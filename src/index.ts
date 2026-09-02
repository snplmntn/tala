/**
 * Tala. One process: a Telegram long-poll loop, a Manila-midnight daily line, and a bare
 * health endpoint for the keep-alive ping that stops Render's free tier spinning down.
 *
 * Deliberately NOT a webhook. Render needs a public endpoint anyway for the ping, and this
 * way that endpoint writes nothing — there is no URL to POST a forged `correction` intent
 * to, so the secret-token check and the random path stop existing rather than being got
 * right. And if the instance is asleep or redeploying, Telegram HOLDS the updates and the
 * next poll drains them, where a webhook would retry with backoff and then discard.
 */

import { createServer } from 'node:http';
import { Db } from './db.ts';
import { extract, transcript } from './extract.ts';
import { addDays, dayDiff, manilaDate, peso } from './ledger.ts';
import { COMMANDS, applyEvent, balances, callback, runCommand } from './handlers.ts';
import {
  answerCallback,
  deleteWebhook,
  getUpdates,
  photoAsDataUrl,
  send,
  sendCsv,
  senderId,
  setMyCommands,
  type Update,
} from './telegram.ts';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
};

const TOKEN = env('TELEGRAM_TOKEN');

/**
 * The allowlist, as one number.
 *
 * Not self-discovered on purpose. "First sender to message the bot becomes the owner" is a
 * tempting pairing flow, but bot usernames are publicly searchable — so between deploy and
 * your first message there is a window where a stranger can claim your ledger, and the
 * failure is total, silent and confusing to recover from. A value you set once is smaller
 * than a pairing-code table and has no race at all.
 *
 * `0` is an explicit PAIRING MODE rather than a silent misconfiguration: the bot replies
 * with your chat id so you can set it from your phone instead of tailing a log. It grants
 * nothing — an unauthorised sender still cannot write a row.
 */
const rawOwner = process.env.OWNER_CHAT_ID;
// Unset is a MISCONFIGURATION and must refuse to boot; an explicit 0 is a request to pair.
// Number('') is 0, not NaN, so this has to be checked on the string — otherwise forgetting
// the variable on Render would quietly pair with the first stranger who finds the bot
// while nothing at all is being recorded.
if (rawOwner === undefined || rawOwner.trim() === '') {
  throw new Error('missing env: OWNER_CHAT_ID (set it to 0 to pair and learn your id)');
}
const OWNER = Number(rawOwner);
if (!Number.isInteger(OWNER) || OWNER < 0) {
  // Negative ids are groups and channels, and group joins are disabled in BotFather — so a
  // stray minus sign would leave the bot accepting nobody, which looks identical to a
  // broken deploy. Refuse it with a reason instead.
  throw new Error(`OWNER_CHAT_ID must be a positive whole number (your user id), got "${rawOwner}"`);
}
const PAIRING = OWNER === 0;
const GROQ = env('GROQ_API_KEY');
const db = new Db(env('TURSO_URL'), env('TURSO_TOKEN'));

const today = () => manilaDate(new Date());
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/**
 * What was just said, so a follow-up is an answer rather than a fresh sentence.
 *
 * One buffer, not one per chat, because the allowlist is one person by construction — see
 * OWNER above. Slash commands stay out of it: /csv and /balance are pages of output that
 * would crowd the prompt, and skipping them actually helps, since "maribank" typed after a
 * detour through /balance still lands next to the question that was really asked.
 */
const history = transcript();

// ─────────────────────────────────────────────────────────────────────────────
// The guard. First thing, before any parse, any LLM call, any write.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bot usernames are publicly searchable, so a stranger can message this bot. Without the
 * allowlist their message writes real rows — and the quota damage lands first: one stranger
 * at Groq's 30 RPM ceiling exhausts 1,000 requests/day in about 33 minutes and the bot is
 * dead until UTC midnight.
 *
 * senderId() reads callback_query.from, not .chat — callback_query has no `.chat`, and that
 * is the row-mutating path a naive check leaves wide open while looking like it authenticates.
 * Unauthorised senders get silence, never an "unauthorized" reply that confirms the bot exists.
 */
const authorised = (u: Update): boolean => senderId(u) === OWNER;

// ─────────────────────────────────────────────────────────────────────────────

async function handle(u: Update): Promise<void> {
  if (!authorised(u)) {
    const id = senderId(u);
    if (PAIRING && id != null) {
      // Pairing replies to whoever asks, which is safe: it confirms a bot exists and
      // grants nothing. Outside pairing mode an unauthorised sender gets silence, never
      // an "unauthorized" message that would confirm the bot is real.
      log('pairing: chat id', id);
      await send(
        TOKEN,
        id,
        `Your chat id is ${id}\n\nSet OWNER_CHAT_ID=${id} and restart. Until then I ignore everything.`,
      );
      return;
    }
    log('ignored update from', id);
    return;
  }

  if (u.callback_query) {
    const msg = await callback(db, u.callback_query.data ?? '', today());
    await answerCallback(TOKEN, u.callback_query.id, msg);
    return;
  }

  const m = u.message ?? u.edited_message;
  if (!m) return;

  // A `document` ships original bytes with home and campus GPS intact. Telegram re-encodes
  // `photo`, which is what strips EXIF, so only photos are accepted.
  if (m.document) {
    await send(TOKEN, m.chat.id, 'Send receipts as a photo, not a file — a file keeps its GPS metadata.');
    return;
  }

  const text = (m.text ?? m.caption ?? '').trim();
  const hasPhoto = !!m.photo?.length;

  // Deterministic commands never reach the LLM. The anchor in particular is the one number
  // the design trusts unconditionally, so it does not go through a probabilistic parser.
  // One dispatcher, shared with the local REPL, so the two can never drift.
  if (!hasPhoto && text.startsWith('/')) {
    const reply = await runCommand(db, await db.accounts(), text, today());
    if (reply) {
      if (reply.document) {
        await sendCsv(TOKEN, m.chat.id, reply.document.filename, reply.document.content);
      } else {
        await send(TOKEN, m.chat.id, reply.text, reply.keyboard);
      }
      return;
    }
  }

  // Claim the update BEFORE the LLM call. A duplicate delivery stops here; a provider
  // outage leaves a row we can replay instead of an expense you watched vanish.
  const inboxId = await db.claim({
    update_id: u.update_id,
    message_id: m.message_id,
    chat_id: m.chat.id,
    text: text || null,
    has_photo: hasPhoto,
    now: new Date().toISOString(),
  });
  if (inboxId == null) {
    log('duplicate update', u.update_id);
    return;
  }

  const accounts = await db.accounts();
  let parsed;
  try {
    const imageDataUrl = hasPhoto ? await photoAsDataUrl(TOKEN, m.photo!) : null;
    parsed = await extract(
      GROQ,
      accounts.map((a) => a.id),
      { text, imageDataUrl },
      today(),
      history.turns,
    );
    await db.markInbox(inboxId, 'parsed', { model: parsed.model, raw: parsed.raw });
  } catch (e) {
    // Deferred, not lost. The raw text is on disk and /retry replays it.
    await db.markInbox(inboxId, 'deferred', { error: String(e).slice(0, 400) });
    await send(
      TOKEN,
      m.chat.id,
      `Saved your message but couldn't read it yet (${String(e).slice(0, 80)}). It will be retried — nothing is lost.`,
    );
    return;
  }

  history.add('user', hasPhoto ? `${text} (sent a receipt photo)`.trim() : text);
  for (const ev of parsed.events) {
    const r = await applyEvent(db, accounts, ev, {
      inboxId,
      today: today(),
      messageId: m.message_id,
      hadPhoto: hasPhoto,
    });
    await send(TOKEN, m.chat.id, r.text, r.keyboard);
    history.add('assistant', r.text);
  }
  await db.markInbox(inboxId, 'applied');
}

// ─────────────────────────────────────────────────────────────────────────────
// The daily line. The single carrier for every alarm.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Without this the error-detection loop is thirty days long: a wrong account or a missing
 * transfer leg on the 3rd stays invisible until the 1st, by which point you cannot remember
 * the transactions well enough to attribute the drift. That is the difference between "that
 * was the Grab ride" and an unexplained ₱430 adjustment.
 *
 * It is also its own dead-man switch, which is why no external watchdog is needed: a daily
 * message that stops arriving IS the alarm.
 */
async function dailyLine(): Promise<void> {
  const accounts = await db.accounts();
  const t = today();
  const body = await balances(db, accounts, t);

  const ages = await Promise.all(
    accounts.map(async (a) => {
      const s = await db.latestSnapshot(a.id);
      return s ? dayDiff(s.as_of_date, t) : 999;
    }),
  );
  const stalest = Math.max(...ages);
  const nudge = stalest >= 28 ? `\n\nAnchors are ${stalest}d old — time to /snap.` : '';
  await send(TOKEN, OWNER, `${t}\n${body}${nudge}`);
}

/**
 * Retry whatever a provider outage deferred, so nothing sits in the inbox forever.
 *
 * Paced, and this is not theoretical: Groq's free tier caps at 8,000 tokens per MINUTE, and
 * this prompt is ~1.2k tokens, so roughly six calls a minute. A human typing never notices;
 * a catch-up loop firing twenty in a row 429s partway and re-defers the rest. So it takes a
 * few per tick and lets the scheduler come back — the backlog drains over minutes instead of
 * bouncing off the ceiling every time.
 */
const RETRY_PER_TICK = 3;

async function retryDeferred(): Promise<void> {
  const rows = (await db.deferred()).slice(0, RETRY_PER_TICK);
  if (!rows.length) return;
  const accounts = await db.accounts();
  for (const row of rows) {
    try {
      const parsed = await extract(
        GROQ,
        accounts.map((a) => a.id),
        { text: row.raw_text },
        today(),
      );
      await db.markInbox(row.id, 'parsed', { model: parsed.model, raw: parsed.raw });
      for (const ev of parsed.events) {
        const r = await applyEvent(db, accounts, ev, { inboxId: row.id, today: today(), hadPhoto: false });
        await send(TOKEN, OWNER, `(retried) ${r.text}`, r.keyboard);
      }
      await db.markInbox(row.id, 'applied');
    } catch (e) {
      // A 429 here is expected under a burst and is not an error worth reporting — the row
      // stays deferred and the next tick picks it up.
      log('retry still failing', row.id, String(e).slice(0, 120));
      return; // still limited or still down; leave the rest for the next tick
    }
  }
}

/**
 * Manila midnight, computed rather than configured.
 *
 * A cron expression would have to be UTC (`0 16 * * *`) and would silently be wrong if the
 * offset ever changed. Checking the Manila civil date every minute is smaller than that and
 * cannot drift — and it survives the process restarting at any hour, because the marker is
 * the date itself, not a timer.
 */
function scheduler(): void {
  let lastRun = today(); // do not fire on boot
  setInterval(() => {
    void (async () => {
      try {
        const t = today();
        if (t !== lastRun) {
          lastRun = t;
          await dailyLine();
        }
        await retryDeferred();
      } catch (e) {
        log('scheduler', e);
      }
    })();
  }, 60_000).unref?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// The loop.
// ─────────────────────────────────────────────────────────────────────────────

async function poll(): Promise<never> {
  // The offset comes from the ledger itself: max(telegram_update_id) + 1. No extra table,
  // and a restart resumes exactly where it left off rather than replaying a day.
  //
  // Never fatal. This used to be the last unguarded await at boot, so a transient Turso blip
  // killed the process after the port was already listening — a restart loop that looks like
  // a broken deploy. Falling back to 0 is safe precisely because inbox.telegram_update_id is
  // UNIQUE: replayed updates are refused by the idempotency guard, so the worst case is a
  // few wasted claims, not a duplicate expense.
  let offset = 1;
  try {
    const row = await db.one<{ n: number | null }>('SELECT MAX(telegram_update_id) AS n FROM inbox');
    offset = (row?.n ?? 0) + 1;
  } catch (e) {
    log(
      'could not read the offset, starting from 0 (UNIQUE guard makes this safe):',
      String(e).slice(0, 160),
    );
    offset = 0;
  }
  log('polling from offset', offset);

  let backoff = 1000;
  for (;;) {
    try {
      const updates = await getUpdates(TOKEN, offset);
      backoff = 1000;
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await handle(u);
        } catch (e) {
          // A DM is the error tracker. Nobody opens a hosting dashboard for a personal bot.
          log('handle', u.update_id, e);
          await send(TOKEN, OWNER, `error on update ${u.update_id}: ${String(e).slice(0, 300)}`).catch(
            () => {},
          );
        }
      }
    } catch (e) {
      log('poll', String(e).slice(0, 200));
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

/**
 * The keep-alive surface, and nothing else. Render's free tier spins down after 15 minutes
 * of inactivity, so an external pinger (cron-job.org, GitHub Actions, UptimeRobot) hits
 * /healthz every ~10 minutes. Every other path is a bare 404 — no bodies, no hints.
 */
function health(): void {
  const port = Number(process.env.PORT ?? 3000);
  createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404).end();
  }).listen(port, () => log('health on', port));
}

if (PAIRING) {
  log('PAIRING MODE — OWNER_CHAT_ID is 0, so nothing will be recorded.');
  log('Message the bot; it will reply with your chat id. Set it, then restart.');
}

// BIND THE PORT FIRST. Render (and every PaaS) waits for a listener before it will route
// traffic or call the deploy healthy, so any awaited network call ahead of this can hang the
// deploy — and an uncaught throw here would kill the process before it ever listened. Two
// Telegram calls used to sit above this line, which is exactly how a deploy gets stuck on
// "Build successful" with nothing after it.
health();

// Now the Telegram setup, and never fatally. If Telegram is slow, rate-limiting or briefly
// unreachable, the service still comes up healthy and the poll loop retries with backoff on
// its own. A cosmetic "/" menu is not worth a failed deploy.
try {
  // Long-polling and a webhook are mutually exclusive; clear one left by an earlier deploy.
  await deleteWebhook(TOKEN);
  // Populate Telegram's own "/" menu from the command table, so the commands are
  // discoverable in the UI and never drift from /help.
  await setMyCommands(TOKEN, COMMANDS);
} catch (e) {
  log('telegram setup failed, continuing:', String(e).slice(0, 200));
}

scheduler();

// Last resort. The service is already healthy by this point, so anything escaping the poll
// loop should be reported and retried rather than taking the process down and handing Render
// a restart loop to interpret.
for (;;) {
  try {
    await poll();
  } catch (e) {
    log('poll loop died, restarting in 10s:', String(e).slice(0, 300));
    await send(TOKEN, OWNER, `Tala restarted its poll loop: ${String(e).slice(0, 200)}`).catch(() => {});
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

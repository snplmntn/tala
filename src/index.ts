/**
 * Tala. One process: a Telegram long-poll loop, an 08:00 Manila daily line, and a bare
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
import { addDays, dayDiff, daysBetween, manilaDate, manilaHour, manilaStartOfDay } from './ledger.ts';
import {
  COMMANDS,
  applyEvent,
  balances,
  callback,
  dropFired,
  dueReminders,
  dueTimed,
  runCommand,
} from './handlers.ts';
import {
  answerCallback,
  clearKeyboard,
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Returns true if this update cost an extraction call — the drain below paces on it. */
async function handle(u: Update): Promise<boolean> {
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
      return false;
    }
    log('ignored update from', id);
    return false;
  }

  if (u.callback_query) {
    const q = u.callback_query;
    const r = await callback(db, q.data ?? '', today());
    // The toast acknowledges the tap and is gone a second later, so it gets the first line
    // and the chat gets the answer. Telegram caps it at 200 characters and silently fails
    // the whole call above that, which is how a multi-line anchor result became no result.
    await answerCallback(TOKEN, q.id, r.text.split('\n')[0].slice(0, 200));
    if (!q.message) return false;
    // The question has been answered: its buttons stop existing, and the outcome is posted
    // as a message so the chat holds a record of it rather than a prompt that never resolved.
    //
    // ADVICE keeps the buttons and nothing else. It used to skip the send as well, which is
    // why tapping "fix" only ever flashed a toast: the guidance it exists to give was gone
    // in a second, and the row it was about still needed its void and confirm taps.
    if (!r.advice) await clearKeyboard(TOKEN, q.message.chat.id, q.message.message_id);
    await send(TOKEN, q.message.chat.id, r.text, r.keyboard);
    history.add('assistant', r.text);
    return false;
  }

  const m = u.message ?? u.edited_message;
  if (!m) return false;

  // A `document` ships original bytes with home and campus GPS intact. Telegram re-encodes
  // `photo`, which is what strips EXIF, so only photos are accepted.
  if (m.document) {
    await send(TOKEN, m.chat.id, 'Send receipts as a photo, not a file: a file keeps its GPS metadata.');
    return false;
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
      return false;
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
    return false;
  }

  const accounts = await db.accounts();
  let parsed;
  try {
    const imageDataUrl = hasPhoto ? await photoAsDataUrl(TOKEN, m.photo!) : null;
    parsed = await extract(
      GROQ,
      accounts.map((a) => a.id),
      { text, imageDataUrl },
      { today: today(), history: history.turns, owner: await db.getSetting('owner_name') },
    );
    await db.markInbox(inboxId, 'parsed', { model: parsed.model, raw: parsed.raw });
  } catch (e) {
    // Deferred, not lost. The raw text is on disk and /retry replays it.
    await db.markInbox(inboxId, 'deferred', { error: String(e).slice(0, 400) });
    await send(
      TOKEN,
      m.chat.id,
      `Saved your message but couldn't read it yet (${String(e).slice(0, 80)}). It will be retried, nothing is lost.`,
    );
    return true; // the call was made and the quota spent, so the drain still paces
  }

  history.add('user', hasPhoto ? `${text} (sent a receipt photo)`.trim() : text);
  for (const ev of parsed.events) {
    const r = await applyEvent(db, accounts, ev, {
      inboxId,
      today: today(),
      messageId: m.message_id,
      hadPhoto: hasPhoto,
      // Only the query path spends this, and only when the message was a QUESTION about the
      // numbers rather than a request for them. See withAnswer in handlers.ts.
      groqKey: GROQ,
      history: history.turns,
    });
    await send(TOKEN, m.chat.id, r.text, r.keyboard);
    history.add('assistant', r.text);
  }
  await db.markInbox(inboxId, 'applied');
  return true;
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
/** A month of catch-up is plenty; anything older is history, not a nudge. */
const CATCHUP_DAYS = 31;

/**
 * 08:00 Manila, and it carries the overnight close-out.
 *
 * It fired at midnight, which is a notification you sleep through and read at breakfast
 * anyway. At 08:00 it arrives when you read it, and confirming yesterday's untapped entries
 * on the same tick gives you one morning message instead of two: what it closed, then where
 * you stand.
 */
const DAILY_HOUR = 8;

async function dailyLine(since: string | null, t: string): Promise<void> {
  const accounts = await db.accounts();
  const name = await db.getSetting('owner_name');
  const body = await balances(db, accounts, t);

  const ages = await Promise.all(
    accounts.map(async (a) => {
      const s = await db.latestSnapshot(a.id);
      return s ? dayDiff(s.as_of_date, t) : 999;
    }),
  );
  const stalest = Math.max(...ages);
  const nudge = stalest >= 28 ? `\n\nAnchors are ${stalest}d old, time to /snap.` : '';

  // Every day the process missed, so a reminder that came due during an outage still fires
  // — late, and SAYING it is late. A silent catch-up would erase the evidence of the
  // outage, which is the one thing the daily line exists to make visible.
  const dates = since ? daysBetween(addDays(since, 1), t).slice(-CATCHUP_DAYS) : [t];
  const due = await dueReminders(db, dates);
  const bell = due.length ? `\n\n${due.map((r) => `⏰ ${r.text}`).join('\n')}` : '';
  const late = dates.length > 1 ? ` · late, no daily line for ${dates.length - 1}d` : '';

  // Close out everything you did not tap. An entry is taken as read once you have slept on
  // it, which is the whole reason this line fires at 08:00 rather than at midnight: a spend
  // logged at 23:50 would otherwise have had ten minutes.
  const cutoff = manilaStartOfDay(t);
  const closing = await db.unconfirmedBefore(cutoff);
  if (closing) await db.batch([db.confirmBefore(cutoff, new Date().toISOString())]);
  const closed = closing ? `\n${closing} ${closing === 1 ? 'entry' : 'entries'} confirmed` : '';

  await send(TOKEN, OWNER, `${name ? `${name} · ` : ''}${t}${late}${closed}\n${body}${nudge}${bell}`);
  // Both AFTER the send, and in this order: a Telegram failure must not consume a one-off
  // reminder, and must leave the marker unset so the next tick tries again.
  await dropFired(db, due);
  await db.setSetting('last_daily_line', t);
}

/**
 * The other carrier: reminders that name a minute rather than a day.
 *
 * The daily line is right for anything you act on when you sit down, and wrong for a bill
 * that closes at 17:00. So a timed reminder rides this — the same once-a-minute tick, with
 * the same recovery property: the marker is an INSTANT, and dueTimed fires every slot inside
 * `(marker, now]`, so a process that was down at 21:00 sends at 21:04 instead of losing it.
 */
async function timedReminders(): Promise<void> {
  const now = new Date().toISOString();
  // A first boot scans the last minute only. Defaulting to the epoch would dump every slot
  // in the catch-up window into the chat the moment this shipped.
  const scan = (await db.getSetting('reminder_scan')) ?? new Date(Date.now() - 60_000).toISOString();
  const due = await dueTimed(db, scan, now);
  for (const r of due) await send(TOKEN, OWNER, `⏰ ${r.text}`);
  // Both AFTER the send, exactly as the daily line does it: a Telegram failure must not
  // consume a one-off reminder, and must leave the marker where the next tick retries it.
  await dropFired(db, due);
  await db.setSetting('reminder_scan', now);
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
        { today: today(), owner: await db.getSetting('owner_name') },
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
 * 08:00 Manila, computed rather than configured.
 *
 * A cron expression would have to be UTC (`0 0 * * *`) and would silently be wrong if the
 * offset ever changed. Checking the Manila civil date and hour every minute is smaller than
 * that and cannot drift, and it survives the process restarting at any hour, because the
 * marker is the date itself, not a timer.
 *
 * TWO markers, and both are load-bearing. The stored one is what makes a missed day recover:
 * this used to initialise from `today()` on boot, so a process that was down all of the 25th
 * silently never sent the 25th — fine for a balance table you can retype as /balance, fatal
 * for a reminder, which is simply gone. The in-memory one is what stops a database outage
 * from looping the send: getSetting reports a failed read as "no preference set", which
 * would otherwise look like a day that had not run, once a minute, forever.
 *
 * Firing on a FIRST-EVER boot is deliberate and not a regression of the old "do not fire on
 * boot": every later same-day restart reads the stored marker and stays quiet, so the
 * anti-spam property is now stronger than the in-memory version it replaces.
 */
function scheduler(): void {
  let ran: string | null = null;
  setInterval(() => {
    void (async () => {
      try {
        const t = today();
        const last = ran === t ? t : await db.getSetting('last_daily_line');
        // The hour is the only reason this is not a pure date comparison. A process that
        // boots at 03:00 waits for 08:00; one that boots at 14:00 with the day unsent fires
        // at once, because a late daily line still carries reminders that would otherwise
        // just be gone.
        if (last !== t && manilaHour(new Date()) >= DAILY_HOUR) {
          ran = t; // set BEFORE the send, so a throw cannot retry it every minute
          await dailyLine(last, t);
        }
        await timedReminders();
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

/**
 * How long to wait between two messages that both need the extractor.
 *
 * This only ever fires while draining a BACKLOG — everything Telegram held while the service
 * was asleep, redeploying or unreachable — because a single message has nothing after it to
 * pace against.
 *
 * Without it the drain fires every queued message at once, and Groq's free tier caps at 8,000
 * tokens per MINUTE against a prompt of roughly 1.8k, so about the fifth call 429s and the
 * rest defer. Nothing is lost, but the ORDER is: a reply that answers the bot's own question
 * ("maribank", right after being asked which account) gets parsed with its question missing
 * from the transcript, and comes out as something else entirely.
 *
 * retryDeferred already paces for exactly this reason — see RETRY_PER_TICK. The cold-start
 * drain is the larger burst and simply never got the same treatment.
 */
const PACE_MS = 14_000;

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
      for (const [i, u] of updates.entries()) {
        offset = Math.max(offset, u.update_id + 1);
        let spentACall = false;
        try {
          spentACall = await handle(u);
        } catch (e) {
          // A DM is the error tracker. Nobody opens a hosting dashboard for a personal bot.
          log('handle', u.update_id, e);
          await send(TOKEN, OWNER, `error on update ${u.update_id}: ${String(e).slice(0, 300)}`).catch(
            () => {},
          );
        }
        // Only ever between messages, so ordinary one-at-a-time typing waits for nothing.
        if (spentACall && i < updates.length - 1) {
          log('pacing the backlog,', updates.length - i - 1, 'left');
          await sleep(PACE_MS);
        }
      }
    } catch (e) {
      log('poll', String(e).slice(0, 200));
      await sleep(backoff);
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
  log('PAIRING MODE: OWNER_CHAT_ID is 0, so nothing will be recorded.');
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
    await sleep(10_000);
  }
}

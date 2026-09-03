/**
 * The router. Every way a message can arrive ends here, and leaves as a Reply.
 *
 * Three entry points, one per input shape: applyEvent for a parsed LLM event, runCommand for
 * a slash command, callback for an inline-button tap. They are together because they answer
 * the same question — "what should the chat say now?" — and because applyEvent DELEGATES a
 * spoken query to runCommand, which is friction removed rather than a layering mistake.
 *
 * The work itself lives one file out, by domain: entries.ts writes money rows, anchors.ts
 * owns the baseline, reports.ts reads the ledger back. This file is dispatch and copy.
 */

import { Db, type Account } from './db.ts';
import { answer, type Extracted, type Turn } from './extract.ts';
import {
  WEEKDAYS,
  addDays,
  dayDiff,
  daysBetween,
  manilaDate,
  peso,
  reminderDue,
  unsettled,
  type Event,
} from './ledger.ts';
import { correct, feeCmd, money, transfer, undo, voidWithSiblings } from './entries.ts';
import { anchorAccount, proposeAnchor, snapshot } from './anchors.ts';
import { balances, csv, interest, queryFacts, rates, recap, remaining, remainingFor } from './reports.ts';
import { acct, noAccount, nowIso, type CallbackReply, type Reply } from './reply.ts';
import { mono } from './telegram.ts';

export { anchorAccount, proposeAnchor, snapshot } from './anchors.ts';
export { balances, csv, interest, rates, recap } from './reports.ts';
export { correct, money, transfer, undo } from './entries.ts';
export type { CallbackReply, Reply } from './reply.ts';

export async function applyEvent(
  db: Db,
  accounts: Account[],
  e: Extracted,
  ctx: {
    inboxId: number;
    today: string;
    messageId?: number | null;
    hadPhoto: boolean;
    /** Absent in tests and in the REPL without a key: the report still sends, unexplained. */
    groqKey?: string;
    history?: Turn[];
  },
): Promise<Reply> {
  switch (e.intent) {
    case 'expense':
    case 'income':
      return money(db, accounts, e, ctx);
    case 'transfer':
      return transfer(db, accounts, e, ctx);
    case 'correction':
      return correct(db, accounts, e, ctx);
    case 'snapshot':
      return proposeAnchor(db, accounts, e, ctx.today);
    case 'interest': {
      // Straight to the command, same as open_account: /interest already owns the amount
      // parsing, the date, the learner and the double-count warning. A second copy of any of
      // that here is how the typed path and the spoken path drift into different answers.
      if (!e.account)
        return { text: `Which account credited that? (${accounts.map((a) => a.id).join(' / ')})` };
      if (!e.amount) return { text: `${acct(accounts, e.account)?.name ?? e.account}: how much interest?` };
      return interest(db, accounts, [e.account, e.amount, e.date_hint].filter(Boolean).join(' '), ctx.today);
    }
    case 'open_account':
      return proposeAccount(db, e.new_account, e.new_account_book);
    case 'query': {
      // The extractor already classified this, so honour it. A query is read-only: there is
      // no correctness argument for making you remember a slash command to ask a question.
      const kind = e.query_kind ?? 'balance';
      // The period rides along for a recap. Without it "how much did I spend this month"
      // and "what did I spend today" both reach a bare /recap, which answers for today —
      // so the spoken path would silently be able to ask only one of the two questions.
      const period = kind === 'recap' && e.date_hint ? ` ${e.date_hint}` : '';
      const report = (await runCommand(db, accounts, `/${kind}${period}`, ctx.today)) ?? {
        text: 'Ask me /balance or /recap.',
      };
      return withAnswer(db, accounts, e, report, ctx);
    }
    default:
      // The extractor writes this one, because it is the only reply with nothing to state:
      // no amount, no account, no row. Everything else is answered from real numbers below.
      return {
        text:
          e.reply?.trim() ||
          'Not sure what to do with that. Tell me what you spent, like "250 jollibee maribank", or /help.',
      };
  }
}

/**
 * The report, plus the answer to the question the report does not answer.
 *
 * A table says what a number IS. "did my interest get added", "why does this still say est",
 * "is that the whole day" are questions about how it got there, and every one of them used to
 * be routed to the nearest report and answered with a table the user had just seen. That is
 * the difference between a ledger you read and a ledger you can talk to.
 *
 * BELOW the report, never instead of it: the code-computed figures stay first and stay
 * authoritative, so prose that paraphrases one badly is contradicted in the same message.
 *
 * Failure is silent by design. A model that is rate-limited, slow or down must never cost you
 * the answer you actually asked for, and the report is already complete without this.
 */
/**
 * True when the report IS the whole answer, so nothing gets appended to it.
 *
 * "how much did i spend yday" is a bare REQUEST wearing a question mark, and the extractor's
 * did/was/is heuristic reads it as a follow-up — so a dated, totalled recap came back with a
 * paragraph hedging about the figure printed two lines above it. The prompt now says this
 * too, but the model decides in one place and code refuses in another: `ask` earns its LLM
 * call only for a question ABOUT the numbers (why, how come, still, already, counted).
 */
export const tableAnswers = (ask: string): boolean =>
  /^\s*(how much|how many|what|magkano)\b/i.test(ask) &&
  !/\b(why|how come|still|already|includ\w*|counted|added|missing|est|mean|means)\b/i.test(ask);

async function withAnswer(
  db: Db,
  accounts: Account[],
  e: Extracted,
  report: Reply,
  ctx: { today: string; groqKey?: string; history?: Turn[] },
): Promise<Reply> {
  // A bare "balance" or "recap" gets nothing appended: the table IS the answer, and prose
  // after it would be noise on the path that is already working.
  if (!e.ask?.trim() || tableAnswers(e.ask) || !ctx.groqKey || report.document) return report;
  try {
    const prose = await answer(ctx.groqKey, e.ask, report.text, await queryFacts(db, accounts, ctx.today), {
      today: ctx.today,
      history: ctx.history,
      owner: await db.getSetting('owner_name'),
    });
    return prose ? { ...report, text: `${report.text}\n\n${prose}` } : report;
  } catch {
    return report;
  }
}

// ── callbacks ───────────────────────────────────────────────────────────────

export async function callback(db: Db, data: string, today: string): Promise<CallbackReply> {
  const [kind, a, b] = data.split(':');
  const now = nowIso();

  if (kind === 'ok') {
    // Where the balance goes for a logged row. The echo above still has live buttons, so its
    // figure would be provisional; this tap is where the entry settles. The column write is
    // presentational and no-ops if the 08:00 close-out already set it, so the line below is
    // the whole point of the tap either way.
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(a)]);
    if (!row) return { text: 'That row is gone.' };
    await db.batch([db.confirmEvent(Number(a), now)]);
    const account = acct(await db.accounts(), row.account_id);
    return { text: account ? `✓ confirmed, ${await remaining(db, account, today)}` : '✓ confirmed' };
  }

  if (kind === 'void') {
    // Always validate against CURRENT row state: a three-week-old inline keyboard stays
    // live in Telegram forever, so an unvalidated tap silently reverses a settled row.
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(a)]);
    if (!row) return { text: 'That row is gone.' };
    if (row.voided_at) return { text: 'Already voided.' };
    const anchor = await db.latestSnapshot(row.account_id);
    if (anchor && dayDiff(row.occurred_at, anchor.as_of_date) >= 0)
      return { text: 'That period is already reconciled, correct it instead.' };
    const siblings = await voidWithSiblings(db, row);
    const extra = siblings.length > 1 ? ` (+${siblings.length - 1} paired)` : '';
    const left = await remainingFor(db, await db.accounts(), siblings, today);
    return { text: `🗑 voided${extra}${left ? `, ${left}` : ''}` };
  }

  if (kind === 'adj') {
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(b)]);
    if (!row || row.type !== 'adjustment') return { text: 'That row is gone.' };
    // The category is why this number is worth anything. Written to the row that already exists.
    await db.run('UPDATE events SET category = ? WHERE id = ? AND category IS NULL', [a, Number(b)]);
    return { text: `✓ tagged as ${a}` };
  }

  if (kind === 'snap') {
    const accounts = await db.accounts();
    const account = acct(accounts, a);
    if (!account) return { text: noAccount(a, accounts) };
    // The whole reply, keyboard included: a first anchor answers with another question.
    return anchorAccount(db, account, Number(b), today);
  }
  if (kind === 'open') {
    // Straight into the command: /account add owns the id rules, the duplicate check and the
    // credit-sign warning, so the tapped path and the typed path cannot answer differently.
    const [book, id, name] = (b ?? '').split('|');
    return accountsCmd(db, `add ${id} ${book} ${a} ${name ?? ''}`.trim());
  }

  if (kind === 'anchored') return { text: 'Kept as counted, the earlier spending stays in your recap only.' };

  if (kind === 'anchorsub') {
    const accounts = await db.accounts();
    const account = acct(accounts, a);
    if (!account) return { text: noAccount(a, accounts) };
    const anchor = await db.latestSnapshot(account.id);
    if (!anchor) return { text: 'No anchor to adjust.' };
    const amount = Number(b);
    // Applied as an explicit adjustment dated after the anchor, not by moving the anchor.
    // The anchor stays exactly the figure you typed, and the ledger records why the balance
    // differs from it — which is the whole point of never mutating a row.
    await db.batch([
      db.insertEvent({
        type: 'adjustment',
        book: account.book,
        account_id: account.id,
        amount_centavos: amount,
        category: 'reclassified',
        occurred_at: addDays(anchor.as_of_date, 1),
        logged_at: nowIso(),
        note: 'pre-anchor spending applied on request',
      } as never),
    ]);
    return { text: `applied ${peso(Math.abs(amount))}, ${await remaining(db, account, today)}` };
  }

  if (kind === 'nope') return { text: '✗ cancelled, nothing was written' };
  // Advice, not an action. Both of these are waiting on a message you have not typed yet,
  // so taking the buttons away would strand you if you changed your mind.
  if (kind === 'tx')
    return { text: 'Reply: transfer <amount> <from> to <to>, then void the expense.', advice: true };
  if (kind === 'fix')
    return { text: 'Reply with the correction, e.g. "the jollibee was 285 not 250".', advice: true };
  return { text: 'Unknown action.' };
}

// ── one command table, four consumers ───────────────────────────────────────

/**
 * The single source of truth for commands.
 *
 * It drives the /help text, Telegram's own "/" menu via setMyCommands, and the dispatcher
 * that BOTH the bot and the local REPL call. Keeping four copies in step by hand is how
 * /help ends up working in Telegram and not in the REPL — which is exactly what happened
 * before this existed.
 */
export const COMMANDS = [
  { name: 'balance', args: '', help: 'confirmed vs expected, per book' },
  { name: 'recap', args: '[today|week|month|YYYY-MM-DD] [list]', help: 'what you spent, itemised' },
  { name: 'snap', args: '<account> <amount>', help: 'anchor a real balance from your banking app' },
  { name: 'fee', args: '<amount>', help: 'attach a transfer fee to the transfer just logged' },
  { name: 'interest', args: '[<account> <amount> [date]]', help: 'what you have earned, or report a credit' },
  { name: 'rate', args: '[account] [10% gross]', help: 'see rates, or set one' },
  { name: 'owed', args: '', help: 'money you fronted that has not come back' },
  { name: 'account', args: '[add|off|on] …', help: 'list accounts, or open and close them' },
  {
    name: 'remind',
    args: '[every] <day|mon-sun|som|eom> [HH:MM] <text>',
    help: 'a nudge on the daily line, or at an exact time',
  },
  { name: 'name', args: '[what to call you]', help: 'what Tala calls you' },
  { name: 'undo', args: '', help: 'void the last entry' },
  { name: 'csv', args: '', help: 'the whole ledger as a spreadsheet' },
  { name: 'help', args: '', help: 'this' },
] as const;

export const HELP = [
  'Tala: just say what you spent.',
  mono(
    [
      '250 jollibee maribank',
      'jeep 15, load 50, lunch 90 gcash',
      '600 dinner maribank, 400 not mine',
      'sent 2k from maya to gotyme, fee 10',
      'the jollibee was 285 not 250',
      '(or send a receipt photo)',
    ].join('\n'),
  ),
  // One per line, NOT padded into columns: a /command inside a monospace block stops being
  // tappable, and tapping beats alignment on a list you read once.
  ...COMMANDS.map((c) => `/${c.name}${c.args ? ' ' + c.args : ''}: ${c.help}`),
  '',
  'An ANCHOR is a real balance you read off your banking app. Everything is counted forward',
  'from it, so /snap is the one habit worth keeping. The rest is just telling me things.',
  '',
  "Balances show confirmed (what the bank credited) and expected (plus today's",
  'uncredited interest). (est) means the rate is still a seed, /interest clears it.',
  '',
  'Entries you do not tap confirm themselves at 08:00 the next morning, on the daily line.',
].join('\n');

/**
 * The first five minutes, which used to be a wall of "not anchored" and no idea what to do.
 *
 * Shown until the first anchor exists, because until then every number in the app is zero
 * and the balance table is nothing but a list of things that have not happened yet.
 */
export async function firstRun(db: Db, accounts: Account[]): Promise<string | null> {
  if (await db.one('SELECT 1 FROM snapshots LIMIT 1')) return null;
  const name = await db.getSetting('owner_name');
  return [
    name ? `Hi ${name}, let's set this up.` : "Welcome. I'm Tala, and I track your money in this chat.",
    '',
    ...(name ? [] : ['First, what should I call you?', '  /name Sean', '']),
    `${name ? 'Tell' : 'Then tell'} me what each account actually holds right now. That is an ANCHOR: the real`,
    'balance from your banking app, and everything gets counted forward from it.',
    mono(accounts.map((a) => `${a.id} 1234.56`).join('\n')),
    `Your accounts: ${accounts.map((a) => a.id).join(', ')}   (/account to add or close one)`,
    '',
    'After that, just say what you spend:  250 jollibee maribank',
  ].join('\n');
}

/**
 * Dispatch a slash command. Returns null when it is not a command at all, so the caller
 * falls through to the LLM. Deterministic: nothing here goes near the extractor.
 */
export async function runCommand(
  db: Db,
  accounts: Account[],
  line: string,
  today: string,
): Promise<Reply | null> {
  // The transfer reply asks for "fee 10" BY NAME and without a slash, so answer to it
  // without one. A message the app dictated must never reach the extractor: the transfer is
  // still in its transcript, and it emits the whole thing a second time. Here rather than in
  // the bot's dispatcher so the REPL cannot answer differently.
  const typed = /^fee\b/i.test(line) ? `/${line}` : line;
  if (!typed.startsWith('/')) return null;
  const [raw, ...rest] = typed.split(/\s+/);
  const cmd = raw.slice(1).toLowerCase();
  const arg = rest.join(' ');

  switch (cmd) {
    case 'start':
      return { text: (await firstRun(db, accounts)) ?? HELP };
    case 'help':
      return { text: HELP };
    case 'name': {
      const current = await db.getSetting('owner_name');
      if (!arg) {
        return {
          text: current
            ? `I call you ${current}. Change it: /name Sean`
            : 'What should I call you? /name Sean',
        };
      }
      // Trimmed to something that fits in a sentence: this is interpolated into the model's
      // system prompt, so a pasted essay would be prompt text, not a nickname.
      const next = arg.replace(/\s+/g, ' ').trim().slice(0, 40);
      await db.setSetting('owner_name', next);
      return { text: `Got it, ${next} it is.` };
    }
    case 'balance':
      return { text: (await firstRun(db, accounts)) ?? (await balances(db, accounts, today)) };
    case 'recap':
      return { text: await recap(db, arg, today) };
    case 'snap':
    case 'snapshot':
      return snapshot(db, accounts, arg, today);
    case 'interest':
      return interest(db, accounts, arg, today);
    case 'fee':
      return feeCmd(db, accounts, arg, today);
    case 'rate':
    case 'rates':
      return rates(db, accounts, arg);
    case 'account':
    case 'accounts':
      return accountsCmd(db, arg);
    case 'remind':
    case 'reminders':
      return remindCmd(db, arg, today);
    case 'owed': {
      const owed = unsettled(await db.allEvents());
      return { text: owed > 0 ? `owed to you: ${peso(owed)}` : 'nothing outstanding' };
    }
    case 'undo':
      return { text: await undo(db, accounts, today) };
    case 'csv':
      return { text: 'ledger attached', document: { filename: `tala-${today}.csv`, content: await csv(db) } };
    default:
      return { text: `Unknown command /${cmd}. Try /help` };
  }
}

/**
 * An id is DERIVED from the name, never asked for and never taken from the model.
 *
 * The model used to be asked for a whole `/account add` argument line; it reliably sent back
 * the name alone, and the user got the command's usage string — the terminal friction this
 * path exists to remove. Names are the only thing a person actually says out loud, so that
 * is the only thing asked of the model, and the id is a pure function of it.
 */
export const accountId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 16);

/**
 * Opening an account, proposed rather than performed.
 *
 * The kind is the one field nobody can infer: a Beep card is a stored-value card, which is
 * an ewallet to one person and cash to another, and the choice changes nothing less than
 * whether the balance is an asset or a debt. So it is asked with buttons — four taps of
 * ground truth beats a confident guess you would have to close the account to undo.
 */
export async function proposeAccount(db: Db, name: string | null, book: string | null): Promise<Reply> {
  const clean = (name ?? '').replace(/[:|]/g, ' ').trim().slice(0, 24);
  const id = accountId(clean);
  if (!/^[a-z][a-z0-9]{1,15}$/.test(id))
    return { text: 'What should I call it? Like "open a seabank account".' };

  const existing = (await db.allAccounts()).find((a) => a.id === id);
  if (existing)
    return {
      text: existing.active
        ? `${existing.name} is already open, just log to it.`
        : `${existing.name} is closed. /account on ${id} reopens it, history and all.`,
    };

  const bk = book === 'business' ? 'business' : 'personal';
  const payload = `${bk}|${id}|${clean}`;
  return {
    text: `Open ${clean} as a ${bk} account. What kind is it?`,
    keyboard: [
      KINDS.map((k) => ({ text: k, callback_data: `open:${k}:${payload}` })),
      [{ text: '✗ cancel', callback_data: 'nope' }],
    ],
  };
}

// ── reminders ───────────────────────────────────────────────────────────────

/**
 * A nudge on the daily line. Deliberately not financial — the Maya boost is one row in the
 * list, not the reason the list exists.
 *
 * Stored as ONE JSON row in `settings`, which is why there is no migration: schema.sql has
 * no IF NOT EXISTS and only ever runs against an empty database, so a table declared there
 * would never reach a ledger that was already deployed. `settings` is created in db.ts for
 * exactly this reason, and a reminder is a preference, not a ledger fact.
 */
export interface Reminder {
  when: string; // 'som' | 'eom' | '1'..'31' | 'mon'..'sun'
  text: string;
  /** Absent means ONE-OFF, which is the default: it deletes itself after it fires. */
  every?: boolean;
  /**
   * 'HH:MM' Manila, and the whole reason there are two carriers.
   *
   * Absent means the 08:00 daily line, which is right for anything you act on when you sit
   * down. A bill that closes at 17:00 or a 21:00 medicine needs the minute it names, so a
   * timed reminder rides the scheduler's minute tick instead — see dueTimed. The two sets
   * are disjoint by construction (dueReminders drops every row that has an `at`), because a
   * reminder that arrives twice is a reminder you learn to ignore.
   */
  at?: string;
}

/** The instant a Manila civil date and 'HH:MM' name, so a slot can be compared to a scan. */
const slotAt = (date: string, at: string): string => new Date(`${date}T${at}:00+08:00`).toISOString();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const REMINDERS = 'reminders';
// One settings row must not be able to become a wall in the morning message.
const MAX_REMINDERS = 20;
const MAX_TEXT = 200;

async function loadReminders(db: Db): Promise<Reminder[]> {
  const raw = await db.getSetting(REMINDERS);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .filter((r): r is Reminder => typeof r?.when === 'string' && typeof r?.text === 'string')
          // A hand-edited time would reach slotAt as an Invalid Date and throw inside the
          // scheduler. Demoted to the daily line instead: late is recoverable, silent is not.
          .map((r) => (r.at && !HHMM.test(r.at) ? { ...r, at: undefined } : r))
      : [];
  } catch {
    // A hand-edited settings row must not be able to stop the daily line arriving.
    return [];
  }
}

const saveReminders = (db: Db, rows: Reminder[]) => db.setSetting(REMINDERS, JSON.stringify(rows));

const same = (a: Reminder, b: Reminder) => a.when === b.when && a.text === b.text && a.at === b.at;

/**
 * Everything due on any of `dates`. A LIST of dates, not one, because the daily line catches
 * up after an outage — a reminder that came due while the process was down fires late rather
 * than being lost, which is the whole point of persisting the marker.
 */
export async function dueReminders(db: Db, dates: string[]): Promise<Reminder[]> {
  const all = await loadReminders(db);
  // Timed rows are excluded here and ONLY here: they have their own carrier, and a row in
  // both sets fires twice on the day it comes round.
  return all.filter((r) => !r.at && dates.some((d) => reminderDue(r.when, d)));
}

/** A month of catch-up, the same bound the daily line uses. Older than that is history. */
const TIMED_CATCHUP_DAYS = 32;

/**
 * Everything with a clock time whose moment fell in `(scan, now]`.
 *
 * A WINDOW, not "is it 21:00 right now", because the tick is once a minute and the process
 * is not always up: a scan marker that survives a restart turns a missed 21:00 into a 21:04
 * reminder instead of a lost one, which is the same guarantee the daily line's date catch-up
 * gives — off one settings key and no per-row bookkeeping. Exclusive on the left, so an
 * advanced marker can never fire the same slot twice.
 */
export async function dueTimed(db: Db, scan: string, now: string): Promise<Reminder[]> {
  const timed = (await loadReminders(db)).filter((r) => r.at);
  if (!timed.length) return [];
  // From the day BEFORE the scan: Manila is UTC+8, so an instant early in a UTC day belongs
  // to a Manila date whose 00:00 slot is already behind it.
  const dates = daysBetween(addDays(manilaDate(new Date(scan)), -1), manilaDate(new Date(now))).slice(
    -TIMED_CATCHUP_DAYS,
  );
  return timed.filter((r) =>
    dates.some((d) => {
      if (!reminderDue(r.when, d)) return false;
      const slot = slotAt(d, r.at!);
      return slot > scan && slot <= now;
    }),
  );
}

/**
 * Retire the one-offs that just fired. Separate from `dueReminders` so the caller can send
 * FIRST and delete second: a Telegram failure must not silently consume a reminder.
 */
export async function dropFired(db: Db, fired: Reminder[]): Promise<void> {
  const oneOffs = fired.filter((r) => !r.every);
  if (!oneOffs.length) return;
  const all = await loadReminders(db);
  const keep = all.filter((r) => !oneOffs.some((f) => same(f, r)));
  if (keep.length !== all.length) await saveReminders(db, keep);
}

const WHEN_LABEL = (when: string): string =>
  when === 'som'
    ? 'the 1st'
    : when === 'eom'
      ? 'the last day'
      : WEEKDAYS.includes(when as never)
        ? `${when[0].toUpperCase()}${when.slice(1)}`
        : `day ${when}`;

/**
 * Accepts what people type; refuses everything else rather than guessing a day.
 *
 * Weekdays are matched EXACTLY against an alias table, never by prefix: "mon" is a prefix of
 * "money" and "sat" of "satisfy", so `/remind money check the card` would have quietly
 * become a Monday reminder to "check the card". A dozen table entries buy the certainty.
 */
const WEEKDAY_WORDS: Record<string, string> = {
  sun: 'sun',
  sunday: 'sun',
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  weds: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
};

function parseWhen(raw: string): string | null {
  const w = raw.toLowerCase();
  if (w === 'som' || w === 'start' || w === 'first') return 'som';
  if (w === 'eom' || w === 'end' || w === 'last') return 'eom';
  if (WEEKDAY_WORDS[w]) return WEEKDAY_WORDS[w];
  const n = Number(w.replace(/(st|nd|rd|th)$/, ''));
  return Number.isInteger(n) && n >= 1 && n <= 31 ? String(n) : null;
}

/**
 * "21:00", "9:30pm", "9pm" -> "21:00". Null for everything else, including a bare "9".
 *
 * The colon-or-meridiem requirement is what keeps the grammar unambiguous: the token after
 * the day is optional, so without it `/remind 25 9 internet bill` could be 09:00 or a
 * reminder that starts with the word 9 — and a bill reminder that fires at 09:00 instead of
 * being about "9 internet bill" is the kind of wrong nobody notices until the bill is late.
 */
function parseAt(raw: string): string | null {
  const w = raw.toLowerCase();
  if (!/[:]|am$|pm$/.test(w)) return null;
  const m = w.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Scanned forward rather than computed: exact for every clamp and weekday, and 8 lines shorter. */
function nextFire(when: string, from: string, at?: string): string | null {
  // TODAY counts when a clock time is set and has not passed yet. Without this, "/remind 4
  // 21:00" typed on the 4th at lunchtime confirms with next month's date while it is about
  // to fire tonight, which reads as the reminder having been misfiled.
  const start = at && reminderDue(when, from) && slotAt(from, at) > new Date().toISOString() ? 0 : 1;
  for (let i = start; i <= 366; i++) {
    const d = addDays(from, i);
    if (reminderDue(when, d)) return d;
  }
  return null;
}

const REMIND_USAGE = [
  '/remind eom boost maya          once, on the last day of this month',
  '/remind every 25 internet bill  every month on the 25th',
  '/remind every fri water the plants',
  '/remind som review subscriptions',
  '/remind 25 17:00 pay the bill   at 17:00 on the 25th, to the minute',
  '/remind every mon 9:30pm meds   9:30pm and 21:30 both work',
  '/remind            list them',
  '/remind off 2      drop one',
].join('\n');

export async function remindCmd(db: Db, arg: string, today: string): Promise<Reply> {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const list = await loadReminders(db);

  if (!parts.length) {
    if (!list.length)
      return { text: ['Nothing set. They arrive with the daily line.', '', REMIND_USAGE].join('\n') };
    const lines = list.map((r, i) => {
      const next = nextFire(r.when, today, r.at);
      const when = `${WHEN_LABEL(r.when)}${r.at ? ` ${r.at}` : ''}`;
      return `  ${String(i + 1).padEnd(3)} ${when.padEnd(19)} ${(r.every ? 'every' : 'once').padEnd(6)} ${next ?? ''}  ${r.text}`;
    });
    return {
      text: [
        'Reminders: 08:00 in Manila with the daily line, or at the exact time you set.',
        mono(lines.join('\n')),
        '/remind off <n> to drop one · /remind for the full syntax',
      ].join('\n'),
    };
  }

  if (parts[0] === 'off') {
    const n = Number(parts[1]);
    if (!Number.isInteger(n) || n < 1 || n > list.length)
      return { text: `Which one? /remind off 1..${list.length || 1}` };
    const [gone] = list.splice(n - 1, 1);
    await saveReminders(db, list);
    return { text: `dropped: ${gone.text}` };
  }

  const every = parts[0] === 'every' || parts[0] === 'monthly' || parts[0] === 'weekly';
  const rest = every ? parts.slice(1) : parts;
  const when = rest.length ? parseWhen(rest[0]) : null;
  if (!when)
    return {
      text: [`Couldn't read "${rest[0] ?? ''}" as a day.`, '', REMIND_USAGE].join('\n'),
    };
  // Optional, and only ever the token straight after the day — see parseAt for why it has
  // to look like a time rather than merely be a number.
  const at = rest.length > 1 ? parseAt(rest[1]) : null;

  // Control characters stripped, not escaped: telegram.ts marks its monospace blocks with
  // them, so they are markup rather than something a reminder should be able to carry.
  const text = rest
    .slice(at ? 2 : 1)
    .join(' ')
    .replace(/[\u0000-\u0008]/g, '')
    .slice(0, MAX_TEXT);
  if (!text) return { text: `Remind you of what? e.g. /remind ${rest[0]} boost maya` };
  if (list.length >= MAX_REMINDERS)
    return { text: `That is ${MAX_REMINDERS} reminders already. /remind off <n> to make room.` };

  const row: Reminder = { when, text, ...(every ? { every: true } : {}), ...(at ? { at } : {}) };
  await saveReminders(db, [...list, row]);
  const next = nextFire(when, today, at ?? undefined);
  return {
    text: `⏰ ${text}\n${WHEN_LABEL(when)}${at ? ` at ${at}` : ''}${every ? ', every time it comes round' : ', once'}, next ${next}`,
  };
}

const BOOKS = ['personal', 'business'] as const;
const KINDS = ['bank', 'ewallet', 'cash', 'credit'] as const;

/**
 * `/account` to list, `/account add …` to open one, `/account off …` to close one.
 *
 * This exists because the design assumes you will open accounts — the whole point of
 * tracking rates is chasing them, and PH digital banks re-tier constantly. Without a chat
 * path, opening SeaBank would block you from logging SeaBank expenses until you reached a
 * terminal, because the account list IS the closed enum handed to the extractor.
 *
 * Deliberately does NOT take a rate. Setting one needs the gross-or-net word, `/rate`
 * already enforces that, and duplicating rate parsing here is how the two drift apart.
 */
export async function accountsCmd(db: Db, arg: string): Promise<Reply> {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const [verb, id, ...rest] = parts;

  if (!verb) {
    const rows = await db.allAccounts();
    const lines = rows.map((a) => {
      const rate = a.rate > 0 ? `${(a.rate * 100).toFixed(2)}% net` : 'untracked';
      return `  ${a.id.padEnd(9)} ${a.book.padEnd(9)} ${a.kind.padEnd(8)} ${rate}${a.active ? '' : '   (closed)'}`;
    });
    return {
      text: [
        'Accounts: this list is the closed set the extractor may choose from.',
        mono(lines.join('\n')),
        `/account add <id> <${BOOKS.join('|')}> <${KINDS.join('|')}> [display name]`,
        '/account off <id>     close it (history stays, extractor stops offering it)',
        '/account on <id>      reopen it',
        '',
        'Set a rate separately, so the gross-or-net word is never skipped:',
        '  /rate <id> 4% gross',
      ].join('\n'),
    };
  }

  if (verb === 'off' || verb === 'on') {
    if (!id) return { text: `Which account? /account ${verb} <id>` };
    const existing = (await db.allAccounts()).find((a) => a.id === id.toLowerCase());
    if (!existing) return { text: `No account "${id}".` };
    await db.batch([db.setAccountActive(existing.id, verb === 'on')]);
    return {
      text: `${existing.name} ${verb === 'on' ? 'reopened' : 'closed, history kept, no longer offered'}`,
    };
  }

  if (verb !== 'add') return { text: `Unknown: /account ${verb}. Try /account on its own.` };

  const [book, kind, ...nameParts] = rest;
  if (!id || !book || !kind)
    return { text: `/account add <id> <${BOOKS.join('|')}> <${KINDS.join('|')}> [display name]` };

  // The id goes into the LLM's enum and into every future row, so it is validated rather
  // than sanitised — a silently mangled id is an account you cannot spend from.
  const cleanId = id.toLowerCase();
  if (!/^[a-z][a-z0-9]{1,15}$/.test(cleanId))
    return {
      text: `"${id}" won't work as an id: lowercase letters and digits, 2-16 chars, e.g. seabank.`,
    };
  // The usage line rides along on both: spoken input reaches here as the same argument
  // string, and "Book must be one of" alone does not tell you where the word belongs.
  const usage = `/account add <id> <${BOOKS.join('|')}> <${KINDS.join('|')}> [display name]`;
  if (!BOOKS.includes(book as never)) return { text: `Book must be one of: ${BOOKS.join(', ')}\n${usage}` };
  if (!KINDS.includes(kind as never)) return { text: `Kind must be one of: ${KINDS.join(', ')}\n${usage}` };

  const all = await db.allAccounts();
  if (all.some((a) => a.id === cleanId))
    return { text: `"${cleanId}" already exists. /account on ${cleanId} to reopen.` };

  const name = nameParts.join(' ') || cleanId[0].toUpperCase() + cleanId.slice(1);
  await db.batch([db.addAccount({ id: cleanId, name, book, kind })]);

  const lines = [`${name} added · ${book} · ${kind} · untracked`];
  if (kind === 'credit') {
    // The sign convention, stated at the one moment it matters. Liabilities carry negative
    // balances so net worth stays SUM(balance) regardless of kind.
    lines.push('A credit account carries a NEGATIVE balance: spending on it increases what you owe.');
  }
  lines.push(`Anchor it: /snap ${cleanId} <amount>`);
  lines.push(`Earns interest? /rate ${cleanId} 4% gross`);
  return { text: lines.join('\n') };
}

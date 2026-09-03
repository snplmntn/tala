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
import type { Extracted } from './extract.ts';
import { addDays, dayDiff, peso, unsettled, type Event } from './ledger.ts';
import { correct, money, transfer, undo } from './entries.ts';
import { anchorAccount, proposeAnchor, snapshot } from './anchors.ts';
import { balances, csv, interest, rates, recap } from './reports.ts';
import { acct, nowIso, type CallbackReply, type Reply } from './reply.ts';
import { mono } from './telegram.ts';

export { anchorAccount, proposeAnchor, snapshot } from './anchors.ts';
export { balances, csv, interest, rates, recap } from './reports.ts';
export { correct, money, transfer, undo } from './entries.ts';
export type { CallbackReply, Reply } from './reply.ts';

export async function applyEvent(
  db: Db,
  accounts: Account[],
  e: Extracted,
  ctx: { inboxId: number; today: string; messageId?: number | null; hadPhoto: boolean },
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
      if (!e.amount) return { text: `${acct(accounts, e.account)?.name ?? e.account} — how much interest?` };
      return interest(db, accounts, [e.account, e.amount, e.date_hint].filter(Boolean).join(' '), ctx.today);
    }
    case 'open_account':
      // Straight to the command, arguments and all: /account add already owns the id rules,
      // the duplicate check and the credit-sign warning, and a second copy of that here is
      // how the two would drift. The extractor's job is only to write the arguments.
      // ponytail: created outright, no confirm button — /account off reverses it, and an
      // account with no rows costs nothing. Gate it if typos start opening accounts.
      return e.new_account
        ? accountsCmd(db, `add ${e.new_account}`)
        : { text: 'What should I call it? Like "open a seabank account".' };
    case 'query': {
      // The extractor already classified this, so honour it. A query is read-only: there is
      // no correctness argument for making you remember a slash command to ask a question.
      const kind = e.query_kind ?? 'balance';
      return (
        (await runCommand(db, accounts, `/${kind}`, ctx.today)) ?? { text: 'Ask me /balance or /recap.' }
      );
    }
    default:
      // The extractor writes this one, because it is the only reply with nothing to state:
      // no amount, no account, no row. Everything else is answered from real numbers below.
      return {
        text:
          e.reply?.trim() ||
          'Not sure what to do with that. Tell me what you spent — like "250 jollibee maribank" — or /help.',
      };
  }
}

// ── callbacks ───────────────────────────────────────────────────────────────

export async function callback(db: Db, data: string, today: string): Promise<CallbackReply> {
  const [kind, a, b] = data.split(':');
  const now = nowIso();

  if (kind === 'ok') {
    await db.batch([db.confirmEvent(Number(a), now)]);
    return { text: '✓ confirmed' };
  }

  if (kind === 'void') {
    // Always validate against CURRENT row state: a three-week-old inline keyboard stays
    // live in Telegram forever, so an unvalidated tap silently reverses a settled row.
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(a)]);
    if (!row) return { text: 'That row is gone.' };
    if (row.voided_at) return { text: 'Already voided.' };
    const anchor = await db.latestSnapshot(row.account_id);
    if (anchor && dayDiff(row.occurred_at, anchor.as_of_date) >= 0)
      return { text: 'That period is already reconciled — correct it instead.' };
    await db.batch([db.voidEvent(Number(a), now)]);
    return { text: '🗑 voided' };
  }

  if (kind === 'adj') {
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(b)]);
    if (!row || row.type !== 'adjustment') return { text: 'That row is gone.' };
    // The category is why this number is worth anything. Written to the row that already exists.
    await db.run('UPDATE events SET category = ? WHERE id = ? AND category IS NULL', [a, Number(b)]);
    return { text: `Tagged as ${a}.` };
  }

  if (kind === 'snap') {
    const account = (await db.accounts()).find((x) => x.id === a);
    if (!account) return { text: 'Unknown account.' };
    // The whole reply, keyboard included: a first anchor answers with another question.
    return anchorAccount(db, account, Number(b), today);
  }
  if (kind === 'anchored')
    return { text: 'Kept as counted — the earlier spending stays in your recap only.' };

  if (kind === 'anchorsub') {
    const account = (await db.accounts()).find((x) => x.id === a);
    if (!account) return { text: 'Unknown account.' };
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
    return {
      text: `Applied ${peso(Math.abs(amount))} — balance is now ${peso(anchor.balance_centavos + amount)}.`,
    };
  }

  if (kind === 'nope') return { text: 'Cancelled — nothing was written.' };
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
  { name: 'recap', args: '[YYYY-MM]', help: 'this month, or a past one' },
  { name: 'snap', args: '<account> <amount>', help: 'anchor a real balance from your banking app' },
  { name: 'interest', args: '[<account> <amount> [date]]', help: 'what you have earned, or report a credit' },
  { name: 'rate', args: '[account] [10% gross]', help: 'see rates, or set one' },
  { name: 'owed', args: '', help: 'money you fronted that has not come back' },
  { name: 'account', args: '[add|off|on] …', help: 'list accounts, or open and close them' },
  { name: 'name', args: '[what to call you]', help: 'what Tala calls you' },
  { name: 'undo', args: '', help: 'void the last entry' },
  { name: 'csv', args: '', help: 'the whole ledger as a spreadsheet' },
  { name: 'help', args: '', help: 'this' },
] as const;

export const HELP = [
  'Tala — just say what you spent.',
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
  ...COMMANDS.map((c) => `/${c.name}${c.args ? ' ' + c.args : ''} — ${c.help}`),
  '',
  'An ANCHOR is a real balance you read off your banking app. Everything is counted forward',
  'from it, so /snap is the one habit worth keeping — the rest is just telling me things.',
  '',
  'Balances show confirmed (what the bank credited) and expected (plus today’s',
  'uncredited interest). (est) means the rate is still a seed — /interest clears it.',
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
    name ? `Hi ${name} — let's set this up.` : "Welcome. I'm Tala, and I track your money in this chat.",
    '',
    ...(name ? [] : ['First, what should I call you?', '  /name Sean', '']),
    `${name ? 'Tell' : 'Then tell'} me what each account actually holds right now. That is an ANCHOR — the real`,
    'balance from your banking app — and everything gets counted forward from it.',
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
  if (!line.startsWith('/')) return null;
  const [raw, ...rest] = line.split(/\s+/);
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
      return { text: `Got it — ${next} it is.` };
    }
    case 'balance':
      return { text: (await firstRun(db, accounts)) ?? (await balances(db, accounts, today)) };
    case 'recap':
      return { text: await recap(db, rest[0] || today.slice(0, 7)) };
    case 'snap':
    case 'snapshot':
      return snapshot(db, accounts, arg, today);
    case 'interest':
      return interest(db, accounts, arg, today);
    case 'rate':
    case 'rates':
      return rates(db, accounts, arg);
    case 'account':
    case 'accounts':
      return accountsCmd(db, arg);
    case 'owed': {
      const owed = unsettled(await db.allEvents());
      return { text: owed > 0 ? `owed to you: ${peso(owed)}` : 'nothing outstanding' };
    }
    case 'undo':
      return { text: await undo(db) };
    case 'csv':
      return { text: 'ledger attached', document: { filename: `tala-${today}.csv`, content: await csv(db) } };
    default:
      return { text: `Unknown command /${cmd}. Try /help` };
  }
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
        'Accounts — this list is the closed set the extractor may choose from.',
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
      text: `${existing.name} ${verb === 'on' ? 'reopened' : 'closed — history kept, no longer offered'}`,
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
    return { text: `"${id}" won't work as an id — lowercase letters and digits, 2-16 chars, e.g. seabank.` };
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
    lines.push('A credit account carries a NEGATIVE balance — spending on it increases what you owe.');
  }
  lines.push(`Anchor it: /snap ${cleanId} <amount>`);
  lines.push(`Earns interest? /rate ${cleanId} 4% gross`);
  return { text: lines.join('\n') };
}

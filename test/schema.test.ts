/**
 * The schema's own guarantees, tested against a real database.
 *
 * ledger.test.ts covers the arithmetic and never opens a database — so until this file
 * existed, the append-only triggers were verified by nothing but having been read
 * carefully. That is the wrong thing to leave untested: their failure mode is not a crash,
 * it is a financial history that quietly became mutable, discovered years later when the
 * numbers stop tying.
 *
 * Runs against `file::memory:` — libSQL is SQLite, so schema.sql loads verbatim with no
 * network, no account and no fixture. Also the prerequisite for ever porting this schema
 * anywhere: a port without an oracle is a rewrite of a correctness invariant on faith.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Db } from '../src/db.ts';
import { manilaStartOfDay } from '../src/ledger.ts';
import {
  anchorAccount,
  applyEvent,
  balances,
  callback,
  dropFired,
  dueReminders,
  dueTimed,
  fenced,
  runCommand,
  tableAnswers,
} from '../src/handlers.ts';
import type { Extracted } from '../src/extract.ts';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

async function fresh(): Promise<Db> {
  const db = new Db('file::memory:');
  await db.executeMultiple(SCHEMA);
  return db;
}

const anEvent = (db: Db) =>
  db.run(
    `INSERT INTO events (type, book, account_id, amount_centavos, category, occurred_at, logged_at)
     VALUES ('expense','personal','maribank',-25000,'food','2026-09-03','2026-09-03T00:00:00Z')`,
  );

// ── the seed ────────────────────────────────────────────────────────────────

test('accounts seed with NET rates and a stable learner reference', async () => {
  const db = await fresh();
  const rows = await db.all<{ id: string; rate: number; rate_seed: number; rate_source: string }>(
    'SELECT id, rate, rate_seed, rate_source FROM accounts ORDER BY sort',
  );
  assert.equal(rows.length, 6);

  const maya = rows.find((r) => r.id === 'maya')!;
  // 10% advertised gross x 0.80 for the PH final withholding tax. Seeding gross would leave
  // every projection 25% hot and the learner fighting a permanent bias.
  assert.equal(maya.rate, 0.08);
  assert.equal(maya.rate_seed, 0.08, 'rate_seed must start equal to rate');
  assert.equal(maya.rate_source, 'seeded_net');

  assert.equal(rows.find((r) => r.id === 'maribank')!.rate, 0.026); // 3.25% gross
  assert.equal(rows.find((r) => r.id === 'gcash')!.rate, 0); // does not earn
  assert.equal(rows.find((r) => r.id === 'gotyme')!.rate, 0); // untracked on purpose
});

// ── append-only, the invariant the whole design leans on ────────────────────

test('an amount can never be updated', async () => {
  const db = await fresh();
  await anEvent(db);
  await assert.rejects(() => db.run('UPDATE events SET amount_centavos = 1 WHERE id = 1'), /append-only/);
  const [row] = await db.all<{ amount_centavos: number }>('SELECT amount_centavos FROM events');
  assert.equal(row.amount_centavos, -25000, 'the original amount must survive the attempt');
});

test('a row can never be deleted', async () => {
  const db = await fresh();
  await anEvent(db);
  await assert.rejects(() => db.run('DELETE FROM events WHERE id = 1'), /append-only/);
  await assert.rejects(() => db.run('DELETE FROM events'), /append-only/);
});

test('every other column is frozen too, not just the amount', async () => {
  const db = await fresh();
  await anEvent(db);
  for (const sql of [
    "UPDATE events SET account_id = 'gcash' WHERE id = 1",
    "UPDATE events SET occurred_at = '2026-01-01' WHERE id = 1",
    "UPDATE events SET category = 'shopping' WHERE id = 1",
    "UPDATE events SET book = 'business' WHERE id = 1",
    "UPDATE events SET type = 'income' WHERE id = 1",
    'UPDATE events SET corrects_id = 1 WHERE id = 1',
    "UPDATE events SET transfer_id = 'x' WHERE id = 1",
  ]) {
    await assert.rejects(() => db.run(sql), /append-only/, sql);
  }
});

test('the three set-once columns are settable exactly once', async () => {
  // This is the case a careless reading misses: not "voided_at is writable", but
  // "voided_at is writable once and then frozen". A second write must fail, or a void
  // could be silently walked back and the ledger would have no record of it.
  for (const col of ['voided_at', 'confirmed_at', 'settled_at']) {
    const db = await fresh();
    await anEvent(db);

    await db.run(`UPDATE events SET ${col} = '2026-09-03T00:00:00Z' WHERE id = 1`);
    const [set] = await db.all<Record<string, string | null>>(`SELECT ${col} AS v FROM events`);
    assert.equal(set.v, '2026-09-03T00:00:00Z', `${col} should be settable once`);

    await assert.rejects(
      () => db.run(`UPDATE events SET ${col} = '2026-09-04T00:00:00Z' WHERE id = 1`),
      /append-only/,
      `${col} must be frozen after the first write`,
    );
    await assert.rejects(
      () => db.run(`UPDATE events SET ${col} = NULL WHERE id = 1`),
      /append-only/,
      `${col} must never be cleared`,
    );
  }
});

test('a set-once column cannot smuggle another change alongside it', async () => {
  const db = await fresh();
  await anEvent(db);
  await assert.rejects(
    () => db.run("UPDATE events SET voided_at = '2026-09-03T00:00:00Z', amount_centavos = 1 WHERE id = 1"),
    /append-only/,
  );
  const [row] = await db.all<{ amount_centavos: number; voided_at: string | null }>(
    'SELECT amount_centavos, voided_at FROM events',
  );
  assert.equal(row.amount_centavos, -25000);
  assert.equal(row.voided_at, null, 'the whole statement must be rejected, not partly applied');
});

// ── the snapshot anchor: idempotent by constraint, not by convention ────────

test('re-anchoring the same day supersedes instead of duplicating', async () => {
  // UNIQUE(account_id, as_of_date) is what makes month-close idempotent, so there is no
  // separate close event that can be run twice and double the interest. It is also the
  // undo for a fat-fingered number.
  const db = await fresh();
  const put = (n: number) =>
    db.batch([
      {
        sql: `INSERT INTO snapshots (account_id, as_of_date, balance_centavos, logged_at)
              VALUES ('maribank','2026-09-03',?, '2026-09-03T00:00:00Z')
              ON CONFLICT(account_id, as_of_date)
              DO UPDATE SET balance_centavos = excluded.balance_centavos`,
        args: [n],
      },
    ]);

  await put(1_300_000);
  await put(1_300_000); // a second close must change nothing
  await put(1_285_000); // a corrected reading must supersede

  const rows = await db.all<{ balance_centavos: number }>('SELECT balance_centavos FROM snapshots');
  assert.equal(rows.length, 1, 'one anchor per account per day, always');
  assert.equal(rows[0].balance_centavos, 1_285_000);
});

// ── the inbox: the idempotency guard against Telegram redelivery ────────────

test('the same telegram update cannot be claimed twice', async () => {
  // Telegram redelivers anything unacknowledged, and a free tier that spins down makes
  // mid-handler death routine — so this is what stands between a retry and a duplicate
  // expense that drift would then silently absorb.
  const db = await fresh();
  const claim = () =>
    db.claim({
      update_id: 999,
      text: '250 jollibee maribank',
      has_photo: false,
      now: '2026-09-03T00:00:00Z',
    });

  const first = await claim();
  assert.ok(first && first > 0, 'the first claim wins');
  assert.equal(await claim(), null, 'the redelivery must be refused, not applied again');
});

// ── money precision: the reason every column is INTEGER centavos ────────────

test('a large peso balance survives a round trip exactly', async () => {
  // ₱21,474,836.47 is where a 4-byte integer would cap. SQLite's INTEGER is a dynamic
  // up-to-8-byte type, so this is only a hazard if the schema is ever ported — noted here
  // so a port has to make this test fail before it can ship.
  const db = await fresh();
  const big = 9_999_999_999; // ₱99,999,999.99
  await db.run(
    `INSERT INTO snapshots (account_id, as_of_date, balance_centavos, logged_at)
     VALUES ('maya','2026-09-03',?,'2026-09-03T00:00:00Z')`,
    [big],
  );
  const [row] = await db.all<{ balance_centavos: number }>('SELECT balance_centavos FROM snapshots');
  assert.equal(row.balance_centavos, big);
  assert.equal(typeof row.balance_centavos, 'number', 'must arrive as a number, never a string');
});

// ── adding an account: one INSERT, and the extractor's enum follows ─────────

test('a new account joins the extractor enum with no redeploy', async () => {
  // This is the whole reason accounts are rows rather than a TypeScript union: the closed
  // set handed to the LLM is read from the table at request time, so opening SeaBank is one
  // INSERT and you can log SeaBank expenses immediately.
  const db = await fresh();
  assert.equal((await db.accountIds()).includes('seabank'), false);

  await db.batch([db.addAccount({ id: 'seabank', name: 'SeaBank', book: 'personal', kind: 'bank' })]);
  assert.equal((await db.accountIds()).includes('seabank'), true);

  // Untracked by default: a rate has to be set deliberately, with its gross-or-net basis.
  const [row] = await db.all<{ rate: number; rate_source: string; active: number }>(
    "SELECT rate, rate_source, active FROM accounts WHERE id = 'seabank'",
  );
  assert.equal(row.rate, 0);
  assert.equal(row.active, 1);
});

test('an account is opened by talking, and only the kind is asked', async () => {
  // The extractor's account field is a closed enum, so the only way in used to be
  // /account add — and the bot answered "I can't open an account for you".
  const db = await fresh();
  const spoken = (name: string | null, book: 'personal' | 'business' | null = null) =>
    applyEvent(db, [], spokenEvent({ intent: 'open_account', new_account: name, new_account_book: book }), {
      inboxId: 1,
      today: '2026-09-03',
      hadPhoto: false,
    });

  // A name is all the model is asked for: the id is derived, the kind is a tap.
  const ask = await spoken('Beep Card');
  assert.match(ask.text, /Open Beep Card as a personal account/);
  assert.equal((await db.accountIds()).includes('beepcard'), false, 'asking must not write');
  const kinds = ask.keyboard![0].map((b) => b.text);
  assert.deepEqual(kinds, ['bank', 'ewallet', 'cash', 'credit']);

  const created = await callback(db, ask.keyboard![0][1].callback_data, '2026-09-03');
  assert.match(created.text, /Beep Card added/);
  assert.equal((await db.accountIds()).includes('beepcard'), true, 'usable on the very next message');
  const [row] = await db.all<{ name: string; book: string; kind: string }>(
    "SELECT name, book, kind FROM accounts WHERE id = 'beepcard'",
  );
  assert.deepEqual(row, { name: 'Beep Card', book: 'personal', kind: 'ewallet' });

  assert.match((await spoken('Beep Card')).text, /already open/, 'never asks twice');
  await db.batch([db.setAccountActive('beepcard', false)]);
  assert.match((await spoken('beep card')).text, /closed/, 'a closed one is reopened, not duplicated');

  assert.match((await spoken('Kita', 'business')).text, /as a business account/);
  assert.match((await spoken(null)).text, /What should I call it/);
  assert.match((await spoken('!!')).text, /What should I call it/, 'an id must survive the name');
});

test('closing an account hides it from the enum but keeps its history', async () => {
  // Never a DELETE: events reference accounts, so deleting would either fail on the foreign
  // key or orphan rows. Closing has to preserve every past figure.
  const db = await fresh();
  await db.run(
    `INSERT INTO events (type, book, account_id, amount_centavos, occurred_at, logged_at)
     VALUES ('expense','personal','gcash',-5000,'2026-09-03','2026-09-03T00:00:00Z')`,
  );

  await db.batch([db.setAccountActive('gcash', false)]);
  assert.equal((await db.accountIds()).includes('gcash'), false, 'no longer offered to the extractor');
  assert.equal(
    (await db.allAccounts()).some((a) => a.id === 'gcash'),
    true,
    'still listed for the owner',
  );

  const [kept] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE account_id = 'gcash'");
  assert.equal(kept.n, 1, 'history survives a closed account');

  await db.batch([db.setAccountActive('gcash', true)]);
  assert.equal((await db.accountIds()).includes('gcash'), true, 'and it can be reopened');
});

// ── prose may PROPOSE an anchor; only a tap writes one ──────────────────────

test('a natural-language anchor writes nothing until confirmed', async () => {
  // The anchor is the one number the design trusts unconditionally, so a misparse must not
  // be able to write a garbage baseline plus the phantom adjustment row that follows it.
  // Prose proposes; a tap commits. This is the same capture-and-confirm rule as reading a
  // balance off a screenshot.
  const db = await fresh();
  const accounts = await db.accounts();
  const base = {
    amount: '98,000',
    account: 'maya',
    to_account: null,
    category: null,
    merchant: null,
    note: null,
    date_hint: null,
    shared_amount: null,
    recurrence: 'one_off' as const,
    fee: null,
    query_kind: null,
    match_amount: null,
    match_merchant: null,
    looks_like_transfer: false,
    whole_balance: false,
    new_account: null,
    new_account_book: null,
    reply: null,
    ask: null,
  };

  const proposal = await applyEvent(
    db,
    accounts,
    { ...base, intent: 'snapshot' },
    {
      inboxId: 1,
      today: '2026-09-03',
      hadPhoto: false,
    },
  );

  assert.match(proposal.text, /Anchor Maya Savings at ₱98,000\.00/);
  assert.ok(proposal.keyboard, 'a proposal must offer a confirm button');
  assert.equal(proposal.keyboard![0][0].callback_data, 'snap:maya:9800000');

  const [before] = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM snapshots');
  assert.equal(before.n, 0, 'proposing must not write');

  await callback(db, 'snap:maya:9800000', '2026-09-03');
  const rows = await db.all<{ account_id: string; balance_centavos: number }>(
    'SELECT account_id, balance_centavos FROM snapshots',
  );
  assert.equal(rows.length, 1, 'the tap writes exactly one anchor');
  assert.equal(rows[0].balance_centavos, 9_800_000);

  // Cancelling writes nothing either.
  assert.match((await callback(db, 'nope', '2026-09-03')).text, /cancelled/);
});

test('a spoken question is answered, not redirected to a slash command', async () => {
  // The extractor already classifies query_kind. Throwing it away and replying "use
  // /balance" is friction with no correctness argument behind it — a query is read-only.
  const db = await fresh();
  const accounts = await db.accounts();
  // Anchored first: an un-anchored ledger answers every balance question with the first-run
  // walkthrough instead, which is a different behaviour with its own test below.
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'maya')!,
    9_800_000,
    '2026-09-03',
  );
  const reply = await applyEvent(
    db,
    accounts,
    {
      intent: 'query',
      query_kind: 'balance',
      amount: null,
      account: null,
      to_account: null,
      category: null,
      merchant: null,
      note: null,
      date_hint: null,
      shared_amount: null,
      recurrence: 'one_off',
      fee: null,
      match_amount: null,
      match_merchant: null,
      looks_like_transfer: false,
      whole_balance: false,
      new_account: null,
      new_account_book: null,
      reply: null,
      ask: null,
    },
    { inboxId: 1, today: '2026-09-03', hadPhoto: false },
  );
  assert.match(reply.text, /Maya Savings/, 'it should answer with the balance itself');
  assert.doesNotMatch(reply.text, /Ask with/, 'not a pointer to a command');
});

test('a ledger with no anchors is walked through setup, not shown a table of zeros', async () => {
  // Before the first anchor every number in the app is zero and the balance table is a list
  // of things that have not happened yet — which is what the screenshots showed, and what
  // left a new user typing /snap for each account with nothing telling them to.
  const db = await fresh();
  const accounts = await db.accounts();

  const cold = await runCommand(db, accounts, '/balance', '2026-09-03');
  assert.match(cold!.text, /ANCHOR/, 'it must say what an anchor is');
  assert.match(cold!.text, /what should I call you/i, 'and ask for a name while nothing is set');

  await db.setSetting('owner_name', 'Sean');
  assert.match((await runCommand(db, accounts, '/balance', '2026-09-03'))!.text, /Hi Sean/);
  assert.doesNotMatch(
    (await runCommand(db, accounts, '/balance', '2026-09-03'))!.text,
    /what should I call you/i,
    'it must stop asking once it knows',
  );

  // One anchor is the whole difference: from here it is a real ledger and answers like one.
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'maya')!,
    9_800_000,
    '2026-09-03',
  );
  assert.match((await runCommand(db, accounts, '/balance', '2026-09-03'))!.text, /Maya Savings/);
});

// ── the first anchor, when spending was already logged ──────────────────────

test('an un-anchored account is excluded from the book total, and says so', async () => {
  // The bug this replaced: a ₱250 cash expense with no anchor reported a -₱250 BALANCE and
  // dragged the whole book's "expected" to -₱250 — presenting an unknown baseline plus a
  // known outflow as net worth. A total must be either right or visibly incomplete.
  const db = await fresh();
  const accounts = await db.accounts();
  await db.run(
    `INSERT INTO events (type, book, account_id, amount_centavos, category, occurred_at, logged_at)
     VALUES ('expense','personal','cash',-25000,'food','2026-09-03','2026-09-03T00:00:00Z')`,
  );

  const out = await balances(db, accounts, '2026-09-03');
  assert.match(out, /Cash on hand\s+not anchored\s+₱250\.00 logged/);
  assert.doesNotMatch(out, /-₱250\.00/, 'a flow must never be rendered as a negative balance');
  // Per book, because each book has its own total to qualify.
  assert.match(out, /excludes 5 un-anchored: maya, maribank, gcash, bdo, cash/);
  assert.match(out, /excludes 1 un-anchored: gotyme/);
});

test('tapping ✓ anchor it carries the follow-up question, keyboard and all', async () => {
  // The regression this exists for: callback() used to return a bare string, so the
  // keyboard anchorAccount attaches to a first anchor was dropped and the multi-line text
  // was crammed into a 200-char toast. The one question the design can only ask once per
  // account arrived as nothing at all.
  const db = await fresh();
  await db.run(
    `INSERT INTO events (type, book, account_id, amount_centavos, category, occurred_at, logged_at)
     VALUES ('expense','personal','cash',-25000,'food','2026-09-03','2026-09-03T00:00:00Z')`,
  );

  const r = await callback(db, 'snap:cash:150000', '2026-09-03');
  assert.match(r.text, /already logged ₱250\.00/);
  assert.ok(r.keyboard, 'the tap must be able to ask another question');
  assert.equal(r.keyboard![1][0].callback_data, 'anchorsub:cash:-25000');
  assert.notEqual(r.advice, true, 'an anchor is an action, so its buttons must be retired');

  // Guidance is the exception: it leaves the row's buttons alone, because you may not follow through.
  assert.equal((await callback(db, 'fix:1', '2026-09-03')).advice, true);
});

test('the first anchor asks whether the count was before or after logged spending', async () => {
  // Nothing in the data distinguishes "₱1,500 is in my wallet now, after the ₱250" from
  // "₱1,500 is what I had before it". The two differ by exactly that ₱250, so guessing
  // either way silently corrupts the baseline every later balance inherits.
  const db = await fresh();
  const accounts = await db.accounts();
  const cash = accounts.find((a) => a.id === 'cash')!;
  await db.run(
    `INSERT INTO events (type, book, account_id, amount_centavos, category, occurred_at, logged_at)
     VALUES ('expense','personal','cash',-25000,'food','2026-09-03','2026-09-03T00:00:00Z')`,
  );

  const r = await anchorAccount(db, cash, 150_000, '2026-09-03');
  assert.match(r.text, /already logged ₱250\.00/);
  assert.ok(r.keyboard, 'it must ask, not choose');
  assert.equal(r.keyboard![0][0].callback_data, 'anchored:cash');
  assert.equal(r.keyboard![1][0].callback_data, 'anchorsub:cash:-25000');

  // Counted-after: the anchor stands alone, spending stays in the recap only.
  assert.match((await callback(db, 'anchored:cash', '2026-09-03')).text, /Kept as counted/);
  assert.match(await balances(db, accounts, '2026-09-03'), /Cash on hand\s+₱1,500\.00/);

  // Counted-before: an explicit adjustment applies it. The anchor itself is never rewritten,
  // so the ledger records why the balance differs from the figure that was typed.
  // Also a cross-check on remaining(): the figure now comes from balanceFor(), and it has
  // to agree with the anchor-plus-adjustment arithmetic this assertion was written against.
  assert.match((await callback(db, 'anchorsub:cash:-25000', '2026-09-03')).text, /₱1,250\.00 left/);
  assert.match(await balances(db, accounts, '2026-09-03'), /Cash on hand\s+₱1,250\.00/);

  const [anchor] = await db.all<{ balance_centavos: number }>(
    "SELECT balance_centavos FROM snapshots WHERE account_id = 'cash'",
  );
  assert.equal(anchor.balance_centavos, 150_000, 'the anchor keeps the figure you typed');
});

test('a later anchor does not ask again', async () => {
  // The ambiguity is a first-anchor problem only. After that, drift answers the same
  // question quantitatively and the three-button tag explains it.
  const db = await fresh();
  const cash = (await db.accounts()).find((a) => a.id === 'cash')!;
  await anchorAccount(db, cash, 150_000, '2026-09-01');
  const second = await anchorAccount(db, cash, 140_000, '2026-09-03');
  assert.doesNotMatch(second.text, /already logged/);
  assert.match(second.text, /drift/, 'it reports drift instead');
});

// ── reported credits, and the period they are divided by ────────────────────

/** Every Extracted field, so a test only states the ones it is about. */
const spokenEvent = (p: Partial<Extracted>): Extracted => ({
  intent: 'unknown',
  amount: null,
  account: null,
  to_account: null,
  category: null,
  merchant: null,
  note: null,
  date_hint: null,
  shared_amount: null,
  recurrence: 'one_off',
  fee: null,
  query_kind: null,
  match_amount: null,
  match_merchant: null,
  looks_like_transfer: false,
  whole_balance: false,
  new_account: null,
  new_account_book: null,
  reply: null,
  ask: null,
  ...p,
});

interface Obs {
  period_start: string;
  period_end: string;
  centavo_days: number;
  credited_centavos: number;
  implied_rate: number;
  accepted: number;
}
const observations = (db: Db) =>
  db.all<Obs>(
    'SELECT period_start, period_end, centavo_days, credited_centavos, implied_rate, accepted FROM rate_observations ORDER BY id',
  );
const rateOf = async (db: Db, id: string) =>
  (await db.one<{ rate: number }>('SELECT rate FROM accounts WHERE id = ?', [id]))!.rate;

test('a credit is divided by ITS OWN period, not by everything since the anchor', async () => {
  // The bug this pins down: the period used to run from the last ANCHOR, so reporting one
  // day's ₱21.48 against a ten-day-old anchor implied 0.8% instead of 8% — inside the
  // 2x-seed guard, so it was accepted and written over a correct seed. Reporting daily is
  // the habit the design wants, and it was the input that destroyed the rate.
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/snap maya 98000', '2026-09-01');

  // ₱98,000 at 8% net = round(9_800_000 * 0.08 / 365) = 2148 centavos a day.
  await runCommand(db, accounts, '/interest maya 21.48 2026-09-02', '2026-09-02');
  await runCommand(db, accounts, '/interest maya 21.48 2026-09-03', '2026-09-03');

  const obs = await observations(db);
  assert.equal(obs.length, 2);

  // First: (anchor, first credit] — one day, so the denominator is the anchor balance itself.
  assert.deepEqual(
    [obs[0].period_start, obs[0].period_end, obs[0].centavo_days],
    ['2026-09-01', '2026-09-02', 9_800_000],
  );
  assert.equal(obs[0].accepted, 0, 'one observation can be a partial period — two are required');

  // Second: the period starts at the PREVIOUS CREDIT, not the anchor. Under the old rule
  // this would have been 2 days of centavo-days and implied ~4%.
  assert.equal(obs[1].period_start, '2026-09-02');
  assert.equal(obs[1].centavo_days, 9_802_148, 'the balance at the close of the previous credit day');
  assert.equal(obs[1].accepted, 1);
  assert.ok(Math.abs(obs[1].implied_rate - 0.08) < 0.0005, `implied ${obs[1].implied_rate}, wanted ~0.08`);
  assert.ok(Math.abs((await rateOf(db, 'maya')) - 0.08) < 0.0005, 'the learned rate recovers the truth');
});

test('anchoring before reporting the credit no longer costs the lesson', async () => {
  // You read the app, so you /snap first — and that anchor is dated the same day as the
  // credit you are about to report. Dividing by a window that starts on that anchor is a
  // zero-day window, which used to answer "balance too small to infer a rate" and learn
  // nothing. The opening balance comes from the snapshot BEFORE the credit date instead.
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/snap maya 98000', '2026-09-01');
  await runCommand(db, accounts, '/interest maya 21.48 2026-09-02', '2026-09-02');

  // Anchor at the derived figure so there is no drift to confuse the check.
  await runCommand(db, accounts, '/snap maya 98021.48', '2026-09-03');
  const reply = await runCommand(db, accounts, '/interest maya 21.48', '2026-09-03');

  assert.doesNotMatch(reply!.text, /too small/);
  const obs = await observations(db);
  assert.equal(obs.at(-1)!.period_start, '2026-09-02', 'the same period either way round');
  assert.equal(obs.at(-1)!.centavo_days, 9_802_148);
});

test('correcting a credit re-teaches the rate, not just the row', async () => {
  // Without this the row ends up right while the rate keeps the lesson it learned from the
  // wrong number — so "fix the interest and the maths follows" would only be half true.
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/snap maya 98000', '2026-09-01');
  await runCommand(db, accounts, '/interest maya 21.48 2026-09-02', '2026-09-02');
  await runCommand(db, accounts, '/interest maya 21.48 2026-09-03', '2026-09-03');
  const before = await rateOf(db, 'maya');

  const inboxId = (await db.claim({ update_id: 1, has_photo: false, now: '2026-09-03T00:00:00Z' }))!;
  const fixed = await applyEvent(
    db,
    accounts,
    spokenEvent({ intent: 'correction', account: 'maya', match_amount: '21.48', amount: '25.00' }),
    { inboxId, today: '2026-09-03', hadPhoto: false },
  );
  assert.match(fixed.text, /₱25\.00/);

  const obs = await observations(db);
  assert.equal(obs.at(-1)!.credited_centavos, 2500, 'the corrected amount is what got divided');
  assert.equal(obs.at(-1)!.period_start, '2026-09-02', "over the corrected row's own period");
  assert.notEqual(await rateOf(db, 'maya'), before);

  // And the ledger counts the credit once, at the corrected figure.
  const list = await runCommand(db, accounts, '/interest', '2026-09-03');
  assert.match(list!.text, /46\.48/, 'the 21.48 that stands plus the corrected 25.00');
});

test('/interest with no arguments lists what you have earned, per account and in total', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  assert.match((await runCommand(db, accounts, '/interest', '2026-09-03'))!.text, /No interest reported yet/);

  await runCommand(db, accounts, '/snap maya 98000', '2026-09-01');
  await runCommand(db, accounts, '/snap maribank 50000', '2026-09-01');
  await runCommand(db, accounts, '/interest maya 21.48 2026-09-02', '2026-09-02');
  await runCommand(db, accounts, '/interest maribank 3.56 2026-09-02', '2026-09-02');

  const list = (await runCommand(db, accounts, '/interest', '2026-09-03'))!.text;
  assert.match(list, /maya/);
  assert.match(list, /maribank/);
  assert.match(list, /total\s+₱25\.04/);
});

test('a date that cannot be read is refused by name, never filed under today', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  assert.match(
    (await runCommand(db, accounts, '/interest maya 21.48 the other day', '2026-09-03'))!.text,
    /Couldn't read "the other day" as a date/,
  );
  assert.match(
    (await runCommand(db, accounts, '/interest maya 21.48 2026-09-10', '2026-09-03'))!.text,
    /has not happened yet/,
  );
  assert.equal(await db.one('SELECT 1 FROM events'), null, 'and nothing was written');
});

// -- reminders ---------------------------------------------------------------

test('a reminder is one-off by default and repeats only when asked', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  const cmd = (line: string, today = '2026-09-03') => runCommand(db, accounts, line, today);

  assert.match((await cmd('/remind'))!.text, /Nothing set/);

  // Default: once. "every" is the opt-in.
  assert.match((await cmd('/remind eom boost maya'))!.text, /the last day, once/);
  assert.match((await cmd('/remind eom boost maya again'))!.text, /next 2026-09-30/);
  assert.match((await cmd('/remind every 25 internet bill'))!.text, /day 25, every time it comes round/);
  assert.match((await cmd('/remind every fri water the plants'))!.text, /Fri, every/);

  const listed = (await cmd('/remind'))!.text;
  assert.match(listed, /boost maya/);
  assert.match(listed, /internet bill/);
  assert.match(listed, /water the plants/, 'nothing about the list is financial');

  // A junk day is refused rather than guessed at. "money" and "satisfy" are the ones that
  // matter: a prefix match on weekday names swallows both, and the reminder silently moves.
  assert.match((await cmd('/remind someday call mom'))!.text, /Couldn.t read "someday" as a day/);
  assert.match((await cmd('/remind money check the card'))!.text, /Couldn.t read "money" as a day/);
  assert.match((await cmd('/remind satisfy the audit'))!.text, /Couldn.t read "satisfy" as a day/);
  assert.match((await cmd('/remind tuesday standup notes'))!.text, /Tue, once/);
  assert.match((await cmd('/remind eom'))!.text, /Remind you of what/);

  await cmd('/remind off 1');
  assert.doesNotMatch((await cmd('/remind'))!.text, /boost maya once/);
});

test('a one-off fires once and retires itself; a repeating one stays', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/remind eom boost maya', '2026-09-03');
  await runCommand(db, accounts, '/remind every eom snap everything', '2026-09-03');

  const due = await dueReminders(db, ['2026-09-30']);
  assert.deepEqual(due.map((r) => r.text).sort(), ['boost maya', 'snap everything']);

  await dropFired(db, due);
  const after = await dueReminders(db, ['2026-10-31']);
  assert.deepEqual(
    after.map((r) => r.text),
    ['snap everything'],
    'the one-off is gone, the repeating one comes round again',
  );
});

test('a reminder that came due while the process was down still fires, late', async () => {
  // The daily line used to mark itself in memory, so a process that was down all of the
  // 25th silently never sent the 25th. A balance table can be retyped; a reminder is gone.
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/remind 25 renew the domain', '2026-09-20');

  assert.deepEqual(await dueReminders(db, ['2026-09-27']), [], 'not due on the day it booted');
  const caught = await dueReminders(db, ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
  assert.deepEqual(
    caught.map((r) => r.text),
    ['renew the domain'],
    'the catch-up window covers the days that were missed',
  );
});

test('a reminder can name an exact time, and fires from the minute tick instead', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  const cmd = (line: string, today = '2026-09-25') => runCommand(db, accounts, line, today);

  assert.match((await cmd('/remind 25 17:00 pay the bill'))!.text, /day 25 at 17:00, once/);
  assert.match((await cmd('/remind every mon 9:30pm meds'))!.text, /Mon at 21:30, every/);
  assert.match((await cmd('/remind'))!.text, /17:00/);

  // A number that is not written like a time stays part of the text, so the reminder is
  // about the bill rather than silently rescheduled to 09:00.
  assert.match((await cmd('/remind 25 9 internet bill'))!.text, /^⏰ 9 internet bill/);

  // The daily line must not carry a timed row: two carriers, one reminder each.
  assert.deepEqual(
    (await dueReminders(db, ['2026-09-25'])).map((r) => r.text),
    ['9 internet bill'],
  );

  // The window is (scan, now]: due once, then never again from an advanced marker.
  const before = '2026-09-25T08:59:00.000Z'; // 16:59 Manila
  const after = '2026-09-25T09:01:00.000Z'; // 17:01 Manila
  assert.deepEqual(
    (await dueTimed(db, before, after)).map((r) => r.text),
    ['pay the bill'],
  );
  assert.deepEqual(await dueTimed(db, after, '2026-09-25T09:02:00.000Z'), [], 'not fired twice');

  // Down over the slot, back two hours later: late, not lost.
  assert.deepEqual(
    (await dueTimed(db, before, '2026-09-25T11:00:00.000Z')).map((r) => r.text),
    ['pay the bill'],
  );

  // A one-off retires on firing; the repeating 21:30 one comes round the next Monday.
  await dropFired(db, await dueTimed(db, before, after));
  assert.deepEqual(await dueTimed(db, before, after), []);
  assert.deepEqual(
    (await dueTimed(db, '2026-09-28T13:29:00.000Z', '2026-09-28T13:31:00.000Z')).map((r) => r.text),
    ['meds'],
    'Monday 21:30 Manila',
  );
});

test('a question the report already answers gets no prose under it', () => {
  // The bug: "how much did i spend yday" reached answer(), which then hedged about the
  // ₱468.00 printed two lines above it. A dated, totalled table needs no paragraph.
  assert.ok(tableAnswers('how much did i spend yday'));
  assert.ok(tableAnswers('what did I spend on food this month'));
  assert.ok(tableAnswers('how much do I have'));
  // Questions ABOUT the numbers still get one.
  assert.ok(!tableAnswers('did my interest get added to my balance?'));
  assert.ok(!tableAnswers('why does maya still say est?'));
  assert.ok(!tableAnswers('is that the whole day?'));
  assert.ok(!tableAnswers('what does est mean'));
});

test('a fenced answer becomes a monospace block, and only a fenced one', () => {
  // The answer to "what are all my gotyme expenses" is rows, not a paragraph, so the model
  // fences a table and this is what turns it into a <pre> the columns line up inside.
  const out = fenced('GoTyme, since the anchor:\n```\ndinner   897.00\ndinner   299.00\n```');
  assert.match(out, /\u0001dinner {3}897\.00\ndinner {3}299\.00\u0002$/);
  // A model that types the marker itself must not be able to open a block: only fences do.
  assert.equal(fenced('\u0001not a table\u0002'), 'not a table');
  // Prose comes back untouched, so an explanation never gains a stray block.
  assert.equal(fenced('Yes, the 21.48 is already inside it.'), 'Yes, the 21.48 is already inside it.');
});

test('reminder text cannot smuggle a monospace marker into the daily line', async () => {
  // telegram.ts escapes every outgoing string, but it marks its monospace blocks with
  // control characters - those are markup, and user text must not be able to carry them.
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/remind eom <b>' + '\u0001' + 'hi</b>', '2026-09-03');
  const [row] = await dueReminders(db, ['2026-09-30']);
  assert.equal(row.text, '<b>hi</b>', 'the marker is stripped; the tags stay inert text');
});

// -- recap windows -----------------------------------------------------------

const anExpense = (db: Db, o: Record<string, unknown>) =>
  db.run(
    `INSERT INTO events (type, book, account_id, amount_centavos, category, merchant,
       shared_amount_centavos, occurred_at, logged_at, corrects_id, voided_at)
     VALUES ('expense','personal','maribank',?,?,?,?,?,?,?,?)`,
    [
      o.amt as number,
      (o.cat as string) ?? null,
      (o.merch as string) ?? null,
      (o.shared as number) ?? null,
      o.date as string,
      (o.logged as string) ?? `${o.date as string}T02:00:00Z`,
      (o.corrects as number) ?? null,
      (o.voided as string) ?? null,
    ],
  );

async function aWeekOfSpending(): Promise<Db> {
  const db = await fresh();
  await anExpense(db, { date: '2026-08-31', amt: -28500, cat: 'food', merch: 'jollibee' });
  await anExpense(db, { date: '2026-09-01', amt: -1500, cat: 'transport', merch: 'jeep' });
  await anExpense(db, { date: '2026-09-03', amt: -60000, cat: 'food', merch: 'ramen nagi', shared: 40000 });
  await anExpense(db, {
    date: '2026-09-03',
    amt: -99900,
    cat: 'shopping',
    merch: 'oops duplicate',
    voided: '2026-09-03T05:00:00Z',
  });
  const root = await anExpense(db, { date: '2026-09-03', amt: -25000, cat: 'food', merch: 'starbucks' });
  await anExpense(db, { date: '2026-09-03', amt: -28500, cat: 'food', merch: 'starbucks', corrects: root });
  return db;
}

test('recap defaults to today and itemises it', async () => {
  // A day is a handful of rows, so the rows ARE the recap — category totals over three
  // items is a summary of something already visible.
  const db = await aWeekOfSpending();
  const text = (await runCommand(db, await db.accounts(), '/recap', '2026-09-03'))!.text;
  assert.match(text, /Thu 2026-09-03/);
  assert.match(text, /ramen nagi/);
  assert.match(text, /starbucks/);
  assert.doesNotMatch(text, /jollibee/, 'a different day is not in it');
});

test('a voided row is not shown and a corrected one is shown once', async () => {
  const db = await aWeekOfSpending();
  const text = (await runCommand(db, await db.accounts(), '/recap', '2026-09-03'))!.text;
  assert.doesNotMatch(text, /oops duplicate/, 'voided rows are gone from every view');
  assert.doesNotMatch(text, /250\.00/, 'the superseded amount never appears');
  assert.match(text, /285\.00/, 'the corrected amount does');
  // 200 (your half of the ramen) + 285 (the corrected starbucks) = 485.
  assert.match(text, /spent\s+₱485\.00/);
});

test('a shared expense counts only your share, and says whose the rest was', async () => {
  const db = await aWeekOfSpending();
  const text = (await runCommand(db, await db.accounts(), '/recap', '2026-09-03'))!.text;
  assert.match(text, /ramen nagi\s+₱200\.00\s+\(₱400\.00 not yours\)/);
});

test('a week runs Monday to today and groups by day, across a month boundary', async () => {
  const db = await aWeekOfSpending();
  const text = (await runCommand(db, await db.accounts(), '/recap week', '2026-09-03'))!.text;
  assert.match(text, /week of 2026-08-31/, 'Thursday belongs to the week that opened in August');
  assert.match(text, /Mon 2026-08-31/);
  assert.match(text, /Tue 2026-09-01/);
  assert.match(text, /jollibee/, 'and August 31st is in it');
  // 285 + 15 + 200 + 285
  assert.match(text, /spent\s+₱785\.00/);
});

test('a month totals by category, and `list` asks for the rows instead', async () => {
  const db = await aWeekOfSpending();
  const accounts = await db.accounts();
  const totals = (await runCommand(db, accounts, '/recap month', '2026-09-03'))!.text;
  assert.match(totals, /food\s+₱485\.00/);
  assert.match(totals, /transport\s+₱15\.00/);
  assert.doesNotMatch(totals, /starbucks/, 'a month of items is not readable in a chat');

  const items = (await runCommand(db, accounts, '/recap month list', '2026-09-03'))!.text;
  assert.match(items, /starbucks/);
  assert.doesNotMatch(items, /food\s+₱485/, 'one shape or the other, never both');
});

test('a day you can put on an expense is a day you can recap', async () => {
  // These were two independent grammars over ONE field. "3 days ago" dated a purchase fine and
  // reached the recap as the bare word "3"; "month" was a period here and a date nowhere. The
  // recap now hands anything that is not a period straight to resolveDate, so the two can no
  // longer drift apart. Thursday 2026-09-03 throughout.
  const db = await fresh();
  const accounts = await db.accounts();
  const at = async (arg: string) => (await runCommand(db, accounts, `/recap ${arg}`, '2026-09-03'))!.text;

  assert.match(await at('3 days ago'), /Mon 2026-08-31/);
  assert.match(await at('last tuesday'), /Tue 2026-09-01/);
  assert.match(await at('sep 1'), /Tue 2026-09-01/);
  assert.match(await at('last month'), /2026-08/);
  // "last" in front of a period is the period's modifier; in front of a weekday it is the
  // day's. Both readings live in the same function and must not eat each other.
  assert.match(await at('last week'), /week of 2026-08-24/);
});

test('recap says what it could not read, rather than answering for the wrong period', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  assert.match(
    (await runCommand(db, accounts, '/recap someday', '2026-09-03'))!.text,
    /Couldn.t read "someday"/,
  );
  // "this week" and "week" are the same thing: the spoken path sends whichever was heard.
  const spoken = (await runCommand(db, accounts, '/recap this week', '2026-09-03'))!.text;
  assert.match(spoken, /week of 2026-08-31/);
});

test("spending logged after an anchor still shows in that day's recap", async () => {
  // The bug this pins down. Anchor six accounts in the morning and bookingDate dates
  // everything you log afterwards to TOMORROW, because the anchor you just read already
  // contains it — so /recap for today showed one row out of five, and the four it dropped
  // were the ones you had just typed. Balances were right the whole time; the recap was
  // asking occurred_at a question occurred_at does not answer.
  const db = await fresh();
  const accounts = await db.accounts();
  await runCommand(db, accounts, '/snap cash 190000', '2026-09-03');

  // Logged on the 3rd (Manila 18:00), booked to the 4th by the anchor rule. `logged_at` is
  // set at INSERT because the append-only trigger freezes it — no UPDATE can fix it after.
  await anExpense(db, {
    date: '2026-09-04',
    logged: '2026-09-03T10:00:00Z',
    amt: -18000,
    cat: 'education',
    merch: 'pup icog',
  });
  // And one that really is the 3rd, logged before the anchor.
  await anExpense(db, { date: '2026-09-03', amt: -1500, cat: 'transport', merch: 'tricycle' });

  const today = (await runCommand(db, accounts, '/recap', '2026-09-03'))!.text;
  assert.match(today, /tricycle/);
  assert.match(today, /pup icog/, 'the row the anchor pushed forward belongs to the day it was typed');
  assert.match(today, /spent\s+₱195\.00/);

  // And it is not counted twice: tomorrow's recap does not also claim it.
  const tomorrow = (await runCommand(db, accounts, '/recap', '2026-09-04'))!.text;
  assert.doesNotMatch(tomorrow, /pup icog/);
  assert.match(tomorrow, /nothing logged/);
});

test('an empty day is simply empty', async () => {
  const db = await fresh();
  const quiet = (await runCommand(db, await db.accounts(), '/recap', '2026-09-03'))!.text;
  assert.match(quiet, /nothing logged/);
  assert.match(quiet, /spent\s+₱0\.00/);
});

test('a question gets the answer INSTEAD of the report, and never loses the reply', async () => {
  // The gap this closes: every spoken question was routed to the nearest report, so asking
  // "did my interest get added?" printed the same balance table you were already looking at.
  // Appending the answer under that table was the first fix and it was half of one: the
  // report is picked from the wording, so "what are all my gotyme expenses" shipped today's
  // empty personal recap above the real answer. The answer replaces it now.
  const db = await fresh();
  const accounts = await db.accounts();
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'maya')!,
    10_294_025,
    '2026-09-03',
  );

  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'Yes, it is already in there.' } }] }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const ctx = { inboxId: 1, today: '2026-09-04', hadPhoto: false, groqKey: 'k' };
    const q = { intent: 'query' as const, query_kind: 'balance' as const };

    const asked = await applyEvent(db, accounts, spokenEvent({ ...q, ask: 'is my interest in there?' }), ctx);
    assert.equal(asked.text, 'Yes, it is already in there.', 'the answer is the whole message');
    assert.doesNotMatch(asked.text, /Maya Savings/, 'no report nobody asked for');
    assert.equal(calls, 1);

    // A bare request for a report spends nothing and appends nothing: the table IS the answer,
    // and prose after it would be noise on the path that already worked.
    const bare = await applyEvent(db, accounts, spokenEvent(q), ctx);
    assert.doesNotMatch(bare.text, /Yes, it is already in there\./);
    assert.equal(calls, 1, 'a bare report must not cost a second call');

    // Groq down, rate-limited or slow must never cost the answer actually asked for.
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const degraded = await applyEvent(
      db,
      accounts,
      spokenEvent({ ...q, ask: 'is my interest in there?' }),
      ctx,
    );
    assert.match(degraded.text, /Maya Savings/, 'the report still sends, unexplained');
  } finally {
    globalThis.fetch = real;
  }
});

test('a credit reported on the anchor day reaches the balance, once', async () => {
  // The bug this exists to stop: /interest wrote occurred_at raw while every other money row
  // went through bookingDate. Anchor Maya at 01:37, the bank credits at 06:42, report it that
  // evening, and the row landed outside the (anchor, next] window - sitting in `events`
  // looking correct while every balance ignored it, permanently. Anchoring BEFORE the bank
  // pays is the ordinary case, and no date column can tell it from anchoring after.
  const db = await fresh();
  const accounts = await db.accounts();
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'maya')!,
    10_294_025,
    '2026-09-03',
  );

  const reply = await runCommand(db, accounts, '/interest maya 15.34', '2026-09-03');
  assert.match(reply!.text, /₱102,955\.59 left in Maya Savings/, 'the credit must move the balance');

  const [row] = await db.all<{ occurred_at: string }>(
    "SELECT occurred_at FROM events WHERE type = 'interest'",
  );
  assert.equal(row.occurred_at, '2026-09-04', 'booked past the anchor, not onto it');

  // Still there tomorrow: the window it used to fall through is the same one a later `today`
  // re-derives, so a balance that is right on the day and wrong after is the real failure.
  const next = await balances(db, accounts, '2026-09-04');
  assert.match(next, /₱102,955\.59/);

  // And it is counted ONCE: the credit closes the accrual period rather than adding on top
  // of interest the projector generates for a day the bank has already paid.
  assert.equal((next.match(/102,955\.59/g) ?? []).length, 1);
});

test('the void button kills the whole late-entry pair, so the balance it protects does not move', async () => {
  // A late entry books as a PAIR that nets to zero: the categorised spend, plus an offset,
  // because the anchor already contains that money. The button voided one row by id, which
  // left the offset behind and moved the balance by ₱250 that the pair exists to hold still.
  // /undo always voided siblings; both now take the one path.
  const db = await fresh();
  const accounts = await db.accounts();
  const maribank = accounts.find((a) => a.id === 'maribank')!;
  await anchorAccount(db, maribank, 1_285_697, '2026-09-03');

  const inboxId = (await db.claim({ update_id: 1, has_photo: false, now: '2026-09-03T00:00:00Z' }))!;
  const reply = await applyEvent(
    db,
    accounts,
    spokenEvent({ intent: 'expense', amount: '250', account: 'maribank', date_hint: '2026-08-28' }),
    { inboxId, today: '2026-09-03', hadPhoto: false },
  );
  assert.match(reply.text, /late entry for 2026-08-28/);
  const before = await balances(db, accounts, '2026-09-03');

  const id = Number(reply.keyboard![0][1].callback_data.split(':')[1]);
  const tap = await callback(db, `void:${id}`, '2026-09-03');
  assert.match(tap.text, /\+1 paired/, 'both rows, or the balance moves');
  assert.match(tap.text, /₱12,856\.97 left in Maribank/, 'a void says where it left you');

  const live = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE voided_at IS NULL');
  assert.equal(live?.n, 0, 'half a voided pair is worse than either whole state');
  assert.equal(await balances(db, accounts, '2026-09-03'), before, 'the pair nets to zero, voided or not');
});

test('a transfer books per leg, so the anchor day does not swallow it', async () => {
  // The reconciliation window is (anchor, next] and EXCLUSIVE, so a leg dated on its own
  // account's anchor day falls outside every window and moves nothing. money() has always
  // booked a same-day flow forward for exactly this reason. transfer() wrote the raw date,
  // so ₱2,000 left no trace anywhere until the next anchor reported it as drift.
  const db = await fresh();
  const accounts = await db.accounts();
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'maya')!,
    9_856_416,
    '2026-09-03',
  );
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'gotyme')!,
    8_500_000,
    '2026-09-03',
  );

  const move = (dateHint: string | null, update: number) =>
    db.claim({ update_id: update, has_photo: false, now: '2026-09-03T02:00:00Z' }).then((inboxId) =>
      applyEvent(
        db,
        accounts,
        spokenEvent({
          intent: 'transfer',
          amount: '2000',
          account: 'maya',
          to_account: 'gotyme',
          date_hint: dateHint,
        }),
        { inboxId: inboxId!, today: '2026-09-03', hadPhoto: false },
      ),
    );

  const sameDay = await move(null, 1);
  assert.match(sameDay.text, /₱96,564\.16 left in Maya Savings, ₱87,000\.00 left in GoTyme/);

  // Before the anchor is money BOTH anchors already contain, so it books as the same
  // net-to-zero pair a late expense does: the record gains it, no balance moves.
  const late = await move('2026-08-28', 2);
  assert.match(late.text, /late entry for 2026-08-28, balance unchanged/);
  assert.match(late.text, /₱96,564\.16 left in Maya Savings, ₱87,000\.00 left in GoTyme/);

  // And it is still a well-formed transfer: the offsets are adjustments, so the pair of legs
  // brokenTransfers() checks still nets to zero.
  assert.doesNotMatch(await balances(db, accounts, '2026-09-03'), /broken transfer/);
});

test('the 08:00 close-out confirms what you slept on, and nothing from today', async () => {
  // Keyed on logged_at against the Manila start of day, so an entry typed at 23:50 gets a
  // night rather than the ten minutes a midnight close-out would have given it.
  const db = await fresh();
  const at = (loggedAt: string) =>
    db.run(
      `INSERT INTO events (type, book, account_id, amount_centavos, category, occurred_at, logged_at)
       VALUES ('expense','personal','maribank',-25000,'food','2026-09-03',?)`,
      [loggedAt],
    );
  await at('2026-09-03T15:50:00Z'); // 23:50 Manila on the 3rd
  await at('2026-09-03T16:10:00Z'); // 00:10 Manila on the 4th, still yours to review
  await at('2026-09-03T15:59:59Z'); // 23:59:59 Manila on the 3rd

  const cutoff = manilaStartOfDay('2026-09-04');
  assert.equal(await db.unconfirmedBefore(cutoff), 2, 'only what was logged before today');
  await db.batch([db.confirmBefore(cutoff, '2026-09-04T00:00:00Z')]);

  assert.equal(await db.unconfirmedBefore(cutoff), 0, 'and confirming twice is a no-op');
  const open = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE confirmed_at IS NULL');
  assert.equal(open?.n, 1, "today's entry keeps its buttons until tomorrow");
});

// ── "all of it", and the fee that must not re-book the transfer ─────────────

test('moving ALL of an account resolves to the derived balance, and the fee reply does not re-book it', async () => {
  // Two bugs, one conversation. "transferred all of gcash to maribank" carries no figure,
  // so the bot asked "how much" forever — the model is forbidden to produce a balance and
  // nothing else was filling one in. Then the transfer's own "reply: fee 10" invitation went
  // to the extractor, which still had the transfer in its transcript and emitted it AGAIN.
  const db = await fresh();
  const accounts = await db.accounts();
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'gcash')!,
    528_850,
    '2026-09-03',
  );
  await anchorAccount(
    db,
    accounts.find((a) => a.id === 'maribank')!,
    3_209_330,
    '2026-09-03',
  );

  const inboxId = await db.claim({ update_id: 1, has_photo: false, now: '2026-09-03T02:00:00Z' });
  const moved = await applyEvent(
    db,
    accounts,
    spokenEvent({ intent: 'transfer', account: 'gcash', to_account: 'maribank', whole_balance: true }),
    { inboxId: inboxId!, today: '2026-09-03', hadPhoto: false },
  );
  assert.match(moved.text, /₱5,288\.50 · GCash → Maribank · all of it, by my books/);
  assert.match(moved.text, /₱0\.00 left in GCash/);

  // The invitation is answered by CODE. Bare, exactly as the reply asks for it.
  const zero = await runCommand(db, accounts, 'fee 0', '2026-09-03');
  assert.equal(zero!.text, 'No fee, nothing written.');

  const fee = await runCommand(db, accounts, 'fee 10', '2026-09-03');
  assert.match(fee!.text, /₱10\.00 fee · GCash/);
  assert.match(fee!.text, /-₱10\.00 left in GCash/);

  // The whole point: still ONE transfer, two legs. A re-emitted transfer would be four.
  const legs = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'transfer'");
  assert.equal(legs[0].n, 2);

  // A second fee is a correction, not another row.
  const again = await runCommand(db, accounts, 'fee 15', '2026-09-03');
  assert.match(again!.text, /already has a ₱10\.00 fee/);
});

test('an unanchored account has no balance to empty, so it asks instead of inventing one', async () => {
  const db = await fresh();
  const accounts = await db.accounts();
  const inboxId = await db.claim({ update_id: 1, has_photo: false, now: '2026-09-03T02:00:00Z' });
  const r = await applyEvent(
    db,
    accounts,
    spokenEvent({ intent: 'transfer', account: 'gcash', to_account: 'maribank', whole_balance: true }),
    { inboxId: inboxId!, today: '2026-09-03', hadPhoto: false },
  );
  assert.match(r.text, /not anchored/);
  assert.equal((await db.all("SELECT * FROM events WHERE type = 'transfer'")).length, 0);
});

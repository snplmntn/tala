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

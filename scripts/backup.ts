/**
 * Dump the whole ledger as portable SQL.
 *
 * Runs in GitHub Actions, NOT on the laptop. The original plan put this on a Mac, and a
 * student's laptop closed for a fortnight means the only recovery window (Turso's free
 * point-in-time is 1 day) expired with zero copies anywhere — the unbounded-loss case.
 * The daily commit is also what keeps Actions from auto-disabling the schedule.
 *
 * Reuses TURSO_URL and TURSO_TOKEN, so there is no second credential and no CLI to
 * authenticate. Output is plain SQL that imports into any sqlite3 — which makes this both
 * the backup and the exit from Turso.
 *
 * Encryption happens in the workflow, not here: plaintext in git is effectively
 * unrevocable, and one visibility flip or one leaked token reads every transaction ever
 * recorded.
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

const url = process.env.TURSO_URL;
const authToken = process.env.TURSO_TOKEN;
if (!url || !authToken) throw new Error('TURSO_URL and TURSO_TOKEN are required');

const db = createClient({ url, authToken });

const TABLES = ['accounts', 'inbox', 'events', 'snapshots', 'rate_observations'] as const;

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const out: string[] = [
  '-- Tala ledger dump. Restore: sqlite3 tala.db < this-file',
  '-- Schema first, then data. Triggers are recreated last so the inserts are not blocked.',
  'PRAGMA foreign_keys=OFF;',
  'BEGIN TRANSACTION;',
];

// The committed schema is the source of truth for structure; this file carries the rows.
// Triggers are stripped here and re-applied at the end, or every INSERT would fail the
// append-only guard during a restore.
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const withoutTriggersOrSeed = schema
  .replace(/CREATE TRIGGER[\s\S]*?END;/g, '')
  .replace(/INSERT INTO accounts[\s\S]*?;/g, '');
out.push(withoutTriggersOrSeed);

let rowCount = 0;
for (const table of TABLES) {
  const res = await db.execute(`SELECT * FROM ${table} ORDER BY rowid`);
  if (!res.rows.length) continue;
  const cols = res.columns;
  out.push(`-- ${table}: ${res.rows.length} rows`);
  for (const row of res.rows) {
    const values = cols.map((c) => lit((row as Record<string, unknown>)[c]));
    out.push(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${values.join(',')});`);
    rowCount++;
  }
}

for (const trigger of schema.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? []) out.push(trigger);
out.push('COMMIT;', 'PRAGMA foreign_keys=ON;');

// A checksum the restore drill can compare against, so an untested backup becomes a
// tested one for the price of one line.
const totals = await db.execute(
  'SELECT COUNT(*) AS n, COALESCE(SUM(amount_centavos),0) AS total FROM events WHERE voided_at IS NULL',
);
const t = totals.rows[0] as unknown as { n: number; total: number };
out.push(`-- verify: ${t.n} live events, net ${t.total} centavos, ${rowCount} rows dumped`);

process.stdout.write(`${out.join('\n')}\n`);
process.stderr.write(`dumped ${rowCount} rows · ${t.n} live events · net ${t.total} centavos\n`);

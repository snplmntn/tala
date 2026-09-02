/**
 * Storage. Turso (libSQL), which is SQLite — so schema.sql, the append-only triggers and
 * the INTEGER centavos all work unchanged, and `sqlite3 .dump` remains the exit path.
 *
 * Chosen over Render's own Postgres for one disqualifying reason: a free Render Postgres is
 * DELETED 44 days after creation, on a clock that runs from creation and that daily use does
 * not extend. A ledger you intend to keep for five years cannot live on that.
 *
 * It stays over Supabase and Neon for a different reason, recorded here so the decision does
 * not get re-litigated from scratch: ZERO migration. Every candidate is durable enough (Neon
 * states "None of these limits delete your data"; Supabase's pause needs a 7-day activity
 * drought this app cannot produce) and none requires a card, so durability and price do not
 * separate the field. What separates it is that a Postgres port rewrites `events_append_only`
 * — a conditional trigger freezing 17 columns while allowing three to be set exactly once —
 * as ~30 lines of PL/pgSQL, and `REVOKE UPDATE` cannot replace it because this app
 * legitimately updates events, inbox and accounts. That is a rewrite of the one guarantee the
 * schema exists to make. test/schema.test.ts is the oracle that would have to pass first.
 *
 * Postgres also hides two silent money traps worth knowing before anyone tries: `integer` is
 * 4 bytes and caps at ₱21,474,836.47 where SQLite's INTEGER is dynamic, and node-postgres
 * returns BIGINT as a STRING, so "100" + "200" evaluates to "100200" in a ledger whose whole
 * arithmetic is numeric. Neither throws.
 *
 * Never opt into `tursodb`, the Rust rewrite: its own COMPAT.md states that under MVCC "a
 * write that reported success is not durable while sibling statements remain active, and it is
 * silently rolled back if the transaction then ends abnormally". A silently rolled-back
 * acknowledged write is the worst failure mode available to an append-only ledger.
 *
 * Every multi-row write that must be atomic goes through `batch`. Two sequential awaits is
 * how you get half a ₱3,000 transfer with nothing detecting the orphan.
 */

import { createClient, type Client, type InArgs } from '@libsql/client';
import type { Event } from './ledger.ts';

export interface Account {
  id: string;
  name: string;
  book: string;
  kind: string;
  rate: number;
  rate_source: string;
  rate_seed: number;
  rate_floor: number;
  rate_cap_centavos: number | null;
  cashback_rate: number;
  cashback_cap_centavos: number | null;
  active: number;
  sort: number;
}

export interface Snapshot {
  account_id: string;
  as_of_date: string;
  balance_centavos: number;
}

export type Write = { sql: string; args?: InArgs };

export class Db {
  private c: Client;

  constructor(url: string, authToken?: string) {
    // A `file:` URL needs no credential — that is what makes the local chat REPL possible
    // against the same schema, the same triggers and the same client.
    this.c = createClient(authToken ? { url, authToken } : { url });
  }

  /**
   * Preferences that are not ledger facts — what to call you, and whatever comes next.
   *
   * The DDL lives here rather than in schema.sql because schema.sql has no IF NOT EXISTS
   * and is only ever run once, against an empty database. A ledger deployed before this
   * table existed would never get it. One idempotent statement at boot upgrades every
   * install for free, with no migration to remember and nothing to run by hand.
   *
   * Mutable on purpose: the append-only triggers guard `events`, where rewriting history
   * would be a lie about money. A nickname is not history.
   */
  private settingsReady?: Promise<number>;

  /** Created on first use, not at boot: no ordering to get wrong, and the tests get it free. */
  private ensureSettings(): Promise<number> {
    return (this.settingsReady ??= this.run(
      `CREATE TABLE IF NOT EXISTS settings (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ));
  }

  /**
   * Reading a preference must never be able to break a message. Every failure here means
   * the same thing to every caller — "no preference set" — and the ledger does not care.
   */
  async getSetting(key: string): Promise<string | null> {
    try {
      await this.ensureSettings();
      const r = await this.one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
      return r?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Unlike the read, this throws: silently not saving what you just typed is worse. */
  async setSetting(key: string, value: string): Promise<void> {
    await this.ensureSettings();
    await this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  /** Load a whole .sql file. Only used to seed a local dev database from schema.sql. */
  async executeMultiple(sql: string): Promise<void> {
    await this.c.executeMultiple(sql);
  }

  async all<T>(sql: string, args: InArgs = []): Promise<T[]> {
    const r = await this.c.execute({ sql, args });
    return r.rows as unknown as T[];
  }

  async one<T>(sql: string, args: InArgs = []): Promise<T | null> {
    return (await this.all<T>(sql, args))[0] ?? null;
  }

  async run(sql: string, args: InArgs = []): Promise<number> {
    const r = await this.c.execute({ sql, args });
    return Number(r.lastInsertRowid ?? 0);
  }

  /** All-or-nothing. Both transfer legs, correction-plus-target, snapshot-plus-adjustment. */
  async batch(writes: Write[]): Promise<void> {
    if (!writes.length) return;
    await this.c.batch(
      writes.map((w) => ({ sql: w.sql, args: w.args ?? [] })),
      'write',
    );
  }

  // ── accounts ──────────────────────────────────────────────────────────────

  accounts(): Promise<Account[]> {
    return this.all<Account>('SELECT * FROM accounts WHERE active = 1 ORDER BY sort');
  }

  /**
   * The closed enum handed to the LLM, read from the database at request time.
   *
   * This is why accounts are rows: the alternative keeps the same list in a TypeScript
   * union, a JSON schema and a CHECK constraint, and if the CHECK ever drifts stricter than
   * the enum, the model returns a valid-looking value and the INSERT hard-fails on a real
   * expense message — at the moment you are trying to log money. Adding an account is one
   * INSERT, with no redeploy.
   */
  async accountIds(): Promise<string[]> {
    return (await this.accounts()).map((a) => a.id);
  }

  /** Including inactive ones — closed accounts keep their history and their rows. */
  allAccounts(): Promise<Account[]> {
    return this.all<Account>('SELECT * FROM accounts ORDER BY active DESC, sort');
  }

  addAccount(a: { id: string; name: string; book: string; kind: string }): Write {
    return {
      sql: `INSERT INTO accounts (id, name, book, kind, sort)
            VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))`,
      args: [a.id, a.name, a.book, a.kind],
    };
  }

  /**
   * Deactivate, never delete. Events reference accounts, so a DELETE would either fail on
   * the foreign key or orphan history. `active = 0` drops it from the LLM's enum and from
   * the snapshot prompt while every past row keeps resolving.
   */
  setAccountActive(id: string, active: boolean): Write {
    return { sql: 'UPDATE accounts SET active = ? WHERE id = ?', args: [active ? 1 : 0, id] };
  }

  // ── inbox ─────────────────────────────────────────────────────────────────

  /**
   * Claim an update, or discover we already have it.
   *
   * Written BEFORE the LLM call, always. Returns null when this update_id is already
   * present, which is the idempotency guard: Telegram redelivers on any error and a
   * restart mid-handler is routine on a free tier that spins down.
   */
  async claim(u: {
    update_id: number;
    message_id?: number | null;
    chat_id?: number | null;
    text?: string | null;
    has_photo: boolean;
    now: string;
  }): Promise<number | null> {
    try {
      return await this.run(
        `INSERT INTO inbox (telegram_update_id, telegram_message_id, chat_id, raw_text, has_photo, logged_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [u.update_id, u.message_id ?? null, u.chat_id ?? null, u.text ?? null, u.has_photo ? 1 : 0, u.now],
      );
    } catch (e) {
      if (String(e).includes('UNIQUE')) return null; // already seen; do not re-apply
      throw e;
    }
  }

  markInbox(id: number, status: string, extra: { model?: string; raw?: string; error?: string } = {}) {
    return this.run(
      `UPDATE inbox SET status = ?, model_id = COALESCE(?, model_id),
         raw_response = COALESCE(?, raw_response), error = COALESCE(?, error) WHERE id = ?`,
      [status, extra.model ?? null, extra.raw ?? null, extra.error ?? null, id],
    );
  }

  /** Messages whose parse was deferred by a provider outage or an exhausted quota. */
  deferred(): Promise<
    { id: number; raw_text: string | null; chat_id: number; telegram_message_id: number }[]
  > {
    return this.all(
      `SELECT id, raw_text, chat_id, telegram_message_id FROM inbox
        WHERE status = 'deferred' AND has_photo = 0 ORDER BY id LIMIT 20`,
    );
  }

  // ── events ────────────────────────────────────────────────────────────────

  /** Every non-voided row for an account since a date. Correction resolution happens in ledger.ts. */
  eventsSince(accountId: string, since: string): Promise<Event[]> {
    return this.all<Event>(`SELECT * FROM events WHERE account_id = ? AND occurred_at >= ? ORDER BY id`, [
      accountId,
      since,
    ]);
  }

  eventsInMonth(month: string): Promise<Event[]> {
    return this.all<Event>(`SELECT * FROM events WHERE occurred_at LIKE ? ORDER BY id`, [`${month}%`]);
  }

  allEvents(): Promise<Event[]> {
    return this.all<Event>('SELECT * FROM events ORDER BY id');
  }

  insertEvent(
    e: Partial<Event> & {
      type: string;
      account_id: string;
      amount_centavos: number;
      occurred_at: string;
      book: string;
      logged_at: string;
    },
  ): Write {
    return {
      sql: `INSERT INTO events (inbox_id, type, book, account_id, amount_centavos, category, merchant, note,
              recurrence, shared_amount_centavos, transfer_id, fee_centavos, occurred_at, logged_at,
              corrects_id, telegram_message_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        e.inbox_id ?? null,
        e.type,
        e.book,
        e.account_id,
        e.amount_centavos,
        e.category ?? null,
        e.merchant ?? null,
        e.note ?? null,
        e.recurrence ?? 'one_off',
        e.shared_amount_centavos ?? null,
        e.transfer_id ?? null,
        e.fee_centavos ?? null,
        e.occurred_at,
        e.logged_at,
        e.corrects_id ?? null,
        e.telegram_message_id ?? null,
      ],
    };
  }

  /**
   * Find the row a correction is talking about.
   *
   * The LLM never sees the ledger, so it cannot return a row id — it returns a matcher and
   * this resolves it. Most recent match wins, and the caller ECHOES what it found: seeing
   * the wrong row named is the whole disambiguation, and it costs nothing.
   */
  matchForCorrection(m: {
    amount?: number | null;
    merchant?: string | null;
    account?: string | null;
  }): Promise<Event | null> {
    const where: string[] = ['voided_at IS NULL', "type IN ('expense','income','interest','cashback')"];
    const args: InArgs = [];
    if (m.amount != null) {
      where.push('ABS(amount_centavos) = ?');
      args.push(Math.abs(m.amount));
    }
    if (m.merchant) {
      where.push('(merchant LIKE ? OR note LIKE ?)');
      args.push(`%${m.merchant.toLowerCase()}%`, `%${m.merchant.toLowerCase()}%`);
    }
    if (m.account) {
      where.push('account_id = ?');
      args.push(m.account);
    }
    if (args.length === 0) return Promise.resolve(null); // never correct a row chosen at random
    return this.one<Event>(
      `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`,
      args,
    );
  }

  lastEvent(): Promise<Event | null> {
    return this.one<Event>('SELECT * FROM events WHERE voided_at IS NULL ORDER BY id DESC LIMIT 1');
  }

  /** Void, never delete. Refused for a row the anchor already covers — see ledger.bookingDate. */
  voidEvent(id: number, now: string): Write {
    return { sql: 'UPDATE events SET voided_at = ? WHERE id = ? AND voided_at IS NULL', args: [now, id] };
  }

  confirmEvent(id: number, now: string): Write {
    return {
      sql: 'UPDATE events SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL',
      args: [now, id],
    };
  }

  settle(id: number, now: string): Write {
    return { sql: 'UPDATE events SET settled_at = ? WHERE id = ? AND settled_at IS NULL', args: [now, id] };
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  latestSnapshot(accountId: string): Promise<Snapshot | null> {
    return this.one<Snapshot>(
      'SELECT account_id, as_of_date, balance_centavos FROM snapshots WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1',
      [accountId],
    );
  }

  previousSnapshot(accountId: string, before: string): Promise<Snapshot | null> {
    return this.one<Snapshot>(
      'SELECT account_id, as_of_date, balance_centavos FROM snapshots WHERE account_id = ? AND as_of_date < ? ORDER BY as_of_date DESC LIMIT 1',
      [accountId, before],
    );
  }

  /**
   * INSERT OR REPLACE against UNIQUE(account_id, as_of_date).
   *
   * Three jobs in one constraint: re-running a close is a no-op instead of doubling the
   * interest, re-typing a fat-fingered number supersedes rather than duplicating, and
   * reconciliation can run snapshot-to-snapshot — which deletes all month-boundary logic.
   */
  putSnapshot(s: Snapshot & { logged_at: string }): Write {
    return {
      sql: `INSERT INTO snapshots (account_id, as_of_date, balance_centavos, logged_at)
            VALUES (?,?,?,?)
            ON CONFLICT(account_id, as_of_date)
            DO UPDATE SET balance_centavos = excluded.balance_centavos, logged_at = excluded.logged_at`,
      args: [s.account_id, s.as_of_date, s.balance_centavos, s.logged_at],
    };
  }

  // ── rate learning ─────────────────────────────────────────────────────────

  observationCount(accountId: string): Promise<{ n: number } | null> {
    return this.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM rate_observations WHERE account_id = ? AND accepted = 1',
      [accountId],
    );
  }

  recordObservation(o: {
    account_id: string;
    period_start: string;
    period_end: string;
    credited_centavos: number;
    centavo_days: number;
    implied_rate: number;
    accepted: boolean;
    reason: string;
    logged_at: string;
  }): Write {
    return {
      sql: `INSERT INTO rate_observations (account_id, period_start, period_end, credited_centavos,
              centavo_days, implied_rate, accepted, reason, logged_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [
        o.account_id,
        o.period_start,
        o.period_end,
        o.credited_centavos,
        o.centavo_days,
        o.implied_rate,
        o.accepted ? 1 : 0,
        o.reason,
        o.logged_at,
      ],
    };
  }

  /**
   * Move the live rate. `rate_seed` is deliberately untouched: it is the learner's stable
   * sanity band, and rewriting it would turn a lapsed Maya boost into a one-way ratchet
   * that rejects the boost coming back.
   *
   * A manual set DOES move the seed, because that is the user asserting a new baseline.
   */
  setRate(accountId: string, rate: number, source: 'observed' | 'manual'): Write {
    return source === 'manual'
      ? {
          sql: "UPDATE accounts SET rate = ?, rate_seed = ?, rate_source = 'manual' WHERE id = ?",
          args: [rate, rate, accountId],
        }
      : {
          sql: "UPDATE accounts SET rate = ?, rate_source = 'observed' WHERE id = ?",
          args: [rate, accountId],
        };
  }
}

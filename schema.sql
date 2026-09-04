-- Tala — ledger schema.
--
-- The whole design reduces to one identity, asserted in test/ledger.test.ts:
--   snapshot(n) + events in (n, n+1] + reported_interest + adjustment = snapshot(n+1)
-- exactly, in integer centavos.
--
-- Money is INTEGER centavos everywhere. A dump passes numerics through JavaScript's
-- 52-bit float precision, so a REAL peso column drifts — and the drift would land in the
-- reconciliation adjustment, where it reads as unlogged spending.

-- NOTE: there is one more table, `settings`, and it is deliberately NOT here.
-- It holds preferences rather than ledger facts (what to call you, for now) and is created
-- by Db.initSettings() at boot with IF NOT EXISTS. This file has no IF NOT EXISTS and only
-- ever runs against an empty database, so a table added here would never reach a ledger
-- that was already deployed. Defined once, in src/db.ts.

------------------------------------------------------------------------------
-- accounts: rows, not an enum in three places.
-- The closed enum handed to the LLM is `SELECT id FROM accounts WHERE active`,
-- interpolated at request time. Deliberately NO CHECK constraint on events.account_id
-- beyond the FK: a CHECK stricter than the LLM enum hard-fails an INSERT on a real
-- expense message, at the moment you are trying to log money.
------------------------------------------------------------------------------
CREATE TABLE accounts (
  id                    TEXT    PRIMARY KEY,          -- 'maya', 'maribank', ...
  name                  TEXT    NOT NULL,
  book                  TEXT    NOT NULL,             -- 'personal' | 'business'
  kind                  TEXT    NOT NULL,             -- 'bank' | 'ewallet' | 'cash' | 'credit'
  -- Net annual rate. 0 means untracked: no projection, no rate learning. Credited
  -- interest on an untracked pot surfaces as tagged positive drift instead.
  -- Every tracked pot credits DAILY, so there is no cadence column. A future
  -- monthly-crediting account needs `credits_daily` plus a confirm-at-close path.
  rate                  REAL    NOT NULL DEFAULT 0,
  rate_source           TEXT    NOT NULL DEFAULT 'seeded_net',  -- 'seeded_net' | 'observed' | 'manual'
  -- The learner's STABLE sanity reference, never rewritten by the learner itself.
  -- Guarding against the live `rate` instead would be a one-way ratchet: a lapsed Maya
  -- boost drops the rate to 0.024, and the boost coming back at 0.08 would then exceed
  -- 2x the new reference and be rejected as a mis-typed credit, forever.
  rate_seed             REAL    NOT NULL DEFAULT 0,
  -- Where the rate falls to when a monthly-requalifying boost lapses. The learner must
  -- accept a drop to this as real, not as a data error.
  rate_floor            REAL    NOT NULL DEFAULT 0,
  -- Boosted rate applies only to the first N centavos; the excess earns rate_floor.
  rate_cap_centavos     INTEGER,
  cashback_rate         REAL    NOT NULL DEFAULT 0,
  cashback_cap_centavos INTEGER,
  active                INTEGER NOT NULL DEFAULT 1,
  sort                  INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------------------------
-- inbox: written BEFORE the LLM call, always.
-- Three mechanisms in one table:
--   1. Idempotency. Telegram redelivers anything not acknowledged, and a free tier that
--      spins down makes mid-handler death routine, so duplicate rows are a certainty.
--   2. Recovery. A Groq 5xx or an exhausted daily quota defers the parse instead of
--      losing the expense you watched vanish.
--   3. Regression fixtures. Groq's free-tier model lineup churns; raw_text + model_id
--      + raw_response is the corpus that makes a swap survivable.
-- It also makes merchant/recurrence/date_hint backfillable by replay.
------------------------------------------------------------------------------
CREATE TABLE inbox (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_update_id  INTEGER NOT NULL UNIQUE,
  telegram_message_id INTEGER,
  chat_id             INTEGER,
  raw_text            TEXT,
  has_photo           INTEGER NOT NULL DEFAULT 0,
  model_id            TEXT,
  raw_response        TEXT,
  status              TEXT    NOT NULL DEFAULT 'received',
                              -- received | parsed | applied | blocked | deferred | failed
                              -- | duplicate (a re-send the retry drain refused to book twice)
  error               TEXT,
  logged_at           TEXT    NOT NULL      -- UTC ISO8601
);

------------------------------------------------------------------------------
-- events: the ledger. Append-only, enforced by triggers below rather than by convention.
--
-- amount_centavos is SIGNED: negative leaves the account, positive enters it.
-- A refund is therefore a positive-signed row of type 'expense', which makes category
-- totals net automatically with no reverses_id and no special case.
--
-- A correction is a FULL SUPERSEDE, not a delta: it carries corrects_id pointing at the
-- ROOT row plus the complete corrected payload. Effective row per root = max(id).
-- Absolute supersedes are idempotent by construction, so a webhook retry that replays a
-- correction is a no-op instead of silently turning 285 into 320.
------------------------------------------------------------------------------
CREATE TABLE events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id               INTEGER REFERENCES inbox(id),
  type                   TEXT    NOT NULL,  -- expense|income|transfer|interest|cashback|adjustment
  -- Explicit, DEFAULTED from the account rather than DERIVED from it: a domain renewal
  -- paid on personal GCash has to be recordable as a business cost.
  book                   TEXT    NOT NULL,
  account_id             TEXT    NOT NULL REFERENCES accounts(id),
  amount_centavos        INTEGER NOT NULL,
  category               TEXT,              -- adjustments carry it too: fee | forgot | unknown
  merchant               TEXT,              -- lowercased
  note                   TEXT,
  recurrence             TEXT    NOT NULL DEFAULT 'one_off',  -- one_off | monthly | annual
  -- The portion of this expense that is someone else's money. NULL = fully yours.
  -- An amount, not a boolean: `for_self: false` on a P600 group meal where P200 was
  -- yours is wrong in the other direction.
  shared_amount_centavos INTEGER,
  settled_at             TEXT,              -- set once, closes the receivable
  transfer_id            TEXT,              -- both legs share it; sum must be 0
  fee_centavos           INTEGER,           -- on the source leg only
  -- Manila civil date. A UTC host misdates a guaranteed 8-hour window every day via
  -- toISOString().slice(0,10) and, on the 1st, moves rows out of the month's recap and
  -- accrual base entirely.
  occurred_at            TEXT    NOT NULL,  -- YYYY-MM-DD
  logged_at              TEXT    NOT NULL,  -- UTC ISO8601
  corrects_id            INTEGER REFERENCES events(id),
  confirmed_at           TEXT,              -- set once; PRESENTATIONAL, changes no arithmetic
  -- Receipt provenance. message_id only, deliberately NOT file_id: file_ids never expire
  -- and getFile works for anything the bot has ever seen, so storing one turns bot-token
  -- theft from "rotate and move on" into "every receipt ever sent is readable".
  telegram_message_id    INTEGER,
  voided_at              TEXT               -- set once; excluded from every sum
);

CREATE INDEX events_account_date ON events (account_id, occurred_at);
CREATE INDEX events_root         ON events (corrects_id);
CREATE INDEX events_transfer     ON events (transfer_id);

------------------------------------------------------------------------------
-- Append-only, in the database rather than in app code. One `turso db shell` UPDATE at
-- 1am would otherwise break the only invariant with no detection anywhere.
-- The permitted mutation is exactly: one NULL -> value transition on one of three
-- set-once columns. Everything else aborts.
------------------------------------------------------------------------------
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
BEGIN
  SELECT CASE WHEN
       NEW.id                     IS NOT OLD.id
    OR NEW.inbox_id               IS NOT OLD.inbox_id
    OR NEW.type                   IS NOT OLD.type
    OR NEW.book                   IS NOT OLD.book
    OR NEW.account_id             IS NOT OLD.account_id
    OR NEW.amount_centavos        IS NOT OLD.amount_centavos
    OR NEW.category               IS NOT OLD.category
    OR NEW.merchant               IS NOT OLD.merchant
    OR NEW.note                   IS NOT OLD.note
    OR NEW.recurrence             IS NOT OLD.recurrence
    OR NEW.shared_amount_centavos IS NOT OLD.shared_amount_centavos
    OR NEW.transfer_id            IS NOT OLD.transfer_id
    OR NEW.fee_centavos           IS NOT OLD.fee_centavos
    OR NEW.occurred_at            IS NOT OLD.occurred_at
    OR NEW.logged_at              IS NOT OLD.logged_at
    OR NEW.corrects_id            IS NOT OLD.corrects_id
    OR NEW.telegram_message_id    IS NOT OLD.telegram_message_id
    -- set-once: never cleared, never rewritten
    OR (OLD.voided_at   IS NOT NULL AND NEW.voided_at   IS NOT OLD.voided_at)
    OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
    OR (OLD.settled_at  IS NOT NULL AND NEW.settled_at  IS NOT OLD.settled_at)
  THEN RAISE(ABORT, 'events are append-only: only voided_at, confirmed_at and settled_at may be set, once')
  END;
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only: void it, do not delete it');
END;

------------------------------------------------------------------------------
-- snapshots: the anchor. as_of_date is the Manila day you READ the banking app,
-- not the day you typed it in — nobody reads their app at 23:59:59 on the 31st, and
-- snapshotting three days late at P100/day misattributes P300 every month.
--
-- UNIQUE(account_id, as_of_date) does three jobs: it makes month close idempotent
-- (so there is no separate close event to run twice), it makes re-typing a
-- fat-fingered number supersede rather than duplicate, and it lets reconciliation run
-- snapshot-to-snapshot, which deletes all month-boundary special-casing.
------------------------------------------------------------------------------
CREATE TABLE snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT    NOT NULL REFERENCES accounts(id),
  as_of_date        TEXT    NOT NULL,   -- YYYY-MM-DD, Manila
  balance_centavos  INTEGER NOT NULL,
  logged_at         TEXT    NOT NULL,
  UNIQUE (account_id, as_of_date)
);

------------------------------------------------------------------------------
-- rate_observations: append-only record of every learning attempt, accepted or not.
-- Keeping the rejected ones is what lets you answer "why does it still say estimated?".
------------------------------------------------------------------------------
CREATE TABLE rate_observations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT    NOT NULL REFERENCES accounts(id),
  period_start      TEXT    NOT NULL,
  period_end        TEXT    NOT NULL,
  credited_centavos INTEGER NOT NULL,
  centavo_days      INTEGER NOT NULL,   -- the fold's denominator, shared with the accrual
  implied_rate      REAL    NOT NULL,
  accepted          INTEGER NOT NULL,
  reason            TEXT,
  logged_at         TEXT    NOT NULL
);

------------------------------------------------------------------------------
-- Seed. Rates are NET (advertised gross x 0.80): both banks advertise gross and credit
-- net, so the seed's job is to predict the CREDITED amount. Maya T&C 4.6 — interest is
-- "credited to your account on the next day minus the applicable taxes". MariBank help
-- article 10070 — "transaction history shows your transactions after tax".
-- Seeding gross would leave the learner fighting a permanent 25% overprediction and
-- "correcting" it by mutating the rate into something that no longer means anything.
--
-- Maya: 10% gross boosted -> 0.08 net. Boost re-qualifies every calendar month on
-- P25,000 of qualifying spend; rate_floor 0.024 is base 3% gross x 0.8, where it lands
-- when a month is missed. rate_cap 100,000.00 — the boost applies to the first P100k only.
-- Maribank: 3.25% gross -> 0.026 net. Base tier-1 rate, effective 2026-01-15, no boost
-- mechanic and no end date, so this seed is stable.
------------------------------------------------------------------------------
INSERT INTO accounts (id, name, book, kind, rate, rate_seed, rate_floor, rate_cap_centavos, cashback_rate, cashback_cap_centavos, sort) VALUES
  ('maya',     'Maya Savings', 'personal', 'ewallet', 0.08,  0.08,  0.024, 10000000, 0, NULL, 1),
  ('maribank', 'Maribank',     'personal', 'bank',    0.026, 0.026, 0.026,     NULL, 0, NULL, 2),
  ('gcash',    'GCash',        'personal', 'ewallet', 0,     0,     0,         NULL, 0, NULL, 3),
  ('bdo',      'BDO Pay',      'personal', 'bank',    0,     0,     0,         NULL, 0, NULL, 4),
  ('cash',     'Cash on hand', 'personal', 'cash',    0,     0,     0,         NULL, 0, NULL, 5),
  ('gotyme',   'GoTyme',       'business', 'bank',    0,     0,     0,         NULL, 0, NULL, 6);
-- Cashback seeds at 0 on purpose and is learned only from real credits: PH cashback is
-- overwhelmingly vouchers, coins and points, so a projected PESO is never trued up by a
-- cash credit and `expected` would climb forever with reconciliation blaming you.

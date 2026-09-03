/**
 * The pure core. No I/O, no D1, no fetch — every function here is a fold over rows,
 * which is what makes the whole ledger testable without an API key or a database.
 *
 * The LLM never reaches this file. It converts prose to a typed event; this applies events.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Money. Integer centavos, always.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a written amount into centavos. Accepts "1,234.56", "P1234.56", "₱1.2k", "250", "299 x 3".
 * Returns null on anything it cannot read exactly — the caller then asks rather than guesses,
 * because a silently wrong amount is the one error the reconciliation row cannot distinguish
 * from forgotten spending.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;

  // "299 x 3" — three of the same thing, which is how a group order gets typed. The
  // extractor is FORBIDDEN from multiplying it out (see extract.ts: it transcribes, code
  // computes), so the arithmetic has to happen here, on integer centavos, where a misread
  // is a refused message rather than a wrong balance. Order does not matter: multiplication
  // is commutative and only one side is scaled, so "3 x 299" gives the same 89,700.
  const qty = String(raw).match(/^(.+?)\s*[x*\u00d7]\s*(\d{1,3})$/i);
  if (qty) {
    const unit = parseAmount(qty[1]);
    const out = unit == null ? null : unit * Number(qty[2]);
    return out != null && Number.isSafeInteger(out) ? out : null;
  }

  let s = String(raw)
    .trim()
    .toLowerCase()
    // `php` before the bare `p`, or the alternation eats the leading p and leaves "hp".
    .replace(/php|pesos?|[₱p]/g, '')
    .replace(/,/g, '')
    .trim();

  // "32 330" is how a phone keyboard types 32,330, and the extractor copies it verbatim
  // because it is forbidden from reformatting. Collapse the spaces only when the groups
  // really ARE thousands groups, so "1 2" stays unreadable instead of quietly becoming 12.
  if (/^-?\d{1,3}(?: \d{3})+(?:\.\d{1,2})?$/.test(s)) s = s.replace(/ /g, '');

  let mult = 1;
  const k = s.match(/^(-?\d+(?:\.\d+)?)\s*k$/);
  if (k) {
    s = k[1];
    mult = 1000;
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;

  // Scale as a string to avoid float error: 0.1 + 0.2 has no place near money.
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const centavos = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  const out = centavos * mult;
  if (!Number.isSafeInteger(out)) return null;
  return neg ? -out : out;
}

export function peso(centavos: number): string {
  const neg = centavos < 0;
  const a = Math.abs(centavos);
  const s = `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return `${neg ? '-' : ''}₱${s}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time. Manila civil dates, because Workers have no local timezone.
// ─────────────────────────────────────────────────────────────────────────────

const MANILA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Manila civil date (YYYY-MM-DD) of an instant. Every boundary in Tala keys on this. */
export function manilaDate(at: Date): string {
  return MANILA.format(at);
}

const MANILA_HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The Manila hour, 0-23. The daily line is the only boundary that is not a whole date. */
export function manilaHour(at: Date): number {
  return Number(MANILA_HOUR.format(at));
}

/**
 * The instant a Manila civil date began, as a UTC ISO string.
 *
 * `logged_at` is stored in UTC, so this is what turns "logged before today" into a
 * comparison SQL can actually do. Written as a literal offset because the Philippines has
 * had no DST and no offset change since 1978: Intl would return the same instant, and a
 * literal keeps this a pure string operation with nothing to configure.
 */
export const manilaStartOfDay = (date: string): string => new Date(`${date}T00:00:00+08:00`).toISOString();

/** Shift a YYYY-MM-DD civil date by whole days. No timezone involved, pure calendar. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, positive when b is later. */
export function dayDiff(a: string, b: string): number {
  const p = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

/** Inclusive list of civil dates. Bounded by callers to a snapshot period, never a year. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; dayDiff(d, to) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

export const monthOf = (date: string): string => date.slice(0, 7);

/** 0 = Sunday. Pure calendar via Date.UTC, so a Manila Friday is never a host-local Thursday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Day 0 of the next month IS the last day of this one — no month-length table. */
export function lastDayOfMonth(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * The Monday that starts this date's week.
 *
 * Monday, not Sunday: "this week" for spending means the working week you are inside, and a
 * Sunday start puts the weekend that just happened at the TOP of a list you are reading to
 * find out what you spent since Monday. One constant to flip if that is ever wrong.
 */
export const startOfWeek = (date: string): string => addDays(date, -((weekdayOf(date) + 6) % 7));

/**
 * Is a reminder due on this Manila civil date?
 *
 * `when` is one of: 'som' (the 1st), 'eom' (the last day, whatever it is), a weekday
 * abbreviation, or a day of the month.
 *
 * A day number past the month's length CLAMPS to the last day rather than not firing. The
 * 31st would otherwise be silently skipped in February, April, June, September and November
 * — and month-end is the deadline people actually set reminders for, so the failure would
 * land exactly on the reminder that mattered most. 'eom' says it explicitly; the clamp is
 * for the person who typed 31 meaning the same thing.
 */
export function reminderDue(when: string, date: string): boolean {
  const dom = Number(date.slice(8, 10));
  const last = lastDayOfMonth(date);
  if (when === 'som') return dom === 1;
  if (when === 'eom') return dom === last;
  const wd = WEEKDAYS.indexOf(when as never);
  if (wd >= 0) return weekdayOf(date) === wd;
  const n = Number(when);
  return Number.isInteger(n) && n >= 1 && dom === Math.min(n, last);
}

// ─────────────────────────────────────────────────────────────────────────────
// Events and correction resolution.
// ─────────────────────────────────────────────────────────────────────────────

export type EventType = 'expense' | 'income' | 'transfer' | 'interest' | 'cashback' | 'adjustment';

export interface Event {
  id: number;
  inbox_id?: number | null;
  type: EventType;
  book: string;
  account_id: string;
  amount_centavos: number;
  category?: string | null;
  merchant?: string | null;
  note?: string | null;
  recurrence?: string;
  shared_amount_centavos?: number | null;
  settled_at?: string | null;
  transfer_id?: string | null;
  fee_centavos?: number | null;
  occurred_at: string;
  logged_at: string;
  corrects_id?: number | null;
  confirmed_at?: string | null;
  telegram_message_id?: number | null;
  voided_at?: string | null;
}

export const rootId = (e: Event): number => e.corrects_id ?? e.id;

/**
 * Resolve a correction chain to one effective row per root.
 *
 * A correction is a FULL SUPERSEDE carrying the complete corrected payload, so the
 * effective row is simply the highest-id row in each chain. Two consequences worth the
 * design: a replayed correction is a no-op (idempotent by construction, so no dedupe
 * logic exists anywhere), and aggregates never show 250 and 285 as two expenses.
 *
 * Voided rows drop out entirely, and voiding the root voids the chain.
 */
export function effective(rows: Event[]): Event[] {
  const byRoot = new Map<number, Event>();
  const voidedRoots = new Set<number>();

  for (const r of rows) {
    if (r.voided_at) {
      voidedRoots.add(rootId(r));
      continue;
    }
    const root = rootId(r);
    const cur = byRoot.get(root);
    if (!cur || r.id > cur.id) byRoot.set(root, r);
  }
  for (const root of voidedRoots) byRoot.delete(root);
  return [...byRoot.values()];
}

/** Sum of signed amounts. Negative leaves the account, positive enters it. */
export const sum = (rows: Event[]): number => rows.reduce((t, r) => t + r.amount_centavos, 0);

const inWindow = (d: string, after: string, upto: string) => dayDiff(after, d) > 0 && dayDiff(d, upto) >= 0;

/** Effective rows for one account inside (after, upto]. */
export function windowFor(rows: Event[], accountId: string, after: string, upto: string): Event[] {
  return effective(rows).filter((r) => r.account_id === accountId && inWindow(r.occurred_at, after, upto));
}

// ─────────────────────────────────────────────────────────────────────────────
// The accrual fold. ONE implementation, shared by the projection and the rate learner —
// two implementations of centavo-days is the exact bug this exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

export interface RateConfig {
  rate: number; // net annual, on the capped slice
  rate_floor: number; // net annual, on the excess above the cap
  rate_cap_centavos?: number | null; // null = no cap, whole balance earns `rate`
}

/**
 * One day's credited interest on an end-of-previous-day balance.
 *
 * Rounded per day, not once per period: the bank rounds thirty times and we must too, or
 * drift is never zero even on a perfectly logged month. The capped and excess slices round
 * separately because that is how the credits actually post — Maya lands two rows a day.
 *
 * Base clamped at zero: the pass-through wallet model actively invites a negative pot
 * balance, and a negative base would fabricate negative interest that then feeds the
 * true-up and the learner.
 */
export function dailyInterest(balance: number, r: RateConfig): number {
  const base = Math.max(0, balance);
  if (base === 0 || r.rate <= 0) return 0;
  const cap = r.rate_cap_centavos;
  if (cap == null || base <= cap) return Math.round((base * r.rate) / 365);
  return Math.round((cap * r.rate) / 365) + Math.round(((base - cap) * r.rate_floor) / 365);
}

export interface Accrual {
  interest: number; // centavos credited across the period
  balance: number; // closing balance including credited interest
  centavoDays: number; // sum of daily bases — the learner's denominator
  days: number;
}

/**
 * Accrue from the snapshot anchor forward, day by day.
 *
 * `from` is the snapshot's as_of_date and `opening` is its balance at the end of that day.
 * Interest for day D is computed on the balance at the end of D-1 (both banks publish that
 * convention) and credited into the balance, so it compounds — realised yield sits a few
 * basis points above the simple rate, which is expected and must not be read as drift.
 *
 * `to` should be YESTERDAY, not today: today's interest is credited tomorrow on today's
 * close, so accruing through yesterday is exactly the confirmed portion. That is what makes
 * "confirmed matches the banking app" true without a cadence column.
 *
 * ponytail: credits are attributed to the day they are earned, not the day they post, so a
 * single day's boundary can differ from the app by one day's interest (~P21 on Maya). Model
 * the post lag only if the snapshot check ever disagrees by exactly that.
 */
export function accrue(
  opening: number,
  from: string,
  to: string,
  flowsByDate: Map<string, number>,
  r: RateConfig,
): Accrual {
  let balance = opening;
  let interest = 0;
  let centavoDays = 0;
  let days = 0;

  for (const day of daysBetween(addDays(from, 1), to)) {
    const base = Math.max(0, balance);
    centavoDays += base;
    const earned = dailyInterest(base, r);
    interest += earned;
    balance = balance + earned + (flowsByDate.get(day) ?? 0);
    days++;
  }
  return { interest, balance, centavoDays, days };
}

/**
 * Where the accrual must start, and what the balance was at that moment.
 *
 * Generated interest and REPORTED interest must never both count for the same day, so the
 * fold begins at whichever is later: the anchor, or the last credit actually reported. One
 * expression handles both "I never log credits" and "I logged one on the 3rd", with no set
 * of covered days to maintain.
 *
 * `creditsUpto` bounds which credits are allowed to close the period. A balance wants every
 * credit ever reported ('9999-12-31'); the rate learner wants only credits strictly BEFORE
 * the one being reported, or the period would start and end on the same day and there would
 * be nothing to divide by.
 *
 * Extracted so there is exactly ONE of these. Two implementations of the fold window is the
 * same bug class as two implementations of centavo-days: the second one fits its own error
 * as rate signal and quietly destroys a correct seed.
 */
export interface Fold {
  start: string; // the day the accrual opens on; `opening` is the balance at its close
  opening: number;
  after: Event[]; // effective rows strictly after `start`
}

export function foldFrom(
  anchor: { as_of_date: string; balance_centavos: number },
  rows: Event[],
  accountId: string,
  creditsUpto: string,
): Fold {
  // Open-ended above the anchor, deliberately NOT capped at today: a same-day expense books
  // forward to anchor+1, and capping here would hide what you just logged until tomorrow.
  const rowsIn = windowFor(rows, accountId, anchor.as_of_date, '9999-12-31');
  const credits = rowsIn.filter(
    (r) => (r.type === 'interest' || r.type === 'cashback') && dayDiff(r.occurred_at, creditsUpto) >= 0,
  );
  const start = credits.reduce(
    (a, r) => (dayDiff(a, r.occurred_at) > 0 ? r.occurred_at : a),
    anchor.as_of_date,
  );
  return {
    start,
    // rowsIn is strictly above the anchor, so this is the flows in (anchor, start].
    opening: anchor.balance_centavos + sum(rowsIn.filter((r) => dayDiff(r.occurred_at, start) >= 0)),
    after: rowsIn.filter((r) => dayDiff(start, r.occurred_at) > 0),
  };
}

/** Flows keyed by Manila date, excluding interest and cashback (the accrual generates those). */
export function flowsByDate(rows: Event[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.type === 'interest' || r.type === 'cashback') continue;
    m.set(r.occurred_at, (m.get(r.occurred_at) ?? 0) + r.amount_centavos);
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Balances. Two figures, and the distinction is the whole point.
// ─────────────────────────────────────────────────────────────────────────────

export interface Balance {
  accountId: string;
  confirmed: number; // anchor + logged flows + interest already credited. Matches the app.
  accrued: number; // today's uncredited slice. Always small under daily crediting.
  expected: number; // confirmed + accrued
  anchorDate: string | null;
  anchorAgeDays: number | null;
  estimated: boolean; // true while rate_source is still 'seeded_net'
}

/**
 * Pending rows ALWAYS count. `confirmed_at` is presentational and changes no arithmetic,
 * which deletes the filtering that would otherwise make an Aug 31 23:00 expense appear in
 * the August recap on Sep 2 but not on Sep 1. Confirmation is a review marker: you tap it,
 * or the 08:00 daily line sets it for everything logged before today.
 */
export function balanceOf(
  account: {
    id: string;
    rate: number;
    rate_floor: number;
    rate_cap_centavos?: number | null;
    rate_source: string;
  },
  anchor: { as_of_date: string; balance_centavos: number } | null,
  rows: Event[],
  today: string,
): Balance {
  // An un-anchored account has NO BALANCE — it has a running total of flows with no
  // baseline. Reporting that sum as a balance says "you have -₱500", which is not what is
  // known: what is known is "₱500 left, from an unknown starting point". The caller must
  // render it as a flow and leave it OUT of any book total, or one un-anchored account
  // silently makes the whole book's net worth wrong.
  if (!anchor) {
    const all = effective(rows).filter((r) => r.account_id === account.id);
    return {
      accountId: account.id,
      confirmed: sum(all), // a NET FLOW, not a balance — anchorDate === null says so
      accrued: 0,
      expected: sum(all),
      anchorDate: null,
      anchorAgeDays: null,
      estimated: account.rate > 0,
    };
  }

  const yesterday = addDays(today, -1);
  // Every credit ever reported closes a period here — a balance must not re-generate
  // interest for a day the bank already paid.
  const fold = foldFrom(anchor, rows, account.id, '9999-12-31');
  const folded = accrue(fold.opening, fold.start, yesterday, flowsByDate(fold.after), account);

  // accrue() applies flows dated fold.start+1 .. yesterday, so everything the fold did not
  // reach has to be added here. That is today's rows AND anything booked forward — a
  // same-day expense lands on anchor+1, which can be tomorrow. Matching `=== today` would
  // drop exactly the row you just logged.
  const beyondFold = sum(fold.after.filter((r) => dayDiff(yesterday, r.occurred_at) > 0));
  const confirmed = folded.balance + beyondFold;
  const accrued = dailyInterest(confirmed, account); // today's slice, credited tomorrow

  return {
    accountId: account.id,
    confirmed,
    accrued,
    expected: confirmed + accrued,
    anchorDate: anchor.as_of_date,
    anchorAgeDays: dayDiff(anchor.as_of_date, today),
    estimated: account.rate > 0 && account.rate_source === 'seeded_net',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation. The identity, and the drift it measures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * drift = actual - (previous anchor + everything logged in between)
 *
 * Positive drift means money appeared: untracked interest, a promo credit, or an unlogged
 * inflow. Negative means it left: a fee, an unlogged expense, a missing transfer leg.
 *
 * The number is only useful once it is TAGGED. Untagged, a duplicate row, a P10 InstaPay
 * fee, a missing transfer leg, a snapshot typo and "I forgot to log things" are
 * mathematically identical — and net worth ties to the centavo while the category totals
 * you actually decide with are understated by exactly this.
 */
export function drift(
  prev: { as_of_date: string; balance_centavos: number },
  next: { as_of_date: string; balance_centavos: number },
  rows: Event[],
  accountId: string,
): number {
  const between = windowFor(rows, accountId, prev.as_of_date, next.as_of_date);
  return next.balance_centavos - (prev.balance_centavos + sum(between));
}

/**
 * Where a backdated entry must land.
 *
 * Booking it to its real date would put an expense into a period whose adjustment row
 * already accounted for it — August would carry both, September's drift would come out
 * +800 and cancel, and the same August recap would give a different answer depending on
 * when you ran it. So: keep the true date in the note, book the row to the open period.
 */
export function bookingDate(
  occurredAt: string,
  latestAnchor: string | null,
): { date: string; lateFor: string | null } {
  if (!latestAnchor) return { date: occurredAt, lateFor: null };
  const behind = dayDiff(occurredAt, latestAnchor); // > 0 means the anchor is later

  // After the anchor: an ordinary flow on its own date.
  if (behind < 0) return { date: occurredAt, lateFor: null };

  // SAME DAY as the anchor is a real flow, not a reclassification. You read the banking app
  // once and then go on spending, so a same-day expense almost always happened AFTER the
  // reading. Treating it as already-in-the-anchor would net it to zero and freeze your
  // balance for the whole day you snapshotted. It books to the NEXT day because the
  // reconciliation window is (anchor, next] — exclusive — so a row dated on the anchor day
  // would fall outside every window and be silently invisible.
  //
  // ponytail: wrong only if you snapshot late at night AFTER spending, which double-counts
  // that day and surfaces as positive drift next month. Compare the snapshot's clock time
  // if that ever actually bites.
  if (behind === 0) return { date: addDays(latestAnchor, 1), lateFor: null };

  // Strictly before the anchor: the money left before the reading, so the anchor already
  // contains it. This is the reclassification case — see lateEntryPair.
  return { date: addDays(latestAnchor, 1), lateFor: occurredAt };
}

/**
 * A late entry is a RECLASSIFICATION, not a flow.
 *
 * The subtle half of the late-entry rule, and the one that actually bites. If the money
 * left on 28 August and the anchor was read on 31 August, the anchor balance ALREADY
 * contains it — and August's adjustment row already absorbed it as untagged drift.
 * Booking it as a fresh September flow double-counts it: September's derived balance comes
 * out low, September's drift comes out positive by the same amount and cancels August's,
 * and you end up with today's net worth right and every historical month wrong.
 *
 * So it books as a PAIR that nets to zero on the balance: the categorised row, plus an
 * offsetting adjustment whose note says where it came from. The category recap gains the
 * spend, the balance does not move, and the ledger explains itself without a new column.
 *
 * A genuinely NEW expense in the open period is not this — it is one ordinary row.
 */
export function lateEntryPair<T extends { amount_centavos: number; note?: string | null }>(
  row: T,
  lateFor: string,
): [T, T & { type: 'adjustment'; category: string }] {
  const tagged = { ...row, note: `late entry for ${lateFor}${row.note ? ` · ${row.note}` : ''}` };
  const offset = {
    ...tagged,
    type: 'adjustment' as const,
    category: 'reclassified',
    amount_centavos: -row.amount_centavos,
    note: `reclassified from drift before ${lateFor}`,
  };
  return [tagged, offset];
}

// ─────────────────────────────────────────────────────────────────────────────
// The rate learner, with all three guards.
// ─────────────────────────────────────────────────────────────────────────────

export interface LearnResult {
  accepted: boolean;
  rate: number; // the rate to store (the seed, unchanged, when rejected)
  implied: number;
  reason: string;
}

/**
 * Learn a net rate from observed credits, or refuse and say so.
 *
 * The denominator is the accrual's own centavo-days. The design originally accrued on the
 * opening balance while dividing by the average — two denominators, so the formula error
 * gets fitted AS rate signal, rate_source flips to 'observed', and the good seed is gone
 * permanently. Maya at P10,000 with P5,000 spent on the 15th: true P61.64 against P82.19
 * by the opening-balance method, 33% over.
 *
 * Three guards, each for a failure that actually happens:
 *  - centavoDays near zero divides by a user-controlled number: a P5 residual credit on a
 *    P50 average yields 120% p.a., written as authoritative and never pulled back.
 *  - A result outside [0, 2x seed] is a mis-typed credit, not a rate change.
 *  - Two observations minimum, because one month can be a partial period.
 *
 * Callers must SUM same-day credit rows before passing `credited`. Maya posts base and
 * boost as separate rows, and a learner reading them as separate days converges on 2.4%
 * or 5.6% from a perfectly correct 8% seed — the likeliest way a right seed still breaks.
 */
export function learnRate(
  credited: number,
  centavoDays: number,
  seed: number,
  observationCount: number,
): LearnResult {
  const floor = 100_000; // P1,000 of centavo-days: below this the quotient is meaningless
  if (centavoDays < floor)
    return { accepted: false, rate: seed, implied: 0, reason: 'balance too small to infer a rate' };
  if (credited < 0) return { accepted: false, rate: seed, implied: 0, reason: 'negative credit' };

  const implied = (credited * 365) / centavoDays;
  if (implied > seed * 2)
    return { accepted: false, rate: seed, implied, reason: 'implied rate more than double the seed' };
  if (observationCount < 2)
    return { accepted: false, rate: seed, implied, reason: 'need a second observation' };

  return { accepted: true, rate: implied, implied, reason: 'learned from observed credits' };
}

/**
 * Read a rate a human typed, and refuse anything ambiguous.
 *
 * The basis word is mandatory and this is the one place worth being fussy about, because
 * both banks ADVERTISE gross and CREDIT net. Type Maya's advertised 10% as a rate and every
 * projection runs 25% hot forever — the exact error this whole design spent its effort
 * removing. So "10% gross" and "8% net" both store 0.08, and a bare "10%" is refused.
 *
 * A bare integer is refused too: "10" could mean 10% or 1000%, and guessing at a number
 * that multiplies every future balance is not a guess worth making.
 */
export function parseRate(value: string, basis: 'gross' | 'net'): number | null {
  const raw = value.trim().toLowerCase();
  const pct = raw.endsWith('%');
  const n = Number(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n) || n < 0) return null;

  let rate: number;
  if (pct) rate = n / 100;
  else if (n < 1)
    rate = n; // 0.08 is unambiguous
  else return null; // "10" without a % sign

  if (basis === 'gross') rate *= 0.8; // PH withholds 20% final tax at source
  // A deposit rate above 50% is a typo, not a promo.
  return rate > 0.5 ? null : Math.round(rate * 1e6) / 1e6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrity checks. The only mechanisms that tell a real bug from ordinary drift.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A transfer must be exactly two rows summing to zero. Without this check a half-logged
 * transfer produces two opposite drifts whose adjustments cancel — the design self-heals
 * into looking correct while two accounts were wrong by P3,000 all month.
 */
export function brokenTransfers(rows: Event[]): string[] {
  const legs = new Map<string, Event[]>();
  for (const r of effective(rows)) {
    if (!r.transfer_id) continue;
    const group = legs.get(r.transfer_id);
    if (group) group.push(r);
    else legs.set(r.transfer_id, [r]);
  }
  const bad: string[] = [];
  for (const [id, group] of legs) {
    // The fee leg is a third row by design, so net-to-zero is checked on the two transfer legs.
    const transferLegs = group.filter((r) => r.type === 'transfer');
    if (transferLegs.length !== 2 || sum(transferLegs) !== 0) bad.push(id);
  }
  return bad;
}

/** Fronted money nobody has paid back yet. Reported as ONE aggregate, never a chase list. */
export function unsettled(rows: Event[]): number {
  return effective(rows)
    .filter((r) => (r.shared_amount_centavos ?? 0) > 0 && !r.settled_at)
    .reduce((t, r) => t + (r.shared_amount_centavos ?? 0), 0);
}

/**
 * The day a row belongs to in a REPORT, which is not always the day it belongs to in the
 * reconciliation.
 *
 * `occurred_at` answers "when did the money move", because that is what the snapshot windows
 * need. A same-day expense books to anchor+1 (see bookingDate) so it lands inside a window
 * at all — the anchor you just read already contains it, and dating it on the anchor day
 * would both net it to zero and fall outside `(anchor, next]` entirely.
 *
 * That makes `occurred_at` wrong for the other question a recap asks: "what did I spend
 * today". Anchor six accounts this morning and everything you log afterwards is dated
 * tomorrow, so today's recap shows nothing you actually spent.
 *
 * A row dated AFTER the day it was typed can only have been pushed there by that rule —
 * resolveDate refuses a future hint, so nothing else can produce one. So the reporting date
 * is the day you typed it, and otherwise it is `occurred_at` (which stays correct for a
 * genuinely backdated entry). Total and single-valued, so no row lands in two windows or
 * none.
 */
export function reportDate(r: { occurred_at: string; logged_at: string }): string {
  const typed = manilaDate(new Date(r.logged_at));
  return dayDiff(typed, r.occurred_at) > 0 ? typed : r.occurred_at;
}

/**
 * The part of an expense that is actually your money, as a positive spend figure.
 *
 * One expression, shared by the category totals and the itemised list, because two copies
 * of "subtract the shared portion" is how a recap's items stop adding up to its own total.
 * A refund is a positive-signed expense row, so this comes out negative and nets.
 */
export const yours = (r: Event): number => -r.amount_centavos - (r.shared_amount_centavos ?? 0);

/** Spend per category over effective rows, net of refunds and of other people's money. */
export function spendByCategory(rows: Event[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of effective(rows)) {
    if (r.type !== 'expense') continue;
    const key = r.category ?? 'other';
    out.set(key, (out.get(key) ?? 0) + yours(r));
  }
  return out;
}

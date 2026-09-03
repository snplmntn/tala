/**
 * The one check the design cannot do without.
 *
 * Everything in Tala reduces to:
 *   snapshot(n) + events in (n, n+1] = snapshot(n+1)
 * exactly, in integer centavos. The adjustment row is DEFINED as the remainder, so the
 * books tie by construction — they can never fail and can never warn. This file is the
 * only thing that can, which is why every other guard in the design is unverified without it.
 *
 * node --test. Stdlib asserts, one file, no framework, no fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accrue,
  addDays,
  balanceOf,
  bookingDate,
  brokenTransfers,
  dailyInterest,
  dayDiff,
  daysBetween,
  drift,
  effective,
  flowsByDate,
  learnRate,
  lateEntryPair,
  manilaDate,
  parseAmount,
  parseRate,
  peso,
  reminderDue,
  reportDate,
  spendByCategory,
  startOfWeek,
  sum,
  unsettled,
  type Event,
} from '../src/ledger.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

let nextId = 1;
function ev(p: Partial<Event> & { amount_centavos: number; occurred_at: string }): Event {
  return {
    id: nextId++,
    type: 'expense',
    book: 'personal',
    account_id: 'maribank',
    logged_at: '2026-09-01T00:00:00Z',
    ...p,
  } as Event;
}

const MAYA = {
  id: 'maya',
  rate: 0.08,
  rate_floor: 0.024,
  rate_cap_centavos: 10_000_000,
  rate_source: 'seeded_net',
};
const MARIBANK = {
  id: 'maribank',
  rate: 0.026,
  rate_floor: 0.026,
  rate_cap_centavos: null,
  rate_source: 'seeded_net',
};
const GCASH = { id: 'gcash', rate: 0, rate_floor: 0, rate_cap_centavos: null, rate_source: 'seeded_net' };

// ── money: the path where a float bug becomes a wrong balance ────────────────

test('parseAmount reads what people actually type, and refuses what it cannot read', () => {
  assert.equal(parseAmount('250'), 25_000);
  assert.equal(parseAmount('1,234.56'), 123_456);
  assert.equal(parseAmount('₱98,000'), 9_800_000);
  assert.equal(parseAmount('P250.5'), 25_050);
  assert.equal(parseAmount('2k'), 200_000);
  assert.equal(parseAmount('3.5k'), 350_000);
  assert.equal(parseAmount('-500'), -50_000);
  // A phone keyboard groups thousands with a space, and the extractor copies it verbatim.
  assert.equal(parseAmount('32 330'), 3_233_000);
  assert.equal(parseAmount('1 234 567.89'), 123_456_789);
  assert.equal(parseAmount('php 250'), 25_000);
  // But a space is only a separator when the groups are real thousands groups.
  assert.equal(parseAmount('1 2'), null);
  assert.equal(parseAmount('32 33'), null);

  // Refuse rather than guess: a silently wrong amount is indistinguishable from
  // forgotten spending once it lands in the drift row.
  assert.equal(parseAmount('a lot'), null);
  assert.equal(parseAmount('250.567'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

test('no float error survives the parse', () => {
  // 0.1 + 0.2 has no place near money. Scaling happens on the string.
  assert.equal(parseAmount('0.10')! + parseAmount('0.20')!, parseAmount('0.30'));
  assert.equal(parseAmount('19.99')! * 3, parseAmount('59.97'));
});

test('peso formats for humans', () => {
  assert.equal(peso(9_856_416), '₱98,564.16');
  assert.equal(peso(2148), '₱21.48');
  assert.equal(peso(-80_000), '-₱800.00');
  assert.equal(peso(0), '₱0.00');
});

// ── time: wrong by construction if you use toISOString ──────────────────────

test('manilaDate does not misdate the daily 8-hour window', () => {
  // 16:00 UTC is already the next calendar day in Manila (UTC+8). This is the guaranteed
  // window where toISOString().slice(0,10) would file a row into the wrong day — and on
  // the 1st, into the wrong month's recap and accrual base.
  assert.equal(manilaDate(new Date('2026-09-01T16:00:00Z')), '2026-09-02');
  assert.equal(manilaDate(new Date('2026-09-01T15:59:00Z')), '2026-09-01');
  assert.equal(manilaDate(new Date('2026-08-31T16:00:00Z')), '2026-09-01');
});

test('civil date arithmetic crosses months and leap days', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(dayDiff('2026-09-01', '2026-10-01'), 30);
  assert.equal(daysBetween('2026-09-01', '2026-09-03').length, 3);
});

// ── the accrual, against hand-computed real figures ─────────────────────────

test('one day of interest matches the banks own arithmetic', () => {
  // Maya, ₱98,000 at 8.00% net (10% gross x 0.80), whole balance inside the ₱100k cap:
  //   9,800,000 x 0.08 / 365 = 2,147.945 -> 2,148 centavos = ₱21.48
  assert.equal(dailyInterest(9_800_000, MAYA), 2148);

  // And it posts as two rows in the app. Base 3% gross -> 2.4% net gives ₱6.44,
  // boost 7% gross -> 5.6% net gives ₱15.04, summing to the same ₱21.48.
  assert.equal(dailyInterest(9_800_000, { ...MAYA, rate: 0.024 }), 644);
  assert.equal(dailyInterest(9_800_000, { ...MAYA, rate: 0.056 }), 1504);
  assert.equal(644 + 1504, 2148);

  // Maribank, ₱13,000 at 2.60% net: 1,300,000 x 0.026 / 365 = 92.60 -> 93 = ₱0.93
  assert.equal(dailyInterest(1_300_000, MARIBANK), 93);

  // An untracked pot earns nothing here — GoTyme's real interest surfaces as tagged drift.
  assert.equal(dailyInterest(8_500_000, GCASH), 0);
});

test('the boost cap slices the balance instead of the whole thing dropping', () => {
  // ₱150,000: first ₱100k at 8%, the ₱50k excess at the 2.4% floor.
  const expected = Math.round((10_000_000 * 0.08) / 365) + Math.round((5_000_000 * 0.024) / 365);
  assert.equal(dailyInterest(15_000_000, MAYA), expected);
  // And the cap is a ceiling, not a haircut: at ₱98,000 it costs exactly nothing.
  assert.equal(dailyInterest(9_800_000, MAYA), Math.round((9_800_000 * 0.08) / 365));
});

test('a negative pot base cannot fabricate negative interest', () => {
  // The pass-through wallet model actively invites this, and a negative base would feed
  // fake interest into both the true-up and the rate learner.
  assert.equal(dailyInterest(-300_000, MAYA), 0);
  const a = accrue(-300_000, '2026-09-01', '2026-09-10', new Map(), MAYA);
  assert.equal(a.interest, 0);
  assert.equal(a.centavoDays, 0);
});

test('31 days at 10% on ₱10,000 compounds slightly above the simple figure', () => {
  const a = accrue(1_000_000, '2026-09-01', '2026-10-02', new Map(), {
    rate: 0.1,
    rate_floor: 0.1,
    rate_cap_centavos: null,
  });
  assert.equal(a.days, 31);

  // Simple arithmetic: 1,000,000 x 0.10 / 365 = 273.97 -> 274/day, x31 = 8,494 = ₱84.94.
  // But both banks credit net interest INTO the balance that earns the next day's interest,
  // so the fold compounds and lands at ₱85.27. That is the realised yield (~10.5% on a
  // 10% nominal), not drift — and a learner fitting a long window must not "correct" it.
  assert.equal(a.interest, 8527);
  assert.ok(a.interest > 274 * 31, 'compounding lifts it above simple');
  assert.ok(a.interest - 274 * 31 < 50, 'but only by ₱0.33 over a month');
});

test('accrual rounds per day, because the bank rounds thirty times', () => {
  // Rounding once at the end diverges, so drift would never be zero even on a
  // perfectly logged month. Per-day rounding means the fold is a plain sum of integers.
  const days = 30;
  const perDay = dailyInterest(9_800_000, { ...MAYA, rate: 0.024 }); // 644, no compounding drift
  const a = accrue(9_800_000, '2026-09-01', '2026-10-01', new Map(), { ...MAYA, rate: 0.024 });
  assert.equal(a.days, days);
  assert.ok(a.interest > perDay * days, 'compounding should lift it slightly above simple');
  assert.ok(a.interest < perDay * days + 40, 'but only slightly');
});

test('accrual periods have no overlap and no gap', () => {
  const flows = new Map<string, number>();
  const whole = accrue(9_800_000, '2026-09-01', '2026-09-30', flows, MAYA);
  const first = accrue(9_800_000, '2026-09-01', '2026-09-15', flows, MAYA);
  const second = accrue(first.balance, '2026-09-15', '2026-09-30', flows, MAYA);

  assert.equal(first.days + second.days, whole.days);
  assert.equal(first.interest + second.interest, whole.interest);
  assert.equal(second.balance, whole.balance);
});

// ── corrections: full supersede, idempotent by construction ─────────────────

test('a 250 to 285 correction sums to 285 exactly once', () => {
  const root = ev({
    amount_centavos: -25_000,
    occurred_at: '2026-09-05',
    category: 'food',
    merchant: 'jollibee',
  });
  const fix = ev({
    amount_centavos: -28_500,
    occurred_at: '2026-09-05', // keeps the expense in its own month
    category: 'food',
    merchant: 'jollibee',
    corrects_id: root.id,
  });

  const eff = effective([root, fix]);
  assert.equal(eff.length, 1, 'one effective row per chain, not two food expenses');
  assert.equal(sum(eff), -28_500);
});

test('a replayed correction is a no-op', () => {
  // A webhook retry, or repeating yourself because the confirmation did not render.
  // A delta would silently make it 320; an absolute supersede cannot.
  const root = ev({ amount_centavos: -25_000, occurred_at: '2026-09-05' });
  const fix1 = ev({ amount_centavos: -28_500, occurred_at: '2026-09-05', corrects_id: root.id });
  const fix2 = ev({ amount_centavos: -28_500, occurred_at: '2026-09-05', corrects_id: root.id });

  assert.equal(sum(effective([root, fix1])), -28_500);
  assert.equal(sum(effective([root, fix1, fix2])), -28_500, 'replay must not compound');
});

test('a correction can move the account, and only the corrected row counts', () => {
  const root = ev({ amount_centavos: -25_000, occurred_at: '2026-09-05', account_id: 'maribank' });
  const fix = ev({
    amount_centavos: -25_000,
    occurred_at: '2026-09-05',
    account_id: 'gcash',
    corrects_id: root.id,
  });
  const eff = effective([root, fix]);
  assert.equal(eff.length, 1);
  assert.equal(eff[0].account_id, 'gcash');
});

test('voiding drops the whole chain, and never mutates a sum in place', () => {
  const root = ev({ amount_centavos: -25_000, occurred_at: '2026-09-05' });
  const fix = ev({
    amount_centavos: -28_500,
    occurred_at: '2026-09-05',
    corrects_id: root.id,
    voided_at: '2026-09-06T00:00:00Z',
  });
  assert.equal(sum(effective([root, fix])), 0);
});

// ── transfers: the largest amounts in the ledger ─────────────────────────────

test('a transfer nets to zero and a half-logged one is caught', () => {
  const out = ev({
    type: 'transfer',
    amount_centavos: -300_000,
    occurred_at: '2026-09-15',
    account_id: 'maya',
    transfer_id: 't1',
  });
  const inn = ev({
    type: 'transfer',
    amount_centavos: 300_000,
    occurred_at: '2026-09-15',
    account_id: 'gotyme',
    book: 'business',
    transfer_id: 't1',
  });

  assert.equal(sum([out, inn]), 0, 'a cross-book transfer moves no net worth');
  assert.deepEqual(brokenTransfers([out, inn]), []);

  // Two sequential awaits plus the 10ms CPU ceiling gives you exactly this: one leg.
  // Without the check it produces two opposite drifts whose adjustments cancel, and the
  // design self-heals into looking correct while two accounts were wrong all month.
  assert.deepEqual(brokenTransfers([out]), ['t1']);
});

test('the fee leg is a third row and does not break the zero-sum check', () => {
  const out = ev({
    type: 'transfer',
    amount_centavos: -300_000,
    occurred_at: '2026-09-15',
    account_id: 'maya',
    transfer_id: 't2',
    fee_centavos: 1000,
  });
  const inn = ev({
    type: 'transfer',
    amount_centavos: 300_000,
    occurred_at: '2026-09-15',
    account_id: 'gotyme',
    transfer_id: 't2',
  });
  const fee = ev({
    type: 'expense',
    amount_centavos: -1000,
    occurred_at: '2026-09-15',
    account_id: 'maya',
    category: 'fees',
    transfer_id: 't2',
  });

  assert.deepEqual(brokenTransfers([out, inn, fee]), []);
  assert.equal(sum([out, inn, fee]), -1000, 'the ₱10 InstaPay fee is the only net loss');
});

// ── refunds and shared money ────────────────────────────────────────────────

test('a refund is a positive expense row and nets its category automatically', () => {
  const bought = ev({ amount_centavos: -50_000, occurred_at: '2026-09-08', category: 'shopping' });
  const refund = ev({ amount_centavos: 50_000, occurred_at: '2026-09-12', category: 'shopping' });
  const cats = spendByCategory([bought, refund]);
  assert.equal(cats.get('shopping'), 0, 'no reverses_id, no special case');
});

test('fronting money for a group does not overstate your own spending', () => {
  const meal = ev({
    amount_centavos: -60_000,
    occurred_at: '2026-09-09',
    category: 'food',
    shared_amount_centavos: 40_000,
  });
  assert.equal(spendByCategory([meal]).get('food'), 20_000, 'only ₱200 was yours');
  assert.equal(unsettled([meal]), 40_000);

  const settled = ev({ ...meal, id: 99, settled_at: '2026-09-20T00:00:00Z' });
  assert.equal(unsettled([settled]), 0, 'settled receivables stop being owed');
});

// ── late entries: the bug that makes history depend on when you run the report ──

test('a backdated entry books to the open period, keeping its true date in the note', () => {
  // August already wrote a drift adjustment covering this spend. Booking it back into
  // August would double-count it there and make September cancel — today's net worth
  // right, every historical month wrong, and the same August recap answering differently
  // depending on when you ran it.
  const late = bookingDate('2026-08-28', '2026-08-31');
  assert.equal(late.date, '2026-09-01');
  assert.equal(late.lateFor, '2026-08-28');

  // An ordinary entry in the open period is untouched.
  const normal = bookingDate('2026-09-05', '2026-08-31');
  assert.equal(normal.date, '2026-09-05');
  assert.equal(normal.lateFor, null);

  // And with no anchor yet, nothing is late.
  assert.equal(bookingDate('2026-08-28', null).lateFor, null);
});

test('a late entry moves no balance, because the anchor already contains it', () => {
  // The subtle half, and the one that actually bites. The ₱8 left the account on Aug 28,
  // so the Aug 31 anchor already reflects it and August's adjustment already absorbed it
  // as untagged drift. Booked as a fresh September flow it would double-count: September
  // low by ₱8, September's drift +₱8, cancelling August's — net worth right today, every
  // historical month wrong. So it books as a pair that nets to zero.
  const [tagged, offset] = lateEntryPair({ amount_centavos: -800, note: 'jollibee' }, '2026-08-28');
  assert.equal(tagged.amount_centavos + offset.amount_centavos, 0, 'no balance moves');
  assert.equal(offset.type, 'adjustment');
  assert.equal(offset.category, 'reclassified');
  assert.match(tagged.note!, /late entry for 2026-08-28/);
  assert.match(tagged.note!, /jollibee/);
});

test('an event dated exactly on the anchor date is already inside the anchor', () => {
  // A snapshot balance is the state at the END of as_of_date, so the reconciliation
  // window is (anchor, next] — exclusive. Counting a same-day row again would
  // double-count every expense you logged just before taking a snapshot.
  const anchor = { as_of_date: '2026-09-01', balance_centavos: 1_300_000 };
  const sameDay = [ev({ amount_centavos: -25_000, occurred_at: '2026-09-01' })];
  const b = balanceOf(MARIBANK, anchor, sameDay, '2026-09-01');
  assert.equal(b.confirmed, 1_300_000, 'the anchor stands alone on its own day');
});

// ── the rate learner and its three guards ───────────────────────────────────

test('the learner recovers the real rate from real credits', () => {
  const a = accrue(9_800_000, '2026-09-01', '2026-10-01', new Map(), MAYA);
  const r = learnRate(a.interest, a.centavoDays, 0.08, 2);
  assert.ok(r.accepted, r.reason);
  assert.ok(Math.abs(r.implied - 0.08) < 0.001, `implied ${r.implied}`);
});

test('the learner refuses rather than writing an authoritative wrong number', () => {
  // A ₱5 residual credit on a ₱50 average balance implies 120% p.a. — written once as
  // 'observed' and nothing would ever pull it back.
  assert.equal(learnRate(500, 5000, 0.08, 5).accepted, false);
  // A mis-typed credit is not a rate change.
  assert.equal(learnRate(500_000, 294_000_000, 0.08, 5).accepted, false);
  // One month can be a partial period.
  assert.equal(learnRate(64_439, 294_000_000, 0.08, 1).accepted, false);
  // And a refusal keeps the good seed instead of degrading it.
  assert.equal(learnRate(500, 5000, 0.08, 5).rate, 0.08);
});

test('a lapsed monthly boost is accepted as real, not rejected as noise', () => {
  // Miss ₱25,000 of qualifying spend and Maya drops to base 2.4% net. The learner must
  // take that, or it will insist on 8% forever and blame reconciliation for the gap.
  const base = accrue(9_800_000, '2026-09-01', '2026-10-01', new Map(), { ...MAYA, rate: 0.024 });
  const r = learnRate(base.interest, base.centavoDays, 0.08, 2);
  assert.ok(r.accepted, r.reason);
  assert.ok(Math.abs(r.implied - 0.024) < 0.001, `implied ${r.implied}`);
});

// ── balances: two figures, and the distinction is the point ──────────────────

test('confirmed is the anchor plus what was logged; accrued is only today', () => {
  const anchor = { as_of_date: '2026-09-01', balance_centavos: 1_300_000 };
  const rows = [ev({ amount_centavos: -25_000, occurred_at: '2026-09-03' })];
  const b = balanceOf(MARIBANK, anchor, rows, '2026-09-05');

  // Anchor - ₱250 + four days of daily-credited interest.
  const acc = accrue(1_300_000, '2026-09-01', '2026-09-04', flowsByDate(rows), MARIBANK);
  assert.equal(b.confirmed, acc.balance);
  assert.equal(b.accrued, dailyInterest(b.confirmed, MARIBANK));
  assert.equal(b.expected, b.confirmed + b.accrued);
  assert.equal(b.anchorAgeDays, 4, 'the balance carries its own age');
  assert.equal(b.estimated, true, 'and says so while the rate is still seeded');
});

test('pending rows always count, so a recap does not change without an edit', () => {
  // If pending were excluded anywhere, an Aug 31 23:00 expense would be absent from the
  // August recap run on Sep 1 and present in the same recap run on Sep 2.
  const anchor = { as_of_date: '2026-08-31', balance_centavos: 1_300_000 };
  const late = [ev({ amount_centavos: -25_000, occurred_at: '2026-08-31', confirmed_at: null })];
  const a = balanceOf(MARIBANK, anchor, late, '2026-09-01');
  const b = balanceOf(MARIBANK, anchor, [{ ...late[0], confirmed_at: '2026-09-02T00:00:00Z' }], '2026-09-01');
  assert.equal(a.confirmed, b.confirmed, 'confirming changes no arithmetic');
});

test('a reported credit stops the fold double-counting the same days', () => {
  const anchor = { as_of_date: '2026-09-01', balance_centavos: 9_800_000 };
  const reported = ev({
    type: 'interest',
    amount_centavos: 2148,
    occurred_at: '2026-09-02',
    account_id: 'maya',
  });
  const b = balanceOf(MAYA, anchor, [reported], '2026-09-04');

  // Fold resumes from the reported credit, not from the anchor.
  const resumed = accrue(9_800_000 + 2148, '2026-09-02', '2026-09-03', new Map(), MAYA);
  assert.equal(b.confirmed, resumed.balance);
});

test('with no anchor yet, the balance is just the events', () => {
  const rows = [ev({ amount_centavos: 300_000, occurred_at: '2026-09-01', type: 'income' })];
  const b = balanceOf(MARIBANK, null, rows, '2026-09-05');
  assert.equal(b.confirmed, 300_000);
  assert.equal(b.anchorDate, null);
});

// ── THE IDENTITY. A synthetic month with one of everything. ──────────────────

test('drift is exactly zero when everything is logged', () => {
  const prev = { as_of_date: '2026-09-01', balance_centavos: 1_300_000 };

  const expenseRoot = ev({
    amount_centavos: -25_000,
    occurred_at: '2026-09-05',
    category: 'food',
    merchant: 'jollibee',
  });
  const rows: Event[] = [
    expenseRoot,
    ev({
      amount_centavos: -28_500,
      occurred_at: '2026-09-05',
      category: 'food',
      merchant: 'jollibee',
      corrects_id: expenseRoot.id,
    }),
    ev({
      type: 'income',
      amount_centavos: 300_000,
      occurred_at: '2026-09-10',
      recurrence: 'monthly',
      note: 'scholarship',
    }),
    ev({ type: 'transfer', amount_centavos: -200_000, occurred_at: '2026-09-15', transfer_id: 'x1' }),
    ev({
      type: 'transfer',
      amount_centavos: 200_000,
      occurred_at: '2026-09-15',
      account_id: 'maya',
      transfer_id: 'x1',
    }),
    ev({
      amount_centavos: -1000,
      occurred_at: '2026-09-15',
      category: 'fees',
      transfer_id: 'x1',
      note: 'instapay',
    }),
    ev({ amount_centavos: 5_000, occurred_at: '2026-09-20', category: 'shopping', note: 'refund' }),
    ev({
      amount_centavos: -60_000,
      occurred_at: '2026-09-22',
      category: 'food',
      shared_amount_centavos: 40_000,
    }),
  ];

  // A late entry books as a netting pair, so it lands in the food recap without moving
  // a balance the anchor already accounts for.
  for (const r of lateEntryPair({ amount_centavos: -800, note: 'sari-sari' }, '2026-08-28'))
    rows.push(ev({ ...r, occurred_at: '2026-09-02', category: 'food' }));

  // The month's real credited interest, folded the one way the whole system folds it.
  const mine = rows.filter((r) => r.account_id === 'maribank');
  const acc = accrue(prev.balance_centavos, '2026-09-01', '2026-09-30', flowsByDate(mine), MARIBANK);
  rows.push(ev({ type: 'interest', amount_centavos: acc.interest, occurred_at: '2026-09-30' }));

  const next = {
    as_of_date: '2026-10-01',
    balance_centavos: prev.balance_centavos + sum(effective(rows).filter((r) => r.account_id === 'maribank')),
  };

  assert.equal(drift(prev, next, rows, 'maribank'), 0, 'a fully logged month has nothing to explain');

  // And the plug is exactly the gap when something IS missing — ₱137 of unlogged spend.
  const short = { ...next, balance_centavos: next.balance_centavos - 13_700 };
  assert.equal(drift(prev, short, rows, 'maribank'), -13_700);

  // Cross-book: the transfer's other leg belongs to Maya and never touches Maribank's drift.
  assert.equal(sum(effective(rows).filter((r) => r.account_id === 'maya')), 200_000);
});

test('re-anchoring the same day twice leaves the balance identical', () => {
  // The snapshot UNIQUE(account_id, as_of_date) makes this idempotent at the database, so
  // there is no separate month-close event that can be run twice and double the interest.
  const anchor = { as_of_date: '2026-09-01', balance_centavos: 1_300_000 };
  const rows = [ev({ amount_centavos: -25_000, occurred_at: '2026-09-03' })];
  const a = balanceOf(MARIBANK, anchor, rows, '2026-09-05');
  const b = balanceOf(MARIBANK, { ...anchor }, rows, '2026-09-05');
  assert.equal(a.confirmed, b.confirmed);
  assert.equal(a.expected, b.expected);
});

// ── rates typed by a human: the one place worth refusing rather than guessing ──

test('parseRate applies the withholding tax to a gross figure', () => {
  // Both banks advertise gross and credit net. Typing Maya's advertised 10% as a rate
  // would run every projection 25% hot forever.
  assert.equal(parseRate('10%', 'gross'), 0.08);
  assert.equal(parseRate('3.25%', 'gross'), 0.026);
  assert.equal(parseRate('0.10', 'gross'), 0.08);

  // A net figure is stored as given.
  assert.equal(parseRate('8%', 'net'), 0.08);
  assert.equal(parseRate('0.026', 'net'), 0.026);
});

test('parseRate refuses what it cannot read unambiguously', () => {
  // "10" could be 10% or 1000%, and this number multiplies every future balance.
  assert.equal(parseRate('10', 'net'), null);
  assert.equal(parseRate('3.25', 'net'), null);
  assert.equal(parseRate('lots', 'net'), null);
  assert.equal(parseRate('-5%', 'net'), null);
  // A deposit rate above 50% is a typo, not a promo.
  assert.equal(parseRate('900%', 'net'), null);
  // And zero is a legitimate value: it means "stop tracking this pot".
  assert.equal(parseRate('0', 'net'), 0);
});

test('the learner survives a boost lapsing and coming back', () => {
  // The reason rate_seed exists. Guarding against the LIVE rate is a one-way ratchet:
  // a lapsed Maya boost drops 0.08 -> 0.024, and then 0.08 returning exceeds 2 x 0.024
  // and is rejected as a mis-typed credit, forever.
  const SEED = 0.08;
  const lapsed = accrue(9_800_000, '2026-09-01', '2026-10-01', new Map(), { ...MAYA, rate: 0.024 });
  const down = learnRate(lapsed.interest, lapsed.centavoDays, SEED, 2);
  assert.ok(down.accepted && Math.abs(down.implied - 0.024) < 0.001);

  const restored = accrue(9_800_000, '2026-10-01', '2026-11-01', new Map(), MAYA);
  const up = learnRate(restored.interest, restored.centavoDays, SEED, 3);
  assert.ok(up.accepted, `boost returning must be accepted: ${up.reason}`);
  assert.ok(Math.abs(up.implied - 0.08) < 0.001);

  // Against the lapsed live rate instead, the same credit is wrongly rejected.
  assert.equal(learnRate(restored.interest, restored.centavoDays, 0.024, 3).accepted, false);
});

test('an expense on the snapshot day is a real flow, not a reclassification', () => {
  // You read the banking app once and then keep spending, so a same-day expense almost
  // always happened AFTER the reading. Netting it to zero would freeze your balance for
  // the whole day you snapshotted — and it books to the next day because the window is
  // (anchor, next] exclusive, so a row dated on the anchor day falls outside every window.
  const sameDay = bookingDate('2026-09-03', '2026-09-03');
  assert.equal(sameDay.lateFor, null, 'same day must NOT be treated as already-anchored');
  assert.equal(sameDay.date, '2026-09-04');

  // Strictly before the anchor is the genuine reclassification case.
  const before = bookingDate('2026-09-02', '2026-09-03');
  assert.equal(before.lateFor, '2026-09-02');
  assert.equal(before.date, '2026-09-04');

  // After the anchor is untouched.
  const after = bookingDate('2026-09-05', '2026-09-03');
  assert.equal(after.lateFor, null);
  assert.equal(after.date, '2026-09-05');
});

test('a forward-booked same-day expense shows in the balance immediately', () => {
  // The consequence of the same-day rule: the row is dated anchor+1. If the balance window
  // stopped at today, you would see the expense in /recap but not in /balance — which reads
  // as the bot having lost your entry, on the very day you set it up.
  const anchor = { as_of_date: '2026-09-03', balance_centavos: 1_300_000 };
  const booked = bookingDate('2026-09-03', anchor.as_of_date);
  const row = ev({ amount_centavos: -25_000, occurred_at: booked.date, category: 'food' });

  const b = balanceOf(MARIBANK, anchor, [row], '2026-09-03');
  assert.equal(b.confirmed, 1_300_000 - 25_000, 'the expense must count the moment it is logged');

  // And a row dated ON the anchor is still excluded — the anchor already contains it.
  const sameDayRow = ev({ amount_centavos: -9_900, occurred_at: '2026-09-03' });
  assert.equal(balanceOf(MARIBANK, anchor, [sameDayRow], '2026-09-03').confirmed, 1_300_000);
});

// -- reminder days -----------------------------------------------------------

test('a day-of-month reminder clamps instead of silently never firing', () => {
  // The 31st exists in seven months of twelve. Left unclamped, a reminder set for it is
  // skipped in February, April, June, September and November - and month-end is precisely
  // the deadline people set reminders for, so the failure lands on the one that mattered.
  assert.equal(reminderDue('31', '2026-01-31'), true);
  assert.equal(reminderDue('31', '2026-02-28'), true, 'February gets it on the 28th');
  assert.equal(reminderDue('31', '2026-02-27'), false);
  assert.equal(reminderDue('31', '2024-02-29'), true, 'and on the 29th in a leap year');
  assert.equal(reminderDue('31', '2026-04-30'), true);
  assert.equal(reminderDue('31', '2026-05-30'), false, 'a 31-day month fires on the 31st only');
});

test('som and eom mean the ends of the month, whatever length it is', () => {
  assert.equal(reminderDue('som', '2026-09-01'), true);
  assert.equal(reminderDue('som', '2026-09-02'), false);
  assert.equal(reminderDue('eom', '2026-09-30'), true);
  assert.equal(reminderDue('eom', '2026-09-29'), false);
  assert.equal(reminderDue('eom', '2026-02-28'), true);
  // The Maya boost case: the last day is the last chance to have qualified.
  assert.equal(reminderDue('eom', '2026-12-31'), true);
});

test('a weekday reminder is a Manila weekday, and crosses months', () => {
  // 2026-10-01 is a Thursday; 2026-09-30 a Wednesday. Pure calendar, no host timezone.
  assert.equal(reminderDue('thu', '2026-10-01'), true);
  assert.equal(reminderDue('wed', '2026-09-30'), true);
  assert.equal(reminderDue('thu', '2026-09-30'), false);
  assert.equal(reminderDue('sun', '2026-10-04'), true);
});

test('a day that cannot be read is never due, rather than due every day', () => {
  for (const junk of ['', 'someday', '0', '32', '-1', '2.5']) {
    assert.equal(reminderDue(junk, '2026-09-01'), false, junk);
  }
});

test('a week starts on Monday, and crossing a month does not restart it', () => {
  // 2026-09-03 is a Thursday, so its week opened on Monday 2026-08-31 — in the previous
  // month. A week that clamped to the 1st would silently drop the days you spent on.
  assert.equal(startOfWeek('2026-09-03'), '2026-08-31');
  assert.equal(startOfWeek('2026-08-31'), '2026-08-31', 'Monday is its own start');
  assert.equal(startOfWeek('2026-09-06'), '2026-08-31', 'Sunday belongs to the week that opened');
  assert.equal(startOfWeek('2026-09-07'), '2026-09-07', 'and the next Monday opens a new one');
  assert.equal(startOfWeek('2026-01-01'), '2025-12-29', 'across a year boundary too');
});

test('a row reports on the day it was typed only when an anchor pushed it forward', () => {
  // occurred_at answers "when did the money move", which the snapshot windows need. It is
  // the wrong answer to "what did I spend today" the moment bookingDate pushes a same-day
  // expense to anchor+1. Nothing else can date a row after the day it was typed, because
  // resolveDate refuses a future hint - so that gap IS the signal, and needs no column.
  const at = (logged: string, occurred: string) => reportDate({ logged_at: logged, occurred_at: occurred });

  // Manila is UTC+8: 10:00Z on the 3rd is 18:00 on the 3rd.
  assert.equal(at('2026-09-03T10:00:00Z', '2026-09-04'), '2026-09-03', 'booked forward');
  assert.equal(at('2026-09-03T10:00:00Z', '2026-09-03'), '2026-09-03', 'an ordinary row keeps its date');
  assert.equal(at('2026-09-03T10:00:00Z', '2026-08-28'), '2026-08-28', 'a backdated row keeps its own');

  // The daily 8-hour window the whole design keys on: 16:30Z is already tomorrow in Manila.
  assert.equal(at('2026-09-03T16:30:00Z', '2026-09-04'), '2026-09-04', 'typed after Manila midnight');
  assert.equal(at('2026-09-03T15:00:00Z', '2026-09-04'), '2026-09-03', 'typed at 23:00 Manila');
});

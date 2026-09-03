/**
 * Reading the ledger back: balances, the monthly recap, the CSV escape hatch, and rates.
 *
 * Nothing here writes a money row except /interest, which is here rather than in entries.ts
 * because reporting a real credit is what TEACHES the rate — the write is a side effect of
 * the reading, and splitting them would put the learner two files from the number it learns.
 */

import { Db, type Account, type Write } from './db.ts';
import { resolveDate } from './extract.ts';
import {
  WEEKDAYS,
  accrue,
  addDays,
  balanceOf,
  type Balance,
  bookingDate,
  brokenTransfers,
  dayDiff,
  effective,
  flowsByDate,
  foldFrom,
  lastDayOfMonth,
  lateEntryPair,
  learnRate,
  monthOf,
  parseAmount,
  parseRate,
  peso,
  reportDate,
  spendByCategory,
  startOfWeek,
  sum,
  unsettled,
  weekdayOf,
  yours,
  type Event,
} from './ledger.ts';
import { acct, noAccount, nowIso, type Reply } from './reply.ts';
import { mono } from './telegram.ts';

/**
 * One account's balance, computed the single way /balance computes it.
 *
 * The balance table and every reply that reports what is left used to run this
 * anchor-then-fold dance separately and happened to agree. One helper means they cannot
 * quietly stop agreeing.
 */
export async function balanceFor(db: Db, account: Account, today: string): Promise<Balance> {
  const anchor = await db.latestSnapshot(account.id);
  const rows = await db.eventsSince(account.id, anchor?.as_of_date ?? '0000-00-00');
  return balanceOf(account, anchor, rows, today);
}

/**
 * The ledger facts a rendered report leaves out, for answer() to explain from.
 *
 * A balance table says what the number IS. Almost every question about it is really about
 * how it got there: whether a credit is already inside it, why an account still says (est),
 * what moved since you last read the app. None of that is in the table, and a model asked to
 * explain it without these lines will make something up that sounds right.
 *
 * Deliberately the raw shape rather than prose: dates, signed amounts, types. Sentences are
 * what the model is for, and pre-writing them here would be a second copy of the explanation
 * to keep in sync with the first.
 *
 * ponytail: every anchored account, rows capped per account. Seven accounts is ~500 tokens,
 * against an 8,000/minute ceiling this call SHARES with the extract() call for the next
 * message. Scope it to the accounts the question names if that ever stops being comfortable.
 */
const FACT_ROWS = 5;

export async function queryFacts(db: Db, accounts: Account[], today: string): Promise<string> {
  // The balance table goes in whatever report was rendered, because query_kind picks the
  // report and it picks it from the wording. "did my interest reach my balance?" reads as an
  // interest question and lands on the interest recap, which does not contain a balance — so
  // without this the model is asked about a number it was never shown, and answers about the
  // one in front of it instead. Costs a few hundred tokens; buys an answer to the question
  // that was actually asked whichever report the classifier chose.
  const out: string[] = ['where every account stands right now:', await balances(db, accounts, today), ''];
  for (const a of accounts) {
    const anchor = await db.latestSnapshot(a.id);
    if (!anchor) {
      out.push(`${a.id} (${a.name}): never anchored, so it has no balance, only a running total.`);
      continue;
    }
    const rows = effective(await db.eventsSince(a.id, anchor.as_of_date)).filter(
      (r) => r.account_id === a.id && dayDiff(anchor.as_of_date, r.occurred_at) > 0,
    );
    const rate =
      a.rate > 0
        ? ` rate ${(a.rate * 100).toFixed(2)}% net${a.rate_source === 'seeded_net' ? ', still the seeded estimate (est), never yet learned from a real credit' : ', learned from real credits'}.`
        : ' earns no interest.';
    out.push(
      `${a.id} (${a.name}): anchored ${peso(anchor.balance_centavos)} on ${anchor.as_of_date}, ${dayDiff(anchor.as_of_date, today)}d ago.${rate}`,
    );
    // Only what is NOT in the anchor. Rows dated on or before it are inside that reading
    // already, and listing them is how you get told the same peso twice.
    for (const r of rows.slice(-FACT_ROWS)) {
      const bits = [r.occurred_at, r.type, peso(r.amount_centavos), r.merchant, r.category, r.note];
      out.push(`  since the anchor: ${bits.filter(Boolean).join(' · ')}`);
    }
    if (!rows.length) out.push('  since the anchor: nothing logged.');
  }
  return out.join('\n');
}

/**
 * What is left in an account, as one line: the closing statement on every reply that moved
 * money. The question you have after spending is "how much is left", and answering it in
 * the same breath is a round trip to /balance you no longer make.
 *
 * `confirmed` and not `expected`, because "left" is a question about what your banking app
 * shows, and today's uncredited interest slice would make the two disagree by centavos for
 * no gain.
 *
 * An UN-ANCHORED account has no balance to report, only a running total counted from an
 * unknown starting point. Printing a figure there would invent one, so it asks for the
 * anchor instead: the refusal balanceOf() already makes, said out loud.
 */
export async function remaining(db: Db, account: Account, today: string): Promise<string> {
  const b = await balanceFor(db, account, today);
  return b.anchorDate
    ? `${peso(b.confirmed)} left in ${account.name}`
    : `${account.name} not anchored, /snap ${account.id} <amount>`;
}

/**
 * What is left in every account a set of rows touched, as one line.
 *
 * The closing line for a void or an undo, both of which can reach two accounts at once: a
 * transfer's two legs share an inbox_id, so voiding one voids both, and reporting one side
 * would answer half the question.
 */
export async function remainingFor(
  db: Db,
  accounts: Account[],
  rows: Event[],
  today: string,
): Promise<string> {
  const out: string[] = [];
  for (const id of new Set(rows.map((r) => r.account_id))) {
    const account = acct(accounts, id);
    if (account) out.push(await remaining(db, account, today));
  }
  return out.join(', ');
}

export async function balances(db: Db, accounts: Account[], today: string): Promise<string> {
  const out: string[] = [];
  let anyEstimated = false;

  for (const book of ['personal', 'business']) {
    const inBook = accounts.filter((a) => a.book === book);
    if (!inBook.length) continue;
    let confirmed = 0;
    let accrued = 0;
    const lines: string[] = [];

    const unanchored: string[] = [];

    for (const a of inBook) {
      const b = await balanceFor(db, a, today);

      if (!b.anchorDate) {
        // Never folded into the total. An unknown baseline plus a known outflow is not a
        // balance — reporting it as one says "you have -₱250", when what is actually known
        // is "₱250 left, from a starting point nobody has told me". Letting it in would make
        // the book's net worth quietly wrong instead of visibly incomplete.
        unanchored.push(a.id);
        const flow = b.confirmed === 0 ? 'nothing logged yet' : `${peso(Math.abs(b.confirmed))} logged`;
        lines.push(`  ${a.name.padEnd(13)} ${'not anchored'.padStart(12)}   ${flow}`);
        continue;
      }

      confirmed += b.confirmed;
      accrued += b.accrued;
      if (b.estimated) anyEstimated = true;
      const age = b.anchorAgeDays === 0 ? 'today' : `${b.anchorAgeDays}d`;
      lines.push(
        `  ${a.name.padEnd(13)} ${peso(b.confirmed).padStart(12)}   ${age}${b.estimated ? ' (est)' : ''}`,
      );
    }

    // The table goes in a monospace block so the columns land; the hint below it does not,
    // because a /command inside a code block stops being tappable.
    out.push(
      mono(
        [book, ...lines, `  ${'expected'.padEnd(13)} ${peso(confirmed + accrued).padStart(12)}`].join('\n'),
      ),
    );
    if (unanchored.length) {
      // Say what the total is missing, in the same breath as the total.
      out.push(
        `  excludes ${unanchored.length} un-anchored: ${unanchored.join(', ')}. /snap ${unanchored[0]} <amount>`,
      );
    }
  }

  const all = await db.allEvents();
  const broken = brokenTransfers(all);
  const owed = unsettled(all);
  const warn: string[] = [];
  if (broken.length) warn.push(`${broken.length} broken transfer${broken.length > 1 ? 's' : ''}`);
  if (owed > 0) warn.push(`owed to you: ${peso(owed)}`);
  if (warn.length) out.push('', warn.join(' · '));
  // Admitting which numbers are soft is what makes the hard one mean something.
  if (anyEstimated) out.push('(est) = rate not yet learned from a real credit');
  return out.join('\n');
}

/**
 * What a recap shows is decided by HOW LONG the window is, not by a flag.
 *
 * A day is a handful of rows, so the rows ARE the recap — category totals over four items
 * is a summary of something you can already see. A month is hundreds, so categories are the
 * only readable shape. A week sits in between and gets the rows grouped by day, which is
 * what answers "which day did I overspend" without a second command. `list` overrides it.
 */
interface Window {
  from: string;
  to: string;
  label: string;
  items: boolean;
  byDay: boolean;
}

/** A cap, not a page: past this the rows stop being readable and /csv is the right tool. */
const MAX_ITEMS = 40;

const DAY_NAME = (d: string) => {
  const w = WEEKDAYS[weekdayOf(d)];
  return `${w[0].toUpperCase()}${w.slice(1)}`;
};

/** Returns a window, or the sentence to say instead. */
function recapWindow(arg: string, today: string): Window | string {
  // "this" is dropped so "this week" and "week" are the same thing — the spoken path sends
  // whichever the model heard, and re-asking over a filler word is how a bot feels like a form.
  const parts = arg
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && w !== 'this');
  const force = parts.includes('list') || parts.includes('all');
  const word = parts.find((w) => w !== 'list' && w !== 'all');
  const day = (d: string): Window => ({
    from: d,
    to: d,
    label: `${DAY_NAME(d)} ${d}`,
    items: true,
    byDay: false,
  });

  if (!word || word === 'today') return day(today);
  if (word === 'yesterday') return day(addDays(today, -1));
  if (word === 'week') {
    // Monday to TODAY, not Monday to Sunday: days that have not happened are not a recap.
    const from = startOfWeek(today);
    return { from, to: today, label: `week of ${from}`, items: true, byDay: true };
  }
  if (word === 'month' || /^\d{4}-\d{2}$/.test(word)) {
    const m = word === 'month' ? monthOf(today) : word;
    return { from: `${m}-01`, to: `${m}-${lastDayOfMonth(`${m}-01`)}`, label: m, items: force, byDay: false };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(word)) return day(word);
  return `Couldn't read "${word}". Try /recap, /recap week, /recap month, or /recap 2026-08.`;
}

/**
 * The recap. Defaults to TODAY, because the question you ask most is what today cost you —
 * a month is a thing you review, a day is a thing you check.
 *
 * Reads through `effective()` throughout, so a voided row is not shown and a corrected one
 * is shown ONCE at its corrected amount. Nothing here is a raw SELECT of what was typed.
 */
export async function recap(db: Db, arg: string, today: string): Promise<string> {
  const w = recapWindow(arg, today);
  if (typeof w === 'string') return w;

  // Fetched two days wide, then windowed on the REPORTING date — see ledger.reportDate. A
  // row can only be booked one day past the day it was typed (bookingDate returns
  // anchor+1, and an anchor is never in the future), so two days is margin, not guesswork.
  const rows = (await db.eventsBetween(w.from, addDays(w.to, 2))).filter((r) => {
    const d = reportDate(r);
    return dayDiff(w.from, d) >= 0 && dayDiff(d, w.to) >= 0;
  });
  const personal = rows.filter((r) => r.book === 'personal');
  const live = effective(personal);
  // Carrying `day` on the row keeps the grouping, the sort and the window on ONE date.
  const expenses = live
    .filter((r) => r.type === 'expense')
    .map((r) => ({ ...r, day: reportDate(r) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id);

  const cats = [...spendByCategory(personal)].sort((a, b) => b[1] - a[1]);
  const spend = cats.reduce((t, [, v]) => t + v, 0);
  const income = sum(live.filter((r) => r.type === 'income'));
  const earned = sum(live.filter((r) => r.type === 'interest' || r.type === 'cashback'));
  const contributed = sum(
    effective(rows).filter((r) => r.type === 'transfer' && r.book === 'business' && r.amount_centavos > 0),
  );

  const out = [`${w.label} · personal`];
  // 18, not 15: "pup icog document" truncated to "pup icog docume", which reads as broken
  // rather than as abbreviated. The block is still narrower than the balance table.
  const row = (label: string, amount: number, tail = '') =>
    `  ${label.slice(0, 18).padEnd(18)} ${peso(amount).padStart(11)}${tail}`;

  if (w.items && expenses.length) {
    const shown = expenses.slice(0, MAX_ITEMS);
    let day = '';
    for (const r of shown) {
      if (w.byDay && r.day !== day) {
        day = r.day;
        const total = expenses.filter((x) => x.day === day).reduce((t, x) => t + yours(x), 0);
        // Padded to 23 so the day's subtotal lands in the same column as its items: an
        // indented item is 2 + row()'s own 2 + 18 + 1, and the amount is the last 11.
        out.push(`  ${`${DAY_NAME(day)} ${day}`.padEnd(21)}${peso(total).padStart(11)}`);
      }
      const name = r.merchant ?? r.note ?? r.category ?? 'expense';
      // The shared portion is already out of the figure; saying so is why the number differs
      // from the receipt in your pocket.
      const tail = r.shared_amount_centavos ? `  (${peso(r.shared_amount_centavos)} not yours)` : '';
      out.push(`${w.byDay ? '  ' : ''}${row(name, yours(r), tail)}`);
    }
    if (expenses.length > shown.length) out.push(`  +${expenses.length - shown.length} more · /csv`);
    out.push('');
  } else if (!w.items && cats.length) {
    for (const [c, v] of cats) out.push(row(c, v));
    out.push('');
  }

  if (!expenses.length) out.push('  nothing logged');
  out.push(row('spent', spend), row('income', income), row('net', income - spend));
  if (earned) out.push(row('interest', earned));
  if (contributed) {
    // Separately these two mislead. Together they are the number that decides solvency.
    out.push(
      '',
      `contributed ${peso(contributed)} to the business, buffer moving ${peso(income - spend - contributed)}`,
    );
  }
  const owed = unsettled(rows);
  if (owed > 0) out.push('', `owed to you: ${peso(owed)}`);

  // No "you anchored today, so it books to tomorrow" caveat any more: reportDate is what
  // that note used to apologise for, and an empty day is now simply an empty day.
  return mono(out.join('\n'));
}

/** The laziest possible answer to every future "can it show me X?". */
export async function csv(db: Db): Promise<string> {
  const rows = await db.allEvents();
  const head =
    'id,occurred_at,type,book,account,amount,category,merchant,note,shared,transfer_id,corrects_id,voided';
  const esc = (v: unknown) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const body = rows.map((r) =>
    [
      r.id,
      r.occurred_at,
      r.type,
      r.book,
      r.account_id,
      (r.amount_centavos / 100).toFixed(2),
      r.category,
      r.merchant,
      r.note,
      r.shared_amount_centavos,
      r.transfer_id,
      r.corrects_id,
      r.voided_at,
    ]
      .map(esc)
      .join(','),
  );
  return [head, ...body].join('\n');
}

// ── rates: readable and settable from chat, and learned from real credits ────

/**
 * `/rate` to see them, `/rate maya 10% gross` to set one.
 *
 * Deterministic, no LLM — same reasoning as `/snap`. A rate multiplies every future
 * projection for that pot, so it does not go through a probabilistic parser.
 */
export async function rates(db: Db, accounts: Account[], arg: string): Promise<Reply> {
  const parts = arg.trim().split(/\s+/).filter(Boolean);

  if (!parts.length) {
    const lines = accounts.map((a) => {
      if (a.rate === 0) return `  ${a.id.padEnd(9)} untracked`;
      const src = a.rate_source === 'seeded_net' ? 'estimated' : a.rate_source;
      const cap = a.rate_cap_centavos ? `, boosted up to ${peso(a.rate_cap_centavos)}` : '';
      const floor = a.rate_floor !== a.rate ? `, floor ${(a.rate_floor * 100).toFixed(2)}%` : '';
      return `  ${a.id.padEnd(9)} ${(a.rate * 100).toFixed(2)}% net (${src}${floor}${cap})`;
    });
    return {
      text: [
        'Rates are stored NET: what actually lands in the account.',
        mono(lines.join('\n')),
        'Set one:  /rate maya 10% gross   (or "8% net")',
        'Report a real credit and it learns instead:  /interest maya 21.48',
      ].join('\n'),
    };
  }

  const [id, value, basis] = parts;
  const account = acct(accounts, id?.toLowerCase() ?? null);
  if (!account) return { text: noAccount(id, accounts) };
  if (!value)
    return {
      text: `${account.name} is at ${(account.rate * 100).toFixed(2)}% net. Set it: /rate ${account.id} 10% gross`,
    };

  if (basis !== 'gross' && basis !== 'net') {
    // Refused, not guessed. Both banks advertise gross and credit net, so a missing basis
    // word is a 25% error waiting to happen on every projection this pot ever makes.
    return {
      text: [
        `Say gross or net: the banks advertise one and pay the other.`,
        `  /rate ${account.id} ${value} gross   ← the number on their website`,
        `  /rate ${account.id} ${value} net     ← what actually lands`,
      ].join('\n'),
    };
  }

  const rate = parseRate(value, basis);
  if (rate == null)
    return { text: `Couldn't read "${value}" as a rate. Use a percentage ("10%") or a decimal ("0.10").` };

  await db.batch([db.setRate(account.id, rate, 'manual')]);
  const gross = basis === 'gross' ? ` (${value} gross, less the 20% withholding)` : '';
  return { text: `${account.name} → ${(rate * 100).toFixed(2)}% net${gross}` };
}

/**
 * Teach the rate from a credit that is already known to be real.
 *
 * Shared by REPORTING a credit and by CORRECTING one, because a corrected amount has to
 * re-teach the rate over the same period — otherwise the row ends up right while the rate
 * keeps the wrong lesson until some later report happens to overwrite it.
 *
 * The period is (last credit before `date`, date]. Reporting daily therefore learns from
 * ONE day's balance, which is the whole point: the previous behaviour divided a single day's
 * credit by every centavo-day since the anchor, so a ten-day-old anchor taught a rate a
 * tenth of the truth — inside the 2x-seed guard, so it was accepted and written.
 *
 * The opening balance comes from the snapshot BEFORE `date`, never one dated on it: a
 * period cannot start and end on the same day, so an anchor dated on the credit leaves a
 * zero-day window with nothing to divide by. That is a reason to LEARN nothing, and it is
 * not a reason to drop the credit: whether the anchor already contains it depends on the
 * clock time it was read at, which no date column records. The row books via bookingDate
 * either way and the balance keeps it.
 */
export async function learnFromCredit(
  db: Db,
  account: Account,
  credited: number,
  date: string,
): Promise<{ lines: string[]; writes: Write[] }> {
  const anchor = await db.previousSnapshot(account.id, date);
  if (!anchor) {
    const latest = await db.latestSnapshot(account.id);
    return {
      writes: [],
      lines: [
        latest
          ? `nothing to learn yet: ${latest.as_of_date} is the only anchor, so there is no earlier reading to measure the period from. The next credit after your next /snap teaches the rate.`
          : `anchor a balance first: /snap ${account.id} <amount>, then the next credit teaches the rate`,
      ],
    };
  }

  const rows = await db.eventsSince(account.id, anchor.as_of_date);
  // Credits dated ON `date` must not close the period: the one being reported is dated
  // there too, and a period cannot start and end on the same day.
  const fold = foldFrom(anchor, rows, account.id, addDays(date, -1));
  // The learner's denominator is the accrual's OWN centavo-days. Two implementations of
  // centavo-days would fit the formula error as rate signal — which is the bug that
  // destroys a good seed permanently and leaves nothing to explain the gap.
  const a = accrue(fold.opening, fold.start, date, flowsByDate(fold.after), account);

  const seen = (await db.observationCount(account.id))?.n ?? 0;
  const learned = learnRate(credited, a.centavoDays, account.rate_seed || account.rate, seen + 1);

  const writes: Write[] = [
    db.recordObservation({
      account_id: account.id,
      period_start: fold.start,
      period_end: date,
      credited_centavos: credited,
      centavo_days: a.centavoDays,
      implied_rate: learned.implied,
      accepted: learned.accepted,
      reason: learned.reason,
      logged_at: nowIso(),
    }),
  ];
  if (learned.accepted) writes.push(db.setRate(account.id, learned.rate, 'observed'));

  const lines = [`${a.days}d since ${fold.start}`];
  if (learned.accepted) {
    lines.push(
      `rate learned: ${(learned.rate * 100).toFixed(2)}% net (was ${(account.rate * 100).toFixed(2)}%)`,
    );
    // A big drop has exactly two readings and NOTHING in the data separates them, so both
    // are said. No lower guard: a lapsed Maya boost really does drop 8% to the 2.4% floor,
    // and rejecting that would freeze the rate at a number the bank stopped paying.
    if (learned.rate < account.rate * 0.5)
      lines.push(
        a.days > 1
          ? `big drop: either the boost lapsed (check your qualifying spend) or that credit covers less than the ${a.days} days since ${fold.start}. If it was one day's worth, /undo and report each day.`
          : 'that looks like a lapsed boost, not an error. Check your qualifying spend',
      );
  } else {
    // Keeping the good seed and saying why beats writing an authoritative wrong number
    // that nothing will ever pull back.
    lines.push(`kept ${(account.rate * 100).toFixed(2)}%: ${learned.reason}`);
    if (learned.implied > 0) lines.push(`(this credit implies ${(learned.implied * 100).toFixed(2)}%)`);
  }
  return { lines, writes };
}

/** A year of daily credits is 365 lines and Telegram stops at 4096 characters. */
const CREDIT_LINES = 12;

/**
 * Every credit you have reported, per account, with subtotals and a total.
 *
 * Bare `/interest` used to print a usage hint and nothing else, which is the one thing you
 * already knew. Reads through `effective()`, so a corrected credit is counted once at its
 * corrected amount and a voided one is not counted at all.
 */
async function interestList(db: Db): Promise<string> {
  const rows = effective(await db.allEvents()).filter((r) => r.type === 'interest');
  if (!rows.length)
    return ['No interest reported yet.', 'Report one you saw in the app:  /interest maya 21.48'].join('\n');

  const byAccount = new Map<string, Event[]>();
  for (const r of rows) {
    const g = byAccount.get(r.account_id);
    if (g) g.push(r);
    else byAccount.set(r.account_id, [r]);
  }

  const out: string[] = [];
  let total = 0;
  for (const [id, credits] of byAccount) {
    credits.sort((x, y) => dayDiff(y.occurred_at, x.occurred_at));
    const subtotal = sum(credits);
    total += subtotal;
    out.push(id);
    const shown = credits.slice(-CREDIT_LINES);
    for (const c of shown) out.push(`  ${c.occurred_at}  ${peso(c.amount_centavos).padStart(11)}`);
    if (credits.length > shown.length) out.push(`  +${credits.length - shown.length} earlier · /csv`);
    out.push(`  ${'subtotal'.padEnd(12)}${peso(subtotal).padStart(11)}`, '');
  }
  out.push(`${'total'.padEnd(14)}${peso(total).padStart(11)}`);
  return [mono(out.join('\n')), 'Report a credit:  /interest maya 21.48 [yesterday]'].join('\n');
}

/**
 * `/interest` lists what you have earned. `/interest maya 21.48 [yesterday]` reports a
 * credit you actually saw, and the rate learns from it.
 *
 * This is the path that makes the seed stop mattering. Both tracked pots credit DAILY, so
 * you can report a real credit on day two and the seed is replaced permanently — including
 * when Maya changes the rate on you in March.
 *
 * Deterministic for the same reason as /snap and /rate: it feeds the number that scales
 * every future projection. The date is optional and accepts "yesterday" or an ISO date, so
 * catching up on three days is three messages rather than three lies about when they landed.
 */
export async function interest(db: Db, accounts: Account[], arg: string, today: string): Promise<Reply> {
  const trimmed = arg.trim();
  if (!trimmed) return { text: await interestList(db) };

  // The date group is greedy so an unreadable hint ("last monday") reaches resolveDate and
  // is REFUSED by name, instead of failing the match and printing a usage line that does
  // not mention the thing that was wrong.
  const m = trimmed.match(/^([a-z]+)\s+([\d,.]+)(?:\s+(.+))?$/i);
  if (!m) {
    const earning = accounts.filter((a) => a.rate > 0).map((a) => a.id);
    return {
      text: `Report a credit you saw in the app: /interest ${earning[0] ?? 'maya'} 21.48 [yesterday]\n\nEarning pots: ${earning.join(' / ') || 'none'}`,
    };
  }

  const account = acct(accounts, m[1].toLowerCase());
  if (!account) return { text: noAccount(m[1], accounts) };
  const credited = parseAmount(m[2]);
  if (credited == null || credited <= 0) return { text: `Couldn't read "${m[2]}" as an amount.` };
  const date = resolveDate(m[3] ?? null, today, addDays);
  if (date == null)
    return { text: `Couldn't read "${m[3]}" as a date. Use 2026-09-02, "yesterday" or "3 days ago".` };
  if (dayDiff(date, today) < 0) return { text: `${date} has not happened yet.` };

  // The SAME booking rule every other money row goes through, and for the same reason: the
  // reconciliation window is (anchor, next], so a row dated ON the anchor day falls outside
  // every window and is silently invisible. This path used to write `occurred_at` raw, which
  // is how two real Maya credits reported on the anchor date vanished from the balance while
  // sitting in `events` looking fine. bookingDate is the one place that rule lives.
  //
  // The LEARNER still gets the true date below: where a credit books is a reconciliation
  // question, when it was earned is a rate question, and they are not the same date.
  const anchor = await db.latestSnapshot(account.id);
  const { date: booked, lateFor } = bookingDate(date, anchor?.as_of_date ?? null);

  const base = {
    type: 'interest',
    book: account.book,
    account_id: account.id,
    amount_centavos: credited,
    occurred_at: booked,
    logged_at: nowIso(),
    note: 'reported credit',
  };
  // Strictly before the anchor the money IS already in the anchor, so it books as a pair
  // that nets to zero: interest-earned gains the credit, the balance does not move twice.
  const rows = lateFor ? lateEntryPair(base, lateFor) : [base];

  // Learn BEFORE the row exists: it must not sit inside its own denominator.
  const learned = await learnFromCredit(db, account, credited, date);
  await db.batch([...rows.map((r) => db.insertEvent(r as never)), ...learned.writes]);

  const out = [
    `+${peso(credited)} interest · ${account.name}${date === today ? '' : ` · ${date}`}`,
    ...(lateFor ? [`late entry for ${lateFor}, balance unchanged`] : []),
    ...learned.lines,
  ];

  // A /snap on this date already absorbed this credit as positive drift, so reporting it
  // now counts the money twice. Cheap to say here, expensive to discover a month later.
  const drifted = await db.one<{ amount_centavos: number }>(
    `SELECT amount_centavos FROM events WHERE account_id = ? AND occurred_at = ? AND type = 'adjustment'
       AND amount_centavos > 0 AND voided_at IS NULL ORDER BY id DESC LIMIT 1`,
    [account.id, date],
  );
  if (drifted)
    out.push(
      '',
      `heads up: anchoring on ${date} left +${peso(drifted.amount_centavos)} of drift, which may already BE this credit. If so, /undo this one.`,
    );
  // Last line, always: a reported credit moved the balance, so the reply says where it left it.
  out.push(await remaining(db, account, today));
  return { text: out.join('\n') };
}

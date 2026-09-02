/**
 * Reading the ledger back: balances, the monthly recap, the CSV escape hatch, and rates.
 *
 * Nothing here writes a money row except /interest, which is here rather than in entries.ts
 * because reporting a real credit is what TEACHES the rate — the write is a side effect of
 * the reading, and splitting them would put the learner two files from the number it learns.
 */

import { Db, type Account } from './db.ts';
import {
  accrue,
  addDays,
  balanceOf,
  brokenTransfers,
  effective,
  flowsByDate,
  learnRate,
  parseAmount,
  parseRate,
  peso,
  spendByCategory,
  sum,
  unsettled,
  windowFor,
} from './ledger.ts';
import { acct, nowIso, type Reply } from './reply.ts';
import { mono } from './telegram.ts';

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
      const anchor = await db.latestSnapshot(a.id);
      const rows = anchor
        ? await db.eventsSince(a.id, anchor.as_of_date)
        : await db.eventsSince(a.id, '0000-00-00');
      const b = balanceOf(a, anchor, rows, today);

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
        `  excludes ${unanchored.length} un-anchored: ${unanchored.join(', ')} — /snap ${unanchored[0]} <amount>`,
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

export async function recap(db: Db, month: string): Promise<string> {
  const rows = await db.eventsInMonth(month);
  const personal = rows.filter((r) => r.book === 'personal');
  const cats = [...spendByCategory(personal)].sort((a, b) => b[1] - a[1]);
  const spend = cats.reduce((t, [, v]) => t + v, 0);
  const income = sum(effective(personal).filter((r) => r.type === 'income'));
  const earned = sum(effective(personal).filter((r) => r.type === 'interest' || r.type === 'cashback'));
  const contributed = sum(
    effective(rows).filter((r) => r.type === 'transfer' && r.book === 'business' && r.amount_centavos > 0),
  );

  const out = [`${month} · personal`];
  for (const [c, v] of cats) out.push(`  ${c.padEnd(14)} ${peso(v).padStart(11)}`);
  out.push(
    `  ${'spent'.padEnd(14)} ${peso(spend).padStart(11)}`,
    `  ${'income'.padEnd(14)} ${peso(income).padStart(11)}`,
  );
  out.push(`  ${'net'.padEnd(14)} ${peso(income - spend).padStart(11)}`);
  if (earned) out.push(`  ${'interest'.padEnd(14)} ${peso(earned).padStart(11)}`);
  if (contributed) {
    // Separately these two mislead. Together they are the number that decides solvency.
    out.push(
      '',
      `contributed ${peso(contributed)} to the business — buffer moving ${peso(income - spend - contributed)}/mo`,
    );
  }
  const owed = unsettled(rows);
  if (owed > 0) out.push('', `owed to you: ${peso(owed)}`);
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
        'Rates are stored NET — what actually lands in the account.',
        mono(lines.join('\n')),
        'Set one:  /rate maya 10% gross   (or "8% net")',
        'Report a real credit and it learns instead:  /interest maya 21.48',
      ].join('\n'),
    };
  }

  const [id, value, basis] = parts;
  const account = acct(accounts, id?.toLowerCase() ?? null);
  if (!account) return { text: `Unknown account "${id}". One of: ${accounts.map((a) => a.id).join(' / ')}` };
  if (!value)
    return {
      text: `${account.name} is at ${(account.rate * 100).toFixed(2)}% net. Set it: /rate ${account.id} 10% gross`,
    };

  if (basis !== 'gross' && basis !== 'net') {
    // Refused, not guessed. Both banks advertise gross and credit net, so a missing basis
    // word is a 25% error waiting to happen on every projection this pot ever makes.
    return {
      text: [
        `Say gross or net — the banks advertise one and pay the other.`,
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
 * `/interest maya 21.48` — report a credit you actually saw, and let the rate learn itself.
 *
 * This is the path that makes the seed stop mattering. Both tracked pots credit DAILY, so
 * you can report a real credit on day two and the seed is replaced permanently — including
 * when Maya changes the rate on you in March.
 *
 * Deterministic for the same reason as /snap and /rate: it feeds the number that scales
 * every future projection.
 */
export async function interest(db: Db, accounts: Account[], arg: string, today: string): Promise<Reply> {
  const m = arg.trim().match(/^([a-z]+)\s+([\d,.]+)$/i);
  if (!m) {
    const earning = accounts.filter((a) => a.rate > 0).map((a) => a.id);
    return {
      text: `Report a credit you saw in the app: /interest ${earning[0] ?? 'maya'} 21.48\n\nEarning pots: ${earning.join(' / ') || 'none'}`,
    };
  }

  const account = acct(accounts, m[1].toLowerCase());
  if (!account) return { text: `Unknown account "${m[1]}".` };
  const credited = parseAmount(m[2]);
  if (credited == null || credited <= 0) return { text: `Couldn't read "${m[2]}" as an amount.` };

  const anchor = await db.latestSnapshot(account.id);
  const write = db.insertEvent({
    type: 'interest',
    book: account.book,
    account_id: account.id,
    amount_centavos: credited,
    occurred_at: today,
    logged_at: nowIso(),
    note: 'reported credit',
  } as never);

  if (!anchor) {
    await db.batch([write]);
    return {
      text: `+${peso(credited)} interest · ${account.name}\n\nAnchor a balance with /snap to start learning the rate.`,
    };
  }

  // The learner's denominator is the accrual's OWN centavo-days. Two implementations of
  // centavo-days would fit the formula error as rate signal — which is the bug that
  // destroys a good seed permanently and leaves nothing to explain the gap.
  const rows = await db.eventsSince(account.id, anchor.as_of_date);
  const fold = accrue(
    anchor.balance_centavos,
    anchor.as_of_date,
    addDays(today, -1),
    flowsByDate(windowFor(rows, account.id, anchor.as_of_date, today)),
    account,
  );

  const seen = (await db.observationCount(account.id))?.n ?? 0;
  const learned = learnRate(credited, fold.centavoDays, account.rate_seed || account.rate, seen + 1);

  const writes = [
    write,
    db.recordObservation({
      account_id: account.id,
      period_start: anchor.as_of_date,
      period_end: today,
      credited_centavos: credited,
      centavo_days: fold.centavoDays,
      implied_rate: learned.implied,
      accepted: learned.accepted,
      reason: learned.reason,
      logged_at: nowIso(),
    }),
  ];
  if (learned.accepted) writes.push(db.setRate(account.id, learned.rate, 'observed'));
  await db.batch(writes);

  const lines = [`+${peso(credited)} interest · ${account.name} · ${fold.days}d since ${anchor.as_of_date}`];
  if (learned.accepted) {
    lines.push(
      `rate learned: ${(learned.rate * 100).toFixed(2)}% net (was ${(account.rate * 100).toFixed(2)}%)`,
    );
    if (learned.rate < account.rate * 0.5)
      lines.push('that looks like a lapsed boost, not an error — check your qualifying spend');
  } else {
    // Keeping the good seed and saying why beats writing an authoritative wrong number
    // that nothing will ever pull back.
    lines.push(`kept ${(account.rate * 100).toFixed(2)}% — ${learned.reason}`);
    if (learned.implied > 0) lines.push(`(this credit implies ${(learned.implied * 100).toFixed(2)}%)`);
  }
  return { text: lines.join('\n') };
}

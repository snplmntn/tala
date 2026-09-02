/**
 * The impure glue: typed events in, database rows out.
 *
 * Two rules this file exists to enforce:
 *  - Block on MISSING required fields, never on uncertain values. Absence is a
 *    deterministic signal; "I'm 70% sure it said Jollibee" is not, and gating money on a
 *    model's confidence is gating it on a vibe.
 *  - Save optimistically. The row counts the moment it lands and `confirmed_at` is
 *    presentational, so an unanswered prompt can never cost you the record — which is what
 *    the 24h auto-settle was really asking for.
 */

import { Db, type Account } from './db.ts';
import { CATEGORIES, resolveDate, type Extracted } from './extract.ts';
import {
  accrue,
  addDays,
  balanceOf,
  bookingDate,
  brokenTransfers,
  dayDiff,
  drift,
  effective,
  flowsByDate,
  lateEntryPair,
  learnRate,
  parseAmount,
  parseRate,
  peso,
  spendByCategory,
  sum,
  unsettled,
  windowFor,
  type Event,
} from './ledger.ts';
import type { Keyboard } from './telegram.ts';

export interface Reply {
  text: string;
  keyboard?: Keyboard;
}

const acct = (accounts: Account[], id: string | null) => accounts.find((a) => a.id === id) ?? null;
const nowIso = () => new Date().toISOString();

/** Buttons live on every saved row: the fix path is the highest-traffic path in the system. */
const rowKeys = (id: number): Keyboard => [
  [
    { text: '✏️ fix', callback_data: `fix:${id}` },
    { text: '🗑 void', callback_data: `void:${id}` },
    { text: '✓ ok', callback_data: `ok:${id}` },
  ],
];

// ─────────────────────────────────────────────────────────────────────────────

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
      return { text: 'To anchor a balance, type it: /snap maya 98000.00 — one account at a time.' };
    case 'query':
      return { text: 'Ask with /balance, /recap, /owed or /csv.' };
    default:
      return { text: "Didn't catch that. Try: 250 jollibee maribank" };
  }
}

// ── expense / income ────────────────────────────────────────────────────────

async function money(
  db: Db,
  accounts: Account[],
  e: Extracted,
  ctx: { inboxId: number; today: string; messageId?: number | null; hadPhoto: boolean },
): Promise<Reply> {
  const amount = parseAmount(e.amount);
  const account = acct(accounts, e.account);

  // A receipt carries the amount, the merchant and the date, but no receipt on earth says
  // which card paid — so a photo always lands here, and this IS the confirm step.
  if (amount == null && !account) {
    const what = e.merchant ? ` at ${e.merchant}` : '';
    return { text: `Got a purchase${what} — how much, and from which account?` };
  }
  if (amount == null) return { text: `${account!.name} — how much?` };
  if (!account) {
    const names = accounts.map((a) => a.id).join(' / ');
    const what = e.merchant ? `${peso(amount)} at ${e.merchant}` : peso(amount);
    return { text: `${what} — which account? (${names})` };
  }

  const signed = e.intent === 'income' ? Math.abs(amount) : -Math.abs(amount);
  // A refund is a positive-signed expense row, so category totals net with no special case.
  const isRefund = e.intent === 'expense' && /refund|returned|reimburse/i.test(e.note ?? '');
  const finalAmount = isRefund ? Math.abs(amount) : signed;

  const anchor = await db.latestSnapshot(account.id);
  const occurred = resolveDate(e.date_hint, ctx.today, addDays);
  const { date, lateFor } = bookingDate(occurred, anchor?.as_of_date ?? null);

  const base = {
    inbox_id: ctx.inboxId,
    type: e.intent,
    book: account.book,
    account_id: account.id,
    amount_centavos: finalAmount,
    category:
      e.intent === 'expense' ? (CATEGORIES.includes(e.category as never) ? e.category : 'other') : null,
    merchant: e.merchant?.toLowerCase() ?? null,
    note: e.note ?? null,
    recurrence: e.recurrence,
    shared_amount_centavos: parseAmount(e.shared_amount),
    occurred_at: date,
    logged_at: nowIso(),
    telegram_message_id: ctx.hadPhoto ? (ctx.messageId ?? null) : null,
  };

  // A late entry is a reclassification, not a flow: the anchor already contains the money.
  const rows = lateFor ? lateEntryPair(base, lateFor) : [base];
  await db.batch(rows.map((r) => db.insertEvent(r as never)));
  const id = (await db.lastEvent())!.id;

  const bits = [peso(Math.abs(finalAmount)), account.name];
  if (base.merchant) bits.splice(1, 0, base.merchant);
  if (base.category) bits.push(base.category);
  if (base.shared_amount_centavos) bits.push(`${peso(base.shared_amount_centavos)} not yours`);
  if (lateFor) bits.push(`late entry for ${lateFor}, balance unchanged`);
  if (isRefund) bits.push('refund');

  const reply: Reply = {
    text: `${e.intent === 'income' ? '+' : ''}${bits.join(' · ')}`,
    keyboard: rowKeys(id),
  };

  // "sent 2k to maya" can legally parse as an expense — the closed-enum rule fires on a
  // missing account, not a missing counterparty — and a ₱3,000 transfer read as spending
  // overstates a ₱3,000-spend month by 100%.
  if (e.looks_like_transfer && e.intent === 'expense') {
    reply.keyboard = [[{ text: '↔ actually a transfer', callback_data: `tx:${id}` }], ...rowKeys(id)];
  }
  return reply;
}

// ── transfer ────────────────────────────────────────────────────────────────

async function transfer(
  db: Db,
  accounts: Account[],
  e: Extracted,
  ctx: { inboxId: number; today: string },
): Promise<Reply> {
  const amount = parseAmount(e.amount);
  const from = acct(accounts, e.account);
  const to = acct(accounts, e.to_account);
  if (amount == null) return { text: 'How much is the transfer?' };
  if (!from || !to)
    return { text: `Transfer from which account to which? (${accounts.map((a) => a.id).join(' / ')})` };
  if (from.id === to.id) return { text: 'Source and destination are the same account.' };

  const tid = `t${Date.now().toString(36)}`;
  const fee = parseAmount(e.fee);
  const occurred = resolveDate(e.date_hint, ctx.today, addDays);
  const common = { inbox_id: ctx.inboxId, occurred_at: occurred, logged_at: nowIso(), transfer_id: tid };

  const writes = [
    db.insertEvent({
      ...common,
      type: 'transfer',
      book: from.book,
      account_id: from.id,
      amount_centavos: -Math.abs(amount),
      fee_centavos: fee,
    } as never),
    db.insertEvent({
      ...common,
      type: 'transfer',
      book: to.book,
      account_id: to.id,
      amount_centavos: Math.abs(amount),
    } as never),
  ];
  // The fee is a third row in category 'fees' — captured by asking, because you are looking
  // at it on screen while you type. No per-account fee table, no free-transfer counter.
  if (fee) {
    writes.push(
      db.insertEvent({
        ...common,
        type: 'expense',
        book: from.book,
        account_id: from.id,
        amount_centavos: -Math.abs(fee),
        category: 'fees',
        note: 'transfer fee',
      } as never),
    );
  }
  // One batch. Two sequential awaits is how you get half a ₱3,000 transfer.
  await db.batch(writes);

  const crossBook = from.book !== to.book;
  const lines = [`${peso(Math.abs(amount))} · ${from.name} → ${to.name}${fee ? ` (+${peso(fee)} fee)` : ''}`];
  if (crossBook) {
    // Not a net-worth drop: it is you capitalising the company, or drawing from it.
    lines.push(to.book === 'business' ? 'recorded as an owner contribution' : 'recorded as an owner draw');
  }
  if (!fee && (from.id === 'gcash' || from.id === 'maya')) {
    lines.push('any InstaPay fee? reply: fee 10');
  }
  return { text: lines.join('\n') };
}

// ── correction ──────────────────────────────────────────────────────────────

async function correct(
  db: Db,
  accounts: Account[],
  e: Extracted,
  ctx: { inboxId: number; today: string },
): Promise<Reply> {
  const target = await db.matchForCorrection({
    amount: parseAmount(e.match_amount),
    merchant: e.match_merchant,
    account: e.account,
  });
  if (!target)
    return { text: "Couldn't find that row. Name the old amount or the merchant — or /undo the last entry." };

  const newAmount = parseAmount(e.amount);
  if (newAmount == null) return { text: 'Correct it to what amount?' };

  const account = acct(accounts, e.account) ?? acct(accounts, target.account_id)!;
  const signed = target.amount_centavos < 0 ? -Math.abs(newAmount) : Math.abs(newAmount);

  // A FULL SUPERSEDE carrying the complete corrected payload, dated as the ORIGINAL so the
  // expense stays in its own month. Absolute, never a delta: a replayed correction is then
  // a no-op instead of silently turning 285 into 320.
  await db.batch([
    db.insertEvent({
      inbox_id: ctx.inboxId,
      type: target.type,
      book: account.book,
      account_id: account.id,
      amount_centavos: signed,
      category: CATEGORIES.includes(e.category as never) ? e.category : target.category,
      merchant: e.merchant?.toLowerCase() ?? target.merchant,
      note: e.note ?? target.note,
      recurrence: target.recurrence ?? 'one_off',
      shared_amount_centavos: parseAmount(e.shared_amount) ?? target.shared_amount_centavos,
      occurred_at: target.occurred_at,
      logged_at: nowIso(),
      corrects_id: target.corrects_id ?? target.id,
    } as never),
  ]);

  // Echo what was matched. Seeing the wrong row NAMED is the entire disambiguation, and it
  // costs one string — a numbered picker only earns its place if you tap "not that one" twice.
  const label = [
    target.merchant ?? target.note ?? target.type,
    target.occurred_at,
    peso(Math.abs(target.amount_centavos)),
  ]
    .filter(Boolean)
    .join(', ');
  return { text: `${label} → ${peso(Math.abs(signed))}` };
}

// ── snapshot: typed, deterministic, no LLM call at all ──────────────────────

/**
 * `/snap maya 98000.00` — and an image NEVER becomes a snapshot.
 *
 * The anchor is the one number the whole design trusts unconditionally, so it does not go
 * through a probabilistic parser. Accepted one account at a time as a bare message, because
 * a six-app biometric tour in one sitting is what gets skipped in month three.
 */
export async function snapshot(db: Db, accounts: Account[], text: string, today: string): Promise<Reply> {
  const m = text.trim().match(/^\/?(?:snap|snapshot)?\s*([a-z]+)\s+([\d,.]+)$/i);
  if (!m) {
    const pending = await Promise.all(
      accounts.map(async (a) => {
        const s = await db.latestSnapshot(a.id);
        const age = s ? dayDiff(s.as_of_date, today) : null;
        return `${a.id.padEnd(9)} ${s ? `${peso(s.balance_centavos)} (${age}d ago)` : 'never anchored'}`;
      }),
    );
    return { text: `Type one at a time, e.g. "maya 98000".\n\n${pending.join('\n')}` };
  }

  const account = acct(accounts, m[1].toLowerCase());
  if (!account)
    return { text: `Unknown account "${m[1]}". One of: ${accounts.map((a) => a.id).join(' / ')}` };
  const balance = parseAmount(m[2]);
  if (balance == null) return { text: `Couldn't read "${m[2]}" as an amount.` };

  const prev = await db.latestSnapshot(account.id);
  const writes = [
    db.putSnapshot({
      account_id: account.id,
      as_of_date: today,
      balance_centavos: balance,
      logged_at: nowIso(),
    }),
  ];
  const lines = [`${account.name} anchored at ${peso(balance)} as of ${today}`];

  if (prev && prev.as_of_date !== today) {
    const rows = await db.eventsSince(account.id, prev.as_of_date);
    const gap = drift(prev, { as_of_date: today, balance_centavos: balance }, rows, account.id);

    if (gap !== 0) {
      // Untagged, this number is useless: a duplicate row, a ₱10 InstaPay fee, a missing
      // transfer leg, a typo and "I forgot to log things" are mathematically identical.
      writes.push(
        db.insertEvent({
          type: 'adjustment',
          book: account.book,
          account_id: account.id,
          amount_centavos: gap,
          occurred_at: today,
          logged_at: nowIso(),
          note: `drift ${prev.as_of_date} → ${today}`,
        } as never),
      );
      lines.push(`drift ${peso(gap)} over ${dayDiff(prev.as_of_date, today)} days`);
    } else {
      lines.push('drift ₱0.00 — everything logged');
    }
    // Snapshot and adjustment land together, or neither does.
    await db.batch(writes);

    if (gap !== 0) {
      const id = (await db.lastEvent())!.id;
      const label = account.kind === 'cash' ? 'unlogged cash spend' : 'what was it?';
      return {
        text: lines.join('\n'),
        keyboard: [
          [
            { text: 'a fee', callback_data: `adj:fees:${id}` },
            { text: 'spending I forgot', callback_data: `adj:forgot:${id}` },
          ],
          [
            { text: 'interest', callback_data: `adj:interest:${id}` },
            { text: "don't know", callback_data: `adj:unknown:${id}` },
          ],
        ],
      };
    }
    return { text: lines.join('\n') };
  }

  await db.batch(writes);
  if (account.rate > 0) {
    lines.push(`what interest did it credit since the last anchor? reply: /interest ${account.id} 653`);
  }
  return { text: lines.join('\n') };
}

// ── queries ─────────────────────────────────────────────────────────────────

export async function balances(db: Db, accounts: Account[], today: string): Promise<string> {
  const out: string[] = [];
  let anyEstimated = false;

  for (const book of ['personal', 'business']) {
    const inBook = accounts.filter((a) => a.book === book);
    if (!inBook.length) continue;
    let confirmed = 0;
    let accrued = 0;
    const lines: string[] = [];

    for (const a of inBook) {
      const anchor = await db.latestSnapshot(a.id);
      const rows = anchor
        ? await db.eventsSince(a.id, anchor.as_of_date)
        : await db.eventsSince(a.id, '0000-00-00');
      const b = balanceOf(a, anchor, rows, today);
      confirmed += b.confirmed;
      accrued += b.accrued;
      if (b.estimated) anyEstimated = true;

      const age =
        b.anchorAgeDays == null ? 'no anchor' : b.anchorAgeDays === 0 ? 'today' : `${b.anchorAgeDays}d`;
      lines.push(
        `  ${a.name.padEnd(13)} ${peso(b.confirmed).padStart(12)}   ${age}${b.estimated ? ' (est)' : ''}`,
      );
    }
    out.push(`${book}`, ...lines, `  ${'expected'.padEnd(13)} ${peso(confirmed + accrued).padStart(12)}`);
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

export async function recap(db: Db, accounts: Account[], month: string): Promise<string> {
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
  return out.join('\n');
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

// ── callbacks ───────────────────────────────────────────────────────────────

export async function callback(db: Db, data: string, today: string): Promise<string> {
  const [kind, a, b] = data.split(':');
  const now = nowIso();

  if (kind === 'ok') {
    await db.batch([db.confirmEvent(Number(a), now)]);
    return 'ok';
  }

  if (kind === 'void') {
    // Always validate against CURRENT row state: a three-week-old inline keyboard stays
    // live in Telegram forever, so an unvalidated tap silently reverses a settled row.
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(a)]);
    if (!row) return 'gone';
    if (row.voided_at) return 'already voided';
    const anchor = await db.latestSnapshot(row.account_id);
    if (anchor && dayDiff(row.occurred_at, anchor.as_of_date) >= 0)
      return 'that period is already reconciled — correct it instead';
    await db.batch([db.voidEvent(Number(a), now)]);
    return 'voided';
  }

  if (kind === 'adj') {
    const row = await db.one<Event>('SELECT * FROM events WHERE id = ?', [Number(b)]);
    if (!row || row.type !== 'adjustment') return 'gone';
    // The category is why this number is worth anything. Written to the row that already exists.
    await db.run('UPDATE events SET category = ? WHERE id = ? AND category IS NULL', [a, Number(b)]);
    return `tagged as ${a}`;
  }

  if (kind === 'tx') return 'reply: transfer <amount> <from> to <to>, then void the expense';
  if (kind === 'fix') return 'reply with the correction, e.g. "the jollibee was 285 not 250"';
  return 'unknown action';
}

/** The one row class a matcher can never address: a bare "13" with no merchant and no note. */
export async function undo(db: Db): Promise<string> {
  const last = await db.lastEvent();
  if (!last) return 'nothing to undo';
  // Void every row the same message produced, not just the newest. A late entry writes a
  // PAIR that nets to zero, and voiding half of it would move the balance the pair exists
  // to leave alone. Same for a transfer's two legs plus its fee row.
  const siblings = last.inbox_id
    ? await db.all<Event>('SELECT * FROM events WHERE inbox_id = ? AND voided_at IS NULL', [last.inbox_id])
    : [last];
  await db.batch(siblings.map((r) => db.voidEvent(r.id, nowIso())));

  const extra = siblings.length > 1 ? ` (+${siblings.length - 1} paired)` : '';
  return `voided: ${last.type} ${peso(Math.abs(last.amount_centavos))} ${last.account_id} ${last.occurred_at}${extra}`;
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
        ...lines,
        '',
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

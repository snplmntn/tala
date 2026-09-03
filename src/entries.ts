/**
 * Writing money down: an expense, an income, a transfer, a correction, and undoing one.
 *
 * The rule this file exists to enforce is the one from the old handlers.ts header — block on
 * MISSING required fields, never on uncertain values. Absence is deterministic; "I'm 70% sure
 * it said Jollibee" is not, and gating money on a model's confidence is gating it on a vibe.
 * Rows are saved optimistically: `confirmed_at` is presentational, so an unanswered prompt
 * can never cost you the record.
 */

import { randomUUID } from 'node:crypto';

import { Db, type Account } from './db.ts';
import { CATEGORIES, resolveDate, type Extracted } from './extract.ts';
import { addDays, bookingDate, lateEntryPair, parseAmount, peso, type Event } from './ledger.ts';
import { acct, nowIso, rowKeys, type Reply } from './reply.ts';
import { learnFromCredit, remaining, remainingFor } from './reports.ts';

export async function money(
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
    return { text: `Got a purchase${what}. How much, and from which account?` };
  }
  if (amount == null) return { text: `${account!.name}: how much?` };
  if (!account) {
    const names = accounts.map((a) => a.id).join(' / ');
    const what = e.merchant ? `${peso(amount)} at ${e.merchant}` : peso(amount);
    return { text: `${what}: which account? (${names})` };
  }

  const signed = e.intent === 'income' ? Math.abs(amount) : -Math.abs(amount);
  // A refund is a positive-signed expense row, so category totals net with no special case.
  const isRefund = e.intent === 'expense' && /refund|returned|reimburse/i.test(e.note ?? '');
  const finalAmount = isRefund ? Math.abs(amount) : signed;

  const anchor = await db.latestSnapshot(account.id);
  // `?? today` on purpose: a rejected expense is worse than a mis-dated one, and the note
  // keeps whatever the model actually read.
  const occurred = resolveDate(e.date_hint, ctx.today, addDays) ?? ctx.today;
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

export async function transfer(
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

  // Random, not the clock. `Date.now()` collided whenever two transfers landed in the same
  // millisecond, and then brokenTransfers() saw one group with four legs and called BOTH
  // transfers broken. One message carrying two transfers does exactly that.
  const tid = `t${randomUUID().slice(0, 8)}`;
  const fee = parseAmount(e.fee);
  const occurred = resolveDate(e.date_hint, ctx.today, addDays) ?? ctx.today;
  const common = { inbox_id: ctx.inboxId, logged_at: nowIso(), transfer_id: tid };

  // Booked PER LEG, because the two accounts have their own anchors. This used to write both
  // legs on the raw date, which silently lost the whole transfer: the reconciliation window
  // is (anchor, next] and EXCLUSIVE, so a leg dated on its account's anchor day falls outside
  // every window and moves no balance. money() has always routed through bookingDate for
  // exactly this; transfer() never did, and the loss only surfaced as drift a month later.
  const fromBook = bookingDate(occurred, (await db.latestSnapshot(from.id))?.as_of_date ?? null);
  const toBook = bookingDate(occurred, (await db.latestSnapshot(to.id))?.as_of_date ?? null);
  const late = fromBook.lateFor ?? toBook.lateFor;

  const out = {
    ...common,
    occurred_at: fromBook.date,
    type: 'transfer',
    book: from.book,
    account_id: from.id,
    amount_centavos: -Math.abs(amount),
    fee_centavos: fee,
  };
  const into = {
    ...common,
    occurred_at: toBook.date,
    type: 'transfer',
    book: to.book,
    account_id: to.id,
    amount_centavos: Math.abs(amount),
  };
  // A leg dated before its anchor is money the anchor ALREADY contains, so it books as the
  // same net-to-zero pair a late expense does. The offset is an adjustment, and
  // brokenTransfers() counts only rows of type 'transfer', so the group still reads as two
  // legs netting to zero.
  const rows: unknown[] = [
    ...(fromBook.lateFor ? lateEntryPair(out, fromBook.lateFor) : [out]),
    ...(toBook.lateFor ? lateEntryPair(into, toBook.lateFor) : [into]),
  ];
  // The fee is a third row in category 'fees' — captured by asking, because you are looking
  // at it on screen while you type. No per-account fee table, no free-transfer counter.
  if (fee) {
    const feeRow = {
      ...common,
      occurred_at: fromBook.date,
      type: 'expense',
      book: from.book,
      account_id: from.id,
      amount_centavos: -Math.abs(fee),
      category: 'fees',
      note: 'transfer fee',
    };
    rows.push(...(fromBook.lateFor ? lateEntryPair(feeRow, fromBook.lateFor) : [feeRow]));
  }
  // One batch. Two sequential awaits is how you get half a ₱3,000 transfer.
  await db.batch(rows.map((r) => db.insertEvent(r as never)));

  const crossBook = from.book !== to.book;
  const lines = [`${peso(Math.abs(amount))} · ${from.name} → ${to.name}${fee ? ` (+${peso(fee)} fee)` : ''}`];
  if (crossBook) {
    // Not a net-worth drop: it is you capitalising the company, or drawing from it.
    lines.push(to.book === 'business' ? 'recorded as an owner contribution' : 'recorded as an owner draw');
  }
  if (late) lines.push(`late entry for ${late}, balance unchanged`);
  if (!fee && (from.id === 'gcash' || from.id === 'maya')) {
    lines.push('any InstaPay fee? reply: fee 10');
  }
  // Both sides. A transfer is the one write where "what is left" is two questions, and it
  // carries no buttons to hang the answer on, so it goes inline.
  lines.push(`${await remaining(db, from, ctx.today)}, ${await remaining(db, to, ctx.today)}`);
  return { text: lines.join('\n') };
}

// ── correction ──────────────────────────────────────────────────────────────

export async function correct(
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
    return {
      text: "Couldn't find that row. Name the old amount or the merchant, or /undo the last entry.",
    };

  const newAmount = parseAmount(e.amount);
  if (newAmount == null) return { text: 'Correct it to what amount?' };

  const account = acct(accounts, e.account) ?? acct(accounts, target.account_id)!;
  const signed = target.amount_centavos < 0 ? -Math.abs(newAmount) : Math.abs(newAmount);

  // A corrected CREDIT has to re-teach the rate over the same period. Without this the row
  // ends up right while the rate keeps the lesson it learned from the wrong number, until
  // some later report happens to overwrite it — so "fix the interest and the maths follows"
  // would only be half true. Read before the supersede is written, so the corrected row
  // cannot land inside its own denominator; the amount is passed in explicitly.
  const relearn =
    target.type === 'interest' && target.amount_centavos !== signed
      ? await learnFromCredit(db, account, Math.abs(signed), target.occurred_at)
      : null;

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
    ...(relearn?.writes ?? []),
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
  return {
    text: [
      `${label} → ${peso(Math.abs(signed))}`,
      ...(relearn?.lines ?? []),
      await remaining(db, account, ctx.today),
    ].join('\n'),
  };
}

// ── undo ────────────────────────────────────────────────────────────────────

/**
 * Void a row and every row the same message produced.
 *
 * A late entry writes a PAIR that nets to zero, so killing half of it moves the balance the
 * pair exists to leave alone. A transfer is two legs plus a fee row, and half a transfer is
 * what brokenTransfers() exists to detect. /undo has always done this; the 🗑 void button
 * voided a single id and could halve either, so both now take this one path.
 */
export async function voidWithSiblings(db: Db, row: Event): Promise<Event[]> {
  const siblings = row.inbox_id
    ? await db.all<Event>('SELECT * FROM events WHERE inbox_id = ? AND voided_at IS NULL', [row.inbox_id])
    : [row];
  await db.batch(siblings.map((r) => db.voidEvent(r.id, nowIso())));
  return siblings;
}

/** The one row class a matcher can never address: a bare "13" with no merchant and no note. */
export async function undo(db: Db, accounts: Account[], today: string): Promise<string> {
  const last = await db.lastEvent();
  if (!last) return 'nothing to undo';
  const siblings = await voidWithSiblings(db, last);

  const extra = siblings.length > 1 ? ` (+${siblings.length - 1} paired)` : '';
  const line = `voided: ${last.type} ${peso(Math.abs(last.amount_centavos))} ${last.account_id} ${last.occurred_at}${extra}`;
  const left = await remainingFor(db, accounts, siblings, today);
  return left ? `${line}\n${left}` : line;
}

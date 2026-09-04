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
import { addDays, bookingDate, lateEntryPair, manilaHour, parseAmount, peso, type Event } from './ledger.ts';
import { acct, badDate, nowIso, rowKeys, type Reply } from './reply.ts';
import { balanceFor, learnFromCredit, remaining, remainingFor } from './reports.ts';

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
  // Refused by name, not defaulted to today. This used to be `?? today` on the argument that a
  // rejected expense is worse than a mis-dated one — true only while an unreadable hint was
  // rare, and it was not: the schema advertised "sep 1" and "last monday" to the model and the
  // parser knew neither, so every dated catch-up silently landed on the day it was typed. A
  // retype costs you five seconds; a wrong date costs you a month of not knowing.
  const occurred = resolveDate(e.date_hint, ctx.today, addDays, manilaHour(new Date()));
  if (occurred == null) return { text: badDate(e.date_hint) };
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
  let amount = parseAmount(e.amount);
  const from = acct(accounts, e.account);
  const to = acct(accounts, e.to_account);
  // Accounts before the amount, because "all of it" has no figure until the source is known.
  if (!from || !to)
    return { text: `Transfer from which account to which? (${accounts.map((a) => a.id).join(' / ')})` };
  if (from.id === to.id) return { text: 'Source and destination are the same account.' };

  // "move all of my gcash" states no figure, so CODE supplies the one /balance already
  // computes — the model still never sees a balance and never produces one. The derived
  // figure carries whatever drift the account was already holding; emptying it moves that
  // drift to the destination, where the next anchor names it, instead of leaving it hidden
  // in an account the app now shows as zero. An UNANCHORED account has no balance at all,
  // only a running total, so there it asks rather than inventing one.
  const wholeOf = amount == null && e.whole_balance ? await balanceFor(db, from, ctx.today) : null;
  if (wholeOf) {
    if (!wholeOf.anchorDate)
      return {
        text: `${from.name} is not anchored, so I do not know what is in it. /snap ${from.id} <amount>`,
      };
    if (wholeOf.confirmed <= 0)
      return { text: `${from.name} is at ${peso(wholeOf.confirmed)} by my books. How much is the transfer?` };
    amount = wholeOf.confirmed;
  }
  if (amount == null) return { text: 'How much is the transfer?' };

  // Random, not the clock. `Date.now()` collided whenever two transfers landed in the same
  // millisecond, and then brokenTransfers() saw one group with four legs and called BOTH
  // transfers broken. One message carrying two transfers does exactly that.
  const tid = `t${randomUUID().slice(0, 8)}`;
  const fee = parseAmount(e.fee);
  // Same refusal as money(): a transfer books two legs against two anchors, so a wrong date
  // here moves the wrong balance twice.
  const occurred = resolveDate(e.date_hint, ctx.today, addDays, manilaHour(new Date()));
  if (occurred == null) return { text: badDate(e.date_hint) };
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
  // Said out loud when the figure was derived: it is my count of that account, not a
  // number read off the app, and the difference is the user's to catch.
  const whole = wholeOf ? ' · all of it, by my books' : '';
  const lines = [
    `${peso(Math.abs(amount))} · ${from.name} → ${to.name}${fee ? ` (+${peso(fee)} fee)` : ''}${whole}`,
  ];
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

/**
 * `fee 10` — the InstaPay charge, attached to the transfer that just asked for it.
 *
 * The transfer reply invites this reply by name, and until now nothing answered to it: the
 * message went to the extractor, which still had the whole transfer in its transcript and
 * dutifully emitted it AGAIN with a fee on it. One ₱5,288.50 move became two. So the reply
 * the app asks for is a typed command, like /snap — the only messages that get parsed are
 * the ones the app did not dictate.
 *
 * The row carries the transfer's inbox_id, not this message's, so 🗑 void and /undo still
 * take the fee with the transfer exactly as they do when the fee arrives inline.
 */
export async function feeCmd(db: Db, accounts: Account[], arg: string, today: string): Promise<Reply> {
  const amount = parseAmount(arg);
  if (amount == null) return { text: 'How much was the fee? e.g. fee 10' };
  if (amount === 0) return { text: 'No fee, nothing written.' };

  // The SOURCE leg: the fee is charged by the account the money left.
  const leg = await db.one<Event>(
    "SELECT * FROM events WHERE type = 'transfer' AND amount_centavos < 0 AND voided_at IS NULL ORDER BY id DESC LIMIT 1",
  );
  if (!leg) return { text: 'No transfer to attach a fee to.' };
  const already = await db.one<Event>(
    "SELECT * FROM events WHERE transfer_id = ? AND category = 'fees' AND voided_at IS NULL",
    [leg.transfer_id ?? ''],
  );
  if (already)
    return {
      text: `That transfer already has a ${peso(Math.abs(already.amount_centavos))} fee. Correct it instead.`,
    };

  const account = acct(accounts, leg.account_id);
  if (!account) return { text: 'That transfer is on an account I no longer have.' };
  const anchor = await db.latestSnapshot(account.id);
  const { date, lateFor } = bookingDate(leg.occurred_at, anchor?.as_of_date ?? null);
  const row = {
    inbox_id: leg.inbox_id ?? null,
    transfer_id: leg.transfer_id,
    type: 'expense',
    book: account.book,
    account_id: account.id,
    amount_centavos: -Math.abs(amount),
    category: 'fees',
    note: 'transfer fee',
    occurred_at: date,
    logged_at: nowIso(),
  };
  await db.batch((lateFor ? lateEntryPair(row, lateFor) : [row]).map((r) => db.insertEvent(r as never)));
  return { text: `${peso(amount)} fee · ${account.name}\n${await remaining(db, account, today)}` };
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

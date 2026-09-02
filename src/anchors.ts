/**
 * Anchors: the one number the whole design trusts unconditionally.
 *
 * An anchor is a real balance read off a banking app, and every later figure is counted
 * forward from it — so a misparse writes a garbage baseline AND a phantom adjustment row,
 * and every balance after it inherits both. That is why prose only ever PROPOSES one and a
 * tap commits it, and why /snap exists as a typed command that never touches the LLM.
 */

import { Db, type Account } from './db.ts';
import type { Extracted } from './extract.ts';
import { dayDiff, drift, effective, parseAmount, peso, sum } from './ledger.ts';
import { acct, nowIso, type Reply } from './reply.ts';

/**
 * An anchor asked for in prose is PROPOSED, never written.
 *
 * The anchor is the one number the whole design trusts unconditionally: a misparse writes a
 * garbage baseline AND a phantom adjustment row, and every later balance inherits both. So
 * the extractor may transcribe a balance it was told, but only a tap commits it — the same
 * capture-and-confirm rule as reading a balance off a screenshot.
 *
 * Refusing outright was the wrong way to enforce that. This keeps the guarantee and drops
 * the friction.
 */
export async function proposeAnchor(
  db: Db,
  accounts: Account[],
  e: Extracted,
  today: string,
): Promise<Reply> {
  const account = acct(accounts, e.account);
  const balance = parseAmount(e.amount);
  // Ask only for the half that is actually missing. Re-asking for the part you just said
  // is what makes a bot feel like a form.
  if (!account && balance == null)
    return { text: `Which account, and what balance? e.g. "maya is at 98,000" or /snap maya 98000` };
  if (!account)
    return { text: `${peso(balance!)} in which account? (${accounts.map((a) => a.id).join(' / ')})` };
  if (balance == null) return { text: `${account.name} — what balance does the app show?` };

  const prev = await db.latestSnapshot(account.id);
  const was = prev ? ` (was ${peso(prev.balance_centavos)} on ${prev.as_of_date})` : '';
  return {
    text: `Anchor ${account.name} at ${peso(balance)} as of ${today}?${was}`,
    keyboard: [
      [
        { text: '✓ anchor it', callback_data: `snap:${account.id}:${balance}` },
        { text: '✗ cancel', callback_data: 'nope' },
      ],
    ],
  };
}

// ── typed, deterministic, no LLM call at all ────────────────────────────────

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

  return anchorAccount(db, account, balance, today);
}

/**
 * Write an anchor and reconcile against the previous one. Shared by the typed `/snap` and by
 * a confirmed natural-language proposal, so both take exactly the same path.
 */
export async function anchorAccount(
  db: Db,
  account: Account,
  balance: number,
  today: string,
): Promise<Reply> {
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
      const label =
        account.kind === 'cash'
          ? 'Unlogged cash spending, or something else?'
          : 'What was it? Untagged, this number cannot be told apart from forgotten spending.';
      return {
        text: [...lines, '', label].join('\n'),
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

  // FIRST anchor with spending already logged: genuinely ambiguous, and the two readings
  // differ by exactly that spending. Counting your wallet AFTER spending means the money is
  // already gone and subtracting again double-counts; counting BEFORE means it must still
  // come off. Nothing in the data can tell these apart, and it can only ever happen once per
  // account, so ask at the one moment the answer exists.
  if (!prev) {
    const prior = sum(
      effective(await db.eventsSince(account.id, '0000-00-00')).filter((r) => r.type !== 'adjustment'),
    );
    if (prior !== 0) {
      lines.push(
        '',
        `You already logged ${peso(Math.abs(prior))} on this account before anchoring it.`,
        `Is ${peso(balance)} what's there NOW (already spent), or what you had BEFORE that?`,
      );
      return {
        text: lines.join('\n'),
        keyboard: [
          [{ text: `✓ ${peso(balance)} is what's there now`, callback_data: `anchored:${account.id}` }],
          [
            {
              text: `↓ subtract the ${peso(Math.abs(prior))}`,
              callback_data: `anchorsub:${account.id}:${prior}`,
            },
          ],
        ],
      };
    }
  }

  if (account.rate > 0) {
    lines.push(`what interest did it credit since the last anchor? reply: /interest ${account.id} 653`);
  }
  return { text: lines.join('\n') };
}

/**
 * The shape every handler answers with, and the three helpers they all reach for.
 *
 * Its own file so the domain modules can share it without importing each other: entries,
 * anchors and reports all produce a Reply, and none of them needs to know the others exist.
 *
 * ── The copy rules, because five files write user-facing text ────────────────
 *
 * They lived nowhere, so the same idea got four wordings and "no such account" got three.
 * Written down here because this is the module every one of those files already imports.
 *
 *  1. NO EM DASH. Colon when the second half explains, comma when it continues, full stop
 *     when it is a separate thought.
 *  2. Any reply that CHANGED an account's money ends with what is left there, via
 *     `remaining()` in reports.ts. A message with live buttons is not finished, so its
 *     figure is provisional: those state the balance on the confirming tap instead.
 *  3. Buttons: actions are `glyph + lowercase verb`, 20 characters at most. Answers to a
 *     question are bare lowercase nouns with no glyph, because decorating every option in a
 *     multiple choice makes the row noise rather than signal.
 *  4. Tap acknowledgements are lowercase past tense with no trailing full stop, carrying the
 *     glyph of the button they came from.
 *  5. One shape for an unknown account: `No account "maya". One of: a / b / c`. Amounts and
 *     dates already read `Couldn't read "x" as an amount.`, so failures all rhyme.
 *  6. Straight apostrophes. Never a curly one.
 */

import type { Account } from './db.ts';
import type { Keyboard } from './telegram.ts';

export interface Reply {
  text: string;
  keyboard?: Keyboard;
  /** /csv answers with a file rather than a message. */
  document?: { filename: string; content: string };
}

export const acct = (accounts: Account[], id: string | null) => accounts.find((a) => a.id === id) ?? null;
export const nowIso = () => new Date().toISOString();

/**
 * Buttons live on every saved row: the fix path is the highest-traffic path in the system.
 *
 * `confirm` and not `approve`: the row is already written and already in your balance before
 * you tap anything, so a word implying a money gate would promise something that does not
 * exist. It matches the `confirmed_at` column and the acknowledgement, so the button, the
 * reply and the schema all say one word.
 */
export const rowKeys = (id: number): Keyboard => [
  [
    { text: '✏️ fix', callback_data: `fix:${id}` },
    { text: '🗑 void', callback_data: `void:${id}` },
    { text: '✓ confirm', callback_data: `ok:${id}` },
  ],
];

/**
 * One wording for a date that could not be read, wherever the hint came from.
 *
 * Here and not in the three files that need it, for the same reason noAccount() is: a hint
 * reaches the parser from a typed command, from a spoken sentence and from the model's
 * date_hint, and three copies of this sentence is how they drift into three answers.
 */
export const badDate = (hint: string | null | undefined): string =>
  `Couldn't read "${hint ?? ''}" as a date. Use 2026-09-02, "yesterday", "3 days ago" or "last tuesday".`;

/** One wording for a name that is not an account, wherever the name came from. */
export const noAccount = (name: string | null | undefined, accounts: Account[]): string =>
  `No account "${name ?? ''}". One of: ${accounts.map((a) => a.id).join(' / ')}`;

/**
 * What a tap produced. A plain string could not carry the follow-up KEYBOARD that
 * anchorAccount returns on a first anchor — the one question the design says can only be
 * asked once per account — so it was being dropped in silence.
 */
export interface CallbackReply extends Reply {
  /**
   * Guidance, not an action: the row's buttons stay, because you tapped for advice and the
   * row still needs its void and confirm taps. The message is still sent, which is the bug
   * this flag used to cause: a toast is gone in a second and took the guidance with it.
   */
  advice?: boolean;
}

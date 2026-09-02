/**
 * The shape every handler answers with, and the three helpers they all reach for.
 *
 * Its own file so the domain modules can share it without importing each other: entries,
 * anchors and reports all produce a Reply, and none of them needs to know the others exist.
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

/** Buttons live on every saved row: the fix path is the highest-traffic path in the system. */
export const rowKeys = (id: number): Keyboard => [
  [
    { text: '✏️ fix', callback_data: `fix:${id}` },
    { text: '🗑 void', callback_data: `void:${id}` },
    { text: '✓ ok', callback_data: `ok:${id}` },
  ],
];

/**
 * What a tap produced. A plain string could not carry the follow-up KEYBOARD that
 * anchorAccount returns on a first anchor — the one question the design says can only be
 * asked once per account — so it was being dropped in silence.
 */
export interface CallbackReply extends Reply {
  /** Guidance, not an action: leave the message and its buttons exactly where they are. */
  advice?: boolean;
}

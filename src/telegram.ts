/**
 * Telegram transport. Small on purpose — the chat is transport, not the system of record.
 *
 * Two rules encoded here rather than left to discipline:
 *  - The bot token is embedded in every api.telegram.org file URL, so that URL NEVER
 *    leaves this file. Images are downloaded here and handed onward as a data URL.
 *  - parse_mode is HTML, and EVERY outgoing string is escaped here, with no exceptions and
 *    no caller opting out. Merchant names come from OCR and from a model, so they are
 *    attacker-influencable; the earlier rule was to set no parse_mode at all, priced against
 *    MarkdownV2's eighteen special characters. This is three, at a single choke point, and
 *    it buys the one thing plain text cannot give: a monospace block, so the balance columns
 *    actually line up on a phone. The only tags that ever exist are the ones mono() marks.
 */

const API = 'https://api.telegram.org/bot';

/**
 * Columns only align in a monospace font, and Telegram renders plain text proportionally —
 * so every padEnd() in a table was padding for an alignment that never happened.
 *
 * Marked with control characters rather than with `<pre>` directly, because the escape below
 * runs over the WHOLE assembled message. Escape first, then turn the markers into tags: no
 * ordering to get wrong, and no path by which merchant text can become markup. Only the
 * table is wrapped, so /commands outside it stay tappable — inside a code block they are not.
 */
const OPEN = '\u0001';
const CLOSE = '\u0002';
export const mono = (block: string): string => `${OPEN}${block}${CLOSE}`;

/** The same text for somewhere that has no markup at all — the terminal REPL. */
export const plain = (text: string): string => text.replaceAll(OPEN, '').replaceAll(CLOSE, '');

const html = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replaceAll(OPEN, '<pre>')
    .replaceAll(CLOSE, '</pre>');

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
}

export interface Message {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string };
  /**
   * The message this one replies to, when there is one. Only ever read as CONTEXT: it is
   * the one way to point at something older than the six turns the transcript keeps, and
   * `from.is_bot` is what decides whether it re-enters as the bot's turn or as yours.
   */
  reply_to_message?: { text?: string; caption?: string; from?: { is_bot?: boolean } };
}

/**
 * Who sent this. callback_query has NO `.chat` — it carries `.from` — and that is the
 * row-mutating path, so a naive `update.message.chat.id` check leaves every inline button
 * wide open while looking like it authenticates.
 */
export function senderId(u: Update): number | null {
  return u.message?.chat.id ?? u.edited_message?.chat.id ?? u.callback_query?.from.id ?? null;
}

async function call(token: string, method: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function send(token: string, chatId: number, text: string, keyboard?: Keyboard) {
  const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
  const res = (await call(token, 'sendMessage', {
    chat_id: chatId,
    text: html(text),
    parse_mode: 'HTML',
    ...markup,
  })) as { ok?: boolean };

  // Fail SOFT, always. Telegram rejects a malformed entity with a 400 and sends nothing, so
  // any formatting bug would cost you the reply itself — an expense you watched vanish. The
  // unformatted text is worth more than the alignment, so it goes out either way.
  if (res?.ok === false) {
    return call(token, 'sendMessage', { chat_id: chatId, text, ...markup });
  }
  return res;
}

/**
 * Take the buttons off a message once its question has been answered.
 *
 * This is the visible half of a tap: a toast is capped at 200 characters and vanishes, so
 * without this the chat looks identical before and after. It also retires the keyboard,
 * which otherwise stays tappable in Telegram forever — the hazard `void` already has to
 * re-validate against current row state to survive.
 */
export async function clearKeyboard(token: string, chatId: number, messageId: number) {
  return call(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

export async function answerCallback(token: string, id: string, text?: string) {
  return call(token, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
}

export async function sendCsv(token: string, chatId: number, filename: string, csv: string) {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('document', new Blob([csv], { type: 'text/csv' }), filename);
  const res = await fetch(`${API}${token}/sendDocument`, { method: 'POST', body: form });
  return res.json();
}

export type Keyboard = { text: string; callback_data: string }[][];

/**
 * Fetch a photo as a data URL.
 *
 * Uses the smallest variant at or above ~640px rather than the largest available. On Render
 * there is no CPU ceiling to trip, so this is now about tokens and privacy: a smaller image
 * is fewer input tokens against the free-tier daily budget, and Telegram has already
 * re-encoded these — which is what strips EXIF, so home and campus GPS never reach two
 * vendors.
 *
 * `document` uploads are refused upstream in the handler for the same reason: a file ships
 * original bytes.
 */
export async function photoAsDataUrl(token: string, photos: NonNullable<Message['photo']>): Promise<string> {
  const sorted = [...photos].sort((a, b) => a.width - b.width);
  const pick = sorted.find((p) => p.width >= 640) ?? sorted[sorted.length - 1];

  const meta = (await call(token, 'getFile', { file_id: pick.file_id })) as {
    ok: boolean;
    result?: { file_path: string };
  };
  if (!meta.ok || !meta.result) throw new Error('getFile failed');

  // This URL contains the bot token. It does not leave this function.
  const bytes = await fetch(`https://api.telegram.org/file/bot${token}/${meta.result.file_path}`).then((r) =>
    r.arrayBuffer(),
  );

  let binary = '';
  const view = new Uint8Array(bytes);
  const CHUNK = 8192; // String.fromCharCode blows the stack on a whole 300KB spread
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

/**
 * Long-poll for updates.
 *
 * Chosen over a webhook because Render already needs a public HTTP endpoint for the
 * keep-alive ping, and this way that endpoint is a bare /healthz that writes nothing.
 * There is no URL an attacker can POST a forged `correction` intent to, so the secret-token
 * dance and the random webhook path both stop existing rather than being got right.
 *
 * It also fails better on a free tier: if the instance is asleep or restarting, Telegram
 * HOLDS the updates (~24h) and the next poll drains them. A webhook would retry with
 * backoff and then discard, so you would keep typing expenses that were never recorded.
 *
 * `allowed_updates` deletes an entire surface rather than filtering it in code — the ~20
 * other update types never arrive at all.
 */
export async function getUpdates(token: string, offset: number, timeoutSec = 50): Promise<Update[]> {
  const res = await fetch(`${API}${token}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    }),
    // Slightly longer than Telegram's own long-poll window, so the abort is ours to control.
    signal: AbortSignal.timeout((timeoutSec + 15) * 1000),
  });
  const json = (await res.json()) as { ok: boolean; result?: Update[]; description?: string };
  if (!json.ok) throw new Error(`getUpdates: ${json.description ?? res.status}`);
  return json.result ?? [];
}

/**
 * Register the "/" menu in Telegram's own UI.
 *
 * Done from code rather than by hand in BotFather, so the menu cannot drift from the
 * command table that generates it — and a fresh deploy of a new bot is self-configuring.
 */
export async function setMyCommands(token: string, commands: readonly { name: string; help: string }[]) {
  return call(token, 'setMyCommands', {
    commands: commands.map((c) => ({ command: c.name, description: c.help })),
  });
}

/** Clears any webhook left over from an earlier deploy — the two modes are exclusive. */
export async function deleteWebhook(token: string) {
  return call(token, 'deleteWebhook', { drop_pending_updates: false });
}

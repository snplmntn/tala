/**
 * Telegram transport. Small on purpose — the chat is transport, not the system of record.
 *
 * Two rules encoded here rather than left to discipline:
 *  - The bot token is embedded in every api.telegram.org file URL, so that URL NEVER
 *    leaves this file. Images are downloaded here and handed onward as a data URL.
 *  - parse_mode is never set. OCR'd merchant strings are attacker-influencable, and
 *    omitting the mode is less code than escaping it correctly.
 */

const API = 'https://api.telegram.org/bot';

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
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text,
    // No parse_mode. See the file header.
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
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

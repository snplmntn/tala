/**
 * The only place the LLM lives.
 *
 * Its entire job is prose -> a typed event. It never sees a balance, never produces one,
 * and never does arithmetic: amounts come back as STRINGS and are parsed by
 * ledger.parseAmount, so a misread digit is a rejected message rather than a wrong balance.
 *
 * Groq free tier, one fetch. `strict: true` is constrained decoding at the sampler, not a
 * post-hoc validation, so the shape is guaranteed and only the VALUES need checking.
 *
 * Provider churn is expected — Groq's free lineup demonstrably rotates — so this file is
 * the whole adapter. Swapping providers is one URL, one model id, and one auth header.
 */

export const CATEGORIES = [
  'food',
  'transport',
  'groceries',
  'bills',
  'subscriptions',
  'health',
  'education',
  'shopping',
  'fees',
  'load', // a ₱50-100 purchase several times a month that otherwise scatters into bills/other
  'business',
  'other',
] as const;

export const MODEL = 'qwen/qwen3.8-27b'; // text AND vision, strict schema, own free-tier bucket
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export type Intent = 'expense' | 'income' | 'transfer' | 'query' | 'correction' | 'snapshot' | 'unknown';

export interface Extracted {
  intent: Intent;
  amount: string | null;
  account: string | null;
  to_account: string | null;
  category: string | null;
  merchant: string | null;
  note: string | null;
  date_hint: string | null;
  shared_amount: string | null;
  recurrence: 'one_off' | 'monthly' | 'annual';
  fee: string | null;
  query_kind: 'balance' | 'recap' | 'owed' | 'csv' | null;
  match_amount: string | null;
  match_merchant: string | null;
  looks_like_transfer: boolean;
  /** Only for intent: unknown — the words to say back. Every other intent is answered by code. */
  reply: string | null;
}

/** One side of the conversation, as the model sees it. */
export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The last few turns, in memory, per process.
 *
 * Without this every message is parsed alone, so "maribank" answering "which account?" is
 * just the word maribank — and the bot re-asks the question it already asked. That loop is
 * the difference between a form and something worth talking to.
 *
 * Deliberately NOT persisted. One process, one owner, one chat: a restart drops context
 * that was only useful for the next minute, and the alternative is a column on `inbox` plus
 * a migration against the live ledger. It moves into the database the day a second instance
 * or a second user exists — not before.
 */
export function transcript(max = 6) {
  const turns: Turn[] = [];
  return {
    turns,
    add(role: Turn['role'], content: string): void {
      if (!content.trim()) return;
      // Capped: a /csv dump or a long balance table would otherwise crowd out the prompt.
      turns.push({ role, content: content.slice(0, 300) });
      if (turns.length > max) turns.splice(0, turns.length - max);
    },
  };
}

/**
 * Deliberately FLAT rather than a discriminated union with anyOf. Strict mode requires
 * every property present in `required` with additionalProperties false, and nested anyOf
 * is where strict schemas get rejected. A flat object with nullable types is the shape
 * that actually survives, and the intent field carries the discrimination.
 */
function schema(accountIds: string[]) {
  const nullableString = { type: ['string', 'null'] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        // Real messages are "jeep 15, load 50, lunch 90", and real catch-up is three days
        // at once. One intent per message silently drops two of three events — which is
        // how a first lapse becomes permanent abandonment, on cash, where every unlogged
        // peso already hides.
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'intent',
            'amount',
            'account',
            'to_account',
            'category',
            'merchant',
            'note',
            'date_hint',
            'shared_amount',
            'recurrence',
            'fee',
            'query_kind',
            'match_amount',
            'match_merchant',
            'looks_like_transfer',
            'reply',
          ],
          properties: {
            intent: {
              type: 'string',
              enum: ['expense', 'income', 'transfer', 'query', 'correction', 'snapshot', 'unknown'],
              description:
                "expense = money left an account. income = money arrived. transfer = moved between two of the user's OWN accounts. " +
                'correction = fixing a PAST entry ("the X was 285 not 250", "that was gcash not maya"). ' +
                'query = asking a question, not recording anything ("how much do I have", "recap"). ' +
                'snapshot = REPORTING a current bank balance read from an app ("maya is at 98000", "my maribank shows 12850"). ' +
                'unknown = only when none of the above fits.',
            },
            // Strings, always. The model transcribes; code parses. It must never compute.
            amount: {
              ...nullableString,
              description:
                'the amount exactly as written, e.g. "250", "1,234.56". Never computed or converted.',
            },
            account: {
              type: ['string', 'null'],
              enum: [...accountIds, null],
              description: 'which account was charged. Null if the message does not say — do NOT guess.',
            },
            to_account: {
              type: ['string', 'null'],
              enum: [...accountIds, null],
              description: 'destination account for a transfer only',
            },
            category: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
            merchant: {
              ...nullableString,
              description: 'lowercased merchant name, e.g. "jollibee". Null if none named.',
            },
            note: { ...nullableString, description: 'the human detail, e.g. "C1 meal". Never aggregated.' },
            date_hint: {
              ...nullableString,
              description:
                'only if the message says when: "yesterday", "sep 1", "last monday". Null means today.',
            },
            shared_amount: {
              ...nullableString,
              description:
                "the portion that is SOMEONE ELSE'S money, when the user fronted for a group. Null if fully theirs.",
            },
            recurrence: { type: 'string', enum: ['one_off', 'monthly', 'annual'] },
            fee: {
              ...nullableString,
              description: 'a transfer fee the user mentions, e.g. the ₱10 InstaPay charge',
            },
            query_kind: {
              type: ['string', 'null'],
              enum: ['balance', 'recap', 'owed', 'csv', null],
              description: 'ONLY for intent=query. Null for every other intent.',
            },
            match_amount: {
              ...nullableString,
              description: 'for a correction: the OLD amount, to find the row being corrected',
            },
            match_merchant: {
              ...nullableString,
              description: 'for a correction: merchant substring, to find the row',
            },
            looks_like_transfer: {
              type: 'boolean',
              description:
                'true if the wording is sent/moved/transferred/cash-in — even when intent is expense',
            },
            reply: {
              ...nullableString,
              description:
                'ONLY for intent=unknown: what to say back, in your own words. Null for every other intent.',
            },
          },
        },
      },
    },
  };
}

const SYSTEM = `You are Tala, a money tracker in a chat. You convert one Filipino-English message about money into typed events. For anything that records money you are a transcriber, not an accountant.

HARD RULES:
- NEVER compute, convert or sum anything. Copy amounts exactly as written, as strings.
- NEVER guess the account. If the message does not say which account or card, return account: null. Asking is correct; guessing misfiles money.
- NEVER invent an account name. Use only the given ids.
- If the amount is not stated, return amount: null. Do not estimate from the merchant.
- Non-peso amounts ("$20 for cursor"): return amount: null and put the original in note. The peso amount the card was actually charged is the only authoritative figure, and you do not know it.
- "for myself" means shared_amount is null. Only set shared_amount when the user says they covered others.
- A refund or money back is intent: expense with a POSITIVE amount and the same category as the original.
- Set looks_like_transfer: true whenever the wording is sent / moved / transferred / cash-in / padala / load-up, even if you also chose intent: expense. Moving your own money between your accounts is a transfer, not spending.
- Split multi-item messages into separate events, one per SEPARATE PURCHASE ("jeep 15, load 50, lunch 90" is three events).
- But a QUALIFIER about one purchase is NOT a second event. "600 dinner maribank, 400 not mine" is ONE expense of 600 with shared_amount 400. Phrases that mean shared_amount: "N not mine", "N is not mine", "N was theirs", "N is my friend's share", "I paid for N of it". Never emit a separate event for that number.
- If you cannot tell what the user means, return a single event with intent: unknown.

THE CONVERSATION SO FAR IS CONTEXT, NOT DECORATION:
- Earlier turns are given to you as real messages. If YOUR last message asked a question, the user's new message is almost certainly the ANSWER to it. Merge it with what was already established and emit the COMPLETE event.
- "maribank" straight after you asked which account is that account — not a balance query. "32,330" straight after you asked what balance is that balance.
- Never re-ask something the conversation already answered.

TALKING BACK (intent: unknown only):
- When nothing is being recorded, asked or corrected — a greeting, a thank-you, small talk, or something you genuinely could not read — return ONE event with intent: unknown and write the answer in "reply", in your own words, as Tala.
- Be warm and brief: at most two sentences, no lists, no markdown. Say what you can do and give one concrete example of what to type.
- If you could not understand a message that was clearly ABOUT money, say so plainly rather than guessing, and name what is missing.
- "reply" must be null for every other intent. Those answers are written by the app, with the real numbers in them.

CHOOSING THE INTENT — this is the part that matters most:
- Recording a purchase -> expense. Receiving money -> income.
- Moving money between two of the user's OWN accounts -> transfer, with account = source and to_account = destination. A fee the user mentions goes in the "fee" field, NOT in "category".
- FIXING SOMETHING ALREADY LOGGED -> correction. Phrases like "the jollibee was 285 not 250", "that was 300", "it was gcash not maya", "wrong amount". Put the OLD amount in match_amount and the merchant in match_merchant so the row can be found, and the NEW amount in amount. Never return an expense for a correction — that would record the purchase twice.
- ASKING A QUESTION, recording nothing -> query, with query_kind set. "how much do I have" / "what's my balance" -> balance. "recap" / "how much did I spend" -> recap. "who owes me" -> owed. "export" -> csv.
- REPORTING A BALANCE they just read in their banking app -> snapshot, with account and amount. "maya is at 98000", "maribank shows 12,850", "my gcash balance is 340". This is NOT income and NOT an expense: it is a statement of what an account currently holds.
- Use unknown when nothing above fits, and then always write "reply". Do not fall back to unknown for a question or a balance report.

RECEIPT IMAGES: read merchant, date and the TOTAL. Do not try to read every line item. A receipt never says which card was used, so account must be null.`;

export interface ExtractResult {
  events: Extracted[];
  raw: string;
  model: string;
}

/**
 * One call. Throws on any non-2xx so the caller can defer the parse and keep the message —
 * the inbox row is already written, so a Groq outage costs a retry, never an expense.
 */
export async function extract(
  apiKey: string,
  accountIds: string[],
  input: { text?: string | null; imageDataUrl?: string | null },
  today: string,
  history: Turn[] = [],
): Promise<ExtractResult> {
  const content: unknown[] = [];
  if (input.imageDataUrl) content.push({ type: 'image_url', image_url: { url: input.imageDataUrl } });
  content.push({ type: 'text', text: input.text?.trim() || 'Read this receipt.' });

  const body = {
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `${SYSTEM}\n\nAccounts: ${accountIds.join(', ')}\nToday in Manila: ${today}`,
      },
      // Prior turns as real messages rather than a block pasted into the system prompt:
      // the roles are what tell the model which question was ITS question. Constrained
      // decoding still forces the response shape, so plain-text assistant turns are safe.
      ...history,
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'tala_events', strict: true, schema: schema(accountIds) },
    },
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = json.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw) as { events: Extracted[] };
  return { events: parsed.events ?? [], raw, model: MODEL };
}

/**
 * Resolve a relative date hint against today, in Manila civil dates.
 *
 * Deliberately narrow: it handles what people actually type and returns null otherwise,
 * so an unparseable hint means "today" rather than a hallucinated date in the wrong month.
 */
export function resolveDate(
  hint: string | null,
  today: string,
  addDays: (d: string, n: number) => string,
): string {
  if (!hint) return today;
  const h = hint.trim().toLowerCase();
  if (h === 'today') return today;
  if (h === 'yesterday') return addDays(today, -1);
  const ago = h.match(/^(\d+)\s*days?\s*ago$/);
  if (ago) return addDays(today, -Number(ago[1]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(h)) return h;
  return today;
}

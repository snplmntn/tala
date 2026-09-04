/**
 * The only place the LLM lives. Two calls, and the difference between them is the invariant.
 *
 * extract() turns prose into a typed event, and on that path the model never sees a balance,
 * never produces one, and never does arithmetic: amounts come back as STRINGS and are parsed
 * by ledger.parseAmount, so a misread digit is a rejected message rather than a wrong balance.
 * Every WRITE goes through there, which is where the guarantee is worth paying for.
 *
 * answer() is the read-only half, and it does see computed numbers. It runs only after a
 * report has already been rendered by code, it writes prose that is appended BELOW that
 * report, and nothing it says is ever parsed back into a row. So the worst it can do is
 * describe a correct table badly, in public, next to the table. That is a real cost and it
 * buys the thing a ledger you talk to actually needs: an answer to a question nobody wrote
 * a template for.
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

/**
 * The prose half runs on a DIFFERENT model, and the reason is the rate limit rather than the
 * writing. Groq meters tokens per minute per MODEL, 8,000 each on the free tier, so a question
 * used to spend extract()'s minute twice: once to classify it and again to answer it, leaving
 * the next message to 429 and land in the deferred queue. A second model id is a second bucket,
 * so the read path can no longer starve the write path.
 *
 * Same family as MODEL, one version back, because this is the call whose output is judged on
 * how it reads. A figure it invents is still bounded by the rules below, never by the schema.
 *
 * It is a THINKING model where MODEL is not, so reasoning_effort below is load-bearing rather
 * than a tuning knob: left at its default it writes its chain of thought into `content`, and
 * max_tokens truncates the message mid-deliberation before the answer is ever reached. What
 * arrives in the chat is Tala thinking out loud and then stopping. reasoning_format: 'hidden'
 * is the trap next door — it spends the whole 500-token budget reasoning and returns an empty
 * string, which the caller cannot tell from a model being down.
 */
const ANSWER_MODEL = 'qwen/qwen3.6-27b';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export type Intent =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'interest'
  | 'query'
  | 'correction'
  | 'snapshot'
  | 'open_account'
  | 'unknown';

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
  query_kind: 'balance' | 'recap' | 'owed' | 'csv' | 'interest' | null;
  match_amount: string | null;
  match_merchant: string | null;
  looks_like_transfer: boolean;
  /** "move all of my gcash" — the amount is the source account's whole balance, which only code may compute. */
  whole_balance: boolean;
  /** Only for intent: open_account — the display name as written. The id is derived; the kind is asked. */
  new_account: string | null;
  new_account_book: 'personal' | 'business' | null;
  /** Only for intent: unknown — the words to say back. Every other intent is answered by code. */
  reply: string | null;
  /** Only for intent: query — the question to answer in prose UNDER the report. Null for a bare request. */
  ask: string | null;
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
      // Control characters go too — the transport marks its monospace blocks with them, and
      // they are markup, not something the model should ever read back as content.
      //
      // The bot's side is capped harder because what context is FOR on that side is the
      // question it asked, and those are one line ("Which account?"). Its long turns are
      // report tables, which cost as much as the facts block and say less than the ledger
      // the next call reads anyway. 160 still carries "I showed you a table".
      const cap = role === 'assistant' ? 160 : 300;
      turns.push({ role, content: content.replace(/[\u0000-\u0008]/g, '').slice(0, cap) });
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
            'whole_balance',
            'new_account',
            'new_account_book',
            'reply',
            'ask',
          ],
          properties: {
            intent: {
              type: 'string',
              enum: [
                'expense',
                'income',
                'transfer',
                'interest',
                'query',
                'correction',
                'snapshot',
                'open_account',
                'unknown',
              ],
              description:
                "expense = money left an account. income = money arrived. transfer = moved between two of the user's OWN accounts. " +
                'interest = a bank CREDITED interest or earnings on the user\'s own savings ("maya credited 21.48", "got 8 pesos interest"). ' +
                'correction = fixing a PAST entry ("the X was 285 not 250", "that was gcash not maya"). ' +
                'query = asking a question, not recording anything ("how much do I have", "recap"). ' +
                'snapshot = REPORTING a current bank balance read from an app. ' +
                'open_account = asking to START TRACKING an account or card that is not in the list yet. ' +
                'unknown = only when none of the above fits.',
            },
            // Strings, always. The model transcribes; code parses. It must never compute.
            amount: {
              ...nullableString,
              description:
                'the amount exactly as written, e.g. "250", "1,234.56". Never computed or converted. ' +
                'Null when the message states no amount: never estimated from the merchant.',
            },
            account: {
              type: ['string', 'null'],
              enum: [...accountIds, null],
              description:
                'which account or card was charged. Null if the message does not say — do NOT guess: ' +
                'asking is correct, guessing misfiles money.',
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
                'WHEN. For a recorded event this is the DAY: "yesterday", "3 days ago", "last monday", ' +
                '"sep 1", or an ISO date. For intent=query it is the PERIOD being asked about instead: ' +
                '"today", "yesterday", "week", "month", "last week", "last month", or "2026-08" — ' +
                '"what did I spend this month" is date_hint "month". Null means today.',
            },
            shared_amount: {
              ...nullableString,
              description:
                "the portion that is SOMEONE ELSE'S money, when the user fronted for a group: " +
                '"N not mine", "N is not mine", "N was theirs", "N is my friend\'s share", "I paid for N of it". ' +
                'Null if fully theirs, and "for myself" means null.',
            },
            recurrence: { type: 'string', enum: ['one_off', 'monthly', 'annual'] },
            fee: {
              ...nullableString,
              description: 'a transfer fee the user mentions, e.g. the ₱10 InstaPay charge',
            },
            query_kind: {
              type: ['string', 'null'],
              enum: ['balance', 'recap', 'owed', 'csv', 'interest', null],
              description:
                'ONLY for intent=query. Null for every other intent. "how much do I have" / "what\'s my ' +
                'balance" -> balance. "recap" / "how much did I spend" -> recap. "who owes me" -> owed. ' +
                '"export" -> csv. "how much interest have I earned" / "total earnings" -> interest, because ' +
                'what they have EARNED so far is a question, not a credit being reported.',
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
                'true whenever the wording is sent / moved / transferred / cash-in / padala / load-up, even ' +
                'when you also chose intent: expense. Moving your own money between your own accounts is a ' +
                'transfer, not spending.',
            },
            whole_balance: {
              type: 'boolean',
              description:
                'true when the amount IS the whole balance of the source account instead of a figure — ' +
                '"transfer all of my gcash", "move everything in maya", "cash out my whole gcash", "lahat". ' +
                'Still return amount: null and account = the one being emptied; the app looks the balance up.',
            },
            new_account: {
              ...nullableString,
              description:
                "ONLY for intent=open_account: the account's name, exactly as the user wrote it and nothing else — " +
                '"Beep Card", "SeaBank", "BPI". Not an id, no book or kind words, no amount. Null for every other intent.',
            },
            new_account_book: {
              type: ['string', 'null'],
              enum: ['personal', 'business', null],
              description:
                'ONLY for intent=open_account: business ONLY if the user says it is for the business. ' +
                'Null when they do not say — proposeAccount reads anything but "business" as personal, so ' +
                'there is nothing to guess here.',
            },
            reply: {
              ...nullableString,
              description:
                'ONLY for intent=unknown: what to say back, in your own words. Null for every other intent.',
            },
            ask: {
              ...nullableString,
              description:
                'ONLY for intent=query, and only when the message is a QUESTION ABOUT the numbers rather than ' +
                'a bare request FOR them: anything phrased did / does / is / was / why / how come / already / ' +
                'still, anything asking whether something is included, counted, added or missing, and any ' +
                'follow-up leaning on what was just said. "did my interest get added to my balance?" / "why ' +
                'does maya say est?" / "and is that the whole day?" -> copy their words here; do not answer ' +
                'it. Null for a bare request FOR a report, which the table already answers. Null for every ' +
                'other intent.',
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
- A quantity belongs IN the amount, unmultiplied: "299 x 3" -> amount "299 x 3", "3 x 15 jeep" -> amount "3 x 15". Never drop the quantity and never work out the total — the app does that, exactly.
- Non-peso amounts ("$20 for cursor"): return amount: null and put the original in note. The peso amount the card was actually charged is the only authoritative figure, and you do not know it.
- NEVER invent an account name. Use only the given ids — the one exception is intent: open_account, which is how a new id comes into existence.
- A refund or money back is intent: expense with a POSITIVE amount and the same category as the original.
- LENDING someone money is an expense whose shared_amount is the WHOLE amount, with merchant = who borrowed it: "mom borrowed 2k maribank" and "lend her 2k from gcash" are one expense of 2000, shared_amount 2000, merchant "mom", category null. The money really did leave the account and it is still owed to the user, which is what shared_amount means. Never return unknown for a loan and never ask what kind of thing it is.
- Split multi-item messages into separate events, one per SEPARATE PURCHASE ("jeep 15, load 50, lunch 90" is three events). But a QUALIFIER about one purchase is NOT a second event: "600 dinner maribank, 400 not mine" is ONE expense of 600 with shared_amount 400, never two events.

THE CONVERSATION SO FAR IS CONTEXT, NOT DECORATION:
- Earlier turns are given to you as real messages. If YOUR last message asked a question, the user's new message is almost certainly the ANSWER to it. Merge it with what was already established and emit the COMPLETE event.
- "maribank" straight after you asked which account is that account — not a balance query. "32,330" straight after you asked what balance is that balance.
- Never re-ask something the conversation already answered.
- Context is NOT a queue: never emit an event you already emitted earlier in the conversation. A follow-up that adds a detail to something already recorded is a correction, or nothing at all — re-sending it books the money twice.

TALKING BACK (intent: unknown only):
- When nothing is being recorded, asked or corrected — a greeting, a thank-you, small talk, or something you genuinely could not read — return ONE event with intent: unknown and write the answer in "reply", in your own words, as Tala.
- Be warm and brief: at most two sentences, no lists, no markdown. Say what you can do and give one concrete example of what to type.
- If you could not understand a message that was clearly ABOUT money, say so plainly rather than guessing, and name what is missing.
- If the conversation shows Tala just asked what to call the user and they answered with a bare name, your reply must tell them to run "/name <that name>" so it is remembered. You cannot save it yourself.

WHICH FIELDS AN INTENT NEEDS. The intent field's own description defines the nine; this is what to fill in once you have chosen:
- transfer: account = source, to_account = destination. A fee the user mentions goes in "fee", never in "category".
- correction: the OLD amount in match_amount and the merchant in match_merchant so the row can be found, the NEW amount in amount. Never ALSO return an expense for it — that records the purchase twice.
- interest: account, amount, date_hint. NOT income: income arrives from outside, interest is the user's own pot paying them, and the projected rate LEARNS from it. If they do not say which account, account: null and it will be asked.
- snapshot: account and amount, from a balance they just read in their banking app — "maya is at 98000", "maribank shows 12,850", "my gcash balance is 340". This is NOT income, NOT an expense and NOT a query about the balance: it is a statement of what that account currently holds.
- query: query_kind, the period in date_hint, then decide "ask". A "how much" or "what did I spend" question is a REQUEST for the table however it is phrased, so ask stays null with the period in date_hint. A recap can be scoped to ONE SET OF BOOKS by naming an account ("what did gotyme spend this month", "business recap"): query_kind recap with account = that account. Null account is the ordinary personal recap.
- open_account: new_account and new_account_book, nothing else. Whether it is a bank, wallet, cash or credit is NOT yours to decide — the app asks with buttons. If the SAME message also states a balance, still return ONLY open_account: the account must exist before a balance can attach to it.
- unknown: always write "reply". Never fall back to unknown for a question about the user's own money — that is a query with "ask" set, which is how it gets answered against the real numbers instead of from memory.

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
  ctx: { today: string; history?: Turn[]; owner?: string | null },
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
        content: [
          SYSTEM,
          '',
          `Accounts: ${accountIds.join(', ')}`,
          `Today in Manila: ${ctx.today}`,
          // Only when it is known. Told to guess a name, a model will happily invent one.
          ctx.owner ? `You are talking to ${ctx.owner}. Use their name naturally, not in every line.` : '',
        ]
          .join('\n')
          .trim(),
      },
      // Prior turns as real messages rather than a block pasted into the system prompt:
      // the roles are what tell the model which question was ITS question. Constrained
      // decoding still forces the response shape, so plain-text assistant turns are safe.
      ...(ctx.history ?? []),
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
 * Answer a question about numbers that CODE has already computed.
 *
 * What comes back IS the message: the report the app rendered is context here, not something
 * the person sees, because the report picked from the wording is regularly not the one the
 * question is about. So the guard is on the FIGURES rather than on the layout — every number
 * has to be one printed in the report or the facts block. The path stays read-only: nothing
 * said here becomes a row.
 *
 * It may answer with a TABLE. A question like "what are all my gotyme expenses" wants rows,
 * and a paragraph describing rows is the worst of both — it reads longer and says less. The
 * fences it marks the table with are turned into a monospace block by the caller.
 *
 * No json_schema and no strict mode, unlike extract(). There is no shape to constrain: the
 * output is prose, and the only thing that could go wrong with it is being wrong, which a
 * schema does not check.
 *
 * It may do arithmetic, which extract() may never do, and the difference is not inconsistency:
 * a figure produced here is read once and thrown away, while a figure produced there becomes a
 * row. The gate is on the INPUTS — every operand has to be printed in the report or the facts
 * block — because that is the part a reader can check by eye against the table above it. A
 * blanket ban was the first shape and it was wrong: it refused "anchor minus that dinner" while
 * both figures sat on screen, which is not caution, it is a calculator that will not add.
 */
export async function answer(
  apiKey: string,
  question: string,
  report: string,
  facts: string,
  ctx: { today: string; history?: Turn[]; owner?: string | null },
): Promise<string> {
  const system = [
    `You are Tala, a money tracker in a chat, talking to ${ctx.owner ?? 'the person whose ledger this is'}.`,
    `Today in Manila: ${ctx.today}. What you write is the ONLY message they get: everything below was`,
    'computed by the app but is NOT shown to them, so treat it as facts, not as something they can see.',
    '',
    'RULES:',
    '- Lead with the answer. Start with Yes or No ONLY for an actual yes/no question: a "why" or',
    '  "how" answer opening with No reads as contradicting something nobody said.',
    '- NEVER state a figure that is not in the report or the facts, and never convert a currency.',
    '- You MAY do arithmetic, but ONLY when every input is a figure printed in the report or the',
    '  facts: a row taken off a balance, two rows added, a difference between two figures. Name the',
    '  figures you used. Call the result a calculation, not a balance: nothing in the ledger moved.',
    '- If an input is missing, say which one and stop. Never estimate it and never carry a figure',
    '  in from memory.',
    '- The report names the period in its own first line, so never say you cannot tell which',
    '  days it covers, and never doubt a figure printed in it.',
    '- FORMAT. If the answer is a set of rows or figures (a list of expenses, what an account holds,',
    '  what moved), print a table and nothing else: open ``` on its own line, one row per line with',
    '  the amount right-aligned in a column, close ```. Under 40 characters wide, it is read on a',
    '  phone. Put a total row ONLY if you can add it from figures you were given.',
    '- If the answer is an EXPLANATION (why, how come, whether something is counted), write two or',
    '  three sentences and no table. Never both. No bullets, no bold, no headings.',
    '- If the ledger genuinely cannot tell, say so and name what would settle it.',
    '',
    'HOW A BALANCE IS BUILT, so you can explain it:',
    '- An anchor is a real balance read off the banking app on a day; everything after counts forward',
    '  from it. Balance = anchor + every row dated after it + interest projected since the last',
    '  reported credit.',
    '- A credit reported for the anchor day books to the day AFTER it, because the reconciliation',
    '  window excludes the anchor day itself. It still counts, exactly once.',
    '- "(est)" means the rate is still the seeded estimate: no credit has yet landed in a period',
    '  bounded by two anchors, so there is nothing to learn a real rate from.',
    '- "confirmed" should match the banking app; "expected" adds today\'s uncredited slice.',
    '',
    // queryFacts already embeds the balance table verbatim, so a balance query used to ship
    // it twice and pay for it twice. Containment rather than equality: facts wraps it in a
    // heading of its own.
    ...(facts.includes(report.trim())
      ? []
      : ['A REPORT THE APP COMPUTED (facts for you, not shown to them):', report, '']),
    'FACTS FROM THE LEDGER:',
    facts,
  ].join('\n');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      temperature: 0,
      // See ANSWER_MODEL. Not an economy: without it there is no answer in the message.
      reasoning_effort: 'none',
      // 220 fitted three sentences and truncated a table mid-row. What actually bounds the
      // length is FACT_ROWS on the facts side, not this ceiling.
      max_tokens: 500,
      // The last exchange only. Older turns are mostly stale report TABLES: they cost as much
      // as the facts block and say less than it already says.
      messages: [
        { role: 'system', content: system },
        ...(ctx.history ?? []).slice(-2),
        { role: 'user', content: question },
      ],
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return (json.choices?.[0]?.message?.content ?? '').trim();
}

/** Matched by PREFIX, so "sep", "sept" and "september" all land on the same month. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * A date that exists. "2026-02-31" survives every regex and then silently becomes March 3rd
 * once anything constructs a Date from it, which is a wrong day nobody ever sees typed.
 */
const realDay = (iso: string): string | null =>
  new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;

/**
 * Resolve a relative date hint against today, in Manila civil dates.
 *
 * It must understand every format the SCHEMA advertises to the model, and that is the whole
 * reason this grew. The date_hint description offered "sep 1" and "last monday" as examples
 * while this function knew neither, so the model dutifully produced them and every one came
 * back null — which the expense path then swallowed as `?? today`. A prompt and a parser
 * written to different specs is how money gets filed on a day you never chose.
 *
 * Still returns NULL rather than guessing, and now every caller refuses by name on null. The
 * old asymmetry (typed hints refused, spoken hints defaulted to today) was a reasonable trade
 * when an unreadable hint was rare; once the schema was advertising two unreadable formats it
 * stopped being rare, and a silently mis-dated expense is the one error you cannot spot by
 * reading the reply back.
 */
export function resolveDate(
  hint: string | null,
  today: string,
  addDays: (d: string, n: number) => string,
): string | null {
  if (!hint) return today;
  const h = hint.trim().toLowerCase().replace(/[.,]/g, '');
  if (h === 'today') return today;
  if (h === 'yesterday') return addDays(today, -1);
  const ago = h.match(/^(\d+)\s*days?\s*ago$/);
  if (ago) return addDays(today, -Number(ago[1]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(h)) return realDay(h);

  // The most recent one STRICTLY before today. One rule covers both wordings, and it is what
  // makes "last tuesday" said ON a Tuesday mean a week ago rather than this morning.
  const bare = h.replace(/^(last|nung|noong)\s+/, '');
  const wd = bare.length >= 3 ? DAY_NAMES.findIndex((d) => d.startsWith(bare)) : -1;
  if (wd >= 0) {
    // Inlined rather than imported from ledger.weekdayOf: this file imports NOTHING, which is
    // what makes it the one adapter you swap when the provider changes.
    // ponytail: two lines of calendar, not a dependency.
    const [y, m, d] = today.split('-').map(Number);
    const todayWd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return addDays(today, -((todayWd - wd + 7) % 7 || 7));
  }

  // "sep 1" and "1 september", either order. The year is inferred and never asked: a date you
  // type is one that already happened, so a day still ahead of today belongs to last year.
  const md = h.match(/^([a-z]{3,9})\s+(\d{1,2})$/);
  const dm = h.match(/^(\d{1,2})\s+([a-z]{3,9})$/);
  const name = md?.[1] ?? dm?.[2];
  const num = md?.[2] ?? dm?.[1];
  if (name && num) {
    const mi = MONTHS.findIndex((m) => name.startsWith(m));
    if (mi >= 0) {
      const iso = (yr: number) => `${yr}-${String(mi + 1).padStart(2, '0')}-${num.padStart(2, '0')}`;
      const y = Number(today.slice(0, 4));
      return realDay(iso(iso(y) > today ? y - 1 : y));
    }
  }
  return null;
}

/**
 * Talk to the ledger from your terminal. No Telegram, no bot token, no deploy.
 *
 *   npm run chat
 *
 * Runs against a LOCAL SQLite FILE (tala-dev.db), not your real ledger — libSQL takes a
 * `file:` URL, so the same client, the same schema and the same append-only triggers all
 * work with nothing on the network. That means you can type nonsense, break things and
 * delete the file, and your real data is untouched.
 *
 * The only secret it needs is GROQ_API_KEY, because extraction is the actual feature.
 * Telegram is just transport, and this replaces it.
 *
 *   npm run chat -- --remote   talk to the REAL Turso ledger (careful: writes are real)
 *   npm run chat -- --reset    delete the local file and start clean
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

import { Db } from '../src/db.ts';
import { extract } from '../src/extract.ts';
import { manilaDate } from '../src/ledger.ts';
import { HELP, applyEvent, callback, runCommand } from '../src/handlers.ts';

const args = new Set(process.argv.slice(2));
const remote = args.has('--remote');
const DEV_FILE = 'tala-dev.db';

if (args.has('--reset') && !remote) {
  for (const f of [DEV_FILE, `${DEV_FILE}-wal`, `${DEV_FILE}-shm`]) if (existsSync(f)) rmSync(f);
  console.log('local ledger deleted');
}

const groq = process.env.GROQ_API_KEY ?? '';
if (!groq) {
  console.error(
    'GROQ_API_KEY is required — extraction is the feature. Get one free at console.groq.com/keys',
  );
  process.exit(1);
}

let db: Db;
if (remote) {
  const url = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (!url || !token) {
    console.error('--remote needs TURSO_URL and TURSO_TOKEN');
    process.exit(1);
  }
  db = new Db(url, token);
  console.log('\n⚠  REMOTE — writes land in your real ledger.\n');
} else {
  const fresh = !existsSync(DEV_FILE);
  db = new Db(`file:${DEV_FILE}`);
  if (fresh) {
    // Same schema.sql the real database runs, triggers included.
    await db.executeMultiple(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    console.log(`created ${DEV_FILE} from schema.sql`);
  }
}

const today = () => manilaDate(new Date());

console.log(`
Tala — local chat  (${remote ? 'REMOTE' : DEV_FILE})   ${today()}

Type like you would in Telegram:
  250 jollibee maribank
  jeep 15, load 50, lunch 90 gcash
  600 dinner maribank, 400 not mine
  sent 2k from maya to gotyme, fee 10
  the jollibee was 285 not 250

Type /help for the full command list.

Meta:     :raw <json>   apply a hand-written event, skipping the LLM
          :tap <data>   fire an inline-button callback, e.g. :tap ok:1
          :sql <query>  read the ledger directly
          :q            quit
`);

// The async-iterator form, not rl.question(): question() stalls after the first line when
// stdin is a pipe rather than a TTY, which would make this untestable non-interactively.
const rl = createInterface({ input: stdin, output: stdout, prompt: '\u203a ' });
let inboxSeq = Date.now(); // stands in for telegram_update_id

async function handle(line: string): Promise<void> {
  const t = today();
  const accounts = await db.accounts();

  // The SAME dispatcher the Telegram bot uses, so a command can never work in one and not
  // the other — which is exactly how /help ended up missing here.
  const reply = await runCommand(db, accounts, line, t);
  if (reply) {
    console.log(reply.document ? reply.document.content : reply.text);
    if (reply.keyboard)
      console.log(
        '  buttons:',
        reply.keyboard
          .flat()
          .map((b) => b.callback_data)
          .join(' '),
      );
    return;
  }

  // Meta commands exist so the ledger can be exercised without the LLM in the loop —
  // useful when Groq is down, and useful for reproducing a bad parse exactly.
  if (line.startsWith(':sql ')) {
    console.table(await db.all(line.slice(5)));
    return;
  }
  if (line.startsWith(':tap ')) {
    console.log(await callback(db, line.slice(5).trim(), t));
    return;
  }
  if (line.startsWith(':raw ')) {
    const inboxId = await db.claim({
      update_id: inboxSeq++,
      has_photo: false,
      text: line,
      now: new Date().toISOString(),
    });
    const r = await applyEvent(db, accounts, JSON.parse(line.slice(5)), {
      inboxId: inboxId!,
      today: t,
      hadPhoto: false,
    });
    console.log(r.text);
    if (r.keyboard)
      console.log(
        '  buttons:',
        r.keyboard
          .flat()
          .map((b) => b.callback_data)
          .join(' '),
      );
    return;
  }

  // The real path: claim an inbox row first, exactly as the Telegram handler does, so
  // duplicate-suppression and deferred-retry behave identically here.
  const inboxId = await db.claim({
    update_id: inboxSeq++,
    has_photo: false,
    text: line,
    now: new Date().toISOString(),
  });
  if (inboxId == null) return console.log('(duplicate)');

  let parsed;
  try {
    parsed = await extract(
      groq,
      accounts.map((a) => a.id),
      { text: line },
      t,
    );
    await db.markInbox(inboxId, 'parsed', { model: parsed.model, raw: parsed.raw });
  } catch (e) {
    await db.markInbox(inboxId, 'deferred', { error: String(e).slice(0, 400) });
    return console.log(`extraction failed (kept in inbox, nothing lost): ${String(e).slice(0, 160)}`);
  }

  for (const ev of parsed.events) {
    const r = await applyEvent(db, accounts, ev, { inboxId, today: t, hadPhoto: false });
    console.log(r.text);
    if (r.keyboard)
      console.log(
        '  buttons:',
        r.keyboard
          .flat()
          .map((b) => b.callback_data)
          .join(' '),
      );
  }
  await db.markInbox(inboxId, 'applied');
}

rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === ':q' || line === '/quit') break;
  if (line) {
    try {
      await handle(line);
    } catch (e) {
      console.error('error:', e instanceof Error ? e.message : e);
    }
    console.log();
  }
  rl.prompt();
}
rl.close();

# Setting up Tala

One sitting, about 40 minutes. Every service below is a free tier.

Do it in this order — each step produces a value the next one needs, and **step 4 runs the
bot on your own machine before Render is involved**, so you find problems while the feedback
loop is still one second long.

| Step | What                                  | Time   |
| ---- | ------------------------------------- | ------ |
| 1    | Turso — the database                  | 8 min  |
| 2    | Groq — the extraction key             | 3 min  |
| 3    | BotFather — the bot, hardened         | 6 min  |
| 4    | **Run it locally and prove it works** | 8 min  |
| 5    | Render — deploy                       | 6 min  |
| 6    | Keep-alive ping                       | 3 min  |
| 7    | Backups, and one restore drill        | 6 min  |
| 8    | Anchor your balances                  | 3 min  |
| 9    | The Maya check (settles the seed)     | 1 min  |
| 10   | The security sitting                  | 15 min |

You will collect five secrets. Keep them in a scratch note until step 5, then delete it:

```
TELEGRAM_TOKEN=
OWNER_CHAT_ID=
GROQ_API_KEY=
TURSO_URL=
TURSO_TOKEN=
```

---

## 1. Turso — the database

Turso is libSQL, which is SQLite with a network in front. That matters: `schema.sql`, the
append-only triggers and the SQL dump all work unchanged, and you are never locked in.

Not Render's own Postgres, for one disqualifying reason — **a free Render Postgres is deleted
30 days after creation.** A ledger you intend to keep for years cannot live on that clock.

```bash
# Install the CLI. Use the install script, not Homebrew: as of 2026-09 the
# tursodatabase/tap formula declares a dependency on the retired libsql/sqld tap
# and fails to resolve with "No available formula with the name libsql/sqld/sqld".
curl -sSfL https://get.tur.so/install.sh | bash
source ~/.zshrc          # the installer appends ~/.turso to PATH

turso --version          # expect v1.x
turso auth signup        # opens a browser; no card
turso db create tala
```

Load the schema and the seeded accounts:

```bash
cd ~/Development/tala
turso db shell tala < schema.sql
```

**Checkpoint.** This must print your six accounts with Maya at `0.08` and Maribank at
`0.026` — those are net rates, already multiplied by 0.8 for the 20% withholding tax:

```bash
turso db shell tala "SELECT id, book, rate, rate_source FROM accounts ORDER BY sort"
```

Now grab the two values:

```bash
turso db show tala --url        # -> TURSO_URL   (libsql://tala-<you>.turso.io)
turso db tokens create tala     # -> TURSO_TOKEN (a long JWT; shown once)
```

> If you need to start over: `turso db destroy tala` then repeat. Do this **only** before
> you have real data — there is no undo.

---

## 2. Groq — the extraction key

Groq's free tier for `qwen/qwen3.8-27b` is 30 requests/minute, 1,000/day, 8,000 tokens/minute
and **200,000 tokens/day**. The token budget is the one that binds: every call carries the
system prompt plus the JSON schema, so a message costs ~1.8k tokens however short it is —
about 110 messages a day, not 1,000. At ~45 a day you are near a third of it, and a
receipt-photo-heavy month is the one that gets close. The model does text _and_ receipt
photos with strict JSON schema output on the same endpoint.

Chosen over Gemini's free tier for one reason worth knowing: Gemini's pricing page says
free-tier content **is** used to improve Google's products, while Groq's Services Agreement
§4.2 contractually forbids training on your inputs. Every message here carries a merchant,
an amount and which card you used.

1. Sign up at **console.groq.com** (no card).
2. **API Keys → Create API Key**. Copy it — shown once.

**Checkpoint.** Confirm the key works and the model is available to you:

```bash
curl -s https://api.groq.com/openai/v1/chat/completions \
  -H "authorization: Bearer $GROQ_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"qwen/qwen3.8-27b","messages":[{"role":"user","content":"reply with the word ok"}]}' \
  | head -c 400
```

A `model_not_found` here is the one thing that will silently break later. If you get it,
check **console.groq.com/docs/models** for the current vision-capable model on the free tier
and change the one line `export const MODEL` in `src/extract.ts`. Groq's free lineup rotates
— that constant is the whole adapter, which is why it is a constant.

---

## 3. BotFather — the bot, hardened

In Telegram, message **@BotFather**:

```
/newbot
   name:     Tala
   username: <something>_bot     (must end in "bot" and be unique)
```

Copy the token it gives you → `TELEGRAM_TOKEN`.

Then harden it, still in BotFather. These are not optional polish — the first one deletes an
entire class of update your bot would otherwise receive:

```
/setjoingroups   -> Disable      # the bot can never be added to a group
/setprivacy      -> Enable       # it only sees messages addressed to it
/setdescription  -> (leave empty)
```

Leave the description and about text blank. Bot usernames are publicly searchable, and there
is no reason for a stranger who finds yours to learn what it does.

### Getting your chat id

The bot tells you. Set the owner id to `0` — an explicit **pairing mode** — start it, and
message it. No third-party bot, and nothing to look up.

```bash
cd ~/Development/tala
cp .env.example .env
# fill in TELEGRAM_TOKEN, GROQ_API_KEY, TURSO_URL, TURSO_TOKEN
# and set OWNER_CHAT_ID=0 for now
npm install
npm run dev
```

Send your bot any message. It replies with the number:

```
Your chat id is 123456789

Set OWNER_CHAT_ID=123456789 and restart. Until then I ignore everything.
```

Put it in `.env` and restart. While the id is `0` the bot records **nothing** — pairing mode
grants no access, it just tells you the number.

Once a real id is set, an unrecognised sender gets **silence** — never an "unauthorized"
reply that would confirm the bot exists. And the value is validated at boot rather than
trusted: unset refuses (because `Number('')` is `0`, so a forgotten variable would otherwise
pair with whoever found the bot first, while nothing was being recorded), non-numeric
refuses, and a negative refuses because those are group ids.

Not self-discovered on purpose. "First sender becomes the owner" is a tempting pairing flow,
but bot usernames are publicly searchable — between deploy and your first message there is a
window where a stranger claims your ledger, and that failure is total, silent, and confusing
to undo. One value you set once has no race at all.

---

## 4. Run it locally and prove it works

Do this before Render. A local restart is one second; a Render redeploy is two minutes.

```bash
npm test          # must be 49/49 before you trust any number it shows you
npm run typecheck
```

### The fast loop: `npm run chat`

Before touching Telegram at all, talk to the ledger from your terminal:

```bash
npm run chat
```

It runs against a **local SQLite file** (`tala-dev.db`), not your real ledger — libSQL takes
a `file:` URL, so the same client, the same `schema.sql` and the same append-only triggers
all work with nothing on the network. Type nonsense, break things, `npm run chat -- --reset`
and start over; your real data is never involved. The only secret it needs is
`GROQ_API_KEY`, because extraction is the feature and Telegram is only transport.

```
› 250 jollibee maribank
₱250.00 · jollibee · Maribank · food
  buttons: fix:1 void:1 ok:1

› /balance
› :sql SELECT id,type,amount_centavos,category FROM events
› :tap ok:1
› :raw {"intent":"expense","amount":"250", ...}    # skip the LLM entirely
› :q
```

`:raw` is the one worth knowing — it applies a hand-written event with no LLM in the loop,
so you can reproduce a bad parse exactly, or exercise the ledger while Groq is down.
`npm run chat -- --remote` points at the real Turso ledger; writes are real, so use it only
to inspect.

This loop found three real bugs the moment it existed, which is the argument for using it
before Telegram rather than after.

### Then the real thing

```bash
npm run dev
```

Long-polling means **no tunnel and no ngrok** — your Mac talks to the real bot directly.

```

Now walk the real paths in Telegram, in this order:

```

/help -> the command list
/snap maya 98000 -> "Maya Savings anchored at ₱98,000.00 as of ..."
250 jollibee maribank -> "₱250.00 · jollibee · Maribank · food" + buttons
jollibee c1 meal maribank -> "Maribank — how much?" (blocks on the MISSING amount)
250 jollibee -> "₱250.00 at jollibee — which account?" (blocks on account)
the jollibee was 285 not 250 -> echoes the matched row: "jollibee, 2026-..., ₱250.00 → ₱285.00"
600 dinner maribank, 400 not mine
sent 2k from maya to gotyme, fee 10
/balance -> confirmed vs expected, per book
how much do I have -> answers with the balance; no slash command needed
maya is at 98000 -> PROPOSES an anchor; nothing is written until you tap confirm
maribank (as a reply to "which account?") -> understood as the ANSWER, not a new message
hi -> Tala answers in its own words; it only talks when there is nothing to record
/interest maya 21.48 -> records the credit and learns the rate from it
/rate -> every rate, and whether it is estimated or observed
/undo -> voids the last entry
/csv -> the whole ledger as a file

````

Then send a **receipt photo**. It should come back asking which account — a receipt carries
the amount, merchant and date but never says which card paid, so that block _is_ the
confirmation step you wanted.

**What each block proves.** Tala refuses on _missing_ fields and never on _uncertain_ ones.
Absence is a deterministic gate; "I'm 70% sure it said Jollibee" is not, and gating money on
a model's confidence is gating it on a vibe.

**Checkpoint.** `npm test` already proves the triggers work against an in-memory database
(`test/schema.test.ts`). This confirms they actually loaded into *your* Turso database — a
schema can load with its triggers silently missing if the multi-statement parse breaks:

```bash
turso db shell tala "UPDATE events SET amount_centavos = 1 WHERE id = 1"
# -> events are append-only: only voided_at, confirmed_at and settled_at may be set, once
````

If that _succeeds_, the schema did not load its triggers — re-run step 1. That guard is the
only thing standing between one late-night `UPDATE` and a broken invariant nothing detects.

Clean up your test rows before going live (this is the one moment it is safe to):

```bash
turso db shell tala "DROP TRIGGER events_no_delete; DELETE FROM events; DELETE FROM inbox; DELETE FROM snapshots;"
turso db shell tala "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only: void it, do not delete it'); END;"
```

---

## 5. Render — deploy

```bash
gh repo create tala --private --source=. --push
# or create the repo in the browser and push
```

Then in the Render dashboard:

1. **New → Web Service**, connect the repo. `render.yaml` supplies runtime, region
   (Singapore — Render has no PH region), build and start commands, and the health check.
2. **Environment → Add** all five variables. They are marked `sync: false` in `render.yaml`
   precisely so they never live in git.
3. Deploy, and watch the log for `polling from offset 1` and `health on <port>`.

**Two things to know about this free tier.** Keeping one service alive 24/7 consumes about
730 of your account's 750 free instance-hours a month — so **this is the only Render free
service you can run continuously.** And Render's own cron jobs are paid, which is why the
daily line is an in-process scheduler and the backup lives in GitHub Actions.

---

## 6. Keep-alive ping

Render free spins the service down after 15 minutes idle, with a cold start of roughly a
minute. Point any external pinger at the health endpoint every 10 minutes:

```
https://<your-service>.onrender.com/healthz
```

**cron-job.org** is the simplest (free, no card). UptimeRobot works. So does a GitHub
Actions cron if you would rather keep everything in one place.

That endpoint returns the literal string `ok` and touches nothing — no database, no
Telegram. Every other path is a bare 404. That is the whole reason Tala long-polls instead
of using a webhook: you need a public endpoint for this ping anyway, and this way there is no
URL anyone can POST a forged `correction` to.

**Checkpoint.** `curl -s https://<your-service>.onrender.com/healthz` → `ok`, and
`curl -s -o /dev/null -w '%{http_code}' https://<your-service>.onrender.com/` → `404`.

If the service is asleep when you send a message, nothing is lost: Telegram holds updates
for about 24 hours and the next poll drains them. A webhook would retry with backoff and
then discard — you would keep typing expenses that were never recorded.

---

## 7. Backups, and one restore drill

Turso's free point-in-time recovery is **one day**. That is your entire safety margin unless
you keep copies elsewhere.

```bash
age-keygen -o tala-backup.key
# prints:  Public key: age1xxxxxxxx...
```

Put the **identity file** (`tala-backup.key`) in your password manager _and print a copy_. A
backup you cannot decrypt is not a backup, and this is the one key with no recovery path.

Add three repo secrets under **Settings → Secrets and variables → Actions**:

```
TURSO_URL         same as Render
TURSO_TOKEN       same as Render
AGE_PUBLIC_KEY    the age1... public key
```

Run it once by hand: **Actions → backup → Run workflow**. It should commit
`backup/ledger.sql.age`.

It runs in Actions rather than on your Mac deliberately. The obvious plan — a nightly dump on
the laptop — means a fortnight with the lid closed leaves the ledger with zero recoverable
copies, because the one-day window expired. The daily commit is also the repo activity that
stops GitHub auto-disabling the schedule.

### The restore drill — do this once, after your first real month

An untested backup is not a backup. Ten minutes, once.

```bash
age -d -i tala-backup.key backup/ledger.sql.age > /tmp/tala.sql
sqlite3 /tmp/tala.db < /tmp/tala.sql
sqlite3 /tmp/tala.db "SELECT COUNT(*), SUM(amount_centavos) FROM events WHERE voided_at IS NULL;"
tail -1 /tmp/tala.sql     # the dump's own verify line
```

The two figures must match. That dump is plain SQL and imports into any `sqlite3`, so it is
simultaneously your recovery and your exit from Turso.

---

## 8. Anchor your balances

Open each banking app, read the balance, and type it. One account at a time — a six-app
biometric tour in one sitting is exactly what gets skipped in month three.

```
/snap maya 98000
/snap maribank 12850
/snap gcash 340
/snap bdo 2100
/snap cash 1500
/snap gotyme 85000
```

Two habits worth forming now:

**Sweep the wallets first.** Move anything idle in the Maya and GoTyme _wallets_ into savings
before reading the balance. Float left in a wallet produces no drift at all — the savings pot
ties perfectly — so it is a silent permanent understatement rather than a detectable error.

**Type it, never screenshot it.** The anchor is the one number the entire design trusts
unconditionally, so `/snap` is parsed deterministically with no LLM call. An image never
becomes a snapshot.

From the second month on, `/snap` also reports **drift** — the gap between what your bank
says and what Tala derived — and asks you to tag it (a fee / spending I forgot / interest /
don't know). Answer it while you are still inside the banking app. That tag is the whole
value of the number: untagged, a duplicate row, a ₱10 InstaPay fee, a missing transfer leg
and "I forgot to log things" are mathematically identical.

---

## 9. The Maya check — settles the seed

One screen, once. Maya's T&C reads as though interest posts net of tax, but their monthly
Statement of Account itemises interest and withholding tax separately — and Maribank has
already shown one bank can present the same money two ways in two views.

Open **Maya → Maya Savings → transaction history** and read yesterday's interest total:

| What you see                                 | What it means                                                   |
| -------------------------------------------- | --------------------------------------------------------------- |
| **~₱21.48** across two rows, no tax debit    | Confirmed. The seeded `0.08` is right. Nothing to do.           |
| **~₱26.85** plus a separate ~₱5.37 tax debit | The feed is gross. Set Maya's rate to `0.10`.                   |
| **~₱27.92**                                  | The 10% stacks _on top_ of base — 13% gross. Set it to `0.104`. |
| **~₱6.44**, one row only                     | The boost lapsed this month. Set `0.024` and check your spend.  |

Whatever it says, set it from the chat — no SQL:

```
/rate maya 10% gross     # the number on their website; stores 0.08 net
/rate maya 8% net        # what actually lands; stores 0.08
/rate                    # see every rate and where it came from
```

The basis word is required. Both banks advertise gross and credit net, so a bare
`/rate maya 10%` is refused rather than guessed — that missing word is a 25% error on every
projection the pot ever makes.

Expect **two** credit rows a day on Maya — base and boost post separately (₱6.44 + ₱15.04 at
a ₱98,000 balance). Tala sums same-day interest rows before learning a rate, because a
learner that reads them as two separate days converges on 2.4% or 5.6% from a perfectly
correct 8% seed.

Honestly, though: the seed barely matters. Both pots credit **daily**, so the moment you
report one real credit the learner takes over:

```
/interest maya 21.48
   -> +₱21.48 interest · Maya Savings · 3d since 2026-09-01
      rate learned: 8.02% net (was 8.00%)
```

`rate_source` flips from `seeded_net` to `observed`, the `(est)` marker clears from
`/balance`, and the number is now derived from your actual account rather than from anything
written here. Do it twice in the first few days — the learner wants two observations before
it moves — and the seed stops mattering permanently, including when Maya changes the rate on
you in March.

If a reported credit implies something wild (a ₱5 residual on a ₱50 average balance implies
120% p.a.), it is refused and the old rate is kept, with the reason stated. A _lapsed boost_
is not wild, though — a drop to 2.4% is accepted as real, because that is what actually
happened.

---

## 10. The security sitting

No code in Tala can mitigate any of this, and the first item is the most exposed copy of
your ledger.

- **Telegram two-step verification**, with a recovery email **not** on your PH number. Then
  Settings → Devices → terminate every other session. Telegram login is SMS-first, and
  regular chats are not end-to-end encrypted: Telegram Cloud holds every amount and merchant
  in plaintext, permanently. That is the real exposure here, not the database.
- **Notification previews off** for the bot chat. A lock screen on a hallway table is the
  single highest-probability leak in the whole threat model.
- **FileVault on**, and `.env` is already gitignored — confirm before your first commit.
- **Never forward bank SMS** to the bot.
- **Initials in notes, never full names.** `shared_amount` exists because you front money
  for groups, and that consent is not yours to give.
- **Clear History monthly.** Turso plus the encrypted dump is the system of record; the chat
  is only transport.

Realistic severity, stated plainly: nothing in this data can move money. It is read-only
intelligence. But leaked merchant and balance detail is exactly the targeting material for
the social-engineering attacks that _do_ move money on PH e-wallets.

---

## Living with it

**Daily**, at Manila midnight, the bot sends one line: six balances plus anchor age and any
broken-transfer count. Its job is not insight — it is latency. It cuts the window in which an
error is still attributable from thirty days to one, which is the difference between "that
was the Grab ride" and an unexplained ₱430 adjustment next month.

It is also its own dead-man switch. **A daily message that stops arriving is the alarm** —
which is why there is no external watchdog to configure.

**Monthly**, `/snap` all six, answer the drift question, and report the interest each earning
pot credited.

---

## Troubleshooting

| Symptom                                               | Cause and fix                                                                                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot silent, Render log shows nothing                  | Service spun down and the pinger is not hitting `/healthz`. Check step 6.                                                                                                                                                              |
| `missing env: X` on boot                              | That variable is unset on Render. All five are required; there is no default.                                                                                                                                                          |
| Bot silent, log says `ignored update from N`          | `OWNER_CHAT_ID` does not match. Set it to `N`.                                                                                                                                                                                         |
| `model_not_found` from Groq                           | Free lineup rotated. Pick a current vision model and change `MODEL` in `src/extract.ts`.                                                                                                                                               |
| "Saved your message but couldn't read it yet"         | Groq is down or the daily quota is gone. **Nothing is lost** — the row is in `inbox` with status `deferred` and retries every minute.                                                                                                  |
| Balance disagrees with the app by ~one day's interest | Expected. Interest is attributed to the day earned, not the day posted. See the ceilings list in the README.                                                                                                                           |
| Balance disagrees by a lot                            | That is drift, and it is the point. `/snap` and read the number.                                                                                                                                                                       |
| `/balance` shows `(est)`                              | The rate is still seeded, not learned. Report one real interest credit.                                                                                                                                                                |
| `1 broken transfer` in `/balance`                     | One leg of a transfer is missing. Find it: `turso db shell tala "SELECT transfer_id, COUNT(*), SUM(amount_centavos) FROM events WHERE transfer_id IS NOT NULL GROUP BY transfer_id HAVING COUNT(*) != 2 OR SUM(amount_centavos) != 0"` |
| "that period is already reconciled"                   | You tried to void a row an anchor already covers. Correct it instead — voiding it would change a balance that was already reconciled.                                                                                                  |
| A correction hit the wrong row                        | `/undo` reverses the last entry, then correct again naming the old amount _and_ the merchant.                                                                                                                                          |
| Adding a seventh account                              | `/account add seabank personal bank SeaBank`, then `/rate seabank 4% gross`. No SQL and no redeploy — the extractor's account enum is read from the table at request time.                                                             |

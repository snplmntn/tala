# Tala

A single-user Telegram expense ledger. Philippine pesos, Asia/Manila, ₱0/month.

_Talâ_ is Tagalog for a recorded entry, and also the evening star.

```
you  250 jollibee maribank
bot  ₱250.00 · jollibee · Maribank · food          [✏️ fix] [🗑 void] [✓ ok]

you  /balance
bot  personal
       Maya Savings    ₱98,564.16   3d (est)
       Maribank        ₱12,856.97   3d
       GCash              ₱340.00   3d
       BDO Pay          ₱2,100.00   3d
       Cash             ₱1,500.00   3d
       expected       ₱115,383.61
     business
       GoTyme          ₱85,000.00   3d
       expected        ₱85,000.00
```

**[GUIDE.md](GUIDE.md)** — how to actually live with it: what to type, what the answers mean,
and the one habit that makes the numbers true.
**[SETUP.md](SETUP.md)** — one sitting, about 40 minutes, every service a free tier.
Below is why it is built this way.

## The one thing to understand

Everything here reduces to a single identity:

```
snapshot(n) + events in (n, n+1] = snapshot(n+1)
```

Exactly, in integer centavos. You anchor a real balance read off your banking app; every
logged event moves the derived figure; at the next anchor the gap is written as a visible
`adjustment` row. **That gap is the product.** If you log well it is ₱0 and you can trust
the number. If it is ₱3,000, you leaked spending somewhere and now you know.

The catch, and the reason the design looks the way it does: the adjustment row is _defined_
as the remainder, so the books always tie. They can never fail and can never warn. That is
why `test/ledger.test.ts` exists and why it is the only test — it is the one thing that can
falsify the identity, and every other guard is unverified without it.

Two numbers, and the distinction matters:

- **confirmed** — what the bank has actually credited. Should match your app to the centavo.
- **expected** — confirmed plus today's uncredited interest slice.

## Design decisions worth knowing before you change anything

**The LLM never sees a balance and never produces one.** It converts one sentence into a
typed event and stops. Amounts come back as _strings_ and are parsed by `parseAmount`, so a
misread digit is a rejected message rather than a wrong balance. All arithmetic lives in
`src/ledger.ts`, which is pure — the whole ledger is testable without an API key or a
database.

**Money is integer centavos everywhere.** A float peso column drifts, and the drift lands
in the adjustment row where it reads as unlogged spending.

**Events are append-only, enforced by SQLite triggers, not by convention.** The one
permitted mutation is a `NULL → value` transition on `voided_at`, `confirmed_at` or
`settled_at`. A `DELETE` raises. One `UPDATE` from a shell at 1am would otherwise break the
only invariant with nothing detecting it.

**Corrections are full supersedes, never deltas.** A correction row carries `corrects_id`
pointing at the root plus the complete corrected payload; the effective row is the highest
id in the chain. That makes a replayed correction a no-op, so no dedupe logic exists
anywhere — and a delta would silently turn ₱285 into ₱320 on a retry.

**Talk to it; the slash commands are a shortcut, not the interface.** Logging, transfers,
corrections and questions all work in prose — `250 jollibee maribank`, `sent 2k to gotyme`,
`the jollibee was 285 not 250`, `how much do I have`. The extractor classifies the intent
and read-only questions route straight to the same handler `/balance` uses.

The one exception is **anchoring a balance**, which prose may only _propose_:

```
you  maya is at 98,000
bot  Anchor Maya Savings at ₱98,000.00 as of 2026-09-03?   [✓ anchor it] [✗ cancel]
```

Nothing is written until the tap. The anchor is the one number the whole design trusts
unconditionally, so a misparse would write a garbage baseline _and_ the phantom adjustment
row that follows from it, and every later balance would inherit both. Typing
`/snap maya 98000` skips the confirmation, because a typed command is already deliberate.

**Blocking happens on missing fields, never on uncertain values.** You cannot write a row
without an amount and an account, so absence is a real gate. "I'm 70% sure it said Jollibee"
is not, and gating money on a model's confidence is gating it on a vibe. This falls out into
the right UX with no special-casing: a text message with an amount saves instantly, while a
receipt — which never says which card paid — always blocks and asks, which _is_ the confirm
step.

**Pending rows always count.** `confirmed_at` is presentational and the 24-hour settle
changes no arithmetic. Excluding pending rows anywhere would make an Aug 31 23:00 expense
appear in the August recap on Sep 2 but not on Sep 1 — a number changing with no edit.

**Interest accrues daily and is never a cron job.** Both tracked pots credit daily, so the
fold runs on read from the anchor to _yesterday_ — today's interest is credited tomorrow, so
accruing through yesterday is exactly the confirmed portion. There is no `credits_daily`
column and no month-close event, because GoTyme was the only monthly-crediting pot and its
interest is no longer tracked.

**Rates are net, and then learned.** Both banks advertise gross and credit net (Maya T&C
4.6, MariBank help article 10070), and the PH withholds 20% final tax at source with no
de minimis floor for interest. So seeds are `advertised × 0.80`, and reporting one real
credit replaces the seed permanently:

```
/interest maya 21.48     -> rate learned: 8.02% net (was 8.00%)
/rate                    -> see every rate and where it came from
/rate maya 10% gross     -> set one by hand (the basis word is required)
```

Accounts live in rows too, so opening one is a chat command rather than a deploy — the
closed set handed to the extractor is `SELECT id FROM accounts WHERE active`, read at
request time:

```
/account                                    list them, closed ones included
/account add seabank personal bank SeaBank  opens it, untracked
/rate seabank 4% gross                      then set the rate, basis word required
/account off gcash                          closes it; history stays, enum drops it
```

Closing is never a delete: events reference accounts, so a delete would fail on the foreign
key or orphan history. Rates live in `accounts` rows, never in code — nothing here is a constant. The learner needs
two observations and refuses a result outside `[0, 2 × rate_seed]`, keeping the good seed
and saying why rather than writing an authoritative wrong number. `rate_seed` is the stable
band and the learner never rewrites it: guarding against the live rate would be a one-way
ratchet, where a lapsed Maya boost drops the rate to 2.4% and the boost returning at 8%
then exceeds twice the new reference and is rejected forever.

## Ceilings — deliberate shortcuts and where they break

- **Every tracked earning pot credits daily.** A future monthly-crediting account needs a
  `credits_daily` column on `accounts` and a confirm-at-close path. Column add, not a
  migration of history.
- **Interest is attributed to the day it is earned, not the day it posts.** A single day's
  boundary can differ from the app by one day's interest (~₱21 on Maya). Model the post lag
  only if a snapshot disagrees by exactly that.
- **Intra-provider shuffles are not logged.** Moving ₱2,000 from savings to wallet for ten
  days mis-attributes about ₱1.64. Revisit if you start moving six figures around.
- **Maya's boost re-qualifies monthly** on ₱25,000 of qualifying spend, and applies to the
  first ₱100,000 only. `rate_floor` (0.024) is where it lands when a month is missed — the
  learner accepts that drop as real, not as an error.
- **GoTyme's real interest surfaces as tagged positive drift**, roughly ₱170/month. Positive
  drift on an account with no logged spending is unambiguously interest. Once the company
  actually spends from GoTyme that stops being true, and turning projection back on is one
  `UPDATE` on the accounts row.
- **Cashback is seeded at 0 and only ever learned.** PH cashback is mostly vouchers, coins
  and points, so a projected _peso_ would never be trued up by a cash credit and `expected`
  would climb forever with reconciliation blaming you.
- **Five years is ~10,000 rows and single-digit megabytes.** No archival, no partitioning,
  no rollup tables. This sentence exists to pre-kill them.
- **Turso stays because a switch costs ~400 lines and buys nothing** — not because it is the
  safest provider. It has lost free-tier data once (Dec 2023: cross-tenant leak plus ~3 days
  of writes, on the fly.io architecture since retired), its free plan blocks READS as well as
  writes if any single metric is exceeded, and it has cut free-tier allowances twice — once
  unannounced. At 0.2% of the storage quota per year none of that is reachable, and the daily
  encrypted dump is a better durability story than any provider's promises. **Flip
  conditions:** another cut → pay $4.99 (10-day PITR, no archiving) rather than migrate;
  libSQL announced as retiring from Turso Cloud → migrate to **Neon**, not Supabase; a second
  consumer of this data (a phone app, a dashboard) → then and only then does Postgres with
  RLS buy something instead of relocating the risk.

## Deploy

Everything below is a free tier with no card required except Render, which asks for one only
for paid plans.

```bash
# 1. Turso — libSQL, so schema.sql and the triggers work unchanged.
#    Chosen over Render's own Postgres because a free Render Postgres is DELETED
#    30 days after creation.
turso db create tala
turso db shell tala < schema.sql
turso db show tala --url          # -> TURSO_URL
turso db tokens create tala       # -> TURSO_TOKEN

# 2. Groq — free tier, no card. qwen/qwen3.8-27b does text AND vision with strict
#    JSON schema, and its Services Agreement 4.2 forbids training on your inputs.
#    console.groq.com/keys        # -> GROQ_API_KEY

# 3. BotFather — /newbot, then /setjoingroups disable. Keep the description empty.
#                                 # -> TELEGRAM_TOKEN
#    Message the bot once and read the chat id from the logs, or use @userinfobot.
#                                 # -> OWNER_CHAT_ID

# 4. Render — connect the repo. render.yaml has the rest. Set the five env vars.

# 5. Keep-alive. Render free spins down after 15 minutes idle, and Render's own cron is
#    paid, so point an external pinger at https://<service>.onrender.com/healthz every
#    10 minutes (cron-job.org, UptimeRobot, or a GitHub Actions cron).

# 6. Backup. Add repo secrets TURSO_URL, TURSO_TOKEN and AGE_PUBLIC_KEY.
age-keygen -o tala-backup.key     # keep the identity in your password manager
                                  # AND print a copy — a backup you cannot decrypt is not one
```

Then anchor your balances once, one at a time:

```
/snap maya 98000
/snap maribank 12850
/snap gcash 340
/snap bdo 2100
/snap cash 1500
/snap gotyme 85000
```

## The one-hour sitting, before you trust it with anything

No code in Tala can mitigate these, and one of them is the most exposed copy of your ledger.

- **Telegram two-step verification**, with a recovery email _not_ on your PH number, then
  terminate every other session. Telegram login is SMS-first, and regular chats are not
  end-to-end encrypted — Telegram Cloud holds every amount and merchant in plaintext,
  permanently. That is the real threat here, not the database.
- **Notification previews off** for the bot chat. A lock screen on a hallway table is the
  highest-probability leak in the whole model.
- **Never forward bank SMS** to the bot. Type the amount. An image never becomes a snapshot.
- **Initials in notes, never full names.** `shared_amount` exists because you front money
  for groups, and that consent is not yours to give.
- **Clear History monthly.** Turso plus the encrypted dump is the system of record; the chat
  is only transport.

Realistic severity, stated honestly: nothing here can move money. It is read-only
intelligence. But leaked merchant and balance detail is exactly the targeting material for
the social-engineering attacks that _do_ move money on PH e-wallets.

## Verify

```bash
npm test         # 49 asserts across 2 files, node --test, no framework
npm run typecheck
npm run format
npm run chat     # talk to a local SQLite copy — no Telegram, no bot token, no deploy
```

## Restore drill — do this once, after the first real month

An untested backup is not a backup.

```bash
age -d -i tala-backup.key backup/ledger.sql.age > /tmp/tala.sql
sqlite3 /tmp/tala.db < /tmp/tala.sql
sqlite3 /tmp/tala.db "SELECT COUNT(*), SUM(amount_centavos) FROM events WHERE voided_at IS NULL;"
tail -1 /tmp/tala.sql   # the dump's own verify line — the two must match
```

## Layout

```
schema.sql          the ledger, the triggers, and the seeded accounts
src/ledger.ts       PURE. money, Manila dates, the accrual fold, drift, the rate learner
src/db.ts           Turso. every atomic multi-row write goes through batch()
src/extract.ts      the only place the LLM lives. one fetch, strict JSON schema
src/telegram.ts     transport. the bot token never leaves this file
src/handlers.ts     typed events in, rows out — plus COMMANDS, the one command table
                    that drives /help, Telegram's "/" menu, and both dispatchers
src/index.ts        long-poll loop, Manila-midnight scheduler, /healthz
scripts/chat.ts     terminal REPL against a local SQLite file — the fast dev loop
scripts/backup.ts   portable SQL dump — the backup and the exit from Turso
test/ledger.test.ts the identity, and the only thing that can falsify it
test/schema.test.ts the append-only triggers, against a real in-memory database
```

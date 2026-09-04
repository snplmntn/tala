# Living with Tala

This is the day-to-day guide: what to type, what the answers mean, and the one habit that
makes the numbers true. [SETUP.md](SETUP.md) is how you get it running; [README.md](README.md)
is why it is built the way it is.

---

## The first five minutes

Message the bot. It will introduce itself and ask what to call you.

```
/name Sean
```

Then tell it what each account actually holds **right now**, one at a time. Open your banking
app, read the number, send it:

```
maya 102940.25
gcash 1197
```

Each one comes back as a question with two buttons. Tap **✓ anchor it**. That is the whole
setup.

```
/account            see your accounts, add or close one
/rate maya 8% net   only if a pot earns interest
```

---

## The one concept: an anchor

**An anchor is a real balance, read off your banking app, on a date.** Everything else is
counted forward from it.

Tala never talks to your bank. It cannot. So it keeps two different kinds of number and is
careful never to confuse them:

|             | what it is                       | where it comes from  |
| ----------- | -------------------------------- | -------------------- |
| **anchor**  | ₱102,940.25 in Maya on 3 Sep     | you, reading the app |
| **balance** | anchor + everything logged since | arithmetic           |

An account with no anchor has **no balance** — only a running total of what you have logged.
That is why a fresh account shows `not anchored · ₱250.00 logged` rather than `-₱250.00`.
Saying "you have minus ₱250" would be a lie; "₱250 has left, from a starting point nobody
has told me" is the truth.

**So: re-anchor every few weeks.** The daily line nudges you once your oldest anchor passes
28 days. It is the only chore, and it takes ten seconds:

```
maribank 32330
```

---

## Logging money

Just say it. No format, no keywords, no slash command.

```
250 jollibee maribank
```

> ₱250.00 · jollibee · Maribank · food

Several things at once, one message:

```
jeep 15, load 50, lunch 90 gcash
```

> three separate rows

You fronted for other people:

```
600 dinner maribank, 400 not mine
```

> ₱600.00 · dinner · Maribank · food · ₱400.00 not yours

The ₱400 stays on your balance (you really did pay it) but is tracked as owed to you. `/owed`
lists what has not come back.

Moving your own money between your own accounts:

```
sent 2k from maya to gotyme, fee 10
```

> a transfer, not spending — your net worth did not change

`transfer all of my gcash to maribank` needs no figure: the amount is whatever GCash stands
at in the books, and the reply says so — check it against the app, because it is Tala's count
and not a reading. If the fee only surfaces after you send it, reply `fee 10` on its own and
it attaches to the transfer you just logged (`fee 0` if there was none).

A receipt photo works too. It reads the merchant, the date and the total, then asks which
account paid — no receipt on earth says which card was used.

### Opening an account

Tell it in words — _"open a beep card account"_, _"start tracking my BPI"_ — and it asks the one
thing it cannot infer:

> Open Beep Card as a personal account — what kind is it?
> `bank` `ewallet` `cash` `credit`

One tap and it exists, with the id derived from the name (`beepcard`). It starts untracked and
un-anchored, so follow with `/snap beepcard 21` to give it a balance and `/rate beepcard 4% gross`
if it earns. `/account off beepcard` closes it again and keeps the history.

### What it will refuse to guess

If you do not say which account, it asks. If you do not say how much, it asks. It will never
pick for you: a misfiled expense is invisible until reconciliation, and then it looks exactly
like money you forgot to log.

Amounts in another currency come back as a question too. `$20 for cursor` cannot become pesos
without knowing what your card was actually charged, and Tala does not know that.

---

## Fixing things

Say what was wrong, in words:

```
the jollibee was 285 not 250
that was gcash not maya
```

Or use the buttons under any row: **✏️ fix**, **🗑 void**, **✓ confirm**.

**✓ confirm** answers with what is left in that account, which is the reason to tap it: the
echo above still has live buttons, so its figure is provisional until you settle the entry.
Anything you never tap confirms itself at 08:00 the next morning, and the daily line says how
many it closed.

**🗑 void** removes every row the entry wrote, not just one. A late entry is a pair and a
transfer is two legs plus a fee, so voiding half of either would move a balance that is
supposed to stay still.

`/undo` voids the last thing you logged, the same way.

Every reply that moved money ends with what is left in the account it moved. An account you
have never anchored has no balance to state, only a running total from an unknown starting
point, so it asks you to anchor it instead of inventing a figure.

Nothing is ever deleted or overwritten. A correction writes a new row that supersedes the old
one, and the database physically refuses an UPDATE or a DELETE on a money row. What you see
is always the latest version; what happened is always still there.

---

## Asking questions

You can type these as commands or just say them.

| you say                            | you get                           |
| ---------------------------------- | --------------------------------- |
| `/balance` or "how much do I have" | every account, per book           |
| `/recap` or "what did I spend"     | today, itemised                   |
| `/recap week`                      | Monday to today, grouped by day   |
| `/recap month` or `/recap 2026-08` | a whole month, by category        |
| `/recap last month`                | the previous month                |
| `/recap business`                  | the business books instead        |
| `/owed` or "who owes me"           | money you fronted                 |
| `/csv`                             | the whole ledger as a spreadsheet |

### Reading `/recap`

```
/recap                  today, itemised          ← the default
/recap yesterday        yesterday, itemised
/recap 3 days ago       counting back from today
/recap last tuesday     the most recent Tuesday before today
/recap sep 1            a day by name, this year or last, whichever already happened
/recap 2026-09-03       one particular day
/recap week             Monday to today, grouped by day with a subtotal each
/recap last week        the whole previous week
/recap month            this month, by category
/recap last month       the previous month
/recap 2026-08          a past month, by category
/recap month list       a month as individual rows instead
/recap business         today, business books
/recap month business   the business month, by category
```

**The recap answers for one set of books at a time.** It defaults to personal, and `business`
anywhere in the argument switches it. Spoken, you never type the word: naming an account does
it, so "what did gotyme spend this month" reads the business books because GoTyme is a
business account. Mixing the two would make every total answer a question nobody asked.

**Any day you can put on a purchase, you can recap.** "last tuesday", "3 days ago" and
"sep 1" mean the same thing whether you are dating an expense or asking for a day's rows —
one grammar, so there is nothing to remember twice. A date it cannot read is refused by name
rather than answered for today.

**The window decides the shape, not a flag.** A day is a handful of rows, so the rows _are_
the recap — category totals over three items summarise something you can already see. A month
is hundreds of rows, so categories are the only readable form. `list` overrides it when you
want the rows anyway, capped at 40 with a `/csv` pointer.

**A week starts on Monday** and runs to today, not to Sunday — days that have not happened
are not a recap. It crosses a month boundary happily: on Thursday 3 September the week opened
on Monday 31 August, and those two days of August are in it.

**Voided rows never appear**, in any window, and a corrected row appears once at its
corrected amount — never as both the old and the new figure. `/csv` is the exception, on
purpose: it is the audit trail and the exit path, so it keeps everything and carries a
`voided` column you can filter on.

**A shared expense counts only your share**, with the rest named on the line, because that is
why the number differs from the receipt in your pocket.

**Spending you log after anchoring still counts as today.** An anchor you read this morning
already contains today's spending, so a same-day expense is dated _tomorrow_ in the ledger —
otherwise it would net against the figure you just typed and freeze your balance for the day.
A recap undoes that: a row dated after the day you typed it can only have been pushed there
by the anchor rule, so it reports on the day you typed it. Balances still count it on its own
date, and no row is ever counted in two windows.

### Reading `/balance`

```
personal
  Maya Savings   ₱102,940.25   today (est)
  Maribank        ₱32,330.00   4d
  BDO Pay        not anchored   nothing logged yet
  expected       ₱136,491.66
  excludes 1 un-anchored: bdo — /snap bdo <amount>
```

- **`today` / `4d`** — how old that account's anchor is. Older means less certain.
- **`(est)`** — the interest rate is still a guess. Report one real credit with
  `/interest maya 21.48` and it learns the true rate from the arithmetic.
- **`expected`** — confirmed balances plus interest that has accrued today but has not been
  credited yet.
- **`excludes …`** — accounts with no anchor are left out of the total entirely, and it says
  so. A total that quietly omits things is worse than one that admits it.

---

## The daily line

Every morning at 08:00, Manila time, Tala sends you the day's balances unprompted, and opens
with how many untapped entries it confirmed overnight.

It used to arrive at midnight, which is a notification you sleep through and read at
breakfast anyway. Now it arrives when you read it. It is also why the overnight close-out is
at 08:00 rather than midnight: an entry logged at 23:50 gets a night, not ten minutes.

This is not a notification, it is the error-detection loop. Without it, a wrong account or a
missing transfer leg stays invisible until month end — by which point you cannot remember the
transactions well enough to say what went wrong. Seeing it the next morning, you can.

**It is also the dead-man switch.** A daily message that stops arriving _is_ the alarm that
something is down. Nothing else monitors it, on purpose.

If the service was down when 08:00 passed, the line arrives late and says so
(`late, no daily line for 2d`) rather than being skipped — and anything that came due in
those days comes with it. The catch-up window is a month; older than that is history, not a
nudge.

---

## Reminders

Anything you want said back to you on a given day. Not financial — the Maya boost is just
one row in the list.

```
/remind 15 renew the domain              once, on the next 15th
/remind every 25 internet bill           the 25th, every month
/remind every eom boost maya             the last day of every month
/remind every som review subscriptions   the 1st of every month
/remind every fri water the plants       every Friday
/remind 25 17:00 pay the bill            the 25th, at 17:00, to the minute
/remind every mon 9:30pm meds            every Monday at 21:30
/remind                                  list them, numbered, with the next date
/remind off 2                            drop one
```

**One-off is the default.** A reminder fires once and retires itself; `every` is how you ask
for the repeat. For a day of the month that means monthly, for a weekday it means weekly.

**`eom` is not the same as `31`.** It means the last day, whatever the month's length is. A
day number past the end of a month clamps down to the last day rather than not firing, so a
reminder set for the 31st still arrives on 28 February — month-end is the deadline people
actually set reminders for, and silently skipping five months a year would land on the one
that mattered most.

**A time is optional, and it changes which carrier delivers it.** With no time, a reminder
rides the daily line and lands at 08:00 in Manila — right for anything you act on when you
sit down. Name a time (`17:00`, `9:30pm`, `9am`) and it arrives on its own, within a minute
of the moment, because a bill that closes at 17:00 does not care what you read at breakfast.
A bare number stays part of the text, so `/remind 25 9 internet bill` is about "9 internet
bill" and not 09:00 — a time has to look like one.

Missing the moment does not lose it: the check runs every minute against a stored marker, so
a service that was down at 21:00 sends at 21:04. If a deadline is the last day of the month,
set the reminder a few days earlier anyway — arriving on the deadline is arriving on your
last chance.

### The Maya boost

This is what the feature got built for. Maya's boosted rate re-qualifies every calendar month
on qualifying spend, and lapses back to the base rate if you miss it:

```
/remind every 25 boost maya - check qualifying spend in the app
```

Tala does **not** track your qualifying spend. It cannot: it does not know which of your
transactions Maya counts, and a progress bar that says "you're qualified" when you are not is
worse than no progress bar in an app whose whole thesis is that an untagged number misleads.

It does handle the lapse correctly after the fact. `rate_floor` for Maya is already 0.024
(your 3% gross, less the 20% withholding), and the rate learner accepts a drop to the floor
as real rather than as a data error — so report a credit or two after a missed month and the
projections follow you down without being told.

---

## Reconciling, and what drift means

When you re-anchor an account that already had one, Tala compares what it expected with what
you just typed. If they differ, that gap is **drift**, and it gets written as an adjustment
row and shown to you:

```
Maribank anchored at ₱32,330.00 as of 2026-09-17
drift -₱430.00 over 14 days

What was it? Untagged, this number cannot be told apart from forgotten spending.
[a fee] [spending I forgot] [interest] [don't know]
```

**Tag it.** Untagged, a duplicate row, a ₱10 InstaPay fee, a missing transfer leg, a typo and
"I forgot to log a week of jeepney rides" are mathematically identical — and the number stops
telling you anything. Tagged, drift is the most useful signal in the app: it tells you which
habit is leaking.

`don't know` is a legitimate answer. It is still better than an untagged number.

---

## Interest

If a pot earns interest, report the real credit when you see it in the app:

```
/interest maya 21.48                 today's credit
/interest maya 21.48 yesterday       catching up
/interest maya 21.48 2026-09-02      or an exact day
```

Or just say it: **"maya credited 21.48"**, **"got 8 pesos interest on maribank yesterday"**.

Tala works backwards from the credit and the balance it was earned on to learn the actual
rate, so projections stop being a guess. Each credit is divided by **its own period** — from
the last credit you reported up to this one — so reporting daily teaches a daily rate and
reporting once a month teaches a monthly one. Two readings are required before the rate
moves, because one period can be partial.

It does not matter whether you `/snap` before or after reporting the credit. The opening
balance is taken from the anchor _before_ the credit's date, because an anchor read on the
day a credit posted already contains that credit.

Got the number wrong? Say so, and the rate re-learns from the corrected figure:

```
the maya interest was 22.10 not 21.48
```

### What have I earned?

```
/interest
```

Every credit you have reported, per account, with a subtotal each and a total at the bottom.
Corrected credits count once, at the corrected amount; voided ones do not count at all.

Set a rate manually with `/rate maya 10% gross` — the word **gross** or **net** is required,
never assumed, because the two differ by the 20% withholding tax and that is a 25% error on
every projection the account will ever make.

> One overlap to know about: if you `/snap` **before** reporting a credit, the drift row from
> that snapshot has already absorbed it. Reporting it afterwards would count the money twice,
> so Tala says so and you can `/undo`. Either report the credit first, or tag the drift as
> `interest` and skip the report.

---

## Month end

```
/recap month
```

Nothing else is required. There is no close, no lock, no ritual — the ledger is append-only,
so last month cannot change under you.

Worth doing once a month:

- Re-anchor everything, so drift is measured over weeks rather than months.
- `/owed`, and chase anything stale.
- `/csv`, if you want a copy outside the system.

---

## When something goes wrong

**"Saved your message but couldn't read it yet"** — the model provider is down or the daily
quota is gone. Your message is on disk and retries automatically. Nothing is lost.

**It asks which account when you already said one** — the account name has to be one it knows.
`/account` lists them. Say _"open a seabank account"_ and it adds one, or spell it out yourself
with `/account add seabank personal bank SeaBank`.

**A number looks wrong** — `/csv` shows every row including voided and superseded ones. The
ledger keeps its whole history, so the answer is always in there.

**It answers a question you did not ask** — it reads the last few turns for context, and that
context is lost when the service restarts. Say the whole thing in one message and it will be
right.

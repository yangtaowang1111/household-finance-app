# Roadmap

Agreed 2026-08-17. What gets built, in what order, and the reasoning behind the
choices — so a decision doesn't get relitigated six weeks from now, and so the
ones deliberately deferred stay deferred for a reason rather than by neglect.

This is explicitly **not a one-and-done project**. The order below reflects what
makes the app usable soonest, not a final feature set.

## Iteration 1 — the base

**Purpose: keep track of spending, budget, net worth and investments.** Nothing
else ships until those four work end to end.

| | Status |
|---|---|
| Overview (net worth, cash flow, spending breakdown) | Done |
| Transactions (list, filters, recategorise, rules) | Done |
| **Budget baselines from history** | Next |
| **Budget vs actual, by month and YTD** | Next |
| Accounts | Not started |
| Investments | Not started |

Then, in order:

1. **Reporting** — higher priority than retirement, by preference.
2. **Retirement** — after reporting.

Everything else below is later, and some of it is Phase 5.

## Navigation

Twelve top-level entries is too many. Grouped by the oldest distinction in
finance — money that *flows* versus money that *sits*:

```
Overview
Cash flow    → Income · Spending · Budget · Forecast
Wealth       → Accounts · Investments · Retirement · Property
Transactions
Insights     → Reports · Recurring · Tax
Goals
Rules & imports
```

Budgeting is the parent of Spending, per the original suggestion; Income sits
beside Spending for the same reason — they are two halves of one question.

## Decisions

### Retirement is an attribute, not a section

Add `accounts.tax_treatment` (`taxable` / `roth` / `traditional` / `529` /
`hsa`). The Retirement section is then a *view* over it.

Necessary because the Traditional IRA, Roth IRA and joint brokerage all sit
behind one Vanguard login and all carry `type: investment` — nothing in the data
currently distinguishes them. The field pays for itself three times: Retirement
is "treatment is not taxable", the tax view knows which accounts generate
reportable events, and forecasting knows what is reachable before 59½.

### Investment growth is never income

Settled 2026-08-17 and restated here because it will come up again. A gain
converts nothing into cash; it changes a balance. It reaches net worth through
`account_balance_snapshots` and must never touch income — which also matches how
it is taxed, since nothing is realised until sold or withdrawn.

Contributions belong to **Investments**, not Income, for the mirror-image
reason: they are outflows that stay yours.

### Budgets: one annual number, shape from history

Twelve months × 59 categories is 708 inputs and nobody would ever fill it in.
Instead: set an annual figure per category, and distribute it across months
using the shape the category actually had last year. Travel lands heavy in
summer; Groceries is flat. The tool detects which categories are genuinely
seasonal and only asks about those — most are not.

No schema change: `budgets` already keys on `(category_id, month)`, so this
writes twelve rows instead of one.

### Baselines use the median, not the mean

The data is full of one-offs that would wreck an average — a $10,000 college
fund contribution, $61,500 to Vanguard, a $78,299 equity event. One such month
in a twelve-month average adds $833/mo to a category permanently.

Each category offers three numbers, and the choice stays with the user:

| | |
|---|---|
| 2025 monthly median | the typical month |
| 2026 YTD monthly | the current run rate |
| Suggested | median, nudged toward YTD where they diverge |

**Income baselines are not reliable right now.** Tony changed jobs in July 2026,
so 2025 and early-2026 income reflect a salary that no longer applies. Spending
baselines are unaffected; income projections must wait for the new salary to
appear in the data.

### Parent budgets: derived by default, explicit means cap

Rolling children up to the parent and overriding the parent are contradictory —
if Food is capped at $2,000 while its children total $2,400, one of them has to
lose. Resolved by making the two behaviours distinct rather than picking one:

- **No budget set on the group** → it shows the **sum of its children**. The
  default, and right most of the time.
- **A budget set on the group** → that figure is a **cap**, and if the children
  exceed it the conflict is shown explicitly ("capped at $2,000, children total
  $2,400, $400 over") rather than silently resolved.

The second is the discipline worth having when reining a category in, which was
the point of asking for the override.

### Anomaly detection is deterministic; Claude explains it

Most of it needs no model at all: a first-time merchant, an amount well outside
a category's range, the same amount twice in a day, a foreign transaction. All
instant, free and more reliable than asking a model to read 2,565 rows. Claude's
value is prioritising and explaining what those rules surface.

**Fraud detection runs on the daily sync, not the monthly report.** A monthly
review is too slow to be useful against fraud — the flag has to land when the
transaction does. The monthly Claude review is a different product: trends,
budget variance, "running $310/mo above last year".

### Reimbursements offset the category when attributable

A phone-plan share coming back offsets `Mobile Phone`, so the category shows the
real out-of-pocket cost. `Income → Reimbursements` is for money that cannot be
attributed to a category. Filing attributable reimbursements as income inflates
both income and spending while leaving net worth unchanged.

Known inconsistency: 2025 has **12 transactions totalling +$10,780** under
`Income → Reimbursements`, so that year's income and spending are each
overstated by roughly 5%. Not urgent — net worth is right either way.

### Goals and Phase 5 forecasting are one engine

"Sliders to reach a retirement number" and "3–5 year what-if projection" are the
same projection model with two front-ends. Build once.

## Later

**Reporting (next after the base).** Monthly and quarterly summaries generated
in-app rather than exported and pasted — the Claude API is already wired in for
categorisation. Feed it structured summaries (cash flow, budget variance, trend
deltas, savings rate), never raw transactions: cheaper, and the analysis is
better for it. Output is analysis to consider, not instructions to follow.

**Retirement (after reporting).** Blocked on data more than on code — see gaps
below. Two decisions already taken:

- **Statements are an acceptable substitute for syncing.** Employer plans often
  cannot be linked at all; a quarterly PDF or CSV entered by hand keeps the
  balance roughly current, which is all a retirement projection needs. The
  statement importer already handles per-account files.
- **A pension is an income source, not a balance.** It needs its own shape —
  monthly amount and a start date — rather than being forced into `accounts`.

**401(k) deferrals are invisible to the ledger.** Payroll takes them from gross
pay before anything reaches a bank, so they appear in neither income nor
spending, and the savings rate is understated by exactly the amount being saved
hardest. Handled by asking: gross salary and deferral percentage are stored in
`settings` and added back on the budget screen. Two numbers a year.

**Recurring & subscriptions.** Already in the original brief's Build list and
never built. Finds forgotten subscriptions, and is the foundation Phase 5 needs:
committed cash flow cannot be projected without knowing what is committed.

**Tax view.** The data is already shaped for it — the rental was separated from
the primary home specifically for Schedule E, and mortgages are now linked to
properties. Wants `tax_treatment` to finish the picture. **Tagging has to start
before the screen exists**: data not captured in March cannot be recovered in
April.

**Goals.** The Ally accounts are already named **Emergency Fund**, **Friction
Buffer** and **Roth IRA Bridge** — the household already thinks in goals, the
app just doesn't know it. Emergency fund target to be **suggested by the app
from actual monthly spending** rather than entered by hand.

**Lower priority:** cash-flow calendar (what is due when), anomaly alerts on the
Overview.

## Data gaps

These limit what any of the above can honestly report.

| Gap | Notes |
|---|---|
| **Sophia's 401(k)** | Employer plan, not connected. May not be linkable if it is an internal recordkeeper. |
| **Tony's new 401(k)** | New employer, not yet set up. |
| **Colorado PERA pension** | From the job Tony left in July 2026. **Not an account with a balance** — it is a defined-benefit entitlement, and its worth is a future income stream. Agreed 2026-08-17: Tony runs PERA's own calculator (contributions, service term, start date, retirement date) and enters the resulting **monthly income figure** as a retirement income source. Approximate is fine — it is for planning, not reporting. It stays **out of net worth**, which should hold only what could actually be sold or spent. |
| **Sophia's Vanguard** | Two IRAs, ~$7,500 this year. Outstanding. |
| **Sophia's four cards** | No 2026 data at all; they do not sync. Ongoing, not just historical — see [project-status.md](project-status.md). |

Until the retirement accounts are connected, **net worth is understated by
whatever sits in them**, and a Retirement section would be reporting on three
IRAs while missing two employer plans and a pension. That is the reason
retirement follows reporting rather than leading it.

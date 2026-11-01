# ADR 0039: A Cost page under Platform, from one snapshot, with a hand-kept services ledger

**Status:** Accepted
**Decision date:** 2026-11-01
**Owners:** Workload owner and architecture owner

## Context

The owner asked on 2026-11-01 for a **Cost** page under **Platform** in the
admin portal: current and end-of-month costs for the Azure platform, AI costs
(subscriptions or credits remaining) and service subscriptions, organised
better if there is a better way, with alerts, the dashboard, the calendar and
Koda brought in.

Before this, cost lived in four places that did not meet:

- Three Azure budgets ([`infra/budget.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/budget.tf),
  [`infra/foundry.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/foundry.tf)) that email at thresholds and are
  otherwise read by hand in the portal, monthly, into
  [the cost analysis](../architecture/cost-analysis.md).
- The AI usage ledger (`ai_usage`), shown as the last 200 calls on the AI
  Engine's usage tab, with no month total.
- The ElevenLabs credit balance, read only before a render and on the Audio
  tab.
- Subscriptions outside Azure (domain, Cloudflare, Publer and the rest), which
  the cost analysis lists as "tracked separately" and nothing tracked.

## Purpose and decision drivers

- One place that answers "what does this cost this month, and will it go over?"
  for someone who is not a FinOps specialist.
- Cost Optimization and Operational Excellence: alerts that reach the owner
  before the money is spent, through channels already in use.
- Security: no new secret, no subscription id in the browser, least privilege
  for the read, and no widening of what the Terraform identity may grant.
- Cost of the page itself: near zero, in a workload whose whole bill is tens of
  dollars a month.

## Decision

1. **Five tabs, not three sections.** Overview, Azure, AI, Services, Alerts. The
   owner's three areas each get a tab; the overview and the alerts are tabs of
   their own because "will anything go over?" crosses all three.
2. **One snapshot document** (`admin_config/cost_snapshot`) holds the Azure and
   AI readings. The page reads it; it never calls Azure live. It is rebuilt
   every `refreshHours` (6 by default) by the armed `checkAgentHealth` timer,
   the same way the delivery monitor watch runs (no new timer to arm), and on
   the page's Refresh, throttled to once in five minutes.
3. **Azure is read with the Function App's managed identity**, two plain ARM
   calls per scope (Consumption budgets, Cost Management query), no SDK, as
   `labs/resource-graph.js` does. The scopes come from one app setting,
   `COST_SCOPES`, written by Terraform from the subscription variables. The
   end-of-month figure is the budget's own `forecastSpend` when there is one
   (so the page and the forecast alert agree), else a straight line, and the
   page says which.
4. **The role is Cost Management Reader, granted by the owner, not by
   Terraform.** It is at subscription scope, and since SEC-1 step two the
   Terraform identity creates no role assignment above a declared resource
   group (`scripts/terraform-identity-grants.test.mjs`). The owner runs the two
   commands in [the runbook](../runbooks/cost.md) once.
5. **AI costs come from what knows them**: the usage ledger's estimate per
   provider and per task for the month, ElevenLabs' reported credits, the
   app's own image budget, and the Foundry resource group's Azure budget. The
   page says plainly that the ledger is an estimate.
6. **Subscriptions outside Azure are a hand-kept ledger**
   (`admin_config/cost_ledger`), one document with ETag-guarded writes like the
   calendar alerts, with suggestions from the API-keys catalogue for vendors
   the site already uses. The ledger is read live, so edits show at once.
7. **Alerts are computed, not stored**: one pure function over the snapshot and
   the ledger, with a ladder that mirrors the Azure budgets' thresholds. They
   surface on the page, in the dashboard's Decision Center (a new `cost`
   source, editor), on Telegram once per new warning or critical alert, and in
   a monthly closing digest. Renewals are a new Calendar kind, `renewal`.
8. **Editor role.** The page is not shown to viewers. Koda reads the three GET
   routes under its existing Platform switch and none of the writes.

## Consequences and accepted risks

- The Azure tab is empty, with a sentence naming the role, until the owner
  makes the two grants. Accepted: the alternative is weakening the Terraform
  identity's boundary.
- Azure's cost data lags by up to a day, and a six-hour snapshot adds to that.
  For a budget of USD 150 against a measured USD 37 a month this is ample; the
  Refresh button covers the rest.
- Cost Management limits query rates per scope. Three scopes, three calls each,
  four times a day plus manual refreshes, is far inside them.
- The AI figures for Google, Anthropic and OpenAI are the site's estimate.
  Those providers do not expose a balance to an ordinary API key.
- The services ledger is only as good as what the owner types; its alerts make
  a stale renewal date visible rather than silent.
- Telegram is one more voice; every message is once per signal, and both the
  alerts and the digest can be switched off on the page.

## Alternatives considered

- **Cost Management exports to blob storage, read by the app.** More complete
  history, but a new export, a storage container and a schedule to maintain for
  a page that needs three numbers per scope. Rejected for now.
- **Reading Azure live on every page load.** Simpler, but slower, rate-limited,
  and wasteful for data that changes a few times a day.
- **Terraform-managed role assignments.** Rejected for the boundary reason in
  decision 4.
- **Reader instead of Cost Management Reader.** Reader would also expose every
  resource's configuration; the page needs cost data only.
- **A dedicated timer.** It would be off until the owner arms it; riding
  `checkAgentHealth` gives the same cadence with nothing to arm.
- **Putting the services list in Platform Settings' reminders sheet.** The
  sheet is for dates, not money; a ledger with prices and cycles needed its own
  shape, and renewals still reach the Calendar.

## Validation and revisit triggers

- After the owner's grant: the Azure tab's month-to-date for the application
  subscription matches Cost Management's figure for the same day within a few
  cents, and the budget card matches the budget's `currentSpend`.
- The first monthly digest arrives on Telegram on the first of the month.
- Revisit if: the workload adds subscriptions (add them to `COST_SCOPES` and
  grant the role), the bill grows enough that a six-hour lag matters, a
  provider starts exposing a balance API, or history beyond twelve months is
  needed (consider exports).

## Related decisions and references

- [ADR 0015](0015-cost-governance.md) (cost governance) and
  [the cost analysis](../architecture/cost-analysis.md)
- [ADR 0033](0033-contentforge-alignment.md) §4 (Calendar collectors) and the
  Decision Center sources
- [ADR 0038](0038-koda-admin-access.md) (Koda's admin access)
- [Cost page runbook](../runbooks/cost.md)
- [Cost Management Reader](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/management-and-governance#cost-management-reader)
  and [Understand Cost Management data](https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data),
  read 2026-11-01

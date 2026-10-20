# HCW Azure FinOps Assessment

**Status:** Measured 2026-10-03 against September 2026, the estate's first full
calendar month in `centralus` (#822): **USD 36.81** across the application and
Platform Management subscriptions. That replaces the five-day reading of
2026-08-24 and the "USD 15–20" estimate extrapolated from it. Corrected
2026-08-25 against the built estate; the pre-deployment envelope this page used
to carry described resources that were never created; see *Corrected
2026-08-25* below.

**Currency:** USD

**Budgets:** three. Two are **subscription**-scoped — USD 150 on the
application subscription (live) and USD 25 on Platform Management — and
since #849 one sits on the `rg-ai-site-prod-cus` resource group at USD 75 for
the Microsoft Foundry account (declared 2026-10-04; read live on 2026-10-20 as
`site-foundry-monthly-budget`, with its first month estimated below under
*Foundry — first measured month*). A budget alerts at its thresholds; none of
them stops spend.

> **The branch this page kept citing is gone.** Several lines here described a
> control as "declared in `fix/go-live-remediation`, **not applied**" — the
> ceiling above among them. That branch no
> longer exists on `origin` and everything it declared is on `main` in
> `infra/`; [Alerting and support](../runbooks/alerting-and-support.md) made the
> same correction on 2026-09-07. Whether a given control has reached the live
> tenant is a read against the tenant, not something this page can assert — the
> commands are on that runbook — so the lines now say "declared on `main`" and
> stop there.

**Scope:** the HybridCloudWorks production workload across three subscriptions —
application, Platform Management, Platform Connectivity. Cloudflare, Hostinger
and the external AI provider APIs are shown separately because they are not
billed by Azure and no Azure budget can see them.

## Corrected 2026-08-25

The Go-Live readiness review read this page against `infra/*.tf` and found it
budgeting an architecture that was never built. Recorded here rather than
silently rewritten, because a number that was wrong for months is worth knowing
about:

| What this page said | What is actually built |
| --- | --- |
| "Selective Private Link and network — $25–35, four endpoints" | **No private endpoint exists.** `grep private_endpoint infra/*.tf` returns nothing. The network posture that was built is service endpoints on the Functions integration subnet, VNet rules on Cosmos, Key Vault and both storage accounts, and default-`Deny` firewalls. That line is USD 0 |
| "Azure OpenAI — $0–40" | **No Azure OpenAI account existed until #849.** `oai-site-prod-cus` and its resource group were retired on 2026-08-19 ([Naming-Convention](../standards/naming-convention.md)); the subscription holds zero model quota. From 2026-10-04 a Microsoft Foundry account, `ais-site-prod-cus-01` (gpt-5-nano and gpt-5-mini, Global Standard), is declared in `infra/foundry.tf` under a USD 75 resource-group budget; its first month, October 2026, is estimated at USD 8–11 from the 2026-10-20 reading under *Foundry — first measured month* below. Every other model call still goes to an external provider API keyed from Key Vault, on the provider's bill, where no Azure budget sees it |
| "Resource-group monthly budget: USD 150" | The budget is **subscription**-scoped and has been since the workload split into six resource groups. A resource-group budget would have watched one of the six and ignored the other five (`infra/main.tf`, the `azurerm_consumption_budget_subscription.hcw` header) |
| "`enable_ai = false` until model/capacity approval" | There is no `enable_ai` variable. Provider availability is decided at runtime by key presence in Key Vault (`functions/src/lib/ai/router.js`), not by a Terraform switch |
| "Service-specific alerts for Function execution, Cosmos RU/429, Storage, Log Analytics ingestion, AI tokens" | **Zero alert rules of any kind existed** in either subscription when the review ran on 2026-08-24. Five were added and are now declared on `main` in `infra/observability.tf` — see [Alerting and support](../runbooks/alerting-and-support.md) |

The tag table's example values were also wrong (`criticality: medium`,
`dataClassification: public-internal`); the real values are below.

ADR 0008 (*Use selective Private Link*) is still **Accepted** and still
unimplemented, and it is not in ADR 0018's deviation table. That is an
architecture question rather than a cost one — the cost consequence is simply
that this line is zero — and it is left for the architecture owner rather than
dispositioned here.

## Corrected 2026-09-07

Two things moved after the 2026-08-24 reading was taken. That five-day reading
was this page's only baseline until September's measured month replaced it on
2026-10-03 (next section); its two headline conclusions had already stopped
describing the platform:

| What this page concluded | What changed |
| --- | --- |
| "One fixed USD 9 line" — Static Web Apps Standard, billing whether or not anyone visits | **The Static Web App moved to the Free plan on 2026-09-05** (owner decision, #341; `sku_tier = "Free"` in `infra/frontend.tf`). That line is now **USD 0**, and the workload's one fixed cost is gone. Everything the estate uses is in Free; `infra/frontend.tf` lists what Standard bought that it did not. Microsoft documents the move in either direction, so a third custom domain or a bandwidth overage is the signal to go back |
| "Cloudflare's Bot Fight Mode is what blocks Azure's availability agents, which is why this platform has no reachability alert" | **The platform has had a reachability alert since 2026-09-01** (T-519 closed). It is not the Azure availability test — that is still uncreated, and Bot Fight Mode is still why — but a Cloudflare Worker probe ([ADR 0024](../decisions/0024-edge-availability-probe.md)) feeding `alert-api-reachability-prod-cus`. The *cost* consequence is unchanged and is why the sentence survived this long: the Worker is free and the 14,400-execution web test is still unarmed |

The Cosmos size figures further down were measured on 2026-09-06 against the
live account, and are not affected by either reading.

**What this does to the total.** The estate's whole fixed cost was the USD 9
Static Web Apps line; removing it leaves telemetry as the only line that is not
a rounding error. The shape stated at the end of the next section — "one fixed
USD 9 line, one telemetry line of roughly USD 20, and everything else a
rounding error" — is now **one telemetry line of roughly USD 20, and everything
else a rounding error**. The measurement plan's first item settles the rest.
*(It did, and the shape was wrong: September's measured month, next section,
puts the cost in the application subscription and almost none of it in
telemetry.)*

## What the estate actually costs

**September 2026, measured.** Cost Management, read 2026-10-03: actual cost
(`ActualCost`, summed `PreTaxCost`) for 2026-09-01 to 2026-09-30, grouped by
resource group and service. September is the first full calendar month of the
current estate in `centralus`, which it moved to on 2026-08-19
([Naming-Convention](../standards/naming-convention.md)). **Read 2026-10-03:**
the figures can still move slightly while September's billing finalises.

The query, per subscription (Reader is enough):

```text
POST https://management.azure.com/subscriptions/<subscription id>/providers/Microsoft.CostManagement/query?api-version=2023-11-01
{
  "type": "ActualCost",
  "timeframe": "Custom",
  "timePeriod": { "from": "2026-09-01T00:00:00Z", "to": "2026-09-30T23:59:59Z" },
  "dataset": {
    "granularity": "None",
    "aggregation": { "totalCost": { "name": "PreTaxCost", "function": "Sum" } },
    "grouping": [
      { "type": "Dimension", "name": "ResourceGroupName" },
      { "type": "Dimension", "name": "ServiceName" }
    ]
  }
}
```

Application subscription, `sub-app-site-prod-cus`: **USD 34.32**.

| Resource group | Service | September |
| --- | --- | ---: |
| `rg-web-site-prod-cus` | Storage | $12.40 |
| `rg-web-site-prod-cus` | Functions | $6.09 |
| `rg-web-site-prod-cus` | Azure Monitor | $5.86 |
| `rg-db-site-prod-cus` | Azure Cosmos DB | $5.71 |
| `rg-sec-site-prod-cus` | Key Vault | $2.45 |
| `rg-web-site-prod-cus` | Azure App Service | $1.23 |
| `rg-lab-hybrid-prod-cus` | Azure Arc | $0.35 |
| `rg-stor-site-prod-cus` | Storage | $0.23 |
| `rg-lab-hybrid-prod-cus` | Key Vault | $0.01 |
| `rg-web-site-prod-cus` | Bandwidth | $0.00 |
| `rg-stor-site-prod-cus` | Bandwidth | $0.00 |
| **Total** | | **$34.32** |

Platform Management subscription: **USD 2.49**.

| Resource group | Service | September |
| --- | --- | ---: |
| `rg-mgmt-plat-prod-cus` | Azure Monitor | $2.49 |
| `rg-mgmt-plat-prod-cus` | Log Analytics | $0.00 |
| **Total** | | **$2.49** |

**Combined: USD 36.81 a month**, about a quarter of the USD 150 application
ceiling, with Platform Management at about a tenth of its USD 25.

### The gap against the estimate, and what drives it

This page estimated **USD 15–20** for the application subscription, from five
days of month-to-date on 2026-08-24, and roughly **USD 17–21** of Log Analytics
ingestion in Platform Management. The combined total landed near the combined
estimate. The shape did not:

- **The application subscription cost about twice the estimate** (USD 34.32
  against 15–20). The estimate assumed one fixed line, Static Web Apps
  Standard at about USD 9, and rounding errors around it. That line went to
  USD 0 when the site moved to the Free plan on 2026-09-05 (#341). The
  `Azure App Service` line of USD 1.23 is consistent with the Standard days
  before the move, though the query does not name the resource. What filled
  the gap is usage the five-day reading undercounted:
  - **`rg-web-site-prod-cus` Storage, USD 12.40, is the largest line.** That
    group holds one storage account, `stsitefuncprodcus01`, the Function App's
    host storage (`Standard_GRS`, `infra/storage.tf`). Its September metrics,
    read 2026-10-03 with `az monitor metrics list` (Reader): **17.3 million
    transactions**, of which `GetBlob` 12.0 M, `GetBlobProperties` 3.7 M,
    `ListContainers` 0.70 M, `RenewBlobLease` 0.45 M, `GetQueueMetadata` 0.26 M
    and `CreateContainer` 64 thousand; 1.58 TB of blob egress, which is in
    region and is why the Bandwidth line is $0.00; 44 GB in; and **0.64 GB
    stored** (2026-09-29). So the line is transactions, not capacity, and the
    reads are the Functions host's own: about 577,000 operations a day, the
    rate #611 found and closed without explaining. Why the host reads that much
    (12 million blob reads averaging about 130 KB, which would fit the
    deployment package being fetched on instance starts, though nothing here
    proves it), and whether the account needs geo-redundancy, are the
    questions to take to this line first.
  - **Functions, USD 6.09**, against USD 0.14 in the five days. Flex
    Consumption bills on execution, and September carried the armed timers
    (2026-09-05) for a whole month.
  - **Azure Monitor in the application subscription, USD 5.86.** This page
    placed telemetry in Platform Management. What bills here is in
    `rg-web-site-prod-cus` (the alert rules and Application Insights,
    `infra/observability.tf`), not the workspace's ingestion.
  - **Cosmos DB, USD 5.71**, against USD 0.68 in the five days, and **Key
    Vault, USD 2.45**, against USD 0.01. Both are per-request meters, so both
    scale with the same month of armed timers and traffic.
- **Platform Management cost about an eighth of its estimate** (USD 2.49
  against 17–21). Log Analytics ingestion billed **USD 0.00**. The estimate
  priced the 0.25 GB/day cap as if it were always reached, and since the
  verbosity cut it is headroom, not the bill. What does bill there is Azure
  Monitor at USD 2.49.

**The subscription budget now measures the workload.** On 2026-08-24 the
application subscription's month-to-date was **$37.14**, about 91% of it
deleted lab resources and the retired `southcentralus` estate settling.
September has no such tail: every line above is a current workload resource
group. So the budget's 50/75/90/100 ladder now tracks this workload, at about
23% of its ceiling.

That is the cost shape of this platform as measured: **host storage
transactions are the largest line**; Functions, Azure Monitor and Cosmos
follow at around USD 6 each; Key Vault and the rest are small; and telemetry
ingestion, which this page used to call the largest controllable line, billed
nothing in September.

## What bills, and what holds it down

| Cost area | Control in code | Where |
| --- | --- | --- |
| Static Web Apps | **Free plan since 2026-09-05** (#341), one production site; preview environments stay ephemeral, and Free allows 3. Everything this estate uses is in Free — 2 custom domains with managed SSL (the apex and `www` are exactly 2), global distribution, SPA routing, 100 GB bandwidth. What Standard bought and this estate did not use: the 99.95% SLA, bandwidth overage billing, `allowedIpRanges`, bring-your-own-Functions, private endpoints | `azurerm_static_web_app.hcw`, `infra/frontend.tf` |
| Functions, Flex Consumption | **Always-ready deliberately unset (= 0)** — one always-ready 2048 MB instance is roughly $20/month whether or not anything runs. `maximum_instance_count = 20` bounds a traffic spike on the unauthenticated comparison endpoint | `infra/main.tf`, the Scale block |
| Cosmos DB | Serverless capability, no provisioned throughput block anywhere, and a per-container `indexing_policy` with explicit included/excluded paths — indexing is RU spend on every write | `azurerm_cosmosdb_account.hcw`, `azurerm_cosmosdb_sql_container.hcw` |
| Blob storage | Lifecycle deletes scraped article images after 90 days. Versioning on the content account — declared, not yet applied — is bounded by a 30-day non-current-version expiry in the same change, which is what stops versioning becoming an unbounded bill | `azurerm_storage_management_policy.cleanup` |
| Key Vault | Standard SKU, no HSM; runtime reads come from cached secret clients | `azurerm_key_vault.hcw` |
| Log Analytics / App Insights | **0.25 GB/day cap** plus 30-day retention, both live. Pruning the Cosmos diagnostic to `ControlPlaneRequests` — two data-plane categories were most of the cap — is declared and not yet applied. Ingestion sampling deliberately **not** enabled ([ADR 0022](../decisions/0022-alerting-fabric.md)) | `azurerm_log_analytics_workspace.hcw`, `infra/observability.tf` |
| Hub networking | Everything in `hub.tf` is hourly-free by design. Azure Firewall (~$288–912), Bastion (~$138), VPN Gateway (~$138) and DDoS Protection (~$2,944) are absent and the file says why — any one of them is between one and twenty times this whole budget | `infra/hub.tf` |
| AI generation | Not an Azure cost. Providers are on when their key is present; Listen & Learn audio bills against `ELEVENLABS-API-KEY` at about $0.10 per 1,000 characters — up to $0.90 an episode and roughly $4 a certification (ADR 0029 §2a) — or, when that key is absent or out of credit, against `GEMINI-API-KEY` at roughly $0.17 an episode. Logged per run in the AI Engine usage tab, and the expected spend is stated when a run is requested | `functions/src/lib/ai/` |

## What the alert fabric costs

The first alert rules this platform ever had arrived on the retired
`fix/go-live-remediation` branch and are now on `main` in
`infra/observability.tf`. This section was written as what the fabric *will*
cost and is left in that form, because the unit model below is what makes it
re-computable; the rules are no longer hypothetical, though — at least
`alert-api-reachability-prod-cus` has been live since 2026-09-01, and the
`infra/observability.tf` inventory has grown past the five costed here to
include the two Cosmos-export rules
([ADR 0028](../decisions/0028-cosmos-out-of-account-export.md)). Re-count the
rules before treating the total as current. The units, from the Azure Monitor
pricing page:

- **Metric alert rules** bill per monitored time series per month. Three are
  declared (`function_http_5xx`, `function_response_time`, `cosmos_throttled`);
  none uses dimension splitting, so each is one series.
- **Log search alert rules** bill per rule per month, priced by evaluation
  frequency. Two are declared — `app_exceptions` at 5 minutes, `logs_daily_cap`
  at 1 hour.
- **Email notifications** through the action group include 1,000 a month free.
- **Budgets** are free.
- **Standard availability web tests** bill *per execution*. `api_health` is
  created with `enabled = false`, so it costs nothing on creation. Armed at the
  defaults — 5 locations every 15 minutes — it is 5 × 96 × 30 = **14,400
  executions a month**, which is the only line on this list that is not a
  rounding error against a workload of this size. Arming it is an owner decision
  for reachability reasons as well ([Alerting and support](../runbooks/alerting-and-support.md));
  it should also be a spend decision.

The Azure Monitor pricing page renders its prices dynamically, and they could
not be read from it when this section was written. The Azure Retail Prices API
returns them. Read 2026-10-10 for Central US, they are:

| Meter | Price |
| --- | --- |
| Log search alert rule, per month, by evaluation frequency (`Alerts System Log Monitored at …`) | USD 3.00 at 1 min, 1.50 at 5 min, 1.00 at 10 min, 0.50 at 15 min |
| Each further time series of a dimension-split log rule (`Alerts Resource Monitored at …`); the first is in the rule's price | USD 0.30, 0.15, 0.10, 0.05 at the same frequencies |
| Metric alert time series (`Alerts Metric Monitored`) | First 10 a month free, then USD 0.10 each |
| Activity Log alert rules | Free ("Activity log ... alert rules continue to be available at no charge", pricing page FAQ) |
| Email notifications | First 1,000 a month free, then USD 0.00002 each |
| SMS to country code 1 | First 100 a month free, then USD 0.00645 each |

PLAT-4 (#964) added eleven rules at those prices. Seven are log rules at a
15-minute frequency (USD 3.50); one splits by timer, at most 24 further series
(USD 1.20). One is a metric alert inside the free ten, and three are Activity
Log alerts. That comes to about **USD 4.70 a month** at most, USD 2.20 of it in
the application subscription and USD 2.50 in Management, with no added
ingestion: every rule reads data that already arrives. Re-count the rules
before treating any total here as current, and take web-test prices from the
same API before arming the web test.

## Budgets and anomaly controls

| Budget | Scope | Amount | What it watches |
| --- | --- | ---: | --- |
| `site-monthly-budget` | Subscription `sub-app-site-prod-cus` | USD 150 | The workload — Static Web Apps, Functions, Cosmos, storage, Key Vault. (This row read `hcw-monthly-budget` until 2026-10-20; the live name follows `var.workload_name`, which is `site`) |
| `plat-mgmt-monthly-budget` | Subscription `sub-plat-mgmt-prod-cus` | USD 25 | Log Analytics ingestion and retention. Applied: `az consumption budget list` on the Management subscription read it on 2026-10-14 at USD 25 with the month's spend under USD 1 (PLAT-9, #969; this cell said "declared, not applied" after the apply had landed) |
| `site-foundry-monthly-budget` | Resource group `rg-ai-site-prod-cus` | USD 75 | The Microsoft Foundry account and its deployments (#849). Declared 2026-10-04 and applied; read live on 2026-10-20 at USD 75 monthly with the month's spend at USD 5.36 and Azure's forecast at USD 10.60. First month estimated below |

### Foundry — first measured month (October 2026, read 2026-10-20)

Owner decision 2026-10-20: the first month is closed on an estimate rather
than on the bill, because the spend is nowhere near the budget and waiting for
the invoice to close in November buys nothing. The reading is Cost Management's
actual cost for the application subscription, grouped by resource group and
meter category, taken on day 20 of 31, plus the budget's own forecast.

| Reading | Value | Source |
| --- | ---: | --- |
| October spend to 2026-10-20, meter `Foundry Models`, resource group `rg-ai-site-prod-cus` | USD 5.36 | Cost Management query, `ActualCost`, 2026-10-01 to 2026-10-31 |
| The same figure as the budget sees it | USD 5.36 | `site-foundry-monthly-budget`, `currentSpend` |
| Straight-line estimate to month end (20 of 31 days) | USD 8.31 | arithmetic on the row above |
| Azure's own forecast for the month | USD 10.60 | `site-foundry-monthly-budget`, `forecastSpend` |
| Budget | USD 75.00 | `infra/foundry.tf` |

**Estimate for October 2026: USD 8–11, about 11–14 % of the budget.** The
two deployments, `gpt-5-nano` and `gpt-5-mini`, are the only meters in the
resource group; the account itself bills nothing. The 50 % alert sits at
USD 37.50, more than three times the forecast, so no notification is expected
this month. The figure is the whole of the Foundry resource group, so it is an
upper bound on what the site's calls cost: it includes the owner's Test calls
from the AI Services card as well as feature traffic.

What this does not settle: the first month shown here is a forecast, not a
closed invoice. Item 1 of the *Measurement plan* below re-reads every
resource group monthly, and October's closed figure lands in that re-read in
early November, as a line under this table, without reopening #849.

The two subscription budgets carry the same ladder: actual-cost notifications
at 50/75/90/100% and a forecast notification at 100%, which is the one that
leaves time to act. The Foundry budget's ladder is 50/90/100% actual and 100%
forecast. All three route to the ops action group *and* to
`budget_alert_email` directly. A budget notifies; it does not stop spend.

Two things about that are worth keeping in mind:

- The direct `contact_emails` path is why a budget notification proves nothing
  about the action group. Mail arrives on that path with the action group
  completely inert. The alert rules have no such fallback, which is why the
  action group's own delivery had to be observed; it was, by email and SMS on
  2026-08-30 — see
  [Alerting and support](../runbooks/alerting-and-support.md#delivery-is-proven-on-both-channels).
- `budget_start_date` is a create-time constraint, not a "when we started"
  field. Azure rejects a monthly budget whose start date is before the current
  month. Until #820 it defaulted to `2026-08-01` and had to be moved by hand
  before any apply that created a budget. It now defaults to unset: a new
  budget takes the first of the month the plan runs in, and existing budgets
  ignore the attribute ([Deployment Runbook](../runbooks/deployment-runbook.md#3-apply)).

Budget alerts never shut anything down automatically, and nothing here is a
spend cap.

## Edge decision

Azure Front Door currently has a fixed monthly base fee around **$35 for
Standard** and **$330 for Premium**, before transfer and request charges.
Premium provides the strongest WAF and Private Link integration but exceeds the
entire workload ceiling. Cloudflare currently offers Free and Pro plans at a
substantially lower fixed cost, so it remains the approved edge (ADR 0002).

The cost of that choice is not zero, and it is not financial: Cloudflare's Bot
Fight Mode blocks Azure's availability agents, so the Azure availability test
and its alert stay uncreated. That trade is recorded in ADR 0022. It no longer
means the platform is unwatched — [ADR 0024](../decisions/0024-edge-availability-probe.md)
routes around it with a Cloudflare Worker, armed 2026-09-01 — and the route it
took happens to be the free one, so the trade costs nothing here either.

References:

- [Azure Front Door pricing](https://azure.microsoft.com/pricing/details/frontdoor/)
- [Cloudflare plans](https://www.cloudflare.com/plans/)

## Allocation model

Every taggable Azure resource takes the same `var.tags` map:

| Tag | Value | Purpose |
| --- | --- | --- |
| `workload` | `hybridcloudworks` | Workload allocation |
| `environment` | `prod` | Environment allocation |
| `owner` | `platform` | Operational accountability |
| `costCenter` | `content-platform` | Financial ownership |
| `managedBy` | `terraform` | Change authority |
| `criticality` | `high` | Reliability context |
| `dataClassification` | `internal` | Security context |

Coverage comes from one map used everywhere, **not from a gate**. There is no
CI check that a new resource carries tags: `iac-validate.yml` runs `fmt`,
`validate`, `tflint` and Trivy, and none of them inspects the tag map. The
resources with no tags are types Azure does not tag at all — role assignments,
blob containers, Cosmos databases and containers, subnets, diagnostic settings,
budgets, peerings, federated credentials. Exceptions to the map require a reason
and an expiry date.

Cost attribution by tag therefore works today because the map is applied
uniformly, and would stop working silently the first time someone omits it.

## Cosmos backup and export — costed against the measured size (2026-09-06)

Issue #231 waited on one number: how much data the account holds. The owner
measured it on 2026-09-06 by reading the account's `DataUsage` metric through
`az monitor metrics list` on `cosmos-site-prod-cus` (the runnable command is on
#231): **2,386,591,744 bytes, 2.39 GB**, index and all 73
containers included. Every figure below is that size against list prices for a
single Central US region, so the model is the estate's, not a placeholder's.

Prices used (Microsoft Learn, read 2026-09-06; the pricing pages render prices
client-side, so the calculator is the place to re-verify before committing):
serverless request units **$0.25 per million**; Cosmos transactional storage
**$0.25 per GB-month**; continuous 30-day backup **$0.20 per GB-month per
region**; a point-in-time restore **$0.15 per GB restored**. Blob storage on the
RA-GRS content account is taken at roughly **$0.037 per GB-month Hot** and
**$0.02 Cool**, the list figures at the time of writing.

### What recovery already costs

| Line | Per week | Per month | Why |
| --- | ---: | ---: | --- |
| Cosmos storage for 2.39 GB | $0.14 | $0.60 | Already on the bill; the `$0.68` Cosmos line in the estate table is mostly this |
| Continuous30Days backup storage | $0.11 | $0.48 | 2.39 GB × $0.20 × 1 region. The 7-day tier was free; ADR 0018's move to 30 days buys three extra weeks of point-in-time restore for under fifty cents |
| A point-in-time restore, when exercised | — | $0.36 per restore | 2.39 GB × $0.15, billed per restore invocation — the timed restore drill that #231 calls for costs less than a coffee |

### What the out-of-account export would add

The export exists to survive account or region loss, which continuous backup
does not cover (it lives with the account). Two shapes were on the table; the
measurement settles which.

| Shape | RU per export | Per week | Per month | Blob storage, 30-day retention |
| --- | ---: | ---: | ---: | ---: |
| **Full export every day** | ~2.4 M RU (one read per KB) ≈ $0.60 | $4.20 | $18 | 30 × 2.39 GB ≈ 72 GB → $2.65 Hot / $1.45 Cool per month |
| **Full export weekly + change-feed deltas daily** | 2.4 M RU once a week; deltas read only changed documents, a few thousand a day ≈ $0.01–0.05 | $0.70–0.95 | $3–4 | 4–5 weekly copies + deltas ≈ 12 GB → $0.45 Hot / $0.25 Cool per month |
| Restore from the export into a fresh account (the drill) | ~12 M RU of writes (≈5 RU per KB) | — | ≈ $3 per drill | Plus the new account's storage for its lifetime |

**Decision the numbers support:** weekly full plus daily change-feed deltas,
Cool tier, on the RA-GRS content account. Roughly **$4 a month all-in**, against
**$20 a month** for daily fulls that protect nothing extra under an RPO of 24
hours. The cost is dominated by the full read, not by storage, which is why
cadence is the lever and tier is a rounding error. Deletes are the design's
hard part, not its cost: the default latest-version change feed mode does not
emit them, so the weekly full is also the reconciliation that makes a deleted
document disappear from the copy. Cosmos does offer an all-versions-and-deletes
change feed mode that captures deletes, but it requires continuous backup on
the account and a retention window that the delta reader must never fall
outside; whether the exporter adopts it or keeps the weekly reconciliation is
a design choice for #231's ADR, and costs the same either way.

**Whole recovery posture, once the exporter runs:** about **$1.20 a week /
$5 a month** — continuous backup plus export plus one drill a quarter — on a
workload whose entire bill is in the tens of dollars. The measurement plan
below gains one line: re-read `DataUsage` when the exporter is armed and again
after a quarter, since every row here scales linearly with it.

## Measurement plan

The first baseline now exists, so this is maintenance rather than discovery:

1. ~~Re-read month-to-date per resource after a full calendar month in
   `centralus`.~~ **Done 2026-10-03 (#822):** September 2026, USD 36.81
   combined, by resource group and service, above. Re-read it monthly the same
   way.
2. Re-read the Platform Management subscription separately. It is the only one
   with a cost that varies with load, and it was invisible until it had a
   budget.
3. ~~Once the deleted-lab and `southcentralus` tail clears, compare the
   application subscription's total against the workload total.~~ **Done
   2026-10-03:** the tail has cleared, and every September line is a workload
   resource group.
4. Attribute by service and by the required tags.
5. Confirm the Log Analytics figure against the cap after a full **uncapped**
   day. The pre-apply ingestion numbers in `infra/observability.tf` are a floor,
   not a measurement — they were sampled while the cap was already tripping.
6. Treat a reduction as realized savings only after billed cost falls without
   violating latency, error, recovery, or security targets.

No commitment purchase is appropriate, and the Free-plan move of 2026-09-05
only strengthens it. Nothing here has a reservable shape: Static Web Apps has
no reservation on either plan and now bills nothing at all, serverless Cosmos
has no throughput to reserve, and Flex Consumption bills on execution.

## FINOPS_ASSESSMENT

```text
TYPE: FINOPS_ASSESSMENT
GOAL: Keep the production Azure workload below USD 150/month on the application subscription and USD 25/month on Platform Management, without violating the approved security and recovery baseline.
SCOPE: Three subscriptions (app, Platform Management, Platform Connectivity); one region, centralus. Cloudflare, Hostinger and external AI provider APIs are tracked separately because no Azure budget can see them.
CONSTRAINTS: Single primary region; anonymous public site; Entra admin only; static-first delivery; no destructive optimization.
DECISIONS: Consumption/serverless compute with zero always-ready; Cosmos Serverless; capped telemetry at 0.25 GB/day; Cloudflare retained; no Front Door, Firewall, Bastion, VPN Gateway, NAT, APIM, DDoS plan or private endpoints; no Azure OpenAI account.
FINOPS: Measured September 2026 (read 2026-10-03, Cost Management ActualCost by resource group and service) — USD 34.32 application subscription plus USD 2.49 Platform Management, USD 36.81 combined. Largest line: rg-web-site-prod-cus Storage USD 12.40 (stsitefuncprodcus01, 17.3 M host-storage transactions, 0.64 GB stored). Log Analytics ingestion billed USD 0.00.
IMPLEMENTATION: Two subscription budgets with 50/75/90/100 actual plus forecast; Log Analytics daily cap and an 80%-of-cap alert; storage lifecycle and bounded versioning; zero always-ready instances; bounded maximum instance count; required allocation tags applied from one map.
VALIDATION: Done for September 2026 (#822): the full month replaced the five-day reading and the USD 15–20 estimate; the application subscription came in at about twice the estimate (host storage transactions, Functions, Azure Monitor, Cosmos) and Platform Management at about an eighth; the retired-resource tail has cleared. Still open: confirm ingestion after a full uncapped day.
RISK_GATES: Arming the availability test (14,400 executions/month); adding fixed-cost networking; always-ready or zone-redundant compute; provisioned Cosmos throughput; multi-region replication; Defender plans; raising the Log Analytics daily cap.
OPEN_ITEMS: Cloudflare plan cost; Hostinger billed cost; what drives the Functions host storage reads (the largest line) and whether stsitefuncprodcus01 needs GRS; exact Azure Monitor alert-rule and web-test unit prices.
NEXT_OWNER: Workload owner for post-apply cost measurement.
```

## Free-tier disposition (2026-08-18)

Reviewed the subscription's free-services meters against the as-built
architecture (workload owner + validation session). Ruling principles: this
platform already lives on **always-free consumption mechanics** (Functions
scale-to-zero, Cosmos serverless idle-free, scale-to-zero ACA job, capped
Log Analytics); **12-month free-tier meters are treated as traps**, not
opportunities — they expire from the subscription's creation date and then
bill full price.

### Decisions

| Item | Decision |
| --- | --- |
| Blob Hot LRS 5 GB + operations, egress 15 GB | Automatic billing discounts on the existing accounts; nothing to configure |
| Cosmos free tier (25 GB + RU/s) | **Unusable by design** — applies only to provisioned-throughput accounts; ours is serverless (irreversible, ADR-0003/0018). Correctly shows "Not in use" forever |
| Container Registry | **Not needed** — all GitHub Actions jobs use GitHub-hosted runners, so HCW has no runner image or container-registry dependency |
| Service Bus Standard 750 h | **Rejected** for the pending async fabric — 12-month cliff to ~$10/mo; Storage Queues (ADR-0012's choice) cost pennies, never expire, and support managed identity |
| VMs / SQL / MySQL / PostgreSQL / LB / VPN GW / Public IP meters | **Not applicable** — the architecture deliberately contains none of these; standing one up to harvest an expiring freebie needs an ADR and plants month-13 bill shock |
| Key Vault Premium HSM ops, Media Services | Irrelevant (Standard-SKU vault; Media Services is retired) |

### AI options for future features — the standing reference

> **2026-08-25.** Read the table below as a menu, not as a gap. AI generation is
> live and runs entirely on **external provider APIs** keyed from Key Vault —
> there is no Azure OpenAI account and this subscription holds no model quota,
> so today's AI spend is on the providers' bills and no Azure budget sees it.
> What the table still answers is the question that comes up whenever a *new*
> AI-shaped feature is proposed: whether an always-free Azure F0 SKU does the
> job before reaching for a paid generative API.

When a new AI RPC is built, the cost choice per task is:
**paid generative APIs** (the third-party SaaS keys in Key Vault, or Azure
OpenAI if an account is ever created) versus **always-free F0 SKUs** of
individual Azure AI services. F0 mechanics that make them safe under the USD 150
ceiling:

- F0 is **always-free per service** (one F0 resource per service per
  subscription), separate from the 12-month meters — it does not expire.
- On quota exhaustion F0 **throttles (HTTP 429) instead of billing** —
  overage cannot accrue (confirmed in Microsoft Learn for Language/Speech).
- **Create the resource directly with SKU F0.** Resources provisioned
  through Microsoft Foundry default to S0 and do not inherit free tiers.
- F0 resources support managed identity / Entra auth, so the keyless posture
  applies to them exactly as it does elsewhere.

| Task shape | Free option (F0, approximate monthly allowance) | When the paid API is the only option |
| --- | --- | --- |
| Translation | Translator F0 (~2M characters) | — |
| Sentiment, key phrases, summarization, PII detection | Language F0 (~5K text records) | Long-form abstractive quality → LLM |
| Image tagging, OCR, alt-text for media/covers | Vision F0 (~5K transactions, rate-limited) | Creative captions → LLM |
| Moderating anonymous submissions | Content Safety F0 (text+image, 5 RPS) | — |
| Document/receipt extraction | Document Intelligence F0 (~500 pages; 2 pages/4 MB per request; add-ons billable) | Complex layouts |
| Speech-to-text / text-to-speech | Speech F0 (~5 audio hours / ~0.5M characters) | Real-time avatar/LLM-speech features are S0-only |
| **Content drafting, scoring, image generation** | **No free Azure tier exists** | The SaaS keys in Key Vault (the live path), or Azure OpenAI if an account is ever created |

Allowances are the documented F0 shapes at the time of writing — confirm on
the service's pricing page before building against one, and add any new
cognitive account through the normal PR + plan review (it is a new resource:
tags, ADR if architecturally material, F0 SKU stated in the diff). Creating one
is a spend decision and belongs in an `owner-gated` GitHub issue.

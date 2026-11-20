# Investigate: Log Analytics daily cap hit twice, capacity warning firing again

Date: 2026-11-15, updated 2026-11-19. Status: investigating. The repository
checks are done (see "Findings from the repository" below); finding what is
driving the volume still needs the owner, because it needs a query against
the workspace and no session here can sign in to Azure.

## What was seen

- **Sev2 `alert-logs-capacity-prod-cus`** (80%-of-cap early warning) on
  `log-plat-prod-cus-01` (`rg-mgmt-plat-prod-cus`) fired **23:47 UTC Nov 15**
  (alert ID not copied here, as this repository is public; the portal's alert history has it). Metric: **0.208 GB
  ingested vs the 0.2 GB warning threshold** (80% of the ~0.25 GB/day daily
  cap). Still firing as of Nov 15 evening.
- **Sev1 `alert-logs-overquota-prod-cus`** on the same workspace fired **twice**
  in the same stretch: 04:15 UTC Nov 14 (resolved 08:46 UTC) and 03:00 UTC
  Nov 15 (resolved 08:46 UTC Nov 15). While the cap is hit, Azure drops every
  billable table until the next 08:00 UTC reset, and every log-based alert is
  blind.
- The capacity warning itself fired before, too: 09:48 UTC Nov 14 (resolved
  09:49 UTC Nov 15) and 23:48 UTC Nov 14. This is now a nightly pattern, not
  a one-off.

### Update 2026-11-19: the pattern has continued every day

As reported by the owner on the pull request on 2026-11-19 (times there are
Pacific; in November Pacific is UTC-8):

- **Sev2 capacity warning:** fired **six evenings in a row**, most recently
  **Nov 19 at 3:47 PM PT (23:47 UTC)**, reading **0.201 GB against the
  0.2 GB trigger**.
- **Sev1 overquota alert:** fired **five evenings in a row**, and is expected
  to fire again on the evening of Nov 19.
- The exact time of each day's firing was not copied into this note. The
  portal's alert history for `log-plat-prod-cus-01` has them.

Two lines in the "What was seen" list above do not fit how the capacity rule
works, and should be checked against the portal's alert history before they
are relied on:

- "Fired **09:48 UTC** Nov 14" is less than two hours after the 08:00 UTC
  reset. Reaching 0.2 GB that fast would mean about 100 MB an hour, roughly
  eight times the rate every other firing implies. A time recorded in a
  different time zone is the likelier explanation.
- The rule is stateful (an alert stays open until the condition clears, and
  it does not fire again while open), so a firing at 23:48 UTC Nov 14 while
  the 09:48 one was still open until Nov 15 should not happen.

## What it means

Hitting the cap costs $0 in ingestion — the cost is dropped logs and blind
alerts. The mgmt subscription's daily cost crept up ($0.31–0.35/day Nov 9–12
vs $0.20–0.22 Nov 1–8), so volume is growing, not just spiking.

## Standing recommendation (owner decision, not yet taken)

Raise the daily cap to **1 GB/day** (~10x current volume): Log Analytics
PAYG is $2.30/GB with the first 5 GB/month free, so the realistic added cost
is a few dollars a month; the absolute ceiling is ~$69/mo only if 1 GB/day is
actually ingested every day. (The price was not re-checked on 2026-11-19.)

**Correction, 2026-11-19: make the change in Terraform, not in the portal.**
The cap is set by Terraform (see "Findings from the repository" below). A
change made only in the portal (`log-plat-prod-cus-01` → Usage and estimated
costs → Daily Cap) is drift: the next HCP Terraform plan would show it, and
the next apply would put the cap back to 0.25 GB. The change is the value of
the Terraform variable `logs_daily_quota_gb`, either as a workspace variable
in HCP Terraform (organization `hcw`, workspace `hcw-azure`) or as a new
default in `infra/variables.tf` through a pull request. The warning alert
moves with it on its own (to 0.8 GB at a 1 GB cap); no alert edit is needed.

## Findings from the repository (2026-11-19)

These are read from the files on this branch. Nothing here was checked
against the live workspace.

### 1. The daily cap is in Terraform, at 0.25 GB

- [`infra/variables.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/variables.tf#L686-L719),
  variable `logs_daily_quota_gb`, **default `0.25`** (GB per day). A
  validation refuses any value of 0 or less, including Azure's `-1` for
  "no cap", because the warning alert's threshold is worked out from this
  number and would go negative.
- [`infra/main.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/main.tf#L101)
  sets `daily_quota_gb = var.logs_daily_quota_gb` on the workspace resource
  `azurerm_log_analytics_workspace.hcw`.
- `infra/terraform.tfvars.example` does not set it. **Not checked:** whether
  the HCP Terraform workspace `hcw-azure` overrides the default with a
  workspace variable. The alerts' own numbers (0.2 GB = 80% of 0.25 GB) say
  the live cap is 0.25, so an override, if any, is also 0.25.
- The variable's description already explains how to measure real demand:
  raise the cap for one full day (08:00 UTC to 08:00 UTC), read the
  ingestion, then decide. A day that stops exactly at the cap shows the cap,
  not the demand.

### 2. The warning alert, `alert-logs-capacity-prod-cus` (Sev2)

[`infra/observability.tf`, resource `logs_daily_cap`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/observability.tf#L1042-L1089):

- Runs **every hour** over the billable rows of the `Usage` table since the
  last **08:00 UTC** reset, and fires when the total passes
  **`daily_quota_gb * 0.8`** (0.2 GB today). The threshold is read from the
  workspace resource, so it follows the cap automatically.
- Stateful: one alert per day, closing on its own after the 08:00 UTC reset.
- Because it runs hourly, the firing time (23:47 UTC) is the first hourly run
  after the line was crossed; the crossing itself can be up to an hour
  earlier.
- The definition looks correct. The 0.201 and 0.208 GB readings are just
  over the 0.2 GB line, which is what the rule is meant to report.

### 3. The overquota alert, `alert-logs-overquota-prod-cus` (Sev1)

[`infra/observability.tf`, resource `logs_over_quota`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/observability.tf#L1120-L1166):

- Runs **every 15 minutes** and fires when `_LogOperation` has any
  `Ingestion` row containing `OverQuota` since the last 08:00 UTC reset.
  That is the line Azure writes when the cap is hit. The query is the one on
  Microsoft's
  [daily cap page](https://learn.microsoft.com/azure/azure-monitor/logs/daily-cap)
  (linked from the code; not re-opened on 2026-11-19).
- Stateful, closing two clear runs after the reset. That matches the
  recorded "resolved 08:46 UTC" times.
- The definition looks correct. It is firing because the cap really is
  being hit, not because the rule is wrong.

### 4. The timings agree with each other

From the alerts' own numbers: 0.2 GB in the 15¾ hours from 08:00 to
23:47 UTC is about **13 MB an hour**. At that rate the last 0.05 GB takes
about four hours, which puts the cap at about 03:00–04:00 UTC. That is when
the Sev1 alert fired (03:00 and 04:15 UTC). At the same rate a full day
would be about **0.3 GB**, just over the 0.25 GB cap. This is arithmetic on
the alert readings, an estimate and not a measurement, and it says nothing
about *which* table is growing.

### 5. What sends data to the workspace (the places to look)

Everything below writes into `log-plat-prod-cus-01`, so the volume driver is
one of them. Listed so the owner's query can be read against it, not as a
guess at the answer.

- Application Insights `azurerm_application_insights.hcw`
  ([`infra/main.tf` line 133](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/main.tf#L133)).
  It stores its data in this workspace, so a rise in site traffic or in what
  the functions log shows up here without any change under `infra/`.
- Diagnostic settings (the Azure setting that copies a resource's logs to
  the workspace) in
  [`infra/observability.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/observability.tf):
  `key_vault`, `cosmos` (filtered at ingestion by the
  `workspace_transforms` rule since #1530), `content_blob`, `content_queue`,
  `functions_queue`, `functions_blob`.
- Lab host: diagnostic settings `lab_hybrid_key_vault`
  ([`infra/lab-hybrid.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/lab-hybrid.tf#L393))
  and `lab_hybrid_backups_blob`
  ([`infra/lab-hybrid-backups.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/lab-hybrid-backups.tf#L151)),
  and the data collection rule `lab_hybrid`
  ([`infra/lab-hybrid.tf` line 125](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/log-daily-cap-2026-11-15/infra/lab-hybrid.tf#L125)),
  which collects from the lab host machine.

**No change under `infra/` since 2026-11-01 adds or widens any of these.**
Checked with `git log --since=2026-10-25 -- infra/`: the changes of
2026-11-09, when the daily cost started to rise, are deploy identities
(`oidc.tf`), a Search Console sync timer that stays off until it is added to
`enabled_timers`, and the Azure provider version bump. So the growth most
likely comes from more data on existing sources, not a new one in Terraform.
Which source is still open; that is check 1 below.

## What to check

1. **Still needs the owner (needs an Azure sign-in).** Which tables are
   driving the growth? Query the workspace for billable ingestion by table
   over the trailing 7 days and compare with the prior week. Read the answer
   against the list in finding 5. Remember that days stopped by the cap are
   cut short, so compare hours before the cap was hit, not whole days.
2. Is the growth a new table/source, or more volume on existing tables?
3. If the growth is legitimate, raise the cap to 1 GB/day (decision above),
   through `logs_daily_quota_gb` in Terraform, not the portal.
   If it is noise (e.g. a chatty table), exclude or sample it instead.
4. Confirm the alert rules still evaluate correctly once ingestion is back
   under the cap. (The repository side is done: both rule definitions were
   read on 2026-11-19 and look correct; see findings 2 and 3.)

## Done when

- [ ] The cap is raised, or ingestion is brought under control another way.
- [ ] No capacity warning and no overquota firing for 7 days.
- [ ] The volume driver is named in this doc.

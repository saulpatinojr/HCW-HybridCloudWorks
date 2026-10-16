# ADR 0022: The alerting fabric, and the signal it does not cover

**Status:** Accepted
**Decision date:** 2026-08-24
**Owners:** Workload owner and architecture owner

## Context

[ADR 0010](../decisions/0010-observability.md) centralised bounded observability. Collection was
built; alerting never was. The Go-Live readiness review of 2026-08-24 found
**zero alert rules of any kind** in either subscription — `az monitor metrics
alert list`, `scheduledQueryRules`, `webtests` and `activity-log alert list` all
returned empty — while the Log Analytics workspace those rules would have read
from was simultaneously `OverQuota` and dropping every billable table. The
platform was both unmonitored and silently discarding the evidence that would
have shown it. [ADR 0018](../decisions/0018-as-built-plan-v02.md) tracked this as remediation
debt under TODO **T-505**.

The rules described here are declared on `fix/go-live-remediation` and **have
not been applied**. This ADR records the design decisions, several of which
deliberately diverge from what the review asked for.

## Purpose and decision drivers

- **An alert must keep working when the thing it watches is broken.** The
  failure that motivated this work was a capped workspace, and a log-based alert
  is silent exactly then.
- **Ingestion is capped at 0.25 GB/day**, so every alert design that adds
  ingestion competes for budget with the two tables an incident is actually read
  from.
- **Nothing has ever fired here.** Every threshold is a first estimate, so the
  design has to make tuning easy and has to say which numbers are guesses.
- **A coverage claim must not exceed what can fire.** A rule that exists,
  appears in an inventory, and cannot page anyone is worse than a visibly empty
  inventory, because it looks fixed.

## Decision

Five armed rules — Function App 5xx, Function App latency, Cosmos throttling,
application exceptions, Log Analytics daily-cap approach — plus a standard
availability web test and its alert, both created disabled. All route to the
existing `ag-plat-prod-cus-01` action group. The operator-facing description
lives in [Alerting and support](../runbooks/alerting-and-support.md); what follows is why.

**1. Metric alerts over log alerts wherever there is a choice.** Platform
metrics are not ingested into the workspace, are not billed by the GB, and keep
evaluating through an `OverQuota` window. Only the two conditions with no metric
equivalent are scheduled query rules.

**2. Cosmos 429 is a metric alert, not the KQL rule the review specified.** A
KQL rule for throttling has to read `CDBDataPlaneRequests` — the diagnostic
category being removed in the same change for consuming about a third of the
daily cap. Keeping it to feed a throttling alert would re-create the `OverQuota`
condition the alert exists to help with, and a log alert would go silent in
precisely that scenario. `TotalRequests` split on `StatusCode` is the documented
route to 429s and there is no dedicated throttled-request metric on this account
type.

**3. Application Insights ingestion sampling is deliberately NOT enabled.**
`sampling_percentage` configures *ingestion* sampling, which Microsoft states
"only applies when no other sampling is in effect", and Azure Functions runs
adaptive SDK sampling on by default. `functions/host.json` has it enabled with
`Request` excluded. The net effect is inverted: `AppTraces` — the largest table
by far — is host-sampled and therefore untouchable by ingestion sampling, while
`AppRequests` and `AppExceptions` are excluded from host sampling and are
exactly what ingestion sampling would discard. Those two tables are 0.3% of the
cap each, are what an incident is read from, and one of them is what the new
exceptions rule counts. Microsoft's own guidance is that sampling affects
alerting accuracy. The daily-cap problem is solved by pruning Cosmos categories
instead; the remaining levers, if headroom is ever needed, are `host.json`
`logLevel`, `maxTelemetryItemsPerSecond`, or a workspace ingestion-time
transformation.

**4. The log alert identities use Log Analytics Reader, not Monitoring Reader.**
Both rules carry a user-assigned identity — user-assigned rather than
system-assigned because only that ordering is expressible as one deterministic
apply, and because managed-identity tokens are cached per resource URI for about
24 hours, so granting a role after a refusal is not reliably a quick fix. Two
identities rather than one, because the rules sit in different subscriptions and
Microsoft's guidance is to create a new identity rather than attach one across
that boundary.

The role choice is the load-bearing part. Reader, Monitoring Reader and Log
Analytics Reader all carry `*/read` and all three satisfy the documented
requirement. Only **Log Analytics Reader** carries a `notActions` entry for
`Microsoft.OperationalInsights/workspaces/sharedKeys/read`. On a workspace those
shared keys are the *ingestion* keys: a principal holding them can write
arbitrary data into the workspace. The other two roles would have let an alert
rule forge or drown the telemetry it reads. On the Application Insights
component scope the two roles are functionally identical — Log Analytics
Reader's workspace-specific actions have nothing to act on there — so the
component grant uses Monitoring Reader, the role that names the job.

**5. The availability test and its alert are gated on the same variable.** The
alert carries `count = var.availability_test_enabled ? 1 : 0` rather than being
created unconditionally against a disabled test. Created unconditionally it
would sit enabled and inert, and `az monitor metrics alert list` would report
six rules when five can fire — with the inert one being reachability, the only
signal that survives the application being completely down.

**6. A log rule is stateful wherever its condition can clear.** Amended
2026-10-16. The rule this decision first wrote, for four workload rules, now
covers every log rule that evaluates every 12 hours or more often and watches
a state. That is a count, a level, or an absence, which the next good reading
clears. Three exceptions remain, and each is held by a reason, not by habit:

- **The daily rules:** `alert-export-window-latency`, `alert-cosmos-export-daily`
  and `alert-cosmos-export-full` are stateless because Azure refuses
  auto-resolution on a rule evaluated less often than every 12 hours.
- **`alert-lab-unit-failed`:** stateless, and muted for six hours, because its
  condition is an event, a `hcw-unit-failed` line, not a state. A stateful
  form would report Resolved about 30 minutes after the line left the hour's
  window (two clear 15-minute evaluations), whether or
  not the unit came back.
- **Activity Log alerts:** stateless by platform. Each alert is one event, read
  and closed by a person.

The amendment moved `alert-logs-capacity`, `alert-lab-disk` and both
`alert-lab-backup-missing` rules from mutes to stateful. They had muted
because their conditions hold for hours. That was the reason to make them
stateful, not to mute them. A mute still opened an alert at every evaluation
and closed none, and 43 of them were open on 2026-10-16 for conditions long
gone. The capacity rule's own reason, that its condition "cannot clear before
the 08:00 UTC reset and there is nothing to auto-resolve", had it backwards:
the reset is what clears it.

The decision as first written, 2026-08-25, after the first firing, follows. `autoMitigate` defaults to false on a
scheduled query rule, and a stateless log rule notifies on *every* evaluation
whose condition is met — at PT5M that is a fresh Sev1 mail every five to ten
minutes, continuing for a further window-length after the condition clears,
because a 15-minute window evaluated every 5 minutes counts the same burst three
times. `alert-app-exceptions-prod-cus` demonstrated this the night the rules
went live. Statefulness costs nothing: the rule evaluates at the same frequency
against the same threshold and detects exactly what it detected before, and adds
a Resolved notification the stateless form cannot send. It is deliberately the
*only* change made without firing data, because it is the only one that does not
trade coverage for quiet. `mute_actions_after_alert_duration` is mutually
exclusive with it. It stayed on `alert-logs-capacity` alone, on the reasoning
that the condition cannot clear before the 08:00 UTC reset. The 2026-10-16
amendment above corrects that.

The corollary is recorded so it is not lost: **after this, a noisy rule is one
that fires too often, and the remedies all cost coverage.** They are ordered in
[Alerting and support](../runbooks/alerting-and-support.md) — fix the throw, filter the query
on a named `problemId`, require two failing periods, raise the threshold, lower
the severity — and none of them should be applied before the query in that
section says what is actually throwing. Suppression by
[alert processing rule](https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-processing-rules)
is for planned windows only; it outlives the reason for it otherwise.

## Consequences and accepted risks

- **At the time of this ADR, reachability had no alert, and that is the
  failure class this platform has actually had.** Cloudflare Bot Fight Mode answers Azure's availability agents
  the way it answers any datacenter client — a 403 interstitial — and a WAF skip
  rule against it was built, applied and confirmed inert, because Bot Fight Mode
  does not run on the Ruleset Engine. Three recorded incidents (2026-08-20 mass
  404, and two on 2026-08-21) share one shape: host up, functions unregistered,
  every route 404. `Http5xx` does not count 404s; `AppExceptions` cannot fire
  because no handler runs. **None of the five rules armed then detected it.**
  It was accepted as a cost of the Cloudflare edge ([ADR 0002](../decisions/0002-cloudflare-edge.md))
  and tracked as TODO **T-519**. T-519 closed on 2026-09-01: the edge
  availability probe ([ADR 0024](0024-edge-availability-probe.md)) feeds
  `alert-api-reachability-prod-cus`, which is armed (`infra/observability.tf`).
- **The per-request Cosmos audit trail is gone.** Pruning
  `CDBDataPlaneRequests` means a data-access question can no longer be answered
  from logs. Accepted because a capped workspace answers no questions at all,
  and because the account firewall already restricts callers to the Functions
  subnet and named operator windows. If the audit trail becomes a requirement,
  the answer is a dedicated table with its own cap or an ingestion-time
  transformation that keeps only writes — not switching the category back on
  under a 0.25 GB cap.
- **Delivery is unproven and cannot be proven before the apply.** Every rule
  routes solely through one action group and none has a second path; for the
  four rules in the application subscription that reference also crosses a
  subscription boundary. ARM accepting the reference is proven; a notification
  arriving is not. Two post-apply tests settle it and they answer different
  questions ([Deployment Runbook](../runbooks/deployment-runbook.md#4-post-apply-verification)
  §4). **Settled after the apply, recorded 2026-10-10 (PLAT-4, #964):** the
  cross-subscription hop delivered when `alert-app-exceptions-prod-cus` fired
  on 2026-08-25, and both receivers delivered a CLI test notification on
  2026-08-30, email and then SMS (T-709 closed). Both are in
  [CHANGELOG.md](../repo/changelog.md);
  [Alerting and support](../runbooks/alerting-and-support.md#delivery-is-proven-on-both-channels)
  has the evidence and the commands that re-prove it.
- **Every threshold is an estimate**, stated as such beside each resource. They
  are to be tuned against the first week of real firing, not preserved because
  they are written down. That week began on 2026-08-25 with
  `alert-app-exceptions-prod-cus`, and the first thing it calibrated was
  notification behaviour rather than a threshold (decision 6). The thresholds
  themselves are still untuned.
- Cost is small but not zero, and the one line that is not a rounding error is
  arming the web test at 14,400 executions a month
  ([Cost analysis](../architecture/cost-analysis.md)).
- Azure RBAC propagation is eventually consistent and `azurerm` does not wait,
  so a first apply can fail query validation on a grant that has not landed.
  Re-applying converges. `skip_query_validation` was deliberately not set — it
  would hide a genuinely broken query.

## Alternatives considered

- **A KQL rule for Cosmos 429s** — rejected; see decision 2.
- **Ingestion sampling to solve the daily cap** — rejected; see decision 3. This
  reverses the readiness review's own recommendation, on its evidence.
- **A `Http404` metric alert on `Microsoft.Web/sites` as an interim reachability
  detector** — considered and **not built**. It needs neither Cloudflare nor the
  workspace, and this host serves only `/api`, so a burst of 404s is anomalous
  rather than normal. It is the cheapest partial cover for the gap above and
  remains available; it was not adopted here because its threshold would be a
  guess against no baseline at all, and because it detects the symptom on a host
  that is by then already failing. Recorded rather than dropped.
- **A second action group in the application subscription**, referenced
  alongside the Management one — the fallback if the cross-subscription hop
  proves inert. Costs one free resource and duplicate mail per alert. Not built
  before there is evidence it is needed.
- **A deliberately always-true heartbeat rule as a dead man's switch** —
  rejected. It proves delivery continuously only if something external notices
  the heartbeat stopping, which is the same unwatched-silence problem one level
  up.

## Validation and revisit triggers

- Validated only by the apply, then the two delivery tests, then the first week
  of firing. Until a notification has been seen to arrive, the rules are
  plumbing rather than coverage.
- Confirm ingestion against the cap after a full **uncapped** day. The pre-apply
  figures are a floor, not a measurement — they were sampled while the cap was
  already tripping.
- **Revisit when:** Cloudflare admits the availability agents (arm the test, and
  reconsider the `Http404` interim); the first real incident calibrates a
  threshold; ingestion sits comfortably under the cap and a pruned category
  could return; or `hashicorp/terraform-provider-azurerm#29149` closes, which
  changes what the post-apply Function App assertion is guarding against.

## Related decisions and references

- Amends [ADR 0010](../decisions/0010-observability.md); closes the observability row of
  [ADR 0018](../decisions/0018-as-built-plan-v02.md)'s remediation-debt table (TODO T-505)
- The reachability gap is a consequence of [ADR 0002](../decisions/0002-cloudflare-edge.md)
- [Alerting and support](../runbooks/alerting-and-support.md) ·
  [Deployment Runbook](../runbooks/deployment-runbook.md) · [Cost analysis](../architecture/cost-analysis.md)
- `infra/observability.tf` — every threshold's assumption, beside the resource

# Investigate: app-exceptions alert firings, Nov 21–24, 2026

## Alert

`alert-app-exceptions-prod-cus` (Sev1, `infra/observability.tf`): more than 5
application exceptions in 15 minutes, scoped to the Application Insights
component `appi-site-prod-cus-01` (workspace-based, telemetry in
`log-plat-prod-cus-01`). Stateful: one firing per burst, resolves after
three clean 5-minute evaluations.

## Firings

Seven firings in about three days. All times UTC; counts are the alert's own
rolling-15-minute counts, so they differ slightly from the fixed 15-minute
buckets in the queries below.

| Fired (UTC) | Count | Resolved (UTC) |
|---|---|---|
| Nov 22 02:56 | 58 | Nov 22 03:22 |
| Nov 23 02:01 | 18 | Nov 23 02:32 |
| Nov 23 13:16 | 101 | Nov 23 13:42 |
| Nov 23 23:46 | 58 | Nov 24 00:12 |
| Nov 24 03:46 | 26 | Nov 24 04:27 |
| Nov 24 05:06 | 8 | Nov 24 05:32 |
| Nov 24 06:06 | 22 | Nov 24 06:32 |

## What the exceptions are

Queried live Nov 24 via the Azure Muse Reader (Log Analytics workspace
`log-plat-prod-cus-01`, `AppExceptions`, last 3 days; helper
`azure_query.py` in the `custom.azure-muse-reader` connector). 428 rows.

By `ProblemId`:

| Count | ProblemId |
|---|---|
| 222 | `Azure.RequestFailedException` at `Azure.Core.HttpPipelineExtensions.ProcessMessageAsync` — "The listener for function 'Functions.\<timer\>' was unable to start." |
| 88 | `Azure.RequestFailedException` at `Microsoft.Azure.WebJobs.Host.BlobStorageConcurrencyStatusRepository.ReadAsync` — HTTP 403, `AuthenticationFailed` |
| 88 | `Azure.RequestFailedException` at `Azure.Storage.Blobs.ContainerRestClient.CreateAsync` — HTTP 403, `AuthenticationFailed` |
| 13 | `Microsoft.AspNetCore.Connections.ConnectionAbortedException` at gRPC `PipeExtensions.ReadStreamMessageAsync` — "The request stream was aborted." |
| 8 | `System.InvalidOperationException` at gRPC `HttpContextStreamWriter.WriteCoreAsync` — "Can't write the message because the request is complete." |
| 6 | `Azure.RequestFailedException` at `Azure.Storage.Queues.QueueRestClient.GetPropertiesAsync` |
| 2 | `RpcException` on `syncSocialCalendarScheduled` |
| 1 | `System.OperationCanceledException` |

The storage failures all carry the same outer message:

> Server failed to authenticate the request. Make sure the value of
> Authorization header is formed correctly including the signature.
> Status: 403 ... ErrorCode: AuthenticationFailed

The two storage operations fail as a pair on the same `RequestId`: one
`ReadAsync` (singleton-lock / concurrency status) and one `CreateAsync`
(blob container). Every timer listener then fails to start:
`checkAgentHealth`, `publishScheduledContent`, `syncSocialCalendarScheduled`,
`brainIndexReconcile`, `platformJobSweeper`, `sweepVisitorSessions`,
`syncRssFeeds`, `cleanupRejectedContent`, `cleanupSoftDeletedContent`.

No exception names a function handler or any application code. The
`OperationName` is empty on all but the two `syncSocialCalendarScheduled`
rows: these are host-level failures, not code bugs.

## Root cause: T-511, the keyless AzureWebJobsStorage

This is the failure mode documented in `infra/functionapp.tf` (T-511):

- `azurerm_function_app_flex_consumption` re-injects a keyless
  `AzureWebJobsStorage` connection string (empty `AccountKey`) on **every
  Terraform apply** — hashicorp/terraform-provider-azurerm#29149, open,
  reproducing on the pinned 5.1.0.
- The Functions host uses that string for its own storage (timers,
  singleton locks, SyncTriggers). With an empty key, every storage call
  fails the signature check with exactly the error above.
- An azapi read-then-update pair strips the setting in the same apply, so
  it does not survive an apply that completes. But an app-settings change
  **restarts the host**, and a host that (re)starts while the keyless
  setting is present fails every listener start — a burst of exceptions —
  until the strip lands and the next restart recovers. That is why the
  bursts are short-lived and self-clearing.

Activity Log for `func-site-prod-cus-01` (`sites/config` writes) lines up
with every burst:

| Burst (UTC) | Config writes in the window |
|---|---|
| Nov 23 02:01 (18) | Terraform 02:00:40–02:00:57; deploy 02:03–02:05 |
| Nov 23 13:16 (101) | Terraform 13:14, 13:17, 13:18, 13:21; deploy 13:24–13:26. The 13:14:47–13:15:00 listener failures and the 13:18:07 / 13:21:37 storage 403s fall minute-for-minute on the Terraform writes. |
| Nov 23 23:46 (58) | Deploy 23:40–23:42; Terraform 23:44–23:45 |
| Nov 24 03:46 (26) | Terraform apply 03:59 (the reader-creation apply; RBAC alerts 04:06–04:07); burst spans 03:30–04:15 |
| Nov 24 05:06 (8) | Terraform 05:02 |
| Nov 24 06:06 (22) | Terraform 06:01; deploy 06:03–06:36 |
| Nov 24 07:00 (2) | Terraform 07:12–07:13; deploy 07:15–07:18 |
| Nov 24 16:15 (3) | Terraform 16:26 |

The Terraform caller in every case is the HCP Terraform run identity
(`f4a9edf1-973f-4ddc-9117-c496a420c142`) — the same identity behind the
Nov 23 Sev4 RBAC alerts and the kv-errors 403s (it calls
`CertificateContactsGet` on both vaults on every run and is refused there
too, for the same reason: Contributor is management-plane only). The
deploy caller is a second identity (`6aa5f474-3f2e-44b4-ba87-8a75300e9c34`).
Deploys restart the host as well, so a deploy overlapping an apply's
window bursts too — but the writer of the bad setting is Terraform, not
the deploy.

## Correction to the Nov 21 finding

The Nov 21 firing (58 exceptions, 02:41–03:07 UTC Nov 22) was attributed
to the Deploy Functions run 44977705523 as a "deploy-restart signature,
not a code bug". That conclusion stands, but the mechanism is now precise:
it was the same T-511 window — merges #1759/#1761/#1762 triggered applies
in the same hour, and the host restarted while the keyless setting was
present. It was not a distinct deploy problem.

## Impact

During each burst window the timer listeners cannot start, so timers due
in that window may run late or not at all. The host recovers on the next
restart after the strip. Whether any timer run was actually missed (as
opposed to delayed) is not yet established from the exception rows alone.

## Caveats

- The keyless setting could not be observed directly at burst time: it is
  transient by design (present only inside the apply window), and the
  Reader role's `config/appsettings` GET returns an empty properties map —
  setting values are not readable with Reader access.
- The gRPC aborts, the two `RpcException`s on
  `syncSocialCalendarScheduled`, and the queue `GetPropertiesAsync`
  failures are treated here as secondary (host-restart disruption), not a
  separate cause. That reading should be confirmed, not assumed.

## Open questions for @claude

1. Verify the T-511 mechanism on current main: the azapi strip pair, the
   `deploy-functions.yml` assertion that `AzureWebJobsStorage` is absent,
   and whether azurerm #29149 has closed (if it has, the pair, T-511 and
   `scripts/assert-expected-plan.mjs` can go together, per the comment).
2. Confirm from the repo side that no function-code change is needed.
3. Check whether any timer run was actually missed during the bursts, or
   only delayed — timer-overdue alert state and function execution history.
4. Recommend the fix: accept the transient bursts as the known cost of the
   strip design; tune `alert-app-exceptions` (e.g. exclude listener-start
   exceptions during applies); fix the re-injection (azurerm upgrade if
   #29149 closed); or make the strip atomic. Recommend one.
5. Update this doc with the findings. Do not merge.

## Queries used

Workspace `log-plat-prod-cus-01`, via `azure_query.py`:

```kql
// 3-day summary by operation + type
AppExceptions
| where TimeGenerated > ago(3d)
| summarize count() by OperationName, Type, ProblemId
| order by count_ desc

// 15-minute buckets
AppExceptions
| where TimeGenerated > ago(3d)
| summarize count() by bin(TimeGenerated, 15m)
| order by TimeGenerated desc

// detail rows for a firing window, e.g. the 101-exception burst
AppExceptions
| where TimeGenerated between (datetime(2026-11-23T13:00:00Z) .. datetime(2026-11-23T13:45:00Z))
| project TimeGenerated, OperationName, Type, ProblemId, OuterMessage, Method, SeverityLevel
| order by TimeGenerated desc
| take 50
```

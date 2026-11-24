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
| Nov 24 07:00 (2, below threshold) | Terraform 07:12–07:13; deploy 07:15–07:18 |
| Nov 24 16:15 (3, below threshold) | Terraform 16:26 |

The Terraform caller in every case is the HCP Terraform run identity
(its object id is in the Activity Log; it is not written here because this
repository is public) — the same identity behind the
Nov 23 Sev4 RBAC alerts and the kv-errors 403s (it calls
`CertificateContactsGet` on both vaults on every run and is refused there
too, for the same reason: Contributor is management-plane only). The
deploy caller is a second identity, the Deploy Functions workflow's
sign-in.
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

Answered in "Review, Nov 24" below.

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

## Review, Nov 24

This section answers the five questions above. It comes from reading the
repository on `main` and the public GitHub and Microsoft Learn pages, all on
Nov 24. This review could not sign in to Azure (`az account show` returned
"Please run 'az login'"), so nothing below re-ran a Log Analytics query. The
places that need a live query say so and give the query.

### 1. The T-511 mechanism is in place on `main`, and the upstream bug is still open

- **The strip pair (two azapi resources that read the settings and then
  write them back without `AzureWebJobsStorage`).** These are
  `azapi_resource_action.function_app_settings` and
  `azapi_update_resource.function_app_settings_without_webjobs_storage`, at
  the end of [`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf). The second
  writes every setting except `AzureWebJobsStorage`, and it stamps
  `RUNTIME_CONFIG_WRITER = azapi-strip` so that a host that missed the strip
  can be told apart from one that got it. Both are replaced on every change
  to the Function App (`replace_triggered_by`).
- **The deploy check.** The step "Assert AzureWebJobsStorage is absent, then
  sync triggers" in
  [`deploy-functions.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/deploy-functions.yml) fails
  the deploy if `AzureWebJobsStorage` is present, or if
  `RUNTIME_CONFIG_WRITER` is not `azapi-strip`. It checks and fails; it does
  not repair. That is the right choice, because a repair would hide a broken
  strip.
- **Upstream.**
  [hashicorp/terraform-provider-azurerm#29149](https://github.com/hashicorp/terraform-provider-azurerm/issues/29149)
  is **open** (read from the GitHub API on Nov 24: `state: open`, 15
  comments, last updated 2026-10-28). Neither release notes for
  [v5.14.0](https://github.com/hashicorp/terraform-provider-azurerm/releases/tag/v5.14.0)
  (the version in `infra/.terraform.lock.hcl`) nor those for
  [v5.15.0](https://github.com/hashicorp/terraform-provider-azurerm/releases/tag/v5.15.0)
  (released Nov 24) mention Flex Consumption or `AzureWebJobsStorage`.
  Because the bug is still open, the pair, T-511 and
  `scripts/assert-expected-plan.mjs` all stay.
- **These bursts are fresh proof that the bug reproduces on 5.14.0.** The
  last comment on #29149 (2026-10-28, another user on azurerm 4.61.0)
  describes the same pattern: host-storage 403 bursts that start within
  three minutes of the Terraform identity's `sites/config` writes.

**Why every apply opens the window, not just applies that change a
setting.** `RUNTIME_CONFIG_WRITER` is deliberately different between the two
writers (`azurerm` and then `azapi-strip`). So every plan shows a change on
the Function App, which is the "permanent diff" described above that key in
`functionapp.tf`. That means every apply makes azurerm write the settings
again. That write puts the keyless string back and restarts the host. The
strip's write a few seconds later restarts the host again. An apply that
only changes a role assignment elsewhere still restarts the Function App
twice. That is why there were seven firings in three days and not one or
two.

**Three things to correct, found while checking. None changes the
conclusion.**

1. [`deploy-functions.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/deploy-functions.yml)
   (the comment above the assert step, about line 335) says the azapi pair
   is "in infra/main.tf". It is in `infra/functionapp.tf`. This looks like a
   leftover from before the Function App moved into its own file. The fix
   is a one-word comment change. A session cannot push changes under
   `.github/workflows` through the Claude GitHub App (the app this review
   runs as), so it has to be made from the owner's computer.
2. `infra/functionapp.tf` (the `AzureWebJobsStorage__accountName` comment,
   about line 399, and the FTP-policy comment, about line 1240) still says
   "the 5.1.0 pinned in .terraform.lock.hcl". The lock file has
   **5.14.0**. That file's own rule is "on every azurerm minor upgrade,
   re-test #29149", and these bursts are that re-test, so the comment can
   now say 5.14.0 and cite this page. This looks like an oversight.
3. Two rows in the Activity Log table above do not fit "minute for minute".
   The Nov 24 03:46 burst is shown as starting at 03:30, but the Terraform
   write is at 03:59. The Nov 24 07:00 row (below the alert's threshold) is
   before the 07:12 Terraform write. Either an earlier `sites/config` or
   `sites/write` call is missing from the table (a deploy, or the
   reader-creation work), or those exceptions have another cause. Before
   "every burst" is called proven, re-run the Activity Log query for
   03:15–04:20 and 06:45–07:20 on Nov 24 and list every write on the site,
   from any caller.

### 2. No function-code change is needed

- No exception names a handler. Every storage failure is in the host's own
  code (`Microsoft.Azure.WebJobs.Host...`, `Azure.Storage.Blobs/Queues`).
- The `BlobStorageConcurrencyStatusRepository.ReadAsync` frame comes from
  [`functions/host.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/host.json):
  `concurrency.snapshotPersistenceEnabled: true` makes the host keep its
  dynamic-concurrency snapshot in host storage. It fails here only because
  host storage authentication fails. Nothing to change.
- The `QueueRestClient.GetPropertiesAsync` failures come from the two queue
  triggers (`brainIndexWorker` in `brain-http.js` and `platformJobWorker` in
  `jobs-worker.js`) checking their queues with the same bad connection.
  Queue messages stay in the queue, so they are processed late, not lost.
- The gRPC aborts and the two `RpcException`s on
  `syncSocialCalendarScheduled` (a 5-minute timer) match the host being
  restarted while a worker call was in progress. gRPC is the channel
  between the Functions host and the Node.js worker. The next run 5 minutes
  later re-does the same reconciliation. Treating them as secondary, as the
  caveat above does, is consistent with the code. It was not checked
  against the rows' timestamps.
- None of the timers sets `runOnStartup: true`. The only explicit
  `runOnStartup` is `false`, on `brainIndexReconcile`. So a restart does not
  start extra runs.

### 3. Missed or delayed: most likely delayed, but the daily timers need one query

**From the repository and the documentation (checked).** Microsoft's
[timer trigger reference](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-timer)
says `useMonitor` "persists schedule occurrences to aid in ensuring the
schedule is maintained correctly even when function app instances restart".
It defaults to `true` for any schedule of one minute or longer. No timer
here sets `useMonitor`, and the shortest schedule is 2 minutes
(`sweepVisitorSessions`), so every timer is monitored. When a listener
finally starts, a run that was due while it was down is started late, with
`isPastDue = true`. The same page also says "the timer trigger doesn't
retry after a function fails", so this catch-up covers a listener that was
down, not a run that failed.

**What that means in practice (not verified live).** A short-period timer
that missed several runs during one burst gets **one** late run, not one
for each missed slot. For example, `checkAgentHealth` (every 5 minutes)
across a 25-minute burst probably skipped four slots and ran once at the
end. Every short timer here is a sweep or reconciliation that picks up
whatever is waiting, so one late run does the work of the skipped ones. The
runs that matter are the **once-a-day and once-a-week timers whose time
fell inside a burst**. Read against the schedule map (`timer_schedules` in
[`infra/observability.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/observability.tf)):

| Burst | Timers due inside it (UTC) |
|---|---|
| Nov 22 02:41–03:22 | `cosmosExportScheduler` 03:00 |
| Nov 23 02:00–02:32 | `refreshToolServiceCache` 02:00, `syncRssFeeds` 02:00 |
| Nov 23 13:00–13:42 (Monday) | **`buildWeeklyNewsletter` 13:00 (weekly)**, `sendReminders` 13:00 |
| Nov 23 23:40–Nov 24 00:12 | `labsWeeklyRollup` 23:55, `cleanupTempStorage` 00:00, `refreshPlaudToken` 00:00, `monitorPublishingPipeline` 00:00, `cleanupSoftDeletedContent` 00:00, `syncRssFeeds` 00:00, `syncSearchConsole` 00:10 |
| Nov 24 03:30–04:27 | `forgeScheduled` 03:30, `cleanupRejectedContent` 04:00, `cleanupSoftDeletedContent` 04:00, `syncRssFeeds` 04:00 |
| Nov 24 05:00–05:32 | `cleanupUnusedCertImages` 05:00 |
| Nov 24 06:00–06:32 | `syncRssFeeds` 06:00, `fetchBlogListings` 06:15 |

**Why the timer-overdue alert alone cannot answer this.**
`alert-timer-overdue-prod-cus` waits 45 minutes after a run was due (its
`Grace`) and then needs a successful run at or after that time. Every burst
above was shorter than about 45 minutes, so a late catch-up run inside that
grace never trips it. So if it stayed quiet, the late run probably
happened, which fits "delayed". If it fired for one of the timers above, a
run was really missed. Its firing history for Nov 21–24 is in Azure
Monitor's alert list, which this review could not read.

**The query that settles it.** Run it against `log-plat-prod-cus-01`, the
same way as the queries below. A row with an empty `firstSuccess` is a
missed run. Otherwise `delay` is how late it was.

```kql
let Due = datatable(timer: string, due: datetime) [
  "cosmosExportScheduler",     datetime(2026-11-22T03:00:00Z),
  "refreshToolServiceCache",   datetime(2026-11-23T02:00:00Z),
  "buildWeeklyNewsletter",     datetime(2026-11-23T13:00:00Z),
  "sendReminders",             datetime(2026-11-23T13:00:00Z),
  "labsWeeklyRollup",          datetime(2026-11-23T23:55:00Z),
  "cleanupTempStorage",        datetime(2026-11-24T00:00:00Z),
  "refreshPlaudToken",         datetime(2026-11-24T00:00:00Z),
  "monitorPublishingPipeline", datetime(2026-11-24T00:00:00Z),
  "cleanupSoftDeletedContent", datetime(2026-11-24T00:00:00Z),
  "syncSearchConsole",         datetime(2026-11-24T00:10:00Z),
  "forgeScheduled",            datetime(2026-11-24T03:30:00Z),
  "cleanupRejectedContent",    datetime(2026-11-24T04:00:00Z),
  "cleanupSoftDeletedContent", datetime(2026-11-24T04:00:00Z),
  "cleanupUnusedCertImages",   datetime(2026-11-24T05:00:00Z)
];
let Runs = AppRequests
  | where TimeGenerated > datetime(2026-11-21T12:00:00Z)
  | extend timer = replace_string(Name, "Functions.", "")
  | project timer, ran = TimeGenerated, Success;
Due
| join kind=leftouter Runs on timer
| summarize firstRun = minif(ran, ran >= due),
            firstSuccess = minif(ran, ran >= due and Success == true)
    by timer, due
| extend delay = firstSuccess - due
| order by due asc
```

For the short timers, this lists every gap between successful runs that is
longer than one and a half periods. Each gap should line up with a burst.

```kql
let Period = datatable(timer: string, period: timespan) [
  "sweepVisitorSessions", 2m, "checkAgentHealth", 5m,
  "syncSocialCalendarScheduled", 5m, "healthPulse", 5m,
  "brainIndexReconcile", 15m, "platformJobSweeper", 15m,
  "publishScheduledContent", 15m, "labCanary", 1h, "syncRssFeeds", 2h
];
AppRequests
| where TimeGenerated > ago(3d) and Success == true
| extend timer = replace_string(Name, "Functions.", "")
| join kind=inner Period on timer
| sort by timer asc, TimeGenerated asc
| extend prevRun = prev(TimeGenerated), prevTimer = prev(timer)
| where timer == prevTimer and TimeGenerated - prevRun > period * 1.5
| project timer, prevRun, nextRun = TimeGenerated, gap = TimeGenerated - prevRun
| order by prevRun asc
```

### 4. Recommendation: change the alert, and leave the strip as it is

The four options, briefly:

- **Accept the bursts as they are.** No. That leaves a Sev1 page about
  twice a day for something that is known and clears itself, which teaches
  people to ignore Sev1.
- **Upgrade azurerm to a fixed version.** Not possible yet, because #29149
  is open and neither 5.14.0 nor 5.15.0 fixes it.
- **Make the strip atomic (done in a single write).** Not possible inside
  Terraform. The PLAT-2 note in `functionapp.tf` explains why no ordering
  closes the gap: the strip can only run after azurerm's write. The only
  atomic route is to stop managing the Function App with azurerm at all and
  manage `Microsoft.Web/sites` entirely through azapi. That would mean moving
  a stateful, `prevent_destroy` resource and rewriting the plan assertion.
  That is a separate decision record, not a fix for this alert.
- **Tune `alert-app-exceptions` (recommended).** We now have three days and
  428 classified rows, which is the evidence the comment on that rule asks
  for before a filter is added ("a week of real firing"; three days is less
  than a week, but every row in it has been put in a category).

**What the tuning should be, as a follow-up Terraform pull request in
`infra/observability.tf`:**

1. **Leave the T-511 signature out of the Sev1 rule.** The signature is an
   exception with an empty operation name that is either a host-storage 403
   `AuthenticationFailed` or a "listener … was unable to start". Every other
   exception still counts, so a real code fault still pages at Sev1. A
   starting point for the query (the component scope uses the classic
   `exceptions` schema):

   ```kql
   exceptions
   | where not(isempty(operation_Name)
       and (outerMessage has "was unable to start"
            or (outerMessage has "AuthenticationFailed" and outerMessage has "403")))
   ```

   Before applying it, run the same filter over the last three days with
   `bin(timestamp, 15m)` and check that no 15-minute bucket is still above
   5. If the gRPC restart aborts push a bucket over, they need the same
   treatment, limited to `type` `ConnectionAbortedException` and
   `InvalidOperationException` with an empty operation name.
2. **Add a separate rule that fires only if the signature keeps going.**
   Something like `alert-host-storage-auth-prod-cus`, Sev2, evaluated every
   15 minutes, firing only when the signature appears in **four
   consecutive** periods (`failing_periods` 4 of 4, so about an hour). A
   normal apply window lasts a few minutes, and the longest burst here was
   about 45 minutes. A host where the strip did not land stays broken until
   the next apply, so this catches it. The deploy check,
   `monitor-functions-registered.yml` and `alert-timer-overdue` already
   cover that case too, so this rule is a backstop, not the only guard.
3. Fix the two comment discrepancies from section 1 in the same pull
   request (the workflow one from the owner's computer).

Under the repository's working agreements, the Terraform change goes to
`terraform-expert-engineer` for the build and to `infrastructure-pr-reviewer`
before the pull request is opened.

### Not checked in this review

- No Log Analytics, Activity Log or Azure Monitor alert-history query was
  run, because this runner has no Azure sign-in. The two KQL blocks in
  section 3 and the Activity Log re-check in section 1 are still to be run.
- The value of `AzureWebJobsStorage` at the time of a burst was not seen,
  for the reason given under Caveats above.
- That the host retries a listener that failed to start (which would
  explain 222 listener rows from 9 timers over 7 bursts) is how the
  Functions host is understood to behave. It is not verified here.

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

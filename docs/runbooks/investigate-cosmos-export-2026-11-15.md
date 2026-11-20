# Investigate: no full Cosmos export completed Sunday

Date: 2026-11-15. Status: investigating (draft PR). Repository-side checks
done 2026-11-20; the Azure-side checks are still open (see "What is still
open" below).

## What was seen

- **Sev2 `alert-cosmos-export-full-prod-cus`** on `appi-site-prod-cus-01`
  (`rg-web-site-prod-cus`) fired **01:14 UTC Nov 16** (5:14 PM PT Nov 15),
  alert ID not copied here, as this repository is public; the portal's alert history has it.
- **First time this alert type has fired.** No full Cosmos export completed on
  Sunday. The alert is stateless — one mail per missed Sunday — so it will
  **not auto-resolve**.
- Alert's own description: "No full Cosmos export completed on Sunday,
  checked each Monday over the trailing 2 days. Deltas since the last full
  keep accumulating and deletes stay unreconciled until the next full lands.
  Stateless: one mail per missed Sunday. ADR 0028."

## What it means

The site itself is up and unaffected — this is about the data export, not the
site. The export copy of the data is going stale: changes since the last full
export keep accumulating, and deleted items are not being cleaned out of the
export copy until a full export lands.

## What to check

1. What runs the Sunday full export (timer / function / schedule)? Find its
   definition and its last successful run.
2. Why didn't Sunday's run happen — did the job fail, or never trigger?
   Check the job's logs for the Sunday window.
3. Read ADR 0028 (`docs/decisions`) for the export design, so the fix matches
   the intended behavior.
4. Confirm the next full export is scheduled and will pick up the backlog
   (deltas applied, deletes reconciled).

## What the repository shows (checked 2026-11-20)

Everything in this section was read from the code and Terraform on `main`.
None of it was checked against Azure: a session working from GitHub cannot
read the Function App's logs, Application Insights or the storage account.

### How the export is meant to work (ADR 0028)

[ADR 0028](../decisions/0028-cosmos-out-of-account-export.md) (an ADR is a
decision record, a short page that says what was decided and why) sets the
design:

- **Once a day at 03:00 UTC the export runs.** On Sunday it copies every
  included container in full. On the other six days it copies only what
  changed since the day before, read from the Cosmos change feed (Cosmos's
  running list of the documents that changed).
- **The Sunday full is also how deletes reach the copy.** The daily change
  feed does not report deleted documents, so a document deleted on Tuesday
  only disappears from the copy when the next full is taken without it.
  That is why a missed full matters: until a full lands, a restore would
  bring back up to two weeks of deliberately deleted documents instead of
  one.
- **The copy goes to the `cosmos-export` blob container** on
  `stsiteprodcus01`, under one folder per run (`full/2026-11-15/`,
  `delta/2026-11-16/`). That container has a 35-day write-once lock
  (Azure calls it a time-based immutability policy): a file written there
  cannot be overwritten or deleted for 35 days.
- **Only absence pages.** A run that finishes sends one
  `cosmosExportCompleted` event to Application Insights. The alerts fire when
  that event is missing, never on an error message.

### What runs it

There is one timer and one queue job, both in
[`functions/src/functions/cosmos-export.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/cosmos-export.js):

| Part | What it does | Where |
| --- | --- | --- |
| Timer `cosmosExportScheduler` | Fires daily at `0 0 3 * * *` (03:00 UTC; the app sets no `WEBSITE_TIME_ZONE`, so the schedule is UTC). Picks `full` when the UTC day is Sunday, `delta` otherwise. Writes a run record `full/<date>/run.json`, then puts one job per container on the platform jobs queue. | `cosmos-export.js` line 42; `modeFor` and `createExportScheduler` in [`lib/backup/cosmos-export.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/cosmos-export.js) |
| Job type `cosmos-export-container` | The jobs worker runs one per container: reads the whole container, writes `<container>.ndjson.gz`, then a `<container>.marker.json` beside it. Time limit 28 minutes per container. | `cosmos-export.js` line 63; `createContainerExporter` in `lib/backup/cosmos-export.js` |
| Run completion | The worker that finds every container's marker present writes `manifest.json` and sends the one `cosmosExportCompleted` event. | `completeRunIfLast` in `lib/backup/cosmos-export.js` |
| On/off switch | The timer does nothing unless the app setting `FEATURE_FLAG_COSMOS_EXPORT` is `true` and `FEATURE_FLAG_SCHEDULERS` is not `false`. Terraform sets the first from `cosmos_export_enabled`, the same variable that creates both alerts. | [`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf) line 927, [`infra/variables.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/variables.tf) line 769 |
| The alert that fired | Runs once a day. On a Monday, if no `full` event arrived in the last two days, it fires. | `cosmos_export_full_missing` in [`infra/observability.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/observability.tf) line 1518 |

A full run on today's code covers 64 containers; a delta covers 57 (the
seven extra are the operational logs, such as `admin_audit_logs` and
`ai_usage`, which are copied on Sundays only).

### Nothing in the repository changed the exporter before Sunday

`git log` on the exporter, its storage code, the jobs queue, the alert and
the storage Terraform shows no change since 2026-10-25 apart from two CI
housekeeping commits on 2026-11-12 that do not touch the exporter's code. So
the cause is not a code change that landed that week. The alert also had not
fired on any earlier Sunday, so the Sunday path worked before.

### The three ways the alert can fire, and how to tell them apart

The alert only knows that the `cosmosExportCompleted` event with mode `full`
is missing. From the code, three different things produce that:

1. **The timer never started the Sunday run.** The switch was off, the
   Function App was down or restarting at 03:00 UTC, or the timer was held
   off. Sign: there is no `full/2026-11-15/run.json`.
2. **The run started but at least one container did not finish.** One
   container job failed or ran past its 28 minutes, so its marker was never
   written, no manifest was written and no event was sent. Sign:
   `full/2026-11-15/run.json` exists but fewer than 64 markers do. A failed
   job also sends the "failed platform job" notification
   (`createJobFailureOnComplete`), so a phone alert on Sunday morning would
   point here.
3. **The run finished but its event never reached the logs.** The manifest
   exists, so the backup is fine, but the event was dropped. This has
   happened before: until
   [#1530](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1530)
   (2026-11-03) the log workspace hit its daily size cap most evenings and
   dropped everything until 08:00 UTC, which includes the 03:00 UTC export.
   The `alert-logs-overquota` rule exists to show this. Sign:
   `full/2026-11-15/manifest.json` exists.

One more clue the owner already has: **whether `alert-cosmos-export-daily`
also fired on Monday or Tuesday.** That rule fires when no run at all, full
or delta, finished in two days. If it stayed quiet, the daily runs on
Saturday and Monday finished, which means the switch was on and the timer
was alive, and case 1 is unlikely.

A cause the code makes possible, not confirmed: a container job that wrote
its data file and then failed before writing its marker cannot succeed on a
retry. The retry would try to write the same data file again, and the 35-day
write-once lock on `cosmos-export` is expected to refuse that. The job would
keep failing until it is sent to the failed-jobs queue. This was not tested;
it is listed so the person reading the Sunday logs knows to look for a
storage "blob is immutable" error.

### Can a full export be started by hand?

**Yes, but there is no button or script for it.** The only way in is the
general jobs route `POST /api/enqueueJob`
([`functions/src/functions/jobs-http.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/jobs-http.js)),
called once per container with type `cosmos-export-container` and a payload
of `{ "runId": "<date>", "mode": "full", "container": "<name>" }`. The job
type is marked `super_admin`, so only a signed-in super admin can enqueue it,
and the timer's own comment says a hand enqueue is intended to be rare. For
a full run that is 64 separate calls, one per container in the full plan
([`export-classification.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/export-classification.js)).

Things to know before doing it:

- **Use a new date as the `runId`, not `2026-11-15`.** Any container whose
  data file was already written for the 15th cannot be written again for 35
  days (the write-once lock), so re-running that date is expected to fail
  for those containers. The `runId` only has to be a date; a full under a
  weekday's date is fine for a restore, because the restore script picks the
  newest complete `full/<date>/manifest.json`
  (`selectRestoreSet` in
  [`scripts/lib/cosmos-export-restore.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/lib/cosmos-export-restore.mjs)).
- **The admin Health page would not show it.** The "Nightly export" card
  ([`backup-status.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/backup-status.js))
  only looks for a full on Sundays and a delta on other days, so a hand full
  on a weekday is invisible there. Check it with the Application Insights
  query below instead.
- **It does not clear the alert that already fired.** That alert is
  stateless: it sent its one mail and has nothing to resolve.

The recommendation is **not to run one by hand** and to let the scheduled
full on **Sunday 2026-11-22** at 03:00 UTC do the catch-up, unless the
checks below show the Sunday path itself is broken (case 2 with a container
that keeps failing). A scheduled full re-reads every container from scratch,
so it picks up all the changes and drops all the deletes since the last good
full, with nothing extra to do. A small script to enqueue a hand full, if it
is wanted, is new work for its own ticket.

### The next full export

The timer's schedule and the Sunday rule are unchanged, so the next full is
due **Sunday 2026-11-22 at 03:00 UTC** under `full/2026-11-22/`. Its
`cosmosExportCompleted` event with mode `full` should appear in Application
Insights a short time later (the run's length is the sum of the container
jobs; the event's `durationMs` says how long earlier runs took). If it does
not arrive, `alert-cosmos-export-full-prod-cus` fires again early on Monday
2026-11-23.

## What is still open

**Why Sunday's run did not complete is not known.** The repository does not
show it; only Azure can. These steps decide between the three cases above.
All commands are PowerShell, one line each.

1. **Before Sunday 2026-11-22, open the admin Health page** at
   `https://hybridcloudworks.com/admin/health?tab=overview` and read
   **Operational Signals → Nightly export**. It reads the export files
   directly, not the logs, and looks back seven days, so 2026-11-15 drops off
   it on the 22nd. It tells the cases apart: no record for the 15th is
   case 1, a record with fewer than 64 markers is case 2 (it says how many),
   a completed run is case 3.
2. **List the export events of the last two weeks.** A healthy fortnight
   shows two `full` rows and twelve `delta` rows; the question is whether
   `2026-11-15` is missing and whether the deltas around it are there.

   ```powershell
   az monitor app-insights query --app appi-site-prod-cus-01 -g rg-web-site-prod-cus --offset 14d --analytics-query 'customEvents | where name == "cosmosExportCompleted" | project timestamp, mode = tostring(customDimensions.mode), runId = tostring(customDimensions.runId), containers = toint(customDimensions.containers), docs = tolong(customDimensions.docs), durationMs = tolong(customDimensions.durationMs) | order by timestamp desc' -o table
   ```

3. **Read the exporter's own log lines for Sunday morning.** Each line names
   a container, a count and a time, never a document. A container that
   started and has no "docs, bytes" line after it is the one that failed.

   ```powershell
   az monitor app-insights query --app appi-site-prod-cus-01 -g rg-web-site-prod-cus --start-time 2026-11-15T02:55:00Z --end-time 2026-11-15T08:00:00Z --analytics-query 'traces | where message startswith "[cosmosExport]" or message startswith "cosmosExportScheduler" | project timestamp, message | order by timestamp asc' -o table
   ```

   If this prints nothing at all, also check whether the log cap was hit that
   night (case 3): the `alert-logs-overquota` rule would have fired between
   Saturday evening and 08:00 UTC Sunday.

4. **Check the switch is still on.** It should print `true`.

   ```powershell
   az functionapp config appsettings list -g rg-web-site-prod-cus -n func-site-prod-cus-01 -o json | ConvertFrom-Json | Where-Object name -eq FEATURE_FLAG_COSMOS_EXPORT | Select-Object name, value
   ```

These are the same checks the
[Cosmos restore runbook](cosmos-restore.md) gives for a missing run, and the
[alerting runbook](alerting-and-support.md) lists both export alerts.

## Done when

- [ ] The cause of the missed Sunday export is named in this doc.
- [ ] A full export completes and the export copy reconciles.
- [ ] The Sunday job's failure cause is fixed, or its schedule is corrected.

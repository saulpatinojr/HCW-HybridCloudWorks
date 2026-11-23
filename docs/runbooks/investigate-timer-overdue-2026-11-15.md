# Investigate: more than five timers overdue at once

Opened 2026-11-15, updated 2026-11-21. Status: **findings recorded, ready for
review.** The alert is a side effect of the log cap, not failing jobs; the fix
belongs to the log-cap investigation
([#1729](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1729)).

## In short

Every night the Log Analytics workspace (where the site's logs are stored)
reaches its daily size limit, the "daily cap", and from then until the cap
resets at 08:00 UTC (midnight Pacific) nothing new is logged. The timer jobs
keep running on schedule, but the record of each run is thrown away. The timer
alert (`alert-timer-overdue-prod-cus`) decides whether a timer ran by looking
for that record, so after the reset it sees jobs with no recorded run and
pages. It is a blind spot in the monitor, not a broken job.

The cap stops the *collection* of logs, not the app: Microsoft's page on the
[daily cap](https://learn.microsoft.com/azure/azure-monitor/logs/daily-cap)
says "once the daily cap is reached, data collection stops" and calls the
workspace "effectively blind" until the reset.

## What was seen

All times below are given in UTC and Pacific (PT, which is UTC−8 since
daylight saving ended on 2026-11-01).

### Nov 14–15 (first firings)

- **Sev2 `alert-timer-overdue-prod-cus`** on `appi-site-prod-cus-01`
  (`rg-web-site-prod-cus`), series "more than five timers at once", fired
  **08:07 UTC Nov 14** and again **08:07 UTC Nov 15** (the alert ID is not
  copied here because this repository is public; the portal's alert history
  has it). Both are 7 minutes after the 08:00 UTC cap reset.
- At **12:07 UTC Nov 14** four timers were paged one by one:
  `generateReviewerDigest`, `ambassadorAudienceMonthly`,
  `cleanupUnusedCertImages`, `fetchBlogListings`.
- `fetchBlogListings` resolved 12:53 UTC Nov 14. The other three resolved
  **04:08 UTC Nov 15**, about an hour after that night's over-the-cap alert
  (Sev1, 03:00 UTC Nov 15, recorded on #1729).

### Nov 18–20 (reported by the owner, 2026-11-20)

| Event | PT | UTC |
| --- | --- | --- |
| "More than five timers at once" fires, Nov 19 and Nov 20 | 12:07 AM | 08:07 |
| Five timers paged one by one, each morning: `cleanupRejectedContent`, `generateReviewerDigest`, `ambassadorAudienceMonthly`, `fetchBlogListings`, `cleanupUnusedCertImages` | 04:07 AM | 12:07 |
| "More than five timers at once" resolves | ~04:38 AM | ~12:38 |
| `fetchBlogListings` resolves | ~04:53 AM | ~12:53 |

The same pattern, to the minute, on every night the cap was hit.

## How the alert decides a timer is overdue

The rule is `azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue` in
[`infra/observability.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/observability.tf)
(search for `timer_overdue`), with each timer's schedule in the
`timer_schedules` map just above it. Every 15 minutes it:

1. Works out, for each timer, the last time it was due at least 45 minutes ago
   (the "grace", which allows for a 30-minute run plus logging delay).
2. Looks in the last two days of `requests` (one row per finished function
   run, written by Application Insights) for a successful run of that timer at
   or after that time.
3. Lists every timer with no such run. If more than five are listed, it sends
   one alert named "more than five timers at once" instead of one per timer.
4. Returns nothing at all if no `requests` row has arrived in the last 30
   minutes (the `Ingesting` guard), so that a capped workspace does not page
   once per timer.

It resolves a series after two clean evaluations (about 30 minutes), because
`auto_mitigation_enabled = true`.

## Each timing, explained

Times are UTC; the schedules are from
[`functions/src/functions/schedulers.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/schedulers.js)
and
[`functions/src/functions/ambassador-audience.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/ambassador-audience.js),
and they match the alert's `timer_schedules` map (a test,
`timer-alert-schedules.test.js`, keeps the two the same).

| Timer | Schedule (NCRONTAB, UTC) | Due | Next run |
| --- | --- | --- | --- |
| `cleanupRejectedContent` | `0 0 4 * * *` | 04:00 daily | 04:00 next day |
| `cleanupUnusedCertImages` | `0 0 5 * * *` | 05:00 daily | 05:00 next day |
| `ambassadorAudienceMonthly` | `0 45 6 * * *` | 06:45 daily | 06:45 next day |
| `generateReviewerDigest` | `0 0 7 * * *` | 07:00 daily | 07:00 next day |
| `fetchBlogListings` | `0 15 */6 * * *` | 00:15, 06:15, 12:15, 18:15 | 12:15 same day |

- **During the blackout (cap hit → 08:00) the rule is silent.** No `requests`
  rows arrive, so the `Ingesting` guard returns nothing. Any timer alert still
  open is resolved during this window, which is why the Nov 14 alerts
  "resolved" at 04:08 UTC Nov 15, about an hour after that night's cap hit.
  Those resolutions do **not** mean the timers ran; the rule had stopped
  looking.
- **08:07: "more than five at once".** Logging resumes at 08:00. The first
  evaluation after that sees every timer whose run fell in the blackout as
  having no recorded success: the four daily timers above, `fetchBlogListings`
  (06:15), and the frequent ones (every 2 to 15 minutes) that have not yet run
  again. That is more than five.
- **Frequent timers clear within minutes.** Their next run is logged.
- **12:07: five timers paged one by one.** The count drops to five, so the
  rule stops grouping and names each timer. The sixth to clear was most likely
  `monitorPublishingPipeline` (every 6 hours; its 06:00 run fell in the
  blackout and its 12:00 run was logged). This is worked out from the
  schedules, not checked in the logs.
- **~12:38: the grouped alert resolves**, two clean evaluations after 12:07.
- **~12:53: `fetchBlogListings` resolves.** It runs again at 12:15, that run
  is logged, and the series clears two evaluations later. This is the one
  timer in the list that genuinely "catches up" after the reset.
- **The four daily timers do not catch up the same day.** They run once a day,
  between 04:00 and 07:00 UTC (8 PM to 11 PM PT), which is inside the
  blackout. Nothing in the code re-runs them after the reset: none uses
  `runOnStartup`, and the timer trigger only runs a missed schedule late when
  the app was not running at the scheduled time
  ([timer trigger, `useMonitor` and `isPastDue`](https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer)),
  which is not the case here. So their alerts stay open through the day and
  only "resolve" when the next blackout blinds the rule, and the cycle
  repeats.
- **`cleanupRejectedContent` joined the list on Nov 19.** On Nov 14 the cap
  was hit at 04:15 UTC (#1729), just after its 04:00 run was logged. On Nov
  19 and 20 it was missing too, which means the cap was hit before its 04:00
  run finished, and its 03:30 neighbour `forgeScheduled` was not listed, so
  the cap was hit after 03:30. The cap is being reached earlier each night,
  which matches the volume growth recorded on #1729. The exact cap times for
  Nov 19 and 20 were not checked.

## Findings

1. **Confirmed from the code: the firings are the log-cap blackout, not
   failing jobs.** Every timing in the table above follows from the rule's
   query, the timers' schedules and the 08:00 UTC reset, with no failure
   needed to explain it.
2. **The owner's summary needs one correction.** "The timers catch up after
   the reset" is true for `fetchBlogListings` and the frequent timers. It is
   not true for the four daily timers: they are not re-run, their run that
   night is simply never recorded. Their alerts clear because the monitor goes
   blind the next night, not because a run was seen.
3. **Not proven: that the four daily timers succeeded.** The logs that would
   prove it are exactly the ones the cap dropped. The likely reading is that
   they ran (the app and its other timers were healthy either side of the
   blackout), but no run of these four between 04:00 and 07:00 UTC has been
   seen in any log since the cap started tripping that early.
4. **This repeats every night while the cap trips before 07:00 UTC.** Expect
   the grouped alert at 12:07 AM PT and the individual ones at 04:07 AM PT
   each morning until #1729 is resolved.

## Discrepancies noticed

- **The runbook's entry for this alert does not mention the cap.** The
  `alert-timer-overdue` row in
  [`docs/runbooks/alerting-and-support.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/alerting-and-support.md)
  says the cause is "the host is not running that timer, or every run fails".
  That is the case the rule was built for, but the commonest cause today is
  the cap. Looks like an oversight (the cap trips started after the rule was
  written). Fix: add one sentence to that row, "If it fires at 08:07 UTC right
  after the cap reset, check #1729 first."
- **The rule's comment covers the blackout but not its after-effect.** The
  "SILENT WHEN NOTHING AT ALL ARRIVES" note in `infra/observability.tf`
  explains why the rule is quiet while capped, but not that it then pages for
  every run that fell in the gap. Fix: the same, one sentence; or, if the cap
  cannot be raised, teach the query to ignore a due time that fell inside a
  cap blackout. The first is cheap; the second is a real query change and is
  only worth doing if the owner keeps the cap at 0.25 GB/day.

Neither fix is made in this pull request, which only records the
investigation.

## What would close this

1. **Stop the cap tripping.** This is the root cause and is tracked on
   [#1729](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1729)
   (raising the cap is the owner's decision, because it costs money). Once
   the cap no longer trips, this alert should stop firing on its own.
2. **Then confirm.** On the first night the cap is *not* hit, check that each
   of the five timers shows a successful run in Application Insights
   (`requests` where `name` is `Functions.<timer>` and `success` is true)
   after its scheduled time, and that no timer-overdue alert fires at 08:07
   UTC.
3. **Optional, if proof is wanted sooner.** The timer trigger keeps each
   timer's last run time in the Function App's own storage account (host
   storage), which the cap does not touch
   ([timer trigger docs, "Connections" and `useMonitor`](https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer)).
   Reading it would show whether the four daily timers ran during the
   blackout. Not tried: that storage account denies network access by default
   (ADR 0008), so it needs a firewall exception to read, and the exact place
   the run times are kept on this hosting plan was not confirmed.

## Done when

- [x] The cause of each firing is explained, with the evidence noted here.
- [ ] #1729 stops the nightly cap trip.
- [ ] One night with no cap trip shows all five timers with a logged
      successful run and no timer-overdue alert.

# Investigate: more than five timers overdue at once

Date: 2026-11-15. Status: investigating (draft PR).

## What was seen

- **Sev2 `alert-timer-overdue-prod-cus`** on `appi-site-prod-cus-01`
  (`rg-web-site-prod-cus`), dimension "more than five timers at once", fired
  **08:07 UTC Nov 15** (Alert ID `fa091ccf-8b6b-1500-bfc8-dae9364e0002).
  Still firing, no resolution email as of Nov 15 evening.
- It fired **7 minutes after the 08:00 UTC daily log-cap reset**, right after
  the Sev1 overquota alert (fired 03:00 UTC Nov 15) had been dropping logs
  overnight. The timer check was blind during the blackout, so some overdue
  timers may have run without their success being logged — or they genuinely
  did not run.

## The Nov 14 pile-up (context)

- First fired 08:07 UTC Nov 14; re-fired 12:07 UTC Nov 14 with **four**
  timers overdue at once: `generateReviewerDigest`,
  `ambassadorAudienceMonthly`, `cleanupUnusedCertImages`, `fetchBlogListings`.
- `fetchBlogListings` resolved 12:53 UTC Nov 14. The other three resolved
  **04:08 UTC Nov 15** — but those resolutions landed ~1 hour after the Sev1
  overquota fired, and the timer alert query needs live log ingestion to see
  overdue timers, so "resolved" may partly reflect the monitor going blind
  rather than the timers actually running.

## What to check

1. List which timers are overdue right now, and confirm each one actually ran
   successfully after the 08:00 UTC Nov 15 reset (function invocation logs /
   Application Insights), not just that the alert cleared.
2. Re-verify the three Nov 14 timers (`generateReviewerDigest`,
   `ambassadorAudienceMonthly`, `cleanupUnusedCertImages`) — did they really
   run, or did their resolutions coincide with the log blackout?
3. If a timer genuinely did not run, find why (missed trigger, host issue,
   deployment gap) and run or reschedule it.

## Done when

- [ ] The alert resolves.
- [ ] Every timer that was overdue is confirmed to have run successfully after
      the reset, with the evidence noted here.
- [ ] Any timer that genuinely missed its run has a cause and a fix.

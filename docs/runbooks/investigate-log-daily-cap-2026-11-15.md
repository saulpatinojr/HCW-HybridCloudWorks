# Investigate: Log Analytics daily cap hit twice, capacity warning firing again

Date: 2026-11-15. Status: investigating (draft PR).

## What was seen

- **Sev2 `alert-logs-capacity-prod-cus`** (80%-of-cap early warning) on
  `log-plat-prod-cus-01` (`rg-mgmt-plat-prod-cus`) fired **23:47 UTC Nov 15**
  (Alert ID `7cec9734-5148-6225-800c-d7a512aa0002`). Metric: **0.208 GB
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

## What it means

Hitting the cap costs $0 in ingestion — the cost is dropped logs and blind
alerts. The mgmt subscription's daily cost crept up ($0.31–0.35/day Nov 9–12
vs $0.20–0.22 Nov 1–8), so volume is growing, not just spiking.

## Standing recommendation (owner decision, not yet taken)

Raise the daily cap to **1 GB/day** (~10x current volume): Log Analytics
PAYG is $2.30/GB with the first 5 GB/month free, so the realistic added cost
is a few dollars a month; the absolute ceiling is ~$69/mo only if 1 GB/day is
actually ingested every day. Change is in the Portal:
`log-plat-prod-cus-01` → Usage and estimated costs → Daily Cap.

## What to check

1. Which tables are driving the growth? Query the workspace for billable
   ingestion by table over the trailing 7 days and compare with the prior week.
2. Is the growth a new table/source, or more volume on existing tables?
3. If the growth is legitimate, raise the cap to 1 GB/day (decision above).
   If it is noise (e.g. a chatty table), exclude or sample it instead.
4. Confirm the alert rules still evaluate correctly once ingestion is back
   under the cap.

## Done when

- [ ] The cap is raised, or ingestion is brought under control another way.
- [ ] No capacity warning and no overquota firing for 7 days.
- [ ] The volume driver is named in this doc.

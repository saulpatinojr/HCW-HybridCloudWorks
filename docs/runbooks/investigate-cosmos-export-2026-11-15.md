# Investigate: no full Cosmos export completed Sunday

Date: 2026-11-15. Status: investigating (draft PR).

## What was seen

- **Sev2 `alert-cosmos-export-full-prod-cus`** on `appi-site-prod-cus-01`
  (`rg-web-site-prod-cus`) fired **01:14 UTC Nov 16** (5:14 PM PT Nov 15),
  Alert ID `5ce4b928-aade-3a87-3be6-2253e3920002`.
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

## Done when

- [ ] The cause of the missed Sunday export is named in this doc.
- [ ] A full export completes and the export copy reconciles.
- [ ] The Sunday job's failure cause is fixed, or its schedule is corrected.

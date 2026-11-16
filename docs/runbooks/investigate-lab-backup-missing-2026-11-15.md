# Investigate: lab Coder backup missing for two days

Date: 2026-11-15. Status: investigating (draft PR).

## What was seen

- **Sev2 `alert-lab-backup-missing-coder-prod-cus`** on `log-plat-prod-cus-01`
  (`rg-mgmt-plat-prod-cus`) fired **04:23 UTC Nov 16** (8:23 PM PT Nov 15),
  alert ID not copied here, as this repository is public; the portal's alert history has it.
- **First time this alert has ever fired.** The lab host wrote no Coder
  PostgreSQL dump to `stlabhybridprodcus01/host-backups/coder/` in two days.
- Alert's own description: "The lab host wrote no Coder PostgreSQL dump to
  stlabhybridprodcus01/host-backups/coder/ in two days. The nightly unit is
  failing or the host is not uploading; `sudo systemctl status
  coder-postgres-backup` and `sudo journalctl -t hcw-backup-upload` on the
  host say which. LAB-9."

## What it means

The site itself is fine — this is about the lab's database backup. There is
no recent backup to restore from if the lab database has a problem.

## Related work

Sev2 `alert-lab-unit-failed-prod-cus` (fired 03:16 UTC Nov 14, still open,
tracked in PR #1731) is very likely the same failing job: a watched systemd
unit on `arcs-lab-hybrid-prod-cus-01` failed, and the nightly Coder backup
was one of the candidate units. This backup alert may be the answer to which
unit failed — but confirm it on the host rather than assuming it.

## What to check

1. On the host, check the backup unit directly:
   `sudo systemctl status coder-postgres-backup` and
   `sudo journalctl -t hcw-backup-upload`.
2. Did the nightly unit run and fail, or never run at all? Check the unit's
   recent runs and the host journal for the last two nights.
3. Check the upload path — is `stlabhybridprodcus01/host-backups/coder/`
   reachable from the host, and when was the last dump actually written there?
4. If the unit is the same one behind the lab-unit-failed alert, cross-link
   the finding in PR #1731 and close whichever investigation the evidence
   supports.

## Done when

- [ ] A successful Coder backup lands in the storage path.
- [ ] The failing unit's root cause is fixed, or the upload path is repaired.
- [ ] The backup alert clears, and the next two nightly backups land on
      schedule.

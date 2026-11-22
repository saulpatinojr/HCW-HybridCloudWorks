# Investigate: lab Coder backup missing for two days

Opened 2026-11-15. Updated 2026-11-20. Status: **recovered, cause not yet
confirmed** (draft PR
[#1733](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1733)).
Backups have been landing again since the night of Nov 17 (Pacific time).
What stopped them for those nights is narrowed down from the repository, but
not yet read on the host: the session that wrote this update had no SSH key
and no Azure sign-in, so it could not look at the host, the storage account
or Log Analytics.

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
- **Both backup alerts resolved on Nov 17 (Pacific time)**, as reported by
  the owner on 2026-11-20:
  - Coder PostgreSQL dump (`alert-lab-backup-missing-coder-prod-cus`):
    **9:24 PM PT Nov 17** (05:24 UTC Nov 18).
  - Vault snapshot (`alert-lab-backup-missing-vault-prod-cus`, the matching
    alert for the Vault copy): **9:31 PM PT Nov 17** (05:31 UTC Nov 18).
    So the Vault copy was missing too, not only the Coder one.
  - Neither has fired again since.

## What it means

The site itself is fine; this is about the lab's backups. While the alert
was open there was no off-host copy (a copy kept outside the lab machine, in
Azure Storage) newer than two days to restore from. There is one again now.

## Related work: the lab-unit-failed alert is a different job

Sev2 `alert-lab-unit-failed-prod-cus` (it fires when any watched background
job on the lab host fails) is investigated in draft PR
[#1731](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1731).
When this note was opened it looked like the same failing job. **It is not.**

PR #1731's finding (its note,
[`investigate-lab-unit-failed-2026-11-15.md` on branch `investigate/lab-unit-failed-2026-11-15`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-unit-failed-2026-11-15/docs/runbooks/investigate-lab-unit-failed-2026-11-15.md),
"Findings (2026-11-19)") is that the failing job is almost certainly the
nightly drift check, `hcw-playbook-drift` (a dry run of the host's setup
that fails whenever the host differs from the repository). The reason is
timing: that alert fired at exactly 03:16 UTC each time, and the Coder
backup job only starts at 03:30 UTC (plus up to 10 minutes of random delay),
so its failure could not be reported before 03:31. The Vault snapshot starts
at 03:45. Neither backup can be the job behind a 03:16 alert.

One thing from #1731 does matter here, and is new: the dates. #1731 lists
the lab-unit-failed alert on **Nov 14, Nov 18 and Nov 19** (UTC), and none
on **Nov 15, 16 or 17**. Those are the same nights the backups went missing.
The drift check was out of step with the repository the whole time (since
the half-finished setup run of Nov 12 that #1731 describes), so it should
have failed and alerted every night. A quiet drift check on exactly the
nights the backups stopped points to one shared cause; see finding 3 below.
(#1731 counts the emails that were noticed; whether any came on those nights
and were missed is not checked.)

## Findings from the repository (2026-11-20)

Read from the backup scripts and units under
[`lab-host/ansible/roles/coder`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-host/ansible/roles/coder)
and
[`lab-host/ansible/roles/backups`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-host/ansible/roles/backups),
and the two alert rules in
[`infra/lab-hybrid-backups.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/lab-hybrid-backups.tf#L197).

### 1. When the gap was, worked out from the alert rule

The alert does not look at the files in storage. It counts successful
uploads in the storage account's own log (`StorageBlobLogs`, `PutBlob` or
`PutBlockList` with `Success`) over the last two days, once an hour, and
fires when the count is zero. It resolves on its own once the count is one
or more (`auto_mitigation_enabled = true`).

So, allowing for the delay before a log row arrives (minutes, sometimes
longer):

- **Last good Coder upload before the gap:** the hourly check at 03:23 UTC
  Nov 16 still saw one, and the one at 04:23 did not. So the last good
  upload was between about 03:23 and 04:23 UTC **Nov 14**, which is the
  nightly run of Nov 14 (03:30 UTC, plus up to 10 minutes).
- **First good upload after the gap:** at or before 05:24 UTC **Nov 18**.
  The nightly runs of Nov 18 start at 03:30 (Coder) and 03:45 (Vault) UTC,
  so these are most likely the ordinary nightly runs of that night, with the
  alerts noticing an hour or two later. It may instead have been a run by
  hand or a run at start-up (see finding 4); only the host's log can tell.
- **Missed nights:** the runs of **Nov 15, 16 and 17 (UTC)**, three nights
  for both Coder and Vault. "Two days" in the alert's name is how long it
  waits before it fires, not how long the gap was.

### 2. Nothing in the repository changed the backup jobs around then

No commit between Nov 1 and Nov 20 touched the backup units, timers or
scripts (`git log` over `lab-host/ansible/roles/backups`,
`lab-host/ansible/roles/coder` and `infra/lab-hybrid-backups.tf`). The only
nearby change is the version bump of the Coder database image from
PostgreSQL 18.6 to 18.7 on Nov 12
([`3e959bd`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/commit/3e959bde3868c33c4d398d5d777b7440f905c16c)).
That cannot explain the gap: the Vault snapshot, which does not use that
database at all, stopped on the same nights and came back on the same night.

The settings as they are now, unchanged through the gap:

| | Coder dump | Vault snapshot |
| --- | --- | --- |
| Service | `coder-postgres-backup` ([unit](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-backup-missing-2026-11-15/lab-host/ansible/roles/coder/templates/coder-postgres-backup.service.j2)) | `hcw-vault-backup` ([unit](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-backup-missing-2026-11-15/lab-host/ansible/roles/backups/templates/hcw-vault-backup.service.j2)) |
| Starts (UTC) | 03:30, plus up to 10 min (`coder_backup_on_calendar`) | 03:45, plus up to 10 min (`backups_vault_on_calendar`) |
| Missed while the host was off | runs once at the next start-up (`Persistent=true`) | same |
| Uploads with | `hcw-backup-upload coder`, only if `/etc/hcw/backups/upload.env` exists | `hcw-backup-upload vault` |
| On failure | writes the `hcw-unit-failed` line (`OnFailure=`) | same |
| Silent skip | upload skipped, exit 0, if `upload.env` is missing | whole run skipped if the Vault token file is missing (`ConditionPathExists=`) |

### 3. Both backups stopping together points to something they share

The two jobs share only these:

- **The host itself being up** at 03:30 to 03:55 UTC.
- **The upload helper and the Arc identity.** Both upload through
  [`hcw-backup-upload`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-backup-missing-2026-11-15/lab-host/ansible/roles/backups/files/hcw-backup-upload),
  which gets its sign-in from the Azure Arc agent on the host (Arc is the
  Microsoft service that lets Azure manage a machine outside Azure; its
  agent hands out a token for the machine's own identity) through
  [`hcw-arc-token`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-backup-missing-2026-11-15/lab-host/ansible/roles/backups/files/hcw-arc-token).
- **The storage account** `stlabhybridprodcus01` and its log.
- **The switch file** `/etc/hcw/backups/upload.env`, which the setup
  playbook writes only while `backups_enabled` is on (it follows
  `arc_enabled` in
  [`group_vars/all.yml` line 647](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-backup-missing-2026-11-15/lab-host/ansible/group_vars/all.yml#L647)).
  The same switch also stops the Vault timer.

Put that next to the quiet drift check on the same nights (see "Related
work" above), and the likely causes, from most to least likely, are:

1. **The host was off, asleep or cut off from the network** for those
   nights. Nothing would run, so no backups and no drift-check alert. If it
   came back before 03:00 UTC Nov 18, the next night's runs are exactly what
   was seen.
2. **The Arc agent was down or disconnected.** The uploads would fail with
   "no token for the Arc identity", the jobs would fail and write their
   `hcw-unit-failed` lines, but the same agent also carries the host's logs
   to Azure, so those lines (and the drift check's) would never reach the
   alert. This fits everything seen as well as cause 1 does.
3. **The storage log stopped arriving**, while the uploads themselves
   worked. The alert counts log rows, not files, so it would fire with the
   backups safely in place. That would not explain the quiet drift check.
4. **Off-host backups switched off by a setup run** (`backups_enabled`
   false). The Coder job would keep dumping locally and exit 0 with no
   alert, and the Vault timer would be stopped. Unlikely: it would need a
   setup run with Arc turned off, and turned back on by Nov 18, and #1731
   found no setup run completed after the failed one of Nov 12.

A Coder-only cause (Docker or the database down, the PostgreSQL 18.7 image)
does not fit, because Vault stopped too.

### 4. Two gaps in the design worth knowing

These did not necessarily cause this gap, but they make a gap harder to
read:

- **The Coder job skips the upload without saying so** when
  `/etc/hcw/backups/upload.env` is missing (the `if [ -r ... ]` at the end of
  [`coder-postgres-backup.sh.j2`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/investigate/lab-backup-missing-2026-11-15/lab-host/ansible/roles/coder/templates/coder-postgres-backup.sh.j2#L36)).
  That is on purpose (the file is the off switch), but it means only the
  two-day alert notices.
- **A failure that also stops the logs is silent** until the two-day alert.
  If cause 2 above is what happened, the `OnFailure=` line did its job on
  the host and nobody in Azure saw it. The heartbeat alert
  (`alert-lab-heartbeat-prod-cus`, in
  [`infra/lab-hybrid.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/lab-hybrid.tf#L507))
  is the one meant to catch a host that has gone quiet; whether it fired on
  Nov 14 to 18 is the first thing to check.

Neither needs a change until the cause is known.

### Not checked

- The host: its start-up history, the two jobs' runs and the upload log for
  Nov 14 to 18, the Arc agent's log, and whether `upload.env` was there.
- The storage account: which blobs exist under `coder/` and `vault/`, and
  whether any upload was tried and refused on the missed nights.
- Log Analytics and the alert history: whether the heartbeat alert fired
  between Nov 14 and Nov 18, and the `hcw-unit-failed` rows for those nights.

## Confirm on the host (owner, about 5 minutes)

All commands are **PowerShell**, from the workstation that has the `hcw-lab`
SSH key and an `az login` session. Nothing here changes anything; every
command only reads.

1. **See every upload the storage account recorded from Nov 13 until now,
   including refused ones:**

   ```powershell
   $ws = (az monitor log-analytics workspace show -n log-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId; az monitor log-analytics query -w $ws --analytics-query "StorageBlobLogs | where TimeGenerated between (datetime(2026-11-13) .. now()) | where AccountName == 'stlabhybridprodcus01' | where OperationName in ('PutBlob', 'PutBlockList') | project TimeGenerated, StatusText, StatusCode, ObjectKey | order by TimeGenerated asc" -o json | ConvertFrom-Json | Format-Table -Wrap
   ```

   What you should see: one `coder/` and one `vault/` row with `Success`
   each night around 03:30 to 03:55 UTC on Nov 13, 14, 18, 19 and 20, and
   **no rows at all** for Nov 15, 16 and 17. No rows means the host never tried
   (causes 1, 2 or 4). Rows with a refusal (for example `403`) mean it tried
   and Azure said no: put the `StatusText` on this PR. `Success` rows on the
   missed nights mean the backups were fine and only the log was late
   (cause 3).

2. **See whether the host was talking to Azure at all, hour by hour:**

   ```powershell
   $ws = (az monitor log-analytics workspace show -n log-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId; az monitor log-analytics query -w $ws --analytics-query "Heartbeat | where TimeGenerated between (datetime(2026-11-14) .. datetime(2026-11-19)) | where tolower(_ResourceId) endswith '/providers/microsoft.hybridcompute/machines/arcs-lab-hybrid-prod-cus-01' | summarize beats = count() by hour = bin(TimeGenerated, 1h) | order by hour asc" -o json | ConvertFrom-Json | Format-Table
   ```

   What you should see if cause 1 or 2 is right: hours missing between Nov
   14 and Nov 18. Every hour present means the host was connected the whole
   time, and the answer is on the host (step 3).

3. **Read the host's own record of those nights:**

   ```powershell
   ssh hcw-lab 'journalctl --list-boots --no-pager | tail -n 5; sudo journalctl -u coder-postgres-backup -u hcw-vault-backup -t hcw-backup-upload -t hcw-unit-failed --since 2026-11-14 --until 2026-11-19 --no-pager; sudo journalctl -u himdsd --since 2026-11-14 --until 2026-11-19 --no-pager | tail -n 40; sudo ls -l /var/backups/coder /var/backups/vault /etc/hcw/backups'
   ```

   What it tells you:
   - `--list-boots`: a start-up on Nov 17 or 18 after a long gap is cause 1.
   - The job and upload lines: no lines for Nov 15 to 17 means the jobs
     never ran (cause 1); `no token for the Arc identity` means cause 2;
     `uploaded coder/...` lines on those nights mean cause 3; jobs that ran
     with no upload line at all mean cause 4.
   - The `himdsd` lines (the Arc agent's identity service): errors or
     restarts on Nov 15 to 17 support cause 2.
   - The folder listing: local Coder dumps dated Nov 15 to 17 mean the job
     ran; `upload.env` should be listed under `/etc/hcw/backups`.

Put what you see on
[#1733](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1733), and
the next session finishes this note.

## Done when

- [x] A successful Coder backup lands in the storage path. (Nov 18 UTC; the
      alert resolved at 9:24 PM PT Nov 17.)
- [ ] The cause of the missed nights is found on the host (steps above), and
      fixed or recorded as a one-off (for example, the host was off).
- [x] The backup alert clears. (Both resolved Nov 17 PT.)
- [ ] The next two nightly backups land on schedule. Probably true (the
      owner reports no miss since), but the alert cannot show it: it only
      fires after two whole days with no upload, so one missed night would
      not page anyone. Step 1 above, which runs up to now, shows each
      night's upload; look for `Success` rows on Nov 19 and 20 UTC.

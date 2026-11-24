# Content archive: the yearly long-term copy

The content archive is a long-term copy of what the site holds, so that old
content can be brought back years later. It is designed in
[ADR 0046](../decisions/0046-content-archive.md), and the work is tracked on
issue [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).

This page says what exists today, how to run and read a **dry run** (a run
that counts what an archive would hold and writes none), what each state on
the admin card means, and how the archive will be switched on.

## What exists today, and what does not

| Part | State |
| --- | --- |
| The storage for it: a private blob container (a folder for files in Azure Storage) named `content-archive` on the account `stsiteprodcus01` | In Terraform. It exists once the owner has confirmed the run that follows the merge. Empty |
| The switch: the app setting `CONTENT_ARCHIVE_ENABLED` on the Function App (the site's server-side code) | In Terraform, set to `false` |
| The list of what is kept, changed and left out, container by container | In code, with a test: [`archive-classification.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/archive-classification.js) |
| The dry run and its report | Built. On the admin at [Health → Overview](https://hybridcloudworks.com/admin/health?tab=overview), card **Archive** |
| The job that writes an archive, and the daily check that starts it | **Not built.** It is phase 3 of ADR 0046. Until then the switch starts nothing, whatever it says |
| Reading an archive back | **Not built and not tried.** See [Reading an archive back](#reading-an-archive-back) |
| Images and audio | Not in the first version (the owner's answer of 2026-11-24). The first archive is the database only |

**No archive has been written.** Nothing on this page deletes anything, spends
anything beyond a few seconds of the Function App's time, or cannot be undone.

## What an archive will hold

One archive a year, of the calendar year before, made on or after 1 February
from the weekly full database backup (the Sunday run of the nightly export;
[Cosmos restore runbook](cosmos-restore.md)). Each database container (a
named box of records) gets one of three decisions:

- **Kept as it is**: 50 containers. Articles, pages, the owner's notes and
  recordings, newsletters, prompts, images' records and the like.
- **Kept, with something taken out first**: 4 containers.
    - `developer_events` (calls for speakers and talk proposals): the
      speaker's name, email and bio and the organizer's review note are
      removed from every proposal, accepted or not.
    - `mcp_servers` (outside tool servers): the sign-in tokens and the client
      secret are removed.
    - `doc_vault` (the owner's private documents): the one secret item the
      vault uses to make document ids is left out. The documents read back
      without it.
    - `admin_config` (settings documents): key records, and short-lived state
      such as health results and caches, are left out. A document the list
      does not name is left out too.
- **Left out**: 25 containers. 18 for a known reason (the access list, audit
  rows the database deletes after 90 days, caches and queues that a job
  rebuilds) and **7 that are waiting for the owner**, below.

Two rules cut across containers. An interview is kept only while it is public
in the backup, in `content` and in its earlier versions in `content_versions`.
And an earlier version is kept only when its content item is in the same
backup.

## Run a dry run

A dry run makes the Function App read the newest complete weekly backup and
count. It writes its report beside the backup's own working files (the private
`cosmos-export-state` container), never into `content-archive`, and it changes
no record. It works whether or not the Terraform run has been confirmed, and
whether the switch is on or off.

You need the `super_admin` role. Below that role the card is not shown.

1. Open [Health → Overview](https://hybridcloudworks.com/admin/health?tab=overview)
   and scroll to the **Archive** card at the bottom.
   You should see **Switch (CONTENT_ARCHIVE_ENABLED): Off**, and a sentence
   that starts "The job that writes an archive is not built yet".
   If the card says the state could not be read, the deployment that carries
   this feature has not run yet; see
   [After the merge](#after-the-merge-the-owners-steps-in-order).
2. Press **Dry run**.
   You should see a notice "Dry run started", naming the date of the backup it
   reads and the number of containers (about 61).
   If it says no complete weekly full backup was found, the nightly export has
   not finished a Sunday run in the last 35 days. The **Nightly export** line
   on the Operational Signals card of the same tab says when the last run
   finished. Nothing was started; try again after the next Sunday run (03:00
   UTC).
3. Wait a few minutes, then press the round refresh arrow at the top right of
   the card.
   While it is reading you see "12 of 61 containers done" (the numbers move).
   When it has finished you see **Records an archive would keep** with a
   number.
   If it still shows progress after 45 minutes, one container's job failed. A
   failed job sends an alert to your phone, and
   [Health → Alerts](https://hybridcloudworks.com/admin/health?tab=alerts)
   lists it under "Sent to your phone". Press **Dry run** again: a new run
   starts from the beginning and the old one is simply left unfinished.

## Read the report

- **Records an archive would keep / with fields taken out first / it would
  leave out.** Totals across every container that was read.
- **A red line about containers that "held a different number of records".**
  The dry run counted a different number of records in a backup file than the
  backup's own list says it wrote. That should never happen. Do not switch
  the archive on; say so on
  [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811)
  with the date of the backup.
- **Waiting for you: 7 containers to classify.** See the next section.
- **Every container** (press to unfold). One row per container: how many
  records would be kept, how many would have fields removed and which fields,
  and how many would be left out and why. The reasons, in the card's words:

    | Reason on the card | What it means |
    | --- | --- |
    | a promise limits keeping it | Someone was told it would be deleted, or agreed to less than keeping it for good (an interview that is not public, audit rows) |
    | it is a secret | A token, a key record or the Doc Vault's secret item |
    | it is the access list | Who may sign in to the admin |
    | a job rebuilds it | A cache or an index |
    | short-lived working state | Health results, leases, queues |
    | a document the list does not name | A settings document whose id is not in the code's list. Left out to be safe; a number above zero here is worth a look |
    | its content item is not in the backup | An earlier version of something that has since been deleted |
    | not classified yet | One of the seven below |

The report never shows a record, the id of a record or the value of a field.
The server does not send one.

## Classify the seven containers

Seven containers are left over from the earlier site, and no code in this
repository reads them, so nothing here can say what they hold:
`tool_workspaces`, `tool_migration_workspaces`, `tool_assessment_sessions`,
`tool_architecture_plans`, `tool_exports`, `config_providers` and
`config_settings`. They may hold what a visitor typed, or a key someone pasted
into the earlier site.

For each one the report shows the number of records and the **names** of its
fields. Read the names and answer on
[#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) with
one word per container:

- `KEEP`: it is content worth keeping and holds nothing about a visitor and no
  key.
- `STRIP`, with the field names to remove: keep it without those fields.
- `OUT`: leave it out for good.

A container with 0 records, or one the report says is "not in the backup", can
be answered `OUT`. Until you answer, all seven stay out, so not answering is
safe. A session then changes the list in a pull request; the test beside the
list keeps the count honest.

If a container shows "only the first 100 names are listed" or "names not
shown: they read like typed text", its records use typed text as field names.
Treat that as a sign it holds what people typed, and answer `OUT` unless you
know otherwise.

## What each state on the card means

| The card says | Meaning | What to do |
| --- | --- | --- |
| Switch: **Off** | `CONTENT_ARCHIVE_ENABLED` is not exactly `true` (this includes the setting not existing yet) | Nothing. This is how it ships |
| Archive of 2026: **Not written** | `content-archive/2026/manifest.json` does not exist | Nothing. No archive has been written |
| Archive of 2026: **Not known** | The storage account did not answer, or refused, when the server looked for that year's manifest. (A container that does not exist yet reads as "Not written", which is true.) | Press the refresh arrow in a minute. If it stays, say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| Archive of 2026: **Written** | That year's manifest (the list of files with their counts and fingerprints) exists. A year is archived once | Nothing |
| "could not start today: it is still January" | An archive is never made in January, the month of grace | Wait |
| "the newest complete weekly backup is from before 2 February" | The archive is made from the first Sunday backup on or after 2 February, the day after the yearly clean-up of talk proposals | Wait for that Sunday |
| "no complete weekly full backup was found" | The nightly export is off or has not finished a Sunday run in 35 days. No backup, no archive | Check the Nightly export line on the same tab |

## After the merge: the owner's steps, in order

Either order of steps 1 and 2 is safe. The code reads a missing setting as
"off" and a missing container as "not known", and starts nothing in either
case.

1. **Confirm the Terraform run.** Open the
   [`hcw-azure` workspace's runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs)
   in HCP Terraform and open the run named after the pull request.
   You should see, beside the usual three replacements and one changed
   setting that every run shows, exactly **one resource to add**
   (`azurerm_storage_container.content_archive`) and **one more setting on the
   Function App** (`CONTENT_ARCHIVE_ENABLED = "false"`). Nothing else is
   replaced or destroyed.
   If the plan shows anything else, do not confirm; say what it shows on
   [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).
2. **Deploy the Function App from `main`.** Open
   [the Deploy Functions workflow](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-functions.yml),
   press **Run workflow**, leave the branch on `main`, press the green **Run
   workflow** button. Do not use "Re-run" on an older run: that deploys the
   older code.
   You should see the run finish green in about ten minutes.
3. **Check the container exists** (PowerShell; read-only; not run by the
   session that wrote this page):

    ```powershell
    az storage container-rm show --storage-account stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus -n content-archive -o json | ConvertFrom-Json | Select-Object name, publicAccess
    ```

    You should see one row, `content-archive`, with `publicAccess` as `None`
    (or empty). An error that names `ContainerNotFound` means step 1 has not
    been applied.
4. **Run a dry run** and read it: [Run a dry run](#run-a-dry-run).
5. **Answer for the seven containers** on #1811:
   [Classify the seven containers](#classify-the-seven-containers).

Switching the archive on is not one of these steps.

## Switching it on

Not yet. The switch has nothing to start until the archive job is built
(phase 3 of ADR 0046). When it is, switching on is a one-line pull request
that changes `"CONTENT_ARCHIVE_ENABLED" = "false"` to `"true"` in
[`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf),
made only after you have read a dry-run report with no red line and said yes.
The first archive would then be made on the first day all of these hold: the
switch is on, the date is 1 February or later, that year has no archive yet,
and a complete Sunday backup dated 2 February or later exists.

## Reading an archive back

**The exact steps are not written yet, on purpose.** They will be written and
tried on the first real archive, in phase 3, and recorded here. Nothing below
has been run.

The outline, from ADR 0046 section 6:

1. Read the year's `manifest.json`. It stays online, so there is no waiting.
2. Bring the wanted files back online by **copying** each one to a new online
   file. A file in the Archive tier (Azure's cheapest, offline tier) cannot be
   read until it has been brought back ("rehydrated"). Copying leaves the
   archived file untouched and avoids the charge for removing a file from the
   tier early.
3. Wait. Microsoft says a standard-priority request "might take up to 15
   hours" for a file under 10 GB.
4. Check each copy's sha256 (its fingerprint) against the manifest. A match
   is the proof.
5. Download, then delete the online copies.

Microsoft's pages, opened on 2026-11-24:
[Blob rehydration from the archive tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview)
(the two ways to bring a file back, the priorities, what is charged) and, from
ADR 0046's own reading the same day,
[Rehydrate an archived blob to an online tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-to-online-tier)
and
[Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview).

## A person's request to be erased

Nothing changes yet in the
[data-subject requests runbook](data-subject-requests.md): no archive exists,
so its sentence about backups is still the whole truth. ADR 0046 section 5
lists the three changes that runbook gets when the first archive is written.

One thing does exist now: a dry-run report. It holds container names, field
names and counts, and nothing about a person.

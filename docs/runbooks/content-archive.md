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

- **Kept as it is**: 33 containers. Articles, pages, the owner's notes and
  recordings, newsletters, image records and the like. Every one of them is
  a container the site's code reads or writes today, so its fields are
  known. (`plaud_ingest` is the one exception: no code names it, and it is
  kept because the owner said its recordings are theirs.)
- **Kept in part**: 6 containers. For four of them the code holds a **keep
  list** (the only fields that are kept; a field nobody listed is dropped, so
  a new or forgotten field can never carry a secret in).
    - `developer_events` (calls for speakers and talk proposals): from a call,
      its title, description, dates and status; from a proposal, the talk's
      title, abstract, format, level, dates and status. The speaker's name,
      email and bio, the review note, who reviewed it, and the organizer's
      name and key id are never kept. The abstract is free text the speaker
      typed and **is** kept: it is the talk.
    - `mcp_servers` (outside tool servers): name, transport, switches, the
      *name* of the setting its key is read from, tool names, and its web
      address **without** its query string (the part after `?`, where a key
      can sit). Sign-in tokens, the client secret and request headers are
      never kept.
    - `ai_providers` (the AI provider cards): the fields today's editor
      accepts. An old key on a card carried over from the earlier site is
      dropped.
    - `admin_settings` (settings documents): four named documents and the
      news sources are kept; the record of who first set the site up, test
      results and caches are left out, and so is a document the list does
      not name.
    - `doc_vault` (the owner's private documents): documents and their
      earlier versions are kept; the one secret item the vault uses to make
      document ids is left out. The documents read back without it.
    - `admin_config` (settings documents): key records, and short-lived state
      such as health results and caches, are left out. A document the list
      does not name is left out too.
- **Left out**: 40 containers. 19 for a known reason (the two access lists:
  who may sign in, and which machine is which lab agent; audit rows the
  database deletes after 90 days; caches and queues that a job rebuilds) and
  **21 that are waiting for the owner**, below.

Two rules cut across containers. An interview is kept only while it is public
in the backup, and **no earlier version of an interview is kept at all**: a
public interview's history holds its drafts from before it was published,
which the guest never agreed to (an open question for the owner in
[ADR 0046](../decisions/0046-content-archive.md#open-question-for-the-owner-earlier-versions-of-a-published-interview)).
And an earlier version of anything else is kept only when its content item is
in the same backup.

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
   reads and the number of containers (about 60).
   If it says "A dry run is still reading the backup", one is already
   running and less than 30 minutes old; nothing new was started. Wait for
   its report.
   If it says no complete weekly full backup was found, the nightly export has
   not finished a Sunday run in the last 35 days. The **Nightly export** line
   on the Operational Signals card of the same tab says when the last run
   finished. Nothing was started; try again after the next Sunday run (03:00
   UTC).
3. Wait a few minutes, then press the round refresh arrow at the top right of
   the card.
   While it is reading you see "12 of 60 containers done" (the numbers move).
   When it has finished you see **Records an archive would keep** with a
   number.
   If, 30 minutes after it started, the card says in red "The last dry run
   did not finish" and names the containers that are missing, one
   container's job failed. A failed job sends an alert to your phone, and
   [Health → Alerts](https://hybridcloudworks.com/admin/health?tab=alerts)
   lists it under "Sent to your phone". Nothing was archived or changed.
   Press **Dry run** again: a new run starts from the beginning.

## Read the report

- **Records an archive would keep / with fields taken out first / it would
  leave out.** Totals across every container that was read.
- **A red line about containers that "held a different number of records".**
  The dry run counted a different number of records in a backup file than the
  backup's own list says it wrote. That should never happen. Do not switch
  the archive on; say so on
  [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811)
  with the date of the backup.
- **A red block "Look before switching the archive on".** It lists every
  container an archive would **keep** that has at least one field which
  (a) **would remain** in the archive, (b) has a *name* that looks like a
  secret or someone's contact details, and (c) holds something other than
  numbers or yes/no. A name looks that way when it contains `token`,
  `secret`, `password`, `apikey`, `authorization`, `credential`,
  `privatekey`, `hash`, `salt`, `cookie`, `signature`, `email` or `phone`,
  or is exactly `sas`, `sig`, `key`, `pwd`, `auth` or `pin` (the list is in
  [`archive-classification.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/archive-classification.js),
  `SENSITIVE_NAME_WORDS`). The check reads names at any depth inside a
  record and never a value. For each such field the block gives one line:

    ```text
    meta.requestHash in 12 record(s); values seen: short text (under 64 characters) ×11, empty ×1
    ```

    - **Where it sits**: the names of the fields above it, then its own, joined
      by dots. `meta.requestHash` is a field `requestHash` inside a field
      `meta`. A part shown as `(id)` is a field name that is not printed
      because it is shaped like an id or typed text. For the two settings
      containers, `admin_config` and `admin_settings`, the line starts with
      the settings document the field is in (`credential_register › …`) when
      the code names that document, and `(other)` otherwise.
    - **In how many records.**
    - **What kind of value it holds**, as counts: number, true/false,
      date-like text, short text (under 64 characters), long text, list,
      object, or empty. This is what tells a harmless field from a real one:
      a date is not a secret; a short text under a name like `apiKey` may be.
      Never the value itself.
    - "N more use(s) of a name that is not shown because it is shaped like
      an id or typed text": a field that would remain whose own name cannot
      be printed. It is in red because nothing can be said about it from the
      report; say so on #1811 and a session will look at the code that writes
      that container.

  A hit is a reason to look, not proof. For each line, answer on
  [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811)
  with `FINE` (it may stay) or `OUT` (take it out), and a session changes the
  list in a pull request before the archive is switched on.
- **Three quieter lines, in grey, per container** (in the red block's
  containers and in "Every container"):
    - **"Named like one, but only numbers or yes/no"**: a field that would
      remain and whose every value was a number or true/false, such as a
      count of tokens (`totalTokens`) or a switch (`emailVerified`). It
      cannot hold a secret or an address, so it is not flagged.
    - **"Kept on purpose"**, with the reason. Today that is one name,
      `apiKeyEnvVar` on `mcp_servers` and `ai_providers`: the *name* of the
      setting a key is read from, never the key. The list keeps it only when
      it is shaped like a setting's name and drops anything else.
    - **"Taken out before archiving"**: names the records carry that the
      archive would not, because the record is left out or the field is
      dropped, with a count of records each. For a container that is left
      out whole the line reads "Found, and not archived".
- **Waiting for you: 21 containers to classify.** See the next section.
- **Every container** (press to unfold). One row per container: how many
  records would be kept, how many would have fields removed and which fields,
  how many would be left out and why, its field names, and the same lines
  about names that look sensitive. A removed field is named only when the name is
  one the site's own code uses (`speakerEmail`, `oauthToken`); any other
  removed field shows as "(other fields)", because its name could be
  anything. The reasons, in the card's words:

    | Reason on the card | What it means |
    | --- | --- |
    | a promise limits keeping it | Someone was told it would be deleted, or agreed to less than keeping it for good (an interview that is not public, audit rows) |
    | it is a secret | A token, a key record or the Doc Vault's secret item |
    | it is the access list | Who may sign in to the admin, which machine is which lab agent, or who first set the site up |
    | a job rebuilds it | A cache or an index |
    | short-lived working state | Health results, leases, queues |
    | a document the list does not name | A settings document whose id is not in the code's list, or a record of a kind the list does not name. Left out to be safe; a number above zero here is worth a look |
    | its content item is not in the backup | An earlier version of something that has since been deleted |
    | not classified yet | One of the 21 below |

The report never shows a record, the id of a record or the value of a field.
The server does not send one.

**Which field names are shown.** A field's name can itself be an id: a record
that is a list keyed by visitor id has ids for field names. So a name is shown
only when it is both **common** (at least 2 records of that container carry
it, and at least 1 record in every 100) and **plain** (it starts with a letter,
holds only letters, digits, `_` and `-`, is at most 40 characters, has no run
of four or more digits, and is not shaped like a UUID or a long run of hex).
Every other name is only counted ("more uses of names that are not shown").
A container with one record shows no field name at all. At most 100 names are
listed per container, the most common first.

**Where a report is kept, and for how long.** In the private
`cosmos-export-state` blob container, under `state/archive-report/`, one
folder per report. No storage rule deletes it; the code does: starting a dry
run deletes every report older than 90 days.

## Classify the 21 containers

No code in this repository names these 21 containers today, so nothing here
can say what they hold. They are left over from the earlier site. They may
hold what a visitor typed, or a key someone pasted into the earlier site.

- Saved work from the earlier site's tools: `tool_workspaces`,
  `tool_migration_workspaces`, `tool_assessment_sessions`,
  `tool_architecture_plans`, `tool_exports`.
- Settings from the earlier site: `config`, `config_providers`,
  `config_settings`, `config_tags`, `site_settings`.
- Content from the earlier site: `content_templates`, `youtubevideos`,
  `roadmap_items`, `wiki_pages`, `pillar_details`, `pillar_items`, `prompts`,
  `character_profiles`, `character_modules`, `character_images`,
  `character_tag_adjectives`.

The first seven were always waiting for you. The other fourteen were listed
as "kept as it is" until an independent review on 2026-11-24 pointed out that
nobody had read them; they moved here, so they are looked at before they are
kept.

For each one the report shows the number of records, the **names** of its
common fields, and how many records have a field named like a secret. Read
them and answer on
[#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) with
one word per container:

- `KEEP`: it is content worth keeping and holds nothing about a visitor and no
  key.
- `STRIP`, with the field names to keep: keep it with only those fields.
- `OUT`: leave it out for good.

A container with 0 records, or one the report says is "not in the backup", can
be answered `OUT`. Until you answer, all 21 stay out, so not answering is
safe. A session then changes the list in a pull request; the test beside the
list keeps the count honest.

If a container shows a large number of "names that are not shown", its
records use ids or typed text as field names. Treat that as a sign it holds
what people typed, and answer `OUT` unless you know otherwise.

## What each state on the card means

| The card says | Meaning | What to do |
| --- | --- | --- |
| Switch: **Off** | `CONTENT_ARCHIVE_ENABLED` is not exactly `true` (this includes the setting not existing yet) | Nothing. This is how it ships |
| Archive of 2026: **Not written** | The `content-archive` container exists, and `2026/manifest.json` is not in it | Nothing. No archive has been written |
| Archive of 2026: **Not known: no container yet** | The `content-archive` container does not exist. The server asks that first, because storage answers "not found" for a file in a missing container exactly as for a missing file, and "the container is gone" must never look like "this year is safe to start" | Before the Terraform run is confirmed this is expected. After it, it is a fault: say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| Archive of 2026: **Not known** | The storage account did not answer, or refused, when the server asked whether the container exists or looked for that year's manifest | Press the refresh arrow in a minute. If it stays, say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| Archive of 2026: **Written** | That year's manifest (the list of files with their counts and fingerprints) exists. A year is archived once | Nothing |
| "could not start today: it is still January" | An archive is never made in January, the month of grace | Wait |
| "the newest complete weekly backup is from before 2 February" | The archive is made from the first Sunday backup on or after 2 February, the day after the yearly clean-up of talk proposals | Wait for that Sunday |
| "no complete weekly full backup was found" | The nightly export is off or has not finished a Sunday run in 35 days. No backup, no archive | Check the Nightly export line on the same tab |

## After the merge: the owner's steps, in order

Either order of steps 1 and 2 is safe. The code reads a missing setting as
"off" and a missing container as "not known: no container yet", and starts
nothing in either case.

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
5. **Answer for the 21 containers** on #1811:
   [Classify the 21 containers](#classify-the-21-containers).

Switching the archive on is not one of these steps.

## Switching it on

Not yet. The switch has nothing to start until the archive job is built
(phase 3 of ADR 0046). When it is, switching on is a one-line pull request
that changes `"CONTENT_ARCHIVE_ENABLED" = "false"` to `"true"` in
[`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf),
made only after you have read a dry-run report with no red line and said yes.
The first archive would then be made on the first day all of these hold: the
switch is on, the date is 1 February or later, the `content-archive`
container exists, that year has no archive yet, and a complete Sunday backup
dated 2 February or later exists.

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
names and counts. A field name is shown only when it is common and plain
([Read the report](#read-the-report)), so that an id used as a field name
does not end up in a report, and a report is deleted after 90 days.

**A deleted archive file is not gone at once.** This matters for the erasure
steps of ADR 0046 section 5, and for anyone deleting an archive on purpose.
The storage account has two safety nets, both set in
[`infra/storage.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/storage.tf):

- **Versioning** (`versioning_enabled`): deleting or replacing a file does
  not remove its bytes; the file as it was becomes an "earlier version". A
  storage rule (`expire-noncurrent-versions`) deletes an earlier version
  **30 days** after it was made.
- **Soft delete** (`delete_retention_policy`, **7 days**): when an earlier
  version is deleted, by that rule or by hand, it can still be brought back
  for 7 more days.

So the old bytes of a deleted or rewritten archive file can linger for up to
about 37 days (30, then 7) if nothing more is done, and for 7 days even when
its earlier versions are deleted by hand straight away. An erasure is
finished only when that time has passed. Microsoft describes how the two
work together on
[Soft delete for blobs](https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-overview#feature-interactions)
and
[Blob versioning](https://learn.microsoft.com/azure/storage/blobs/versioning-overview#feature-interactions)
(both opened on 2026-11-24). Not tried on this account: no archive file
exists yet.

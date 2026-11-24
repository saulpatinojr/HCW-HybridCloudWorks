# Content archive: the yearly long-term copy

The content archive is a long-term copy of what the site holds, so that old
content can be brought back years later. It is designed in
[ADR 0046](../decisions/0046-content-archive.md), and the work is tracked on
issue [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).

This page says what exists today, how to run and read a **dry run** (a run
that counts what an archive would hold and writes none), what each state on
the admin card means, how the archive is switched on, what a run does, what
to do when one does not finish, and how to read an archived file back.

## What exists today, and what does not

| Part | State |
| --- | --- |
| The storage for it: a private blob container (a folder for files in Azure Storage) named `content-archive` on the account `stsiteprodcus01` | In Terraform. It exists once the owner has confirmed the run that follows the merge. Empty |
| The switch: the app setting `CONTENT_ARCHIVE_ENABLED` on the Function App (the site's server-side code) | In Terraform, set to `false` |
| The list of what is kept, changed and left out, container by container | In code, with a test: [`archive-classification.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/archive-classification.js) |
| The dry run and its report | Built. On the admin at [Health → Overview](https://hybridcloudworks.com/admin/health?tab=overview), card **Archive** |
| The job that writes an archive, and the daily check that starts it | Built: [`archive-job.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/archive-job.js). **Switched off.** While the switch is off it reads nothing and writes nothing. See [What a run does](#what-a-run-does-step-by-step) |
| Reading an archive back | Steps written, **not tried**: no archive exists to try them on. No button for it yet. See [Reading an archive back](#reading-an-archive-back) |
| Images and audio | Not in the first version (the owner's answer of 2026-11-24). The first archive is the database only |

**No archive has been written.**

**Most of this page changes nothing.** Running a dry run and reading its
report delete nothing, spend nothing beyond a few seconds of the Function
App's time, and need no undoing. Three sections are different, and each
flags its steps where they are:

- [Switching it on](#switching-it-on) starts something that writes a
  long-term copy.
- [Reading an archive back](#reading-an-archive-back) **spends money**
  (bringing a file back from the Archive tier is charged), **opens the
  storage account's firewall to your computer, grants your account a
  role**, and **deletes** the copies it made. Each of those steps says so
  before it.
- [A file that should not be there](#a-file-that-should-not-be-there)
  **deletes** a file, and also opens the firewall and grants a role for the
  length of the job.

## What an archive will hold

One archive a year, of the calendar year before, made on or after 1 February
from the weekly full database backup (the Sunday run of the nightly export;
[Cosmos restore runbook](cosmos-restore.md)). Each database container (a
named box of records) gets one of three decisions:

- **Kept as it is**: 54 containers.
    - 33 that the site's code reads or writes today, so their fields are
      known: articles, pages, the owner's notes and recordings, newsletters,
      image records and the like. (`plaud_ingest` is the one exception among
      them: no code names it, and it is kept because the owner said its
      recordings are theirs.)
    - 21 left over from the earlier site that no code names, kept whole by
      the owner's decision of 2026-11-24:
      [The 21 containers the owner chose to keep](#the-21-containers-the-owner-chose-to-keep).
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
- **Left out**: 19 containers, each for a known reason (the two access
  lists: who may sign in, and which machine is which lab agent; audit rows
  the database deletes after 90 days; caches and queues that a job
  rebuilds). **None is waiting for the owner.** A container added to the
  database later is left out, and shown on the card as waiting, until it is
  decided.

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
   You should see **Switch (CONTENT_ARCHIVE_ENABLED): Off**, a sentence that
   starts "An archive of" and ends with what stands in the way, and "No
   archive has been written yet."
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

  A container the owner has already decided about is **not** in this block:
  see the next point. So after the decision of 2026-11-24 this block is
  expected to be empty, and a line in it is something new.

  A hit is a reason to look, not proof. For each line, answer on
  [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811)
  with `FINE` (it may stay) or `OUT` (take it out), and a session changes the
  list in a pull request before the archive is switched on.
- **A block "The owner chose to keep these, 2026-11-24".** It lists the
  containers that would be in the red block, had the owner not already
  decided to keep them as the dry run showed them (ten that were flagged in
  the first dry run, and the 21 that were waiting). Each still shows the
  same lines: where the field sits, in how many records, and the kinds of
  value. That decision was made for each container, not for each name one
  by one, so the names are listed every time and are not treated as checked.
  If a name appears here that you do not remember from the first dry run,
  say so on
  [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).
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
- **"Nothing is waiting for you: every container is classified."** What you
  see since the decision of 2026-11-24. If a container is ever added to the
  database without being classified, this turns into "Waiting for you: 1
  container(s) to classify", with its record count and field names; see
  [If a container is waiting](#if-a-container-is-waiting).
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
    | not classified yet | A container nobody has decided about. None today; see [If a container is waiting](#if-a-container-is-waiting) |

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

## The 21 containers the owner chose to keep

No code in this repository names these 21 containers today, so nothing here
can say what their records hold. They are left over from the earlier site.

- Saved work from the earlier site's tools: `tool_workspaces`,
  `tool_migration_workspaces`, `tool_assessment_sessions`,
  `tool_architecture_plans`, `tool_exports`.
- Settings from the earlier site: `config`, `config_providers`,
  `config_settings`, `config_tags`, `site_settings`.
- Content from the earlier site: `content_templates`, `youtubevideos`,
  `roadmap_items`, `wiki_pages`, `pillar_details`, `pillar_items`, `prompts`,
  `character_profiles`, `character_modules`, `character_images`,
  `character_tag_adjectives`.

Until 2026-11-24 they were left out, waiting for you. After the first dry
run you decided that everything it listed stays
([your decision on #1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811#issuecomment-7144574612)),
so all 21 are now archived **whole**: every record, every field.

Two things to know about that, said plainly:

- **Three of the five `tool_` containers hold the email address and the
  session id of whoever used the tool:** `tool_workspaces` (the field
  `ownerEmail`), `tool_assessment_sessions` (`ownerEmail`,
  `requestedByEmail`, `ownerUid`) and `tool_architecture_plans`
  (`requestedByEmail`, `ownerUid`, `sessionId`). `ownerUid` is the id of the
  person's account. Those are the field names your first dry run showed;
  the other two `tool_` containers held no record. An email address is
  another person's contact detail, and nobody agreed to it being kept for
  good. The session
  recommended leaving those three out; you chose to keep them, because the
  archive is private and only you can read it. If someone who used those
  tools ever asks to be erased, each year's archive that holds their record
  has to be rewritten by hand
  ([ADR 0046, section 5](../decisions/0046-content-archive.md#5-erasure-a-persons-request-to-be-deleted),
  and step 4a of the
  [data-subject requests runbook](data-subject-requests.md#step-4a-the-yearly-archive-content-archive)).
- **`config_providers` and `config_settings` may hold keys typed into the
  earlier site.** Nothing is taken out of a container that is kept whole, so
  if one is there, it goes into the archive. The dry-run report lists those
  two under "The owner chose to keep these", with each field named like a
  secret and the kind of value it holds.

To change your mind about any of them, reply on
[#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) with
the container's name and `OUT` (leave it out) or `STRIP` and the field names
to keep. A session then changes the list in a pull request. What that does
depends on when:

- **Before any archive has started:** nothing more. The next dry run is made
  under the new list (the daily check starts one by itself), and an archive
  starts only from a report made under the list as it then is.
- **While a year's archive is being written** (the card says "is being
  written" or "is not finished"): the run does not carry on under the old
  list. It starts again from the beginning under the new one, after a new
  dry run, and every file is written again. If a container was taken off the
  list, the file the old run wrote for it is still in the year's folder, and
  the archive will not finish until you have removed it:
  [A file that should not be there](#a-file-that-should-not-be-there). The
  card and a message on your phone say so.
- **After a year has been archived** (it has its manifest): that year is not
  touched. The new list applies to later years only. Removing something from
  a finished year is the by-hand erasure of
  [ADR 0046, section 5](../decisions/0046-content-archive.md#5-erasure-a-persons-request-to-be-deleted).

## If a container is waiting

None is today. This is what happens if one ever is, because a container was
added to the database and nobody could say what it holds.

It is left out of every archive, and the dry run reads it and shows, under
"Waiting for you", its number of records, the **names** of its common fields,
and the fields named like a secret. Read them and answer on
[#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) with
one word:

- `KEEP`: it is content worth keeping.
- `STRIP`, with the field names to keep: keep it with only those fields.
- `OUT`: leave it out for good.

Until you answer it stays out, so not answering is safe. A container with a
large number of "names that are not shown" uses ids or typed text as field
names; treat that as a sign it holds what people typed.

## What each state on the card means

| The card says | Meaning | What to do |
| --- | --- | --- |
| Switch: **Off** | `CONTENT_ARCHIVE_ENABLED` is not exactly `true` (this includes the setting not existing yet) | Nothing. This is how it ships |
| Archive of 2026: **Not written** | The `content-archive` container exists, and `2026/manifest.json` is not in it | Nothing. No archive has been written |
| Archive of 2026: **Not known: no container yet** | The `content-archive` container does not exist. The server asks that first, because storage answers "not found" for a file in a missing container exactly as for a missing file, and "the container is gone" must never look like "this year is safe to start" | Before the Terraform run is confirmed this is expected. After it, it is a fault: say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| Archive of 2026: **Not known** | The storage account did not answer, or refused, when the server asked whether the container exists or looked for that year's manifest | Press the refresh arrow in a minute. If it stays, say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| Archive of 2026: **Written** | That year's manifest (the list of files with their counts and fingerprints) exists. A year is archived once | Nothing |
| "could not start today: the nightly export is off" | The archive is made from the nightly export's weekly backup, and the export's timer is what looks, once a day, whether an archive should start. With the export off nothing looks | Check the **Nightly export** line on the same tab. Switching the export on is the variable `cosmos_export_enabled` in the [`hcw-azure` workspace](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables) |
| "No archive has been written yet." | No year has a manifest | Nothing |
| "The archive of 2026 is being written … 12 of 60 files are written and checked" | A run is in progress. Each file is written, read back and checked; nothing is in the Archive tier yet | Wait, and press the refresh arrow |
| In red: "The archive of 2026 started … and is not finished", with the missing containers | The run is more than 6 hours old and has no manifest. Nothing has been moved to the Archive tier | See [When a run does not finish](#when-a-run-does-not-finish) |
| **Last archive: 2026**, with a time, and "60 files (one per container), … records, … compressed" | That year's archive is finished. The numbers are from its manifest | Do the read-back check once ([Reading an archive back](#reading-an-archive-back)) |
| "50 of 60 files are in the Archive tier; the daily check moves the rest" | The archive is finished and listed, and some files are still online. Moving a file can fail; the next daily check (03:00 UTC) tries again | Nothing, unless it says so for more than two days; then say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| In red: "file(s) the archive's list names are not in storage" | A file the manifest lists has been deleted | Say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) |
| "could not start today: no dry run has been made yet", "the newest dry run did not finish", or "the newest dry-run report was made from an older backup" | An archive never starts unless a finished dry-run report describes the very backup it would read. When that is the only thing missing, the daily check (03:00 UTC) starts the dry run itself, and the archive starts the day after if the report shows nothing to decide | Nothing. You can also press **Dry run** yourself |
| "could not start today: the newest dry-run report was made before the list of what is kept last changed", or "does not cover every container an archive would write" | The list changed after the report was made (a decision of yours was put into the code, for example), so the report no longer describes what an archive would write | Nothing: the daily check starts a new dry run, once for each backup and each version of the list |
| "could not start today: the newest dry-run report met a record too large to search whole" | One record in a kept container was too deep or too big for the dry run to look through all of it for names that look like a secret, so the report cannot vouch for that container | Say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811); the "Every container" table of the report shows which container. A session decides with you whether to raise the limit or leave the container out |
| On your phone: "the dry run did not finish", or "no more automatic dry runs" | The daily check starts at most one dry run by itself for each backup. If that one did not finish it tells you once and starts no other for that backup; after three in a row (one a week) it stops starting them at all | Press **Dry run** on the card yourself. If it fails again, [Health → Alerts](https://hybridcloudworks.com/admin/health?tab=alerts) has the failed job's message |
| In red: "The folder of the archive of 2026 holds 1 file(s) its list does not name" | A container was taken off the list while the archive was being written, and the file the earlier run wrote for it is still there | [A file that should not be there](#a-file-that-should-not-be-there) |
| "could not start today: a dry run is still reading the backup" | The same, a few minutes in | Wait |
| "could not start today: the newest dry-run report shows a field to look at in a container nobody has decided about" | The red block "Look before switching the archive on" is not empty. No archive starts while it is not | Read the block and answer on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) ([Read the report](#read-the-report)). Your phone gets one message for each such report, not one a day. Once your answer is in the list, the daily check makes a new dry run and carries on by itself |
| "could not start today: the newest dry-run report shows a container waiting for you" | A container nobody has classified is in the backup | [If a container is waiting](#if-a-container-is-waiting) |
| "could not start today: the newest dry-run report counted a different number of records" | The dry run disagreed with the backup's own list | Do not switch anything; say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) with the date of the backup |
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
   The pull request that added the archive job changed only comments in
   Terraform, so its own run shows nothing new: the usual lines, and these
   two if they had not been applied yet.
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
5. **Answer for the containers that were waiting.** Done on 2026-11-24:
   you chose to keep all 21
   ([The 21 containers the owner chose to keep](#the-21-containers-the-owner-chose-to-keep)).

Switching the archive on is not one of these steps.

## Switching it on

The archive is switched on by one app setting, `CONTENT_ARCHIVE_ENABLED`, and
only after you have read a dry-run report with no red line and said yes.
There is no button that starts an archive: once the switch is on it starts by
itself, once a year.

Before you start, three things should be true:

- The newest dry-run report on the
  [Archive card](https://hybridcloudworks.com/admin/health?tab=overview) has
  no red line ([Read the report](#read-the-report)).
- The **Nightly export** line on the Operational Signals card of the same tab
  shows a recent run. The archive is made from its Sunday backup.
- The Function App has been deployed from `main` since the archive job merged
  (step 2 of [After the merge](#after-the-merge-the-owners-steps-in-order)).

**Before step 1, know what it starts.** Switching on lets the site write a
long-term copy of its content into the Archive tier. It can be switched off
again the same way, and a year's archive can be deleted by you. Storage
charges an early-deletion fee for a file removed from the Archive tier before
180 days; for files of this size that is cents
([Blob rehydration from the archive tier: pricing and billing](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview#pricing-and-billing),
opened on 2026-11-24).

1. Reply `ARM` on
   [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).
   A session then opens a one-line pull request that changes
   `"CONTENT_ARCHIVE_ENABLED" = "false"` to `"true"` in
   [`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf)
   and merges it when its checks are green.
   **Know this about the check on that run.** The program that reads each
   Terraform plan and flags anything unexpected
   ([`assert-expected-plan.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/assert-expected-plan.mjs))
   has been told in advance to expect this one change, `"false"` to
   `"true"`. That is so the arming run passes. It also means the check will
   **not** flag that change if it ever appears in a run you did not ask for.
   So in step 2 read the plan yourself: if `CONTENT_ARCHIVE_ENABLED` is
   changing and you did not reply `ARM`, do not confirm.
2. Confirm the Terraform run. Open the
   [`hcw-azure` workspace's runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs)
   and open the run named after that pull request.
   You should see, beside the usual three replacements and one changed
   setting that every run shows, exactly **one changed setting on the
   Function App**: `CONTENT_ARCHIVE_ENABLED`, `"false"` to `"true"`. Nothing
   is added, replaced or destroyed.
   If the plan shows anything else, do not confirm; say what it shows on
   [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).
3. Open [Health → Overview](https://hybridcloudworks.com/admin/health?tab=overview)
   and press the refresh arrow on the **Archive** card.
   You should see **Switch (CONTENT_ARCHIVE_ENABLED): On**.
   If it still says Off after ten minutes, the run in step 2 has not finished
   applying; look at its page again.

Nothing else is needed. The first archive is then made on the first day, at
03:00 UTC, on which all of these hold: the switch is on, the nightly export
is on, the date is 1 February or later, the `content-archive` container
exists, that year has no archive yet, the newest complete Sunday backup is
dated 2 February or later, **and the newest dry-run report was made from
that same backup and shows nothing to decide** (no red block, no container
waiting, no count that disagrees with the backup).

You do not have to press Dry run for that. On the first morning everything
else holds, the daily check starts a dry run of the new backup by itself.
The next morning it reads the report: if it is clean the archive starts, and
if it is not, nothing starts and your phone gets the message "Content
archive of 2026 is waiting for you".

For the archive of 2026 that means: the dry run on Monday 8 February 2027
(of the backup of Sunday 7 February), and the archive on Tuesday 9 February,
provided the switch is on by then. If you press **Dry run** yourself on the
Sunday, after the backup has finished, the archive starts on the Monday.
Switched on later in the year, it works the same way from the next morning,
reading the newest Sunday backup.

One effect to know: a new Sunday backup arrives every week. If a report
shows something to decide and you answer a week later, the report is by
then older than the newest backup, so a new dry run is made first. That is
on purpose: an archive is only ever made from a backup that a finished
report describes.

**What success looks like.** A message on your phone, "Content archive of
2026 written", with the number of files, records and bytes. On the card:
**Archive of 2026: Written**, a **Last archive: 2026** line with the time,
and "Every file is in the Archive tier". Then do the read-back check once,
below, and write the result on
[#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).

**Switching it off again** is the same pull request in reverse (`"true"` to
`"false"`). From the moment that run has applied, the daily check does
nothing and a job that was already waiting in the queue writes nothing. A
finished year's archive is not touched.

## What a run does, step by step

All of this happens inside the Function App (the site's server-side code).
It reads the backup, never the live database.

1. **The daily check.** Every day at 03:00 UTC the nightly export's timer
   (`cosmosExportScheduler`) queues the export, and then asks whether an
   archive should start. If the switch is off it stops there, having read
   nothing, and logs one line that says so. If everything is ready except
   that no finished dry-run report describes the newest backup, it starts a
   dry run and stops; the archive starts at a later check, and only if that
   report shows nothing to decide.
2. **It picks one backup and writes that down.** It takes the newest complete
   Sunday backup and records its date in a small working note
   (`state/archive-run/<year>/run.json` in the private `cosmos-export-state`
   container). Every job of this archive reads that same backup, so an
   archive that takes two days is not made from two different Sundays.
3. **It queues one job per container** that the list keeps
   ([What an archive will hold](#what-an-archive-will-hold)) and the backup
   holds: 60 at most. The 19 containers that are left out are never queued,
   and neither is one that is waiting for a decision or that the list does
   not name; a job for any of those is refused.
4. **Each job writes one file.** It reads the container's backup file a line
   at a time, puts each record through the same list the dry run uses, and
   writes what is kept to `content-archive/<year>/cosmos/<container>.ndjson.gz`
   (one record per line as JSON, then gzip-compressed). The file is written
   as an ordinary online file, and the write is conditional: storage lets it
   through only when no file has that name yet, or only over the exact
   version the job saw when it started. So two jobs for one container cannot
   both write it, and a late job cannot write over a file that has been
   checked since.
5. **Each job checks its file before it counts.** Two checks are made while
   the upload is still open: no line of the backup was unreadable, and the
   job read as many records as the backup's own list says it holds. A file
   that fails either is never stored. The third needs the stored file: it is
   read back, and must have the same sha256 (a fingerprint of its bytes),
   size and record count as what was written. A file that fails that one
   stays under its name, is not counted, and is replaced by the next job for
   that container. The job then notes the file's version stamp, so that the
   manifest later names exactly the version that was checked.
6. **The manifest is written last.** Before it is written the job asks
   again: is the switch still on; is every container of the run still on the
   list of what is kept, under the same rules the run started with; is each
   file in storage the very version that was checked; and is there no other
   file in the year's folder. Only then does the last job
   write `content-archive/<year>/manifest.json`: for each file its name,
   record count, size and sha256, how many records were left out and why,
   and the names of the fields that were removed. It holds no record and no
   id. It is written "create only": it can never replace an existing one.
   **This file is what "archived" means.**
7. **Only then are the data files moved to the Archive tier** (Azure's
   cheapest tier, where a file is offline). The manifest stays online, so the
   card can always show what an archive holds.

Running any of this twice does no harm. A job that finds its file already
checked skips it; a job never writes into a year that has its manifest; and
a file that could not be moved to the Archive tier is moved by the next
day's check.

## When a run does not finish

You find out in three ways: a message on your phone when a job fails ("Job
failed: content-archive-container"), a message from the next daily check
("Content archive of 2026 is not finished") when a run is more than 6 hours
old, and the red line on the card, which names the containers still missing.

Nothing has been archived at that point: files move to the Archive tier only
after the manifest exists, so every file written so far is online and is
simply replaced.

1. Do nothing for one day. The next daily check (03:00 UTC) queues the
   missing containers again, and writes the manifest itself if every file is
   there.
   You should see the red line go, and **Last archive** appear.
2. If the same container is missing two days running, open
   [Health → Alerts](https://hybridcloudworks.com/admin/health?tab=alerts)
   and read the message for it under "Sent to your phone". It carries one of
   these sentences:

    | The message says | Meaning | What to do |
    | --- | --- | --- |
    | "a line of the backup file could not be read as a record" | The Sunday backup has a damaged line for that container | Say so on [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811) with the container's name. Do not switch anything off: the other files are fine and nothing is archived until this one passes |
    | "the backup file holds a different number of records than the backup's own list says" | The same kind of fault: the backup disagrees with itself | The same |
    | "the archive file read back from storage is not the file that was written" | Storage handed back something else | Wait one more day; if it repeats, say so on #1811 |
    | "the backup file for this container is not there" | The backup was deleted while the run was unfinished (backups are kept 35 days) | Nothing: the next check starts again from the newest backup |
    | The job "timed out" | The container is too big to write and check inside the 28 minutes one job has. `content_versions` is the one that can grow that far | Say so on #1811. Splitting a container's file into numbered parts is the fix, and it is a code change |

3. If the backup a run started from is deleted before the run finishes (35
   days), the next check starts again from the newest backup by itself. Files
   written from the old backup are not counted and are replaced.

A run that is still unfinished when the next January arrives is left as it
is: the year it was for is not made up later (ADR 0046 section 4). Its files
stay online in `content-archive/<year>/cosmos/` with no manifest. They are
not an archive; say so on #1811 and a session will tell you how to remove
them.

## A file that should not be there

You are here because the card says, in red, "The folder of the archive of
2026 holds 1 file(s) its list does not name", or your phone said "a file
that should not be there".

What happened: an archive had started and had written a file for some
container; then the list of what is kept was changed and that container was
taken off it. The run started again under the new list, and the old file is
still in the year's folder. The archive will not finish while it is there,
because a finished year must hold only what its manifest lists. The code has
no way to delete a file from the archive, on purpose, so this is done by
hand.

Nothing is in the Archive tier at this point (files move there only after
the manifest), so there is no early-deletion charge.

**These steps have not been run**: no archive has ever been written. All
lines are **PowerShell** and need the Azure CLI signed in as you.

1. **This step opens the storage account's firewall to your computer and
   grants your account a role on the archive's container.** Both are taken
   away again in step 4.

    ```powershell
    $ip = (Invoke-RestMethod https://api.ipify.org).Trim(); az storage account network-rule add --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus --ip-address $ip -o none; $me = (az ad signed-in-user show -o json | ConvertFrom-Json).id; $scope = (az storage container-rm show --storage-account stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus -n content-archive -o json | ConvertFrom-Json).id; az role assignment create --assignee-object-id $me --assignee-principal-type User --role "Storage Blob Data Contributor" --scope $scope -o none
    ```

    You should see no output and no error. A role takes a few minutes to
    apply: a `403` in step 2 means wait and try again. Keep this window open.
2. List the files in the year's folder that the run does not name (2026
   here; for another year change the number at the start of the line). It
   reads the run's own list from the working notes and compares:

    ```powershell
    $year = 2026; az storage blob download --account-name stsiteprodcus01 --auth-mode login -c cosmos-export-state -n "state/archive-run/$year/run.json" -f archive-run.json -o none; $wanted = (Get-Content archive-run.json -Raw | ConvertFrom-Json).containers | ForEach-Object { "$year/cosmos/$_.ndjson.gz" }; $extra = az storage blob list --account-name stsiteprodcus01 --auth-mode login -c content-archive --prefix "$year/cosmos/" -o json | ConvertFrom-Json | Where-Object { $wanted -notcontains $_.name }; $extra | Select-Object name, @{ n = 'tier'; e = { $_.properties.blobTier } } | Format-Table
    ```

    You should see one row for each file that should not be there, with the
    tier `Hot` or `Cool`. The role in step 1 is on the `content-archive`
    container only, so if the first part fails with a `403` on
    `cosmos-export-state`, say so on
    [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811)
    and a session will give you the names another way. If you see no row,
    nothing needs deleting; go to step 4. If a row shows the tier `Archive`,
    stop and say so on #1811: that should not be possible.
3. **This step deletes.** It deletes only the files step 2 listed. Read the
   list first; they must be containers you took off the list.

    ```powershell
    $extra | ForEach-Object { az storage blob delete --account-name stsiteprodcus01 --auth-mode login -c content-archive -n $_.name -o none }
    ```

    You should see no output. The account keeps a deleted file restorable
    for 7 days and its earlier versions for 30
    ([A person's request to be erased](#a-persons-request-to-be-erased)).
4. Take the role and the firewall opening away again (same window):

    ```powershell
    az role assignment delete --assignee $me --role "Storage Blob Data Contributor" --scope $scope -o none; az storage account network-rule remove --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus --ip-address $ip -o none
    ```

    You should see no output.

At the next daily check (03:00 UTC) the archive finishes by itself: the red
line goes and **Last archive** appears.

## Reading an archive back

**These steps have not been run.** No archive exists yet to run them on.
They are written from Microsoft's pages (linked below, opened on
2026-11-24) and from the steps this repository already uses to reach a
private storage container from your own computer
([data-subject requests runbook](data-subject-requests.md), step 5). The
first real read-back will correct them here. ADR 0046 section 6 describes a
button in the admin for this; it is not built yet, so the read-back is done
by hand.

What to know before you start:

- A file in the Archive tier is offline. It has to be **rehydrated** (brought
  back online) before it can be read. Microsoft says a standard-priority
  request "might take up to 15 hours" for a file under 10 GB, and that many
  small files can take longer; high priority can finish in under an hour and
  costs more
  ([Blob rehydration from the archive tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview#rehydration-priority)).
- **It costs money.** Storage charges for the amount of data read back and
  for the copy that is written
  ([the same page, pricing and billing](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview#pricing-and-billing)).
  The prices are on the
  [Blob Storage pricing page](https://azure.microsoft.com/pricing/details/storage/blobs/);
  this page does not quote one, and what you pay is yours to read there. For
  a few dozen database files it is expected to be cents.
- The steps **copy** each archived file to a new online file and leave the
  archived one untouched. Microsoft recommends that: it avoids the
  early-deletion fee, and the archive stays as it was.
- The manifest is online. The Archive card shows its totals without any of
  this.

All lines are **PowerShell**. They need the Azure CLI signed in as you
(`az login`). The storage account refuses every caller outside the Function
App's network, and you hold no standing right to read the archive, so step 1
gives your computer both for the length of the job and step 7 takes them
away.

1. **This step opens the storage account's firewall to your computer and
   grants your account a role** (Storage Blob Data Contributor, on the
   archive's container only). Both are temporary, and step 7 takes them away:

    ```powershell
    $ip = (Invoke-RestMethod https://api.ipify.org).Trim(); az storage account network-rule add --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus --ip-address $ip -o none; $me = (az ad signed-in-user show -o json | ConvertFrom-Json).id; $scope = (az storage container-rm show --storage-account stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus -n content-archive -o json | ConvertFrom-Json).id; az role assignment create --assignee-object-id $me --assignee-principal-type User --role "Storage Blob Data Contributor" --scope $scope -o none
    ```

    You should see no output and no error. A role takes a few minutes to
    apply: a `403` in step 2 means wait and try again, not that the grant
    failed. Keep this PowerShell window open; the later steps use `$ip`,
    `$me` and `$scope`.
2. This step only reads. Download the manifest of the year you want (2026 here; for another year
   change the number at the start of the line):

    ```powershell
    $year = 2026; az storage blob download --account-name stsiteprodcus01 --auth-mode login -c content-archive -n "$year/manifest.json" -f manifest.json -o none; $files = (Get-Content manifest.json -Raw | ConvertFrom-Json).files; $files | Select-Object container, records, bytes | Format-Table
    ```

    You should see one row per container with its record count and size. An
    error naming `BlobNotFound` means that year has no archive.
3. **This step spends money. Treat it as not undoable once started.**
   Bringing a file back is charged for the amount of data read and for the
   copy written (see above). Microsoft's page says the other way of bringing
   a file back, changing its tier, cannot be cancelled after it starts; it
   does not say whether a copy can, so do not count on stopping one. The
   step also writes new files into the archive's container.
   Start the copies, one per file, into a `readback/` folder in the same
   container:

    ```powershell
    $files | ForEach-Object { az storage blob copy start --account-name stsiteprodcus01 --auth-mode login --source-container content-archive --source-blob $_.name --destination-container content-archive --destination-blob ("readback/" + $_.name) --tier hot --rehydrate-priority standard -o none }
    ```

    You should see no output. The line is the one Microsoft gives on
    [Rehydrate an archived blob to an online tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-to-online-tier#rehydrate-a-blob-with-a-copy-operation),
    with this account's names. To read back one container only, put
    `| Where-Object container -eq 'blogs'` after `$files`.
4. Wait, then look. Each copy shows the tier `Archive` until it is ready and
   `Hot` when it is:

    ```powershell
    az storage blob list --account-name stsiteprodcus01 --auth-mode login -c content-archive --prefix "readback/$year/" -o json | ConvertFrom-Json | ForEach-Object { [pscustomobject]@{ name = $_.name; tier = $_.properties.blobTier; waiting = $_.properties.rehydrationStatus } } | Format-Table
    ```

    You should see every row with tier `Hot` and nothing under `waiting`.
    That can take up to 15 hours. Do not delete anything while a row is
    still waiting.
5. **This step puts copies of the archive's files on your computer.** They
   hold everything the archive holds, including other people's email
   addresses. Download the copies and check each one's fingerprint against
   the manifest:

    ```powershell
    $files | ForEach-Object { $local = $_.container + ".ndjson.gz"; az storage blob download --account-name stsiteprodcus01 --auth-mode login -c content-archive -n ("readback/" + $_.name) -f $local -o none; [pscustomobject]@{ container = $_.container; matches = ((Get-FileHash $local -Algorithm SHA256).Hash.ToLower() -eq $_.sha256) } } | Format-Table
    ```

    You should see `True` for every container. **A match is the proof** that
    the file read back is the file that was written. A `False` is a failed
    read-back: stop, keep the files, and say which container on
    [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).
    The files are in the folder the PowerShell window is in. Each one opens
    with any tool that reads `.gz`; inside is one record per line.
6. **This step deletes.** It deletes only the online copies under
   `readback/`, never the archive. Do it when you have what you need, so the
   copies are not paid for at the online price and are not a second place
   the content lives:

    ```powershell
    az storage blob list --account-name stsiteprodcus01 --auth-mode login -c content-archive --prefix "readback/$year/" -o json | ConvertFrom-Json | ForEach-Object { az storage blob delete --account-name stsiteprodcus01 --auth-mode login -c content-archive -n $_.name -o none }
    ```

    You should see no output. The account keeps a deleted file restorable
    for 7 days and its earlier versions for 30
    ([A person's request to be erased](#a-persons-request-to-be-erased)).
7. **This step removes a role and a firewall rule**: the two that step 1
   added, and nothing else. Do not skip it: until it is done your account
   can read and write the archive from that address. Same window:

    ```powershell
    az role assignment delete --assignee $me --role "Storage Blob Data Contributor" --scope $scope -o none; az storage account network-rule remove --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus --ip-address $ip -o none
    ```

    You should see no output. Then delete the downloaded files from your
    computer when you are done with them.

**The read-back rule** (ADR 0046 section 6): the first archive is read back
in full, every file, and every fingerprint must match, before the archive is
called done on #1811 and before any lock against deletion is discussed.

Microsoft's pages, opened on 2026-11-24:
[Blob rehydration from the archive tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview)
(the two ways to bring a file back, the priorities, what is charged) and
[Rehydrate an archived blob to an online tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-to-online-tier)
(the copy command, and how to see whether a copy is ready). From ADR 0046's
own reading the same day:
[Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview).

## A person's request to be erased

The [data-subject requests runbook](data-subject-requests.md) now lists the
archive among the stores (section 1) and has a step for it (section 4, "The
yearly archive"): what to check, and the four by-hand steps of ADR 0046
section 5 for the two cases where a person can be in an archive. Until the
first archive is written that step's answer is always "no archive exists".

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

The archive job's own working notes (`state/archive-run/<year>/` in the
private `cosmos-export-state` container) hold container names, counts, sizes
and fingerprints, never a record, so an erasure has nothing to do there.

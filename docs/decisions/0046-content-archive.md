# ADR 0046: A yearly archive of the site's content, kept in the Archive tier of the existing storage account

**Status:** Proposed. The owner made the main decisions on 2026-11-24
([#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811));
this record turns them into a design and asks five questions. Replying
`ACCEPT` on #1811 (with an answer to each question, or "as recommended")
starts the build described under [Phases](#phases). Nothing is built, and no
storage is created, by the pull request that adds this record.
**Decision date:** 2026-11-24
**Owners:** Workload owner and architecture owner

## Context

The owner asked for "an archival of ALL HCW content in an archival vault": a
long-term copy of what the site holds, so that old content can be brought back
years later, at leisure, for whatever reason.

Nothing like that exists today. The nearest thing is the nightly backup of the
database (Azure Cosmos DB, the service that stores the site's records), which
is described in [ADR 0028](0028-cosmos-out-of-account-export.md). That backup
keeps 35 days and is built to recover from an accident last week, not to keep
anything for years. ADR 0028 was amended on 2026-10-16 to say that full
backups "are archived quarterly" to a second subscription. That was never
built.

Some words used below, explained once:

- A **container** is a named box of records. The database has 79 of them (for
  example `content` for articles). Blob Storage, the service that stores
  files, also calls its folders containers; there are 12 of those. The tables
  below say which kind is meant.
- The **Archive tier** is the cheapest way Azure stores a file. The file is
  offline: before it can be read it has to be **rehydrated** (brought back
  online), which takes up to 15 hours. A file in this tier cannot be changed,
  only deleted or replaced.
- A **manifest** is a small list that goes with an archive: every file in it,
  how many records each holds, and a **sha256** for each (a fingerprint of the
  file; if one byte changes, the fingerprint changes, so it proves a file read
  back is the file that was written).
- **Personal data** is anything about an identifiable person: a name, an email
  address, a biography, a voice.
- An **erasure request** is a person asking for their data to be deleted. The
  site must honour one
  ([data-subject requests runbook](../runbooks/data-subject-requests.md)).

### What the owner has already decided (2026-11-24, recorded on #1811)

1. **Scope: everything, except where a promise to someone says otherwise.**
   Three promises are known: a guest's interview recording is deleted after
   365 days (`interview_audio_retention_days` in
   [`infra/variables.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/variables.tf));
   a talk proposal that was not accepted loses the speaker's name, email, bio
   and the review note after the yearly cycle
   ([`proposal-cycle.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/developer-api/proposal-cycle.js));
   and an erasure request is honoured.
2. **The cycle is the calendar year**, ending in December to match the
   Microsoft MVP cycle, with January as a grace month. The archive of year Y
   is written on or after 1 February of year Y+1.
3. **Storage is the Archive tier of the existing storage account**,
   `stsiteprodcus01`, in one new private container. The archive is **not**
   disaster recovery: no second subscription and no second region is asked
   for. The account copies everything to a second Azure region by itself
   (it is "RA-GRS"); that is accepted, and a separate single-region account
   is not worth building unless images and audio turn out to be large.
4. **Defaults nobody objected to:** only the owner reads the archive, by a
   temporary grant each time; it is written once a year; it is not locked
   against deletion until one archive has been read back successfully; and
   personal data is removed before archiving wherever no agreement covers
   keeping it.

### Facts about the Archive tier, checked on Microsoft Learn on 2026-11-24

- It is supported only on accounts with LRS, GRS or RA-GRS redundancy, which
  includes this one; a file should stay at least 180 days or an early-deletion
  charge applies; a file "can't be read or modified" until rehydrated; a file
  can be created directly in the tier at upload, or moved there afterwards
  with the Set Blob Tier operation
  ([Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview),
  [Archive a blob](https://learn.microsoft.com/azure/storage/blobs/archive-blob)).
- A file that is deleted while the account's soft delete still holds it is
  not charged the early-deletion fee until that holding period ends (same
  page). This account's soft delete is 7 days.
- Rehydration at standard priority "might take up to 15 hours" for a file
  under 10 GB; high priority can finish in under an hour and costs more.
  Microsoft recommends rehydrating by **copying** the archived file to a new
  online file, which leaves the archived one untouched and avoids the
  early-deletion fee. Many small files rehydrate more slowly than a few large
  ones
  ([Blob rehydration from the archive tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview),
  [Rehydrate an archived blob](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-to-online-tier)).
- **Price.** The session that recorded the owner's decision on #1811 read
  Azure's retail price list that day: $0.004 per GB per month for "Archive
  RA-GRS Data Stored" in Central US ($0.002 for LRS, the single-region kind).
  This record did not read the price again. Reading a file back is charged
  per GB as well; that price was not looked up, and it is on the
  [Blob Storage pricing page](https://azure.microsoft.com/pricing/details/storage/blobs/).

## Purpose and decision drivers

- **Keep the content.** A copy of what the site held at the end of each year
  that outlives the pages, the database layout and the tools that made it.
- **Keep the promises.** Nothing goes into a permanent copy that someone was
  told would be deleted, and nothing about a person goes in without an
  agreement that covers keeping it. An archive that cannot be edited is the
  worst place to discover personal data.
- **Keep secrets out.** A copy that lasts for years must hold no password,
  token or key, however old.
- **Cost close to nothing, and no new credential.** The site runs under a
  USD 150 monthly ceiling.
- **Prove it works before trusting it.** One archive is read back and checked
  before anything is locked.

## Decision

### 1. One archive a year, in one new private container

A new private Blob Storage container, `content-archive`, on `stsiteprodcus01`.
Each year gets its own folder:

```text
content-archive/
  2026/
    manifest.json                  the list of files, counts and sha256 (kept online, never archived)
    cosmos/content.ndjson.gz       one file per database container (Archive tier)
    cosmos/developer_events.ndjson.gz
    ...
```

Each data file is gzip-compressed NDJSON (one record per line as JSON, then
compressed). That is the same format the nightly backup writes, so the tool
that restores a backup can read an archive.

**Each yearly archive is a complete picture, not a top-up.** The archive of
2026 holds everything that existed on the day it was taken, including records
from earlier years. So a record that lives for five years is in five archives.
That is simple to read back (one folder is the whole answer), and it matters
for erasure (see [section 5](#5-erasure-a-persons-request-to-be-deleted)).

Archives are kept until the owner deletes them. No rule deletes one on a
timer.

### 2. The inventory: what goes in, what is changed first, what stays out

There are three possible decisions for each container: **archive as is**;
**archive with fields removed** (the named fields are taken out of every
record before it is written); or **leave out**, for one of four reasons: a
promise, a secret, derived data (something a job can rebuild, such as a search
index or a cache), or working state (jobs, counters and locks that mean
nothing later).

The list of containers is from
[`infra/cosmos-containers.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/cosmos-containers.json)
(79) and what each holds is from the code under `functions/src` and the notes
in
[`scripts/lib/migration-manifest.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/lib/migration-manifest.mjs).
**This record could not read Azure**, so nothing here is a count or a look at
real records. Where the code does not say what a container holds, the row
says so and the decision is the owner's.

**Totals for the database:** 48 archive as is, 4 archive with fields removed,
18 left out, 9 the owner has to say (each has a proposed default of "leave
out", so nothing doubtful is archived by accident).

#### The database (Cosmos DB account `cosmos-site-prod-cus`, database `hcw`)

| Container | What it holds | Personal data, and whose | A promise that limits keeping it | Proposed decision |
| --- | --- | --- | --- | --- |
| `content` | Every article, page, learning item and interview the site has, published or draft. Public submissions land here too and carry no submitter details. | Yes, for interviews only: the guest's name, role, bio and the dated consent record | The guest agreed to publication on the site (the consent wording in `interviews/consent.js`) | Archive as is. An interview that was never published is left out (rule 2 under the table) |
| `content_versions` | An earlier copy of a content item, one per save (the editor's version history). The only container that grows without limit | Same as `content`: earlier versions of interviews | Same as `content` | Archive as is, with the same rule for unpublished interviews |
| `blogs` | Blog posts from the earlier site, about 242, read only through a fallback path | None found | None | Archive as is |
| `content_templates` | Templates the editor starts a new item from | None found | None | Archive as is |
| `certifications` | Certification pages, about 110, partly generated from Microsoft Learn | None found | None | Archive as is |
| `certEvents` | Certification news items shown on the Skills hub | None found | None | Archive as is |
| `speakerevents` | The owner's own talks and events, about 18 | The owner's own | None | Archive as is |
| `podcasts` | Podcast shows and their settings | None found | None | Archive as is |
| `episodes` | Podcast episodes | None found | None | Archive as is |
| `youtubevideos` | Video entries. No code in `functions/src` or `frontend/src` names this container today, so its fields were not read | Not known | None known | Archive as is; the first run's manifest shows whether it holds anything |
| `recordings` | The owner's voice recordings brought in from the recorder service, with their transcripts | **Possibly other people's**: a recording of a meeting holds whoever spoke. The code cannot say who is in one | No agreement with the other speakers is recorded anywhere in the code | **Owner to say** (not classified). Proposed: leave out until the owner says the recordings are the owner's voice only |
| `plaud_ingest` | Recorder imports from the earlier site. No code names it today | Possibly, as `recordings` | None known | **Owner to say** (not classified). Proposed: the same answer as `recordings` |
| `newsletters` | Newsletter issues: title, text, status, dates | No. Subscriber addresses are kept by the email provider, never in the database (data-subject runbook, section 1) | None | Archive as is |
| `roadmap_items` | Roadmap entries from the earlier site. No code names it today | Not known | None known | Archive as is |
| `wiki_pages` | Wiki pages from the earlier site. No code names it today | Not known | None known | Archive as is |
| `listen_and_learn` | Listen & Learn sets (one per exam) | None found | None | Archive as is |
| `listen_and_learn_episodes` | Listen & Learn episodes: script and audio path, one per exam area | None found | None | Archive as is |
| `podcast_transcripts` | Two-host scripts made from articles and recordings, with their audio path | Possibly, where a script was made from a recording | None | Archive as is, except scripts made from a recording, which follow the answer for `recordings` |
| `designs` | Architecture designs shown on the site | None found | None | Archive as is |
| `frameworks` | Framework pages (for example the Well-Architected pillars) | None found | None | Archive as is |
| `pillar_details` | Detail pages under a framework pillar. No code names it today | None found | None | Archive as is |
| `pillar_items` | Items under a framework pillar. No code names it today | None found | None | Archive as is |
| `social_posts` | Social media posts and captions, about 15 | None found | None | Archive as is |
| `prompts` | The writing prompts the content tools use | None found | None | Archive as is |
| `prompt_keyword_synonyms` | Word lists for the prompts | None found | None | Archive as is |
| `prompt_keyword_augmentations` | Word lists for the prompts | None found | None | Archive as is |
| `image_prompts` | Image prompts, one document per page | None found | None | Archive as is |
| `image_prompts_sets` | Sets of image prompts under a page | None found | None | Archive as is |
| `image_prompt_sets` | Named sets of image prompts | None found | None | Archive as is |
| `image_prompt_sets_prompts` | The prompts inside a named set | None found | None | Archive as is |
| `image_prompt_pages` | Pages that have image prompts | None found | None | Archive as is |
| `generated_content_images` | Records of generated images (the picture itself is a blob) | None found | None | Archive as is |
| `curated_article_images` | Records of hand-picked article images | None found | None | Archive as is |
| `character_profiles` | Character descriptions used for cover images | None found | None | Archive as is |
| `character_modules` | Parts of a character description | None found | None | Archive as is |
| `character_images` | Records of character images | None found | None | Archive as is |
| `character_tag_adjectives` | Word lists for characters | None found | None | Archive as is |
| `brain_records` | The owner's private notes (the Second Brain): notes, links between them, earlier versions | The owner's own; a note can mention anyone | None | Archive as is (the owner's own writing) |
| `doc_vault` | The owner's private templates, applications and letters, with earlier versions, and one `salt` item (a random secret that document ids are made from) | The owner's own; a letter can name someone else | None | Archive with fields removed: the one item `vault-id-salt` is left out, because it is a secret. Phase 2 checks in `doc-vault/model.js` that a restore works without it |
| `ambassador` | The owner's Ambassador hub: programs, the owner's applications and their evidence | The owner's own; free-text fields and attachments can hold someone else's details (data-subject runbook, section 1) | None | Archive as is |
| `developer_events` | Calls for speakers that organizers opened, and the talk proposals speakers sent to them | **Yes, speakers'**: name, email, bio, and the organizer's review note | A proposal that was not accepted loses those four fields after the yearly cycle (#1777) | Archive with fields removed: `speakerName`, `speakerEmail`, `speakerBio`, `reviewNote` from **every** proposal, accepted or not (question 2 below), and whether or not the live clean-up is switched on |
| `tool_workspaces` | Saved work from the Cloud Tools of the earlier site. No code names it today | **Not known**: it may hold what a visitor typed, under a visitor id | None known | **Owner to say** (not classified). Proposed: leave out until the first run reports its count and field names |
| `tool_migration_workspaces` | As `tool_workspaces` | **Not known** | None known | **Owner to say** (not classified). Proposed: as `tool_workspaces` |
| `tool_assessment_sessions` | As `tool_workspaces` | **Not known** | None known | **Owner to say** (not classified). Proposed: as `tool_workspaces` |
| `tool_architecture_plans` | As `tool_workspaces` | **Not known** | None known | **Owner to say** (not classified). Proposed: as `tool_workspaces` |
| `tool_exports` | As `tool_workspaces` | **Not known** | None known | **Owner to say** (not classified). Proposed: as `tool_workspaces` |
| `mcp_servers` | The outside tool servers the site can call (MCP servers), with their sign-in state | No | None; but it holds **secrets**: access tokens, refresh tokens and a client secret | Archive with fields removed: `oauthToken`, `oauthRefreshToken`, `oauthClientSecret`, `oauthPending` |
| `lab_agents` | The list of lab machines allowed to report in. No token or hash was found in the files read | None found | None | Archive as is |
| `admins` | Who may sign in to the admin, and with which role | **Yes, administrators'**: sign-in id, email, role | None | Leave out: it is the access list, not content. Putting back a years-old access list would be a mistake, and the live one is in the nightly backup |
| `admin_config` | About seventy features keep a settings document here: writing-tool settings, reminders, the cost ledger, notes on events, health results, and the records of the keys the site issues | **Yes, in places**: an organizer's name and contact note on each key record; what the owner pays, on the cost ledger | None; but the key records hold a **hash of each key** (a one-way scramble, enough to check a key but not to rebuild it) | Archive with fields removed: whole documents: every `developer_api_key:` record and the agent key record (key hashes and organizers' details), and the short-lived state documents (leases, probe results, caches). Phase 2 lists the document ids in code, with a test, the way the export list is held today |
| `admin_settings` | Admin settings: the Telegram bot's switches, news-feed sources, the model list | None found in the files read | None | Archive as is; phase 2 reads every document id before the first run |
| `site_settings` | Site settings from the earlier site. No code names it today | Not known | None known | Archive as is |
| `system` | Counters and status documents the platform keeps (dashboard counts, publish state) | None found | None | Archive as is |
| `config` | Empty by design: its data lives in the three containers below | None found | None | Archive as is (expected to be empty) |
| `config_providers` | Provider settings from the earlier site. No code names it today, so its fields were not read | Not known | **It may hold keys** typed into the earlier site; not known | **Owner to say** (not classified). Proposed: leave out until the first run reports its field names |
| `config_settings` | Settings from the earlier site. No code names it today | Not known | It may hold keys; not known | **Owner to say** (not classified). Proposed: as `config_providers` |
| `config_tags` | Tag lists from the earlier site. No code names it today | None found | None | Archive as is |
| `ai_providers` | The AI providers the site can use. Holds the *name* of the setting a key is read from, never a key | None found | None | Archive as is |
| `admin_audit_logs` | The log of admin actions and refused sign-ins | Yes: user ids and masked email addresses | **The database deletes each row after 90 days** (`default_ttl`) | Leave out: a 90-day record does not go into a permanent archive |
| `audits` | The log of content changes (who changed what) | Yes: user ids | **Deleted after 90 days**, as above | Leave out, for the same reason |
| `ai_usage` | One row per AI call: task, model, token counts, cost | None found in the files read | None | Archive as is |
| `telegram_bot_activity` | The log of commands sent to the site's Telegram bot | The owner's own (only the owner's chat is allowed) | None | Archive as is |
| `workflow_alerts` | Alerts the publishing checks raised | None found | None | Archive as is |
| `workflow_digests` | The periodic summaries of those checks | None found | None | Archive as is |
| `content_stats_markers` | Bookkeeping that stops the dashboard counters being moved twice | None found | None | Leave out: bookkeeping, rebuilt by a recount |
| `brain_search` | The search index over the owner's notes; rebuilt from `brain_records` | None found | None | Leave out: derived data that a job rebuilds |
| `_snapshots` | The published copy of pages; rebuilt from `content` by a publish | None found | None | Leave out: derived data that a job rebuilds |
| `homepage_feeds` | The home page's news list; refilled on a timer | None found | None | Leave out: derived data that a job rebuilds |
| `rss_cache` | Fetched news feeds; refilled on a timer | None found | None | Leave out: derived data that a job rebuilds |
| `tool_service_cache` | Fetched cloud price lists; refilled on a timer | None found | None | Leave out: derived data that a job rebuilds |
| `tool_price_history` | Daily copies of public cloud list prices, kept 400 days. Refilled going forward but not backfilled, which the owner accepted for the backup | None found | None | Leave out: derived data that a job rebuilds |
| `azure_landing_content` | One landing-page document written from a constant in this repository | None found | None | Leave out: the script in Git is the source |
| `tool_service_catalog` | About eight catalogue documents written by a script in this repository | None found | None | Leave out: the script in Git is the source |
| `jobs` | Background jobs in flight; each row is deleted after 30 days | None found | Short-lived by design | Leave out: working state with no value after its window |
| `lab_jobs` | Lab jobs in flight; deleted after 30 days | None found | Short-lived by design | Leave out: working state with no value after its window |
| `lab_public_quota` | Rate-limit counters; deleted after 2 hours | None found | Short-lived by design | Leave out: working state with no value after its window |
| `submission_quota` | Rate-limit counters keyed by a scrambled visitor identity; deleted after 2 hours | A scrambled visitor identity | Short-lived by design | Leave out: working state with no value after its window |
| `tool_ai_plan_quota` | Rate-limit counters; deleted after 2 hours | None found | Short-lived by design | Leave out: working state with no value after its window |
| `tool_export_quota` | Rate-limit counters; deleted after 2 hours | None found | Short-lived by design | Leave out: working state with no value after its window |

Rules that apply across the table:

1. **A talk proposal is always archived without the speaker's details.** The
   archive job removes the four fields itself. It does not rely on the live
   clean-up, because that clean-up ships switched off (`PROPOSAL_STRIP_ENABLED`
   is `"false"` in
   [`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf)).
2. **An interview that was never published is left out**, in `content` and in
   `content_versions`. The guest's recorded agreement is to publication on the
   site; a draft the guest never saw published is not covered by it. A
   published interview is archived as it is, with the guest's name, role, bio
   and the consent record, because that is what the public page shows.
3. **A container added later must be classified before the next archive.** The
   list is held in code with a test, the way the backup's list is held today
   ([`export-classification.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/backup/export-classification.js)):
   a new container fails the build until someone decides whether it is
   archived.
4. **The nine "owner to say" containers are settled by the owner, not by
   guessing.** Two (`recordings`, `plaud_ingest`) are question 5 below. The
   other seven are settled by a dry run: phase 2 adds a report-only run that
   writes, for every container, the number of records and the *names* of the
   top-level fields (never a value). The owner reads that list and answers.
   Until then all nine are left out.

#### The files (Blob Storage)

| Container (account) | What it holds | Personal data, and whose | A promise that limits keeping it | Proposed decision |
| --- | --- | --- | --- | --- |
| `blogs` (`stsiteprodcus01`) | Cover images for blog posts | None found | None | Archive as is, in the media phase (question 1) |
| `covers` (`stsiteprodcus01`) | Cover images for content | None found | None | Archive as is, in the media phase |
| `certifications` (`stsiteprodcus01`) | Certification badge images | None found | None | Archive as is, in the media phase |
| `speakerevents` (`stsiteprodcus01`) | Files for the owner's talks, and the attachments of the Ambassador hub | The owner's own; an attachment can be someone else's document (data-subject runbook, section 1) | None | Archive as is, in the media phase |
| `content` (`stsiteprodcus01`) | Raw files for content (uploads) | Not known: not read | None known | Archive as is, in the media phase, after the dry run lists what is in it |
| `listenandlearn` (`stsiteprodcus01`) | Listen & Learn episode audio (generated voices) | None | None | Archive as is, in the media phase |
| `podcast` (`stsiteprodcus01`) | Podcast audio (generated voices). Its `uploads/` folder holds recordings waiting to be transcribed | `uploads/` only: whoever is on a recording | **`uploads/` is deleted after 7 days** by a lifecycle rule | Archive as is, in the media phase, **except `uploads/`**, which is left out |
| `interviews-audio` (`stsiteprodcus01`) | `audio/`: a guest's recording. `transcripts/`: the word-for-word text made from it | **Yes, the guest's**: their voice and their words | **`audio/` is deleted after 365 days** | **Leave out, both folders.** The recording because of the promise. The transcript because it is the guest's unedited words; the published interview is already in `content`, and the transcript stays in the live container, where an erasure request can reach it |
| `cosmos-export` (`stsiteprodcus01`) | The nightly database backup | Everything the database holds | Deleted after 35 days | Leave out: it is what the archive is made *from*, and it holds the fields this archive removes |
| `cosmos-export-state` (`stsiteprodcus01`) | Bookmarks the backup uses to know where it stopped | None | None | Leave out: working state |
| `function-releases` (`stsitefuncprodcus01`) | The packaged code of the Function App, one per deployment | None | None | Leave out: the code is in Git |
| `host-backups` (the lab host's backup account, [`infra/lab-hybrid-backups.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/lab-hybrid-backups.tf)) | Nightly backups of the lab machine, including a snapshot of its secret store | Not content | It holds **secrets** | Leave out: secrets, and not site content |

**Totals for the files:** 7 archive as is (one of them with a folder left
out), 5 left out. None of the files is archived in the first version; see
question 1.

#### What is outside Azure

- **The documentation site** ([docs.hybridcloudworks.com](https://docs.hybridcloudworks.com/))
  is built from the `docs/` folder of this repository. Git already keeps
  every version of it, so it is not archived again.
- **The repositories** (this one, the four add-ons and the four Apps: nine
  in all) are code and documents in Git, on GitHub. Git is already a full
  history. Whether a copy of them belongs in this archive is question 3.
- **Newsletter subscribers** are held by the email provider, not by the site.
  They are personal data with no agreement to archive, and they are left out.

### 3. Size: how to measure it, and what it would cost

This record cannot read Azure, so there are no sizes here, only how to get
them. All three lines are **PowerShell**, need nothing but the read-only
Reader role (so the read-only Azure reader described in
[ADR 0043](0043-muse-azure-reader.md) can run them too), and were **not run**
by the session that wrote this.

1. **The database.** One number, in bytes, for the whole account. A number
   around 2,400,000,000 (2.4 GB) matches what the owner measured on
   2026-09-06. If the table is empty, the sign-in has no Reader role on the
   subscription.

   ```powershell
   $c = (az cosmosdb show -n cosmos-site-prod-cus -g rg-db-site-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json).id; az monitor metrics list --resource $c --metric DataUsage --interval PT1H --offset 6h --aggregation Total -o table
   ```

   The archive will be smaller than this: the number includes the database's
   indexes and the containers that are left out, and the files are compressed.
   The truest number is the compressed size of the last weekly full backup,
   which that run's own manifest records. The admin shows the backup's state
   at
   [Health → Overview → Nightly export](https://hybridcloudworks.com/admin/health?tab=overview);
   this record did not check whether that line shows the size, and the dry
   run in phase 2 reports it either way.

2. **All the files together, split by tier.** One row per tier (Hot, Cool),
   in bytes. This is the whole account, backups included.

   ```powershell
   $s = (az storage account show -n stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json).id; az monitor metrics list --resource "$s/blobServices/default" --metric BlobCapacity --interval PT1H --offset 2d --aggregation Average --filter "Tier eq '*'" -o table
   ```

3. **Each file container on its own.** One row per container. Microsoft lists
   this metric (`ContainerUsedSize`) as an "advanced platform metric", and
   this record does not know whether it is switched on for this account. If
   the table is empty, that is the reason, not an error in the line; say so
   on #1811 and the dry run in phase 2 will count the files instead.

   ```powershell
   $s = (az storage account show -n stsiteprodcus01 -g rg-stor-site-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json).id; az monitor metrics list --resource $s --metric ContainerUsedSize --interval PT1H --offset 2d --aggregation Average --filter "ContainerName eq '*'" -o table
   ```

   The metrics are described on
   [Azure Blob Storage monitoring data reference](https://learn.microsoft.com/azure/storage/blobs/monitor-blob-storage-reference#metrics).

**What it would cost, at the retail list price above** (not what the owner
pays, which this record does not know): every 10 GB kept in the Archive tier
on this account is about **4 US cents a month** (10 × $0.004), or about 50
cents a year. On a single-region account it would be 2 cents. One year's
database archive is expected to be well under 10 GB, so the first version
costs a few cents a month; and since each year adds a complete copy, ten
years of database archives is still tens of cents a month. Images and audio
are the unknown, which is why they are measured before they are added.

### 4. How an archive is made

**It is made from the weekly full backup, not by reading the database
again.** Every Sunday the backup job already writes one complete, checked copy
of each container as a file in the private `cosmos-export` container. The
archive job takes the first complete Sunday copy dated on or after
2 February (one day after the yearly clean-up of proposals runs), and for
each container on the "archive" list it reads the backup file, drops the
records and fields the inventory says to drop, and writes the result into the
year's folder. Reasons:

- The backup is one consistent, already verified picture, with its own
  manifest to check counts against.
- It costs nothing in database charges and puts no load on the live site.
- The containers that are derived data or working state are not in the backup
  at all, so they cannot leak into the archive by mistake.

The dependency this creates is said plainly: **no backup, no archive.** If the
nightly export is switched off, the archive job does nothing and says so.

**Where it runs: inside the Function App** (the site's server-side code), as
one small background job per container, the same way the backup runs.
Reasons, and why not a GitHub workflow:

- The storage account and the database refuse every caller outside the
  Function App's own network
  ([ADR 0025](0025-cosmos-firewall-datacenter-sentinel.md),
  `default_action = "Deny"` in
  [`infra/storage.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/storage.tf)).
  A workflow on GitHub's machines cannot reach either without opening the
  firewall for the length of the run.
- The Function App's identity already holds the one role needed (Storage Blob
  Data Contributor on the account), so there is **no new credential and no
  new role**.
- A job is limited to one container at a time and passes the file through as
  a stream (read a piece, change it, write it, forget it), so memory stays
  flat however large the container is. The Function App has 2 GB per
  instance. The 30-minute limit on one job is the thing to watch:
  `content_versions` is the only container that grows without limit, and
  phase 3 measures its job and splits the file if it comes close.

**The steps of one run:**

1. A daily timer checks four things and does nothing unless all are true: the
   switch `CONTENT_ARCHIVE_ENABLED` is `true` (it ships `false`); today is on
   or after 1 February; `content-archive/<last year>/manifest.json` does
   **not** exist; and a complete full backup dated on or after 2 February
   exists.
2. It queues one job per container on the archive list.
3. Each job writes its file as an ordinary online file first, counting
   records and computing the sha256 as it writes. Then it reads the file back
   and checks the sha256 and the record count.
4. When every container's file is checked, the last job writes
   `manifest.json`: the year, the date, which backup it was made from, the
   version of the code, and for each file its name, size, record count,
   sha256 and the list of fields that were removed. It holds no record and
   no id.
5. Only then is each data file moved to the Archive tier. The manifest stays
   online, so anyone allowed can see what an archive holds without waiting
   15 hours.

**Why write online first and archive last:** a file in the Archive tier
cannot be read or fixed. Checking it before it goes offline is the only cheap
moment to check it.

**Running twice does no harm.** File names are fixed by year and container. A
job that finds its file already checked skips it. The manifest is written
with "create only, never overwrite", so two jobs racing cannot both write it.

**If a run stops half-way**, nothing has been archived yet (step 5 has not
happened), so every file is still online and replaceable. The queue retries
the failed job; the next day's timer sees no manifest and queues whatever is
missing. A run with no manifest six hours after it started raises an alert,
the way a missed backup does today.

**Once a year, and never in January, is enforced by the timer itself:** the
year it archives is always "last year", it refuses to run before 1 February,
and it refuses to run when that year's manifest exists. A year that was
missed (the switch was off) is not made up later: the live database still
holds whatever was not deleted, and the next archive is a complete picture
anyway. A second archive of the same year is possible only by the owner
deleting the manifest on purpose.

**Images and audio: a second step, not the first version.** When they are
added, the recommended way is a server-side copy: the storage service copies
each file from its container into the year's folder and sets the Archive tier
on the copy, without the file passing through the Function App
([Archive a blob: copy operation](https://learn.microsoft.com/azure/storage/blobs/archive-blob#archive-an-existing-blob)).
Reasons to wait:

- Their size is unknown, and the size decides whether the existing account or
  a cheaper single-region one is right.
- Thousands of small image files are the case Microsoft warns is slow to
  rehydrate, so they may be better packed into a few large files first. That
  choice should be made with real counts.
- The first archive has to be read back and proved. Proving it on a few
  dozen database files first is quicker than on thousands of images.
- Unlike database records, the media files are still sitting in their live
  containers, with 30 days of earlier versions kept. Nothing is at risk while
  they wait.

### 5. Erasure: a person's request to be deleted

**The design aim is that an erasure request never touches the archive**,
because nothing about a person is archived unless an agreement covers it. What
that leaves:

| Personal data still in the archive | Why it is there | What an erasure request means |
| --- | --- | --- |
| A published interview: the guest's name, role, bio, their words as published | The guest agreed to publication, and the consent record is archived with it | The archive must be rewritten (below) if the guest withdraws |
| The owner's own data (notes, applications, talks, bot log) | It is the owner's | Nothing: the owner is the one asking |
| Someone named in the owner's free text or attachments (a note, a letter, an Ambassador entry) | The code cannot see inside free text | The archive must be rewritten if such a request is upheld |
| Speakers who sent proposals | **Not there**: the four fields are removed before archiving | Nothing to do in the archive |
| Administrators, audit rows, subscribers, recordings | **Not there**: left out | Nothing to do in the archive |

**When the archive does have to change, this is the honest procedure.** A file
in the Archive tier cannot be edited. So, for **each** year's archive that
holds the person's record (every archive taken while the record existed):

1. Rehydrate the one container file by copying it to an online file. Wait up
   to 15 hours. This is charged per GB read.
2. Rewrite it without the person's record, check it, and write it back into
   the year's folder as a new Archive-tier file.
3. Delete the old file **and its earlier versions** (the account keeps
   earlier versions for 30 days and deleted files for 7; an erasure is not
   finished until those are gone too). Deleting a file younger than 180 days
   adds the early-deletion charge, which for a file of this size is cents.
4. Rewrite the manifest with the new sha256 and a line saying the file was
   rewritten for an erasure on that date (no name, no reason).

That is slow, by-hand work measured in days, not minutes, and it is the price
of an archive. It is also the reason this design removes personal data first
and the reason the archive is **not locked**: a locked archive could not
honour step 3 at all. If the owner later wants a lock, it has to be weighed
against this.

**The change needed in the data-subject requests runbook.** Step 4 of
section 4 of
[`docs/runbooks/data-subject-requests.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/data-subject-requests.md)
tells the person today: "Copies in disaster-recovery backups are not edited;
they are deleted automatically, within 35 days at the latest." Once the first
archive exists that sentence is no longer the whole truth. The pull request
that builds the job (phase 3) changes the runbook in three places:

- **Section 1 (the list of stores)** gets a row for `content-archive`: what
  is in it, that speakers' details, administrators, audit rows and recordings
  are never in it, and that it is kept until the owner deletes it.
- **Section 4 gets a new step, "The yearly archive"**: check the request
  against the table above; if the person is a published interview guest or
  is named in the owner's own writing, follow the four steps above for each
  year's archive; otherwise write down "not in the archive" with the reason.
- **The sentence to the person** becomes: "Your live records and mailing-list
  subscription have been permanently erased. Backup copies are not edited;
  they are deleted automatically within 35 days. The site also keeps a yearly
  long-term archive; it does not hold your details" or, where it did, "and
  your details have been removed from it as of" the date.

The runbook is **not** changed by the pull request that adds this record,
because no archive exists yet and the current wording is true today.

### 6. Reading an archive back

Who: **only the owner**, with a grant that is added for the job and removed
after it, the way the runbook for deleting an interview recording works
today. Nobody holds a standing right to read the archive except the Function
App's own identity, which writes it.

The steps (the exact lines are written and tried in phase 3, in a new
runbook, on the first real read-back; they are not guessed here):

1. Read `content-archive/<year>/manifest.json` in the admin. It is online, so
   this needs no waiting and no grant. Pick the files wanted.
2. Start the rehydration: the Function App copies each wanted file to an
   online copy under `content-archive/readback/<year>/`. The archived file is
   not touched. This is a button in the admin, so no workstation needs to
   reach the storage account for it.
3. Wait. Up to 15 hours at standard priority; the admin shows when each copy
   is ready.
4. The Function App computes the sha256 of each online copy and compares it
   with the manifest. **A match is the proof.** A mismatch is a failed
   read-back and is investigated before anything else happens.
5. To take the files away: the owner opens the storage firewall to their own
   address and gives their own account the Storage Blob Data Reader role on
   the `content-archive` container, downloads from `readback/<year>/`, and
   removes both again.
6. The online copies are deleted when the work is done, so they are not paid
   for at the online price and are not a second place personal data lives.

**The read-back rule.** The first archive is read back in full, every file,
and every sha256 must match, before (a) the archive is called done on #1811,
and (b) any lock against deletion is even discussed. The result is written on
#1811 with the date.

### 7. Security

- **Private.** The container is private, the account refuses anonymous reads
  outright (`allow_nested_items_to_be_public = false`), and its firewall
  admits only the Function App's network. The container is never added to the
  list of containers the public media route serves
  (`PUBLIC_MEDIA_CONTAINERS` in
  [`blob-paths.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/blob-paths.js));
  a test holds that.
- **No shared link, ever.** No SAS (a web address with a built-in password
  that lets anyone holding it read a file) is created for the archive, by the
  code or in any runbook. Access is by Microsoft Entra sign-in and role only.
- **Who holds what.** The Function App's identity: Storage Blob Data
  Contributor on the whole account, which it already has; nothing is added.
  The owner: no standing data role; Storage Blob Data Reader on the one
  container for the length of a download. The read-only Azure reader
  (ADR 0043): Reader on the subscription, which can see that the container
  exists and how big it is, and cannot read a file. Nobody else.
- **No secrets archived.** These are the places a secret or a token lives in
  the database, and what happens to each:

  | Where | What | In the archive |
  | --- | --- | --- |
  | `mcp_servers` | `oauthToken`, `oauthRefreshToken`, `oauthClientSecret`, `oauthPending` (sign-in tokens for outside tool servers) | Fields removed |
  | `admin_config`, records `developer_api_key:…` and the agent key record | The hash of each key the site issued, with the organizer's name and contact note | Whole records left out |
  | `doc_vault`, item `vault-id-salt` | The random secret that document ids are derived from | Item left out |
  | `config_providers`, `config_settings` | Not known; they may hold keys typed into the earlier site | Left out until the dry run shows their field names |
  | `host-backups` (files) | A snapshot of the lab machine's secret store | Left out |

  Every other key the site uses is in Key Vault, not in the database, and is
  never near this job. A test in phase 2 feeds the job a made-up record
  carrying each field above and fails if any of them comes out the other
  side.
- **Logs name no record.** As with the backup: container names, counts,
  sizes and durations only.
- **Not locked.** No immutability policy (a rule that stops files being
  deleted or replaced for a set time) is put on the container. After the
  first successful read-back the owner can ask for an **unlocked** one, which
  stops the application deleting an archive by mistake and which the owner
  can still lift. A **locked** one cannot be lifted by anyone and would block
  an erasure, so this record recommends never locking while any personal data
  remains in the archive.
- **Deleting is guarded the usual way.** The Terraform resource for the
  container carries `prevent_destroy`, like the other stores that hold data.

### 8. What ADR 0028 promised, settled

ADR 0028's amendment of 2026-10-16, item 4, says full backups "are archived
quarterly to an offline or secondary subscription storage account". **That
was never built, and it is replaced by this yearly archive.** The part about
a second subscription is dropped by the owner's decision of 2026-11-24: the
archive is for getting old content back, not for surviving the loss of the
subscription. ADR 0028 carries a dated note pointing here; its status is not
changed by this record.

## What is not decided: five questions for the owner

Each can be answered with one word on
[#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811).
"As recommended" answers all five.

1. **Images and audio: in the first archive, or as a second step?** They are
   most of what a visitor sees, but their size is unknown and they are still
   safe in their live containers.
   - `LATER`: the first archive is the database only; images and audio follow
     once they have been measured and the first read-back has passed.
     **Recommended.**
   - `NOW`: build both together; the first archive waits for the larger
     build.
   - `NEVER`: the archive is the database only; images and audio stay in
     their live containers.
2. **An accepted talk proposal: are the speaker's details archived?** The
   speaker typed their name, email and bio to be considered for one event.
   Nothing in the code records an agreement to keep them for good.
   - `STRIP`: archive the talk's title, abstract and decision, without name,
     email, bio or review note. No speaker's personal data is in the archive,
     so an erasure request never touches it. **Recommended.**
   - `NAME`: also keep the speaker's name (a talk that was accepted was given
     in public under that name). An erasure request from a speaker then means
     rewriting archives.
   - `KEEP`: keep all four fields. The same, with more to remove.
3. **The nine repositories (this one, the four add-ons, the four Apps): are
   they part of this archive?** They are code and documents in Git on GitHub,
   which already keeps every version.
   - `GIT`: leave them where they are; Git is their history. **Recommended.**
   - `BUNDLE`: each year, also store one file per repository holding its full
     history (a "git bundle") in the archive. This needs a workflow in each
     repository and a way for it to write into the storage account, which is
     new access to design.
4. **How a yearly run starts.**
   - `AUTO`: a daily timer inside the Function App starts it by itself on the
     first day all the conditions in section 4 are true. It ships switched
     off; the owner switches it on once. **Recommended.**
   - `BUTTON`: the same job, but it only ever runs when the owner presses a
     button in the admin. Nothing can be forgotten *on*, but a year can be
     forgotten.
   - `WORKFLOW`: a GitHub workflow the owner starts by hand. Not recommended:
     GitHub's machines cannot reach the database or the storage account, so
     each run would have to open both firewalls.
5. **The owner's recordings: is anyone else's voice on them?** `recordings`
   and `plaud_ingest` hold recordings and their transcripts.
   - `MINE`: they are the owner's voice only; archive them as they are.
   - `OTHERS`: some are meetings or conversations; leave both containers out
     (and the scripts made from them). **This is what happens until the
     question is answered.**

Not a question, but the owner's to confirm after the dry run: the seven
containers left over from the earlier site whose contents the code cannot
describe (`tool_workspaces`, `tool_migration_workspaces`,
`tool_assessment_sessions`, `tool_architecture_plans`, `tool_exports`,
`config_providers`, `config_settings`). They stay out until then.

## Phases

| Phase | What the pull request contains | The owner's steps |
| --- | --- | --- |
| **1. Design** (this record) | This decision record, the note on ADR 0028, the changelog entry. No code, no Terraform, no workflow | Read it; answer the five questions; reply `ACCEPT` on #1811 |
| **2. Storage and the list** | Terraform: the private `content-archive` container with `prevent_destroy`, and the app setting `CONTENT_ARCHIVE_ENABLED = "false"`. No lifecycle rule, no immutability policy, no new role. Code with no effect on its own: the archive list (every container and its decision, with the test that fails on an unclassified one), the field-removal function with its "no secret comes out" test, and the report-only dry run | Confirm the Terraform run in HCP Terraform (it adds one empty container and one setting; nothing is replaced or destroyed). Run the dry run from the admin and answer for the seven leftover containers |
| **3. The job and the runbook** | The timer, the per-container job, the check-then-archive step, the manifest, the alert for a run that did not finish, a line on the admin Health page, the read-back button, a new runbook `docs/runbooks/content-archive.md`, and the changes to the data-subject requests runbook from section 5. No new credential, so the credential checklist has nothing to add; the pull request says so row by row | Switch `CONTENT_ARCHIVE_ENABLED` on. The first run happens on the first day the conditions are true (for the archive of 2026: the first Sunday backup on or after 2 February 2027; the owner can ask for an earlier trial archive under a `trial/` folder to prove the read-back sooner). Then do the read-back and write the result on #1811 |
| **4. Images and audio** (if question 1 is `LATER` or `NOW`) | Sizes from section 3, the choice between this account and a single-region one, the copy job, and its manifest | Run the sizing lines; confirm any Terraform run; read back a sample |
| **5. A lock, if wanted** | Only after the read-back: an unlocked time-based policy on the container | Decide; confirm the Terraform run |

## Consequences and accepted risks

- **The archive is as good as the Sunday backup it is made from.** A fault in
  the backup is a fault in the archive. The check in step 3 proves the
  archive matches what was read, not that the backup was right; the backup's
  own restore drill covers that.
- **"Archive of 2026" means "everything that existed in early February
  2027".** It includes January 2027's records and does not include anything
  deleted during 2026. A record created and deleted inside one year is in no
  archive. That is accepted: the archive is a yearly picture, not a history
  of every change.
- **Left-out containers are gone for good if the live copy is lost.** The 90
  days of audit rows, the access list and the caches are not recoverable from
  the archive, by design.
- **Removing fields is one-way.** An accepted speaker's email cannot be got
  back from an archive. That is the point.
- **A second copy in another region exists whether asked for or not**, and
  doubles the (very small) storage price. Accepted by the owner.
- **Erasure after archiving is slow and manual** for the two cases left in
  section 5.
- **Reading back costs money and time**, so it is done on purpose, not out of
  curiosity. Order of magnitude at list price: cents for the database files.
- **One more switch that ships off.** Until `CONTENT_ARCHIVE_ENABLED` is
  `true` there is no archive, and nothing reminds anyone. Phase 3 puts its
  state on the Health page for that reason.

## Alternatives considered

- **A quarterly copy in a second subscription** (what ADR 0028's amendment
  said). Dropped by the owner: the archive is not disaster recovery.
- **A separate single-region (LRS) storage account.** Half the storage price
  and no unrequested second copy, but a new account, new network rules and a
  new role, to save a fraction of a cent a month on the database. Revisit in
  phase 4 if images and audio are large.
- **A lifecycle rule that moves old backups to the Archive tier.** Simple,
  but it would archive the backup as it is: every field, tokens and
  speakers' details included, with no chance to remove anything. Rejected.
- **Reading the database directly for the archive.** Works, but costs
  database charges, loads the live site, and needs its own consistency
  checks that the backup already does.
- **Writing straight into the Archive tier.** One step fewer, but a file that
  failed half-way could not be read to find out, and could not be fixed.
- **A GitHub workflow with the keyless Azure sign-in.** Good for a job that
  only needs the control plane. This one needs to read and write files
  behind two firewalls that admit only the Function App.
- **Archiving everything with nothing removed, and editing on request.**
  Closest to "all", and the worst for erasure: every request would mean a
  15-hour, by-hand rewrite of every year's archive.

## Validation and revisit triggers

Validated when:

- The dry run's counts for the archived containers match the manifest of the
  backup it read.
- The first archive's manifest lists every container on the archive list and
  no other.
- The "no secret comes out" test and the "unclassified container fails the
  build" test are in CI.
- The first archive has been read back in full and every sha256 matched,
  recorded on #1811.

Revisit when:

- Images and audio are measured (phase 4): the account choice, and packing
  small files.
- A new kind of personal data is added to the site: it is classified before
  the next archive.
- The owner wants a lock: weigh it against erasure first.
- The weekly full backup changes shape or is switched off: the archive
  depends on it.
- An erasure request is upheld for something in the archive: do it, time it,
  and write the real steps into the runbook.

## Noticed while writing this, not changed here

- **ADR 0028's amendment states the quarterly copy as a fact** ("are archived
  quarterly") though it was never built. It looks like an oversight, not a
  choice; the note added to ADR 0028 by this change corrects it.
- **The nightly backup holds the fields this archive removes**: the sign-in
  tokens in `mcp_servers`, the key hashes in `admin_config` and speakers'
  details, for 35 days, in the private `cosmos-export` container. That looks
  deliberate in effect (a backup has to be able to restore a working site)
  but it is not written down in ADR 0028. No change is proposed; it is worth
  one sentence in ADR 0028 or the restore runbook.
- **`audits` and `admin_audit_logs` are deleted by the database after 90
  days, and are also in the weekly backup**, which keeps a copy up to 35 days
  longer. Probably fine, and not written down.
- **The data-subject requests runbook still has lines with placeholders**
  (`<USER_EMAIL>`, `<AUDIENCE_ID>`), against this repository's rule for
  commands. Already noted on
  [#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777#issuecomment-7123832000);
  not fixed here.
- **ADR 0028 is still "Proposed"** though the backup has run since September.
  Its status is the owner's to change.

## Related decisions and references

- [ADR 0028](0028-cosmos-out-of-account-export.md): the nightly backup this
  archive is made from, and the promise this record replaces.
- [ADR 0025](0025-cosmos-firewall-datacenter-sentinel.md): why the job runs
  inside the Function App.
- [ADR 0040](0040-interviews-from-the-admin.md): interview recordings, their
  365-day retention and the consent record.
- [ADR 0042](0042-developer-api.md): talk proposals and the keys the site
  issues.
- [ADR 0043](0043-muse-azure-reader.md): the read-only Azure reader that can
  run the sizing lines.
- [Data-subject requests runbook](../runbooks/data-subject-requests.md) and
  [Cosmos restore runbook](../runbooks/cosmos-restore.md).
- Issue [#1811](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811)
  (this work) and
  [#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777)
  (where the owner asked for it).
- Microsoft Learn, opened on 2026-11-24:
  [Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview),
  [Archive a blob](https://learn.microsoft.com/azure/storage/blobs/archive-blob),
  [Blob rehydration from the archive tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview),
  [Rehydrate an archived blob to an online tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-to-online-tier),
  [Azure Blob Storage monitoring data reference](https://learn.microsoft.com/azure/storage/blobs/monitor-blob-storage-reference#metrics).

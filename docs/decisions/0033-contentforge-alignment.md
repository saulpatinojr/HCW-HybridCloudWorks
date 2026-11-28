# ADR 0033: ContentForge alignment — one content operating system

**Status:** Accepted (implementation brief; owner request 2026-10-03)
**Decision date:** 2026-10-03
**Owners:** Workload owner

## Context

ContentForge (the `/admin` CMS) grew one hub at a time. Each hub works on
its own, but the whole reads as a set of unrelated pages: two identical
pipeline graphics on the home page, a sidebar a new user cannot decode,
features that create things and then lose them, and four hubs that
re-implement the same list, status and delete patterns. An inventory of all
twenty-six admin pages, their routes, data and backend on 2026-10-03 is
condensed below; it is the basis for every slice that follows.

## 1. Current-state findings

**Store.** Cosmos DB (74 containers, `infra/cosmos-containers.json`,
generated from `scripts/lib/migration-manifest.mjs`), Azure Blob for media.
Comments still say Firestore throughout. Adding a container needs a
manifest edit, a regenerate and a Terraform apply (human review).

**Pipeline.** One `content` container, no schema, fields under several
spellings. Twelve statuses in `lib/cms/content-status.js`; the frontend's
`CONTENT_STATUSES` is stale and unused. Content type is `type`
(blog / framework / architecture / coder_corner, plus derived news). Origin
is the free-text `source` field (rss, manual_url, forge-url, recording,
drafts, repo, template-form, firecrawl). `content_versions` is written on
every save and read by nothing. No autosave. Three audit sinks, some
actions logged twice. No shared CRUD helper; `drafts-handlers.js` is the
best ETag-safe template, `admin-crud.js` the best REST template.

**Confirmed blocking bug.** Every Approve button (queue, review page, all
review boards, editor save bar) sends `newStatus: 'approved_blog'`. The
backend normaliser maps only the retired news statuses, so the transition
table rejects it with 400 "Invalid transition". Approval has been failing
from every surface. The Queue "Approved" chip, the Editor list filter and
the Frameworks / Coder Corner `published_blog` filter query statuses that
are never stored, so they always come back empty. `forge_ready` and
`needs_rework` are counted in the Editor badge but shown on no screen.

**Home.** The quick-action row and the "ContentForge Pipeline" card show
the same four stages with the same counts. Sidebar and dashboard duplicate
the count formula; the sidebar never refetches. "1801" and "99+" are the
same number.

**Creative.** Forge Studio is a configuration form for the autonomous
forge, not a workspace; forging starts from the Queue. The manual forge job
store lacks `incrementIf`, so the budget claim throws. AI Engine has one
global provider order, per-feature on/off and NVIDIA placement; no per-task
provider or model, the portal model overrides every purpose, usage is
recorded by five of fourteen call sites, and a custom MCP server accepts
any URL plus any app-setting name as its bearer key. Image Prompts and
Image Gallery share no data: lineage fields exist but are written empty,
the AI cover ignores the prompt library, regeneration overwrites the same
blob path, AI-generated blobs are never deleted, "Update selected" updates
one image, tag toggles erase tags, folders are not persisted, and the
keyword matrix is read by no generator.

**Amplify.** Calendar shows only scheduled content, month view only, no
reschedule or delete, and never refetches after a change. Newsletter
issues never move from `scheduled` to `sent`, so metrics never appear.
Social Hub always reports "connected". Recording Hub's "Send to pipeline"
crashes on an unimported function after creating the content.

**Enhanced (today split across Spotlight and Platform).** Listen & Learn
is two levels (certification set → area episode) with no versions, no
rename, reorder, archive or delete; regeneration overwrites the blob under
a one-year immutable cache header, a failed regeneration takes a published
episode off the site, and its Settings link 404s. Labs are hard-coded in
three places with no provider tag, objectives or steps; the public page is
one cross-provider list; the admin hub manages only the job runner.

**Spotlight.** Speaking and Certifications work but share no code: two
data-fetch hooks, two delete dialogs, two editors (neither uses the shared
dialog), no shared table or status badge. Snapshot publishing probably has
no public effect until the next deploy because `/about` reads build-time
JSON first. "Feature in Spotlight" is dropped by the sanitizer. Neither
feeds the calendar. Dates are stored as UTC midnight and shown a day early
in US time zones.

**Platform.** Health's timestamp formatter expects Firestore objects, so
every time shows "Not available". Status vocabulary differs on every
surface. Most hubs have no probe. Two links to `/admin/platform-settings`
404. Settings are split across `admin_config`, `admin_settings` and
`cms/config/*`.

## 2. Duplicate or conflicting functionality

| Duplicate | Disposition |
|---|---|
| Dashboard quick actions vs Pipeline card | Keep the Pipeline card (it is the one with stage counts and a flow); fold Social and Recording into a "Next up" strip; remove the quick-action row |
| Sidebar vs dashboard count formula | One `useDashboardCounts` hook; sidebar refetches on route change and after recalculate |
| Four review boards, approve/reject/restore written three times | Shared `useContentTransitions`; boards keep their fields |
| Two delete endpoints, two `getLiveUrl` | Frontend uses `lib/livePages.getLiveUrl` only |
| `CONTENT_STATUSES`, `canPerformAction`, empty allowlists in `config/admin.js` | Remove |
| NewsletterCalendar vs Calendar | Calendar aggregates newsletter sends; the hub keeps its month view as a filtered embed |
| Speaking `useGuardedLoad` vs Certifications `useCertifications` | Shared `useGuardedLoad` + `useWriteGuard` under `components/admin/shared/` |
| Hand-built Cert editor overlay vs `ui/dialog` | `ui/dialog` |
| Status vocabulary on five surfaces | `lib/status.js`: healthy / degraded / misconfigured / unavailable / unknown for systems; one label map for content statuses |

**Amended 2026-10-08 (#1010, #1011).** The system words are now healthy /
degraded / critical / offline / unknown. Critical replaces misconfigured and
covers every check that answered and said no; offline replaces unavailable
and means not reachable, or silent past a heartbeat. The transition rules
(freshness windows, critical against offline, the heartbeat) are written in
`lib/status.js` beside the words, and `toSystemStatus` still reads the two
old ids.

## 3. Navigation map (sidebar)

```
HOME        Dashboard
PIPELINE    New Content · Drafts · Review Queue · Editor · Publish · Live Pages
ENHANCED    Listen & Learn · Labs · Frameworks · Coder Corner
CREATIVE    Forge Studio · AI Engine · Image Prompts · Image Gallery
AMPLIFY     Calendar · Newsletter Hub · Social Hub · Linkie Hub · Recording Hub
SPOTLIGHT   Speaking · Certifications · Ambassador
PLATFORM    Platform Settings · Health · Integrations
```

Every item carries a one-line description shown as a tooltip and as the
page's purpose statement, from one registry (`config/adminNav.js`) that the
sidebar, the dashboard and the page headers all read. "Prompts" becomes
"Image Prompts" so the relationship with Image Gallery is in the name.

Public routes gain `/:provider/education/labs` and
`/:provider/education/labs/:labId`; `/education/labs` stays as the
cross-provider index.

## 4. Domain model changes

No new Cosmos container except one. Everything else is new fields on
existing documents plus new `admin_config` documents (constant partition).

- **Taxonomy** (`admin_config/content_taxonomy`): `kinds[]` (what the item
  becomes: article, tutorial, documentation, course lesson, newsletter,
  social post, podcast script, audiobook chapter, case study, image set,
  …) and `ideaOrigins[]` (how it became an idea: manual, content gap,
  audience question, refresh, conference, certification objective, speaker
  engagement, ambassador requirement, AI recommendation, imported source,
  RSS feed, repurposing, …). Each `{id, label, description, enabled,
  order}`. Admins add, rename, disable and reorder; ids are never deleted.
  Content documents gain `kind` and `ideaOrigin`; absent values are derived
  from `source` at read time, so no backfill is needed.
- **Status fix**: `normalizeStatusForBlogOnly` also maps `approved_blog →
  approved` and `published_blog → published` so old clients keep working;
  the frontend sends canonical statuses.
- **Images**: generated image rows carry `promptSetId`, `promptName`,
  `setId` (an image set is a prompt set), `altText`, `caption`, `license`,
  `width`, `height`, `bytes`, `archivedAt`, `softDeletedAt`; generation
  paths get a timestamp so regeneration never overwrites. Gallery folders
  persist in `admin_config/gallery_folders`.
- **AI routing** (`admin_settings/ai-routing`): per-feature
  `{provider, model, fallbacks[]}`; router reads it ahead of the global
  order. Every call site records usage.
- **Audio Library**: `listen_and_learn` documents gain `kind`
  (`course | book`), `author`, `coverImageUrl`, `description`, `tags[]`,
  `archivedAt`; episodes (chapters) gain `versions[]`
  `{id, audioUrl, audioPath, bytes, durationSeconds, speechProvider,
  speechModel, generatedAt, active}`, `order` becomes editable, blob paths
  gain a version stamp.
- **Calendar**: a read-only aggregate `GET cms/calendar?from&to` unions
  content schedules, newsletter issues, social posts, speaking events,
  certification expirations, Ambassador deadlines and audio releases, each
  item `{id, kind, title, start, end, status, href, sourceId}`.
- **Speaking** gains `status` (idea, proposed, accepted, declined,
  delivered), `cfpDeadline`, `sessions[]`, `evidence[]`. **Certifications**
  gain `renewalDate`, `evidence[]`. Dates stored as plain `YYYY-MM-DD`
  where the value is a calendar date.
- **Ambassador** (new container `ambassador`, partition `/id`, documents
  distinguished by `docType`: `program`, `application`, `evidence`).
  Programs are seeded from a catalogue of seven community and recognition
  programs (today `functions/src/lib/ambassador/programs.js`); all
  editable, disable-able.
  Evidence items link by `{sourceModule, sourceId}` and keep a `snapshot`.
  Amended 2026-10-05: a program may be additional to another
  (`parentProgramId`, one level); its card, questions and application open
  only while the parent's membership is Active, and the parent's evidence
  counts for it. The first such pair seeded is a regional-lead program
  that is additional to its parent program.
- **Labs** catalogue rows gain `providers[]`, `objectives[]`,
  `prerequisites[]`, `steps[]`, `difficulty`, `validation`.

## 5. Cross-feature relationship map

```
Idea (kind + ideaOrigin) ─► Drafts/Submit ─► Queue ─► Editor ─► Publish ─► Live Pages
      ▲                         │                                      │
      │ Forge Studio brief ─────┘                                      ├─► Calendar
Image Prompts ─► Image Set ─► Image Gallery ─► covers/inline in content │
Listen & Learn: content ─► chapter audio (versions) ─► public audio ───┤
Newsletter: pulls live content + gallery images; sends ───────────────┤
Social / Linkie: pulls live pages ────────────────────────────────────┤
Speaking + Certifications ─► Ambassador evidence ─► applications ─────┘
AI Engine routing is read by every generator; usage flows to the Usage tab
Health probes every hub's dependency; Settings holds taxonomy + defaults
```

## 6. Highest-risk migrations

1. **Status normaliser change** touches every transition; covered by the
   existing state-machine tests plus new alias tests. Rollback is a revert.
2. **Image blob paths with timestamps**: existing rows keep their paths;
   only new generations change. Deleting a row deletes only its own blob.
3. **Audio versions**: existing episodes are read as one implicit version;
   the first regeneration writes `versions[]`. Cache header for
   `listenandlearn` drops to revalidate.
4. **Ambassador container** needs `terraform apply` (owner review). Until
   applied the hub shows a clear "not provisioned" state, nothing else
   breaks.
5. **Sidebar regroup** breaks bookmarks for nothing (routes unchanged) but
   the Platform-group nav test is rewritten deliberately.
6. **Labs per-provider routes** must be declared before
   `education/:certSlug` or `labs` is read as a certification slug.

## 7. Prioritized implementation sequence

1. Foundation: approve bug, filter fixes, nav registry + regroup, one
   pipeline graphic, shared primitives (PageHeader, StatusBadge,
   EmptyState, ListToolbar, useGuardedLoad), taxonomy model + settings tab,
   Health timestamp fix, 404 link fixes, status vocabulary.
2. Creative: Forge Studio workspace, AI routing by task, Image Prompts ↔
   Gallery lineage and gallery CRUD fixes.
3. Amplify: Calendar aggregate + reschedule/unschedule, Newsletter
   sent-state reconciliation + manual content blocks + CSV export.
4. Enhanced: Audio Library (books/chapters/versions, cheapest default
   voice), Labs provider structure + Agent/Desktop/Lab tabs.
5. Spotlight: Speaking + Certifications fixes, Ambassador module.
6. Platform: Health breadth, Settings consolidation, Integrations cards for
   AI keys.

Each slice ships with tests and a CHANGELOG entry; infra changes (the
`ambassador` container) are batched in the Spotlight slice.

## 8. Acceptance criteria

- Approve works from queue, review boards and editor; every status filter
  returns what it names; `forge_ready` and `needs_rework` have a chip.
- One pipeline graphic on Home, with Drafts and Live Pages as stages and
  counts that match the sidebar.
- The sidebar groups match §3 and every entry explains itself on hover.
- Every content record can carry a kind and an idea origin, both
  configurable in Settings without deleting history.
- Forge Studio starts from an idea, template, source or image set, writes
  a draft into the pipeline, and offers next actions on completion.
- AI providers can be assigned per task with fallbacks; usage is recorded
  for every call site.
- From an image you can see its prompt and set; from a set you can see
  every image; archive, restore, bulk edit and soft delete work.
- Calendar shows every scheduled kind, supports month / week / agenda,
  reschedule and unschedule, and links each item to its record.
- Newsletter issues reach `sent`; an issue can pull a chosen article.
- Audio Library organises books/courses → chapters → versions with
  rename, reorder, regenerate one chapter, archive and delete.
- Ambassador tracks programs, applications, evidence, deadlines and
  renewals, pulls Speaking and Certification evidence, and has a Settings
  tab last.
- Labs appear under each provider's Learn section with Agent, Desktop and
  Lab explained.
- Health shows real timestamps and a probe for every integration-backed
  hub; status words are the same everywhere.

## Addendum, 2026-11-28: program names in this record

Owner rule of 2026-11-25, in `.claude/CLAUDE.md` under "Public text about
Ambassador and community programs"
([#1924](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1924)):
public text names no real community program outside the Ambassador Page's
seed catalogue (`functions/src/lib/ambassador/programs.js`). This record was
accepted before that rule. Section 4 listed the programs the catalogue was
first seeded with, and its 2026-10-05 amendment named the first parent and
child pair. On 2026-11-28 the owner asked for that wording to be changed
([#1947](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1947)): section 4 now says the programs were seeded from a catalogue of
seven, and the amendment describes a regional-lead program additional to its
parent. Nothing the record decides changed; the catalogue itself is where the
programs are listed.

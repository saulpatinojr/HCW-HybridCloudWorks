# The Blog Machine

The program that turns the admin portal into a content engine: check posts in
the queue or paste a URL, and a professional, visually rich post in the
owner's voice comes out the other end — announced on Telegram with a staging
link, approved with one reply, live a minute later. The manual editor path
stays exactly as it is; the machine is an addition, not a replacement.

This page is the program of record: the architecture, the seven-phase plan, the
module-grammar contract both packages must match, the decisions already made,
and the backlog. The `T-601…T-607` identifiers on the phases below were the
repository's own tracked-item numbers in the root `TODO.md`; that scheme was
retired on 2026-09-05 when open work moved to GitHub issues, and the issue
number beside each phase in the status line is the live reference.

**Status: engineering complete (2026-08-28).** All seven phases landed —
Phase 0 + plan (#236), Phase 1 (#237), Phase 2 (#238), Phase 3 (#239),
Phase 4 (#240), Phase 5 (#241), Phases 6–7 (#242 and the close-out PR) —
closed to CHANGELOG.md as one program entry. What remains is the
owner-gated activation checklist (below) and the backlog. Per-phase
"As built" notes record where the landed code deliberately differs from
the original spec text.

## The Drafts stage (2026-10-03)

Hand-written articles have a stage of their own before the queue:
**Admin → Drafts** (`/admin/drafts`), the entry above Review Queue in the
admin menu. A draft is an ordinary `content` document at
`contentStatus: 'drafting'`, `Live: false` — the same container and shape as
everything else, so no infrastructure changed — and it is never public:
`isPublicDocument` refuses the status outright, and the manifest, pre-render
and feeds never select it.

- **Write and save** on the page: title, subtitle, date, track, part, tags,
  reading time and the markdown body, with a live preview through the
  article renderer. Saves carry the version's ETag, so two tabs or devices
  cannot overwrite each other; the second is told to reload.
- **Send to In Review** moves the same document to `in_review`, normalised and
  stamped exactly as the old repository import left it, and it continues
  through the review board and the Publish Queue as before.
- **Back to Drafts** returns an article that came from Drafts and is still In
  Review (not approved, not live). **Delete** removes a draft, or one still In
  Review — one document, so both go — and refuses anything live.
- **Paste or upload a markdown draft** (2026-10-25) brings whole `.md` files
  straight in from the owner's private Obsidian vault, several at a time, one
  request each, or one pasted draft: `POST cms/drafts/from-markdown`
  (`{ markdown, origin: 'vault' | 'paste' }`). It reads the file with the same
  parser the import uses, checks it with the same rules as a typed draft, and
  writes a `drafting` document under an id derived from the title, so sending
  the same article twice reports "already present" rather than duplicating it.
  This is the way in. The Drafts page is the source of truth for a
  pre-publish article, and the promote script
  (`scripts/ideas/promote-idea.mjs`) now saves a promoted idea into the
  owner's private vault (`<vault>/Drafts`) to be uploaded here, and refuses to
  write anywhere inside the repository. Code:
  `functions/src/lib/cms/drafts-markdown.js`,
  `frontend/src/pages/admin/drafts/MarkdownDraftPanel.jsx`. How to use it:
  [Idea notes](../runbooks/obsidian-idea-notes.md).
- **Import from docs/content** is the old way in, and it is being retired: a
  pre-publish draft must not be committed to the public repository or shown on
  the public docs site (owner rule 2026-10-25), so do not use it for a new
  article. It brought the `blog-*.md` articles in once, as drafts
  (`blog-template.md` and this file are skipped as contracts), and the button
  and route stay only until the existing files are removed in a later change.

`drafting` is deliberately not the forge's `draft`: `forgeScheduled` picks up
`draft` documents to rewrite, and a hand-written article must never be one.
The state machine's two new edges (`drafting → in_review`,
`in_review → drafting`) are walked only by the Drafts routes;
`transitionContentStatus` refuses both. Code:
`functions/src/lib/cms/drafts.js`, `drafts-handlers.js`,
`frontend/src/pages/admin/DraftsPage.jsx`.

## What already exists — the load-bearing fact

**The forge pipeline is built and works end-to-end**
(`functions/src/lib/content/forge.js`): dedupe against published titles →
owner-voice + rotating-format prompt → draft → module validation and repair →
grade against the owner's profile → land at `forge_ready` (grade ≥ threshold
and clean) or `editing`, with version history, audit rows and stats. Automatic
hero images exist too: on `forge_ready` the pipeline arms
`altCoverImageTrigger`, and the live content change-feed
(`functions/src/functions/change-feed.js`) runs
`lib/triggers/ai-cover.js` — provider-themed covers via Replicate, written to
exactly the field the publish-time image gate reads.

What the program builds is everything *around* that engine, none of which
exists today:

| Missing | Today's reality |
| --- | --- |
| A way in | The only enqueue site anywhere (`/forge` in the Telegram bot) sends the wrong payload key and has always failed; the admin UI has no forge trigger at all (the unported T-409 Forge page) |
| A way to see the result | Nothing unpublished is reachable: the public API deliberately serves an identical 404 for drafts and missing docs |
| A way to hear about it | No notification fires when a post reaches `forge_ready`; the owner would have to poll the queue |
| A way to say yes | The bot has no approve/reject; publishing is a portal-only, multi-click flow |
| A way to sound like the owner | The voice config (`admin_config/forge_profile.wordSoup`, `forge_prompts`) has no admin UI or endpoint — it can only be seeded by hand in Cosmos |
| Enough visual vocabulary | 8 module types exist; no pull quote, stat board, comparison table, timeline, or titled callout |

## Decisions (made 2026-08-28, owner)

1. **Staging link = signed preview URL.** A tokenized `/preview/{id}?t=…`
   that renders the full production template and works when tapped straight
   from Telegram, no sign-in. Expires in 72 h; invalid or expired tokens 404
   indistinguishably from missing content.
2. **Telegram approve = publish live immediately** — through the full publish
   pipeline (`processPublishContent`), never a raw status write, so every
   quality/image/slug gate still applies. Reject sends the post to rejected
   with the reason in the audit trail.
3. **Heroes: the existing AI cover pipeline is primary** (Replicate,
   provider-themed; needs `REPLICATE-API-KEY`); a curated set of **designed
   per-provider default heroes is the deterministic fallback** when
   generation is unconfigured or fails. Zero posts blocked on imagery.
4. **Sources are internal-only.** `sourceUrl` stays on the document for
   admin views and provenance and is never rendered publicly. The prose is
   original analysis in the owner's voice, not a re-skin — the grader and
   banned-phrase guardrails enforce the voice, and the dedupe gate enforces
   distance from what is already published.

## Architecture (as it will run)

```
  entry points                         the engine                    the loop
┌─────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────┐
│ queue checkboxes ───┼──▶│ forge-article job (≤10/batch)│   │ change feed sees          │
│ paste a URL ────────┼──▶│ forge-from-url job           │──▶│ forge_ready rising edge   │
│ RSS → inspect ──────┼──▶│ forgeScheduled timer         │   │  ├─ auto hero (ai-cover)  │
│ (manual editor path │   │   (autoForge + dailyLimit)   │   │  └─ Telegram: title,      │
│  unchanged)         │   │ voice: forge_profile,        │   │     grade, preview link   │
└─────────────────────┘   │ formats, modules, grader     │   │ /approve → publish job    │
                          └──────────────────────────────┘   │ /reject → rejected+note   │
                                                             │ (or approve in portal)    │
                                                             └──────────────────────────┘
```

Every arrow reuses an existing mechanism: the jobs platform
(`lib/jobs.js` + storage queue), the content change-feed with rising-edge
claims, `notifyTelegram` keyed per post id, and the injected
`processPublishContent` exactly as the scheduled-publish timer already uses it.

## Phases

Each phase is sized to one PR. Dependency order: 0 → {1, 2, 3, 4a}
independent → 4b → 5 → 6 → 7.

### Phase 0 — Quick fixes (T-601)

- `functions/src/lib/telegram/bot.js`: `/forge` enqueues `{ contentId }` but
  `resolveForgeTargets` accepts only `sourceContentId`/`sourceContentIds` —
  the repository's only forge entry point has always failed. Fix the key and
  strengthen the bot test to assert the payload shape (the existing test
  checked the job type only, which is how the bug shipped).
- `frontend/src/components/templates/BlogDetailTemplate.jsx`: the modular
  render path drops `markdownCodeComponents`, so fenced code inside
  modularized posts silently loses syntax highlighting. Pass the same
  components map the fallback path already uses.

### Phase 1 — URL → draft (T-602)

Implement `generateArticleDraft` **HTTP-direct** (admin-authed): scrape the
URL (`lib/content/scrape.js` `scrapeArticle`, fallback chain capped ~20 s) →
`createDrafter().generateDraft` — whose output is already exactly the shape
`SubmitUrlsPage.jsx` and the editor expect. Internal budget ~75 s under the
90 s client timeout; contingency if real-world drafting breaks the window:
both call sites flip to a `draft-from-url` job polled via the existing
`runJob()` client. Requires the `.azure/api-surface.json` contract move
(notImplemented → implemented, same change, enforced by
`api-contract.test.js`) and an `AI_FEATURES` entry.

Also in this phase: extract the voice/format prompt block currently composed
twice (`forge.js` and `drafting.js`) into one builder in `voice.js`, and add
an unattended **`forge-from-url`** job — scrape → source content doc
(`sourceUrl` internal-only) → `runForgePipeline` — with a paste box on the
queue header calling `runJob('forge-from-url', { url })`.

### Phase 2 — Queue → forge: "Forge Selected" (T-603)

The queue already has per-card checkboxes and a `selectedIds` Set, wired only
to bulk-reject. Add `forgeSelected(ids)` in
`frontend/src/pages/admin/queue/useQueueActions.js`, chunking ≤10 (the
`FORGE_MAX_BATCH` cap) into `runJob('forge-article', { sourceContentIds })`;
a select-all header checkbox; and forge provenance/grade badges on queue
cards. The smallest phase — everything else already exists.

### Phase 3 — Forge Studio: the voice, editable (T-604; the T-409 remainder)

Two new authenticated RPCs — `getForgeConfig` / `updateForgeConfig`
(whitelist-validated writes to `admin_config/forge_profile` and
`forge_prompts`, audit rows, contract additions) — and a new admin page:
voice profile (wordSoup, interest areas with weights), master prompt,
guardrails (banned phrases, style rules), quality threshold, automation
(autoForge + dailyLimit, live in Phase 6), a read-only format-rotation
viewer, and the forge-stats scoreboard. Plus **voice calibration**: a job
that reads the owner's published posts and produces *suggested* wordSoup
additions and style hints as accept/dismiss chips — never merged
automatically, so the profile stays the owner's own.

### Phase 4a — Richer modules: grammar + public render (T-605)

First commit: unify the duplicate module serializer (`BoardTab.jsx` adopts
`lib/moduleParser.js`) so new types are implemented once. Then five new
types, all built from components and tokens the site already owns:

| type | body | built from | payload | pairing |
| --- | --- | --- | --- | --- |
| `pull_quote` | JSON | Bookerly + provider accent rule | `{"text","attribution"?}` (text required) | pairable |
| `stat_board` | JSON | `shared/StatBlock.jsx` glass tiles | `{"stats":[{"value","label","sublabel"?}]}` (2–4, value+label required) | full width |
| `comparison` | JSON | glass-styled table + theme vars | `{"columns":[…],"rows":[[…]]}` (≥2 columns, ≥1 row, row length = columns) | full width |
| `timeline` | JSON | `.section-number` zero-padded markers | `{"steps":[{"title","body"?}]}` (≥2, title required) | full width |
| `callout` | JSON | `Eyebrow` label + titled glass frame | `{"eyebrow"?,"title","body"}` (title+body required) | pairable |
| `design` (repaired) | raw Mermaid | labelled mono frame (client-side mermaid render = backlog) | — | full width |

Two grammar-wide rules: a JSON module body must parse to a plain object (a
bare `5` or an array is rejected), and `MAX_MODULES` is **14** on both
sides. As-built (PR for T-605): `design` previously existed only in the
backend list — the frontend parser round-tripped it to an empty body,
destroying the diagram; it is now a raw type in both parsers with a
regression test. The forge instruction's spacer style `dotted` was fixed to
the renderer's key `dots`.

Backend: `KNOWN_MODULE_TYPES` / `JSON_MODULE_TYPES` and per-type semantic
validation live in `lib/cms/content-modules.js`; the repair pass in
`lib/content/forge-pipeline.js` unwraps semantically-broken modules into
faithful plain markdown (blockquote / stat list / GFM table / numbered
list / bold-title paragraph) so no prose is lost. Frontend: exported
`RAW_MODULE_TYPES` / `JSON_MODULE_TYPES` / `MAX_MODULES` in
`lib/moduleParser.js`, renderers in `InlineModules.jsx`, pairing rules in
`lib/modulePairing.js` (`FULL_WIDTH_MODULE_TYPES` =
spacer/stat_board/comparison/timeline/design never pair). **This section is
the cross-package grammar contract of record** — backend and frontend
cannot import each other's lists, so each side carries a test asserting its
list matches this table (`content-modules.test.js` /
`moduleParser.test.js`).

### Phase 4b — Teach the forge; make the editor honest (T-605)

Extend `MODULE_TAG_SYNTAX` with syntax + a good/bad example per new type;
update each `FORMAT_LIBRARY` entry's module list (comparison →
comparison + stat_board; case_study → timeline + pull_quote; contrarian →
pull_quote + callout; …). Editor forms for the new types; share
`ARTICLE_PROSE_CLASS` between `BlogDetailTemplate` and `PreviewPanel` so the
in-editor preview stops rendering with the wrong typography.

### Phase 5 — Staging preview + the Telegram loop (T-606)

- **Signed preview route** `GET /api/public/preview/{contentId}?t={token}`:
  token = HMAC-SHA256(`PREVIEW_SIGNING_SECRET`, `contentId.exp`), 72 h
  expiry, serves only `{forge_ready, editing, approved}`, and answers
  invalid/expired/missing identically (404) — preserving the public-reads
  invariant in spirit. The first token-signing code in `functions/src`; the
  route is a deliberate, justified addition to `PUBLIC_ROUTES` in
  `route-inventory.test.js`. Secret seeded via the approved vault procedure.
  Frontend `/preview/:id` reuses `BlogDetailTemplate`, carries `noindex`,
  and stays out of the prerender manifest.
- **Notification**: a `forge_ready` rising-edge branch in the content
  change-feed handler (`lib/triggers/handlers.js`, `claimRisingEdge` per the
  ai-cover precedent) → `notifyTelegram` with `source: 'forge_ready:{id}'`
  (per-post cooldown keying) carrying title, grade, format, the preview
  link, and the command hints.
- **Commands**: `/approve {id}` → enqueue a new `publish-content` job whose
  handler calls the injected `processPublishContent` with `markLive: true` —
  the same reuse contract the scheduled-publish timer documents ("it calls
  `processPublishContent`, it does not reimplement publishing").
  `/reject {id} [reason]` → `transitionContentStatus`
  (forge_ready → rejected is a valid edge), reason to the audit trail. Both
  in `TOGGLEABLE_COMMANDS`.
- **Heroes**: ai-cover runs automatically; add the deterministic fallback —
  when generation is unconfigured or errored, assign a curated per-provider
  default hero (owner uploads ~8 via the image gallery once; mapping in
  `admin_config`).
- **5b (follow-up)**: inline Approve / Reject / Preview buttons — widen
  `allowed_updates` to `['message','callback_query']` in
  `scripts/cutover/04-telegram-webhook.ps1` (ride the T-526 re-registration
  the owner must run anyway), dispatch `callback_query`, answer with
  `answerCallbackQuery`.

**As built (#241).** Three deliberate deltas from the spec text above. The
token verification lives in a new `lib/public-preview.js` rather than
`lib/public-reads.js`, preserving that module's zero-imports invariant
(node:crypto is needed). The notification's failure semantics invert
ai-cover's: an unsent notification writes NOTHING to the document — a
failure marker would re-fire the change feed and loop — so the flag stays
armed and the fresh claim quiets retries for its 15-minute window; the flag
clears only after a confirmed send, and an unseeded secret still notifies,
saying the link is unavailable. `/reject` runs
`createContentStatusTransitioner`, the state-machine core extracted from the
HTTP handler so the guarded route and the bot share one writer (audit rows
carry `authMethod: telegram_webhook`). Found and fixed in passing: the
bot's `/ack`/`/resolve` passed the alertId as `patchDoc`'s updates argument
and had never persisted anything (T-512-era).

### Phase 6 — Throughput: the machine runs itself (T-607)

Arm `forgeScheduled`, `syncRssFeeds` and `publishScheduledContent`
(**Gate: owner** — T-518's workspace variables and four-gate procedure);
enforce `autoForge.dailyLimit` with a counter in `forge_stats`; rank forge
candidates by interest-area weights from the profile; add an optional
per-job-type `onComplete` hook in `lib/jobs.js` used for **failure**
notifications only — successes already ride the Phase 5 rising edge, and
double-pinging the owner defeats the point.

**As built (#242).** The counter is a rolling `forge_stats.today` bucket
(`{ date, forged }`, reset on UTC date change) bumped by every forge run —
scheduled, `/forge`, and forge-from-url — so the daily limit is one ledger,
not a per-caller count; `forgeScheduled` spends only the day's remaining
budget and skips at the limit. Ranking: an interest area scores when any of
its keywords hits the candidate's title/topics/provider; ties keep query
order (`scoreCandidate`/`rankCandidates` in `lib/timers/forge-scheduled.js`).
The `onComplete` hook fires after the terminal status write for all three
outcomes and is best-effort; `createJobFailureOnComplete`
(`lib/job-failure-notify.js`, cooldown per `job_failed:{type}`) is wired to
forge-article, forge-from-url and publish-content. The timer also adopted
the process-wide `defaultForgeConfig` (the #239 singleton lesson).

### Phase 7 — Polish and program close (T-607)

Grade sorting and a forged-today `n/dailyLimit` indicator on the queue; a
`/queue`-style bot view of pending `forge_ready` items; this page updated to
as-built; tracker entries closed to CHANGELOG.

**As built (close-out PR).** "Forge grade" joined the queue's sort dropdown
(ungraded items sort last in descending); the header shows a
`Forged today: n/limit` meter read from the same `forge_stats.today` bucket
the scheduler enforces (via `getForgeConfig`, which now returns it); the
bot's `/queue` appends a "Staged for approval" list — newest five
forge_ready items with grade and an inline `/approve {id}` per row.

## Owner-gated dependencies

| What | Why it gates | Tracker |
| --- | --- | --- |
| ~~Telegram webhook re-registration~~ | ~~The entire Phase 5 loop is dead while the webhook points at GCP~~ — **closed 2026-08-28**: `getWebhookInfo` returns the Azure URL and `/help` answers in the chat. **The Phase 5 approve-by-reply loop is live**, and the inline approve/reject buttons in §5b are unblocked | ~~T-526~~ |
| ~~Timer arming (workspace variables + four gates)~~ | ~~Phase 6's scheduled forge/publish/RSS are permanent no-ops until armed~~ — **closed 2026-09-05**: all 18 timers armed | ~~T-518~~ |
| `PREVIEW_SIGNING_SECRET` seeding | Signed preview links | vault procedure |
| `REPLICATE-API-KEY` seeding | Auto hero generation (fallback heroes cover its absence) | vault procedure |
| ~8 default hero uploads + mapping | The deterministic hero fallback | Phase 5 |

## Backlog — unique and cool, deliberately unscheduled

1. **Social captions auto-queued to Publer on publish** — **LANDED**
   (post-program). `generateSocialCaption` is implemented (the Social Hub
   Generate button works; feature-gated as `socialCaption` in the AI
   switches), and a live publish arms `socialCaptionTrigger` once per
   document → the change feed generates a caption and bulk-schedules it in
   Publer with a delay (default 60 min — the undo window), recording a
   `social_posts` doc the existing reconcile timer adopts by `publerJobId`.
   Publer unconfigured → the caption is kept as a Social Hub draft. Switched
   by the owner-seeded `admin_config/social_autopost`
   `{ enabled, accountIds: [{ id, provider }], scheduleDelayMinutes }` —
   absent or disabled means no model call and no post.
2. **The manual image RPC cluster** — **LANDED** (post-program). All four
   (`generatePreviewImages`, `generateCuratedArticleImage`,
   `generateReviewHeroImage`, `triggerAiImageGeneration`) were live 404s
   the admin UI called; they now exist in `lib/manual-images.js`, sharing
   ai-cover's extracted generation core (`generateCoversForContent`)
   rather than duplicating it. `triggerAiImageGeneration` stays
   fire-and-forget by arming the change-feed flag; the other three are
   synchronous and 503 cleanly while `REPLICATE-API-KEY` is unseeded.
3. **Weekly digest send** — **LANDED** (post-program), with a correction:
   `generateReviewerDigestManual`'s actual frontend contract (the Ops
   Health "Run Now" tile) is the REVIEWER queue snapshot, the manual twin
   of the 07:00 `generateReviewerDigest` timer — not the newsletter
   `generate-weekly-digest` job this line originally guessed. It now runs
   that same snapshot on demand (`generatedBy: 'manual'` into the same
   `workflow_digests/{date}` doc). The newsletter job remains reachable
   through `enqueueJob` as before.
4. **Analytics-informed topic weighting** — engagement data feeding
   interest-area weight *suggestions* (accept/dismiss, like voice
   calibration). **BLOCKED on an owner decision**: no engagement data
   source exists anywhere in the system (no analytics provider is wired;
   the only external read scopes are the Linkie proxy's). Pick a provider
   (Azure SWA analytics? Plausible? GA4?) and this becomes buildable.
5. **Series detection + interlinking** — **LANDED** (post-program). The
   forge pipeline's dedupe corpus fetch was widened to carry `id`,
   `keyTopics` and the public-URL fields, and after post-processing (before
   grading, so the grader sees the real article) the forge scores each
   published post against the draft — Jaccard over title + keyTopics
   tokens, reusing the dedupe gate's own tokenizer (`lib/content/related-posts.js`).
   The top 3 above a 0.15 floor are appended as a `links` module
   ("related reading", deletable in the editor like any module; skipped when
   the draft is already at the module cap) and stamped as
   `relatedContentIds` series metadata on the content doc. Only posts with
   a resolvable public URL are ever proposed — a link the reader cannot
   follow is worse than none — and there is no score ceiling: true
   duplicates never reach this code because the dedupe gate already
   refused to forge them.
6. **SEO lint in the grader** — **LANDED** (post-program). A deterministic
   lint (`lib/content/seo-lint.js`, no model call) runs inside
   `buildForgeArtifacts` and stamps `forgeGrade.seo.findings`: summary
   length vs the 70–160 meta-description window, slug/key-topic alignment
   (against the real `slugify` the publisher uses), and heading hierarchy
   (H1 in body, too-deep first heading, skipped levels — code fences and
   module tags stripped first). Strictly advisory: findings never move the
   overall, the staging decision, or any publish gate. Surfaced where the
   approve decision happens — as a bullet list in the preview banner and a
   one-line count in the forge_ready Telegram note.
7. **Voice-drift monitor** — periodic re-grade of recent posts against the profile; Telegram alert on drift.
8. **Stale-post refresh bot** — old posts feeding a news_analysis/update-format forge run on the owner's own content.
9. **A/B titles** — drafter emits three candidates; owner picks via Telegram buttons (5b infrastructure).
10. **Voice memo → draft** (`createContentFromRecording` — the Plaud path).
11. **Cross-provider duplicate-angle advisor** — extend the title dedupe across providers as an advisory signal.

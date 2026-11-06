# ADR 0040: Interviews are made from the admin: audio in a private container, Gemini transcription through the AI provider selection, an `interview` content type reviewed and published in the CMS, and public pages read live from the API

**Status:** Proposed 2026-11-05 (the four owner decisions of 2026-11-05 are fixed; the design decisions below are the session's and are for the owner to confirm or reverse on the issue)
**Decision date:** 2026-11-05
**Owners:** Workload owner and architecture owner

Related: issue [#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565)
(this design), its parent
[#1344](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1344) (the
first real interview); the slice plan
[`docs/architecture/interviews-slices.md`](../architecture/interviews-slices.md);
[ADR 0034](0034-ai-model-selection.md) (every modality is a task, and a task
picks its provider); [ADR 0031](0031-security-scanner-owner-decisions.md)
(the storage account stays closed to the internet); [ADR 0037](0037-agent-content-api.md)
(publishing stays a human act; reuse the content routes rather than copy
them); the runbook
[`docs/runbooks/add-an-interview.md`](../runbooks/add-an-interview.md) (the
hand-written path this replaces).

## Context

An interview is a page of questions and answers with a guest at
`/azure/interviews/<slug>`, with a list at `/azure/interviews`. Today the only
way to make one is to write a JSON file by hand in
`frontend/src/data/interviews/`, open a pull request and deploy the frontend.
The page component, the validation of the interview's shape
([`frontend/src/lib/interviews.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/lib/interviews.js))
and the Book view all exist and work; what is missing is a way to make the
content without a deploy.

What the repository already has, and this design builds on (read on `main`
at `7950a484`, 2026-11-05):

- **Uploads go through the Function App as base64 JSON**, capped at 15 MB for
  images and 40 MiB for podcast recordings, with no SAS (a signed link that
  lets a browser talk to storage directly) anywhere in use:
  `generateSasUrl` in
  [`functions/src/lib/blob-storage.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/blob-storage.js)
  is read-only and has no callers. The storage account refuses every request
  that does not come from the Function App's subnet
  ([`infra/storage.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/storage.tf),
  the `network_rules` block with `default_action = "Deny"`), its CORS rule
  allows GET, HEAD and OPTIONS only, and the site's Content Security Policy
  (`connect-src` in
  [`frontend/staticwebapp.config.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/staticwebapp.config.json))
  does not name the storage host. All four of those would have to change for a
  browser to write to storage directly.
- **A request to the Function App cannot carry more than about 210 MB.**
  Microsoft's
  [app settings reference](https://learn.microsoft.com/azure/azure-functions/functions-app-settings#functions%5C_request%5C_body%5C_size%5C_limit)
  says `FUNCTIONS_REQUEST_BODY_SIZE_LIMIT` defaults to its maximum of
  220,200,960 bytes and cannot be raised, and the
  [service limits table](https://learn.microsoft.com/azure/azure-functions/functions-scale#service-limits)
  puts the maximum request size at 210 MB on every plan. The repository's own
  note in
  [`functions/src/lib/admin-uploads.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/admin-uploads.js)
  says base64 JSON costs about 2.5 times the file size in memory on a
  2048 MB instance. Cloudflare sits in front of the API with its own
  per-request body limit [VERIFY on the plan's limits page before slice A].
- **The AI layer already lists transcription as a planned task.**
  `recordingTranscript` in
  [`functions/src/lib/ai/tasks.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/ai/tasks.js)
  has modality `stt` (speech to text), `planned: true`, no recommended model
  and no call site; no provider is marked as carrying `stt`
  ([`provider-order.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/ai/provider-order.js)),
  and the model enrichment gives `gemini-*` models text, json, vision and
  grounding only. A media task's call site asks `modelForTask({ task })` for
  the provider and model and then calls its own adapter; the text router
  (`generateJsonResponse`) must not be used for a media task
  (`ai-call-sites.test.js`). The router's per-attempt timeout is 60 s, which
  is far too short for an hour of audio. Nothing sends audio to a model today;
  the only transcription path is Plaud
  ([`functions/src/lib/podcast/recording-upload.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/podcast/recording-upload.js)),
  which the owner ruled out for interviews.
- **Gemini takes audio of up to 9.5 hours in one prompt, through its Files
  API for anything over 20 MB.** The Gemini audio page says "Max length: 9.5
  hours of audio per prompt", "32 tokens per second of audio", "Maximum
  request size is 20 MB total" for inline data, "Use the Files API for files
  larger than 20 MB", and that a prompt can ask for "a transcript from 02:30
  to 03:29" (read 2026-11-05 at
  [aistudio.google.com/docs/audio](https://aistudio.google.com/docs/audio)).
  The Files page says files are up to 2 GB each, 20 GB per project, "stored
  for 48 hours", deletable, and uploaded with a two-step resumable protocol
  (read 2026-11-05 at
  [aistudio.google.com/docs/files](https://aistudio.google.com/docs/files)).
  The repository calls Gemini over REST with `fetch` and the `GEMINI-API-KEY`
  Key Vault secret; there is no SDK and no Files API client.
- **Content lives in one Cosmos container, `content`, with one status
  machine** ([`content-status.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/cms/content-status.js)):
  publishing flips `contentStatus` to `published` and `Live` to `true` on the
  same document under an ETag; unpublishing sets `inspected`. The type is
  declared in a contract ([`publish-contracts.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/cms/publish-contracts.js))
  that fixes the public section, the body fields and the quality rubric; an
  unknown type silently becomes `blog`. The Drafts stage
  (`cms/drafts`, status `drafting`) is blog-only by design and refuses any
  field outside its allow-list. The generic update route accepts any JSON
  field under size caps but checks no shape.
- **Public pages read published content live** through
  [`public-reads.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/public-reads.js)
  with a field allow-list pinned by a test, `Cache-Control: public,
  max-age=300`, and a 404 that does not distinguish "missing" from "not
  public". Search engines get pre-rendered pages from a manifest that a daily
  workflow fetches from the API and commits
  ([`scripts/build-content-manifest.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/build-content-manifest.mjs)),
  so the sitemap and the pre-rendered seed follow a published post by up to a
  day and a frontend deploy, while the page itself is live at once.
- **Background work is a Cosmos `jobs` document plus a storage queue
  message** ([`functions/src/lib/jobs.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/jobs.js)):
  one attempt, a timeout per type (default 10 minutes), a sweeper that
  re-queues stuck jobs at most three times, and a guard that refuses writes
  after the job's deadline. Log lines carry ids and counts, never content
  (`error-response.js`, `no-raw-error-leaks.test.js`).
- **Outbound fetches of a URL the caller chose go through one guard**
  ([`functions/src/lib/http/guarded-fetch.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/http/guarded-fetch.js)):
  https or http only, the name resolved and refused if private or
  link-local, the connection pinned to the address that passed, redirects
  followed by hand and re-checked, one deadline, one byte cap. It returns a
  buffer, not a stream, with an 8 MiB default cap.

## Purpose and decision drivers

- **Nothing publishes by itself, and the recording never leaves the owner's
  control (the owner's rule; security, privacy).** A transcript is the
  guest's words; the recording is their voice. Both are personal data.
- **No new Azure resource and no new secret (owner decision; cost,
  operations).** Gemini is already keyed; the storage account and the
  Function App already exist.
- **Keep the storage account closed (ADR 0031; security).** Opening it to
  the internet for one upload form reverses a decision the owner made for
  the whole estate.
- **Reuse the content pipeline, do not copy it (ADR 0037; reliability).** The
  status machine, the ETag writes, the publisher role gate, the version
  snapshot and the audit rows already exist and are tested.
- **Bounded cost and time (operations).** An hour of audio is about 115,000
  input tokens; a job must not run unbounded and a month must not surprise
  the owner.
- **The junior administrator can run it.** One form, one list page, the same
  review and publish buttons as a blog post.

## Decision

### The four owner decisions, as given on 2026-11-05

1. **Transcription is Gemini audio understanding through the site's existing
   AI provider selection.** No new Azure resource, no new secret.
2. **Publishing is a new `interview` content type in the admin CMS**; the
   public interview pages read from the API like blog posts, with no pull
   request and no deploy per interview.
3. **The recording is kept private in a blob container under the site's
   identity**, for re-transcription and provenance, with a retention the
   owner sets; it is never published and there is no player.
4. **The form's inputs, first version:** an audio file upload; an audio URL
   fetched server-side; a pasted transcript or Plaud export (which skips
   transcription); a required "the guest agreed to publish" checkbox with the
   date; and an optional guest photo.

### Design decisions

**D1. A large audio file reaches the private container in blocks through
the Function App, not by a direct browser write.** The browser cuts the file
into 4 MiB pieces and sends each as a raw `application/octet-stream` body to
`PUT /api/cms/interviews/uploads/{uploadId}/blocks/{index}`; the Function
App stages each piece as an uncommitted block on the blob (`Put Block`), and
`POST .../complete` commits the block list in order (`Put Block List`). The
upload session is opened by `POST /api/cms/interviews/uploads` with the file
name, type, size, SHA-256 and the duration the browser read from the file's
metadata; each session stages its blocks under its own blob path,
`audio/<interviewId>/<uploadId>.<ext>`, so two uploads for the same
interview can never share block ids or interleave, the hash is checked on
that blob, and only then does the document's recording pointer move to it;
the recording it replaces is listed under `provenance.audio.superseded` for
the delete helper (D10) and expires under the lifecycle rule in any case.
The cap is **500 MiB**, three audio types
(`audio/mpeg` `.mp3`, `audio/mp4` `.m4a`, `audio/wav` `.wav`, the same list
and alias spellings as the podcast upload), and the extension must match the
type. A block is idempotent (re-sending index 7 overwrites block 7), so the
browser retries a failed block alone, three blocks in flight at a time; the
whole file is never in the Function App's memory and no request exceeds
4 MiB. A declared duration over **9.5 hours (34,200 seconds)**, Gemini's
limit per prompt, is refused at the session open with `TOO_LONG` (422),
because every transcription request attaches the whole file (D3). Storage
removes uncommitted blocks that are never committed after a
week ([Put Block](https://learn.microsoft.com/rest/api/storageservices/put-block#remarks)).
The blob is written under the Function App's managed identity, as every blob
is today.

   *Why not a user-delegation SAS and a direct browser PUT, which the issue
   sketched?* It would need four reversals at once: open the storage firewall
   to the internet (ADR 0031), add PUT and the `x-ms-*` headers to the
   account's CORS rule, add the storage host to the site's `connect-src`, and
   write the first write-capable SAS in the codebase. The block route keeps
   every one of those as it is, costs about 125 small requests for a 500 MiB
   file, and reuses the identity, the guard and the audit row the other
   uploads use. The repository's precedent (no SAS in use, firewall closed)
   makes the proxied path the right call. The SAS path stays recorded under
   Alternatives if the owner ever opens the account for another reason.

**D2. An audio URL is fetched by a job, through the existing fetch guard,
streamed straight into the container.** `POST /api/cms/interviews/{id}/audio-from-url`
checks the URL's shape and enqueues `interview-fetch-audio`; the job calls a
new streaming variant of `guardedFetch` (`guardedFetchStream`, same
validation, same manual redirects, same pinning, a byte counter on the
stream instead of a buffer) and pipes the body into `uploadBlobFromStream`.
Rules: https only (`httpsOnly: true`); at most 5 redirects, each hop
re-validated against private, loopback, link-local and Azure platform
addresses; a 10-minute deadline over the whole exchange; a 500 MiB cap
counted on the stream; the response `Content-Type` must be one of the three
audio types, or `application/octet-stream` with an allowed extension on the
URL path; a `Content-Length` over the cap is refused before any byte is
read. There is no host allow-list by default: a Plaud share, a Dropbox link
and a OneDrive link are all public hosts, and the guard already refuses
anything private. An app setting `INTERVIEW_AUDIO_URL_HOSTS` (comma-separated
host suffixes, empty by default) lets the owner narrow it without a deploy.
The URL itself is stored in the provenance block; it is never logged.

**D3. Transcription is a queued job with its own Gemini adapter, chunked by
time windows, resumable, capped in cost.**

   - *Task.* `recordingTranscript` in `tasks.js` stops being `planned`; its
     recommended model is the Gemini Flash model the catalogue marks live
     and `model-tables.js` prices (slice B reads the catalogue and the
     pricing page on the day and records the date in the `reason`, as every
     task does). `stt` joins Gemini's capabilities in `provider-order.js`
     and the `gemini-*` enrichment row, and `only: ['gemini']` so no other
     provider can ever be handed the audio. The call site is
     `modelForTask({ task: 'recordingTranscript' })`, the media-task door;
     a feature switch on the AI Engine turns it off like any other task.
   - *Function.* A job type `interview-transcribe` registered in a new
     `functions/src/functions/interviews-jobs.js` (role `editor`, payload
     `{ interviewId, transcriptVersion }`, `timeoutMs` 25 minutes; the
     Flex Consumption default function timeout is 30 minutes per the
     [service limits](https://learn.microsoft.com/azure/azure-functions/functions-scale#service-limits)).
     Not a timer (nothing to poll) and not Durable Functions (the repository
     has none; the jobs framework already gives claim-by-ETag, sweeper and
     poison handling).
   - *Getting the audio to Gemini.* The job streams the blob from the
     container into Gemini's resumable upload (`POST /upload/v1beta/files`
     with `X-Goog-Upload-Protocol: resumable`, then the bytes to the
     returned upload URL), keeps the returned `file.uri` for the job's
     lifetime, and deletes the file from Gemini when the job ends, success
     or failure; Gemini would delete it after 48 hours anyway. The read
     from the container is a stream (`downloadBlobStream`, a new helper in
     `blob-storage.js`; the existing `downloadBlob` buffers the whole blob,
     which for 500 MiB would be about a gigabyte of memory on the way to
     Gemini). The audio bytes never touch Cosmos or a log.
   - *Chunking.* One `generateContent` call per **60-minute window**:
     "Transcribe from MM:SS to MM:SS with speaker labels; return JSON
     `{ segments: [{ start, end, speaker, text }], endOfAudio }`", with
     `responseMimeType: application/json`. Before the job is enqueued the
     route refuses a recording whose declared duration exceeds 34,200
     seconds (9.5 hours, Gemini's limit per prompt) with `TOO_LONG`; the
     duration is the one the browser declared at upload, or, for a URL
     fetch, none, in which case the job itself stops with `TOO_LONG` when
     the tenth window ends without `endOfAudio`. The loop stops when
     `endOfAudio` is true or after 10 windows, never more.
     Every call carries the same `fileUri`, and Gemini charges the whole
     file's audio tokens on every call (32 tokens per second of audio,
     whatever range the prompt asks for), so the windows are as few and as
     long as the output allows: an hour of speech is about 15,000 output
     tokens, well inside the model's output cap, and a one-hour recording
     costs one call rather than three. A time-sliced upload would need the
     audio cut on our side, which Flex Consumption cannot do without
     ffmpeg; the multiplied estimate below is the price of not cutting it.
     Each window's result is written to
     `interviews-audio/<id>/transcript-v<n>.parts/<k>.json` as it arrives, so
     a job that is re-queued by the sweeper or re-run by the owner skips the
     windows already on disk; the finished transcript is assembled into
     `interviews-audio/<id>/transcript-v<n>.json` (segments plus a plain
     `"Speaker 1: ..."` text) and the parts are deleted. The whole window
     prompt is fixed text; no user text enters it.
   - *Retries.* Each window call is retried up to 3 times on 408, 429 and
     5xx with a 2 s then 4 s wait (the router's own policy, reused); 400,
     401 and 403 are not retried and fail the job with a code. The job
     itself is never retried by the framework; the owner's "Transcribe
     again" button enqueues a new job with the next `transcriptVersion`.
   - *Idempotency.* The document carries `transcription: { version, jobId,
     status }`; a second enqueue for the same version while a job is
     `queued` or `running` is refused with 409.
   - *Cost ceiling.* Before the first window the job compares the month's
     spend on `ai:recordingTranscript` (the `ai_usage` ledger, the same
     read the image budget makes in `triggers/ai-cover.js`) with
     `INTERVIEW_TRANSCRIPTION_MONTHLY_USD` (default 10) and stops with
     `BUDGET_EXCEEDED` if the estimate for this file would cross it. The
     estimate is **32 tokens per second of audio, times the number of
     windows (duration divided by 60 minutes, rounded up), times a retry
     allowance of 1.5**, at the model's audio input rate, plus the output
     tokens; the duration comes from the file's bytes at a conservative
     64 kbit/s until the first window's `end` timestamp gives the real
     figure (the first window always runs; the check repeats before the
     second). `model-tables.js` gains an audio-input rate for the chosen
     model, read from Gemini's pricing page with the date [VERIFY in slice
     B]. A usage row per window records the full file's audio tokens, so
     the Cost page shows what Gemini charged, not what the window covered.
     The monthly ceiling is the hard stop; the estimate only decides
     whether to start.
   - *What is logged.* The interview id, the transcript version, the window
     index, token counts, bytes and the elapsed time. Never a segment, a
     name, the URL or the file name. The test asserts it, as
     `recording-upload.test.js` does for the podcast path.
   - *Pasted transcript or Plaud export.* The form writes it straight to
     `transcript-v1.json` through `POST /api/cms/interviews/{id}/transcript`
     (text up to 400,000 characters, the cap `draft-from-recording.js`
     already uses; a Plaud export's `Speaker N:` lines are kept as
     speakers), sets `transcription.status = 'provided'`, and goes directly
     to drafting. No audio, no Gemini call.

**D4. The transcript becomes a Q&A draft through the text router with a
fenced prompt, validated against the interview shape, with an honesty
guard.**

   - *Task.* A new task `interviewDrafting` (modality `json`, needs `text`
     and `json`, `public: false`, no `only`: the transcript is text, and the
     owner's global provider order applies). Call site:
     `generateJsonResponse({ feature: 'interviewDrafting', ... })`, as
     `forgeDrafting` does, run by a job `interview-draft` (role `editor`,
     `timeoutMs` 25 minutes, the transcription job's ceiling) that
     `interview-transcribe` enqueues on success and the owner can re-run.
     The job is **checkpointed by pass**: each pass's validated items are
     saved on the document (`provenance.drafting.passes[k]`, with the
     transcript version they came from) as soon as the pass returns, each
     pass runs under its own 3-minute deadline, and a re-run or a sweeper
     re-queue for the same transcript version starts at the first pass
     with no saved output. So a long transcript never needs to fit in one
     timeout, and a job that does time out keeps the passes it finished;
     the combined list is validated once all passes are saved.
   - *Prompt shape.* System: the site's interview voice, "use only words
     and facts that appear between the markers; if the guest did not say
     it, leave it out; never add a fact, a number, a name or a title". The
     transcript goes between the `<<<BEGIN ARTICLE>>>` / `<<<END ARTICLE>>>`
     markers of `prompt-fence.js`, neutralised with `fenceArticleText`, in
     **passes of at most 120 kB** (the cap `recording-script.js` uses),
     split on speaker-turn boundaries, as many passes as the transcript
     needs (a 400,000-character pasted transcript is at most about 1.2 MB of
     UTF-8, so up to ten passes); a single turn longer than one pass is
     split at a UTF-8 character boundary (never inside a multi-byte
     character), preferring the last sentence end before the limit, and
     each piece keeps the turn's `Speaker N:` label, so no words are
     dropped and every piece is still attributed; each pass is
     given the questions already drafted as data so it does not repeat
     them, each pass is one router call recorded under
     `ai:interviewDrafting` and checked against the same monthly ceiling
     as transcription before it runs, and the combined list is validated
     once at the end (over 40 items: the first 40 kept, the rest dropped
     with a `truncated` flag for the editor). The guest's name and role
     from the form are given as data; the prompt asks for the JSON shape
     `{ speakers: { interviewer, guest }, qa: [{ q, a, pullQuote? }] }`,
     one question per topic turn, 1 to 40 items, each `q` up to 240
     characters, each `a` up to 6000, each `pullQuote` a verbatim sentence
     of the guest.
   - *Speaker to guest mapping.* The model names which transcript speaker
     is the guest; the server checks it against a simple count (the speaker
     with more question marks is the interviewer) and keeps the model's
     answer unless the two disagree, in which case `speakers.unsure = true`
     and the editor shows a prompt to pick.
   - *Validation.* `functions/src/lib/interviews/schema.js` carries the
     same limits as `frontend/src/lib/interviews.js` (`normalizeInterview`:
     title 160, subtitle 240, bio 6000, tags lower-case hyphenated, qa 1 to
     40, q 240, a 6000, pullQuote 240, related 12 links each). A test reads
     the frontend file and fails when the two drift, the pattern
     `public-reads.allowlist.test.js` uses. The output is parsed with the
     router's `parseJsonWithFallbacks`; an output that fails the shape is
     sent back once for repair (the router's existing round trip) and then
     fails the job with `INVALID_DRAFT`.
   - *Honesty guard.* `draft-guard.js`: every `pullQuote` must appear
     verbatim in the transcript (whitespace and case normalised) or it is
     dropped; every answer must draw at least 80% of its distinct words of
     five letters or more from the guest's own turns, or the item is kept
     and flagged `needsReview: true` for the editor to see. Nothing invented
     survives silently; nothing the guest said is thrown away.
   - *What is stored.* The validated `qa` list on the content document,
     `provenance.drafting = { model, provider, draftedAt, transcriptVersion
     }`, and `interview.stage = 'ready'`.

**D5. The `interview` content type is a `content` document with a contract,
reviewed and published through the existing routes, edited on its own admin
page.**

   - *Document* (in `content`, partition `/id`, like every item):
     `type: 'interview'`, `publishTarget: 'interview'`, `cloudProvider:
     'Azure'`, `contentStatus` (the shared machine), `slug`, `Title/title`,
     `subtitle`, `date`, `guest: { name, role }`, `bio`, `image: { src, alt
     }`, `tags`, `qa`, `related`, plus three blocks the public never sees:
     `consent` (D9), `provenance` (`source: 'upload' | 'url' |
     'transcript'`, `audio: { container, path, bytes, sha256, contentType,
     uploadedAt, sourceUrl? }`, `transcription: { version, model, provider,
     transcribedAt, windows }`, `drafting` as in D4) and `interview: {
     stage: 'uploading' | 'fetching' | 'transcribing' | 'drafting' | 'ready'
     | 'failed', error? }`. The transcript stays in the container (D3), not
     on the document: a transcript can run to hundreds of kilobytes, the
     `content` container's index policy is generated and excludes only the
     blog body paths, and a Cosmos document is capped at 2 MB. The document
     holds the pointer and version.
   - *Status.* Created at `contentStatus: 'draft'` (not `drafting`, which
     the Drafts routes own, and not `in_review` until the Q&A exists). The
     daily forge timer's candidate query
     ([`timers/forge-scheduled.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/timers/forge-scheduled.js))
     excludes `type = 'interview'`, with a test, so an interview is never
     rewritten by the blog pipeline. The owner moves it `draft → in_review →
     approved` with `transitionContentStatus` and publishes with
     `publishContent` (publisher role, ETag, version snapshot, audit row),
     unpublishes with `unpublishContentToInspected`. The contract gives
     `section: 'interviews'`, so `curatedSubpagePath` becomes
     `/azure/interviews/<slug>`, which is the route the frontend already
     declares. Publishing refuses without a confirmed consent (D9) and a
     `qa` list that passes the schema; the quality gate uses a small rubric
     over a `bodyText` field the server derives from `qa` (the contract
     body reader only reads strings), and the image rubric is `NO_IMAGERY`,
     so no AI cover is armed. Dedup reuses the title-within-seven-days stage
     unchanged.
   - *Editing.* The generic markdown editor cannot edit a `qa` list, so the
     admin gets `/admin/interviews` (list, with stage and status) and
     `/admin/interviews/{id}` (the form of D7 plus a Q&A editor: reorder,
     edit, drop an item, clear a `needsReview` flag, pick the guest
     speaker, read the transcript, "Transcribe again", "Draft again"),
     under the Pipeline group in `adminNav.js` with `minRole: 'editor'`.
     Saves go through a new type-aware validator hooked into
     `content-update-validation.js` for `type === 'interview'` (the same
     `schema.js`), on the existing `updateContentItem` route with its ETag.
     *One-sentence deviation from "in the admin Drafts CMS":* the Drafts
     page's routes are blog-only on purpose (ADR 0037 reuses them for Koda),
     so the interview gets its own page in the same Pipeline group, on the
     same status machine and the same review and publish routes; the owner's
     decision (a CMS content type, reviewed then published, nothing
     automatic) is kept.
   - *Type registrations* (each pinned by an existing test): `interview` in
     `SUPPORTED_PUBLISH_TARGETS`, `CONTRACTS`, `KNOWN_TYPES`, `TYPE_TO_KIND`
     (`kind: 'interview'` added to `DEFAULT_KINDS`), `IDEA_TYPES` in
     `scripts/ideas/idea-notes.mjs`, `getPublicSectionForPublishTarget`,
     the admin snapshot type lists, and on the frontend `contentModel.js`,
     `useEditorState.js` and `editorItems.js`. The blog list hook
     (`useBlogData.js`), the public section counts and the manifest builder
     each exclude `interview` from the blog surfaces, with a test for each.
   - *Koda* (ADR 0038) gets no interview route: consent is a human act, and
     the recording is personal data.

**D6. The public API is two anonymous routes in `public-reads.js`, read live
by the pages; the static sample and `available.js` are retired; search
engines follow the manifest as they do for blog posts.**

   - `GET /api/public/interviews`: published interviews, newest first,
     `PUBLIC_INTERVIEW_LIST_FIELDS` = `slug, title, subtitle, date, guest,
     tags, publishedAt`. `GET /api/public/interviews/{slug}`:
     `PUBLIC_INTERVIEW_DETAIL_FIELDS` = the list fields plus `bio, image, qa,
     related, updatedAt`. Never `consent`, `provenance`, `interview`,
     `transcription`, the audio path or any `*Draft` field; the allow-list
     test pins both lists against the frontend's `normalizeInterview`. Same
     visibility clause as content (`Live === true` or published status, not
     soft-deleted, not `drafting`), the same 404 for missing and not
     public, `Cache-Control: public, max-age=300` like content (an
     unpublish is visible within five minutes; the admin preview route,
     which is `no-store`, is for the owner's own check). Listed in
     `PUBLIC_ROUTES` of `route-inventory.test.js` with its reason, in
     `.azure/api-surface.json`, and in `function-inventory.json`.
   - *Frontend.* `InterviewsPage.jsx` stops importing `@/data/interviews`
     and reads `usePublicData(fetchPublicInterviews, 'interviews:list')` and
     `usePublicData(() => fetchPublicInterview(slug), 'interview:<slug>')`
     from `publicApi.js`, through the same `normalizeInterview` (now applied
     to API data, so a bad document shows the not-found page rather than a
     broken one); the landing card reads the same list key. Loading shows
     the skeleton; an unknown slug renders `NotFoundPage` (keeping the
     `data-page="not-found"` marker the pre-render skips on).
     `frontend/src/data/interviews/` (`example-interview.json`, `index.js`,
     `available.js`, its test) is deleted; `lib/interviews.js` stays as the
     one validator; the `interviews.routes.test.js` and
     `prerender-entry.jsx` switch from the static list to the manifest.
   - *Pre-render and sitemap.* `public-content-manifest.js` adds published
     interviews as routes `/azure/interviews/<slug>` with seeds
     `interview:<slug>` and `interviews:list`, and a `sections.interviews`
     count; `build-content-manifest.mjs` writes them. The daily manifest
     workflow and the manual frontend deploy are unchanged, so the sitemap,
     the pre-rendered HTML and the landing card follow a newly published
     interview the way they follow a blog post: live page at once, search
     and landing card after the next manifest run and deploy. There is no
     build-time fetch from the live API, for the reason the manifest exists
     (CI cannot reach the origin). `validate:routes` is unaffected: the
     pages keep using `routeFactory`. The header keeps its nine slots
     (#1337); the Azure landing card is the entry.

**D7. The admin form** at `/admin/interviews/new` takes: guest name
(required), role, bio, photo (optional), title, subtitle, date (default
today), tags, the consent checkbox with its date (D9), and exactly one of:
an audio file (D1), an audio URL (D2) or a transcript text (D3's last
bullet). It creates the document first (`POST /api/cms/interviews`, editor,
returns id and ETag), then runs the chosen input, then shows the stage
(`uploading 37%`, `transcribing window 3`, `drafting`, `ready`) by polling
`GET /api/cms/interviews/{id}` every 5 seconds while a stage is in flight.
The form never writes a transcript or a Q&A itself. The browser upload
helper is a new `frontend/src/lib/interviewUpload.js` (file slicing, three
blocks in flight, per-block retry, and a SHA-256 of the whole file computed
incrementally over the same 4 MiB slices, never by reading the file into
memory at once; a hash that cannot be computed fails the upload rather than
sending an empty hash); `api.js` gains a `putBytes` call that sends a raw
body with the bearer token and no JSON content type.

**D8. The guest photo reuses the image upload path.** The form calls the
existing `POST /api/cms/uploads/covers` (15 MB, image types, PNG/JPEG/WebP,
SVG refused) at path `interviews/<id>/guest.<ext>` and stores the returned
public media URL in `image.src`, with `image.alt` required when a photo is
set, exactly as `normalizeInterview` demands. No new container, route or
role.

**D9. Consent is a required, dated, attributed field, checked at publish,
never public.** The form shows one fixed sentence (`CONSENT_WORDING_V1`,
kept in code so a later change gets a new version): "The guest has agreed
that this interview may be published on hybridcloudworks.com, and knows the
recording is kept privately for the site's records." The document stores
`consent: { confirmed: true, date: 'YYYY-MM-DD', wording: 'v1', confirmedBy:
{ oid, email }, confirmedAt }`; `confirmedBy` is the signed-in admin, taken
from the token, not the form. `publishContent` refuses an interview whose
consent is missing, unconfirmed or dated in the future with
`CONSENT_REQUIRED` (422). The audit row for the create carries the consent
date and the admin's oid, nothing else.

**D10. The private container, retention and deletion.**

   - Terraform (`infra/storage.tf`): `azurerm_storage_container.interviews_audio`,
     name `interviews-audio`, on the content account `stsiteprodcus01`,
     `container_access_type = "private"`, with the same `checkov` skip
     comment as `podcast`; `prevent_destroy` is not set (the podcast
     container does not set it either; soft delete covers 7 days). **One
     new role assignment, on this container only:** the Function App
     identity holds Storage Blob Data Contributor on the whole account
     (`func_blob`), and that role cannot delete a blob *version*
     (`Microsoft.Storage/storageAccounts/blobServices/containers/blobs/deleteBlobVersion/action`
     is outside it), which the version-aware delete below needs. So
     `azurerm_role_assignment.func_interviews_audio_owner` grants the
     built-in **Storage Blob Data Owner** at the scope of
     `azurerm_storage_container.interviews_audio` alone, the way
     `infra/lab-hybrid-backups.tf` grants a role on one container. Why the
     built-in role and not a custom one: the repository's custom roles
     (`infra/roles/*.json`) exist because the Terraform identity cannot
     create role definitions, so each one is a step the owner runs by hand
     (`az role definition create`) before the apply; a built-in role at
     container scope needs no owner step, and the container holds nothing
     but this feature's recordings and transcripts, so Data Owner there
     widens nothing else. The network rule (subnet only), `shared_access_key_enabled
     = false`, `allow_nested_items_to_be_public = false` and the CORS rule
     are untouched, so nothing outside the Function App can read or write
     the container.
   - Layout: `audio/<interviewId>.<ext>` for the recording,
     `transcripts/<interviewId>/v<n>.json` (and the `.parts/` folder while a
     job runs) for transcripts. Two prefixes so the lifecycle rule can
     expire recordings and keep transcripts.
   - Retention: a rule `expire-interview-audio` in the existing
     `azurerm_storage_management_policy.cleanup`, prefix
     `interviews-audio/audio/`, delete after
     `var.interview_audio_retention_days` (new variable, **default 365**)
     from creation. Transcripts are not expired by rule; they are the
     provenance the owner asked to keep. The owner changes the number in
     HCP Terraform's variables and confirms the run.
   - Deletion: "Delete recording" on the admin page (`DELETE
     /api/cms/interviews/{id}/audio`, publisher) deletes the blob and clears
     `provenance.audio`. The account keeps blob versions, and deleting a
     versioned blob without naming a version turns the current blob into a
     previous version rather than a soft-deleted blob, which the account's
     `expire-noncurrent-versions` rule would keep for up to 30 days
     ([blob versioning](https://learn.microsoft.com/azure/storage/blobs/versioning-overview),
     read 2026-11-05). So the delete handler lists the blob's versions
     (`includeVersions`) and deletes each by its `versionId` as well as the
     current blob; blob soft delete (7 days on this account) then holds the
     deleted versions for that window, which is the only recovery path and
     the one the runbook names. The lifecycle rule carries the same
     `version { delete_after_days_since_creation }` action as the base
     blob, so an expired recording's versions go with it. Deleting the
     interview (`deleteContentItem`, existing) deletes its audio and
     transcripts the same way through an interview-aware hook, in an order
     that also catches an upload still in flight: the hook **first writes a
     tombstone** (`provenance.audio.deletedAt`) under the document's ETag,
     so any upload completion that read the document before it fails its
     own ETag write with 409 and deletes the blob it just committed, and
     any completion or session open that reads the document after it sees
     the tombstone and refuses (409) before committing; only then does the
     hook sweep, and it sweeps the interview's **whole `audio/<interviewId>/`
     prefix** (and `transcripts/<interviewId>/`), not only the paths the
     document names, so a blob committed in the moment between the two
     writes is removed too. Uncommitted blocks of an abandoned session are
     not blobs and go with Azure's one-week clean-up. Unpublishing deletes
     nothing.
   - Kept out of `PUBLIC_MEDIA_CONTAINERS` (a disclosure decision, says its
     comment) and out of `UPLOAD_CONTAINERS` (the generic upload route is
     15 MB and image-only). Nothing in `connect-src` or the storage CORS
     rule changes.

**D11. Security and privacy review points**, to be checked on each slice's
pull request:

   - Transcripts and recordings are personal data: they live in one private
     container, reach Gemini for the length of a job and 48 hours at most,
     appear in no log, no audit row, no Cosmos document, no backup other
     than the content account's own (RA-GRS with blob versioning), and no
     public field. The Cosmos export (ADR 0028) carries the document, so it
     carries the guest's name, bio and consent record, as it does for every
     author today.
   - Who calls what: every `cms/interviews/*` route is `editor` except
     delete-audio (publisher); publish and unpublish are the existing
     publisher routes; the two public routes are anonymous and read-only
     with allow-listed fields; the job types are `editor`; Koda has none.
     `route-inventory.test.js` enforces the guard on every route.
   - The audio URL fetch is server-side request forgery surface: it goes
     through `guarded-fetch.js` and nowhere else, with the stream variant
     tested against private addresses, redirects to private addresses,
     downgrade to http, oversize and stall.
   - The block upload accepts raw bytes: `Content-Length` is required and
     capped per block, the block index is bounded by the session's declared
     size, the session is tied to the interview id and the caller's oid,
     the committed size and SHA-256 must match the declaration, and the
     content type is never trusted from the body.
   - AI output is untrusted: fenced input, shape-validated output, the
     honesty guard, `safeLink` on every link, and no HTML in any field (the
     page renders text).
   - Cost: the monthly ceiling, the 500 MiB cap, the 10-window cap, the
     25-minute job timeout, one job per transcript version.

**D12. Tests at each boundary** (named in the slice plan): Terraform `fmt`,
`validate`, `tflint` and the Trivy scan; the block upload routes with a
stubbed blob client (session, block bounds, commit order, size and hash
mismatch, 409 on a second commit, 401/403); the stream fetch guard against
the SSRF cases; the transcription job with a stubbed Gemini client
(windowing, `endOfAudio`, resume from parts, retry classes, budget refusal,
content-free logs); the drafting job with a stubbed router (shape, repair
round, pull-quote verbatim rule, the 80% guard, speaker mapping); the
contract and type registrations (every pinned list); the publish refusals
(consent, schema); the public routes (allow-list pinned to the frontend,
404 for unpublished, cache header); the frontend pages with a stubbed
`publicApi` (list, detail, not-found, landing card), the manifest builder
(interview routes and seeds, blog surfaces exclude interviews); and a
Playwright journey of the form against the stubbed API (`frontend/e2e/interviews.spec.js`,
added to the explicit list in `ci.yml`).

**D13. Rollback.** Each slice is one pull request, and they revert in the
reverse of their merge order, D, then C, then B, then A, because C imports
B's `schema.js` and B imports A's `storage.js` and `blob-storage.js`
helpers. Reverting a slice while a later one is still on `main` is not
done; if only the later behaviour must go, revert that later slice. Within
that order: the form slice is pure frontend; the CMS and pages slice is the
only one that removes something (the static sample), and its revert
restores the JSON path; the jobs slice registers routes and job types that
nothing calls once the form is gone; the Terraform slice leaves an empty
container (reverting it after audio exists is the owner's delete, not a
revert). A published interview is unpublished from the admin, not by a
revert.

## Consequences and accepted risks

- Positive: no new resource, no new secret, no change to the storage
  account's network posture, one more content type on one status machine,
  and a path from a recording to a published page that the owner runs alone
  from a phone.
- The audio does go to Google for transcription: that is the owner's
  decision 1, and the 48-hour Files retention is Google's documented
  behaviour, not ours to shorten beyond deleting the file when the job ends.
  Google's Files page does not say whether uploaded files are used for
  training; the owner's own Gemini API terms govern that [REVIEW REQUIRED:
  owner to confirm the paid-tier data terms are acceptable for guests'
  voices].
- A 500 MiB upload over a slow connection is 125 requests and several
  minutes; the form must survive a closed tab by letting the owner resume
  from `/admin/interviews/{id}` (uncommitted blocks live a week). The first
  version resumes by re-sending the file; a block-list read for a smarter
  resume is a later improvement.
- Transcription quality and speaker attribution are the model's; the
  honesty guard flags, it does not prove. The owner reads every answer
  before `in_review`, as the runbook will say.
- The landing card and the sitemap lag a new interview by up to a day and a
  manual deploy, as they do for blog posts. The page itself is live within
  five minutes of publishing.
- Gemini's audio-input price has no row in `model-tables.js` today; until
  slice B adds it, the Cost page would under-count. Slice B adds it with the
  date read.
- The `interviews-audio` container has no `prevent_destroy`; `terraform
  destroy` of the account is already refused by the account's own guard.

## Alternatives considered

- **User-delegation SAS and a direct browser PUT** (the issue's sketch).
  Rejected for this version: it needs the storage firewall opened to the
  internet, PUT in the account CORS rule, the storage host in `connect-src`
  and the first write SAS in the codebase, four reversals of ADR 0031's
  posture for one form. If the owner opens the account for another reason,
  the block route can be replaced by a SAS grant with the same session
  document and the same size cap.
- **A second storage account open to the internet, just for uploads.** A new
  Azure resource, against decision 1's spirit, plus a copy step into the
  private account.
- **Proxy the whole file in one request.** Impossible above 210 MB on any
  Functions plan, and about 2.5× the file in memory below it.
- **Send the audio inline to Gemini.** Capped at 20 MB per request; the
  Files API is the documented path above that.
- **Split the audio on our side (ffmpeg) into one-hour files.** The Flex
  Consumption image has no ffmpeg and the repository builds no native
  tooling; time-window prompts over one uploaded file give the same
  chunking with no binary dependency.
- **A Durable Functions orchestration.** Nothing in the repository uses it;
  the jobs framework already gives the claim, timeout, sweeper and poison
  behaviour, and the parts-on-blob resume covers the one thing Durable would
  add.
- **Plaud for transcription** (the podcast path). Ruled out by the owner.
- **Store the transcript on the content document.** Rejected: size and index
  policy, and it would copy personal data into every Cosmos export.
- **Keep the interview as JSON in the repository and add a form that opens a
  pull request.** Rejected by decision 2.
- **Fetch published slugs at build time instead of the manifest.** CI cannot
  reach the origin (the reason the manifest workflow exists), and the blog
  precedent already solves pre-render and sitemap.
- **A timer that polls for interviews to transcribe.** Nothing to poll; a
  queue message is already how every other background job starts.

## Validation and revisit triggers

Validated when: the first real interview (#1344) is uploaded, transcribed,
drafted, reviewed, published and visible at `/azure/interviews/<slug>` with
no deploy, its recording in `interviews-audio/audio/` and nowhere else, and
a search of Log Analytics for the interview's window shows ids and counts
only; a browser journey of the form is green in CI; the Cost page shows the
transcription under AI.

Revisit when: Gemini changes the Files API retention or the 9.5-hour cap;
the owner opens the storage account to the internet for another reason
(then the SAS alternative is cheaper); interviews outgrow the `content`
container's allow-lists; a second content type needs structured (non-
markdown) editing, at which point the Q&A editor becomes a field-schema
editor; or the monthly transcription spend approaches the ceiling.

## Related decisions and references

- [ADR 0028](0028-cosmos-out-of-account-export.md), [ADR 0029](0029-podcast-hosting-and-audio-surface.md)
  (the podcast upload and Plaud path this does not reuse),
  [ADR 0031](0031-security-scanner-owner-decisions.md),
  [ADR 0033](0033-contentforge-alignment.md), [ADR 0034](0034-ai-model-selection.md),
  [ADR 0037](0037-agent-content-api.md), [ADR 0038](0038-koda-admin-access.md).
- Slice plan: [`docs/architecture/interviews-slices.md`](../architecture/interviews-slices.md).
- Runbook to rewrite: [`docs/runbooks/add-an-interview.md`](../runbooks/add-an-interview.md).
- Gemini: [audio understanding](https://aistudio.google.com/docs/audio),
  [Files API](https://aistudio.google.com/docs/files) (both read 2026-11-05).
- Microsoft Learn: [Functions app settings, `FUNCTIONS_REQUEST_BODY_SIZE_LIMIT`](https://learn.microsoft.com/azure/azure-functions/functions-app-settings#functions%5C_request%5C_body%5C_size%5C_limit),
  [Functions service limits](https://learn.microsoft.com/azure/azure-functions/functions-scale#service-limits),
  [Put Block](https://learn.microsoft.com/rest/api/storageservices/put-block),
  [Put Block List](https://learn.microsoft.com/rest/api/storageservices/put-block-list),
  [Storage firewall rules](https://learn.microsoft.com/azure/storage/common/storage-network-security)
  (all read 2026-11-05).

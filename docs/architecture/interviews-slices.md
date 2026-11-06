# Interviews from the admin: the four slices

The build plan for [ADR 0040](../decisions/0040-interviews-from-the-admin.md)
(issue [#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565)).
Four pull requests. Three of them (A, B, C) are written at the same time by
three agents in their own worktrees (separate working folders of the same
clone); the fourth (D) starts when the first three have merged, because it
calls their routes. Each slice is reviewable on its own and touches nothing
another slice owns; they revert in reverse merge order (D, C, B, A), as the
ADR's D13 says, because C imports B's `schema.js` and B imports A's helpers.

Read the ADR first; this page says *where* and *in what order*, the ADR says
*what* and *why*. The letters D1 to D13 below point at the ADR's decisions.

## Rules every slice follows

- Work in your own worktree on a branch `feat/1565-<slice>`; never `git
  stash` (the worktrees share one stash list); name every scratch file by
  slice (`1565-a-body.md`, never `body.md`).
- Commit as the owner's noreply identity, the message ending with the
  Co-Authored-By line the session gives you; the pull request title is
  `<area>: <what changed> (#1565)`, at most 72 characters, opened ready for
  review with the template's sections.
- Before opening the pull request, hand the branch to the matching
  reviewer named in each slice; fix what it finds.
- **Do not edit `CHANGELOG.md`** in A, B or C. Slice D carries the entries
  for all four (see D's section), so two open pull requests never touch the
  same lines of that file.
- No content in logs: ids, counts, bytes, versions, durations. A test in
  each functions slice asserts it.
- No real tenant, subscription or application id anywhere; placeholders are
  `00000000-0000-0000-0000-000000000001` and the like.
- The three merge in the order **A, then B, then C**; each rebases onto
  `main` just before its merge. The only files two of them both touch are
  the registries in the "shared files" table, where an addition from each
  lands on neighbouring lines; the rebase resolves them in a minute.

## Shared files, and the contract that keeps them from colliding

| File | Who adds a line | What |
|---|---|---|
| `functions/src/functions/index.js` | A, B, C | one `import "./<file>.js"` each; append at the end of the list, one import per slice |
| `functions/function-inventory.json` | A, B, C | the new function names, sorted where the test says |
| `.azure/api-surface.json` | A, B, C | A: `adminWrites` for the three upload routes; B: `adminWrites` for its four routes (`audio-from-url`, `transcribe`, `draft` and `transcript`; `api-contract.test.js` fails on any route the file does not claim); C: `publicReads` for the two public routes and `adminReads`/`adminWrites` for the interview CRUD |
| `functions/src/functions/route-inventory.test.js` | C only (A and B's routes are guarded, so they need no entry) | the two public routes in `PUBLIC_ROUTES` with their reason |
| `functions/src/functions/registration-shims.test.js` | A, B, C | the new file names in its list |
| `functions/src/lib/jobs.roles.test.js` | B only | the new job module in its import list |
| `functions/src/lib/interviews/storage.js` | A owns it; **B writes an identical copy** | see below |
| `functions/src/lib/blob-storage.js` | A adds `stageBlock` and `commitBlockList`; B adds one export, `downloadBlobStream` (a `Readable` of the blob's body, 8 MiB reads), placed after `downloadBlob` so the two additions do not share lines | A's agent is told B adds that one function; neither touches the other's |

`functions/src/lib/interviews/storage.js` is needed by A (the upload) and B
(the jobs) at once. A owns it. B's agent creates the same file with exactly
this content, so that when B rebases onto A's merge, Git sees one identical
file and no conflict:

```js
/**
 * storage.js — where an interview's recording and transcripts live.
 *
 * One private container, two prefixes: the lifecycle rule in infra/storage.tf
 * expires `audio/` after the owner's retention and never touches
 * `transcripts/` (ADR 0040, D10). Nothing else writes here, and nothing
 * public reads here: the container is in neither PUBLIC_MEDIA_CONTAINERS nor
 * UPLOAD_CONTAINERS on purpose.
 */

export const INTERVIEWS_AUDIO_CONTAINER = 'interviews-audio';

export const AUDIO_TYPES = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
});

// Browsers and recorders spell the same three types several ways. The
// canonical type is what is stored and checked against the extension.
const AUDIO_TYPE_ALIASES = Object.freeze({
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
});

export function canonicalAudioType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  const type = AUDIO_TYPE_ALIASES[base] || base;
  return Object.hasOwn(AUDIO_TYPES, type) ? type : null;
}

export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

export function audioBlobPath(interviewId, uploadId, ext) {
  return `audio/${interviewId}/${uploadId}.${ext}`;
}

export const MAX_AUDIO_SECONDS = 34_200; // Gemini's 9.5 hours per prompt

export function transcriptBlobPath(interviewId, version) {
  return `transcripts/${interviewId}/v${version}.json`;
}

export function transcriptPartPath(interviewId, version, windowIndex) {
  return `transcripts/${interviewId}/v${version}.parts/${String(windowIndex).padStart(3, '0')}.json`;
}
```

A adds its test for these helpers in `storage.test.js` (including that
every alias above maps to its canonical type and an unknown type gives
`null`); B does not write a test for this file.

## Slice A: the private container, and the block upload

**Owner agent:** `terraform-expert-engineer` for `infra/`, then
`typescript-distinguished-engineer` for the functions code. Reviewers before
the pull request: `infrastructure-pr-reviewer` (the Terraform) and
`typescript-security-reviewer` (the raw-body routes).

**Pull request title:** `Interviews: private audio container and block upload (#1565)`

**Decisions it builds:** D1, D10 (Terraform half), D11's upload bullets.

**Files to touch**

- `infra/storage.tf`: `azurerm_storage_container.interviews_audio`
  (copy the `podcast` block, name `interviews-audio`, private, the
  `CKV2_AZURE_21` skip comment); a `rule { name = "expire-interview-audio" }`
  inside `azurerm_storage_management_policy.cleanup` with
  `prefix_match = ["interviews-audio/audio/"]`, a `base_blob {
  delete_after_days_since_creation_greater_than =
  var.interview_audio_retention_days }` action and a `version {
  delete_after_days_since_creation = var.interview_audio_retention_days }`
  action, so an expired recording's previous versions go with it (the
  account keeps blob versions; ADR 0040 D10); and
  `azurerm_role_assignment.func_interviews_audio_owner`: the built-in
  `Storage Blob Data Owner` for the Function App identity at
  `azurerm_storage_container.interviews_audio.id` only (copy the
  container-scoped assignment in `infra/lab-hybrid-backups.tf`), because
  `func_blob`'s Contributor role cannot delete a blob version and slice C's
  delete needs to; a custom role would cost an owner `az role definition
  create` step, which is why the built-in one is chosen (ADR D10). Add the
  assignment to `scripts/terraform-identity-grants.test.mjs` if that test
  enumerates role assignments.
- `infra/variables.tf`: `variable "interview_audio_retention_days"`
  (number, default 365, a validation of 1 to 3650, a description a junior
  administrator can read).
- `functions/src/lib/interviews/storage.js` (above) and `storage.test.js`.
- `functions/src/lib/blob-storage.js`: two helpers, `stageBlock(container,
  path, blockId, bytes)` and `commitBlockList(container, path, blockIds, {
  contentType, metadata })`, both calling `refuseWriteAfterJobAbort` first
  like `uploadBlob`; `blob-storage.test.js` gains their cases.
- `functions/src/lib/interviews/upload.js`: the three handlers.
  `openUpload` (editor; body `{ interviewId, fileName, contentType, bytes,
  sha256, durationSec }`; normalises the type with `canonicalAudioType`
  (`null` is refused), checks the extension matches the canonical type,
  `bytes` is 1 to `MAX_AUDIO_BYTES`, `durationSec` is a positive number at
  most `MAX_AUDIO_SECONDS` (over it: 422 `TOO_LONG`; the browser reads it
  from the file's metadata, and a file whose duration cannot be read is
  refused with `DURATION_REQUIRED`); the blob path is
  `audioBlobPath(interviewId, uploadId, ext)`, unique per session, so two
  sessions for one interview never share a blob or its block ids; appends
  the session to the bounded list `provenance.audio.uploads` on the
  interview's content document (one entry per open session, keyed by
  `uploadId`, written under the document's ETag with a `patchDoc` that
  tolerates the document being a bare `{ type: 'interview' }` stub in
  tests); refuses with 409 when the document carries the deletion
  tombstone `provenance.audio.deletedAt` (see `completeUpload` below);
  returns `{ uploadId, blockSize: 4194304, blockCount }`). `putBlock`
  (editor; `PUT`, raw body read with `request.arrayBuffer()`, `Content-Length`
  required and at most `blockSize`, `index` an integer in `[0, blockCount)`,
  the last block's length checked against the declared size, block id =
  base64 of the zero-padded index, 404 when the upload id does not belong
  to the caller's oid). `completeUpload` (editor; commits the blocks in
  order on the session's own blob, reads the committed blob's size, refuses
  a size or SHA-256 mismatch with 422 and deletes that blob (fenced: the
  session's `refusals` count is written under the ETag first, so a blob is
  never deleted after another completion published it), then moves the
  pointer: the previous `provenance.audio.path`, if any, is appended to
  `provenance.audio.superseded` (slice C's `deleteBlobWithVersions` sweeps
  that list on delete, and the lifecycle rule expires it regardless), and
  the pointer fields (`container, path, bytes, sha256, contentType,
  durationSec, uploadedAt, uploadId, superseded`) are written under the
  document's ETag **together with every other open session in
  `provenance.audio.uploads`**, so only this session leaves the list and
  another upload in flight can still send blocks and complete; 409 if
  already complete. **Deletion race:** a completion that finds the
  tombstone `provenance.audio.deletedAt` before committing refuses with 409
  and commits nothing; a completion whose pointer write fails its ETag
  because the delete hook wrote the tombstone after this completion read
  the document answers 409 and deletes the blob it just committed (with its
  versions); slice C's sweep of the whole `audio/<interviewId>/` prefix
  catches the one window left between the two.
- `functions/src/functions/interviews-upload-http.js`: the registrations
  with `httpRouteByMethod` (`POST cms/interviews/uploads`, `PUT
  cms/interviews/uploads/{uploadId}/blocks/{index}`, `POST
  cms/interviews/uploads/{uploadId}/complete`), all through
  `getDefaultGuard().requireRole(request, 'editor')`.
- The shared registries (table above).
- `docs/runbooks/required-checks.md` is **not** touched; nothing changes in
  the ruleset.

**Tests to add**

- `infra`: the existing `fmt, validate, tflint` and Trivy jobs cover it; add
  the container and the variable to `scripts/terraform-identity-grants.test.mjs`
  only if that test enumerates containers (read it first; it may not).
- `functions/src/lib/interviews/upload.test.js`: open with a bad type,
  oversize, mismatched extension; a block out of range; a block that is too
  long; a block from another admin's oid; a completion against a
  tombstoned document (409, nothing committed) and one whose pointer write
  meets the tombstone's ETag (409, its blob deleted); completing one of two
  open sessions leaves the other in `provenance.audio.uploads`; a duration of 34,200 accepted
  and 34,201 refused with `TOO_LONG`; two sessions for one interview stage
  on different blobs and the second completion lists the first path under
  `superseded`; complete with the wrong hash
  (blob deleted, 422); complete twice (409); the happy path with a stubbed
  blob client asserting `stageBlock` is called with the padded ids and
  `commitBlockList` with them in order; log lines carry the upload id and
  byte counts only.
- `functions/src/lib/blob-storage.test.js`: the two helpers refuse after a
  job abort.

**Commands to run.** Each line stands alone and names its folder, so it
works from any working directory; `$W` is your worktree's root, set once
with `W=$(git rev-parse --show-toplevel)`. The lines below are bash (Git
Bash), the shell every agent runs; a PowerShell reader writes the worktree
path in place of `"$W"`.

```bash
terraform -chdir="$W/infra" fmt -check -recursive
terraform -chdir="$W/infra" init -backend=false -input=false
terraform -chdir="$W/infra" validate
tflint --chdir "$W/infra" --recursive
npm --prefix "$W/functions" ci --engine-strict=false
npm --prefix "$W/functions" run lint
npm --prefix "$W/functions" test -- src/lib/interviews src/lib/blob-storage src/functions/route-inventory src/functions/function-inventory src/functions/registration-shims src/functions/api-contract
```

**Must not touch:** `functions/src/lib/ai/*`, `functions/src/lib/cms/*`,
`functions/src/lib/public-reads.js`, anything under `frontend/`,
`CHANGELOG.md`, `docs/runbooks/add-an-interview.md`, the storage account's
`network_rules`, CORS rule or `shared_access_key_enabled`,
`frontend/staticwebapp.config.json`.

**Not verified by this slice:** the Terraform apply (the owner confirms the
HCP Terraform run; expected: 1 container and 1 role assignment to add, 1 policy to change in
place, 0 to destroy); the block upload against real storage (the first
real upload in slice D proves it).

## Slice B: fetch, transcribe and draft (the jobs and the Gemini client)

**Owner agent:** `typescript-distinguished-engineer`. Reviewers before the
pull request: `typescript-security-reviewer` (the fetch guard, the prompt
fence, the logs) and `typescript-test-engineer` (the stubbed Gemini client).

**Pull request title:** `Interviews: fetch, transcribe and draft jobs with a stubbed Gemini (#1565)`

**Decisions it builds:** D2, D3, D4, D11's fetch and AI bullets.

**Files to touch**

- `functions/src/lib/http/guarded-fetch.js`: `guardedFetchStream(url, {
  maxBytes, timeoutMs, httpsOnly, allowedTypes, allowedExtensions })`
  returning `{ response, stream }` where `stream` is a counting
  `Readable` that destroys itself past `maxBytes`; shares every check with
  `guardedFetch`. `guarded-fetch.test.js`: the SSRF cases for the stream
  variant (private address, redirect to private, redirect to http, oversize
  `Content-Length`, oversize on the wire, stall past the deadline, wrong
  content type).
- `functions/src/lib/ai/tasks.js`: `recordingTranscript` loses `planned`,
  gains `only: ['gemini']` and a priced, dated recommendation; a new
  `interviewDrafting` task (json modality). `provider-order.js`: `stt` in
  Gemini's capabilities. `model-enrichment.js`: `stt` on the `gemini-*`
  row that is not TTS. `model-tables.js`: an audio-input rate for the chosen
  model with the date read from Gemini's pricing page. `features-catalogue.js`:
  the placement entries the test requires. Update the tests that pin the
  planned and media lists (`tasks.test.js`, `media-tasks.test.js`,
  `ai-config.test.js`, `ai-call-sites.test.js` floors) and add the budget
  row in `sync-budgets.test.js` only if a file with `httpRoute` imports a
  `generate*` function (the jobs module does not; the enqueue routes do not).
- `functions/src/lib/interviews/storage.js`: the identical copy (above).
- `functions/src/lib/blob-storage.js`: one export, `downloadBlobStream(container,
  path)` returning a `Readable` of the blob's body, placed after
  `downloadBlob`, with its case in `blob-storage.test.js`; A is told
  (shared files table). The recording is read with it and never with
  `downloadBlob`, which buffers the whole blob.
- `functions/src/lib/interviews/gemini-files.js`: `uploadToGemini({ stream,
  bytes, mimeType, apiKey, fetch })` (the two-step resumable protocol),
  `deleteFromGemini`, `transcribeWindow({ fileUri, model, startSec, endSec,
  apiKey, fetch })` returning `{ segments, endOfAudio, usage }`; the key read
  the way `router.js` reads `GEMINI_API_KEY` (never logged, never in an
  error message); retries as D3 says. `gemini-files.test.js` with a fake
  `fetch`.
- `functions/src/lib/interviews/transcribe.js`: the job worker (budget
  check, upload, window loop, parts on blob, assemble, delete parts, delete
  the Gemini file in `finally`, usage rows, the document patch).
  `transcribe.test.js`: windowing stops on `endOfAudio`; resumes from
  existing parts; 10-window cap; the estimate multiplies the whole file's
  audio tokens by the window count and a 1.5 retry allowance and is
  re-checked before the second window; budget refusal with `BUDGET_EXCEEDED`;
  429 retried, 403 not; the Gemini file deleted on failure; log lines
  content-free (assert no segment text, name or URL appears in any
  `context.log` call).
- `functions/src/lib/interviews/fetch-audio.js`: the `interview-fetch-audio`
  worker (guardedFetchStream into `uploadBlobFromStream`, then
  `provenance.audio` with `sourceUrl`). Test with a fake fetch and a stubbed
  blob client.
- `functions/src/lib/interviews/schema.js`: the interview limits (title
  160, subtitle 240, bio 6000, tags, qa 1 to 40, q 240, a 6000, pullQuote
  240, related 12 each, `safeLink`); `validateInterviewFields(partial)` and
  `validateQa(list)`. `schema.test.js` reads
  `frontend/src/lib/interviews.js` and fails if a limit there differs
  (copy the pattern in `functions/src/lib/public-reads.allowlist.test.js`).
  **C also imports this file**; B owns it. C's agent must not create it;
  C stubs the import in its tests until B merges (C merges after B).
- `functions/src/lib/interviews/draft.js`: the `interview-draft` worker
  (fence, prompt, `generateJsonResponse({ feature: 'interviewDrafting' })`,
  `validateQa`, speaker mapping) and `draft-guard.js` (verbatim pull
  quotes, the 80% rule, `needsReview`). Tests with a stubbed router: shape
  failure goes to the repair round then `INVALID_DRAFT`; an invented pull
  quote is dropped; an answer with invented words is flagged, not dropped;
  the speaker disagreement sets `unsure`.
- `functions/src/lib/interviews/transcript-text.js`: the pasted-transcript
  handler (400,000-character cap, `Speaker N:` lines kept, written to
  `transcripts/<id>/v1.json`, `transcription.status = 'provided'`). The
  drafting worker (`draft.js`) splits any transcript into passes of at most
  120 kB on speaker-turn boundaries, as many as needed (up to ten for the
  400,000-character cap, which is at most about 1.2 MB of UTF-8); a single
  turn longer than a pass is split at a UTF-8 character boundary (the last
  sentence end before the limit when there is one), each piece keeping the
  turn's `Speaker N:` label, so nothing is dropped (`splitTranscript` must
  not truncate a turn); each pass is checkpointed: its validated items are
  saved on the document as `provenance.drafting.passes[k]` with the
  transcript version, each pass runs under a 3-minute deadline, and a
  re-run or re-queue for the same version resumes at the first pass with no
  saved output; gives each pass the questions already drafted,
  checks the monthly ceiling before each pass, records each pass under
  `ai:interviewDrafting`, and validates the combined list once (over 40:
  first 40 kept, `truncated` flag). `draft.test.js` covers a three-pass
  transcript, the no-repeat input, the ceiling refusal between passes, the
  truncation flag, a 300 kB single turn split into three labelled pieces
  with no character lost (including a multi-byte character at the cut),
  and a job that stops after pass two resuming at pass three.
- The `transcribe` enqueue route refuses `provenance.audio.durationSec >
  MAX_AUDIO_SECONDS` (from A's `storage.js`) with 422 `TOO_LONG` before
  writing a job, and the worker stops with `TOO_LONG` when the tenth window
  ends without `endOfAudio` (a URL fetch has no declared duration).
  `transcribe.test.js` covers 34,200 accepted, 34,201 refused, and the
  tenth-window stop.
- `functions/src/functions/interviews-jobs.js`: `registerJobType` for the
  three types (`interview-fetch-audio`, `interview-transcribe`,
  `interview-draft`; role `editor`; `maxPayloadBytes` 1024; `timeoutMs`
  10, 25 and 25 minutes, the drafting job checkpointed by pass as above),
  and the enqueue routes `POST
  cms/interviews/{id}/audio-from-url`, `POST cms/interviews/{id}/transcribe`,
  `POST cms/interviews/{id}/draft`, `POST cms/interviews/{id}/transcript`
  (all editor, with the queue output binding as
  `listen-and-learn-http.js` has it, 409 when a job for that version is
  already queued or running).
- The shared registries (table above) and `jobs.roles.test.js`.

**Commands to run** (bash; `$W` is your worktree's root as in slice A;
each line stands alone)

```bash
npm --prefix "$W/functions" ci --engine-strict=false
npm --prefix "$W/functions" run lint
npm --prefix "$W/functions" test -- src/lib/interviews src/lib/http/guarded-fetch src/lib/ai src/lib/jobs src/lib/blob-storage src/functions/route-inventory src/functions/function-inventory src/functions/registration-shims src/functions/api-contract src/functions/job-poison-hooks src/functions/job-write-after-abort src/lib/no-raw-error-leaks
```

**Must not touch:** `infra/`, `functions/src/lib/cms/*`,
`functions/src/lib/public-reads.js`, `functions/src/lib/blob-storage.js`
beyond its one `downloadBlobStream` export (A adds the block helpers; B
otherwise uses `uploadBlobFromStream`, `uploadBlob` and `deleteBlob`, which
exist), anything under `frontend/`,
`CHANGELOG.md`, `docs/`.

**Not verified by this slice:** any call to the real Gemini API (every test
stubs `fetch`); the audio-input price (marked `[VERIFY]` in the rate's
comment until the owner's first real run shows up on the Cost page).

## Slice C: the content type, the public API, the live pages, the runbook

**Owner agent:** `typescript-distinguished-engineer`. Reviewers before the
pull request: `typescript-security-reviewer` (the public allow-lists and
the publish refusals) and `cloud-documentation-archivist` (the runbook).

**Pull request title:** `Interviews: content type, public API and live pages (#1565)`

**Decisions it builds:** D5, D6, D8 (the photo path), D9, D10's deletion
hook, D12's page tests.

**Files to touch**

- `functions/src/lib/cms/publish-targets.js`, `publish-contracts.js`
  (`CONTRACTS.interview`: `section: 'interviews'`, body fields `['bodyText',
  'bio']`, a small rubric, `NO_IMAGERY`), `taxonomy.js`, `taxonomy-fields.js`,
  `publish.js` (`interview → interviews`; the consent and schema refusals
  before the quality gate, `CONSENT_REQUIRED` 422; derive `bodyText` from
  `qa` for the rubric), `content-update-validation.js` (the `interview`
  hook calling `validateInterviewFields` from
  `functions/src/lib/interviews/schema.js`, which B owns), `content-create.js`
  (accept `interview`), `functions/src/lib/admin-snapshots.js` type lists,
  `functions/src/lib/timers/forge-scheduled.js` (exclude `type = 'interview'`),
  `functions/src/lib/content-workflow.js` (delete hook first writes the
  tombstone `provenance.audio.deletedAt` under the document's ETag, then
  sweeps every blob under the interview's whole `audio/<interviewId>/`
  prefix and `transcripts/<interviewId>/` prefix, not only the paths the
  document names, so an upload that committed while the delete was starting
  is removed too; it removes the audio and
  transcripts, listing each blob's versions with `includeVersions` and
  deleting every `versionId` as well as the current blob, since the account
  keeps versions and a plain delete would leave the recording as a previous
  version for up to 30 days; `delete-audio` in `lib/interviews/admin.js`
  shares the helper, `deleteBlobWithVersions`, which C adds to
  `lib/interviews/admin.js`, not to `blob-storage.js`), `scripts/ideas/idea-notes.mjs`
  (`IDEA_TYPES`). Update each
  pinned test (`publish-targets.test.js`, `publish-contracts` cases in
  `content-quality.test.js`, `taxonomy-fields.test.js`,
  `idea-promotion.test.js`, `publish.test.js`).
- `functions/src/lib/interviews/consent.js`: `CONSENT_WORDING_V1`,
  `validateConsent`, and the create handler's attribution from the token.
- `functions/src/lib/interviews/admin.js` and
  `functions/src/functions/interviews-admin-http.js`: `POST cms/interviews`
  (create at `draft` with consent), `GET cms/interviews` (list with stage
  and status), `GET cms/interviews/{id}` (document plus the transcript read
  from the container, `private, no-store`), `DELETE cms/interviews/{id}/audio`
  (publisher). Edits go through the existing `updateContentItem`.
- `functions/src/lib/public-reads.js` and `functions/src/functions/public-reads.js`:
  the two public routes, `PUBLIC_INTERVIEW_LIST_FIELDS`,
  `PUBLIC_INTERVIEW_DETAIL_FIELDS`, the same visibility clause, 300-second
  cache; `public-reads.allowlist.test.js` pins the lists against
  `frontend/src/lib/interviews.js`; `route-inventory.test.js` `PUBLIC_ROUTES`.
- `functions/src/lib/public-content-manifest.js` and
  `scripts/build-content-manifest.mjs`: interview routes, seeds and the
  `sections.interviews` count; interviews excluded from the blog routes.
  `functions/src/lib/public-section-counts.js` and
  `frontend/src/hooks/useBlogData.js`: exclude `interview`.
- `frontend/src/lib/publicApi.js`: `fetchPublicInterviews`,
  `fetchPublicInterview(slug)`. `frontend/src/pages/azure/InterviewsPage.jsx`
  and `LandingPage.jsx`: read live through `usePublicData`;
  `frontend/scripts/prerender-entry.jsx` and
  `frontend/src/lib/interviews.routes.test.js`: routes from the manifest.
  Delete `frontend/src/data/interviews/` entirely; update
  `InterviewsPage.test.jsx`, `LandingPage.interviews.test.jsx`,
  `Header.interviews.test.jsx` to stub `publicApi` instead of the data
  module. `frontend/src/lib/contentModel.js`,
  `features/editor/hooks/useEditorState.js`,
  `pages/admin/editor-list/editorItems.js`: the `interview` type.
- `docs/runbooks/add-an-interview.md`: rewritten for the new path (the
  form, what each stage means, how to read the transcript, review and
  publish, unpublish, delete the recording, where the retention is set,
  what to do when a stage says `failed`); the "sample interview" banner
  goes. `docs/content/blog-machine.md`: one paragraph naming the interview
  type and linking the runbook and ADR 0040.
- The shared registries (table above).

**Tests to add:** the publish refusals (no consent, future date, bad `qa`);
the public routes (allow-list, unpublished gives 404, `Cache-Control`);
the version-aware delete (a stubbed blob client lists two versions and the
test asserts three deletes: each version and the current blob); the delete
hook writes the tombstone before it lists, and deletes a blob under
`audio/<interviewId>/` that the document does not name;
the manifest builder (interview routes present, blog routes exclude
interviews); the forge timer query excludes interviews; the frontend pages
with a stubbed `publicApi` (list, detail, not-found marker, landing card
present only with items, server render through `renderToString`).

**Commands to run** (bash; `$W` is your worktree's root as in slice A;
each line stands alone)

```bash
npm --prefix "$W/functions" ci --engine-strict=false
npm --prefix "$W/functions" run lint
npm --prefix "$W/functions" test -- src/lib/cms src/lib/interviews src/lib/public-reads src/lib/public-content-manifest src/lib/timers src/functions/route-inventory src/functions/function-inventory src/functions/registration-shims src/functions/api-contract
npm --prefix "$W/scripts" ci --engine-strict=false
npm --prefix "$W/scripts" test
npm --prefix "$W/frontend" ci --engine-strict=false
npm --prefix "$W/frontend" run lint
npm --prefix "$W/frontend" run format:check
npm --prefix "$W/frontend" run validate:routes
npm --prefix "$W/frontend" test -- src/pages/azure src/lib/interviews src/hooks src/components/interviews src/lib/csp
npm --prefix "$W/frontend" run build
python -I "$W/scripts/docs/check_redaction.py" "$W"
python -m mkdocs build --strict -f "$W/mkdocs.yml" -d "$TMP/1565-c-site"
```

**Must not touch:** `infra/`, `functions/src/lib/ai/*`,
`functions/src/lib/interviews/{storage,schema,gemini-files,transcribe,draft,draft-guard,fetch-audio,transcript-text}.js`
(B's), `functions/src/functions/interviews-jobs.js`,
`interviews-upload-http.js`, `frontend/src/pages/admin/*` (D's),
`frontend/src/config/adminNav.js`, `CHANGELOG.md`.

**Not verified by this slice:** the pages against the live API (the first
real interview in D proves it); the sitemap entry (appears after the next
manifest run and deploy).

## Slice D: the admin form, its page and the browser journey

**Owner agent:** `typescript-distinguished-engineer`. Reviewers before the
pull request: `typescript-test-engineer` (the Playwright journey) and
`typescript-security-reviewer` (the raw-body client, the token handling).
Starts after A, B and C have merged.

**Pull request title:** `Interviews: admin form, Q&A editor and browser journey (#1565)`

**Decisions it builds:** D7, D5's editing half, D13 for the CHANGELOG.

**Files to touch**

- `frontend/src/lib/api.js`: `putBytes(route, arrayBuffer, { headers })`
  (bearer token, `Content-Type: application/octet-stream`, `Content-Length`,
  a 60-second timeout, no retry). `frontend/src/lib/interviewUpload.js`:
  slice, three in flight, per-block retry (3 attempts), progress callback,
  and the whole-file SHA-256 computed incrementally over the same 4 MiB
  slices (`imageUpload.js`'s `sha256HexOf` reads the file into memory with
  `arrayBuffer()` and returns an empty string on failure; neither is
  acceptable for 500 MiB, so this helper hashes slice by slice and fails
  the upload when hashing is unavailable); `interviewUpload.test.js`
  covers the hash of a multi-slice file against a known digest and the
  refusal path.
- `frontend/src/pages/admin/InterviewsPage.jsx` (list),
  `InterviewNewPage.jsx` (the form), `InterviewEditPage.jsx` (the Q&A
  editor and stage panel), each at most 600 lines with a sibling
  `*.test.jsx` (`adminPagesBudget.test.js` enforces both), with the field
  components under `frontend/src/components/admin/interviews/`.
- `frontend/src/App.jsx`: `interviews`, `interviews/new`,
  `interviews/:interviewId` under `/admin`. `frontend/src/config/adminNav.js`:
  an `ITEMS` row `['pipeline', '/admin/interviews', Icon, 'Interviews',
  '...', { minRole: 'editor' }]`; `adminNav.test.js` and
  `adminRedirects.test.jsx` as they require.
- `frontend/e2e/interviews.spec.js`: sign in with the Entra stub, open
  `/admin/interviews/new`, fill the guest, tick consent with a date, paste
  a transcript, submit; answer `cms/interviews` (create),
  `cms/interviews/{id}/transcript`, `cms/interviews/{id}/draft` and the
  polled `cms/interviews/{id}` with stage `ready`; assert the Q&A editor
  shows the stubbed items and a `needsReview` flag; a second test uploads a
  small file and asserts the block PUTs and the complete call. Add the
  spec to the explicit list in `.github/workflows/ci.yml`.
- `CHANGELOG.md`, `[Unreleased]` → `### Added`: **four entries**, one per
  slice, each in the file's shape (`- **Headline ([#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565)).** Prose...`),
  written by D's agent from A, B and C's merged pull request descriptions
  and D's own, each ending with what was not verified. This is the only
  slice that edits the file.

**Commands to run** (bash; `$W` is your worktree's root as in slice A;
each line stands alone)

```bash
npm --prefix "$W/frontend" ci --engine-strict=false
npm --prefix "$W/frontend" run lint
npm --prefix "$W/frontend" run format:check
npm --prefix "$W/frontend" run validate:routes
npm --prefix "$W/frontend" test -- src/pages/admin src/lib/interviewUpload src/lib/api src/config
npx --prefix "$W/frontend" playwright test --config "$W/frontend/playwright.config.js" e2e/interviews.spec.js --project=chromium
```

**Must not touch:** `infra/`, `functions/` (if a route needs a change, open
it as a one-file follow-up on its owner slice's area, not inside D),
`frontend/src/pages/azure/*`, `docs/decisions/*`.

**Not verified by this slice:** the first real interview end to end (that is
the issue's last acceptance line and closes #1344: the owner uploads, the
session watches the job, reviews the draft with the owner, and publishes
from the admin).

## Order and parallelism, in one picture

```
day 1:  A ──┐        B ──┐        C ──┐        (three worktrees at once)
            ├─ merge A   │            │
                         ├─ rebase, merge B
                                      ├─ rebase, merge C
day 2:                                           D ── merge D ── first real interview (#1344)
owner:  confirm the HCP Terraform run after A merges (1 add, 1 change, 0 destroy)
```

A and B share `storage.js` by identical copy; B and C share `schema.js` by
ownership (B writes it, C imports it and stubs it in tests until the rebase);
everything else is disjoint by directory.

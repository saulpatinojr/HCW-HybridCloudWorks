/**
 * podcast-http.js — the podcast transcript admin surface (#435).
 *
 * Generation runs as the `generate-podcast-transcript` job (podcast-jobs.js);
 * the generate route here only enqueues it, through the same Storage Queue
 * output binding `enqueueJob` uses, so no new credential and no new service.
 * The other routes are the fast half — reading what was generated, and
 * approving it. The page that presents them is the Recording Hub (#442).
 *
 * Approval publishes to Podbean (#437, ADR 0029 §1b) — through a second job,
 * `publish-podcast-transcript`, for the same reason: an MP3 upload and an
 * episode create can take tens of seconds, and the client's own deadlines
 * sum past the HTTP budget. So the review route and the retry route both
 * carry the queue output binding, and both answer 202 with the job id when a
 * publish is in flight. Nothing on this surface writes `podcasts`: the feed
 * is the ingest boundary and the timer reads it.
 *
 * The podcast voice's own routes sit here too (#432, 2026-09-26): the
 * ElevenLabs plan and credits for the Audio tab, the ~300-character live
 * check, and (#725) the voice list and a voice's preview, which the Podcast
 * voices picker plays (lib/podcast/elevenlabs-admin.js).
 */
import { output } from '@azure/functions';
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { queryDocs, readDoc, upsertDoc, patchDoc, replaceDocIfMatch, createDoc } from '../lib/cosmos-client.js';
import { headBlobForDelivery, uploadBlob } from '../lib/blob-storage.js';
import { getCostEstimate, modelForTask } from '../lib/ai/router.js';
import { JOBS_QUEUE } from '../lib/jobs.js';
import { createPodcastHandlers } from '../lib/podcast/handlers.js';
import { createElevenLabsHandlers } from '../lib/podcast/elevenlabs-admin.js';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

const handlers = () =>
  createPodcastHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, upsertDoc, patchDoc, replaceDocIfMatch, createDoc },
  });

httpRoute('generatePodcastTranscript', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/podcast/transcripts/generate',
  extraOutputs: [queueOutput],
  handler: (request, context) =>
    handlers().generateTranscript(request, context, {
      enqueue: (message) => context.extraOutputs.set(queueOutput, message),
    }),
});

httpRoute('reviewPodcastTranscript', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/podcast/transcripts/review',
  extraOutputs: [queueOutput],
  handler: (request, context) =>
    handlers().reviewTranscript(request, context, {
      enqueue: (message) => context.extraOutputs.set(queueOutput, message),
    }),
});

// The retry: the same host step approval runs, on a transcript that is
// already published. Idempotent on the host episode id the document carries.
httpRoute('publishPodcastTranscript', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/podcast/transcripts/{id}/publish',
  extraOutputs: [queueOutput],
  handler: (request, context) =>
    handlers().publishTranscript(request, context, {
      enqueue: (message) => context.extraOutputs.set(queueOutput, message),
    }),
});

httpRoute('listPodcastTranscripts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/podcast/transcripts',
  handler: (request, context) => handlers().listTranscripts(request, context),
});

// What Podbean says now about the show and the episodes the records name,
// with thirty days of downloads each (#1115, lib/podcast/host-reads.js).
// Cached fifteen minutes in admin_config/podbean_host_overview; `?refresh=1`
// reads live. "Not configured" is a 200, not an error.
httpRoute('getPodcastHostOverview', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/podcast/host/overview',
  handler: (request, context) => handlers().getHostOverview(request, context),
});

// Registered after the literal `generate` and `review` routes so the static
// segments win; otherwise `cms/podcast/transcripts/review` would bind
// `id: 'review'`.
httpRoute('getPodcastTranscript', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/podcast/transcripts/{id}',
  handler: (request, context) => handlers().getTranscript(request, context),
});

const elevenLabs = () =>
  createElevenLabsHandlers({
    guard: getDefaultGuard(),
    // readDoc: the saved podcast voices (admin_config/podcast_voices) and the
    // last sample's record (admin_config/podcast_last_sample).
    store: { queryDocs, upsertDoc, readDoc },
    // headBlobForDelivery: whether the last sample's blob is still there.
    storage: { uploadBlob, headBlobForDelivery },
    // modelForTask: the podcastVoice task's model for the live check (ADR 0034 slice 5).
    ai: { getCostEstimate, modelForTask },
  });

// The Audio tab's ElevenLabs card: plan, credits used / limit, reset date,
// what the last render billed, and the last sample to replay for nothing.
// "Not configured" is a 200, not an error.
httpRoute('getElevenLabsStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/podcast/elevenlabs',
  handler: (request, context) => elevenLabs().getStatus(request, context),
});

// The owner's live check: a fixed two-turn sample under 300 characters,
// through the same path an episode takes. The caller sends no text.
httpRoute('renderElevenLabsSample', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/podcast/elevenlabs/sample',
  handler: (request, context) => elevenLabs().renderSample(request, context),
});

// The Podcast voices picker (#725): every voice this key may list, each
// marked usable on the plan or not, and why. Spends no credits.
httpRoute('listElevenLabsVoices', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/podcast/elevenlabs/voices',
  handler: (request, context) => elevenLabs().listVoices(request, context),
});

// One voice's preview MP3, so the owner can pick by ear without the site's
// CSP admitting a third-party media host. The caller names a voice id, never
// a URL, and only ElevenLabs's preview host is fetched.
httpRoute('previewElevenLabsVoice', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/podcast/elevenlabs/voices/{voiceId}/preview',
  handler: (request, context) => elevenLabs().previewVoice(request, context),
});

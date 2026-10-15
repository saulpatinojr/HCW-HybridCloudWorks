/**
 * draft-from-recording.js — one recording transcript in, a content draft out,
 * persisted and linked back to the recording. The semantics of
 * `createContentFromRecording` (issue #180, the last of the fifteen RPCs the
 * admin UI invoked without a route).
 *
 * What it reuses, on purpose:
 *   - `createDrafter().generateDraft` — the drafter the forge, the digest and
 *     generateArticleDraft already use, feature-gated as forgeDrafting. The
 *     transcript takes the place of scraped page markdown; the content type
 *     the editor picked becomes the drafter's admin instructions.
 *   - `createContentDocument` — the createContentItem write path (dedup 409,
 *     quality gate, document shape), so a recording-born draft is
 *     indistinguishable to the editor and the pipeline from any other.
 *
 * What it adds: the input contract (a recording that exists, a transcript
 * within limits, a known content type), the link back (`recordings/{id}` is
 * patched to `routed` with the contentId, so the state survives a client that
 * dies between the two calls RecordingsPage makes), and the error mapping.
 *
 * Runs inside the HTTP budget like generateArticleDraft: one model call over
 * at most MAX_TRANSCRIPT_CHARS of text, under the client's 90 s timeout. A
 * transcript longer than that belongs in a job, and the 413 says so.
 *
 * `requestedProvider` (RecordingsPage sends 'gemini') is recorded on the
 * document for provenance and is NOT honoured as a routing instruction: which
 * provider runs is the AI router's decision by configured order and key
 * presence (lib/ai/router.js), and the draft records the one that did.
 */
import { randomUUID } from 'node:crypto';
import { AuthoredError, authoredDetails, failureFields } from '../http/error-response.js';
import { inferProviderFromUrl } from './draft-from-url.js';
import { AFTER_MODEL_MARGIN_MS, startBudgetClock } from '../ai/time-budget.js';

/** Below this the model has nothing to work with; the UI has a transcript box. */
export const MIN_TRANSCRIPT_CHARS = 200;

/** ~100k tokens of English. One HTTP call; longer goes to a job (not built). */
export const MAX_TRANSCRIPT_CHARS = 400_000;

export const MAX_TITLE_CHARS = 300;

/**
 * The editor's dropdown (RecordingsPage.jsx CONTENT_TYPES) → publish type and
 * the instruction block the drafter gets. Keys are the contract; a value not
 * listed here is a 400, never a silent default.
 */
export const RECORDING_CONTENT_TYPES = Object.freeze({
  blog_post: {
    publishType: 'blog',
    instructions:
      'The source is a spoken-word transcript, not an article. Write a blog post that ' +
      'keeps the speaker’s arguments and examples, drops filler, false starts and ' +
      'crosstalk, and never quotes the transcript verbatim as if it were prose.',
  },
  technical_guide: {
    publishType: 'blog',
    instructions:
      'The source is a spoken-word transcript of a technical walkthrough. Write a ' +
      'step-ordered technical guide: prerequisites, numbered steps with the exact ' +
      'commands or settings named in the recording, verification, and pitfalls the ' +
      'speaker mentions. Do not invent commands the transcript does not contain.',
  },
  linkedin_post: {
    publishType: 'blog',
    instructions:
      'The source is a spoken-word transcript. Write a LinkedIn-length post ' +
      '(180–300 words) with one clear takeaway, no hashtags in the body, and the ' +
      'same keyTopics you would give a full article. postContent is the post itself.',
  },
  podcast_notes: {
    publishType: 'blog',
    instructions:
      'The source is a podcast episode transcript. Write show notes: a two-sentence ' +
      'episode summary, a timestamped outline if the transcript carries timestamps ' +
      '(omit timestamps otherwise), the key takeaways, and every resource or product ' +
      'the speakers name, as a list.',
  },
  meeting_summary: {
    publishType: 'blog',
    instructions:
      'The source is a meeting transcript. Write an internal-style summary: purpose, ' +
      'decisions taken, open questions, and action items with the owner named when ' +
      'the transcript names one. Keep it factual; no editorialising.',
  },
});

const STATUS_BY_CODE = Object.freeze({
  BAD_INPUT: 400,
  RECORDING_NOT_FOUND: 404,
  TRANSCRIPT_TOO_SHORT: 422,
  TRANSCRIPT_TOO_LONG: 413,
  PERSIST_REJECTED: null, // carries its own status
  AI_FEATURE_DISABLED: 503,
  AI_NOT_CONFIGURED: 503,
  DRAFT_BUDGET_EXCEEDED: 504,
  AI_BUDGET_EXHAUSTED: 504,
});

/** Same ceiling as generateArticleDraft: the client aborts at 90 s. Less
 * AFTER_MODEL_MARGIN_MS (the content write and the link-back), it is also the
 * AI router's budget, so a slow first provider fails over inside it
 * (router.js header, SYNCHRONOUS CALLS HAVE A TIME BUDGET). */
export const RECORDING_DRAFT_HTTP_BUDGET_MS = 75000;

/**
 * A refusal of the recording drafter. Every sentence is written in this
 * module (or is content-create's own answer, for PERSIST_REJECTED), so the
 * route may show it and its `details` (#945).
 */
export class RecordingDraftError extends AuthoredError {}

/**
 * One coded refusal.
 *
 * @param {string} code - machine-readable reason, mapped to a status
 * @param {string} message - the authored sentence
 * @param {object} [extra] - `status`, `details`
 * @returns {RecordingDraftError}
 */
function coded(code, message, extra = {}) {
  return Object.assign(new RecordingDraftError(message, { code }), extra);
}

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Cloud provider for the draft: the caller's explicit value when it is one of
 * KNOWN_CLOUD_PROVIDERS (case-insensitive, stored in canonical case), else inferred from the title and the opening of the
 * transcript with the same keyword map the URL path uses, else 'Multi'.
 */
export const KNOWN_CLOUD_PROVIDERS = Object.freeze([
  'Azure',
  'Aws',
  'Gcp',
  'Github',
  'Terraform',
  'Finops',
  'Docker',
  'Multi',
]);

export function inferProviderFromRecording({ cloudProvider, title, transcript }) {
  const explicit = String(cloudProvider || '').trim();
  const known = KNOWN_CLOUD_PROVIDERS.find((p) => p.toLowerCase() === explicit.toLowerCase());
  if (known) return known;
  return inferProviderFromUrl(`${title || ''} ${String(transcript || '').slice(0, 4000)}`);
}

/**
 * Validate the request body into the shape the drafter needs. Throws coded
 * errors; returns `{ recordingId, title, transcript, contentType, requestedProvider, cloudProvider }`
 * with `transcript` possibly null (to be taken from the stored recording).
 */
export function parseRecordingRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw coded('BAD_INPUT', 'A JSON body is required.');
  }
  const recordingId = String(body.recordingId || '').trim();
  if (!recordingId || recordingId.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(recordingId)) {
    throw coded('BAD_INPUT', 'recordingId is required and must be an identifier.');
  }
  const contentType = String(body.contentType || '').trim();
  if (!RECORDING_CONTENT_TYPES[contentType]) {
    throw coded(
      'BAD_INPUT',
      `contentType must be one of: ${Object.keys(RECORDING_CONTENT_TYPES).join(', ')}.`
    );
  }
  const title = String(body.title || '')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
  const transcript = typeof body.transcript === 'string' ? body.transcript : null;
  const requestedProvider = String(body.provider || '')
    .trim()
    .slice(0, 40);
  const cloudProvider = String(body.cloudProvider || '')
    .trim()
    .slice(0, 40);
  return { recordingId, title, transcript, contentType, requestedProvider, cloudProvider };
}

/**
 * @param {object} deps
 * @param {{ generateDraft: Function }} deps.drafter   createDrafter()
 * @param {{ readDoc: Function, patchDoc: Function, queryDocs: Function, upsertDoc: Function }} deps.store
 * @param {Function} [deps.persist]  createContentDocument (injected for tests)
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createRecordingDrafter({
  drafter,
  store,
  persist,
  now = () => new Date(),
  uuid = randomUUID,
  log = {},
}) {
  if (typeof persist !== 'function') {
    throw new Error('createRecordingDrafter requires persist (createContentDocument)');
  }

  // `budgetMs` sits beside `user`, never in `body`: the body is the client's
  // JSON, and a client must not choose its own time budget.
  async function draftFromRecording(body, { user, budgetMs = null } = {}) {
    const budgetLeft = startBudgetClock(budgetMs);
    const input = parseRecordingRequest(body);

    const recording = await store.readDoc('recordings', input.recordingId, input.recordingId);
    if (!recording) {
      throw coded('RECORDING_NOT_FOUND', `recording ${input.recordingId} not found`);
    }

    const transcript = String(input.transcript ?? recording.transcript ?? '').trim();
    if (transcript.length < MIN_TRANSCRIPT_CHARS) {
      throw coded(
        'TRANSCRIPT_TOO_SHORT',
        `The transcript has ${transcript.length} characters; at least ${MIN_TRANSCRIPT_CHARS} are needed to draft from.`
      );
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      throw coded(
        'TRANSCRIPT_TOO_LONG',
        `The transcript has ${transcript.length} characters; the HTTP path takes at most ${MAX_TRANSCRIPT_CHARS}. Split the recording.`
      );
    }

    const title = input.title || String(recording.title || '').trim() || 'Untitled recording';
    const type = RECORDING_CONTENT_TYPES[input.contentType];
    const cloudProvider = inferProviderFromRecording({
      cloudProvider: input.cloudProvider,
      title,
      transcript,
    });

    const usage = [];
    const parsed = await drafter.generateDraft({
      url: `recording:${input.recordingId}`,
      cloudProvider,
      scrapedTitle: title,
      description: `Transcript of a recording titled "${title}" (${input.contentType.replace('_', ' ')}).`,
      markdown: transcript,
      customInstructionPrompt: type.instructions,
      usageOut: usage,
      budgetMs: budgetLeft(),
    });

    const postContent = String(parsed?.postContent || '').trim();
    if (!postContent) {
      throw coded('DRAFT_EMPTY', 'The model returned no postContent for this transcript.');
    }

    const stamp = now().toISOString();
    const result = await persist({
      store,
      user,
      now,
      uuid,
      // The critique is the editor's call at review time, as it is for the
      // forge; running it here would double the model cost of every routing.
      runEditorialCritique: false,
      data: {
        type: type.publishType,
        Title: String(parsed.title || title).slice(0, MAX_TITLE_CHARS),
        title: String(parsed.title || title).slice(0, MAX_TITLE_CHARS),
        Summary: String(parsed.summary || ''),
        summary: String(parsed.summary || ''),
        Content: postContent,
        content: postContent,
        postContent,
        Author: 'Hybrid Cloud Works',
        'Cloud Provider': cloudProvider,
        Tags: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.slice(0, 12).map(String) : [],
        keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.slice(0, 12).map(String) : [],
        summaryPrompt: String(parsed.summaryPrompt || ''),
        detailsPrompt: String(parsed.detailsPrompt || ''),
        suggestedContentType: parsed.suggestedContentType || null,
        Live: false,
        Status: 'Draft',
        contentStatus: 'draft',
        source: 'recording',
        sourceTrustLevel: 'manual',
        trustedSource: true,
        sourceRecordingId: input.recordingId,
        recordingContentType: input.contentType,
        requestedAiProvider: input.requestedProvider || null,
        aiProvider: parsed.aiProvider || null,
        aiModel: parsed.aiModel || null,
        format: parsed.format || null,
        approvedForNews: false,
        routedAt: stamp,
      },
    });
    if (result.status !== 200) {
      throw coded('PERSIST_REJECTED', result.body?.error || 'Content was not created', {
        status: result.status,
        details: result.body,
      });
    }
    const contentId = result.body.contentId;

    // The link back, best-effort. RecordingsPage PATCHes the same fields after
    // the response, so this write is belt-and-braces for a client that dies in
    // between — and a failure here must not turn a created draft into a 5xx,
    // which would invite a retry and a duplicate. The response says whether
    // the link landed.
    let linked = true;
    try {
      await store.patchDoc('recordings', input.recordingId, {
        status: 'routed',
        contentId,
        routedAt: stamp,
        routedContentType: input.contentType,
      });
    } catch (error) {
      linked = false;
      log.warn?.(
        `[createContentFromRecording] draft created but the recording link-back failed (${error?.code || error?.name || 'error'}); the client PATCH will set it`
      );
    }

    // Content-free: type and provider only. Identifiers stay out of the trace,
    // as everywhere else in this package.
    log.log?.(
      `[createContentFromRecording] drafted (${input.contentType}, ${parsed.aiProvider || 'provider unknown'})`
    );
    return {
      contentId,
      linked,
      draft: {
        title: parsed.title || title,
        summary: parsed.summary || '',
        keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics : [],
        aiProvider: parsed.aiProvider || null,
        cloudProvider,
      },
    };
  }

  return { draftFromRecording };
}

function withBudget(promise, budgetMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        coded(
          'DRAFT_BUDGET_EXCEEDED',
          `Drafting from the recording exceeded ${Math.round(budgetMs / 1000)} s. Try again, or shorten the transcript.`
        )
      );
    }, budgetMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * POST /api/createContentFromRecording — the HTTP shape over
 * draftFromRecording. Editor-gated like every content RPC. Response on
 * success `{ ok: true, contentId, draft }` — RecordingsPage reads contentId.
 * Errors map by code: 400 bad input, 404 unknown recording, 413/422
 * transcript out of range, 409/422 from the persistence path (duplicate,
 * quality), 503 AI disabled or unconfigured, 504 budget, 502 anything else.
 */
export function createContentFromRecordingHandler({
  guard,
  recordingDrafter,
  budgetMs = RECORDING_DRAFT_HTTP_BUDGET_MS,
}) {
  return async function createContentFromRecording(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => null);
    try {
      const result = await withBudget(
        recordingDrafter.draftFromRecording(body, {
          user: auth.user,
          budgetMs: budgetMs - AFTER_MODEL_MARGIN_MS,
        }),
        budgetMs
      );
      return json(200, { ok: true, ...result });
    } catch (error) {
      const code = error?.code;
      const status =
        code === 'PERSIST_REJECTED' ? error.status || 422 : STATUS_BY_CODE[code] || 502;
      // The drafter's and the router's refusals are authored and shown; a
      // provider's or the store's own words are not (#945). The log line is
      // content-free: the code and the correlation id.
      const details = authoredDetails(error);
      return json(status, {
        ...failureFields(
          context,
          'The draft could not be created from this recording.',
          error,
          request
        ),
        code: code || 'GENERATION_FAILED',
        ...(details ? { details } : {}),
      });
    }
  };
}

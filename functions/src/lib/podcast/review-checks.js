/**
 * review-checks.js — the checks the podcast hub's routes (handlers.js) make
 * before they change anything: a JSON body, a review's status and id, and
 * the refusals for a missing transcript, an unapproved one, or audio made
 * on ElevenLabs' free plan. Each answer is a response object, or null when
 * the request may go on.
 */
import { parseTranscriptId } from './publish-transcript.js';
import { freePlanRefusal } from './speech-licence.js';
import { STATUS } from './store.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The 409 for ElevenLabs free-plan audio (speech-licence.js), or null. */
export function licenceRefusal(doc, context, route) {
  const licence = freePlanRefusal(doc);
  if (!licence) return null;
  context.log?.(`${route}: refused (free_plan_licence)`);
  return json(409, { error: licence, code: 'FREE_PLAN_LICENCE' });
}

/**
 * Why a review may not proceed, as a response, or null. A missing transcript
 * is 404. Approving free-plan audio is 409, checked before the status write
 * so the refusal changes nothing and queues no host step. Withdrawing to
 * draft is never refused.
 */
export function reviewRefusal(existing, { id, status, context }) {
  if (!existing) return json(404, { error: `No podcast transcript ${id}` });
  if (status !== STATUS.published) return null;
  return licenceRefusal(existing, context, 'reviewPodcastTranscript');
}

/**
 * Why a publish retry may not proceed, as a response, or null: a missing
 * transcript (404), one that is not approved (409 — approval is what
 * publishes), or approved free-plan audio (409).
 */
export function retryRefusal(doc, { id, context }) {
  if (!doc) return json(404, { error: `No podcast transcript ${id}` });
  if (doc.status !== STATUS.published) {
    return json(409, {
      error:
        `Podcast transcript ${id} is ${doc.status || 'not published'}; ` +
        'approve it first — publishing to Podbean is what approval does.',
    });
  }
  return licenceRefusal(doc, context, 'publishPodcastTranscript');
}

/** The request's JSON object, or null when the body is not one. */
export async function readBodyObject(request) {
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' ? body : null;
}

/** A review request's status and id: `{ status, id }`, or `{ response }` with the 400. */
export async function readReview(request) {
  const body = await readBodyObject(request);
  if (!body) return { response: json(400, { error: 'Body must be a JSON object' }) };
  const status = String(body.status || '').trim();
  // 'failed' is written by the generator, never chosen by a reviewer:
  // `draft` is how a reviewer withdraws one, and it leaves a record.
  if (status !== STATUS.published && status !== STATUS.draft) {
    return {
      response: json(400, {
        error: `status must be "${STATUS.published}" or "${STATUS.draft}"`,
      }),
    };
  }
  // The worker's validator (Cosmos's 1,023-byte id bound), so an
  // oversized id is a 400 with the job's own sentence, not a 500.
  const parsedId = parseTranscriptId(body.id, { field: 'id' });
  if (parsedId.error) return { response: json(400, { error: parsedId.error }) };
  return { status, id: parsedId.value };
}


/**
 * What every Listen & Learn route shares (PR #841 split of handlers.js):
 * the JSON reply and the refusal shape, the route and body readers, the
 * guard scaffold, the store reads bound by the factory, the job enqueue and
 * the speech estimate.
 *
 * SHAPE OF A ROUTE. Every route is `guarded(...)`: the role guard, then the
 * route body, with any throw logged and answered as a 500. The body reads
 * the route and the request body through `readRequest`, which answers the
 * first thing wrong as one refusal, so a route is one guard, the store reads
 * it needs, and one success — the validation rules themselves live in
 * library.js, where they are tested without a store.
 */
import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
// The one body-shape test the other admin writers use: an object, not null,
// not an array. A JSON array passes `typeof === 'object'` and then fails on
// a field message that names the wrong problem.
import { isPlainObject } from '../cms/content-update-validation.js';
import { EPISODE_CONTAINER, SET_CONTAINER, setId, speakableTextOf } from './publish.js';
import { voiceSettingsOf } from './speech-settings.js';
import { estimateSpeechCostUsd } from './speech/index.js';

export const PRODUCT = 'listenAndLearn';

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** A refusal on its way to `json(status, { error })`. */
export const refuse = (status, error) => ({ ok: false, status, error });

/**
 * Ceilings, not page sizes. A certification has at most eight areas and the
 * site has tens of certifications; anything past these means a container has
 * run away, which is the case being defended against.
 */
export const MAX_SETS = 200;
export const MAX_EPISODES_PER_SET = 50;
/** Every chapter row across every book, projected to five fields. */
export const MAX_CHAPTER_ROWS = 5000;

/** Study-guide order, which is the order episodes are meant to be heard in. */
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

export const isSoftDeleted = (doc) => Boolean(doc?.softDeletedAt || doc?.softDeleteExpiresAt);

const CHAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,120}$/;
const VERSION_ID_PATTERN = /^[a-z0-9]{1,20}$/i;

/** `platform` and `examCode` from the route, lower-cased and trimmed, or null. */
function routeSet(request) {
  const platform = String(request.params?.platform || '')
    .trim()
    .toLowerCase();
  const examCode = String(request.params?.examCode || '').trim();
  if (!platform || !examCode) return null;
  return { platform, examCode, id: setId(platform, examCode) };
}

export function truthyQuery(request, name) {
  const value = String(request.query?.get?.(name) ?? '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

const ROUTE_REQUIRED = Object.freeze({
  set: 'platform and examCode are required',
  chapter: 'platform, examCode and chapterId are required',
  version: 'platform, examCode, chapterId and versionId are required',
});

/**
 * The set, chapter and version the route names, each validated as far as the
 * route goes: `/{platform}/{examCode}`, then `/chapters/{chapterId}`, then
 * `/versions/{versionId}`. One 400 names everything the route needed.
 */
export function readRoute(request, { chapter = false, version = false } = {}) {
  const ref = routeSet(request);
  const chapterId = String(request.params?.chapterId || '').trim();
  const versionId = String(request.params?.versionId || '').trim();
  const shape = version ? 'version' : chapter ? 'chapter' : 'set';
  const idsValid = {
    set: () => true,
    chapter: () => CHAPTER_ID_PATTERN.test(chapterId),
    version: () => CHAPTER_ID_PATTERN.test(chapterId) && VERSION_ID_PATTERN.test(versionId),
  };
  if (!ref || !idsValid[shape]()) return refuse(400, ROUTE_REQUIRED[shape]);
  return { ok: true, ref, chapterId, versionId };
}

/** A JSON object body run through `parse` (`{ value } | { error }`). */
export function parseBody(body, parse) {
  if (!isPlainObject(body)) return refuse(400, 'Body must be a JSON object');
  const parsed = parse(body);
  return parsed.error ? refuse(400, parsed.error) : { ok: true, body, parsed: parsed.value };
}

/** `readRoute` then the body — in that order, as the routes always checked. */
export async function readRequest(
  request,
  { chapter = false, version = false, parse = null, emptyBody = false } = {}
) {
  const route = readRoute(request, { chapter, version });
  if (!route.ok || !parse) return route;
  const body = (await request.json().catch(() => null)) ?? (emptyBody ? {} : null);
  const read = parseBody(body, parse);
  return read.ok ? { ...route, ...read } : read;
}

export const noSetMessage = (ref) => `No Listen & Learn set for ${ref.platform}/${ref.examCode}`;
export const noChapterMessage = (ref, chapterId) => `No chapter ${chapterId} in ${ref.id}`;

/** What a route answers when the job it would queue is over its type's payload bound. */
export const TOO_LARGE_TO_QUEUE =
  'That request is too large to queue as one job. Shorten it, or split it into smaller parts, and try again.';

/**
 * The scaffold every route shares: the role guard, then the route body,
 * with any throw logged under `label` and answered as a 500 carrying
 * `message`. The body answers everything else.
 *
 * The one throw that is the caller's to fix is newJobDoc's
 * JOB_PAYLOAD_TOO_LARGE (#942): a job document over its type's payload
 * bound. That is answered 413 with a fixed sentence, keyed on the code
 * newJobDoc sets rather than on any `status` an error happens to carry, so
 * a 413 from somewhere else is not passed off as the caller's.
 */
export const guardedWith =
  (guard) =>
  (role, label, message, run) =>
  async (request, context, io = {}) => {
    const auth = await guard.requireRole(request, role);
    if (auth.error) return auth.error;
    try {
      return await run({ request, context, auth, io });
    } catch (error) {
      if (error?.code === 'JOB_PAYLOAD_TOO_LARGE') {
        context.warn?.(`${label} refused: JOB_PAYLOAD_TOO_LARGE`);
        return json(413, { error: TOO_LARGE_TO_QUEUE });
      }
      context.error(`${label} failed:`, error);
      return json(500, { error: message });
    }
  };

// ── store reads the routes share, bound to the store by the factory ─────────

/** Read a set and its live chapters, or the 404 to answer with. */
export async function loadSetFrom(store, ref) {
  const [set, rows] = await Promise.all([
    store.readDoc(SET_CONTAINER, ref.id, ref.id),
    store.queryDocs(
      EPISODE_CONTAINER,
      `SELECT TOP ${MAX_EPISODES_PER_SET} * FROM c WHERE c.setId = @setId`,
      [{ name: '@setId', value: ref.id }]
    ),
  ]);
  const chapters = rows.filter((doc) => !isSoftDeleted(doc));
  if ((!set || isSoftDeleted(set)) && chapters.length === 0) return { missing: true };
  return { set: set && !isSoftDeleted(set) ? set : null, chapters: [...chapters].sort(byOrder) };
}

/** One chapter in a set, or null; soft-deleted reads as absent. */
export async function loadChapterFrom(store, ref, chapterId) {
  const doc = await store.readDoc(EPISODE_CONTAINER, chapterId, ref.id);
  return doc && !isSoftDeleted(doc) ? doc : null;
}

/**
 * The text a new chapter speaks: as pasted, or read from the content item
 * it names with the markup dropped — a missing item is a 404, an item with
 * no body is a 400.
 */
export async function resolveChapterTextFrom(store, { sourceText, contentId }) {
  if (sourceText || !contentId) return { ok: true, sourceText };
  const item = await store.readDoc('content', contentId, contentId);
  if (!item) return refuse(404, `content ${contentId} not found`);
  const text = speakableTextOf(item);
  return text
    ? { ok: true, sourceText: text }
    : refuse(400, 'That content item has no body text to speak');
}

/** One past the highest `order` among the set's live chapters. */
export async function nextChapterOrderIn(store, ref) {
  const siblings = await store.queryDocs(
    EPISODE_CONTAINER,
    `SELECT TOP ${MAX_EPISODES_PER_SET} c.id, c["order"], c.softDeletedAt FROM c WHERE c.setId = @setId`,
    [{ name: '@setId', value: ref.id }]
  );
  return (
    siblings.filter((s) => !isSoftDeleted(s)).reduce((max, s) => Math.max(max, s.order ?? 0), -1) +
    1
  );
}

/** Write a job document and queue it; the 202 body every enqueue answers. */
export async function queueJob(
  { store, uuid, stamp },
  { type, payload, user, enqueue, extra = {} }
) {
  const jobId = uuid();
  const doc = newJobDoc({ id: jobId, type, payload, requestedBy: user, createdAt: stamp() });
  await store.upsertDoc(JOBS_CONTAINER, doc);
  enqueue({ jobId, type });
  return json(202, {
    ok: true,
    jobId,
    type,
    status: 'queued',
    poll: `getJob?jobId=${jobId}`,
    ...extra,
  });
}

/**
 * What speaking `bytes` of text would cost for a book, before it is spent:
 * the book's provider, and the `listenAndLearnSpeech` task's model read
 * through the router (ADR 0034 slice 5, #860) — the same resolution the
 * worker applies (listen-and-learn-jobs.js resolveRunModel). With no router
 * wired, or a task with nothing eligible, the model is null and the switch
 * prices its own default. Null when no provider would run, which the page
 * shows as "transcript only".
 */
export async function estimateFor({ env, ai = null }, set, { bytes }) {
  const voice = voiceSettingsOf(set);
  const model = await taskModelOrNull(ai);
  const estimate = estimateSpeechCostUsd({
    product: PRODUCT,
    ceilingBytes: bytes,
    model,
    provider: voice.provider === 'auto' ? null : voice.provider,
    env,
  });
  return estimate
    ? {
        provider: estimate.provider,
        model: estimate.model,
        bytes: estimate.bytes,
        estimatedCostUsd: estimate.estimatedCostUsd,
      }
    : { provider: null, model, bytes, estimatedCostUsd: null };
}

/**
 * The `listenAndLearnSpeech` task's model, or null: no router wired, nothing
 * eligible, or the task switched off — an estimate is a figure shown before
 * spending and must not fail the page for want of it; the run itself says
 * why (listen-and-learn-jobs.js resolveRunModel).
 */
async function taskModelOrNull(ai) {
  if (typeof ai?.modelForTask !== 'function') return null;
  try {
    const chosen = await ai.modelForTask({ task: 'listenAndLearnSpeech' });
    return chosen?.model || null;
  } catch {
    return null;
  }
}

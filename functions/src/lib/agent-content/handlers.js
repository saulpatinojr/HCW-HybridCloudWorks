/**
 * agent-content/handlers.js — what Koda's key can do (ADR 0037).
 *
 * The routes under /api/agent-content/v1/ are the Drafts stage's own routes
 * (cms/drafts-handlers.js) and the public reads (public-reads.js), reached
 * with the agent key instead of an admin sign-in. Nothing is reimplemented:
 * each Drafts route is created with the key guard standing in for the role
 * guard (guard.js asRoleGuard), one handler set per capability, so a draft
 * Koda writes gets the same field allow-list, size caps, etag protection,
 * title dedup, refusals and audit rows the owner's own page gets, with
 * `koda (agent)` as createdBy and updatedBy and `draftOrigin: 'agent'`.
 *
 * What Koda cannot do is what the Drafts routes cannot do: set a slug, a
 * workflow field or anything a public read keys on, publish, unpublish, or
 * touch anything live (drafts.js DRAFT_INVARIANTS and the refusals in
 * drafts-stage.js). There is no route for it to call.
 */
import { createDraftsHandlers } from '../cms/drafts-handlers.js';
import { DRAFT_ORIGINS } from '../cms/drafts-stage.js';
import { MAX_DRAFT_BODY_BYTES } from '../cms/drafts.js';
import { MAX_LISTED_DRAFTS } from '../cms/drafts-handlers.js';
import { createPublicReadHandlers } from '../public-reads.js';
import { errorResponse } from '../http/error-response.js';
import { AGENT_ID, API_BASE_PATH, REQUESTS_PER_MINUTE, enabledCapabilities } from './keys.js';

/** The ideaOrigin a draft Koda creates carries when Koda names none (taxonomy.js DEFAULT_IDEA_ORIGINS). */
export const AGENT_DEFAULT_IDEA_ORIGIN = 'ai-recommendation';

/** The surface, as the status route describes it to the connector. Method, path and the capability each needs. */
export const ENDPOINTS = Object.freeze([
  ['GET', 'status', null],
  ['GET', 'drafts', 'drafts.read'],
  ['GET', 'drafts/{id}', 'drafts.read'],
  ['POST', 'drafts', 'drafts.write'],
  ['POST', 'drafts/from-markdown', 'drafts.write'],
  ['PUT', 'drafts/{id}', 'drafts.write'],
  ['POST', 'drafts/{id}/send-to-review', 'drafts.review'],
  ['POST', 'drafts/{id}/back-to-drafts', 'drafts.review'],
  ['DELETE', 'drafts/{id}', 'drafts.delete'],
  ['GET', 'published', 'published.read'],
  ['GET', 'published/{slugOrId}', 'published.read'],
]);

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The limits the status route states, so the connector can read them instead of guessing. */
export const LIMITS = Object.freeze({
  requestsPerMinute: REQUESTS_PER_MINUTE,
  maxBodyBytes: MAX_DRAFT_BODY_BYTES,
  maxListedDrafts: MAX_LISTED_DRAFTS,
});

/**
 * @param {object} deps
 * @param {{ authenticate: Function, requireCapability: Function, asRoleGuard: Function }} deps.guard
 * @param {object} deps.store the Drafts routes' store (drafts-handlers.js createDraftsHandlers)
 * @param {{ queryDocs: Function, readDoc: Function }} deps.publicStore the public reads' store
 * @param {(contentId: string) => Promise<unknown>} [deps.onContentDeleted]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {object} [deps.log]
 */
export function createAgentContentHandlers({
  guard,
  store,
  publicStore,
  onContentDeleted = null,
  now,
  uuid,
  log = {},
}) {
  const drafts = (capability) =>
    createDraftsHandlers({
      guard: guard.asRoleGuard(capability),
      store,
      onContentDeleted,
      ...(now ? { now } : {}),
      ...(uuid ? { uuid } : {}),
      log,
      origin: DRAFT_ORIGINS.agent,
      defaultIdeaOrigin: AGENT_DEFAULT_IDEA_ORIGIN,
    });
  const reads = drafts('drafts.read');
  const writes = drafts('drafts.write');
  const reviews = drafts('drafts.review');
  const deletes = drafts('drafts.delete');
  const published = createPublicReadHandlers({ store: publicStore });

  // A store fault in the guard (the key read, the counter) is the
  // repository's content-free 500, as the Drafts routes answer it, never a
  // throw into the host.
  const guarded = (what, check, work) => async (request, context) => {
    try {
      const auth = await check(request);
      if (auth.error) return auth.error;
      return await work(request, context, auth);
    } catch (error) {
      return errorResponse(context, `Failed to ${what}`, error, 500);
    }
  };
  const withCapability = (capability, what, work) =>
    guarded(what, (request) => guard.requireCapability(request, capability), work);

  return {
    /** GET status — the harmless first call the connector makes: who this is and what the key may do. */
    status: guarded('read the agent status', (request) => guard.authenticate(request), async (request, context, auth) =>
      json(200, {
        ok: true,
        agent: AGENT_ID,
        keyHint: auth.record.keyHint || null,
        capabilities: enabledCapabilities(auth.record),
        limits: LIMITS,
        basePath: `/api/${API_BASE_PATH}`,
        endpoints: ENDPOINTS.map(([method, path, capability]) => ({ method, path, capability })),
      }),
    ),
    listDrafts: reads.list,
    getDraft: reads.get,
    createDraft: writes.create,
    createDraftFromMarkdown: writes.createFromMarkdown,
    saveDraft: writes.update,
    deleteDraft: deletes.remove,
    sendToReview: reviews.sendToReview,
    backToDrafts: reviews.backToDrafts,
    listPublished: withCapability('published.read', 'list the published posts', (request, context) =>
      published.listContent(request, context),
    ),
    getPublished: withCapability('published.read', 'read the published post', (request, context) =>
      published.getContent(request, context),
    ),
  };
}

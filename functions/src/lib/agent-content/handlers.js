/**
 * agent-content/handlers.js — what Koda's key can do (ADR 0037).
 *
 * The routes under /api/agent-content/v1/ are the Drafts stage's own routes
 * (cms/drafts-handlers.js) and the public reads (public-reads.js), reached
 * with the agent key instead of an admin sign-in. Nothing is reimplemented:
 * the key guard verifies the key and the route's capability, then the Drafts
 * handlers run with that identity in the role guard's place, so a draft Koda
 * writes gets the same field allow-list, size caps, etag protection, title
 * dedup, refusals and audit rows the owner's own page gets, with
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

/** What the transition audit rows record as the credential for Koda's moves. */
export const AGENT_AUTH_METHOD = 'agent_key';

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

/** Is the key's "Read drafts" switch on? Absent switches are on (keys.js). */
const canRead = (record) => record?.capabilities?.['drafts.read'] !== false;

/**
 * The same answer without the draft's text: `draft.fields` (the eight editor
 * fields, body included) is replaced by `bodyWithheld: true`. The summary
 * fields (id, title, stage, etag, actions) stay, because a caller that may
 * write needs the etag to write again.
 */
export function withoutBody(response) {
  if (!response || typeof response.body !== 'string') return response;
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return response;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.draft || !('fields' in parsed.draft)) return response;
  const { fields: _withheld, ...rest } = parsed.draft;
  return { ...response, body: JSON.stringify({ ...parsed, draft: { ...rest, bodyWithheld: true } }) };
}

/**
 * @param {object} deps
 * @param {{ authenticate: Function, requireCapability: Function }} deps.guard
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
  const published = createPublicReadHandlers({ store: publicStore });

  // Every route: the key's gates and the route's capability first, inside
  // the try, so a store fault in the guard (the key read, the counter) is the
  // repository's content-free 500 and never a throw into the host; then the
  // work. The Drafts handlers are created per request with a guard that
  // hands back the identity already verified here, so nothing is checked
  // twice and nothing is counted twice.
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

  const draftsFor = (auth) =>
    createDraftsHandlers({
      guard: { requireRole: async () => ({ user: auth.user, role: 'editor', error: null }) },
      store,
      onContentDeleted,
      ...(now ? { now } : {}),
      ...(uuid ? { uuid } : {}),
      log,
      origin: DRAFT_ORIGINS.agent,
      defaultIdeaOrigin: AGENT_DEFAULT_IDEA_ORIGIN,
      authMethod: AGENT_AUTH_METHOD,
    });

  /**
   * A Drafts route under one capability. A write, review or delete answers
   * with the draft as the page would see it, body included; a key whose
   * "Read drafts" switch is off is told the outcome without the text, so the
   * read switch means what it says even for a caller that may write.
   */
  const draftRoute = (capability, what, action) =>
    withCapability(capability, what, async (request, context, auth) => {
      const response = await draftsFor(auth)[action](request, context);
      return capability !== 'drafts.read' && !canRead(auth.record) ? withoutBody(response) : response;
    });

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
    listDrafts: draftRoute('drafts.read', 'list the drafts', 'list'),
    getDraft: draftRoute('drafts.read', 'read the draft', 'get'),
    createDraft: draftRoute('drafts.write', 'create the draft', 'create'),
    createDraftFromMarkdown: draftRoute('drafts.write', 'create the draft from the markdown file', 'createFromMarkdown'),
    saveDraft: draftRoute('drafts.write', 'save the draft', 'update'),
    deleteDraft: draftRoute('drafts.delete', 'delete the draft', 'remove'),
    sendToReview: draftRoute('drafts.review', 'send the draft to review', 'sendToReview'),
    backToDrafts: draftRoute('drafts.review', 'move the article back to Drafts', 'backToDrafts'),
    listPublished: withCapability('published.read', 'list the published posts', (request, context) =>
      published.listContent(request, context),
    ),
    getPublished: withCapability('published.read', 'read the published post', (request, context) =>
      published.getContent(request, context),
    ),
  };
}

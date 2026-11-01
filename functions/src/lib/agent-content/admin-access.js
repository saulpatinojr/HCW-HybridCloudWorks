/**
 * agent-content/admin-access.js — the admin routes Koda's key may call, and
 * the guard wrapper that lets it (ADR 0038).
 *
 * ADR 0037 kept Koda's key out of every `/api/cms/*` route on purpose: the
 * key passed nothing that called `requireRole`. The owner's instruction of
 * 2026-11-01 widened Koda's job from "write drafts" to "work the Pipeline,
 * Enhanced, Spotlight and Second Brain sections and read Platform health and
 * integrations", creating and reviewing but never deleting. Mirroring a
 * hundred routes under /api/agent-content/v1 would have been a second copy
 * of every handler, so the key is instead accepted by the admin role guard
 * itself, through `withAgentAccess`, and only for the routes in `POLICY`.
 *
 * The rules, all enforced here and tested in admin-access.test.js:
 *
 *   - A DELETE is never allowed, whatever the route. A POST or PUT that
 *     deletes or trashes (deleteContentItem, softDeleteLivePage, the
 *     doc-vault DELETE) is simply not in the table.
 *   - Publishing stays a human act (ADR 0037): publishContent,
 *     saveContentSchedule, unscheduleContent, unpublishContentToInspected,
 *     the slug and rehost writes, and the podcast publish are not listed, and
 *     a `transitionContentStatus` to `published` or `archived`, an
 *     `enqueueJob` of `publish-content`, and a `createContentItem` asking to
 *     be born published are refused by the body rules below.
 *   - Settings, secrets, credentials, admins, AI routing, MCP, the lab agent
 *     registry, the Coder token and every Amplify route are not listed: the
 *     owner named the sections Koda works in, and those are not among them.
 *   - Each route belongs to a section switch on the Koda tab
 *     (keys.js CAPABILITIES, the `admin.*` ids). A section that is off
 *     refuses its routes with 403 and an audit row, like a capability.
 *   - The key acts as `koda (agent)` everywhere except the Second Brain,
 *     which is the owner's private workspace partitioned by the owner's
 *     object id: there the key acts as the owner (`asOwner`), so the notes
 *     it writes land in the owner's partition. Audit rows still say which
 *     key did it.
 *   - The role each route requires is the role the policy grants: `editor`
 *     for nearly everything, `publisher` for the Doc Vault (whose reads
 *     already need it) and `viewer` for the health reads. A route whose
 *     handler asks for more than the grant is refused with 403.
 *
 * Every refusal of a presented key is an `admin_audit_logs` row of kind
 * agent-content-denial with `surface: 'admin'`, the reason
 * (`route-not-allowed`, `section-off`, `role`, `body-not-allowed`,
 * `body-unreadable`, `user-only-route`, or the key guard's own `wrong-key`,
 * `revoked-key`, `no-key`, `rate-limited`), the method and the route as the
 * policy spells it (the template, or `unlisted`), and never the key, the
 * body or the concrete path, whose segments can be document ids.
 */
import { satisfiesRole, minimumRole } from '../auth/roles.js';
import { AGENT_ID, AGENT_USER, CAPABILITIES, agentKeyFrom, looksLikeKey } from './keys.js';

/** The section switches, in the order the Koda tab shows them. */
export const ADMIN_SECTION_IDS = Object.freeze(
  CAPABILITIES.filter((capability) => capability.id.startsWith('admin.')).map((capability) => capability.id)
);

/**
 * Status values a transition may move content to on Koda's behalf. `published`
 * and `archived` are a publisher's act through their own routes.
 */
export const TRANSITION_TARGETS_ALLOWED = Object.freeze(['approved', 'editing', 'forge_ready', 'rejected']);

/** Job types Koda may enqueue: the ones that produce or inspect content, never the one that publishes it. */
export const JOB_TYPES_ALLOWED = Object.freeze([
  'forge-article',
  'forge-from-url',
  'batch-inspect',
  'sync-blog-source',
  'generate-listen-and-learn',
]);

/** Statuses a new content item may not be created in by the key. */
export const CREATE_STATUSES_REFUSED = Object.freeze(['published', 'archived']);

const P = 'admin.pipeline';
const E = 'admin.enhanced';
const B = 'admin.brain';
const S = 'admin.spotlight';
const H = 'admin.platform';

/**
 * One row per method and route template. `sections` is the switch (or
 * switches, any of which) that opens the route; `role` the role the key acts
 * with there (editor when unsaid); `asOwner` makes the key act as the Second
 * Brain's owner; `body` names a JSON field and the values it may (or may not)
 * carry.
 *
 * Templates use the registrations' own spelling (`{id}`, `{*blobPath}`), so
 * admin-access-registry.test.js can hold every row to a registered route.
 */
export const POLICY = Object.freeze(
  [
    // Pipeline: New Content, Drafts, Review Queue, Editor, Live Pages.
    ['GET', 'cms/content', P],
    ['GET', 'cms/content/item', P],
    ['POST', 'cms/content/item', P],
    ['GET', 'cms/content/{id}/versions', P],
    ['GET', 'cms/content/{id}/versions/{versionId}', P],
    ['GET', 'cms/content/rehost-images', P],
    ['GET', 'cms/drafts', P],
    ['POST', 'cms/drafts', P],
    ['POST', 'cms/drafts/from-markdown', P],
    ['GET', 'cms/drafts/{id}', P],
    ['PUT', 'cms/drafts/{id}', P],
    ['POST', 'cms/drafts/{id}/send-to-review', P],
    ['POST', 'cms/drafts/{id}/back-to-drafts', P],
    // content-create.js reads the item from `body.data`, so the rules look there.
    [
      'POST',
      'createContentItem',
      P,
      { body: [{ field: 'data.contentStatus', refuse: CREATE_STATUSES_REFUSED }, { field: 'data.Live', refuse: [true] }] },
    ],
    ['POST', 'updateContentItem', P],
    ['PATCH', 'updateContentItem', P],
    ['POST', 'saveEditorDraft', P],
    ['POST', 'saveContentImageOrder', P],
    ['POST', 'transitionContentStatus', P, { body: { field: 'newStatus', allow: TRANSITION_TARGETS_ALLOWED } }],
    ['POST', 'requestContentInspection', P],
    ['POST', 'resetContentReviewState', P],
    ['POST', 'generateArticleDraft', P],
    ['POST', 'generateReviewHeroImage', P],
    ['POST', 'generatePreviewImages', P],
    ['POST', 'triggerAiImageGeneration', P],
    ['POST', 'generateSocialCaption', P],
    ['POST', 'enqueueJob', P, { body: { field: 'type', allow: JOB_TYPES_ALLOWED } }],
    ['GET', 'getJob', P],
    ['POST', 'getJob', P],
    ['POST', 'getQueueSnapshot', P, { role: 'viewer' }],
    ['POST', 'getPublishSnapshot', P, { role: 'viewer' }],
    ['POST', 'getDecisionCenter', P, { role: 'viewer' }],
    ['POST', 'getAdminDashboardSnapshot', P, { role: 'viewer' }],
    // What the editor reads to fill its pickers, and the images an article can
    // use. Not cms/config/{collection}: its only collections are the AI
    // providers and the MCP servers, which stay closed.
    ['GET', 'cms/settings', P],
    ['GET', 'cms/images', P],
    ['GET', 'cms/images/folders', P],
    ['GET', 'cms/images/{id}/usage', P],
    ['GET', 'cms/images/curated/{id}', P],
    ['POST', 'cms/uploads/{container}', [P, S]],

    // Enhanced: Listen & Learn, Labs (read), Frameworks and Coder Corner
    // (content routes above), Blogs.
    ['GET', 'cms/listen-and-learn', E],
    ['POST', 'cms/listen-and-learn', E],
    ['GET', 'cms/listen-and-learn/speech-options', E],
    ['POST', 'cms/listen-and-learn/estimate', E],
    ['POST', 'cms/listen-and-learn/review', E],
    ['POST', 'cms/listen-and-learn/source-episode', E],
    ['GET', 'cms/listen-and-learn/{platform}/{examCode}', E],
    ['PATCH', 'cms/listen-and-learn/{platform}/{examCode}', E],
    ['POST', 'cms/listen-and-learn/{platform}/{examCode}/chapters', E],
    ['PATCH', 'cms/listen-and-learn/{platform}/{examCode}/chapters', E],
    ['PATCH', 'cms/listen-and-learn/{platform}/{examCode}/chapters/{chapterId}', E],
    ['POST', 'cms/listen-and-learn/{platform}/{examCode}/chapters/{chapterId}/regenerate', E],
    ['GET', 'getLabsSnapshot', E, { role: 'viewer' }],
    ['POST', 'getLabsSnapshot', E, { role: 'viewer' }],
    ['GET', 'getLabJob', E, { role: 'viewer' }],
    ['POST', 'getLabJob', E, { role: 'viewer' }],
    ['GET', 'cms/labs/starts', E],
    ['GET', 'cms/labs/coder-automation', E],
    ['GET', 'cms/blog-sources', E],
    ['POST', 'cms/blog-sources', E],
    ['PUT', 'cms/blog-sources/{id}', E],

    // Creative: the Second Brain only, as the owner.
    ['GET', 'cms/brain/status', B, { asOwner: true }],
    ['GET', 'cms/brain/items', B, { asOwner: true }],
    ['POST', 'cms/brain/items', B, { asOwner: true }],
    ['GET', 'cms/brain/items/{id}', B, { asOwner: true }],
    ['GET', 'cms/brain/history/{id}', B, { asOwner: true }],
    ['POST', 'cms/brain/search', B, { asOwner: true }],
    ['GET', 'cms/brain/graph', B, { asOwner: true }],
    ['POST', 'cms/brain/draft/{id}', B, { asOwner: true }],
    ['GET', 'cms/brain/context', B, { asOwner: true }],
    ['POST', 'cms/brain/ask', B, { asOwner: true }],

    // Spotlight: Speaking, Certifications, Ambassador, Doc Vault.
    ['GET', 'cms/speakerevents', S],
    ['POST', 'upsertSpeakerEvent', S],
    ['GET', 'cms/certifications', S],
    ['POST', 'cms/certifications', S],
    ['PATCH', 'cms/certifications/{id}', S],
    ['GET', 'cms/ambassador/applications', S],
    ['POST', 'cms/ambassador/applications', S],
    ['PATCH', 'cms/ambassador/applications/{id}', S],
    ['GET', 'cms/ambassador/evidence', S],
    ['POST', 'cms/ambassador/evidence', S],
    ['PATCH', 'cms/ambassador/evidence/{id}', S],
    ['POST', 'cms/ambassador/evidence/import', S],
    ['GET', 'cms/ambassador/evidence/sources/{sourceModule}', S],
    ['GET', 'cms/ambassador/files/{container}/{*blobPath}', S],
    ['GET', 'cms/ambassador/programs', S],
    ['GET', 'cms/ambassador/readiness/{programId}', S],
    ['GET', 'cms/doc-vault', S, { role: 'publisher' }],
    ['POST', 'cms/doc-vault', S, { role: 'publisher' }],
    ['POST', 'cms/doc-vault/upload', S, { role: 'publisher' }],
    ['GET', 'cms/doc-vault/{id}', S, { role: 'publisher' }],
    ['PUT', 'cms/doc-vault/{id}', S, { role: 'publisher' }],
    ['POST', 'cms/doc-vault/{id}/untrash', S, { role: 'publisher' }],
    ['GET', 'cms/doc-vault/{id}/versions/{version}', S, { role: 'publisher' }],
    ['POST', 'cms/doc-vault/{id}/restore-version', S, { role: 'publisher' }],

    // Platform: health and integrations, read, plus one connection test.
    ['GET', 'cms/health/probe-results', H, { role: 'viewer' }],
    ['POST', 'getOpsHealthSnapshot', H, { role: 'viewer' }],
    ['GET', 'cms/integration-status', H],
    ['GET', 'cms/streamyard/status', H],
    ['POST', 'connectionProbe', H],
  ].map(([method, route, sections, options = {}]) =>
    Object.freeze({
      method,
      route,
      sections: Object.freeze(Array.isArray(sections) ? sections : [sections]),
      role: options.role || 'editor',
      asOwner: Boolean(options.asOwner),
      body: options.body ? Object.freeze((Array.isArray(options.body) ? options.body : [options.body]).map((rule) => Object.freeze({ ...rule }))) : null,
      pattern: templateToPattern(route),
    })
  )
);

/** A route template as a case-insensitive regular expression over the path after `/api/`. */
export function templateToPattern(template) {
  const source = template
    .split('/')
    .map((segment) => {
      if (/^\{\*[^}]+\}$/.test(segment)) return '.+';
      if (/^\{[^}]+\}$/.test(segment)) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}$`, 'i');
}

/** The path after `/api/`, from the request's URL, without a query string or trailing slash. */
export function apiPathOf(request) {
  let pathname;
  try {
    pathname = new URL(request?.url || '', 'http://request.local').pathname;
  } catch {
    return '';
  }
  return decodeURIComponent(pathname)
    .replace(/^\/+/, '')
    .replace(/^api\//i, '')
    .replace(/\/+$/, '');
}

/** The first policy row for this method and path, or null. A DELETE never matches. */
export function matchPolicy(method, path) {
  const verb = String(method || '').toUpperCase();
  if (verb === 'DELETE' || !path) return null;
  return POLICY.find((row) => row.method === verb && row.pattern.test(path)) || null;
}

/** Which of a row's sections the record has on, or null when none is. */
export function openSection(row, record) {
  const switches = record?.capabilities || {};
  return row.sections.find((section) => switches[section] !== false) || null;
}

/**
 * Read the one body field a rule cares about, from a clone so the handler
 * still gets the body. A body that cannot be read, or is not an object, fails
 * the rule: the handler would refuse it anyway, and the rule must not be
 * passable by sending nothing.
 */
async function bodyOf(request) {
  try {
    const source = typeof request?.clone === 'function' ? request.clone() : request;
    const body = await source.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

/** `a.b.c` read off an object, undefined where the path ends early. */
const pick = (object, path) =>
  path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);

/**
 * Whether every body rule of a row holds for this request: `{ ok, reason,
 * field }`. The body is read once; each rule reads its field by path (the
 * create handler keeps the item under `data`, so `data.contentStatus`).
 */
export async function checkBodyRule(row, request) {
  if (!row.body) return { ok: true };
  const read = await bodyOf(request);
  if (!read.ok) return { ok: false, reason: 'body-unreadable', field: row.body[0].field };
  for (const rule of row.body) {
    const raw = pick(read.body, rule.field);
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (rule.allow && !rule.allow.includes(value)) return { ok: false, reason: 'body-not-allowed', field: rule.field };
    if (rule.refuse && rule.refuse.includes(value)) return { ok: false, reason: 'body-not-allowed', field: rule.field };
  }
  return { ok: true };
}

/** The identity the key acts with on a row: Koda, or the Second Brain's owner for `asOwner` rows. */
export function agentUserFor(row, env = process.env) {
  if (!row.asOwner) return { ...AGENT_USER, roles: [], scp: '' };
  return {
    ...AGENT_USER,
    oid: env.BRAIN_OWNER_OID || AGENT_USER.oid,
    sub: env.BRAIN_OWNER_OID || AGENT_USER.sub,
    tid: env.BRAIN_OWNER_TENANT_ID || null,
    actingFor: 'owner',
    roles: [],
    scp: '',
  };
}

/** The policy as the status route and the Koda tab show it: one line per row, grouped by section. */
export function describePolicy(record = null) {
  const switches = record?.capabilities || {};
  return ADMIN_SECTION_IDS.map((section) => {
    const capability = CAPABILITIES.find((entry) => entry.id === section);
    return {
      id: section,
      label: capability?.label || section,
      on: switches[section] !== false,
      routes: POLICY.filter((row) => row.sections.includes(section)).map((row) => ({
        method: row.method,
        path: `/api/${row.route}`,
        ...(row.body ? { limit: row.body.map(bodyLimitText).join('; ') } : {}),
      })),
    };
  });
}

function bodyLimitText(body) {
  if (body.allow) return `${body.field} must be one of ${body.allow.join(', ')}`;
  return `${body.field} must not be ${body.refuse.join(' or ')}`;
}

const deny = (status, error) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: false, error }),
});

const FORBIDDEN = 'This key may not call that route.';

/**
 * Wrap the admin role guard so a request that presents a site key takes the
 * key path (authenticate, then the policy), and every other request takes
 * the role guard's own path unchanged.
 *
 * @param {{ requireRole: Function, requireUser: Function }} roleGuard
 * @param {object} deps
 * @param {{ authenticate: (request: object) => Promise<{record: object|null, user: object|null, error: object|null}> }} deps.agentGuard
 * @param {(entry: object) => unknown} [deps.auditDenial] the denial sink; never awaited, must not throw synchronously
 * @param {NodeJS.ProcessEnv} [deps.env]
 */
export function withAgentAccess(roleGuard, { agentGuard, auditDenial = null, env = process.env }) {
  const audit = (entry) => {
    try {
      const result = auditDenial?.({ kind: 'agent-content-denial', agent: AGENT_ID, ...entry });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // The refusal is unchanged when the audit sink fails.
    }
  };

  /** Only a value shaped like a site key takes the key path; a token, or nothing, takes the role guard's. */
  const presentsKey = (request) => looksLikeKey(agentKeyFrom(request));

  async function requireRole(request, required) {
    if (!presentsKey(request)) return roleGuard.requireRole(request, required);

    const minimum = minimumRole(required);
    if (!minimum) throw new Error(`requireRole: unknown role requirement ${JSON.stringify(required)}`);

    // The route is matched before the key is checked, so the key guard's own
    // refusals (wrong, revoked, over the limit) carry the admin surface and
    // the route template too. The concrete path is matched and then dropped:
    // its segments can be document ids, and telemetry is content-free.
    const method = String(request?.method || '').toUpperCase();
    const row = matchPolicy(method, apiPathOf(request));
    const where = { surface: 'admin', method, route: row ? row.route : 'unlisted' };

    const auth = await agentGuard.authenticate(request, where);
    if (auth.error) return { user: null, role: null, error: auth.error };

    const refuse = (reason, extra = {}) => {
      audit({ outcome: 'denied', reason, ...where, ...extra });
      return { user: null, role: null, error: deny(403, FORBIDDEN) };
    };

    if (!row) return refuse('route-not-allowed');
    const section = openSection(row, auth.record);
    if (!section) return refuse('section-off', { section: row.sections[0] });
    if (!satisfiesRole(row.role, minimum)) return refuse('role', { required: minimum, granted: row.role });
    const body = await checkBodyRule(row, request);
    if (!body.ok) return refuse(body.reason, { field: body.field });

    return { user: agentUserFor(row, env), role: row.role, error: null };
  }

  /**
   * A key is not a user: the user-only routes (the sign-in expectations, the
   * current-admin status, the bootstrap) refuse it without a verifier round
   * trip, and the refusal is a denial row like any other presented key's.
   */
  async function requireUser(request) {
    if (!presentsKey(request)) return roleGuard.requireUser(request);
    audit({
      outcome: 'denied',
      reason: 'user-only-route',
      surface: 'admin',
      method: String(request?.method || '').toUpperCase(),
      route: 'unlisted',
    });
    return { user: null, role: null, error: deny(401, 'Authentication required') };
  }

  return { ...roleGuard, requireRole, requireUser };
}

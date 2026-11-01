import { describe, it, expect, vi } from 'vitest';

import {
  POLICY,
  ADMIN_SECTION_IDS,
  TRANSITION_TARGETS_ALLOWED,
  JOB_TYPES_ALLOWED,
  templateToPattern,
  apiPathOf,
  matchPolicy,
  openSection,
  checkBodyRule,
  agentUserFor,
  describePolicy,
  withAgentAccess,
} from './admin-access.js';
import { AGENT_USER, CAPABILITY_IDS, defaultCapabilities, generateKey } from './keys.js';

const SECRET = generateKey();
const RECORD = { id: 'agent_content_key:koda', capabilities: defaultCapabilities() };

/** A request as the guard sees it: method, URL, headers, and a cloneable JSON body. */
function request({ method = 'GET', path = 'cms/content', key = SECRET, body = undefined, token = null, cloneable = true } = {}) {
  const headers = new Map();
  if (key) headers.set('authorization', `Bearer ${key}`);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const req = {
    method,
    url: `https://api-azure.hybridcloudworks.com/api/${path}?x=1`,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    json: async () => {
      if (body === 'invalid') throw new SyntaxError('bad json');
      return body;
    },
  };
  if (cloneable) req.clone = () => ({ ...req, clone: undefined });
  return req;
}

function setup({ record = RECORD, agentError = null, env = { BRAIN_OWNER_OID: 'owner-oid', BRAIN_OWNER_TENANT_ID: 'owner-tid' } } = {}) {
  const roleGuard = {
    requireRole: vi.fn(async () => ({ user: { oid: 'human' }, role: 'editor', error: null })),
    requireUser: vi.fn(async () => ({ user: { oid: 'human' }, role: null, error: null })),
    clearCache: vi.fn(),
  };
  const agentGuard = {
    authenticate: vi.fn(async () =>
      agentError ? { record: null, user: null, error: agentError } : { record, user: AGENT_USER, error: null }
    ),
  };
  const audits = [];
  const guard = withAgentAccess(roleGuard, { agentGuard, auditDenial: (entry) => audits.push(entry), env });
  return { guard, roleGuard, agentGuard, audits };
}

describe('the policy table', () => {
  it('never lists a DELETE, and lists each method and route once', () => {
    expect(POLICY.some((row) => row.method === 'DELETE')).toBe(false);
    const keys = POLICY.map((row) => `${row.method} ${row.route}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists none of the publishing, deleting, settings, secrets or admin routes', () => {
    const routes = new Set(POLICY.map((row) => row.route));
    for (const never of [
      'publishContent', 'saveContentSchedule', 'unscheduleContent', 'unpublishContentToInspected',
      'softDeleteLivePage', 'deleteContentItem', 'deleteRejectedContent', 'deleteSpeakerEvent',
      'deleteContentGeneratedImage', 'deleteCuratedGeneratedImage', 'cms/content/slug',
      'cms/content/{id}', 'cms/secrets', 'cms/credentials', 'cms/admins', 'cms/admins/{id}',
      'cms/bootstrap/reset', 'cms/settings', 'cms/platform-settings/{setting}', 'cms/ai-routing',
      'cms/labs/coder-token', 'cms/labs/agents', 'cms/brain/reindex', 'cms/brain/sync',
      'cms/newsletters', 'cms/social-posts', 'cms/calendar', 'publishSnapshot',
      'cms/podcast/transcripts/{id}/publish', 'cms/integration-status PUT', 'cms/agent-content/key',
      'cms/config/{collection}', 'cms/keyword-config',
    ]) {
      if (never === 'cms/settings') {
        // read is allowed for the editor's pickers; the write is not
        expect(POLICY.some((row) => row.route === never && row.method !== 'GET')).toBe(false);
        continue;
      }
      expect(routes.has(never.replace(/ PUT$/, '')) && POLICY.some((r) => r.route === never.replace(/ PUT$/, '') && r.method === 'PUT'), never).toBe(false);
      if (!never.endsWith(' PUT')) expect(routes.has(never), never).toBe(false);
    }
  });

  it('puts every row under a section switch the key record knows', () => {
    for (const row of POLICY) {
      for (const section of row.sections) {
        expect(ADMIN_SECTION_IDS, `${row.method} ${row.route}`).toContain(section);
        expect(CAPABILITY_IDS).toContain(section);
      }
    }
  });

  it('grants publisher only to the Doc Vault, and viewer only to reads', () => {
    for (const row of POLICY) {
      if (row.role === 'publisher') expect(row.route.startsWith('cms/doc-vault')).toBe(true);
      if (row.route.startsWith('cms/doc-vault')) expect(row.role).toBe('publisher');
    }
  });

  it('acts as the owner only on the Second Brain', () => {
    for (const row of POLICY) expect(row.asOwner, row.route).toBe(row.route.startsWith('cms/brain/'));
  });
});

describe('matching', () => {
  it('turns a template into a pattern that binds one segment per {param} and the rest for {*param}', () => {
    expect(templateToPattern('cms/drafts/{id}').test('cms/drafts/abc')).toBe(true);
    expect(templateToPattern('cms/drafts/{id}').test('cms/drafts/abc/send-to-review')).toBe(false);
    expect(templateToPattern('cms/ambassador/files/{container}/{*blobPath}').test('cms/ambassador/files/evidence/a/b/c.png')).toBe(true);
    expect(templateToPattern('cms/listen-and-learn').test('cms/listen-and-learn.evil')).toBe(false);
  });

  it('reads the path after /api/ from the URL, without query or trailing slash, case-insensitively', () => {
    expect(apiPathOf({ url: 'https://h/api/transitionContentStatus?x=1' })).toBe('transitionContentStatus');
    expect(apiPathOf({ url: 'https://h/api/cms/drafts/' })).toBe('cms/drafts');
    expect(apiPathOf({ url: 'not a url' })).toBe('not a url');
    expect(apiPathOf({})).toBe('');
    expect(matchPolicy('get', 'CMS/Content')?.route).toBe('cms/content');
  });

  it('never matches a DELETE, even on a listed route', () => {
    expect(matchPolicy('DELETE', 'cms/drafts/abc')).toBeNull();
    expect(matchPolicy('DELETE', 'cms/doc-vault/abc')).toBeNull();
    expect(matchPolicy('PUT', 'cms/drafts/abc')?.route).toBe('cms/drafts/{id}');
  });

  it('opens a row through any of its sections', () => {
    const uploads = matchPolicy('POST', 'cms/uploads/covers');
    expect(uploads.sections).toEqual(['admin.pipeline', 'admin.spotlight']);
    expect(openSection(uploads, { capabilities: { 'admin.pipeline': false } })).toBe('admin.spotlight');
    expect(openSection(uploads, { capabilities: { 'admin.pipeline': false, 'admin.spotlight': false } })).toBeNull();
  });
});

describe('body rules', () => {
  const transition = matchPolicy('POST', 'transitionContentStatus');
  const enqueue = matchPolicy('POST', 'enqueueJob');
  const create = matchPolicy('POST', 'createContentItem');

  it('lets a transition reach the review states and never published or archived', async () => {
    for (const target of TRANSITION_TARGETS_ALLOWED) {
      expect(await checkBodyRule(transition, request({ body: { newStatus: target } }))).toEqual({ ok: true });
    }
    for (const target of ['published', 'archived', '', undefined]) {
      expect((await checkBodyRule(transition, request({ body: { newStatus: target } }))).ok).toBe(false);
    }
  });

  it('lets a job be enqueued only for the producing types', async () => {
    for (const type of JOB_TYPES_ALLOWED) {
      expect(await checkBodyRule(enqueue, request({ body: { type } }))).toEqual({ ok: true });
    }
    expect((await checkBodyRule(enqueue, request({ body: { type: 'publish-content' } }))).reason).toBe('body-not-allowed');
    expect((await checkBodyRule(enqueue, request({ body: { type: ' forge-article ' } }))).ok).toBe(true);
  });

  it('refuses a create whose item (under `data`, where the handler reads it) asks to be born published or live, and allows one that does not say', async () => {
    expect((await checkBodyRule(create, request({ body: { data: { contentStatus: 'published' } } }))).reason).toBe('body-not-allowed');
    expect((await checkBodyRule(create, request({ body: { data: { contentStatus: 'archived' } } }))).reason).toBe('body-not-allowed');
    expect((await checkBodyRule(create, request({ body: { data: { Live: true } } }))).reason).toBe('body-not-allowed');
    expect(await checkBodyRule(create, request({ body: { data: { title: 'x', contentStatus: 'drafting' } } }))).toEqual({ ok: true });
    expect(await checkBodyRule(create, request({ body: { data: { title: 'x' } } }))).toEqual({ ok: true });
    // The top level is not where the handler reads, so a status there is neither refused nor honoured.
    expect(await checkBodyRule(create, request({ body: { contentStatus: 'published', data: { title: 'x' } } }))).toEqual({ ok: true });
  });

  it('fails closed on a body it cannot read, and reads a clone so the handler still gets the body', async () => {
    expect((await checkBodyRule(transition, request({ body: 'invalid' }))).reason).toBe('body-unreadable');
    expect((await checkBodyRule(transition, request({ body: ['approved'] }))).reason).toBe('body-unreadable');
    const req = request({ body: { newStatus: 'approved' } });
    const clone = vi.spyOn(req, 'clone');
    await checkBodyRule(transition, req);
    expect(clone).toHaveBeenCalledTimes(1);
  });
});

describe('withAgentAccess', () => {
  it('leaves a token request to the role guard, untouched', async () => {
    const { guard, roleGuard, agentGuard } = setup();
    const req = request({ key: null, token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' });
    const result = await guard.requireRole(req, 'editor');
    expect(result.role).toBe('editor');
    expect(roleGuard.requireRole).toHaveBeenCalledWith(req, 'editor');
    expect(agentGuard.authenticate).not.toHaveBeenCalled();
  });

  it('lets the key through a listed route as koda (agent) with the row’s role', async () => {
    const { guard, roleGuard, audits } = setup();
    const result = await guard.requireRole(request({ method: 'POST', path: 'cms/drafts' }), 'editor');
    expect(result.error).toBeNull();
    expect(result.role).toBe('editor');
    expect(result.user).toMatchObject({ oid: 'agent:koda', preferred_username: 'koda (agent)', agent: 'koda' });
    expect(roleGuard.requireRole).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('refuses a route that is not listed, with an audit row naming it and never the key', async () => {
    const { guard, audits } = setup();
    const result = await guard.requireRole(request({ method: 'POST', path: 'publishContent' }), 'publisher');
    expect(result.error.status).toBe(403);
    expect(JSON.parse(result.error.body)).toEqual({ ok: false, error: 'This key may not call that route.' });
    expect(audits).toEqual([
      expect.objectContaining({ kind: 'agent-content-denial', agent: 'koda', surface: 'admin', reason: 'route-not-allowed', method: 'POST', route: 'unlisted' }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET.slice(5));
    // The concrete path never reaches the row: its segments can be document ids.
    expect(JSON.stringify(audits)).not.toContain('publishContent');
  });

  it('refuses every DELETE, listed route or not', async () => {
    const { guard, audits } = setup();
    for (const path of ['cms/drafts/abc', 'cms/doc-vault/abc', 'cms/content/abc', 'cms/certifications/abc']) {
      const result = await guard.requireRole(request({ method: 'DELETE', path }), 'editor');
      expect(result.error.status, path).toBe(403);
    }
    expect(audits.map((a) => a.reason)).toEqual(['route-not-allowed', 'route-not-allowed', 'route-not-allowed', 'route-not-allowed']);
  });

  it('refuses a route whose section switch is off, naming the section', async () => {
    const record = { capabilities: { ...defaultCapabilities(), 'admin.spotlight': false } };
    const { guard, audits } = setup({ record });
    const result = await guard.requireRole(request({ method: 'GET', path: 'cms/certifications' }), 'editor');
    expect(result.error.status).toBe(403);
    expect(audits[0]).toMatchObject({ reason: 'section-off', section: 'admin.spotlight', route: 'cms/certifications' });
    // The upload route stays open through Pipeline when Spotlight is off.
    expect((await guard.requireRole(request({ method: 'POST', path: 'cms/uploads/certifications' }), 'editor')).error).toBeNull();
  });

  it('refuses when the handler asks for more than the row grants', async () => {
    const { guard, audits } = setup();
    // cms/content is an editor row; a handler asking for publisher on it is refused.
    const result = await guard.requireRole(request({ method: 'GET', path: 'cms/content' }), 'publisher');
    expect(result.error.status).toBe(403);
    expect(audits[0]).toMatchObject({ reason: 'role', required: 'publisher', granted: 'editor' });
    // A viewer row satisfies a viewer handler, and a publisher row a publisher handler.
    expect((await guard.requireRole(request({ method: 'POST', path: 'getQueueSnapshot' }), 'viewer')).role).toBe('viewer');
    expect((await guard.requireRole(request({ method: 'GET', path: 'cms/doc-vault' }), 'publisher')).role).toBe('publisher');
  });

  it('applies the body rules and audits the field, never the value', async () => {
    const { guard, audits } = setup();
    const refused = await guard.requireRole(
      request({ method: 'POST', path: 'transitionContentStatus', body: { newStatus: 'published', contentId: 'c1' } }),
      'editor'
    );
    expect(refused.error.status).toBe(403);
    expect(audits[0]).toMatchObject({ reason: 'body-not-allowed', field: 'newStatus', route: 'transitionContentStatus' });
    expect(JSON.stringify(audits)).not.toContain('c1');
    const born = await guard.requireRole(
      request({ method: 'POST', path: 'createContentItem', body: { data: { contentStatus: 'published', title: 'secret title' } } }),
      'editor'
    );
    expect(born.error.status).toBe(403);
    expect(audits[1]).toMatchObject({ reason: 'body-not-allowed', field: 'data.contentStatus' });
    expect(JSON.stringify(audits)).not.toContain('secret title');
    const allowed = await guard.requireRole(
      request({ method: 'POST', path: 'transitionContentStatus', body: { newStatus: 'approved' } }),
      'editor'
    );
    expect(allowed.error).toBeNull();
  });

  it('acts as the Second Brain’s owner on its routes, and as koda everywhere else', async () => {
    const { guard } = setup();
    const brain = await guard.requireRole(request({ method: 'GET', path: 'cms/brain/items' }), 'editor');
    expect(brain.user).toMatchObject({ oid: 'owner-oid', sub: 'owner-oid', tid: 'owner-tid', actingFor: 'owner', preferred_username: 'koda (agent)', agent: 'koda' });
    const content = await guard.requireRole(request({ method: 'GET', path: 'cms/content' }), 'editor');
    expect(content.user.oid).toBe('agent:koda');
    expect(content.user.actingFor).toBeUndefined();
    expect(agentUserFor(matchPolicy('GET', 'cms/brain/status'), {}).oid).toBe('agent:koda');
  });

  it('passes the key guard’s own refusals through (wrong key, limit), telling the key guard the surface and route template for its own audit row', async () => {
    const limited = { status: 429, headers: { 'Retry-After': '7' }, body: '{}' };
    const { guard, agentGuard, audits } = setup({ agentError: limited });
    const result = await guard.requireRole(request({ method: 'GET', path: 'cms/drafts/draft-id-77' }), 'editor');
    expect(result.error).toBe(limited);
    // The wrapper writes nothing itself: the key guard wrote the row, with this context.
    expect(audits).toEqual([]);
    expect(agentGuard.authenticate).toHaveBeenCalledWith(expect.anything(), { surface: 'admin', method: 'GET', route: 'cms/drafts/{id}' });
    await guard.requireRole(request({ method: 'POST', path: 'publishContent' }), 'publisher');
    expect(agentGuard.authenticate).toHaveBeenLastCalledWith(expect.anything(), { surface: 'admin', method: 'POST', route: 'unlisted' });
  });

  it('never writes a concrete path into a denial row, only the template or unlisted', async () => {
    const record = { capabilities: { ...defaultCapabilities(), 'admin.brain': false } };
    const { guard, audits } = setup({ record });
    await guard.requireRole(request({ method: 'GET', path: 'cms/brain/items/note-id-42' }), 'editor');
    await guard.requireRole(request({ method: 'DELETE', path: 'cms/drafts/draft-id-77' }), 'editor');
    expect(audits.map((a) => a.route)).toEqual(['cms/brain/items/{id}', 'unlisted']);
    expect(JSON.stringify(audits)).not.toMatch(/note-id-42|draft-id-77/);
  });

  it('throws on an unknown role requirement, like the role guard does', async () => {
    const { guard } = setup();
    await expect(guard.requireRole(request(), 'publishor')).rejects.toThrow(/unknown role requirement/);
  });

  it('refuses a key on the user-only routes without a verifier round trip, and writes the denial row', async () => {
    const { guard, roleGuard, audits } = setup();
    const result = await guard.requireUser(request({ method: 'GET', path: 'getCurrentAdminStatus' }));
    expect(result.error.status).toBe(401);
    expect(roleGuard.requireUser).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({ kind: 'agent-content-denial', surface: 'admin', reason: 'user-only-route', method: 'GET', route: 'unlisted' }),
    ]);
    await guard.requireUser(request({ key: null, token: 'a.b.c' }));
    expect(roleGuard.requireUser).toHaveBeenCalledTimes(1);
  });

  it('keeps the role guard’s other members, such as clearCache', () => {
    const { guard, roleGuard } = setup();
    expect(guard.clearCache).toBe(roleGuard.clearCache);
  });
});

describe('describePolicy', () => {
  it('lists each section with its switch state and its routes, body limits included', () => {
    const sections = describePolicy({ capabilities: { 'admin.brain': false } });
    expect(sections.map((s) => s.id)).toEqual(ADMIN_SECTION_IDS);
    expect(sections.find((s) => s.id === 'admin.brain').on).toBe(false);
    expect(sections.find((s) => s.id === 'admin.pipeline').on).toBe(true);
    const pipeline = sections.find((s) => s.id === 'admin.pipeline');
    expect(pipeline.routes).toContainEqual({ method: 'POST', path: '/api/transitionContentStatus', limit: `newStatus must be one of ${TRANSITION_TARGETS_ALLOWED.join(', ')}` });
    expect(pipeline.routes).toContainEqual({ method: 'POST', path: '/api/createContentItem', limit: 'data.contentStatus must not be published or archived; data.Live must not be true' });
    expect(pipeline.routes).toContainEqual({ method: 'GET', path: '/api/cms/content' });
    expect(sections.reduce((n, s) => n + s.routes.length, 0)).toBeGreaterThanOrEqual(POLICY.length);
  });
});

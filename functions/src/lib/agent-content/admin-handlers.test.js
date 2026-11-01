/**
 * The Koda tab's routes (admin-handlers.js, ADR 0037): the read at editor and
 * every write at super_admin; Generate answers the plaintext once and stores
 * the hash; Rotate keeps the switches; PATCH changes the switches and refuses
 * unknown ones by name; Revoke removes the hash and keeps the history; every
 * write is under the record's ETag and leaves an audit row without the key.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAgentContentAdminHandlers } from './admin-handlers.js';
import { KEY_PREFIX, KEY_RECORD_ID, defaultCapabilities, hashKey, isUsable } from './keys.js';

const OWNER = { oid: 'owner-oid', email: 'owner@hcw.dev' };
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const request = (body) => ({
  headers: { get: (name) => (name.toLowerCase() === 'user-agent' ? 'vitest' : null) },
  json: async () => body,
});
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });
const failure = (code, message) => Object.assign(new Error(message), { code });

function memoryStore(seed = null) {
  let etag = 1;
  const nextEtag = () => `"e${etag++}"`;
  const docs = new Map();
  if (seed) docs.set(seed.id, { ...seed, _etag: nextEtag() });
  const audits = [];
  return {
    docs,
    audits,
    readDoc: vi.fn(async (container, id, partitionKey) => {
      expect(container).toBe('admin_config');
      expect(partitionKey).toBe('admin_config');
      return docs.has(id) ? structuredClone(docs.get(id)) : null;
    }),
    createDoc: vi.fn(async (container, doc) => {
      if (docs.has(doc.id)) throw failure(409, 'exists');
      const stored = { ...doc, _etag: nextEtag() };
      docs.set(doc.id, stored);
      return structuredClone(stored);
    }),
    replaceDocIfMatch: vi.fn(async (container, doc, options) => {
      expect(options).toEqual({ partitionKey: 'admin_config' });
      const current = docs.get(doc.id);
      if (!current) throw failure(404, 'missing');
      if (doc._etag !== current._etag) throw failure(412, 'changed');
      const stored = { ...doc, _etag: nextEtag() };
      docs.set(doc.id, stored);
      return structuredClone(stored);
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      expect(container).toBe('admin_audit_logs');
      audits.push(doc);
      return doc;
    }),
  };
}

const roleGuard = (granted) => ({
  requireRole: vi.fn(async (req, role) => {
    const order = ['viewer', 'editor', 'publisher', 'super_admin'];
    if (order.indexOf(granted) >= order.indexOf(role)) return { user: OWNER, role: granted, error: null };
    return { user: null, role: null, error: { status: 403, headers: {}, body: '{}' } };
  }),
});

function setup({ seed = null, role = 'super_admin' } = {}) {
  const store = memoryStore(seed);
  let n = 0;
  const handlers = createAgentContentAdminHandlers({
    guard: roleGuard(role),
    store,
    now: () => new Date('2026-10-31T12:00:00.000Z'),
    uuid: () => `audit-${++n}`,
    log: context,
  });
  return { handlers, store };
}

describe('roles', () => {
  it('an editor may read, and nothing else', async () => {
    const { handlers, store } = setup({ role: 'editor' });
    expect((await handlers.getKey(request(), context)).status).toBe(200);
    expect((await handlers.generateKey(request(), context)).status).toBe(403);
    expect((await handlers.updateCapabilities(request({ capabilities: {} }), context)).status).toBe(403);
    expect((await handlers.revokeKey(request(), context)).status).toBe(403);
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });
});

describe('before a key exists', () => {
  it('the read says so, with the catalogue the tab draws from', async () => {
    const { handlers } = setup();
    const res = parse(await handlers.getKey(request(), context));
    expect(res.body.key).toEqual({ present: false, active: false, capabilities: defaultCapabilities() });
    expect(res.body.capabilities.map((c) => c.id)).toContain('drafts.write');
    expect(res.body.basePath).toBe('/api/agent-content/v1');
    expect(res.body.endpoints.length).toBeGreaterThan(5);
  });

  it('a capabilities change is 404 NO_KEY, and a revoke is a no-op 200', async () => {
    const { handlers } = setup();
    const patched = parse(await handlers.updateCapabilities(request({ capabilities: { 'drafts.read': false } }), context));
    expect(patched.status).toBe(404);
    expect(patched.body.code).toBe('NO_KEY');
    expect((await handlers.revokeKey(request(), context)).status).toBe(200);
  });
});

describe('Generate', () => {
  it('answers the plaintext once, stores only its hash, and audits the hint', async () => {
    const { handlers, store } = setup();
    const res = parse(await handlers.generateKey(request(), context));
    expect(res.status).toBe(201);
    expect(res.body.secret.startsWith(KEY_PREFIX)).toBe(true);
    expect(res.body.shownOnce).toBe(true);
    expect(res.body.key.present).toBe(true);
    expect(res.body.key.active).toBe(true);
    expect(res.body.key.createdBy).toBe('owner@hcw.dev');

    const stored = store.docs.get(KEY_RECORD_ID);
    expect(stored.keyHash).toBe(hashKey(res.body.secret));
    expect(JSON.stringify(stored)).not.toContain(res.body.secret);
    expect(stored.configScope).toBe('admin_config');

    expect(store.audits).toHaveLength(1);
    expect(store.audits[0].action).toBe('agent_content_key_generated');
    expect(store.audits[0].details).toEqual({ keyHint: stored.keyHint });
    expect(JSON.stringify(store.audits)).not.toContain(res.body.secret);

    // The read never shows it again.
    const read = parse(await handlers.getKey(request(), context));
    expect(JSON.stringify(read.body)).not.toContain(res.body.secret);
    expect(JSON.stringify(read.body)).not.toContain(stored.keyHash);
  });

  it('again is a rotation: a new key, the old one dead, the switches and the first creation kept', async () => {
    const { handlers, store } = setup();
    const first = parse(await handlers.generateKey(request(), context)).body.secret;
    await handlers.updateCapabilities(request({ capabilities: { 'drafts.delete': false } }), context);
    const second = parse(await handlers.generateKey(request(), context));
    expect(second.status).toBe(201);
    expect(second.body.secret).not.toBe(first);
    const stored = store.docs.get(KEY_RECORD_ID);
    expect(stored.keyHash).toBe(hashKey(second.body.secret));
    expect(stored.capabilities['drafts.delete']).toBe(false);
    expect(stored.createdBy).toBe('owner@hcw.dev');
    expect(stored.rotatedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(store.audits.map((a) => a.action)).toEqual([
      'agent_content_key_generated',
      'agent_content_capabilities_changed',
      'agent_content_key_rotated',
    ]);
    expect(store.replaceDocIfMatch).toHaveBeenCalled();
  });

  it('after a revoke makes the key usable again, as a rotation', async () => {
    const { handlers, store } = setup();
    await handlers.generateKey(request(), context);
    await handlers.revokeKey(request(), context);
    expect(isUsable(store.docs.get(KEY_RECORD_ID))).toBe(false);
    const again = parse(await handlers.generateKey(request(), context));
    expect(again.status).toBe(201);
    const stored = store.docs.get(KEY_RECORD_ID);
    expect(isUsable(stored)).toBe(true);
    expect(stored.revokedAt).toBeNull();
    expect(store.audits.at(-1).action).toBe('agent_content_key_rotated');
  });

  it('retries once on a lost race and otherwise fails closed', async () => {
    const { handlers, store } = setup();
    store.createDoc.mockRejectedValueOnce(failure(409, 'raced'));
    const res = parse(await handlers.generateKey(request(), context));
    expect(res.status).toBe(201);
    store.replaceDocIfMatch.mockRejectedValue(failure(412, 'raced'));
    const lost = await handlers.generateKey(request(), context);
    expect(lost.status).toBe(500);
  });
});

describe('PATCH capabilities', () => {
  it('switches what the key may do and refuses an unknown switch by name', async () => {
    const { handlers, store } = setup();
    await handlers.generateKey(request(), context);
    const res = parse(await handlers.updateCapabilities(request({ capabilities: { 'published.read': false } }), context));
    expect(res.status).toBe(200);
    expect(res.body.key.capabilities['published.read']).toBe(false);
    expect(res.body.key.capabilities['drafts.read']).toBe(true);
    expect(store.docs.get(KEY_RECORD_ID).capabilitiesChangedBy).toBe('owner@hcw.dev');

    const bad = parse(await handlers.updateCapabilities(request({ capabilities: { publish: true } }), context));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Not a capability: publish');
    expect(store.docs.get(KEY_RECORD_ID).capabilities['published.read']).toBe(false);
  });
});

describe('two tabs toggling different switches', () => {
  it('both changes land: the retry after a lost race merges over the other tab’s write', async () => {
    const { handlers, store } = setup();
    await handlers.generateKey(request(), context);
    // The other tab's write lands between this request's read and its replace.
    const replace = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async (container, doc, options) => {
      const other = { ...store.docs.get(KEY_RECORD_ID) };
      other.capabilities = { ...other.capabilities, 'drafts.delete': false };
      await replace(container, { ...other }, options);
      return replace(container, doc, options);
    });
    const res = parse(await handlers.updateCapabilities(request({ capabilities: { 'published.read': false } }), context));
    expect(res.status).toBe(200);
    expect(res.body.key.capabilities['published.read']).toBe(false);
    expect(res.body.key.capabilities['drafts.delete']).toBe(false);
    expect(store.docs.get(KEY_RECORD_ID).capabilities['drafts.delete']).toBe(false);
  });
});

describe('Revoke', () => {
  it('removes the hash, keeps the history, and the record is no longer usable', async () => {
    const { handlers, store } = setup();
    const made = parse(await handlers.generateKey(request(), context));
    const res = parse(await handlers.revokeKey(request(), context));
    expect(res.status).toBe(200);
    expect(res.body.key.active).toBe(false);
    expect(res.body.key.present).toBe(true);
    expect(res.body.key.revokedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(res.body.key.revokedBy).toBe('owner@hcw.dev');
    expect(res.body.key.keyHint).toBe(made.body.key.keyHint);
    const stored = store.docs.get(KEY_RECORD_ID);
    expect(stored.keyHash).toBeUndefined();
    expect(isUsable(stored)).toBe(false);
    expect(store.audits.at(-1).action).toBe('agent_content_key_revoked');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { createDeveloperApiAdminHandlers, READ_ROLE, WRITE_ROLE } from './admin-handlers.js';
import { createDeveloperApiGuard } from './guard.js';
import { hashKey, keyRecordId } from './keys.js';
import { createTestStore, makeRequest, testContext } from './test-store.test-helper.js';

const ctx = testContext();
const body = (res) => JSON.parse(res.body);
const ADMIN = { oid: 'admin-oid', email: 'owner@example.com' };

function setup({ refuse = false } = {}) {
  const store = createTestStore();
  const requireRole = vi.fn(async (_request, role) =>
    refuse ? { error: { status: 403, headers: {}, body: '{"ok":false}' } } : { user: ADMIN, role },
  );
  const log = { error: vi.fn() };
  const handlers = createDeveloperApiAdminHandlers({
    guard: { requireRole },
    store,
    now: () => new Date('2026-11-21T10:00:00Z'),
    log,
  });
  const keyGuard = createDeveloperApiGuard({ store, now: () => Date.parse('2026-11-21T10:00:00Z') });
  const works = async (secret) =>
    (await keyGuard.authenticate(makeRequest({ headers: { Authorization: `Bearer ${secret}` } }))).error === null;
  return { store, handlers, requireRole, log, works };
}

const create = (handlers, payload = { organizerName: 'Org', scopes: ['cfs:manage'] }) =>
  handlers.createKey(makeRequest({ method: 'POST', body: payload }), ctx);

describe('the organizer key admin routes (ADR 0042)', () => {
  it('makes a key, answers the plaintext once, and stores only its hash', async () => {
    const { store, handlers, works, requireRole } = setup();
    const res = await create(handlers);
    expect(res.status).toBe(201);
    const { secret, key, shownOnce } = body(res);
    expect(shownOnce).toBe(true);
    expect(requireRole.mock.calls[0][1]).toBe(WRITE_ROLE);
    expect(JSON.stringify(store.all('admin_config'))).not.toContain(secret);
    expect(store.all('admin_config')[0].keyHash).toBe(hashKey(secret));
    expect(await works(secret)).toBe(true);
    expect(key).not.toHaveProperty('keyHash');
    // The audit row carries the hint, never the key.
    const audit = store.all('admin_audit_logs');
    expect(audit[0].action).toBe('developer_api_key_generated');
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('lists keys for an editor, never with a hash or a secret', async () => {
    const { handlers, requireRole } = setup();
    const { secret } = body(await create(handlers));
    const res = await handlers.listKeys(makeRequest(), ctx);
    expect(requireRole.mock.calls.at(-1)[1]).toBe(READ_ROLE);
    expect(body(res).keys).toHaveLength(1);
    expect(body(res).scopes.map((s) => s.id)).toContain('cfs:manage');
    expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain('keyHash');
  });

  it('refuses bad input with 400', async () => {
    const { handlers } = setup();
    expect((await create(handlers, { organizerName: 'Org', scopes: ['events:publish'] })).status).toBe(400);
    expect((await create(handlers, { scopes: ['cfs:manage'] })).status).toBe(400);
    expect((await handlers.createKey(makeRequest({ method: 'POST', body: '{nope' }), ctx)).status).toBe(400);
  });

  it('rotates: the old key stops at once, the new one works, the organizer stays', async () => {
    const { handlers, works, store } = setup();
    const made = body(await create(handlers));
    const res = await handlers.rotateKey(makeRequest({ method: 'POST', params: { keyId: made.key.keyId } }), ctx);
    expect(res.status).toBe(200);
    const rotated = body(res);
    expect(rotated.key.keyId).toBe(made.key.keyId);
    expect(rotated.key.organizerName).toBe('Org');
    expect(await works(made.secret)).toBe(false);
    expect(await works(rotated.secret)).toBe(true);
    expect(store.all('admin_audit_logs').map((a) => a.action)).toContain('developer_api_key_rotated');
  });

  it('changes scopes and the organizer, and refuses an empty or bad change', async () => {
    const { handlers } = setup();
    const { key } = body(await create(handlers));
    const patch = (payload) =>
      handlers.updateKey(makeRequest({ method: 'PATCH', params: { keyId: key.keyId }, body: payload }), ctx);
    const changed = await patch({ scopes: ['events:read', 'cfs:manage'], organizerName: 'Org 2', organizerContact: '' });
    expect(body(changed).key).toMatchObject({ scopes: ['events:read', 'cfs:manage'], organizerName: 'Org 2', organizerContact: null });
    expect((await patch({})).status).toBe(400);
    expect((await patch([])).status).toBe(400);
    expect((await patch({ organizerName: '' })).status).toBe(400);
    expect((await patch({ organizerName: 4 })).status).toBe(400);
    expect((await patch({ organizerContact: 'x'.repeat(300) })).status).toBe(400);
    expect((await patch({ scopes: [] })).status).toBe(400);
  });

  it('revokes: the hash is removed, the key is 401 on the next request, a second revoke is a no-op', async () => {
    const { handlers, works, store } = setup();
    const made = body(await create(handlers));
    const revoke = () =>
      handlers.revokeKey(makeRequest({ method: 'DELETE', params: { keyId: made.key.keyId } }), ctx);
    const res = await revoke();
    expect(body(res).key.active).toBe(false);
    expect(store.all('admin_config')[0]).not.toHaveProperty('keyHash');
    expect(await works(made.secret)).toBe(false);
    expect((await revoke()).status).toBe(200);
    expect(store.all('admin_audit_logs').filter((a) => a.action === 'developer_api_key_revoked')).toHaveLength(1);
  });

  it('refuses to rotate a revoked key, before or during the write', async () => {
    const { handlers, store, works } = setup();
    const made = body(await create(handlers));
    const params = { keyId: made.key.keyId };
    await handlers.revokeKey(makeRequest({ method: 'DELETE', params }), ctx);
    const res = await handlers.rotateKey(makeRequest({ method: 'POST', params }), ctx);
    expect(res.status).toBe(409);
    expect(body(res).code).toBe('KEY_REVOKED');
    expect(res.body).not.toContain('hcdk_');

    // Revoked between the first read and the rewrite.
    const other = body(await create(handlers, { organizerName: 'Org B', scopes: ['cfs:manage'] }));
    const read = store.readDoc;
    let reads = 0;
    store.readDoc = async (...args) => {
      const doc = await read(...args);
      reads += 1;
      return reads === 2 && doc ? { ...doc, revokedAt: 'now' } : doc;
    };
    const raced = await handlers.rotateKey(makeRequest({ method: 'POST', params: { keyId: other.key.keyId } }), ctx);
    expect(raced.status).toBe(409);
    store.readDoc = read;
    expect(await works(other.secret)).toBe(true);
  });

  it('answers 404 for an unknown or malformed key id', async () => {
    const { handlers, store } = setup();
    for (const keyId of ['0123456789abcdef', 'nope']) {
      const params = { keyId };
      expect((await handlers.revokeKey(makeRequest({ method: 'DELETE', params }), ctx)).status).toBe(404);
      expect((await handlers.rotateKey(makeRequest({ method: 'POST', params }), ctx)).status).toBe(404);
      expect(
        (await handlers.updateKey(makeRequest({ method: 'PATCH', params, body: { scopes: ['cfs:manage'] } }), ctx)).status,
      ).toBe(404);
    }
    // A record of another kind under the same id shape is not a key.
    store.put('admin_config', { id: keyRecordId('0123456789abcdef'), kind: 'other' }, ADMIN_CONFIG_PARTITION);
    expect(
      (await handlers.revokeKey(makeRequest({ method: 'DELETE', params: { keyId: '0123456789abcdef' } }), ctx)).status,
    ).toBe(404);
  });

  it('retries once on a lost race, then answers a sanitized 500', async () => {
    const { handlers, store } = setup();
    const { key } = body(await create(handlers));
    const real = store.replaceDocIfMatch;
    let calls = 0;
    store.replaceDocIfMatch = async (...args) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('stale'), { code: 412 });
      return real(...args);
    };
    const ok = await handlers.updateKey(
      makeRequest({ method: 'PATCH', params: { keyId: key.keyId }, body: { scopes: ['events:read'] } }),
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(calls).toBe(2);

    store.replaceDocIfMatch = async () => {
      throw Object.assign(new Error('stale'), { code: 412 });
    };
    const lost = await handlers.updateKey(
      makeRequest({ method: 'PATCH', params: { keyId: key.keyId }, body: { scopes: ['events:read'] } }),
      ctx,
    );
    expect(lost.status).toBe(500);
    store.replaceDocIfMatch = async () => {
      throw Object.assign(new Error('down'), { code: 503 });
    };
    const down = await handlers.rotateKey(makeRequest({ method: 'POST', params: { keyId: key.keyId } }), ctx);
    expect(down.status).toBe(500);
    expect(down.body).not.toContain('down');
  });

  it('keeps answering when the audit write fails, with a content-free log line', async () => {
    const { handlers, store, log } = setup();
    store.upsertDoc = async () => {
      throw new Error('audit down');
    };
    expect((await create(handlers)).status).toBe(201);
    expect(log.error).toHaveBeenCalledWith('[developer-api] audit row developer_api_key_generated failed');
  });

  it('returns the guard refusal as it is', async () => {
    const { handlers } = setup({ refuse: true });
    expect((await handlers.listKeys(makeRequest(), ctx)).status).toBe(403);
    expect((await create(handlers)).status).toBe(403);
  });

  it('works with a store whose writes answer nothing', async () => {
    const { handlers, store } = setup();
    const createDoc = store.createDoc;
    store.createDoc = async (...args) => {
      await createDoc(...args);
      return undefined;
    };
    const res = await create(handlers);
    expect(body(res).key.organizerName).toBe('Org');
    store.queryDocs = async () => undefined;
    expect(body(await handlers.listKeys(makeRequest(), ctx)).keys).toEqual([]);
  });
});

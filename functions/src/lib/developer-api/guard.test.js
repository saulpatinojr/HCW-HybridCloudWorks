import { describe, it, expect, vi } from 'vitest';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { createDeveloperApiGuard, getDeveloperApiGuard, resetDeveloperApiGuard } from './guard.js';
import { buildKeyRecord, generateKey, keyRecordId } from './keys.js';
import { createTestStore, makeRequest } from './test-store.test-helper.js';

const NOW = Date.parse('2026-11-21T10:00:30Z');

function setup({ scopes = ['cfs:manage'], requestsPerMinute } = {}) {
  const store = createTestStore();
  const { keyId, secret } = generateKey();
  const record = buildKeyRecord({ keyId, secret, actor: 'owner', organizer: { organizerName: 'Org', scopes } });
  store.put('admin_config', record, ADMIN_CONFIG_PARTITION);
  const auditDenial = vi.fn();
  const guard = createDeveloperApiGuard({ store, now: () => NOW, auditDenial, requestsPerMinute });
  const withKey = (key = secret) => makeRequest({ headers: { Authorization: `Bearer ${key}` } });
  return { store, keyId, secret, record, guard, auditDenial, withKey };
}

describe('the organizer key guard (ADR 0042)', () => {
  it('needs a store', () => {
    expect(() => createDeveloperApiGuard({})).toThrow(/store/);
  });

  it('lets a good key through as the organizer', async () => {
    const { guard, withKey, keyId } = setup();
    const auth = await guard.authenticate(withKey());
    expect(auth.error).toBeNull();
    expect(auth.user.developerKeyId).toBe(keyId);
    expect(auth.user.oid).toBe(`developer:${keyId}`);
  });

  it('refuses a missing or foreign-shaped value with 401, without a read or an audit row', async () => {
    const { guard, store, auditDenial } = setup();
    const read = vi.spyOn(store, 'readDoc');
    for (const request of [
      makeRequest(),
      makeRequest({ headers: { Authorization: 'Bearer some-entra-token' } }),
      makeRequest({ headers: { Authorization: `Bearer hcwk_${'a'.repeat(43)}` } }),
    ]) {
      const auth = await guard.authenticate(request);
      expect(auth.error.status).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
    expect(auditDenial).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret on a real id, with one audit row naming the reason, not the key', async () => {
    const { guard, keyId, secret, auditDenial } = setup();
    const wrong = `${secret.slice(0, -4)}AAAA`;
    const auth = await guard.authenticate(makeRequest({ headers: { 'X-API-Key': wrong } }));
    expect(auth.error.status).toBe(401);
    expect(auditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'developer-api-denial', reason: 'wrong-key', keyId }),
    );
    expect(JSON.stringify(auditDenial.mock.calls)).not.toContain(wrong);
  });

  it('refuses an id that names no record with 401 and no audit row (shaped values are free to make)', async () => {
    const { guard, auditDenial } = setup();
    const other = generateKey();
    const auth = await guard.authenticate(makeRequest({ headers: { Authorization: `Bearer ${other.secret}` } }));
    expect(auth.error.status).toBe(401);
    expect(auditDenial).not.toHaveBeenCalled();
  });

  it('refuses a revoked key on the very next request (no cache)', async () => {
    const { guard, store, record, withKey, auditDenial } = setup();
    expect((await guard.authenticate(withKey())).error).toBeNull();
    const { keyHash: _removed, ...rest } = record;
    store.put('admin_config', { ...rest, revokedAt: '2026-11-21T10:00:31Z' }, ADMIN_CONFIG_PARTITION);
    const auth = await guard.authenticate(withKey());
    expect(auth.error.status).toBe(401);
    expect(auditDenial).toHaveBeenCalledWith(expect.objectContaining({ reason: 'revoked-key' }));
  });

  it('answers 403 when the scope is off, and passes when it is on', async () => {
    const { guard, withKey, auditDenial } = setup({ scopes: ['events:read'] });
    const denied = await guard.requireScope(withKey(), 'cfs:manage');
    expect(denied.error.status).toBe(403);
    expect(JSON.parse(denied.error.body).error).toMatch(/cfs:manage/);
    expect(auditDenial).toHaveBeenCalledWith(expect.objectContaining({ reason: 'scope-off', scope: 'cfs:manage' }));
    expect((await guard.requireScope(withKey(), 'events:read')).error).toBeNull();
    // An authentication refusal comes back as it is.
    expect((await guard.requireScope(makeRequest(), 'events:read')).error.status).toBe(401);
  });

  it('answers 429 with Retry-After past the per-minute limit', async () => {
    const { guard, withKey, auditDenial } = setup({ requestsPerMinute: 2 });
    expect((await guard.authenticate(withKey())).error).toBeNull();
    expect((await guard.authenticate(withKey())).error).toBeNull();
    const limited = await guard.authenticate(withKey());
    expect(limited.error.status).toBe(429);
    expect(limited.error.headers['Retry-After']).toBe('30');
    expect(auditDenial).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rate-limited' }));
  });

  it('lets a quota fault that is not the limit through as a fault', async () => {
    const { guard, store, withKey } = setup();
    store.incrementIf = async () => {
      throw Object.assign(new Error('boom'), { code: 503 });
    };
    await expect(guard.authenticate(withKey())).rejects.toThrow('boom');
  });

  it('stamps lastUsedAt at most every five minutes, best effort', async () => {
    const { guard, store, withKey, keyId } = setup();
    const patch = vi.spyOn(store, 'patchDoc');
    await guard.authenticate(withKey());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][1]).toBe(keyRecordId(keyId));
    await guard.authenticate(withKey());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('keeps the same answer when the audit sink throws or rejects', async () => {
    const store = createTestStore();
    for (const auditDenial of [
      () => {
        throw new Error('sink');
      },
      () => Promise.reject(new Error('sink')),
    ]) {
      const { keyId, secret } = generateKey();
      const record = buildKeyRecord({ keyId, secret, actor: 'o', organizer: { organizerName: 'O', scopes: ['cfs:manage'] } });
      store.put('admin_config', record, ADMIN_CONFIG_PARTITION);
      const guard = createDeveloperApiGuard({ store, auditDenial });
      const auth = await guard.authenticate(makeRequest({ headers: { 'X-API-Key': generateKey({ keyId }).secret } }));
      expect(auth.error.status).toBe(401);
    }
  });

  it('composes one production guard lazily', () => {
    resetDeveloperApiGuard();
    const first = getDeveloperApiGuard();
    expect(getDeveloperApiGuard()).toBe(first);
    resetDeveloperApiGuard();
    expect(getDeveloperApiGuard()).not.toBe(first);
  });
});

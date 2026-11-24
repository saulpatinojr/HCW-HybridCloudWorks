import { describe, it, expect, vi } from 'vitest';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import {
  REFUSAL_CAP_REACHED,
  REFUSAL_ROWS_PER_MINUTE,
  createDeveloperApiGuard,
  getDeveloperApiGuard,
  resetDeveloperApiGuard,
} from './guard.js';
import { buildKeyRecord, generateKey, keyRecordId, quotaKeyFor, refusalQuotaKeyFor } from './keys.js';
import { createTestStore, makeRequest } from './test-store.test-helper.js';

const NOW = Date.parse('2026-11-21T10:00:30Z');

function setup({ scopes = ['cfs:manage'], requestsPerMinute, refusalRowsPerMinute, now = () => NOW } = {}) {
  const store = createTestStore();
  const { keyId, secret } = generateKey();
  const record = buildKeyRecord({ keyId, secret, actor: 'owner', organizer: { organizerName: 'Org', scopes } });
  store.put('admin_config', record, ADMIN_CONFIG_PARTITION);
  const auditDenial = vi.fn();
  const guard = createDeveloperApiGuard({ store, now, auditDenial, requestsPerMinute, refusalRowsPerMinute });
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

  describe('refusals that cost the caller nothing to repeat are capped per key id (#1777)', () => {
    const wrongOf = (secret) => `${secret.slice(0, -4)}${secret.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    const denials = (env) => env.auditDenial.mock.calls.filter(([entry]) => entry.kind === 'developer-api-denial');
    const capRows = (env) => env.auditDenial.mock.calls.filter(([entry]) => entry.kind === REFUSAL_CAP_REACHED);
    const revoke = ({ store, record }) => {
      const { keyHash: _removed, ...rest } = record;
      store.put('admin_config', { ...rest, revokedAt: '2026-11-21T10:00:31Z' }, ADMIN_CONFIG_PARTITION);
    };

    it('writes a row for each wrong key up to the cap, then keeps refusing with 401 and no row', async () => {
      const env = setup();
      const wrong = env.withKey(wrongOf(env.secret));
      for (let i = 0; i < REFUSAL_ROWS_PER_MINUTE + 15; i += 1) {
        const auth = await env.guard.authenticate(wrong);
        expect(auth.error.status).toBe(401);
        expect(auth.error.headers['Retry-After']).toBeUndefined();
      }
      // A row for each refusal up to the cap, then one row saying the cap was reached, then nothing.
      expect(env.auditDenial).toHaveBeenCalledTimes(REFUSAL_ROWS_PER_MINUTE + 1);
      expect(denials(env)).toHaveLength(REFUSAL_ROWS_PER_MINUTE);
      // One counter for the minute, stopped one past the cap: nothing grows with the requests.
      const counters = env.store.all('submission_quota');
      expect(counters.map((doc) => doc.id)).toEqual([refusalQuotaKeyFor(env.keyId, NOW)]);
      expect(counters[0].count).toBe(REFUSAL_ROWS_PER_MINUTE + 1);
    });

    it('writes exactly one "cap reached" row a minute, with the key id and nothing else, so held-back refusals are visible', async () => {
      const env = setup({ refusalRowsPerMinute: 2 });
      const wrong = env.withKey(wrongOf(env.secret));
      // Wrong keys use up the minute's rows, then the real key is revoked: its refusals get no row of their own.
      for (let i = 0; i < 6; i += 1) await env.guard.authenticate(wrong);
      revoke(env);
      for (let i = 0; i < 4; i += 1) expect((await env.guard.authenticate(env.withKey())).error.status).toBe(401);
      const entries = env.auditDenial.mock.calls.map(([entry]) => entry);
      expect(entries.map((entry) => entry.reason ?? entry.kind)).toEqual(['wrong-key', 'wrong-key', REFUSAL_CAP_REACHED]);
      expect(entries[2]).toEqual({ kind: REFUSAL_CAP_REACHED, outcome: 'rows-held-back', keyId: env.keyId });
      expect(JSON.stringify(entries[2])).not.toContain(env.secret);
    });

    it('writes the "cap reached" row once even when many refusals arrive together', async () => {
      const env = setup({ refusalRowsPerMinute: 3 });
      const wrong = env.withKey(wrongOf(env.secret));
      await Promise.all(Array.from({ length: 25 }, () => env.guard.authenticate(wrong)));
      expect(denials(env)).toHaveLength(3);
      expect(capRows(env)).toHaveLength(1);
    });

    it('stays silent past the cap when the counter fails on the second look', async () => {
      const env = setup({ refusalRowsPerMinute: 1 });
      const wrong = env.withKey(wrongOf(env.secret));
      await env.guard.authenticate(wrong);
      const incrementIf = env.store.incrementIf;
      let calls = 0;
      env.store.incrementIf = async (...args) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('down'), { code: 503 });
        return incrementIf(...args);
      };
      expect((await env.guard.authenticate(wrong)).error.status).toBe(401);
      expect(env.auditDenial).toHaveBeenCalledTimes(1);
    });

    it('answers the capped refusal exactly as the first one, so the answer says nothing about the id', async () => {
      const env = setup({ refusalRowsPerMinute: 1 });
      const wrong = env.withKey(wrongOf(env.secret));
      const first = await env.guard.authenticate(wrong);
      const capped = await env.guard.authenticate(wrong);
      expect(capped.error).toEqual(first.error);
      const unknown = await env.guard.authenticate(env.withKey(generateKey().secret));
      expect(unknown.error).toEqual(first.error);
      expect(denials(env)).toHaveLength(1);
      expect(capRows(env)).toHaveLength(1);
    });

    it("never slows the organizer's own right key, and does not use up its per-minute limit", async () => {
      const env = setup({ refusalRowsPerMinute: 2, requestsPerMinute: 3 });
      const wrong = env.withKey(wrongOf(env.secret));
      for (let i = 0; i < 20; i += 1) await env.guard.authenticate(wrong);
      for (let i = 0; i < 3; i += 1) expect((await env.guard.authenticate(env.withKey())).error).toBeNull();
      const byId = Object.fromEntries(env.store.all('submission_quota').map((doc) => [doc.id, doc.count]));
      expect(byId).toEqual({ [refusalQuotaKeyFor(env.keyId, NOW)]: 3, [quotaKeyFor(env.keyId, NOW)]: 3 });
    });

    it('caps a revoked key the same way, on the same counter as wrong keys', async () => {
      const env = setup({ refusalRowsPerMinute: 3 });
      await env.guard.authenticate(env.withKey(wrongOf(env.secret)));
      revoke(env);
      for (let i = 0; i < 6; i += 1) expect((await env.guard.authenticate(env.withKey())).error.status).toBe(401);
      expect(denials(env).map(([entry]) => entry.reason)).toEqual(['wrong-key', 'revoked-key', 'revoked-key']);
      expect(capRows(env)).toHaveLength(1);
    });

    it('caps the rows of a key over its per-minute limit, which is still answered 429', async () => {
      const env = setup({ requestsPerMinute: 1, refusalRowsPerMinute: 2 });
      expect((await env.guard.authenticate(env.withKey())).error).toBeNull();
      for (let i = 0; i < 5; i += 1) {
        const limited = await env.guard.authenticate(env.withKey());
        expect(limited.error.status).toBe(429);
        expect(limited.error.headers['Retry-After']).toBe('30');
      }
      expect(denials(env)).toHaveLength(2);
      expect(capRows(env)).toHaveLength(1);
    });

    it('counts each key id on its own, and starts again the next minute', async () => {
      let clock = NOW;
      const env = setup({ refusalRowsPerMinute: 1, now: () => clock });
      const other = generateKey();
      env.store.put(
        'admin_config',
        buildKeyRecord({ keyId: other.keyId, secret: other.secret, actor: 'owner', organizer: { organizerName: 'B', scopes: ['cfs:manage'] } }),
        ADMIN_CONFIG_PARTITION,
      );
      const wrong = env.withKey(wrongOf(env.secret));
      await env.guard.authenticate(wrong);
      await env.guard.authenticate(wrong);
      await env.guard.authenticate(env.withKey(wrongOf(other.secret)));
      expect(denials(env).map(([entry]) => entry.keyId)).toEqual([env.keyId, other.keyId]);
      expect(capRows(env).map(([entry]) => entry.keyId)).toEqual([env.keyId]);
      clock = NOW + 60_000;
      await env.guard.authenticate(wrong);
      expect(denials(env)).toHaveLength(3);
    });

    it('writes no counter and no row for an id that names no record', async () => {
      const env = setup();
      for (let i = 0; i < 5; i += 1) await env.guard.authenticate(env.withKey(generateKey().secret));
      expect(env.store.all('submission_quota')).toEqual([]);
      expect(env.auditDenial).not.toHaveBeenCalled();
    });

    it('still refuses with 401, and still writes the row, when the counter itself fails', async () => {
      const env = setup();
      env.store.incrementIf = async () => {
        throw Object.assign(new Error('boom'), { code: 503 });
      };
      const auth = await env.guard.authenticate(env.withKey(wrongOf(env.secret)));
      expect(auth.error.status).toBe(401);
      expect(env.auditDenial).toHaveBeenCalledWith(expect.objectContaining({ reason: 'wrong-key' }));
    });

    it('never puts the presented key in a counter id or a row', async () => {
      const env = setup();
      const wrong = wrongOf(env.secret);
      await env.guard.authenticate(env.withKey(wrong));
      // Everything after the second underscore. The random part may itself
      // hold an underscore (it is base64url), so `split('_')[2]` was now and
      // then an empty string, and `not.toContain('')` always fails (#1798).
      const secretPart = wrong.slice(wrong.indexOf('_', wrong.indexOf('_') + 1) + 1);
      expect(secretPart.length).toBeGreaterThan(8);
      expect(JSON.stringify(env.store.all('submission_quota'))).not.toContain(secretPart);
      expect(JSON.stringify(env.auditDenial.mock.calls)).not.toContain(secretPart);
    });
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

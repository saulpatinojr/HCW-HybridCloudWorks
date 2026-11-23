import { describe, it, expect, vi } from 'vitest';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { createDeveloperApiAdminHandlers, READ_ROLE, WRITE_ROLE } from './admin-handlers.js';
import { createDeveloperApiGuard } from './guard.js';
import { CFS_CONTAINER, callDocId } from './cfs.js';
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

  describe("a speaker's erasure request (#1777)", () => {
    const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const seeded = (options) => {
      const env = setup(options);
      const put = (n, eventId, speakerEmail, extra = {}) =>
        env.store.put(
          CFS_CONTAINER,
          {
            id: UUID(n),
            eventId,
            docType: 'cfs-submission',
            speakerName: 'Grace Hopper',
            speakerEmail,
            speakerBio: 'A bio.',
            title: 'Running Arc at home',
            abstract: 'A lab story.',
            status: 'pending',
            submittedAt: `2026-11-2${n}T10:00:00.000Z`,
            ...extra,
          },
          eventId,
        );
      put(1, 'cloud-day-2027', 'grace@example.com');
      put(2, 'other-day-2027', 'grace@example.com', { status: 'accepted' });
      put(3, 'cloud-day-2027', 'ada@example.com');
      env.store.put(
        CFS_CONTAINER,
        { id: callDocId('cloud-day-2027'), eventId: 'cloud-day-2027', docType: 'cfs-call', status: 'open' },
        'cloud-day-2027',
      );
      const find = (speakerEmail) =>
        env.handlers.findProposals(makeRequest({ method: 'POST', body: { speakerEmail } }), ctx);
      const erase = (submissionId) =>
        env.handlers.eraseProposal(makeRequest({ method: 'DELETE', params: { submissionId } }), ctx);
      const proposals = () => env.store.all(CFS_CONTAINER).filter((doc) => doc.docType === 'cfs-submission');
      return { ...env, find, erase, proposals, UUID };
    };

    it("finds one address's proposals across every organizer's calls, with ids and dates only", async () => {
      const env = seeded();
      const res = await env.find('  Grace@Example.com ');
      expect(res.status).toBe(200);
      expect(env.requireRole.mock.calls.at(-1)[1]).toBe(WRITE_ROLE);
      const answer = body(res);
      expect(answer).toMatchObject({ ok: true, count: 2, truncated: false });
      expect(answer.proposals.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: UUID(1), eventId: 'cloud-day-2027', status: 'pending', submittedAt: '2026-11-21T10:00:00.000Z' },
        { id: UUID(2), eventId: 'other-day-2027', status: 'accepted', submittedAt: '2026-11-22T10:00:00.000Z' },
      ]);
      // Nothing the speaker wrote, and not the address, comes back.
      for (const text of ['grace@example.com', 'Grace Hopper', 'A bio.', 'Running Arc', 'A lab story.']) {
        expect(res.body).not.toContain(text);
      }
      // A read: no audit row, and nothing deleted.
      expect(env.store.all('admin_audit_logs')).toEqual([]);
      expect(env.proposals()).toHaveLength(3);
    });

    it('answers an empty list for an address with no proposals, and 400 for a bad or missing address', async () => {
      const env = seeded();
      expect(body(await env.find('nobody@example.com'))).toMatchObject({ proposals: [], count: 0 });
      expect((await env.find('not-an-address')).status).toBe(400);
      expect((await env.find(undefined)).status).toBe(400);
      expect((await env.handlers.findProposals(makeRequest({ method: 'POST', body: 'not json' }), ctx)).status).toBe(400);
      env.store.queryDocs = async () => undefined;
      expect(body(await env.find('grace@example.com'))).toMatchObject({ proposals: [], count: 0, truncated: false });
    });

    it('says so when there are more than it answers', async () => {
      const env = seeded();
      env.store.queryDocs = async (_name, query) => {
        expect(query).toContain('TOP 201');
        return Array.from({ length: 201 }, (_, i) => ({ id: UUID(i), eventId: 'e' }));
      };
      const answer = body(await env.find('grace@example.com'));
      expect(answer.count).toBe(200);
      expect(answer.truncated).toBe(true);
    });

    it('deletes one proposal by id, whoever owns the call, and leaves the rest and the call', async () => {
      const env = seeded();
      const res = await env.erase(UUID(2));
      expect(res.status).toBe(200);
      expect(env.requireRole.mock.calls.at(-1)[1]).toBe(WRITE_ROLE);
      expect(body(res)).toEqual({ ok: true, id: UUID(2), eventId: 'other-day-2027', deleted: true });
      expect(env.proposals().map((doc) => doc.id).sort()).toEqual([UUID(1), UUID(3)]);
      expect(await env.store.readDoc(CFS_CONTAINER, callDocId('cloud-day-2027'), 'cloud-day-2027')).not.toBeNull();
    });

    it('writes one audit row with the event and status only: no name, address or text', async () => {
      const env = seeded();
      await env.erase(UUID(1));
      const rows = env.store.all('admin_audit_logs');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'developer_cfs_submission_erased',
        resourceType: 'developer_cfs_submission',
        resourceId: UUID(1),
        userId: ADMIN.oid,
        details: { eventId: 'cloud-day-2027', status: 'pending' },
      });
      const text = JSON.stringify(rows[0].details) + rows[0].resourceId;
      for (const secret of ['grace@example.com', 'Grace Hopper', 'A bio.', 'Running Arc', 'A lab story.']) {
        expect(text).not.toContain(secret);
      }
    });

    it('is safe to ask twice, and for an id that never existed: 200 with deleted false and no row', async () => {
      const env = seeded();
      await env.erase(UUID(1));
      expect(body(await env.erase(UUID(1)))).toEqual({ ok: true, id: UUID(1), deleted: false });
      expect(body(await env.erase(UUID(9)))).toEqual({ ok: true, id: UUID(9), deleted: false });
      expect(env.store.all('admin_audit_logs')).toHaveLength(1);
    });

    it('refuses an id that is not a UUID before any read, so a call cannot be deleted here', async () => {
      const env = seeded();
      const query = vi.spyOn(env.store, 'queryDocs');
      expect((await env.erase(callDocId('cloud-day-2027'))).status).toBe(400);
      expect((await env.erase(undefined)).status).toBe(400);
      expect(query).not.toHaveBeenCalled();
      expect(env.store.all(CFS_CONTAINER)).toHaveLength(4);
    });

    it('deletes under the version it found, reads again after one lost race, and answers 409 after two', async () => {
      const env = seeded();
      const real = env.store.deleteDocIfMatch;
      const etags = [];
      let raced = false;
      env.store.deleteDocIfMatch = async (name, id, etag, pk) => {
        etags.push([etag, pk]);
        if (!raced) {
          raced = true;
          const current = await env.store.readDoc(name, id, pk);
          env.store.put(name, { ...current, status: 'rejected' }, pk);
        }
        return real(name, id, etag, pk);
      };
      expect(body(await env.erase(UUID(1))).deleted).toBe(true);
      expect(etags).toHaveLength(2);
      expect(etags[0][0]).not.toBe(etags[1][0]);
      expect(etags[0][1]).toBe('cloud-day-2027');
      expect(env.store.all('admin_audit_logs')[0].details.status).toBe('rejected');

      const fail = (code) => {
        env.store.deleteDocIfMatch = async () => {
          throw Object.assign(new Error('cosmos said: detail'), { code });
        };
      };
      fail(412);
      const conflict = await env.erase(UUID(3));
      expect(conflict.status).toBe(409);
      fail(404);
      expect(body(await env.erase(UUID(3)))).toEqual({ ok: true, id: UUID(3), deleted: false });
      fail(503);
      const failed = await env.erase(UUID(3));
      expect(failed.status).toBe(500);
      expect(failed.body).not.toContain('detail');
      expect(env.proposals().map((doc) => doc.id)).toContain(UUID(3));
    });

    it('is refused without the role, on both routes, before anything is read', async () => {
      const env = seeded({ refuse: true });
      const query = vi.spyOn(env.store, 'queryDocs');
      expect((await env.find('grace@example.com')).status).toBe(403);
      expect((await env.erase(UUID(1))).status).toBe(403);
      expect(query).not.toHaveBeenCalled();
      expect(env.proposals()).toHaveLength(3);
    });
  });
});

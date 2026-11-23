import { describe, it, expect } from 'vitest';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { createClientIdentity } from '../auth/client-identity.js';
import { createDeveloperApiGuard } from './guard.js';
import { createDeveloperApiHandlers, ENDPOINTS } from './handlers.js';
import { buildKeyRecord, generateKey } from './keys.js';
import { CFS_CONTAINER, MAX_SUBMISSION_BYTES, SUBMISSIONS_PER_CLIENT_PER_HOUR, callDocId } from './cfs.js';
import { createTestStore, makeRequest, testContext } from './test-store.test-helper.js';

const NOW = Date.parse('2026-11-21T10:00:00Z');
const EVENT = 'cloud-day-2027';

const SNAPSHOT = {
  id: 'speakerevents',
  publishedAt: '2026-11-20T00:00:00Z',
  meta: {
    speakerId: 'abc123',
    speakerProfile: { name: 'Site Owner', bio: 'Hybrid cloud.', links: [{ label: 'Blog', url: 'https://example.com' }] },
  },
  items: [
    { id: 'e1', name: 'Azure Day', date: '2026-12-01', location: 'Austin', display: true, sessions: [{ title: 'Arc at scale' }] },
    { id: 'e2', name: 'Old Day', date: '2025-01-01', display: true },
    { id: 'e3', sessionizeId: 9, display: false },
  ],
};

function setup({ scopes = ['cfs:manage'], identity, now = () => NOW } = {}) {
  const store = createTestStore();
  store.put('_snapshots', SNAPSHOT);
  const make = (name, keyScopes = scopes) => {
    const { keyId, secret } = generateKey();
    const record = buildKeyRecord({ keyId, secret, actor: 'owner', organizer: { organizerName: name, scopes: keyScopes } });
    store.put('admin_config', record, ADMIN_CONFIG_PARTITION);
    return { keyId, secret, record };
  };
  const org = make('Org A');
  const guard = createDeveloperApiGuard({ store, now });
  let n = 0;
  const handlers = createDeveloperApiHandlers({
    guard,
    store,
    publicStore: store,
    identity: identity || createClientIdentity({ allowUnverifiedOrigin: true, ipSalt: 'salt' }),
    now,
    uuid: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
  });
  const keyed = (secret, opts = {}) =>
    makeRequest({ ...opts, headers: { Authorization: `Bearer ${secret}`, ...(opts.headers || {}) } });
  return { store, handlers, org, make, keyed };
}

const ctx = testContext();
const body = (res) => JSON.parse(res.body);
const proposal = (extra = {}) => ({
  speakerName: 'Grace',
  speakerEmail: 'Grace@Example.com',
  title: 'Running Arc at home',
  abstract: 'A lab story.',
  level: 'beginner',
  ...extra,
});
const submit = (handlers, payload, { eventId = EVENT, ip = '203.0.113.7' } = {}) =>
  handlers.submitProposal(
    makeRequest({ method: 'POST', params: { eventId }, headers: { 'cf-connecting-ip': ip }, body: payload }),
    ctx,
  );

describe('Developer API v1 handlers (ADR 0042, Phase 1)', () => {
  it('needs its dependencies', () => {
    expect(() => createDeveloperApiHandlers({})).toThrow(/requires/);
    expect(() => createDeveloperApiHandlers({ guard: {}, store: {}, publicStore: {}, identity: {} })).toThrow(
      /anonymousKey/,
    );
  });

  it('walks the Phase 1 acceptance line end to end, and a revoke stops the key at once', async () => {
    const { store, handlers, org, keyed } = setup();

    // Reads published events and speakers (public, no key).
    const events = body(await handlers.publishedEvents(makeRequest(), ctx));
    expect(events.events.map((e) => e.id)).toEqual(['e2', 'e1']);
    const speakers = body(await handlers.speakers(makeRequest({ query: { q: 'arc' } }), ctx));
    expect(speakers.speakers[0].name).toBe('Site Owner');

    // Opens a call.
    const opened = await handlers.setCall(
      keyed(org.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'open', title: 'CfS 2027' } }),
      ctx,
    );
    expect(opened.status).toBe(201);
    expect(body(opened).call).toMatchObject({ eventId: EVENT, status: 'open', title: 'CfS 2027' });

    // Takes a public proposal.
    const sent = await submit(handlers, proposal());
    expect(sent.status).toBe(201);
    expect(body(sent)).toEqual({ ok: true, id: expect.any(String), status: 'pending' });

    // Lists it for review.
    const listed = body(
      await handlers.listSubmissions(keyed(org.secret, { params: { eventId: EVENT } }), ctx),
    );
    expect(listed.count).toBe(1);
    expect(listed.submissions[0]).toMatchObject({ speakerEmail: 'grace@example.com', status: 'pending' });

    // Accepts it: a decision for the organizer, nothing made public.
    const reviewed = await handlers.reviewSubmission(
      keyed(org.secret, {
        method: 'PUT',
        params: { eventId: EVENT, submissionId: body(sent).id },
        body: { decision: 'accepted', note: 'Great' },
      }),
      ctx,
    );
    expect(reviewed.status).toBe(200);
    expect(body(reviewed).submission).toMatchObject({ status: 'accepted', reviewNote: 'Great' });

    // Every keyed write left an audit row naming the key id, never the key.
    const audits = store.all('admin_audit_logs');
    expect(audits.map((a) => a.action).sort()).toEqual(['developer_cfs_opened', 'developer_cfs_submission_reviewed']);
    expect(JSON.stringify(audits)).not.toContain(org.secret);
    expect(JSON.stringify(audits)).not.toContain('grace@example.com');

    // Revoked in the admin: the next request is 401.
    const { keyHash: _removed, ...rest } = store.all('admin_config')[0];
    store.put('admin_config', { ...rest, revokedAt: 'now' }, ADMIN_CONFIG_PARTITION);
    const after = await handlers.listSubmissions(keyed(org.secret, { params: { eventId: EVENT } }), ctx);
    expect(after.status).toBe(401);
  });

  it('answers the status of a working key, and 401 without one', async () => {
    const { handlers, org, keyed } = setup();
    const res = await handlers.status(keyed(org.secret), ctx);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ organizer: { keyId: org.keyId, name: 'Org A' }, scopes: ['cfs:manage'] });
    expect(body(res).endpoints).toHaveLength(ENDPOINTS.length);
    expect((await handlers.status(makeRequest(), ctx)).status).toBe(401);
  });

  it('serves the public reads with a public cache, and refuses bad filters with 400', async () => {
    const { handlers } = setup();
    const res = await handlers.publishedEvents(makeRequest({ query: { from: '2026-01-01' } }), ctx);
    expect(res.headers['Cache-Control']).toMatch(/public/);
    expect(body(res).events.map((e) => e.id)).toEqual(['e1']);
    expect((await handlers.publishedEvents(makeRequest({ query: { from: 'soon' } }), ctx)).status).toBe(400);
    expect((await handlers.speakers(makeRequest({ query: { q: 'x'.repeat(101) } }), ctx)).status).toBe(400);
  });

  it('answers a sanitized 500 when the snapshot read fails', async () => {
    const { handlers, store } = setup();
    store.readDoc = async () => {
      throw new Error('cosmos down at https://secret-host');
    };
    const res = await handlers.publishedEvents(makeRequest(), ctx);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('secret-host');
  });

  describe('opening and closing a call', () => {
    it('needs cfs:manage', async () => {
      const { handlers, make, keyed } = setup();
      const reader = make('Reader', ['events:read']);
      const res = await handlers.setCall(
        keyed(reader.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'open' } }),
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('refuses a bad event id, a bad body and bad JSON with 400', async () => {
      const { handlers, org, keyed } = setup();
      const call = (params, payload) => handlers.setCall(keyed(org.secret, { method: 'POST', params, body: payload }), ctx);
      expect((await call({ eventId: 'Bad Id' }, { action: 'open' })).status).toBe(400);
      expect((await call({ eventId: EVENT }, { action: 'publish' })).status).toBe(400);
      expect((await call({ eventId: EVENT }, { action: 'open', closesAt: '2020-01-01' })).status).toBe(400);
      expect((await call({ eventId: EVENT }, '{not json')).status).toBe(400);
    });

    it('closes and reopens its own call, and cannot close a call that does not exist', async () => {
      const { handlers, org, keyed } = setup();
      const call = (payload) =>
        handlers.setCall(keyed(org.secret, { method: 'POST', params: { eventId: EVENT }, body: payload }), ctx);
      expect((await call({ action: 'close' })).status).toBe(404);
      expect((await call({ action: 'open', description: 'Line one\nLine two' })).status).toBe(201);
      const closed = await call({ action: 'close' });
      expect(closed.status).toBe(200);
      expect(body(closed).call.status).toBe('closed');
      const reopened = await call({ action: 'open', closesAt: '2027-01-01T00:00:00Z' });
      expect(body(reopened).call).toMatchObject({ status: 'open', description: 'Line one\nLine two' });
    });

    it("answers 404 on another organizer's event, the same as no call at all", async () => {
      const { handlers, org, make, keyed } = setup();
      await handlers.setCall(
        keyed(org.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'open' } }),
        ctx,
      );
      const other = make('Org B');
      for (const payload of [{ action: 'open' }, { action: 'close' }]) {
        const res = await handlers.setCall(
          keyed(other.secret, { method: 'POST', params: { eventId: EVENT }, body: payload }),
          ctx,
        );
        expect(res.status).toBe(404);
      }
      const list = await handlers.listSubmissions(keyed(other.secret, { params: { eventId: EVENT } }), ctx);
      expect(list.status).toBe(404);
    });

    it("refuses to open a call on one of the site's own published event ids", async () => {
      const { handlers, org, keyed } = setup();
      const res = await handlers.setCall(
        keyed(org.secret, { method: 'POST', params: { eventId: 'e1x' }, body: { action: 'open' } }),
        ctx,
      );
      expect(res.status).toBe(201);
      const env = setup();
      env.store.put('_snapshots', { ...SNAPSHOT, items: [{ id: 'azure-day-2026', name: 'A', display: true }] });
      const reserved = await env.handlers.setCall(
        env.keyed(env.org.secret, { method: 'POST', params: { eventId: 'azure-day-2026' }, body: { action: 'open' } }),
        ctx,
      );
      expect(reserved.status).toBe(409);
      expect(body(reserved).code).toBe('EVENT_ID_RESERVED');
    });

    it('keeps the deadline and opening time on a reopen unless sent, and clears a field sent as null', async () => {
      let clock = NOW;
      const env = setup({ now: () => clock });
      const call = (payload) =>
        env.handlers.setCall(env.keyed(env.org.secret, { method: 'POST', params: { eventId: EVENT }, body: payload }), ctx);
      const first = body(await call({ action: 'open', title: 'T', closesAt: '2026-12-01T00:00:00Z' })).call;
      clock += 1000;
      const again = body(await call({ action: 'open' })).call;
      expect(again).toMatchObject({ title: 'T', closesAt: '2026-12-01T00:00:00.000Z', openedAt: first.openedAt });
      const cleared = body(await call({ action: 'open', title: null, closesAt: null })).call;
      expect(cleared).toMatchObject({ title: null, closesAt: null });
    });

    it('reports a call past its deadline as not accepting proposals', async () => {
      let clock = NOW;
      const env = setup({ now: () => clock });
      await env.handlers.setCall(
        env.keyed(env.org.secret, {
          method: 'POST',
          params: { eventId: EVENT },
          body: { action: 'open', closesAt: '2026-11-22T00:00:00Z' },
        }),
        ctx,
      );
      const list = () => env.handlers.listSubmissions(env.keyed(env.org.secret, { params: { eventId: EVENT } }), ctx);
      expect(body(await list()).call).toMatchObject({ status: 'open', acceptingProposals: true });
      clock = Date.parse('2026-11-23T00:00:00Z');
      expect(body(await list()).call).toMatchObject({ status: 'open', acceptingProposals: false });
    });

    it('answers 409 when the call changed between the read and the write', async () => {
      const { handlers, org, keyed, store } = setup();
      const open = () =>
        handlers.setCall(keyed(org.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'open' } }), ctx);
      await open();
      const replace = store.replaceDocIfMatch;
      store.replaceDocIfMatch = async () => {
        throw Object.assign(new Error('stale'), { code: 412 });
      };
      expect((await open()).status).toBe(409);
      store.replaceDocIfMatch = async () => {
        throw Object.assign(new Error('down'), { code: 503 });
      };
      expect((await open()).status).toBe(500);
      store.replaceDocIfMatch = replace;
    });
  });

  describe('sending a proposal (public)', () => {
    const openCall = async ({ handlers, org, keyed }, extra = {}) =>
      handlers.setCall(
        keyed(org.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'open', ...extra } }),
        ctx,
      );

    it('is refused when no call is open, and after the call closes', async () => {
      const env = setup();
      expect((await submit(env.handlers, proposal())).status).toBe(404);
      await openCall(env);
      await env.handlers.setCall(
        env.keyed(env.org.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'close' } }),
        ctx,
      );
      expect((await submit(env.handlers, proposal())).status).toBe(404);
    });

    it('is refused once the closing time has passed', async () => {
      let clock = NOW;
      const env = setup({ now: () => clock });
      await openCall(env, { closesAt: '2026-11-22T00:00:00Z' });
      expect((await submit(env.handlers, proposal())).status).toBe(201);
      clock = Date.parse('2026-11-22T00:00:01Z');
      expect((await submit(env.handlers, proposal(), { ip: '198.51.100.2' })).status).toBe(404);
    });

    it('stores a pending proposal with only the allowed fields', async () => {
      const env = setup();
      await openCall(env);
      const res = await submit(env.handlers, proposal({ status: 'accepted', admin: true }));
      expect(res.status).toBe(201);
      const stored = env.store.all(CFS_CONTAINER).find((d) => d.docType === 'cfs-submission');
      expect(stored.status).toBe('pending');
      expect(stored).not.toHaveProperty('admin');
    });

    it('refuses bad input: bad JSON, a too-large body, a honeypot, a bad email, a bad level, a bad event id', async () => {
      const env = setup();
      await openCall(env);
      expect((await submit(env.handlers, '{nope')).status).toBe(400);
      expect((await submit(env.handlers, proposal({ abstract: 'x'.repeat(MAX_SUBMISSION_BYTES) }))).status).toBe(413);
      expect((await submit(env.handlers, proposal({ website: 'http://spam' }))).status).toBe(400);
      expect((await submit(env.handlers, proposal({ speakerEmail: 'nope' }))).status).toBe(400);
      expect((await submit(env.handlers, proposal({ level: 'guru' }))).status).toBe(400);
      expect((await submit(env.handlers, proposal({ title: '' }))).status).toBe(400);
      expect((await submit(env.handlers, proposal(), { eventId: '../x' })).status).toBe(400);
    });

    it('limits each client per hour, with Retry-After', async () => {
      const env = setup();
      await openCall(env);
      for (let i = 0; i < SUBMISSIONS_PER_CLIENT_PER_HOUR; i += 1) {
        expect((await submit(env.handlers, proposal())).status).toBe(201);
      }
      const limited = await submit(env.handlers, proposal());
      expect(limited.status).toBe(429);
      expect(limited.headers['Retry-After']).toBe('3600');
      // Another client is not affected.
      expect((await submit(env.handlers, proposal(), { ip: '198.51.100.9' })).status).toBe(201);
    });

    it('limits each call per hour, across clients', async () => {
      const env = setup();
      await openCall(env);
      env.store.put('submission_quota', { id: `developer-cfs:call:${EVENT}`, windowStartMs: NOW, count: 100 });
      expect((await submit(env.handlers, proposal())).status).toBe(429);
    });

    it('refuses an unverified origin with 403 when the origin lock is on', async () => {
      const identity = createClientIdentity({ allowUnverifiedOrigin: false, originSecret: 'x', ipSalt: 's' });
      const env = setup({ identity });
      const res = await submit(env.handlers, proposal());
      expect(res.status).toBe(403);
    });

    it('lets an identity fault that is not the origin check through as a 500', async () => {
      const identity = {
        anonymousKey: () => {
          throw new Error('bug');
        },
      };
      const env = setup({ identity });
      expect((await submit(env.handlers, proposal())).status).toBe(500);
    });

    it('lets a quota fault that is not the limit through as a 500', async () => {
      const env = setup();
      await openCall(env);
      env.store.incrementIf = async () => {
        throw Object.assign(new Error('down'), { code: 503 });
      };
      expect((await submit(env.handlers, proposal())).status).toBe(500);
    });

    it('lets a call-quota fault that is not the limit through as a 500', async () => {
      const env = setup();
      await openCall(env);
      const real = env.store.incrementIf;
      env.store.incrementIf = async (name, id, opts) => {
        if (id.startsWith('developer-cfs:call:')) throw Object.assign(new Error('down'), { code: 503 });
        return real(name, id, opts);
      };
      expect((await submit(env.handlers, proposal())).status).toBe(500);
    });

    it('reads a request without a text body as empty', async () => {
      const env = setup();
      const request = makeRequest({ method: 'POST', params: { eventId: EVENT } });
      delete request.text;
      expect((await env.handlers.submitProposal(request, ctx)).status).toBe(400);
    });

    it('refuses a body the client declares as too large before reading it', async () => {
      const env = setup();
      await openCall(env);
      let read = false;
      const request = makeRequest({
        method: 'POST',
        params: { eventId: EVENT },
        headers: { 'cf-connecting-ip': '203.0.113.7', 'content-length': String(MAX_SUBMISSION_BYTES + 1) },
        body: proposal(),
      });
      request.text = async () => {
        read = true;
        return '';
      };
      expect((await env.handlers.submitProposal(request, ctx)).status).toBe(413);
      expect(read).toBe(false);
      // A size at the cap, and a header that is not a number, are read and measured as before.
      const sized = (length) =>
        env.handlers.submitProposal(
          makeRequest({
            method: 'POST',
            params: { eventId: EVENT },
            headers: { 'cf-connecting-ip': '203.0.113.7', 'content-length': length },
            body: proposal(),
          }),
          ctx,
        );
      expect((await sized(String(MAX_SUBMISSION_BYTES))).status).toBe(201);
      expect((await sized('nope')).status).toBe(201);
    });
  });

  describe("sending proposals through the organizer's own server (the relay)", () => {
    // One server, one address: what an organizer's backend looks like to the limit.
    const RELAY_IP = '192.0.2.50';
    const open = (env, key = env.org, eventId = EVENT) =>
      env.handlers.setCall(
        env.keyed(key.secret, { method: 'POST', params: { eventId }, body: { action: 'open' } }),
        ctx,
      );
    const relay = (env, secret, { eventId = EVENT, headers = {} } = {}) =>
      env.handlers.submitProposal(
        makeRequest({
          method: 'POST',
          params: { eventId },
          headers: { 'cf-connecting-ip': RELAY_IP, ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers },
          body: proposal(),
        }),
        ctx,
      );
    const clientCounters = (env) =>
      env.store.all('submission_quota').filter((doc) => doc.id.startsWith('developer-cfs:client:'));

    it('lets the key that owns the call send more than the per-visitor limit from one address', async () => {
      const env = setup();
      await open(env);
      for (let i = 0; i < SUBMISSIONS_PER_CLIENT_PER_HOUR + 1; i += 1) {
        expect((await relay(env, env.org.secret)).status).toBe(201);
      }
      // The per-visitor counter was never touched; the per-call one counted every proposal.
      expect(clientCounters(env)).toEqual([]);
      const perCall = env.store.all('submission_quota').find((doc) => doc.id === `developer-cfs:call:${EVENT}`);
      expect(perCall.count).toBe(SUBMISSIONS_PER_CLIENT_PER_HOUR + 1);
      // Each one is stored as an ordinary pending proposal, with nothing of the key on it.
      const stored = env.store.all(CFS_CONTAINER).filter((doc) => doc.docType === 'cfs-submission');
      expect(stored).toHaveLength(SUBMISSIONS_PER_CLIENT_PER_HOUR + 1);
      expect(stored.every((doc) => doc.status === 'pending')).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(env.org.keyId);
    });

    it('still stops the sixth proposal in the hour from one address with no key', async () => {
      const env = setup();
      await open(env);
      for (let i = 0; i < SUBMISSIONS_PER_CLIENT_PER_HOUR; i += 1) {
        expect((await relay(env, null)).status).toBe(201);
      }
      expect((await relay(env, null)).status).toBe(429);
      // The owner's key, from that same address, is still let through.
      expect((await relay(env, env.org.secret)).status).toBe(201);
    });

    it('still holds the owning key to the per-call limit, the open-call check and the checks on the body', async () => {
      const env = setup();
      // No call yet: the same 404 a visitor gets.
      expect((await relay(env, env.org.secret)).status).toBe(404);
      await open(env);
      const bad = makeRequest({
        method: 'POST',
        params: { eventId: EVENT },
        headers: { 'cf-connecting-ip': RELAY_IP, Authorization: `Bearer ${env.org.secret}` },
        body: proposal({ website: 'http://spam' }),
      });
      expect((await env.handlers.submitProposal(bad, ctx)).status).toBe(400);
      env.store.put('submission_quota', { id: `developer-cfs:call:${EVENT}`, windowStartMs: NOW, count: 100 });
      const limited = await relay(env, env.org.secret);
      expect(limited.status).toBe(429);
      expect(limited.headers['Retry-After']).toBe('3600');
    });

    it("gives a key that does not own the call no way past the per-visitor limit", async () => {
      const env = setup();
      await open(env);
      const other = env.make('Org B');
      for (let i = 0; i < SUBMISSIONS_PER_CLIENT_PER_HOUR; i += 1) {
        expect((await relay(env, other.secret)).status).toBe(201);
      }
      expect((await relay(env, other.secret)).status).toBe(429);
      expect(clientCounters(env)).toHaveLength(1);
    });

    it('gives a key without cfs:manage no way past it either, and writes no refusal row', async () => {
      const env = setup();
      await open(env);
      // The same key record, with the scope taken away after it opened the call.
      const [record] = env.store.all('admin_config');
      env.store.put('admin_config', { ...record, scopes: ['events:read'] }, ADMIN_CONFIG_PARTITION);
      for (let i = 0; i < SUBMISSIONS_PER_CLIENT_PER_HOUR; i += 1) {
        expect((await relay(env, env.org.secret)).status).toBe(201);
      }
      expect((await relay(env, env.org.secret)).status).toBe(429);
      expect(env.store.all('admin_audit_logs').filter((row) => row.kind === 'developer-api-denial')).toEqual([]);
    });

    it('answers 401 to a wrong or revoked key, and stores nothing', async () => {
      const env = setup();
      await open(env);
      const wrong = `${env.org.secret.slice(0, -4)}${env.org.secret.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
      expect((await relay(env, wrong)).status).toBe(401);
      const [record] = env.store.all('admin_config');
      const { keyHash: _removed, ...rest } = record;
      env.store.put('admin_config', { ...rest, revokedAt: 'now' }, ADMIN_CONFIG_PARTITION);
      expect((await relay(env, env.org.secret)).status).toBe(401);
      expect(env.store.all(CFS_CONTAINER).filter((doc) => doc.docType === 'cfs-submission')).toEqual([]);
    });

    it('treats a bearer value that is not an organizer key as no key at all', async () => {
      const env = setup();
      await open(env);
      const reads = [];
      const real = env.store.readDoc;
      env.store.readDoc = async (name, ...rest) => {
        reads.push(name);
        return real(name, ...rest);
      };
      expect((await relay(env, 'some-other-token')).status).toBe(201);
      expect(reads).not.toContain('admin_config');
      expect(clientCounters(env)).toHaveLength(1);
    });

    it('still refuses an unverified origin before the key is looked at', async () => {
      const identity = createClientIdentity({ allowUnverifiedOrigin: false, originSecret: 'x', ipSalt: 's' });
      const env = setup({ identity });
      await open(env);
      expect((await relay(env, env.org.secret)).status).toBe(403);
    });
  });

  describe('listing and reviewing proposals', () => {
    async function withProposals() {
      const env = setup();
      await env.handlers.setCall(
        env.keyed(env.org.secret, { method: 'POST', params: { eventId: EVENT }, body: { action: 'open' } }),
        ctx,
      );
      const first = body(await submit(env.handlers, proposal()));
      const second = body(await submit(env.handlers, proposal({ title: 'Second' }), { ip: '198.51.100.4' }));
      return { ...env, first, second };
    }

    it('filters by status and refuses an unknown status', async () => {
      const env = await withProposals();
      const list = (status) =>
        env.handlers.listSubmissions(
          env.keyed(env.org.secret, { params: { eventId: EVENT }, query: status ? { status } : {} }),
          ctx,
        );
      expect(body(await list('pending')).count).toBe(2);
      expect(body(await list('accepted')).count).toBe(0);
      expect((await list('published')).status).toBe(400);
      expect((await env.handlers.listSubmissions(makeRequest({ params: { eventId: EVENT } }), ctx)).status).toBe(401);
    });

    it('refuses a bad submission id, a bad decision, and an unknown proposal', async () => {
      const env = await withProposals();
      const review = (submissionId, payload, eventId = EVENT) =>
        env.handlers.reviewSubmission(
          env.keyed(env.org.secret, { method: 'PUT', params: { eventId, submissionId }, body: payload }),
          ctx,
        );
      expect((await review('nope', { decision: 'accepted' })).status).toBe(400);
      expect((await review(env.first.id, { decision: 'publish' })).status).toBe(400);
      expect((await review(env.first.id, null)).status).toBe(400);
      expect((await review('00000000-0000-4000-8000-999999999999', { decision: 'accepted' })).status).toBe(404);
      expect((await env.handlers.reviewSubmission(makeRequest({ method: 'PUT' }), ctx)).status).toBe(401);
    });

    it('can put a decision back to pending, clearing who reviewed it', async () => {
      const env = await withProposals();
      const review = (decision) =>
        env.handlers.reviewSubmission(
          env.keyed(env.org.secret, {
            method: 'PUT',
            params: { eventId: EVENT, submissionId: env.first.id },
            body: { decision },
          }),
          ctx,
        );
      await review('rejected');
      const back = body(await review('pending'));
      expect(back.submission).toMatchObject({ status: 'pending', reviewedAt: null });
    });

    it('answers 409 when the proposal changed between the read and the write', async () => {
      const env = await withProposals();
      env.store.replaceDocIfMatch = async () => {
        throw Object.assign(new Error('stale'), { code: 412 });
      };
      const res = await env.handlers.reviewSubmission(
        env.keyed(env.org.secret, {
          method: 'PUT',
          params: { eventId: EVENT, submissionId: env.first.id },
          body: { decision: 'accepted' },
        }),
        ctx,
      );
      expect(res.status).toBe(409);
      env.store.replaceDocIfMatch = async () => {
        throw Object.assign(new Error('down'), { code: 500 });
      };
      const failed = await env.handlers.reviewSubmission(
        env.keyed(env.org.secret, {
          method: 'PUT',
          params: { eventId: EVENT, submissionId: env.first.id },
          body: { decision: 'accepted' },
        }),
        ctx,
      );
      expect(failed.status).toBe(500);
    });

    it("answers 404 when a second organizer's key reviews or lists another organizer's proposals", async () => {
      const env = await withProposals();
      const other = env.make('Org B');
      const reviewed = await env.handlers.reviewSubmission(
        env.keyed(other.secret, {
          method: 'PUT',
          params: { eventId: EVENT, submissionId: env.first.id },
          body: { decision: 'rejected', note: 'Not yours' },
        }),
        ctx,
      );
      expect(reviewed.status).toBe(404);
      expect(reviewed.body).not.toContain('grace@example.com');
      // The proposal is as it was, and no review was recorded.
      const stored = await env.store.readDoc(CFS_CONTAINER, env.first.id, EVENT);
      expect(stored).toMatchObject({ status: 'pending', reviewNote: null, reviewedBy: null });
      expect(env.store.all('admin_audit_logs').map((row) => row.action)).not.toContain(
        'developer_cfs_submission_reviewed',
      );
      const listed = await env.handlers.listSubmissions(env.keyed(other.secret, { params: { eventId: EVENT } }), ctx);
      expect(listed.status).toBe(404);
      expect(listed.body).not.toContain('grace@example.com');
    });

    it('stores the call under its event partition', async () => {
      const env = await withProposals();
      expect(await env.store.readDoc(CFS_CONTAINER, callDocId(EVENT), EVENT)).toMatchObject({
        organizerKeyId: env.org.keyId,
      });
    });
  });
});

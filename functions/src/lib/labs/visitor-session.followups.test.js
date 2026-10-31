/**
 * The follow-ups to the visitor lab sessions, from two reviews:
 * #1400 (who may start, read and end a session) and #1403 (the clean-up).
 * https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400
 * https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403
 *
 * Each describe names the item it holds. The handlers get the real client
 * identity helper, built as production builds it, and a store that runs the
 * module's own SQL (test/cosmos-predicate.js) and, where it matters, ages
 * records out by their `ttl` the way Cosmos does (test/memory-store.js).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCosmosQuery } from '../../../test/cosmos-predicate.js';
import { memoryStore } from '../../../test/memory-store.js';
import { createClientIdentity } from '../auth/client-identity.js';
import { CHECK_ATTEMPTS_PER_WINDOW, CHECK_WINDOW_MS, LOCK_CODES, LOCK_REASONS } from './public-lock.js';
import {
  CODER_PROVISION_TIMEOUT_MS,
  DOOR_CODES,
  PROVISION_LEASE_MS,
  VISITOR_DOC_TTL_SECONDS,
  VISITOR_PENDING_DOC_TTL_SECONDS,
  VISITOR_CHECK_REASONS,
  VISITOR_READS_PER_WINDOW,
  VISITOR_SESSION_SWITCH,
  createVisitorSessionHandlers,
  reapExpiredVisitorSessions,
} from './visitor-session.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const DAY = '2026-10-31';
const SITE = 'https://hybridcloudworks.com';
const CODER = { base: 'https://coder.lab.hybridcloudworks.com', token: 'broker-token' };
const ORIGIN_SECRET = 'test-origin-secret';
const IP_SALT = 'test-ip-salt';
const ALICE = '203.0.113.10';
const BOB = '203.0.113.20';
const iso = (ms) => new Date(ms).toISOString();

const identity = () =>
  createClientIdentity({ originSecret: ORIGIN_SECRET, ipSalt: IP_SALT, allowUnverifiedOrigin: false });
const fromCaller = (ip, extra = {}) =>
  new Headers({ 'x-hcw-origin-secret': ORIGIN_SECRET, 'cf-connecting-ip': ip, ...extra });
const keyOf = (ip) => identity().anonymousKey({ headers: fromCaller(ip) }).key;
const ALICE_KEY = keyOf(ALICE);

/** A Cosmos-like store that runs the module's SQL, with the daily cap's conditional increment. */
function store(docs = [], { now = null } = {}) {
  const s = memoryStore(Object.fromEntries(docs.map((d) => [`lab_jobs/${d.id}`, d])), { query: runCosmosQuery, now });
  s.incrementIf = vi.fn(async (container, id, options) => {
    const doc = s.docs.get(`${container}/${id}`);
    if (!doc) throw Object.assign(new Error('NotFound'), { code: 404 });
    const { limit, floor } = options.conditionValues;
    const count = doc.count || 0;
    if ((typeof limit === 'number' && count >= limit) || (typeof floor === 'number' && count <= floor)) {
      throw Object.assign(new Error('PreconditionFailed'), { code: 412 });
    }
    doc.count = count + options.value;
    return doc;
  });
  return s;
}

/** Starts a visitor has used today: what the counter took, less the refunds written for it (#1464 review, round 2). */
const quotaOf = (s, key = ALICE_KEY) => {
  const id = `visitor-quota:${key}:${DAY}`;
  const refunds = [...s.docs.values()].filter((d) => d.kind === 'visitor_refund' && d.quotaId === id).length;
  return (s.get('submission_quota', id)?.count ?? 0) - refunds;
};
const refundDocs = (s) => [...s.docs.keys()].filter((key) => key.startsWith('submission_quota/visitor-refund:'));

/** Turnstile, answering what the test says, and a Coder that accepts everything. */
function visitorFetch({ siteverify = { success: true, hostname: 'hybridcloudworks.com', action: 'visitor-session' } } = {}) {
  let users = 0;
  return vi.fn(async (url) => {
    const target = String(url);
    if (target.startsWith('https://challenges.cloudflare.com/')) return { ok: true, json: async () => siteverify };
    if (target.endsWith('/api/v2/templates')) return { ok: true, json: async () => [{ id: 'tmpl-1', name: 'hcw-lab' }] };
    if (target.endsWith('/api/v2/organizations')) return { ok: true, json: async () => [{ id: 'org-1' }] };
    if (target.endsWith('/api/v2/users')) {
      users += 1;
      return { ok: true, json: async () => ({ id: `u-${users}`, username: `v-00000000000${users}` }) };
    }
    if (/\/members\/[^/]+\/workspaces$/.test(target)) return { ok: true, json: async () => ({ id: `ws-${users}` }) };
    return { ok: true, status: 200 };
  });
}

const siteverifyCalls = (fetchImpl) =>
  fetchImpl.mock.calls.filter(([url]) => String(url).startsWith('https://challenges.cloudflare.com/')).length;
const coderCalls = (fetchImpl) =>
  fetchImpl.mock.calls
    .filter(([url]) => String(url).startsWith(CODER.base))
    .map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(url).pathname}`);

const startAs = (handlers, ip, context) =>
  handlers.startSession(
    {
      headers: fromCaller(ip, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: 'turnstile-token-sample' }),
    },
    context
  );
const statusAs = (handlers, ip, context) => handlers.getStatus({ headers: fromCaller(ip) }, context);
const stopAs = (handlers, ip, id, context) =>
  handlers.stopSession(
    { url: `https://api.hybridcloudworks.com/api/public/labs/visitor-session?sessionId=${id}`, headers: fromCaller(ip) },
    context
  );
const parsed = (res) => ({ status: res.status, body: JSON.parse(res.body) });

const session = (id, overrides = {}) => ({
  id,
  type: 'visitor-session',
  status: 'active',
  clientHash: 'someone-else',
  labId: 'landing-zone-builder-output',
  coderUserId: `u-${id}`,
  coderUsername: 'v-aaaaaaaaaaaa',
  workspaceId: `ws-${id}`,
  workspaceName: 'lab-lzb',
  accessUrl: `https://code-server--lab-lzb--v-${id}.coder.lab.hybridcloudworks.com/`,
  expiresAt: iso(NOW + 30 * 60 * 1000),
  ttl: VISITOR_DOC_TTL_SECONDS,
  ...overrides,
});

let now = NOW;
const clock = () => now;

beforeEach(() => {
  now = NOW;
  vi.stubEnv(VISITOR_SESSION_SWITCH, 'true');
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'turnstile-secret');
  vi.stubEnv('CODER_URL', CODER.base);
  vi.stubEnv('CODER_BROKER_TOKEN', CODER.token);
  vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '2');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('#1400 item 1: a daily start is spent only when a new lab is really made', () => {
  it('hands the caller back their own running session without counting it', async () => {
    const s = store();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    const first = parsed(await startAs(handlers, ALICE));
    const reloads = [parsed(await startAs(handlers, ALICE)), parsed(await startAs(handlers, ALICE))];

    expect(first.status).toBe(201);
    expect(reloads.map((r) => [r.status, r.body.sessionId])).toEqual([
      [200, first.body.sessionId],
      [200, first.body.sessionId],
    ]);
    expect(quotaOf(s)).toBe(1);
  });

  it('does not count a start refused because the lab is full', async () => {
    const s = store([session('peer-1'), session('peer-2')]);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    const full = parsed(await startAs(handlers, ALICE));

    expect(full.status).toBe(503);
    expect(full.body.code).toBe(DOOR_CODES.capacity_full);
    expect(quotaOf(s)).toBe(0);
    expect(s.incrementIf).not.toHaveBeenCalled();
  });
});

describe('#1400 item 2: how often one visitor may ask', () => {
  it(`asks Cloudflare at most ${CHECK_ATTEMPTS_PER_WINDOW} times per visitor in ten minutes, then answers 429 before asking`, async () => {
    const fetchImpl = visitorFetch({ siteverify: { success: false, 'error-codes': ['invalid-input-response'] } });
    const context = { warn: vi.fn() };
    const handlers = createVisitorSessionHandlers({ store: store(), identity: identity(), fetchImpl, clock });

    for (let i = 0; i < CHECK_ATTEMPTS_PER_WINDOW; i += 1) expect((await startAs(handlers, ALICE, context)).status).toBe(403);
    const refused = await startAs(handlers, ALICE, context);

    expect(refused.status).toBe(429);
    expect(refused.headers['Retry-After']).toBe(String(CHECK_WINDOW_MS / 1000));
    expect(JSON.parse(refused.body)).toEqual({ ok: false, code: LOCK_CODES.attempts, reason: VISITOR_CHECK_REASONS[LOCK_CODES.attempts] });
    expect(siteverifyCalls(fetchImpl)).toBe(CHECK_ATTEMPTS_PER_WINDOW);
    expect(context.warn).toHaveBeenLastCalledWith(
      'visitor-session: refused a start: too many human verification checks from one visitor'
    );

    // Another visitor is not held to Alice's count, and Alice's window ends.
    expect((await startAs(handlers, BOB, context)).status).toBe(403);
    now += CHECK_WINDOW_MS;
    expect((await startAs(handlers, ALICE, context)).status).toBe(403);
    expect(siteverifyCalls(fetchImpl)).toBe(CHECK_ATTEMPTS_PER_WINDOW + 2);
  });

  it(`reads the status at most ${VISITOR_READS_PER_WINDOW} times per visitor in ten minutes, then answers 429 without a query`, async () => {
    const s = store();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    for (let i = 0; i < VISITOR_READS_PER_WINDOW; i += 1) expect((await statusAs(handlers, ALICE)).status).toBe(200);
    const queries = s.queryDocs.mock.calls.length;
    const refused = parsed(await statusAs(handlers, ALICE));

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ configured: true, open: false, code: DOOR_CODES.reads_rate_limited });
    expect(s.queryDocs.mock.calls.length).toBe(queries);
    expect((await statusAs(handlers, BOB)).status).toBe(200);
  });

  it('counts a stop against the same limit as the status read, before it reads the store', async () => {
    const s = store();
    const handlers = createVisitorSessionHandlers({
      store: s,
      identity: identity(),
      fetchImpl: visitorFetch(),
      clock,
      readLimiter: { take: () => false },
    });

    expect((await stopAs(handlers, ALICE, 'sess-1')).status).toBe(429);
    expect(s.readDoc).not.toHaveBeenCalled();
  });
});

describe('#1400 item 3: the human verification detail goes to the log, not to the visitor', () => {
  it.each([
    ['our own setting is wrong', { success: false, 'error-codes': ['missing-input-secret'] }, 503, LOCK_CODES.unavailable],
    ['the visitor failed the check', { success: false, 'error-codes': ['invalid-input-response'] }, 403, LOCK_CODES.failed],
    ['the token was made on another site', { success: true, hostname: 'evil.example', action: 'visitor-session' }, 403, LOCK_CODES.failed],
  ])('answers a plain sentence when %s, and logs why', async (_name, siteverify, status, code) => {
    const context = { warn: vi.fn() };
    const handlers = createVisitorSessionHandlers({ store: store(), identity: identity(), fetchImpl: visitorFetch({ siteverify }), clock });

    const res = parsed(await startAs(handlers, ALICE, context));

    expect(res).toEqual({ status, body: { ok: false, code, reason: VISITOR_CHECK_REASONS[code] } });
    // The visitor session's own words, not the lab submission's (#1464 review, finding H).
    expect(VISITOR_CHECK_REASONS[code]).not.toBe(LOCK_REASONS[code]);
    expect(JSON.stringify(res.body)).not.toMatch(/missing-input-secret|invalid-input-response|evil\.example|siteverify|error codes/);
    const [line] = context.warn.mock.calls.at(-1);
    expect(line).toMatch(/^visitor-session: refused a start by the human verification check: /);
    expect(line).toMatch(/missing-input-secret|invalid-input-response|evil\.example/);
  });
});

describe('#1403 item 2: a start whose process died is cleaned up from the record it wrote first', () => {
  const crashed = (overrides = {}) => ({
    id: 'p-1',
    type: 'visitor-session',
    status: 'provisioning',
    endStatus: 'ended',
    clientHash: ALICE_KEY,
    labId: 'landing-zone-builder-output',
    coderUsername: 'v-0123456789ab',
    workspaceName: 'lab-lzb',
    createdAt: iso(NOW),
    cleanupAttempts: 0,
    workspaceGone: false,
    userGone: false,
    retryAt: iso(NOW + PROVISION_LEASE_MS),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
    ...overrides,
  });

  /** A Coder with or without the visitor's user and workspace, for the lookups by name. */
  function coderWith({ user = true, workspace = true } = {}) {
    return vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v2/users/v-0123456789ab' && (init?.method ?? 'GET') === 'GET') {
        return user ? { ok: true, status: 200, json: async () => ({ id: 'u-made', username: 'v-0123456789ab' }) } : { ok: false, status: 404 };
      }
      if (path === '/api/v2/users/v-0123456789ab/workspace/lab-lzb') {
        return workspace
          ? { ok: true, status: 200, json: async () => ({ id: 'ws-made', name: 'lab-lzb', owner_id: 'u-made' }) }
          : { ok: false, status: 404 };
      }
      return { ok: true, status: 200 };
    });
  }

  const sweep = (s, fetchImpl, log) => reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now), log });

  it('leaves it alone while its lease runs: the start may still be under way', async () => {
    const s = store([crashed()]);
    const fetchImpl = coderWith();
    now = NOW + PROVISION_LEASE_MS - 1000;

    await sweep(s, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.get('lab_jobs', 'p-1').status).toBe('provisioning');
  });

  it('finds the user and the workspace by name after the lease, deletes both, and saves it as over', async () => {
    const s = store([crashed()]);
    const fetchImpl = coderWith();
    now = NOW + PROVISION_LEASE_MS;

    expect(await sweep(s, fetchImpl)).toMatchObject({ finished: 1 });

    expect(coderCalls(fetchImpl)).toEqual([
      'GET /api/v2/users/v-0123456789ab',
      'GET /api/v2/users/v-0123456789ab/workspace/lab-lzb',
      'POST /api/v2/workspaces/ws-made/builds',
      'DELETE /api/v2/users/u-made',
    ]);
    expect(s.get('lab_jobs', 'p-1')).toMatchObject({
      status: 'ended',
      coderUserId: 'u-made',
      workspaceId: 'ws-made',
      workspaceConfirmedBy: 'ok',
      userConfirmedBy: 'ok',
    });
  });

  it('takes Coder having no such user as nothing made at all, and calls nothing else', async () => {
    const s = store([crashed()]);
    const fetchImpl = coderWith({ user: false });
    now = NOW + PROVISION_LEASE_MS;

    expect(await sweep(s, fetchImpl)).toMatchObject({ finished: 1 });

    expect(coderCalls(fetchImpl)).toEqual(['GET /api/v2/users/v-0123456789ab']);
    expect(s.get('lab_jobs', 'p-1')).toMatchObject({ status: 'ended', userConfirmedBy: 'not found', workspaceConfirmedBy: 'no user' });
  });

  it('never sends a stored user name that is not of the broker\'s own shape', async () => {
    const s = store([crashed({ coderUsername: 'admin' })]);
    const fetchImpl = coderWith();
    const log = vi.fn();
    now = NOW + PROVISION_LEASE_MS;

    expect(await sweep(s, fetchImpl, log)).toMatchObject({ pending: 1 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.get('lab_jobs', 'p-1').status).toBe('cleanup_pending');
    expect(log.mock.calls.at(-1)[0]).toContain('user user lookup invalid name');
  });

  it('cleans up the note of a start that failed at the user by looking only for the user', async () => {
    const s = store([crashed({ status: 'cleanup_pending', startFailed: true, workspaceGone: true, retryAt: iso(NOW) })]);
    const fetchImpl = coderWith();

    expect(await sweep(s, fetchImpl)).toMatchObject({ finished: 1 });

    expect(coderCalls(fetchImpl)).toEqual(['GET /api/v2/users/v-0123456789ab', 'DELETE /api/v2/users/u-made']);
    expect(s.get('lab_jobs', 'p-1')).toMatchObject({ status: 'ended', coderUserId: 'u-made', userConfirmedBy: 'ok' });
  });

  it('gives the lease room for the four provisioning calls at their timeouts', () => {
    expect(PROVISION_LEASE_MS).toBeGreaterThan(4 * CODER_PROVISION_TIMEOUT_MS);
  });
});

describe('#1403 item 4: what confirmed each half is kept, and a 404 is said in the log', () => {
  it("records 'gone' for a half Coder answered 404, and 'ok' for one it accepted, and logs the 404", async () => {
    const s = store([session('s-1', { clientHash: ALICE_KEY })]);
    const fetchImpl = vi.fn(async (url) => (String(url).includes('/builds') ? { ok: false, status: 404 } : { ok: true, status: 200 }));
    const context = { warn: vi.fn() };
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    expect(parsed(await stopAs(handlers, ALICE, 's-1', context)).body.cleanup).toBe('done');

    expect(s.get('lab_jobs', 's-1')).toMatchObject({ status: 'ended', workspaceConfirmedBy: 'gone', userConfirmedBy: 'ok' });
    expect(context.warn).toHaveBeenCalledWith(
      "visitor-session: a session's Coder clean-up was taken as done on a 404 or 410 (workspace gone, user ok)"
    );
  });

  it('logs nothing extra when both deletes were accepted', async () => {
    const s = store([session('s-2', { clientHash: ALICE_KEY })]);
    const context = { warn: vi.fn() };
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    await stopAs(handlers, ALICE, 's-2', context);

    expect(s.get('lab_jobs', 's-2')).toMatchObject({ workspaceConfirmedBy: 'ok', userConfirmedBy: 'ok' });
    expect(context.warn).not.toHaveBeenCalled();
  });
});

describe('#1403 item 5: a session whose workspace Coder has not confirmed as deleted still holds a slot', () => {
  const waiting = (id, overrides) =>
    session(id, { status: 'cleanup_pending', retryAt: iso(NOW + 60_000), accessUrl: undefined, ...overrides });

  it.each([
    ['waiting, with the workspace not yet deleted', waiting('w-1', { workspaceGone: false }), 1],
    ['waiting, with the workspace deleted and only the user left', waiting('w-1', { workspaceGone: true }), 0],
    ['given up, with the workspace not deleted', waiting('w-1', { status: 'cleanup_failed', workspaceGone: false }), 1],
    ['a start under way', session('p-1', { status: 'provisioning', retryAt: iso(NOW + 60_000) }), 1],
    ['over', session('e-1', { status: 'ended', workspaceGone: true, userGone: true }), 0],
  ])('counts %s, as the slots it holds', async (_name, record, holds) => {
    const handlers = createVisitorSessionHandlers({ store: store([record]), identity: identity(), fetchImpl: visitorFetch(), clock });

    const status = parsed(await statusAs(handlers, ALICE)).body;

    expect(status.bounds.activeCount).toBe(holds);
  });

  it('refuses a new start while one running and one waiting session fill the two slots', async () => {
    const s = store([session('peer-1'), waiting('w-1', { workspaceGone: false })]);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    const res = parsed(await startAs(handlers, ALICE));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(DOOR_CODES.capacity_full);
    expect(parsed(await statusAs(handlers, ALICE)).body).toMatchObject({ open: false, code: DOOR_CODES.capacity_full });
  });
});

describe('#1403 item 6: a session that leaves active drops the lab address', () => {
  it('keeps no accessUrl once a stop has claimed it, whether Coder finished or not', async () => {
    const s = store([session('s-1', { clientHash: ALICE_KEY }), session('s-2', { clientHash: keyOf(BOB) })]);
    const fetchImpl = vi.fn(async (url) => (String(url).includes('/users/') ? { ok: false, status: 417 } : { ok: true, status: 200 }));
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    await stopAs(handlers, ALICE, 's-1');
    expect(s.get('lab_jobs', 's-1').status).toBe('cleanup_pending');
    expect(s.get('lab_jobs', 's-1').accessUrl).toBeUndefined();

    fetchImpl.mockImplementation(async () => ({ ok: true, status: 200 }));
    await stopAs(handlers, BOB, 's-2');
    expect(s.get('lab_jobs', 's-2').status).toBe('ended');
    expect(s.get('lab_jobs', 's-2').accessUrl).toBeUndefined();
  });
});

describe('#1403 item 7: the stop says whether the clean-up is done', () => {
  it.each([
    ['Coder confirmed both deletes', async () => ({ ok: true, status: 200 }), 'done'],
    ['Coder refused the user (it still has the workspace)', async (url) => (String(url).includes('/users/') ? { ok: false, status: 417 } : { ok: true, status: 200 }), 'pending'],
  ])('answers cleanup %s', async (_name, answer, cleanup) => {
    const s = store([session('s-1', { clientHash: ALICE_KEY })]);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: vi.fn(answer), clock });

    expect(parsed(await stopAs(handlers, ALICE, 's-1'))).toEqual({ status: 200, body: { ok: true, status: 'ended', cleanup } });
  });
});

describe('#1403 item 8: records age out when Cosmos would delete them', () => {
  it('keeps a finished session two hours and a waiting one a week, counted from their last write', async () => {
    const s = store([], { now: clock });
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });
    const alice = parsed(await startAs(handlers, ALICE)).body.sessionId;
    const bob = parsed(await startAs(handlers, BOB)).body.sessionId;

    // Alice ends hers and Coder confirms; Bob's clean-up is refused and waits.
    await stopAs(handlers, ALICE, alice);
    const refusing = createVisitorSessionHandlers({
      store: s,
      identity: identity(),
      fetchImpl: vi.fn(async (url) => (String(url).includes('/users/') ? { ok: false, status: 417 } : { ok: true, status: 200 })),
      clock,
    });
    await stopAs(refusing, BOB, bob);
    expect([s.get('lab_jobs', alice)?.status, s.get('lab_jobs', bob)?.status]).toEqual(['ended', 'cleanup_pending']);

    now += VISITOR_DOC_TTL_SECONDS * 1000;
    expect(s.get('lab_jobs', alice)).toBeNull();
    expect(s.get('lab_jobs', bob)).not.toBeNull();

    now = NOW + VISITOR_PENDING_DOC_TTL_SECONDS * 1000;
    expect(s.get('lab_jobs', bob)).toBeNull();
  });
});

describe('#1464 review, finding A: starts that overlap cannot get past the limits', () => {
  const coderUsers = (fetchImpl) => coderCalls(fetchImpl).filter((call) => call === 'POST /api/v2/users').length;
  const active = (s) =>
    [...s.docs.entries()].filter(([path, doc]) => path.startsWith('lab_jobs/') && doc.status === 'active').length;

  it('lets only one of two starts by one visitor at the same moment make a lab, and spends one start', async () => {
    const s = store();
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    const results = (await Promise.all([startAs(handlers, ALICE), startAs(handlers, ALICE)])).map(parsed);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.code).toBe(DOOR_CODES.start_in_progress);
    expect(quotaOf(s)).toBe(1);
    expect(active(s)).toBe(1);
    expect(coderUsers(fetchImpl)).toBe(1);
    // The lock is let go when the start ends: the next press gets the running session back.
    expect(parsed(await startAs(handlers, ALICE)).status).toBe(200);
  });

  it('lets only one of two visitors starting at the same moment take the last slot', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const s = store();
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    const [alice, bob] = (await Promise.all([startAs(handlers, ALICE), startAs(handlers, BOB)])).map(parsed);

    expect([alice.status, bob.status].sort()).toEqual([201, 503]);
    expect([alice, bob].find((r) => r.status === 503).body.code).toBe(DOOR_CODES.capacity_full);
    expect(active(s)).toBe(1);
    expect(coderUsers(fetchImpl)).toBe(1);
    // The visitor turned away spent nothing.
    const turnedAway = alice.status === 503 ? ALICE_KEY : keyOf(BOB);
    expect(quotaOf(s, turnedAway)).toBe(0);
  });

  it('takes over a start lock whose time has passed, and not one that is still running', async () => {
    const lockId = `visitor-start:${ALICE_KEY}`;
    const s = store();
    s.docs.set(`submission_quota/${lockId}`, { id: lockId, sessionId: 'other', expiresAt: iso(NOW + 1000), _etag: '"l1"' });
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    expect(parsed(await startAs(handlers, ALICE)).status).toBe(409);
    now = NOW + 1000;
    expect(parsed(await startAs(handlers, ALICE)).status).toBe(201);
  });

  it("lets a session's slot go when it ends, so the next visitor can take it", async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const s = store();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });
    const alice = parsed(await startAs(handlers, ALICE)).body.sessionId;
    expect(s.get('submission_quota', 'visitor-slot:0')).toMatchObject({ sessionId: alice });
    expect(parsed(await startAs(handlers, BOB)).status).toBe(503);

    await stopAs(handlers, ALICE, alice);

    expect(s.get('submission_quota', 'visitor-slot:0').sessionId).toBeNull();
    expect(parsed(await startAs(handlers, BOB)).status).toBe(201);
  });

  it('takes over a slot that was never let go only once it is old and its session holds no lab', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const s = store([session('gone-1', { status: 'ended', workspaceGone: true, userGone: true })]);
    s.docs.set('submission_quota/visitor-slot:0', { id: 'visitor-slot:0', sessionId: 'gone-1', takenAt: iso(NOW - 60_000), _etag: '"s1"' });
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    // Too young to judge: a session that has just taken a slot may not be visible yet.
    expect(parsed(await startAs(handlers, ALICE)).status).toBe(503);
    now = NOW + PROVISION_LEASE_MS;
    expect(parsed(await startAs(handlers, ALICE)).status).toBe(201);
  });
});

describe('#1464 review, finding B: the list of labs is read again after a sweep the start waited for', () => {
  it('still counts a session past its hour whose workspace delete Coder refused during that sweep', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const s = store([session('old-1', { expiresAt: iso(NOW - 1000) })]);
    const inner = visitorFetch();
    const fetchImpl = vi.fn(async (url, init) =>
      String(url).includes('/builds') ? { ok: false, status: 500 } : inner(url, init)
    );
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    const res = parsed(await startAs(handlers, ALICE));

    expect(s.get('lab_jobs', 'old-1')).toMatchObject({ status: 'cleanup_pending', workspaceGone: false });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(DOOR_CODES.capacity_full);
    expect(coderCalls(fetchImpl)).not.toContain('POST /api/v2/users');
  });
});

describe('#1464 review, finding C: a daily start is given back at most once', () => {
  const dead = (overrides = {}) =>
    session('p-1', {
      status: 'provisioning',
      endStatus: 'ended',
      clientHash: ALICE_KEY,
      coderUserId: undefined,
      workspaceId: undefined,
      coderUsername: 'v-0123456789ab',
      dailyCap: { container: 'submission_quota', id: `visitor-quota:${ALICE_KEY}:${DAY}` },
      dailyCapRefund: 'pending',
      workspaceGone: false,
      userGone: false,
      retryAt: iso(NOW - 1000),
      ...overrides,
    });
  const noSuchUser = vi.fn(async () => ({ ok: false, status: 404 }));

  it('gives back the start of a start whose process died, when the sweep cleans its record, and only once', async () => {
    const s = store([dead()]);
    s.docs.set(`submission_quota/visitor-quota:${ALICE_KEY}:${DAY}`, { id: `visitor-quota:${ALICE_KEY}:${DAY}`, count: 2, _etag: '"q"' });

    await reapExpiredVisitorSessions(s, noSuchUser, CODER, { nowIso: iso(now) });
    now += 60 * 60 * 1000;
    await reapExpiredVisitorSessions(s, noSuchUser, CODER, { nowIso: iso(now) });

    expect(quotaOf(s)).toBe(1);
    expect(refundDocs(s)).toEqual(['submission_quota/visitor-refund:p-1']);
    expect(s.get('lab_jobs', 'p-1')).toMatchObject({ status: 'ended', dailyCapRefund: 'given' });
  });

  it('gives nothing back for a record whose start already gave it back, or that started', async () => {
    const s = store([dead({ dailyCapRefund: 'given', status: 'cleanup_pending' }), dead({ id: 'p-2', dailyCapRefund: 'spent', status: 'cleanup_pending' })]);
    s.docs.set(`submission_quota/visitor-quota:${ALICE_KEY}:${DAY}`, { id: `visitor-quota:${ALICE_KEY}:${DAY}`, count: 2, _etag: '"q"' });

    await reapExpiredVisitorSessions(s, noSuchUser, CODER, { nowIso: iso(now) });

    expect(quotaOf(s)).toBe(2);
    expect(refundDocs(s)).toEqual([]);
  });

  it('leaves the give-back to the sweep, and gives it back once in all, when the failed start cannot write its note', async () => {
    const s = store();
    const replace = s.replaceDocIfMatch.getMockImplementation();
    let refuse = true;
    s.replaceDocIfMatch.mockImplementation(async (container, doc, options) => {
      if (container === 'lab_jobs' && refuse) throw Object.assign(new Error('down'), { code: 503 });
      return replace(container, doc, options);
    });
    const inner = visitorFetch();
    const fetchImpl = vi.fn(async (url, init) =>
      /\/members\/[^/]+\/workspaces$/.test(String(url)) ? { ok: false, status: 400 } : inner(url, init)
    );
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    expect((await startAs(handlers, ALICE, { error: vi.fn() })).status).toBe(502);
    expect(quotaOf(s)).toBe(1);

    refuse = false;
    now = NOW + PROVISION_LEASE_MS;
    await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now) });
    await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now + 60 * 60 * 1000) });
    expect(quotaOf(s)).toBe(0);
  });
});

describe('#1464 review, finding F: a user is looked up by name only when its create got no clear answer', () => {
  /** Coder refusing (or not answering) the user create, with the lookups recorded. */
  const createAnswering = (answer) => {
    const inner = visitorFetch();
    return vi.fn(async (url, init) => {
      if (String(url).endsWith('/api/v2/users')) {
        if (answer === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        return { ok: false, status: answer, text: async () => 'taken' };
      }
      return inner(url, init);
    });
  };

  it('saves the record as over at once when Coder refuses the user outright (409), and looks nothing up', async () => {
    const s = store();
    const fetchImpl = createAnswering(409);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    expect((await startAs(handlers, ALICE, { error: vi.fn() })).status).toBe(502);
    const [record] = [...s.docs.entries()].filter(([path]) => path.startsWith('lab_jobs/')).map(([, d]) => d);
    expect(record).toMatchObject({ status: 'ended', userGone: true, workspaceGone: true, userConfirmedBy: 'refused at create' });

    now = NOW + 24 * 60 * 60 * 1000;
    fetchImpl.mockClear();
    await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now) });
    expect(coderCalls(fetchImpl)).toEqual([]);
    // Nothing holds the slot, and the start was given back.
    expect(s.get('submission_quota', 'visitor-slot:0').sessionId).toBeNull();
    expect(quotaOf(s)).toBe(0);
  });

  it.each([['no answer', 'timeout'], ['a 5xx answer', 503]])('looks the user up by name after %s, since it may have been made', async (_name, answer) => {
    const s = store();
    const fetchImpl = createAnswering(answer);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    await startAs(handlers, ALICE, { error: vi.fn() });
    const [record] = [...s.docs.entries()].filter(([path]) => path.startsWith('lab_jobs/')).map(([, d]) => d);

    expect(record).toMatchObject({ status: 'cleanup_pending', userGone: false });
    now = Date.parse(record.retryAt);
    fetchImpl.mockClear();
    await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now) });
    expect(coderCalls(fetchImpl)[0]).toBe(`GET /api/v2/users/${record.coderUsername}`);
  });

  it('never deletes a user the lookup finds under another name', async () => {
    const s = store([
      session('p-1', { status: 'cleanup_pending', coderUserId: undefined, coderUsername: 'v-0123456789ab', workspaceGone: true, retryAt: iso(NOW) }),
    ]);
    const fetchImpl = vi.fn(async (url) =>
      new URL(String(url)).pathname === '/api/v2/users/v-0123456789ab'
        ? { ok: true, status: 200, json: async () => ({ id: 'u-someone', username: 'v-ffffffffffff' }) }
        : { ok: true, status: 200 }
    );
    const log = vi.fn();

    await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now), log });

    expect(coderCalls(fetchImpl)).toEqual(['GET /api/v2/users/v-0123456789ab']);
    expect(s.get('lab_jobs', 'p-1')).toMatchObject({ status: 'cleanup_pending', userGone: false });
    expect(s.get('lab_jobs', 'p-1').coderUserId).toBeUndefined();
    expect(log.mock.calls.at(-1)[0]).toContain('user user lookup mismatch');
  });
});

describe('#1464 review, finding G: a clean-up given up for good no longer holds a slot', () => {
  it('does not count it, and lets its slot go when it is given up', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const s = store([
      session('f-1', {
        clientHash: ALICE_KEY,
        status: 'cleanup_pending',
        cleanupAttempts: 4,
        cleanupRounds: 24,
        workspaceGone: false,
        slot: 0,
        retryAt: iso(NOW - 1000),
      }),
    ]);
    s.docs.set('submission_quota/visitor-slot:0', { id: 'visitor-slot:0', sessionId: 'f-1', takenAt: iso(NOW - 1000), _etag: '"s"' });
    const refusing = vi.fn(async () => ({ ok: false, status: 500 }));
    const log = vi.fn();

    await reapExpiredVisitorSessions(s, refusing, CODER, { nowIso: iso(now), log });

    expect(s.get('lab_jobs', 'f-1').status).toBe('cleanup_failed');
    expect(s.get('lab_jobs', 'f-1').retryAt).toBeUndefined();
    expect(s.get('submission_quota', 'visitor-slot:0').sessionId).toBeNull();
    expect(log.mock.calls.at(-1)[0]).toMatch(/given up for good .* no longer counts against the visitor lab limit/);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });
    expect(parsed(await statusAs(handlers, BOB)).body.bounds.activeCount).toBe(0);
    expect(parsed(await startAs(handlers, BOB)).status).toBe(201);
  });
});

describe('#1464 review, round 2', () => {
  const labsIn = (s) =>
    [...s.docs.entries()].filter(
      ([path, doc]) => path.startsWith('lab_jobs/') && ['active', 'provisioning'].includes(doc.status)
    ).length;

  it('1: counts a session saved before slots existed that is past its hour, while the sweep is held back', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const legacy = session('legacy-1', { expiresAt: iso(NOW + 30_000) });
    const s = store([legacy]);
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    // A status read runs the sweep and holds the next one back for a minute.
    await statusAs(handlers, BOB);
    now = NOW + 40_000; // the legacy session is now past its hour, and the sweep is still held back
    const res = parsed(await startAs(handlers, ALICE));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe(DOOR_CODES.capacity_full);
    expect(coderCalls(fetchImpl)).not.toContain('POST /api/v2/users');
  });

  it('2: lets two visitors starting at once take only the room a session saved before slots existed leaves', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '2');
    const s = store([session('legacy-1')]);
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });

    const results = (await Promise.all([startAs(handlers, ALICE), startAs(handlers, BOB)])).map(parsed);

    expect(results.map((r) => r.status).sort()).toEqual([201, 503]);
    expect(labsIn(s)).toBe(2); // the old session and one new one
  });

  it("3: hands back the caller's session that a start finished while this one waited for the lock", async () => {
    const s = store();
    const create = s.createDoc.getMockImplementation();
    let firstDone;
    const first = new Promise((resolve) => {
      firstDone = resolve;
    });
    let lockTries = 0;
    s.createDoc.mockImplementation(async (container, doc) => {
      if (String(doc.id).startsWith('visitor-start:')) {
        lockTries += 1;
        if (lockTries === 2) await first; // the second request reaches the lock only after the first start ends
      }
      return create(container, doc);
    });
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    const a = startAs(handlers, ALICE).then((res) => {
      firstDone();
      return res;
    });
    const b = startAs(handlers, ALICE);
    const [ra, rb] = (await Promise.all([a, b])).map(parsed);

    expect([ra.status, rb.status]).toEqual([201, 200]);
    expect(rb.body.sessionId).toBe(ra.body.sessionId);
    expect(coderCalls(fetchImpl).filter((call) => call === 'POST /api/v2/users')).toHaveLength(1);
    expect(quotaOf(s)).toBe(1);
  });

  it('4: looks the user up after a 408 from Coder, which may have made it', async () => {
    const s = store();
    const inner = visitorFetch();
    const fetchImpl = vi.fn(async (url, init) =>
      String(url).endsWith('/api/v2/users') ? { ok: false, status: 408 } : inner(url, init)
    );
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    expect((await startAs(handlers, ALICE, { error: vi.fn() })).status).toBe(502);

    const [record] = [...s.docs.entries()].filter(([path]) => path.startsWith('lab_jobs/')).map(([, d]) => d);
    expect(record).toMatchObject({ status: 'cleanup_pending', userGone: false });
    expect(record.userConfirmedBy).toBeUndefined();
  });

  describe('5: a give-back that fails is tried again, and still happens once', () => {
    const failingThenWorking = (s, matches, times = 1) => {
      const create = s.createDoc.getMockImplementation();
      let left = times;
      s.createDoc.mockImplementation(async (container, doc) => {
        if (matches(doc) && left > 0) {
          left -= 1;
          throw Object.assign(new Error('throttled'), { code: 429 });
        }
        return create(container, doc);
      });
    };
    const refusingWorkspace = () => {
      const inner = visitorFetch();
      return vi.fn(async (url, init) =>
        /\/members\/[^/]+\/workspaces$/.test(String(url)) ? { ok: false, status: 400 } : inner(url, init)
      );
    };

    it('keeps the marker pending when the refund cannot be written, and the sweep writes it later, once', async () => {
      const s = store();
      failingThenWorking(s, (doc) => String(doc.id).startsWith('visitor-refund:'));
      const fetchImpl = refusingWorkspace();
      const context = { error: vi.fn() };
      const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

      expect((await startAs(handlers, ALICE, context)).status).toBe(502);
      const [note] = [...s.docs.entries()].filter(([path]) => path.startsWith('lab_jobs/')).map(([, d]) => d);
      expect(note).toMatchObject({ status: 'cleanup_pending', dailyCapRefund: 'pending' });
      expect(quotaOf(s)).toBe(1);
      expect(context.error).toHaveBeenCalledWith('visitor-session: a daily start could not be given back yet (429)');

      now = Date.parse(note.retryAt);
      await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now) });
      await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now + 60 * 60 * 1000) });

      expect(quotaOf(s)).toBe(0);
      expect(refundDocs(s)).toHaveLength(1);
      expect(s.get('lab_jobs', note.id).dailyCapRefund).toBe('given');
    });

    it('does not finish a record whose refund is still owed, even when Coder has nothing left', async () => {
      const s = store([
        session('p-9', {
          status: 'cleanup_pending',
          endStatus: 'ended',
          startFailed: true,
          coderUserId: undefined,
          workspaceGone: true,
          userGone: true,
          dailyCap: { container: 'submission_quota', id: `visitor-quota:${ALICE_KEY}:${DAY}` },
          dailyCapRefund: 'pending',
          retryAt: iso(NOW),
        }),
      ]);
      failingThenWorking(s, (doc) => String(doc.id).startsWith('visitor-refund:'));

      await reapExpiredVisitorSessions(s, vi.fn(), CODER, { nowIso: iso(now) });
      expect(s.get('lab_jobs', 'p-9')).toMatchObject({ status: 'cleanup_pending', dailyCapRefund: 'pending' });

      now = Date.parse(s.get('lab_jobs', 'p-9').retryAt);
      await reapExpiredVisitorSessions(s, vi.fn(), CODER, { nowIso: iso(now) });
      expect(s.get('lab_jobs', 'p-9')).toMatchObject({ status: 'ended', dailyCapRefund: 'given' });
      expect(refundDocs(s)).toEqual(['submission_quota/visitor-refund:p-9']);
    });

    it('adds no second refund when the refund was written but the marker was not', async () => {
      const s = store();
      const replace = s.replaceDocIfMatch.getMockImplementation();
      // The note is written, the refund is written, then the write that turns the marker to `given` fails.
      let noteWrites = 0;
      s.replaceDocIfMatch.mockImplementation(async (container, doc, options) => {
        if (container === 'lab_jobs' && doc.startFailed) {
          noteWrites += 1;
          if (noteWrites === 2) throw Object.assign(new Error('down'), { code: 503 });
        }
        return replace(container, doc, options);
      });
      const fetchImpl = refusingWorkspace();
      const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

      await startAs(handlers, ALICE, { error: vi.fn() });
      expect(refundDocs(s)).toHaveLength(1);
      const [note] = [...s.docs.entries()].filter(([path]) => path.startsWith('lab_jobs/')).map(([, d]) => d);
      expect(note.dailyCapRefund).toBe('pending');

      now = Date.parse(note.retryAt);
      await reapExpiredVisitorSessions(s, fetchImpl, CODER, { nowIso: iso(now) });
      expect(refundDocs(s)).toHaveLength(1);
      expect(quotaOf(s)).toBe(0);
      expect(s.get('lab_jobs', note.id).dailyCapRefund).toBe('given');
    });
  });
});

describe('#1464 review, round 3: every holder owns one of the slots, and slots never age out', () => {
  const labsIn = (s) =>
    [...s.docs.entries()].filter(
      ([path, doc]) => path.startsWith('lab_jobs/') && ['active', 'provisioning'].includes(doc.status)
    ).length;
  const slotDoc = (n, sessionId, takenAt) => ({ id: `visitor-slot:${n}`, kind: 'visitor_slot', sessionId, takenAt, ttl: -1 });
  const putSlot = (s, n, sessionId, takenAt) =>
    s.docs.set(`submission_quota/visitor-slot:${n}`, { ...slotDoc(n, sessionId, takenAt), _etag: `"slot-${n}"` });
  const OLD = iso(NOW - 60 * 60 * 1000);

  it('1: keeps a slot for as long as its session may hold a lab, past a week, and counts it', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '1');
    const s = store([], { now: clock });
    const refusing = vi.fn(async (url, init) => {
      const target = String(url);
      if (target.includes('/builds')) return { ok: false, status: 500 };
      return visitorFetch()(url, init);
    });
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });
    const alice = parsed(await startAs(handlers, ALICE)).body.sessionId;
    const ending = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: refusing, clock });
    await stopAs(ending, ALICE, alice);
    expect(s.get('lab_jobs', alice)).toMatchObject({ status: 'cleanup_pending', workspaceGone: false, slot: 0 });

    // The waiting record is written again on day 6 (a retry), so on day 8 it is still there.
    const DAY_MS = 24 * 60 * 60 * 1000;
    now = NOW + 6 * DAY_MS;
    const record = s.get('lab_jobs', alice);
    await s.replaceDocIfMatch('lab_jobs', { ...record, retryAt: iso(NOW + 9 * DAY_MS) }, { partitionKey: alice });
    now = NOW + 8 * DAY_MS;
    expect(s.get('lab_jobs', alice)).not.toBeNull();

    expect(s.get('submission_quota', 'visitor-slot:0')).toMatchObject({ sessionId: alice, ttl: -1 });
    const later = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl: visitorFetch(), clock });
    const bob = parsed(await startAs(later, BOB));
    expect(bob.status).toBe(503);
    expect(bob.body.code).toBe(DOOR_CODES.capacity_full);
  });

  it('2: counts an old session, a session in slot 1 and a crashed reservation in slot 0 together, at a limit of 2', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '2');
    // The old session passes its hour while the sweep is held back, so only the full count sees it.
    const s = store([session('legacy-1', { expiresAt: iso(NOW + 30_000) }), session('s-1', { slot: 1 })]);
    putSlot(s, 1, 's-1', OLD);
    putSlot(s, 0, 'crashed-start', OLD); // its record was never written, and it is old enough to take over
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });
    await statusAs(handlers, BOB); // runs the sweep, and holds the next one back for a minute
    now = NOW + 40_000;

    const res = parsed(await startAs(handlers, ALICE));

    expect(res.status).toBe(503);
    expect(labsIn(s)).toBe(2);
    expect(coderCalls(fetchImpl)).not.toContain('POST /api/v2/users');
  });

  it('3: gives an old session a slot before taking one, so a start in flight in another slot is not overrun', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '3');
    const s = store([session('legacy-1'), session('s-1', { slot: 1 })]);
    putSlot(s, 0, 'crashed-start', OLD);
    putSlot(s, 1, 's-1', OLD);
    putSlot(s, 2, 'in-flight', iso(NOW - 1000)); // a start that has its slot and has not written its record yet
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    const res = parsed(await startAs(handlers, ALICE));

    // Three holders already: the old session (now in slot 0), the session in slot 1, and the start in flight.
    expect(res.status).toBe(503);
    expect(s.get('submission_quota', 'visitor-slot:0').sessionId).toBe('legacy-1');
    expect(coderCalls(fetchImpl)).not.toContain('POST /api/v2/users');
  });

  it('4: never lets two starts at once go past the limit, against an old session, a crashed reservation and a live slot', async () => {
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '3');
    const s = store([session('legacy-1'), session('s-1', { slot: 1 })]);
    putSlot(s, 0, 'crashed-start', OLD);
    putSlot(s, 1, 's-1', OLD);
    const fetchImpl = visitorFetch();
    const handlers = createVisitorSessionHandlers({ store: s, identity: identity(), fetchImpl, clock });

    const results = (await Promise.all([startAs(handlers, ALICE), startAs(handlers, BOB)])).map(parsed);

    expect(results.map((r) => r.status).sort()).toEqual([201, 503]);
    expect(labsIn(s)).toBe(3); // the old session, the one in slot 1, and one new one
    const named = [0, 1, 2].map((n) => s.get('submission_quota', `visitor-slot:${n}`)?.sessionId);
    expect(new Set(named).size).toBe(3);
    expect(named).toContain('legacy-1');
    expect(named).toContain('s-1');
  });
});

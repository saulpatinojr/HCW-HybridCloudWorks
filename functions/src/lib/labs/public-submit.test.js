/**
 * Anonymous lab submission (#672). What must hold, one block per bound of
 * ADR 0032 decision 6 plus the two this PR adds on top:
 *
 *   - CLOSED BY DEFAULT: with the switch absent, or anything but "true", all
 *     three routes answer PUBLIC_SUBMISSION_CLOSED and touch nothing: no
 *     body read, no identity, no store call of any kind.
 *   - FAIL CLOSED WITH NO AGENT: open, but no agent registered for
 *     terraform-validate heartbeating, is 503 and nothing is counted or
 *     queued; an unreadable lab is 503 too, never "open".
 *   - terraform-validate only; 64 KB exactly; 2 an hour per client; 50 a day
 *     across everyone; refused while more than 20 are queued; written with
 *     public: true and a one-day ttl, and the agent's claim and completion
 *     keep both.
 *   - The job read serves public jobs only, one identical 404 otherwise,
 *     and answers the visitor report, never the raw output (the report
 *     itself is visitor-report.test.js).
 *
 * The lock to the site's pane (ADR 0032 decision 6 as revised 2026-09-28,
 * public-lock.js) has its own file, public-lock.test.js. Here every request
 * comes from the site's origin with a token a stubbed siteverify passes, so
 * each block tests the bound it names and nothing else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { LAB_JOB_TYPES } from '../labs.js';
import { REPORT_LINES } from './visitor-report.js';
import { createLabAgentHandlers } from '../lab-agent.js';
import {
  DOOR_CODES,
  DOOR_REASONS,
  PUBLIC_BOUNDS,
  PUBLIC_JOB_TTL_SECONDS,
  PUBLIC_MAX_BODY_BYTES,
  PUBLIC_MAX_PAYLOAD_BYTES,
  PUBLIC_PER_CLIENT_PER_HOUR,
  PUBLIC_PER_DAY,
  PUBLIC_QUEUE_CEILING,
  PUBLIC_QUOTA_TTL_SECONDS,
  PUBLIC_STATUS_CACHE_ID,
  PUBLIC_SUBMISSION_SWITCH,
  TURNSTILE_SECRET_SETTING,
  createPublicSubmitHandlers,
  isLivePublicJob,
  projectPublicJob,
  publicJobDocument,
  publicQuotaId,
  publicSubmissionEnabled,
  validatePublicSubmission,
} from './public-submit.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const OPEN = { [PUBLIC_SUBMISSION_SWITCH]: 'true', [TURNSTILE_SECRET_SETTING]: 'turnstile-secret' };
const JOB_UUID = '33333333-9d4a-4c5b-8e7f-0a1b2c3d4e5f';
const SITE = 'https://hybridcloudworks.com';
const TOKEN = 'turnstile-token-1';

/** A siteverify that passes every token, as Cloudflare answers one solved on the site. */
const siteverifyPasses = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      hostname: 'hybridcloudworks.com',
      action: 'lab-validate',
      'error-codes': [],
    }),
  }));

const onlineAgent = (over = {}) => ({
  id: 'vps-1',
  lastSeenAt: new Date(NOW - 10_000).toISOString(),
  capabilities: ['shell-echo', 'terraform-validate'],
  ...over,
});

/**
 * An in-memory store with every operation the handlers use, Cosmos error
 * codes included. `queryDocs` answers the two queries the lab check makes:
 * the agents, and the count of queued jobs, derived from the jobs held.
 */
function memStore({ agents = [onlineAgent()], queued = 0, failQuery = false } = {}) {
  const docs = new Map();
  const key = (container, id) => `${container}/${id}`;
  const cosmosError = (code) => Object.assign(new Error(`cosmos ${code}`), { code });
  for (let i = 0; i < queued; i += 1) {
    docs.set(key('lab_jobs', `seed-${i}`), { id: `seed-${i}`, type: 'shell-echo', status: 'queued' });
  }
  const inContainer = (container) =>
    [...docs.entries()].filter(([k]) => k.startsWith(`${container}/`)).map(([, v]) => v);
  return {
    docs,
    jobs: () => inContainer('lab_jobs'),
    queryDocs: vi.fn(async (container, sql) => {
      if (failQuery) throw new Error('cosmos unavailable');
      if (container === 'lab_agents') return agents;
      if (container === 'lab_jobs' && sql.includes('COUNT(1)')) {
        return [inContainer('lab_jobs').filter((j) => j.status === 'queued').length];
      }
      throw new Error(`unexpected query on ${container}: ${sql}`);
    }),
    readDoc: vi.fn(async (container, id) => docs.get(key(container, id)) ?? null),
    upsertDoc: vi.fn(async (container, doc) => {
      docs.set(key(container, doc.id), doc);
      return doc;
    }),
    createDoc: vi.fn(async (container, doc) => {
      if (docs.has(key(container, doc.id))) throw cosmosError(409);
      docs.set(key(container, doc.id), doc);
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      docs.set(key(container, doc.id), doc);
      return doc;
    }),
    incrementIf: vi.fn(async (container, id, { path, value, condition, conditionValues }) => {
      const doc = docs.get(key(container, id));
      if (!doc) throw cosmosError(404);
      // The two predicates in play, evaluated the way Cosmos would.
      const passes = condition.includes('windowStartMs')
        ? doc.windowStartMs > conditionValues.windowFloor && doc.count < conditionValues.limit
        : doc.count < conditionValues.limit;
      if (!passes) throw cosmosError(412);
      doc[path.slice(1)] += value;
      return doc;
    }),
  };
}

const storeCalls = (store) =>
  ['queryDocs', 'readDoc', 'upsertDoc', 'createDoc', 'replaceDocIfMatch', 'incrementIf'].reduce(
    (n, name) => n + store[name].mock.calls.length,
    0
  );

const identityFor = (key = 'client-a') => ({
  anonymousKey: vi.fn(() => ({ key, trusted: true })),
  trustedClientIp: vi.fn(() => '203.0.113.7'),
});
const refusingIdentity = () => ({
  anonymousKey: vi.fn(() => {
    throw new Error('unverified origin');
  }),
  trustedClientIp: vi.fn(() => null),
});

const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const body = (over = {}) => ({
  type: 'terraform-validate',
  payload: 'terraform {}\n',
  payloadEncoding: 'text',
  turnstileToken: TOKEN,
  ...over,
});

/** Headers as the Functions host presents them: `get` by case-insensitive name. */
const headersOf = (map) => {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[String(name).toLowerCase()] ?? null };
};

/** A POST from the builder's pane: the site's Origin, unless the test says otherwise. */
const postRequest = (value, headers = { origin: SITE }) => {
  const text = vi.fn(async () => (typeof value === 'string' ? value : JSON.stringify(value)));
  return { method: 'POST', headers: headersOf(headers), text, query: new Map() };
};
const getRequest = (query = {}) => ({
  method: 'GET',
  headers: { get: () => null },
  text: vi.fn(async () => ''),
  query: new Map(Object.entries(query)),
});

const parse = (res) => JSON.parse(res.body);

/** One sequence for the whole file, so handlers built on one store never reuse an id. */
let issued = 0;
const nextUuid = () => `00000000-0000-4000-8000-${String((issued += 1)).padStart(12, '0')}`;

function build({
  env = OPEN,
  store = memStore(),
  identity = identityFor(),
  now = () => NOW,
  uuid = nextUuid,
  fetch = siteverifyPasses(),
} = {}) {
  const handlers = createPublicSubmitHandlers({ identity, store, env, now, uuid, fetch });
  return { handlers, store, identity, fetch };
}

describe('the bounds are ADR 0032 decision 6, and no wider', () => {
  it('names each one exactly', () => {
    expect(PUBLIC_BOUNDS).toEqual({
      jobType: 'terraform-validate',
      maxPayloadBytes: 64 * 1024,
      perClientPerHour: 2,
      perDay: 50,
      queueCeiling: 20,
      jobTtlSeconds: 24 * 60 * 60,
    });
  });

  it('caps the payload at the same 64 KB as the admin enqueue', () => {
    expect(PUBLIC_MAX_PAYLOAD_BYTES).toBe(LAB_JOB_TYPES['terraform-validate'].maxPayloadBytes);
  });
});

describe('closed by default', () => {
  it.each([undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true '])(
    'treats %j as closed',
    (value) => {
      expect(publicSubmissionEnabled({ [PUBLIC_SUBMISSION_SWITCH]: value })).toBe(false);
    }
  );

  it('opens only on the exact string "true"', () => {
    expect(publicSubmissionEnabled({ [PUBLIC_SUBMISSION_SWITCH]: 'true' })).toBe(true);
    expect(publicSubmissionEnabled(undefined)).toBe(false);
  });

  it('reads process.env when no env is passed, and nothing in this process sets the switch', async () => {
    expect(process.env[PUBLIC_SUBMISSION_SWITCH]).toBeUndefined();
    const store = memStore();
    const identity = identityFor();
    const handlers = createPublicSubmitHandlers({ identity, store });
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(503);
    expect(parse(res).code).toBe('PUBLIC_SUBMISSION_CLOSED');
    expect(storeCalls(store)).toBe(0);
  });

  it('refuses a submission before reading the body, the caller or the store', async () => {
    const { handlers, store, identity } = build({ env: {} });
    const request = postRequest(body());
    const res = await handlers.submitJob(request, context);

    expect(res.status).toBe(503);
    expect(parse(res)).toEqual({
      ok: false,
      configured: false,
      code: DOOR_CODES.closed,
      error: DOOR_REASONS[DOOR_CODES.closed],
    });
    expect(request.text).not.toHaveBeenCalled();
    expect(identity.anonymousKey).not.toHaveBeenCalled();
    expect(storeCalls(store)).toBe(0);
    expect(store.jobs()).toEqual([]);
  });

  it('says it is closed on the status read, with the bounds, and reads no store', async () => {
    const { handlers, store } = build({ env: { [PUBLIC_SUBMISSION_SWITCH]: 'false' } });
    const res = await handlers.getSubmissionStatus(getRequest(), context);

    expect(res.status).toBe(200);
    expect(parse(res)).toEqual({
      configured: false,
      open: false,
      code: DOOR_CODES.closed,
      reason: DOOR_REASONS[DOOR_CODES.closed],
      bounds: PUBLIC_BOUNDS,
    });
    expect(storeCalls(store)).toBe(0);
  });

  it('closes the job read too, before any store read', async () => {
    const { handlers, store } = build({ env: {} });
    const res = await handlers.getJob(getRequest({ jobId: JOB_UUID }), context);
    expect(res.status).toBe(503);
    expect(parse(res).code).toBe(DOOR_CODES.closed);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(storeCalls(store)).toBe(0);
  });

  it('routes GET to the status and POST to the submission on the one registration', async () => {
    const { handlers } = build({ env: {} });
    expect((await handlers.submitRoute(getRequest(), context)).status).toBe(200);
    expect((await handlers.submitRoute(postRequest(body()), context)).status).toBe(503);
  });
});

describe('fails closed while no agent can run the job', () => {
  it.each([
    ['no agent registered at all', []],
    ['an agent that last heartbeated 91 s ago', [onlineAgent({ lastSeenAt: new Date(NOW - 91_000).toISOString() })]],
    ['an agent that never heartbeated', [onlineAgent({ lastSeenAt: null })]],
    // The goodbye heartbeat writes lastSeenAt too, so freshness alone held
    // the door open for 90 s after a stop (#1009).
    ['an agent whose fresh heartbeat said offline', [onlineAgent({ status: 'offline' })]],
    ['an agent whose fresh heartbeat said stopping', [onlineAgent({ status: 'stopping' })]],
    // The guard refuses it at once; its heartbeat stays fresh 90 s (#1018).
    ['an agent deactivated since its last heartbeat', [onlineAgent({ active: false })]],
    ['an online agent not registered for terraform-validate', [onlineAgent({ capabilities: ['shell-echo'] })]],
    ['an online agent with no capabilities field', [onlineAgent({ capabilities: undefined })]],
  ])('refuses with %s, and neither counts nor queues', async (_label, agents) => {
    const { handlers, store } = build({ store: memStore({ agents }) });
    const res = await handlers.submitJob(postRequest(body()), context);

    expect(res.status).toBe(503);
    expect(parse(res)).toMatchObject({ ok: false, code: DOOR_CODES.offline });
    expect(parse(res).error).toBe(DOOR_REASONS[DOOR_CODES.offline]);
    expect(store.incrementIf).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.jobs()).toEqual([]);
  });

  it('reads each agent\'s status with its heartbeat, because the online rule needs both (#1009)', async () => {
    const { handlers, store } = build({ store: memStore({ agents: [onlineAgent()] }) });
    await handlers.submitJob(postRequest(body()), context);
    const [, sql] = store.queryDocs.mock.calls.find(([container]) => container === 'lab_agents');
    expect(sql).toMatch(/\bc\.lastSeenAt\b/);
    expect(sql).toMatch(/\bc\.status\b/);
  });

  it('refuses as unavailable, not open, when the lab cannot be read', async () => {
    const { handlers, store } = build({ store: memStore({ failQuery: true }) });
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(503);
    expect(parse(res).code).toBe(DOOR_CODES.unavailable);
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('refuses as unavailable when the queue count is not a number', async () => {
    const store = memStore();
    store.queryDocs.mockImplementation(async (container) =>
      container === 'lab_agents' ? [onlineAgent()] : [{ weird: true }]
    );
    const { handlers } = build({ store });
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(503);
    expect(parse(res).code).toBe(DOOR_CODES.unavailable);
  });

  it('reports the offline door on the status read and caches it for a minute', async () => {
    const store = memStore({ agents: [] });
    const { handlers } = build({ store });
    const first = parse(await handlers.getSubmissionStatus(getRequest(), context));
    expect(first).toMatchObject({ configured: true, open: false, code: DOOR_CODES.offline });
    expect(first.bounds).toEqual(PUBLIC_BOUNDS);
    const cached = store.docs.get(`tool_service_cache/${PUBLIC_STATUS_CACHE_ID}`);
    expect(cached).toMatchObject({ kind: 'labs-public-submit', ttl: 60 });

    store.queryDocs.mockClear();
    const second = parse(await handlers.getSubmissionStatus(getRequest(), context));
    expect(second.code).toBe(DOOR_CODES.offline);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('opens the status read only when an agent is online and the queue has room', async () => {
    const { handlers } = build({ store: memStore({ queued: 3 }) });
    const res = await handlers.getSubmissionStatus(getRequest(), context);
    expect(parse(res)).toEqual({
      configured: true,
      open: true,
      code: null,
      reason: null,
      queued: 3,
      bounds: PUBLIC_BOUNDS,
    });
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
  });

  it('refuses a POST from a shut door in the minute cache without reading the lab', async () => {
    const store = memStore({ agents: [] });
    const { handlers } = build({ store });
    await handlers.getSubmissionStatus(getRequest(), context);
    store.queryDocs.mockClear();

    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(503);
    expect(parse(res).code).toBe(DOOR_CODES.offline);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.incrementIf).not.toHaveBeenCalled();
  });

  it('reads an open door live on a POST, so the queue ceiling sees a fresh count', async () => {
    const store = memStore();
    const { handlers } = build({ store });
    expect(parse(await handlers.getSubmissionStatus(getRequest(), context)).open).toBe(true);
    // The queue fills after the door was cached open.
    for (let i = 0; i < PUBLIC_QUEUE_CEILING + 1; i += 1) {
      store.docs.set(`lab_jobs/late-${i}`, { id: `late-${i}`, status: 'queued' });
    }
    store.queryDocs.mockClear();
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(2);
    expect(parse(res).code).toBe(DOOR_CODES.full);
    // And the refusal is what the status read now says.
    expect(parse(await handlers.getSubmissionStatus(getRequest(), context)).code).toBe(DOOR_CODES.full);
  });

  it('never claims open on a failed read', async () => {
    const { handlers } = build({ store: memStore({ failQuery: true }) });
    const door = parse(await handlers.getSubmissionStatus(getRequest(), context));
    expect(door).toMatchObject({ open: false, code: DOOR_CODES.unavailable });
  });
});

describe('only terraform-validate', () => {
  it.each(['shell-echo', 'ansible-check', 'helm-template', 'kubeconform', undefined, '', 'TERRAFORM-VALIDATE'])(
    'refuses type %j with 400 and queues nothing',
    async (type) => {
      const { handlers, store } = build();
      const res = await handlers.submitJob(postRequest(body({ type })), context);
      expect(res.status).toBe(400);
      expect(parse(res).error).toBe('Only terraform-validate jobs may be submitted publicly');
      expect(store.createDoc).not.toHaveBeenCalled();
      expect(store.incrementIf).not.toHaveBeenCalled();
    }
  );

  it('refuses unknown keys rather than ignoring them', () => {
    expect(validatePublicSubmission(body({ agentId: 'vps-1' }))).toEqual({
      status: 400,
      error: 'Unknown field(s): agentId. Allowed: type, payload, payloadEncoding, turnstileToken',
    });
  });

  it.each([
    ['a non-object', [], 'Body must be a JSON object'],
    ['null', null, 'Body must be a JSON object'],
    ['an empty payload', body({ payload: '  ' }), 'payload must be a non-empty string'],
    ['a non-string payload', body({ payload: 42 }), 'payload must be a non-empty string'],
    ['an unknown encoding', body({ payloadEncoding: 'zip' }), 'payloadEncoding must be one of text, tar'],
    ['a tar that is not base64', body({ payloadEncoding: 'tar', payload: 'not base64!' }), 'a tar payload must be base64'],
  ])('refuses %s', (_label, value, error) => {
    expect(validatePublicSubmission(value)).toEqual({ status: 400, error });
  });

  it('refuses a body that is not JSON', async () => {
    const { handlers } = build();
    const res = await handlers.submitJob(postRequest('{not json'), context);
    expect(res.status).toBe(400);
    expect(parse(res).code).toBe('INVALID_BODY');
  });

  it('defaults the encoding to text and accepts a base64 tar', () => {
    const { type, payload } = body();
    expect(validatePublicSubmission({ type, payload }).value.payloadEncoding).toBe('text');
    expect(validatePublicSubmission(body({ payloadEncoding: 'tar', payload: 'H4sIAAAA' })).value).toEqual({
      type: 'terraform-validate',
      payload: 'H4sIAAAA',
      payloadEncoding: 'tar',
    });
  });
});

describe('a 64 KB payload', () => {
  it('accepts exactly 65,536 bytes', async () => {
    const { handlers, store } = build();
    const payload = 'a'.repeat(PUBLIC_MAX_PAYLOAD_BYTES);
    const res = await handlers.submitJob(postRequest(body({ payload })), context);
    expect(res.status).toBe(202);
    expect(store.jobs().find((j) => j.public).payload).toBe(payload);
  });

  it('refuses 65,537 bytes with 413 and queues nothing', async () => {
    const { handlers, store } = build();
    const res = await handlers.submitJob(
      postRequest(body({ payload: 'a'.repeat(PUBLIC_MAX_PAYLOAD_BYTES + 1) })),
      context
    );
    expect(res.status).toBe(413);
    expect(parse(res)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(parse(res).error).toContain('65537 bytes; max 65536');
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('measures bytes, not characters', () => {
    // 'é' is two bytes in UTF-8: 32,769 of them is 65,538 bytes.
    const res = validatePublicSubmission(body({ payload: 'é'.repeat(32_769) }));
    expect(res.status).toBe(413);
  });

  it('refuses a declared Content-Length over the cap before reading the body', async () => {
    const { handlers, identity } = build();
    const request = postRequest(body(), {
      origin: SITE,
      'content-length': String(PUBLIC_MAX_BODY_BYTES + 1),
    });
    const res = await handlers.submitJob(request, context);
    expect(res.status).toBe(413);
    expect(request.text).not.toHaveBeenCalled();
    expect(identity.anonymousKey).not.toHaveBeenCalled();
  });

  it('refuses an oversized raw body before parsing it', async () => {
    const { handlers, identity } = build();
    const raw = `{"type":"terraform-validate","payload":"${'a'.repeat(PUBLIC_MAX_BODY_BYTES)}"}`;
    const res = await handlers.submitJob(postRequest(raw), context);
    expect(res.status).toBe(413);
    expect(identity.anonymousKey).not.toHaveBeenCalled();
  });
});

describe('2 an hour per client', () => {
  it('accepts two and refuses the third with 429 and Retry-After', async () => {
    const { handlers, store } = build();
    for (let i = 0; i < PUBLIC_PER_CLIENT_PER_HOUR; i += 1) {
      expect((await handlers.submitJob(postRequest(body()), context)).status).toBe(202);
    }
    const third = await handlers.submitJob(postRequest(body()), context);
    expect(third.status).toBe(429);
    expect(third.headers['Retry-After']).toBe('3600');
    expect(parse(third).code).toBe('LAB_RATE_LIMITED');
    expect(store.jobs().filter((j) => j.public)).toHaveLength(2);
  });

  it('counts under lab-caller:<hash> in submission_quota, separate from other routes', async () => {
    const { handlers, store } = build({ identity: identityFor('hash-1') });
    await handlers.submitJob(postRequest(body()), context);
    expect(store.docs.get('submission_quota/lab-caller:hash-1')).toMatchObject({ count: 1 });
    expect(store.docs.has('submission_quota/hash-1')).toBe(false);
  });

  it('gives another client its own two', async () => {
    const store = memStore();
    const a = build({ store, identity: identityFor('a') }).handlers;
    const b = build({ store, identity: identityFor('b') }).handlers;
    await a.submitJob(postRequest(body()), context);
    await a.submitJob(postRequest(body()), context);
    expect((await a.submitJob(postRequest(body()), context)).status).toBe(429);
    expect((await b.submitJob(postRequest(body()), context)).status).toBe(202);
  });

  it('lets the client in again once the hour has passed', async () => {
    let clock = NOW;
    const store = memStore();
    const { handlers } = build({ store, now: () => clock });
    await handlers.submitJob(postRequest(body()), context);
    await handlers.submitJob(postRequest(body()), context);
    expect((await handlers.submitJob(postRequest(body()), context)).status).toBe(429);
    clock = NOW + 60 * 60 * 1000 + 1;
    store.queryDocs.mockImplementation(async (container, sql) =>
      container === 'lab_agents'
        ? [onlineAgent({ lastSeenAt: new Date(clock - 5_000).toISOString() })]
        : sql.includes('COUNT(1)')
          ? [0]
          : []
    );
    expect((await handlers.submitJob(postRequest(body()), context)).status).toBe(202);
  });

  it('refuses an unverified origin with 403 before counting anything', async () => {
    const { handlers, store } = build({ identity: refusingIdentity() });
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.incrementIf).not.toHaveBeenCalled();
  });

  it('does not spend the day’s budget on a request the client limit refused', async () => {
    const { handlers, store } = build();
    await handlers.submitJob(postRequest(body()), context);
    await handlers.submitJob(postRequest(body()), context);
    await handlers.submitJob(postRequest(body()), context);
    const day = store.docs.get(`tool_service_cache/${publicQuotaId('2026-09-27')}`);
    expect(day.count).toBe(2);
  });
});

describe('50 a day across everyone', () => {
  it('accepts fifty from fifty clients and pauses the fifty-first until tomorrow', async () => {
    let clock = NOW;
    const store = memStore();
    // The agent drains each job as it lands, so the queue ceiling never bites here.
    const drain = () => {
      for (const job of store.jobs()) job.status = 'succeeded';
    };
    const submitAs = async (client) => {
      const { handlers } = build({ store, identity: identityFor(client), now: () => clock });
      const res = await handlers.submitJob(postRequest(body()), context);
      drain();
      return res;
    };
    for (let i = 0; i < PUBLIC_PER_DAY; i += 1) {
      expect((await submitAs(`client-${i}`)).status).toBe(202);
    }
    const over = await submitAs('client-50');
    expect(over.status).toBe(503);
    expect(parse(over).code).toBe('LAB_PAUSED_FOR_TODAY');
    expect(store.jobs().filter((j) => j.public)).toHaveLength(PUBLIC_PER_DAY);

    const counter = store.docs.get(`tool_service_cache/${publicQuotaId('2026-09-27')}`);
    expect(counter).toMatchObject({
      id: 'lab-public-quota:2026-09-27',
      kind: 'lab-public-quota',
      day: '2026-09-27',
      count: PUBLIC_PER_DAY,
      ttl: PUBLIC_QUOTA_TTL_SECONDS,
    });

    // A new UTC day is a new counter.
    clock = Date.parse('2026-09-28T00:00:01Z');
    store.queryDocs.mockImplementation(async (container, sql) =>
      container === 'lab_agents'
        ? [onlineAgent({ lastSeenAt: new Date(clock - 5_000).toISOString() })]
        : sql.includes('COUNT(1)')
          ? [0]
          : []
    );
    expect((await submitAs('client-tomorrow')).status).toBe(202);
  });
});

describe('refused outright while more than 20 are queued', () => {
  it('accepts with exactly 20 queued', async () => {
    const { handlers } = build({ store: memStore({ queued: PUBLIC_QUEUE_CEILING }) });
    expect((await handlers.submitJob(postRequest(body()), context)).status).toBe(202);
  });

  it('refuses with 21 queued, before any counter moves', async () => {
    const { handlers, store } = build({ store: memStore({ queued: PUBLIC_QUEUE_CEILING + 1 }) });
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(503);
    expect(res.headers['Retry-After']).toBe('300');
    expect(parse(res)).toMatchObject({ code: DOOR_CODES.full, error: DOOR_REASONS[DOOR_CODES.full] });
    expect(store.incrementIf).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('counts every queued job, admin ones included', async () => {
    // The 21 seeded jobs are shell-echo, the admin console's smoke test.
    const { handlers } = build({ store: memStore({ queued: 21 }) });
    const door = parse(await handlers.getSubmissionStatus(getRequest(), context));
    expect(door).toMatchObject({ open: false, code: DOOR_CODES.full, queued: 21 });
  });
});

describe('public: true with a one-day ttl', () => {
  it('writes the admin enqueue’s shape plus public, ttl and no person', async () => {
    const { handlers, store } = build({ uuid: () => JOB_UUID });
    const res = await handlers.submitJob(postRequest(body({ payload: 'module "x" {}\n' })), context);
    expect(res.status).toBe(202);
    expect(parse(res)).toEqual({ ok: true, jobId: JOB_UUID, type: 'terraform-validate', status: 'queued' });

    const job = store.docs.get(`lab_jobs/${JOB_UUID}`);
    expect(job).toEqual({
      id: JOB_UUID,
      type: 'terraform-validate',
      payload: 'module "x" {}\n',
      payloadEncoding: 'text',
      status: 'queued',
      public: true,
      ttl: 86_400,
      requestedBy: 'public',
      requestedByEmail: null,
      requestedVia: 'public/labs/submit',
      createdAt: '2026-09-27T12:00:00.000Z',
      claimedAt: null,
      finishedAt: null,
      agentId: null,
      exitCode: null,
      output: null,
    });
    expect(JSON.stringify(job)).not.toContain('client-a');
    // The token is the lock's, and is never written with the job.
    expect(JSON.stringify(job)).not.toContain(TOKEN);
    expect(store.createDoc).toHaveBeenCalledWith('lab_jobs', job);
  });

  it('relies on a lab_jobs container whose TTL is on, so the document ttl governs', () => {
    const spec = JSON.parse(
      readFileSync(join(process.cwd(), '..', 'infra', 'cosmos-containers.json'), 'utf8')
    );
    const labJobs = spec.containers.find((c) => c.name === 'lab_jobs');
    // null would mean TTL off, and Cosmos would ignore the per-document ttl.
    expect(Number.isInteger(labJobs.default_ttl)).toBe(true);
    expect(labJobs.default_ttl).toBeGreaterThan(PUBLIC_JOB_TTL_SECONDS);
  });

  it('keeps public and ttl through the agent’s claim and completion', async () => {
    const job = publicJobDocument(JOB_UUID, body(), '2026-09-27T12:00:00.000Z');
    const docs = new Map([[JOB_UUID, job]]);
    const store = {
      queryDocs: vi.fn(async () => [docs.get(JOB_UUID)]),
      readDoc: vi.fn(async (_c, id) => docs.get(id) ?? null),
      replaceDocIfMatch: vi.fn(async (_c, doc) => {
        docs.set(doc.id, doc);
        return doc;
      }),
      patchDoc: vi.fn(async (_c, id, updates) => {
        docs.set(id, { ...docs.get(id), ...updates });
        return docs.get(id);
      }),
    };
    const guard = {
      requireAgent: vi.fn(async () => ({
        agent: { agentId: 'vps-1', capabilities: ['terraform-validate'] },
        error: null,
      })),
    };
    const agent = createLabAgentHandlers({ guard, store, now: () => new Date(NOW) });
    const claimed = await agent.claimLabJob({ json: async () => ({ agentId: 'vps-1' }) }, context);
    expect(JSON.parse(claimed.body).job.id).toBe(JOB_UUID);
    expect(docs.get(JOB_UUID)).toMatchObject({ status: 'claimed', public: true, ttl: 86_400 });

    await agent.completeLabJob(
      { json: async () => ({ agentId: 'vps-1', jobId: JOB_UUID, status: 'succeeded', exitCode: 0, output: 'ok' }) },
      context
    );
    expect(docs.get(JOB_UUID)).toMatchObject({ status: 'succeeded', public: true, ttl: 86_400 });
  });

  it('returns 500 and no job id when the write fails', async () => {
    const store = memStore();
    store.createDoc.mockImplementation(async (container, doc) => {
      if (container === 'lab_jobs') throw new Error('cosmos down');
      return doc;
    });
    const { handlers } = build({ store });
    const res = await handlers.submitJob(postRequest(body()), context);
    expect(res.status).toBe(500);
    expect(parse(res).jobId).toBeUndefined();
  });
});

describe('the job read', () => {
  const publicJob = (over = {}) => ({
    ...publicJobDocument(JOB_UUID, body(), '2026-09-27T11:59:00.000Z'),
    status: 'succeeded',
    agentId: 'vps-1',
    exitCode: 0,
    output: 'Success! The configuration is valid.\n',
    claimedAt: '2026-09-27T11:59:10.000Z',
    finishedAt: '2026-09-27T11:59:40.000Z',
    _ts: Math.floor(NOW / 1000) - 20,
    ...over,
  });

  const seeded = (doc) => {
    const store = memStore();
    if (doc) store.docs.set(`lab_jobs/${doc.id}`, doc);
    return build({ store });
  };

  it('answers a public job with its status and visitor report, and nothing else', async () => {
    const { handlers } = seeded(publicJob());
    const res = await handlers.getJob(getRequest({ jobId: JOB_UUID }), context);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(parse(res)).toEqual({
      ok: true,
      job: {
        id: JOB_UUID,
        type: 'terraform-validate',
        status: 'succeeded',
        exitCode: 0,
        report: {
          verdict: 'valid',
          headline: REPORT_LINES.valid,
          errors: [],
          modules: [],
          modulesNote: null,
          providers: [],
        },
        createdAt: '2026-09-27T11:59:00.000Z',
        claimedAt: '2026-09-27T11:59:10.000Z',
        finishedAt: '2026-09-27T11:59:40.000Z',
      },
    });
    expect(res.body).not.toContain('vps-1');
    expect(res.body).not.toContain('terraform {}');
  });

  it('never answers the raw output, which stays on the document for the admin view', async () => {
    const output = "Unable to find image 'ghcr.io/x@sha256:abc' locally\n== terraform validate\nSuccess!\n";
    const { handlers, store } = seeded(publicJob({ output }));
    const res = await handlers.getJob(getRequest({ jobId: JOB_UUID }), context);
    expect(parse(res).job).not.toHaveProperty('output');
    expect(res.body).not.toContain('ghcr.io');
    expect(store.docs.get(`lab_jobs/${JOB_UUID}`).output).toBe(output);
  });

  it('has no report while the job is still in flight', async () => {
    const { handlers } = seeded(publicJob({ status: 'running', exitCode: null, output: null }));
    const res = await handlers.getJob(getRequest({ jobId: JOB_UUID }), context);
    expect(parse(res).job).toMatchObject({ status: 'running', report: null });
  });

  it.each([
    ['a missing job', null],
    ['an admin job', { ...publicJob(), public: undefined }],
    ['a job flagged public by anything but true', { ...publicJob(), public: 'true' }],
    ['a public job of another type', publicJob({ type: 'shell-echo' })],
    ['a public job past its day', publicJob({ _ts: Math.floor(NOW / 1000) - PUBLIC_JOB_TTL_SECONDS })],
  ])('answers the identical 404 for %s', async (_label, doc) => {
    const { handlers } = seeded(doc);
    const res = await handlers.getJob(getRequest({ jobId: JOB_UUID }), context);
    expect(res.status).toBe(404);
    expect(parse(res)).toEqual({ ok: false, code: 'JOB_NOT_FOUND', error: 'Job not found' });
  });

  it.each(['', 'not-a-uuid', '../lab_agents/vps-1', `${JOB_UUID}x`, JOB_UUID.toUpperCase()])(
    'refuses jobId %j before any read',
    async (jobId) => {
      const { handlers, store } = seeded(publicJob());
      const res = await handlers.getJob(getRequest({ jobId }), context);
      expect(res.status).toBe(400);
      expect(store.readDoc).not.toHaveBeenCalled();
    }
  );

  it('returns 500 on a store fault', async () => {
    const { handlers, store } = seeded(publicJob());
    store.readDoc.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await handlers.getJob(getRequest({ jobId: JOB_UUID }), context);
    expect(res.status).toBe(500);
  });

  it('keeps a job without _ts live, and projects odd fields to null', () => {
    const doc = publicJob({ _ts: undefined, exitCode: '0', output: 7, claimedAt: 'garbage' });
    expect(isLivePublicJob(doc, NOW)).toBe(true);
    const projected = projectPublicJob(doc);
    expect(projected).toMatchObject({ exitCode: null, claimedAt: null });
    expect(projected.report).toMatchObject({ verdict: 'valid', modules: [], providers: [] });
    expect(projected).not.toHaveProperty('output');
  });
});

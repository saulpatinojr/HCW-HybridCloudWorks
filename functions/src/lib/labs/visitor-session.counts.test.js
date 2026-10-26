/**
 * The lab-start counter as the visitor session broker drives it
 * (visitor-session.js startSession). What must hold: a NEW session is counted
 * exactly once; a repeat request that returns a live session, a refused
 * request and a counter fault do not add a count or change the visitor's
 * answer; and nothing that identifies the visitor reaches what is stored,
 * however much of it the request carried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryStore } from '../../../test/memory-store.js';
import {
  LAB_STARTS_CONTAINER,
  LAB_STARTS_DAY_KEYS,
  LAB_STARTS_DAY_KIND,
  LAB_STARTS_META_ID,
  LAB_STARTS_META_KEYS,
  dayDocId,
} from './lab-starts.js';
import {
  DOOR_CODES,
  VISITOR_SESSION_SWITCH,
  createVisitorSessionHandlers,
} from './visitor-session.js';

const NOW = Date.parse('2026-10-26T14:30:15.250Z');
const DAY = '2026-10-26';
const SITE = 'https://hybridcloudworks.com';
const LAB = 'terraform-validate-walkthrough';
const OTHER_LAB = 'landing-zone-builder-output';
// Values a leak would show up as. They are made up and appear in the request.
const CLIENT_HASH = 'client-hash-9f8e7d6c5b4a';
const CLIENT_IP = '203.0.113.77';
const TURNSTILE_TOKEN = 'turnstile-token-0a1b2c3d4e5f';

const ENV = {
  [VISITOR_SESSION_SWITCH]: 'true',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  CODER_URL: 'https://coder.lab.hybridcloudworks.com',
  CODER_BROKER_TOKEN: 'broker-token',
};

// The broker keeps one live session and two starts a day per client, so a test
// that starts several sessions says which client is asking.
let client = CLIENT_HASH;
const identity = {
  fromRequest: () => ({
    anonymousKey: () => client,
    trustedClientIp: () => CLIENT_IP,
  }),
};

/**
 * The shared in-memory Cosmos plus what the broker also uses: the lab_jobs
 * query (the sessions given in `sessions`) and the daily cap's increment,
 * which answers "no counter yet" so the cap creates one.
 */
function brokerStore(sessions = []) {
  const store = memoryStore(
    {},
    {
      query: ({ container, parameters }) => {
        if (container !== 'lab_jobs') return [];
        const status = parameters.find((p) => p.name === '@status')?.value;
        return sessions.filter((s) => s.status === status);
      },
    }
  );
  store.incrementIf = vi.fn(async () => {
    throw Object.assign(new Error('missing'), { code: 404 });
  });
  return store;
}

const fetchImpl = vi.fn(async (url) => {
  if (String(url).startsWith('https://challenges.cloudflare.com/')) {
    return {
      ok: true,
      json: async () => ({ success: true, hostname: 'hybridcloudworks.com', action: 'visitor-session' }),
    };
  }
  if (url.endsWith('/api/v2/templates')) {
    return { ok: true, json: async () => [{ id: 'tmpl-1', name: 'hcw-lab' }] };
  }
  if (url.endsWith('/api/v2/organizations')) return { ok: true, json: async () => [{ id: 'org-1' }] };
  if (url.endsWith('/api/v2/users')) {
    return { ok: true, json: async () => ({ id: 'u-1', username: 'v-abc123' }) };
  }
  return { ok: true, json: async () => ({ id: 'ws-1' }) };
});

const startRequest = (labId = LAB, extra = {}) => ({
  headers: new Headers({ origin: SITE }),
  url: `${SITE}/api/public/labs/visitor-session?utm=secret-campaign&email=a@example.com`,
  json: async () => ({ labId, turnstileToken: TURNSTILE_TOKEN, ...extra }),
});

const system = (store) =>
  [...store.docs.entries()]
    .filter(([path]) => path.startsWith(`${LAB_STARTS_CONTAINER}/`))
    .map(([, doc]) => doc);

const dayDocs = (store) => system(store).filter((doc) => doc.kind === LAB_STARTS_DAY_KIND);

let previousEnv;
beforeEach(() => {
  previousEnv = process.env;
  process.env = { ...ENV, LABS_VISITOR_MAX_CONCURRENT: '9' };
  client = CLIENT_HASH;
  fetchImpl.mockClear();
});
afterEach(() => {
  process.env = previousEnv;
});

const handlersFor = (store, clock = () => NOW) =>
  createVisitorSessionHandlers({ store, identity, fetchImpl, clock });

describe('a new visitor session', () => {
  it('is counted once, for its lab and its UTC day', async () => {
    const store = brokerStore();
    const res = await handlersFor(store).startSession(startRequest());
    expect(res.status).toBe(201);
    expect(dayDocs(store)).toHaveLength(1);
    const [day] = dayDocs(store);
    expect(day.id).toBe(dayDocId(DAY));
    expect(day.byLab).toEqual({ [LAB]: 1 });
    expect(day.total).toBe(1);
  });

  it('is counted per lab, and again on the next UTC day', async () => {
    const store = brokerStore();
    const clockState = { now: NOW };
    const handlers = handlersFor(store, () => clockState.now);
    client = 'client-one';
    expect((await handlers.startSession(startRequest(LAB))).status).toBe(201);
    clockState.now = Date.parse('2026-10-26T23:59:59.999Z');
    client = 'client-two';
    expect((await handlers.startSession(startRequest(OTHER_LAB))).status).toBe(201);
    clockState.now = Date.parse('2026-10-27T00:00:00.000Z');
    client = 'client-three';
    expect((await handlers.startSession(startRequest(LAB))).status).toBe(201);

    const days = Object.fromEntries(dayDocs(store).map((doc) => [doc.day, doc.byLab]));
    expect(days).toEqual({
      '2026-10-26': { [LAB]: 1, [OTHER_LAB]: 1 },
      '2026-10-27': { [LAB]: 1 },
    });
  });

  it('stores only the allowed keys, whatever the request carried', async () => {
    const store = brokerStore();
    const res = await handlersFor(store).startSession(
      startRequest(LAB, { email: 'person@example.com', name: 'A Person', sessionId: 'sess-x' })
    );
    expect(res.status).toBe(201);

    const docs = system(store);
    expect(docs).toHaveLength(2); // the day document and the marker
    for (const doc of docs) {
      const keys = Object.keys(doc).filter((key) => !key.startsWith('_'));
      const allowed = doc.kind === LAB_STARTS_DAY_KIND ? LAB_STARTS_DAY_KEYS : LAB_STARTS_META_KEYS;
      expect(keys.sort()).toEqual([...allowed].sort());
    }
  });

  it('keeps the client hash, address, token, session id, username and URL out of what it stores', async () => {
    const store = brokerStore();
    const res = await handlersFor(store).startSession(startRequest());
    const { sessionId, accessUrl } = JSON.parse(res.body);
    const stored = JSON.stringify(system(store));
    for (const secret of [
      CLIENT_HASH,
      CLIENT_IP,
      TURNSTILE_TOKEN,
      sessionId,
      accessUrl,
      'v-abc123',
      'secret-campaign',
      'a@example.com',
      'lab-lzb',
      'lab-tfv',
      SITE,
      '14:30',
      '2026-10-26T',
    ]) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe('what is not counted', () => {
  it('a repeat request that returns the live session', async () => {
    const store = brokerStore();
    const handlers = handlersFor(store);
    const first = await handlers.startSession(startRequest());
    expect(first.status).toBe(201);
    // The broker finds the first session through lab_jobs; give the query that answer.
    const session = [...store.docs.values()].find((doc) => doc.type === 'visitor-session' && doc.status === 'active');
    expect(session).toBeDefined();
    const withSession = brokerStore([session]);
    // Carry the counts over so the test sees whether the repeat adds to them.
    for (const [path, doc] of store.docs) {
      if (path.startsWith(`${LAB_STARTS_CONTAINER}/`)) withSession.docs.set(path, doc);
    }
    const again = await handlersFor(withSession).startSession(startRequest());
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body).sessionId).toBe(session.id);
    expect(dayDocs(withSession)[0].total).toBe(1);
  });

  it.each([
    ['an unknown lab', () => startRequest('not-a-lab'), 400],
    [
      'a request from outside the site',
      () => ({ ...startRequest(), headers: new Headers({ origin: 'https://evil.example' }) }),
      403,
    ],
    ['a missing Turnstile token', () => ({ ...startRequest(), json: async () => ({ labId: LAB }) }), 403],
  ])('%s', async (_name, build, status) => {
    const store = brokerStore();
    const res = await handlersFor(store).startSession(build());
    expect(res.status).toBe(status);
    expect(system(store)).toEqual([]);
  });

  it('a request refused because the lab is full', async () => {
    const live = {
      id: 'sess-live',
      type: 'visitor-session',
      status: 'active',
      clientHash: 'someone-else',
      expiresAt: new Date(NOW + 60_000).toISOString(),
    };
    process.env = { ...ENV, LABS_VISITOR_MAX_CONCURRENT: '1' };
    const store = brokerStore([live]);
    const res = await handlersFor(store).startSession(startRequest());
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.capacity_full);
    expect(system(store)).toEqual([]);
  });

  it('a start the Coder host could not provision', async () => {
    const store = brokerStore();
    const failing = vi.fn(async (url) =>
      String(url).startsWith('https://challenges.cloudflare.com/')
        ? { ok: true, json: async () => ({ success: true, hostname: 'hybridcloudworks.com', action: 'visitor-session' }) }
        : { ok: false, status: 502, text: async () => 'bad gateway' }
    );
    const handlers = createVisitorSessionHandlers({ store, identity, fetchImpl: failing, clock: () => NOW });
    const res = await handlers.startSession(startRequest(), { error: vi.fn() });
    expect(res.status).toBe(502);
    expect(system(store)).toEqual([]);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'a lab id that is a name on every object (%s)',
    async (name) => {
      const store = brokerStore();
      const res = await handlersFor(store).startSession(startRequest(name));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).code).toBe(DOOR_CODES.invalid_lab);
      expect(fetchImpl).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/v2/users'),
        expect.anything()
      );
      expect(system(store)).toEqual([]);
    }
  );

  it('a status check or a stop', async () => {
    const store = brokerStore();
    const handlers = handlersFor(store);
    await handlers.getStatus({ headers: new Headers({ origin: SITE }) });
    await handlers.stopSession({ url: `${SITE}/x?sessionId=nope` });
    expect(system(store)).toEqual([]);
  });
});

describe('a counter fault', () => {
  it('never reaches the visitor: the session is still handed out, and only the code is logged', async () => {
    const store = brokerStore();
    store.fail(LAB_STARTS_CONTAINER, LAB_STARTS_META_ID, 'readDoc', {
      code: 503,
      message: `store down for ${CLIENT_HASH} ${CLIENT_IP}`,
    });
    const context = { error: vi.fn() };
    const res = await handlersFor(store).startSession(startRequest(), context);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(context.error).toHaveBeenCalledWith('visitor-session: lab start not counted (503)');
    const logged = JSON.stringify(context.error.mock.calls);
    expect(logged).not.toContain(CLIENT_HASH);
    expect(logged).not.toContain(CLIENT_IP);
  });

  it('logs the reason, and only the reason, when the count is given up after lost races', async () => {
    const store = brokerStore();
    store.fail(LAB_STARTS_CONTAINER, dayDocId(DAY), 'createDoc', { code: 409 }, 5);
    const context = { error: vi.fn() };
    const res = await handlersFor(store).startSession(startRequest(), context);
    expect(res.status).toBe(201);
    expect(context.error).toHaveBeenCalledWith('visitor-session: lab start not counted (contention)');
    expect(dayDocs(store)).toEqual([]);
  });

  it('is tolerated when the caller passes no logging context at all', async () => {
    const store = brokerStore();
    store.fail(LAB_STARTS_CONTAINER, LAB_STARTS_META_ID, 'readDoc', { code: 500 });
    const res = await handlersFor(store).startSession(startRequest());
    expect(res.status).toBe(201);
  });
});

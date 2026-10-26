/**
 * The visitor-session sweep timer: its registration, its gate, what it is
 * allowed to touch, and what happens when it overlaps another sweep (#1403,
 * item 1). One run itself is tested in lib/timers/visitor-session-sweep.test.js.
 *
 * The handler is driven end to end here: the real module, a Cosmos-like store
 * behind the mocked cosmos-client.js, and a fake Coder behind `fetch`.
 * cosmos-client.js is mocked with spies on every verb that would CREATE or
 * overwrite a document the sweep has no business writing, so "the timer never
 * creates a session" is a test that watches them, not a sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const timers = new Map();
vi.mock('@azure/functions', () => ({
  app: {
    timer: (name, options) => timers.set(name, options),
    http: () => {},
    storageQueue: () => {},
    cosmosDB: () => {},
  },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));

// The module store, faked. The three verbs the sweep uses delegate to whatever
// store a test puts in `backing`; every other verb is a spy that must not be called.
const backing = vi.hoisted(() => ({ store: null }));
const forbidden = vi.hoisted(() => ({
  createDoc: vi.fn(async () => {
    throw new Error('createDoc must not be called by the sweep');
  }),
  upsertDoc: vi.fn(async () => {
    throw new Error('upsertDoc must not be called by the sweep');
  }),
  incrementIf: vi.fn(async () => {
    throw new Error('incrementIf must not be called by the sweep');
  }),
  patchDoc: vi.fn(async () => {
    throw new Error('patchDoc must not be called by the sweep');
  }),
  deleteDoc: vi.fn(async () => {
    throw new Error('deleteDoc must not be called by the sweep');
  }),
}));
vi.mock('../lib/cosmos-client.js', () => ({
  queryDocs: (...args) => backing.store.queryDocs(...args),
  readDoc: (...args) => backing.store.readDoc(...args),
  replaceDocIfMatch: (...args) => backing.store.replaceDocIfMatch(...args),
  ...forbidden,
}));

import { memoryStore } from '../../test/memory-store.js';
import { reapExpiredVisitorSessions } from '../lib/labs/visitor-session.js';
import { resetUnconfiguredWarning } from '../lib/timers/visitor-session-sweep.js';

const { SWEEP_STORE, TIMER_FLAG, TIMER_NAME, TIMER_SCHEDULE, sweepEnabled } = await import('./visitor-session-sweep.js');

const iso = (ms) => new Date(ms).toISOString();
const CODER_URL = 'https://coder.lab.hybridcloudworks.com';

function sweepStore(sessions = []) {
  return memoryStore(Object.fromEntries(sessions.map((s) => [`lab_jobs/${s.id}`, s])), {
    query: ({ docs, parameters }) => {
      const value = (name) => parameters?.find((p) => p.name === name)?.value;
      return docs.filter(
        (d) =>
          d.type === value('@type') &&
          d.status === value('@status') &&
          (value('@nowIso') === undefined || d.expiresAt <= value('@nowIso')) &&
          (value('@dueIso') === undefined || d.retryAt <= value('@dueIso'))
      );
    },
  });
}

const session = (id, overrides = {}) => ({
  id,
  type: 'visitor-session',
  status: 'active',
  clientHash: 'hash',
  labId: 'landing-zone-builder-output',
  coderUserId: `u-${id}`,
  coderUsername: `v-${id}`,
  workspaceId: `ws-${id}`,
  workspaceName: 'lab-lzb',
  expiresAt: iso(Date.now() - 60_000),
  ttl: 7200,
  ...overrides,
});

const waiting = (id) =>
  session(id, {
    status: 'cleanup_pending',
    endStatus: 'ended',
    endedAt: iso(Date.now() - 10 * 60_000),
    cleanupAttempts: 1,
    workspaceGone: true,
    userGone: false,
    expiresAt: iso(Date.now() + 60_000),
    retryAt: iso(Date.now() - 1000),
  });

/** A Coder that accepts every call, after a pause long enough for a second run to start meanwhile. */
function slowCoder() {
  return vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, status: 200 };
  });
}

const callsOf = (fetchImpl) => fetchImpl.mock.calls.map(([url, init]) => `${init?.method} ${new URL(url).pathname}`);

function recordingContext() {
  const lines = { log: [], warn: [] };
  return { context: { log: (line) => lines.log.push(line), warn: (line) => lines.warn.push(line) }, lines };
}

const envKeys = [
  'FEATURE_FLAG_SCHEDULERS',
  `FEATURE_FLAG_${TIMER_FLAG}`,
  'LABS_VISITOR_SESSIONS_ENABLED',
  'CODER_URL',
  'CODER_BROKER_TOKEN',
  'CODER_STATUS_TOKEN',
];
const saved = {};

beforeEach(() => {
  for (const key of envKeys) saved[key] = process.env[key];
  for (const key of envKeys) delete process.env[key];
  resetUnconfiguredWarning();
  for (const spy of Object.values(forbidden)) spy.mockClear();
  backing.store = sweepStore([]);
});

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

/** Arm the timer and configure Coder, as production would have both. */
function arm({ switchValue } = {}) {
  process.env[`FEATURE_FLAG_${TIMER_FLAG}`] = 'true';
  process.env.CODER_URL = CODER_URL;
  process.env.CODER_BROKER_TOKEN = 'broker-token-value';
  if (switchValue !== undefined) process.env.LABS_VISITOR_SESSIONS_ENABLED = switchValue;
}

const run = (context) => timers.get(TIMER_NAME).handler({}, context);

describe('sweepVisitorSessions registration', () => {
  it('is registered as an every-two-minutes timer with no output binding', () => {
    const timer = timers.get(TIMER_NAME);
    expect(TIMER_NAME).toBe('sweepVisitorSessions');
    expect(timer).toBeDefined();
    expect(TIMER_SCHEDULE).toBe('0 */2 * * * *');
    expect(timer.schedule).toBe(TIMER_SCHEDULE);
    expect(timer.extraOutputs).toBeUndefined();
  });

  it('is given the three store verbs the sweep uses and nothing that creates a document', () => {
    expect(Object.keys(SWEEP_STORE).sort()).toEqual(['queryDocs', 'readDoc', 'replaceDocIfMatch']);
    expect(SWEEP_STORE.createDoc).toBeUndefined();
  });
});

describe('the gate', () => {
  it('is gated like every timer: its own flag "true", the schedulers master not "false"', () => {
    expect(TIMER_FLAG).toBe('SWEEP_VISITOR_SESSIONS');
    expect(sweepEnabled({})).toBe(false);
    expect(sweepEnabled({ FEATURE_FLAG_SWEEP_VISITOR_SESSIONS: '1' })).toBe(false);
    expect(sweepEnabled({ FEATURE_FLAG_SWEEP_VISITOR_SESSIONS: 'false' })).toBe(false);
    expect(sweepEnabled({ FEATURE_FLAG_SWEEP_VISITOR_SESSIONS: 'true' })).toBe(true);
    expect(sweepEnabled({ FEATURE_FLAG_SWEEP_VISITOR_SESSIONS: 'true', FEATURE_FLAG_SCHEDULERS: 'false' })).toBe(false);
    expect(sweepEnabled({ FEATURE_FLAG_SWEEP_VISITOR_SESSIONS: 'true', FEATURE_FLAG_SCHEDULERS: 'true' })).toBe(true);
  });

  it('a disarmed timer logs the skip and touches nothing: no query, no Coder call', async () => {
    backing.store = sweepStore([session('d-1')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);
    process.env.CODER_URL = CODER_URL;
    process.env.CODER_BROKER_TOKEN = 'broker-token-value';
    const { context, lines } = recordingContext();

    await run(context);

    expect([...lines.warn, ...lines.log].some((line) => line.startsWith(`[${TIMER_NAME}] disabled — skipping`))).toBe(true);
    expect(backing.store.queryDocs).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(backing.store.get('lab_jobs', 'd-1').status).toBe('active');
  });

  it('a disarmed timer does not throw even when the invocation will not take the skip line', async () => {
    // The gate logs through the context before the sweep is reached, so this is
    // the one place the handler's last wall is what stands between a closed
    // context and a failed run.
    const closed = {
      log: () => {
        throw new Error('context is closed');
      },
      warn: () => {
        throw new Error('context is closed');
      },
    };

    await expect(run(closed)).resolves.toBeUndefined();
    expect(backing.store.queryDocs).not.toHaveBeenCalled();
  });

  it('the master switch alone holds it off, whatever its own flag says', async () => {
    arm();
    process.env.FEATURE_FLAG_SCHEDULERS = 'false';
    backing.store = sweepStore([session('m-1')]);
    vi.stubGlobal('fetch', slowCoder());

    await run(recordingContext().context);

    expect(backing.store.queryDocs).not.toHaveBeenCalled();
  });
});

describe('an armed timer', () => {
  it('ends the sessions past their hour and finishes the waiting clean-ups, and logs counts', async () => {
    arm();
    backing.store = sweepStore([session('a-1'), waiting('a-2')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);
    const { context, lines } = recordingContext();

    await run(context);

    expect(backing.store.get('lab_jobs', 'a-1').status).toBe('expired');
    expect(backing.store.get('lab_jobs', 'a-2').status).toBe('ended');
    expect(lines.warn).toEqual([`[${TIMER_NAME}] reaped=1 finished=1 pending=0 failed=0`]);
  });

  it.each([
    ['off', 'false'],
    ['not set at all', undefined],
    ['on', 'true'],
  ])('runs whether LABS_VISITOR_SESSIONS_ENABLED is %s: a switch turned off must not strand a Coder user', async (_name, switchValue) => {
    arm({ switchValue });
    backing.store = sweepStore([session('s-1'), waiting('s-2')]);
    vi.stubGlobal('fetch', slowCoder());

    await run(recordingContext().context);

    expect(backing.store.get('lab_jobs', 's-1').status).toBe('expired');
    expect(backing.store.get('lab_jobs', 's-2').status).toBe('ended');
  });

  it('never creates a session or a Coder user: no document written but the ones it ends, no Coder call that provisions', async () => {
    arm({ switchValue: 'true' });
    backing.store = sweepStore([session('n-1'), session('n-2', { expiresAt: iso(Date.now() + 30 * 60_000) }), waiting('n-3')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);
    const before = new Set(backing.store.docs.keys());

    await run(recordingContext().context);
    await run(recordingContext().context);

    for (const [verb, spy] of Object.entries(forbidden)) expect(spy, verb).not.toHaveBeenCalled();
    expect(new Set(backing.store.docs.keys())).toEqual(before); // no document added
    // A live session is left alone, and nothing asked Coder to make a user or a workspace.
    expect(backing.store.get('lab_jobs', 'n-2').status).toBe('active');
    const calls = callsOf(fetchImpl);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/^(DELETE \/api\/v2\/users\/[^/]+|POST \/api\/v2\/workspaces\/[^/]+\/builds|GET \/api\/v2\/users\/[^/]+\/workspace\/[^/]+)$/);
    }
    expect(calls.some((call) => call === 'POST /api/v2/users' || call.includes('/members/'))).toBe(false);
    // The one POST it makes asks Coder to delete a workspace, not to build or start one.
    const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const [, init] of posts) expect(JSON.parse(init.body)).toEqual({ transition: 'delete' });
  });

  it('does nothing, and spends no try, when Coder is not configured', async () => {
    process.env[`FEATURE_FLAG_${TIMER_FLAG}`] = 'true';
    backing.store = sweepStore([waiting('c-1')]);
    vi.stubGlobal('fetch', slowCoder());

    await run(recordingContext().context);

    expect(backing.store.queryDocs).not.toHaveBeenCalled();
    expect(backing.store.get('lab_jobs', 'c-1')).toMatchObject({ status: 'cleanup_pending', cleanupAttempts: 1 });
  });

  it('does nothing, and spends no try, when only the read-only status token is set', async () => {
    // CODER_STATUS_TOKEN cannot delete, so were it used every try would be refused and spent.
    process.env[`FEATURE_FLAG_${TIMER_FLAG}`] = 'true';
    process.env.CODER_URL = CODER_URL;
    process.env.CODER_STATUS_TOKEN = 'status-token-value';
    backing.store = sweepStore([waiting('c-2'), session('c-3')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);

    await run(recordingContext().context);
    await run(recordingContext().context);

    expect(backing.store.queryDocs).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(backing.store.get('lab_jobs', 'c-2')).toMatchObject({ status: 'cleanup_pending', cleanupAttempts: 1 });
    expect(backing.store.get('lab_jobs', 'c-3').status).toBe('active');
  });

  it('never throws out of the handler, whatever fails', async () => {
    arm();
    backing.store = sweepStore([session('t-1')]);
    backing.store.queryDocs.mockImplementation(async () => {
      throw Object.assign(new Error('the account key is abc123 for t-1'), { code: 503 });
    });
    vi.stubGlobal('fetch', slowCoder());
    const { context, lines } = recordingContext();

    await expect(run(context)).resolves.toBeUndefined();

    expect([...lines.warn, ...lines.log].join('\n')).not.toMatch(/abc123|t-1/);
    // Even a context that refuses every line, and a store that returns nothing usable.
    await expect(run({ log: () => { throw new Error('closed'); }, warn: () => { throw new Error('closed'); } })).resolves.toBeUndefined();
    backing.store.queryDocs.mockImplementation(async () => null);
    await expect(run(recordingContext().context)).resolves.toBeUndefined();
  });
});

describe('overlap: a second run, or another sweep, cannot make a second set of Coder calls', () => {
  const oneSet = ['POST /api/v2/workspaces/ws-o-1/builds', 'DELETE /api/v2/users/u-o-1'];

  /** How many times a run tried to take a session (the conditional write that marks it `ending`). */
  const claimsTried = (store) => store.replaceDocIfMatch.mock.calls.filter(([, doc]) => doc.status === 'ending').length;

  it('two timer runs at the same moment (as a host that did not skip a tick would make) call Coder once', async () => {
    arm();
    backing.store = sweepStore([session('o-1')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);

    await Promise.all([run(recordingContext().context), run(recordingContext().context)]);

    expect(callsOf(fetchImpl)).toEqual(oneSet);
    expect(backing.store.get('lab_jobs', 'o-1').status).toBe('expired');
    // Both did try to claim it: one won and one lost the ETag race.
    expect(claimsTried(backing.store)).toBe(2);
  });

  it('a timer run and the in-request sweep at the same moment call Coder once', async () => {
    arm();
    backing.store = sweepStore([session('o-1')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);
    const config = { base: CODER_URL, token: 'broker-token-value' };

    // The in-request sweep is the same function the handlers call, with the same arguments.
    await Promise.all([
      run(recordingContext().context),
      reapExpiredVisitorSessions(backing.store, fetchImpl, config, { nowIso: new Date().toISOString() }),
    ]);

    expect(callsOf(fetchImpl)).toEqual(oneSet);
    expect(backing.store.get('lab_jobs', 'o-1').status).toBe('expired');
    // Both did try to claim it (the sweep did meet the race), and one of them lost.
    expect(claimsTried(backing.store)).toBeGreaterThanOrEqual(2);
  });

  it('a timer run that meets a waiting session another run is finishing does not ask Coder again', async () => {
    arm();
    backing.store = sweepStore([waiting('o-1')]);
    const fetchImpl = slowCoder();
    vi.stubGlobal('fetch', fetchImpl);

    await Promise.all([run(recordingContext().context), run(recordingContext().context), run(recordingContext().context)]);

    expect(callsOf(fetchImpl)).toEqual(['DELETE /api/v2/users/u-o-1']);
    expect(backing.store.get('lab_jobs', 'o-1').status).toBe('ended');
    expect(claimsTried(backing.store)).toBeGreaterThanOrEqual(2);
  });
});

/**
 * One run of the visitor-session sweep timer (#1403, item 1), driven with a
 * Cosmos-like store and a fake Coder. The registration, the schedule and the
 * gate are tested beside the timer, in functions/src/functions/visitor-session-sweep.test.js.
 *
 * What must hold: a run does the sweep and reports counts only; it does
 * nothing, not even a query, when Coder is not configured (it would spend
 * tries on sessions it cannot clean); it never throws; and what it logs names
 * no session, no Coder id and none of the text Coder or Cosmos sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryStore } from '../../../test/memory-store.js';
import { runCosmosQuery } from '../../../test/cosmos-predicate.js';
import { CLEANUP_RETRY_BASE_MS } from '../labs/visitor-session.js';
import { SWEEP_NAME, createVisitorSessionSweep, resetUnconfiguredWarning } from './visitor-session-sweep.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const CODER_ENV = { CODER_URL: 'https://coder.lab.hybridcloudworks.com', CODER_BROKER_TOKEN: 'broker-token-value' };

/** An in-memory store that runs the sweep's queries as written, with their parameters. */
function sweepStore(sessions = []) {
  return memoryStore(Object.fromEntries(sessions.map((s) => [`lab_jobs/${s.id}`, s])), {
    // The sweep's own SQL, run against these documents (#1403, item 8).
    query: runCosmosQuery,
  });
}

const expired = (id, overrides = {}) => ({
  id,
  type: 'visitor-session',
  status: 'active',
  clientHash: 'hash',
  labId: 'landing-zone-builder-output',
  coderUserId: `u-${id}`,
  coderUsername: `v-${id}`,
  workspaceId: `ws-${id}`,
  workspaceName: 'lab-lzb',
  expiresAt: iso(NOW - 60_000),
  ttl: 7200,
  ...overrides,
});

/** A Coder that accepts every delete, and remembers what it was asked. */
function acceptingCoder() {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

const callsOf = (fetchImpl) => fetchImpl.mock.calls.map(([url, init]) => `${init?.method} ${new URL(url).pathname}`);

/** An invocation context that records every line, by level. */
function recordingContext() {
  const lines = { log: [], warn: [] };
  return {
    context: { log: (line) => lines.log.push(line), warn: (line) => lines.warn.push(line) },
    lines,
    all: () => [...lines.log, ...lines.warn],
  };
}

const sweepWith = (store, fetchImpl, env = CODER_ENV) =>
  createVisitorSessionSweep({ store, fetchImpl, env, now: () => NOW });

beforeEach(() => {
  resetUnconfiguredWarning();
});

describe('one run of the sweep', () => {
  it('ends an expired session, deletes its Coder workspace and user, and reports counts only', async () => {
    const store = sweepStore([expired('s-1')]);
    const fetchImpl = acceptingCoder();
    const { context, lines } = recordingContext();

    const result = await sweepWith(store, fetchImpl).run(context);

    expect(result).toEqual({ swept: true, reaped: 1, finished: 0, pending: 0, failed: 0 });
    expect(callsOf(fetchImpl)).toEqual(['POST /api/v2/workspaces/ws-s-1/builds', 'DELETE /api/v2/users/u-s-1']);
    expect(store.get('lab_jobs', 's-1').status).toBe('expired');
    // Something happened, so the summary is a Warning (it ships); it holds four numbers.
    expect(lines.warn).toEqual([`[${SWEEP_NAME}] reaped=1 finished=0 pending=0 failed=0`]);
  });

  it('finishes a clean-up that was waiting for its next try', async () => {
    const waiting = expired('w-1', {
      status: 'cleanup_pending',
      endStatus: 'ended',
      endedAt: iso(NOW - 5 * 60_000),
      cleanupAttempts: 1,
      workspaceGone: true,
      userGone: false,
      retryAt: iso(NOW - 1000),
    });
    const store = sweepStore([waiting]);
    const fetchImpl = acceptingCoder();

    const result = await sweepWith(store, fetchImpl).run(recordingContext().context);

    expect(result).toMatchObject({ swept: true, finished: 1 });
    expect(callsOf(fetchImpl)).toEqual(['DELETE /api/v2/users/u-w-1']);
    expect(store.get('lab_jobs', 'w-1').status).toBe('ended');
  });

  it('is quiet, and cheap, when there is nothing to do: two queries, no Coder call, an Information line', async () => {
    const store = sweepStore([]);
    const fetchImpl = acceptingCoder();
    const { context, lines } = recordingContext();

    const result = await sweepWith(store, fetchImpl).run(context);

    expect(result).toEqual({ swept: true, reaped: 0, finished: 0, pending: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The sessions past their hour; then, in one query, every record due again (#1403).
    expect(store.queryDocs).toHaveBeenCalledTimes(2);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(lines.warn).toEqual([]);
    expect(lines.log).toEqual([`[${SWEEP_NAME}] reaped=0 finished=0 pending=0 failed=0`]);
  });

  it('takes up no more than the sweep’s own limit of sessions in one run', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => expired(`b-${String(i).padStart(2, '0')}`));
    const store = sweepStore(sessions);

    const result = await sweepWith(store, acceptingCoder()).run(recordingContext().context);

    // MAX_SWEEP_SESSIONS is 10; the other two wait for the next tick.
    expect(result.reaped).toBe(10);
    expect(sessions.filter((s) => store.get('lab_jobs', s.id).status === 'active')).toHaveLength(2);
  });

  it('keeps a session whose clean-up Coder refuses, as the sweep does, and says so in counts', async () => {
    const store = sweepStore([expired('r-1')]);
    const refusing = vi.fn(async () => ({ ok: false, status: 417 }));
    const { context, lines } = recordingContext();

    const result = await sweepWith(store, refusing).run(context);

    expect(result).toMatchObject({ swept: true, reaped: 0, pending: 1 });
    expect(store.get('lab_jobs', 'r-1')).toMatchObject({
      status: 'cleanup_pending',
      retryAt: iso(NOW + CLEANUP_RETRY_BASE_MS),
    });
    // Both the sweep's own line and the summary are Warnings: Information is not shipped (host.json).
    expect(lines.warn).toEqual([
      expect.stringContaining('Coder clean-up is not finished (workspace HTTP 417, user skipped); try 1 of 5'),
      `[${SWEEP_NAME}] reaped=0 finished=0 pending=1 failed=0`,
    ]);
    expect(lines.log).toEqual([]);
  });

  it('sends the broker token, and only that, to Coder', async () => {
    const store = sweepStore([expired('t-1')]);
    const fetchImpl = acceptingCoder();

    await sweepWith(store, fetchImpl, { ...CODER_ENV, CODER_STATUS_TOKEN: 'status-token-value' }).run(recordingContext().context);

    const tokens = fetchImpl.mock.calls.map(([, init]) => init.headers['Coder-Session-Token']);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set(['broker-token-value']));
  });
});

describe('when Coder is not configured', () => {
  it('does nothing at all: no query, no Coder call, and no try spent on a session that has something in Coder', async () => {
    const waiting = expired('u-1', { status: 'cleanup_pending', endStatus: 'ended', cleanupAttempts: 2, retryAt: iso(NOW - 1000) });
    const store = sweepStore([waiting, expired('u-2')]);
    const fetchImpl = acceptingCoder();

    for (let tick = 0; tick < 6; tick += 1) {
      expect(await sweepWith(store, fetchImpl, {}).run(recordingContext().context)).toEqual({
        swept: false,
        reason: 'unconfigured',
      });
    }

    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Six ticks, and the tries are exactly where they were: five would have ended it as cleanup_failed.
    expect(store.get('lab_jobs', 'u-1')).toMatchObject({ status: 'cleanup_pending', cleanupAttempts: 2 });
    expect(store.get('lab_jobs', 'u-2').status).toBe('active');
  });

  it('treats an unresolved Key Vault reference as no setting', async () => {
    const env = { CODER_URL: CODER_ENV.CODER_URL, CODER_BROKER_TOKEN: '@Microsoft.KeyVault(SecretUri=https://kv.example/secrets/x)' };
    const store = sweepStore([expired('k-1')]);

    expect(await sweepWith(store, acceptingCoder(), env).run(recordingContext().context)).toMatchObject({
      swept: false,
      reason: 'unconfigured',
    });
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it.each([
    ['no broker token at all', { CODER_URL: CODER_ENV.CODER_URL, CODER_STATUS_TOKEN: 'status-token-value' }],
    [
      'a broker token that is an unresolved Key Vault reference',
      {
        CODER_URL: CODER_ENV.CODER_URL,
        CODER_BROKER_TOKEN: '@Microsoft.KeyVault(SecretUri=https://kv.example/secrets/x)',
        CODER_STATUS_TOKEN: 'status-token-value',
      },
    ],
    ['an empty broker token', { CODER_URL: CODER_ENV.CODER_URL, CODER_BROKER_TOKEN: '', CODER_STATUS_TOKEN: 'status-token-value' }],
  ])('does not fall back to the read-only status token: %s means nothing is swept and no try is spent', async (_name, env) => {
    // A status token cannot delete anything: were it used, every try would be refused and spent,
    // and five end a session as cleanup_failed. readBrokerConfig must not hand it back.
    const waiting = expired('f-1', { status: 'cleanup_pending', endStatus: 'ended', cleanupAttempts: 1, retryAt: iso(NOW - 1000) });
    const store = sweepStore([waiting]);
    const fetchImpl = acceptingCoder();

    for (let tick = 0; tick < 6; tick += 1) {
      expect(await sweepWith(store, fetchImpl, env).run(recordingContext().context)).toEqual({
        swept: false,
        reason: 'unconfigured',
      });
    }

    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.get('lab_jobs', 'f-1')).toMatchObject({ status: 'cleanup_pending', cleanupAttempts: 1 });
  });

  it('warns once per process, then drops to Information, so a Coder deliberately not set up does not page', async () => {
    const sweep = sweepWith(sweepStore([]), acceptingCoder(), {});
    const first = recordingContext();
    const second = recordingContext();

    await sweep.run(first.context);
    await sweep.run(second.context);

    expect(first.lines.warn).toHaveLength(1);
    expect(first.lines.warn[0]).toContain('Coder is not set up (CODER_URL and CODER_BROKER_TOKEN)');
    expect(second.lines.warn).toEqual([]);
    expect(second.lines.log).toHaveLength(1);
  });

  it('warns again when the settings are lost a second time: a run that finds Coder set up re-arms the warning', async () => {
    const store = sweepStore([]);
    const unset = sweepWith(store, acceptingCoder(), {});
    const set = sweepWith(store, acceptingCoder());
    const episodes = [recordingContext(), recordingContext(), recordingContext(), recordingContext()];

    await unset.run(episodes[0].context); // lost: Warning
    await unset.run(episodes[1].context); // still lost: Information
    await set.run(episodes[2].context); // set up again
    await unset.run(episodes[3].context); // lost again: Warning

    expect(episodes.map((e) => e.lines.warn.length)).toEqual([1, 0, 0, 1]);
  });
});

describe('what it logs, and what it never throws', () => {
  it('names no session, no Coder id or user, and none of the text Coder or Cosmos sent', async () => {
    const store = sweepStore([
      expired('sess-secretid-1'),
      expired('sess-secretid-2', { status: 'cleanup_pending', endStatus: 'ended', cleanupAttempts: 4, retryAt: iso(NOW - 1000), workspaceGone: true }),
    ]);
    // Coder answers with text that names things; the Cosmos write fails with a message that names a session.
    const chatty = vi.fn(async () => ({
      ok: false,
      status: 417,
      text: async () => 'You cannot delete a user that has workspaces: u-sess-secretid-1 coder-token-leak',
    }));
    store.fail('lab_jobs', 'sess-secretid-1', 'replaceDocIfMatch', Object.assign(new Error('cosmos is down for sess-secretid-1'), { code: 503 }));
    const recorded = recordingContext();

    await sweepWith(store, chatty).run(recorded.context);

    const text = recorded.all().join('\n');
    expect(text).not.toMatch(/sess-secretid|u-sess|ws-sess|v-sess|coder-token-leak|broker-token-value|cosmos is down|cannot delete a user/);
    // It did say something: the given-up line and the summary, with the kinds and the numbers.
    expect(text).toMatch(/given up after 5 tries in round 1 of 25; another round follows in an hour \(workspace done, user HTTP 417\)/);
    expect(text).toMatch(/could not be saved \(503\)/);
    expect(text).toMatch(/reaped=0 finished=0 pending=0 failed=2/);
  });

  it('does not throw when the store is down, and says only the kind', async () => {
    const store = {
      queryDocs: vi.fn(async () => {
        throw Object.assign(new Error('the account key is abc123 for sess-1'), { code: 503 });
      }),
    };
    const recorded = recordingContext();

    const result = await sweepWith(store, acceptingCoder()).run(recorded.context);

    expect(result).toMatchObject({ swept: true, reaped: 0, failed: 0 });
    expect(recorded.all().join('\n')).toMatch(/could not be listed \(503\)/);
    expect(recorded.all().join('\n')).not.toMatch(/abc123|sess-1/);
  });

  it('does not throw when something outside the sweep fails, and says only the kind of error', async () => {
    // Reading the settings throws: the run's own wall holds.
    const hostile = new Proxy({}, {
      get() {
        throw Object.assign(new Error('reading the environment failed for u-hidden'), { code: 'EBOOM' });
      },
    });
    const recorded = recordingContext();

    const result = await sweepWith(sweepStore([]), acceptingCoder(), hostile).run(recorded.context);

    expect(result).toEqual({ swept: false, reason: 'error' });
    expect(recorded.lines.warn).toEqual([`[${SWEEP_NAME}] the sweep could not run (EBOOM)`]);
  });

  it('does not throw when the invocation cannot take a log line, or has no log methods at all', async () => {
    const store = sweepStore([expired('l-1')]);
    const angry = { log: () => { throw new Error('context is closed'); }, warn: () => { throw new Error('context is closed'); } };

    await expect(sweepWith(store, acceptingCoder()).run(angry)).resolves.toMatchObject({ swept: true, reaped: 1 });
    await expect(sweepWith(sweepStore([]), acceptingCoder()).run({})).resolves.toMatchObject({ swept: true });
    await expect(sweepWith(sweepStore([]), acceptingCoder(), {}).run({})).resolves.toMatchObject({ swept: false });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a context'],
    ['a number', 7],
    ['an object whose log methods are not functions', { log: 'x', warn: 42 }],
    [
      'an object whose log getter throws',
      Object.defineProperty({}, 'warn', {
        get() {
          throw new Error('getter exploded');
        },
      }),
    ],
  ])('does not throw when the invocation is %s', async (_name, context) => {
    const store = sweepStore([expired('n-1')]);

    await expect(sweepWith(store, acceptingCoder()).run(context)).resolves.toMatchObject({ swept: true, reaped: 1 });
    await expect(sweepWith(sweepStore([]), acceptingCoder(), {}).run(context)).resolves.toMatchObject({ swept: false });
  });

  it('puts a run that only gave up on sessions at Warning, because a give-up is the one outcome a person must see', async () => {
    const exhausted = expired('g-1', {
      status: 'cleanup_pending',
      endStatus: 'ended',
      cleanupAttempts: 4,
      retryAt: iso(NOW - 1000),
      workspaceGone: true,
      userGone: false,
    });
    const store = sweepStore([exhausted]);
    const refusing = vi.fn(async () => ({ ok: false, status: 417 }));
    const { context, lines } = recordingContext();

    const result = await sweepWith(store, refusing).run(context);

    expect(result).toMatchObject({ swept: true, failed: 1, reaped: 0, finished: 0, pending: 0 });
    expect(store.get('lab_jobs', 'g-1').status).toBe('cleanup_failed');
    expect(lines.log).toEqual([]);
    expect(lines.warn).toHaveLength(2);
    expect(lines.warn[0]).toContain('given up after 5 tries');
    expect(lines.warn[1]).toBe(`[${SWEEP_NAME}] reaped=0 finished=0 pending=0 failed=1`);
  });
});

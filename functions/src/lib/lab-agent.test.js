/**
 * The Labs agent API.
 *
 * The load-bearing assertions are about containment. This is the entire
 * surface a credential on a third-party VPS can reach, so what matters is not
 * that the happy path works but that a compromised agent cannot claim job
 * types it was not registered for, complete jobs it does not hold, report a
 * status that hides work, or grant itself new capabilities.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createLabAgentHandlers,
  AGENT_TERMINAL_STATUSES,
  OUTPUT_CAP_BYTES,
  parseAppliedRecord,
} from './lab-agent.js';
import { AGENT_ONLINE_SOURCE, BACK_ONLINE_SENT } from './timers/agent-health.js';

const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
const NOW = new Date('2026-08-10T04:00:00.000Z');

const allowGuard = (agent = {}) => ({
  requireAgent: vi.fn(async () => ({
    agent: { agentId: 'vps-1', active: true, capabilities: ['shell-echo'], ...agent },
    identity: { oid: 'oid-1' },
    error: null,
  })),
});
const denyGuard = () => ({
  requireAgent: vi.fn(async () => ({
    agent: null,
    identity: null,
    error: { status: 403, body: JSON.stringify({ ok: false, error: 'Agent access required' }) },
  })),
});

const emptyStore = () => ({
  queryDocs: vi.fn(async () => []),
  readDoc: vi.fn(async () => null),
  patchDoc: vi.fn(async () => ({})),
  replaceDocIfMatch: vi.fn(async (c, doc) => doc),
});

const req = (body) => ({ json: async () => body });
const make = (guard, store) => createLabAgentHandlers({ guard, store, now: () => NOW });

const parse = (res) => JSON.parse(res.body);

describe('every handler is guarded', () => {
  // The fourth since 2026-10-08; its own containment tests, the vault and
  // Coder included, are in labs/coder-automation.test.js.
  const HANDLERS = ['claimLabJob', 'heartbeatAgent', 'completeLabJob', 'reportCoderAutomation'];

  it('is exactly these four', () => {
    expect(Object.keys(make(allowGuard(), emptyStore())).sort()).toEqual([...HANDLERS].sort());
  });

  it.each(HANDLERS)(
    '%s makes zero store calls when the guard denies',
    async (name) => {
      const store = emptyStore();
      const h = make(denyGuard(), store);
      const res = await h[name](
        req({ agentId: 'vps-1', jobId: 'j1', status: 'succeeded' }),
        context
      );

      expect(res.status).toBe(403);
      for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
    }
  );

  it.each(HANDLERS)(
    '%s rejects a malformed body before authenticating',
    async (name) => {
      const guard = allowGuard();
      const h = make(guard, emptyStore());
      const res = await h[name](
        {
          json: async () => {
            throw new Error('not json');
          },
        },
        context
      );

      expect(res.status).toBe(400);
      expect(guard.requireAgent).not.toHaveBeenCalled();
    }
  );
});

describe('claimLabJob', () => {
  const job = (over = {}) => ({
    id: 'j1',
    type: 'shell-echo',
    payload: 'hello',
    status: 'queued',
    createdAt: '2026-08-10T03:00:00.000Z',
    _etag: '"abc"',
    ...over,
  });

  it('claims the oldest matching job and returns only what the agent needs', async () => {
    const store = emptyStore();
    store.queryDocs = vi.fn(async () => [
      job({ id: 'newer', createdAt: '2026-08-10T03:30:00.000Z' }),
      job({ id: 'older', createdAt: '2026-08-10T03:00:00.000Z' }),
    ]);
    const h = make(allowGuard(), store);
    const res = await h.claimLabJob(req({ agentId: 'vps-1' }), context);

    const body = parse(res);
    expect(body.job.id).toBe('older');
    // Not the whole document: no _etag, no internal status, no agentId.
    expect(Object.keys(body.job).sort()).toEqual(['id', 'payload', 'payloadEncoding', 'type']);
    // A document from before #675 carries no encoding and is text.
    expect(body.job.payloadEncoding).toBe('text');
    // FIFO in the query too, so TOP 20 is the twenty oldest candidates and
    // not an arbitrary twenty sorted afterwards (ADR 0033).
    expect(store.queryDocs.mock.calls[0][1]).toMatch(/ORDER BY c\.createdAt ASC/);
  });

  it('passes a tar payload encoding through to the agent, and nothing else', async () => {
    const store = emptyStore();
    store.queryDocs = vi.fn(async () => [
      job({ id: 'chart', payloadEncoding: 'tar', payload: 'AAAA' }),
    ]);
    const h = make(allowGuard(), store);
    const body = parse(await h.claimLabJob(req({ agentId: 'vps-1' }), context));
    expect(body.job.payloadEncoding).toBe('tar');

    store.queryDocs = vi.fn(async () => [job({ id: 'odd', payloadEncoding: 'zip' })]);
    const odd = parse(
      await make(allowGuard(), store).claimLabJob(req({ agentId: 'vps-1' }), context)
    );
    expect(odd.job.payloadEncoding).toBe('text');
  });

  it('scopes the query to the registry capabilities, not the request', async () => {
    // An agent that names its own capabilities can claim any job type, which
    // makes the enqueue-side LAB_JOB_TYPES allowlist decorative.
    const store = emptyStore();
    const h = make(allowGuard({ capabilities: ['shell-echo'] }), store);
    await h.claimLabJob(req({ agentId: 'vps-1', capabilities: ['terraform-validate'] }), context);

    const params = store.queryDocs.mock.calls[0][2];
    const types = params.find((p) => p.name === '@types');
    expect(types.value).toEqual(['shell-echo']);
  });

  it('returns no job, and touches nothing, for an agent with no capabilities', async () => {
    const store = emptyStore();
    const h = make(allowGuard({ capabilities: [] }), store);
    const res = await h.claimLabJob(req({ agentId: 'vps-1' }), context);

    expect(parse(res).job).toBeNull();
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('moves to the next candidate when it loses the claim race', async () => {
    const store = emptyStore();
    store.queryDocs = vi.fn(async () => [job({ id: 'contended' }), job({ id: 'free' })]);
    store.replaceDocIfMatch = vi.fn(async (container, doc) => {
      if (doc.id === 'contended') throw Object.assign(new Error('conflict'), { code: 412 });
      return doc;
    });
    const h = make(allowGuard(), store);
    const res = await h.claimLabJob(req({ agentId: 'vps-1' }), context);

    expect(parse(res).job.id).toBe('free');
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
  });

  it('500s on a write failure that is not a lost race', async () => {
    const store = emptyStore();
    store.queryDocs = vi.fn(async () => [job()]);
    store.replaceDocIfMatch = vi.fn(async () => {
      throw Object.assign(new Error('throttled'), { code: 429 });
    });
    const h = make(allowGuard(), store);
    const res = await h.claimLabJob(req({ agentId: 'vps-1' }), context);

    expect(res.status).toBe(500);
  });

  it('offers stale claimed jobs so a dead agent does not strand work', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    await h.claimLabJob(req({ agentId: 'vps-1' }), context);

    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain("c.status = 'claimed'");
    const stale = params.find((p) => p.name === '@staleBefore');
    expect(new Date(stale.value).getTime()).toBeLessThan(NOW.getTime());
  });

  it('reports no work rather than failing when nothing matches', async () => {
    const h = make(allowGuard(), emptyStore());
    const res = await h.claimLabJob(req({ agentId: 'vps-1' }), context);

    expect(res.status).toBe(200);
    expect(parse(res).job).toBeNull();
  });
});

describe('heartbeatAgent', () => {
  it('writes lastSeenAt, the field the Labs snapshot actually reads', async () => {
    // The stub agent wrote lastPing while labs.js reads lastSeenAt, so the
    // connected indicator could never be true (T-401).
    const store = emptyStore();
    const h = make(allowGuard(), store);
    await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'idle' }), context);

    const [container, id, updates] = store.patchDoc.mock.calls[0];
    expect(container).toBe('lab_agents');
    expect(id).toBe('vps-1');
    expect(updates.lastSeenAt).toBe(NOW.toISOString());
    expect(updates).not.toHaveProperty('lastPing');
  });

  it('never sends undefined values, which patchDoc would treat as deletions', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    await h.heartbeatAgent(req({ agentId: 'vps-1' }), context);

    const updates = store.patchDoc.mock.calls[0][2];
    expect(Object.values(updates).every((v) => v !== undefined)).toBe(true);
    expect(updates).not.toHaveProperty('hostname');
  });

  it('marks a self-announced shutdown offline at once and tells nobody yet (#1009)', async () => {
    // `systemctl stop` → SIGTERM → the agent heartbeats `offline` itself. Until
    // 2026-10-08 that sent a critical message on the spot, and a 43-second
    // reboot left the owner with a red alert and no word it was over. The
    // health timer now speaks after five minutes offline.
    const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
    const store = emptyStore();
    const warn = vi.fn();
    const h = createLabAgentHandlers({
      guard: allowGuard({ status: 'idle', hostname: 'vps-hostinger-01' }),
      store,
      now: () => NOW,
      notifier,
    });
    const res = await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'offline' }), { ...context, warn });
    expect(res.status).toBe(200);
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({
      status: 'offline',
      offlineSince: NOW.toISOString(),
    });
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/an agent reported its own shutdown and is marked offline/));
    // Content-free: the ingested line never carries the document id.
    for (const [line] of warn.mock.calls) expect(line).not.toContain('vps-1');

    // Already offline: a repeated offline heartbeat is not a new outage.
    const s1 = emptyStore();
    await createLabAgentHandlers({ guard: allowGuard({ status: 'offline' }), store: s1, now: () => NOW, notifier })
      .heartbeatAgent(req({ agentId: 'vps-1', status: 'offline' }), context);
    expect(s1.patchDoc.mock.calls[0][2]).not.toHaveProperty('offlineSince');

    // `stopping` and `idle` are not offline: no offlineSince.
    for (const status of ['stopping', 'idle']) {
      const s2 = emptyStore();
      await createLabAgentHandlers({ guard: allowGuard({ status: 'idle' }), store: s2, now: () => NOW, notifier })
        .heartbeatAgent(req({ agentId: 'vps-1', status }), context);
      expect(s2.patchDoc.mock.calls[0][2]).not.toHaveProperty('offlineSince');
    }
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('lets a terminal offline win over the job-derived busy, so a deadline shutdown with work running is still recorded', async () => {
    const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
    const store = emptyStore();
    const h = createLabAgentHandlers({ guard: allowGuard({ status: 'busy' }), store, now: () => NOW, notifier });
    await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'offline', activeJobs: 2 }), context);
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({ status: 'offline', activeJobs: 2, offlineSince: NOW.toISOString() });

    // `stopping` while jobs drain stays `stopping`: as `busy` it read online
    // and held the public door open for work nobody would claim (#1018).
    const s1 = emptyStore();
    await createLabAgentHandlers({ guard: allowGuard({ status: 'busy' }), store: s1, now: () => NOW, notifier })
      .heartbeatAgent(req({ agentId: 'vps-1', status: 'stopping', activeJobs: 1 }), context);
    expect(s1.patchDoc.mock.calls[0][2]).toMatchObject({ status: 'stopping', activeJobs: 1 });

    const s2 = emptyStore();
    await createLabAgentHandlers({ guard: allowGuard({ status: 'idle' }), store: s2, now: () => NOW, notifier })
      .heartbeatAgent(req({ agentId: 'vps-1', status: 'idle', activeJobs: 1 }), context);
    expect(s2.patchDoc.mock.calls[0][2].status).toBe('busy');
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('says nothing when an agent comes back from an outage nobody was told about (a short reboot)', async () => {
    const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
    const store = emptyStore();
    const warn = vi.fn();
    const offlineSince = new Date(NOW.getTime() - 43_000).toISOString();
    await createLabAgentHandlers({ guard: allowGuard({ status: 'offline', offlineSince }), store, now: () => NOW, notifier })
      .heartbeatAgent(req({ agentId: 'vps-1', status: 'idle' }), { ...context, warn });
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    expect(store.patchDoc.mock.calls[0][2]).not.toHaveProperty('backOnlineAt');
    // The transition is still on the record, at a level host.json ingests.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/an agent is back online after 1 min$/));
    for (const [line] of warn.mock.calls) expect(line).not.toContain('vps-1');
  });

  it('sends one "back online after N min" on the first normal heartbeat after an outage the owner was told about, and clears the debt', async () => {
    const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
    const store = emptyStore();
    const offlineSince = new Date(NOW.getTime() - 12 * 60_000).toISOString();
    const h = createLabAgentHandlers({
      guard: allowGuard({
        status: 'offline',
        offlineSince,
        offlineNotifiedAt: new Date(NOW.getTime() - 7 * 60_000).toISOString(),
        hostname: 'vps-hostinger-01',
      }),
      store,
      now: () => NOW,
      notifier,
    });
    expect((await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'idle' }), context)).status).toBe(200);

    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({ status: 'idle', backOnlineAt: NOW.toISOString() });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const call = notifier.notifyTelegram.mock.calls[0][0];
    expect(call).toMatchObject({ title: 'Lab agent back online after 12 min', source: AGENT_ONLINE_SOURCE, severity: 'info' });
    expect(call.message).toContain('vps-1 (vps-hostinger-01)');
    expect(store.patchDoc.mock.calls[1]).toEqual(['lab_agents', 'vps-1', BACK_ONLINE_SENT, { partitionKey: 'vps-1' }]);
  });

  it('leaves the debt for the health timer when the back-online message does not go, and still records the heartbeat', async () => {
    const owed = { status: 'offline', offlineSince: '2026-08-10T03:40:00.000Z', offlineNotifiedAt: '2026-08-10T03:45:00.000Z' };
    const notifiers = [
      null,
      { notifyTelegram: vi.fn(async () => ({ sent: false, reason: 'cooldown' })) },
      { notifyTelegram: vi.fn(async () => { throw new Error('telegram down'); }) },
    ];
    for (const notifier of notifiers) {
      const store = emptyStore();
      const h = createLabAgentHandlers({ guard: allowGuard(owed), store, now: () => NOW, notifier });
      expect((await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'idle' }), context)).status).toBe(200);
      expect(store.patchDoc).toHaveBeenCalledTimes(1);
      expect(store.patchDoc.mock.calls[0][2]).toMatchObject({ status: 'idle', backOnlineAt: NOW.toISOString() });
      expect(store.patchDoc.mock.calls[0][2]).not.toHaveProperty('offlineNotifiedAt');
    }
  });

  it('keeps the start of an outage the owner is still owed the end of, and cancels the unsent back-online', async () => {
    const store = emptyStore();
    await createLabAgentHandlers({
      guard: allowGuard({
        status: 'idle',
        offlineSince: '2026-08-10T03:40:00.000Z',
        offlineNotifiedAt: '2026-08-10T03:45:00.000Z',
        backOnlineAt: '2026-08-10T03:55:00.000Z',
      }),
      store,
      now: () => NOW,
    }).heartbeatAgent(req({ agentId: 'vps-1', status: 'offline' }), context);
    const updates = store.patchDoc.mock.calls[0][2];
    expect(updates).toMatchObject({ status: 'offline', backOnlineAt: null });
    expect(updates).not.toHaveProperty('offlineSince');
  });

  it('refuses to let the agent grant itself capabilities or rebind its identity', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    await h.heartbeatAgent(
      req({
        agentId: 'vps-1',
        capabilities: ['terraform-validate'],
        oid: 'attacker',
        active: true,
      }),
      context
    );

    const updates = store.patchDoc.mock.calls[0][2];
    expect(updates).not.toHaveProperty('capabilities');
    expect(updates).not.toHaveProperty('oid');
    expect(updates).not.toHaveProperty('active');
  });

  it('derives busy from activeJobs rather than trusting the reported status', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'idle', activeJobs: 2 }), context);

    expect(store.patchDoc.mock.calls[0][2].status).toBe('busy');
  });

  it('falls back to idle for an unrecognised status', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    await h.heartbeatAgent(req({ agentId: 'vps-1', status: 'pwned' }), context);

    expect(store.patchDoc.mock.calls[0][2].status).toBe('idle');
  });
});

describe('heartbeatAgent: the applied commit (#1009)', () => {
  const APPLIED = {
    commit: '0123456789abcdef0123456789abcdef01234567',
    committedAt: '2026-08-09T22:02:14-05:00',
    appliedAt: '2026-08-10T03:31:07Z',
  };
  // Stored normalised to UTC, as every date the site keeps.
  const STORED = {
    commit: APPLIED.commit,
    committedAt: '2026-08-10T03:02:14.000Z',
    appliedAt: '2026-08-10T03:31:07.000Z',
  };

  it('stores the host’s applied commit on its registry document, as one field', async () => {
    const store = emptyStore();
    await make(allowGuard(), store).heartbeatAgent(req({ agentId: 'vps-1', applied: APPLIED }), context);
    const updates = store.patchDoc.mock.calls[0][2];
    expect(updates.applied).toEqual(STORED);
    expect(Object.keys(updates).filter((key) => key.startsWith('applied'))).toEqual(['applied']);
  });

  it('writes nothing for it when the stored record already says the same', async () => {
    const store = emptyStore();
    await make(allowGuard({ applied: STORED }), store).heartbeatAgent(
      req({ agentId: 'vps-1', applied: APPLIED }),
      context
    );
    expect(store.patchDoc.mock.calls[0][2]).not.toHaveProperty('applied');
  });

  it('keeps the stored record when a heartbeat carries none, or a malformed one', async () => {
    for (const applied of [
      undefined,
      null,
      'abc',
      { ...APPLIED, commit: 'abc' },
      { ...APPLIED, commit: APPLIED.commit.toUpperCase() },
      { ...APPLIED, appliedAt: '2026-08-10' },
      { ...APPLIED, committedAt: 'yesterday' },
    ]) {
      const store = emptyStore();
      await make(allowGuard({ applied: STORED }), store).heartbeatAgent(
        req({ agentId: 'vps-1', applied }),
        context
      );
      const updates = store.patchDoc.mock.calls[0][2];
      expect(updates, JSON.stringify(applied)).not.toHaveProperty('applied');
      expect(Object.values(updates).every((v) => v !== undefined)).toBe(true);
    }
  });

  it('refuses dates ahead of the site’s clock by more than the skew the Coder report allows', () => {
    // NOW is 04:00:00Z; ten minutes is the allowance.
    expect(parseAppliedRecord({ ...APPLIED, appliedAt: '2026-08-10T04:09:59Z' }, NOW.getTime())).not.toBeNull();
    expect(parseAppliedRecord({ ...APPLIED, appliedAt: '2026-08-10T04:10:01Z' }, NOW.getTime())).toBeNull();
    expect(parseAppliedRecord({ ...APPLIED, committedAt: '2099-01-01T00:00:00Z' }, NOW.getTime())).toBeNull();
  });

  it('takes only the three fields, whatever else the body carries', () => {
    expect(
      parseAppliedRecord({ ...APPLIED, capabilities: ['terraform-validate'], active: true }, NOW.getTime())
    ).toEqual(STORED);
  });
});

describe('completeLabJob', () => {
  const held = (over = {}) => ({ id: 'j1', status: 'claimed', agentId: 'vps-1', _etag: '"e1"', ...over });
  const written = (store, call = 0) => store.replaceDocIfMatch.mock.calls[call][1];
  const preconditionFailed = () => Object.assign(new Error('precondition failed'), { code: 412 });
  const complete = (h) =>
    h.completeLabJob(req({ agentId: 'vps-1', jobId: 'j1', status: 'succeeded', exitCode: 0 }), context);

  it('records a terminal result for a job the agent holds', async () => {
    const store = emptyStore();
    store.readDoc = vi.fn(async () => held());
    const h = make(allowGuard(), store);
    const res = await h.completeLabJob(
      req({ agentId: 'vps-1', jobId: 'j1', status: 'succeeded', exitCode: 0, output: 'done' }),
      context
    );

    expect(res.status).toBe(200);
    expect(store.patchDoc).not.toHaveBeenCalled();
    const [container, doc, options] = store.replaceDocIfMatch.mock.calls[0];
    expect(container).toBe('lab_jobs');
    expect(doc).toMatchObject({ id: 'j1', agentId: 'vps-1', status: 'succeeded', exitCode: 0, output: 'done' });
    expect(doc.finishedAt).toBe(NOW.toISOString());
    // The ETag of the read that found the job held fences the write (#1057).
    expect(doc._etag).toBe('"e1"');
    expect(options).toEqual({ partitionKey: 'j1' });
  });

  describe('when the job changes between the ownership read and the write (#1057)', () => {
    it.each([
      ['another agent claims it once the lease lapses', held({ agentId: 'vps-2', _etag: '"e2"' }), 403],
      ['an operator or the canary cancels it', held({ status: 'cancelled', _etag: '"e2"' }), 409],
      ['the canary withdraws it', null, 404],
    ])('refuses the stale result when %s, and leaves the job as it now is', async (_, now, status) => {
      const store = emptyStore();
      store.readDoc = vi.fn().mockResolvedValueOnce(held()).mockResolvedValueOnce(now);
      store.replaceDocIfMatch = vi.fn().mockRejectedValueOnce(preconditionFailed());
      const res = await complete(make(allowGuard(), store));

      expect(res.status).toBe(status);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
      expect(store.readDoc).toHaveBeenCalledTimes(2);
      expect(store.patchDoc).not.toHaveBeenCalled();
    });

    it('retries under the new ETag when the job is still this agent’s and claimed', async () => {
      const store = emptyStore();
      store.readDoc = vi.fn().mockResolvedValueOnce(held()).mockResolvedValueOnce(held({ _etag: '"e2"' }));
      store.replaceDocIfMatch = vi
        .fn()
        .mockRejectedValueOnce(preconditionFailed())
        .mockImplementationOnce(async (c, doc) => doc);
      const res = await complete(make(allowGuard(), store));

      expect(res.status).toBe(200);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
      expect(written(store, 1)).toMatchObject({ status: 'succeeded', _etag: '"e2"' });
    });

    it('gives up with a conflict when the job changes on every attempt', async () => {
      const store = emptyStore();
      store.readDoc = vi.fn(async () => held());
      store.replaceDocIfMatch = vi.fn(async () => {
        throw preconditionFailed();
      });
      const warn = vi.fn();
      const res = await make(allowGuard(), store).completeLabJob(
        req({ agentId: 'vps-1', jobId: 'j1', status: 'failed' }),
        { ...context, warn }
      );

      expect(res.status).toBe(409);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('answers 500, not a retry, when the write fails for another reason', async () => {
      const store = emptyStore();
      store.readDoc = vi.fn(async () => held());
      store.replaceDocIfMatch = vi.fn(async () => {
        throw Object.assign(new Error('service unavailable'), { code: 503 });
      });
      const res = await complete(make(allowGuard(), store));

      expect(res.status).toBe(500);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a job held by another agent', async () => {
    // Otherwise the results surface is an arbitrary write.
    const store = emptyStore();
    store.readDoc = vi.fn(async () => held({ agentId: 'vps-2' }));
    const h = make(allowGuard(), store);
    const res = await h.completeLabJob(
      req({ agentId: 'vps-1', jobId: 'j1', status: 'succeeded' }),
      context
    );

    expect(res.status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'queued', 'claimed', 'running', 'nonsense'])(
    'refuses the non-agent status %s',
    async (status) => {
      const store = emptyStore();
      const h = make(allowGuard(), store);
      const res = await h.completeLabJob(req({ agentId: 'vps-1', jobId: 'j1', status }), context);

      expect(res.status).toBe(400);
      expect(store.readDoc).not.toHaveBeenCalled();
    }
  );

  it('accepts exactly the three terminal statuses', () => {
    expect(AGENT_TERMINAL_STATUSES).toEqual(['succeeded', 'failed', 'timeout']);
  });

  it('will not reopen a cancelled job', async () => {
    const store = emptyStore();
    store.readDoc = vi.fn(async () => held({ status: 'cancelled' }));
    const h = make(allowGuard(), store);
    const res = await h.completeLabJob(
      req({ agentId: 'vps-1', jobId: 'j1', status: 'succeeded' }),
      context
    );

    expect(res.status).toBe(409);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('404s an unknown job', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    const res = await h.completeLabJob(
      req({ agentId: 'vps-1', jobId: 'ghost', status: 'failed' }),
      context
    );

    expect(res.status).toBe(404);
  });

  it('requires a jobId', async () => {
    const store = emptyStore();
    const h = make(allowGuard(), store);
    const res = await h.completeLabJob(req({ agentId: 'vps-1', status: 'failed' }), context);

    expect(res.status).toBe(400);
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('clamps output so a compromised agent cannot inflate storage', async () => {
    const store = emptyStore();
    store.readDoc = vi.fn(async () => held());
    const h = make(allowGuard(), store);
    await h.completeLabJob(
      req({
        agentId: 'vps-1',
        jobId: 'j1',
        status: 'failed',
        output: 'x'.repeat(OUTPUT_CAP_BYTES * 3),
      }),
      context
    );

    expect(written(store).output).toHaveLength(OUTPUT_CAP_BYTES);
  });

  it('defaults a non-integer exit code rather than storing it', async () => {
    const store = emptyStore();
    store.readDoc = vi.fn(async () => held());
    const h = make(allowGuard(), store);
    await h.completeLabJob(
      req({ agentId: 'vps-1', jobId: 'j1', status: 'failed', exitCode: 'boom' }),
      context
    );

    expect(written(store).exitCode).toBe(-1);
  });
});

/**
 * Ops-health snapshot + workflow-alert RPCs — pinned to source
 * buildOpsHealthSnapshot (:6470-6597) and updateWorkflowAlert (:5907-6037).
 * Load-bearing: the latest-digest lookup orders by DOC ID (the source's own
 * bug fix), reopen writes explicit nulls (not deletions), and resolve
 * requires a note and auto-acknowledges.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  OPS_HEALTH_CACHE_TTL_MS,
  WORKFLOW_ALERT_ACTIONS,
  alertUpdateRefusal,
  asksToRefresh,
  createOpsHealthHandlers,
  buildWorkflowAlertUpdates,
  getWorkflowAlertStatus,
  resetOpsHealthCache,
  toHoursSince,
} from './ops-health.js';

const context = { log: vi.fn(), error: vi.fn() };

// The snapshot cache is the module's (#946); no test inherits another's.
beforeEach(() => resetOpsHealthCache());

const allowGuard = (role = 'viewer') => ({
  requireRole: vi.fn(async () => ({
    user: { oid: 'u1', preferred_username: 'ops@hcw.dev' },
    role,
    error: null,
  })),
});
const denyGuard = {
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: '{}' },
  })),
};

const makeRequest = (body) => ({
  headers: { get: (k) => (k === 'user-agent' ? 'vitest' : null) },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

const NOW = new Date('2026-08-07T04:00:00.000Z');
const ENV = {
  RUNTIME_CONFIG_GENERATION: 'run-77-abc1234',
  RUNTIME_CONFIG_WRITER: 'azapi-strip',
  RESOLVED_KEY: 'a-real-value',
};
const fixed = { now: () => NOW, uuid: () => 'fixed-uuid', env: ENV };

function opsStore() {
  return {
    queryDocs: vi.fn(async (container, query, params) => {
      if (query.includes('VALUE COUNT')) {
        if (query.includes("'published'")) return [12];
        if (query.includes("'rss'")) return [3];
        return [2]; // queue breach
      }
      if (container === 'content' && query.includes('c["slug"]')) {
        return [{ id: 'p1', slug: 'has-slug' }, { id: 'p2' }]; // one missing slug
      }
      if (container === 'content' && query.includes('ARRAY_CONTAINS(@ids, c.id)')) {
        const ids = params?.[0]?.value || [];
        return ids.filter((id) => id === 'c-exists').map((id) => ({ id }));
      }
      if (container === 'content') {
        return [
          {
            id: 's1',
            contentStatus: 'approved',
            updatedAt: '2026-08-06T04:00:00Z',
          },
          {
            id: 's-live',
            contentStatus: 'published',
            Live: true,
            updatedAt: '2026-08-07T03:00:00Z',
          },
        ];
      }
      if (container === 'workflow_digests') {
        expect(query).toContain('ORDER BY c.id DESC');
        return [
          {
            id: '2026-08-06',
            publishingOps: { status: 'success', lastRunAt: 'run-ts' },
          },
        ];
      }
      if (container === 'workflow_alerts') {
        return [
          {
            id: 'a-open',
            alertType: 'scheduled_publish_failures',
            updatedAt: '2026-08-07T02:00:00Z',
          },
          {
            id: 'a-resolved',
            status: 'resolved',
            updatedAt: '2026-08-07T03:00:00Z',
          },
        ];
      }
      if (container === 'generated_content_images') {
        return [
          { id: 'img-ok', contentId: 'c-exists' },
          { id: 'img-orphan', contentId: 'c-gone' },
          { id: 'img-noid', contentId: '' },
        ];
      }
      if (container === 'jobs') {
        return [
          {
            id: 'job-f1',
            type: 'forgeArticle',
            status: 'failed',
            error: 'OpenAI 429 rate limit exceeded',
            createdAt: '2026-08-07T03:30:00Z',
            finishedAt: '2026-08-07T03:31:00Z',
          },
        ];
      }
      return [];
    }),
    readDoc: vi.fn(async (container, id) => {
      if (container === 'workflow_digests') return null;
      if (container === 'system') return { telegram: 'state' };
      if (container === 'content') return id === 'c-exists' ? { id } : null;
      if (container === 'admin_config' && id === 'forge_stats') {
        return {
          updatedAt: '2026-08-07T01:00:00.000Z',
          today: { date: '2026-08-07', forged: 3 },
        };
      }
      return null;
    }),
    upsertDoc: vi.fn(),
    patchDoc: vi.fn(),
  };
}

describe('helpers', () => {
  it('alertUpdateRefusal refuses the body before any read, in the handler order', () => {
    const body = (status, error) => ({ status, error });
    const refusal = (fields) => {
      const response = alertUpdateRefusal(fields);
      return response && body(response.status, JSON.parse(response.body).error);
    };
    expect(refusal({ alertId: '', action: 'resolve', normalizedResolutionNote: 'x' })).toEqual(
      body(400, 'alertId and action required')
    );
    expect(refusal({ alertId: 'a1', action: undefined, normalizedResolutionNote: '' })).toEqual(
      body(400, 'alertId and action required')
    );
    const invalid = alertUpdateRefusal({ alertId: 'a1', action: 'snooze' });
    expect(JSON.parse(invalid.body)).toEqual({
      error: 'Invalid action',
      validActions: ['acknowledge', 'resolve', 'reopen'],
    });
    expect(refusal({ alertId: 'a1', action: 'resolve', normalizedResolutionNote: '' })).toEqual(
      body(400, 'resolutionNote is required when resolving an alert')
    );
    // Nothing refuses: every accepted action with what it needs.
    for (const action of WORKFLOW_ALERT_ACTIONS) {
      expect(alertUpdateRefusal({ alertId: 'a1', action, normalizedResolutionNote: 'done' })).toBe(
        null
      );
    }
    expect(WORKFLOW_ALERT_ACTIONS).toEqual(['acknowledge', 'resolve', 'reopen']);
  });

  it('buildWorkflowAlertUpdates stamps every action and writes nothing else for an unknown one', () => {
    const base = { nowIso: '2026-01-01T00:00:00.000Z', actor: 'ops@example.test' };
    expect(buildWorkflowAlertUpdates({ ...base, action: 'unknown' })).toEqual({
      updatedAt: base.nowIso,
      updatedBy: base.actor,
    });
    expect(Object.keys(buildWorkflowAlertUpdates({ ...base, action: 'reopen' }))).toEqual([
      'updatedAt',
      'updatedBy',
      'active',
      'status',
      'resolvedAt',
      'resolvedBy',
      'resolutionNote',
      'activationNotifiedAt',
    ]);
  });

  it('getWorkflowAlertStatus falls back through status -> active flag -> open', () => {
    expect(getWorkflowAlertStatus({ status: 'acknowledged' })).toBe('acknowledged');
    expect(getWorkflowAlertStatus({ active: false })).toBe('resolved');
    expect(getWorkflowAlertStatus({})).toBe('open');
  });

  it('toHoursSince rounds to a tenth and rejects unparseable values', () => {
    const nowMs = NOW.getTime();
    expect(toHoursSince(new Date(nowMs - 90 * 60 * 1000), nowMs)).toBe(1.5);
    expect(toHoursSince('junk', nowMs)).toBeNull();
  });

  it('buildWorkflowAlertUpdates: resolve auto-acknowledges, reopen nulls out', () => {
    const resolve = buildWorkflowAlertUpdates({
      action: 'resolve',
      nowIso: 'T',
      actor: 'a',
      normalizedResolutionNote: 'done',
      alertData: {},
    });
    expect(resolve).toMatchObject({
      active: false,
      status: 'resolved',
      resolutionNote: 'done',
      acknowledgedAt: 'T', // was never acknowledged — resolve fills it
    });

    const alreadyAcked = buildWorkflowAlertUpdates({
      action: 'resolve',
      nowIso: 'T',
      actor: 'a',
      normalizedResolutionNote: 'done',
      alertData: { acknowledgedAt: 'earlier' },
    });
    expect(alreadyAcked).not.toHaveProperty('acknowledgedAt');

    const reopen = buildWorkflowAlertUpdates({
      action: 'reopen',
      nowIso: 'T',
      actor: 'a',
      normalizedResolutionNote: '',
      alertData: {},
    });
    // Explicit nulls — a deletion (undefined) would be a different write.
    expect(reopen.resolvedAt).toBeNull();
    expect(reopen.resolutionNote).toBeNull();
    expect(reopen.active).toBe(true);
  });
});

describe('getOpsHealthSnapshot', () => {

  it('assembles the full source response shape', async () => {
    const store = opsStore();
    const h = createOpsHealthHandlers({ guard: allowGuard(), store, ...fixed });
    const body = JSON.parse((await h.getOpsHealthSnapshot(makeRequest({}), context)).body);

    expect(body.readiness).toEqual({
      functionsConfigured: true,
      configGeneration: 'run-77-abc1234',
      configWriter: 'azapi-strip',
      unresolvedSecrets: [],
      publishedItems: 12,
      missingSlugCount: 1,
      rssSources: 3,
      lastCheckedAt: NOW.toISOString(),
    });
    // Every block says when it was read (ADR 0033 §1 Platform).
    expect(body.lastCheckedAt).toBe(NOW.toISOString());
    expect(body.operationalSignals.lastCheckedAt).toBe(NOW.toISOString());
    expect(body.digest.lastCheckedAt).toBe(NOW.toISOString());
    expect(body.storage).toEqual({
      generatedImages: 3,
      bounded: false,
      lastCheckedAt: NOW.toISOString(),
    });
    expect(body.forge).toEqual({
      updatedAt: '2026-08-07T01:00:00.000Z',
      todayDate: '2026-08-07',
      forgedToday: 3,
      lastCheckedAt: NOW.toISOString(),
    });
    // Today's digest missing -> latest-by-id fallback used.
    expect(body.digest.id).toBe('2026-08-06');
    expect(body.alerts.map((a) => a.id)).toEqual(['a-resolved', 'a-open']); // updatedAt desc
    expect(body.operationalSignals).toMatchObject({
      queueBreachCount: 2,
      publishFailureCount: 1, // the open scheduled_publish_failures alert
      orphanedGeneratedImages: 2, // c-gone + missing contentId
      failedJobs: [
        {
          id: 'job-f1',
          type: 'forgeArticle',
          status: 'failed',
          error: 'OpenAI 429 rate limit exceeded',
          createdAt: '2026-08-07T03:30:00Z',
          finishedAt: '2026-08-07T03:31:00Z',
        },
      ],
      lastSchedulerSuccessAt: 'run-ts',
    });
    expect(body.operationalSignals.oldestStagedHours).toBe(24); // staged Live item excluded
    expect(body.telegramNotifyState).toEqual({
      telegram: 'state',
      lastCheckedAt: NOW.toISOString(),
    });
  });

  it('derives readiness from the config stamp and the unresolved references, not a constant', async () => {
    // The literal `true` this replaced reported "Ready" on a worker that had
    // never received its configuration (ADR 0033 §1 Platform).
    const store = opsStore();
    const h = createOpsHealthHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
      env: {
        RUNTIME_CONFIG_GENERATION: 'run-78',
        RUNTIME_CONFIG_WRITER: 'azurerm',
        PUBLER_API_KEY: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/PUBLER-API-KEY)',
        RESEND_API_KEY: 'resolved',
      },
    });
    const body = JSON.parse((await h.getOpsHealthSnapshot(makeRequest({}), context)).body);
    expect(body.readiness.functionsConfigured).toBe(false);
    expect(body.readiness.unresolvedSecrets).toEqual(['PUBLER_API_KEY']);

    const unset = createOpsHealthHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
      env: {},
    });
    const unsetBody = JSON.parse((await unset.getOpsHealthSnapshot(makeRequest({}), context)).body);
    expect(unsetBody.readiness).toMatchObject({
      functionsConfigured: false,
      configGeneration: 'unset',
      configWriter: 'unset',
    });
  });

  it('denies without touching the store', async () => {
    const store = opsStore();
    const h = createOpsHealthHandlers({ guard: denyGuard, store, ...fixed });
    expect((await h.getOpsHealthSnapshot(makeRequest({}), context)).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});

describe('updateWorkflowAlert', () => {
  const alertStore = (alert = { id: 'a1', alertType: 'link_rot', active: true }) => ({
    queryDocs: vi.fn(),
    readDoc: vi.fn(async () => alert),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
  });

  it('validates action, requires a note to resolve, 404s missing alerts', async () => {
    const h = createOpsHealthHandlers({
      guard: allowGuard('publisher'),
      store: alertStore(),
      ...fixed,
    });
    expect((await h.updateWorkflowAlert(makeRequest({ alertId: 'a1' }), context)).status).toBe(400);
    expect(
      (await h.updateWorkflowAlert(makeRequest({ alertId: 'a1', action: 'nuke' }), context)).status
    ).toBe(400);
    expect(
      (await h.updateWorkflowAlert(makeRequest({ alertId: 'a1', action: 'resolve' }), context))
        .status
    ).toBe(400);

    const missing = createOpsHealthHandlers({
      guard: allowGuard('publisher'),
      store: { ...alertStore(), readDoc: vi.fn(async () => null) },
      ...fixed,
    });
    expect(
      (
        await missing.updateWorkflowAlert(
          makeRequest({ alertId: 'x', action: 'acknowledge' }),
          context
        )
      ).status
    ).toBe(404);
  });

  it('patches the alert and writes the audit row with the before/after diff', async () => {
    const store = alertStore();
    const h = createOpsHealthHandlers({
      guard: allowGuard('publisher'),
      store,
      ...fixed,
    });
    const res = await h.updateWorkflowAlert(
      makeRequest({
        alertId: 'a1',
        action: 'resolve',
        resolutionNote: 'fixed the feed',
      }),
      context
    );
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      alertId: 'a1',
      action: 'resolve',
    });

    const patch = store.patchDoc.mock.calls[0];
    expect(patch[0]).toBe('workflow_alerts');
    expect(patch[2]).toMatchObject({
      status: 'resolved',
      resolutionNote: 'fixed the feed',
    });

    const audit = store.upsertDoc.mock.calls.find(([c]) => c === 'audits')[1];
    expect(audit).toMatchObject({
      action: 'workflow_alert_resolve',
      resourceId: 'a1',
      resourceTitle: 'link_rot',
      changes: {
        before: { active: true, status: 'open' },
        notes: 'fixed the feed',
      },
      metadata: { alertType: 'link_rot' },
    });
  });

  it('sanitizes 500 error responses and attaches correlation ID (AP-B10)', async () => {
    const explodingStore = {
      ...opsStore(),
      queryDocs: vi.fn(async () => {
        throw new Error('Cosmos connection refused: 192.168.1.1');
      }),
    };
    const ctx = {
      invocationId: 'ops-inv-999',
      error: vi.fn(),
    };
    const h = createOpsHealthHandlers({
      guard: allowGuard('viewer'),
      store: explodingStore,
      ...fixed,
    });
    const res = await h.getOpsHealthSnapshot({ query: { get: () => null } }, ctx);
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Failed to generate operations health snapshot');
    expect(body.correlationId).toBe('ops-inv-999');
    expect(res.body).not.toContain('192.168.1.1');
    expect(ctx.error).toHaveBeenCalled();
  });
});

describe('the snapshot cache outlives the handler set that filled it (#946)', () => {
  // ops-health-http.js builds a handler set per request. The cache used to
  // live inside one, so a test that reused a single instance passed while
  // production ran the fan-out on every Health view. Every test here builds
  // a new handler set per call, as production does.
  const plain = () => ({ query: { get: () => null } });
  const refresh = () => ({ query: { get: (key) => (key === 'refresh' ? 'true' : null) } });

  /** A handler-set factory over one store, read off a clock the test moves. */
  const perRequest =
    ({ store, clock, env = ENV, guard = allowGuard('viewer') }) =>
    () =>
      createOpsHealthHandlers({
        guard,
        store,
        env,
        now: () => new Date(clock.ms),
        uuid: () => 'fixed-uuid',
      });

  /** How many queries one build runs, measured on a store of its own. */
  async function queriesPerBuild() {
    const store = opsStore();
    await perRequest({ store, clock: { ms: NOW.getTime() } })().getOpsHealthSnapshot(
      plain(),
      context
    );
    return store.queryDocs.mock.calls.length;
  }

  it('serves a second, separately built handler set from the cache', async () => {
    const store = opsStore();
    const clock = { ms: NOW.getTime() };
    const handlers = perRequest({ store, clock });

    const first = await handlers().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;
    expect(fanOut).toBeGreaterThan(0);

    clock.ms += 10_000;
    const second = await handlers().getOpsHealthSnapshot(plain(), context);
    expect(second.status).toBe(200);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut);
    expect(second.body).toBe(first.body);
  });

  it('expires at 30 s: served at 29.999 s, rebuilt at 30 s', async () => {
    const store = opsStore();
    const clock = { ms: NOW.getTime() };
    const handlers = perRequest({ store, clock });

    await handlers().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;

    clock.ms = NOW.getTime() + OPS_HEALTH_CACHE_TTL_MS - 1;
    const young = JSON.parse((await handlers().getOpsHealthSnapshot(plain(), context)).body);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut);
    expect(young.generatedAt).toBe(NOW.toISOString());

    clock.ms = NOW.getTime() + OPS_HEALTH_CACHE_TTL_MS;
    const expired = JSON.parse((await handlers().getOpsHealthSnapshot(plain(), context)).body);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
    expect(expired.generatedAt).toBe(new Date(clock.ms).toISOString());
    expect(OPS_HEALTH_CACHE_TTL_MS).toBe(30_000);
  });

  it('is not shared across stores or environments, which the snapshot is built from', async () => {
    const clock = { ms: NOW.getTime() };
    const storeA = opsStore();
    const storeB = opsStore();

    await perRequest({ store: storeA, clock })().getOpsHealthSnapshot(plain(), context);
    const fanOut = storeA.queryDocs.mock.calls.length;

    // Another store: its own build, never store A's snapshot.
    await perRequest({ store: storeB, clock })().getOpsHealthSnapshot(plain(), context);
    expect(storeB.queryDocs).toHaveBeenCalledTimes(fanOut);

    // Store A under another environment: readiness reads the environment, so
    // the cached snapshot would report the wrong configuration.
    const unset = JSON.parse(
      (await perRequest({ store: storeA, clock, env: {} })().getOpsHealthSnapshot(plain(), context))
        .body
    );
    expect(unset.readiness.configGeneration).toBe('unset');
    expect(storeA.queryDocs).toHaveBeenCalledTimes(fanOut * 2);

    // And store A under the first environment is still cached.
    const again = JSON.parse(
      (await perRequest({ store: storeA, clock })().getOpsHealthSnapshot(plain(), context)).body
    );
    expect(again.readiness.configGeneration).toBe('run-77-abc1234');
    expect(storeA.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
  });

  it('is one snapshot for every admitted role, and the guard still runs before it', async () => {
    const store = opsStore();
    const clock = { ms: NOW.getTime() };

    const viewer = await perRequest({ store, clock })().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;

    const publisher = await perRequest({ store, clock, guard: allowGuard('publisher') })()
      .getOpsHealthSnapshot(plain(), context);
    expect(publisher.body).toBe(viewer.body);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut);

    const refused = await perRequest({ store, clock, guard: denyGuard })().getOpsHealthSnapshot(
      plain(),
      context
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toBe('{}');
  });

  it('shares one build between views that arrive while it is in flight', async () => {
    const perBuild = await queriesPerBuild();
    const store = opsStore();
    const handlers = perRequest({ store, clock: { ms: NOW.getTime() } });

    const [a, b] = await Promise.all([
      handlers().getOpsHealthSnapshot(plain(), context),
      handlers().getOpsHealthSnapshot(plain(), context),
    ]);
    expect(a.status).toBe(200);
    expect(b.body).toBe(a.body);
    expect(store.queryDocs).toHaveBeenCalledTimes(perBuild);
  });

  it('drops a failed build rather than serving it to the next view', async () => {
    const store = opsStore();
    // Only the first query of the first build fails; every later one answers.
    store.queryDocs.mockImplementationOnce(async () => {
      throw new Error('transient');
    });
    const handlers = perRequest({ store, clock: { ms: NOW.getTime() } });

    const failed = await handlers().getOpsHealthSnapshot(plain(), { error: vi.fn() });
    expect(failed.status).toBe(500);

    const next = await handlers().getOpsHealthSnapshot(plain(), context);
    expect(next.status).toBe(200);
    expect(JSON.parse(next.body).readiness.publishedItems).toBe(12);
  });

  it('rebuilds on ?refresh=true and serves that build to the next view', async () => {
    const store = opsStore();
    const clock = { ms: NOW.getTime() };
    const handlers = perRequest({ store, clock });

    await handlers().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;

    clock.ms += 5_000;
    const refreshed = await handlers().getOpsHealthSnapshot(refresh(), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
    expect(JSON.parse(refreshed.body).generatedAt).toBe(new Date(clock.ms).toISOString());

    clock.ms += 5_000;
    const after = await handlers().getOpsHealthSnapshot(plain(), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
    expect(after.body).toBe(refreshed.body);
  });

  it('is invalidated by an alert update made through another handler set', async () => {
    const base = opsStore();
    const store = {
      ...base,
      readDoc: vi.fn(async (container, id, pk) =>
        container === 'workflow_alerts'
          ? { id, alertType: 'link_rot', active: true }
          : base.readDoc(container, id, pk)
      ),
    };
    const clock = { ms: NOW.getTime() };

    await perRequest({ store, clock })().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;

    const update = await perRequest({ store, clock, guard: allowGuard('publisher') })()
      .updateWorkflowAlert(makeRequest({ alertId: 'a1', action: 'acknowledge' }), context);
    expect(update.status).toBe(200);

    await perRequest({ store, clock })().getOpsHealthSnapshot(plain(), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
  });
});

describe('a refresh, a slow build and a failed audit, against the shared cache (review of #946)', () => {
  const plain = () => ({ query: { get: () => null } });
  /** What the Health page's refresh() sends after an action: the flag in the body. */
  const bodyRefresh = () => ({ query: { get: () => null }, json: async () => ({ refresh: true }) });
  /** Let every pending promise callback and timer at 0 ms run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const perRequest =
    ({ store, clock, guard = allowGuard('viewer') }) =>
    () =>
      createOpsHealthHandlers({
        guard,
        store,
        env: ENV,
        now: () => new Date(clock.ms),
        uuid: () => 'fixed-uuid',
      });

  /**
   * opsStore whose queries wait at a gate the test opens, and whose published
   * count is read when the query is ISSUED: a build that started before an
   * action reports what was stored before it, however late it answers.
   */
  function gatedStore() {
    const base = opsStore();
    const state = { published: 12 };
    let open;
    let gate = new Promise((resolve) => {
      open = resolve;
    });
    const store = {
      ...base,
      queryDocs: vi.fn(async (container, query, params) => {
        const published = state.published;
        await gate;
        if (query.includes('VALUE COUNT') && query.includes("'published'")) return [published];
        return base.queryDocs(container, query, params);
      }),
    };
    return {
      store,
      state,
      open: () => open(),
      close: () => {
        gate = new Promise((resolve) => {
          open = resolve;
        });
      },
    };
  }

  /** How many queries one build runs, measured on a store of its own. */
  async function queriesPerBuild() {
    const store = opsStore();
    await perRequest({ store, clock: { ms: NOW.getTime() } })().getOpsHealthSnapshot(
      plain(),
      context
    );
    return store.queryDocs.mock.calls.length;
  }

  const body = (response) => JSON.parse(response.body);

  it('asksToRefresh: the body flag or the query, strictly, and never a body it cannot parse', async () => {
    expect(await asksToRefresh(bodyRefresh())).toBe(true);
    expect(await asksToRefresh({ query: { get: (k) => (k === 'refresh' ? 'true' : null) } })).toBe(
      true
    );
    expect(await asksToRefresh({ query: { refresh: 'true' } })).toBe(true);
    expect(await asksToRefresh({ json: async () => ({ refresh: 'true' }) })).toBe(false);
    expect(await asksToRefresh({ json: async () => ({}) })).toBe(false);
    expect(
      await asksToRefresh({
        json: async () => {
          throw new SyntaxError('not JSON');
        },
      })
    ).toBe(false);
    expect(await asksToRefresh(plain())).toBe(false);
  });

  it('a refresh in the body rebuilds inside the 30 s, and the next plain view gets that build', async () => {
    const store = opsStore();
    const clock = { ms: NOW.getTime() };
    const handlers = perRequest({ store, clock });

    await handlers().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;

    clock.ms += 5_000;
    const refreshed = await handlers().getOpsHealthSnapshot(bodyRefresh(), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
    expect(body(refreshed).generatedAt).toBe(new Date(clock.ms).toISOString());

    const after = await handlers().getOpsHealthSnapshot(plain(), context);
    expect(after.body).toBe(refreshed.body);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
  });

  it('serves a build still running past 30 s instead of starting another fan-out', async () => {
    const gated = gatedStore();
    const clock = { ms: NOW.getTime() };
    const handlers = perRequest({ store: gated.store, clock });

    const first = handlers().getOpsHealthSnapshot(plain(), context);
    await settle();
    const issued = gated.store.queryDocs.mock.calls.length;
    expect(issued).toBeGreaterThan(0);

    // Cosmos is slow (429 retries): a view a minute later joins the build.
    clock.ms += 60_000;
    const second = handlers().getOpsHealthSnapshot(plain(), context);
    await settle();
    expect(gated.store.queryDocs).toHaveBeenCalledTimes(issued);

    gated.open();
    const [a, b] = await Promise.all([first, second]);
    expect(b.body).toBe(a.body);
  });

  it('counts the 30 s from when the build settled, not from when it started', async () => {
    const gated = gatedStore();
    const clock = { ms: NOW.getTime() };
    const handlers = perRequest({ store: gated.store, clock });

    const first = handlers().getOpsHealthSnapshot(plain(), context);
    await settle();
    clock.ms = NOW.getTime() + 20_000;
    gated.open();
    await first;
    const fanOut = gated.store.queryDocs.mock.calls.length;

    // 45 s after it started, 25 s after it settled: still served.
    clock.ms = NOW.getTime() + 45_000;
    await handlers().getOpsHealthSnapshot(plain(), context);
    expect(gated.store.queryDocs).toHaveBeenCalledTimes(fanOut);

    // 30 s after it settled: rebuilt.
    clock.ms = NOW.getTime() + 50_000;
    await handlers().getOpsHealthSnapshot(plain(), context);
    expect(gated.store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
  });

  it('never hands a refresh a build that started before it, so the action it follows is in the answer', async () => {
    const gated = gatedStore();
    const handlers = perRequest({ store: gated.store, clock: { ms: NOW.getTime() } });

    // The page's mount read starts a build, and it is still reading...
    const mountRead = handlers().getOpsHealthSnapshot(plain(), context);
    await settle();
    const issued = gated.store.queryDocs.mock.calls.length;

    // ...when an action changes what is stored, and the page asks to refresh.
    gated.state.published = 13;
    const refresh = handlers().getOpsHealthSnapshot(bodyRefresh(), context);
    await settle();
    // The refresh waits; it does not start a second fan-out beside the first.
    expect(gated.store.queryDocs).toHaveBeenCalledTimes(issued);

    gated.open();
    const [before, after] = await Promise.all([mountRead, refresh]);
    expect(body(before).readiness.publishedItems).toBe(12);
    expect(body(after).readiness.publishedItems).toBe(13);
  });

  it('refreshes that arrive while a build runs share one queued build between them', async () => {
    const perBuild = await queriesPerBuild();
    const gated = gatedStore();
    const handlers = perRequest({ store: gated.store, clock: { ms: NOW.getTime() } });

    const running = handlers().getOpsHealthSnapshot(plain(), context);
    await settle();
    gated.state.published = 13;
    const refreshes = [
      handlers().getOpsHealthSnapshot(bodyRefresh(), context),
      handlers().getOpsHealthSnapshot(bodyRefresh(), context),
      handlers().getOpsHealthSnapshot(bodyRefresh(), context),
    ];
    gated.open();
    const answers = await Promise.all([running, ...refreshes]);

    // The running build, then one queued build for all three refreshes.
    expect(gated.store.queryDocs).toHaveBeenCalledTimes(perBuild * 2);
    for (const answer of answers.slice(2)) expect(answer.body).toBe(answers[1].body);
    expect(body(answers[1]).readiness.publishedItems).toBe(13);
  });

  it('a refresh with nothing running starts its build at once', async () => {
    const gated = gatedStore();
    gated.open();
    const handlers = perRequest({ store: gated.store, clock: { ms: NOW.getTime() } });
    await handlers().getOpsHealthSnapshot(plain(), context);
    const fanOut = gated.store.queryDocs.mock.calls.length;

    gated.close();
    const refresh = handlers().getOpsHealthSnapshot(bodyRefresh(), context);
    await settle();
    expect(gated.store.queryDocs.mock.calls.length).toBeGreaterThan(fanOut);
    gated.open();
    expect((await refresh).status).toBe(200);
  });

  it('invalidates as soon as the alert is patched, even when the audit write after it fails', async () => {
    const base = opsStore();
    const store = {
      ...base,
      readDoc: vi.fn(async (container, id, pk) =>
        container === 'workflow_alerts'
          ? { id, alertType: 'link_rot', active: true }
          : base.readDoc(container, id, pk)
      ),
      upsertDoc: vi.fn(async (container) => {
        if (container === 'audits') throw new Error('audits throttled');
      }),
    };
    const clock = { ms: NOW.getTime() };

    await perRequest({ store, clock })().getOpsHealthSnapshot(plain(), context);
    const fanOut = store.queryDocs.mock.calls.length;

    const update = await perRequest({ store, clock, guard: allowGuard('publisher') })()
      .updateWorkflowAlert(makeRequest({ alertId: 'a1', action: 'resolve', resolutionNote: 'ok' }), {
        error: vi.fn(),
        warn: vi.fn(),
      });
    expect(update.status).toBe(500);
    expect(base.patchDoc).toHaveBeenCalledTimes(1);

    // The alert did change, so the next view must not be the cached snapshot.
    await perRequest({ store, clock })().getOpsHealthSnapshot(plain(), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(fanOut * 2);
  });
});


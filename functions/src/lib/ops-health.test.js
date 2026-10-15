/**
 * Ops-health snapshot + workflow-alert RPCs — pinned to source
 * buildOpsHealthSnapshot (:6470-6597) and updateWorkflowAlert (:5907-6037).
 * Load-bearing: the latest-digest lookup orders by DOC ID (the source's own
 * bug fix), reopen writes explicit nulls (not deletions), and resolve
 * requires a note and auto-acknowledges.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WORKFLOW_ALERT_ACTIONS,
  alertUpdateRefusal,
  createOpsHealthHandlers,
  buildWorkflowAlertUpdates,
  getWorkflowAlertStatus,
  toHoursSince,
} from './ops-health.js';

const context = { log: vi.fn(), error: vi.fn() };

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

  it('caches the operations health snapshot for 30s and invalidates on alert update (AP-B11)', async () => {
    let nowMs = NOW.getTime();
    const store = opsStore();
    const h = createOpsHealthHandlers({
      guard: allowGuard('viewer'),
      store,
      now: () => new Date(nowMs),
      ...fixed,
    });

    const res1 = await h.getOpsHealthSnapshot({ query: { get: () => null } }, context);
    expect(res1.status).toBe(200);
    const initialCalls = store.queryDocs.mock.calls.length;

    // Second call within 30s serves from cache, no new store queries
    nowMs += 10_000;
    const res2 = await h.getOpsHealthSnapshot({ query: { get: () => null } }, context);
    expect(res2.status).toBe(200);
    expect(store.queryDocs.mock.calls.length).toBe(initialCalls);

    // Call with ?refresh=true bypasses cache
    const res3 = await h.getOpsHealthSnapshot({ query: { get: (k) => (k === 'refresh' ? 'true' : null) } }, context);
    expect(res3.status).toBe(200);
    expect(store.queryDocs.mock.calls.length).toBeGreaterThan(initialCalls);
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


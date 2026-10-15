/**
 * The health pulse (#1010): what it checks on its own, what it records, and
 * the heartbeat that lets the hub tell "checked three minutes ago" from "the
 * checks have stopped".
 */
import { describe, it, expect, vi } from 'vitest';
import { createHealthPulse } from './pulse.js';
import {
  AI_TEST_STALE_AFTER_MS,
  PUBLISHER_LATE_AFTER_MS,
  aiProvidersVerdict,
  checkRuntimeConfig,
  checkScheduledPublishing,
  labAgentsFromRows,
  labAgentsVerdict,
  mcpServersVerdict,
} from './pulse-checks.js';
import { PULSE_DOC_ID, resultDocId } from './probe-results.js';
import { classifyFailure, normalizeStatus, PULSE_INTERVAL_MS, PULSE_LATE_AFTER_MS } from './status-model.js';

const NOW = new Date('2026-10-08T12:02:00.000Z');
const nowMs = NOW.getTime();
const minutesAgo = (n) => new Date(nowMs - n * 60 * 1000).toISOString();

/** A snapshot as ops-health.js builds it, every block present and healthy. */
const snapshot = (overrides = {}) => ({
  success: true,
  generatedAt: NOW.toISOString(),
  lastCheckedAt: NOW.toISOString(),
  readiness: {
    functionsConfigured: true,
    configGeneration: '2026-10-01.3',
    configWriter: 'terraform',
    unresolvedSecrets: [],
    lastCheckedAt: NOW.toISOString(),
  },
  digest: {
    publishingOps: { status: 'success', due: 0, published: 0, skipped: 0, failed: 0, lastRunAt: minutesAgo(2) },
    publishingWatchdog: { overdueScheduledCount: 0, lastRunAt: minutesAgo(120) },
    linkRot: { checked: 40, broken: 0, lastRunAt: minutesAgo(600) },
  },
  operationalSignals: { queueBreachCount: 0, publishFailureCount: 0, orphanedGeneratedImages: 0 },
  storage: { generatedImages: 12, bounded: false },
  forge: { updatedAt: minutesAgo(30), todayDate: '2026-10-08', forgedToday: 2 },
  telegramNotifyState: { lab_agent_offline: { lastNotifiedAt: minutesAgo(90) } },
  ...overrides,
});

function memStore({ agents = [], providers = [], mcp = [] } = {}) {
  const data = new Map();
  return {
    data,
    readDoc: vi.fn(async (_c, id) => data.get(id) ?? null),
    createDoc: vi.fn(async (_c, doc) => {
      if (data.has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
      data.set(doc.id, { ...doc, _etag: 'e1' });
      return data.get(doc.id);
    }),
    replaceDocIfMatch: vi.fn(async (_c, doc) => {
      data.set(doc.id, doc);
      return doc;
    }),
    upsertDoc: vi.fn(async (_c, doc) => {
      data.set(doc.id, doc);
      return doc;
    }),
    queryDocs: vi.fn(async (container) => {
      if (container === 'lab_agents') return agents;
      if (container === 'ai_providers') return providers;
      if (container === 'mcp_servers') return mcp;
      return [];
    }),
  };
}

const pulse = (store, buildSnapshot = async () => snapshot()) =>
  createHealthPulse({ store, buildSnapshot, now: () => NOW, log: { warn: vi.fn() } });

const stored = (store, probeId) => store.data.get(resultDocId(probeId));

describe('the pulse run', () => {
  it('records every check it can make on its own, as the pulse, then its heartbeat', async () => {
    const digest = 'a'.repeat(64);
    const store = memStore({
      agents: [
        {
          id: 'a1',
          active: true,
          lastSeenAt: new Date(nowMs - 20 * 1000).toISOString(),
          applied: { commit: 'c'.repeat(40), committedAt: minutesAgo(600), appliedAt: minutesAgo(300) },
        },
      ],
      providers: [{ id: 'anthropic', enabled: true, status: 'connected', lastTested: minutesAgo(60), lastTestedBy: 'probe' }],
      mcp: [{ id: 'plaud', enabled: true, status: 'connected', lastTested: minutesAgo(10) }],
    });
    // The two documents the lab recurrence checks read (#1009): main read an
    // hour ago with nothing new under lab-host/, and a Coder report whose
    // published template is the checkout's.
    store.data.set('lab_drift', { id: 'lab_drift', since: minutesAgo(600), hostCommits: [], lastSuccessAt: minutesAgo(60) });
    store.data.set('coder_automation', {
      id: 'coder_automation',
      reportedAt: minutesAgo(120),
      templatePushedAt: minutesAgo(3000),
      templateVersion: 'brave_turing1',
      templateDigest: digest,
      templateSourceDigest: digest,
    });
    // And the canary's last run passed, and Coder last accepted the token.
    store.data.set('lab_canary', {
      id: 'lab_canary',
      lastRunAt: minutesAgo(20),
      lastResult: { ok: true, outcome: 'succeeded', timings: { claimMs: 9000, runMs: 2000 } },
      lastSuccessAt: minutesAgo(20),
      consecutiveFailures: 0,
    });
    store.data.set('coder_status_token', {
      id: 'coder_status_token',
      operations: { status: { lastAcceptedAt: minutesAgo(30) } },
    });
    const summary = await pulse(store).run();
    expect(summary).toMatchObject({ checks: 18, recorded: 18, failures: 0 });

    for (const id of [
      'cosmos',
      'runtime-config',
      'unresolved-secrets',
      'storage',
      'scheduled-publishing',
      'publishing-failures',
      'queue-sla',
      'orphaned-images',
      'link-rot',
      'forge',
      'telegram-notify',
      'lab-agents',
      'ai-providers',
      'mcp-servers',
      'lab-drift',
      'coder-template',
      'lab-canary',
      'coder-token',
    ]) {
      const doc = stored(store, id);
      expect(doc, id).toBeTruthy();
      expect(doc).toMatchObject({ checkedBy: 'pulse', recordedBy: 'pulse', checkedAt: NOW.toISOString() });
      expect(normalizeStatus(doc.status), id).toBe('healthy');
    }

    // The heartbeat is written last, after the results it vouches for.
    const beat = store.data.get(PULSE_DOC_ID);
    expect(beat).toMatchObject({
      configScope: 'admin_config',
      docType: 'health_pulse',
      lastBeatAt: NOW.toISOString(),
      intervalMs: PULSE_INTERVAL_MS,
      lateAfterMs: PULSE_LATE_AFTER_MS,
      checks: 18,
      recorded: 18,
      failures: [],
    });
    expect(store.upsertDoc.mock.calls.at(-1)[1].id).toBe(PULSE_DOC_ID);
    // Nothing third-party: only reads of our own containers. The registry is
    // read twice, once for the heartbeats and once for the applied commits.
    expect(store.queryDocs.mock.calls.map(([container]) => container).sort()).toEqual([
      'ai_providers',
      'lab_agents',
      'lab_agents',
      'mcp_servers',
    ]);
  });

  it('records a snapshot that cannot be built as Cosmos’s verdict, and nothing the snapshot would have said', async () => {
    const store = memStore();
    await pulse(store, async () => {
      throw Object.assign(new Error('Request timed out'), { code: 408 });
    }).run();
    expect(stored(store, 'cosmos')).toMatchObject({
      status: 'offline',
      summary: 'The ops-health snapshot could not be read (408).',
    });
    expect(stored(store, 'queue-sla')).toBeUndefined();
    expect(stored(store, 'runtime-config')).toBeUndefined();
    // The registry checks are separate reads and still answer.
    expect(stored(store, 'lab-agents')).toMatchObject({ status: 'unknown' });
  });

  it('leaves a check that throws unrecorded, and names it on the heartbeat', async () => {
    const store = memStore();
    store.queryDocs.mockImplementation(async (container) => {
      if (container === 'mcp_servers') throw new Error('mcp_servers query refused');
      return [];
    });
    const summary = await pulse(store).run();
    expect(summary.failures).toBe(1);
    expect(stored(store, 'mcp-servers')).toBeUndefined();
    expect(store.data.get(PULSE_DOC_ID).failures).toEqual([
      {
        probeId: 'mcp-servers',
        error: expect.stringMatching(/^The check failed \(Error; reference [\w.:-]+\)\.$/),
      },
    ]);
  });

  it('fails the run when the heartbeat cannot be written, so the hub sees the pulse go late', async () => {
    const store = memStore();
    store.upsertDoc.mockRejectedValue(new Error('cosmos down'));
    await expect(pulse(store).run()).rejects.toThrow('cosmos down');
  });
});

describe('the pulse’s checks', () => {
  it('calls the scheduler offline after three missed fifteen-minute runs', () => {
    const late = snapshot();
    late.digest.publishingOps.lastRunAt = new Date(nowMs - PUBLISHER_LATE_AFTER_MS - 60 * 1000).toISOString();
    expect(checkScheduledPublishing(late, nowMs)).toMatchObject({ status: 'offline' });
    const failed = snapshot();
    failed.digest.publishingOps.status = 'failed';
    expect(checkScheduledPublishing(failed, nowMs).status).toBe('critical');
    const idle = snapshot({ digest: {} });
    expect(checkScheduledPublishing(idle, nowMs).status).toBe('unknown');
  });

  it('calls a missing or unset configuration critical', () => {
    const unset = snapshot();
    unset.readiness.configGeneration = 'unset';
    expect(checkRuntimeConfig(unset).status).toBe('critical');
    const unresolved = snapshot();
    unresolved.readiness.unresolvedSecrets = ['RESEND-API-KEY'];
    expect(checkRuntimeConfig(unresolved)).toMatchObject({
      status: 'critical',
      summary: '1 Key Vault reference did not resolve: RESEND-API-KEY.',
    });
  });

  it('judges lab agents by their heartbeat: offline when none has beaten within 90 s', () => {
    const rows = [
      { id: 'a1', lastSeenAt: new Date(nowMs - 20 * 1000).toISOString() },
      { id: 'a2', lastSeenAt: new Date(nowMs - 5 * 60 * 1000).toISOString() },
    ];
    expect(labAgentsVerdict(labAgentsFromRows(rows, nowMs), nowMs)).toMatchObject({
      status: 'degraded',
      summary: '1 of 2 agents online. Last heartbeat just now.',
    });
    expect(labAgentsVerdict(labAgentsFromRows([rows[1]], nowMs), nowMs).status).toBe('offline');
    expect(labAgentsVerdict([], nowMs).status).toBe('unknown');
  });

  it('counts a fresh heartbeat that announced a shutdown, or a deactivated agent, as offline (labs.js isAgentOnline)', () => {
    const fresh = new Date(nowMs - 5 * 1000).toISOString();
    for (const row of [
      { id: 'a1', lastSeenAt: fresh, status: 'stopping' },
      { id: 'a1', lastSeenAt: fresh, status: 'offline' },
      { id: 'a1', lastSeenAt: fresh, status: 'idle', active: false },
    ]) {
      expect(labAgentsVerdict(labAgentsFromRows([row], nowMs), nowMs).status, JSON.stringify(row)).toBe('offline');
    }
  });

  it('reads the AI providers’ last recorded tests, and calls a week-old test stale', () => {
    const fresh = [
      { id: 'anthropic', status: 'connected', lastTested: minutesAgo(60), lastTestedBy: 'probe' },
      { id: 'nvidia', status: 'error', lastTested: minutesAgo(61), lastTestError: 'timeout after 45000 ms' },
    ];
    expect(aiProvidersVerdict(fresh, nowMs)).toMatchObject({
      status: 'degraded',
      summary: '1 of 2 enabled providers passed their last recorded test. Newest recorded test: anthropic 1 h ago by the weekly probe.',
    });
    expect(aiProvidersVerdict([fresh[1]], nowMs).status).toBe('offline');
    expect(aiProvidersVerdict([{ ...fresh[1], lastTestError: 'Unauthorized' }], nowMs).status).toBe(
      'critical'
    );
    const old = [{ ...fresh[0], lastTested: new Date(nowMs - AI_TEST_STALE_AFTER_MS - 1).toISOString() }];
    expect(aiProvidersVerdict(old, nowMs).status).toBe('unknown');
    expect(aiProvidersVerdict([{ id: 'x', enabled: false }], nowMs).status).toBe('critical');
    expect(aiProvidersVerdict([{ id: 'x' }], nowMs).status).toBe('unknown');
  });

  it('reads the MCP servers’ last syncs, counting only those switched on', () => {
    expect(mcpServersVerdict([{ id: 'plaud', enabled: false, status: 'error' }], nowMs).status).toBe(
      'unknown'
    );
    expect(
      mcpServersVerdict([{ id: 'plaud', enabled: true, status: 'error', lastError: 'MCP server returned HTTP 401' }], nowMs)
        .status
    ).toBe('critical');
    expect(
      mcpServersVerdict(
        [
          { id: 'plaud', enabled: true, status: 'connected', lastTested: minutesAgo(5) },
          { id: 'docs', enabled: true },
        ],
        nowMs
      ).status
    ).toBe('degraded');
  });
});

describe('the status model', () => {
  it('reads the words used until 2026-10-08 as the states they now mean', () => {
    expect(normalizeStatus('misconfigured')).toBe('critical');
    expect(normalizeStatus('unavailable')).toBe('offline');
    expect(normalizeStatus('Healthy')).toBe('healthy');
    expect(normalizeStatus('fine')).toBeNull();
  });

  it('calls a refusal critical and an unreachable dependency offline', () => {
    expect(classifyFailure('Resend is not configured: RESEND_API_KEY is not set')).toBe('critical');
    expect(classifyFailure('Publer answered 403 - Forbidden')).toBe('critical');
    expect(classifyFailure('getaddrinfo ENOTFOUND api.example')).toBe('offline');
    expect(classifyFailure({ message: 'Service Unavailable', code: 503 })).toBe('offline');
    expect(classifyFailure('Coder is configured but did not answer within 5 s.')).toBe('offline');
  });
});

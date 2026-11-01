/**
 * One model, two copies, held to one opinion (#1010, #1011).
 *
 * The status model and its transition rules are written for the page in
 * lib/status.js. The server's health pulse needs the same rules to judge
 * what it records, and keeps a copy (functions/src/lib/health/). If the two
 * drifted, a card would flip between two verdicts every time the page and
 * the pulse took turns writing it — the "indicators update consistently"
 * requirement broken by the very feature that makes them update.
 *
 * So this file imports both and fails on any difference: the ids, the old
 * words, the windows, the critical-against-offline rule, the probe list and
 * kinds, and the verdict and sentence each check gives on the same data.
 * It is the frontend suite's because the frontend already reads backend
 * modules in tests (lib/aiEngine.test.js); the functions suite has no React.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({ getJSON: (...args) => getJSON(...args), postJSON: vi.fn() }));
vi.mock('@/lib/adminSettings', () => ({
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/lib/publicApi', () => ({ fetchCloudPricing: vi.fn() }));

import * as page from '@/lib/status';
import {
  PROBES,
  evaluateContentAgent,
  evaluateCosmos,
  evaluateForge,
  evaluateLinkRot,
  evaluateOrphanedImages,
  evaluatePublishingFailures,
  evaluateQueueSla,
  evaluateRuntimeConfig,
  evaluateScheduledPublishing,
  evaluateStorage,
  evaluateTelegramNotify,
  labAgentsVerdict,
  mcpServersVerdict,
  runUnresolvedSecrets,
} from './probeRegistry';
import { PUBLISHER_LATE_AFTER_MS } from './probeEvaluators';
import * as server from '../../../../../functions/src/lib/health/status-model.js';
import { HEALTH_PROBES } from '../../../../../functions/src/lib/health/probe-catalogue.js';
import * as pulse from '../../../../../functions/src/lib/health/pulse-checks.js';

const NOW = Date.parse('2026-10-08T12:02:00.000Z');
const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();

describe('the model', () => {
  it('has the same five ids and reads the same two old ones', () => {
    expect(Object.keys(page.SYSTEM_STATUS)).toEqual([...server.SYSTEM_STATUS_IDS]);
    expect(page.LEGACY_SYSTEM_IDS).toEqual(server.LEGACY_SYSTEM_IDS);
    for (const word of [...server.SYSTEM_STATUS_IDS, 'misconfigured', 'unavailable']) {
      expect(page.toSystemStatus(word).id, word).toBe(server.normalizeStatus(word));
    }
  });

  it('has the same windows and the same heartbeat rule', () => {
    expect(page.FRESHNESS_MS).toEqual(server.FRESHNESS_MS);
    expect(page.PULSE_INTERVAL_MS).toBe(server.PULSE_INTERVAL_MS);
    expect(page.MISSED_BEATS).toBe(server.MISSED_BEATS);
    expect(page.PULSE_LATE_AFTER_MS).toBe(server.PULSE_LATE_AFTER_MS);
    expect(PUBLISHER_LATE_AFTER_MS).toBe(pulse.PUBLISHER_LATE_AFTER_MS);
  });

  it('calls the same failures critical and the same ones offline', () => {
    const corpus = [
      'Resend is not configured: RESEND_API_KEY is not set',
      'CODER_URL is not set',
      'No AI provider is configured',
      'Publer answered 403 - Forbidden',
      'Unauthorized',
      'getOpsHealthSnapshot failed with HTTP 500. Try again or check the logs.',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
      'getLabJob timed out after 20s',
      'timeout after 45000 ms',
      'Coder is configured but did not answer within 5 s.',
      'Publer could not be reached',
      'getaddrinfo ENOTFOUND api.example',
      'connect ECONNREFUSED 10.0.0.1:443',
      'Snapshot refused: HTTP 503',
      'HTTP 504 from the gateway',
      { message: 'Bad gateway', status: 502 },
      { message: 'Not found', status: 404 },
      '',
      null,
    ];
    for (const failure of corpus) {
      expect(page.classifyFailure(failure), JSON.stringify(failure)).toBe(
        server.classifyFailure(failure)
      );
    }
  });
});

describe('the probe list', () => {
  it('names every registry probe in the server’s catalogue, with the same kind, and nothing else', () => {
    expect(PROBES.map((probe) => probe.id).sort()).toEqual(Object.keys(HEALTH_PROBES).sort());
    for (const probe of PROBES) {
      expect(HEALTH_PROBES[probe.id].kind, probe.id).toBe(probe.kind);
    }
  });

  it('lets anyone who can read the hub record a check every admin can run', () => {
    // Snapshot reads and the session's own identity are viewer work.
    for (const probe of PROBES.filter((p) => p.kind === 'snapshot')) {
      expect(HEALTH_PROBES[probe.id].writeRole, probe.id).toBe('viewer');
    }
    expect(HEALTH_PROBES['identity-token'].writeRole).toBe('viewer');
    expect(HEALTH_PROBES['rss-fetch'].writeRole).toBe('editor');
  });
});

/** A snapshot as ops-health.js builds it. */
const snapshot = (overrides = {}) => ({
  lastCheckedAt: minutesAgo(0),
  readiness: {
    functionsConfigured: true,
    configGeneration: 'run-77',
    configWriter: 'azapi-strip',
    unresolvedSecrets: [],
    lastCheckedAt: minutesAgo(0),
  },
  agent: {
    id: 'koda',
    label: 'Koda',
    key: {
      present: true,
      active: true,
      lastUsedAt: minutesAgo(40),
      rotatedAt: null,
      revokedAt: null,
      createdAt: null,
      unavailable: false,
    },
    sectionsOff: [{ id: 'admin.brain', label: 'Second Brain' }],
    denials: {
      since: minutesAgo(1440),
      total: 2,
      byReason: [{ reason: 'wrong-key', count: 2 }],
      lastAt: minutesAgo(5),
      bounded: false,
      unavailable: false,
    },
    lastCheckedAt: minutesAgo(0),
  },
  digest: {
    lastCheckedAt: minutesAgo(0),
    publishingOps: {
      status: 'success',
      due: 2,
      published: 2,
      skipped: 0,
      failed: 0,
      lastRunAt: minutesAgo(7),
    },
    publishingWatchdog: { overdueScheduledCount: 0, lastRunAt: minutesAgo(100) },
    linkRot: { checked: 40, broken: 0, lastRunAt: minutesAgo(3000) },
  },
  operationalSignals: {
    queueBreachCount: 0,
    oldestStagedHours: 3,
    publishFailureCount: 0,
    orphanedGeneratedImages: 0,
    lastCheckedAt: minutesAgo(0),
  },
  storage: { generatedImages: 12, bounded: false, lastCheckedAt: minutesAgo(0) },
  forge: { updatedAt: minutesAgo(90), todayDate: '2026-10-08', forgedToday: 2 },
  telegramNotifyState: {
    id: 'notify_state',
    lastCheckedAt: minutesAgo(0),
    forge_ready: { lastNotifiedAt: minutesAgo(30) },
    lab_agent_offline: { lastNotifiedAt: minutesAgo(400) },
  },
  ...overrides,
});

const withDigest = (digest) => snapshot({ digest: { ...snapshot().digest, ...digest } });

const SNAPSHOTS = {
  'everything healthy': snapshot(),
  'unresolved Key Vault references': snapshot({
    readiness: {
      ...snapshot().readiness,
      functionsConfigured: false,
      unresolvedSecrets: ['A', 'B'],
    },
  }),
  'configuration stamp unset': snapshot({
    readiness: { ...snapshot().readiness, configGeneration: 'unset' },
  }),
  'scheduler degraded with overdue items': withDigest({
    publishingOps: { ...snapshot().digest.publishingOps, status: 'degraded', failed: 1 },
    publishingWatchdog: { overdueScheduledCount: 3 },
  }),
  'scheduler failed': withDigest({
    publishingOps: { ...snapshot().digest.publishingOps, status: 'failed' },
  }),
  'scheduler stopped': withDigest({
    publishingOps: { ...snapshot().digest.publishingOps, lastRunAt: minutesAgo(50) },
  }),
  'no scheduler run recorded': snapshot({
    digest: { publishingWatchdog: { overdueScheduledCount: 0 } },
  }),
  'no run but overdue': snapshot({ digest: { publishingWatchdog: { overdueScheduledCount: 2 } } }),
  'counts above zero': snapshot({
    operationalSignals: {
      queueBreachCount: 4,
      oldestStagedHours: 30,
      publishFailureCount: 2,
      orphanedGeneratedImages: 1,
    },
  }),
  'broken links': withDigest({
    linkRot: { checked: 40, broken: 2, sampleBroken: [{ url: 'https://x/y', status: 404 }] },
  }),
  'older snapshot without the newer blocks': snapshot({
    storage: undefined,
    forge: undefined,
    telegramNotifyState: undefined,
    operationalSignals: undefined,
    agent: undefined,
    digest: null,
  }),
  'agent key revoked and still called': snapshot({
    agent: { ...snapshot().agent, key: { ...snapshot().agent.key, active: false } },
  }),
  'agent key revoked and quiet': snapshot({
    agent: {
      ...snapshot().agent,
      key: { ...snapshot().agent.key, active: false },
      denials: { ...snapshot().agent.denials, total: 0, byReason: [] },
    },
  }),
  'agent without a key': snapshot({
    agent: {
      ...snapshot().agent,
      key: { present: false, active: false, unavailable: false },
      sectionsOff: [],
    },
  }),
  'agent key record unread': snapshot({
    agent: { ...snapshot().agent, key: { present: false, active: false, unavailable: true } },
  }),
  'agent refusals uncounted': snapshot({
    agent: { ...snapshot().agent, denials: { ...snapshot().agent.denials, unavailable: true } },
  }),
  'agent refusals at the bound': snapshot({
    agent: {
      ...snapshot().agent,
      denials: { ...snapshot().agent.denials, total: 200, bounded: true },
    },
  }),
  'agent last use unparseable': snapshot({
    agent: { ...snapshot().agent, key: { ...snapshot().agent.key, lastUsedAt: 'not-a-date' } },
  }),
  'forge never ran, nothing notified': snapshot({
    forge: { updatedAt: null },
    telegramNotifyState: { id: 'notify_state' },
  }),
};

const PAIRS = {
  cosmos: [(ctx) => evaluateCosmos(ctx), () => pulse.checkCosmos()],
  'runtime-config': [evaluateRuntimeConfig, pulse.checkRuntimeConfig],
  storage: [evaluateStorage, pulse.checkStorage],
  'scheduled-publishing': [evaluateScheduledPublishing, pulse.checkScheduledPublishing],
  'publishing-failures': [evaluatePublishingFailures, pulse.checkPublishingFailures],
  'queue-sla': [evaluateQueueSla, pulse.checkQueueSla],
  'orphaned-images': [evaluateOrphanedImages, pulse.checkOrphanedImages],
  'link-rot': [evaluateLinkRot, pulse.checkLinkRot],
  forge: [evaluateForge, pulse.checkForge],
  'telegram-notify': [evaluateTelegramNotify, pulse.checkTelegramNotify],
  'content-agent': [evaluateContentAgent, pulse.checkContentAgent],
};

const verdict = (r) => ({ status: r.status, summary: r.summary, detail: r.detail ?? null });

describe('the page and the pulse judge the same snapshot the same way', () => {
  it('covers every snapshot check the pulse records', () => {
    expect(Object.keys(PAIRS).sort()).toEqual(
      Object.keys(pulse.SNAPSHOT_CHECKS)
        .filter((id) => id !== 'unresolved-secrets')
        .sort()
    );
  });

  for (const [name, snap] of Object.entries(SNAPSHOTS)) {
    it(`agrees on "${name}"`, () => {
      const ctx = { snapshot: snap, ops: { loaded: true, error: '' } };
      for (const [id, [onPage, onServer]] of Object.entries(PAIRS)) {
        expect(verdict(onPage(ctx, NOW)), `${id} on "${name}"`).toEqual(
          verdict(onServer(snap, NOW))
        );
      }
    });
  }
});

describe('the page and the pulse read registries the same way', () => {
  beforeEach(() => getJSON.mockReset());

  it('agrees on the unresolved Key Vault references', async () => {
    for (const names of [[], ['RESEND-API-KEY', 'PUBLER-API-KEY']]) {
      getJSON.mockResolvedValueOnce({ status: 'ok', unresolvedSecrets: names.length });
      const snap = snapshot({ readiness: { ...snapshot().readiness, unresolvedSecrets: names } });
      expect(verdict(await runUnresolvedSecrets({ snapshot: snap }))).toEqual(
        verdict(pulse.checkUnresolvedSecrets(snap))
      );
    }
  });

  it('agrees on the lab agents’ heartbeats', () => {
    const fleets = [
      [],
      [{ online: true, lastSeenAt: minutesAgo(0) }],
      [
        { online: true, lastSeenAt: minutesAgo(0) },
        { online: false, lastSeenAt: minutesAgo(30) },
      ],
      [{ online: false, lastSeenAt: minutesAgo(600) }],
    ];
    for (const agents of fleets) {
      expect(verdict(labAgentsVerdict(agents, NOW))).toEqual(
        verdict(pulse.labAgentsVerdict(agents, NOW))
      );
    }
  });

  it('agrees on the MCP servers’ last syncs', () => {
    const lists = [
      [],
      [{ id: 'plaud', enabled: false, status: 'connected' }],
      [{ id: 'plaud', enabled: true, status: 'connected', lastTested: minutesAgo(10) }],
      [{ id: 'plaud', enabled: true }],
      [{ id: 'plaud', enabled: true, status: 'error', lastError: 'HTTP 401 Unauthorized' }],
      [{ id: 'plaud', enabled: true, status: 'error', lastError: 'request timed out' }],
      [
        { id: 'plaud', enabled: true, status: 'connected', lastTested: minutesAgo(10) },
        {
          id: 'docs',
          enabled: true,
          status: 'error',
          lastError: 'nope',
          lastTested: minutesAgo(20),
        },
      ],
    ];
    for (const servers of lists) {
      expect(verdict(mcpServersVerdict(servers, NOW)), JSON.stringify(servers)).toEqual(
        verdict(pulse.mcpServersVerdict(servers, NOW))
      );
    }
  });
});

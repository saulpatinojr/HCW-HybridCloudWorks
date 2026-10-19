/**
 * The probe registry (ADR 0033 Platform): one entry per hub dependency, every
 * answer in the shared vocabulary, and the pure evaluators that read the
 * snapshot and the session. The page's use of it is in ../HealthPage.test.jsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getJSON = vi.fn();
const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: vi.fn(),
}));
vi.mock('@/lib/adminSettings', () => ({
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/lib/publicApi', () => ({ fetchCloudPricing: vi.fn() }));

import { SERVICES } from '@/components/admin/integrations/serviceRegistry';
import { SYSTEM_STATUS } from '@/lib/status';
import {
  HUBS,
  PROBES,
  PROBE_IDS,
  SERVICE_PROBE_IDS,
  classifyFailure,
  evaluateCosmos,
  evaluateLinkRot,
  evaluateRuntimeConfig,
  evaluateScheduledPublishing,
  evaluateTelegramNotify,
  probeReportLines,
  probesByHub,
  resolveProbe,
  runAiProviders,
  runLabAgents,
  runLabCheck,
  runMcpServers,
  mcpServersVerdict,
  runNewsletterBuild,
  runUnresolvedSecrets,
  safeProbes,
} from './probeRegistry';

const byId = (id) => PROBES.find((probe) => probe.id === id);

describe('the registry', () => {
  it('has unique ids, a hub that exists and the five facts on every entry', () => {
    expect(new Set(PROBE_IDS).size).toBe(PROBE_IDS.length);
    for (const probe of PROBES) {
      expect(Object.keys(HUBS), `${probe.id} hub`).toContain(probe.hub);
      for (const field of ['label', 'covers', 'impact', 'action']) {
        expect(probe[field], `${probe.id} has no ${field}`).toMatch(/\w/);
      }
      expect(probe.href?.to, `${probe.id} has no link`).toMatch(/^\/admin\//);
      expect(['live', 'snapshot', 'session']).toContain(probe.kind);
      if (probe.kind === 'live') expect(typeof probe.run).toBe('function');
      else expect(typeof probe.evaluate).toBe('function');
      expect(typeof probe.safe, `${probe.id} does not say whether Test all may run it`).toBe(
        'boolean'
      );
      if (!probe.safe) expect(probe.costNote, `${probe.id} is unsafe with no reason`).toMatch(/\w/);
    }
  });

  it('covers every hub and every testable Integrations service, by the same test function', () => {
    expect(probesByHub().map((group) => group.id)).toEqual(Object.keys(HUBS));
    // The four language models are one probe here — `ai-providers` asks every
    // ENABLED provider, which is the question Health has — so their cards'
    // tests are covered by it rather than by four more cards.
    const coveredByAiProviders = new Set(['gemini', 'anthropic', 'openai', 'nvidia']);
    const testable = SERVICES.filter((service) => service.test).map((service) => service.id);
    for (const id of testable) {
      if (coveredByAiProviders.has(id)) continue;
      expect(SERVICE_PROBE_IDS, `${id} has a service test but no probe`).toContain(id);
    }
    expect(byId('ai-providers')).toBeTruthy();
  });

  it('keeps the probes that write or spend out of Test all', () => {
    const unsafe = PROBES.filter((probe) => !probe.safe).map((probe) => probe.id);
    expect(unsafe.sort()).toEqual(
      ['rss-fetch', 'batch-inspect', 'reviewer-digest', 'labs-noop', 'youtube'].sort()
    );
    expect(safeProbes().map((probe) => probe.id)).not.toContain('youtube');
  });

  it('answers unknown, never a guess, for a live probe that has not run', () => {
    expect(resolveProbe(byId('publer'), {}, {})).toMatchObject({
      status: 'unknown',
      summary: 'Not tested yet.',
    });
    expect(
      resolveProbe(byId('publer'), {}, { publer: { status: 'healthy', summary: 'ok' } })
    ).toMatchObject({
      status: 'healthy',
    });
  });
});

describe('classifyFailure', () => {
  it('calls a missing key or a refusal critical, and a service that did not answer offline', () => {
    expect(classifyFailure('Resend is not configured: RESEND_API_KEY is not set')).toBe('critical');
    expect(classifyFailure('Publer answered 403 - Forbidden')).toBe('critical');
    expect(classifyFailure('Failed to fetch')).toBe('offline');
    expect(classifyFailure(Object.assign(new Error('Bad gateway'), { status: 502 }))).toBe(
      'offline'
    );
  });
});

describe('snapshot evaluators', () => {
  const snapshot = {
    lastCheckedAt: '2026-10-03T12:00:00.000Z',
    readiness: {
      functionsConfigured: true,
      configGeneration: 'run-77',
      configWriter: 'azapi-strip',
      unresolvedSecrets: [],
      lastCheckedAt: '2026-10-03T12:00:00.000Z',
    },
    digest: {
      lastCheckedAt: '2026-10-03T12:00:00.000Z',
      publishingOps: {
        status: 'success',
        due: 2,
        published: 2,
        skipped: 0,
        failed: 0,
        lastRunAt: '2026-10-03T11:00:00.000Z',
      },
      publishingWatchdog: { overdueScheduledCount: 0 },
      linkRot: {
        lastRunAt: '2026-10-01T06:00:00.000Z',
        checked: 40,
        broken: 2,
        sampleBroken: [{ url: 'https://x/y', status: 404 }],
      },
    },
    telegramNotifyState: {
      id: 'notify_state',
      lastCheckedAt: '2026-10-03T12:00:00.000Z',
      forge_ready: { lastNotifiedAt: '2026-10-03T10:00:00.000Z' },
    },
  };
  const ctx = { snapshot, ops: { loaded: true, error: '' } };

  it('reads the config stamp and the unresolved references, with the block’s own time', () => {
    expect(evaluateRuntimeConfig(ctx)).toMatchObject({
      status: 'healthy',
      checkedAt: '2026-10-03T12:00:00.000Z',
    });
    expect(
      evaluateRuntimeConfig({
        ...ctx,
        snapshot: {
          readiness: {
            ...snapshot.readiness,
            functionsConfigured: false,
            unresolvedSecrets: ['PUBLER_API_KEY'],
          },
        },
      })
    ).toMatchObject({
      status: 'critical',
      summary: expect.stringContaining('PUBLER_API_KEY'),
    });
    expect(
      evaluateRuntimeConfig({
        ...ctx,
        snapshot: { readiness: { ...snapshot.readiness, configGeneration: 'unset' } },
      })
    ).toMatchObject({ status: 'critical' });
  });

  it('judges the scheduler by its heartbeat, its status and the watchdog’s overdue count', () => {
    // Ten minutes after the last run: inside the three missed 15-minute runs.
    const now = Date.parse('2026-10-03T11:10:00.000Z');
    expect(evaluateScheduledPublishing(ctx, now).status).toBe('healthy');
    const degraded = {
      ...snapshot,
      digest: {
        ...snapshot.digest,
        publishingOps: { ...snapshot.digest.publishingOps, status: 'degraded' },
      },
    };
    expect(evaluateScheduledPublishing({ ...ctx, snapshot: degraded }, now).status).toBe(
      'degraded'
    );
    const failed = {
      ...snapshot,
      digest: {
        ...snapshot.digest,
        publishingOps: { ...snapshot.digest.publishingOps, status: 'failed' },
      },
    };
    expect(evaluateScheduledPublishing({ ...ctx, snapshot: failed }, now).status).toBe('critical');
    // Every run is recorded (#1010), so three missed runs mean it stopped.
    const late = Date.parse('2026-10-03T11:46:00.000Z');
    expect(evaluateScheduledPublishing(ctx, late)).toMatchObject({
      status: 'offline',
      summary: expect.stringContaining('missed its 15-minute runs'),
    });
    const idle = { ...snapshot, digest: { publishingWatchdog: { overdueScheduledCount: 0 } } };
    expect(evaluateScheduledPublishing({ ...ctx, snapshot: idle }, now)).toMatchObject({
      status: 'unknown',
      summary: expect.stringContaining('No scheduler run is recorded'),
    });
    const overdue = { ...snapshot, digest: { publishingWatchdog: { overdueScheduledCount: 3 } } };
    expect(evaluateScheduledPublishing({ ...ctx, snapshot: overdue }, now).status).toBe('degraded');
  });

  it('shows the two blocks that were returned and never rendered: link rot and Telegram notices', () => {
    expect(evaluateLinkRot(ctx)).toMatchObject({
      status: 'degraded',
      summary: '2 of 40 live links are broken.',
      detail: 'https://x/y (404)',
      checkedAt: '2026-10-01T06:00:00.000Z',
    });
    expect(evaluateTelegramNotify(ctx)).toMatchObject({
      status: 'healthy',
      summary: expect.stringContaining('forge_ready'),
    });
    expect(
      evaluateTelegramNotify({
        ...ctx,
        snapshot: { ...snapshot, telegramNotifyState: { lastCheckedAt: 'x' } },
      }).status
    ).toBe('unknown');
  });

  it('calls Cosmos offline when the snapshot did not answer, and has no result while it loads', () => {
    expect(evaluateCosmos(ctx).status).toBe('healthy');
    expect(
      evaluateCosmos({
        snapshot: null,
        ops: { loaded: false, error: 'Snapshot refused: HTTP 503' },
      })
    ).toMatchObject({
      status: 'offline',
      summary: expect.stringContaining('HTTP 503'),
    });
    expect(
      evaluateCosmos({ snapshot: null, ops: { loaded: false, error: 'Admin access required' } })
        .status
    ).toBe('critical');
    // Still loading is not evidence: no time, so a stored result shows instead.
    expect(evaluateCosmos({ snapshot: null, ops: { loaded: false, error: '' } })).toMatchObject({
      status: 'unknown',
      checkedAt: null,
    });
  });
});

describe('live runners', () => {
  beforeEach(() => {
    getJSON.mockReset();
    postJSON.mockReset();
  });

  it('tests every enabled AI provider through testAiProvider and shows the weekly probe’s last result', async () => {
    getJSON.mockResolvedValueOnce({
      items: [
        {
          id: 'gemini',
          enabled: true,
          lastTested: '2026-09-29T06:15:00.000Z',
          lastTestedBy: 'probe',
        },
        { id: 'openai', enabled: true },
        { id: 'nvidia', enabled: false },
      ],
    });
    postJSON.mockImplementation(async (name, body) =>
      body.providerId === 'gemini'
        ? { status: 'connected', latencyMs: 900 }
        : { status: 'error', error: 'timeout' }
    );
    const r = await runAiProviders();
    expect(r.status).toBe('degraded');
    expect(r.summary).toContain('1 of 2 enabled providers answered');
    expect(r.summary).toContain('the weekly probe');
    expect(r.detail).toContain('openai: timeout');
    expect(postJSON).toHaveBeenCalledTimes(2);
    expect(postJSON).not.toHaveBeenCalledWith('testAiProvider', { providerId: 'nvidia' });
  });

  it('calls no enabled provider critical and all answering healthy', async () => {
    getJSON.mockResolvedValueOnce({ items: [{ id: 'gemini', enabled: false }] });
    expect((await runAiProviders()).status).toBe('critical');
    getJSON.mockResolvedValueOnce({ items: [{ id: 'gemini', enabled: true }] });
    postJSON.mockResolvedValue({ status: 'connected', latencyMs: 500 });
    expect((await runAiProviders()).status).toBe('healthy');
  });

  it('judges lab agents by how many are online', async () => {
    postJSON.mockResolvedValueOnce({ agents: [] });
    expect((await runLabAgents()).status).toBe('unknown');
    postJSON.mockResolvedValueOnce({
      agents: [
        { agentId: 'a', online: true, lastSeenAt: '2026-10-03T11:59:00.000Z' },
        { agentId: 'b', online: false, lastSeenAt: '2026-10-01T00:00:00.000Z' },
      ],
    });
    expect(await runLabAgents()).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('1 of 2 agents online'),
    });
    expect(postJSON).toHaveBeenCalledWith('getLabsSnapshot', {});
  });

  it('judges the newsletter build by the newest issue’s age against the send day', async () => {
    const recent = new Date(Date.now() - 2 * 86400000).toISOString();
    getJSON.mockImplementation(async (route) =>
      route === 'cms/newsletters'
        ? { ok: true, issues: [{ createdAt: recent }] }
        : { value: { sendDay: 'tuesday' } }
    );
    expect(await runNewsletterBuild()).toMatchObject({
      status: 'healthy',
      summary: expect.stringContaining('tuesday'),
    });
    const stale = new Date(Date.now() - 20 * 86400000).toISOString();
    getJSON.mockImplementation(async (route) =>
      route === 'cms/newsletters' ? { ok: true, issues: [{ createdAt: stale }] } : { value: {} }
    );
    expect((await runNewsletterBuild()).status).toBe('degraded');
    getJSON.mockImplementation(async (route) =>
      route === 'cms/newsletters' ? { issues: [] } : {}
    );
    expect((await runNewsletterBuild()).status).toBe('unknown');
  });

  it('renders the unresolvedSecrets count from /api/health, naming the settings the snapshot knows', async () => {
    getJSON.mockResolvedValueOnce({ status: 'ok', unresolvedSecrets: 0 });
    expect((await runUnresolvedSecrets({})).status).toBe('healthy');
    getJSON.mockResolvedValueOnce({ status: 'ok', unresolvedSecrets: 2 });
    expect(
      await runUnresolvedSecrets({
        snapshot: { readiness: { unresolvedSecrets: ['A_KEY', 'B_KEY'] } },
      })
    ).toMatchObject({
      status: 'critical',
      summary: '2 Key Vault references did not resolve: A_KEY, B_KEY.',
    });
    expect(getJSON).toHaveBeenCalledWith('health');
  });
});

describe('the report section', () => {
  it('lists every probe under its hub with the shared word and the time', () => {
    const lines = probeReportLines(PROBES, (probe) =>
      probe.id === 'publer'
        ? { status: 'healthy', summary: 'Connected.', checkedAt: '2026-10-03T12:00:00.000Z' }
        : { status: 'unknown', summary: 'Not tested yet.', checkedAt: null }
    );
    expect(lines[0]).toBe('### Probe registry');
    expect(lines[2]).toBe('- Pulse: Unknown — it has never reported.');
    expect(lines).toContain('#### Amplify');
    expect(lines).toContain(
      '- Publer: Healthy (2026-10-03T12:00:00.000Z, by this session) — Connected.'
    );
    expect(lines).toContain(`- Cosmos DB: ${SYSTEM_STATUS.unknown.label} — Not tested yet.`);
    expect(lines.join('\n')).not.toMatch(/PASS|FAIL|UNKNOWN/);
  });
});

describe('stored results and staleness (#1011)', () => {
  const NOW = Date.parse('2026-10-08T12:00:00.000Z');
  const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();

  it('shows the newer of this tab’s result and the stored one, and never lets "not run" hide a result', () => {
    const stored = {
      publer: { status: 'critical', summary: 'Refused.', checkedAt: minutesAgo(30), stored: true },
    };
    // Nothing run here: the stored result shows, with its time.
    expect(resolveProbe(byId('publer'), {}, {}, stored, NOW)).toMatchObject({
      status: 'critical',
      summary: 'Refused.',
      checkedAt: minutesAgo(30),
    });
    // A newer run here wins.
    const live = { publer: { status: 'healthy', summary: 'Connected.', checkedAt: minutesAgo(1) } };
    expect(resolveProbe(byId('publer'), {}, live, stored, NOW).status).toBe('healthy');
    // A smoke test not run in this session says so with no time: the stored run shows.
    const smokeStored = {
      'rss-fetch': { status: 'healthy', summary: 'RSS fetch complete.', checkedAt: minutesAgo(60) },
    };
    expect(resolveProbe(byId('rss-fetch'), { smoke: {} }, {}, smokeStored, NOW)).toMatchObject({
      status: 'healthy',
      summary: 'RSS fetch complete.',
    });
  });

  it('shows a result past its window as Unknown, with its last value and time', () => {
    const stored = {
      cosmos: {
        status: 'healthy',
        summary: 'Cosmos DB answered the ten-query ops snapshot.',
        checkedAt: minutesAgo(40),
        checkedBy: 'pulse',
        stored: true,
      },
    };
    const loading = { snapshot: null, ops: { loaded: false, error: '' } };
    expect(resolveProbe(byId('cosmos'), loading, {}, stored, NOW)).toMatchObject({
      status: 'unknown',
      stale: true,
      lastStatus: 'healthy',
      checkedAt: minutesAgo(40),
      checkedBy: 'pulse',
    });
    // A live result keeps a day.
    const publer = { publer: { status: 'healthy', summary: 'ok', checkedAt: minutesAgo(23 * 60) } };
    expect(resolveProbe(byId('publer'), {}, {}, publer, NOW).stale).toBe(false);
    const older = { publer: { status: 'healthy', summary: 'ok', checkedAt: minutesAgo(25 * 60) } };
    expect(resolveProbe(byId('publer'), {}, {}, older, NOW).status).toBe('unknown');
  });

  it('gives the session-token checks the life of a token, not a day', () => {
    const stored = {
      'identity-token': {
        status: 'healthy',
        summary: 'every comparison holds',
        checkedAt: minutesAgo(100),
      },
    };
    expect(resolveProbe(byId('identity-token'), {}, {}, stored, NOW)).toMatchObject({
      status: 'unknown',
      stale: true,
    });
  });

  it('says in the report that a result is stale, who checked it, and how the pulse is', () => {
    const lines = probeReportLines(
      PROBES,
      (probe) =>
        probe.id === 'cosmos'
          ? {
              status: 'unknown',
              stale: true,
              lastStatus: 'healthy',
              windowMs: 15 * 60 * 1000,
              summary: 'Cosmos DB answered.',
              checkedAt: minutesAgo(40),
              checkedBy: 'pulse',
            }
          : { status: 'unknown', summary: 'Not tested yet.', checkedAt: null },
      { pulse: { lastBeatAt: minutesAgo(3), intervalMs: 300000 }, now: NOW }
    );
    expect(lines[2]).toBe(
      `- Pulse: Healthy — every 5 min, last beat ${minutesAgo(3)} (3 min ago).`
    );
    expect(lines).toContain(
      `- Cosmos DB: Unknown (stale: last Healthy, older than its 15 min window) (${minutesAgo(40)}, by the pulse) — Cosmos DB answered.`
    );
  });
});

describe('the heartbeat and sync runners', () => {
  beforeEach(() => {
    getJSON.mockReset();
    postJSON.mockReset();
  });

  it('repeats the labs snapshot’s verdict for a lab recurrence check, detail included (#1009)', async () => {
    postJSON.mockResolvedValueOnce({
      checks: {
        'lab-drift': {
          status: 'critical',
          summary:
            'vps-hostinger-01 is behind main: 2 changes under lab-host/ or vps-agent/ merged after 01234567, the oldest 2 d ago. Run bootstrap.sh on the lab host.',
          detail: 'bbbbbbbb 2026-10-08T00:00:00.000Z LAB-5',
        },
      },
    });
    expect(await runLabCheck('lab-drift')).toMatchObject({
      status: 'critical',
      summary: expect.stringContaining('is behind main'),
      detail: 'bbbbbbbb 2026-10-08T00:00:00.000Z LAB-5',
    });
    expect(postJSON).toHaveBeenCalledWith('getLabsSnapshot', {});
  });

  it('calls a lab check unknown on an API that does not send it, and a failed read by its kind', async () => {
    postJSON.mockResolvedValueOnce({ agents: [] });
    expect(await runLabCheck('coder-template')).toMatchObject({
      status: 'unknown',
      summary: expect.stringContaining('does not carry this check'),
    });
    postJSON.mockRejectedValueOnce(new Error('Failed to fetch'));
    expect(await runLabCheck('coder-template')).toMatchObject({ status: 'offline' });
  });

  it('registers every lab check as a live, Test-all-safe probe that reads the snapshot', async () => {
    for (const id of ['lab-drift', 'coder-template', 'lab-canary', 'coder-token', 'portainer']) {
      expect(byId(id), id).toMatchObject({ kind: 'live', safe: true, hub: 'enhanced' });
      // Test all may press it: its run reads the snapshot and writes nothing.
      postJSON.mockResolvedValueOnce({
        checks: { [id]: { status: 'healthy', summary: `${id} ok` } },
      });
      expect(await byId(id).run(), id).toMatchObject({ status: 'healthy', summary: `${id} ok` });
      expect(postJSON).toHaveBeenLastCalledWith('getLabsSnapshot', {});
    }
  });

  it('calls the lab offline when no agent has beaten within its window', async () => {
    postJSON.mockResolvedValueOnce({
      agents: [{ agentId: 'a', online: false, lastSeenAt: '2026-10-01T00:00:00.000Z' }],
    });
    expect(await runLabAgents()).toMatchObject({
      status: 'offline',
      summary: expect.stringContaining('All 1 agents are offline'),
    });
  });

  it('reads the MCP servers’ last syncs, counting only those switched on', async () => {
    getJSON.mockResolvedValueOnce({
      items: [
        { id: 'plaud', enabled: true, status: 'connected', lastTested: '2026-10-08T11:00:00.000Z' },
        { id: 'docs', enabled: true, status: 'error', lastError: 'MCP server returned HTTP 401' },
        { id: 'old', enabled: false, status: 'error' },
      ],
    });
    const r = await runMcpServers();
    expect(r).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('1 of 2 enabled MCP servers answered'),
    });
    expect(r.detail).toBe('plaud: connected\ndocs: MCP server returned HTTP 401');
    expect(getJSON).toHaveBeenCalledWith('cms/config/mcp-servers');
    expect(
      mcpServersVerdict([{ id: 'docs', enabled: true, status: 'error', lastError: 'timed out' }])
        .status
    ).toBe('offline');
    expect(mcpServersVerdict([]).status).toBe('unknown');
  });
});

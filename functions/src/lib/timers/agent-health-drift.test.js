/**
 * checkAgentHealth's hourly read of main for the drift check (#1009).
 *
 * The run's own work (marks and messages) comes first and never depends on
 * GitHub: a read that fails, or a drift record that cannot be written, is a
 * `mainRead: 'failed'` and a content-free warn line, never a failed run.
 */
import { describe, it, expect, vi } from 'vitest';

import { AGENT_HEALTH_QUERY, createAgentHealthCheck } from './agent-health.js';
import { DRIFT_READ_INTERVAL_MS, LAB_DRIFT_DOC_ID } from '../labs/drift.js';
import { RepoSourceError } from '../cms/repo-draft-source.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const now = () => NOW;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const APPLIED = { commit: 'a'.repeat(40), committedAt: ago(72 * 3_600_000), appliedAt: ago(48 * 3_600_000) };

function store({ agents, drift = null } = {}) {
  const docs = new Map(drift ? [[LAB_DRIFT_DOC_ID, { ...drift, _etag: 'e1' }]] : []);
  return {
    docs,
    queryDocs: vi.fn(async () => agents),
    patchDoc: vi.fn(async (_c, id, updates) => ({ id, ...updates })),
    readDoc: vi.fn(async (_c, id) => docs.get(id) ?? null),
    createDoc: vi.fn(async (_c, doc) => {
      docs.set(doc.id, { ...doc, _etag: 'e1' });
      return docs.get(doc.id);
    }),
    replaceDocIfMatch: vi.fn(async (_c, doc) => {
      docs.set(doc.id, doc);
      return doc;
    }),
  };
}

const fresh = { id: 'vps-1', agentId: 'vps-1', active: true, status: 'idle', lastSeenAt: ago(10_000), applied: APPLIED };
const stale = { id: 'vps-2', agentId: 'vps-2', active: true, status: 'idle', lastSeenAt: ago(10 * 60_000) };

describe('checkAgentHealth reads main once an hour', () => {
  it('reads the applied commits with the registry, then main from the oldest of them', async () => {
    expect(AGENT_HEALTH_QUERY).toContain('c.applied');
    const s = store({ agents: [fresh] });
    const driftReader = { hostCommits: vi.fn(async () => ({ commits: [], truncated: false })) };
    const summary = await createAgentHealthCheck({ store: s, now, driftReader }).run();
    expect(summary.mainRead).toBe('read');
    expect(driftReader.hostCommits).toHaveBeenCalledWith(APPLIED.committedAt);
    expect(s.docs.get(LAB_DRIFT_DOC_ID)).toMatchObject({ lastSuccessAt: NOW.toISOString(), hostCommits: [] });
  });

  it('does not ask again within the hour', async () => {
    const s = store({
      agents: [fresh],
      drift: { id: LAB_DRIFT_DOC_ID, lastAttemptAt: ago(DRIFT_READ_INTERVAL_MS - 60_000) },
    });
    const driftReader = { hostCommits: vi.fn() };
    expect((await createAgentHealthCheck({ store: s, now, driftReader }).run()).mainRead).toBe('not due');
    expect(driftReader.hostCommits).not.toHaveBeenCalled();
  });

  it('marks a stale agent first, and a GitHub failure after it changes nothing about that', async () => {
    const s = store({ agents: [stale] });
    const driftReader = {
      hostCommits: vi.fn(async () => {
        throw new RepoSourceError('GitHub did not answer within 8000 ms.', { code: 'TIMEOUT' });
      }),
    };
    const log = { warn: vi.fn() };
    const summary = await createAgentHealthCheck({ store: s, now, log, driftReader }).run();
    expect(summary).toMatchObject({ markedOffline: 1, mainRead: 'failed' });
    expect(s.patchDoc.mock.invocationCallOrder[0]).toBeLessThan(driftReader.hostCommits.mock.invocationCallOrder[0]);
    expect(s.docs.get(LAB_DRIFT_DOC_ID).lastError).toBe('TIMEOUT: GitHub did not answer within 8000 ms.');
  });

  it('never fails the run when the drift record cannot be written, and logs only a code', async () => {
    const s = store({ agents: [fresh] });
    s.createDoc.mockRejectedValueOnce(Object.assign(new Error('Cosmos is down for vps-1'), { code: 503 }));
    const log = { warn: vi.fn() };
    const driftReader = { hostCommits: vi.fn(async () => ({ commits: [], truncated: false })) };
    const summary = await createAgentHealthCheck({ store: s, now, log, driftReader }).run();
    expect(summary.mainRead).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      '[checkAgentHealth] the drift record could not be written (503); the next run tries again'
    );
    expect(log.warn.mock.calls.flat().join('\n')).not.toContain('vps-1');
  });

  it('never matches the PLAT-4 offline alert with its own lines', async () => {
    // alert-lab-agent-offline matches lines starting "[checkAgentHealth] offline message"
    // or "[checkAgentHealth] owner notification failed" (infra/observability.tf).
    const s = store({ agents: [fresh] });
    s.createDoc.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 503 }));
    const log = { warn: vi.fn() };
    const driftReader = {
      hostCommits: vi.fn(async () => {
        throw Object.assign(new Error('y'), { code: 'RATE_LIMITED' });
      }),
    };
    await createAgentHealthCheck({ store: s, now, log, driftReader }).run();
    for (const [line] of log.warn.mock.calls) {
      expect(line).not.toMatch(/^\[checkAgentHealth\] (offline message|owner notification failed)/);
    }
  });
});

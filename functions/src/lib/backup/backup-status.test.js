/**
 * The nightly export's status reader and the Health check it feeds (#1409):
 * a run that covers every authored container, one missing brain_records, no
 * runs at all (said as "no manifest", never as healthy), an incomplete run,
 * the 26-hour age rule, and the reader's cache. The in-memory blob store is
 * the one cosmos-export.test.js hands the exporter.
 */
import { describe, it, expect, vi } from 'vitest';

import { AUTHORED, exportPlanFor } from './export-classification.js';
import { blobNames } from './cosmos-export.js';
import {
  BACKUP_STATUS_TTL_MS,
  DEFAULT_LOOKBACK_DAYS,
  WATCHED_CONTAINER,
  backupsUnavailable,
  createBackupStatusReader,
} from './backup-status.js';
import { EXPORT_STALE_AFTER_MS, checkNightlyExport } from '../health/pulse-checks.js';

/** Wednesday, mid-morning UTC: the 03:00 delta of the same date is the newest run. */
const NOW = new Date('2026-11-04T09:30:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

/** An in-memory export blob store (cosmos-export.test.js memBlobs, reads only). */
function memBlobs(initial = {}) {
  const blobs = new Map(Object.entries(initial));
  return {
    blobs,
    readJson: vi.fn(async (name) => {
      const raw = blobs.get(name);
      return raw === undefined ? null : JSON.parse(raw);
    }),
    listNames: vi.fn(async (prefix) => [...blobs.keys()].filter((n) => n.startsWith(prefix))),
    putJson: vi.fn(),
    uploadGzipStream: vi.fn(),
  };
}

/** The run record and manifest of one run, with every container of its plan at 3 records. */
function completedRun({ mode, runId, completedAt, except = [], docs = 3 }) {
  const names = blobNames({ mode, runId, container: '' });
  const containers = exportPlanFor(mode).filter((c) => !except.includes(c));
  return {
    [names.run]: JSON.stringify({
      runId,
      mode,
      containers,
      enqueuedAt: `${runId}T03:00:01.000Z`,
    }),
    [names.manifest]: JSON.stringify({
      runId,
      mode,
      containers: containers.map((container) => ({
        container,
        docs,
        bytes: 100,
        tsHighWater: 1,
        durationMs: 5,
      })),
      docs: docs * containers.length,
      bytes: 100 * containers.length,
      durationMs: 5 * containers.length,
      completedAt,
    }),
  };
}

const reader = (blobs, overrides = {}) =>
  createBackupStatusReader({ blobs, now: () => NOW, ttlMs: 0, ...overrides });

describe('createBackupStatusReader', () => {
  it('reports the newest completed run with every authored container, and brain_records on /ownerId', async () => {
    const blobs = memBlobs({
      ...completedRun({ mode: 'delta', runId: '2026-11-04', completedAt: '2026-11-04T03:41:00.000Z' }),
      ...completedRun({ mode: 'delta', runId: '2026-11-03', completedAt: '2026-11-03T03:40:00.000Z' }),
      ...completedRun({ mode: 'full', runId: '2026-11-01', completedAt: '2026-11-01T04:10:00.000Z' }),
    });
    const block = await reader(blobs).read();

    expect(block.unavailable).toBe(false);
    expect(block.lookbackDays).toBe(DEFAULT_LOOKBACK_DAYS);
    expect(block.checkedAt).toBe(NOW.toISOString());
    // Newest first; the nights with no run record are not listed.
    expect(block.runs.map((run) => `${run.mode}/${run.runId}`)).toEqual([
      'delta/2026-11-04',
      'delta/2026-11-03',
      'full/2026-11-01',
    ]);
    expect(block.lastCompleted).toMatchObject({
      runId: '2026-11-04',
      mode: 'delta',
      complete: true,
      startedAt: '2026-11-04T03:00:01.000Z',
      completedAt: '2026-11-04T03:41:00.000Z',
      containerCount: 57,
      expectedCount: 57,
      authored: { expected: AUTHORED.length, present: AUTHORED.length, missing: [] },
      watched: { container: WATCHED_CONTAINER, present: true, docs: 3, partitionKey: '/ownerId' },
    });
    expect(block.lastCompleted.containers).toContainEqual({ container: 'brain_records', docs: 3 });
    // Names and counts only: nothing in the block is a document or a field of one.
    expect(JSON.stringify(block)).not.toMatch(/"id"|ownerId":|body/);
    // The Sunday full is read under full/, the weekdays under delta/: no listing.
    expect(blobs.listNames).not.toHaveBeenCalled();
    expect(blobs.readJson).toHaveBeenCalledWith('full/2026-11-01/manifest.json');
    // Seven dates, one run.json read each; a manifest read only where a run exists.
    expect(blobs.readJson.mock.calls.filter(([n]) => n.endsWith('run.json'))).toHaveLength(7);
    expect(blobs.readJson.mock.calls.filter(([n]) => n.endsWith('manifest.json'))).toHaveLength(3);
  });

  it('names an authored container the newest run is missing', async () => {
    const blobs = memBlobs(
      completedRun({
        mode: 'delta',
        runId: '2026-11-04',
        completedAt: '2026-11-04T03:41:00.000Z',
        except: ['brain_records'],
      })
    );
    const { lastCompleted } = await reader(blobs).read();
    expect(lastCompleted.containerCount).toBe(56);
    expect(lastCompleted.authored).toEqual({
      expected: AUTHORED.length,
      present: AUTHORED.length - 1,
      missing: ['brain_records'],
    });
    expect(lastCompleted.watched).toEqual({
      container: 'brain_records',
      present: false,
      docs: null,
      partitionKey: '/ownerId',
    });
  });

  it('reports no runs at all as no manifest, not as healthy', async () => {
    const block = await reader(memBlobs()).read();
    expect(block).toEqual({
      unavailable: false,
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      runs: [],
      lastCompleted: null,
      checkedAt: NOW.toISOString(),
    });
    expect(checkNightlyExport({ backups: block }, NOW.getTime())).toEqual({
      status: 'critical',
      summary: 'No completed export manifest in the last 7 days.',
    });
  });

  it('counts the markers of a run that has a record and no manifest', async () => {
    const names = blobNames({ mode: 'delta', runId: '2026-11-04', container: '' });
    const blobs = memBlobs({
      ...completedRun({ mode: 'delta', runId: '2026-11-03', completedAt: '2026-11-03T03:40:00.000Z' }),
      [names.run]: JSON.stringify({ containers: exportPlanFor('delta'), enqueuedAt: '2026-11-04T03:00:01.000Z' }),
      [blobNames({ mode: 'delta', runId: '2026-11-04', container: 'blogs' }).marker]: '{}',
      [blobNames({ mode: 'delta', runId: '2026-11-04', container: 'content' }).marker]: '{}',
      [blobNames({ mode: 'delta', runId: '2026-11-04', container: 'content' }).data]: 'gz',
    });
    const block = await reader(blobs).read();
    expect(block.runs[0]).toEqual({
      runId: '2026-11-04',
      mode: 'delta',
      startedAt: '2026-11-04T03:00:01.000Z',
      expectedCount: 57,
      complete: false,
      completedAt: null,
      markers: 2,
    });
    // The incomplete run's prefix is the only one listed.
    expect(blobs.listNames.mock.calls).toEqual([[names.prefix]]);
    // The last completed one is the night before.
    expect(block.lastCompleted.runId).toBe('2026-11-03');
  });

  it('reuses one reading for the TTL and reads again after it; a failed read is not cached', async () => {
    const blobs = memBlobs(
      completedRun({ mode: 'delta', runId: '2026-11-04', completedAt: '2026-11-04T03:41:00.000Z' })
    );
    let clock = NOW.getTime();
    const r = createBackupStatusReader({ blobs, now: () => new Date(clock) });
    await r.read();
    const reads = blobs.readJson.mock.calls.length;
    clock += BACKUP_STATUS_TTL_MS - 1;
    await r.read();
    expect(blobs.readJson.mock.calls.length).toBe(reads);
    clock += 2;
    await r.read();
    expect(blobs.readJson.mock.calls.length).toBe(reads * 2);

    const failing = memBlobs();
    failing.readJson.mockRejectedValueOnce(new Error('403 from the storage firewall'));
    const r2 = createBackupStatusReader({ blobs: failing, now: () => NOW });
    await expect(r2.read()).rejects.toThrow(/403/);
    await r2.read();
    expect(failing.readJson.mock.calls.length).toBeGreaterThan(1);
  });

  it('backupsUnavailable is the block when nothing could be read', () => {
    expect(backupsUnavailable('2026-11-04T09:30:00.000Z')).toEqual({
      unavailable: true,
      lookbackDays: null,
      runs: [],
      lastCompleted: null,
      checkedAt: '2026-11-04T09:30:00.000Z',
    });
  });
});

describe('checkNightlyExport', () => {
  const nowMs = NOW.getTime();
  const completed = (ageMs, extra = {}) => ({
    backups: {
      unavailable: false,
      lookbackDays: 7,
      runs: [],
      lastCompleted: {
        runId: '2026-11-04',
        mode: 'delta',
        complete: true,
        completedAt: new Date(nowMs - ageMs).toISOString(),
        containerCount: 57,
        authored: { expected: 46, present: 46, missing: [] },
        watched: { container: 'brain_records', present: true, docs: 12, partitionKey: '/ownerId' },
        ...extra,
      },
    },
  });

  it('is healthy for a fresh, complete run and names brain_records with its partition key', () => {
    expect(checkNightlyExport(completed(6 * HOUR_MS), nowMs)).toEqual({
      status: 'healthy',
      summary:
        'Export delta/2026-11-04 completed 6 h ago: 57 containers, every authored container present (46 of 46). brain_records: 12 records, partition key /ownerId.',
    });
  });

  it('is critical once the newest completed run is older than 26 hours', () => {
    expect(EXPORT_STALE_AFTER_MS).toBe(26 * HOUR_MS);
    expect(checkNightlyExport(completed(EXPORT_STALE_AFTER_MS - 1), nowMs).status).toBe('healthy');
    const late = checkNightlyExport(completed(EXPORT_STALE_AFTER_MS + 1), nowMs);
    expect(late.status).toBe('critical');
    expect(late.summary).toMatch(/finished 26 h ago; a run is due every 24 h/);
    expect(checkNightlyExport(completed(0, { completedAt: 'not-a-date' }), nowMs).status).toBe(
      'critical'
    );
  });

  it('is critical when an authored container is missing, and says which', () => {
    const verdict = checkNightlyExport(
      completed(6 * HOUR_MS, {
        containerCount: 56,
        authored: { expected: 46, present: 45, missing: ['brain_records'] },
        watched: { container: 'brain_records', present: false, docs: null, partitionKey: '/ownerId' },
      }),
      nowMs
    );
    expect(verdict).toEqual({
      status: 'critical',
      summary:
        'Export delta/2026-11-04 completed 6 h ago with 56 containers, but 1 authored container is missing: brain_records. brain_records is not in it.',
    });
  });

  it('says what an incomplete newest run got to when no run completed', () => {
    const verdict = checkNightlyExport(
      {
        backups: {
          unavailable: false,
          lookbackDays: 7,
          runs: [{ runId: '2026-11-04', mode: 'delta', complete: false, markers: 40, expectedCount: 57 }],
          lastCompleted: null,
        },
      },
      nowMs
    );
    expect(verdict).toEqual({
      status: 'critical',
      summary:
        'No completed export manifest in the last 7 days. The newest run, delta/2026-11-04, has 40 container markers of 57 and no manifest.',
    });
  });

  it('is unknown, never healthy, when the manifests could not be read or the block is absent', () => {
    expect(checkNightlyExport({ backups: backupsUnavailable(NOW.toISOString()) }, nowMs)).toEqual({
      status: 'unknown',
      summary: "The export's run manifests could not be read, so last night's export is not known.",
    });
    expect(checkNightlyExport({}, nowMs)).toEqual({
      status: 'unknown',
      summary: 'This snapshot carries no backups block.',
    });
  });
});

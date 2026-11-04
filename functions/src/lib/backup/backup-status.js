/**
 * backup-status.js — "did last night's export run, and what did it cover?",
 * answered from inside the site (#1409).
 *
 * WHY. The nightly Cosmos export (cosmos-export.js, ADR 0028) writes one run
 * manifest per night into the private `cosmos-export` blob container. That
 * container's firewall refuses every workstation, and the log workspace has
 * dropped the 03:00 UTC window more than once (#1530), so the owner had no
 * way to see whether a run completed, or whether it carried a newly
 * classified container such as `brain_records`, short of opening the portal.
 * The Function App already has the identity and the network path to the
 * container, so this reader looks for it and hands the Health page a small,
 * id-free block.
 *
 * WHAT IT READS. The last `lookbackDays` UTC dates, newest first. For each
 * date it point-reads the run record the scheduler claims
 * (`<mode>/<date>/run.json`) and, when that exists, the run manifest the
 * last worker writes (`<mode>/<date>/manifest.json`). The mode is the one
 * the scheduler derives from the date (`modeFor`: Sunday is full), so there
 * is exactly one place a date's manifest can be and no listing is needed to
 * find it. A run with a record and no manifest is incomplete; for that one
 * run the prefix is listed once, so the block can say how many of its
 * container markers exist. A date with no run record is a night the
 * scheduler never fired, and costs one read.
 *
 * WHAT IT RETURNS. Per run: mode, when it was enqueued and completed, the
 * containers with their record counts, how many of the authored containers
 * (export-classification.js, class A) are present and which are missing,
 * and `brain_records` on its own with its partition key path, because that
 * is the question #1409 asks. Never a document, never a field: the manifest
 * carries names, counts, bytes and durations, and so does this.
 *
 * COST. Up to `2 * lookbackDays` small point reads and at most one listing
 * per build, cached for `ttlMs` inside the reader, so the five-minute health
 * pulse and the Health page share one reading. No new timer.
 */
import { PARTITION_KEY_PATHS } from '../cosmos-client.js';
import { AUTHORED } from './export-classification.js';
import { blobNames, modeFor, runIdFor } from './cosmos-export.js';

/** The container #1409 is about, reported on its own beside the coverage. */
export const WATCHED_CONTAINER = 'brain_records';
/** How many UTC dates the reader looks back: a week holds one full and six deltas. */
export const DEFAULT_LOOKBACK_DAYS = 7;
/** How long one reading is reused before the blobs are read again. */
export const BACKUP_STATUS_TTL_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The names and record counts in a manifest, in the shape the Health page
 * shows. Anything that is not a `{ container, docs }` row is dropped rather
 * than guessed at.
 *
 * @param {unknown} manifest
 * @returns {{ container: string, docs: number }[]}
 */
function manifestContainers(manifest) {
  const rows = Array.isArray(manifest?.containers) ? manifest.containers : [];
  return rows
    .filter((row) => typeof row?.container === 'string' && row.container)
    .map((row) => ({ container: row.container, docs: Number(row.docs) || 0 }));
}

/**
 * Which of the authored containers a run covers. `authored` is the list as
 * the code classifies it TODAY, on purpose: a run from before a container
 * was classified shows that container as missing, which is the finding
 * #1409 exists to surface.
 *
 * @param {{ container: string, docs: number }[]} containers
 * @param {readonly string[]} authored
 */
function authoredCoverage(containers, authored) {
  const present = new Set(containers.map((row) => row.container));
  const missing = authored.filter((name) => !present.has(name));
  return { expected: authored.length, present: authored.length - missing.length, missing };
}

/**
 * The watched container as the block reports it: whether the run carries it,
 * its record count, and the partition key path the restore needs
 * (cosmos-client.js PARTITION_KEY_PATHS; `/id` when the table has no entry).
 */
function watched(containers, partitionKeys, name) {
  const row = containers.find((entry) => entry.container === name) || null;
  return {
    container: name,
    present: Boolean(row),
    docs: row ? row.docs : null,
    partitionKey: partitionKeys[name] || '/id',
  };
}

/**
 * @param {object} deps
 * @param {import('./cosmos-export.js').ExportBlobStore} deps.blobs the export blob store
 * @param {() => Date} [deps.now]
 * @param {number} [deps.lookbackDays]
 * @param {number} [deps.ttlMs] 0 reads the blobs on every call
 * @param {readonly string[]} [deps.authored]
 * @param {Record<string, string>} [deps.partitionKeys]
 */
export function createBackupStatusReader({
  blobs,
  now = () => new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  ttlMs = BACKUP_STATUS_TTL_MS,
  authored = AUTHORED,
  partitionKeys = PARTITION_KEY_PATHS,
}) {
  let cached = null;

  /** One run as the block reports it, from its record and manifest. */
  async function readRun(date) {
    const runId = runIdFor(date);
    const mode = modeFor(date);
    const names = blobNames({ mode, runId, container: '' });
    const run = await blobs.readJson(names.run);
    if (!run) return null;
    const expected = Array.isArray(run.containers) ? run.containers.length : null;
    const base = {
      runId,
      mode,
      startedAt: typeof run.enqueuedAt === 'string' ? run.enqueuedAt : null,
      expectedCount: expected,
    };
    const manifest = await blobs.readJson(names.manifest);
    if (manifest) {
      const containers = manifestContainers(manifest);
      return {
        ...base,
        complete: true,
        completedAt: typeof manifest.completedAt === 'string' ? manifest.completedAt : null,
        containerCount: containers.length,
        containers,
        authored: authoredCoverage(containers, authored),
        watched: watched(containers, partitionKeys, WATCHED_CONTAINER),
      };
    }
    // Incomplete: say how far it got, from the markers written so far.
    const present = await blobs.listNames(names.prefix);
    const markers = present.filter((name) => name.endsWith('.marker.json')).length;
    return { ...base, complete: false, completedAt: null, markers };
  }

  async function readFresh() {
    const at = now();
    const runs = [];
    for (let back = 0; back < lookbackDays; back += 1) {
      const run = await readRun(new Date(at.getTime() - back * DAY_MS));
      if (run) runs.push(run);
    }
    const lastCompleted = runs.find((run) => run.complete) || null;
    return {
      unavailable: false,
      lookbackDays,
      runs,
      lastCompleted,
      checkedAt: at.toISOString(),
    };
  }

  /**
   * The block, from the cache while it is younger than `ttlMs`, otherwise
   * read again. A read that throws is not cached and the error reaches the
   * caller, which says "could not be read" rather than "no run".
   */
  async function read() {
    const nowMs = now().getTime();
    if (cached && nowMs - cached.at < ttlMs) return cached.value;
    const value = await readFresh();
    cached = { at: nowMs, value };
    return value;
  }

  return { read, readFresh };
}

/**
 * The block when no reader was given or the read failed: the page and the
 * pulse treat it as "not known", never as "no export".
 *
 * @param {string} checkedAt
 */
export const backupsUnavailable = (checkedAt) => ({
  unavailable: true,
  lookbackDays: null,
  runs: [],
  lastCompleted: null,
  checkedAt,
});

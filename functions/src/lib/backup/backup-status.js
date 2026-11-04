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
 * carries names, counts, bytes and durations, and so does this. The blobs
 * are the exporter's own writes, but they are still read as data: every
 * value is type-checked, counts are clamped to safe non-negative integers
 * and times to a bounded string.
 *
 * COST AND FAILURE. Up to `2 * lookbackDays` small point reads and at most
 * one listing per reading, cached for `ttlMs` inside the reader and shared
 * by callers that arrive while a reading is in flight, so the five-minute
 * health pulse and the Health page share one reading. The whole reading is
 * bounded by `timeoutMs`: the ops snapshot must not wait on a storage
 * account that drops rather than refuses. A failed or timed-out reading is
 * not cached, is logged by its code only (never the store's words, #945),
 * and reaches the caller as a rejection, which the snapshot turns into
 * "not known" rather than "no run". No new timer.
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
/** The most one reading may take before it is "not known" (the snapshot waits on it). */
export const BACKUP_STATUS_TIMEOUT_MS = 8 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** An ISO time is 24 characters; anything longer is not a time this block repeats. */
const TIME_MAX_LENGTH = 40;

/** A count from a blob: a safe non-negative integer, or 0. */
const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/** A time string from a blob, bounded, or null. */
const timeString = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= TIME_MAX_LENGTH ? value : null;

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
    .map((row) => ({ container: row.container, docs: count(row.docs) }));
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

/** The error's code for a log line: its HTTP status, its code, or its name. Never its message. */
const errorCode = (error) =>
  error?.statusCode ?? error?.code ?? error?.name ?? 'unknown';

/**
 * @param {object} deps
 * @param {import('./cosmos-export.js').ExportBlobStore} deps.blobs the export blob store
 * @param {() => Date} [deps.now]
 * @param {number} [deps.lookbackDays]
 * @param {number} [deps.ttlMs] 0 reads the blobs on every call
 * @param {number} [deps.timeoutMs] 0 waits as long as the store takes
 * @param {readonly string[]} [deps.authored]
 * @param {Record<string, string>} [deps.partitionKeys]
 * @param {{ warn?: Function }} [deps.log]
 */
export function createBackupStatusReader({
  blobs,
  now = () => new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  ttlMs = BACKUP_STATUS_TTL_MS,
  timeoutMs = BACKUP_STATUS_TIMEOUT_MS,
  authored = AUTHORED,
  partitionKeys = PARTITION_KEY_PATHS,
  log = console,
}) {
  let cached = null;
  let inFlight = null;

  /** One run as the block reports it, from its record and manifest. */
  async function readRun(date) {
    const runId = runIdFor(date);
    const mode = modeFor(date);
    const names = blobNames({ mode, runId, container: '' });
    const run = await blobs.readJson(names.run);
    if (!run || typeof run !== 'object') return null;
    const base = {
      runId,
      mode,
      startedAt: timeString(run.enqueuedAt),
      expectedCount: Array.isArray(run.containers) ? run.containers.length : null,
    };
    const manifest = await blobs.readJson(names.manifest);
    if (manifest && typeof manifest === 'object') {
      const containers = manifestContainers(manifest);
      return {
        ...base,
        complete: true,
        completedAt: timeString(manifest.completedAt),
        containerCount: containers.length,
        containers,
        authored: authoredCoverage(containers, authored),
        watched: watched(containers, partitionKeys, WATCHED_CONTAINER),
      };
    }
    // Incomplete: say how far it got, from the markers written so far. A
    // listing that fails leaves the count unknown (null) and the reading
    // whole; the completed runs already read are the ones that matter.
    let markers = null;
    try {
      const present = await blobs.listNames(names.prefix);
      markers = present.filter((name) => name.endsWith('.marker.json')).length;
    } catch (error) {
      log.warn?.(`[backupStatus] listing ${mode}/${runId} failed: ${errorCode(error)}`);
    }
    return { ...base, complete: false, completedAt: null, markers };
  }

  /**
   * One full reading. `isCancelled` is checked between the sequential reads
   * so a reading whose deadline has passed stops at the next boundary
   * instead of walking every remaining date against a storage account that
   * is already not answering.
   */
  async function readFresh(isCancelled = () => false) {
    const at = now();
    const runs = [];
    for (let back = 0; back < lookbackDays; back += 1) {
      if (isCancelled()) {
        throw Object.assign(new Error('backup status read cancelled'), { code: 'ECANCELED' });
      }
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
   * `readFresh`, but no longer than `timeoutMs`. The race alone would leave
   * the losing read walking on; the flag stops it at its next read.
   */
  function readBounded() {
    if (!(timeoutMs > 0)) return readFresh();
    let timer;
    let cancelled = false;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        reject(Object.assign(new Error('backup status read timed out'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
    });
    // The losing read's own rejection (ECANCELED) has nowhere to go once the
    // race is decided; swallow it there so nothing is reported as unhandled.
    const reading = readFresh(() => cancelled);
    reading.catch(() => {});
    return Promise.race([reading, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * The block, from the cache while it is younger than `ttlMs`, otherwise
   * read again; callers that arrive during a read share it. A read that
   * throws or times out is not cached: its code is logged and the error
   * reaches the caller, which says "could not be read" rather than "no run".
   */
  async function read() {
    const nowMs = now().getTime();
    if (cached && nowMs - cached.at < ttlMs) return cached.value;
    if (!inFlight) {
      inFlight = readBounded()
        .then((value) => {
          cached = { at: now().getTime(), value };
          return value;
        })
        .catch((error) => {
          log.warn?.(`[backupStatus] read failed: ${errorCode(error)}`);
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
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

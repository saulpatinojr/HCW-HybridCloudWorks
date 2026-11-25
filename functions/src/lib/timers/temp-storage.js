/**
 * temp-storage.js — `cleanupTempStorage`, daily (T-302).
 *
 * Not an orphan sweep. T-302's hazard was an orphan query that enumerates
 * every blob and every referencing document and deletes whatever it failed
 * to enumerate. This job does not try: it deletes by PREFIX and AGE only —
 * blobs under the temporary-upload prefixes (`TEMP_STORAGE_PREFIXES`,
 * default `content:uploads/`, the per-user scratch prefix Site-Main kept in
 * `uploads/` and the migration skipped) older than `TEMP_STORAGE_MAX_AGE_DAYS`
 * (default 7). Nothing a document could reference lives under those
 * prefixes by construction.
 *
 * DRY-RUN BY DEFAULT: reports what it would delete until
 * `TEMP_STORAGE_CLEANUP_DELETE=true`.
 */

import { errorFacts } from '../http/error-response.js';
export const DEFAULT_PREFIXES = 'content:uploads/';
export const DEFAULT_MAX_AGE_DAYS = 7;

/** `container:prefix,container:prefix` → [{ container, prefix }]; a blank prefix is refused (that would be the whole container). */
export function parsePrefixes(spec) {
  return String(spec || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [container, ...rest] = entry.split(':');
      return { container: container.trim(), prefix: rest.join(':').trim() };
    })
    .filter((p) => p.container && p.prefix);
}

/** The blobs last changed at or before `cutoff`; one with no readable time is kept. */
function staleBlobs(blobs, cutoff) {
  return blobs.filter((b) => {
    const modified = b.lastModified ? new Date(b.lastModified).getTime() : Number.NaN;
    return Number.isFinite(modified) && modified <= cutoff;
  });
}

/** Delete each stale blob; one that fails is logged and the rest go on. Returns how many went. */
async function deleteStale(storage, log, container, stale) {
  let deleted = 0;
  for (const blob of stale) {
    try {
      await storage.deleteBlob(container, blob.name);
      deleted += 1;
    } catch (err) {
      log.error?.(
        `[cleanupTempStorage] Failed to delete a blob in ${container}: ${errorFacts(err)}`
      );
    }
  }
  return deleted;
}

/** One prefix swept, its counts added to the run's result. */
async function sweepPrefix(d, result, { container, prefix }, cutoff) {
  const blobs = (await d.storage.listBlobs(container, prefix)) || [];
  const stale = staleBlobs(blobs, cutoff);
  result.examined += blobs.length;
  result.candidates += stale.length;
  const deleted = d.deleteEnabled ? await deleteStale(d.storage, d.log, container, stale) : 0;
  result.deleted += deleted;
  result.byPrefix[`${container}:${prefix}`] = {
    examined: blobs.length,
    candidates: stale.length,
    deleted,
  };
}

/** TEMP_STORAGE_MAX_AGE_DAYS when it is a positive number, else the default. */
function maxAgeDaysOf(env) {
  return Number(env.TEMP_STORAGE_MAX_AGE_DAYS) > 0 ? Number(env.TEMP_STORAGE_MAX_AGE_DAYS) : DEFAULT_MAX_AGE_DAYS;
}

async function run({ storage, env, now, log }) {
  const deleteEnabled = env.TEMP_STORAGE_CLEANUP_DELETE === 'true';
  const maxAgeDays = maxAgeDaysOf(env);
  const cutoff = now().getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const targets = parsePrefixes(env.TEMP_STORAGE_PREFIXES || DEFAULT_PREFIXES);

  const result = {
    dryRun: !deleteEnabled,
    maxAgeDays,
    examined: 0,
    candidates: 0,
    deleted: 0,
    byPrefix: {},
  };
  for (const target of targets) await sweepPrefix({ storage, log, deleteEnabled }, result, target, cutoff);
  log.log?.(
    `[cleanupTempStorage] ${deleteEnabled ? 'deleted' : 'DRY RUN — would delete'} ${deleteEnabled ? result.deleted : result.candidates} of ${result.examined} (older than ${maxAgeDays} d)`
  );
  return result;
}

export function createTempStorageCleanup({
  storage,
  env = process.env,
  now = () => new Date(),
  log = {},
}) {
  return { run: () => run({ storage, env, now, log }) };
}

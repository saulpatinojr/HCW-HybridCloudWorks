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

export function createTempStorageCleanup({
  storage,
  env = process.env,
  now = () => new Date(),
  log = {},
}) {
  async function run() {
    const deleteEnabled = env.TEMP_STORAGE_CLEANUP_DELETE === 'true';
    const maxAgeDays =
      Number(env.TEMP_STORAGE_MAX_AGE_DAYS) > 0
        ? Number(env.TEMP_STORAGE_MAX_AGE_DAYS)
        : DEFAULT_MAX_AGE_DAYS;
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
    for (const { container, prefix } of targets) {
      const blobs = await storage.listBlobs(container, prefix);
      const stale = (blobs || []).filter((b) => {
        const modified = b.lastModified ? new Date(b.lastModified).getTime() : Number.NaN;
        return Number.isFinite(modified) && modified <= cutoff;
      });
      result.examined += (blobs || []).length;
      result.candidates += stale.length;
      let deleted = 0;
      if (deleteEnabled) {
        for (const blob of stale) {
          try {
            await storage.deleteBlob(container, blob.name);
            deleted += 1;
          } catch (err) {
            log.error?.(
              `[cleanupTempStorage] Failed to delete ${container}/${blob.name}: ${errorFacts(err)}`
            );
          }
        }
      }
      result.deleted += deleted;
      result.byPrefix[`${container}:${prefix}`] = {
        examined: (blobs || []).length,
        candidates: stale.length,
        deleted,
      };
    }
    log.log?.(
      `[cleanupTempStorage] ${deleteEnabled ? 'deleted' : 'DRY RUN — would delete'} ${deleteEnabled ? result.deleted : result.candidates} of ${result.examined} (older than ${maxAgeDays} d)`
    );
    return result;
  }
  return { run };
}

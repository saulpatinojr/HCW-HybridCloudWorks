/**
 * snapshot-badges.js — the legacy badge step of publishSnapshot
 * (snapshots-publish.js): certifications whose badge still names the
 * decommissioned Firebase bucket, re-pointed at the copy in the
 * `certifications` container when blob storage confirms it is there.
 */
import { errorFacts } from './http/error-response.js';
import { legacyBadgePathsOf, repointAll } from './legacy-badge-url.js';

/**
 * Re-point the certifications whose badge still names the decommissioned
 * Firebase bucket at the same path in the `certifications` container, where
 * the migration copied the blobs (legacy-badge-url.js, #868). Only when
 * blob storage confirms the blob exists: a reference rewritten to nothing
 * would swap a placeholder for a broken frame.
 *
 * The rewrite is persisted as ONE conditional write per row (`ifMatch` on
 * the `_etag` the row was read with), so an editor who saved a replacement
 * badge while blob storage was being asked is not overwritten by the
 * migration. A 412 re-reads the row, recomputes the rewrite against what is
 * stored now, and tries once more; if that fails too the fresh row is
 * published exactly as stored and the miss is logged — never the stale row.
 * A missing blob is reported by name and the document is left as it was.
 *
 * @param {object[]} rows the raw certification documents
 * @param {{ blobExists: (path: string) => Promise<boolean>, patch: ((id: string, changes: object, etag: string|undefined) => Promise<unknown>)|null, reread: ((id: string) => Promise<object|null>)|null, log: object }} deps
 * @returns {Promise<{ rows: object[], repointed: number, missing: string[] }>}
 */
export async function repointLegacyBadges(rows, deps) {
  const existing = await confirmLegacyBlobs(rows, deps.blobExists);
  const out = [];
  const missing = [];
  let repointed = 0;
  for (const row of rows) {
    const outcome = await repointRow(row, existing, deps);
    out.push(outcome.row);
    repointed += outcome.repointed;
    missing.push(...outcome.missing.map((path) => `${row.name || row.Name || row.id}: ${path}`));
  }
  return { rows: out, repointed, missing };
}

/** Every distinct legacy path the rows name, asked of blob storage once each. */
async function confirmLegacyBlobs(rows, blobExists) {
  const paths = new Set(rows.flatMap(legacyBadgePathsOf));
  const existing = new Set();
  for (const path of paths) {
    if (await blobExists(path)) existing.add(path);
  }
  return existing;
}

/** One row: the rewrite as one change set, persisted conditionally, retried once from a fresh read. */
async function repointRow(row, existing, deps) {
  const first = repointAll(row, existing);
  if (Object.keys(first.changes).length === 0) {
    return { row, repointed: 0, missing: first.missing };
  }
  if (!deps.patch) return { row: first.doc, repointed: 1, missing: first.missing };

  const written = await persistRepoint(deps.patch, row, first.changes, deps.log);
  if (written !== 'conflict') return { row: first.doc, repointed: 1, missing: first.missing };
  return repointAfterConflict(row, existing, deps, first);
}

/**
 * Someone wrote between the query and this write. Decide again from the
 * row as it is now, and publish that decision whether or not it persists.
 */
async function repointAfterConflict(row, existing, { patch, reread, log }, first) {
  const fresh = reread ? await reread(row.id) : null;
  if (!fresh) {
    log?.warn?.('[publishSnapshot] a row changed during publish and could not be re-read; published as queried');
    return { row, repointed: 0, missing: first.missing };
  }
  const again = repointAll(fresh, existing);
  if (Object.keys(again.changes).length === 0) {
    return { row: fresh, repointed: 0, missing: again.missing };
  }
  const second = await persistRepoint(patch, fresh, again.changes, log);
  if (second === 'conflict') {
    log?.warn?.('[publishSnapshot] a row changed twice during publish; published as stored, not re-pointed');
    return { row: fresh, repointed: 0, missing: again.missing };
  }
  return { row: again.doc, repointed: 1, missing: again.missing };
}

/**
 * Persist a rewrite with the row's ETag as the precondition. 'conflict' on a
 * 412; any other failure is logged and the publish still carries the URL.
 */
async function persistRepoint(patch, row, changes, log) {
  try {
    await patch(row.id, changes, row._etag);
    return 'written';
  } catch (error) {
    if (error?.code === 412 || error?.statusCode === 412) return 'conflict';
    log?.warn?.(
      `[publishSnapshot] could not persist a re-pointed badge: ${errorFacts(error)}`
    );
    return 'failed';
  }
}

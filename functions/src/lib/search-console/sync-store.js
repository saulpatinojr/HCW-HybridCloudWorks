/**
 * sync-store.js — reading and writing the one snapshot document a Search
 * Console run (sync.js) keeps in `admin_config`.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { CONTAINER, HISTORY_MAX, SNAPSHOT_DOC_ID, SNAPSHOT_DOC_TYPE, WRITE_ATTEMPTS } from './sync-constants.js';
import { emptySnapshot } from './sync-present.js';

const isWriteConflict = (failure) => {
  const status = failure?.code ?? failure?.statusCode;
  return status === 412 || status === 409;
};

/** The stored snapshot, or null before the first run. */
export async function readStored(store) {
  return store.readDoc(CONTAINER, SNAPSHOT_DOC_ID, ADMIN_CONFIG_PARTITION);
}

/** Write `build(stored)` under the ETag `stored` was read with; retry a lost race. */
async function save(store, build) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const stored = await readStored(store);
    const doc = {
      ...build(stored),
      id: SNAPSHOT_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: SNAPSHOT_DOC_TYPE,
    };
    try {
      if (stored) {
        await store.replaceDocIfMatch(CONTAINER, { ...doc, _etag: stored._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });
      } else {
        await store.createDoc(CONTAINER, doc);
      }
      return doc;
    } catch (failure) {
      if (!isWriteConflict(failure) || attempt === WRITE_ATTEMPTS) throw failure;
    }
  }
  return null;
}

/**
 * `save(build)`, but only while this run still holds the lease: it is
 * checked and extended first (lease.js `renew`), so no other run can take
 * it during the write. False, with nothing written, when the run lost it.
 */
export async function saveWhileHeld(store, lease, build) {
  const held = await lease.renew();
  if (!held.ok) return false;
  await save(store, build);
  return true;
}

/** The data sections of a stored snapshot, without Cosmos's own fields. */
function pick(stored) {
  const out = {};
  for (const key of ['generatedAt', 'indexing', 'performance', 'sitemaps']) {
    if (stored?.[key] !== undefined && stored[key] !== null) out[key] = stored[key];
  }
  return out;
}

/** A failed run's document: the last good figures kept, only the status and run replaced. */
export const keepPrevious = (stored, siteUrl, run) => ({
  ...emptySnapshot(siteUrl),
  ...pick(stored),
  siteUrl,
  status: 'error',
  run,
});

/** The stored history with this run's entry added, newest last, at most HISTORY_MAX. */
export const withHistory = (stored, entry) => {
  const previous = Array.isArray(stored?.indexing?.history) ? stored.indexing.history : [];
  return entry ? [...previous, entry].slice(-HISTORY_MAX) : previous.slice(-HISTORY_MAX);
};

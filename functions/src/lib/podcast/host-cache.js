/**
 * host-cache.js — one `admin_config` document per Podbean read, served while
 * it is young (#1115).
 *
 * The overview (host-reads.js) and the statistics (host-stats.js) are the
 * same shape of thing: a read of Podbean's API that costs several requests
 * against a bucket of 60, answered to a tab that re-renders far more often
 * than the figures change. Both store their last answer in `admin_config`
 * with its `fetchedAt` and serve it while it is younger than their TTL unless
 * the caller asks for a refresh. This is that rule, once.
 *
 * Two more rules ride on it (CodeRabbit on #1127). A refresh is budgeted: it
 * reads live only when the stored answer is older than `refreshFloorMs`, and
 * the floor is read from the shared document, so every editor session, tab
 * and instance together make at most one live read per floor — the same
 * bucket serves publishing and reconciliation. And the document carries the
 * client's `accountKey` (podbean.js: a hash of the client id, never the id),
 * so settings pointed at another Podbean account make the cache a miss
 * rather than serving the previous account's rows until expiry.
 *
 * The cache is a courtesy to the rate bucket, never a dependency: a document
 * that cannot be read is logged (content-free — the code, not the message,
 * which Cosmos fills with the document) and the live read runs; one that
 * cannot be written is logged and the live answer is still returned. Only
 * `read` itself may throw, and what it throws is the caller's.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

/**
 * Whether a cached answer still stands: the same account, and a parseable,
 * non-negative age under the TTL. An `accountKey` absent on either side is
 * `null`, so a client without one (the tests' fakes) matches a document
 * without one, and a document written before the key existed matches only
 * a client without one.
 */
export function isYoungerThan(cached, { now, ttlMs, accountKey = null }) {
  if (!cached || typeof cached.fetchedAt !== 'string') return false;
  if ((cached.accountKey ?? null) !== (accountKey ?? null)) return false;
  const age = now.getTime() - Date.parse(cached.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

/**
 * The fields of a cached document a caller serves — `fields` by name — or
 * null when the document is not one this read wrote.
 */
function pick(doc, fields, accept) {
  if (!doc || typeof doc !== 'object' || typeof doc.fetchedAt !== 'string') return null;
  const value = Object.fromEntries(fields.map((field) => [field, doc[field] ?? null]));
  return accept(value) ? value : null;
}

/**
 * @param {object} args
 * @param {{ readDoc: Function, upsertDoc: Function }} args.store
 * @param {string} args.id the `admin_config` document id
 * @param {ReadonlyArray<string>} args.fields what the document carries (and what is served)
 * @param {(value: object) => boolean} [args.accept] refuse a cached document that is not this read's
 * @param {() => Promise<object>} args.read the live read; its answer is stored under `fields`
 * @param {() => Date} args.now
 * @param {number} args.ttlMs
 * @param {boolean} [args.refresh] read live unless the cache is younger than the floor
 * @param {number} [args.refreshFloorMs] how young a cached answer must be for a refresh to serve it anyway
 * @param {string | null} [args.accountKey] the client's account key, stored and required to match
 * @param {string} args.label the log prefix, e.g. `podbean overview`
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<object>} the answer with `cached: true | false`
 */
export async function readThroughCache({
  store,
  id,
  fields,
  accept = () => true,
  read,
  now,
  ttlMs,
  refresh = false,
  refreshFloorMs = 0,
  accountKey = null,
  label,
  log,
}) {
  let cached = null;
  try {
    cached = pick(await store.readDoc('admin_config', id, ADMIN_CONFIG_PARTITION), fields, accept);
  } catch (error) {
    log?.(`${label}: cache read failed (${error?.code || 'UNEXPECTED'}); reading live`);
  }
  const serveTtl = refresh ? Math.min(ttlMs, refreshFloorMs) : ttlMs;
  if (isYoungerThan(cached, { now: now(), ttlMs: serveTtl, accountKey })) {
    if (refresh) log?.(`${label}: refresh within the floor; serving the cache`);
    return { ...cached, cached: true };
  }

  const live = { ...(await read()), accountKey: accountKey ?? null };
  await writeCache({ store, id, fields, live, label, log });
  return { ...live, cached: false };
}

/**
 * Write the live answer to its document, unless something newer is already
 * there. Two refreshes in flight finish in any order, so the write is
 * decided from a fresh read: a stored answer fetched at or after this one
 * stands; an older one is replaced only if it has not changed since that
 * read (IfMatch on its etag, a 412 meaning someone else got there first);
 * with nothing stored, a create, refused with a 409 when another first
 * writer landed in between, and that one stands. A store without
 * `createDoc`/`replaceDocIfMatch` (the tests' plain fakes) upserts. A
 * pre-read that fails is treated as nothing stored. Never throws: a cache
 * that cannot be written is logged by code and the live answer is served
 * (CodeRabbit on #1127).
 */
async function writeCache({ store, id, fields, live, label, log }) {
  const document = {
    id,
    configScope: ADMIN_CONFIG_PARTITION,
    ...Object.fromEntries(fields.map((field) => [field, live[field] ?? null])),
  };
  let current = null;
  try {
    current = await store.readDoc('admin_config', id, ADMIN_CONFIG_PARTITION);
  } catch (error) {
    log?.(`${label}: cache pre-read failed (${error?.code || 'UNEXPECTED'}); writing anyway`);
  }
  try {
    if (current?.fetchedAt && live.fetchedAt && current.fetchedAt >= live.fetchedAt) {
      log?.(`${label}: cache already holds a newer read; not written`);
      return;
    }
    if (current?._etag && typeof store.replaceDocIfMatch === 'function') {
      await store.replaceDocIfMatch(
        'admin_config',
        { ...document, _etag: current._etag },
        { partitionKey: ADMIN_CONFIG_PARTITION }
      );
      return;
    }
    if (!current && typeof store.createDoc === 'function') {
      await store.createDoc('admin_config', document);
      return;
    }
    await store.upsertDoc('admin_config', document);
  } catch (error) {
    const status = error?.code ?? error?.statusCode;
    const code = status === 412 ? 'CHANGED' : status === 409 ? 'CONFLICT' : error?.code || 'UNEXPECTED';
    log?.(`${label}: cache write failed (${code}); serving live`);
  }
}

/**
 * Cosmos DB data access layer for Azure Functions.
 *
 * Uses DefaultAzureCredential (managed identity in production, az login locally).
 * No static key — COSMOS_KEY must NOT be set. Auth is RBAC via managed identity.
 *
 * Required app settings: COSMOS_ENDPOINT, COSMOS_DATABASE
 * Required RBAC role on the Function App MI: Cosmos DB Built-in Data Contributor
 */

import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

let client = null;
let database = null;

/**
 * Containers whose partition key is NOT `/id`.
 *
 * `readDoc`, `patchDoc` and `deleteDoc` default the partition key to the
 * document id, which is correct for 69 of the 74 containers and silently wrong
 * for these five. Wrong in the worst way: a point read against the wrong
 * logical partition does not error, it returns nothing — and `readDoc` maps
 * that to `null`. The first person to write a `content_versions` reader would
 * have got `null` forever with no indication why (T-313).
 *
 * Mirrored from `infra/cosmos-containers.json`, which is the source of truth.
 * `cosmos-client.test.js` asserts the two agree, so adding a fifth exception to
 * the manifest without adding it here fails CI.
 *
 * Note for anyone comparing against T-313 as written: it named three
 * exceptions. There are five — `listen_and_learn_episodes` (`/setId`) was
 * missing from the finding, and `admin_config` (`/configScope`, a constant)
 * was added 2026-08-18 for the forge save's transactional batch.
 */
export const PARTITION_KEY_PATHS = Object.freeze({
  admin_config: '/configScope',
  content_versions: '/contentId',
  image_prompt_sets_prompts: '/setName',
  image_prompts_sets: '/pageId',
  listen_and_learn_episodes: '/setId',
});

/**
 * The one legal partition key value for `admin_config` — a CONSTANT, so the
 * ContentForge save (forge_profile + forge_prompts, one all-or-nothing write)
 * can port to a Cosmos TransactionalBatch, which only spans one container and
 * one logical partition (owner decision 2026-08-17, Site-Main TODO §2).
 * Every `admin_config` document must carry `configScope: ADMIN_CONFIG_PARTITION`
 * on create, and every point operation passes it explicitly.
 */
export const ADMIN_CONFIG_PARTITION = 'admin_config';

/**
 * Resolve the partition key for a point operation.
 *
 * Throws rather than guessing for the five containers above: an explicit
 * failure at the call site is recoverable, a silent `null` is not.
 *
 * @param {string} containerName
 * @param {string|undefined} explicit - partition key the caller supplied
 * @param {string} id - the document id, the default for `/id` containers
 * @returns {string}
 */
export function resolvePartitionKey(containerName, explicit, id) {
  if (explicit !== undefined && explicit !== null) return explicit;

  const path = PARTITION_KEY_PATHS[containerName];
  if (path) {
    throw new Error(
      `${containerName} is partitioned on ${path}, not /id — pass an explicit partition key. ` +
        'Defaulting to the document id would read the wrong logical partition and return null.'
    );
  }
  return id;
}

/**
 * Initialize or return the singleton Cosmos DB client.
 * Uses managed identity (DefaultAzureCredential) — no key required.
 */
export function getCosmosDb() {
  if (database) return database;

  const endpoint = process.env.COSMOS_ENDPOINT;
  const databaseId = process.env.COSMOS_DATABASE || 'hcw';

  if (!endpoint) {
    throw new Error('Missing COSMOS_ENDPOINT environment variable');
  }

  const credential =
    process.env.WEBSITE_INSTANCE_ID || process.env.IDENTITY_ENDPOINT
      ? new ManagedIdentityCredential()
      : new DefaultAzureCredential();

  client = new CosmosClient({
    endpoint,
    aadCredentials: credential,
  });
  database = client.database(databaseId);

  return database;
}

/**
 * Get a Cosmos DB container reference.
 * @param {string} containerName - e.g. 'content', 'blogs', 'lab_jobs'
 */
export function getContainer(containerName) {
  return getCosmosDb().container(containerName);
}

/**
 * Read a single document by ID.
 * Equivalent to: admin.firestore().collection(name).doc(id).get()
 *
 * @param {string} containerName
 * @param {string} id
 * @param {string} [partitionKey] - defaults to id
 * @returns {Promise<object|null>}
 */
export async function readDoc(containerName, id, partitionKey) {
  const container = getContainer(containerName);
  const pk = resolvePartitionKey(containerName, partitionKey, id);
  try {
    const { resource } = await container.item(id, pk).read();
    return resource || null;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

/**
 * Write or REPLACE a document.
 *
 * NOT equivalent to `.set(data, { merge: true })` — this comment used to say it
 * was, and that was wrong in the most expensive direction. `items.upsert()`
 * replaces the whole document: every field absent from `document` is deleted.
 *
 * Site-Main has 48 partial-write call sites (31 `.update()`, 17
 * `set(..., { merge: true })`). Porting any of them onto this function the way
 * the old comment invited silently wipes every field the payload omits, with no
 * error and no test failure. Use `patchDoc` for those.
 *
 * Equivalent to: admin.firestore().collection(name).doc(id).set(data)
 *
 * @param {string} containerName
 * @param {object} document - must include 'id' field
 * @returns {Promise<object>}
 */
export async function upsertDoc(containerName, document) {
  const container = getContainer(containerName);
  const { resource } = await container.items.upsert(document);
  return resource;
}

/**
 * Replace a document only if it has not changed since it was read.
 *
 * The Cosmos equivalent of a Firestore single-document transaction: read,
 * decide, write-if-unchanged. A concurrent writer loses with a 412 rather than
 * silently overwriting, and the caller decides what losing means — for the
 * Labs agent claiming a job, losing means "someone else took it, try the next
 * one" (lib/lab-agent.js).
 *
 * Distinct from `upsertDoc`, which replaces unconditionally, and from
 * `patchDoc`, whose read-modify-write path retries on 412 because for a field
 * update the retry is what the caller wants. Here it is not: re-reading a job
 * that another agent just claimed and claiming it anyway would defeat the
 * point.
 *
 * @param {string} containerName
 * @param {object} document - must include 'id' and the '_etag' it was read with
 * @param {object} [options]
 * @param {string} [options.partitionKey] - defaults to the document id
 * @returns {Promise<object>} the document after the write
 * @throws {{code: 412}} when the document changed since it was read
 */
export async function replaceDocIfMatch(containerName, document, options = {}) {
  const container = getContainer(containerName);
  const pk = resolvePartitionKey(containerName, options.partitionKey, document.id);
  const { resource } = await container
    .item(document.id, pk)
    .replace(document, { accessCondition: { type: 'IfMatch', condition: document._etag } });
  return resource;
}

/**
 * Add to a numeric field atomically, but only if the document still satisfies a
 * predicate.
 *
 * This is the one primitive Cosmos offers that a read-modify-write cannot
 * emulate, and the reason it exists here is a counter that was wrong under
 * concurrency in the expensive direction: the submission quota read the count,
 * compared it, and wrote it back as three separate operations, so N simultaneous
 * requests all read the same value, all passed the limit check, and all wrote
 * `count: 1` — N accepted against a limit of five (T-204).
 *
 * Both halves are needed and neither is sufficient alone:
 *
 *  - `incr` is applied server-side, so the increment cannot be lost. On its own
 *    it would still let every caller past the limit, because nobody checked.
 *  - `condition` is a SQL `FROM ... WHERE` predicate evaluated against the
 *    stored document in the same atomic operation as the patch. On its own it
 *    is just an ETag with extra steps.
 *
 * Together they are a compare-and-increment: writes to one document serialize
 * within its partition, so exactly the callers that observe a passing predicate
 * get their increment, and the rest get 412.
 *
 * **The predicate is a raw SQL fragment — there is no parameter binding for it
 * in the REST API or the SDK.** Never interpolate caller-controlled text into
 * it. `conditionValues` exists so the common case (numeric bounds) cannot be
 * written unsafely: values are checked as finite numbers and substituted for
 * `@name` placeholders, and anything else throws.
 *
 * **`incr` fails on a path that is absent or non-numeric** — "Node(PATH) isn't
 * a number", a 400, not a silent no-op. The documented "creates the field if it
 * doesn't exist" behaviour does not extend to a path holding a string. The
 * practical consequence is that a caller must make the predicate imply the
 * field is a number: a bound like `c.count < @limit` does this for free, since
 * a comparison against a missing or non-numeric property is undefined and
 * therefore does not match. Take that away and a malformed document turns into
 * a 400 on a hot path.
 *
 * Note also that the JS SDK's own documentation tab omits conditional patch —
 * only the .NET, Java and Python tabs show it. It does work: `PatchRequestBody`
 * is typed `{operations, condition?}` and `ClientContext.patch` forwards the
 * body verbatim to the REST API, whose documented shape is exactly that.
 *
 * @param {string} containerName
 * @param {string} id
 * @param {object} options
 * @param {string} options.path - JSON Pointer to the numeric field, e.g. `/count`
 * @param {number} [options.value] - amount to add; may be negative. Default 1.
 * @param {string} options.condition - `FROM c WHERE ...` with `@name` placeholders
 * @param {Record<string, number>} [options.conditionValues] - numeric bindings
 * @param {string} [options.partitionKey] - defaults to id
 * @returns {Promise<object>} the document after the increment
 * @throws {{code: 412}} when the predicate did not hold
 * @throws {{code: 404}} when the document does not exist
 */
export async function incrementIf(containerName, id, options) {
  const { path, value = 1, condition, conditionValues, partitionKey } = options ?? {};
  if (!path?.startsWith('/')) {
    throw new Error(`incrementIf: path must be a JSON Pointer, got ${JSON.stringify(path)}`);
  }

  const container = getContainer(containerName);
  const pk = resolvePartitionKey(containerName, partitionKey, id);
  const { resource } = await container.item(id, pk).patch({
    condition: bindConditionValues(condition, conditionValues),
    operations: [{ op: 'incr', path, value }],
  });
  return resource;
}

/**
 * Substitute numeric bindings into a patch predicate.
 *
 * Exported for its own tests because it is the safety property of
 * `incrementIf`, and a safety property that is only exercised through a live
 * Cosmos account is one that is not exercised.
 *
 * Non-numeric values are refused rather than quoted. Quoting is where string
 * interpolation into SQL goes wrong, and nothing in this repository needs a
 * string binding here — the day something does, it should be a deliberate
 * change to this function with its own tests, not an accident.
 */
export function bindConditionValues(condition, values = {}) {
  if (typeof condition !== 'string' || condition.trim() === '') {
    throw new Error('incrementIf: condition is required');
  }

  return condition.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`incrementIf: condition references @${name} with no value`);
    }
    const value = values[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `incrementIf: @${name} must be a finite number, got ${JSON.stringify(value)}`
      );
    }
    return String(value);
  });
}

/**
 * Create a document, failing if the id is already taken.
 *
 * `upsertDoc` cannot express this: it replaces whatever is there, so two
 * callers racing to initialise the same document both "succeed" and one
 * silently discards the other's write. `items.create` is the Cosmos operation
 * that has a loser, and a caller that needs to know it lost — the quota's
 * first-request-in-a-window path — needs the 409.
 *
 * @param {string} containerName
 * @param {object} document - must include 'id'
 * @returns {Promise<object>} the created document
 * @throws {{code: 409}} when a document with that id already exists
 */
export async function createDoc(containerName, document) {
  const container = getContainer(containerName);
  const { resource } = await container.items.create(document);
  return resource;
}

/**
 * Cosmos rejects a patch specification with more than ten operations:
 * "The number of patch operations can't exceed 10."
 * https://learn.microsoft.com/azure/cosmos-db/partial-document-update-faq
 */
export const MAX_PATCH_OPERATIONS = 10;

/** Cosmos refuses to patch these, and Firestore never exposed them. */
const SYSTEM_PROPERTIES = new Set(['id', '_id', '_ts', '_etag', '_rid', '_self', '_attachments']);

/**
 * Convert a Firestore field path to a JSON Pointer.
 *
 * Firestore addresses nested fields with dots — `.update({ 'a.b': 1 })` — while
 * Cosmos wants `/a/b`. Per RFC 6902, `~` and `/` inside a property NAME escape
 * to `~0` and `~1`; the escaping must happen per segment, after the split, or a
 * legitimate dotted path would escape its own separators.
 */
export function toJsonPointer(fieldPath) {
  return `/${String(fieldPath)
    .split('.')
    .map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')}`;
}

/**
 * Partially update a document, leaving absent fields untouched.
 *
 * Equivalent to: admin.firestore().collection(name).doc(id).update(updates)
 *
 * Two execution paths, because Cosmos's patch API cannot express Firestore's
 * update semantics in every case:
 *
 *  - **Patch** (<= 10 operations, no deletions). One round trip, and
 *    conflict-resolved per PATH across regions rather than per document, so two
 *    writers touching different fields do not clobber each other.
 *  - **Read-modify-write with ETag** otherwise. Used when the update exceeds the
 *    ten-operation ceiling, or deletes a field. Deletion needs this because
 *    Cosmos `remove` FAILS on an absent path ("Node(PATH) to be removed is
 *    absent") while Firestore's `FieldValue.delete()` on a missing field is a
 *    no-op — routing deletions through RMW keeps the Firestore behaviour that 48
 *    call sites already depend on.
 *
 * The RMW path is guarded by `_etag` (`ifMatch`), so a concurrent write loses
 * with a 412 rather than silently overwriting. It retries once, because the
 * common case is two handlers touching the same document in the same second.
 *
 * Chunking a >10-operation update into several patch calls is deliberately NOT
 * done: it would drop atomicity silently, which is the same class of bug as the
 * upsert-as-merge comment above.
 *
 * @param {string} containerName
 * @param {string} id
 * @param {Record<string, any>} updates - field path -> value. `undefined` deletes.
 * @param {object} [options]
 * @param {string} [options.partitionKey] - defaults to id
 * @param {string} [options.ifMatch] - an `_etag` read earlier. The write then
 *   fails with 412 if the document changed in between, instead of overwriting.
 *   Use it when the update was *decided* from a document read earlier in the
 *   handler — the RMW path's own ETag only protects the read it performs
 *   itself, which is a much narrower window and re-reads on conflict rather
 *   than telling the caller. The scheduled publisher needs the wider guard,
 *   because the timer and an operator can both act on one document
 *   (T-301).
 * @returns {Promise<object>} the document after the write
 */
export async function patchDoc(containerName, id, updates, options = {}) {
  const plan = planPatch(updates);
  if (plan.strategy === 'noop') {
    return readDoc(containerName, id, options.partitionKey);
  }

  const container = getContainer(containerName);
  const pk = resolvePartitionKey(containerName, options.partitionKey, id);
  const accessCondition = options.ifMatch
    ? { accessCondition: { type: 'IfMatch', condition: options.ifMatch } }
    : undefined;

  if (plan.strategy === 'patch') {
    const { resource } = await container.item(id, pk).patch(plan.operations, accessCondition);
    return resource;
  }

  // A caller-supplied ETag makes the retry wrong: retrying re-reads, which is
  // exactly the "decide from a stale document" the caller asked to prevent.
  return readModifyWrite(container, id, pk, plan.entries, options.ifMatch ? 1 : 0, options.ifMatch);
}

/**
 * Decide how a set of updates must be written, and build the operations.
 *
 * Split out from `patchDoc` and exported because it is the part with the rules
 * in it — the ten-operation ceiling, the deletion carve-out, the system-property
 * refusal — and it is pure, so it is testable without a Cosmos account. The
 * house style in this directory is dependency injection over mocking
 * (`createRoleGuard`), and this follows it.
 *
 * @param {Record<string, any>} updates
 * @returns {{strategy: 'noop'} | {strategy: 'patch', operations: object[], entries: [string, any][]} | {strategy: 'rmw', entries: [string, any][], reason: string}}
 */
export function planPatch(updates) {
  const entries = Object.entries(updates ?? {});
  if (entries.length === 0) return { strategy: 'noop' };

  for (const [field] of entries) {
    const root = String(field).split('.')[0];
    if (SYSTEM_PROPERTIES.has(root)) {
      throw new Error(`patchDoc: refusing to modify system property ${JSON.stringify(root)}`);
    }
  }

  const hasDeletion = entries.some(([, value]) => value === undefined);
  if (hasDeletion) {
    return { strategy: 'rmw', entries, reason: 'deletion' };
  }
  if (entries.length > MAX_PATCH_OPERATIONS) {
    return { strategy: 'rmw', entries, reason: 'exceeds-operation-limit' };
  }

  return {
    strategy: 'patch',
    entries,
    operations: entries.map(([field, value]) => ({
      op: 'set',
      path: toJsonPointer(field),
      value,
    })),
  };
}

/**
 * ETag-guarded read-modify-write, applying dotted field paths onto a copy.
 * One retry: a 412 means someone else wrote between our read and our replace,
 * and re-reading resolves it unless the document is genuinely hot.
 */
async function readModifyWrite(container, id, pk, entries, attempt = 0, ifMatch = null) {
  const { resource: current } = await container.item(id, pk).read();
  if (!current) {
    throw new Error(`patchDoc: document ${id} does not exist`);
  }
  // The caller decided this update from an earlier read. If the document moved
  // since then, applying the update to what we just read would write a
  // decision made about a document that no longer exists.
  if (ifMatch && current._etag !== ifMatch) {
    throw Object.assign(new Error(`patchDoc: ${id} changed since it was read`), { code: 412 });
  }

  const next = structuredClone(current);
  for (const [field, value] of entries) {
    applyFieldPath(next, String(field).split('.'), value);
  }

  try {
    const { resource } = await container
      .item(id, pk)
      .replace(next, { accessCondition: { type: 'IfMatch', condition: current._etag } });
    return resource;
  } catch (err) {
    if (err.code === 412 && attempt === 0) {
      return readModifyWrite(container, id, pk, entries, attempt + 1, ifMatch);
    }
    throw err;
  }
}

/**
 * Set or delete a dotted path on a plain object, creating intermediates.
 * Exported for tests — it is the half of the read-modify-write path that can be
 * checked without a Cosmos account.
 */
export function applyFieldPath(target, segments, value) {
  const last = segments[segments.length - 1];
  let cursor = target;

  for (const segment of segments.slice(0, -1)) {
    if (cursor[segment] === null || typeof cursor[segment] !== 'object') {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }

  if (value === undefined) {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
}

/**
 * Delete a document by ID.
 * Equivalent to: admin.firestore().collection(name).doc(id).delete()
 *
 * @param {string} containerName
 * @param {string} id
 * @param {string} [partitionKey]
 */
export async function deleteDoc(containerName, id, partitionKey) {
  const container = getContainer(containerName);
  await container.item(id, resolvePartitionKey(containerName, partitionKey, id)).delete();
}

/**
 * Delete a document only if it is still the version that was read: the
 * delete counterpart of `patchDoc(..., { ifMatch })`. Throws the SDK's 412
 * when the document changed since `etag` was read, and its 404 when it is
 * already gone, so a caller that decided "this may be deleted" from a read
 * cannot delete a document that has since moved on (the Drafts stage,
 * lib/cms/drafts-handlers.js: a draft sent to review in another tab).
 *
 * @param {string} containerName
 * @param {string} id
 * @param {string} etag - the `_etag` read earlier
 * @param {string} [partitionKey]
 */
export async function deleteDocIfMatch(containerName, id, etag, partitionKey) {
  if (!etag) throw new Error('deleteDocIfMatch: an etag is required');
  const container = getContainer(containerName);
  await container
    .item(id, resolvePartitionKey(containerName, partitionKey, id))
    .delete({ accessCondition: { type: 'IfMatch', condition: etag } });
}

/**
 * Query documents with SQL.
 * Equivalent to: admin.firestore().collection(name).where(...).orderBy(...).limit(n).get()
 *
 * `fetchAll()` is NOT a single page. It loops until the query is exhausted,
 * accumulating every page in memory — it consumes the continuation token
 * rather than discarding it, so results are never silently truncated. (T-311
 * claimed the opposite; the SDK's `toArrayImplementation` shows otherwise.)
 *
 * The consequence that matters is the other one: an unbounded query
 * materialises the whole result set in the handler. That is why callers supply
 * `TOP` in the SQL — the bounded-window rule in the public-reads header, and
 * the ceilings added for the anonymous feed (T-203). The only queries here
 * without `TOP` are `SELECT VALUE COUNT(1)` aggregates, which return one row.
 *
 * There is deliberately no cursor API. Adding one is a real feature — it would
 * let callers page rather than window — and belongs with T-206, not here.
 *
 * @param {string} containerName
 * @param {string} query - Cosmos DB SQL query
 * @param {Array<{name: string, value: any}>} [parameters]
 * @param {object} [options]
 * @param {number} [options.maxItemCount] - page size for the internal loop
 * @param {string} [options.partitionKey] - scope to one logical partition
 *   instead of fanning out across all of them. Only correct when the query's
 *   predicate matches the container's partition key (T-312).
 * @returns {Promise<object[]>}
 */
export async function queryDocs(containerName, query, parameters = [], options = {}) {
  const container = getContainer(containerName);
  const feedOptions = { maxItemCount: options.maxItemCount };
  if (options.partitionKey !== undefined && options.partitionKey !== null) {
    feedOptions.partitionKey = options.partitionKey;
  }
  const { resources } = await container.items.query({ query, parameters }, feedOptions).fetchAll();
  return resources;
}

/**
 * Query documents with SQL and return a single page with its continuation token (AP-B11).
 *
 * @param {string} containerName
 * @param {string} query - Cosmos DB SQL query
 * @param {Array<{name: string, value: any}>} [parameters]
 * @param {object} [options]
 * @param {number} [options.maxItemCount] - maximum items per page
 * @param {string} [options.continuationToken] - continuation token from previous page
 * @param {string} [options.partitionKey] - scope to one logical partition
 * @returns {Promise<{ resources: object[], continuationToken: string|null, hasMoreResults: boolean }>}
 */
export async function queryDocsPage(containerName, query, parameters = [], options = {}) {
  const container = getContainer(containerName);
  const feedOptions = {
    maxItemCount: options.maxItemCount || options.limit || 50,
  };
  if (options.continuationToken) {
    feedOptions.continuationToken = options.continuationToken;
  }
  if (options.partitionKey !== undefined && options.partitionKey !== null) {
    feedOptions.partitionKey = options.partitionKey;
  }
  const response = await container.items.query({ query, parameters }, feedOptions).fetchNext();
  return {
    resources: response.resources || [],
    continuationToken: response.continuationToken || null,
    hasMoreResults: response.hasMoreResults ?? false,
  };
}

/**
 * Validate a WHERE clause fragment for countDocs.
 * Rejects illegal SQL injection vectors such as semicolons, comments, or union statements.
 *
 * @param {string|undefined} whereClause
 * @returns {string} Sanitized whereClause
 */
export function validateWhereClause(whereClause) {
  if (!whereClause) return '';
  const trimmed = String(whereClause).trim();
  if (!trimmed) return '';

  if (/;|--|\/\*|\*\/|union\s+all|union\s+select/i.test(trimmed)) {
    throw new Error('countDocs: whereClause contains illegal or unsafe characters');
  }

  return trimmed;
}

/**
 * Count documents matching a query.
 * Equivalent to: admin.firestore().collection(name).count().get()
 *
 * @param {string} containerName
 * @param {string} [whereClause] - SQL WHERE clause (omit 'WHERE')
 * @param {Array<{name: string, value: any}>} [parameters]
 * @returns {Promise<number>}
 */
export async function countDocs(containerName, whereClause, parameters = []) {
  const container = getContainer(containerName);
  const sanitizedWhere = validateWhereClause(whereClause);
  const query = sanitizedWhere
    ? `SELECT VALUE COUNT(1) FROM c WHERE ${sanitizedWhere}`
    : 'SELECT VALUE COUNT(1) FROM c';
  const { resources } = await container.items.query({ query, parameters }).fetchAll();
  return resources[0] || 0;
}



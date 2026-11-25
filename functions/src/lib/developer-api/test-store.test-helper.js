/**
 * An in-memory stand-in for the cosmos-client functions the Developer API
 * uses, for its tests only. Point operations keep the real contracts that
 * matter here: createDoc answers 409 on a taken id, replaceDocIfMatch and
 * deleteDocIfMatch answer 412 on a stale `_etag`, and incrementIf evaluates the quota's predicate
 * (`windowStartMs > @windowFloor AND count < @limit`) the way Cosmos would.
 */
let etagCounter = 0;
const nextEtag = () => `"etag-${(etagCounter += 1)}"`;
const codeError = (code) => Object.assign(new Error(`cosmos ${code}`), { code });

const key = (id, pk) => `${pk ?? id}|${id}`;
const clone = (value) => (value == null ? value : structuredClone(value));
/** The partition key this store files a document under when the caller does not name one. */
const partitionOf = (doc) => doc.eventId ?? doc.configScope ?? doc.id;

function tableOf(containers, name) {
  if (!containers.has(name)) containers.set(name, new Map());
  return containers.get(name);
}

function put(containers, name, doc, pk) {
  const stored = { ...clone(doc), _etag: nextEtag() };
  tableOf(containers, name).set(key(doc.id, pk), stored);
  return clone(stored);
}

/** The stored document for a write that must find one under a matching `_etag`; 404 or 412 otherwise. */
function currentFor(containers, name, id, pk, etag) {
  const current = tableOf(containers, name).get(key(id, pk));
  if (!current) throw codeError(404);
  if (current._etag !== etag) throw codeError(412);
  return current;
}

function incrementIf(store, containers, name, id, { path, value = 1, conditionValues = {} }) {
  const current = tableOf(containers, name).get(key(id, id));
  if (!current) throw codeError(404);
  const field = path.slice(1);
  const { windowFloor = -Infinity, limit = Infinity } = conditionValues;
  if (!(current.windowStartMs > windowFloor && current[field] < limit)) throw codeError(412);
  return store.put(name, { ...current, [field]: current[field] + value }, id);
}

/**
 * Filters on the parameters this API passes and on `c.field = 'literal'`
 * terms in the SQL; nothing else in the SQL is read.
 */
function queryDocs(containers, name, query, parameters = [], options = {}) {
  const params = Object.fromEntries(parameters.map((p) => [p.name.slice(1), p.value]));
  for (const [, field, value] of String(query).matchAll(/c\.(\w+) = '([^']*)'/g)) params[field] = value;
  return [...tableOf(containers, name).values()]
    .filter((doc) => options.partitionKey === undefined || partitionOf(doc) === options.partitionKey)
    .filter((doc) => Object.entries(params).every(([field, value]) => doc[field] === value))
    .map(clone);
}

/** Where a page starts: 0, or this store's own `skip:<n>` token; any other token is the database's 400. */
function skipOf(continuationToken) {
  if (!continuationToken) return 0;
  const match = /^skip:(\d+)$/.exec(continuationToken);
  if (!match) throw codeError(400);
  return Number(match[1]);
}

/**
 * One page of queryDocs, the way cosmos-client's queryDocsPage answers:
 * `ORDER BY c.<field> DESC` is honoured, `maxItemCount` is the page size,
 * and the continuation token is this store's own (`skip:<n>`). A token of
 * any other shape is answered 400, as the database answers one it did not
 * issue.
 */
async function queryDocsPage(store, name, query, parameters = [], options = {}) {
  const skip = skipOf(options.continuationToken);
  const rows = await store.queryDocs(name, query, parameters, options);
  const order = /ORDER BY c\.(\w+) DESC/.exec(String(query));
  if (order) rows.sort((a, b) => String(b[order[1]]).localeCompare(String(a[order[1]])));
  const size = options.maxItemCount || 50;
  const resources = rows.slice(skip, skip + size);
  const more = skip + size < rows.length;
  return { resources, continuationToken: more ? `skip:${skip + size}` : null, hasMoreResults: more };
}

export function createTestStore() {
  const containers = new Map();
  const store = {
    containers,
    /** Every document in a container, as stored. */
    all: (name) => [...tableOf(containers, name).values()].map(clone),
    put: (name, doc, pk) => put(containers, name, doc, pk),
    readDoc: async (name, id, pk) => clone(tableOf(containers, name).get(key(id, pk)) ?? null),
    async createDoc(name, doc) {
      const pk = partitionOf(doc);
      if (tableOf(containers, name).has(key(doc.id, pk))) throw codeError(409);
      return store.put(name, doc, pk);
    },
    upsertDoc: async (name, doc) => store.put(name, doc, partitionOf(doc)),
    async replaceDocIfMatch(name, doc, options) {
      const pk = options?.partitionKey ?? doc.id;
      currentFor(containers, name, doc.id, pk, doc._etag);
      return store.put(name, doc, pk);
    },
    async deleteDocIfMatch(name, id, etag, pk) {
      if (!etag) throw new Error('deleteDocIfMatch: an etag is required');
      currentFor(containers, name, id, pk, etag);
      tableOf(containers, name).delete(key(id, pk));
    },
    async patchDoc(name, id, updates, options = {}) {
      const pk = options.partitionKey ?? id;
      const current = tableOf(containers, name).get(key(id, pk));
      if (!current) throw codeError(404);
      return store.put(name, { ...current, ...updates }, pk);
    },
    incrementIf: async (name, id, change) => incrementIf(store, containers, name, id, change),
    queryDocs: async (...args) => queryDocs(containers, ...args),
    queryDocsPage: (...args) => queryDocsPage(store, ...args),
  };
  return store;
}

/** A Functions-shaped request. */
export function makeRequest({ method = 'GET', headers = {}, params = {}, query = {}, body } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method,
    params,
    query: new Map(Object.entries(query)),
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(raw),
    text: async () => raw,
  };
}

export const testContext = () => ({ log: () => {}, warn: () => {}, error: () => {}, invocationId: 'test' });

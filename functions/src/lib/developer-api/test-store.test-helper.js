/**
 * An in-memory stand-in for the cosmos-client functions the Developer API
 * uses, for its tests only. Point operations keep the real contracts that
 * matter here: createDoc answers 409 on a taken id, replaceDocIfMatch answers
 * 412 on a stale `_etag`, and incrementIf evaluates the quota's predicate
 * (`windowStartMs > @windowFloor AND count < @limit`) the way Cosmos would.
 */
let etagCounter = 0;
const nextEtag = () => `"etag-${(etagCounter += 1)}"`;
const codeError = (code) => Object.assign(new Error(`cosmos ${code}`), { code });

export function createTestStore() {
  const containers = new Map();
  const table = (name) => {
    if (!containers.has(name)) containers.set(name, new Map());
    return containers.get(name);
  };
  const key = (id, pk) => `${pk ?? id}|${id}`;
  const clone = (value) => (value == null ? value : structuredClone(value));

  const store = {
    containers,
    /** Every document in a container, as stored. */
    all: (name) => [...table(name).values()].map(clone),
    put(name, doc, pk) {
      const stored = { ...clone(doc), _etag: nextEtag() };
      table(name).set(key(doc.id, pk), stored);
      return clone(stored);
    },
    async readDoc(name, id, pk) {
      return clone(table(name).get(key(id, pk)) ?? null);
    },
    async createDoc(name, doc) {
      const pk = doc.eventId ?? doc.configScope ?? doc.id;
      if (table(name).has(key(doc.id, pk))) throw codeError(409);
      return store.put(name, doc, pk);
    },
    async upsertDoc(name, doc) {
      const pk = doc.eventId ?? doc.configScope ?? doc.id;
      return store.put(name, doc, pk);
    },
    async replaceDocIfMatch(name, doc, options) {
      const pk = options?.partitionKey ?? doc.id;
      const current = table(name).get(key(doc.id, pk));
      if (!current) throw codeError(404);
      if (current._etag !== doc._etag) throw codeError(412);
      return store.put(name, doc, pk);
    },
    async patchDoc(name, id, updates, options = {}) {
      const pk = options.partitionKey ?? id;
      const current = table(name).get(key(id, pk));
      if (!current) throw codeError(404);
      return store.put(name, { ...current, ...updates }, pk);
    },
    async incrementIf(name, id, { path, value = 1, conditionValues = {} }) {
      const current = table(name).get(key(id, id));
      if (!current) throw codeError(404);
      const field = path.slice(1);
      const { windowFloor = -Infinity, limit = Infinity } = conditionValues;
      if (!(current.windowStartMs > windowFloor && current[field] < limit)) throw codeError(412);
      return store.put(name, { ...current, [field]: current[field] + value }, id);
    },
    /**
     * Filters on the parameters this API passes and on `c.field = 'literal'`
     * terms in the SQL; nothing else in the SQL is read.
     */
    async queryDocs(name, query, parameters = [], options = {}) {
      const params = Object.fromEntries(parameters.map((p) => [p.name.slice(1), p.value]));
      for (const [, field, value] of String(query).matchAll(/c\.(\w+) = '([^']*)'/g)) params[field] = value;
      return [...table(name).values()]
        .filter((doc) => options.partitionKey === undefined || (doc.eventId ?? doc.configScope ?? doc.id) === options.partitionKey)
        .filter((doc) => Object.entries(params).every(([field, value]) => doc[field] === value))
        .map(clone);
    },
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

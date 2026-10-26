/**
 * An in-memory Cosmos for tests, with real ETag semantics: a replace with a
 * stale `_etag` is a 412 and a create over an existing id a 409, as
 * cosmos-client.js's verbs answer. Documents are keyed by container and id;
 * every read returns a copy, so a test cannot change the store by accident.
 *
 * `fail(container, id, verb)` makes the next calls of one verb on one
 * document throw (a read that fails, a write that loses a race), for the
 * paths a real store reaches only under load; for `queryDocs` the id is
 * `*`. The same shape as labs/coder-automation.test.js's makeStore, across
 * containers.
 *
 * `queryDocs` answers with `query({ container, query, parameters, docs })`
 * when one is given (docs are copies of that container's documents), and
 * with no rows otherwise: an in-memory store cannot run Cosmos SQL, so a test
 * that queries says what Cosmos would answer (test/mcp-projection.js).
 */
import { vi } from 'vitest';
import { assertReplaceDocIfMatchCall } from '../src/lib/cosmos-call-shape.js';

export function memoryStore(initial = {}, { query = null } = {}) {
  const docs = new Map();
  const failures = new Map();
  let etag = 0;
  const key = (container, id) => `${container}/${id}`;
  const stamp = (doc) => ({ ...structuredClone(doc), _etag: `"e${++etag}"` });
  for (const [path, doc] of Object.entries(initial)) docs.set(path, stamp(doc));

  const docsIn = (container) =>
    [...docs.entries()].filter(([path]) => path.startsWith(`${container}/`)).map(([, doc]) => doc);
  const maybeFail = (container, id, verb) => {
    const queue = failures.get(`${verb}:${key(container, id)}`);
    const error = queue?.shift();
    if (error) throw error;
  };

  const store = {
    docs,
    audit: [],
    get: (container, id) => docs.get(key(container, id)) ?? null,
    /** Queue errors for the next `times` calls of `verb` on one document. */
    fail(container, id, verb, error, times = 1) {
      const name = `${verb}:${key(container, id)}`;
      failures.set(name, [...(failures.get(name) ?? []), ...Array.from({ length: times }, () => error)]);
    },
    readDoc: vi.fn(async (container, id) => {
      maybeFail(container, id, 'readDoc');
      const doc = docs.get(key(container, id));
      return doc ? structuredClone(doc) : null;
    }),
    createDoc: vi.fn(async (container, doc) => {
      maybeFail(container, doc.id, 'createDoc');
      if (docs.has(key(container, doc.id))) throw Object.assign(new Error('conflict'), { code: 409 });
      docs.set(key(container, doc.id), stamp(doc));
      return structuredClone(docs.get(key(container, doc.id)));
    }),
    replaceDocIfMatch: vi.fn(async (container, doc, options) => {
      // The real function's argument shape, from the module the real function
      // checks with: a store that accepted `(container, id, doc, etag)` once let
      // a call the real store cannot take pass every test (#1383).
      assertReplaceDocIfMatchCall(container, doc, options);
      maybeFail(container, doc.id, 'replaceDocIfMatch');
      if (docs.get(key(container, doc.id))?._etag !== doc._etag) {
        throw Object.assign(new Error('precondition'), { code: 412 });
      }
      docs.set(key(container, doc.id), stamp(doc));
      return structuredClone(docs.get(key(container, doc.id)));
    }),
    queryDocs: vi.fn(async (container, sql, parameters = []) => {
      maybeFail(container, '*', 'queryDocs');
      if (!query) return [];
      const copies = docsIn(container).map((doc) => structuredClone(doc));
      return query({ container, query: sql, parameters, docs: copies });
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      maybeFail(container, doc.id, 'upsertDoc');
      if (container === 'admin_audit_logs') store.audit.push(structuredClone(doc));
      else docs.set(key(container, doc.id), stamp(doc));
      return doc;
    }),
  };
  return store;
}

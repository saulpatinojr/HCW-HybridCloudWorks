/**
 * An in-memory Cosmos for the Doc Vault tests, with the real client's
 * conditional writes: a replace, patch or delete under a stale etag is a 412,
 * a missing document a 404, a create over an existing id a 409.
 *
 * It answers only the vault's own queries (handlers.js exports each one as a
 * constant, and this store compares the text), interpreting them in code. It
 * refuses any container but `doc_vault` and the audit container, so a handler
 * that reached for another one fails the test that made it.
 *
 * `fail(verb, error, { times, where })` makes the next calls of one verb throw,
 * for the paths a real store reaches only under load or when it is down.
 */
import { vi } from 'vitest';
import {
  EXPIRED_TRASH_QUERY,
  FIND_BY_KEY_QUERY,
  LIST_ACTIVE_QUERY,
  LIST_TRASH_QUERY,
  VERSIONS_QUERY,
  VERSION_IDS_QUERY,
} from '../src/lib/doc-vault/handlers.js';

const AUDIT = 'admin_audit_logs';
const VAULT = 'doc_vault';

export const failure = (code) => Object.assign(new Error(`store ${code}`), { code });

const isTrashed = (doc) => doc.deletedAt !== undefined && doc.deletedAt !== null;

export function vaultStore(seed = []) {
  const docs = new Map();
  const audit = [];
  const touched = new Set();
  const failures = [];
  let etag = 0;
  const stamp = (doc) => ({ ...structuredClone(doc), _etag: `"e${++etag}"` });
  for (const doc of seed) docs.set(doc.id, stamp(doc));

  const check = (container, verb) => {
    touched.add(container);
    if (container !== VAULT && container !== AUDIT) {
      throw new Error(`unexpected container ${container}`);
    }
    const at = failures.findIndex((f) => f.verb === verb && f.times > 0);
    if (at >= 0) {
      failures[at].times -= 1;
      throw failures[at].error;
    }
  };
  const param = (parameters, name) => parameters.find((p) => p.name === name)?.value;

  const run = (sql, parameters) => {
    const all = [...docs.values()].map((doc) => structuredClone(doc));
    const type = param(parameters, '@docType');
    const ofType = all.filter((doc) => doc.docType === type);
    if (sql === LIST_ACTIVE_QUERY) {
      return ofType
        .filter((doc) => !isTrashed(doc))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    if (sql === LIST_TRASH_QUERY) {
      return ofType
        .filter(isTrashed)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    if (sql === FIND_BY_KEY_QUERY) {
      return ofType.filter((doc) => doc.dedupeKey === param(parameters, '@key')).slice(0, 2);
    }
    if (sql === VERSIONS_QUERY) {
      return ofType
        .filter((doc) => doc.documentId === param(parameters, '@id'))
        .sort((a, b) => b.version - a.version);
    }
    if (sql === VERSION_IDS_QUERY) {
      return ofType
        .filter((doc) => doc.documentId === param(parameters, '@id'))
        .map((doc) => ({ id: doc.id, version: doc.version }));
    }
    if (sql === EXPIRED_TRASH_QUERY) {
      return ofType
        .filter((doc) => isTrashed(doc) && doc.deletedAt < param(parameters, '@cutoff'))
        .slice(0, 20)
        .map((doc) => ({ id: doc.id }));
    }
    throw new Error(`unexpected query ${sql}`);
  };

  const store = {
    docs,
    audit,
    touched,
    get: (id) => docs.get(id) ?? null,
    /** Every stored document, as JSON text: for a test that looks for a string anywhere. */
    dump: () => JSON.stringify([...docs.values()]),
    fail(verb, error, { times = 1 } = {}) {
      failures.push({ verb, error, times });
    },
    queryDocs: vi.fn(async (container, sql, parameters = []) => {
      check(container, 'queryDocs');
      return run(sql, parameters);
    }),
    readDoc: vi.fn(async (container, id) => {
      check(container, 'readDoc');
      const doc = docs.get(id);
      return doc ? structuredClone(doc) : null;
    }),
    createDoc: vi.fn(async (container, doc) => {
      check(container, 'createDoc');
      if (docs.has(doc.id)) throw failure(409);
      docs.set(doc.id, stamp(doc));
      return structuredClone(docs.get(doc.id));
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      check(container, 'upsertDoc');
      if (container === AUDIT) audit.push(structuredClone(doc));
      else docs.set(doc.id, stamp(doc));
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      check(container, 'replaceDocIfMatch');
      const stored = docs.get(doc.id);
      if (!stored) throw failure(404);
      if (stored._etag !== doc._etag) throw failure(412);
      docs.set(doc.id, stamp(doc));
      return structuredClone(docs.get(doc.id));
    }),
    patchDoc: vi.fn(async (container, id, updates, options = {}) => {
      check(container, 'patchDoc');
      const stored = docs.get(id);
      if (!stored) throw failure(404);
      if (options.ifMatch && options.ifMatch !== stored._etag) throw failure(412);
      docs.set(id, stamp({ ...stored, ...updates }));
      return structuredClone(docs.get(id));
    }),
    deleteDoc: vi.fn(async (container, id) => {
      check(container, 'deleteDoc');
      if (!docs.has(id)) throw failure(404);
      docs.delete(id);
    }),
    deleteDocIfMatch: vi.fn(async (container, id, ifMatch) => {
      check(container, 'deleteDocIfMatch');
      const stored = docs.get(id);
      if (!stored) throw failure(404);
      if (stored._etag !== ifMatch) throw failure(412);
      docs.delete(id);
    }),
  };
  return store;
}

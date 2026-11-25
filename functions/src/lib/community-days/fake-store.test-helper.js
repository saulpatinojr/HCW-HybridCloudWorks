/**
 * A small in-memory stand-in for the Cosmos helpers the Community Days
 * modules use, for their tests. It keeps the one behaviour those modules
 * depend on: a document is replaced or deleted only under the ETag (version
 * stamp) it was read at, and created only when it does not exist. A lost
 * race throws an error with `code: 412` (or 409 on create, 404 when gone),
 * as the real helpers do.
 */
import { vi } from 'vitest';

/** Store `doc` under `name` and hand it back. */
function keep(docs, name, doc) {
  docs.set(name, doc);
  return doc;
}

export function fakeStore(initial = []) {
  const docs = new Map();
  let version = 0;
  const key = (container, id) => `${container}/${id}`;
  const stamp = (doc) => ({ ...doc, _etag: `"etag-${(version += 1)}"` });
  const fail = (code) => Object.assign(new Error(`store ${code}`), { code });
  for (const [container, doc] of initial) docs.set(key(container, doc.id), stamp(doc));

  const store = {
    docs,
    get: (container, id) => docs.get(key(container, id)) ?? null,
    put: (container, doc) => keep(docs, key(container, doc.id), stamp(doc)),
    readDoc: vi.fn(async (container, id) => {
      const doc = docs.get(key(container, id));
      return doc ? structuredClone(doc) : null;
    }),
    createDoc: vi.fn(async (container, doc) => {
      if (docs.has(key(container, doc.id))) throw fail(409);
      return structuredClone(store.put(container, doc));
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      const current = docs.get(key(container, doc.id));
      if (!current) throw fail(404);
      if (current._etag !== doc._etag) throw fail(412);
      return structuredClone(store.put(container, doc));
    }),
    deleteDocIfMatch: vi.fn(async (container, id, etag) => {
      const current = docs.get(key(container, id));
      if (!current) throw fail(404);
      if (current._etag !== etag) throw fail(412);
      docs.delete(key(container, id));
    }),
    queryDocs: vi.fn(async (container, query) => {
      const rows = [...docs.entries()].filter(([name]) => name.startsWith(`${container}/`)).map(([, doc]) => structuredClone(doc));
      // The notes query filters by docType; the topics query reads every row.
      const type = /c\.docType = @type/.test(query) ? 'community_days_event_note' : null;
      return type ? rows.filter((doc) => doc.docType === type) : rows;
    }),
    upsertDoc: vi.fn(async (container, doc) => structuredClone(store.put(container, doc))),
  };
  return store;
}

/** A made-up event in the shape events.js keeps. */
export const cachedEvent = (over = {}) => ({
  id: 'event-1',
  title: 'Example Community Day 2027',
  tagline: 'A free day of talks',
  url: 'https://www.communitydays.org/event/2027-03-06/example-community-day-2027',
  website: 'https://example.org/day',
  startDate: '2027-03-06',
  endDate: '2027-03-07',
  timezone: 'America/Toronto',
  eventType: 'In Person',
  venue: 'Example Hall',
  city: 'Exampleville',
  region: 'Ontario',
  country: 'CA',
  costTiers: ['Free'],
  callUrl: 'https://example.org/speak',
  callOpens: '2026-11-01',
  callCloses: '2027-01-15',
  cancelled: false,
  postponed: false,
  lastUpdate: '2026-11-12T10:41:37.000Z',
  pageText: 'Join us for a day of cloud and platform engineering talks.',
  ...over,
});

/**
 * The shared daily cap (lib/daily-cap.js), extracted from the explain
 * route's quota for the public lab submission (#672). What must hold: the
 * first call of a day creates the counter at 1 with the caller's id, kind
 * and ttl; every later call is one compare-and-increment; the cap refuses;
 * a lost race to create goes round to the increment; and a store fault
 * propagates rather than reading as "allowed".
 */
import { describe, expect, it, vi } from 'vitest';

import { takeDailyCap } from './daily-cap.js';

const cosmosError = (code) => Object.assign(new Error(`cosmos ${code}`), { code });

function counterStore() {
  const docs = new Map();
  return {
    docs,
    incrementIf: vi.fn(async (_container, id, { value, conditionValues }) => {
      const doc = docs.get(id);
      if (!doc) throw cosmosError(404);
      if (!(doc.count < conditionValues.limit)) throw cosmosError(412);
      doc.count += value;
      return doc;
    }),
    createDoc: vi.fn(async (_container, doc) => {
      if (docs.has(doc.id)) throw cosmosError(409);
      docs.set(doc.id, { ...doc });
      return doc;
    }),
  };
}

const args = (over = {}) => ({
  container: 'tool_service_cache',
  id: 'cap:2026-09-27',
  kind: 'cap',
  day: '2026-09-27',
  nowIso: '2026-09-27T12:00:00.000Z',
  limit: 3,
  ttlSeconds: 172_800,
  ...over,
});

describe('takeDailyCap', () => {
  it('creates the day’s counter on the first call, with the caller’s id, kind and ttl', async () => {
    const store = counterStore();
    expect(await takeDailyCap(store, args())).toBe(true);
    expect(store.createDoc).toHaveBeenCalledWith('tool_service_cache', {
      id: 'cap:2026-09-27',
      kind: 'cap',
      day: '2026-09-27',
      count: 1,
      createdAt: '2026-09-27T12:00:00.000Z',
      ttl: 172_800,
    });
  });

  it('allows exactly the limit and refuses the next', async () => {
    const store = counterStore();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await takeDailyCap(store, args()));
    expect(results).toEqual([true, true, true, false, false]);
    expect(store.docs.get('cap:2026-09-27').count).toBe(3);
  });

  it('goes round to the increment when another instance created the counter first', async () => {
    const store = counterStore();
    store.createDoc.mockImplementationOnce(async (_c, doc) => {
      store.docs.set(doc.id, { ...doc, count: 1 });
      throw cosmosError(409);
    });
    expect(await takeDailyCap(store, args())).toBe(true);
    expect(store.docs.get('cap:2026-09-27').count).toBe(2);
  });

  it('gives up as refused after three lost races', async () => {
    const store = counterStore();
    store.createDoc.mockRejectedValue(cosmosError(409));
    expect(await takeDailyCap(store, args())).toBe(false);
    expect(store.incrementIf).toHaveBeenCalledTimes(3);
  });

  it('propagates a store fault from either operation', async () => {
    const failingIncrement = counterStore();
    failingIncrement.incrementIf.mockRejectedValue(cosmosError(503));
    await expect(takeDailyCap(failingIncrement, args())).rejects.toMatchObject({ code: 503 });

    const failingCreate = counterStore();
    failingCreate.createDoc.mockRejectedValue(cosmosError(500));
    await expect(takeDailyCap(failingCreate, args())).rejects.toMatchObject({ code: 500 });
  });
});

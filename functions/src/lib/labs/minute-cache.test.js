import { describe, expect, it, vi } from 'vitest';

import { CACHE_CONTAINER } from '../cloud-tools/history.js';
import { createMinuteCache, MINUTE_CACHE_SECONDS } from './minute-cache.js';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const context = { warn: vi.fn(), error: vi.fn() };

/** A store stand-in with a missing document and a succeeding write, unless overridden. */
const makeStore = (over = {}) => ({
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, d) => d),
  ...over,
});

/** A minute cache over `store` with a fixed clock. */
const cacheFor = (store, now = () => NOW) =>
  createMinuteCache({ store, id: 'labs:test', kind: 'labs-test', now });

describe('createMinuteCache', () => {
  it('reads the document by id as its own partition key, from tool_service_cache', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'labs:test', value: { a: 1 }, cachedAt: new Date(NOW - 10_000).toISOString() })),
    });
    expect(await cacheFor(store).read(context)).toEqual({ a: 1 });
    expect(store.readDoc).toHaveBeenCalledWith(CACHE_CONTAINER, 'labs:test', 'labs:test');
  });

  it('is a miss when nothing is stored', async () => {
    expect(await cacheFor(makeStore()).read(context)).toBeNull();
  });

  it('is a miss once the entry is a minute old, whatever Cosmos TTL has got round to', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'labs:test', value: { a: 1 }, cachedAt: new Date(NOW - 60_000).toISOString() })),
    });
    expect(await cacheFor(store).read(context)).toBeNull();
  });

  it('is a miss when the stamp is missing or unparseable, or the value was never written', async () => {
    for (const doc of [
      { id: 'labs:test', value: { a: 1 } },
      { id: 'labs:test', value: { a: 1 }, cachedAt: 'yesterday-ish' },
      { id: 'labs:test', cachedAt: new Date(NOW).toISOString() },
    ]) {
      const store = makeStore({ readDoc: vi.fn(async () => doc) });
      expect(await cacheFor(store).read(context)).toBeNull();
    }
  });

  it('treats a failed read as a miss and says so at warn, by class and code rather than message', async () => {
    const warn = vi.fn();
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw Object.assign(new Error('cosmos down at https://cosmos.example/dbs/x'), { code: 'ECONNRESET' });
      }),
    });
    expect(await cacheFor(store).read({ warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache read failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('name=Error code=ECONNRESET'));
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/cosmos down|https?:\/\//);
  });

  it('writes id, kind, value, the stamp and a one-minute ttl', async () => {
    const store = makeStore();
    await cacheFor(store).write({ b: 2 }, context);
    expect(store.upsertDoc).toHaveBeenCalledWith(CACHE_CONTAINER, {
      id: 'labs:test',
      kind: 'labs-test',
      value: { b: 2 },
      cachedAt: new Date(NOW).toISOString(),
      ttl: MINUTE_CACHE_SECONDS,
    });
  });

  it('never throws from a failed write, and logs the failure without its message', async () => {
    const warn = vi.fn();
    const store = makeStore({ upsertDoc: vi.fn(async () => { throw new Error('write refused'); }) });
    await expect(cacheFor(store).write({ b: 2 }, { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache write failed'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('write refused');
  });
});

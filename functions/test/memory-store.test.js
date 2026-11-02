import { describe, expect, it } from 'vitest';
import { runCosmosQuery } from './cosmos-predicate.js';
import { memoryStore } from './memory-store.js';

/**
 * The shared test store's `replaceDocIfMatch` (#1383). It stands in for
 * cosmos-client.js's function in a large part of the suite, so it has to refuse
 * what the real one refuses: a store that accepted any argument order let two
 * wrong calls in production pass every test.
 */
describe('memoryStore replaceDocIfMatch', () => {
  const seeded = () => memoryStore({ 'lab_jobs/sess-1': { id: 'sess-1', status: 'active' } });

  it('replaces a document read under the same ETag, and hands out a new ETag', async () => {
    const store = seeded();
    const read = await store.readDoc('lab_jobs', 'sess-1');

    const written = await store.replaceDocIfMatch('lab_jobs', { ...read, status: 'ended' }, { partitionKey: 'sess-1' });

    expect(written).toMatchObject({ id: 'sess-1', status: 'ended' });
    expect(written._etag).not.toBe(read._etag);
    expect(store.get('lab_jobs', 'sess-1').status).toBe('ended');
  });

  it('answers 412 for a document read before someone else wrote', async () => {
    const store = seeded();
    const stale = await store.readDoc('lab_jobs', 'sess-1');
    await store.replaceDocIfMatch('lab_jobs', { ...stale, note: 'first writer' });

    await expect(store.replaceDocIfMatch('lab_jobs', { ...stale, status: 'ended' })).rejects.toMatchObject({
      code: 412,
    });
    expect(store.get('lab_jobs', 'sess-1')).toMatchObject({ note: 'first writer', status: 'active' });
  });

  it('refuses the old (container, id, document, etag) shape with a TypeError, and writes nothing', async () => {
    const store = seeded();
    const read = await store.readDoc('lab_jobs', 'sess-1');

    await expect(
      store.replaceDocIfMatch('lab_jobs', 'sess-1', { ...read, status: 'ended' }, read._etag)
    ).rejects.toThrow(TypeError);

    expect(store.get('lab_jobs', 'sess-1')).toEqual(read);
    expect([...store.docs.keys()]).toEqual(['lab_jobs/sess-1']);
  });

  it('refuses a document with no ETag instead of answering 412 for it', async () => {
    const store = seeded();

    await expect(store.replaceDocIfMatch('lab_jobs', { id: 'sess-1', status: 'ended' })).rejects.toThrow(TypeError);
  });

  it('refuses an options argument that is not an object', async () => {
    const store = seeded();
    const read = await store.readDoc('lab_jobs', 'sess-1');

    await expect(store.replaceDocIfMatch('lab_jobs', read, 'sess-1')).rejects.toThrow(TypeError);
  });
});

/**
 * Ageing out, as Cosmos's time to live does (#1403, item 8): the visitor
 * session records live 2 hours once over and 7 days while they wait, and a
 * mistake in either would not have failed a test while this store kept every
 * document for ever.
 */
describe('memoryStore with a clock: documents age out by their ttl', () => {
  it('keeps a document until its ttl has passed since its last write, then it is gone for every verb', async () => {
    let nowMs = Date.parse('2026-10-31T00:00:00Z');
    const store = memoryStore({}, { now: () => nowMs, query: runCosmosQuery });
    await store.createDoc('lab_jobs', { id: 'a', type: 't', ttl: 60 });

    nowMs += 59_000;
    expect(await store.readDoc('lab_jobs', 'a')).not.toBeNull();
    nowMs += 1_000;
    expect(await store.readDoc('lab_jobs', 'a')).toBeNull();
    expect(store.get('lab_jobs', 'a')).toBeNull();
    expect(await store.queryDocs('lab_jobs', 'SELECT * FROM c WHERE c.type = @t', [{ name: '@t', value: 't' }])).toEqual([]);
  });

  it('counts the ttl from the last write, so a document that is written again lives on', async () => {
    let nowMs = Date.parse('2026-10-31T00:00:00Z');
    const store = memoryStore({}, { now: () => nowMs });
    const created = await store.createDoc('lab_jobs', { id: 'a', ttl: 60 });
    nowMs += 50_000;
    await store.replaceDocIfMatch('lab_jobs', { ...created, note: 'again' }, { partitionKey: 'a' });
    nowMs += 50_000;
    expect(await store.readDoc('lab_jobs', 'a')).toMatchObject({ note: 'again' });
  });

  it('answers 404 to a replace of a document that has aged out, and lets a create take its id', async () => {
    let nowMs = Date.parse('2026-10-31T00:00:00Z');
    const store = memoryStore({}, { now: () => nowMs });
    const created = await store.createDoc('lab_jobs', { id: 'a', ttl: 60 });
    nowMs += 61_000;
    await expect(store.replaceDocIfMatch('lab_jobs', created, { partitionKey: 'a' })).rejects.toMatchObject({ code: 404 });
    await expect(store.createDoc('lab_jobs', { id: 'a' })).resolves.toMatchObject({ id: 'a' });
  });

  it('ages nothing without a clock', async () => {
    const store = memoryStore({ 'lab_jobs/a': { id: 'a', ttl: 1 } });
    expect(await store.readDoc('lab_jobs', 'a')).not.toBeNull();
  });
});

describe('runCosmosQuery runs the text of a query, with its parameters', () => {
  const docs = [
    { id: '1', type: 'v', status: 'active', expiresAt: '2026-10-31T01:00:00Z' },
    { id: '2', type: 'v', status: 'cleanup_pending', retryAt: '2026-10-31T00:30:00Z' },
    { id: '3', type: 'other', status: 'active', expiresAt: '2026-10-31T00:00:00Z' },
  ];

  it('reads =, <=, > and ARRAY_CONTAINS against parameters', () => {
    const ids = (query, parameters) => runCosmosQuery({ query, parameters, docs }).map((d) => d.id);
    expect(
      ids('SELECT * FROM c WHERE c.type = @type AND c.expiresAt <= @now', [
        { name: '@type', value: 'v' },
        { name: '@now', value: '2026-10-31T02:00:00Z' },
      ])
    ).toEqual(['1']);
    expect(
      ids('SELECT * FROM c WHERE ARRAY_CONTAINS(@statuses, c.status) AND c.retryAt > @now', [
        { name: '@statuses', value: ['cleanup_pending', 'ending'] },
        { name: '@now', value: '2026-10-31T00:00:00Z' },
      ])
    ).toEqual(['2']);
  });

  it('does not match a missing field, as Cosmos does not', () => {
    const rows = runCosmosQuery({
      query: 'SELECT * FROM c WHERE c.retryAt <= @now',
      parameters: [{ name: '@now', value: '2099-01-01T00:00:00Z' }],
      docs,
    });
    expect(rows.map((d) => d.id)).toEqual(['2']);
  });

  it('throws on a query it cannot read, and on a parameter the query names and nobody gives', () => {
    expect(() => runCosmosQuery({ query: 'SELECT c.id FROM c', docs })).toThrow(/unreadable query/);
    expect(() => runCosmosQuery({ query: 'SELECT * FROM c WHERE c.type == @t', parameters: [{ name: '@t', value: 'v' }], docs })).toThrow(
      /unreadable/
    );
    expect(() => runCosmosQuery({ query: 'SELECT * FROM c WHERE c.type = @t', docs })).toThrow(/no parameter/);
  });
});

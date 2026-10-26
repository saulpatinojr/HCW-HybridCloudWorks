import { describe, expect, it } from 'vitest';
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

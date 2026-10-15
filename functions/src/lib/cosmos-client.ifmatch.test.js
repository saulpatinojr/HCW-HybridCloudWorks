/**
 * `patchDoc`'s optional ETag precondition, tested against a mocked SDK.
 *
 * Separate file because it needs `@azure/cosmos` replaced, and
 * `cosmos-client.test.js` deliberately covers only the pure decision rules.
 *
 * It exists at all for the reason T-104 taught: `publish.test.js` asserts that
 * `processPublishContent` *passes* `{ ifMatch }`, against a fake store that
 * would accept any option name at all. If this module ignored the option, that
 * test would stay green while two concurrent runs both published — which is
 * precisely the outcome the precondition is for (T-301).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const item = vi.hoisted(() => ({
  patch: vi.fn(async () => ({ resource: { id: 'c1' } })),
  read: vi.fn(async () => ({ resource: { id: 'c1', _etag: '"live"', a: 1 } })),
  replace: vi.fn(async () => ({ resource: { id: 'c1' } })),
  delete: vi.fn(async () => ({})),
}));

vi.mock('@azure/cosmos', () => ({
  CosmosClient: class {
    database() {
      return { container: () => ({ item: () => item }) };
    }
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));

const { patchDoc, deleteDocIfMatch } = await import('./cosmos-client.js');

describe('patchDoc ifMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';
  });

  it('sends no access condition when the caller does not ask for one', async () => {
    await patchDoc('content', 'c1', { Live: true });
    expect(item.patch.mock.calls[0][1]).toBeUndefined();
  });

  it('sends If-Match on the patch path when the caller supplies an etag', async () => {
    await patchDoc('content', 'c1', { Live: true }, { ifMatch: '"abc"' });
    expect(item.patch.mock.calls[0][1]).toEqual({
      accessCondition: { type: 'IfMatch', condition: '"abc"' },
    });
  });

  it('refuses the read-modify-write path when the document moved', async () => {
    // >10 operations forces RMW. The document read there is fresh, so without
    // this check the update — decided from a document the caller read
    // earlier — would be applied on top of someone else's write.
    const updates = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}`, i])
    );
    await expect(patchDoc('content', 'c1', updates, { ifMatch: '"stale"' })).rejects.toMatchObject({
      code: 412,
    });
    expect(item.replace).not.toHaveBeenCalled();
  });

  it('answers a document gone before the read-modify-write with a 404, as the patch path does', async () => {
    // A deletion routes through read-modify-write, whose read answers a
    // missing item with no resource; a caller that skips a deleted document
    // on 404 (cms/content-update.js, the linked blogs) must see one here too.
    item.read.mockResolvedValueOnce({ resource: undefined });
    await expect(
      patchDoc('blogs', 'b1', { Status: undefined }, { ifMatch: '"live"' })
    ).rejects.toMatchObject({ code: 404 });
    expect(item.replace).not.toHaveBeenCalled();
  });

  it('proceeds through read-modify-write when the etag still matches', async () => {
    const updates = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}`, i])
    );
    await patchDoc('content', 'c1', updates, { ifMatch: '"live"' });
    expect(item.replace).toHaveBeenCalledTimes(1);
  });

  it('does not retry a conflict when the caller supplied an etag', async () => {
    // The default RMW behaviour retries once by re-reading, which is exactly
    // the "decide from a document that has since changed" the caller asked to
    // prevent. Retrying here would defeat the precondition.
    item.replace.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 412 }));
    const updates = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}`, i])
    );

    await expect(patchDoc('content', 'c1', updates, { ifMatch: '"live"' })).rejects.toMatchObject({
      code: 412,
    });
    expect(item.replace).toHaveBeenCalledTimes(1);
  });

  it('still retries a conflict once when no etag was supplied', async () => {
    // The pre-existing behaviour, unchanged: two handlers touching the same
    // document in the same second is the common case.
    item.replace.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 412 }));
    const updates = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}`, i])
    );

    await patchDoc('content', 'c1', updates);
    expect(item.replace).toHaveBeenCalledTimes(2);
  });
});

/**
 * The delete counterpart (the Drafts stage, lib/cms/drafts-handlers.js). A
 * fake store in the handler tests would accept any option at all, so this is
 * what proves the condition actually reaches the SDK.
 */
describe('deleteDocIfMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';
  });

  it('sends If-Match with the etag the caller read', async () => {
    await deleteDocIfMatch('content', 'c1', '"abc"');
    expect(item.delete).toHaveBeenCalledWith({
      accessCondition: { type: 'IfMatch', condition: '"abc"' },
    });
  });

  it('refuses to delete unconditionally when no etag is given', async () => {
    await expect(deleteDocIfMatch('content', 'c1', '')).rejects.toThrow(/etag is required/);
    expect(item.delete).not.toHaveBeenCalled();
  });

  it("passes the SDK's 412 through rather than retrying", async () => {
    item.delete.mockRejectedValueOnce(Object.assign(new Error('precondition'), { code: 412 }));
    await expect(deleteDocIfMatch('content', 'c1', '"stale"')).rejects.toMatchObject({
      code: 412,
    });
    expect(item.delete).toHaveBeenCalledTimes(1);
  });
});

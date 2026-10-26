/**
 * `replaceDocIfMatch`'s arguments, tested against a mocked SDK (#1383).
 *
 * Separate file because it needs `@azure/cosmos` replaced, as
 * `cosmos-client.ifmatch.test.js` does for `patchDoc`.
 *
 * The visitor sessions called `replaceDocIfMatch('lab_jobs', session.id,
 * {...session, status}, session._etag)`. Nothing stopped them: the function
 * read `document.id` off the string it was handed, got `undefined`, and went on
 * to ask the SDK to replace a document that did not exist. These tests hold the
 * real function to two things: a correct call reaches the SDK carrying the
 * whole document, the partition key and the ETag as an `If-Match` condition,
 * and a call in any other shape is refused before the SDK is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  replace: vi.fn(async (document) => ({ resource: { ...document, _etag: '"after"' } })),
  item: vi.fn(),
}));

vi.mock('@azure/cosmos', () => ({
  CosmosClient: class {
    database() {
      return {
        container: () => ({
          item: (...args) => {
            sdk.item(...args);
            return { replace: sdk.replace };
          },
        }),
      };
    }
  },
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));

const { replaceDocIfMatch } = await import('./cosmos-client.js');

const session = () => ({ id: 'sess-1', _etag: '"read"', type: 'visitor-session', status: 'active' });

describe('replaceDocIfMatch arguments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';
  });

  it('sends the whole document to the SDK, under the ETag it was read with', async () => {
    const document = { ...session(), status: 'ended' };

    const written = await replaceDocIfMatch('lab_jobs', document, { partitionKey: 'sess-1' });

    expect(sdk.item).toHaveBeenCalledWith('sess-1', 'sess-1');
    expect(sdk.replace).toHaveBeenCalledWith(document, {
      accessCondition: { type: 'IfMatch', condition: '"read"' },
    });
    expect(written).toMatchObject({ id: 'sess-1', status: 'ended', _etag: '"after"' });
  });

  it('defaults the partition key to the document id for a container partitioned on /id', async () => {
    await replaceDocIfMatch('lab_jobs', session());

    expect(sdk.item).toHaveBeenCalledWith('sess-1', 'sess-1');
  });

  it('refuses the old visitor-session shape, (container, id, document, etag), before the SDK is touched', async () => {
    const doc = session();

    await expect(
      replaceDocIfMatch('lab_jobs', doc.id, { ...doc, status: 'ended' }, doc._etag)
    ).rejects.toThrow(TypeError);
    await expect(replaceDocIfMatch('lab_jobs', doc.id, { ...doc, status: 'ended' })).rejects.toThrow(
      /document must be the whole document/
    );

    expect(sdk.item).not.toHaveBeenCalled();
    expect(sdk.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['a document with no ETag', ['lab_jobs', { id: 'sess-1' }]],
    ['a document with no id', ['lab_jobs', { _etag: '"read"' }]],
    ['a bare partition key as the options', ['lab_jobs', session(), 'sess-1']],
    ['a document as the options', ['lab_jobs', session(), session()]],
  ])('refuses %s', async (_name, args) => {
    await expect(replaceDocIfMatch(...args)).rejects.toThrow(TypeError);

    expect(sdk.item).not.toHaveBeenCalled();
    expect(sdk.replace).not.toHaveBeenCalled();
  });
});

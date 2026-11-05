/**
 * What interviews-upload-http.js wires into its handlers (#1565).
 *
 * The routes themselves are covered by route-inventory.test.js and
 * api-contract.test.js; this pins the DEPENDENCIES: a handler handed
 * `commitBlockList` without `deleteBlob` or `hashBlobSha256` registers, passes
 * the inventory, and then either keeps a wrong file or never checks it.
 */
import { describe, it, expect, vi } from 'vitest';

const registrations = new Map();
vi.mock('../lib/auth/http-route.js', () => ({
  httpRoute: (name, options) => registrations.set(name, options),
  httpRouteByMethod: (name, { handlers, ...options }) =>
    registrations.set(name, { ...options, methods: Object.keys(handlers), handler: handlers.PUT }),
}));
vi.mock('../lib/auth/default-guard.js', () => ({
  getDefaultGuard: () => ({ requireRole: vi.fn() }),
}));
const storageSpies = {
  stageBlock: vi.fn(),
  commitBlockList: vi.fn(),
  hashBlobSha256: vi.fn(),
  deleteBlob: vi.fn(),
};
vi.mock('../lib/blob-storage.js', () => ({
  stageBlock: (...args) => storageSpies.stageBlock(...args),
  commitBlockList: (...args) => storageSpies.commitBlockList(...args),
  hashBlobSha256: (...args) => storageSpies.hashBlobSha256(...args),
  deleteBlob: (...args) => storageSpies.deleteBlob(...args),
}));
vi.mock('../lib/cosmos-client.js', () => ({ readDoc: vi.fn(), queryDocs: vi.fn(), patchDoc: vi.fn() }));

const created = [];
vi.mock('../lib/interviews/upload.js', () => ({
  createInterviewUploadHandlers: (deps) => {
    created.push(deps);
    return {
      openUpload: vi.fn(async () => ({ status: 201 })),
      putBlock: vi.fn(async () => ({ status: 200 })),
      completeUpload: vi.fn(async () => ({ status: 200 })),
    };
  },
}));

await import('./interviews-upload-http.js');

describe('interviews-upload-http registrations', () => {
  it('registers the three routes with their verbs and no queue output', () => {
    const open = registrations.get('cmsInterviewUploads');
    const block = registrations.get('cmsInterviewUploadBlock');
    const complete = registrations.get('cmsInterviewUploadComplete');
    expect(open).toMatchObject({ route: 'cms/interviews/uploads', methods: ['POST'] });
    expect(block).toMatchObject({ route: 'cms/interviews/uploads/{uploadId}/blocks/{index}', methods: ['PUT'] });
    expect(complete).toMatchObject({ route: 'cms/interviews/uploads/{uploadId}/complete', methods: ['POST'] });
    for (const spec of [open, block, complete]) expect(spec.extraOutputs).toBeUndefined();
  });

  it('hands the handlers the full storage seam, including deleteBlob and hashBlobSha256', async () => {
    await registrations.get('cmsInterviewUploadComplete').handler({}, {});
    const deps = created.at(-1);
    for (const name of ['stageBlock', 'commitBlockList', 'hashBlobSha256', 'deleteBlob']) {
      expect(typeof deps.storage[name], name).toBe('function');
      await deps.storage[name]('interviews-audio', 'audio/x.mp3');
      expect(storageSpies[name]).toHaveBeenCalledWith('interviews-audio', 'audio/x.mp3');
    }
    for (const name of ['readDoc', 'queryDocs', 'patchDoc']) expect(typeof deps.store[name], name).toBe('function');
    expect(typeof deps.guard.requireRole).toBe('function');
  });
});

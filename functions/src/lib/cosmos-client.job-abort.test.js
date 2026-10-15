/**
 * cosmos-client.js under a platform job's deadline (#942 follow-up), against
 * a mocked SDK.
 *
 * patchDoc's read-modify-write path reads the document and then replaces
 * it. The guard at the top of patchDoc runs before the read, so a deadline
 * that passes DURING the read (or during the re-read after a 412) is only
 * seen if the guard runs again before the replace. These tests hold the read
 * open, fire the job's abort while it is pending, and check what reaches the
 * SDK afterwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const item = vi.hoisted(() => ({
  read: vi.fn(),
  replace: vi.fn(async (doc) => ({ resource: doc })),
}));

vi.mock('@azure/cosmos', () => ({
  CosmosClient: class {
    database() {
      return { container: () => ({ item: () => item }) };
    }
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {}, ManagedIdentityCredential: class {} }));

process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';

const { patchDoc } = await import('./cosmos-client.js');
const { runAsJob } = await import('./job-context.js');

const timeoutReason = () => Object.assign(new Error('job timed out'), { code: 'JOB_TIMEOUT' });
const stored = () => ({ resource: { id: 'c1', _etag: '"e1"', Status: 'draft', a: 1 } });

/** A read that answers only when `release` is called. */
function slowRead() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  item.read.mockImplementationOnce(async () => {
    await gate;
    return stored();
  });
  return () => release();
}

/** Resolves once `fn` has been called `times` times. */
async function calledTimes(fn, times) {
  while (fn.mock.calls.length < times) await new Promise((resolve) => setTimeout(resolve, 1));
}

beforeEach(() => {
  vi.clearAllMocks();
  item.read.mockImplementation(async () => stored());
});

describe('the read-modify-write path checks the job again before its replace (#942)', () => {
  it('refuses the replace when the deadline passed while the read was pending', async () => {
    const job = new AbortController();
    const release = slowRead();
    const write = runAsJob(job.signal, () => patchDoc('content', 'c1', { Status: undefined }));
    await calledTimes(item.read, 1);
    job.abort(timeoutReason());
    release();
    await expect(write).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    expect(item.replace).not.toHaveBeenCalled();
  });

  it('refuses the second replace when the deadline passed during the re-read after a 412', async () => {
    const job = new AbortController();
    item.replace.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 412 }));
    item.read.mockImplementationOnce(async () => stored());
    const release = slowRead();
    const write = runAsJob(job.signal, () => patchDoc('content', 'c1', { Status: undefined }));
    await calledTimes(item.read, 2);
    job.abort(timeoutReason());
    release();
    await expect(write).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    expect(item.replace).toHaveBeenCalledTimes(1);
  });

  it('still replaces a kept container, and anything while the job is live or outside a job', async () => {
    const job = new AbortController();
    const release = slowRead();
    const kept = runAsJob(job.signal, () =>
      patchDoc('content_versions', 'v1', { note: undefined }, { partitionKey: 'c1' })
    );
    await calledTimes(item.read, 1);
    job.abort(timeoutReason());
    release();
    await kept;
    expect(item.replace).toHaveBeenCalledTimes(1);

    await runAsJob(new AbortController().signal, () => patchDoc('content', 'c1', { Status: undefined }));
    await patchDoc('content', 'c1', { Status: undefined });
    expect(item.replace).toHaveBeenCalledTimes(3);
  });
});

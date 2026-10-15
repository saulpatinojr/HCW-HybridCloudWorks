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
 *
 * The other half: a write already dispatched when the abort fires runs to
 * completion. The job's signal is never handed to the SDK, because cancelling
 * a dispatched write on the client leaves it applied by the service and
 * rejected to the job, an uncertain commit (review of #1199).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const item = vi.hoisted(() => ({
  read: vi.fn(),
  replace: vi.fn(async (doc) => ({ resource: doc })),
  patch: vi.fn(async () => ({ resource: { id: 'c1' } })),
  delete: vi.fn(async () => ({})),
}));
const items = vi.hoisted(() => ({
  upsert: vi.fn(async (doc) => ({ resource: doc })),
  create: vi.fn(async (doc) => ({ resource: doc })),
}));

vi.mock('@azure/cosmos', () => ({
  CosmosClient: class {
    database() {
      return { container: () => ({ item: () => item, items }) };
    }
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {}, ManagedIdentityCredential: class {} }));

process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';

const { createDoc, deleteDoc, deleteDocIfMatch, incrementIf, patchDoc, replaceDocIfMatch, upsertDoc } =
  await import('./cosmos-client.js');
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

describe('a write already dispatched when the job aborts runs to completion (#942)', () => {
  const ACCESS = { accessCondition: { type: 'IfMatch', condition: '"e1"' } };
  /** Every argument any SDK write method was called with. */
  const writeArguments = () =>
    [
      ...items.upsert.mock.calls,
      ...items.create.mock.calls,
      ...item.patch.mock.calls,
      ...item.replace.mock.calls,
      ...item.delete.mock.calls,
    ].flat();
  const carriesSignal = (argument) =>
    argument !== null && typeof argument === 'object' && 'abortSignal' in argument;

  it('hands the SDK no abortSignal on any write path inside a job, so each call is what it was before', async () => {
    const job = new AbortController();
    await runAsJob(job.signal, async () => {
      await upsertDoc('content', { id: 'c1' });
      await createDoc('content', { id: 'c2' });
      await patchDoc('content', 'c1', { a: 2 }, { ifMatch: '"e1"' });
      await incrementIf('content', 'c1', { path: '/n', condition: 'FROM c WHERE c.n < 5' });
      await patchDoc('content', 'c1', { a: undefined });
      await replaceDocIfMatch('content', { id: 'c1', _etag: '"e1"' });
      await deleteDoc('content', 'c1');
      await deleteDocIfMatch('content', 'c1', '"e1"');
    });
    expect(writeArguments().filter(carriesSignal)).toEqual([]);
    expect(items.upsert.mock.calls[0]).toEqual([{ id: 'c1' }]);
    expect(items.create.mock.calls[0]).toEqual([{ id: 'c2' }]);
    expect(item.patch.mock.calls[0][1]).toEqual(ACCESS);
    expect(item.patch.mock.calls[1]).toHaveLength(1);
    expect(item.replace.mock.calls.map(([, options]) => options)).toEqual([ACCESS, ACCESS]);
    expect(item.delete.mock.calls).toEqual([[], [ACCESS]]);
  });

  it('lets a write in flight at the abort finish, then refuses the next write that starts', async () => {
    // The mocked SDK answers as Cosmos does when handed an abortSignal: the
    // service applies the write, and the client promise rejects if the
    // signal fired while the request was pending (an uncertain commit).
    const applied = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    items.upsert.mockImplementationOnce(async (doc, options) => {
      applied.push(doc.id);
      await gate;
      if (options?.abortSignal?.aborted) {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      }
      return { resource: doc };
    });
    const job = new AbortController();
    await runAsJob(job.signal, async () => {
      const inFlight = upsertDoc('content', { id: 'c1' });
      await calledTimes(items.upsert, 1);
      job.abort(timeoutReason());
      release();
      await expect(inFlight).resolves.toEqual({ id: 'c1' });
      await expect(upsertDoc('content', { id: 'c2' })).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    });
    expect(applied).toEqual(['c1']);
    expect(items.upsert).toHaveBeenCalledTimes(1);
  });
});

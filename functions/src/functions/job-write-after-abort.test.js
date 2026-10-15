/**
 * #942's own acceptance: a timed-out job's side effects stop. Under #1198 a
 * worker checks its signal at chosen points and hands it to the libraries it
 * calls, but its Cosmos and Blob writes go through the shared clients, which
 * never saw it, so a write that STARTS after the job is recorded `timeout`
 * still lands. The publish-podcast-transcript worker is the example here:
 * its transcript read outlives the budget, and the patch it makes next went
 * through after the job was over.
 *
 * The follow-up refuses such a write in the shared clients themselves
 * (lib/job-context.js): runJob runs the worker inside the job's context,
 * and cosmos-client.js and blob-storage.js refuse a write that starts there
 * once the signal has fired. Nothing is re-threaded through the workers.
 *
 * The real cosmos-client.js runs here over a mocked SDK; the registry, the
 * worker and runJob are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  slowRead: null,
  transcript: { id: 'article_x', status: 'published', host: {}, _etag: '"t1"' },
  patches: [],
  upserts: [],
}));
vi.mock('@azure/cosmos', () => ({
  CosmosClient: class {
    database() {
      return {
        container: (name) => ({
          item: (id) => ({
            read: async () => {
              // Only the worker's read is slow; the hook's read after the
              // timeout answers at once.
              if (name === 'podcast_transcripts' && sdk.slowRead) {
                const wait = sdk.slowRead;
                sdk.slowRead = null;
                await wait;
              }
              return { resource: name === 'podcast_transcripts' ? structuredClone(sdk.transcript) : null };
            },
            patch: async (operations) => {
              sdk.patches.push({ name, id, operations });
              return { resource: { id } };
            },
          }),
          items: {
            upsert: async (doc) => {
              sdk.upserts.push({ name, doc });
              return { resource: doc };
            },
          },
        }),
      };
    }
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {}, ManagedIdentityCredential: class {} }));

process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';
delete process.env.PODBEAN_CLIENT_ID;
delete process.env.PODBEAN_CLIENT_SECRET;

const { createJobHandlers, getJobType } = await import('../lib/jobs.js');
await import('./podcast-jobs.js');
const cosmos = await import('../lib/cosmos-client.js');

/** A jobs container in memory, for runJob's own claim and terminal write. */
function jobsStore() {
  const docs = {
    'j-pod': {
      id: 'j-pod',
      type: 'publish-podcast-transcript',
      payload: { transcriptId: 'article_x' },
      status: 'queued',
      attempts: 0,
      _etag: '"j"',
    },
  };
  return {
    docs,
    readDoc: async (_c, id) => (docs[id] ? { ...docs[id] } : null),
    replaceDocIfMatch: async (_c, doc) => {
      docs[doc.id] = { ...doc, _etag: '"j2"' };
      return docs[doc.id];
    },
    patchDoc: async (_c, id, updates) => {
      docs[id] = { ...docs[id], ...updates };
      return docs[id];
    },
  };
}

beforeEach(() => {
  sdk.patches.length = 0;
  sdk.upserts.length = 0;
  sdk.slowRead = null;
});

describe('a write that starts after a job is recorded timeout (#942)', () => {
  it('is refused by the shared client, so the timed-out publish leaves the transcript alone', async () => {
    let release;
    sdk.slowRead = new Promise((resolve) => {
      release = resolve;
    });
    const store = jobsStore();
    const handlers = createJobHandlers({
      guard: { requireRole: vi.fn() },
      store,
      types: new Map([
        ['publish-podcast-transcript', { ...getJobType('publish-podcast-transcript'), timeoutMs: 20 }],
      ]),
    });

    const outcome = await handlers.runJob({ jobId: 'j-pod' }, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(outcome).toEqual({ jobId: 'j-pod', outcome: 'timeout' });
    expect(store.docs['j-pod'].status).toBe('timeout');

    // The worker's read now answers, after the job is over; what it would
    // write next (the skipped record, Podbean being unconfigured here) must
    // not land.
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sdk.patches).toEqual([]);
  });

  it('is not refused outside a job, so routes, timers and the hooks write as before', async () => {
    await cosmos.patchDoc('podcast_transcripts', 'article_x', { title: 'x' });
    await cosmos.upsertDoc('content', { id: 'c1' });
    expect(sdk.patches).toHaveLength(1);
    expect(sdk.upserts).toHaveLength(1);
  });

  it('is refused for every write a timed-out job starts, except a usage row or an MCP token', async () => {
    const { runAsJob } = await import('../lib/job-context.js');
    const job = new AbortController();
    job.abort(Object.assign(new Error('job timed out'), { code: 'JOB_TIMEOUT' }));
    await runAsJob(job.signal, async () => {
      await expect(cosmos.upsertDoc('content', { id: 'c1' })).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(cosmos.createDoc('content', { id: 'c2' })).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(cosmos.patchDoc('content', 'c1', { a: 1 })).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(
        cosmos.replaceDocIfMatch('content', { id: 'c1', _etag: '"e"' })
      ).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(
        cosmos.incrementIf('content', 'c1', { path: '/n', condition: 'FROM c WHERE c.n < 5' })
      ).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(cosmos.deleteDoc('content', 'c1')).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(cosmos.deleteDocIfMatch('content', 'c1', '"e"')).rejects.toMatchObject({
        code: 'JOB_TIMEOUT',
      });
      // Spend already billed, and a token already rotated, are kept.
      await cosmos.upsertDoc('ai_usage', { id: 'u1' });
      await cosmos.patchDoc('mcp_servers', 'plaud', { oauthRefreshToken: 'rt-2' });
      // Reads are not writes.
      await expect(cosmos.readDoc('content', 'c1')).resolves.toBeNull();
    });
    expect(sdk.upserts.map(({ name }) => name)).toEqual(['ai_usage']);
    expect(sdk.patches.map(({ name }) => name)).toEqual(['mcp_servers']);
  });
});

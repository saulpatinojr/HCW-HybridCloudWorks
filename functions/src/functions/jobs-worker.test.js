import { describe, it, expect, vi } from 'vitest';

const queues = new Map();
vi.mock('@azure/functions', () => ({
  app: { storageQueue: (name, options) => queues.set(name, options) },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));
vi.mock('../lib/auth/default-guard.js', () => ({ getDefaultGuard: () => ({}) }));
vi.mock('../lib/cosmos-client.js', () => ({ readDoc: vi.fn(), upsertDoc: vi.fn(), patchDoc: vi.fn(), replaceDocIfMatch: vi.fn() }));
const runJob = vi.fn();
vi.mock('../lib/jobs.js', () => ({
  JOBS_QUEUE: 'platform-jobs',
  createJobHandlers: () => ({ runJob }),
}));

await import('./jobs-worker.js');
const worker = queues.get('platformJobWorker');

describe('platformJobWorker', () => {
  it('has the jobs queue as an output, so a job can queue follow-up jobs', () => {
    expect(worker.extraOutputs).toEqual([{ type: 'queue', queueName: 'platform-jobs', connection: 'AzureWebJobsStorage' }]);
  });

  it('sends what the job queued once it has finished, and nothing when it queued nothing', async () => {
    runJob.mockImplementationOnce(async (_message, _context, io) => {
      io.enqueue({ jobId: 'next-1', type: 'content-archive-container' });
      io.enqueue({ jobId: 'next-2', type: 'content-archive-container' });
      return { jobId: 'job-1', outcome: 'succeeded' };
    });
    const context = { extraOutputs: { set: vi.fn() } };
    expect(await worker.handler({ jobId: 'job-1' }, context)).toEqual({ jobId: 'job-1', outcome: 'succeeded' });
    expect(context.extraOutputs.set).toHaveBeenCalledWith(worker.extraOutputs[0], [
      { jobId: 'next-1', type: 'content-archive-container' },
      { jobId: 'next-2', type: 'content-archive-container' },
    ]);

    runJob.mockResolvedValueOnce({ jobId: 'job-2', outcome: 'succeeded' });
    const quiet = { extraOutputs: { set: vi.fn() } };
    await worker.handler({ jobId: 'job-2' }, quiet);
    expect(quiet.extraOutputs.set).not.toHaveBeenCalled();
  });
});

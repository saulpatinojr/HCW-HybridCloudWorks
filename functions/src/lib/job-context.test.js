/**
 * job-context.js (#942 follow-up): inside a platform job's context the
 * shared clients refuse a write that starts after the job's signal fired;
 * outside it, and for the containers kept on purpose, nothing changes.
 */
import { describe, it, expect } from 'vitest';
import { WRITES_KEPT_AFTER_ABORT, refuseWriteAfterJobAbort, runAsJob } from './job-context.js';

/** The reason runJob aborts with: an Error carrying JOB_TIMEOUT. */
const timeoutReason = () => Object.assign(new Error('job timed out'), { code: 'JOB_TIMEOUT' });

describe('refuseWriteAfterJobAbort', () => {
  it('does nothing outside a job', () => {
    expect(() => refuseWriteAfterJobAbort('content')).not.toThrow();
  });

  it('lets a job write until its signal fires, then refuses with the job’s reason, after awaits too', async () => {
    const job = new AbortController();
    await runAsJob(job.signal, async () => {
      expect(() => refuseWriteAfterJobAbort('content')).not.toThrow();
      await Promise.resolve();
      job.abort(timeoutReason());
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(() => refuseWriteAfterJobAbort('content')).toThrow('job timed out');
      expect(() => refuseWriteAfterJobAbort()).toThrow('job timed out');
    });
  });

  it('keeps the containers whose writes record something that already happened', async () => {
    expect(WRITES_KEPT_AFTER_ABORT).toEqual([
      'admin_audit_logs',
      'ai_usage',
      'audits',
      'content_versions',
      'mcp_servers',
    ]);
    const job = new AbortController();
    job.abort(timeoutReason());
    await runAsJob(job.signal, async () => {
      for (const container of WRITES_KEPT_AFTER_ABORT) {
        expect(() => refuseWriteAfterJobAbort(container)).not.toThrow();
      }
    });
  });

  it('does not reach code that runs outside the job, such as runJob’s hooks', async () => {
    const job = new AbortController();
    job.abort(timeoutReason());
    const inside = runAsJob(job.signal, async () => {
      await Promise.resolve();
      return () => refuseWriteAfterJobAbort('content');
    });
    // The caller's own continuation after awaiting the job is outside it.
    const later = await inside;
    expect(() => refuseWriteAfterJobAbort('content')).not.toThrow();
    // A function made inside but called from outside reads the caller's context.
    expect(() => later()).not.toThrow();
  });
});

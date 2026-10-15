/**
 * job-context.js (#942 follow-up): inside a platform job's context the
 * shared clients refuse a write that starts after the job's signal fired;
 * outside it, and for the containers kept on purpose, nothing changes.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITES_KEPT_AFTER_ABORT,
  currentJobSignal,
  outsideJob,
  refuseWriteAfterJobAbort,
  runAsJob,
  writeAbortSignal,
} from './job-context.js';

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

describe('currentJobSignal and writeAbortSignal', () => {
  it('give the running job’s signal inside a job, except for a kept container, and nothing outside', async () => {
    expect(currentJobSignal()).toBeUndefined();
    expect(writeAbortSignal('content')).toBeUndefined();
    const job = new AbortController();
    await runAsJob(job.signal, async () => {
      await Promise.resolve();
      expect(currentJobSignal()).toBe(job.signal);
      expect(writeAbortSignal('content')).toBe(job.signal);
      expect(writeAbortSignal()).toBe(job.signal);
      for (const container of WRITES_KEPT_AFTER_ABORT) {
        expect(writeAbortSignal(container)).toBeUndefined();
      }
    });
  });
});

describe('outsideJob', () => {
  it('runs shared work, and everything it starts, outside the job that started it', async () => {
    const job = new AbortController();
    job.abort(timeoutReason());
    await runAsJob(job.signal, async () => {
      const shared = outsideJob(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        refuseWriteAfterJobAbort('content');
        return currentJobSignal();
      });
      await expect(shared).resolves.toBeUndefined();
      // The job's own code, after the shared work, is still inside it.
      expect(() => refuseWriteAfterJobAbort('content')).toThrow('job timed out');
    });
  });
});

describe('the refusal', () => {
  it('is a fresh error each time, carrying the job’s reason as its cause and the reason’s code', async () => {
    const job = new AbortController();
    const reason = timeoutReason();
    job.abort(reason);
    const caught = [];
    await runAsJob(job.signal, async () => {
      for (const container of ['content', 'podcast_transcripts']) {
        try {
          refuseWriteAfterJobAbort(container);
        } catch (error) {
          caught.push(error);
        }
      }
    });
    expect(caught).toHaveLength(2);
    const [first, second] = caught;
    expect(first).not.toBe(second);
    for (const refusal of caught) {
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).not.toBe(reason);
      expect(refusal.cause).toBe(reason);
      expect(refusal.code).toBe('JOB_TIMEOUT');
      expect(refusal.message).toMatch(/job timed out/);
    }
    // Annotating one refusal leaves the reason, and the next refusal, alone.
    first.extra = 'annotated';
    expect(reason.extra).toBeUndefined();
    expect(second.extra).toBeUndefined();
  });

  it('carries no code when the reason has none', async () => {
    const job = new AbortController();
    job.abort(new Error('stopped'));
    let refusal = null;
    await runAsJob(job.signal, async () => {
      try {
        refuseWriteAfterJobAbort('content');
      } catch (error) {
        refusal = error;
      }
    });
    expect(refusal?.message).toMatch(/stopped/);
    expect(refusal).not.toHaveProperty('code');
  });
});

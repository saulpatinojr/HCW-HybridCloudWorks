import { describe, it, expect, vi } from 'vitest';
import { runJob } from './jobs.js';

const noSleep = vi.fn(async () => {});

describe('runJob', () => {
  it('enqueues, polls until a terminal status, and returns the job', async () => {
    const enqueue = vi.fn(async () => ({ ok: true, jobId: 'j1', status: 'queued' }));
    const statuses = ['queued', 'running', 'running', 'succeeded'];
    const get = vi.fn(async () => ({
      ok: true,
      job: { id: 'j1', status: statuses.shift(), result: { n: 1 } },
    }));
    const onUpdate = vi.fn();

    const job = await runJob(
      'noop',
      { a: 1 },
      { fetchers: { enqueue, get }, sleep: noSleep, onUpdate }
    );

    expect(enqueue).toHaveBeenCalledWith({ type: 'noop', payload: { a: 1 } });
    expect(get).toHaveBeenCalledTimes(4);
    expect(job).toEqual({ id: 'j1', status: 'succeeded', result: { n: 1 } });
    expect(onUpdate).toHaveBeenCalledTimes(4);
  });

  it('hands the 202 body to onAccepted once, before the first poll', async () => {
    // Listen & Learn states its expected speech cost there; a page must see
    // it at acceptance, not after the run.
    const accepted = { ok: true, jobId: 'j1', status: 'queued', speech: { estimatedCostUsd: 7.2 } };
    const enqueue = vi.fn(async () => accepted);
    const get = vi.fn(async () => ({ ok: true, job: { id: 'j1', status: 'succeeded' } }));
    const onAccepted = vi.fn(() => expect(get).not.toHaveBeenCalled());

    await runJob('noop', {}, { fetchers: { enqueue, get }, sleep: noSleep, onAccepted });

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith(accepted);
  });

  it('an onAccepted callback that throws does not reject runJob — the job is accepted and polling', async () => {
    // The job is running server-side by the time the 202 is rendered; a
    // render error must not report that work as failed (Copilot on #447).
    const enqueue = vi.fn(async () => ({ ok: true, jobId: 'j1', status: 'queued' }));
    const statuses = ['running', 'succeeded'];
    const get = vi.fn(async () => ({
      ok: true,
      job: { id: 'j1', status: statuses.shift(), result: { n: 1 } },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onAccepted = vi.fn(() => {
      throw new Error('render blew up');
    });

    const job = await runJob(
      'noop',
      {},
      { fetchers: { enqueue, get }, sleep: noSleep, onAccepted }
    );

    expect(job).toEqual({ id: 'j1', status: 'succeeded', result: { n: 1 } });
    expect(get).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('runJob: onAccepted threw', 'noop', 'render blew up');
    warn.mockRestore();
  });

  it('does not call onAccepted for a rejected job', async () => {
    const onAccepted = vi.fn();
    const enqueue = vi.fn(async () => ({ ok: false, error: 'nope' }));
    await expect(
      runJob('nope', {}, { fetchers: { enqueue, get: vi.fn() }, sleep: noSleep, onAccepted })
    ).rejects.toThrow('nope');
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('throws the server error when the job is not accepted', async () => {
    const enqueue = vi.fn(async () => ({ ok: false, error: 'Unknown job type' }));
    await expect(
      runJob('nope', {}, { fetchers: { enqueue, get: vi.fn() }, sleep: noSleep })
    ).rejects.toThrow('Unknown job type');
  });

  it('survives transient poll errors with backoff and keeps going', async () => {
    const enqueue = vi.fn(async () => ({ ok: true, jobId: 'j1' }));
    let calls = 0;
    const get = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('502');
      // runJob's stored shape since #945: a sentence, the code and a reference.
      return {
        ok: true,
        job: { id: 'j1', status: 'failed', error: 'The job failed (HTTP_503; reference inv-9).' },
      };
    });
    const sleep = vi.fn(async () => {});
    const job = await runJob('noop', {}, { fetchers: { enqueue, get }, sleep });
    expect(job.status).toBe('failed');
    expect(job.error).toBe('The job failed (HTTP_503; reference inv-9).');
    // backoff grew while errors accumulated, then the terminal poll landed
    expect(sleep.mock.calls.length).toBe(3);
    expect(sleep.mock.calls[1][0]).toBeGreaterThan(sleep.mock.calls[0][0]);
  });

  it('gives up after maxWaitMs with the last known job attached', async () => {
    const enqueue = vi.fn(async () => ({ ok: true, jobId: 'j1' }));
    const get = vi.fn(async () => ({ ok: true, job: { id: 'j1', status: 'running' } }));
    let t = 0;
    const now = () => (t += 60_000);
    await expect(
      runJob('noop', {}, { fetchers: { enqueue, get }, sleep: noSleep, now, maxWaitMs: 120_000 })
    ).rejects.toMatchObject({ code: 'JOB_WAIT_EXCEEDED', job: { status: 'running' } });
  });

  it('aborts cleanly', async () => {
    const controller = new AbortController();
    const enqueue = vi.fn(async () => ({ ok: true, jobId: 'j1' }));
    const get = vi.fn(async () => {
      controller.abort();
      return { ok: true, job: { id: 'j1', status: 'running' } };
    });
    await expect(
      runJob('noop', {}, { fetchers: { enqueue, get }, sleep: noSleep, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

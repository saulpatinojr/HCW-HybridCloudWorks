import { describe, it, expect, vi } from 'vitest';
import { createJobFailureOnComplete } from './job-failure-notify.js';
import { formatTelegramText } from './notify.js';

const job = { id: 'job-1', type: 'publish-content', payload: { contentId: 'doc-9' } };

function makeHook() {
  const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
  return { hook: createJobFailureOnComplete({ notifier }), notifier };
}

describe('createJobFailureOnComplete', () => {
  it('stays silent on success — the forge_ready rising edge already covers it', async () => {
    const { hook, notifier } = makeHook();
    await hook({ job, status: 'succeeded', result: {}, error: null });
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('notifies a failure with the error, the payload, and a per-type cooldown source', async () => {
    const { hook, notifier } = makeHook();
    await hook({ job, status: 'failed', result: null, error: 'quality gate refused' });
    const call = notifier.notifyTelegram.mock.calls[0][0];
    expect(call.source).toBe('job_failed:publish-content');
    expect(call.severity).toBe('warning');
    expect(call.title).toBe('Job failed: publish-content');
    expect(call.message).toContain('quality gate refused');
    expect(call.message).toContain('"contentId":"doc-9"');
  });

  it('says timed out for a timeout', async () => {
    const { hook, notifier } = makeHook();
    await hook({ job, status: 'timeout', result: null, error: 'job timed out' });
    expect(notifier.notifyTelegram.mock.calls[0][0].message).toContain('timed out');
  });

  it('redacts sensitive credentials and email addresses in payload and error', async () => {
    const { hook, notifier } = makeHook();
    await hook({
      job: {
        id: 'job-sec',
        type: 'publish-content',
        payload: {
          token: 'secret-token-123',
          email: 'admin@example.com',
          apiKey: 're_1234567890abcdef',
        },
      },
      status: 'failed',
      result: null,
      error: 'Bearer def-123 failed for user@hcw.test',
    });
    const msg = notifier.notifyTelegram.mock.calls[0][0].message;
    expect(msg).not.toContain('secret-token-123');
    expect(msg).not.toContain('admin@example.com');
    expect(msg).not.toContain('re_1234567890abcdef');
    expect(msg).not.toContain('user@hcw.test');
    expect(msg).not.toContain('def-123');
    expect(msg).toContain('[redacted]');
    expect(msg).toContain('[redacted email]');
  });
});

describe('prefixed source display names', () => {
  it('job_failed:* and forge_ready:* render as prose, not raw keys', () => {
    expect(
      formatTelegramText({ title: 'T', message: 'M', severity: 'info', source: 'job_failed:x' })
    ).toContain('Reported by the job worker.');
    expect(
      formatTelegramText({ title: 'T', message: 'M', severity: 'info', source: 'forge_ready:abc' })
    ).toContain('Reported by ContentForge.');
  });
});

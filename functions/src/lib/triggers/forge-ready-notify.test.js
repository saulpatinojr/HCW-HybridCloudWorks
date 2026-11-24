import { describe, it, expect, vi } from 'vitest';
import {
  createForgeReadyNotifier,
  buildForgeReadyMessage,
  FORGE_READY_NOTIFY_CLAIM_FIELDS,
} from './forge-ready-notify.js';

const NOW = new Date('2026-08-28T12:00:00Z');

const doc = (overrides = {}) => ({
  id: 'doc-1',
  Title: 'Staged post',
  contentStatus: 'forge_ready',
  forgeReadyNotifyTrigger: true,
  format: 'deep_dive',
  forgeGrade: { overall: 8.4, threshold: 7 },
  ...overrides,
});

function makeNotifier({ data = doc(), sent = true, reason, env } = {}) {
  const store = {
    readDoc: vi.fn(async () => data),
    replaceDocIfMatch: vi.fn(async (container, d) => d),
    patchDoc: vi.fn(async () => ({})),
  };
  const notifier = {
    notifyTelegram: vi.fn(async () => (sent ? { sent: true } : { sent: false, reason })),
  };
  const notify = createForgeReadyNotifier({
    store,
    notifier,
    env: env ?? { PREVIEW_SIGNING_SECRET: 'secret' },
    now: () => NOW,
  });
  return { notify, store, notifier };
}

describe('buildForgeReadyMessage', () => {
  it('carries grade, format, the preview link and both command hints', () => {
    const message = buildForgeReadyMessage(doc(), 'https://hybridcloudworks.com/preview/doc-1?t=x');
    expect(message).toContain('Grade: 8.4 (threshold 7)');
    expect(message).toContain('Format: deep_dive');
    expect(message).toContain('Preview: https://hybridcloudworks.com/preview/doc-1?t=x');
    expect(message).toContain('/approve doc-1');
    expect(message).toContain('/reject doc-1 [reason]');
  });

  it('says the preview link is unavailable when there is none, instead of omitting it silently', () => {
    expect(buildForgeReadyMessage(doc(), null)).toContain('PREVIEW_SIGNING_SECRET');
  });

  it('mentions SEO advisories only when the lint found some', () => {
    const flagged = doc({
      forgeGrade: {
        overall: 8.4,
        threshold: 7,
        seo: { findings: [{ key: 'meta_description_short', message: 'short' }] },
      },
    });
    const withPreview = buildForgeReadyMessage(flagged, 'https://hybridcloudworks.com/preview/doc-1?t=x');
    expect(withPreview).toContain('SEO: 1 advisory note(s) — details in the preview banner.');
    // No preview link → no pointer to a banner the owner cannot reach.
    const withoutPreview = buildForgeReadyMessage(flagged, null);
    expect(withoutPreview).toContain('SEO: 1 advisory note(s).');
    expect(withoutPreview).not.toContain('preview banner');
    expect(buildForgeReadyMessage(doc(), null)).not.toContain('SEO:');
  });
});

describe('createForgeReadyNotifier', () => {
  it('claims, notifies with the per-post cooldown source and a signed link, then clears the flag', async () => {
    const { notify, store, notifier } = makeNotifier();
    const result = await notify.run('doc-1', 'etag-1');
    expect(result).toEqual({ ran: true, reason: 'sent' });

    // The claim went first (etag-conditioned replace stamping the run id).
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      'content',
      expect.objectContaining({ forgeReadyNotifyRunId: 'etag-1' })
    );

    const call = notifier.notifyTelegram.mock.calls[0][0];
    expect(call.source).toBe('forge_ready:doc-1');
    expect(call.title).toBe('Forge ready: Staged post');
    expect(call.message).toMatch(/Preview: https:\/\/hybridcloudworks\.com\/preview\/doc-1\?t=/);

    // Completion: flag cleared, claim released, stamp written.
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'doc-1',
      expect.objectContaining({
        forgeReadyNotifyTrigger: false,
        [FORGE_READY_NOTIFY_CLAIM_FIELDS.claimField]: null,
        [FORGE_READY_NOTIFY_CLAIM_FIELDS.claimedAtField]: null,
        forgeReadyNotifiedAt: NOW.toISOString(),
      })
    );
  });

  it('still notifies without a secret, saying the link is unavailable', async () => {
    const { notify, notifier } = makeNotifier({ env: {} });
    const result = await notify.run('doc-1', 'etag-1');
    expect(result.reason).toBe('sent');
    expect(notifier.notifyTelegram.mock.calls[0][0].message).toContain('PREVIEW_SIGNING_SECRET');
  });

  it('skips quietly when the flag is not set', async () => {
    const { notify, notifier } = makeNotifier({ data: doc({ forgeReadyNotifyTrigger: false }) });
    const result = await notify.run('doc-1', 'etag-1');
    expect(result).toEqual({ ran: false, reason: 'flag_not_set' });
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('skips a redelivery of the same event (claim already stamped with this event id)', async () => {
    const { notify, notifier } = makeNotifier({
      data: doc({ forgeReadyNotifyRunId: 'etag-1', forgeReadyNotifyRunAt: NOW.toISOString() }),
    });
    const result = await notify.run('doc-1', 'etag-1');
    expect(result).toEqual({ ran: false, reason: 'already_run_by_this_event' });
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('records the attempt when the send fails, but never clears the trigger', async () => {
    const { notify, store } = makeNotifier({ sent: false, reason: 'not_configured' });
    const result = await notify.run('doc-1', 'etag-1');
    expect(result).toMatchObject({ ran: false, reason: 'not_sent:not_configured', attempts: 1 });

    // One write, and it is the attempt record — NOT the completion write. The
    // trigger flag must stay armed so a later change retries (T-735).
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    const [, , update] = store.patchDoc.mock.calls[0];
    expect(update).toEqual({
      forgeReadyNotifyAttempts: 1,
      forgeReadyNotifyLastAttemptAt: NOW.toISOString(),
      forgeReadyNotifyLastReason: 'not_configured',
    });
    // The load-bearing property: nothing boolean is written, because the
    // rising-edge claim keys on a boolean and writing one would re-fire the
    // feed on our own write — the loop this handler exists to avoid.
    expect(Object.values(update).some((v) => typeof v === 'boolean')).toBe(false);
    expect(update).not.toHaveProperty('forgeReadyNotifyTrigger');
  });

  it('counts attempts up across repeated failures, so a stranded draft is findable', async () => {
    const { notify, store } = makeNotifier({
      data: doc({ forgeReadyNotifyAttempts: 3 }),
      sent: false,
      reason: 'cooldown',
    });
    const result = await notify.run('doc-1', 'etag-1');
    expect(result.attempts).toBe(4);
    expect(store.patchDoc.mock.calls[0][2].forgeReadyNotifyAttempts).toBe(4);
  });

  it('a failed attempt-record write does not turn a delivery problem into an error', async () => {
    const { notify, store } = makeNotifier({ sent: false, reason: 'telegram_error' });
    store.patchDoc.mockRejectedValueOnce(new Error('cosmos down'));
    const result = await notify.run('doc-1', 'etag-1');
    expect(result).toMatchObject({ ran: false, reason: 'not_sent:telegram_error' });
  });

  it('never throws when the notifier does — the change feed must survive', async () => {
    const { notify, store, notifier } = makeNotifier();
    notifier.notifyTelegram.mockRejectedValueOnce(new Error('boom'));
    const result = await notify.run('doc-1', 'etag-1');
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('error: Error');
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

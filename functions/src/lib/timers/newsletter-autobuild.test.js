import { describe, it, expect, vi } from 'vitest';
import {
  AUTOBUILD_ACTOR,
  AUTOBUILD_SOURCE,
  buildAutoBuildMessage,
  createNewsletterAutoBuild,
} from './newsletter-autobuild.js';
import { createIssueBuilder } from '../newsletter/issue.js';
import { SOURCE_DISPLAY_NAMES } from '../notify.js';

const DRAFTS = 'https://hybridcloudworks.com/admin/newsletter-hub?tab=drafts';
const NOW = new Date('2026-09-14T13:00:00Z');

const notifier = (sent = true) => ({ notifyTelegram: vi.fn(async () => (sent ? { sent: true } : { sent: false, reason: 'cooldown' })) });
const builderReturning = (result) => ({ build: vi.fn(async () => result) });

describe('createNewsletterAutoBuild', () => {
  it('builds a week into Drafts and sends the subject, item count and Drafts link', async () => {
    const builder = builderReturning({ success: true, issueId: 'issue-2026-09-14', subject: 'Landing zones', itemCount: 5, introError: null });
    const n = notifier();
    const summary = await createNewsletterAutoBuild({ builder, notifier: n }).run();

    // No days: the window is Newsletter settings, Content, read by the builder (#557).
    expect(builder.build).toHaveBeenCalledWith({ keep: true, keptBy: AUTOBUILD_ACTOR });
    expect(builder.build.mock.calls[0][0]).not.toHaveProperty('days');
    expect(summary).toMatchObject({ success: true, reason: 'built', itemCount: 5, notified: true });
    const sent = n.notifyTelegram.mock.calls[0][0];
    expect(sent).toMatchObject({ source: AUTOBUILD_SOURCE, severity: 'info' });
    expect(sent.title).toContain('issue-2026-09-14');
    expect(sent.message).toContain('Subject: Landing zones');
    expect(sent.message).toContain('Items: 5');
    expect(sent.message).toContain(DRAFTS);
    expect(sent.message).toMatch(/Nothing has been sent/);
  });

  it('says the AI intro was not written when the builder reports an intro error', async () => {
    const builder = builderReturning({ success: true, issueId: 'issue-2026-09-14', subject: 'Weekly', itemCount: 2, introError: 'forgeDrafting is disabled' });
    const n = notifier();
    const summary = await createNewsletterAutoBuild({ builder, notifier: n }).run();
    expect(summary.introError).toBe('forgeDrafting is disabled');
    const sent = n.notifyTelegram.mock.calls[0][0];
    expect(sent.severity).toBe('warning');
    expect(sent.message).toMatch(/AI intro was not written/);
  });

  it('reports a week with nothing new without throwing', async () => {
    const builder = builderReturning({ success: false, itemCount: 0, reason: 'empty', message: 'Nothing new in the last 7 days, so no issue was built.' });
    const n = notifier();
    const summary = await createNewsletterAutoBuild({ builder, notifier: n }).run();
    expect(summary).toMatchObject({ success: false, reason: 'empty' });
    expect(n.notifyTelegram.mock.calls[0][0].title).toMatch(/nothing new/);
  });

  it('reports a refusal without throwing, and says nothing was overwritten', async () => {
    const builder = builderReturning({ success: false, issueId: 'issue-2026-09-14', reason: 'locked', status: 'sent', message: "Today's issue is already sent." });
    const n = notifier();
    const summary = await createNewsletterAutoBuild({ builder, notifier: n }).run();
    expect(summary).toMatchObject({ success: false, reason: 'locked' });
    const sent = n.notifyTelegram.mock.calls[0][0];
    expect(sent.message).toContain('already sent');
    expect(sent.message).toMatch(/Nothing was overwritten and nothing was sent/);
  });

  it('notifies and rethrows when the build itself fails', async () => {
    const builder = { build: vi.fn(async () => { throw new Error('Cosmos unreachable'); }) };
    const n = notifier();
    const log = { error: vi.fn() };
    await expect(createNewsletterAutoBuild({ builder, notifier: n, log }).run()).rejects.toThrow('Cosmos unreachable');
    expect(n.notifyTelegram.mock.calls[0][0]).toMatchObject({ severity: 'warning', source: AUTOBUILD_SOURCE });
    // The page is called Newsletter Hub in the menu (#566); the route keeps its old name.
    expect(n.notifyTelegram.mock.calls[0][0].message).toContain('You can build it from the Newsletter Hub:');
    expect(n.notifyTelegram.mock.calls[0][0].message).not.toContain('Mailing List');
    expect(log.error).toHaveBeenCalled();
  });

  it('records a notification that was not delivered, without failing the run', async () => {
    const builder = builderReturning({ success: true, issueId: 'issue-2026-09-14', subject: 'S', itemCount: 1, introError: null });
    const summary = await createNewsletterAutoBuild({ builder, notifier: notifier(false) }).run();
    expect(summary).toMatchObject({ success: true, notified: false, notifyReason: 'cooldown' });
  });

  it('builds the link on the configured origin', () => {
    const { message } = buildAutoBuildMessage({ success: true, issueId: 'i', subject: 's', itemCount: 1 }, 'https://example.test/admin/newsletter-hub?tab=drafts');
    expect(message).toContain('https://example.test/admin/newsletter-hub?tab=drafts');
  });

  it('with the real builder, writes a kept draft and never an approved status', async () => {
    const written = new Map();
    const store = {
      queryDocs: vi.fn(async (container) =>
        container === 'content'
          ? [{ Title: 'Landing zones', publishedAt: '2026-09-10T00:00:00Z', publishedUrl: 'https://hybridcloudworks.com/azure/blog/lz' }]
          : []
      ),
      readDoc: vi.fn(async (container, id) => written.get(`${container}/${id}`) ?? null),
      upsertDoc: vi.fn(async (container, doc) => {
        written.set(`${container}/${doc.id}`, doc);
        return doc;
      }),
    };
    const builder = createIssueBuilder({ store, drafter: null, now: () => NOW });
    const n = notifier();
    await createNewsletterAutoBuild({ builder, notifier: n, siteUrl: 'https://hybridcloudworks.com/' }).run();
    expect(written.get('newsletters/issue-2026-09-14')).toMatchObject({
      status: 'draft',
      savedAt: NOW.toISOString(),
      savedBy: AUTOBUILD_ACTOR,
    });
    expect(n.notifyTelegram.mock.calls[0][0].message).toContain(DRAFTS);
  });

  it('has a display name for its Telegram source', () => {
    expect(SOURCE_DISPLAY_NAMES[AUTOBUILD_SOURCE]).toBeTruthy();
  });
});

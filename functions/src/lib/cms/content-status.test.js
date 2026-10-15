import { describe, it, expect } from 'vitest';
import {
  VALID_TRANSITIONS,
  VALID_STATUSES,
  canPublishFromStatus,
  toValidDate,
  resolvePreferredPublishedDate,
  buildStatusUpdateData,
  validateTransitionRequest,
} from './content-status.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');

describe('transition table', () => {
  it('keeps the source graph — spot-check the edges bugs have hidden in', () => {
    expect(VALID_TRANSITIONS.forge_ready).toEqual(['published', 'editing', 'rejected']);
    expect(VALID_TRANSITIONS.rejected).toContain('inspected'); // the restore path
    // Undo on Live Pages and Restore on the Archive board (AP-F13, #937).
    // Until 2026-10-15 this line said the opposite ("no resurrect-to-live").
    expect(VALID_TRANSITIONS.archived).toContain('published');
    expect(VALID_STATUSES).toContain('needs_rework');
  });

  it('canPublishFromStatus accepts exactly the publishable set, normalized', () => {
    expect(canPublishFromStatus('approved')).toBe(true);
    expect(canPublishFromStatus('forge_ready')).toBe(true);
    expect(canPublishFromStatus('published')).toBe(true);
    expect(canPublishFromStatus('approved_news')).toBe(true); // normalizes to approved
    expect(canPublishFromStatus('in_review')).toBe(false);
    expect(canPublishFromStatus(undefined)).toBe(false); // defaults to ingested
  });
});

describe('date resolution', () => {
  it('toValidDate handles Date, Timestamp-like, ISO string — and rejects garbage', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    // Source wraps plain Dates in `new Date(value)` — equal value, new object.
    expect(toValidDate(d)?.getTime()).toBe(d.getTime());
    expect(toValidDate({ toDate: () => d })).toBe(d);
    expect(toValidDate('2026-01-01T00:00:00Z')?.getTime()).toBe(d.getTime());
    expect(toValidDate('junk')).toBeNull();
    expect(toValidDate(null)).toBeNull();
  });

  it('resolvePreferredPublishedDate honors the field priority order', () => {
    const date = resolvePreferredPublishedDate({
      publishedAt: '2026-03-01T00:00:00Z',
      publishedDate: '2026-02-01T00:00:00Z',
    });
    expect(date?.toISOString()).toBe('2026-02-01T00:00:00.000Z'); // publishedDate wins
    expect(resolvePreferredPublishedDate({})).toBeNull();
  });
});

describe('buildStatusUpdateData', () => {
  it('always stamps status, reviewer, and review timestamp', () => {
    const out = buildStatusUpdateData({}, 'in_review', 'rev@x', 'note', { now: NOW });
    expect(out.contentStatus).toBe('in_review');
    expect(out.reviewedBy).toBe('rev@x');
    expect(out.reviewedAt).toBe('2026-08-06T12:00:00.000Z');
    expect(out.reviewNotes).toBe('note');
  });

  it('clears soft-delete/rejection markers on every non-rejected transition', () => {
    const out = buildStatusUpdateData({}, 'approved', 'r', '', { now: NOW });
    // undefined = patchDoc deletion
    expect('softDeletedAt' in out && out.softDeletedAt === undefined).toBe(true);
    // Both halves of the soft-delete marker, or Undo leaves the page hidden.
    expect('softDeleteExpiresAt' in out && out.softDeleteExpiresAt === undefined).toBe(true);
    expect('rejectedAt' in out && out.rejectedAt === undefined).toBe(true);

    const rejected = buildStatusUpdateData({}, 'rejected', 'r', '', { now: NOW });
    expect(rejected.rejectedAt).toBe(NOW.toISOString());
    expect(rejected.Live).toBe(false);
    expect('softDeletedAt' in rejected).toBe(false);
  });

  it('approved: resolves target from doc type and seeds blogDraft only when absent', () => {
    const seeded = buildStatusUpdateData({ type: 'framework', content: 'body' }, 'approved', 'r', '', { now: NOW });
    expect(seeded.publishTarget).toBe('framework');
    expect(seeded.blogDraft).toBe('body');
    expect(seeded.approvedForNews).toBe(false);

    const kept = buildStatusUpdateData({ blogDraft: 'mine' }, 'approved', 'r', '', { now: NOW });
    expect(kept).not.toHaveProperty('blogDraft');
  });

  it('published: preserves an existing published date (ISO string form) across aliases', () => {
    const out = buildStatusUpdateData(
      { publishedDate: '2026-02-01T00:00:00Z', type: 'blog' },
      'published',
      'r',
      '',
      { now: NOW }
    );
    expect(out.publishedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(out['Published At']).toBe('2026-02-01T00:00:00.000Z');
    expect(out.datePublished).toBe('2026-02-01T00:00:00.000Z');
    expect(out.Live).toBe(true);
  });

  it('published: falls back to now and honors markLive=false', () => {
    const out = buildStatusUpdateData({}, 'published', 'r', '', { now: NOW, markLive: false });
    expect(out.publishedAt).toBe(NOW.toISOString());
    expect(out).not.toHaveProperty('Published At'); // only set when a real date existed
    expect(out.Live).toBe(false);
  });

  it('forge_ready and archived stage with Live=false', () => {
    expect(buildStatusUpdateData({}, 'forge_ready', 'r', '', { now: NOW }).Live).toBe(false);
    expect(buildStatusUpdateData({}, 'archived', 'r', '', { now: NOW }).Live).toBe(false);
  });

  it('archived and rejected retire the legacy Status word, and going live drops it (AP-F13, #937)', () => {
    // The public gate also admits `Status: 'Live'`; a page taken down has to
    // stop saying it, or a legacy document stays on the site with Live false.
    expect(buildStatusUpdateData({}, 'archived', 'r', '', { now: NOW }).Status).toBe('Archived');
    expect(buildStatusUpdateData({}, 'rejected', 'r', '', { now: NOW }).Status).toBe('Rejected');
    const live = buildStatusUpdateData({}, 'published', 'r', '', { now: NOW });
    expect('Status' in live && live.Status === undefined).toBe(true);
    // Staged, not live: the legacy word is left alone.
    const staged = buildStatusUpdateData({}, 'published', 'r', '', { now: NOW, markLive: false });
    expect('Status' in staged).toBe(false);
  });
});

describe('validateTransitionRequest', () => {
  const ok = {
    contentId: 'c1',
    blogId: null,
    normalizedStatus: 'approved',
    markLive: null,
    reviewNotes: '',
    reviewedBy: 'r',
  };

  it('accepts a well-formed request', () => {
    expect(validateTransitionRequest(ok)).toEqual({ ok: true });
  });

  it('400s each malformed shape with the source message', () => {
    expect(validateTransitionRequest({ ...ok, contentId: 5 }).error.error).toMatch(/must be a string/);
    expect(validateTransitionRequest({ ...ok, markLive: 'yes' }).error.error).toMatch(/must be boolean/);
    expect(validateTransitionRequest({ ...ok, reviewNotes: 'x'.repeat(5001) }).error.error).toMatch(/5000/);
    expect(validateTransitionRequest({ ...ok, reviewedBy: 'x'.repeat(241) }).error.error).toMatch(/240/);
    expect(validateTransitionRequest({ ...ok, contentId: null }).error.error).toMatch(/contentId \(or blogId\)/);
    const bad = validateTransitionRequest({ ...ok, normalizedStatus: 'nonsense' });
    expect(bad.error.error).toMatch(/Invalid status/);
    expect(bad.error.validStatuses).toEqual(VALID_STATUSES);
  });
});

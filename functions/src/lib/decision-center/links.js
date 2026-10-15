/**
 * Where each Decision Center item opens (#1013, #1014): the admin page that
 * shows that one item at the stage it waits in.
 *
 * The content half mirrors frontend/src/lib/itemLinks.js, which is the
 * frontend's single place for "a content item's stage → its URL", and
 * frontend/src/lib/status.js CONTENT_STATUS, which names each status's stage.
 * frontend/src/lib/itemLinks.test.js imports this module and fails when the
 * two disagree for any status, so the copy cannot drift silently.
 *
 * The other builders name the deep-link parameter each page reads to focus
 * the item: `transcript`, `issue`, `alert`, `reminder`, `chapter` (with the
 * book's `platform` and `exam`), and the Ambassador hub's `application`.
 */

const enc = encodeURIComponent;

/** The pipeline stage each stored status sits in (frontend/src/lib/status.js `stage`). */
export const CONTENT_STAGE = Object.freeze({
  drafting: 'drafts',
  draft: 'review',
  ingested: 'review',
  inspected: 'review',
  in_review: 'review',
  needs_rework: 'editor',
  approved: 'editor',
  editing: 'editor',
  forge_ready: 'publish',
  published: 'live',
  rejected: 'off',
  archived: 'off',
});

/** Legacy spellings still found on old documents (frontend/src/lib/status.js CONTENT_ALIASES). */
const CONTENT_ALIASES = Object.freeze({
  approved_blog: 'approved',
  approved_news: 'approved',
  published_blog: 'published',
  published_news: 'published',
  published_both: 'published',
  published_live: 'published',
  ready_to_publish: 'approved',
});

/** The stage a content document is at: a live page is `live` unless it was taken off the pipeline. */
export function contentStage(item = {}) {
  const raw = String(item.contentStatus || 'ingested').toLowerCase();
  const id = Object.hasOwn(CONTENT_ALIASES, raw) ? CONTENT_ALIASES[raw] : raw;
  const offThePipeline = id === 'rejected' || id === 'archived';
  if (item.Live === true && !offThePipeline) return 'live';
  return Object.hasOwn(CONTENT_STAGE, id) ? CONTENT_STAGE[id] : 'review';
}

/** The review board, the page every stage but Drafts and the Editor is decided on. */
const reviewPath = (id) => `/admin/review-queue/${enc(id)}?source=content`;

const STAGE_PATHS = Object.freeze({
  drafts: () => '/admin/drafts',
  review: reviewPath,
  editor: (id) => `/admin/editor/${enc(id)}`,
  publish: reviewPath,
  live: reviewPath,
  off: reviewPath,
});

/** The page that opens one content document at its stage. */
export const contentHref = (item = {}) => STAGE_PATHS[contentStage(item)](String(item.id ?? ''));

export const transcriptHref = (id) => `/admin/recording-hub?tab=transcripts&transcript=${enc(id)}`;

/** `tab` is the Newsletter Hub tab the issue is listed on: `newsletter` or `drafts`. */
export const newsletterIssueHref = (id, tab = 'newsletter') =>
  `/admin/newsletter-hub?tab=${enc(tab)}&issue=${enc(id)}`;

export const alertHref = (id) => `/admin/health?tab=alerts&alert=${enc(id)}`;

/** Where the Health Hub lists the Key Vault references that did not resolve. */
export const UNRESOLVED_SECRETS_HREF = '/admin/health?tab=overview';

/** One reminder, opened on Platform Settings' Reminders tab. */
export const reminderHref = (id) => `/admin/platform-settings?tab=reminders&reminder=${enc(id)}`;

/** One chapter on the Review tab, its book opened by provider and exam code. */
export function chapterHref({ provider, examCode, id }) {
  if (!provider || !examCode) return '/admin/listen-and-learn?tab=review';
  return `/admin/listen-and-learn?tab=review&platform=${enc(provider)}&exam=${enc(examCode)}&chapter=${enc(id)}`;
}

/** The Applications tab with this application open (`?application=` alone lands on Dashboard). */
export const ambassadorHref = (id) => `/admin/ambassador?tab=applications&application=${enc(id)}`;

/** Compose, with the article the post was for already chosen when it is known. */
export const socialComposeHref = (contentId) =>
  contentId ? `/admin/social-hub?tab=compose&contentId=${enc(contentId)}` : '/admin/social-hub?tab=compose';

export const SOCIAL_QUEUE_HREF = '/admin/social-hub?tab=queue';

export const FORGE_QUEUE_HREF = '/admin/forge-studio?tab=queue';

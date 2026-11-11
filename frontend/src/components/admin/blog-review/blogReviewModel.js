/**
 * Pure derivations for the blog review board (ADR 0033, PR #841).
 *
 * Everything here takes the content record (or the board's local state) and
 * returns plain values: which fields a display reads, which workflow buttons
 * a status shows, what the schedule request looks like, and the sentences
 * the board shows under its controls. Nothing here touches React or the
 * network, so each function is unit-tested on its own.
 */
import { getCoverImageUrl } from '@/lib/blogUtils';
import { toDate } from '@/lib/dateUtils';
import {
  getContentPublicPath,
  getPublicSectionForTarget,
  getPublishTargetForItem,
} from '@/lib/contentModel';
import { getOrderedContentImages } from '@/lib/contentImages';

/** Where a published record's public URL may live, in the order the board trusts them. */
export const PUBLISHED_URL_KEYS = Object.freeze([
  'slugPageUrl',
  'publishedUrl',
  'blogUrl',
  'publicUrl',
]);
export const TITLE_KEYS = Object.freeze(['Title', 'title']);
export const CONTENT_KEYS = Object.freeze(['content', 'Content']);
export const SUMMARY_KEYS = Object.freeze(['Summary', 'summary']);
export const SOURCE_URL_KEYS = Object.freeze(['sourceUrl', 'CD Url', 'url']);
export const PROVIDER_KEYS = Object.freeze(['Cloud Provider', 'cloudProvider']);
export const HERO_IMAGE_KEYS = Object.freeze(['aiImageUrls.hero', 'altCoverImage', 'heroImageUrl']);
export const CONTENT_IMAGE_KEYS = Object.freeze(['aiImageUrls.content', 'contentImageUrl']);

/** Statuses whose record can still be approved or rejected from the board. */
export const REVIEWABLE_STATUSES = Object.freeze(['ingested', 'inspected', 'in_review']);
/** Statuses whose record opens in the editor as its next step. */
export const EDITOR_STATUSES = Object.freeze(['approved', 'forge_ready', 'editing']);
export const MAX_REVIEW_IMAGES = 4;
export const DEFAULT_IMAGE_PROMPT_HINT = 'AI prompt will be generated from this content.';

const asArray = (value) => (Array.isArray(value) ? value : []);

const readPath = (source, path) => path.split('.').reduce((current, key) => current?.[key], source);

/**
 * The first truthy value among `keys` on `source` (dotted paths allowed), or
 * `fallback`. Replaces the `a || b || c || ''` chains the board used to
 * carry for every field that has more than one spelling (ADR 0033 §1).
 */
export function firstNonEmpty(source, keys, fallback = '') {
  const hit = keys.map((key) => readPath(source, key)).find(Boolean);
  return hit === undefined ? fallback : hit;
}

export const toLocalDateInputValue = (value) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const truncate = (text, max) => (text.length > max ? `${text.substring(0, max)}...` : text);

/** The display values every card reads from the record. */
export function deriveBlogView(blog = {}) {
  const status = blog.contentStatus || 'ingested';
  const selectedProvider = firstNonEmpty(blog, PROVIDER_KEYS);
  const hasProvider = Boolean(selectedProvider) && selectedProvider !== 'Unknown';
  const isPublishedLive = blog.Live === true;
  // `published` is the canonical spelling, `published_*` the Firestore-era
  // one (ADR 0033 §1); a review board must read both.
  const isPublishedStatus = status === 'published' || status.startsWith('published_');
  const explicitPublishedUrl = firstNonEmpty(blog, PUBLISHED_URL_KEYS);
  const displayUrl = isPublishedLive
    ? explicitPublishedUrl || getContentPublicPath(blog) || ''
    : '';
  return {
    status,
    title: firstNonEmpty(blog, TITLE_KEYS, 'Untitled'),
    coverUrl: getCoverImageUrl(blog),
    content: firstNonEmpty(blog, CONTENT_KEYS),
    summary: firstNonEmpty(blog, SUMMARY_KEYS),
    sourceUrl: firstNonEmpty(blog, SOURCE_URL_KEYS),
    selectedProvider,
    hasProvider,
    isPublishedLive,
    isPublishedStatus,
    displayUrl,
  };
}

/** Which workflow buttons a record's status earns. */
export function deriveWorkflowFlags({ status, isPublishedStatus, isPublishedLive, hasProvider }) {
  return {
    showTransitions: REVIEWABLE_STATUSES.includes(status) || isPublishedStatus,
    recallInsteadOfApprove: isPublishedStatus,
    showPublishPane: status === 'approved' && !isPublishedLive,
    canOpenEditor: EDITOR_STATUSES.includes(status),
    showPublishedNavigation: isPublishedStatus && !isPublishedLive,
    needsProvider: !hasProvider,
  };
}

const SLOT_DEFAULTS = Object.freeze({ isGenerating: false, error: '' });

/** The tiles in the Images card: four fixed slots, then up to two previous heroes. */
export function buildImageSlots(blog = {}, { imagePromptPreview, isCoverGenerating }) {
  const heroUrl = firstNonEmpty(blog, HERO_IMAGE_KEYS);
  const aiImages = blog.aiImageUrls || {};
  const secondary = asArray(blog.secondaryImageUrls);
  const history = blog.aiImageHistory || {};
  const heroHistory = [...asArray(history.hero)].filter(Boolean).reverse();
  const fixed = [
    {
      key: 'hero',
      label: 'Hero Cover',
      url: heroUrl,
      prompt: imagePromptPreview,
      isGenerating: isCoverGenerating,
      error: blog.altCoverImageError || '',
    },
    {
      key: 'content',
      label: 'Content Image',
      url: firstNonEmpty(blog, CONTENT_IMAGE_KEYS),
      prompt: 'Content image not yet generated.',
    },
    {
      key: 'secondary-1',
      label: 'Secondary Image 1',
      url: aiImages.secondary1 || secondary[0] || '',
      prompt: 'Secondary image not yet generated.',
    },
    {
      key: 'secondary-2',
      label: 'Secondary Image 2',
      url: aiImages.secondary2 || secondary[1] || '',
      prompt: 'Secondary image not yet generated.',
    },
  ];
  const previous = heroHistory
    .filter((url) => url !== heroUrl)
    .slice(0, 2)
    .map((url, index) => ({
      key: `hero-history-${index}`,
      label: `Previous Hero ${index + 1}`,
      url,
      prompt: 'Previously generated hero image.',
    }));
  return [...fixed, ...previous].map((slot) => ({ ...SLOT_DEFAULTS, ...slot }));
}

/** The caption under an empty image slot. */
export function describeImageSlot(slot) {
  if (slot.isGenerating) return `Generating now. Prompt: ${slot.prompt}`;
  if (slot.error) return `Generation failed: ${slot.error}`;
  return slot.prompt;
}

/** The schedule inputs a record starts from: its own date, or 09:00 tomorrow. */
export function deriveScheduleFields(blog) {
  // `toDate`, not `.toDate()`. `scheduledPublishDate` is an ISO string
  // since the migration, and calling a legacy timestamp method on it
  // threw — inside a setTimeout, so outside the error boundary, blanking
  // the review page for any scheduled item (T-303). A null here
  // now falls through to the same default as an unscheduled item rather
  // than taking the page down.
  const date = toDate(blog.scheduledPublishDate);
  if (date) {
    return {
      instantPublish: false,
      scheduledDate: toLocalDateInputValue(date),
      scheduledTime: date.toTimeString().split(' ')[0].substring(0, 5),
    };
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return {
    instantPublish: true,
    scheduledDate: toLocalDateInputValue(tomorrow),
    scheduledTime: '09:00',
  };
}

/**
 * Does this record's page address start with a topic word (#1628)? Only a
 * blog article's does; interviews and the other sections keep a title slug.
 */
export function usesTopicAddress(blog) {
  return getPublicSectionForTarget(getPublishTargetForItem(blog || {})) === 'blog';
}

/**
 * The local-state patch a fresh record implies: the images, topics and
 * address topic it carries, its schedule, its saved prompt override (only when it has one),
 * and the end of a cover generation once the record says it finished.
 */
export function deriveBlogSyncPatch(blog) {
  const patch = {
    reviewImages: getOrderedContentImages(blog),
    keyTopics: asArray(blog?.keyTopics),
    // The address topic (#1628); '' means the server picks one at publish.
    topic: typeof blog?.topic === 'string' ? blog.topic : '',
  };
  if (!blog) return patch;
  if (blog.altCoverImagePrompt) patch.imagePrompt = blog.altCoverImagePrompt;
  const coverFinished = blog.altCoverImageGeneratedAt || blog.altCoverImageError;
  if (blog.altCoverImageTrigger !== true && coverFinished) patch.coverTriggerPending = false;
  return { ...patch, ...deriveScheduleFields(blog) };
}

export const parseScheduleDateTime = (scheduledDate, scheduledTime) => {
  const [year, month, day] = String(scheduledDate).split('-').map(Number);
  const [hours, minutes] = String(scheduledTime).split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes);
};

const SCHEDULE_CHECKS = Object.freeze([
  {
    failed: ({ scheduledDate, scheduledTime }) => !scheduledDate || !scheduledTime,
    text: 'Please enter both a date and time.',
  },
  {
    failed: ({ when }) => Number.isNaN(when.getTime()),
    text: 'Invalid date or time format.',
  },
  {
    failed: ({ when, now }) => when <= now,
    text: 'Scheduled date must be in the future.',
  },
]);

/**
 * The saveContentSchedule payload and audit row for the current inputs, or
 * `{ error }` naming the first check the inputs fail.
 */
export function buildScheduleRequest({
  blog,
  blogId,
  instantPublish,
  scheduledDate,
  scheduledTime,
  now = new Date(),
}) {
  const publishTarget = getPublishTargetForItem(blog);
  const audit = {
    contentId: blogId,
    instantPublish,
    scheduledDate: instantPublish ? null : scheduledDate,
  };
  if (instantPublish) {
    return { payload: { contentId: blogId, instantPublish: true, publishTarget }, audit };
  }
  const when = parseScheduleDateTime(scheduledDate, scheduledTime);
  const failure = SCHEDULE_CHECKS.find((check) =>
    check.failed({ scheduledDate, scheduledTime, when, now })
  );
  if (failure) return { error: failure.text };
  return {
    payload: {
      contentId: blogId,
      instantPublish: false,
      scheduledPublishDate: when.toISOString(),
      publishTarget,
    },
    audit,
  };
}

/** The sentence under the schedule card. */
export function describeScheduleState({
  hasProvider,
  instantPublish,
  scheduledDate,
  scheduledTime,
}) {
  if (!hasProvider) return 'Select a Cloud Provider to enable schedule actions.';
  if (instantPublish) {
    return 'This content is ready to be published immediately from the Publish pane.';
  }
  if (scheduledDate && scheduledTime) {
    return `Scheduled to publish on ${new Date(`${scheduledDate}T${scheduledTime}`).toLocaleString()}`;
  }
  return 'Select a date and time for scheduled publishing.';
}

const describeCoverSource = (promptOverride, plan) => {
  if (promptOverride) return 'your prompt override';
  if (plan?.setName) return `the "${plan.setName}" image set`;
  return 'the built-in prompt';
};

/** The confirmation shown once a cover generation is queued. */
export function describeCoverQueued(promptOverride, plan) {
  const using = describeCoverSource(promptOverride, plan);
  return `AI cover queued using ${using}. The Images panel updates when the new file lands; the previous cover stays in the gallery.`;
}

/** The parenthetical and origin after an assigned image set's name. */
export function describeCoverPlanSource(plan) {
  const promptName = plan.promptName ? ` (${plan.promptName})` : '';
  const origin =
    plan.source === 'page' ? `, assigned to ${plan.pagePath}` : ', recorded on this content';
  return `${promptName}${origin}`;
}

/** The page paths a plan looked at, as a parenthetical, or nothing. */
export function formatPlanPagePaths(plan) {
  const paths = asArray(plan.pagePaths);
  return paths.length ? ` (${paths.join(', ')})` : '';
}

/**
 * The review images after a gallery pick: unchanged when the pick has no
 * URL or is already attached, otherwise appended and capped at four.
 */
export function appendGalleryImage(images, item, blogId) {
  const imageUrl = String(item?.imageUrl || '').trim();
  if (!imageUrl || images.some((entry) => entry.url === imageUrl)) return images;
  return [
    ...images,
    {
      id: `${blogId}-${Date.now()}-${imageUrl}`,
      url: imageUrl,
      label: `Secondary ${images.length}`,
      sourceLabel: 'Gallery',
    },
  ].slice(0, MAX_REVIEW_IMAGES);
}

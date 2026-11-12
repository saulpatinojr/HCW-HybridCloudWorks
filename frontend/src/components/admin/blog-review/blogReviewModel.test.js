/**
 * The pure derivations the blog review board renders from (ADR 0033, PR #841).
 * Each case pins a behaviour the board used to carry inline, so the split
 * into these helpers changes nothing a reviewer sees.
 */
import { describe, expect, it } from 'vitest';
import {
  appendGalleryImage,
  buildImageSlots,
  buildScheduleRequest,
  deriveBlogSyncPatch,
  deriveBlogView,
  deriveWorkflowFlags,
  describeCoverPlanSource,
  describeCoverQueued,
  describeImageSlot,
  describeScheduleState,
  firstNonEmpty,
  formatPlanPagePaths,
  PUBLISHED_URL_KEYS,
  toLocalDateInputValue,
  truncate,
  hasPublishedAddress,
} from './blogReviewModel';

describe('firstNonEmpty', () => {
  it('returns the first truthy field in table order, reading dotted paths', () => {
    const blog = { slugPageUrl: '', publishedUrl: '/p/one', blogUrl: '/p/two' };
    expect(firstNonEmpty(blog, PUBLISHED_URL_KEYS)).toBe('/p/one');
    expect(firstNonEmpty({ aiImageUrls: { hero: 'h.png' } }, ['aiImageUrls.hero'])).toBe('h.png');
  });

  it('falls back when nothing is set, and survives a missing parent object', () => {
    expect(firstNonEmpty({}, PUBLISHED_URL_KEYS)).toBe('');
    expect(firstNonEmpty({}, ['Title', 'title'], 'Untitled')).toBe('Untitled');
    expect(firstNonEmpty({ aiImageUrls: null }, ['aiImageUrls.hero', 'altCoverImage'])).toBe('');
  });
});

describe('deriveBlogView', () => {
  it('reads both spellings of each field and defaults the status to ingested', () => {
    const view = deriveBlogView({
      title: 'lower',
      Content: 'body',
      'CD Url': 'https://src.example/a',
      cloudProvider: 'Azure',
    });
    expect(view.status).toBe('ingested');
    expect(view.title).toBe('lower');
    expect(view.content).toBe('body');
    expect(view.sourceUrl).toBe('https://src.example/a');
    expect(view.selectedProvider).toBe('Azure');
    expect(view.hasProvider).toBe(true);
  });

  it('treats Unknown and empty as no provider', () => {
    expect(deriveBlogView({ 'Cloud Provider': 'Unknown' }).hasProvider).toBe(false);
    expect(deriveBlogView({}).hasProvider).toBe(false);
  });

  it('recognises both published spellings and shows a URL only when live', () => {
    expect(deriveBlogView({ contentStatus: 'published' }).isPublishedStatus).toBe(true);
    expect(deriveBlogView({ contentStatus: 'published_blog' }).isPublishedStatus).toBe(true);
    expect(deriveBlogView({ contentStatus: 'approved' }).isPublishedStatus).toBe(false);
    expect(deriveBlogView({ publishedUrl: '/p/x' }).displayUrl).toBe('');
    expect(deriveBlogView({ publishedUrl: '/p/x', Live: true }).displayUrl).toBe('/p/x');
  });
});

describe('deriveWorkflowFlags', () => {
  const flagsFor = (overrides) =>
    deriveWorkflowFlags({
      status: 'inspected',
      isPublishedStatus: false,
      isPublishedLive: false,
      hasProvider: true,
      ...overrides,
    });

  it('offers approve and reject while the record is still under review', () => {
    const flags = flagsFor({});
    expect(flags.showTransitions).toBe(true);
    expect(flags.recallInsteadOfApprove).toBe(false);
    expect(flags.canOpenEditor).toBe(false);
    expect(flags.showPublishPane).toBe(false);
  });

  it('swaps approve for recall on a published record that is not yet live', () => {
    const flags = flagsFor({ status: 'published', isPublishedStatus: true });
    expect(flags.showTransitions).toBe(true);
    expect(flags.recallInsteadOfApprove).toBe(true);
    expect(flags.showPublishedNavigation).toBe(true);
    expect(
      flagsFor({ status: 'published', isPublishedStatus: true, isPublishedLive: true })
        .showPublishedNavigation
    ).toBe(false);
  });

  it('points an approved record at the publish pane and the editor', () => {
    const flags = flagsFor({ status: 'approved' });
    expect(flags.showTransitions).toBe(false);
    expect(flags.showPublishPane).toBe(true);
    expect(flags.canOpenEditor).toBe(true);
    expect(flagsFor({ hasProvider: false }).needsProvider).toBe(true);
  });
});

describe('buildImageSlots', () => {
  const options = { imagePromptPreview: 'preview', isCoverGenerating: false };

  it('fills the four fixed slots from the AI urls first, then the legacy fields', () => {
    const slots = buildImageSlots(
      {
        altCoverImage: 'legacy-hero.png',
        aiImageUrls: { content: 'c.png' },
        secondaryImageUrls: ['s1.png'],
      },
      options
    );
    expect(slots.map((slot) => slot.key)).toEqual([
      'hero',
      'content',
      'secondary-1',
      'secondary-2',
    ]);
    expect(slots[0]).toMatchObject({
      url: 'legacy-hero.png',
      prompt: 'preview',
      isGenerating: false,
    });
    expect(slots[1].url).toBe('c.png');
    expect(slots[2].url).toBe('s1.png');
    expect(slots[3].url).toBe('');
  });

  it('appends up to two previous heroes, newest first, skipping the current one', () => {
    const slots = buildImageSlots(
      {
        aiImageUrls: { hero: 'now.png' },
        aiImageHistory: { hero: ['a.png', 'b.png', null, 'now.png', 'c.png'] },
      },
      options
    );
    const previous = slots.filter((slot) => slot.key.startsWith('hero-history'));
    expect(previous.map((slot) => slot.url)).toEqual(['c.png', 'b.png']);
    expect(previous[0].label).toBe('Previous Hero 1');
  });

  it('describes a slot by what is happening to it', () => {
    expect(describeImageSlot({ isGenerating: true, prompt: 'p', error: '' })).toBe(
      'Generating now. Prompt: p'
    );
    expect(describeImageSlot({ isGenerating: false, prompt: 'p', error: 'boom' })).toBe(
      'Generation failed: boom'
    );
    expect(describeImageSlot({ isGenerating: false, prompt: 'p', error: '' })).toBe('p');
  });
});

describe('deriveBlogSyncPatch', () => {
  it('copies topics, images and the saved prompt override; schedules a record with a date', () => {
    const patch = deriveBlogSyncPatch({
      keyTopics: ['k8s'],
      altCoverImagePrompt: 'saved prompt',
      scheduledPublishDate: '2030-04-05T09:30:00',
    });
    expect(patch.keyTopics).toEqual(['k8s']);
    expect(patch.imagePrompt).toBe('saved prompt');
    expect(patch.instantPublish).toBe(false);
    expect(patch.scheduledDate).toBe('2030-04-05');
    expect(patch.scheduledTime).toBe('09:30');
  });

  it('leaves the override alone when the record has none, and defaults to 09:00 tomorrow', () => {
    const patch = deriveBlogSyncPatch({});
    expect(patch).not.toHaveProperty('imagePrompt');
    expect(patch.keyTopics).toEqual([]);
    expect(patch.instantPublish).toBe(true);
    expect(patch.scheduledTime).toBe('09:00');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(patch.scheduledDate).toBe(toLocalDateInputValue(tomorrow));
  });

  it('copies the address topic, and reads none as automatic (#1628)', () => {
    expect(deriveBlogSyncPatch({ topic: 'identity' }).topic).toBe('identity');
    expect(deriveBlogSyncPatch({ topic: null }).topic).toBe('');
    expect(deriveBlogSyncPatch({}).topic).toBe('');
  });

  it('ends a pending cover only once the record says generation finished', () => {
    expect(
      deriveBlogSyncPatch({ altCoverImageTrigger: true, altCoverImageGeneratedAt: 'x' })
    ).not.toHaveProperty('coverTriggerPending');
    expect(deriveBlogSyncPatch({ altCoverImageGeneratedAt: 'x' }).coverTriggerPending).toBe(false);
    expect(deriveBlogSyncPatch({ altCoverImageError: 'e' }).coverTriggerPending).toBe(false);
    expect(deriveBlogSyncPatch({})).not.toHaveProperty('coverTriggerPending');
  });

  it('tolerates a missing record', () => {
    expect(deriveBlogSyncPatch(undefined)).toEqual({
      reviewImages: [],
      keyTopics: [],
      topic: '',
    });
  });
});

describe('buildScheduleRequest', () => {
  const base = { blog: { contentType: 'blog' }, blogId: 'c1' };

  it('builds an instant request without looking at the date inputs', () => {
    const request = buildScheduleRequest({ ...base, instantPublish: true, scheduledDate: '' });
    expect(request.error).toBeUndefined();
    expect(request.payload).toMatchObject({ contentId: 'c1', instantPublish: true });
    expect(request.payload).toHaveProperty('publishTarget');
    expect(request.audit).toEqual({ contentId: 'c1', instantPublish: true, scheduledDate: null });
  });

  it('names the first failed check for a scheduled request', () => {
    const now = new Date(2030, 0, 10, 12, 0);
    const scheduled = (scheduledDate, scheduledTime) =>
      buildScheduleRequest({ ...base, instantPublish: false, scheduledDate, scheduledTime, now });
    expect(scheduled('', '09:00').error).toBe('Please enter both a date and time.');
    expect(scheduled('2030-01-11', '').error).toBe('Please enter both a date and time.');
    expect(scheduled('2030-13-99', 'zz').error).toBe('Invalid date or time format.');
    expect(scheduled('2030-01-09', '09:00').error).toBe('Scheduled date must be in the future.');
  });

  it('builds a scheduled request with the local date and time as an ISO string', () => {
    const now = new Date(2030, 0, 10, 12, 0);
    const request = buildScheduleRequest({
      ...base,
      instantPublish: false,
      scheduledDate: '2030-01-11',
      scheduledTime: '09:30',
      now,
    });
    expect(request.error).toBeUndefined();
    expect(request.payload.instantPublish).toBe(false);
    expect(new Date(request.payload.scheduledPublishDate)).toEqual(new Date(2030, 0, 11, 9, 30));
    expect(request.audit.scheduledDate).toBe('2030-01-11');
  });
});

describe('describeScheduleState', () => {
  it('explains the schedule card in the order the board checks', () => {
    const state = {
      hasProvider: true,
      instantPublish: false,
      scheduledDate: '',
      scheduledTime: '',
    };
    expect(describeScheduleState({ ...state, hasProvider: false })).toBe(
      'Select a Cloud Provider to enable schedule actions.'
    );
    expect(describeScheduleState({ ...state, instantPublish: true })).toBe(
      'This content is ready to be published immediately from the Publish pane.'
    );
    expect(describeScheduleState(state)).toBe('Select a date and time for scheduled publishing.');
    expect(
      describeScheduleState({ ...state, scheduledDate: '2030-01-11', scheduledTime: '09:30' })
    ).toMatch(/^Scheduled to publish on /);
  });
});

describe('cover prompt sentences', () => {
  it('says which prompt a queued cover will use', () => {
    expect(describeCoverQueued('my prompt', { setName: 'Ops' })).toMatch(
      /queued using your prompt override\./
    );
    expect(describeCoverQueued('', { setName: 'Ops' })).toMatch(/using the "Ops" image set\./);
    expect(describeCoverQueued('', null)).toMatch(/using the built-in prompt\./);
  });

  it('describes where an assigned set came from', () => {
    expect(
      describeCoverPlanSource({ promptName: 'Hero', source: 'page', pagePath: '/blog/azure' })
    ).toBe(' (Hero), assigned to /blog/azure');
    expect(describeCoverPlanSource({ source: 'content' })).toBe(', recorded on this content');
  });

  it('lists the pages a plan looked at, or nothing', () => {
    expect(formatPlanPagePaths({ pagePaths: ['/a', '/b'] })).toBe(' (/a, /b)');
    expect(formatPlanPagePaths({ pagePaths: [] })).toBe('');
    expect(formatPlanPagePaths({})).toBe('');
  });
});

describe('appendGalleryImage', () => {
  const images = [{ id: 'x', url: 'one.png' }];

  it('returns the same list for an empty pick or a duplicate', () => {
    expect(appendGalleryImage(images, null, 'c1')).toBe(images);
    expect(appendGalleryImage(images, { imageUrl: '  ' }, 'c1')).toBe(images);
    expect(appendGalleryImage(images, { imageUrl: 'one.png' }, 'c1')).toBe(images);
  });

  it('appends a gallery pick labelled by position and caps the list at four', () => {
    const next = appendGalleryImage(images, { imageUrl: ' two.png ' }, 'c1');
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ url: 'two.png', label: 'Secondary 1', sourceLabel: 'Gallery' });
    expect(next[1].id.startsWith('c1-')).toBe(true);
    const four = ['a', 'b', 'c', 'd'].map((url) => ({ id: url, url }));
    expect(appendGalleryImage(four, { imageUrl: 'e' }, 'c1')).toHaveLength(4);
  });
});

describe('truncate', () => {
  it('cuts long text with an ellipsis and leaves short text alone', () => {
    expect(truncate('abcdef', 3)).toBe('abc...');
    expect(truncate('abc', 3)).toBe('abc');
  });
});

describe('hasPublishedAddress', () => {
  it('is true once a publish has written the address, even after an unpublish (#1628)', () => {
    const slug = 'ai-c1';
    expect(hasPublishedAddress({ slug, contentStatus: 'published' })).toBe(true);
    expect(
      hasPublishedAddress({
        slug,
        contentStatus: 'inspected',
        curatedSubpagePath: '/azure/blog/ai-c1',
      })
    ).toBe(true);
    expect(hasPublishedAddress({ slug, contentStatus: 'approved', Live: true })).toBe(true);
    expect(hasPublishedAddress({ Slug: slug, contentStatus: 'approved', Status: 'Live' })).toBe(
      true
    );
    expect(hasPublishedAddress({ slug, contentStatus: 'published_blog' })).toBe(true);
    expect(hasPublishedAddress({ slug, contentStatus: 'inspected' })).toBe(false);
    expect(hasPublishedAddress(undefined)).toBe(false);
  });

  it('is false without a stored slug, because the server then builds a new address (#1628)', () => {
    expect(
      hasPublishedAddress({ contentStatus: 'published', curatedSubpagePath: '/azure/blog/x' })
    ).toBe(false);
  });
});

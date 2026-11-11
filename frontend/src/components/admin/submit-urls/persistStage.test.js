/**
 * Stage 4 is the only stage that writes anything durable, and until #634 the
 * payload it writes had no test at all — it was built inline in a click
 * handler on a 2,900-line page.
 *
 * These run the builders and the two save paths directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  buildContentCreatePayload,
  createAndOpenEditor,
  getEditorPath,
  getQueueReviewPath,
  parseLineItems,
  persistContentItem,
  savePreview,
} from './persistStage';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

function payloadInput(overrides = {}) {
  return {
    sourceUrl: '  https://kb.example.com/1  ',
    sourceUrls: ['https://kb.example.com/1'],
    provider: '',
    blogLandingProvider: '',
    draftTitle: 'A title',
    title: '',
    draftSummary: 'A summary',
    draftContent: 'body',
    draftTopics: ['t1'],
    summaryPrompt: 'sp',
    detailsPrompt: 'dp',
    publishedDate: '',
    heroImageUrl: '',
    secondaryImageUrls: [],
    aiImageUrls: {},
    contentType: 'blog',
    frameworkSourceUrls: '',
    frameworkKnowledgePrompt: '',
    frameworkDiagramPrompt: '',
    frameworkImagePrompt: '',
    frameworkConceptSeeds: '',
    ...overrides,
  };
}

function persistBag(overrides = {}) {
  return {
    canPreview: true,
    readinessComplete: true,
    contentType: 'blog',
    draftContent: 'body',
    draftSummary: 'A summary',
    draftTitle: 'A title',
    draftTopics: [],
    detailsPrompt: '',
    frameworkConceptSeeds: '',
    frameworkDiagramPrompt: '',
    frameworkImagePrompt: '',
    frameworkKnowledgePrompt: '',
    frameworkSourceUrls: '',
    generatedImages: {},
    kbArticleUrls: ['https://kb.example.com/1'],
    publishedDate: '',
    resolvedBlogLandingProvider: '',
    resolvedProvider: 'Azure',
    selectedGenerated: {},
    selectedUploaded: {},
    slotUrls: {},
    sourceUrl: '',
    summaryPrompt: '',
    title: '',
    navigate: vi.fn(),
    setCreateAndOpenSaving: vi.fn(),
    setError: vi.fn(),
    setPreviewSaving: vi.fn(),
    setResult: vi.fn(),
    setSavedContentId: vi.fn(),
    ...overrides,
  };
}

describe('parseLineItems', () => {
  it('splits on newlines, commas and semicolons, dropping blanks', () => {
    expect(parseLineItems('a\n b , c;;d\n\n')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is empty for nothing', () => {
    expect(parseLineItems('')).toEqual([]);
    expect(parseLineItems()).toEqual([]);
  });
});

describe('the saved-content paths', () => {
  it('point at the editor and at the review queue', () => {
    expect(getEditorPath('abc123')).toContain('abc123');
    expect(getQueueReviewPath('abc123')).toContain('abc123');
    // The review link declares where the item came from.
    expect(getQueueReviewPath('abc123')).toContain('source=content');
  });
});

describe('buildContentCreatePayload', () => {
  it('never marks the draft live or approved', () => {
    // Saving is not publishing. If these ever default true, a save becomes a
    // publish and the human gate is gone.
    const payload = buildContentCreatePayload(payloadInput());
    expect(payload.Live).toBe(false);
    expect(payload.approvedForBlog).toBe(false);
    expect(payload.contentStatus).toBe('inspected');
  });

  it('trims the source URL into all three of its homes', () => {
    const payload = buildContentCreatePayload(payloadInput());
    expect(payload.url).toBe('https://kb.example.com/1');
    expect(payload.sourceUrl).toBe('https://kb.example.com/1');
    expect(payload['CD Url']).toBe('https://kb.example.com/1');
  });

  it('writes the title and content under both casings the collection reads', () => {
    // Not a mistake: older readers take the capitalised keys, newer ones the
    // lowercase, and the same value has to satisfy both.
    const payload = buildContentCreatePayload(payloadInput());
    expect(payload.Title).toBe(payload.title);
    expect(payload.Content).toBe(payload.content);
    expect(payload.content).toBe(payload.postContent);
  });

  it('carries the kind and idea origin from Stage 1, and neither key when unset (ADR 0033 §4)', () => {
    const classified = buildContentCreatePayload(
      payloadInput({ kind: 'tutorial', ideaOrigin: 'audience-question' })
    );
    expect(classified.kind).toBe('tutorial');
    expect(classified.ideaOrigin).toBe('audience-question');

    const unset = buildContentCreatePayload(payloadInput());
    expect('kind' in unset).toBe(false);
    expect('ideaOrigin' in unset).toBe(false);
  });

  it('writes the address topic only when it is one of the list (#1628)', () => {
    expect(buildContentCreatePayload(payloadInput({ draftTopic: 'hybrid' })).topic).toBe('hybrid');
    // '' (pick automatically), a word not on the list, and no value at all
    // leave the key out, so the server picks one at publish.
    for (const draftTopic of ['', 'kubernetes', undefined, null]) {
      expect('topic' in buildContentCreatePayload(payloadInput({ draftTopic }))).toBe(false);
    }
  });

  it('falls back from the generated title to the typed one', () => {
    const payload = buildContentCreatePayload(payloadInput({ draftTitle: '', title: 'Typed' }));
    expect(payload.title).toBe('Typed');
  });

  it('omits the image keys entirely when there is no hero', () => {
    const payload = buildContentCreatePayload(payloadInput());
    expect('heroImageUrl' in payload).toBe(false);
    expect('secondaryImageUrls' in payload).toBe(false);
  });

  it('mirrors a hero into the cover fields when there is one', () => {
    const payload = buildContentCreatePayload(payloadInput({ heroImageUrl: '/m/h.png' }));
    expect(payload.contentImageUrl).toBe('/m/h.png');
    expect(payload.altCoverImage).toBe('/m/h.png');
  });

  it('carries no framework keys for a blog', () => {
    const payload = buildContentCreatePayload(
      payloadInput({ frameworkSourceUrls: 'https://a.com' })
    );
    expect('frameworkSourceUrls' in payload).toBe(false);
    expect('officialSources' in payload).toBe(false);
  });

  it('parses and filters the framework sources for a framework', () => {
    const payload = buildContentCreatePayload(
      payloadInput({
        contentType: 'framework',
        frameworkSourceUrls: 'https://a.com\nnot-a-url\nhttps://b.com',
        frameworkConceptSeeds: 'one, two',
      })
    );
    // The invalid line is dropped rather than shipped.
    expect(payload.frameworkSourceUrls).toEqual(['https://a.com', 'https://b.com']);
    expect(payload.officialSources).toEqual(payload.frameworkSourceUrls);
    expect(payload.frameworkConceptSeeds).toEqual(['one', 'two']);
  });

  it('omits the published date unless one was set', () => {
    expect('Published At' in buildContentCreatePayload(payloadInput())).toBe(false);
    const dated = buildContentCreatePayload(payloadInput({ publishedDate: '2026-01-02' }));
    expect(dated['Published At']).toBeInstanceOf(Date);
  });

  it('adds a landing zone only when a blog landing provider is set', () => {
    const plain = buildContentCreatePayload(payloadInput());
    expect('targetLandingZone' in plain).toBe(false);
    const zoned = buildContentCreatePayload(payloadInput({ blogLandingProvider: 'Azure' }));
    expect(zoned.landingProvider).toBe('Azure');
    expect(zoned.targetLandingZone.startsWith('/azure/')).toBe(true);
  });

  it('never lets kbArticleUrls be a non-array', () => {
    const payload = buildContentCreatePayload(payloadInput({ sourceUrls: undefined }));
    expect(payload.kbArticleUrls).toEqual([]);
  });
});

describe('persistContentItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postJSON.mockResolvedValue({ contentId: 'new-id' });
  });

  it('writes nothing until the readiness gate is met', async () => {
    expect(await persistContentItem(persistBag({ readinessComplete: false }))).toBeNull();
    expect(await persistContentItem(persistBag({ canPreview: false }))).toBeNull();
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('returns the new id and remembers it', async () => {
    const state = persistBag();
    expect(await persistContentItem(state)).toBe('new-id');
    expect(state.setSavedContentId).toHaveBeenCalledWith('new-id');
  });

  it('returns null and reports when the write fails', async () => {
    postJSON.mockRejectedValue(new Error('collection refused'));
    const state = persistBag();
    expect(await persistContentItem(state)).toBeNull();
    expect(state.setError).toHaveBeenCalledWith('collection refused');
  });

  it('sends the selected images, uploaded winning over generated', async () => {
    const state = persistBag({
      slotUrls: { hero: '/m/up.png' },
      selectedUploaded: { hero: true },
      generatedImages: { hero: '/m/gen.png', secondary1: '/m/s1.png' },
      selectedGenerated: { hero: true, secondary1: true },
    });
    await persistContentItem(state);
    const [[, body]] = postJSON.mock.calls;
    expect(body.data.heroImageUrl).toBe('/m/up.png');
    expect(body.data.secondaryImageUrls).toEqual(['/m/s1.png']);
    // Only the generated one is reported as AI-made.
    expect(body.data.aiImageUrls).toEqual({ secondary1: '/m/s1.png' });
  });

  it('sends the address topic the drafting step suggested (#1628)', async () => {
    await persistContentItem(persistBag({ draftTopic: 'security' }));
    const [[, body]] = postJSON.mock.calls;
    expect(body.data.topic).toBe('security');
  });
});

describe('savePreview', () => {
  const event = () => ({ preventDefault: vi.fn() });

  beforeEach(() => {
    vi.clearAllMocks();
    postJSON.mockResolvedValue({ contentId: 'new-id' });
  });

  it('reports success with the new id', async () => {
    const state = persistBag();
    await savePreview(state, event());
    expect(state.setResult).toHaveBeenCalledWith({
      stage: 4,
      message: 'Draft saved to content collection.',
      contentId: 'new-id',
    });
  });

  it('claims nothing when the write failed', async () => {
    // The error is already reported by persistContentItem; a success banner on
    // top of it would contradict the error the operator is looking at.
    postJSON.mockRejectedValue(new Error('collection refused'));
    const state = persistBag();
    await savePreview(state, event());
    expect(state.setResult).toHaveBeenCalledTimes(1);
    expect(state.setResult).toHaveBeenCalledWith(null);
  });

  it('always clears the spinner', async () => {
    postJSON.mockRejectedValue(new Error('collection refused'));
    const state = persistBag();
    await savePreview(state, event());
    expect(state.setPreviewSaving).toHaveBeenLastCalledWith(false);
  });
});

describe('createAndOpenEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postJSON.mockResolvedValue({ contentId: 'new-id' });
  });

  it('navigates to the new item', async () => {
    const state = persistBag();
    await createAndOpenEditor(state);
    expect(state.navigate).toHaveBeenCalledWith(expect.stringContaining('new-id'));
  });

  it('stays put when the write failed', async () => {
    postJSON.mockRejectedValue(new Error('collection refused'));
    const state = persistBag();
    await createAndOpenEditor(state);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.setCreateAndOpenSaving).toHaveBeenLastCalledWith(false);
  });

  it('stays put when the response carried no id', async () => {
    // A 200 with no contentId is not a save.
    postJSON.mockResolvedValue({});
    const state = persistBag();
    await createAndOpenEditor(state);
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

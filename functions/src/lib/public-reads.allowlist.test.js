/**
 * The public reads return an ALLOWLIST of fields, never a stored document.
 *
 * Writers put operational state on the same documents these routes serve: a
 * caption or cover generation failure, an inspection error and its time, a
 * Listen & Learn regeneration failure kept on a chapter that stays published,
 * job ids, actors, grades and the speech provenance of an audio take. A
 * denylist has to name each of those to keep it private, and every field a
 * writer adds later is public until someone notices. These tests pin the
 * other direction: a field is public only when it is listed, and the lists
 * are derived from what the public pages read.
 *
 * Three kinds of assertion:
 *   1. LEAK: a document carrying every internal field the writers set, each
 *      holding a sentinel string, answers with no sentinel anywhere in the
 *      response body.
 *   2. GUARD: a document carrying a field no list names (a future writer's)
 *      answers with keys that are a subset of the allowlist, so a new field
 *      is withheld until someone lists it on purpose.
 *   3. COMPATIBILITY: every field the public pages read is on the list, pinned
 *      against the frontend source itself, so dropping one fails here rather
 *      than blanking a page.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createPublicReadHandlers,
  PUBLIC_CONTENT_LIST_FIELDS,
  PUBLIC_CONTENT_DETAIL_FIELDS,
  PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS,
  PUBLIC_LISTEN_AND_LEARN_SET_FIELDS,
  PUBLIC_PODCAST_FIELDS,
  PUBLIC_FEED_CACHE_FIELDS,
  projectFields,
} from './public-reads.js';
import {
  buildPreviewToken,
  createPublicPreviewHandlers,
  PUBLIC_PREVIEW_FIELDS,
} from './public-preview.js';
import { ARTICLE_FIELDS } from './public-content-manifest.js';

const SENTINEL = 'INTERNAL-SENTINEL';
const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

const makeRequest = ({ query = {}, params = {} } = {}) => ({
  method: 'GET',
  query: { get: (k) => query[k] ?? null },
  params,
});

/**
 * Every operational field a content writer is known to set, each holding the
 * sentinel. Named from the writers: triggers/social-caption-trigger.js,
 * triggers/ai-cover.js, triggers/handlers.js and content/inspect-job.js
 * (inspectError/inspectErrorAt), content/forge.js (forgeMeta, forgeGrade,
 * contentQuality, imageReadiness), the editorial workflow's actor stamps, the
 * publish integrations' job ids and sync errors, and the framework builder's
 * generation prompts (admin/submit-urls persistStage.js).
 */
const INTERNAL_CONTENT_FIELDS = Object.freeze({
  frameworkKnowledgePrompt: `${SENTINEL} knowledge prompt`,
  frameworkImagePrompt: `${SENTINEL} image prompt`,
  frameworkDiagramPrompt: `${SENTINEL} diagram prompt`,
  socialCaption: `${SENTINEL} caption text`,
  socialCaptionError: `${SENTINEL} caption provider refused`,
  socialCaptionTrigger: false,
  altCoverImageError: `fallback: default hero (${SENTINEL} image model refused)`,
  altCoverImageTrigger: false,
  inspectError: `${SENTINEL} 429 from the store`,
  inspectErrorAt: `${SENTINEL}-2026-10-15T00:00:00.000Z`,
  inspectTrigger: false,
  lastError: { message: `${SENTINEL} regeneration failed`, attempt: 'regeneration' },
  error: `${SENTINEL} job failed`,
  syncError: `${SENTINEL} sync failed`,
  publerJobId: `${SENTINEL}-job`,
  createSlugPageTrigger: false,
  forgeReadyNotifyTrigger: false,
  forgeReadyNotifyAttempts: 2,
  forgeMeta: { model: `${SENTINEL}-model`, forgedBy: `${SENTINEL}@example.com` },
  contentQuality: { verdict: SENTINEL },
  imageQuality: { note: SENTINEL },
  imageReadiness: { note: SENTINEL },
  imageLineage: { promptSet: SENTINEL },
  critiqueVerdict: SENTINEL,
  critiqueIssues: [SENTINEL],
  reviewNotes: SENTINEL,
  reviewedBy: `${SENTINEL}@example.com`,
  createdBy: `${SENTINEL}@example.com`,
  updatedBy: `${SENTINEL}@example.com`,
  versionCreatedBy: `${SENTINEL}@example.com`,
  approvedBy: `${SENTINEL}@example.com`,
  sentToReviewBy: `${SENTINEL}@example.com`,
  returnedToDraftsBy: `${SENTINEL}@example.com`,
  requestedBy: `${SENTINEL}@example.com`,
  heldBy: `${SENTINEL}@example.com`,
  addedBy: `${SENTINEL}@example.com`,
  aFieldNoWriterHasAddedYet: SENTINEL,
  _etag: SENTINEL,
  _rid: SENTINEL,
});

/** A published article, as public as a document gets, plus every internal field. */
const leakyPublishedDoc = (over = {}) => ({
  id: 'article-1',
  slug: 'article-1',
  Title: 'Public title',
  summary: 'Public summary',
  content: 'Public body',
  Live: true,
  contentStatus: 'published',
  publishedAt: '2026-10-01T00:00:00Z',
  ...INTERNAL_CONTENT_FIELDS,
  // forge writes the grade on every forged document, and it outlives publication.
  forgeGrade: {
    overall: 81,
    threshold: 75,
    gradedBy: `${SENTINEL}-pipeline`,
    promptVersion: SENTINEL,
    subs: { clarity: SENTINEL },
    seo: { findings: [{ key: 'meta_description_short', message: 'Summary is short.' }] },
  },
  ...over,
});

/** The fields a frontend source file reads off the named variables. */
function fieldsReadIn(relativePath, variables) {
  const source = readFileSync(new URL(`../../../frontend/src/${relativePath}`, import.meta.url), 'utf8');
  const names = variables.join('|');
  const fields = new Set();
  // Not preceded by `.`, so `audioRef.current?.play` is not read as `current.play`.
  const variable = `(?<![\\w$.])(?:${names})`;
  const dotted = new RegExp(`${variable}(?:\\?\\.|\\.)(?!\\[)([A-Za-z_$][\\w$]*)`, 'g');
  const bracketed = new RegExp(`${variable}(?:\\?\\.)?\\[\\s*'([^']+)'\\s*\\]`, 'g');
  for (const match of source.matchAll(dotted)) fields.add(match[1]);
  for (const match of source.matchAll(bracketed)) fields.add(match[1]);
  return fields;
}

/** The fields not on the allowlist; `[]` when every one is listed. */
const missingFrom = (allowlist, fields) => [...fields].filter((f) => !allowlist.includes(f));

describe('projectFields', () => {
  it('copies only the named fields a document defines', () => {
    expect(projectFields({ a: 1, b: undefined, c: 3, d: null }, ['a', 'b', 'd', 'z'])).toEqual({
      a: 1,
      d: null,
    });
  });

  it('answers an empty object for a missing document', () => {
    expect(projectFields(null, ['a'])).toEqual({});
    expect(projectFields(undefined, ['a'])).toEqual({});
  });

  it('never reads a field off the prototype', () => {
    expect(projectFields(Object.create({ inherited: SENTINEL }), ['inherited'])).toEqual({});
  });
});

describe('getContent — the public article detail', () => {
  const byId = (doc) => ({
    readDoc: vi.fn(async (container, id) => (container === 'content' && id === doc.id ? doc : null)),
    queryDocs: vi.fn(async () => []),
  });
  const bySlug = (doc) => ({
    readDoc: vi.fn(async () => null),
    queryDocs: vi.fn(async (container, query) =>
      container === 'content' && query.includes('c["slug"]') ? [doc] : []
    ),
  });

  for (const [path, storeFor, key] of [
    ['a point read by id', byId, 'article-1'],
    ['a slug lookup', bySlug, 'article-1'],
  ]) {
    it(`returns no internal field through ${path}`, async () => {
      const h = createPublicReadHandlers({ store: storeFor(leakyPublishedDoc()) });
      const res = await h.getContent(makeRequest({ params: { slugOrId: key } }), context);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(SENTINEL);
      const { item } = JSON.parse(res.body);
      for (const field of Object.keys(INTERNAL_CONTENT_FIELDS)) {
        expect(item, `${field} reached the public detail`).not.toHaveProperty(field);
      }
      expect(item).not.toHaveProperty('forgeGrade');
      // What the page renders is still there.
      expect(item).toMatchObject({ Title: 'Public title', summary: 'Public summary', content: 'Public body' });
    });

    it(`answers only allowlisted keys through ${path}`, async () => {
      const h = createPublicReadHandlers({ store: storeFor(leakyPublishedDoc()) });
      const res = await h.getContent(makeRequest({ params: { slugOrId: key } }), context);
      const { item } = JSON.parse(res.body);
      expect(missingFrom(PUBLIC_CONTENT_DETAIL_FIELDS, Object.keys(item))).toEqual([]);
    });
  }

  it('keeps every allowlisted field a document holds', async () => {
    const full = Object.fromEntries(PUBLIC_CONTENT_DETAIL_FIELDS.map((f) => [f, `value of ${f}`]));
    const doc = { ...full, ...INTERNAL_CONTENT_FIELDS, id: 'full', Live: true };
    const h = createPublicReadHandlers({ store: byId(doc) });
    const { item } = JSON.parse(
      (await h.getContent(makeRequest({ params: { slugOrId: 'full' } }), context)).body
    );
    expect(Object.keys(item).sort()).toEqual([...PUBLIC_CONTENT_DETAIL_FIELDS].sort());
  });

  it('projects the slug lookup in SQL, carrying the fields the visibility filter reads', async () => {
    const store = { readDoc: vi.fn(async () => null), queryDocs: vi.fn(async () => []) };
    await createPublicReadHandlers({ store }).getContent(
      makeRequest({ params: { slugOrId: 'anything' } }),
      context
    );
    expect(store.queryDocs).toHaveBeenCalled();
    for (const [, query] of store.queryDocs.mock.calls) {
      expect(query).not.toMatch(/SELECT TOP \d+ \*/);
      for (const field of ['Live', 'Status', 'contentStatus', 'softDeletedAt', 'softDeleteExpiresAt']) {
        expect(query, `projection lost ${field}, which isPublicDocument reads`).toContain(`c["${field}"]`);
      }
      expect(query).not.toContain('c["inspectError"]');
    }
  });

  it('still refuses an unpublished document the projection carries the status of', async () => {
    const draft = leakyPublishedDoc({ Live: false, contentStatus: 'in_review' });
    const res = await createPublicReadHandlers({ store: bySlug(draft) }).getContent(
      makeRequest({ params: { slugOrId: 'article-1' } }),
      context
    );
    expect(res.status).toBe(404);
  });

  it('names no operational field', () => {
    const operational = /(Error|ErrorAt|Trigger|Attempts|JobId|By|Prompt)$|^(error|lastError|inspect|forge|critique|review)|Quality$|Readiness$|Lineage$/;
    expect(PUBLIC_CONTENT_DETAIL_FIELDS.filter((f) => operational.test(f))).toEqual([]);
  });

  it('carries no generation prompt on any public content list', () => {
    // The framework builder stores the prompts it generated with; they are
    // admin-side inputs, read only through the editor-gated cms routes.
    for (const [name, fields] of [
      ['PUBLIC_CONTENT_LIST_FIELDS', PUBLIC_CONTENT_LIST_FIELDS],
      ['PUBLIC_CONTENT_DETAIL_FIELDS', PUBLIC_CONTENT_DETAIL_FIELDS],
      ['PUBLIC_PREVIEW_FIELDS', PUBLIC_PREVIEW_FIELDS],
    ]) {
      expect(fields.filter((f) => /prompt/i.test(f)), name).toEqual([]);
    }
  });

  it('covers every field useFrameworkData reads from a list row (pinned against the source)', () => {
    const read = fieldsReadIn('hooks/useFrameworkData.js', ['doc']);
    expect(read.size).toBeGreaterThan(30);
    expect(missingFrom(PUBLIC_CONTENT_LIST_FIELDS, read)).toEqual([]);
  });

  it('serves at least what the list serves for the same document, less the visibility markers', () => {
    const visibility = ['Live', 'Status', 'contentStatus', 'softDeletedAt', 'softDeleteExpiresAt'];
    const listed = PUBLIC_CONTENT_LIST_FIELDS.filter((f) => !visibility.includes(f));
    expect(missingFrom(PUBLIC_CONTENT_DETAIL_FIELDS, listed)).toEqual([]);
    for (const field of visibility) expect(PUBLIC_CONTENT_DETAIL_FIELDS).not.toContain(field);
  });

  it('serves every field the pre-render manifest keeps', () => {
    // public-content-manifest.js promises every manifest field is already
    // served by public/content; the pre-rendered article is the same page.
    expect(missingFrom(PUBLIC_CONTENT_DETAIL_FIELDS, ARTICLE_FIELDS)).toEqual([]);
  });

  describe('covers every field the detail templates read (pinned against the source)', () => {
    // Read only in previewMode: the preview banner's status and grade. The
    // preview allowlist carries them; the public detail does not.
    const PREVIEW_ONLY = ['contentStatus', 'forgeGrade'];

    it('BlogDetailTemplate', () => {
      const read = fieldsReadIn('components/templates/BlogDetailTemplate.jsx', ['article']);
      expect(read.size).toBeGreaterThan(30);
      const publicRead = [...read].filter((f) => !PREVIEW_ONLY.includes(f));
      expect(missingFrom(PUBLIC_CONTENT_DETAIL_FIELDS, publicRead)).toEqual([]);
    });

    it('ArchitectureDetailTemplate', () => {
      const read = fieldsReadIn('components/templates/ArchitectureDetailTemplate.jsx', [
        'architecture',
        'item',
      ]);
      expect(read.size).toBeGreaterThan(30);
      expect(missingFrom(PUBLIC_CONTENT_DETAIL_FIELDS, read)).toEqual([]);
    });

    it('FrameworkDetailTemplate', () => {
      const read = fieldsReadIn('components/templates/FrameworkDetailTemplate.jsx', [
        'framework',
        'item',
      ]);
      expect(read.size).toBeGreaterThan(15);
      expect(missingFrom(PUBLIC_CONTENT_DETAIL_FIELDS, read)).toEqual([]);
    });
  });
});

describe('getPreview — the signed staging preview', () => {
  const SECRET = 'test-secret';
  const NOW = 1_700_000_000_000;
  const preview = async (doc) => {
    const handlers = createPublicPreviewHandlers({
      store: { readDoc: vi.fn(async () => doc) },
      env: { PREVIEW_SIGNING_SECRET: SECRET },
      now: () => NOW,
    });
    const query = new Map([['t', buildPreviewToken(SECRET, doc.id, { now: () => NOW })]]);
    return handlers.getPreview({ params: { contentId: doc.id }, query });
  };
  const draft = () => leakyPublishedDoc({ Live: false, contentStatus: 'forge_ready' });

  it('returns no internal field, and only the grade fields the banner reads', async () => {
    const res = await preview(draft());
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(SENTINEL);
    const { item } = JSON.parse(res.body);
    for (const field of Object.keys(INTERNAL_CONTENT_FIELDS)) {
      expect(item, `${field} reached the preview`).not.toHaveProperty(field);
    }
    expect(item.contentStatus).toBe('forge_ready');
    expect(item.forgeGrade).toEqual({
      overall: 81,
      threshold: 75,
      seo: { findings: [{ key: 'meta_description_short', message: 'Summary is short.' }] },
    });
  });

  it('answers only allowlisted keys', async () => {
    const { item } = JSON.parse((await preview(draft())).body);
    expect(missingFrom(PUBLIC_PREVIEW_FIELDS, Object.keys(item))).toEqual([]);
  });

  it('is the public detail plus the banner fields, nothing else', () => {
    expect(missingFrom(PUBLIC_PREVIEW_FIELDS, PUBLIC_CONTENT_DETAIL_FIELDS)).toEqual([]);
    expect(PUBLIC_PREVIEW_FIELDS.filter((f) => !PUBLIC_CONTENT_DETAIL_FIELDS.includes(f)).sort()).toEqual(
      ['contentStatus', 'forgeGrade']
    );
  });

  it('covers every field BlogDetailTemplate and PreviewPage read', () => {
    const read = new Set([
      ...fieldsReadIn('components/templates/BlogDetailTemplate.jsx', ['article']),
      ...fieldsReadIn('pages/PreviewPage.jsx', ['item']),
    ]);
    expect(missingFrom(PUBLIC_PREVIEW_FIELDS, read)).toEqual([]);
  });
});

/**
 * A published chapter whose regeneration failed: `saveEpisodeFailure` keeps
 * it published and records `lastError`, and `toEpisodeDoc` / `mergeRegeneration`
 * store the take's provenance beside the audio (listen-and-learn/publish.js).
 */
const leakyEpisode = (over = {}) => ({
  id: 'plan',
  setId: 'azure_az-104',
  provider: 'azure',
  examCode: 'AZ-104',
  areaSlug: 'plan',
  areaName: 'Plan',
  kind: 'guide',
  order: 0,
  weightLabel: '20-25%',
  title: 'Planning',
  summary: 'Public summary',
  keyTakeaways: ['One'],
  transcript: [{ speaker: 'Host', text: 'Hello' }],
  videos: [{ videoId: 'v1', url: 'https://www.youtube.com/watch?v=v1', title: 'Video', duration: '9:00' }],
  sources: [],
  audioUrl: '/api/public/media/listenandlearn/azure/az-104/plan.mp3',
  audioBytes: 1024,
  durationSeconds: 540,
  approvedAt: '2026-10-01T00:00:00Z',
  generatedAt: '2026-09-30T00:00:00Z',
  status: 'published',
  lastError: { message: `${SENTINEL} speech provider said no`, at: 'x', attempt: 'regeneration' },
  error: `${SENTINEL} failed`,
  audioError: `${SENTINEL} no key`,
  audioPath: `${SENTINEL}/path.mp3`,
  speechProvider: `${SENTINEL}-provider`,
  speechModel: `${SENTINEL}-model`,
  versions: [{ id: 'v1', speechProvider: SENTINEL, costUsd: 0.1, generatedBy: SENTINEL, active: true }],
  approvedBy: `${SENTINEL}@example.com`,
  updatedBy: `${SENTINEL}@example.com`,
  sourceText: SENTINEL,
  sourceContentId: SENTINEL,
  statusBeforeArchive: SENTINEL,
  speakers: { a: SENTINEL, b: SENTINEL },
  weightLow: 20,
  firstGeneratedAt: SENTINEL,
  regeneratedAt: SENTINEL,
  titleEditedAt: SENTINEL,
  aFieldNoWriterHasAddedYet: SENTINEL,
  _ts: 1,
  ...over,
});

/** A set as saveSet and the Audio Library write it, plus operational fields. */
const leakySet = () => ({
  id: 'azure_az-104',
  provider: 'azure',
  examCode: 'AZ-104',
  kind: 'course',
  certSlug: 'az-104',
  certTitle: 'Azure Administrator',
  title: 'Azure Administrator',
  studyGuideUrl: 'https://learn.microsoft.com/credentials/az-104',
  studyGuideTitle: 'Study guide',
  areaCount: 5,
  voice: { provider: `${SENTINEL}-provider`, name: SENTINEL },
  areaSlugs: ['plan'],
  generatedBy: `${SENTINEL}@example.com`,
  updatedBy: `${SENTINEL}@example.com`,
  lastError: `${SENTINEL} run failed`,
  aFieldNoWriterHasAddedYet: SENTINEL,
  _etag: SENTINEL,
});

describe('getListenAndLearn — one certification’s published chapters', () => {
  const get = (set, episodes) => {
    const store = { readDoc: vi.fn(async () => set), queryDocs: vi.fn(async () => episodes) };
    const h = createPublicReadHandlers({ store });
    return { store, res: h.getListenAndLearn(makeRequest({ query: { platform: 'azure', examCode: 'AZ-104' } }), context) };
  };

  it('returns no failure, provenance or actor field from a chapter or its set', async () => {
    const res = await get(leakySet(), [leakyEpisode()]).res;
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(SENTINEL);
    const body = JSON.parse(res.body);
    for (const field of ['lastError', 'error', 'audioError', 'speechProvider', 'speechModel', 'versions', 'audioPath', 'approvedBy']) {
      expect(body.episodes[0], `${field} reached the public chapter`).not.toHaveProperty(field);
    }
    for (const field of ['voice', 'generatedBy', 'updatedBy', 'lastError', 'areaSlugs']) {
      expect(body.set, `${field} reached the public set`).not.toHaveProperty(field);
    }
  });

  it('answers only allowlisted keys for the set and every chapter', async () => {
    const body = JSON.parse((await get(leakySet(), [leakyEpisode()]).res).body);
    expect(missingFrom(PUBLIC_LISTEN_AND_LEARN_SET_FIELDS, Object.keys(body.set))).toEqual([]);
    for (const episode of body.episodes) {
      expect(missingFrom(PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS, Object.keys(episode))).toEqual([]);
    }
  });

  it('keeps what the study page renders', async () => {
    const body = JSON.parse((await get(leakySet(), [leakyEpisode()]).res).body);
    expect(body.episodes[0]).toMatchObject({
      title: 'Planning',
      keyTakeaways: ['One'],
      transcript: [{ speaker: 'Host', text: 'Hello' }],
      videos: [{ videoId: 'v1' }],
      audioUrl: '/api/public/media/listenandlearn/azure/az-104/plan.mp3',
    });
    expect(body.set).toMatchObject({ certTitle: 'Azure Administrator', studyGuideUrl: expect.any(String) });
  });

  it('projects the chapter query in SQL', async () => {
    const { store, res } = get(leakySet(), []);
    await res;
    const [, query] = store.queryDocs.mock.calls[0];
    expect(query).not.toMatch(/SELECT TOP \d+ \*/);
    expect(query).toContain('c["transcript"]');
    expect(query).not.toContain('c["lastError"]');
  });

  it('covers every field ListenAndLearn and EpisodePlaylist read (pinned against the source)', () => {
    const read = new Set([
      ...fieldsReadIn('components/education/ListenAndLearn.jsx', ['episode']),
      ...fieldsReadIn('components/education/EpisodePlaylist.jsx', ['chapter', 'current']),
      // Read through other names: `episodes[0]?.audioBytes` and the sort's `a.order`.
      'audioBytes',
      'order',
    ]);
    expect(read.size).toBeGreaterThan(10);
    expect(missingFrom(PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS, read)).toEqual([]);
  });
});

describe('listPodcasts and getFeed — the other anonymous whole-document reads', () => {
  it('listPodcasts answers only allowlisted keys and projects in SQL', async () => {
    const store = {
      queryDocs: vi.fn(async () => [
        {
          id: 'ep-1',
          provider: 'main',
          title: 'Episode',
          mediaUrl: 'https://mcdn.podbean.com/ep-1.mp3',
          publishedAt: '2026-10-14T00:00:00Z',
          updatedAt: '2026-10-15T00:00:00Z',
          lastError: SENTINEL,
          aFieldNoWriterHasAddedYet: SENTINEL,
          _rid: SENTINEL,
        },
      ]),
      readDoc: vi.fn(async () => null),
    };
    const res = await createPublicReadHandlers({ store }).listPodcasts(
      makeRequest({ query: { provider: 'azure' } }),
      context
    );
    expect(res.body).not.toContain(SENTINEL);
    const { items } = JSON.parse(res.body);
    expect(items.map((i) => i.id)).toEqual(['ep-1']);
    expect(missingFrom(PUBLIC_PODCAST_FIELDS, Object.keys(items[0]))).toEqual([]);
    const [, query] = store.queryDocs.mock.calls[0];
    expect(query).not.toMatch(/SELECT TOP \d+ \*/);
    for (const field of ['softDeletedAt', 'softDeleteExpiresAt', 'mediaUnavailableAt', 'mediaUrl', 'updatedAt']) {
      expect(query, `projection lost ${field}, which the filter reads`).toContain(`c["${field}"]`);
    }
  });

  it('listPodcasts covers every field the audio pages read', () => {
    const read = new Set([
      ...fieldsReadIn('lib/audioEpisodes.js', ['doc']),
      ...fieldsReadIn('components/admin/recording-hub/EpisodesTab.jsx', ['ep']),
    ]);
    // normalizeListenAndLearnEpisode in the same file reads its own rows.
    for (const notAPodcastField of ['areaName', 'certSlug', 'certTitle', 'examCode', 'approvedAt', 'generatedAt', 'audioUrl', 'summary', 'durationSeconds', 'setId', 'kind']) {
      read.delete(notAPodcastField);
    }
    expect(read.size).toBeGreaterThan(5);
    expect(missingFrom(PUBLIC_PODCAST_FIELDS, read)).toEqual([]);
  });

  it('getFeed answers only allowlisted keys and projects in SQL', async () => {
    const store = {
      queryDocs: vi.fn(async () => [
        {
          id: 'c1',
          provider: 'azure',
          feedName: 'Azure Blog',
          items: [{ title: 'x', pubDate: '2026-10-14' }],
          lastError: SENTINEL,
          aFieldNoWriterHasAddedYet: SENTINEL,
          _etag: SENTINEL,
        },
      ]),
      readDoc: vi.fn(),
    };
    const res = await createPublicReadHandlers({ store }).getFeed(
      makeRequest({ query: { provider: 'azure' } }),
      context
    );
    expect(res.body).not.toContain(SENTINEL);
    const [doc] = JSON.parse(res.body).rssCache;
    expect(doc).toMatchObject({ id: 'c1', feedName: 'Azure Blog', items: [{ title: 'x' }] });
    expect(missingFrom(PUBLIC_FEED_CACHE_FIELDS, Object.keys(doc))).toEqual([]);
    const [, query] = store.queryDocs.mock.calls[0];
    expect(query).not.toMatch(/SELECT TOP \d+ \*/);
  });

  it('listContent filters in code as well as in SQL', async () => {
    const store = {
      queryDocs: vi.fn(async () => [leakyPublishedDoc()]),
      readDoc: vi.fn(),
    };
    const res = await createPublicReadHandlers({ store }).listContent(makeRequest(), context);
    expect(res.body).not.toContain(SENTINEL);
    const [item] = JSON.parse(res.body).items;
    expect(missingFrom(PUBLIC_CONTENT_LIST_FIELDS, Object.keys(item))).toEqual([]);
  });
});

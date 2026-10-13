/**
 * Public read endpoints — semantics pinned to the frontend consumers they
 * replace (useCoderCornerData, detail templates, usePodcastData, useNewsData,
 * AboutPage/_snapshots). The load-bearing assertions are the negative ones:
 * a draft, soft-deleted, or internal-field leak here is an anonymous data
 * exposure, because Firestore rules no longer stand in front of these reads.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isPodcastMediaRetired,
  createPublicReadHandlers,
  MAIN_PODCAST_PROVIDER,
  PUBLIC_CONTENT_LIST_FIELDS,
  isSoftDeleted,
  isPublicDocument,
  resolvePublishedDateValue,
  resolveFeedUrlForProvider,
  resolveMainFeedUrl,
  stripInternalFields,
  CURATED_IMAGE_BATCH_MAX,
} from './public-reads.js';

const context = { log: vi.fn(), error: vi.fn() };

const makeRequest = ({ query = {}, params = {} } = {}) => ({
  method: 'GET',
  query: { get: (k) => query[k] ?? null },
  params,
});

const publicDoc = (over = {}) => ({
  id: 'p1',
  Title: 'Public',
  Live: true,
  slug: 'public-1',
  publishedAt: '2026-01-15T00:00:00Z',
  ...over,
});

describe('isPublicDocument', () => {
  it('admits Live, Status=Live, and every published-status spelling', () => {
    expect(isPublicDocument({ Live: true })).toBe(true);
    expect(isPublicDocument({ Status: 'Live' })).toBe(true);
    expect(isPublicDocument({ contentStatus: 'published' })).toBe(true); // new state machine
    expect(isPublicDocument({ contentStatus: 'published_blog' })).toBe(true); // frontend legacy
  });

  it('rejects drafts and anything soft-deleted, even if Live', () => {
    expect(isPublicDocument({ contentStatus: 'draft' })).toBe(false);
    expect(isPublicDocument({ contentStatus: 'in_review' })).toBe(false);
    expect(isPublicDocument({ Live: true, softDeletedAt: '2026-01-01' })).toBe(false);
    expect(isPublicDocument({ Live: true, softDeleteExpiresAt: '2026-01-01' })).toBe(false);
    expect(isPublicDocument({})).toBe(false);
    expect(isPublicDocument(null)).toBe(false);
  });
});

describe('resolvePublishedDateValue', () => {
  it('honors the alias priority and tolerates garbage', () => {
    expect(
      resolvePublishedDateValue({ publishedAt: '2026-03-01', publishedDate: '2026-02-01' })
    ).toBe(new Date('2026-02-01').getTime());
    expect(resolvePublishedDateValue({ publishedAt: 'junk' })).toBe(0);
    expect(resolvePublishedDateValue({})).toBe(0);
  });
});

describe('stripInternalFields', () => {
  it('removes review/audit fields and Cosmos system properties', () => {
    const out = stripInternalFields({
      id: 'x',
      Title: 'T',
      reviewNotes: 'secret',
      contentQuality: { score: 1 },
      createdBy: 'someone@x',
      _rid: 'abc',
      _ts: 123,
    });
    expect(out).toEqual({ id: 'x', Title: 'T' });
  });
});

describe('listContent', () => {
  /** Capture the SQL listContent issues, alongside a benign row. */
  const captureQuery = async (request = makeRequest()) => {
    const store = { queryDocs: vi.fn(async () => [publicDoc()]), readDoc: vi.fn() };
    const h = createPublicReadHandlers({ store });
    await h.listContent(request, context);
    const [, query, parameters] =
      store.queryDocs.mock.calls[0].length === 3
        ? store.queryDocs.mock.calls[0]
        : [null, store.queryDocs.mock.calls[0][1], store.queryDocs.mock.calls[0][2]];
    return { query, parameters };
  };

  describe('the window counts published documents, not all documents (T-206)', () => {
    it('filters public status and soft-deletion in SQL, before TOP applies', async () => {
      // The defect: `SELECT TOP 1000 *` with no WHERE returned an ARBITRARY
      // 1000 of a ~1k-document container, so published articles vanished
      // non-deterministically once the count crossed the window. The filter
      // must narrow the window server-side.
      const { query } = await captureQuery();
      expect(query).toMatch(/^SELECT TOP 1000 /);
      expect(query).toContain('c.Live = true');
      expect(query).toContain('c.Status = "Live"');
      expect(query).toContain(
        'c.contentStatus IN ("published", "published_blog", "published_news", "published_both")'
      );
      expect(query).toContain('softDeletedAt');
      expect(query).toContain('softDeleteExpiresAt');
    });

    it('errs WIDE where SQL and JS truthiness could disagree', async () => {
      // A soft-delete marker holding '', false or 0 is NOT deleted to
      // isSoftDeleted (JS truthiness). The SQL must admit those rows and let
      // the JS filter decide — erring narrow would drop a published article,
      // which is the finding's defect reintroduced through its own fix.
      const { query } = await captureQuery();
      expect(query).toContain('c.softDeletedAt = ""');
      expect(query).toContain('c.softDeletedAt = false');
      expect(query).toContain('c.softDeletedAt = 0');
    });

    it('keeps the type and provider narrowing alongside the public filter', async () => {
      const { query, parameters } = await captureQuery(
        makeRequest({ query: { type: 'coder_corner', provider: 'gcp' } })
      );
      expect(query).toContain('LOWER(c.type) = @type');
      expect(query).toContain('ARRAY_CONTAINS(@providers');
      expect(parameters.find((x) => x.name === '@providers').value).toContain('Google Cloud');
    });

    it('still applies the JS filter as the authority', async () => {
      // The SQL layer only shapes the window; a fake store that ignores the
      // query (as this one does) must still never leak a draft. This is the
      // two-layer contract stated on SQL_PUBLIC_CLAUSE.
      const store = {
        queryDocs: vi.fn(async () => [publicDoc(), { id: 'd', contentStatus: 'draft' }]),
        readDoc: vi.fn(),
      };
      const h = createPublicReadHandlers({ store });
      const res = await h.listContent(makeRequest(), context);
      expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['p1']);
    });
  });

  describe('the ORDER BY switch (T-206 step 3)', () => {
    it('is off by default — the window stays unordered until the operator flips it', async () => {
      const { query } = await captureQuery();
      expect(query).not.toContain('ORDER BY');
    });

    it('orders by the computed property when PUBLIC_LIST_SQL_ORDER=1', async () => {
      // cp_sortDate is a computed property, defined on every document, which
      // is what exempts this from rule 2's "never ORDER BY a possibly-missing
      // field". The flag exists because the property must be applied to the
      // live containers first (the Terraform apply writes it, #816).
      process.env.PUBLIC_LIST_SQL_ORDER = '1';
      try {
        const { query } = await captureQuery();
        expect(query).toMatch(/ORDER BY c\.cp_sortDate DESC$/);
      } finally {
        delete process.env.PUBLIC_LIST_SQL_ORDER;
      }
    });
  });

  describe('the projection replaces SELECT * (T-206)', () => {
    it('projects explicit fields — never the whole document', async () => {
      const { query } = await captureQuery();
      expect(query).not.toContain('SELECT TOP 1000 *');
      for (const field of PUBLIC_CONTENT_LIST_FIELDS) {
        expect(query, `projection lost ${field}`).toContain(`c["${field}"]`);
      }
    });

    it('leaves article bodies out of list responses', async () => {
      // The RU story: full documents averaged ~20 KB, dominated by bodies no
      // list consumer reads. The audit found exactly one heavy field with a
      // list reader — `explanation` (useCoderCornerData excerpt fallback) —
      // and these eight with none.
      for (const heavy of [
        'content',
        'Content',
        'postContent',
        'blogDraft',
        'overviewHtml',
        'codeSnippet',
        'commandExample',
        'sidebarContent',
      ]) {
        expect(PUBLIC_CONTENT_LIST_FIELDS, `${heavy} has no list consumer`).not.toContain(heavy);
      }
      expect(PUBLIC_CONTENT_LIST_FIELDS).toContain('explanation');
    });

    it('covers every audited consumer requirement', () => {
      // Each entry names the consumer that reads it; losing one silently
      // blanks a public page. This is the audit, pinned — extend it when a
      // consumer starts reading a new field.
      const required = {
        // the server's own filter and sort
        Live: 'isPublicDocument',
        Status: 'isPublicDocument',
        contentStatus: 'isPublicDocument',
        softDeletedAt: 'isSoftDeleted',
        softDeleteExpiresAt: 'isSoftDeleted',
        publishedDate: 'resolvePublishedDateValue',
        datePublished: 'resolvePublishedDateValue',
        'Published At': 'resolvePublishedDateValue',
        blogPublishedAt: 'resolvePublishedDateValue',
        publishedAt: 'resolvePublishedDateValue',
        // cards
        explanation: 'useCoderCornerData:41,:53 excerpt fallback',
        language: 'useCoderCornerData card',
        repoUrl: 'useCoderCornerData card',
        altCoverImageVariants: 'useBlogData:174-179 image race',
        costAnalysis: 'ArchitecturePage doc.costAnalysis?.estimatedMonthly',
        frameworkPillars: 'useFrameworkData:93-101',
        keyTopics: 'useBlogData tags',
        'CD Url': 'useBlogData url resolution',
        'Source URL': 'useBlogData url resolution',
        curatedSubpagePath: 'SocialHubPage getLiveUrl',
        slugPageUrl: 'SocialHubPage getLiveUrl',
        // delete/dedup identity on LivePagesPage
        sourceContentId: 'LivePagesPage delete path',
        publishedContentId: 'LivePagesPage delete path',
        publishedBlogId: 'LivePagesPage delete path',
        blogId: 'LivePagesPage delete path',
      };
      const missing = Object.entries(required)
        .filter(([field]) => !PUBLIC_CONTENT_LIST_FIELDS.includes(field))
        .map(([field, consumer]) => `${field} (${consumer})`);
      expect(missing).toEqual([]);
    });
  });

  it('filters non-public docs server-side and sorts by resolved date desc', async () => {
    const store = {
      queryDocs: vi.fn(async () => [
        publicDoc({ id: 'old', publishedAt: '2026-01-01T00:00:00Z' }),
        { id: 'draft', contentStatus: 'draft', Title: 'Secret draft' },
        publicDoc({ id: 'new', publishedAt: undefined, 'Published At': '2026-06-01T00:00:00Z' }),
        publicDoc({ id: 'deleted', softDeletedAt: '2026-01-01' }),
      ]),
      readDoc: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.listContent(makeRequest(), context);
    const body = JSON.parse(res.body);
    expect(body.items.map((i) => i.id)).toEqual(['new', 'old']); // alias date sorts first
  });

  it('builds parameterized type and provider-alias clauses', async () => {
    const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
    const h = createPublicReadHandlers({ store });
    await h.listContent(makeRequest({ query: { type: 'coder_corner', provider: 'gcp' } }), context);
    const [container, query, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe('content');
    expect(query).toContain('LOWER(c.type) = @type');
    expect(query).toContain('ARRAY_CONTAINS(@providers');
    expect(params).toContainEqual({ name: '@type', value: 'coder_corner' });
    expect(params.find((p) => p.name === '@providers').value).toContain('Google Cloud');
  });

  it('matches Docker the way the CMS writes it, not just the slug (#776)', async () => {
    // Before Docker had an alias, `?provider=docker` fell back to
    // ['docker', 'DOCKER'] and never matched a document filed as "Docker".
    const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
    const h = createPublicReadHandlers({ store });
    await h.listContent(makeRequest({ query: { type: 'coder_corner', provider: 'docker' } }), context);
    const [, , params] = store.queryDocs.mock.calls[0];
    expect(params.find((p) => p.name === '@providers').value).toEqual(['Docker', 'docker']);
  });

  it('returns full documents with internal fields stripped', async () => {
    const store = {
      queryDocs: vi.fn(async () => [
        publicDoc({
          frameworkConcepts: [{ label: 'Pillar' }],
          featured: true,
          reviewNotes: 'internal',
          _rid: 'abc',
        }),
      ]),
      readDoc: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.listContent(makeRequest(), context);
    const [item] = JSON.parse(res.body).items;
    // Fields outside any card projection survive — the list consumers
    // (useFrameworkData, useProviderLandingContent) read them.
    expect(item.frameworkConcepts).toEqual([{ label: 'Pillar' }]);
    expect(item.featured).toBe(true);
    expect(item).not.toHaveProperty('reviewNotes');
    expect(item).not.toHaveProperty('_rid');
  });

  it('serves the legacy blogs container only via the source allowlist', async () => {
    const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
    const h = createPublicReadHandlers({ store });

    await h.listContent(makeRequest({ query: { source: 'blogs' } }), context);
    expect(store.queryDocs.mock.calls[0][0]).toBe('blogs');

    const denied = await h.listContent(
      makeRequest({ query: { source: 'admin_settings' } }),
      context
    );
    expect(denied.status).toBe(400);
    expect(store.queryDocs).toHaveBeenCalledTimes(1); // rejected before any read
  });

  it('applies offset/limit after the sort and clamps the limit', async () => {
    const docs = Array.from({ length: 10 }, (_, i) =>
      publicDoc({ id: `d${i}`, publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` })
    );
    const store = { queryDocs: vi.fn(async () => docs), readDoc: vi.fn() };
    const h = createPublicReadHandlers({ store });
    const res = await h.listContent(makeRequest({ query: { limit: '3', offset: '2' } }), context);
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['d7', 'd6', 'd5']);

    await h.listContent(makeRequest({ query: { limit: '5000' } }), context);
    expect(store.queryDocs).toHaveBeenCalledTimes(2); // clamped internally, no crash
  });
});

describe('getContent', () => {
  it('resolves by id in content first and strips internal fields', async () => {
    const store = {
      readDoc: vi.fn(async (c, id) =>
        c === 'content' && id === 'abc' ? publicDoc({ id: 'abc', reviewNotes: 'x' }) : null
      ),
      queryDocs: vi.fn(async () => []),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getContent(makeRequest({ params: { slugOrId: 'abc' } }), context);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('content');
    expect(body.item.id).toBe('abc');
    expect(body.item).not.toHaveProperty('reviewNotes');
  });

  it('falls through id → slug → Slug → legacy blogs, like the templates', async () => {
    const legacy = publicDoc({ id: 'legacy-1', Slug: 'my-post' });
    const store = {
      readDoc: vi.fn(async () => null),
      queryDocs: vi.fn(async (container, query) =>
        container === 'blogs' && query.includes('c["Slug"]') ? [legacy] : []
      ),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getContent(makeRequest({ params: { slugOrId: 'my-post' } }), context);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('blogs');
    expect(body.item.id).toBe('legacy-1');
  });

  it('404s a non-public document exactly like a missing one', async () => {
    const store = {
      readDoc: vi.fn(async () => ({ id: 'x', contentStatus: 'in_review', Title: 'Draft' })),
      queryDocs: vi.fn(async () => []),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getContent(makeRequest({ params: { slugOrId: 'x' } }), context);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('Draft');
  });

  it('serves the published document when a draft shares its slug', async () => {
    // The T-305 defect: `SELECT TOP 1` picked arbitrarily among duplicates and
    // the public filter ran afterwards, so a live article 404'd whenever an
    // unpublished document sharing its slug happened to come back first.
    const draft = { id: 'draft-1', slug: 'shared', contentStatus: 'in_review', Title: 'Draft' };
    const live = publicDoc({ id: 'live-1', slug: 'shared', Title: 'Live' });
    const store = {
      readDoc: vi.fn(async () => null),
      queryDocs: vi.fn(async () => [draft, live]),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getContent(makeRequest({ params: { slugOrId: 'shared' } }), context);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).item.id).toBe('live-1');
    expect(res.body).not.toContain('Draft');
  });

  it('orders slug candidates deterministically and bounds them', async () => {
    // Without ORDER BY the winner among duplicates is whatever the engine
    // returns; `_ts` is a system property present on every document, so it is
    // one of the few fields this codebase may sort on without dropping rows.
    const store = {
      readDoc: vi.fn(async () => null),
      queryDocs: vi.fn(async () => []),
    };
    const h = createPublicReadHandlers({ store });
    await h.getContent(makeRequest({ params: { slugOrId: 'anything' } }), context);

    for (const [, query] of store.queryDocs.mock.calls) {
      expect(query).toMatch(/ORDER BY c\._ts DESC/);
      expect(query).toMatch(/SELECT TOP \d+ /);
      expect(query).not.toMatch(/SELECT TOP 1 /);
    }
  });

  it('still 404s when every same-slug document is non-public', async () => {
    const store = {
      readDoc: vi.fn(async () => null),
      queryDocs: vi.fn(async () => [
        { id: 'a', slug: 'shared', contentStatus: 'in_review', Title: 'DraftA' },
        { id: 'b', slug: 'shared', Live: true, softDeletedAt: '2026-01-01', Title: 'DeletedB' },
      ]),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getContent(makeRequest({ params: { slugOrId: 'shared' } }), context);

    expect(res.status).toBe(404);
    expect(res.body).not.toContain('DraftA');
    expect(res.body).not.toContain('DeletedB');
  });
});

/**
 * The public news pages were calling the EDITOR-gated cache lookup, so an
 * anonymous visitor's requests threw at token acquisition and no curated
 * imagery rendered (T-210). The assertions that matter are about what
 * this endpoint does NOT return: the admin equivalent answers with the whole
 * document, and the document is not public.
 */
describe('getCuratedImage', () => {
  const cached = (over = {}) => ({
    id: 'a1',
    imageUrl: 'https://cdn.example/img/a1.png',
    storagePath: 'curated/internal/a1.png',
    promptSet: 'house-style-v3',
    promptName: 'news-hero',
    promptTemplateVersion: 7,
    theme: 'cool-blue',
    style: 'cinematic',
    ...over,
  });

  const handlersFor = (doc) =>
    createPublicReadHandlers({
      store: { readDoc: vi.fn(async () => doc), queryDocs: vi.fn() },
    });

  it('returns the image url', async () => {
    const h = handlersFor(cached());
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).imageUrl).toBe('https://cdn.example/img/a1.png');
  });

  it('returns ONLY the image url — never the document', async () => {
    // storagePath is an internal blob path and the prompt fields are editorial
    // IP. Neither is needed to render an <img>, and an allowlist of one field
    // cannot leak a field added to the container later.
    const h = handlersFor(cached());
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    const body = JSON.parse(res.body);

    expect(Object.keys(body).sort()).toEqual(['imageUrl', 'success']);
    expect(res.body).not.toContain('storagePath');
    expect(res.body).not.toContain('house-style-v3');
    expect(res.body).not.toContain('cinematic');
  });

  it('answers 200 with a null url when nothing is cached', async () => {
    // The caller's question is "is there a cached image?", and "no" is a
    // successful answer to it — the hook treats absence as "not cached", not
    // as an error, so a 404 here would show up in its error path.
    const h = handlersFor(null);
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'missing' } }), context);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).imageUrl).toBeNull();
  });

  it('withholds an archived image', async () => {
    // Not asked for by the finding. `archived` is set by an admin explicitly
    // retiring an image, and the only thing this can do is stop a retired
    // image appearing on a public page.
    const h = handlersFor(cached({ archived: true }));
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    expect(JSON.parse(res.body).imageUrl).toBeNull();
  });

  it('treats a document with no usable url as uncached', async () => {
    // Whitespace-only included: untrimmed, it is truthy, and would reach the
    // browser as an `<img src=" ">` that resolves back to the page itself.
    for (const over of [
      { imageUrl: '' },
      { imageUrl: '   ' },
      { imageUrl: null },
      { imageUrl: { url: 'x' } },
    ]) {
      const h = handlersFor(cached(over));
      const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
      expect(JSON.parse(res.body).imageUrl).toBeNull();
    }
  });

  it('rejects an empty id without reading', async () => {
    const store = { readDoc: vi.fn(), queryDocs: vi.fn() };
    const h = createPublicReadHandlers({ store });
    const res = await h.getCuratedImage(makeRequest({ params: { id: '  ' } }), context);
    expect(res.status).toBe(400);
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('trims the stored url', async () => {
    const h = handlersFor(cached({ imageUrl: '  https://cdn.example/img/a1.png  ' }));
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    expect(JSON.parse(res.body).imageUrl).toBe('https://cdn.example/img/a1.png');
  });

  // T-739. The batched route exists so a twelve-card news grid costs one round
  // trip instead of twelve. The risk it introduces is divergence: a second
  // implementation of the same lookup is a second place for the disclosure
  // rules to be wrong, and the anonymous one is the one that matters.
  describe('getCuratedImages (batched)', () => {
    const batchHandlers = (rows) =>
      createPublicReadHandlers({
        store: { queryDocs: vi.fn(async () => rows), readDoc: vi.fn() },
      });
    const ask = (ids) => makeRequest({ query: { ids } });

    it('answers every requested id, keyed, including the misses', async () => {
      // A miss must be an explicit null rather than an omission: the caller
      // needs to distinguish "no cover" from "not asked about", or it cannot
      // stop asking.
      const h = batchHandlers([cached({ id: 'a1' })]);
      const res = await h.getCuratedImages(ask('a1,a2'), context);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).images).toEqual({
        a1: 'https://cdn.example/img/a1.png',
        a2: null,
      });
    });

    it('agrees with the single-id route on every disclosure rule', async () => {
      // The property worth protecting. Each case is run through BOTH handlers
      // and the answers compared, so a rule changed in one and not the other
      // fails here rather than becoming a public leak.
      const cases = [
        cached({ id: 'x' }),
        cached({ id: 'x', archived: true }),
        cached({ id: 'x', imageUrl: '' }),
        cached({ id: 'x', imageUrl: '   ' }),
        cached({ id: 'x', imageUrl: null }),
        cached({ id: 'x', imageUrl: { url: 'nope' } }),
        cached({ id: 'x', imageUrl: '  https://cdn.example/trim.png  ' }),
      ];

      for (const doc of cases) {
        const single = await createPublicReadHandlers({
          store: { readDoc: vi.fn(async () => doc), queryDocs: vi.fn() },
        }).getCuratedImage(makeRequest({ params: { id: 'x' } }), context);

        const batch = await batchHandlers([doc]).getCuratedImages(ask('x'), context);

        expect(JSON.parse(batch.body).images.x, JSON.stringify(doc)).toBe(
          JSON.parse(single.body).imageUrl
        );
      }
    });

    it('returns ONLY urls — never any part of the documents', async () => {
      const h = batchHandlers([cached({ id: 'a1' })]);
      const res = await h.getCuratedImages(ask('a1'), context);
      expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(['images', 'success']);
      expect(res.body).not.toContain('storagePath');
      expect(res.body).not.toContain('house-style-v3');
      expect(res.body).not.toContain('cinematic');
    });

    it('is bounded, so one anonymous request cannot become an unbounded fan-out', async () => {
      const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
      const h = createPublicReadHandlers({ store });
      const tooMany = Array.from({ length: CURATED_IMAGE_BATCH_MAX + 1 }, (_, i) => `a${i}`);
      const res = await h.getCuratedImages(ask(tooMany.join(',')), context);
      expect(res.status).toBe(400);
      expect(store.queryDocs).not.toHaveBeenCalled();
    });

    it('accepts exactly the maximum', async () => {
      const ids = Array.from({ length: CURATED_IMAGE_BATCH_MAX }, (_, i) => `a${i}`);
      const res = await batchHandlers([]).getCuratedImages(ask(ids.join(',')), context);
      expect(res.status).toBe(200);
    });

    it('deduplicates and ignores blanks before counting against the cap', async () => {
      const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
      const h = createPublicReadHandlers({ store });
      const res = await h.getCuratedImages(ask('a1, a1 ,,  , a2 ,'), context);
      expect(res.status).toBe(200);
      expect(Object.keys(JSON.parse(res.body).images).sort()).toEqual(['a1', 'a2']);
      expect(store.queryDocs.mock.calls[0][2]).toEqual([{ name: '@ids', value: ['a1', 'a2'] }]);
    });

    it('rejects a missing or empty ids list without reading', async () => {
      for (const ids of [undefined, '', '   ', ',,,']) {
        const store = { queryDocs: vi.fn(), readDoc: vi.fn() };
        const h = createPublicReadHandlers({ store });
        const res = await h.getCuratedImages(ask(ids), context);
        expect(res.status).toBe(400);
        expect(store.queryDocs).not.toHaveBeenCalled();
      }
    });

    it('uses one query rather than a point read per id', async () => {
      // The entire reason this route exists.
      const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
      const h = createPublicReadHandlers({ store });
      await h.getCuratedImages(ask('a1,a2,a3,a4,a5,a6,a7,a8,a9,a10,a11,a12'), context);
      expect(store.queryDocs).toHaveBeenCalledTimes(1);
      expect(store.readDoc).not.toHaveBeenCalled();
    });

    it('does not 500 when the store throws', async () => {
      const h = createPublicReadHandlers({
        store: {
          queryDocs: vi.fn(async () => {
            throw new Error('cosmos down');
          }),
          readDoc: vi.fn(),
        },
      });
      const res = await h.getCuratedImages(ask('a1'), context);
      expect(res.status).toBe(500);
      expect(res.body).not.toContain('cosmos down');
    });
  });

  it('caches a hit hard — it is hit up to twelve times per news page load', async () => {
    const h = handlersFor(cached());
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    expect(res.headers['Cache-Control']).toBe('public, max-age=3600');
  });

  it('caches a miss only briefly, so a new image is not hidden for an hour', async () => {
    // Negative caching at the hit's TTL would mean that after an admin
    // generates an image, visitors and any CDN in front of them keep being
    // told there is none until the hour is out — a slower version of the bug
    // this endpoint exists to fix.
    const hit = await handlersFor(cached()).getCuratedImage(
      makeRequest({ params: { id: 'a1' } }),
      context
    );
    const miss = await handlersFor(null).getCuratedImage(
      makeRequest({ params: { id: 'a1' } }),
      context
    );

    const seconds = (res) => Number(/max-age=(\d+)/.exec(res.headers['Cache-Control'])[1]);
    expect(seconds(miss)).toBeGreaterThan(0);
    expect(seconds(miss)).toBeLessThan(seconds(hit));
  });

  it('caches an archived image as a miss, not as a hit', async () => {
    // Otherwise retiring an image would be cached for an hour at the TTL meant
    // for a stable URL.
    const h = handlersFor(cached({ archived: true }));
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
  });

  it('500s rather than leaking a store error to an anonymous caller', async () => {
    const h = createPublicReadHandlers({
      store: {
        readDoc: vi.fn(async () => {
          throw new Error('cosmos exploded with connection string in it');
        }),
        queryDocs: vi.fn(),
      },
    });
    const res = await h.getCuratedImage(makeRequest({ params: { id: 'a1' } }), context);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('connection string');
  });
});

describe('getSnapshot', () => {
  it('serves only the allowlisted snapshot ids', async () => {
    const store = {
      readDoc: vi.fn(async (_c, id) => ({ id, items: [1, 2] })),
      queryDocs: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    const ok = await h.getSnapshot(makeRequest({ params: { id: 'certifications' } }), context);
    expect(JSON.parse(ok.body).snapshot.items).toEqual([1, 2]);

    const denied = await h.getSnapshot(makeRequest({ params: { id: 'admin_settings' } }), context);
    expect(denied.status).toBe(404);
    expect(store.readDoc).toHaveBeenCalledTimes(1); // denylist short-circuits before the read
  });

  it('strips internal fields from inside items[], not just the wrapper', async () => {
    // stripInternalFields used to be applied to the wrapper only, so createdBy
    // and updatedBy on each item were never reached — the read-path half of
    // T-201.
    const store = {
      readDoc: vi.fn(async (_c, id) => ({
        id,
        updatedBy: 'wrapper-admin@example.com',
        items: [
          { id: 'a', name: 'Visible', createdBy: 'admin@example.com', _etag: '"x"' },
          { id: 'b', name: 'Also visible', updatedBy: 'other@example.com' },
        ],
      })),
      queryDocs: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getSnapshot(makeRequest({ params: { id: 'speakerevents' } }), context);
    const { snapshot } = JSON.parse(res.body);

    expect(snapshot).not.toHaveProperty('updatedBy');
    for (const item of snapshot.items) {
      expect(item).not.toHaveProperty('createdBy');
      expect(item).not.toHaveProperty('updatedBy');
      expect(item).not.toHaveProperty('_etag');
    }
    expect(JSON.stringify(snapshot)).not.toContain('@example.com');
    // The fields consumers need survive.
    expect(snapshot.items.map((i) => i.name)).toEqual(['Visible', 'Also visible']);
  });

  it('leaves non-object entries in items[] alone', async () => {
    const store = {
      readDoc: vi.fn(async (_c, id) => ({ id, items: [1, 'two', null, ['x']] })),
      queryDocs: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.getSnapshot(makeRequest({ params: { id: 'certifications' } }), context);
    expect(JSON.parse(res.body).snapshot.items).toEqual([1, 'two', null, ['x']]);
  });
});

describe('T-202 — anonymous feeds filter deletions, not publication status', () => {
  const handlers = (rows) =>
    createPublicReadHandlers({
      store: {
        queryDocs: vi.fn(async (container) => rows[container] ?? []),
        readDoc: vi.fn(),
      },
    });

  it('listPodcasts drops soft-deleted episodes', async () => {
    const h = handlers({
      podcasts: [
        { id: 'live', title: 'Kept', publishedAt: '2026-01-02' },
        { id: 'gone', title: 'Removed', publishedAt: '2026-01-03', softDeletedAt: '2026-02-01' },
        { id: 'expiring', title: 'Also removed', softDeleteExpiresAt: '2026-03-01' },
      ],
    });
    const body = JSON.parse((await h.listPodcasts(makeRequest(), context)).body);
    expect(body.items.map((i) => i.id)).toEqual(['live']);
  });

  it('listPodcasts still serves episodes that carry no publication status', async () => {
    // The outage guard. Podcasts have no contentStatus/Live/Status, so
    // filtering them on isPublicDocument — which is what T-202 literally
    // prescribed — would return an empty page for every provider.
    const h = handlers({
      podcasts: [
        { id: 'a', title: 'Episode A', publishedAt: '2026-01-01' },
        { id: 'b', title: 'Episode B', publishedAt: '2026-01-02' },
      ],
    });
    const body = JSON.parse((await h.listPodcasts(makeRequest(), context)).body);
    expect(body.items).toHaveLength(2);
  });

  it('getFeed drops soft-deleted cache documents', async () => {
    const h = handlers({
      rss_cache: [
        { id: 'c1', provider: 'azure', feedName: 'Azure Blog', items: [] },
        { id: 'c2', provider: 'azure', feedName: 'Stale', items: [], softDeletedAt: '2026-02-01' },
      ],
    });
    const req = makeRequest({ query: { provider: 'azure' } });
    const body = JSON.parse((await h.getFeed(req, context)).body);

    expect(body.rssCache.map((d) => d.id)).toEqual(['c1']);
    // T-765 (2026-09-05): the response no longer carries `insights` at all —
    // the panel that read them was retired, and nothing ever wrote them.
    expect(body).not.toHaveProperty('insights');
  });

  it('getFeed still serves cache documents, which never carry a status', async () => {
    const h = handlers({
      rss_cache: [{ id: 'c1', provider: 'azure', feedName: 'Azure Blog', items: [{ title: 'x' }] }],
    });
    const req = makeRequest({ query: { provider: 'azure' } });
    const body = JSON.parse((await h.getFeed(req, context)).body);

    expect(body.rssCache).toHaveLength(1);
  });
});

describe('T-203 — the feed endpoint is bounded', () => {
  const capture = () => {
    const queries = [];
    return {
      queries,
      store: {
        queryDocs: vi.fn(async (container, query) => {
          queries.push({ container, query });
          return [];
        }),
        readDoc: vi.fn(),
      },
    };
  };

  it('bounds the feed query, which was unbounded on an anonymous endpoint', async () => {
    // Two containers were bounded here until 2026-09-05; the ai_insights read
    // went with the retired panel (T-765), so one query remains to bound.
    const { queries, store } = capture();
    const h = createPublicReadHandlers({ store });
    await h.getFeed(makeRequest({ query: { provider: 'azure' } }), context);

    expect(queries).toHaveLength(1);
    for (const { query } of queries) {
      expect(query).toMatch(/SELECT TOP \d+ /);
    }
  });

  it('bounds documents well above any plausible feed count, not at the render count', async () => {
    // The ceiling is a runaway guard, not a page size. One rss_cache document
    // is one feed holding many items; useNewsData renders 30 *items* after
    // flattening. Sizing the document bound to 30 would drop whole feeds.
    const { queries, store } = capture();
    const h = createPublicReadHandlers({ store });
    await h.getFeed(makeRequest({ query: { provider: 'azure' } }), context);

    for (const { query } of queries) {
      const bound = Number(query.match(/SELECT TOP (\d+) /)[1]);
      expect(bound).toBeGreaterThanOrEqual(100);
    }
  });

  it('does not order the feed queries', async () => {
    // Rule 2: ORDER BY drops documents missing the sort key, and lastFetched /
    // generatedAt are only in the composite indexes — presence is not
    // guaranteed. An arbitrary TOP N is acceptable because N only binds once a
    // container has run away.
    const { queries, store } = capture();
    const h = createPublicReadHandlers({ store });
    await h.getFeed(makeRequest({ query: { provider: 'azure' } }), context);

    for (const { query } of queries) {
      expect(query).not.toMatch(/ORDER BY/i);
    }
  });

  it('still parameterises the provider rather than interpolating it', async () => {
    const store = {
      queryDocs: vi.fn(async () => []),
      readDoc: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    await h.getFeed(makeRequest({ query: { provider: "azure' OR 1=1--" } }), context);

    for (const call of store.queryDocs.mock.calls) {
      expect(call[1]).not.toContain('OR 1=1');
      expect(call[2]).toEqual([{ name: '@provider', value: "azure' OR 1=1--" }]);
    }
  });
});

describe('isSoftDeleted', () => {
  it('is the universal half of isPublicDocument', () => {
    expect(isSoftDeleted({ softDeletedAt: '2026-01-01' })).toBe(true);
    expect(isSoftDeleted({ softDeleteExpiresAt: '2026-01-01' })).toBe(true);
    expect(isSoftDeleted({})).toBe(false);
    expect(isSoftDeleted(null)).toBe(false);
  });

  it('does not require a publication status, unlike isPublicDocument', () => {
    // This is the distinction T-202 turned on: a cache document has no
    // contentStatus, so isPublicDocument rejects it while isSoftDeleted admits
    // it. Filtering rss_cache/podcasts on the former would have emptied two
    // public pages (three, while the ai_insights panel still existed).
    const cacheDoc = { provider: 'azure', feedName: 'Azure Blog', items: [] };
    expect(isSoftDeleted(cacheDoc)).toBe(false);
    expect(isPublicDocument(cacheDoc)).toBe(false);
  });
});

describe('listPodcasts', () => {
  it('filters by provider and sorts newest first', async () => {
    const store = {
      queryDocs: vi.fn(async () => [
        { id: 'a', publishedAt: '2026-01-01T00:00:00Z' },
        { id: 'b', publishedAt: '2026-05-01T00:00:00Z' },
      ]),
      readDoc: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.listPodcasts(makeRequest({ query: { provider: 'aws' } }), context);
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['b', 'a']);
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain('c.provider IN (@provider, @mainProvider)');
    expect(params).toContainEqual({ name: '@provider', value: 'aws' });
  });

  it("returns the site's show alongside the provider's own episodes", async () => {
    // The point of the main feed: a provider with no feed of its own is not
    // an empty page, because the site's show is on it. One query, so a show
    // episode arrives once — never as a second copy of a provider row.
    const store = {
      queryDocs: vi.fn(async () => [
        { id: 'aws-1', provider: 'aws', publishedAt: '2026-01-01T00:00:00Z' },
        { id: 'show-1', provider: 'main', publishedAt: '2026-05-01T00:00:00Z' },
      ]),
      readDoc: vi.fn(async () => null),
    };
    const res = await createPublicReadHandlers({ store }).listPodcasts(
      makeRequest({ query: { provider: 'aws' } }),
      context
    );

    expect(store.queryDocs).toHaveBeenCalledTimes(1);
    const [, , params] = store.queryDocs.mock.calls[0];
    expect(params).toContainEqual({ name: '@mainProvider', value: MAIN_PODCAST_PROVIDER });
    const body = JSON.parse(res.body);
    expect(body.items.map((i) => i.id)).toEqual(['show-1', 'aws-1']);
    expect(body.total).toBe(2);
  });

  it('lower-cases the provider, so ?provider=Azure is not an empty section', async () => {
    // The rows and the feed config are keyed by the canonical slug. Without
    // this the route answers 200 with no episodes and a null feed URL, which
    // reads as "nothing published" rather than "wrong casing".
    const store = {
      queryDocs: vi.fn(async () => [{ id: 'a', publishedAt: '2026-01-01T00:00:00Z' }]),
      readDoc: vi.fn(async () => null),
    };
    const h = createPublicReadHandlers({ store });
    const res = await h.listPodcasts(makeRequest({ query: { provider: 'AzURe' } }), context);

    expect(res.status).toBe(200);
    const [, , params] = store.queryDocs.mock.calls[0];
    expect(params).toContainEqual({ name: '@provider', value: 'azure' });
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['a']);
  });
});

describe('getFeed', () => {
  it('requires a provider and returns the rss cache, and reads only that container', async () => {
    const store = {
      queryDocs: vi.fn(async () => [{ id: 'cache1', provider: 'aws', items: [] }]),
      readDoc: vi.fn(),
    };
    const h = createPublicReadHandlers({ store });

    expect((await h.getFeed(makeRequest(), context)).status).toBe(400);

    const res = await h.getFeed(makeRequest({ query: { provider: 'aws' } }), context);
    const body = JSON.parse(res.body);
    expect(body.rssCache.map((d) => d.id)).toEqual(['cache1']);
    // T-765: one query, against rss_cache only — ai_insights is no longer read.
    expect(store.queryDocs).toHaveBeenCalledTimes(1);
    expect(store.queryDocs.mock.calls[0][0]).toBe('rss_cache');
    expect(body).not.toHaveProperty('insights');
  });
});

describe('T-319 — the feed endpoint is bounded in items, not just in documents', () => {
  const feedStore = (docs) => ({
    queryDocs: vi.fn(async (container) => (container === 'rss_cache' ? docs : [])),
    readDoc: vi.fn(),
  });

  const getCache = async (docs) => {
    const h = createPublicReadHandlers({ store: feedStore(docs) });
    const res = await h.getFeed(makeRequest({ query: { provider: 'azure' } }), context);
    return JSON.parse(res.body).rssCache;
  };

  // One rss_cache document is one FEED. FEED_CACHE_MAX_DOCS bounds how many
  // feeds an anonymous caller gets; without this bound each of them could
  // still carry an unbounded articles array.
  const dated = (n, isoMonth) => ({ title: `item-${n}`, pubDate: `2026-${isoMonth}-01T00:00:00Z` });

  it('trims an oversized feed document to the newest items', async () => {
    // 40 items, oldest first, so a first-N truncation would keep the 20 oldest.
    const items = Array.from({ length: 40 }, (_, i) => ({
      title: `item-${i}`,
      pubDate: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }));
    const [doc] = await getCache([{ id: 'c1', provider: 'azure', items, itemCount: 40 }]);

    expect(doc.items).toHaveLength(20);
    expect(doc.items[0].title).toBe('item-39');
    expect(doc.items.at(-1).title).toBe('item-20');
    // The writer's invariant is itemCount === items.length; a stale 40 would
    // tell the client about items that are not in the response.
    expect(doc.itemCount).toBe(20);
  });

  it('serves a document written by the current ingest untouched', async () => {
    // Equal to the writer's cap, so the trim must not engage — including not
    // reordering a feed the client has not asked to be reordered.
    const items = [dated(0, '03'), dated(1, '01'), dated(2, '02')];
    const [doc] = await getCache([{ id: 'c1', provider: 'azure', items, itemCount: 3 }]);

    expect(doc.items.map((i) => i.title)).toEqual(['item-0', 'item-1', 'item-2']);
    expect(doc.itemCount).toBe(3);
  });

  it('drops undated items before dated ones when trimming', async () => {
    // A feed that emits items with no pubDate must not be able to evict every
    // dated article: Date.parse('') is NaN, and NaN is not "now".
    const items = [
      ...Array.from({ length: 25 }, (_, i) => ({ title: `undated-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => dated(i, '06')),
    ];
    const [doc] = await getCache([{ id: 'c1', provider: 'azure', items }]);

    expect(doc.items).toHaveLength(20);
    expect(doc.items.filter((i) => i.title.startsWith('item-'))).toHaveLength(5);
  });

  it('keeps stored order among undated items', async () => {
    // All-undated compares 0 throughout, so the stable sort leaves feed order.
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `u-${i}` }));
    const [doc] = await getCache([{ id: 'c1', provider: 'azure', items }]);

    expect(doc.items.map((i) => i.title)).toEqual(Array.from({ length: 20 }, (_, i) => `u-${i}`));
  });

  it('leaves a malformed document alone rather than inventing an empty feed', async () => {
    const cache = await getCache([
      { id: 'c1', provider: 'azure', items: 'not-an-array' },
      { id: 'c2', provider: 'azure' },
    ]);

    expect(cache[0].items).toBe('not-an-array');
    expect(cache[1]).not.toHaveProperty('items');
  });

  it('does not mutate the stored document it was handed', async () => {
    const items = Array.from({ length: 30 }, (_, i) => dated(i, '05'));
    const stored = { id: 'c1', provider: 'azure', items, itemCount: 30 };
    await getCache([stored]);

    expect(stored.items).toHaveLength(30);
    expect(stored.itemCount).toBe(30);
  });

  it('bounds every document, not only the first', async () => {
    const many = (n) => Array.from({ length: n }, (_, i) => dated(i, '04'));
    const cache = await getCache([
      { id: 'c1', provider: 'azure', items: many(25) },
      { id: 'c2', provider: 'azure', items: many(30) },
    ]);

    expect(cache.map((d) => d.items.length)).toEqual([20, 20]);
  });

  it('still strips internal fields from a trimmed document', async () => {
    const items = Array.from({ length: 30 }, (_, i) => dated(i, '07'));
    const [doc] = await getCache([{ id: 'c1', provider: 'azure', items, _etag: 'x', _ts: 1 }]);

    expect(doc).not.toHaveProperty('_etag');
    expect(doc).not.toHaveProperty('_ts');
    expect(doc.items).toHaveLength(20);
  });

  it('is sized to the ingest writer cap it shadows', async () => {
    // public-reads.js has no imports on purpose, so the read ceiling is a
    // second copy of MAX_CACHE_ITEMS_PER_FEED. This is the assertion that
    // stops the copies drifting: a read ceiling below the write cap would
    // start trimming documents the writer considers whole.
    const { MAX_CACHE_ITEMS_PER_FEED } = await import('./rss/feeds.js');
    const items = Array.from({ length: MAX_CACHE_ITEMS_PER_FEED + 1 }, (_, i) => dated(i, '08'));
    const [doc] = await getCache([{ id: 'c1', provider: 'azure', items }]);

    expect(doc.items).toHaveLength(MAX_CACHE_ITEMS_PER_FEED);
  });
});

describe('public list limits are clamped, whatever the query string says', () => {
  // `limit` and `offset` come straight off an anonymous query string, so every
  // value below is something a caller can actually send. The clamp is
  // `Math.min(Math.max(Number(v) || DEFAULT, 1), MAX)`, and the cases that
  // matter are the ones where `Number(v)` is not a usable page size.
  const DEFAULT_LIMIT = 60;
  const MAX_LIMIT = 250;

  const docs = Array.from({ length: 300 }, (_, i) =>
    publicDoc({
      id: `d${String(i).padStart(3, '0')}`,
      // Descending publish dates keep the resolved order deterministic, so a
      // page can be identified by its first id.
      publishedAt: new Date(Date.UTC(2026, 0, 1) - i * 86400000).toISOString(),
    })
  );

  const listWith = async (query) => {
    const h = createPublicReadHandlers({
      store: { queryDocs: vi.fn(async () => docs), readDoc: vi.fn() },
    });
    const res = await h.listContent(makeRequest({ query }), context);
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  };

  it('falls back to the default for a non-numeric limit', async () => {
    // Number('abc') is NaN, which is falsy — the `||` is what makes this the
    // default rather than a NaN slice returning nothing.
    for (const limit of ['abc', '', ' ', 'null', '12abc']) {
      expect((await listWith({ limit })).items).toHaveLength(DEFAULT_LIMIT);
    }
  });

  it('falls back to the default for a zero limit', async () => {
    // 0 is falsy, so it takes the default rather than clamping up to 1: an
    // explicit `limit=0` is treated as "unset", not as "an empty page".
    expect((await listWith({ limit: '0' })).items).toHaveLength(DEFAULT_LIMIT);
    expect((await listWith({ limit: '-0' })).items).toHaveLength(DEFAULT_LIMIT);
  });

  it('clamps a negative limit up to one item, never to a negative slice', async () => {
    // Math.max(..., 1) matters here: slice(offset, offset + -5) would return
    // an empty array, so a negative limit would silently blank the page.
    for (const limit of ['-5', '-1', '-9999']) {
      expect((await listWith({ limit })).items).toHaveLength(1);
    }
  });

  it('clamps an oversized limit down to the ceiling', async () => {
    for (const limit of ['5000', '250000', '1e6', 'Infinity']) {
      expect((await listWith({ limit })).items).toHaveLength(MAX_LIMIT);
    }
  });

  it('serves exactly the ceiling when asked for it', async () => {
    // 250 is the widest real client fetch (useFrameworkData), so the boundary
    // itself must not be off by one.
    expect((await listWith({ limit: String(MAX_LIMIT) })).items).toHaveLength(MAX_LIMIT);
    expect((await listWith({ limit: String(MAX_LIMIT - 1) })).items).toHaveLength(MAX_LIMIT - 1);
  });

  it('truncates a fractional limit rather than returning a fractional page', async () => {
    expect((await listWith({ limit: '2.9' })).items).toHaveLength(2);
  });

  it('treats a non-numeric or negative offset as zero', async () => {
    const first = (await listWith({ limit: '5', offset: '0' })).items[0].id;
    for (const offset of ['abc', '-10', '', 'NaN']) {
      expect((await listWith({ limit: '5', offset })).items[0].id).toBe(first);
    }
  });

  it('returns an empty page, not an error, for an offset past the end', async () => {
    const body = await listWith({ offset: '100000' });
    expect(body.items).toEqual([]);
    // `total` is the size of the match, not of the page, so a paginating
    // client can tell "past the end" from "nothing matched".
    expect(body.total).toBe(docs.length);
  });

  it('reports the unpaginated total alongside a clamped page', async () => {
    const body = await listWith({ limit: '5000' });
    expect(body.items).toHaveLength(MAX_LIMIT);
    expect(body.total).toBe(docs.length);
  });

  it('clamps the podcast limit on the same rules', async () => {
    // listPodcasts has its own copy of the clamp against the same constants.
    const episodes = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      title: `Episode ${i}`,
      publishedAt: new Date(Date.UTC(2026, 0, 1) - i * 86400000).toISOString(),
    }));
    const h = createPublicReadHandlers({
      store: { queryDocs: vi.fn(async () => episodes), readDoc: vi.fn() },
    });
    const listed = async (limit) =>
      JSON.parse((await h.listPodcasts(makeRequest({ query: { limit } }), context)).body).items;

    expect(await listed('abc')).toHaveLength(DEFAULT_LIMIT);
    expect(await listed('0')).toHaveLength(DEFAULT_LIMIT);
    expect(await listed('-5')).toHaveLength(1);
    expect(await listed('5000')).toHaveLength(MAX_LIMIT);
  });
});

describe('getListenAndLearn — approval is the only gate', () => {
  const store = (set, episodes) => ({
    readDoc: vi.fn(async () => set),
    queryDocs: vi.fn(async () => episodes),
  });

  const get = async (deps, query = { platform: 'azure', examCode: 'AZ-104' }) => {
    const h = createPublicReadHandlers({ store: deps });
    return h.getListenAndLearn(makeRequest({ query }), context);
  };

  it('filters to published in SQL, on an equality test', async () => {
    // These are AI-written summaries of a paid exam's objectives. Every
    // episode is generated as a draft and approved one at a time, so this
    // filter IS the review gate — not a display preference. An equality test
    // means an unrecognised status stays hidden, which is the safe direction;
    // a `!== 'draft'` would leak anything a future writer misspells.
    const deps = store({ id: 'azure_az-104' }, []);
    await get(deps);

    const [container, query, params] = deps.queryDocs.mock.calls[0];
    expect(container).toBe('listen_and_learn_episodes');
    expect(query).toContain('c.status = @status');
    expect(query).not.toContain('!=');
    expect(params).toContainEqual({ name: '@status', value: 'published' });
    expect(params).toContainEqual({ name: '@setId', value: 'azure_az-104' });
  });

  it('returns episodes in study-guide order, not query order', async () => {
    const deps = store({ id: 'azure_az-104' }, [
      { id: 'c', order: 2 },
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ]);
    const body = JSON.parse((await get(deps)).body);
    expect(body.episodes.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a soft-deleted episode the status filter would have admitted', async () => {
    const deps = store({ id: 'azure_az-104' }, [
      { id: 'a', order: 0 },
      { id: 'gone', order: 1, softDeletedAt: '2026-02-01' },
    ]);
    const body = JSON.parse((await get(deps)).body);
    expect(body.episodes.map((e) => e.id)).toEqual(['a']);
  });

  it('strips Cosmos system properties from the set and the episodes', async () => {
    const deps = store({ id: 'azure_az-104', _etag: 'x' }, [{ id: 'a', order: 0, _ts: 1 }]);
    const res = await get(deps);
    expect(res.body).not.toContain('_etag');
    expect(res.body).not.toContain('_ts');
  });

  it('serves a generated set with nothing approved as an empty list, not a 404', async () => {
    // "Generated but not yet approved" and "never generated" are different
    // states, and the page renders a different thing for each.
    const res = await get(store({ id: 'azure_az-104', examCode: 'AZ-104' }, []));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).episodes).toEqual([]);
  });

  it('404s a certification that was never generated', async () => {
    expect((await get(store(null, []))).status).toBe(404);
  });

  it('lowercases the platform and exam code into the set id', async () => {
    const deps = store({ id: 'azure_az-104' }, []);
    await get(deps, { platform: 'AZURE', examCode: 'AZ-104' });
    expect(deps.readDoc).toHaveBeenCalledWith('listen_and_learn', 'azure_az-104', 'azure_az-104');
  });

  it('requires both parameters', async () => {
    expect((await get(store(null, []), { platform: 'azure' })).status).toBe(400);
    expect((await get(store(null, []), { examCode: 'AZ-104' })).status).toBe(400);
  });

  it('bounds the episode query', async () => {
    const deps = store({ id: 'azure_az-104' }, []);
    await get(deps);
    expect(deps.queryDocs.mock.calls[0][1]).toMatch(/SELECT TOP \d+/);
  });

  it('names the same containers the writer does', async () => {
    // public-reads.js has no imports on purpose, so the container names are a
    // second copy. This is what stops the copies drifting into a read that
    // silently returns nothing.
    const { SET_CONTAINER, EPISODE_CONTAINER } = await import('./listen-and-learn/publish.js');
    const deps = store({ id: 'azure_az-104' }, []);
    await get(deps);

    expect(deps.readDoc.mock.calls[0][0]).toBe(SET_CONTAINER);
    expect(deps.queryDocs.mock.calls[0][0]).toBe(EPISODE_CONTAINER);
  });
});

describe('listPodcasts feedUrl (#349)', () => {
  const handlers = ({ rows = [], config } = {}) =>
    createPublicReadHandlers({
      store: {
        queryDocs: vi.fn(async () => rows),
        readDoc: vi.fn(async () => config),
      },
    });

  it('exposes the provider row of admin_config/podcast_feeds', async () => {
    const h = handlers({
      config: {
        feeds: [
          { provider: 'aws', url: 'https://example.com/aws.xml' },
          { provider: 'azure', url: 'https://example.com/azure.xml' },
        ],
      },
    });
    const res = await h.listPodcasts(makeRequest({ query: { provider: 'azure' } }), context);
    expect(JSON.parse(res.body).feedUrl).toBe('https://example.com/azure.xml');
  });

  it('is null when nothing is configured, and the list still answers', async () => {
    const res = await handlers({ rows: [{ id: 'e1', provider: 'azure' }] }).listPodcasts(
      makeRequest({ query: { provider: 'azure' } }),
      context
    );
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.feedUrl).toBeNull();
    expect(body.items).toHaveLength(1);
  });

  it('does not read the config without a provider to look up', async () => {
    const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn() };
    await createPublicReadHandlers({ store }).listPodcasts(makeRequest(), context);
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('degrades to null when the config read fails, warning with a code and no message', async () => {
    const store = {
      queryDocs: vi.fn(async () => [{ id: 'e1', provider: 'azure' }]),
      readDoc: vi.fn(async () => {
        // The shape of a Cosmos SDK failure: the message names the request.
        throw Object.assign(
          new Error('Request to dbs/site/colls/admin_config/docs/podcast_feeds failed'),
          { statusCode: 503, code: 'ServiceUnavailable' }
        );
      }),
    };
    const warn = vi.fn();
    const res = await createPublicReadHandlers({ store }).listPodcasts(
      makeRequest({ query: { provider: 'azure' } }),
      { ...context, warn }
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).feedUrl).toBeNull();

    // Telemetry stays content-free: the status, never the SDK's message,
    // which carries the container, id and partition key of the request.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].map(String).join(' ');
    expect(logged).toContain('503');
    expect(logged).not.toContain('admin_config');
    expect(logged).not.toContain('podcast_feeds');
    expect(logged).not.toContain('Request to');
  });

  it('reads the same document the timer ingests from', async () => {
    // A second copy of three names, for the same no-imports reason as the
    // Listen & Learn containers. This is what stops the page's RSS button and
    // the timer's ingest naming two different feeds.
    const { PODCAST_FEEDS_CONFIG_ID } = await import('./timers/podcasts.js');
    const { ADMIN_CONFIG_PARTITION } = await import('./cosmos-client.js');
    const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn(async () => null) };
    await createPublicReadHandlers({ store }).listPodcasts(
      makeRequest({ query: { provider: 'azure' } }),
      context
    );
    expect(store.readDoc).toHaveBeenCalledWith(
      'admin_config',
      PODCAST_FEEDS_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
  });

  it('files the show under the same provider value the ingest writes', async () => {
    // A fourth copied name, and the one with the widest blast radius: the SQL
    // above and public-section-counts.js both match on it, so a drift here
    // hides every show episode from every page and every count at once.
    const { MAIN_FEED_PROVIDER } = await import('./timers/podcasts.js');
    expect(MAIN_PODCAST_PROVIDER).toBe(MAIN_FEED_PROVIDER);
  });

  it("carries the site's show beside the provider's feed, each answering for itself", async () => {
    // Both, not one resolved value: `feedUrl` still means the feed THESE
    // provider rows came from, and which of the two a reader is offered is
    // the page's decision (useAudioEpisodes).
    const config = {
      mainFeedUrl: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
      feeds: [{ provider: 'azure', url: 'https://example.com/azure.xml' }],
    };
    const azure = JSON.parse(
      (
        await handlers({ config }).listPodcasts(
          makeRequest({ query: { provider: 'azure' } }),
          context
        )
      ).body
    );
    expect(azure.feedUrl).toBe('https://example.com/azure.xml');
    expect(azure.mainFeedUrl).toBe('https://media.rss.com/hybrid-cloud-insights/feed.xml');

    // A provider with no feed of its own: the show is all there is to offer.
    const aws = JSON.parse(
      (
        await handlers({ config }).listPodcasts(
          makeRequest({ query: { provider: 'aws' } }),
          context
        )
      ).body
    );
    expect(aws.feedUrl).toBeNull();
    expect(aws.mainFeedUrl).toBe('https://media.rss.com/hybrid-cloud-insights/feed.xml');
  });

  it('publishes the main feed only when it is an https URL', () => {
    const url = 'https://media.rss.com/hybrid-cloud-insights/feed.xml';
    expect(resolveMainFeedUrl({ mainFeedUrl: ` ${url} ` })).toBe(url);
    expect(resolveMainFeedUrl({ mainFeedUrl: 'http://insecure.example/feed.xml' })).toBeNull();
    expect(resolveMainFeedUrl({ mainFeedUrl: 'javascript:alert(1)' })).toBeNull();
    expect(resolveMainFeedUrl({ mainFeedUrl: 42 })).toBeNull();
    expect(resolveMainFeedUrl({ feeds: [] })).toBeNull();
    expect(resolveMainFeedUrl(null)).toBeNull();
  });

  it('only ever returns an https URL for the asked-for provider', () => {
    expect(
      resolveFeedUrlForProvider(
        { feeds: [{ provider: 'azure', url: 'http://example.com/plain.xml' }] },
        'azure'
      )
    ).toBeNull();
    expect(
      resolveFeedUrlForProvider({ feeds: [{ provider: 'aws', url: 'https://x/aws.xml' }] }, 'azure')
    ).toBeNull();
    expect(resolveFeedUrlForProvider({ feeds: 'nope' }, 'azure')).toBeNull();
    expect(resolveFeedUrlForProvider(null, 'azure')).toBeNull();
  });
});

describe('listListenAndLearnEpisodes — the provider-wide list (#349)', () => {
  const published = (over = {}) => ({
    id: 'area-1',
    setId: 'azure_az-104',
    provider: 'azure',
    examCode: 'AZ-104',
    areaSlug: 'area-1',
    areaName: 'Manage identities',
    order: 0,
    weightLabel: '20-25%',
    title: 'Identities',
    summary: 'A summary',
    transcript: [{ speaker: 'A', text: 'the whole script' }],
    videos: [{ url: 'https://youtube.com/x' }],
    audioUrl: '/api/public/media/listenandlearn/azure/az-104/area-1.mp3',
    audioBytes: 1000,
    durationSeconds: 540,
    status: 'published',
    approvedAt: '2026-09-01T00:00:00Z',
    generatedAt: '2026-08-30T00:00:00Z',
    approvedBy: 'someone@example.com',
    speechProvider: 'gemini',
    ...over,
  });

  const store = ({ episodes = [], sets = [] } = {}) => ({
    queryDocs: vi.fn(async (container) =>
      container === 'listen_and_learn_episodes' ? episodes : sets
    ),
    readDoc: vi.fn(),
  });

  const list = (deps, query = { platform: 'azure' }) =>
    createPublicReadHandlers({ store: deps }).listListenAndLearnEpisodes(
      makeRequest({ query }),
      context
    );

  it('filters to published in SQL, on an equality test, by provider', async () => {
    const deps = store();
    await list(deps);
    const [container, query, params] = deps.queryDocs.mock.calls[0];
    expect(container).toBe('listen_and_learn_episodes');
    expect(query).toContain('c.status = @status');
    expect(query).not.toContain('!=');
    expect(query).toMatch(/SELECT TOP \d+/);
    expect(params).toContainEqual({ name: '@status', value: 'published' });
    expect(params).toContainEqual({ name: '@provider', value: 'azure' });
  });

  it('orders newest approval first in SQL, on one field, so the cap keeps the newest rows', async () => {
    // Above the cap an unordered TOP returns an arbitrary subset that no
    // in-memory sort can recover. One key only: the container declares no
    // composite index, and a two-key ORDER BY would need one.
    const deps = store();
    await list(deps);
    const query = deps.queryDocs.mock.calls[0][1];
    expect(query).toMatch(/ORDER BY c\.approvedAt DESC\s*$/);
    expect(query.match(/ORDER BY/g)).toHaveLength(1);
    expect(query).not.toMatch(/ORDER BY [^,]+,/);
  });

  it('projects the allowlist in SQL so the transcript never leaves Cosmos', async () => {
    const deps = store();
    await list(deps);
    const [episodesQuery, setsQuery] = deps.queryDocs.mock.calls.map((call) => call[1]);

    expect(episodesQuery).not.toMatch(/SELECT TOP \d+ \*/);
    for (const field of ['id', 'setId', 'title', 'audioUrl', 'durationSeconds', 'approvedAt']) {
      expect(episodesQuery).toContain(`c["${field}"]`);
    }
    expect(episodesQuery).not.toContain('transcript');
    expect(episodesQuery).not.toContain('approvedBy');
    // The soft-delete markers must come back or isSoftDeleted cannot run.
    expect(episodesQuery).toContain('c["softDeletedAt"]');
    expect(episodesQuery).toContain('c["softDeleteExpiresAt"]');

    expect(setsQuery).not.toMatch(/SELECT TOP \d+ \*/);
    expect(setsQuery).toContain('c["id"], c["certTitle"], c["certSlug"]');
    expect(setsQuery).toContain('c["softDeletedAt"]');
    expect(setsQuery).not.toContain('studyGuideUrl');
  });

  it('projects each row to the listing allowlist and joins the certification', async () => {
    const deps = store({
      episodes: [published()],
      sets: [{ id: 'azure_az-104', certTitle: 'Azure Administrator', certSlug: 'az-104' }],
    });
    const body = JSON.parse((await list(deps)).body);
    expect(body.items).toEqual([
      {
        id: 'area-1',
        setId: 'azure_az-104',
        provider: 'azure',
        examCode: 'AZ-104',
        areaSlug: 'area-1',
        areaName: 'Manage identities',
        order: 0,
        weightLabel: '20-25%',
        title: 'Identities',
        summary: 'A summary',
        audioUrl: '/api/public/media/listenandlearn/azure/az-104/area-1.mp3',
        audioBytes: 1000,
        durationSeconds: 540,
        approvedAt: '2026-09-01T00:00:00Z',
        generatedAt: '2026-08-30T00:00:00Z',
        certTitle: 'Azure Administrator',
        certSlug: 'az-104',
      },
    ]);
    // The transcript is the largest field on the document and the approver
    // is provenance for the admin page; neither belongs on an anonymous list.
    expect(JSON.stringify(body)).not.toContain('the whole script');
    expect(JSON.stringify(body)).not.toContain('someone@example.com');
  });

  it('omits an episode with no audio: a podcast row must play something', async () => {
    const deps = store({
      episodes: [published({ id: 'silent', audioUrl: null }), published({ id: 'sound' })],
    });
    const body = JSON.parse((await list(deps)).body);
    expect(body.items.map((e) => e.id)).toEqual(['sound']);
    expect(body.total).toBe(1);
  });

  it('drops soft-deleted episodes and ignores soft-deleted sets', async () => {
    const deps = store({
      episodes: [published({ id: 'gone', softDeletedAt: '2026-01-01' }), published({ id: 'kept' })],
      sets: [{ id: 'azure_az-104', certTitle: 'Old', softDeletedAt: '2026-01-01' }],
    });
    const body = JSON.parse((await list(deps)).body);
    expect(body.items.map((e) => e.id)).toEqual(['kept']);
    expect(body.items[0].certTitle).toBeNull();
  });

  it('sorts newest approval first, falling back to generation time', async () => {
    const deps = store({
      episodes: [
        published({ id: 'older', approvedAt: '2026-08-01T00:00:00Z' }),
        published({ id: 'newest', approvedAt: '2026-09-05T00:00:00Z' }),
        published({ id: 'unapproved-date', approvedAt: null, generatedAt: '2026-09-03T00:00:00Z' }),
      ],
    });
    const body = JSON.parse((await list(deps)).body);
    expect(body.items.map((e) => e.id)).toEqual(['newest', 'unapproved-date', 'older']);
  });

  it('lowercases the platform and requires it', async () => {
    const deps = store();
    await list(deps, { platform: 'AZURE' });
    expect(deps.queryDocs.mock.calls[0][2]).toContainEqual({ name: '@provider', value: 'azure' });
    expect((await list(store(), {})).status).toBe(400);
  });

  it('names the same containers the writer does', async () => {
    const { SET_CONTAINER, EPISODE_CONTAINER } = await import('./listen-and-learn/publish.js');
    const deps = store();
    await list(deps);
    const containers = deps.queryDocs.mock.calls.map((call) => call[0]);
    expect(containers).toContain(EPISODE_CONTAINER);
    expect(containers).toContain(SET_CONTAINER);
  });

  it('lists the kind of a source-grounded episode and withholds its sources (#433)', async () => {
    // `kind` is the decided addition: a listener-facing page may label a
    // source-grounded episode. `sources` waits for the citation page. And a
    // document with no `kind` — every episode before #433 — is listed as
    // it always was, which the exact-row test above pins.
    const sources = [{ kind: 'page', url: 'https://example.com/a', title: 'A' }];
    const deps = store({
      episodes: [published({ id: 'source_t', kind: 'source', sources })],
      sets: [{ id: 'azure_az-104', certTitle: 'T', certSlug: 't' }],
    });
    const body = JSON.parse((await list(deps)).body);
    expect(body.items[0].kind).toBe('source');
    expect(body.items[0]).not.toHaveProperty('sources');
    expect(JSON.stringify(body)).not.toContain('https://example.com/a');

    const query = deps.queryDocs.mock.calls[0][1];
    expect(query).toContain('c["kind"]');
    expect(query).not.toContain('sources');
  });
});

describe('podcast media that is gone (#372)', () => {
  const handlers = (rows) =>
    createPublicReadHandlers({
      store: {
        queryDocs: vi.fn(async (container) => rows[container] ?? []),
        readDoc: vi.fn(),
      },
    });

  it('hides a row on a host the show left only when nothing has refreshed it since', () => {
    // Podbean's first tenure: never refreshed after the show returned.
    expect(
      isPodcastMediaRetired({
        mediaUrl: 'https://mcdn.podbean.com/mf/web/x/ep.mp3',
        updatedAt: '2026-09-04T10:00:00.000Z',
      })
    ).toBe(true);
    expect(isPodcastMediaRetired({ mediaUrl: 'https://MCDN.podbean.com/ep.mp3' })).toBe(true);
    // The current feed's episodes, refreshed by fetchPodcastFeeds since the
    // return: the bare host list hid all of them on 2026-10-13.
    expect(
      isPodcastMediaRetired({
        mediaUrl: 'https://mcdn.podbean.com/mf/web/y/ep.mp3',
        updatedAt: '2026-10-13T06:30:00.000Z',
      })
    ).toBe(false);
    // RSS.com: the stale upload the public list showed instead of the show.
    expect(
      isPodcastMediaRetired({
        mediaUrl: 'https://content.rss.com/episodes/1/2/hcw/ep.mp3',
        updatedAt: '2026-09-08T03:30:00.570Z',
      })
    ).toBe(true);
    expect(
      isPodcastMediaRetired({
        mediaUrl: 'https://media.rss.com/hcw/ep.mp3',
        updatedAt: '2026-10-13T08:30:00.000Z',
      })
    ).toBe(false);
    // A host the show has not left is never hidden here, however stale, so a
    // stalled timer cannot empty the page.
    expect(
      isPodcastMediaRetired({ mediaUrl: 'https://cdn.example/ep.mp3', updatedAt: '2020-01-01T00:00:00.000Z' })
    ).toBe(false);
    expect(
      isPodcastMediaRetired({
        mediaUrl: 'https://media.rss.com/hcw/ep.mp3',
        updatedAt: '2026-10-13T08:30:00.000Z',
        mediaUnavailableAt: '2026-10-14',
      })
    ).toBe(true);
    expect(isPodcastMediaRetired({ mediaUrl: 'not a url' })).toBe(false);
    expect(isPodcastMediaRetired({})).toBe(false);
  });

  it('listPodcasts hides episodes whose media is gone, and counts only what it serves', async () => {
    const h = handlers({
      podcasts: [
        {
          id: 'dead',
          title: 'PodBean era',
          publishedAt: '2026-05-01',
          mediaUrl: 'https://mcdn.podbean.com/mf/web/x/ep.mp3',
          updatedAt: '2026-09-04T10:00:00.000Z',
        },
        {
          id: 'marked',
          title: 'Marked',
          publishedAt: '2026-06-01',
          mediaUrl: 'https://media.rss.com/a.mp3',
          mediaUnavailableAt: '2026-09-06',
        },
        {
          id: 'stale-rsscom',
          title: 'RSS.com upload no feed carries',
          publishedAt: '2026-09-08',
          mediaUrl: 'https://content.rss.com/episodes/1/2/hcw/a.mp3',
          updatedAt: '2026-09-08T03:30:00.570Z',
        },
        {
          id: 'live',
          title: 'Back on Podbean',
          publishedAt: '2026-07-01',
          mediaUrl: 'https://mcdn.podbean.com/mf/web/y/b.mp3',
          updatedAt: '2026-10-13T06:30:00.000Z',
        },
      ],
    });
    const body = JSON.parse((await h.listPodcasts(makeRequest(), context)).body);
    expect(body.items.map((i) => i.id)).toEqual(['live']);
    expect(body.total).toBe(1);
  });
});

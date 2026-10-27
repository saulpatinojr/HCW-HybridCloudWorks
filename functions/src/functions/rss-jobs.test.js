import { beforeEach, expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({
  queryDocs: vi.fn(),
  upsertDoc: vi.fn(),
  readDoc: vi.fn(),
  parseURL: vi.fn(),
}));
vi.mock('../lib/cosmos-client.js', () => fakes);
vi.mock('../lib/cms/content-dedup.js', () => ({
  findDuplicateContent: vi.fn(async () => ({ duplicate: false })),
  buildDedupFields: () => ({}),
}));
vi.mock('../lib/rss/ingest.js', async (load) => ({
  ...(await load()),
  createRssParser: async () => ({ parseURL: fakes.parseURL }),
}));
import { DEFAULT_BLOG_SOURCES } from '../lib/rss/source-config.js';
import { getJobType } from '../lib/jobs.js';
import { runRssIngest } from './rss-jobs.js';

const kiro = DEFAULT_BLOG_SOURCES.find((source) => source.name === 'Kiro Blog');
const listing = DEFAULT_BLOG_SOURCES.find((source) => source.kind === 'listing');
let sources;
beforeEach(() => {
  vi.clearAllMocks();
  sources = DEFAULT_BLOG_SOURCES.map((source) => ({
    ...source,
    enabled: source.id === kiro.id,
    settingKind: 'blog_source',
    maxItems: 1,
    fallbackImageUrl: 'https://example.com/default.png',
  }));
  fakes.queryDocs.mockImplementation(async (container) =>
    container === 'admin_settings' ? sources : []
  );
  fakes.upsertDoc.mockImplementation(async (_, doc) => doc);
  fakes.parseURL.mockResolvedValue({
    items: [
      {
        title: 'New Kiro feature',
        link: 'https://kiro.dev/blog/new-feature',
        contentSnippet: 'A feature.',
      },
      { title: 'Another feature', link: 'https://kiro.dev/blog/another-feature' },
    ],
  });
});

it('scheduled RSS intake uses saved source enablement, limits, and image settings', async () => {
  const result = await runRssIngest({});
  expect(result.newContent).toBe(1);
  expect(fakes.parseURL).toHaveBeenCalledTimes(1);
  expect(fakes.upsertDoc).toHaveBeenCalledWith(
    'content',
    expect.objectContaining({
      blogSourceId: kiro.id,
      blogFallbackImageUrl: 'https://example.com/default.png',
      Live: false,
      inspectTrigger: true,
    })
  );
});
it('manual source jobs run the selected enabled source and refuse paused or missing sources', async () => {
  const worker = getJobType('sync-blog-source').worker;
  expect((await worker({ sourceId: kiro.id }, { context: {} })).newContent).toBe(1);
  sources = sources.map((source) => ({ ...source, enabled: false }));
  await expect(worker({ sourceId: kiro.id })).rejects.toThrow('Choose an enabled blog source');
  await expect(worker({ sourceId: 'unknown' })).rejects.toThrow('Choose an enabled blog source');
});
it('manual listing intake preserves source settings and resolves article links relative to the listing', async () => {
  sources = sources.map((source) => ({ ...source, enabled: source.id === listing.id }));
  vi.stubEnv('FIRECRAWL_API_KEY', 'fc-unit-test-only');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          extract: {
            articles: [
              { title: 'Listing article', url: 'relative-post' },
              { title: 'Malformed', url: 'https://[' },
            ],
          },
        },
      }),
    }))
  );
  try {
    const result = await getJobType('sync-blog-source').worker(
      { sourceId: listing.id },
      { context: {} }
    );
    expect(result.newArticles).toBe(1);
    expect(fakes.upsertDoc).toHaveBeenCalledWith(
      'content',
      expect.objectContaining({
        blogSourceId: listing.id,
        blogFallbackImageUrl: 'https://example.com/default.png',
        sourceUrl: new URL('relative-post', listing.url).href,
        Live: false,
        inspectTrigger: true,
      })
    );
    expect(fakes.upsertDoc).toHaveBeenCalledWith(
      'admin_settings',
      expect.objectContaining({ sourceId: listing.id, status: 'succeeded' })
    );
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
it('does not begin an already cancelled RSS sweep', async () => {
  await expect(
    runRssIngest({}, { signal: AbortSignal.abort(new Error('cancelled')) })
  ).rejects.toThrow('cancelled');
  expect(fakes.queryDocs).not.toHaveBeenCalled();
});

it('does not fail listing ingestion when its run-status write fails', async () => {
  sources = sources.map((source) => ({ ...source, enabled: source.id === listing.id }));
  const original = fakes.upsertDoc.getMockImplementation();
  fakes.upsertDoc.mockImplementation((container, doc) => {
    if (container === 'admin_settings') throw new Error('Status write unavailable');
    return original(container, doc);
  });
  vi.stubEnv('FIRECRAWL_API_KEY', 'fc-unit-test-only');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: { extract: { articles: [{ title: 'Article', url: 'relative-post' }] } },
      }),
    }))
  );
  try {
    const result = await getJobType('sync-blog-source').worker(
      { sourceId: listing.id },
      { context: {} }
    );
    expect(result).toMatchObject({ newArticles: 1, errors: 0 });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it.each(['AbortError', 'SyntaxError'])(
  'records listing response body %s as a failure, rather than an empty success',
  async (name) => {
    sources = sources.map((source) => ({ ...source, enabled: source.id === listing.id }));
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-unit-test-only');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw Object.assign(new Error('private-upstream-response-marker'), { name });
        },
      }))
    );
    const context = { error: vi.fn() };
    try {
      const result = await getJobType('sync-blog-source').worker(
        { sourceId: listing.id },
        { context }
      );
      expect(result).toMatchObject({ newArticles: 0, errors: 1 });
      expect(result.failures[0].error).toBe('The blog listing response could not be read.');
      expect(JSON.stringify(result)).not.toContain('private-upstream-response-marker');
      expect(context.error).toHaveBeenCalled();
      expect(JSON.stringify(context.error.mock.calls)).not.toContain(
        'private-upstream-response-marker'
      );
      expect(fakes.upsertDoc).toHaveBeenCalledWith(
        'admin_settings',
        expect.objectContaining({ sourceId: listing.id, status: 'failed' })
      );
      expect(
        fakes.upsertDoc.mock.calls.filter(([container]) => container === 'content')
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }
);

it('preserves caller cancellation while the listing body is being read', async () => {
  sources = sources.map((source) => ({ ...source, enabled: source.id === listing.id }));
  const controller = new AbortController();
  const context = { error: vi.fn() };
  vi.stubEnv('FIRECRAWL_API_KEY', 'fc-unit-test-only');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => {
        controller.abort(new Error('cancelled by caller'));
        throw new Error('private-upstream-response-marker');
      },
    }))
  );
  try {
    await expect(
      getJobType('sync-blog-source').worker(
        { sourceId: listing.id },
        { context, signal: controller.signal }
      )
    ).rejects.toThrow('cancelled by caller');
    expect(context.error).not.toHaveBeenCalled();
    expect(fakes.upsertDoc).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

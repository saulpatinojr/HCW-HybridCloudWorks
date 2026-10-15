/**
 * URL → draft (Blog Machine T-602): scrape orchestration, supporting-material
 * assembly under the drafter's 5-document ceiling, both callers' payload
 * dialects, and the HTTP handler's error mapping — the codes are the
 * contract the Publish-Ready Builder shows to the owner.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  isHttpUrl,
  extractPageTitle,
  extractPageDescription,
  inferProviderFromUrl,
  scrapeToSource,
  createUrlDrafter,
  createGenerateArticleDraftHandler,
  buildUrlSourceDoc,
  DRAFT_HTTP_BUDGET_MS,
  MAX_EXTRA_URL_SCRAPES,
  UrlDraftError,
} from './draft-from-url.js';
import { createDrafter } from './drafting.js';
import { createAiRouter } from '../ai/router.js';
import { AFTER_MODEL_MARGIN_MS } from '../ai/time-budget.js';

const PAGE_HTML = `<html><head>
  <title>Fallback Title</title>
  <meta property="og:title" content="OG Title" />
  <meta property="og:description" content="OG description." />
</head><body>x</body></html>`;

const goodScrape = (over = {}) => ({
  success: true,
  markdown: '# Article\n\nBody text.',
  html: PAGE_HTML,
  plainText: 'Body text.',
  images: [{ src: 'https://img.example/hero.png' }],
  wordCount: 42,
  scrapeMode: 'direct_html',
  error: null,
  ...over,
});

describe('url and page helpers', () => {
  it('isHttpUrl accepts http(s) only', () => {
    expect(isHttpUrl('https://a.example/x')).toBe(true);
    expect(isHttpUrl('http://a.example')).toBe(true);
    expect(isHttpUrl('ftp://a.example')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });

  it('extractPageTitle prefers og:title, falls back to <title>, then the fallback', () => {
    expect(extractPageTitle(PAGE_HTML)).toBe('OG Title');
    expect(extractPageTitle('<html><head><title>T</title></head></html>')).toBe('T');
    expect(extractPageTitle('<html></html>', 'fb')).toBe('fb');
  });

  it('extractPageDescription reads og:description then meta description', () => {
    expect(extractPageDescription(PAGE_HTML)).toBe('OG description.');
    expect(extractPageDescription('<meta name="description" content="plain">')).toBe('plain');
    expect(extractPageDescription('')).toBe('');
  });

  it('inferProviderFromUrl maps the same keywords the Builder uses, Multi otherwise', () => {
    expect(inferProviderFromUrl('https://learn.microsoft.com/azure/aks')).toBe('Azure');
    expect(inferProviderFromUrl('https://aws.amazon.com/blogs/x')).toBe('Aws');
    expect(inferProviderFromUrl('https://cloud.google.com/run')).toBe('Gcp');
    expect(inferProviderFromUrl('https://example.com/post')).toBe('Multi');
  });

  it('infers Docker last, as the Builder does: Docker on Azure is Azure', () => {
    expect(inferProviderFromUrl('https://docs.docker.com/build/')).toBe('Docker');
    expect(inferProviderFromUrl('https://learn.microsoft.com/azure/docker-on-aci')).toBe('Azure');
  });
});

describe('scrapeToSource', () => {
  it('rejects a non-http URL with BAD_URL before any network touch', async () => {
    const scrape = vi.fn();
    await expect(scrapeToSource('notaurl', { scrape })).rejects.toMatchObject({
      code: 'BAD_URL',
    });
    expect(scrape).not.toHaveBeenCalled();
  });

  it('maps a failed or empty scrape to SCRAPE_FAILED with the scraper reason', async () => {
    const scrape = vi.fn(async () => ({ success: false, error: 'Status code 403' }));
    await expect(scrapeToSource('https://a.example/x', { scrape })).rejects.toMatchObject({
      code: 'SCRAPE_FAILED',
      message: expect.stringContaining('Status code 403'),
    });
  });

  it('returns markdown, title, description and images on success', async () => {
    const scrape = vi.fn(async () => goodScrape());
    const source = await scrapeToSource('https://a.example/x ', { scrape });
    expect(source).toMatchObject({
      url: 'https://a.example/x',
      markdown: '# Article\n\nBody text.',
      title: 'OG Title',
      description: 'OG description.',
      wordCount: 42,
      scrapeMode: 'direct_html',
    });
  });
});

describe('createUrlDrafter', () => {
  const makeDrafter = () => ({
    generateDraft: vi.fn(async () => ({
      title: 'Drafted',
      summary: 'S',
      postContent: '# P',
      keyTopics: ['a'],
      summaryPrompt: 'sp',
      detailsPrompt: 'dp',
      suggestedContentType: 'blog',
    })),
  });

  it('drafts from the primary URL, inferring the provider when none is given', async () => {
    const drafter = makeDrafter();
    const scrape = vi.fn(async () => goodScrape());
    const { draftFromUrl } = createUrlDrafter({ drafter, scrape });
    const result = await draftFromUrl({ url: 'https://learn.microsoft.com/azure/x' });
    expect(result.draft.title).toBe('Drafted');
    expect(result.draft.sourceUrls).toEqual(['https://learn.microsoft.com/azure/x']);
    const call = drafter.generateDraft.mock.calls[0][0];
    expect(call).toMatchObject({
      url: 'https://learn.microsoft.com/azure/x',
      cloudProvider: 'Azure',
      scrapedTitle: 'OG Title',
      description: 'OG description.',
      markdown: '# Article\n\nBody text.',
    });
  });

  it("merges both dialects' instructions and folds draftText in as a supporting document", async () => {
    const drafter = makeDrafter();
    const scrape = vi.fn(async () => goodScrape());
    const { draftFromUrl } = createUrlDrafter({ drafter, scrape });
    await draftFromUrl({
      url: 'https://a.example/x',
      customInstructionPrompt: 'Builder prompt',
      instructions: 'Editor instruction',
      draftText: 'current draft body',
    });
    const call = drafter.generateDraft.mock.calls[0][0];
    expect(call.customInstructionPrompt).toBe('Builder prompt\n\nEditor instruction');
    expect(call.supportingDocuments).toEqual([
      expect.objectContaining({ name: 'Current article draft', textContent: 'current draft body' }),
    ]);
  });

  it('scrapes extra KB urls (capped) and tolerates one failing', async () => {
    const drafter = makeDrafter();
    const scrape = vi.fn(async (url) => {
      if (url.includes('broken')) return { success: false, error: 'nope' };
      return goodScrape();
    });
    const { draftFromUrl } = createUrlDrafter({ drafter, scrape });
    const extras = ['https://kb.example/1', 'https://kb.example/broken', 'https://kb.example/2'];
    const result = await draftFromUrl({
      url: 'https://a.example/x',
      urls: ['https://a.example/x', ...extras, 'https://kb.example/beyond-cap'],
    });
    // primary + capped extras recorded as provenance
    expect(result.draft.sourceUrls).toEqual(['https://a.example/x', ...extras]);
    expect(scrape).toHaveBeenCalledTimes(1 + MAX_EXTRA_URL_SCRAPES);
    const docs = drafter.generateDraft.mock.calls[0][0].supportingDocuments;
    expect(docs).toHaveLength(2); // the broken extra degraded, it did not fail the draft
    expect(docs[0].name).toMatch(/^KB article: /);
  });

  it('fetches documentUrls server-side: pdf as base64, text inline, failures skipped', async () => {
    const drafter = makeDrafter();
    const scrape = vi.fn(async () => goodScrape());
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('.pdf'))
        return {
          ok: true,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: async () => new TextEncoder().encode('PDFDATA').buffer,
        };
      if (url.endsWith('missing')) return { ok: false, headers: { get: () => '' } };
      return {
        ok: true,
        headers: { get: () => 'text/plain' },
        text: async () => 'kb text',
      };
    });
    const resolve = async () => ({ address: '93.184.216.34' });
    const { draftFromUrl } = createUrlDrafter({ drafter, scrape, fetch: fetchImpl, resolve });
    await draftFromUrl({
      url: 'https://a.example/x',
      documentUrls: ['https://kb.example/doc.pdf', 'https://kb.example/missing', 'https://kb.example/notes.txt'],
    });
    const docs = drafter.generateDraft.mock.calls[0][0].supportingDocuments;
    expect(docs).toEqual([
      expect.objectContaining({ name: 'doc.pdf', mimeType: 'application/pdf' }),
      expect.objectContaining({ name: 'notes.txt', textContent: 'kb text' }),
    ]);
    expect(Buffer.from(docs[0].base64Data, 'base64').toString()).toBe('PDFDATA');
  });

  it('never fetches a documentUrl on the private network, link-local, or localhost, and a redirect there is refused', async () => {
    const drafter = makeDrafter();
    const scrape = vi.fn(async () => goodScrape());
    const fetchImpl = vi.fn(async (url) =>
      url.includes('bounce')
        ? { ok: false, status: 302, headers: { get: (k) => (k === 'location' ? 'http://10.0.0.5/secret' : null) } }
        : { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'leaked' }
    );
    const addresses = { 'kb.example': '93.184.216.34', 'internal.example': '10.0.0.5' };
    const resolve = async (host) => ({ address: addresses[host] || '169.254.169.254' });
    const { draftFromUrl } = createUrlDrafter({ drafter, scrape, fetch: fetchImpl, resolve });
    await draftFromUrl({
      url: 'https://a.example/x',
      documentUrls: [
        'http://internal.example/config',
        'http://169.254.169.254/metadata/identity',
        'http://localhost:7071/api/health',
        'https://kb.example/bounce',
      ],
    });
    const docs = drafter.generateDraft.mock.calls[0][0].supportingDocuments;
    expect(docs).toEqual([]);
    // Only the public host was ever contacted (once, for the redirect that was then refused).
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['https://kb.example/bounce']);
  });

  it('spends the budget on the scrapes and hands the drafter what is left', async () => {
    vi.useFakeTimers();
    try {
      const drafter = makeDrafter();
      const scrape = vi.fn(async () => {
        vi.advanceTimersByTime(10_000);
        return goodScrape();
      });
      const { draftFromUrl } = createUrlDrafter({ drafter, scrape });
      await draftFromUrl({ url: 'https://a.example/x' }, { budgetMs: 60_000 });
      expect(drafter.generateDraft.mock.calls[0][0].budgetMs).toBe(50_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never takes a budget from the payload, which is the client body', async () => {
    const drafter = makeDrafter();
    const { draftFromUrl } = createUrlDrafter({ drafter, scrape: vi.fn(async () => goodScrape()) });
    await draftFromUrl({ url: 'https://a.example/x', budgetMs: 999_999 });
    expect(drafter.generateDraft.mock.calls[0][0].budgetMs).toBeUndefined();
    await draftFromUrl({ url: 'https://a.example/x', budgetMs: 999_999 }, { budgetMs: 40_000 });
    expect(drafter.generateDraft.mock.calls[1][0].budgetMs).toBeLessThanOrEqual(40_000);
  });
});

describe('createGenerateArticleDraftHandler', () => {
  const makeRequest = (body) => ({ json: async () => body });
  const okGuard = { requireRole: vi.fn(async () => ({ oid: 'u1' })) };

  it('refuses without the editor role, before reading the body', async () => {
    const guard = {
      requireRole: vi.fn(async () => ({ error: { status: 403, body: 'no' } })),
    };
    const urlDrafter = { draftFromUrl: vi.fn() };
    const handler = createGenerateArticleDraftHandler({ guard, urlDrafter });
    const res = await handler(makeRequest({ url: 'https://a.example' }), {});
    expect(res).toEqual({ status: 403, body: 'no' });
    expect(urlDrafter.draftFromUrl).not.toHaveBeenCalled();
  });

  it('returns 200 { ok, draft } on success', async () => {
    const urlDrafter = { draftFromUrl: vi.fn(async () => ({ draft: { title: 'T' } })) };
    const handler = createGenerateArticleDraftHandler({ guard: okGuard, urlDrafter });
    const res = await handler(makeRequest({ url: 'https://a.example' }), {});
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, draft: { title: 'T' } });
  });

  it('hands the drafter its budget, less the after-model margin, beside the body and not in it', async () => {
    const urlDrafter = { draftFromUrl: vi.fn(async () => ({ draft: { title: 'T' } })) };
    const handler = createGenerateArticleDraftHandler({ guard: okGuard, urlDrafter });
    const body = { url: 'https://a.example' };
    await handler(makeRequest(body), {});
    expect(urlDrafter.draftFromUrl).toHaveBeenCalledWith(body, {
      budgetMs: DRAFT_HTTP_BUDGET_MS - AFTER_MODEL_MARGIN_MS,
    });
  });

  it.each([
    ['BAD_URL', 400],
    ['SCRAPE_FAILED', 422],
    ['DRAFT_BUDGET_EXCEEDED', 504],
    ['AI_BUDGET_EXHAUSTED', 504],
    [undefined, 502],
  ])('maps error code %s to HTTP %i, in its own words for text it did not write', async (code, status) => {
    // A provider or system message ('boom') never reaches the answer (#945);
    // the log line carries the code and the correlation id instead.
    const err = new Error('boom');
    if (code) err.code = code;
    const urlDrafter = { draftFromUrl: vi.fn(async () => Promise.reject(err)) };
    const handler = createGenerateArticleDraftHandler({ guard: okGuard, urlDrafter });
    const context = { error: vi.fn(), invocationId: 'inv-1' };
    const res = await handler(makeRequest({ url: 'https://a.example' }), context);
    expect(res.status).toBe(status);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      error: 'The draft could not be generated.',
      correlationId: 'inv-1',
    });
    expect(context.error).toHaveBeenCalledWith(
      `[inv-1] The draft could not be generated. (name=Error${code ? ` code=${code}` : ''})`
    );
    expect(JSON.stringify(context.error.mock.calls)).not.toContain('boom');
  });

  it("shows the drafter's own refusal word for word: it is authored", async () => {
    const err = new UrlDraftError('A valid http(s) URL is required.', { code: 'BAD_URL' });
    const urlDrafter = { draftFromUrl: vi.fn(async () => Promise.reject(err)) };
    const handler = createGenerateArticleDraftHandler({ guard: okGuard, urlDrafter });
    const res = await handler(makeRequest({ url: 'x' }), { warn: vi.fn(), invocationId: 'inv-2' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      error: 'A valid http(s) URL is required.',
      correlationId: 'inv-2',
    });
  });

  it('answers 504 when the draft outlives the budget, without waiting for it', async () => {
    const urlDrafter = { draftFromUrl: () => new Promise(() => {}) };
    const handler = createGenerateArticleDraftHandler({
      guard: okGuard,
      urlDrafter,
      budgetMs: 10,
    });
    const res = await handler(makeRequest({ url: 'https://a.example' }), { error: vi.fn() });
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body).error).toMatch(/exceeded/);
  });
});

describe('end to end: a slow first provider no longer outlives the request (2026-09-29)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const okGuard = { requireRole: vi.fn(async () => ({ oid: 'u1' })) };
  const draftJson = JSON.stringify({
    title: 'From the next provider',
    summary: 'S',
    postContent: '# P',
    keyTopics: [],
  });

  /** A fetch where NVIDIA never answers until aborted and Gemini answers at once. */
  function fetchWithStuckNvidia(hosts) {
    return vi.fn((url, init) => {
      const host = new URL(url).host;
      hosts.push(host);
      if (host === 'integrate.api.nvidia.com') {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ candidates: [{ content: { parts: [{ text: draftJson }] } }] }),
      });
    });
  }

  const draftHandler = (ai) =>
    createGenerateArticleDraftHandler({
      guard: okGuard,
      urlDrafter: createUrlDrafter({
        drafter: createDrafter({ store: { queryDocs: async () => [] }, ai, env: {} }),
        scrape: async () => goodScrape(),
      }),
    });

  it('NVIDIA never answers; the draft still comes back from Gemini, well inside the handler budget', async () => {
    // Before the budget, NVIDIA was allowed 120 s, the handler answered 504
    // at 75 s, and Gemini was never asked. NVIDIA is placed first for
    // drafting here, as an administrator still can; since 2026-09-29 its
    // default is the backup (the next test).
    vi.useFakeTimers();
    const hosts = [];
    const ai = createAiRouter({
      env: { NVIDIA_API_KEY: 'nvapi-test', GEMINI_API_KEY: 'g' },
      fetch: fetchWithStuckNvidia(hosts),
      log: { warn: vi.fn() },
      store: {
        queryDocs: async () => [],
        readDoc: async () => ({ placement: { nvidia: { forgeDrafting: 'first' } } }),
      },
    });
    const handler = draftHandler(ai);

    const startedAt = Date.now();
    const pending = handler(makeRequestFor({ url: 'https://learn.microsoft.com/azure/x' }), {
      error: vi.fn(),
    }).then((res) => ({ res, at: Date.now() }));
    await vi.advanceTimersByTimeAsync(DRAFT_HTTP_BUDGET_MS);
    const { res, at } = await pending;

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).draft).toMatchObject({
      title: 'From the next provider',
      aiProvider: 'gemini',
    });
    expect(hosts).toEqual(['integrate.api.nvidia.com', 'generativelanguage.googleapis.com']);
    // NVIDIA's share is half of (75 s less the 5 s margin), so the answer
    // comes at 35 s: under the client's 90 s and the edge's ~100 s.
    expect(at - startedAt).toBe((DRAFT_HTTP_BUDGET_MS - AFTER_MODEL_MARGIN_MS) / 2);
  });

  it('by default NVIDIA is the backup: Gemini answers at once and NVIDIA is never asked', async () => {
    // Owner decision 2026-09-29. With no stored placement the draft does not
    // wait out NVIDIA's share at all.
    vi.useFakeTimers();
    const hosts = [];
    const ai = createAiRouter({
      env: { NVIDIA_API_KEY: 'nvapi-test', GEMINI_API_KEY: 'g' },
      fetch: fetchWithStuckNvidia(hosts),
      log: { warn: vi.fn() },
    });

    const startedAt = Date.now();
    const pending = draftHandler(ai)(makeRequestFor({ url: 'https://learn.microsoft.com/azure/x' }), {
      error: vi.fn(),
    }).then((res) => ({ res, at: Date.now() }));
    await vi.advanceTimersByTimeAsync(0);
    const { res, at } = await pending;

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).draft).toMatchObject({ aiProvider: 'gemini' });
    expect(hosts).toEqual(['generativelanguage.googleapis.com']);
    expect(at - startedAt).toBe(0);
  });
});

function makeRequestFor(body) {
  return { json: async () => body };
}

describe('buildUrlSourceDoc', () => {
  it('lands inspected with inspectTrigger off, provenance recorded, body dual-cased', () => {
    const source = {
      url: 'https://a.example/deep/post',
      markdown: '# Body',
      title: 'A Title',
      description: 'D',
      images: [{ src: 'https://img.example/h.png' }],
      scrapeMode: 'direct_html',
    };
    const doc = buildUrlSourceDoc({
      source,
      provider: 'Azure',
      now: () => new Date('2026-08-28T00:00:00Z'),
      uuid: () => 'id-1',
    });
    expect(doc).toMatchObject({
      id: 'id-1',
      Title: 'A Title',
      Content: '# Body',
      content: '# Body',
      'Cloud Provider': 'Azure',
      contentStatus: 'inspected',
      inspectTrigger: false,
      Live: false,
      source: 'forge-url',
      sourceUrl: 'https://a.example/deep/post',
      contentImageUrl: 'https://img.example/h.png',
      Slug: 'a-title',
    });
  });

  it('titles from the hostname when the page had none', () => {
    const doc = buildUrlSourceDoc({
      source: { url: 'https://blog.example/x', markdown: 'm', title: '', images: [] },
      provider: 'Multi',
      now: () => new Date(),
      uuid: () => 'id-2',
    });
    expect(doc.Title).toBe('Article from blog.example');
  });
});

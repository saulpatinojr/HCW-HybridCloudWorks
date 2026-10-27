import { describe, it, expect, vi } from 'vitest';
import {
  createPublerClient,
  publerSettingForStatus,
  createPublerReconcile,
  buildSocialPostSyncPatch,
  publerStateToSocialStatus,
  normalizePublerPost,
} from './publer-sync.js';
import {
  createBlogListingsScrape,
  scrapeListingPage,
  buildListingContentDoc,
  resolveArticleUrl,
} from './blog-listings.js';
import {
  createPodcastIngest,
  buildPodcastEpisode,
  normalizePodcastId,
  resolveMainFeedEntry,
  resolvePodcastFeeds,
  dedupeFeedsByProvider,
  isFeedGoneError,
  MAIN_FEED_PROVIDER,
  PODCAST_FEEDS,
} from './podcasts.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const now = () => NOW;

function memStore(containers = {}, match = () => []) {
  const data = Object.fromEntries(
    Object.entries(containers).map(([k, v]) => [k, new Map(v.map((d) => [d.id, d]))])
  );
  const get = (c) => (data[c] ||= new Map());
  return {
    data,
    readDoc: vi.fn(async (c, id) => get(c).get(id) || null),
    upsertDoc: vi.fn(async (c, doc) => {
      get(c).set(doc.id, doc);
      return doc;
    }),
    patchDoc: vi.fn(async (c, id, u) => {
      const next = { ...(get(c).get(id) || { id }), ...u };
      get(c).set(id, next);
      return next;
    }),
    queryDocs: vi.fn(async (c, q, p) => match(c, q, p, [...get(c).values()])),
  };
}

describe('Publer reconcile', () => {
  const publer = (over) => ({
    id: 'p1',
    state: 'scheduled',
    text: 'hi',
    scheduled_at: '2026-08-22T10:00:00Z',
    account_id: 'acc',
    network: 'linkedin',
    job_id: 'job1',
    ...over,
  });

  it('normalizes posts, maps states, and builds the sync patch with aggregate status', () => {
    expect(
      normalizePublerPost({
        post_id: '9',
        status: 'Published',
        caption: 'c',
        scheduledAt: 'bad',
      })
    ).toMatchObject({
      id: '9',
      state: 'published',
      text: 'c',
      scheduledAt: null,
    });
    expect(publerStateToSocialStatus('failed_x')).toBe('failed');
    expect(publerStateToSocialStatus('')).toBe('unknown');
    const patch = buildSocialPostSyncPatch(
      publer({ state: 'published' }),
      { publerPostIds: ['p0'] },
      [publer({ state: 'published' }), publer({ id: 'p2', state: 'scheduled' })],
      NOW.toISOString()
    );
    expect(patch).toMatchObject({
      publerStatus: 'mixed',
      publerActivePostIds: ['p1', 'p2'],
      publerScheduledAt: '2026-08-22T10:00:00.000Z',
      publerPostIds: ['p0', 'p1'],
      publerJobId: 'job1',
      status: 'scheduled',
      syncStatus: 'synced',
      lastSyncedAt: NOW.toISOString(),
      syncError: null,
    });
  });

  it('skips when not configured; ignores Key Vault literals', async () => {
    const client = createPublerClient({
      env: {
        PUBLER_API_KEY: '@Microsoft.KeyVault(SecretUri=x)',
        PUBLER_WORKSPACE_ID: 'w',
      },
      fetch: vi.fn(),
    });
    expect(client.configured).toBe(false);
    expect(await createPublerReconcile({ store: memStore(), client, now }).run()).toMatchObject({
      skipped: true,
      reason: 'not_configured',
    });
  });

  it('asks for all three states at once, pages, and reconciles matches, vanished and unlinked posts', async () => {
    // One `state[]` request per PAGE, not per state (#463 item 5). The three
    // separate passes this replaces cost three times the requests against a
    // budget of 100 per two minutes shared with every other holder of the key.
    const fetch = vi.fn(async (url) => {
      const params = new URL(url).searchParams;
      expect(params.getAll('state[]')).toEqual(['scheduled', 'published', 'failed']);
      // `per_page` is a response field, not a request parameter.
      expect(params.get('per_page')).toBeNull();
      const page = Number(params.get('page'));
      const posts =
        page === 0
          ? [publer(), publer({ id: 'p3', state: 'published', job_id: 'job3' })]
          : [publer({ id: 'p2', job_id: null })];
      return {
        ok: true,
        headers: { get: () => '87' },
        text: async () => JSON.stringify({ posts, total_pages: 2 }),
      };
    });
    const client = createPublerClient({
      env: { PUBLER_API_KEY: 'k', PUBLER_WORKSPACE_ID: 'w' },
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    const store = memStore(
      {
        social_posts: [
          { id: 's1', publerPostIds: ['p1'], status: 'draft' },
          { id: 's2', publerJobId: 'job3', status: 'scheduled' },
          { id: 's3', publerPostIds: ['gone'], status: 'scheduled' },
          {
            id: 's4',
            publerPostIds: ['gone2'],
            status: 'scheduled',
            syncOrigin: 'publer',
          },
        ],
      },
      (c, q, p, rows) => rows
    );
    const r = await createPublerReconcile({ store, client, now }).run();
    expect(r).toEqual({ skipped: false, fetched: 3, updated: 3, created: 1 });
    const STATES = 'state[]=scheduled&state[]=published&state[]=failed';
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      `${'https://app.publer.com/api/v1'}/posts?${STATES}&page=0`,
      `${'https://app.publer.com/api/v1'}/posts?${STATES}&page=1`,
    ]);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer-API k',
      'Publer-Workspace-Id': 'w',
    });
    expect(store.data.social_posts.get('s1')).toMatchObject({
      status: 'scheduled',
      publerStatus: 'scheduled',
      syncOrigin: 'publer',
    });
    expect(store.data.social_posts.get('s2')).toMatchObject({
      status: 'published',
      publerPostIds: ['p3'],
    });
    expect(store.data.social_posts.get('s3')).toMatchObject({
      status: 'deleted',
      publerStatus: 'deleted',
    });
    expect(store.data.social_posts.get('s4').status).toBe('scheduled'); // Publer-origin posts are not re-deleted
    expect(store.data.social_posts.get('publer_p2')).toMatchObject({
      caption: 'hi',
      platforms: ['linkedin'],
      accountIds: ['acc'],
      status: 'scheduled',
      unlinkedFromCalendar: true,
      source: 'publer',
      createdAt: NOW.toISOString(),
    });
  });
});

describe('publerSettingForStatus — which value a rejection actually blames', () => {
  it('blames the workspace id for 401 and the key for 403, as MEASURED not as documented', () => {
    // Publer's docs say 401 is a missing/invalid/revoked key and 403 is a bad
    // workspace or scope. Against the live API on 2026-09-09 it is the other
    // way round, and believing the docs cost #358 two days of reminting a key
    // that was never the problem.
    expect(publerSettingForStatus(401)).toBe('PUBLER_WORKSPACE_ID');
    expect(publerSettingForStatus(403)).toBe('PUBLER_API_KEY');
    expect(publerSettingForStatus('401')).toBe('PUBLER_WORKSPACE_ID');
  });

  it('keeps the warning internally consistent when the status is a string', () => {
    // The gloss and the setting name are derived from one call, so they cannot
    // disagree. A strict `=== 401` in the message had them disagreeing for a
    // string status: PUBLER_WORKSPACE_ID named, "a 403 is the key" explaining
    // it (Copilot review of a0c1ca3e).
    const log = { warn: vi.fn(), log: vi.fn() };
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: '401',
      headers: { get: () => null },
      text: async () => JSON.stringify({ errors: ['nope'] }),
    }));
    const client = createPublerClient({
      env: { PUBLER_API_KEY: 'k', PUBLER_WORKSPACE_ID: 'w' },
      fetch: fetchImpl,
      log,
    });
    return createPublerReconcile({ store: memStore(), client, now, log })
      .run()
      .then(() => {
        const message = log.warn.mock.calls[0][0];
        expect(message).toContain('PUBLER_WORKSPACE_ID');
        expect(message).toContain('a 401 is the workspace id');
        expect(message).not.toContain('a 403 is the key');
      });
  });

  it('falls back to the key for anything else', () => {
    // Unreachable today — `isCredentialRejected` admits only 401 and 403 — so
    // this pins the fallback as conservative rather than as behaviour.
    for (const status of [500, 429, undefined, null]) {
      expect(publerSettingForStatus(status)).toBe('PUBLER_API_KEY');
    }
  });
});

describe('Publer deletePosts — the documented bulk form (#463 item 2)', () => {
  const client = (fetchImpl) =>
    createPublerClient({
      env: { PUBLER_API_KEY: 'k', PUBLER_WORKSPACE_ID: 'w' },
      fetch: fetchImpl,
    });
  const answering = (body, ok = true, status = 200) =>
    vi.fn(async () => ({
      ok,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }));

  it('sends DELETE /posts with a post_ids[] array, not DELETE /posts/{id}', async () => {
    const fetch = answering({ deleted_ids: ['p1', 'p2'] });
    const result = await client(fetch).deletePosts(['p1', 'p2']);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://app.publer.com/api/v1/posts?post_ids[]=p1&post_ids[]=p2'
    );
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
    expect(result).toEqual({ deletedIds: ['p1', 'p2'], missingIds: [] });
  });

  it('reports an id Publer did not delete, because a 200 is not proof', async () => {
    // Publer answers 200 and simply leaves the id out of `deleted_ids`. A
    // caller that only watches for a throw records a post as removed while it
    // is still scheduled to publish under the owner's name.
    const fetch = answering({ deleted_ids: ['p1'] });
    expect(await client(fetch).deletePosts(['p1', 'p2'])).toEqual({
      deletedIds: ['p1'],
      missingIds: ['p2'],
    });
  });

  it('treats a missing deleted_ids as nothing deleted', async () => {
    const fetch = answering({});
    expect(await client(fetch).deletePosts(['p1'])).toEqual({
      deletedIds: [],
      missingIds: ['p1'],
    });
  });

  it('REFUSES an empty list without calling Publer at all', async () => {
    // This is the dangerous one. `DELETE /posts` with no `post_ids` is
    // documented as "delete every non-published post in the workspace", so an
    // empty list must never reach the wire — and it must fail loudly, because
    // the caller believed it had something to delete.
    const fetch = answering({ deleted_ids: [] });
    for (const ids of [[], null, undefined, [''], [null]]) {
      await expect(client(fetch).deletePosts(ids)).rejects.toThrow(/refusing to delete/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('encodes ids and drops duplicates', async () => {
    const fetch = answering({ deleted_ids: ['a b'] });
    await client(fetch).deletePosts(['a b', 'a b']);
    expect(fetch.mock.calls[0][0]).toBe('https://app.publer.com/api/v1/posts?post_ids[]=a%20b');
  });
});

describe('Publer paging stops before it exhausts the rate limit (#463 item 5)', () => {
  const build = (remaining, totalPages = 5) => {
    const log = { warn: vi.fn(), log: vi.fn() };
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => remaining },
      text: async () => JSON.stringify({ posts: [], total_pages: totalPages }),
    }));
    return { fetch, log, client: createPublerClient({ env: { PUBLER_API_KEY: 'k', PUBLER_WORKSPACE_ID: 'w' }, fetch, log }) };
  };

  it('stops after one page when the window is nearly spent, and says so', async () => {
    // 100 requests per two minutes, per USER ACCOUNT across every key it
    // holds — so the budget is shared with the owner's browser and the admin
    // pages. A reconcile that drains it takes those down with it, and a
    // partial pass is corrected five minutes later.
    const { fetch, log, client } = build('3');
    await client.listPostsForSync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/3 Publer requests left in the window/);
  });

  it('pages normally when the window is healthy', async () => {
    const { fetch, log, client } = build('90', 3);
    await client.listPostsForSync();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats a missing header as unknown, not as exhausted', async () => {
    // An upstream that stops sending the header must not stop the reconcile at
    // page one — which is what reading `null` as `0` would do.
    const { fetch, log, client } = build(null, 3);
    await client.listPostsForSync();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never pages past the hard cap however many pages Publer claims', async () => {
    const { fetch, client } = build('99', 500);
    await client.listPostsForSync();
    expect(fetch).toHaveBeenCalledTimes(10);
  });
});

describe('Publer rejected credential (#358)', () => {
  // Measured 2026-09-09: a stale key had failed this timer 429 times in 36
  // hours, 0 successes, and no alert read it. A rejected credential is a
  // configuration state, so the run skips with one warning and the API-keys
  // page hears about it; a 500 or a timeout is transient and still throws.
  const env = { PUBLER_API_KEY: 'k', PUBLER_WORKSPACE_ID: 'w' };
  const answering = (status) =>
    vi.fn(async () => ({
      ok: status < 400,
      status,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({ posts: [], total_pages: 1, errors: ['Publer said why'] }),
    }));
  const quiet = () => ({ warn: vi.fn(), log: vi.fn() });
  const build = ({ status, onKeyVerdict = vi.fn(), log = quiet() }) => {
    const fetch = answering(status);
    const client = createPublerClient({ env, fetch, onKeyVerdict, log });
    const store = memStore();
    const reconcile = createPublerReconcile({ store, client, now, log });
    return { fetch, client, store, reconcile, onKeyVerdict, log };
  };

  // THE ATTRIBUTION, and it is the whole point of #358.
  //
  // Measured against the live API on 2026-09-09 with a working key and a
  // deliberately wrong value in each position:
  //   correct key + WRONG workspace -> 401 "You don't have access on this workspace"
  //   WRONG key   + correct workspace -> 403 "Invalid API key or not active for this account."
  // which is the REVERSE of Publer's documentation. Reporting both against
  // PUBLER_API_KEY turned the key red when the workspace id was wrong, and two
  // days went into reminting a key that was fine.
  it.each([
    [401, 'PUBLER_WORKSPACE_ID', 'PUBLER_API_KEY'],
    [403, 'PUBLER_API_KEY', 'PUBLER_WORKSPACE_ID'],
  ])('blames %i on %s and never on %s', async (status, blamed, spared) => {
    const { reconcile, fetch, store, onKeyVerdict, log } = build({ status });
    await expect(reconcile.run()).resolves.toEqual({
      skipped: true,
      reason: 'credential_rejected',
      status,
      fetched: 0,
      updated: 0,
      created: 0,
    });
    // One page, one warning: the list stops at the first rejection and nothing
    // is reconciled against a workspace that was never read.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/HTTP \d{3}/);
    // The warning names the ONE setting to look at, not both. Naming both is
    // what left the operator guessing.
    expect(log.warn.mock.calls[0][0]).toContain(blamed);
    expect(log.warn.mock.calls[0][0]).not.toContain(spared);
    // With Publer's own sentence, not just the number (#463 item 4).
    expect(onKeyVerdict).toHaveBeenCalledWith(blamed, {
      ok: false,
      status,
      detail: 'Publer said why',
    });
    expect(onKeyVerdict).not.toHaveBeenCalledWith(spared, expect.objectContaining({ ok: false }));
  });

  it('keeps a non-JSON error body instead of discarding it', async () => {
    // An HTML error page from a gateway in front of Publer is exactly the
    // failure where the body says more than the status, and `response.json()`
    // alone threw it away (Copilot review of 200a532f).
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => '<html>502 Bad Gateway</html>',
    }));
    const client = createPublerClient({ env, fetch });
    await expect(client.listPostsForSync()).rejects.toThrow(
      'HTTP 502 — <html>502 Bad Gateway</html>'
    );
  });

  it('carries the upstream sentence into the thrown message too', async () => {
    // `HTTP 401` alone is what #358 had to work from for two days. The body
    // separates a malformed header — our bug — from a revoked key.
    const { reconcile } = build({ status: 500 });
    await expect(reconcile.run()).rejects.toThrow('HTTP 500 — Publer said why');
  });

  it('still throws on a 500 — that IS transient, and a failed invocation is its record', async () => {
    const { reconcile, onKeyVerdict, log } = build({ status: 500 });
    await expect(reconcile.run()).rejects.toThrow(/Publer GET .* failed with HTTP 500/);
    expect(onKeyVerdict).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([404, 429])('does not turn the light red for a %i, which says nothing about the key', async (status) => {
    const { reconcile, onKeyVerdict } = build({ status });
    await expect(reconcile.run()).rejects.toThrow(`HTTP ${status}`);
    expect(onKeyVerdict).not.toHaveBeenCalled();
  });

  it('reports a working key once across two runs, under the SETTING name', async () => {
    // One request per run now that the three states travel together, so the
    // dedupe has less to absorb — but it is still what stops a report per
    // request, and a five-minute timer would otherwise write 288 a day.
    const { reconcile, fetch, onKeyVerdict } = build({ status: 200 });
    await expect(reconcile.run()).resolves.toMatchObject({ skipped: false, fetched: 0 });
    await expect(reconcile.run()).resolves.toMatchObject({ skipped: false, fetched: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    // BOTH lights, once each. A successful call proved the key and the
    // workspace id together, so clearing only one would strand whichever the
    // previous rejection had blamed — and after this change a rejection can
    // have blamed either.
    expect(onKeyVerdict).toHaveBeenCalledTimes(2);
    expect(onKeyVerdict).toHaveBeenCalledWith('PUBLER_API_KEY', { ok: true });
    expect(onKeyVerdict).toHaveBeenCalledWith('PUBLER_WORKSPACE_ID', { ok: true });
  });

  it('never fails the run because the verdict writer threw', async () => {
    const onKeyVerdict = vi.fn(async () => {
      throw new Error('Cosmos is having a day');
    });
    const working = build({ status: 200, onKeyVerdict });
    await expect(working.reconcile.run()).resolves.toMatchObject({ skipped: false });
    expect(working.log.warn.mock.calls[0][0]).toMatch(/\[publer\] could not record a key verdict/);

    // The rejection path too: a page that cannot record the verdict must not
    // turn a skipped run back into the thrown one this change removes.
    const rejected = build({ status: 401, onKeyVerdict });
    await expect(rejected.reconcile.run()).resolves.toMatchObject({
      skipped: true,
      reason: 'credential_rejected',
    });
  });

  it('works with no writer at all, which is how the change-feed and admin handlers build it', async () => {
    const client = createPublerClient({ env, fetch: answering(401) });
    await expect(createPublerReconcile({ store: memStore(), client, now }).run()).resolves.toMatchObject({
      skipped: true,
      reason: 'credential_rejected',
      status: 401,
    });
  });
});

describe('blog listings (Firecrawl)', () => {
  it('calls the v1 scrape endpoint with the schema and resolves relative URLs', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          extract: {
            articles: [
              { url: '/blog/a', title: 'A' },
              { url: 'https://x/b', title: 'B' },
            ],
          },
        },
      }),
    }));
    const articles = await scrapeListingPage(
      { apiKey: 'fc', fetch },
      'https://aws.amazon.com/blogs/'
    );
    expect(articles).toEqual([
      { url: 'https://aws.amazon.com/blog/a', title: 'A' },
      { url: 'https://x/b', title: 'B' },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.firecrawl.dev/v1/scrape');
    expect(init.headers.Authorization).toBe('Bearer fc');
    expect(JSON.parse(init.body)).toMatchObject({
      url: 'https://aws.amazon.com/blogs/',
      formats: ['extract'],
    });
    expect(resolveArticleUrl('https://[', 'https://h.test/blog/')).toBe('');
    expect(resolveArticleUrl('x/y', 'https://h.test/l/')).toBe('https://h.test/l/x/y');
    expect(resolveArticleUrl('../post', 'https://h.test/blog/category/')).toBe('https://h.test/blog/post');
    expect(resolveArticleUrl('//cdn.test/post', 'https://h.test/blog/')).toBe('https://cdn.test/post');
    const failing = vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: 'quota' }),
    }));
    await expect(scrapeListingPage({ apiKey: 'fc', fetch: failing }, 'https://s')).rejects.toThrow(
      'Firecrawl scrape failed for https://s: quota'
    );
  });

  it('writes the RSS content shape with source firecrawl, dedups, skips when unconfigured, isolates source failures', async () => {
    const doc = buildListingContentDoc({
      article: {
        url: 'https://x/a',
        title: 'T',
        description: 'd',
        publishedAt: '2026-08-01',
        author: 'Au',
        imageUrl: 'https://i',
      },
      source: {
        provider: 'aws',
        name: 'AWS Blogs Index',
        url: 'https://aws.amazon.com/blogs/',
      },
      dedupFields: { urlKey: 'k' },
      now: NOW,
      uuid: () => 'u1',
    });
    expect(doc).toMatchObject({
      id: 'u1',
      urlKey: 'k',
      Title: 'T',
      'Cloud Provider': 'Aws',
      Author: 'Au',
      'CD Url': 'https://x/a',
      'Published At': '2026-08-01T00:00:00.000Z',
      source: 'firecrawl',
      sourceFeed: 'https://aws.amazon.com/blogs/',
      contentStatus: 'ingested',
      inspectTrigger: true,
      contentImageUrl: 'https://i',
      readTime: '3 min',
    });

    const store = memStore();
    const dedup = {
      findDuplicateContent: vi.fn(async (_s, { url }) => ({
        duplicate: url.endsWith('/dup'),
      })),
      buildDedupFields: vi.fn(() => ({ urlKey: 'k' })),
    };
    const fetch = vi.fn(async (_u, init) => {
      const { url } = JSON.parse(init.body);
      if (url.includes('broken')) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            extract: {
              articles: [
                { url: 'https://x/new', title: 'N' },
                { url: 'https://x/dup', title: 'D' },
                { url: 'javascript:void', title: 'bad' },
              ],
            },
          },
        }),
      };
    });
    const sources = [
      { provider: 'aws', name: 'ok', url: 'https://ok/' },
      { provider: 'gcp', name: 'broken', url: 'https://broken/' },
    ];
    const r = await createBlogListingsScrape({
      store,
      dedup,
      fetch,
      env: { FIRECRAWL_API_KEY: 'fc' },
      sources,
      now,
      uuid: () => 'u2',
    }).run();
    expect(r).toEqual({
      skipped: false,
      scraped: 1,
      newArticles: 1,
      errors: 1,
      failures: [
        {
          source: 'broken',
          error: 'Firecrawl scrape failed for https://broken/: HTTP 500',
        },
      ],
    });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(dedup.findDuplicateContent.mock.calls[0][1]).toMatchObject({
      url: 'https://x/new',
      title: 'N',
      publishedMs: NOW.getTime(),
    });
    expect(
      await createBlogListingsScrape({
        store,
        dedup,
        fetch,
        env: {},
        sources,
        now,
      }).run()
    ).toMatchObject({ skipped: true, reason: 'not_configured' });
  });
});

describe('podcasts', () => {
  // Pinned so these cases test ingestion, not feed resolution (below).
  const feeds = [{ provider: 'azure', url: 'https://feeds.example.test/hcw.xml' }];
  it('builds episodes from enclosure or media:content, keeps createdAt across upserts, isolates item errors', async () => {
    expect(normalizePodcastId('https://podbean.com/e/Ep-1!', 't')).toBe('podbean-com-e-ep-1');
    const item = {
      guid: 'g1',
      title: 'Ep 1',
      contentSnippet: 's',
      'content:encoded': '<p>long</p>',
      enclosure: { url: 'https://m/1.mp3', type: 'audio/mpeg', length: '123' },
      itunes: { duration: '10:00', image: { href: 'https://img' } },
      link: 'https://l',
      isoDate: '2026-08-20T00:00:00.000Z',
    };
    const ep = buildPodcastEpisode('azure', item, NOW);
    expect(ep).toEqual({
      id: 'g1',
      provider: 'azure',
      title: 'Ep 1',
      description: 's',
      longDescription: '<p>long</p>',
      mediaUrl: 'https://m/1.mp3',
      mimeType: 'audio/mpeg',
      length: '123',
      duration: '10:00',
      image: 'https://img',
      link: 'https://l',
      guid: 'g1',
      publishedAt: '2026-08-20T00:00:00.000Z',
      updatedAt: NOW.toISOString(),
    });
    const mc = buildPodcastEpisode(
      'azure',
      {
        guid: 'g2',
        title: 'Ep 2',
        'media:content': {
          $: { url: 'https://m/2.mp3', type: 'audio/mpeg', fileSize: '9' },
        },
        pubDate: 'nope',
      },
      NOW
    );
    expect(mc).toMatchObject({
      mediaUrl: 'https://m/2.mp3',
      length: '9',
      publishedAt: null,
      image: null,
    });

    const store = memStore({
      podcasts: [{ id: 'g1', createdAt: '2026-01-01T00:00:00.000Z', title: 'old' }],
    });
    const parser = {
      parseURL: vi.fn(async () => ({
        items: [item, { guid: 'g2', title: 'Ep 2' }, null],
      })),
    };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await createPodcastIngest({
      store,
      parser,
      feeds,
      now,
      log,
    }).run();
    expect(r.azure.processed).toBe(2);
    expect(r.azure.errors).toEqual([{ position: 3, error: expect.any(String) }]);
    // The one bad episode must reach the workspace at Warning, because
    // host.json gates `Function` at Warning (#321) and the Information summary
    // below it does not.
    expect(log.warn).toHaveBeenCalledTimes(1);
    // Position in the feed, never the title: the trace stays content-free.
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^\[fetchPodcastFeeds\] azure: episode 3 of 3 failed:/
    );
    expect(log.warn.mock.calls[0][0]).not.toContain('Ep ');
    expect(log.error).not.toHaveBeenCalled();
    expect(store.data.podcasts.get('g1')).toMatchObject({
      title: 'Ep 1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(store.data.podcasts.get('g2').createdAt).toBe(NOW.toISOString());
    const broken = {
      parseURL: vi.fn(async () => {
        throw new Error('504');
      }),
    };
    const brokenLog = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(
      await createPodcastIngest({
        store,
        parser: broken,
        feeds,
        now,
        log: brokenLog,
      }).run()
    ).toEqual({
      azure: { processed: 0, error: '504' },
    });
    expect(brokenLog.error).toHaveBeenCalledTimes(1);
    // Provider, never the URL: the feed list names the feed from the provider.
    expect(brokenLog.error.mock.calls[0][0]).toBe('[fetchPodcastFeeds] azure: feed failed: 504');
  });

  it('fetchPodcastFeeds says so at Warning when the feed is reachable but empty', async () => {
    // The third silent state: no throw, no episode, no write. Without this
    // line an empty feed and a timer that never fired look identical to the
    // updatedAt witness.
    const store = memStore({ podcasts: [] });
    const parser = { parseURL: vi.fn(async () => ({ items: [] })) };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await createPodcastIngest({
      store,
      parser,
      feeds,
      now,
      log,
    }).run();
    expect(r).toEqual({ azure: { processed: 0, errors: [] } });
    expect(log.warn).toHaveBeenCalledWith('[fetchPodcastFeeds] azure: feed returned no items');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('treats HTTP 410 as the feed being gone: Warning, skipped, no Error (#348)', async () => {
    // PodBean's feed returned 410 from 2026-09-05 and the timer logged an
    // Error every two hours. Gone is configuration, not an outage.
    expect(isFeedGoneError(new Error('Status code 410'))).toBe(true);
    expect(isFeedGoneError(new Error('Status code 504'))).toBe(false);
    expect(isFeedGoneError(new Error('410 Gone but phrased differently'))).toBe(false);
    const store = memStore({ podcasts: [] });
    const parser = {
      parseURL: vi.fn(async () => {
        throw new Error('Status code 410');
      }),
    };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await createPodcastIngest({
      store,
      parser,
      feeds,
      now,
      log,
    }).run();
    expect(r).toEqual({ azure: { processed: 0, skipped: 'gone' } });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^\[fetchPodcastFeeds\] azure: feed gone \(410\) — remove it from admin_config\/podcast_feeds/
    );
    expect(log.warn.mock.calls[0][0]).not.toContain('https://');
  });

  it('reads the feed list from admin_config/podcast_feeds, dropping rows it cannot use', async () => {
    const store = memStore({
      admin_config: [
        {
          id: 'podcast_feeds',
          configScope: 'admin_config',
          feeds: [
            { provider: 'azure', url: 'https://media.rss.com/hcw/feed.xml' },
            { provider: 'azure', url: 'https://second.example/feed.xml' },
            { provider: 'aws', url: 'http://insecure.example/feed.xml' },
            { provider: 'Bad Slug', url: 'https://x.example/feed.xml' },
            { url: 'https://no-provider.example/feed.xml' },
            null,
          ],
        },
      ],
    });
    // The duplicate azure row is dropped: the summary is keyed by provider, so
    // two rows would fetch twice and report once.
    expect(await resolvePodcastFeeds(store)).toEqual({
      feeds: [{ provider: 'azure', url: 'https://media.rss.com/hcw/feed.xml' }],
      source: 'admin_config',
    });
    expect(
      dedupeFeedsByProvider([
        { provider: 'a', url: 'https://1' },
        { provider: 'b', url: 'https://2' },
        { provider: 'a', url: 'https://3' },
      ])
    ).toEqual([
      { provider: 'a', url: 'https://1' },
      { provider: 'b', url: 'https://2' },
    ]);
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', 'podcast_feeds', 'admin_config');
    // The run uses what the document says, not the constant.
    const parser = {
      parseURL: vi.fn(async () => ({ items: [{ guid: 'g1', title: 'Ep 1' }] })),
    };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await createPodcastIngest({ store, parser, now, log }).run();
    expect(parser.parseURL).toHaveBeenCalledWith('https://media.rss.com/hcw/feed.xml');
    expect(r).toEqual({ azure: { processed: 1, errors: [] } });
    expect(log.log.mock.calls[0][0]).toMatch(/^\[fetchPodcastFeeds\] \(admin_config\) /);
  });

  it("ingests the site's show under the reserved provider, ahead of the provider feeds", async () => {
    // The shape decision: the show is a separate FIELD in the document and an
    // ordinary ENTRY in the run, so nothing downstream of resolvePodcastFeeds
    // learns a second code path — and the episodes it writes carry
    // `provider: 'main'`, which is what puts them on every provider's page.
    const store = memStore({
      admin_config: [
        {
          id: 'podcast_feeds',
          configScope: 'admin_config',
          mainFeedUrl: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
          feeds: [{ provider: 'azure', url: 'https://example.com/azure.xml' }],
        },
      ],
    });
    expect(await resolvePodcastFeeds(store)).toEqual({
      feeds: [
        {
          provider: MAIN_FEED_PROVIDER,
          url: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
        },
        { provider: 'azure', url: 'https://example.com/azure.xml' },
      ],
      source: 'admin_config',
    });

    const parser = {
      parseURL: vi.fn(async () => ({ items: [{ guid: 'g1', title: 'Ep 1' }] })),
    };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await createPodcastIngest({ store, parser, now, log }).run();
    expect(r).toEqual({
      main: { processed: 1, errors: [] },
      azure: { processed: 1, errors: [] },
    });
    const written = store.upsertDoc.mock.calls.map(([, doc]) => doc.provider);
    expect(written).toEqual([MAIN_FEED_PROVIDER, 'azure']);
  });

  it('takes a document that names only the main feed as configured', async () => {
    // A hand-seeded document need not carry `feeds` at all. Falling through to
    // the empty default would ingest nothing while the document plainly names
    // a feed — silent, and indistinguishable from a timer that never fired.
    const store = memStore({
      admin_config: [
        {
          id: 'podcast_feeds',
          configScope: 'admin_config',
          mainFeedUrl: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
        },
      ],
    });
    expect(await resolvePodcastFeeds(store)).toEqual({
      feeds: [
        {
          provider: MAIN_FEED_PROVIDER,
          url: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
        },
      ],
      source: 'admin_config',
    });
  });

  it('will not let a hand-seeded main row displace the main feed field', async () => {
    // dedupeFeedsByProvider keeps the FIRST row for a provider and the field
    // is prepended, so the document's own `mainFeedUrl` wins. The admin page
    // refuses to write such a row, but this document was seedable by hand
    // before the page existed.
    const store = memStore({
      admin_config: [
        {
          id: 'podcast_feeds',
          configScope: 'admin_config',
          mainFeedUrl: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
          feeds: [{ provider: MAIN_FEED_PROVIDER, url: 'https://impostor.example/feed.xml' }],
        },
      ],
    });
    const { feeds } = await resolvePodcastFeeds(store);
    expect(feeds).toEqual([
      { provider: MAIN_FEED_PROVIDER, url: 'https://media.rss.com/hybrid-cloud-insights/feed.xml' },
    ]);
  });

  it('holds the main feed to the same https rule as every provider row', () => {
    expect(resolveMainFeedEntry({ mainFeedUrl: ' https://x.example/feed.xml ' })).toEqual({
      provider: MAIN_FEED_PROVIDER,
      url: 'https://x.example/feed.xml',
    });
    expect(resolveMainFeedEntry({ mainFeedUrl: 'http://insecure.example/feed.xml' })).toBeNull();
    expect(resolveMainFeedEntry({ mainFeedUrl: '' })).toBeNull();
    expect(resolveMainFeedEntry({ mainFeedUrl: 42 })).toBeNull();
    expect(resolveMainFeedEntry({})).toBeNull();
    expect(resolveMainFeedEntry(null)).toBeNull();
  });

  it('with no document and an empty default, says so at Warning and writes nothing', async () => {
    // The default is empty on purpose: the dead PodBean feed must not come
    // back as a fallback. Silence here would be indistinguishable from a
    // timer that never fired.
    expect(PODCAST_FEEDS).toEqual([]);
    const store = memStore({ podcasts: [] });
    const parser = { parseURL: vi.fn() };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await resolvePodcastFeeds(store)).toEqual({
      feeds: [],
      source: 'default',
    });
    const r = await createPodcastIngest({ store, parser, now, log }).run();
    expect(r).toEqual({});
    expect(parser.parseURL).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      '[fetchPodcastFeeds] no feeds configured (source: default) — seed admin_config/podcast_feeds as { mainFeedUrl, feeds: [{ provider, url }] }'
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});

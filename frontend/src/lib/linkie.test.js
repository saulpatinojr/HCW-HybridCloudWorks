/**
 * The Linkie contract, tested where it is read rather than inside the page.
 *
 * The fixtures below are the two shapes that actually meet here, and the whole
 * point is that they are two:
 *
 *   - Linkie's own body — `{ data: { pages: [...] } }` for pages (it was
 *     `profiles` until October 2026), a bare array or `{ data: [...] }` for
 *     posts. Site-Main, the system this repository was migrated from, read the
 *     old shape in production since before the migration.
 *   - this repository's proxy envelope around it — `{ ok, status, data }` at
 *     HTTP 200 for every outcome (functions/src/lib/integrations/rest-proxy.js).
 *
 * A reader ported from Site-Main without the second is one level short, and a
 * reader that ignores `ok` turns a Linkie 401 into an empty list. Both of those
 * have shipped here before (#397, on the Publer side).
 */
import { describe, it, expect } from 'vitest';

import { LINKIE_ALLOWED_PATHS } from '../../../functions/src/lib/integrations/linkie-allowlist.js';
import { isAllowedPath } from '../../../functions/src/lib/integrations/rest-proxy.js';
import {
  EMPTY_POST_FORM,
  LINKIE_IMAGE_CONTAINER,
  LINKIE_NOT_CONFIGURED,
  LINKIE_POST_IMAGE_FIELD,
  buildPostPayload,
  contentItemPostPayload,
  createPostsBody,
  describeLinkieFailure,
  extractPostImage,
  extractPosts,
  extractProfiles,
  extractTrafficStats,
  linkieImagePath,
  linkiePaths,
  toPublicImageUrl,
  profileLabel,
  readLinkieBody,
  selectProfile,
  trafficStatCards,
  unwrapLinkie,
  validatePostForm,
  visibleLinksState,
} from './linkie';

/** One profile, as Linkie nests them, wrapped in the proxy envelope. */
const profilesEnvelope = (profiles) => ({
  ok: true,
  status: 200,
  data: { data: { pages: profiles } },
});
/** Posts come back under `data` on the raw body, so twice down through the envelope. */
const postsEnvelope = (posts) => ({ ok: true, status: 200, data: { data: posts } });

describe('unwrapLinkie', () => {
  it('reads the proxy envelope, and keeps its four outcomes apart', () => {
    expect(unwrapLinkie({ ok: true, status: 200, data: { hello: 'world' } })).toEqual({
      body: { hello: 'world' },
      notConfigured: false,
      failed: false,
      status: 200,
      reason: '',
    });

    // An unseeded key. Not a fault — the Connections page renders this as
    // "not connected", so it must not be confused with a failure.
    expect(
      unwrapLinkie({
        ok: false,
        code: LINKIE_NOT_CONFIGURED,
        error: 'Linkie is not configured: LINKIE_API_KEY is not set',
      })
    ).toEqual({
      body: null,
      notConfigured: true,
      failed: false,
      status: null,
      reason: 'Linkie is not configured: LINKIE_API_KEY is not set',
    });

    // Linkie refused the key. This arrives as a RESOLVED promise at HTTP 200,
    // so nothing but `failed` stops a caller reading it as "no links".
    expect(unwrapLinkie({ ok: false, status: 401, data: { message: 'Unauthorized' } })).toEqual({
      body: null,
      notConfigured: false,
      failed: true,
      status: 401,
      reason: '',
    });

    // The proxy's own fetch threw; there is no upstream status to report.
    expect(unwrapLinkie({ ok: false, error: 'Linkie request failed: fetch failed' })).toEqual({
      body: null,
      notConfigured: false,
      failed: true,
      status: null,
      reason: 'Linkie request failed: fetch failed',
    });
  });
});

describe('readLinkieBody', () => {
  it('returns the body when Linkie answered', () => {
    expect(readLinkieBody({ ok: true, status: 200, data: { data: [] } })).toEqual({ data: [] });
  });

  it('throws on a refused key, so a write cannot report success', () => {
    // Create/edit/delete all resolve through the proxy whatever Linkie says.
    // Without this throw the page shows "Added to Linkie" and reloads a list
    // that never changed.
    expect(() => readLinkieBody({ ok: false, status: 401 })).toThrow('Linkie answered 401');
    expect(() => readLinkieBody({ ok: false, status: 403, error: 'Forbidden' })).toThrow(
      'Linkie answered 403 — Forbidden'
    );
    expect(() =>
      readLinkieBody({ ok: false, code: LINKIE_NOT_CONFIGURED, error: 'LINKIE_API_KEY is not set' })
    ).toThrow('LINKIE_API_KEY is not set');
    expect(() => readLinkieBody({ ok: false, error: 'fetch failed' })).toThrow('fetch failed');
  });
});

describe('describeLinkieFailure', () => {
  it('leads with the upstream status, because that is what names a bad key', () => {
    expect(describeLinkieFailure({ status: 401, reason: '' })).toBe('Linkie answered 401');
    expect(describeLinkieFailure({ status: null, reason: 'boom' })).toBe('boom');
    expect(describeLinkieFailure({})).toBe('the request failed');
  });
});

describe('extractProfiles', () => {
  it('reads through BOTH wrappers — the envelope and Linkie’s own', () => {
    const profiles = [{ _id: 'p1', username: 'hcw' }];
    // `response.data` is the envelope's; `.data.profiles` is Linkie's.
    expect(extractProfiles(profilesEnvelope(profiles))).toEqual(profiles);
  });

  it('reads an answer from the retired profiles endpoint as no pages, not as a list', () => {
    // Until October 2026 the list came back as `data.profiles`. Nothing here
    // calls that endpoint any more, so a body still shaped that way is an
    // answer from the wrong place and must not be taken for the key's pages.
    expect(
      extractProfiles({ ok: true, status: 200, data: { data: { profiles: [{ _id: 'p1' }] } } })
    ).toEqual([]);
  });

  it('tolerates a flatter body and an already-unwrapped caller', () => {
    const profiles = [{ _id: 'p1' }];
    expect(extractProfiles({ ok: true, status: 200, data: { pages: profiles } })).toEqual(profiles);
    expect(extractProfiles({ data: { pages: profiles } })).toEqual(profiles);
    expect(extractProfiles(profiles)).toEqual(profiles);
  });

  it('drops entries with no _id, since every posts path is built from it', () => {
    expect(extractProfiles(profilesEnvelope([{ _id: 'p1' }, { name: 'no id' }, null]))).toEqual([
      { _id: 'p1' },
    ]);
  });

  it('returns nothing for a failed call rather than an empty success', () => {
    expect(extractProfiles({ ok: false, status: 401 })).toEqual([]);
    expect(extractProfiles(profilesEnvelope([]))).toEqual([]);
  });
});

describe('selectProfile', () => {
  const profiles = [{ _id: 'p1' }, { _id: 'p2' }, { _id: 'p3' }];

  it('honours the operator’s choice when there is more than one profile', () => {
    expect(selectProfile(profiles, 'p2')).toEqual({ _id: 'p2' });
  });

  it('falls back to the first, and ignores a choice that is no longer there', () => {
    expect(selectProfile(profiles)).toEqual({ _id: 'p1' });
    expect(selectProfile(profiles, 'deleted')).toEqual({ _id: 'p1' });
  });

  it('returns null rather than a partial object when there is nothing to pick', () => {
    expect(selectProfile([])).toBeNull();
    expect(selectProfile(undefined)).toBeNull();
    expect(selectProfile([{ name: 'no id' }])).toBeNull();
  });
});

describe('profileLabel', () => {
  it('names a profile when it can, and falls back to the one proven field', () => {
    expect(profileLabel({ _id: 'p1', username: 'hcw' })).toBe('hcw');
    expect(profileLabel({ _id: 'p1', name: ' Hybrid ' })).toBe('Hybrid');
    expect(profileLabel({ _id: 'p1' })).toBe('p1');
    expect(profileLabel({ _id: 'p1', username: '   ' })).toBe('p1');
  });
});

describe('extractPosts', () => {
  it('reads the array Linkie nests under data, through the envelope', () => {
    const posts = [{ _id: 'x1', url: 'https://a.test', provider: 'wordpress' }];
    expect(extractPosts(postsEnvelope(posts))).toEqual(posts);
    expect(extractPosts({ ok: true, status: 200, data: posts })).toEqual(posts);
    expect(extractPosts(posts)).toEqual(posts);
  });

  it('is empty for a refused key, never a partially-read list', () => {
    expect(extractPosts({ ok: false, status: 401, data: { message: 'Unauthorized' } })).toEqual([]);
    expect(extractPosts({ ok: false, code: LINKIE_NOT_CONFIGURED })).toEqual([]);
  });
});

describe('buildPostPayload', () => {
  it('maps the form to Linkie’s snake_case fields', () => {
    expect(
      buildPostPayload({
        url: '  https://hybridcloudworks.com/a  ',
        provider: 'wordpress',
        accountName: 'HybridCloudWorks',
        postType: 'article',
        text: '  My latest article  ',
      })
    ).toEqual({
      url: 'https://hybridcloudworks.com/a',
      provider: 'wordpress',
      account_name: 'HybridCloudWorks',
      post_type: 'article',
      text: 'My latest article',
    });
  });

  it('omits an empty caption rather than sending one', () => {
    const payload = buildPostPayload({
      url: 'https://a.test',
      provider: 'wordpress',
      accountName: 'HybridCloudWorks',
      postType: 'link',
      text: '   ',
    });
    expect(payload).not.toHaveProperty('text');
  });

  it('sends the image as thumbnail_url, the key Linkie returns it under (#501)', () => {
    expect(LINKIE_POST_IMAGE_FIELD).toBe('thumbnail_url');
  });

  it('adds the image under LINKIE_POST_IMAGE_FIELD when one is set', () => {
    const payload = buildPostPayload({
      url: 'https://a.test',
      provider: 'wordpress',
      accountName: 'HybridCloudWorks',
      postType: 'article',
      imageUrl: '  https://cdn.test/cover.png  ',
    });
    expect(payload[LINKIE_POST_IMAGE_FIELD]).toBe('https://cdn.test/cover.png');
  });

  it('sends no image key at all when there is no image, blank or missing', () => {
    // A post without an image must be byte-identical to what was sent before
    // #501, and Linkie keeps deriving its own thumbnail for it.
    const base = {
      url: 'https://a.test',
      provider: 'wordpress',
      accountName: 'HybridCloudWorks',
      postType: 'article',
    };
    const expected = {
      url: 'https://a.test',
      provider: 'wordpress',
      account_name: 'HybridCloudWorks',
      post_type: 'article',
    };
    expect(buildPostPayload(base)).toEqual(expected);
    expect(buildPostPayload({ ...base, imageUrl: '   ' })).toEqual(expected);
    expect(JSON.stringify(buildPostPayload({ ...EMPTY_POST_FORM, url: 'https://a.test' }))).toBe(
      JSON.stringify({
        url: 'https://a.test',
        provider: 'wordpress',
        account_name: 'HybridCloudWorks',
        post_type: 'article',
      })
    );
  });
});

describe('extractPostImage', () => {
  it('reads thumbnail_url from a post shaped like a real Linkie response', () => {
    const post = {
      _id: '65b2d9e1c4a8f6b3d1c2e8a1',
      url: 'https://www.instagram.com/p/Cx1aB2cDeFg/',
      thumbnail_url: 'https://cdn.linkie.app/a/b/posts-65b2d9e1c4a8f6b3d1c2e8a1_1712345678.jpg',
      provider: 'instagram',
      account_name: 'janedoe',
      text: 'New ceramics drop this Friday.',
      post_type: 'photo',
      options: null,
    };
    expect(extractPostImage(post)).toBe(post.thumbnail_url);
  });

  it('ignores other image-ish keys: thumbnail_url is the one Linkie uses', () => {
    expect(extractPostImage({ thumbnail: 'https://cdn.test/x.png' })).toBe('');
    expect(extractPostImage({ image_url: 'https://cdn.test/x.png' })).toBe('');
  });

  it('rejects non-https values and non-objects', () => {
    expect(extractPostImage({ thumbnail_url: 'http://cdn.test/x.png' })).toBe('');
    expect(extractPostImage({ thumbnail_url: 'javascript:alert(1)' })).toBe('');
    expect(extractPostImage({ thumbnail_url: 'data:image/png;base64,AAAA' })).toBe('');
    expect(extractPostImage({ thumbnail_url: '/relative.png' })).toBe('');
    expect(extractPostImage({ thumbnail_url: { url: 'https://cdn.test/x.png' } })).toBe('');
    expect(extractPostImage({ thumbnail_url: null })).toBe('');
    expect(extractPostImage({})).toBe('');
    expect(extractPostImage(null)).toBe('');
  });
});

describe('toPublicImageUrl', () => {
  const identity = (url) => url;

  it('keeps an absolute https URL the resolver produced', () => {
    const resolve = (url) => `https://api-azure.hybridcloudworks.com${url}`;
    expect(toPublicImageUrl('/api/public/media/covers/a.png', { resolve })).toBe(
      'https://api-azure.hybridcloudworks.com/api/public/media/covers/a.png'
    );
  });

  it('prefixes the page origin when the path stays relative', () => {
    expect(
      toPublicImageUrl('/api/public/media/covers/a.png', {
        resolve: identity,
        origin: 'https://www.hybridcloudworks.com/',
      })
    ).toBe('https://www.hybridcloudworks.com/api/public/media/covers/a.png');
  });

  it('returns empty for anything Linkie could not fetch', () => {
    expect(toPublicImageUrl('', { resolve: identity, origin: 'https://a.test' })).toBe('');
    expect(toPublicImageUrl('/x.png', { resolve: identity, origin: 'http://localhost:3000' })).toBe(
      ''
    );
    expect(toPublicImageUrl('/x.png', { resolve: identity })).toBe('');
    expect(
      toPublicImageUrl('//evil.test/x.png', { resolve: identity, origin: 'https://a.test' })
    ).toBe('');
  });
});

describe('linkieImagePath', () => {
  it('stores under linkie/ with a timestamped, randomised name and the given extension', () => {
    expect(linkieImagePath('webp', { now: 1700000000000, random: 'abc123' })).toBe(
      'linkie/1700000000000-abc123.webp'
    );
    expect(LINKIE_IMAGE_CONTAINER).toBe('covers');
  });
});

describe('createPostsBody', () => {
  it('wraps the post in the array the endpoint takes', () => {
    // POST /pages/:id/posts is plural: the bare object is a 400 whose
    // message talks about a field rather than the shape.
    const post = buildPostPayload({ url: 'https://a.test', provider: 'wordpress' });
    expect(createPostsBody(post)).toEqual([post]);
  });
});

describe('contentItemPostPayload', () => {
  it('puts the article title in `text`, because a Linkie post has no title', () => {
    // This is the whole mapping the old form hid: it collected Title + URL and
    // posted them to an endpoint that does not exist. A post has url, provider,
    // account_name, post_type and text — and text is the caption.
    expect(
      contentItemPostPayload({
        title: 'Landing zones without the theatre',
        url: 'https://hybridcloudworks.com/blog/landing-zones',
      })
    ).toEqual({
      url: 'https://hybridcloudworks.com/blog/landing-zones',
      provider: 'wordpress',
      account_name: 'HybridCloudWorks',
      post_type: 'article',
      text: 'Landing zones without the theatre',
    });
  });

  it('sends the cover image under the image field when the item has one', () => {
    const payload = contentItemPostPayload({
      title: 'Landing zones',
      url: 'https://hybridcloudworks.com/blog/landing-zones',
      imageUrl: 'https://api-azure.hybridcloudworks.com/api/public/media/covers/a.png',
    });
    expect(payload[LINKIE_POST_IMAGE_FIELD]).toBe(
      'https://api-azure.hybridcloudworks.com/api/public/media/covers/a.png'
    );
  });

  it('still produces a valid post when the item has no title', () => {
    const payload = contentItemPostPayload({ url: 'https://a.test' });
    expect(payload).not.toHaveProperty('text');
    expect(payload.post_type).toBe('article');
  });
});

describe('validatePostForm', () => {
  it('requires the fields Linkie requires, and text only where it is the content', () => {
    expect(validatePostForm({ url: '', accountName: 'HCW', postType: 'article' })).toBe(
      'A URL is required'
    );
    expect(validatePostForm({ url: 'https://a.test', accountName: ' ', postType: 'article' })).toBe(
      'An account name is required'
    );
    expect(
      validatePostForm({ url: 'https://a.test', accountName: 'HCW', postType: 'text', text: '' })
    ).toBe('Text is required for this post type');
    expect(
      validatePostForm({ url: 'https://a.test', accountName: 'HCW', postType: 'article', text: '' })
    ).toBe('');
  });
});

describe('linkiePaths against the REAL proxy allowlist', () => {
  // Not a copy of the allowlist: the one `linkieProxy` is built with
  // (functions/src/lib/integrations/linkie-allowlist.js), through the matcher
  // it uses (rest-proxy.js isAllowedPath). Linkie renamed profiles to pages in
  // October 2026; a rename that moved this file and not the proxy, or the
  // proxy and not this file, fails here instead of as "not an allowed Linkie
  // endpoint" in the admin hub.
  const withoutQuery = (path) => path.split('?')[0];
  const calls = [
    ['GET', linkiePaths.pages()],
    ['GET', linkiePaths.posts('p1')],
    ['POST', linkiePaths.posts('p1')],
    ['PATCH', linkiePaths.post('p1', 'x9')],
    ['DELETE', linkiePaths.post('p1', 'x9')],
    ['GET', linkiePaths.trafficStats('p1')],
  ];

  it.each(calls)('lets %s %s through', (method, path) => {
    expect(isAllowedPath(LINKIE_ALLOWED_PATHS, withoutQuery(path), method)).toBe(true);
  });

  it.each([
    '/profiles',
    '/profiles/p1/posts',
    '/profiles/p1/posts/x9',
    '/links',
    '/analytics',
    '/pages/p1',
    '/pages/p1/posts/x9/extra',
  ])('does not let %s through', (path) => {
    expect(isAllowedPath(LINKIE_ALLOWED_PATHS, path, 'GET')).toBe(false);
  });

  it('sends the analytics page under Linkie’s current name, page_id', () => {
    expect(linkiePaths.trafficStats('p1')).toContain('page_id=p1');
    expect(linkiePaths.trafficStats('p1')).not.toContain('link_in_bio_id');
  });
});

describe('linkiePaths', () => {
  it('builds the page-scoped shapes the proxy allowlist matches', () => {
    // The allowlist patterns are /^\/pages\/[^/]+\/posts$/ and
    // /^\/pages\/[^/]+\/posts\/[^/]+$/ — see
    // functions/src/lib/integrations/linkie-allowlist.js. There is no /links.
    expect(linkiePaths.pages()).toBe('/pages');
    expect(linkiePaths.posts('p1')).toBe('/pages/p1/posts');
    expect(linkiePaths.post('p1', 'x9')).toBe('/pages/p1/posts/x9');
    expect(linkiePaths.trafficStats('p1')).toBe('/analytics/traffic-stats?page_id=p1');
  });

  it('encodes ids so a stray separator cannot widen the match', () => {
    // `[^/]+` is one segment. An unencoded slash would make
    // /pages/a/b/posts, which the allowlist rejects — loudly, but for the
    // wrong reason, and only after the id has already been mangled.
    expect(linkiePaths.posts('a/b')).toBe('/pages/a%2Fb/posts');
    expect(linkiePaths.post('p1', 'x/9')).toBe('/pages/p1/posts/x%2F9');
    expect(linkiePaths.trafficStats('a b&c')).toBe('/analytics/traffic-stats?page_id=a%20b%26c');
  });
});

describe('extractTrafficStats and trafficStatCards', () => {
  it('reads the summary through both wrappers', () => {
    const summary = { total_visitors: 120, unique_visitors: 90, bounce_rate: 41 };
    expect(extractTrafficStats({ ok: true, status: 200, data: { data: summary } })).toEqual(
      summary
    );
    expect(extractTrafficStats({ ok: true, status: 200, data: summary })).toEqual(summary);
    expect(extractTrafficStats({ ok: false, status: 401 })).toEqual({});
  });

  it('shows a genuine zero and drops a metric Linkie did not return', () => {
    // Absent and zero are different facts: `unique_clicks: 0` is a measurement,
    // a missing `total_subscribers` is not.
    expect(trafficStatCards({ total_visitors: 120, unique_clicks: 0, bounce_rate: 0 })).toEqual([
      { label: 'Total Visitors', value: 120 },
      { label: 'Unique Clicks', value: 0 },
      { label: 'Bounce Rate', value: '0%' },
    ]);
    expect(trafficStatCards({})).toEqual([]);
    expect(trafficStatCards(null)).toEqual([]);
  });
});

describe('visibleLinksState', () => {
  const withPosts = { posts: [{ _id: 'x', url: 'https://a' }], error: 'boom' };

  it('shows nothing when there is no profile, even though a result is held', () => {
    // The regression: `loading` is false when profileId is null, so a naive
    // `loading ? [] : result.posts` leaks the previous profile's list into a
    // state where every write is gated. Caught in review on #429.
    expect(visibleLinksState({ profileId: null, loading: false, result: withPosts })).toEqual({
      posts: [],
      error: '',
    });
  });

  it('shows nothing while a fetch is in flight', () => {
    expect(visibleLinksState({ profileId: 'p1', loading: true, result: withPosts })).toEqual({
      posts: [],
      error: '',
    });
  });

  it('shows the result once a profile is selected and the fetch has settled', () => {
    expect(visibleLinksState({ profileId: 'p1', loading: false, result: withPosts })).toEqual({
      posts: withPosts.posts,
      error: 'boom',
    });
  });

  it('does not throw on a result it has never been given', () => {
    expect(visibleLinksState({ profileId: 'p1', loading: false, result: undefined })).toEqual({
      posts: [],
      error: '',
    });
  });
});

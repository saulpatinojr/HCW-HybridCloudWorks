import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BLOG_SOURCES, loadBlogSources, groupRssSources, validateSource, blogImageDefaults, publicImageUrl } from './source-config.js';
import { buildRssContentDoc, cacheDocId } from './feeds.js';
import { createBlogSourceHandlers } from './source-handlers.js';

const kiro = DEFAULT_BLOG_SOURCES.find(source => source.name === 'Kiro Blog');
const parsed = response => JSON.parse(response.body);
const context = { error: vi.fn(), warn: vi.fn() };
function setup({ existing = null, denied = false } = {}) {
  const store = { queryDocs: vi.fn(async () => []), readDoc: vi.fn(async () => existing),
    createDoc: vi.fn(async (_, doc) => ({ ...doc, _etag: 'new' })),
    replaceDocIfMatch: vi.fn(async (_, doc) => ({ ...doc, _etag: 'next' })), upsertDoc: vi.fn() };
  const guard = { requireRole: vi.fn(async () => denied ? { error: { status: 403 } } : { user: { oid: 'editor' } }) };
  const validateUrl = vi.fn();
  return { store, guard, validateUrl, handlers: createBlogSourceHandlers({ store, guard, validateUrl, uuid: () => '123' }) };
}
const request = (body = kiro, id) => ({ json: async () => body, params: id ? { id } : {} });

describe('runtime blog source catalogue', () => {
  it('seeds Kiro’s advertised RSS feed under AWS and retains stable cache identities when renamed', async () => {
    expect(kiro).toMatchObject({ provider: 'aws', url: 'https://kiro.dev/blog/feed.rss', official: true });
    const sources = await loadBlogSources({ queryDocs: async () => [{ ...kiro, name: 'Renamed', enabled: false, _etag: 'v1' }] });
    const saved = sources.find(source => source.id === kiro.id);
    expect(saved.name).toBe('Renamed');
    expect(cacheDocId('aws', saved)).toBe(kiro.cacheId);
    expect(groupRssSources(sources).aws.some(source => source.id === kiro.id)).toBe(false);
  });
  it('does not grant official trust to custom sources or overrides on a new host', async () => {
    const sources = await loadBlogSources({ queryDocs: async () => [
      { ...kiro, url: 'https://other.example/feed', official: true },
      { ...kiro, id: 'blog-source-custom-1', official: true },
    ] });
    expect(sources.find(source => source.id === kiro.id).official).toBe(false);
    expect(sources.find(source => source.id === 'blog-source-custom-1').official).toBe(false);
    const doc = buildRssContentDoc({ item: {}, sourceUrl: 'https://other.example/a', title: 'A', provider: 'aws', feed: sources.find(source => source.id === kiro.id), now: new Date(), uuid: () => '1' });
    expect(doc.trustedSource).toBe(false);
  });
  it.each([
    { name: '' }, { provider: 'unknown' }, { kind: 'json' }, { enabled: 'true' },
    { maxItems: 0 }, { maxItems: 21 }, { maxItems: 1.5 }, { url: 'http://example.com' },
    { url: 'https://user:pass@example.com' }, { url: 'https://example.com/#token' },
    { url: 'https://example.com:444/feed' }, { fallbackImageUrl: 'javascript:alert(1)' },
  ])('rejects invalid settings %j', change => expect(() => validateSource({ ...kiro, ...change })).toThrow());
  it('allows public gallery image paths and rejects traversal/private media paths', () => {
    expect(publicImageUrl('/api/public/media/covers/hero.png')).toContain('hero.png');
    expect(() => publicImageUrl('/api/public/media/content/private.png')).toThrow();
    expect(() => publicImageUrl('/api/public/media/covers/../secret')).toThrow();
  });
  it('resolves gallery defaults on the configured public API origin for the publish image gate', () => {
    const result = blogImageDefaults({ blogFallbackImageUrl: '/api/public/media/covers/default.png' }, [], { PUBLIC_API_ORIGIN: 'https://api.example.com' });
    expect(result.contentImageUrl).toBe('https://api.example.com/api/public/media/covers/default.png');
    expect(blogImageDefaults({ coverImage: [], blogFallbackImageUrl: 'https://example.com/default.png' }).blogImageOrigin).toBe('source-default');
  });
  it('prefers existing covers and article images over the source fallback', () => {
    const doc = { blogFallbackImageUrl: 'https://example.com/default.png' };
    expect(blogImageDefaults(doc)).toMatchObject({ coverImage: doc.blogFallbackImageUrl, blogImageOrigin: 'source-default' });
    expect(blogImageDefaults(doc, [{ original: 'https://example.com/article.png' }])).toMatchObject({ contentImageUrl: 'https://example.com/article.png', blogImageOrigin: 'article' });
    for (const key of ['contentImageUrl', 'coverImage', 'Cover Image', 'altCoverImage']) expect(blogImageDefaults({ ...doc, [key]: 'existing' })).toEqual({});
    expect(blogImageDefaults({ ...doc, aiImageUrls: { hero: 'generated' } })).toEqual({});
    expect(blogImageDefaults({})).toEqual({});
  });
});

describe('source administration', () => {
  it('checks editor permission before reading or writing', async () => {
    const { handlers, store, guard } = setup({ denied: true });
    expect((await handlers.list({}, context)).status).toBe(403);
    expect((await handlers.save(request(), context)).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'editor');
  });
  it('lists catalogue settings and latest intake state', async () => {
    const { handlers, store } = setup();
    store.queryDocs.mockResolvedValueOnce([]).mockResolvedValueOnce([{ sourceId: kiro.id, status: 'failed' }]);
    const result = await handlers.list({}, context);
    expect(parsed(result).sources.find(source => source.id === kiro.id).lastRun.status).toBe('failed');
  });
  it('creates a custom source, validates both URLs, and audits the save', async () => {
    const { handlers, validateUrl, store } = setup();
    const result = await handlers.save(request({ ...kiro, fallbackImageUrl: 'https://example.com/hero.png', official: true }), context);
    expect(result.status).toBe(200);
    expect(parsed(result).source.official).toBe(false);
    expect(validateUrl).toHaveBeenCalledTimes(2);
    expect(store.createDoc.mock.calls[0][1]).not.toHaveProperty('official');
    expect(store.upsertDoc).toHaveBeenCalledWith('admin_audit_logs', expect.objectContaining({ action: 'blog_source_updated' }));
  });
  it('saves an official override without changing its identity', async () => {
    const { handlers } = setup();
    expect((await handlers.save(request({ ...kiro, name: 'Kiro Updates' }, kiro.id), context)).status).toBe(200);
  });
  it('uses the read etag and rejects stale sessions and racing writes', async () => {
    const { handlers, store } = setup({ existing: { ...kiro, _etag: 'v1' } });
    expect((await handlers.save(request({ ...kiro, _etag: 'stale' }, kiro.id), context)).status).toBe(409);
    const good = request({ ...kiro, _etag: 'v1' }, kiro.id);
    expect((await handlers.save(good, context)).status).toBe(200);
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith('admin_settings', expect.objectContaining({ _etag: 'v1' }));
    store.replaceDocIfMatch.mockRejectedValueOnce({ code: 412 });
    expect((await handlers.save(good, context)).status).toBe(409);
  });
  it('rejects unknown identities and changes to official provider/type', async () => {
    const { handlers } = setup();
    expect((await handlers.save(request(kiro, 'bad'), context)).status).toBe(400);
    expect((await handlers.save(request(kiro, 'blog-source-unknown'), context)).status).toBe(404);
    expect((await handlers.save(request({ ...kiro, kind: 'listing' }, kiro.id), context)).status).toBe(400);
  });
  it('rejects private URLs without writing and handles read/write outages', async () => {
    const { handlers, validateUrl, store } = setup();
    validateUrl.mockRejectedValueOnce({ refused: true });
    expect((await handlers.save(request(), context)).status).toBe(400);
    expect(store.createDoc).not.toHaveBeenCalled();
    store.createDoc.mockRejectedValueOnce(new Error('offline'));
    expect((await handlers.save(request(), context)).status).toBe(500);
    store.queryDocs.mockRejectedValueOnce(new Error('offline'));
    expect((await handlers.list({}, context)).status).toBe(500);
  });
});

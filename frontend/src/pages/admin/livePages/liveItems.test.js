/**
 * What Live Pages lists (PR #841): live records with a URL, one row per
 * URL, minus the ones deleted since load, matching the search, newest first.
 */
import { describe, it, expect } from 'vitest';
import { editorTargetId, getTypeLabel, liveUrlKey, selectLiveItems } from './liveItems';

const live = (id, url, extra = {}) => ({ id, Live: true, publishedUrl: url, ...extra });

describe('selectLiveItems', () => {
  const contentItems = [
    live('c1', 'https://hybridcloudworks.com/azure/blog/one', {
      title: 'One',
      publishedAt: '2026-01-01T00:00:00Z',
    }),
    live('c2', 'https://hybridcloudworks.com/aws/blog/two', {
      title: 'Two',
      publishedAt: '2026-03-01T00:00:00Z',
    }),
    { id: 'draft', title: 'Draft', publishedUrl: 'https://hybridcloudworks.com/x' },
    live('nourl', ''),
  ];
  const blogItems = [
    live('b1', 'https://hybridcloudworks.com/azure/blog/one', { title: 'One (legacy)' }),
    live('b2', 'https://hybridcloudworks.com/gcp/blog/three', { title: 'Three' }),
  ];

  it('keeps only live records with a URL, newest first, tagged with their source', () => {
    const out = selectLiveItems({
      contentItems,
      blogItems,
      includeLegacyPages: false,
      locallyDeletedKeys: {},
      query: '',
    });
    expect(out.map((i) => i.id)).toEqual(['c2', 'c1']);
    expect(out.every((i) => i.__source === 'content')).toBe(true);
  });

  it('merges legacy blogs when asked and dedupes by URL, content first', () => {
    const out = selectLiveItems({
      contentItems,
      blogItems,
      includeLegacyPages: true,
      locallyDeletedKeys: {},
      query: '',
    });
    expect(out.map((i) => i.id)).toEqual(['c2', 'c1', 'b2']);
    expect(out.find((i) => i.id === 'b2').__source).toBe('blogs');
  });

  it('drops a URL deleted since load, and filters by title, provider, type or URL', () => {
    const deleted = selectLiveItems({
      contentItems,
      blogItems: [],
      includeLegacyPages: false,
      locallyDeletedKeys: { 'https://hybridcloudworks.com/aws/blog/two': true },
      query: '',
    });
    expect(deleted.map((i) => i.id)).toEqual(['c1']);

    const searched = selectLiveItems({
      contentItems,
      blogItems,
      includeLegacyPages: true,
      locallyDeletedKeys: {},
      query: '  GCP/BLOG ',
    });
    expect(searched.map((i) => i.id)).toEqual(['b2']);
  });
});

describe('record helpers', () => {
  it('normalises the live URL as a dedupe key', () => {
    expect(liveUrlKey(live('x', '  https://Example.com/A '))).toBe('https://example.com/a');
    expect(liveUrlKey({ id: 'none' })).toBe('');
  });

  it('labels the canonical type, Blog by default', () => {
    expect(getTypeLabel({ contentType: 'framework' })).toBe('Framework');
    expect(getTypeLabel({ publishTarget: 'coder_corner' })).toBe('Coder Corner');
    expect(getTypeLabel({ publishTarget: 'rss' })).toBe('News');
    expect(getTypeLabel({})).toBe('Blog');
  });

  it('opens the editor on the source record when the live one points at it', () => {
    expect(editorTargetId({ id: 'live', sourceContentId: 'src' })).toBe('src');
    expect(editorTargetId({ id: 'live', publishedContentId: 'pub' })).toBe('pub');
    expect(editorTargetId({ id: 'live' })).toBe('live');
  });
});

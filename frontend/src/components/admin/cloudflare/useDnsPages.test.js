/**
 * The DNS tab's paging, its pure half (#1907): how the pages read so far
 * add up, and the sentence that says how much of the zone is on screen.
 */
import { describe, expect, it } from 'vitest';
import { dnsCountText, dnsListView } from './useDnsPages';

const rec = (id) => ({ id, type: 'A', name: `${id}.example.com` });

describe('dnsListView', () => {
  it('joins the pages in order, shows a record that moved between reads once, and names the next page', () => {
    const view = dnsListView([
      { records: [rec('a'), rec('b')], page: 1, totalCount: 4, hasMore: true },
      { records: [rec('b'), rec('c')], page: 2, totalCount: 4, hasMore: true },
    ]);
    expect(view.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(view).toMatchObject({ hasMore: true, nextPage: 3, totalCount: 4 });
  });

  it('reads an answer with no paging fields (a server from before #1907) as one whole page', () => {
    expect(dnsListView([{ records: [rec('a')] }])).toMatchObject({
      hasMore: false,
      nextPage: 2,
      totalCount: null,
    });
    expect(dnsListView([{ records: [] }]).records).toEqual([]);
  });
});

describe('dnsCountText', () => {
  it('says how many of the total are shown, or the total once all are', () => {
    const two = [rec('a'), rec('b')];
    expect(dnsCountText({ records: two, hasMore: true, totalCount: 250 })).toBe(
      "Showing 2 of the zone's 250 records, 100 at a time."
    );
    expect(dnsCountText({ records: two, hasMore: false, totalCount: 2 })).toBe(
      'The zone has 2 records.'
    );
    expect(dnsCountText({ records: [rec('a')], hasMore: false, totalCount: 1 })).toBe(
      'The zone has 1 record.'
    );
  });

  it('says what it can when Cloudflare sent no total', () => {
    expect(dnsCountText({ records: [rec('a')], hasMore: true, totalCount: null })).toBe(
      'Showing 1 record; more follow.'
    );
    expect(dnsCountText({ records: [rec('a')], hasMore: false, totalCount: null })).toBe(
      'Showing 1 record.'
    );
  });
});

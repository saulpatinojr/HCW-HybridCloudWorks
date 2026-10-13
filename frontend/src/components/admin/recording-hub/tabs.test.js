/**
 * The tab resolver, which is the only thing standing between a `?tab=` value
 * and the page picking a panel out of an object.
 *
 * This page had no `?tab=` at all before #576 — it held the selected tab in
 * `useState`, so no link could name a tab and Back could not leave one. The
 * redirects below are therefore for links people wrote by hand, and for the
 * two provider ids that are the only ones this page has ever had.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, MOVED_TABS, TABS, resolveTab, tabHref } from './tabs';

describe('resolveTab', () => {
  it('keeps a tab that exists', () => {
    for (const { id } of TABS) expect(resolveTab(id)).toBe(id);
  });

  it('sends the two provider ids to where their content went', () => {
    expect(resolveTab('podcast')).toBe('transcripts');
    expect(resolveTab('plaud')).toBe('recordings');
  });

  it('sends a Plaud sub-tab id to the duty that absorbed it', () => {
    // Library and Upload merged into Recordings; Connect became Settings.
    expect(resolveTab('library')).toBe('recordings');
    expect(resolveTab('upload')).toBe('recordings');
    expect(resolveTab('connect')).toBe('settings');
  });

  it('sends the host and feed words to Distribution', () => {
    expect(resolveTab('host')).toBe('distribution');
    expect(resolveTab('rss')).toBe('distribution');
    expect(resolveTab('feed')).toBe('distribution');
  });

  it('sends the statistics words to Stats (#1115)', () => {
    expect(resolveTab('stats')).toBe('stats');
    expect(resolveTab('statistics')).toBe('stats');
    expect(resolveTab('downloads')).toBe('stats');
    expect(resolveTab('analytics')).toBe('stats');
  });

  it('falls back to Transcripts for an unknown id, for nothing, and for undefined', () => {
    expect(resolveTab('nope')).toBe(DEFAULT_TAB);
    expect(resolveTab('')).toBe(DEFAULT_TAB);
    expect(resolveTab(undefined)).toBe(DEFAULT_TAB);
    expect(resolveTab(null)).toBe(DEFAULT_TAB);
  });

  it('does not read Object.prototype for a `?tab=` that names one of its keys', () => {
    expect(resolveTab('constructor')).toBe(DEFAULT_TAB);
    expect(resolveTab('toString')).toBe(DEFAULT_TAB);
    expect(resolveTab('__proto__')).toBe(DEFAULT_TAB);
  });

  it('every MOVED_TABS target is a real tab, so no redirect dead-ends', () => {
    const ids = new Set(TABS.map((tab) => tab.id));
    for (const target of Object.values(MOVED_TABS)) expect(ids.has(target)).toBe(true);
  });

  it('no MOVED_TABS key shadows a real tab id', () => {
    for (const { id } of TABS) expect(Object.hasOwn(MOVED_TABS, id)).toBe(false);
  });
});

describe('tabHref', () => {
  it('builds a deep link on the hub route', () => {
    expect(tabHref('episodes')).toBe('/admin/recording-hub?tab=episodes');
  });

  it('encodes a value rather than pasting it into the query string', () => {
    expect(tabHref('a b&c')).toBe('/admin/recording-hub?tab=a%20b%26c');
  });
});

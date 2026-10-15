/**
 * The tab resolver, which is the only thing standing between a `?tab=` value
 * and the page picking a panel out of an object.
 *
 * Before #575 the page read `searchParams.get('tab') || 'compose'` and passed
 * the result straight to a chain of `activeTab === '...'` tests, so an unknown
 * id rendered a header with no panel under it at all.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, MOVED_TABS, TABS, resolveTab, tabHref } from './tabs';

describe('resolveTab', () => {
  it('keeps a tab that exists', () => {
    for (const { id } of TABS) expect(resolveTab(id)).toBe(id);
  });

  it('sends an old address to where its content went', () => {
    expect(resolveTab('connection')).toBe('settings');
    expect(resolveTab('connection-settings')).toBe('settings');
    expect(resolveTab('profiles')).toBe('accounts');
    expect(resolveTab('calendar')).toBe('published');
    expect(resolveTab('scheduled')).toBe('queue');
  });

  it('falls back to Compose for an unknown id, for nothing, and for undefined', () => {
    expect(resolveTab('nope')).toBe(DEFAULT_TAB);
    expect(resolveTab('')).toBe(DEFAULT_TAB);
    expect(resolveTab(undefined)).toBe(DEFAULT_TAB);
    expect(resolveTab(null)).toBe(DEFAULT_TAB);
  });

  it('does not read Object.prototype for a `?tab=` that names one of its keys', () => {
    // MOVED_TABS is a plain object, so `?tab=constructor` would otherwise
    // resolve through the prototype and hand a function to the panel lookup.
    expect(resolveTab('constructor')).toBe(DEFAULT_TAB);
    expect(resolveTab('toString')).toBe(DEFAULT_TAB);
    expect(resolveTab('__proto__')).toBe(DEFAULT_TAB);
  });

  it('every MOVED_TABS target is a real tab, so no redirect dead-ends', () => {
    const ids = new Set(TABS.map((tab) => tab.id));
    for (const target of Object.values(MOVED_TABS)) expect(ids.has(target)).toBe(true);
  });

  it('no MOVED_TABS key shadows a real tab id', () => {
    // A key that is also a tab id would redirect the tab away from itself.
    for (const { id } of TABS) expect(Object.hasOwn(MOVED_TABS, id)).toBe(false);
  });

  it('keeps the four ids the page shipped with reachable', () => {
    // Every link written before #575 used one of these; `settings` in
    // particular must still be Settings even though its accounts card left.
    for (const id of ['compose', 'queue', 'published', 'settings']) {
      expect(resolveTab(id)).toBe(id);
    }
  });
});

describe('tabHref', () => {
  it('builds a deep link on the hub route', () => {
    expect(tabHref('queue')).toBe('/admin/social-hub?tab=queue');
  });

  it('encodes a value rather than pasting it into the query string', () => {
    expect(tabHref('a b&c')).toBe('/admin/social-hub?tab=a%20b%26c');
  });
});

/**
 * Where a `?tab=` value lands on the Speaking Events Hub (#573).
 */
import { describe, it, expect } from 'vitest';

import { DEFAULT_TAB, MOVED_TABS, TABS, resolveTab, tabHref } from './tabs';

describe('resolveTab', () => {
  it('keeps every real tab', () => {
    for (const { id } of TABS) expect(resolveTab(id)).toBe(id);
  });

  it.each([
    ['sessionize', 'sources'],
    ['sync', 'sources'],
    ['manual', 'sources'],
    ['delivered', 'past'],
    ['snapshot', 'publishing'],
    ['speaker', 'settings'],
    ['events', 'upcoming'],
  ])('sends the moved id %s to %s', (from, to) => {
    expect(resolveTab(from)).toBe(to);
  });

  it('falls back to Upcoming for an unknown, empty or missing id', () => {
    expect(resolveTab('nonsense')).toBe(DEFAULT_TAB);
    expect(resolveTab('')).toBe(DEFAULT_TAB);
    expect(resolveTab(null)).toBe(DEFAULT_TAB);
    expect(resolveTab(undefined)).toBe(DEFAULT_TAB);
    expect(DEFAULT_TAB).toBe('upcoming');
  });

  it('does not read Object.prototype for ids like constructor', () => {
    expect(resolveTab('constructor')).toBe(DEFAULT_TAB);
    expect(resolveTab('__proto__')).toBe(DEFAULT_TAB);
    expect(resolveTab('hasOwnProperty')).toBe(DEFAULT_TAB);
  });

  it('never moves an id to a tab that does not exist, and keeps Settings last', () => {
    const ids = new Set(TABS.map((tab) => tab.id));
    for (const target of Object.values(MOVED_TABS)) expect(ids.has(target)).toBe(true);
    for (const moved of Object.keys(MOVED_TABS)) expect(ids.has(moved)).toBe(false);
    expect(TABS.at(-1).id).toBe('settings');
  });

  it('builds a link to a tab', () => {
    expect(tabHref('sources')).toBe('/admin/speaking?tab=sources');
  });
});

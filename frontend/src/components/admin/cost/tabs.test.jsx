/**
 * The Cost page's tab resolver, held to the shared hub contract, plus the
 * redirects the API contract names.
 */
import { describe, expect, it } from 'vitest';
import { describeTabResolver } from '@/components/admin/tabContract';
import * as tabs from './tabs';

describeTabResolver(tabs, {
  route: '/admin/cost',
  redirects: {
    budgets: 'azure',
    spend: 'overview',
    subscriptions: 'services',
    credits: 'ai',
    signals: 'alerts',
    settings: 'alerts',
  },
});

describe('the Cost tabs', () => {
  it('are the five the contract names, Overview first and Alerts last', () => {
    expect(tabs.TABS.map((tab) => [tab.id, tab.label])).toEqual([
      ['overview', 'Overview'],
      ['azure', 'Azure'],
      ['ai', 'AI'],
      ['services', 'Services'],
      ['alerts', 'Alerts'],
    ]);
    expect(tabs.DEFAULT_TAB).toBe('overview');
    expect(tabs.COST_PATH).toBe('/admin/cost');
  });
});

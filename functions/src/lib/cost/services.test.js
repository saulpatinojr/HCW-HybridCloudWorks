import { describe, expect, it } from 'vitest';

import {
  CATEGORY_IDS,
  MAX_NOTE_LENGTH,
  SUGGESTED_VENDORS,
  compareItems,
  isStoredItem,
  newItem,
  normalizeFields,
  patchFields,
  presentItem,
  suggestionsFor,
  summarizeServices,
} from './services.js';

const TODAY = '2026-11-01';

describe('normalizeFields', () => {
  it('fills every field with its default from a name alone', () => {
    expect(normalizeFields({ name: ' Cloudflare Pro ' })).toEqual({
      name: 'Cloudflare Pro',
      vendor: '',
      category: 'other',
      plan: '',
      amount: null,
      currency: 'USD',
      cycle: 'monthly',
      nextRenewal: null,
      autoRenew: true,
      status: 'active',
      paymentMethod: '',
      link: '',
      note: '',
    });
  });

  it('keeps what the current row has when the body leaves a field out', () => {
    const current = { name: 'Old', vendor: 'V', amount: 5, cycle: 'annual', status: 'trial' };
    expect(normalizeFields({ amount: '12.50' }, current)).toMatchObject({
      name: 'Old',
      vendor: 'V',
      amount: 12.5,
      cycle: 'annual',
      status: 'trial',
    });
  });

  it.each([
    [{}, 'name is required'],
    [{ name: '' }, 'name is required'],
    [{ name: 'a\nb' }, 'single line'],
    [{ name: 'x'.repeat(121) }, 'longer than 120'],
    [{ name: 'ok', bogus: 1 }, 'Unknown field(s)'],
    [{ name: 'ok', amount: -1 }, 'amount must be'],
    [{ name: 'ok', amount: 'lots' }, 'amount must be'],
    [{ name: 'ok', amount: 1e9 }, 'or less'],
    [{ name: 'ok', currency: 'dollars' }, 'three-letter'],
    [{ name: 'ok', category: 'fun' }, 'category must be one of'],
    [{ name: 'ok', cycle: 'weekly' }, 'cycle must be one of'],
    [{ name: 'ok', status: 'paused' }, 'status must be one of'],
    [{ name: 'ok', nextRenewal: '2026-02-30' }, 'real date'],
    [{ name: 'ok', nextRenewal: '1999-01-01' }, 'between 2000 and 2100'],
    [{ name: 'ok', autoRenew: 'yes' }, 'true or false'],
    [{ name: 'ok', paymentMethod: '4111 1111 1111 1111' }, 'card number'],
    [{ name: 'ok', link: 'http://insecure.example' }, 'https web address'],
    [{ name: 'ok', link: 'https://user:pw@example.com/' }, 'https web address'],
    [{ name: 'ok', link: '/admin/../etc' }, 'https web address'],
    [{ name: 'ok', link: '/admin/ai-engine/oauth/callback' }, 'https web address'],
    [{ name: 'ok', link: 'https://exa mple.com' }, 'https web address'],
    [{ name: 'ok', link: `https://${'x'.repeat(2050)}.com` }, 'too long'],
    [{ name: 'ok', note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }, 'longer than'],
    [{ name: 'ok', note: 'bad\u0007' }, 'plain text'],
    [{ name: 'ok', vendor: 5 }, 'must be text'],
    [{ name: 'ok', link: 5 }, 'link must be'],
    [{ name: 'ok', note: 5 }, 'note must be text'],
    [{ name: 'ok', currency: 5 }, 'three-letter'],
    ['not an object', 'JSON object'],
  ])('refuses %j', (body, message) => {
    expect(() => normalizeFields(body)).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringContaining(message) })
    );
  });

  it('accepts the shapes the form sends', () => {
    const fields = normalizeFields({
      name: 'Publer',
      vendor: 'Publer',
      category: 'communication',
      plan: 'Professional',
      amount: '$12.00',
      currency: 'usd',
      cycle: 'annual',
      nextRenewal: '2027-03-01',
      autoRenew: false,
      status: 'trial',
      paymentMethod: 'Card ending 1234',
      link: '/admin/social-hub?tab=queue',
      note: 'two\nlines are fine\twith tabs',
    });
    expect(fields).toMatchObject({ amount: 12, currency: 'USD', cycle: 'annual', link: '/admin/social-hub?tab=queue' });
    expect(normalizeFields({ name: 'x', link: 'https://dash.cloudflare.com/?a=1' }).link).toBe(
      'https://dash.cloudflare.com/?a=1'
    );
    expect(normalizeFields({ name: 'x', amount: '' }).amount).toBeNull();
  });
});

describe('patchFields', () => {
  it('names the fields a patch carries and refuses an empty or foreign one', () => {
    expect(patchFields({ amount: 1, note: 'n' })).toEqual(['amount', 'note']);
    expect(() => patchFields({})).toThrow(/at least one field/);
    expect(() => patchFields({ id: 'x' })).toThrow(/Unknown field/);
    expect(() => patchFields([])).toThrow(/JSON object/);
  });
});

describe('presentItem', () => {
  it('adds the monthly figure and the days to renewal, and re-checks every stored field', () => {
    const row = newItem(normalizeFields({ name: 'GitHub', amount: 48, cycle: 'annual', nextRenewal: '2026-11-15' }), {
      id: 'gh',
      at: '2026-10-01T00:00:00.000Z',
    });
    const shown = presentItem(row, TODAY);
    expect(shown).toMatchObject({
      id: 'gh',
      name: 'GitHub',
      monthlyEquivalent: 4,
      daysUntilRenewal: 14,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(Object.keys(shown)).not.toContain('secret');
  });

  it('withholds a hand-edited value the form would refuse, keeping the name', () => {
    const shown = presentItem({ id: 'bad', name: 'Weird', amount: -3, cycle: 'weekly', link: 'javascript:alert(1)' }, TODAY);
    expect(shown.name).toBe('Weird');
    expect(shown.amount).toBeNull();
    expect(shown.cycle).toBe('monthly');
    expect(shown.link).toBe('');
    expect(shown.daysUntilRenewal).toBeNull();
    expect(shown.createdAt).toBeNull();
  });

  it('knows a stored row from junk', () => {
    expect(isStoredItem({ id: 'a1', name: 'x' })).toBe(true);
    expect(isStoredItem({ id: 'a1', name: '' })).toBe(false);
    expect(isStoredItem({ id: 'bad id!', name: 'x' })).toBe(false);
    expect(isStoredItem(null)).toBe(false);
  });
});

describe('summarizeServices', () => {
  const item = ({ id, ...over }) =>
    presentItem(newItem(normalizeFields({ name: 'n', ...over }), { id: id ?? over.name, at: '2026-10-01T00:00:00.000Z' }), TODAY);
  const items = [
    item({ id: 'c', name: 'Cloudflare', category: 'infrastructure', amount: 20, cycle: 'monthly', nextRenewal: '2026-11-10' }),
    item({ id: 'g', name: 'GitHub', category: 'developer', amount: 120, cycle: 'annual', nextRenewal: '2026-12-15' }),
    item({ id: 'p', name: 'Publer', category: 'communication', amount: 9, cycle: 'monthly', nextRenewal: '2026-10-28' }),
    item({ id: 'x', name: 'Cancelled thing', amount: 99, status: 'cancelled', nextRenewal: '2026-11-02' }),
    item({ id: 'f', name: 'Free tier', cycle: 'free' }),
  ];

  it('adds up what bills, groups by category, and lists renewals coming up and past', () => {
    const summary = summarizeServices(items);
    expect(summary.count).toBe(5);
    expect(summary.monthlyEquivalent).toBe(39);
    expect(summary.annualEquivalent).toBe(468);
    expect(summary.byCategory).toEqual([
      { category: 'infrastructure', label: 'Infrastructure', count: 1, monthlyEquivalent: 20 },
      { category: 'communication', label: 'Communication', count: 1, monthlyEquivalent: 9 },
      { category: 'developer', label: 'Developer tools', count: 1, monthlyEquivalent: 10 },
      { category: 'other', label: 'Other', count: 1, monthlyEquivalent: 0 },
    ]);
    expect(summary.upcoming.map((i) => i.id)).toEqual(['c']);
    expect(summary.overdue.map((i) => i.id)).toEqual(['p']);
    expect(summary.items.map((i) => i.id)).toEqual(['x', 'c', 'f', 'g', 'p']);
  });

  it('sorts by name, case-insensitively, then id', () => {
    expect([{ name: 'b', id: '1' }, { name: 'A', id: '2' }, { name: 'a', id: '1' }].sort(compareItems).map((i) => i.id + i.name)).toEqual([
      '1a',
      '2A',
      '1b',
    ]);
  });
});

describe('suggestions', () => {
  it('offers the vendors the site is configured with, minus those already in the ledger', () => {
    expect(SUGGESTED_VENDORS.map((s) => s.name)).toContain('Publer');
    expect(SUGGESTED_VENDORS.map((s) => s.name)).toContain('ElevenLabs');
    expect(SUGGESTED_VENDORS.map((s) => s.name)).not.toContain('AWS');
    expect(SUGGESTED_VENDORS.every((s) => CATEGORY_IDS.includes(s.category))).toBe(true);
    const left = suggestionsFor([{ name: 'Publer Pro', vendor: 'publer' }, { name: 'ElevenLabs', vendor: '' }]);
    expect(left.map((s) => s.name)).not.toContain('Publer');
    expect(left.map((s) => s.name)).not.toContain('ElevenLabs');
    expect(left.length).toBe(SUGGESTED_VENDORS.length - 2);
  });
});

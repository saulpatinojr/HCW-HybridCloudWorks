import { describe, expect, it, vi } from 'vitest';

import { RENEWALS_HREF, collectRenewals } from './collector.js';
import { LEDGER_DOC_ID } from './ledger-store.js';

const NOW = new Date('2026-11-01T00:00:00Z');
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-12-01T00:00:00Z');

const storeOf = (items) => ({
  readDoc: vi.fn(async (container, id) => (container === 'admin_config' && id === LEDGER_DOC_ID ? { id, items } : null)),
  createDoc: vi.fn(),
  replaceDocIfMatch: vi.fn(),
});

describe('collectRenewals', () => {
  it('lists each billing renewal in the window as an all-day deadline, and writes nothing', async () => {
    const store = storeOf([
      { id: 'c', name: 'Cloudflare', vendor: 'Cloudflare', amount: 20, cycle: 'monthly', nextRenewal: '2026-11-15', autoRenew: true },
      { id: 'x', name: 'Cancelled', status: 'cancelled', nextRenewal: '2026-11-16' },
      { id: 'u', name: 'Undated' },
      { id: 'l', name: 'Later', nextRenewal: '2027-01-01' },
      { name: 'junk' },
    ]);
    const items = await collectRenewals({ store, from: FROM, to: TO, now: () => NOW });
    expect(items).toEqual([
      expect.objectContaining({
        id: 'renewal:c',
        kind: 'renewal',
        title: 'Renews: Cloudflare',
        start: '2026-11-15T00:00:00.000Z',
        allDay: true,
        status: 'deadline',
        href: RENEWALS_HREF,
        sourceId: 'c',
        sourceCollection: 'admin_config',
        meta: { vendor: 'Cloudflare', amount: 20, currency: 'USD', cycle: 'monthly', autoRenew: true },
      }),
    ]);
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('is empty with no ledger', async () => {
    const store = { readDoc: vi.fn(async () => null) };
    expect(await collectRenewals({ store, from: FROM, to: TO })).toEqual([]);
  });
});

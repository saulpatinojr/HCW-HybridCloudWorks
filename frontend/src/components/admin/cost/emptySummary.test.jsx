/**
 * The first visit after a deploy: nothing has been read yet, or Azure cannot
 * be read. Every tab must draw, with dashes and zeros where a reading would
 * go, and say why. On 2026-11-02 the Overview tab threw on the missing AI
 * month and Azure totals, and the whole page showed the error card instead.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import CostPage from '@/pages/admin/CostPage';
import { COST_SERVICES_ROUTE } from '@/lib/cost';
import { TABS } from './tabs';
import { AZURE_UNREADABLE, NEVER_READ } from './emptyFixture';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: vi.fn(),
  postJSON: vi.fn(),
  authedFetch: vi.fn(),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const EMPTY_LEDGER = { ok: true, today: '2026-11-02', items: [], total: 0, suggestions: [] };

function answerWith(summary) {
  getJSON
    .mockReset()
    .mockImplementation(async (route) =>
      route.startsWith(COST_SERVICES_ROUTE) ? EMPTY_LEDGER : summary
    );
}

const renderTab = (tab) =>
  render(
    <MemoryRouter initialEntries={[`/admin/cost?tab=${tab}`]}>
      <CostPage />
    </MemoryRouter>
  );

describe.each([
  ['before anything has been read', NEVER_READ],
  ['when Azure cannot be read', AZURE_UNREADABLE],
])('the Cost page %s', (_when, summary) => {
  beforeEach(() => answerWith(summary));

  it.each(TABS.map((tab) => tab.id))('draws the %s tab instead of the error card', async (tab) => {
    renderTab(tab);
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Reading the cost figures' })).toBeNull()
    );
    expect(screen.queryByText(/This page hit an error/)).toBeNull();
    expect(screen.queryByText('The cost figures could not be read')).toBeNull();
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe(
      TABS.find((t) => t.id === tab).label
    );
  });

  it('says why the Azure tab has no figures', async () => {
    renderTab('azure');
    // The reason opens a longer sentence that says how to fix it.
    const found = await screen.findAllByText((text) => text.includes(summary.azure.reason));
    expect(found.length).toBeGreaterThan(0);
  });
});

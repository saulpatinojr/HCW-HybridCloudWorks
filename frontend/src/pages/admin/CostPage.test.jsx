/**
 * The Cost page's frame (ADR 0039): one read of the summary shared by every
 * tab, `?tab=` deep links with guessed ids landing where their content is, a
 * spinner until the read lands, and an error card with a retry when it fails.
 * What each tab shows is tested beside the tab, in components/admin/cost.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

import CostPage from './CostPage';
import { COST_SERVICES_ROUTE, COST_SUMMARY_ROUTE } from '@/lib/cost';
import { SERVICES_ANSWER, SUMMARY } from '@/components/admin/cost/fixture';
import { NAV_ITEMS, navGroupFor } from '@/config/adminNav';

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

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <CostPage />
      <LocationProbe />
    </MemoryRouter>
  );

const summaryCalls = () =>
  getJSON.mock.calls.filter(([route]) => route.startsWith(COST_SUMMARY_ROUTE));

beforeEach(() => {
  getJSON.mockReset().mockImplementation(async (route) => {
    if (route.startsWith(COST_SERVICES_ROUTE)) return SERVICES_ANSWER;
    return { ok: true, ...SUMMARY };
  });
});

describe('the registry entry', () => {
  it('sits under Platform at /admin/cost for editors', () => {
    const item = NAV_ITEMS.find((entry) => entry.label === 'Cost');
    expect(item).toMatchObject({ id: 'cost', to: '/admin/cost', minRole: 'editor' });
    expect(navGroupFor(item).id).toBe('platform');
  });
});

describe('CostPage', () => {
  it('opens on Overview, reading the summary once, with the registry title', async () => {
    renderAt('/admin/cost');
    expect(screen.getByRole('heading', { level: 1, name: 'Cost' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Reading the cost figures' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Reading the cost figures' })).toBeNull()
    );
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(summaryCalls()).toEqual([[COST_SUMMARY_ROUTE]]);
  });

  it('switches tabs through ?tab= without reading the summary again', async () => {
    renderAt('/admin/cost');
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Reading the cost figures' })).toBeNull()
    );
    for (const [name, id] of [
      ['Azure', 'azure'],
      ['AI', 'ai'],
      ['Alerts', 'alerts'],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.getByTestId('location').textContent).toBe(`/admin/cost?tab=${id}`);
      expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true');
    }
    expect(summaryCalls()).toHaveLength(1);
  });

  it('deep-links a tab, sends a guessed id where its content is, and an unknown one to Overview', async () => {
    const { unmount } = renderAt('/admin/cost?tab=services');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Services' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    );
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith(COST_SERVICES_ROUTE));
    unmount();

    const budgets = renderAt('/admin/cost?tab=budgets');
    expect(screen.getByRole('tab', { name: 'Azure' }).getAttribute('aria-selected')).toBe('true');
    budgets.unmount();

    renderAt('/admin/cost?tab=nope');
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('says when the figures could not be read, and reads again on Try again', async () => {
    getJSON.mockRejectedValueOnce(new Error('HTTP 403: editor role needed'));
    renderAt('/admin/cost');
    expect(await screen.findByText('The cost figures could not be read')).toBeTruthy();
    expect(screen.getByText(/editor role needed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() =>
      expect(screen.queryByText('The cost figures could not be read')).toBeNull()
    );
    expect(summaryCalls()).toHaveLength(2);
  });
});

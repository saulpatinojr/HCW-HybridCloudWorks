/**
 * The Search Console page (#1612): one read of the saved report shared by
 * every tab, each of the report's states (ok, not set up, never run, last
 * run failed) and a failed read, Run now's answers, and the words the page
 * puts on Google's codes. The report is a made-up fixture
 * (components/admin/search-console/fixture.js).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import SearchConsolePage from './SearchConsolePage';
import { REPORT } from '@/components/admin/search-console/fixture';
import { NAV_ITEMS, navGroupFor } from '@/config/adminNav';
import {
  SEARCH_CONSOLE_ROUTE,
  SEARCH_CONSOLE_RUN_ROUTE,
  SEARCH_CONSOLE_RUNBOOK_URL,
  SEARCH_CONSOLE_URL,
} from '@/lib/searchConsole';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const getJSON = vi.fn();
const authedFetch = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  authedFetch: (...args) => authedFetch(...args),
  postJSON: vi.fn(),
  sendJSON: vi.fn(),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const renderAt = (url = '/admin/search-console') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchConsolePage />
    </MemoryRouter>
  );

const loaded = () =>
  waitFor(() =>
    expect(screen.queryByRole('status', { name: 'Reading the Search Console report' })).toBeNull()
  );

/** An Error shaped the way lib/api.js throws one for a refused call. */
const apiError = (status, message, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue(REPORT);
  authedFetch.mockReset().mockResolvedValue({ ok: true, status: 202 });
  toast.mockReset();
});

describe('the registry entry', () => {
  it('sits under Platform at /admin/search-console for editors', () => {
    const item = NAV_ITEMS.find((entry) => entry.label === 'Search Console');
    expect(item).toMatchObject({
      id: 'search-console',
      to: '/admin/search-console',
      minRole: 'editor',
    });
    expect(navGroupFor(item).id).toBe('platform');
  });
});

describe('SearchConsolePage with a report', () => {
  it('reads the report once, with the registry title and the link to Google', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: 'Search Console' })).toBeTruthy();
    await loaded();
    expect(getJSON.mock.calls).toEqual([[SEARCH_CONSOLE_ROUTE]]);
    expect(SEARCH_CONSOLE_ROUTE).toBe('cms/search-console');
    expect(screen.getByRole('link', { name: /Open Search Console/ }).getAttribute('href')).toBe(
      SEARCH_CONSOLE_URL
    );
    expect(screen.getByTestId('last-run').textContent).toMatch(
      /2026-11-09 12:14 UTC.*4 pages inspected, 0 could not be inspected/
    );
  });

  it('shows the indexing tiles and lists pages that are not indexed first', async () => {
    renderAt();
    await loaded();
    expect(within(screen.getByTestId('tile-indexed')).getByText('2')).toBeTruthy();
    expect(within(screen.getByTestId('tile-excluded')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('tile-error')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('tile-unknown')).getByText('0')).toBeTruthy();

    const verdicts = screen.getAllByTestId('indexing-row').map((row) => row.dataset.verdict);
    expect(verdicts).toEqual(['FAIL', 'NEUTRAL', 'PASS', 'PASS']);
  });

  it('says ACCESS_DENIED as "401 unauthorized" and flags a canonical Google chose differently', async () => {
    renderAt();
    await loaded();
    const [locked] = screen.getAllByTestId('indexing-row');
    expect(within(locked).getByText('401 unauthorized')).toBeTruthy();
    expect(within(locked).getByText('Never crawled')).toBeTruthy();
    expect(within(locked).getByRole('link', { name: /Inspect in Google/ })).toBeTruthy();
    expect(screen.getAllByText(/Google chose a different address/)).toHaveLength(1);
    expect(screen.getByText('/b-other-address')).toBeTruthy();
  });

  it('filters by verdict chip and by the search box', async () => {
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getAllByTestId('indexing-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Indexed' }));
    expect(screen.getAllByTestId('indexing-row')).toHaveLength(2);

    fireEvent.click(within(screen.getByRole('group', { name: 'Verdict' })).getByText('All'));
    fireEvent.change(screen.getByLabelText('Search inspected pages'), {
      target: { value: 'locked' },
    });
    expect(screen.getAllByTestId('indexing-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search inspected pages'), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText('No pages match the current filter.')).toBeTruthy();
  });

  it('lists pages Google shows that are not in the sitemap', async () => {
    renderAt();
    await loaded();
    const table = screen.getByRole('table', {
      name: 'Pages Google shows that are not in the sitemap',
    });
    expect(within(table).getByText('/old-stray-page')).toBeTruthy();
    expect(within(table).getByText('120')).toBeTruthy();
  });

  it('shows CTR as a percentage with one decimal and position with one decimal', async () => {
    renderAt('/admin/search-console?tab=performance');
    await loaded();
    expect(within(screen.getByTestId('tile-clicks')).getByText('1,234')).toBeTruthy();
    expect(within(screen.getByTestId('tile-ctr')).getByText('2.2%')).toBeTruthy();
    expect(within(screen.getByTestId('tile-ctr')).getByText('Last 28 days: 4.0%')).toBeTruthy();
    expect(within(screen.getByTestId('tile-position')).getByText('18.5')).toBeTruthy();

    const queries = screen.getByRole('table', { name: 'Performance by queries' });
    const rows = within(queries).getAllByRole('row').slice(1);
    // Most clicks first.
    expect(rows[0].textContent).toContain('terraform modules');
    expect(rows[1].textContent).toContain('azure landing zone');
    expect(rows[1].textContent).toContain('5.0%');
    expect(rows[1].textContent).toContain('7.3');
  });

  it('shows a country code upper-case and an empty breakdown in words', async () => {
    renderAt('/admin/search-console?tab=performance');
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: 'Countries' }));
    expect(screen.getByText('USA')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Search appearance' }));
    expect(screen.getByText('No search appearance from Google for this period.')).toBeTruthy();
  });

  it('lists the sitemaps and says what Google API does not offer', async () => {
    renderAt('/admin/search-console?tab=sitemaps');
    await loaded();
    const table = screen.getByRole('table', { name: 'Sitemaps' });
    expect(within(table).getByText('https://hybridcloudworks.com/sitemap.xml')).toBeTruthy();
    expect(within(table).getByText('web: 4')).toBeTruthy();
    expect(within(table).getByText('Read without problems')).toBeTruthy();
    expect(screen.getByText('Not available from Google’s API')).toBeTruthy();
    expect(screen.getByText(/no API for its Page indexing screen/)).toBeTruthy();
    expect(screen.getByText(/no API for its Links screen/)).toBeTruthy();
  });

  it('switches tabs without reading the report again, and sends a guessed tab where it belongs', async () => {
    renderAt('/admin/search-console?tab=queries');
    await loaded();
    expect(screen.getByRole('tab', { name: 'Performance' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Sitemaps' }));
    expect(screen.getByRole('tab', { name: 'Sitemaps' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it('draws a report with every list missing', async () => {
    getJSON.mockResolvedValueOnce({ status: 'ok' });
    renderAt();
    await loaded();
    expect(screen.getByText('No pages were inspected in the last run.')).toBeTruthy();
    expect(within(screen.getByTestId('tile-indexed')).getByText('—')).toBeTruthy();
  });
});

describe('SearchConsolePage states', () => {
  it('explains that Google sign-in is not set up, with the runbook, and offers no Run now', async () => {
    getJSON.mockResolvedValueOnce({ status: 'not_configured', generatedAt: null });
    renderAt();
    expect(await screen.findByText('Google sign-in is not set up yet')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Open the Search Console runbook/ }).getAttribute('href')
    ).toBe(SEARCH_CONSOLE_RUNBOOK_URL);
    expect(screen.queryByRole('button', { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('offers Run now when Google has never been asked', async () => {
    getJSON.mockResolvedValueOnce({ status: 'never_run', generatedAt: null });
    renderAt();
    expect(await screen.findByText('Google has not been asked yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Run now/ })).toHaveLength(1);
  });

  it('shows why the last run failed', async () => {
    getJSON.mockResolvedValueOnce({
      ...REPORT,
      status: 'error',
      run: { ...REPORT.run, message: 'Google refused the sign-in (403).' },
    });
    renderAt();
    expect(
      await screen.findByText(/The last run failed: Google refused the sign-in \(403\)\./)
    ).toBeTruthy();
  });

  it('says when the report could not be read, and reads again on Try again', async () => {
    getJSON.mockRejectedValueOnce(new Error('HTTP 500: the store did not answer'));
    renderAt();
    expect(await screen.findByText('The Search Console report could not be read')).toBeTruthy();
    expect(screen.getByText('HTTP 500: the store did not answer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.getAllByTestId('indexing-row')).toHaveLength(4));
    expect(getJSON).toHaveBeenCalledTimes(2);
  });
});

describe('Run now', () => {
  it('queues a run and says the page updates when it finishes', async () => {
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(authedFetch).toHaveBeenCalledWith(SEARCH_CONSOLE_RUN_ROUTE, {
      method: 'POST',
      body: '{}',
    });
    expect(SEARCH_CONSOLE_RUN_ROUTE).toBe('cms/search-console/run');
    expect(toast.mock.calls[0][0].description).toBe(
      'Queued; the page updates when the run finishes, usually a few minutes.'
    );
    expect(await screen.findByRole('button', { name: /Run in progress/ })).toBeTruthy();
  });

  it('explains a 409 not_configured answer', async () => {
    authedFetch.mockRejectedValueOnce(apiError(409, 'not_configured', 'not_configured'));
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'Google sign-in is not set up yet',
      variant: 'destructive',
    });
    expect(screen.getByRole('button', { name: /Run now/ })).toBeTruthy();
  });

  it('gives any other failure a plain toast with the server sentence', async () => {
    authedFetch.mockRejectedValueOnce(apiError(500, 'The run could not be queued.'));
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].title).toBe('The run could not be started');
    expect(toast.mock.calls[0][0].description).toMatch(/^The run could not be queued\./);
  });
});

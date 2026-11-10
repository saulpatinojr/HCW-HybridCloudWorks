/**
 * The Search Console page (#1612): one read of the saved report shared by
 * every tab, each of the report's states (ok, not set up, never run, last
 * run failed) and a failed read, Run now's answers, and the words the page
 * puts on Google's codes. The report is a made-up fixture
 * (components/admin/search-console/fixture.js).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import SearchConsolePage from './SearchConsolePage';
import { REPORT } from '@/components/admin/search-console/fixture';
import {
  POLL_EVERY_MS,
  POLL_FOR_MS,
  runNowToast,
} from '@/components/admin/search-console/useSearchConsole';
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

/** The page on its Indexing tab, which is no longer where it opens. */
const INDEXING = '/admin/search-console?tab=indexing';

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

  it('opens on Performance, the first tab, with Indexing second', async () => {
    renderAt();
    await loaded();
    const tabs = within(screen.getByRole('tablist', { name: 'Search Console' })).getAllByRole(
      'tab'
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Performance', 'Indexing', 'Sitemaps']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('table', { name: 'Performance by queries' })).toBeTruthy();
  });

  it('shows the indexing tiles and lists pages that are not indexed first', async () => {
    renderAt(INDEXING);
    await loaded();
    expect(within(screen.getByTestId('tile-indexed')).getByText('2')).toBeTruthy();
    expect(within(screen.getByTestId('tile-excluded')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('tile-error')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('tile-unknown')).getByText('0')).toBeTruthy();

    const verdicts = screen.getAllByTestId('indexing-row').map((row) => row.dataset.verdict);
    expect(verdicts).toEqual(['FAIL', 'NEUTRAL', 'PASS', 'PASS']);
  });

  it('says ACCESS_DENIED as "401 unauthorized" and flags a canonical Google chose differently', async () => {
    renderAt(INDEXING);
    await loaded();
    const [locked] = screen.getAllByTestId('indexing-row');
    expect(within(locked).getByText('401 unauthorized')).toBeTruthy();
    expect(within(locked).getByText('Never crawled')).toBeTruthy();
    expect(within(locked).getByRole('link', { name: /Inspect in Google/ })).toBeTruthy();
    expect(screen.getAllByText(/Google chose a different address/)).toHaveLength(1);
    expect(screen.getByText('/b-other-address')).toBeTruthy();
  });

  it('filters by verdict chip and by the search box', async () => {
    renderAt(INDEXING);
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

  it('says where each page came from, shows a subdomain page in full, and filters by host', async () => {
    renderAt(INDEXING);
    await loaded();
    const rows = screen.getAllByTestId('indexing-row');
    expect(rows.map((row) => row.dataset.source)).toEqual([
      'sitemap',
      'search',
      'sitemap',
      'sitemap',
    ]);
    const [, docsRow] = rows;
    expect(within(docsRow).getByText('Found in search')).toBeTruthy();
    const docsLink = within(docsRow).getByRole('link', {
      name: 'https://docs.hybridcloudworks.com/d-not-chosen',
    });
    expect(docsLink.getAttribute('href')).toBe('https://docs.hybridcloudworks.com/d-not-chosen');
    // A page on the main site shows its path only.
    expect(within(rows[0]).getByRole('link', { name: '/c-locked-page' })).toBeTruthy();
    expect(within(rows[0]).getByText('Sitemap')).toBeTruthy();

    const hosts = screen.getByRole('group', { name: 'Host' });
    fireEvent.click(within(hosts).getByText('docs.hybridcloudworks.com (1)'));
    expect(screen.getAllByTestId('indexing-row')).toHaveLength(1);
    fireEvent.click(within(hosts).getByText('hybridcloudworks.com (3)'));
    expect(screen.getAllByTestId('indexing-row')).toHaveLength(3);
    fireEvent.click(within(hosts).getByText('All'));
    fireEvent.change(screen.getByLabelText('Search inspected pages'), {
      target: { value: 'found in search' },
    });
    expect(screen.getAllByTestId('indexing-row')).toHaveLength(1);
  });

  it('links a stray on a subdomain, showing its whole address', async () => {
    getJSON.mockResolvedValueOnce({
      ...REPORT,
      indexing: {
        ...REPORT.indexing,
        strays: [
          { url: 'https://api-azure.hybridcloudworks.com/x', clicks: 1, impressions: 40 },
          ...REPORT.indexing.strays,
        ],
      },
    });
    renderAt(INDEXING);
    await loaded();
    const table = screen.getByRole('table', {
      name: 'Pages Google shows that are not in the sitemap',
    });
    expect(
      within(table)
        .getByRole('link', { name: 'https://api-azure.hybridcloudworks.com/x' })
        .getAttribute('href')
    ).toBe('https://api-azure.hybridcloudworks.com/x');
    expect(within(table).getByRole('link', { name: '/old-stray-page' })).toBeTruthy();
  });

  it('shows each page in the Performance tab by its whole address, host included', async () => {
    renderAt('/admin/search-console?tab=performance');
    await loaded();
    fireEvent.click(screen.getByRole('tab', { name: 'Pages' }));
    const table = screen.getByRole('table', { name: 'Performance by pages' });
    expect(within(table).getByText('https://hybridcloudworks.com/a-indexed-page')).toBeTruthy();
    expect(within(table).getByText('https://docs.hybridcloudworks.com/d-not-chosen')).toBeTruthy();
  });

  it('lists pages Google shows that are not in the sitemap', async () => {
    renderAt(INDEXING);
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
    renderAt(INDEXING);
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

  it('shows a note from a run that worked as information, not a failure', async () => {
    getJSON.mockResolvedValueOnce({
      ...REPORT,
      run: { ...REPORT.run, stale: 3, message: 'Only 1 of 4 pages fit in today’s allowance.' },
    });
    renderAt();
    await loaded();
    const note = screen.getByTestId('run-note');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe(
      'Note from the last run: Only 1 of 4 pages fit in today’s allowance.'
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('last-run').textContent).toMatch(/3 kept from an earlier run/);
  });

  it('marks a page whose answer is from an earlier run as stale', async () => {
    const [first, ...rest] = REPORT.indexing.pages;
    getJSON.mockResolvedValueOnce({
      ...REPORT,
      indexing: {
        ...REPORT.indexing,
        pages: [
          {
            ...first,
            stale: true,
            inspectedAt: '2026-11-08T12:10:00.000Z',
            error: 'Not inspected in the last run: the daily allowance was used up.',
          },
          { ...rest[0], stale: true, error: 'Kept.' },
          ...rest.slice(1),
        ],
      },
    });
    renderAt(INDEXING);
    await loaded();
    const staleRows = screen
      .getAllByTestId('indexing-row')
      .filter((row) => row.dataset.stale === 'true');
    expect(staleRows).toHaveLength(2);
    const markers = screen.getAllByTestId('stale-marker');
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => marker.getAttribute('title'))).toContain(
      'This answer is from an earlier run (2026-11-08 12:10 UTC); the last run could not ask Google again.'
    );
    expect(
      screen.getByText('Not inspected in the last run: the daily allowance was used up.')
    ).toBeTruthy();
    expect(screen.queryByText(/Could not inspect: Not inspected/)).toBeNull();
  });

  it('links only to the public site and to Google, and shows any other address as text', async () => {
    const [first, second, ...rest] = REPORT.indexing.pages;
    getJSON.mockResolvedValueOnce({
      ...REPORT,
      indexing: {
        ...REPORT.indexing,
        pages: [
          { ...first, inspectionResultLink: 'javascript:alert(1)' },
          { ...second, url: 'https://evil.example/b-canonical-elsewhere' },
          ...rest,
        ],
        strays: [
          { url: 'https://hybridcloudworks.com.evil.example/x', clicks: 1, impressions: 2 },
          ...REPORT.indexing.strays,
        ],
      },
    });
    renderAt(INDEXING);
    await loaded();
    const rows = screen.getAllByTestId('indexing-row');
    const allLinks = rows.flatMap((row) => within(row).queryAllByRole('link'));
    for (const link of allLinks) {
      expect(link.getAttribute('href')).toMatch(
        /^https:\/\/(([a-z0-9-]+\.)*hybridcloudworks\.com|search\.google\.com)\//
      );
    }
    expect(screen.getByText('https://evil.example/b-canonical-elsewhere')).toBeTruthy();
    const strays = screen.getByRole('table', {
      name: 'Pages Google shows that are not in the sitemap',
    });
    expect(within(strays).getByText('https://hybridcloudworks.com.evil.example/x')).toBeTruthy();
    expect(within(strays).getAllByRole('link')).toHaveLength(1);
  });

  it('says when the report could not be read, and reads again on Try again', async () => {
    getJSON.mockRejectedValueOnce(new Error('HTTP 500: the store did not answer'));
    renderAt(INDEXING);
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
      'Queued; the page updates when the run finishes, usually in about ten minutes.'
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

  it('says so when a run is already going, and waits for it', async () => {
    authedFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, queued: true, alreadyRunning: true, status: 'running' }),
    });
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].title).toBe('A run is already going');
    expect(await screen.findByRole('button', { name: /Run in progress/ })).toBeTruthy();
  });

  it('explains a 429 with the server sentence saying when the allowance starts again', async () => {
    authedFetch.mockRejectedValueOnce(
      apiError(
        429,
        'daily_budget_spent — Today’s allowance of 1,800 Google page inspections is used up. It starts again at midnight Pacific time (2026-11-10 08:00 UTC).'
      )
    );
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toEqual({
      title: 'Today’s Google inspections are used up',
      description:
        'Today’s allowance of 1,800 Google page inspections is used up. It starts again at midnight Pacific time (2026-11-10 08:00 UTC).',
    });
    expect(screen.getByRole('button', { name: /Run now/ })).toBeTruthy();
  });

  it('has its own words for a 429 that carries no sentence', () => {
    expect(
      runNowToast({ ok: false, error: apiError(429, 'daily_budget_spent') }).description
    ).toMatch(/starts again at midnight Pacific time/);
    expect(runNowToast({ ok: true, alreadyQueued: true }).title).toBe('A run is already going');
  });

  it('keeps the report on screen when a background read fails, and shows the new run when it lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      renderAt(INDEXING);
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
      expect(await screen.findByRole('button', { name: /Run in progress/ })).toBeTruthy();
      // Let the effect that starts the polling timer run before moving the
      // clock, as in "stops waiting after an hour" below: otherwise the timer
      // can start after the jump and never fire, and the page reads only once
      // (failed in CI on 2026-11-10, "called 2 times, but got 1 times").
      await act(async () => {});

      getJSON.mockRejectedValueOnce(new Error('HTTP 503: try later'));
      await act(async () => {
        vi.advanceTimersByTime(POLL_EVERY_MS);
      });
      await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
      expect(screen.getAllByTestId('indexing-row')).toHaveLength(4);
      expect(screen.queryByText('The Search Console report could not be read')).toBeNull();
      expect(screen.getByRole('button', { name: /Run in progress/ })).toBeTruthy();

      getJSON.mockResolvedValueOnce({
        ...REPORT,
        run: { ...REPORT.run, finishedAt: '2026-11-09T13:00:00.000Z' },
      });
      await act(async () => {
        vi.advanceTimersByTime(POLL_EVERY_MS);
      });
      expect(await screen.findByRole('button', { name: /Run now/ })).toBeTruthy();
      expect(screen.getByTestId('last-run').textContent).toMatch(/2026-11-09 13:00 UTC/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting after an hour', async () => {
    // Pinned, so a shorter wait than a late, slow run needs fails here (useSearchConsole.js says why an hour).
    expect(POLL_FOR_MS).toBe(60 * 60_000);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      renderAt();
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
      expect(await screen.findByRole('button', { name: /Run in progress/ })).toBeTruthy();
      // The label changes when React commits, but the effect that starts the
      // polling timer runs a moment later. Let it run before moving the clock;
      // otherwise the timer can start after the jump, against the moved clock,
      // and the hour never passes (the test failed about one run in
      // five that way).
      await act(async () => {});
      getJSON.mockResolvedValue(REPORT);
      await act(async () => {
        vi.advanceTimersByTime(POLL_FOR_MS + POLL_EVERY_MS);
      });
      expect(await screen.findByRole('button', { name: /Run now/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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

/**
 * The Stats tab (#1115): one read per range, the figures by section, each
 * section's failure in place, and the three states that are not figures.
 *
 * recharts is stubbed: jsdom has no layout and no ResizeObserver, so a real
 * ResponsiveContainer renders nothing and warns. What the chart is fed is
 * pinned on `downloadSeries` in statsView.test.js; here the stub records the
 * series it was handed.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StatsTab from './StatsTab';

const getJSON = vi.fn();
const chartData = vi.fn();

vi.mock('@/lib/api', () => ({ getJSON: (...args) => getJSON(...args) }));

let authReady = true;
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady }) }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="chart">{children}</div>,
  BarChart: ({ data, children }) => {
    chartData(data);
    return <div>{children}</div>;
  },
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const stats = (over = {}) => ({
  success: true,
  configured: true,
  cached: true,
  fetchedAt: '2026-10-13T15:00:00.000Z',
  range: '30d',
  window: { start: '2026-10-11', end: '2026-10-13', period: 'd' },
  downloads: { byPeriod: { '2026-10-11': 40, '2026-10-13': 2 }, total: 42 },
  countries: { US: 30, GH: 10, DE: 2 },
  platforms: { Android: 25, iOS: 17 },
  sources: { 'Podbean App': 22, Spotify: 20 },
  retention: {
    'Aug 04-Aug 10': [
      { listeners: 12, retention: 1 },
      { listeners: 6, retention: 0.5 },
    ],
  },
  audience: { followers: 3, likes: 1, comments: 0, totalEpisodeLengthSeconds: 5400 },
  errors: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  authReady = true;
  getJSON.mockResolvedValue(stats());
});

describe('StatsTab', () => {
  it('reads 30 days once auth is ready, and renders every section from the answer', async () => {
    render(<StatsTab />);
    expect(await screen.findByLabelText('Total downloads')).toHaveTextContent('42');
    expect(getJSON).toHaveBeenCalledTimes(1);
    expect(getJSON).toHaveBeenCalledWith('cms/podcast/host/stats?range=30d');
    expect(screen.getByRole('status')).toHaveTextContent(/Podbean read .*\(cached\)/);

    // The chart is fed one point per day of the window.
    expect(chartData).toHaveBeenLastCalledWith([
      { key: '2026-10-11', label: 'Oct 11', count: 40 },
      { key: '2026-10-12', label: 'Oct 12', count: 0 },
      { key: '2026-10-13', label: 'Oct 13', count: 2 },
    ]);

    const countries = screen.getByRole('list', { name: 'Top countries' });
    const rows = within(countries).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('United States');
    expect(rows[0]).toHaveTextContent('30 · 71.4%');
    expect(rows[1]).toHaveTextContent('Ghana');
    expect(
      within(screen.getByRole('list', { name: 'Platforms' })).getAllByRole('listitem')[0]
    ).toHaveTextContent('Android');
    expect(
      within(screen.getByRole('list', { name: 'Sources' })).getAllByRole('listitem')[0]
    ).toHaveTextContent('Podbean App');

    // Retention as a table; the fraction shown as a percentage.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Aug 04-Aug 10')).toBeInTheDocument();
    expect(within(table).getByText('50%')).toBeInTheDocument();

    // Audience tiles.
    expect(screen.getByText('Followers').nextSibling).toHaveTextContent('3');
    expect(screen.getByText('Total episode length').nextSibling).toHaveTextContent('1h 30m');
  });

  it('a range button reads that range, clearing the figures while it reads', async () => {
    render(<StatsTab />);
    await screen.findByLabelText('Total downloads');
    getJSON.mockResolvedValueOnce(stats({ range: '12m', downloads: { byPeriod: {}, total: 7 } }));
    fireEvent.click(screen.getByRole('button', { name: '12 months' }));
    expect(screen.getByRole('button', { name: '12 months' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith('cms/podcast/host/stats?range=12m'));
    expect(await screen.findByLabelText('Total downloads')).toHaveTextContent('7');
  });

  it('Refresh asks the route for a live read of the current range', async () => {
    render(<StatsTab />);
    await screen.findByLabelText('Total downloads');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from Podbean' }));
    await waitFor(() =>
      expect(getJSON).toHaveBeenCalledWith('cms/podcast/host/stats?range=30d&refresh=1')
    );
  });

  it('shows a section’s own failure in place and the others still render', async () => {
    getJSON.mockResolvedValue(
      stats({
        countries: null,
        errors: {
          countries: {
            status: 429,
            code: 'UPSTREAM',
            message: 'Podbean answered 429.',
            retryable: true,
          },
        },
      })
    );
    render(<StatsTab />);
    await screen.findByLabelText('Total downloads');
    expect(
      screen.getByText('Could not read this from Podbean: Podbean answered 429.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Top countries' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Platforms' })).toBeInTheDocument();
  });

  it('says so when Podbean is not configured, and reads nothing before auth is ready', async () => {
    authReady = false;
    const { rerender } = render(<StatsTab />);
    expect(getJSON).not.toHaveBeenCalled();
    authReady = true;
    getJSON.mockResolvedValue({
      success: true,
      configured: false,
      range: '30d',
      reason: 'Podbean publishing is not configured: PODBEAN_CLIENT_ID is not set.',
    });
    rerender(<StatsTab />);
    expect(
      await screen.findByText('Podbean publishing is not configured: PODBEAN_CLIENT_ID is not set.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Total downloads')).not.toBeInTheDocument();
  });

  it('a failed read is an alert with no figures; an empty show is "no data yet"', async () => {
    getJSON.mockRejectedValueOnce(new Error('stats failed with HTTP 502'));
    const { unmount } = render(<StatsTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read Podbean: stats failed with HTTP 502'
    );
    expect(screen.queryByLabelText('Total downloads')).not.toBeInTheDocument();
    unmount();

    getJSON.mockResolvedValue(
      stats({
        downloads: { byPeriod: {}, total: 0 },
        countries: {},
        platforms: {},
        sources: {},
        retention: {},
        audience: { followers: 0, likes: 0, comments: 0, totalEpisodeLengthSeconds: 0 },
      })
    );
    render(<StatsTab />);
    expect(await screen.findByText(/No data yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });
});

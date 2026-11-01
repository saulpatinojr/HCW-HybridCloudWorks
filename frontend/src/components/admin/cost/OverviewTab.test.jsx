/**
 * Overview: four tiles with the fixture's numbers, each opening its tab; where
 * the money goes with the forecast; the last months; and the sources line that
 * says what was read, when and what failed, with Refresh asking for a forced
 * read. A stale snapshot shows the amber notice.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import OverviewTab, { tilesFor } from './OverviewTab';
import { READ_AT, SUMMARY } from './fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T14:10:00.000Z'));
});
afterEach(() => vi.useRealTimers());

const renderTab = (summary = SUMMARY, over = {}) => {
  const onRefresh = vi.fn();
  render(
    <MemoryRouter>
      <OverviewTab summary={summary} pending={false} onRefresh={onRefresh} {...over} />
    </MemoryRouter>
  );
  return { onRefresh };
};

describe('tilesFor', () => {
  it('reads each corner of the snapshot into a tile that opens its tab', () => {
    const tiles = tilesFor(SUMMARY);
    expect(tiles.map((t) => t.to)).toEqual([
      '/admin/cost?tab=azure',
      '/admin/cost?tab=ai',
      '/admin/cost?tab=services',
      '/admin/cost?tab=alerts',
    ]);
    expect(tiles[0]).toMatchObject({
      value: '$117.00',
      label: 'Azure this month of $150.00 budget',
      note: 'forecast $160.00 · 78% used',
      tone: 'warn',
    });
    expect(tiles[1]).toMatchObject({
      value: '$4.23',
      label: 'AI this month of $20.00 budget',
      note: '21.2% used · 120 calls',
      tone: 'ok',
    });
    expect(tiles[2]).toMatchObject({
      value: '$68.54',
      label: 'Services per month (5)',
      note: 'next: Cloudflare Pro in 2 days',
    });
    expect(tiles[3]).toMatchObject({
      value: '5',
      note: '1 critical, 3 warning, 1 info',
      tone: 'bad',
    });
  });

  it('says when Azure is unavailable, no AI budget is set and nothing renews soon', () => {
    const tiles = tilesFor({
      ...SUMMARY,
      azure: { ...SUMMARY.azure, available: false, reason: 'COST_SCOPES is not set' },
      ai: { ...SUMMARY.ai, budgetUsd: null },
      services: { ...SUMMARY.services, upcoming: [] },
      signals: [],
    });
    expect(tiles[0]).toMatchObject({ value: '—', note: 'not available', tone: 'muted' });
    expect(tiles[1]).toMatchObject({ label: 'AI this month', note: 'no budget set · 120 calls' });
    expect(tiles[2].note).toBe('no renewal in the next 30 days');
    expect(tiles[3]).toMatchObject({ value: '0', note: 'nothing to act on', tone: 'muted' });
  });
});

describe('OverviewTab', () => {
  it('renders the tiles, the money table, the last months and the sources line', () => {
    renderTab();
    const tiles = screen.getAllByTestId('stat-tile');
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toHaveAttribute('href', '/admin/cost?tab=azure');
    expect(within(tiles[0]).getByText('$117.00')).toBeInTheDocument();
    expect(within(tiles[3]).getByText('1 critical, 3 warning, 1 info')).toBeInTheDocument();

    const money = screen.getByRole('heading', { name: 'Where the money goes' }).closest('div');
    expect(money).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Azure' })).toHaveAttribute(
      'href',
      '/admin/cost?tab=azure'
    );
    expect(screen.getByText('Total so far').closest('tr')).toHaveTextContent('$189.77');

    expect(screen.getByText('October 2026').closest('tr')).toHaveTextContent('$134.32');
    expect(screen.getByText('September 2026').closest('tr')).toHaveTextContent('$128.90');
    expect(screen.getByText('day 13 of 30')).toBeInTheDocument();
  });

  it('says what was read, how long ago, which source failed, and Refresh asks for a fresh read', () => {
    const { onRefresh } = renderTab();
    expect(
      screen.getByText(/Read Azure Cost Management, the AI usage ledger, the services ledger/)
    ).toBeInTheDocument();
    expect(screen.getByText('7 minutes ago')).toHaveAttribute('title', READ_AT);
    expect(screen.getByText(/Azure cost figures lag by up to a day/)).toBeInTheDocument();
    expect(
      screen.getByText(/ElevenLabs could not be read: Could not read the ElevenLabs subscription/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the amber notice on a stale snapshot and disables Refresh while a read runs', () => {
    renderTab({ ...SUMMARY, stale: true }, { pending: true });
    expect(screen.getByRole('status')).toHaveTextContent(/more than 36 hours old/);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('never prints a subscription id', () => {
    const { container } = render(
      <MemoryRouter>
        <OverviewTab summary={SUMMARY} pending={false} onRefresh={() => {}} />
      </MemoryRouter>
    );
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

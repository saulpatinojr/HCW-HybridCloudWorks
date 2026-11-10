/**
 * The Health page's "Sent to your phone" card (owner request 2026-11-10):
 * it lists the alerts the server logged, newest first, and sends one again.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import SentAlertsCard, {
  ALERTS_RECENT_ROUTE,
  ALERTS_RESEND_ROUTE,
  refusalSentence,
  utcMinute,
} from './SentAlertsCard';

const getJSON = vi.fn();
const postJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const ALERTS = [
  {
    id: 'b2-y',
    at: '2026-11-10T00:45:00.000Z',
    source: 'job_failed:sync-search-console',
    severity: 'warning',
    title: 'Job failed: sync-search-console',
    message: 'Job x failed.\nError: The run failed.',
    resentOf: null,
  },
  {
    id: 'a1-x',
    at: '2026-11-10T00:40:00.000Z',
    source: 'checkLiveLinks',
    severity: 'info',
    title: 'Links checked',
    message: '',
    resentOf: null,
  },
];

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue({ ok: true, alerts: ALERTS });
  postJSON.mockReset().mockResolvedValue({ ok: true, sent: true });
  toast.mockReset();
});

describe('SentAlertsCard', () => {
  it('lists the logged alerts in the order the server gives, with the exact time and the text folded away', async () => {
    render(<SentAlertsCard />);
    const list = await screen.findByRole('list', { name: 'Alerts sent to your phone' });
    const rows = within(list).getAllByTestId('sent-alert');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Job failed: sync-search-console'),
      expect.stringContaining('Links checked'),
    ]);
    expect(rows[0].textContent).toContain('2026-11-10 00:45 UTC');
    expect(within(rows[0]).getByText('Show the text')).toBeTruthy();
    // An alert with no text has nothing to unfold.
    expect(within(rows[1]).queryByText('Show the text')).toBeNull();
    expect(getJSON).toHaveBeenCalledWith(ALERTS_RECENT_ROUTE);
    // One read on open, and no more: a fresh `empty` value each render once
    // made the shared load hook read again on every render.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it('sends one again by its id, says so, and reads the log again', async () => {
    render(<SentAlertsCard />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Send again: Job failed: sync-search-console' })
    );
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith(ALERTS_RESEND_ROUTE, { id: 'b2-y' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sent again' }))
    );
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
  });

  it('shows the server’s own sentence when it could not be sent again', async () => {
    postJSON.mockRejectedValue(
      Object.assign(
        new Error(
          'not_found — That alert is no longer in the log (it keeps the newest 50). (reference abc)'
        ),
        {
          status: 404,
        }
      )
    );
    render(<SentAlertsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send again: Links checked' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'It could not be sent again',
          description: 'That alert is no longer in the log (it keeps the newest 50).',
          variant: 'destructive',
        })
      )
    );
  });

  it('says when nothing has been logged yet, and when the log could not be read', async () => {
    getJSON.mockResolvedValueOnce({ ok: true, alerts: [] });
    const { unmount } = render(<SentAlertsCard />);
    expect(await screen.findByText(/None yet/)).toBeTruthy();
    unmount();

    getJSON.mockRejectedValueOnce(new Error('Failed to read the alert log (reference r1)'));
    render(<SentAlertsCard />);
    expect(
      await screen.findByText(/The alert log could not be read: Failed to read the alert log/)
    ).toBeTruthy();
  });
});

describe('helpers', () => {
  it('writes a time to the minute in UTC, or nothing for no time', () => {
    expect(utcMinute('2026-11-10T00:45:59.000Z')).toBe('2026-11-10 00:45 UTC');
    expect(utcMinute(null)).toBeNull();
  });

  it('takes the server’s sentence out of a joined message, without the reference', () => {
    expect(refusalSentence(new Error('bad_id — Name the alert. (reference x1)'))).toBe(
      'Name the alert.'
    );
    expect(refusalSentence(new Error('Plain failure'))).toBe('Plain failure');
    expect(refusalSentence(null)).toBe('The request failed.');
  });
});

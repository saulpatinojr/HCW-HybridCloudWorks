/**
 * The alerts hook: the pop-up and the Calendar page each hold a copy, and a
 * change made through one must reach the other.
 */
import React, { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const getJSON = vi.fn();
const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

import useCalendarAlerts from './useCalendarAlerts';

const alert = (over = {}) => ({
  id: 'a1',
  title: 'Renew the domain',
  dueDate: '2026-10-28',
  dueTime: null,
  link: '',
  note: '',
  status: 'open',
  snoozedUntil: null,
  doneAt: null,
  state: 'open',
  daysUntilDue: 2,
  ...over,
});

const handles = {};
function Copy({ name, enabled = true, onChanged }) {
  const state = useCalendarAlerts({ enabled, onChanged });
  // Kept for the test to call into, after the render, not during it.
  useEffect(() => {
    handles[name] = state;
  });
  return (
    <p data-testid={name}>
      {state.status}:{state.alerts.map((a) => a.state).join(',')}
    </p>
  );
}

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
  getJSON.mockResolvedValue({ ok: true, today: '2026-10-26', alerts: [alert()] });
});

describe('two copies of the hook (the pop-up and the Calendar page)', () => {
  it('tell each other about a change, so neither goes on showing an alert that was finished', async () => {
    const popupChanged = vi.fn();
    const pageChanged = vi.fn();
    render(
      <>
        <Copy name="popup" onChanged={popupChanged} />
        <Copy name="page" onChanged={pageChanged} />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('ready:open'));
    expect(getJSON).toHaveBeenCalledTimes(2);

    // The server now says the alert is done; the pop-up's Done is what made it so.
    getJSON.mockResolvedValue({
      ok: true,
      today: '2026-10-26',
      alerts: [alert({ state: 'done', status: 'done' })],
    });
    sendJSON.mockResolvedValue({ ok: true, alert: alert({ state: 'done', status: 'done' }) });
    await act(async () => {
      await handles.popup.markDone('a1');
    });

    // The copy that changed it ran its own onChanged once and did not read again.
    expect(popupChanged).toHaveBeenCalledTimes(1);
    expect(getJSON).toHaveBeenCalledTimes(3);
    // The other copy read again and ran its onChanged (the page bumps its grid).
    await waitFor(() => expect(screen.getByTestId('page')).toHaveTextContent('ready:done'));
    expect(pageChanged).toHaveBeenCalledTimes(1);
  });

  it('does not make a copy that is switched off (a viewer) read anything', async () => {
    render(
      <>
        <Copy name="on" />
        <Copy name="off" enabled={false} />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('on')).toHaveTextContent('ready'));
    sendJSON.mockResolvedValue({ ok: true, alert: alert({ state: 'done', status: 'done' }) });
    await act(async () => {
      await handles.on.markDone('a1');
    });
    expect(getJSON).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('off')).toHaveTextContent('idle');
  });

  it('tells nobody about a change the server refused', async () => {
    const otherChanged = vi.fn();
    render(
      <>
        <Copy name="a" />
        <Copy name="b" onChanged={otherChanged} />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('b')).toHaveTextContent('ready'));
    sendJSON.mockRejectedValue(new Error('That alert no longer exists.'));
    await act(async () => {
      await expect(handles.a.markDone('a1')).rejects.toThrow(/no longer exists/);
    });
    expect(otherChanged).not.toHaveBeenCalled();
    expect(getJSON).toHaveBeenCalledTimes(2);
  });
});

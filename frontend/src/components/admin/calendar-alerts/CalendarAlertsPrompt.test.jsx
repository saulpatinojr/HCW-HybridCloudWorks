/**
 * The sign-in pop-up for calendar alerts: when it opens and when it does not,
 * what it lists, what its buttons send, how the keyboard moves in it, and that
 * a failed read costs the admin nothing but a small notice.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

import { AdminRoleProvider } from '@/hooks/useAdminRole';
import {
  PROMPT_DAY_KEY,
  PROMPT_SESSION_KEY,
  resetPromptMemory,
  simulatePageReload,
} from '@/lib/calendarAlerts';
import CalendarAlertsPrompt, { promptSummary } from './CalendarAlertsPrompt';

const TODAY = '2026-10-26';

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

const docker = alert({
  id: 'docker-dsos-application',
  title: 'Submit the Docker-Sponsored Open Source application',
  dueDate: '2026-10-30',
  daysUntilDue: 4,
  link: 'https://www.docker.com/community/open-source/application/',
  note: 'Text is ready to paste in the Doc Vault note: Docker DSOS application',
});
const overdue = alert({
  id: 'late',
  title: 'Pay the invoice',
  dueDate: '2026-10-24',
  daysUntilDue: -2,
});
const later = alert({ id: 'later', title: 'Far away', dueDate: '2026-12-01', daysUntilDue: 36 });
const snoozed = alert({
  id: 'sn',
  title: 'Snoozed one',
  state: 'snoozed',
  status: 'snoozed',
  snoozedUntil: '2026-10-29',
});
const done = alert({ id: 'dn', title: 'Finished one', state: 'done', status: 'done' });

const answer = (alerts, today = TODAY) => ({ ok: true, today, alerts, total: alerts.length });

function Where() {
  const { pathname, hash } = useLocation();
  return <p data-testid="where">{pathname + hash}</p>;
}

function renderPrompt({ role = 'editor' } = {}) {
  return render(
    <AdminRoleProvider value={role}>
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <p>The portal itself</p>
                <CalendarAlertsPrompt />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AdminRoleProvider>
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'Calendar alerts' });

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
  resetPromptMemory();
});
afterEach(() => resetPromptMemory());

describe('when it opens', () => {
  it('lists the open alerts due within a week and the overdue ones, soonest first', async () => {
    getJSON.mockResolvedValue(answer([docker, later, snoozed, done, overdue]));
    renderPrompt();

    const box = await screen.findByRole('dialog', { name: 'Calendar alerts' });
    expect(within(box).getByText('2 alerts are overdue or due within 7 days.')).toBeInTheDocument();
    const titles = within(box)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual([
      'Pay the invoice',
      'Submit the Docker-Sponsored Open Source application',
    ]);
    expect(within(box).getByText('2 days overdue')).toBeInTheDocument();
    expect(within(box).getByText('Due in 4 days')).toBeInTheDocument();
    expect(
      within(box).getByText(/Text is ready to paste in the Doc Vault note/)
    ).toBeInTheDocument();
    for (const hidden of ['Far away', 'Snoozed one', 'Finished one']) {
      expect(within(box).queryByText(hidden)).not.toBeInTheDocument();
    }
    expect(getJSON).toHaveBeenCalledWith('cms/calendar-alerts');
  });

  it('is a dialog with a name and a description', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    const box = await screen.findByRole('dialog', { name: 'Calendar alerts' });
    expect(box).toHaveAccessibleDescription('1 alert is overdue or due within 7 days.');
  });

  it("opens the alert's web link in a new tab, safely", async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    const link = await screen.findByRole('link', {
      name: /Open link \(docker\.com\) for “Submit the Docker/,
    });
    expect(link).toHaveAttribute(
      'href',
      'https://www.docker.com/community/open-source/application/'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not open when nothing is due soon', async () => {
    getJSON.mockResolvedValue(answer([later, snoozed, done]));
    renderPrompt();
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('The portal itself')).toBeInTheDocument();
  });

  it('does not open when there are no alerts at all', async () => {
    getJSON.mockResolvedValue(answer([]));
    renderPrompt();
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks nothing of the server, and shows nothing, below the editor role', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt({ role: 'viewer' });
    await act(async () => {});
    expect(getJSON).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('opens for a publisher and a super admin as well', async () => {
    for (const role of ['publisher', 'super_admin']) {
      resetPromptMemory();
      getJSON.mockResolvedValue(answer([docker]));
      const { unmount } = renderPrompt({ role });
      expect(await screen.findByRole('dialog', { name: 'Calendar alerts' })).toBeInTheDocument();
      unmount();
    }
  });
});

describe('once per session and once per day', () => {
  it('does not open a second time in the same session', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    const first = renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    first.unmount();
    simulatePageReload();

    renderPrompt();
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(PROMPT_SESSION_KEY)).toBe('1');
  });

  it('does not open in a new session on the same day', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    const first = renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    first.unmount();
    simulatePageReload();

    window.sessionStorage.removeItem(PROMPT_SESSION_KEY);
    renderPrompt();
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(window.localStorage.getItem(PROMPT_DAY_KEY)).toBe(TODAY);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens again in a new session on the next day', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    const first = renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    first.unmount();
    simulatePageReload();

    window.sessionStorage.removeItem(PROMPT_SESSION_KEY);
    getJSON.mockResolvedValue(answer([docker], '2026-10-27'));
    renderPrompt();
    expect(await screen.findByRole('dialog', { name: 'Calendar alerts' })).toBeInTheDocument();
    expect(window.localStorage.getItem(PROMPT_DAY_KEY)).toBe('2026-10-27');
  });

  it('does not use up the day when nothing was due', async () => {
    getJSON.mockResolvedValue(answer([later]));
    const first = renderPrompt();
    await act(async () => {});
    first.unmount();
    simulatePageReload();
    expect(window.localStorage.getItem(PROMPT_DAY_KEY)).toBeNull();

    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    expect(await screen.findByRole('dialog', { name: 'Calendar alerts' })).toBeInTheDocument();
  });
});

describe('Done and Snooze', () => {
  it('marks an alert done and takes it off the list', async () => {
    getJSON.mockResolvedValue(answer([docker, overdue]));
    sendJSON.mockResolvedValue({ ok: true, alert: { ...overdue, status: 'done', state: 'done' } });
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });

    fireEvent.click(screen.getByRole('button', { name: 'Mark “Pay the invoice” done' }));

    await waitFor(() => expect(screen.queryByText('Pay the invoice')).not.toBeInTheDocument());
    expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts/late', 'PATCH', { done: true });
    expect(
      within(dialog()).getByText('1 alert is overdue or due within 7 days.')
    ).toBeInTheDocument();
  });

  it('says so when the last one is dealt with', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    sendJSON.mockResolvedValue({ ok: true, alert: { ...docker, status: 'done', state: 'done' } });
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    fireEvent.click(screen.getByRole('button', { name: /Mark “Submit the Docker.*” done/ }));
    expect(
      await screen.findByText('Nothing else is due. You are all caught up.')
    ).toBeInTheDocument();
  });

  it.each([
    ['1 day', /for 1 day$/, 1],
    ['3 days', /for 3 days$/, 3],
    ['next week', /until next week$/, 7],
  ])('snoozes for %s', async (_label, name, days) => {
    getJSON.mockResolvedValue(answer([docker]));
    sendJSON.mockResolvedValue({
      ok: true,
      alert: { ...docker, status: 'snoozed', state: 'snoozed', snoozedUntil: '2026-11-02' },
    });
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });

    const group = screen.getByRole('group', { name: /Snooze “Submit the Docker/ });
    fireEvent.click(within(group).getByRole('button', { name }));

    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/calendar-alerts/docker-dsos-application',
        'PATCH',
        { snoozeDays: days }
      )
    );
    expect(
      await screen.findByText('Nothing else is due. You are all caught up.')
    ).toBeInTheDocument();
  });

  it('keeps the alert and says why when the server refuses the change', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    sendJSON.mockRejectedValue(new Error('That alert no longer exists.'));
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });

    const button = screen.getByRole('button', { name: /Mark “Submit the Docker.*” done/ });
    fireEvent.click(button);

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'That change was not saved',
      description: 'That alert no longer exists.',
      variant: 'destructive',
    });
    expect(
      screen.getByText('Submit the Docker-Sponsored Open Source application')
    ).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('cannot be pressed twice while a change is on its way', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    let finish;
    sendJSON.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });

    const button = screen.getByRole('button', { name: /Mark “Submit the Docker.*” done/ });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(sendJSON).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({ ok: true, alert: { ...docker, state: 'done', status: 'done' } })
    );
  });
});

describe('moving on from the pop-up', () => {
  it('"Close for today" closes it, and nothing is changed', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    fireEvent.click(screen.getByRole('button', { name: 'Close for today' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('Escape closes it', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    const box = await screen.findByRole('dialog', { name: 'Calendar alerts' });
    fireEvent.keyDown(box, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('"All alerts" opens the alerts panel on the Calendar page and closes the pop-up', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    fireEvent.click(screen.getByRole('button', { name: 'All alerts' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/calendar#alerts');
  });

  it('opens a page in the portal through the router, and closes the pop-up', async () => {
    getJSON.mockResolvedValue(answer([alert({ link: '/admin/health' })]));
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    fireEvent.click(screen.getByRole('button', { name: 'Open page: “Renew the domain”' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/health');
  });

  it('offers no link button for a link it would not open', async () => {
    getJSON.mockResolvedValue(answer([alert({ link: 'javascript:alert(1)' })]));
    renderPrompt();
    await screen.findByRole('dialog', { name: 'Calendar alerts' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open page/ })).not.toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  const tabbables = (box) =>
    [...box.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(
      (node) => !node.disabled && node.tabIndex >= 0
    );

  it('moves focus to the dialog itself when it opens, not to a button that changes something', async () => {
    getJSON.mockResolvedValue(answer([docker, overdue]));
    renderPrompt();
    const box = await screen.findByRole('dialog', { name: 'Calendar alerts' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(document.activeElement.tagName).not.toBe('BUTTON');
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('does not let Enter or Space typed as it opens finish an alert', async () => {
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    const box = await screen.findByRole('dialog', { name: 'Calendar alerts' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    fireEvent.keyUp(document.activeElement, { key: ' ' });
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('keeps Tab and Shift+Tab inside the dialog, wrapping at both ends', async () => {
    getJSON.mockResolvedValue(answer([docker, overdue]));
    renderPrompt();
    const box = await screen.findByRole('dialog', { name: 'Calendar alerts' });
    await waitFor(() => expect(box.contains(document.activeElement)).toBe(true));

    const stops = tabbables(box);
    expect(stops.length).toBeGreaterThan(5);
    const [first] = stops;
    const last = stops.at(-1);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('when the read fails', () => {
  it('leaves the portal alone and shows a small notice', async () => {
    getJSON.mockRejectedValue(new Error('timed out'));
    renderPrompt();
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Calendar alerts could not be loaded just now.');
    expect(notice).toHaveTextContent('Signing in worked');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('The portal itself')).toBeInTheDocument();
    expect(notice).not.toHaveTextContent('timed out');
  });

  it("reads it as a failure when the answer is not the server's shape", async () => {
    getJSON.mockResolvedValue('<html>502 Bad Gateway</html>');
    renderPrompt();
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('tries again on request, and opens if something is due then', async () => {
    getJSON.mockRejectedValueOnce(new Error('503'));
    getJSON.mockResolvedValue(answer([docker]));
    renderPrompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Calendar alerts' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('goes away when dismissed', async () => {
    getJSON.mockRejectedValue(new Error('503'));
    renderPrompt();
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('promptSummary', () => {
  it('counts what is listed, in the singular and the plural', () => {
    expect(promptSummary(0)).toBe('Nothing else is due. You are all caught up.');
    expect(promptSummary(1)).toBe('1 alert is overdue or due within 7 days.');
    expect(promptSummary(3)).toBe('3 alerts are overdue or due within 7 days.');
  });
});

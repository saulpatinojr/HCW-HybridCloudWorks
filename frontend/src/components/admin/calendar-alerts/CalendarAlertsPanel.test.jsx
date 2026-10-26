/**
 * The alerts panel on the Calendar page: the whole list with its filters, and
 * add, edit, done, snooze, delete and the calendar download, each as the
 * server is told.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { runAxe } from '@/test-utils/axe';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();
const downloadIcs = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/calendarAlertsIcs', async (importOriginal) => ({
  ...(await importOriginal()),
  downloadIcs: (...args) => downloadIcs(...args),
}));

import CalendarAlertsPanel from './CalendarAlertsPanel';
import useCalendarAlerts from './useCalendarAlerts';

const TODAY = '2026-10-26';

const alert = (over = {}) => ({
  id: 'a1',
  title: 'Renew the domain',
  dueDate: '2026-11-20',
  dueTime: null,
  link: '',
  note: '',
  status: 'open',
  snoozedUntil: null,
  doneAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  state: 'open',
  daysUntilDue: 25,
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
const domain = alert();
const snoozed = alert({
  id: 'sn',
  title: 'Snoozed one',
  state: 'snoozed',
  status: 'snoozed',
  snoozedUntil: '2026-10-29',
  dueDate: '2026-10-28',
  daysUntilDue: 2,
});
const done = alert({
  id: 'dn',
  title: 'Finished one',
  state: 'done',
  status: 'done',
  dueDate: '2026-10-20',
  daysUntilDue: -6,
});

const answer = (alerts) => ({ ok: true, today: TODAY, alerts, total: alerts.length });

function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().hash}</p>;
}

/** The panel with the real alerts hook, as the Calendar page holds them. */
function Harness({ onChanged }) {
  const state = useCalendarAlerts({ enabled: true, onChanged });
  return <CalendarAlertsPanel state={state} />;
}

function renderPanel({ onChanged, path = '/admin/calendar' } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Harness onChanged={onChanged} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const rows = () =>
  within(screen.getByRole('list', { name: 'Calendar alerts' })).getAllByRole('listitem');
const titles = () =>
  rows().map((row) => within(row).getByRole('heading', { level: 3 }).textContent);
const ready = () => screen.findByRole('list', { name: 'Calendar alerts' });

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
  downloadIcs.mockReset();
  getJSON.mockResolvedValue(answer([docker, domain, snoozed, done]));
});

describe('the list', () => {
  it('is a labelled section on the Calendar, opening on the open alerts, soonest first', async () => {
    renderPanel();
    await ready();
    expect(screen.getByRole('region', { name: 'Calendar alerts' })).toHaveAttribute('id', 'alerts');
    expect(titles()).toEqual([
      'Submit the Docker-Sponsored Open Source application',
      'Renew the domain',
    ]);
    expect(screen.getByText('Due in 4 days')).toBeInTheDocument();
    expect(screen.getByText(/Text is ready to paste in the Doc Vault note/)).toBeInTheDocument();
  });

  it('says what each filter would show', async () => {
    renderPanel();
    await ready();
    const group = screen.getByRole('group', { name: 'Show alerts' });
    for (const name of ['Open (2)', 'Due soon (1)', 'Snoozed (1)', 'Done (1)', 'All (4)']) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(group).getByRole('button', { name: 'Open (2)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it.each([
    ['Due soon (1)', ['Submit the Docker-Sponsored Open Source application']],
    ['Snoozed (1)', ['Snoozed one']],
    ['Done (1)', ['Finished one']],
    [
      'All (4)',
      [
        'Finished one',
        'Snoozed one',
        'Submit the Docker-Sponsored Open Source application',
        'Renew the domain',
      ],
    ],
  ])('the %s filter shows its alerts', async (name, expected) => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name }));
    expect(titles()).toEqual(expected);
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows when a snoozed alert comes back, and that a finished one is done', async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'All (4)' }));
    expect(screen.getByText('Snoozed until Thu, 29 Oct 2026')).toBeInTheDocument();
    const finished = rows().find((row) => within(row).queryByText('Finished one'));
    expect(within(finished).getByText('Done')).toBeInTheDocument();
  });

  it('says so when a filter is empty, and when there are no alerts at all', async () => {
    getJSON.mockResolvedValue(answer([domain]));
    const first = renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Done (0)' }));
    expect(screen.getByText('Nothing matches this filter')).toBeInTheDocument();
    first.unmount();

    getJSON.mockResolvedValue(answer([]));
    renderPanel();
    expect(await screen.findByText('No alerts yet')).toBeInTheDocument();
    expect(screen.getByText(/Press Add alert/)).toBeInTheDocument();
  });

  it("opens the alert's web link in a new tab, naming the site, and a portal page through the router", async () => {
    getJSON.mockResolvedValue(
      answer([
        docker,
        alert({
          id: 'p',
          title: 'Check health',
          link: '/admin/health',
          dueDate: '2026-10-27',
          daysUntilDue: 1,
        }),
      ])
    );
    renderPanel();
    const link = await screen.findByRole('link', {
      name: /Open link \(docker\.com\) for “Submit the Docker/,
    });
    expect(link).toHaveAttribute(
      'href',
      'https://www.docker.com/community/open-source/application/'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(screen.getByRole('button', { name: 'Open page: “Check health”' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/health');
  });

  it('brings itself into view when the address ends in #alerts', async () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderPanel({ path: '/admin/calendar#alerts' });
    await ready();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    delete window.HTMLElement.prototype.scrollIntoView;
  });

  it('has no accessibility violations', async () => {
    const { container } = renderPanel();
    await ready();
    const results = await runAxe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('changing an alert', () => {
  it('marks it done, takes it off the open list and tells the page it changed', async () => {
    const onChanged = vi.fn();
    sendJSON.mockResolvedValue({ ok: true, alert: { ...docker, status: 'done', state: 'done' } });
    renderPanel({ onChanged });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Mark “Submit the Docker.*” done/ }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/calendar-alerts/docker-dsos-application',
        'PATCH',
        {
          done: true,
        }
      )
    );
    await waitFor(() => expect(titles()).toEqual(['Renew the domain']));
    expect(toast).toHaveBeenCalledWith({ title: 'Marked done' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reopens a finished alert', async () => {
    sendJSON.mockResolvedValue({ ok: true, alert: { ...done, status: 'open', state: 'open' } });
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen “Finished one”' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts/dn', 'PATCH', { done: false })
    );
    expect(toast).toHaveBeenCalledWith({ title: 'Reopened' });
  });

  it('snoozes for the days chosen, and brings a snoozed alert back now', async () => {
    sendJSON.mockResolvedValue({
      ok: true,
      alert: { ...domain, status: 'snoozed', state: 'snoozed', snoozedUntil: '2026-10-29' },
    });
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Snooze “Renew the domain” for 3 days' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts/a1', 'PATCH', { snoozeDays: 3 })
    );

    sendJSON.mockResolvedValue({ ok: true, alert: { ...snoozed, status: 'open', state: 'open' } });
    fireEvent.click(screen.getByRole('button', { name: 'Snoozed (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bring back now: “Snoozed one”' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenLastCalledWith('cms/calendar-alerts/sn', 'PATCH', {
        snoozeDays: 0,
      })
    );
  });

  it('offers no snooze on a finished alert', async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }));
    expect(screen.queryByRole('group', { name: /Snooze/ })).not.toBeInTheDocument();
  });

  it('says why when the server refuses, keeps the alert, and does not tell the page it changed', async () => {
    const onChanged = vi.fn();
    sendJSON.mockRejectedValue(new Error('That alert no longer exists.'));
    renderPanel({ onChanged });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Mark “Submit the Docker.*” done/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'That change was not saved',
      description: 'That alert no longer exists.',
      variant: 'destructive',
    });
    expect(titles()).toContain('Submit the Docker-Sponsored Open Source application');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('adding and editing', () => {
  it('adds an alert through the form and lists it', async () => {
    const onChanged = vi.fn();
    const created = alert({
      id: 'new1',
      title: 'Call the registrar',
      dueDate: '2026-10-27',
      daysUntilDue: 1,
    });
    sendJSON.mockResolvedValue({ ok: true, alert: created });
    renderPanel({ onChanged });
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    const form = screen.getByRole('form', { name: 'Add alert' });
    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: 'Call the registrar' },
    });
    fireEvent.change(within(form).getByLabelText('Due date (UTC day)'), {
      target: { value: '2026-10-27' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add alert' }));

    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts', 'POST', {
      title: 'Call the registrar',
      dueDate: '2026-10-27',
      dueTime: null,
      link: '',
      note: '',
    });
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(titles()[0]).toBe('Call the registrar');
    expect(toast).toHaveBeenCalledWith({ title: 'Alert added' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("starts the form on the server's UTC day", async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    expect(screen.getByLabelText('Due date (UTC day)')).toHaveValue(TODAY);
  });

  it("keeps the form open and shows the server's sentence when it refuses", async () => {
    sendJSON.mockRejectedValue(
      new Error('There are already 300 alerts. Delete some finished ones first.')
    );
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'One more' } });
    fireEvent.click(within(screen.getByRole('form')).getByRole('button', { name: 'Add alert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Delete some finished ones first.');
    expect(screen.getByRole('form', { name: 'Add alert' })).toBeInTheDocument();
  });

  it('edits an alert in the same form, starting from what it holds', async () => {
    sendJSON.mockResolvedValue({ ok: true, alert: { ...domain, title: 'Renewed' } });
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Renew the domain”' }));
    const form = screen.getByRole('form', { name: 'Edit alert' });
    expect(within(form).getByLabelText('Title')).toHaveValue('Renew the domain');
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Renewed' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts/a1', 'PATCH', {
        title: 'Renewed',
        dueDate: '2026-11-20',
        dueTime: null,
        link: '',
        note: '',
      })
    );
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(toast).toHaveBeenCalledWith({ title: 'Alert saved' });
  });

  it('closes the form on Cancel without sending anything', async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
  });
});

describe('deleting', () => {
  it('asks first, naming the alert, and then deletes it', async () => {
    sendJSON.mockResolvedValue({ ok: true, id: 'a1' });
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Renew the domain”' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText('Delete this alert?')).toBeInTheDocument();
    expect(within(confirm).getByText(/“Renew the domain” will be removed/)).toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete alert' }));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts/a1', 'DELETE'));
    await waitFor(() =>
      expect(titles()).toEqual(['Submit the Docker-Sponsored Open Source application'])
    );
    expect(toast).toHaveBeenCalledWith({ title: 'Alert deleted' });
  });

  it('deletes nothing when the question is cancelled', async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Renew the domain”' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sendJSON).not.toHaveBeenCalled();
    expect(titles()).toContain('Renew the domain');
  });
});

describe('the calendar download', () => {
  it('builds the file from the alerts that are not done', async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Download .ics' }));
    expect(downloadIcs).toHaveBeenCalledTimes(1);
    const [[text]] = downloadIcs.mock.calls;
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('UID:docker-dsos-application@');
    expect(text).toContain('UID:a1@');
    expect(text).not.toContain('UID:dn@');
  });

  it('says so, and throws nothing from the click, when the file cannot be made', async () => {
    downloadIcs.mockImplementation(() => {
      throw new Error('blocked');
    });
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Download .ics' }));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'The calendar file could not be made',
        variant: 'destructive',
      })
    );
  });

  it('warns that an online calendar keeps what it imports', async () => {
    renderPanel();
    await ready();
    expect(screen.getByText(/no longer private to this portal/)).toBeInTheDocument();
  });

  it('is off when every alert is done', async () => {
    getJSON.mockResolvedValue(answer([done]));
    renderPanel();
    await screen.findByText('Nothing matches this filter');
    expect(screen.getByRole('button', { name: 'Download .ics' })).toBeDisabled();
  });
});

describe('when the list cannot be read', () => {
  it('says the role is not enough on a 403', async () => {
    getJSON.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role cannot open calendar alerts. They need the editor role or above.'
    );
  });

  it('asks the admin to sign in again on a 401', async () => {
    getJSON.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your sign-in has expired');
  });

  it('offers Try again for anything else, and shows the list when it works', async () => {
    getJSON.mockRejectedValueOnce(new Error('timed out'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('timed out')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await ready()).toBeInTheDocument();
  });
});

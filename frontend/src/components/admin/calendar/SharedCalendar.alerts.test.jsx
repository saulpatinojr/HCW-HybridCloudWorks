/**
 * The owner's calendar alerts on the shared Calendar: an "Alert" chip on the
 * due day, its own actions in the preview, no scheduling or publishing, and
 * a grid that reads again when the alerts panel changes an alert.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import SharedCalendar from './SharedCalendar';
import CalendarItemChip from './CalendarItemChip';
import { KINDS, findConflicts, isReschedulable, itemStatus, kindMeta } from './calendarModel';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const TODAY = new Date(2026, 9, 26, 12); // 26 October 2026, local noon

const docker = {
  id: 'alert:docker-dsos-application',
  kind: 'alert',
  title: 'Submit the Docker-Sponsored Open Source application',
  start: '2026-10-30T00:00:00.000Z',
  end: null,
  allDay: true,
  status: 'open',
  href: '/admin/calendar#alerts',
  sourceId: 'docker-dsos-application',
  sourceCollection: 'admin_config',
  meta: {
    note: 'Text is ready to paste in the Doc Vault note: Docker DSOS application',
    link: 'https://www.docker.com/community/open-source/application/',
    dueTime: null,
    snoozedUntil: null,
  },
};
const content = {
  id: 'content:c1',
  kind: 'content',
  title: 'Landing zones',
  start: new Date(2026, 9, 28, 9).toISOString(),
  allDay: false,
  status: 'scheduled',
  href: '/admin/review-queue/c1?source=content',
  sourceId: 'c1',
  sourceCollection: 'content',
  meta: { provider: 'Azure', publishTarget: 'blog' },
};

function Where() {
  const { pathname, hash } = useLocation();
  return <p data-testid="where">{pathname + hash}</p>;
}

function renderCalendar(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/admin/calendar']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SharedCalendar today={TODAY} {...props} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const calendarCalls = () =>
  getJSON.mock.calls.map(([route]) => route).filter((route) => route.startsWith('cms/calendar?'));
const chip = () =>
  screen.findByRole('button', { name: /Alert: Submit the Docker-Sponsored.*All day/ });

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
  getJSON.mockResolvedValue({ ok: true, items: [docker, content], warnings: [] });
  sendJSON.mockResolvedValue({ ok: true, alert: docker });
});

describe('the alert kind', () => {
  it('has its own word, bell icon and colour, beside the others', () => {
    expect(KINDS).toContain('alert');
    expect(kindMeta('alert')).toMatchObject({ label: 'Alert' });
    expect(kindMeta('alert').chip).not.toBe(kindMeta('content').chip);
  });

  it('reads open, snoozed and done as statuses', () => {
    expect(itemStatus({ status: 'open' })).toMatchObject({ label: 'Open' });
    expect(itemStatus({ status: 'snoozed' })).toMatchObject({ label: 'Snoozed' });
    expect(itemStatus({ status: 'done' })).toMatchObject({ label: 'Done', tone: 'ok' });
  });

  it('is never rescheduled by a drag, and never collides with a publish', () => {
    expect(isReschedulable({ ...docker })).toBe(false);
    expect(isReschedulable({ ...docker, status: 'scheduled' })).toBe(false);
    const timedAlert = { ...docker, allDay: false, start: content.start };
    expect(findConflicts([content, timedAlert]).size).toBe(0);
  });

  it('draws as a button that cannot be dragged', () => {
    render(<CalendarItemChip item={docker} onSelect={() => {}} />);
    const button = screen.getByRole('button', { name: /Alert: Submit the Docker/ });
    expect(button).toHaveAttribute('draggable', 'false');
    expect(button).toHaveAttribute('data-kind', 'alert');
  });
});

describe('on the grid', () => {
  it('shows an alert on its due day beside the scheduled content, with the word Alert', async () => {
    renderCalendar();
    expect(await chip()).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Content: Landing zones, 9:00 AM/ })
    ).toBeInTheDocument();
    expect(
      new URLSearchParams(calendarCalls()[0].slice('cms/calendar?'.length)).get('kinds')
    ).toBeNull();
  });

  it('can be shown alone or hidden with the Kinds filter', async () => {
    renderCalendar();
    await chip();
    const kinds = screen.getByRole('group', { name: 'Kinds' });
    fireEvent.click(within(kinds).getByRole('button', { name: 'Alert' }));
    expect(
      screen.queryByRole('button', { name: /Content: Landing zones/ })
    ).not.toBeInTheDocument();
    expect(await chip()).toBeInTheDocument();
  });

  it('can be filtered by its own statuses', async () => {
    getJSON.mockResolvedValue({
      ok: true,
      items: [
        docker,
        { ...docker, id: 'alert:d2', sourceId: 'd2', title: 'Finished thing', status: 'done' },
      ],
      warnings: [],
    });
    renderCalendar();
    await chip();
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: 'done' } });
    expect(
      screen.queryByRole('button', { name: /Alert: Submit the Docker/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alert: Finished thing/ })).toBeInTheDocument();
  });

  it('names the source when the alerts could not be read, and still shows the rest', async () => {
    getJSON.mockResolvedValue({
      ok: true,
      items: [content],
      warnings: ['alert: could not be read (Error)'],
    });
    renderCalendar();
    expect(await screen.findByText(/alert: could not be read \(Error\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Content: Landing zones/ })).toBeInTheDocument();
  });
});

describe('opening an alert', () => {
  it("shows the alert's own actions and none of a content item's", async () => {
    renderCalendar();
    fireEvent.click(await chip());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Alert · /)).toBeInTheDocument();
    expect(within(dialog).getByText('Open')).toBeInTheDocument(); // the status badge
    expect(
      within(dialog).getByText(/Text is ready to paste in the Doc Vault note/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /Mark “Submit the Docker.*” done/ })
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('group', { name: /Snooze “Submit the Docker/ })
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /Edit “Submit the Docker/ })
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /Delete “Submit the Docker/ })
    ).toBeInTheDocument();
    for (const forbidden of [
      /Reschedule/,
      /Unschedule/,
      /Schedule social/,
      /Retry on Publish/,
      /Edit \/ reschedule/,
      /Cancel post/,
    ]) {
      expect(within(dialog).queryByRole('button', { name: forbidden })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('link', { name: forbidden })).not.toBeInTheDocument();
    }
  });

  it("opens the alert's web link in a new tab, naming the site", async () => {
    renderCalendar();
    fireEvent.click(await chip());
    const dialog = await screen.findByRole('dialog');
    const link = within(dialog).getByRole('link', { name: /Open link \(docker\.com\)/ });
    expect(link).toHaveAttribute(
      'href',
      'https://www.docker.com/community/open-source/application/'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('goes to a portal page through the router and closes', async () => {
    getJSON.mockResolvedValue({
      ok: true,
      items: [{ ...docker, meta: { ...docker.meta, link: '/admin/health' } }],
      warnings: [],
    });
    renderCalendar();
    fireEvent.click(await chip());
    fireEvent.click(await screen.findByRole('button', { name: /Open page: “Submit the Docker/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/health');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('marks it done through the alerts route, then reads the calendar again', async () => {
    const onChanged = vi.fn();
    renderCalendar({ onChanged });
    fireEvent.click(await chip());
    fireEvent.click(await screen.findByRole('button', { name: /Mark “Submit the Docker.*” done/ }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/calendar-alerts/docker-dsos-application',
        'PATCH',
        {
          done: true,
        }
      )
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
    expect(onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ title: 'Marked done' });
    expect(postJSON).not.toHaveBeenCalled();
  });

  it.each([
    [/for 1 day$/, 1],
    [/for 3 days$/, 3],
    [/until next week$/, 7],
  ])('snoozes through the alerts route (%s)', async (name, days) => {
    renderCalendar();
    fireEvent.click(await chip());
    const group = await screen.findByRole('group', { name: /Snooze “Submit the Docker/ });
    fireEvent.click(within(group).getByRole('button', { name }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/calendar-alerts/docker-dsos-application',
        'PATCH',
        {
          snoozeDays: days,
        }
      )
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
  });

  it('reopens a finished alert, and offers it no snooze', async () => {
    getJSON.mockResolvedValue({ ok: true, items: [{ ...docker, status: 'done' }], warnings: [] });
    renderCalendar();
    fireEvent.click(await chip());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('group', { name: /Snooze/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Reopen “Submit the Docker/ }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/calendar-alerts/docker-dsos-application',
        'PATCH',
        {
          done: false,
        }
      )
    );
  });

  it('edits it in the same form and reads again', async () => {
    renderCalendar();
    fireEvent.click(await chip());
    fireEvent.click(await screen.findByRole('button', { name: /Edit “Submit the Docker/ }));
    const form = screen.getByRole('form', { name: 'Edit alert' });
    expect(within(form).getByLabelText('Due date (UTC day)')).toHaveValue('2026-10-30');
    fireEvent.change(within(form).getByLabelText('Note (optional)'), {
      target: { value: 'Pasted.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/calendar-alerts/docker-dsos-application',
        'PATCH',
        {
          title: 'Submit the Docker-Sponsored Open Source application',
          dueDate: '2026-10-30',
          dueTime: null,
          link: 'https://www.docker.com/community/open-source/application/',
          note: 'Pasted.',
        }
      )
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
  });

  it('deletes it only after asking, then reads again', async () => {
    renderCalendar();
    fireEvent.click(await chip());
    fireEvent.click(await screen.findByRole('button', { name: /Delete “Submit the Docker/ }));
    const confirm = (await screen.findAllByRole('dialog')).at(-1);
    expect(within(confirm).getByText('Delete this alert?')).toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete alert' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/calendar-alerts/docker-dsos-application', 'DELETE')
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
  });

  it('says why when the server refuses, and does not read again', async () => {
    sendJSON.mockRejectedValue(new Error('That alert no longer exists.'));
    renderCalendar();
    fireEvent.click(await chip());
    fireEvent.click(await screen.findByRole('button', { name: /Mark “Submit the Docker.*” done/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'That change was not saved',
      description: 'That alert no longer exists.',
      variant: 'destructive',
    });
    expect(calendarCalls()).toHaveLength(1);
  });
});

describe('when something outside the grid changes an alert', () => {
  it('reads the calendar again when the refresh token changes, and not otherwise', async () => {
    const view = renderCalendar({ refreshToken: 0 });
    await chip();
    expect(calendarCalls()).toHaveLength(1);

    view.rerender(
      <MemoryRouter initialEntries={['/admin/calendar']}>
        <Routes>
          <Route path="*" element={<SharedCalendar today={TODAY} refreshToken={0} />} />
        </Routes>
      </MemoryRouter>
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calendarCalls()).toHaveLength(1);

    view.rerender(
      <MemoryRouter initialEntries={['/admin/calendar']}>
        <Routes>
          <Route path="*" element={<SharedCalendar today={TODAY} refreshToken={1} />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
  });
});

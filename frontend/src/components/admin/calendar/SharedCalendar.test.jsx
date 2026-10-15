/**
 * The shared Calendar (ADR 0033 §4). What must hold: it reads the window the
 * view draws, shows every kind with its icon and word, says which sources
 * failed, opens an item to its actions, schedules from the dialog and
 * REFETCHES afterwards (the bug the old page had), refuses the past before
 * the server does, and embeds with a kind filter and a caller's selection.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import SharedCalendar from './SharedCalendar';

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
vi.mock('react-router', async () => {
  const React_ = await vi.importActual('react');
  return {
    Link: ({ to, children, ...rest }) => React_.createElement('a', { href: to, ...rest }, children),
  };
});

const TODAY = new Date(2026, 9, 3, 12); // 3 October 2026, local noon
const at = (d, h) => new Date(2026, 9, d, h).toISOString();

const ITEMS = [
  {
    id: 'content:c1',
    kind: 'content',
    title: 'Landing zones',
    start: at(10, 9),
    allDay: false,
    status: 'scheduled',
    href: '/admin/review-queue/c1?source=content',
    sourceId: 'c1',
    sourceCollection: 'content',
    meta: { provider: 'Azure', publishTarget: 'blog' },
  },
  {
    id: 'content:c2',
    kind: 'content',
    title: 'Broken publish',
    start: at(1, 9),
    allDay: false,
    status: 'failed',
    href: '/admin/review-queue/c2?source=content',
    sourceId: 'c2',
    sourceCollection: 'content',
    meta: { error: 'The scheduled time passed and the content is not live.' },
  },
  {
    id: 'newsletter:issue-2026-10-06',
    kind: 'newsletter',
    title: 'Weekly',
    start: at(6, 14),
    allDay: false,
    status: 'scheduled',
    href: '/admin/newsletter-hub?tab=published&issue=issue-2026-10-06',
    sourceId: 'issue-2026-10-06',
    sourceCollection: 'newsletters',
    meta: {},
  },
  {
    id: 'social:s1',
    kind: 'social',
    title: 'Hello LinkedIn',
    start: at(10, 9),
    allDay: false,
    status: 'scheduled',
    href: '/admin/social-hub?tab=queue',
    sourceId: 's1',
    sourceCollection: 'social_posts',
    meta: { platforms: ['linkedin'], caption: 'Hello LinkedIn', contentId: 'c1' },
  },
  {
    id: 'speaking:e1',
    kind: 'speaking',
    title: 'KubeCon',
    start: '2026-10-20T00:00:00.000Z',
    allDay: true,
    status: 'accepted',
    href: '/admin/speaking',
    sourceId: 'e1',
    sourceCollection: 'speakerevents',
    meta: {},
  },
];

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
  getJSON.mockResolvedValue({ ok: true, items: ITEMS, warnings: ['ambassador: not provisioned'] });
  postJSON.mockResolvedValue({ success: true });
  sendJSON.mockResolvedValue({ success: true });
});

const calendarCalls = () =>
  getJSON.mock.calls.map(([route]) => route).filter((route) => route.startsWith('cms/calendar?'));

describe('reading', () => {
  it('asks for the month window, shows every kind with icon and word, and names failed sources', async () => {
    render(<SharedCalendar today={TODAY} />);
    expect(
      await screen.findByRole('button', { name: /Content: Landing zones, 9:00 AM/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Newsletter: Weekly/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Social: Hello LinkedIn, 9:00 AM, shares a slot/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Speaking: KubeCon, All day/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Content: Broken publish.*failed/ })
    ).toBeInTheDocument();
    expect(screen.getByText(/ambassador: not provisioned/)).toBeInTheDocument();
    const [route] = calendarCalls();
    const params = new URLSearchParams(route.slice('cms/calendar?'.length));
    expect(new Date(params.get('from')) <= new Date(2026, 9, 1)).toBe(true);
    expect(new Date(params.get('to')) > new Date(2026, 9, 31)).toBe(true);
    expect(params.get('kinds')).toBeNull();
    expect(screen.getByText(/Times in /)).toBeInTheDocument();
  });

  it('filters by kind client-side, and moves to the next month with a new read', async () => {
    render(<SharedCalendar today={TODAY} />);
    await screen.findByRole('button', { name: /Content: Landing zones/ });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Kinds' })).getByRole('button', { name: 'Social' })
    );
    expect(
      screen.queryByRole('button', { name: /Content: Landing zones/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Social: Hello LinkedIn/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
    expect(
      new URLSearchParams(calendarCalls()[1].slice('cms/calendar?'.length)).get('from')
    ).toMatch(/^2026-1[01]-/);
  });

  it('says what went wrong and offers a retry when the read fails', async () => {
    getJSON.mockRejectedValueOnce(new Error('boom'));
    render(<SharedCalendar today={TODAY} />);
    expect(await screen.findByText('The calendar could not be read')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(
      await screen.findByRole('button', { name: /Content: Landing zones/ })
    ).toBeInTheDocument();
  });

  it('embeds narrowed to one kind and hands a chosen item to the caller instead of opening the dialog', async () => {
    const onSelectItem = vi.fn();
    render(<SharedCalendar today={TODAY} kinds={['newsletter']} onSelectItem={onSelectItem} />);
    const chip = await screen.findByRole('button', { name: /Newsletter: Weekly/ });
    expect(new URLSearchParams(calendarCalls()[0].slice('cms/calendar?'.length)).get('kinds')).toBe(
      'newsletter'
    );
    expect(screen.queryByRole('group', { name: 'Kinds' })).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'issue-2026-10-06' })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('acting', () => {
  it('opens an item to its actions; a failed publish shows the reason and a Retry link', async () => {
    render(<SharedCalendar today={TODAY} />);
    fireEvent.click(await screen.findByRole('button', { name: /Content: Broken publish/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/scheduled time passed/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Retry on Publish/ })).toHaveAttribute(
      'href',
      '/admin/publish'
    );
    expect(within(dialog).getByRole('link', { name: /Edit/ })).toHaveAttribute(
      'href',
      '/admin/editor/c2'
    );
    expect(within(dialog).getByRole('link', { name: /Schedule social/ })).toHaveAttribute(
      'href',
      '/admin/social-hub?tab=compose&contentId=c2'
    );
  });

  it('unschedules after confirming, then refetches', async () => {
    render(<SharedCalendar today={TODAY} />);
    fireEvent.click(await screen.findByRole('button', { name: /Content: Landing zones/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unschedule' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unschedule', hidden: false }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('unscheduleContent', { contentId: 'c1' })
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
  });

  it('schedules from the quick-create dialog with the day prefilled, refuses the past, and refetches', async () => {
    const content = { id: 'c9', Title: 'New piece', contentStatus: 'approved', type: 'blog' };
    render(<SharedCalendar today={TODAY} unscheduled={[content]} />);
    await screen.findByRole('button', { name: /Content: Landing zones/ });
    fireEvent.click(
      screen.getByRole('button', { name: 'Schedule something on Thursday, October 15' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Day')).toHaveValue('2026-10-15');
    fireEvent.change(within(dialog).getByLabelText('Content'), { target: { value: 'c9' } });
    // The past is refused here, before the server sees it.
    fireEvent.change(within(dialog).getByLabelText('Day'), { target: { value: '2020-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/has passed/);
    expect(postJSON).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Day'), { target: { value: '2099-10-15' } });
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('saveContentSchedule', {
        contentId: 'c9',
        instantPublish: false,
        scheduledPublishDate: new Date(2099, 9, 15, 10, 30).toISOString(),
        publishTarget: 'blog',
      })
    );
    await waitFor(() => expect(calendarCalls()).toHaveLength(2));
  });

  it('edits a social post from its preview and pushes the change', async () => {
    sendJSON.mockResolvedValue({ success: true, publer: { push: 'change-feed', postIds: ['p1'] } });
    render(<SharedCalendar today={TODAY} />);
    fireEvent.click(await screen.findByRole('button', { name: /Social: Hello LinkedIn/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit \/ reschedule/ }));
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/social-posts/s1', 'PATCH', {
        caption: 'Hello again',
      })
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Post updated' }));
  });
});

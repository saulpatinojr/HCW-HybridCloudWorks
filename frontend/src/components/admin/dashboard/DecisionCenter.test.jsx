/**
 * The dashboard's Decision Center (#1013, #1014): six tabs with counts, the
 * selected tab kept in `?decisions=` so Back from an item returns to it, rows
 * linked through lib/itemLinks.js, an empty state per tab, and the read
 * failing whole or source by source.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DecisionCenter from './DecisionCenter';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

const item = (over) => ({
  priority: 'normal',
  detail: '',
  waitingSince: '2026-10-08T09:00:00.000Z',
  ...over,
});

const ITEMS = [
  item({
    id: 'content:sent-1',
    category: 'queues',
    kind: 'blog',
    title: 'Sent from Drafts',
    stage: 'review',
    status: 'in_review',
    href: '/admin/review-queue/sent-1?source=content',
    source: { collection: 'content', id: 'sent-1', Live: false },
  }),
  item({
    id: 'transcript:t1',
    category: 'pipelines',
    kind: 'transcript',
    title: 'Episode one',
    stage: 'approval',
    status: 'draft',
    waitingSince: '2026-10-06T12:00:00.000Z',
    href: '/admin/recording-hub?tab=transcripts&transcript=t1',
    source: { collection: 'podcast_transcripts', id: 't1' },
  }),
  item({
    id: 'alert:a1',
    category: 'governance',
    kind: 'alert',
    title: 'scheduled publish failures',
    stage: 'acknowledge',
    status: 'open',
    priority: 'high',
    waitingSince: '2026-10-01T12:00:00.000Z',
    href: '/admin/health?tab=alerts&alert=a1',
    source: { collection: 'workflow_alerts', id: 'a1' },
  }),
];

const source = (over) => ({
  count: 0,
  truncated: false,
  restricted: false,
  error: null,
  ...over,
});

const ANSWER = {
  success: true,
  items: ITEMS,
  counts: { all: 3, frameworks: 0, queues: 1, pipelines: 1, governance: 1, other: 0 },
  sources: [
    source({ id: 'review-queue', label: 'Review Queue', category: 'queues', count: 1 }),
    source({ id: 'frameworks', label: 'Frameworks awaiting review', category: 'frameworks' }),
    source({
      id: 'podcast-transcripts',
      label: 'Podcast transcripts awaiting approval',
      category: 'pipelines',
      count: 1,
    }),
    source({
      id: 'workflow-alerts',
      label: 'Open workflow alerts',
      category: 'governance',
      count: 1,
    }),
  ],
  errors: [],
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function Detail() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Back
    </button>
  );
}

function renderAt(path = '/admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<DecisionCenter now={() => NOW} />} />
        <Route path="/admin/*" element={<Detail />} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

const tablist = () => within(screen.getByRole('tablist', { name: 'Decisions by area' }));
const selectedTab = () =>
  tablist()
    .getAllByRole('tab')
    .find((tab) => tab.getAttribute('aria-selected') === 'true');
const rows = () =>
  within(screen.getByRole('list', { name: 'Decisions waiting' })).getAllByRole('link');

beforeEach(() => {
  postJSON.mockReset();
  postJSON.mockResolvedValue(ANSWER);
});

describe('DecisionCenter', () => {
  it('reads getDecisionCenter and shows six tabs with their counts', async () => {
    renderAt();
    await screen.findByText('Sent from Drafts');
    expect(postJSON).toHaveBeenCalledWith('getDecisionCenter', {});
    expect(
      tablist()
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual([
      'Needs a Decision3',
      'Frameworks0',
      'Queues1',
      'Pipelines1',
      'Governance1',
      'Other Actions0',
    ]);
    expect(selectedTab()).toHaveTextContent('Needs a Decision');
  });

  it('lists everything newest first, each row with its kind, stage, wait and priority', async () => {
    renderAt();
    await screen.findByText('Sent from Drafts');
    const links = rows();
    expect(links.map((link) => link.querySelector('p').textContent)).toEqual([
      'Sent from Drafts',
      'Episode one',
      'scheduled publish failures',
    ]);
    expect(links[0]).toHaveTextContent('Blog · Review');
    expect(links[0]).toHaveTextContent('waiting 3h');
    expect(links[1]).toHaveTextContent('Podcast transcript · Awaiting approval');
    expect(links[1]).toHaveTextContent('waiting 2d');
    expect(links[2]).toHaveTextContent('High');
    expect(links[0]).not.toHaveTextContent('High');
  });

  it('links each row through itemLinks: a content item by its stage, the rest by their deep link', async () => {
    postJSON.mockResolvedValue({
      ...ANSWER,
      items: [
        // The API's href is stale; the status says Editor.
        { ...ITEMS[0], status: 'approved', stage: 'editor', href: '/admin/review-queue/sent-1' },
        ITEMS[1],
        { ...ITEMS[2], href: 'https://evil.example/admin' },
      ],
    });
    renderAt();
    await screen.findByText('Sent from Drafts');
    expect(rows().map((link) => link.getAttribute('href'))).toEqual([
      '/admin/editor/sent-1',
      '/admin/recording-hub?tab=transcripts&transcript=t1',
      '/admin',
    ]);
  });

  it('keeps the selected tab in the address, and Back from an item returns to it', async () => {
    renderAt();
    await screen.findByText('Sent from Drafts');
    fireEvent.click(tablist().getByRole('tab', { name: /Pipelines/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/admin?decisions=pipelines');
    expect(rows().map((link) => link.querySelector('p').textContent)).toEqual(['Episode one']);

    fireEvent.click(screen.getByText('Episode one'));
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/admin/recording-hub?tab=transcripts&transcript=t1'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await screen.findByText('Episode one');
    expect(screen.getByTestId('where')).toHaveTextContent('/admin?decisions=pipelines');
    expect(selectedTab()).toHaveTextContent('Pipelines');
    expect(screen.queryByText('Sent from Drafts')).not.toBeInTheDocument();
  });

  it('opens on the tab a link names, and drops the parameter for Needs a Decision', async () => {
    renderAt('/admin?decisions=governance');
    await screen.findByText('scheduled publish failures');
    expect(selectedTab()).toHaveTextContent('Governance');
    fireEvent.click(tablist().getByRole('tab', { name: /Needs a Decision/ }));
    expect(screen.getByTestId('where').textContent).toBe('/admin');
  });

  it('falls back to Needs a Decision for a tab that does not exist', async () => {
    renderAt('/admin?decisions=constructor');
    await screen.findByText('Sent from Drafts');
    expect(selectedTab()).toHaveTextContent('Needs a Decision');
  });

  it('says what would fill an empty tab', async () => {
    renderAt('/admin?decisions=frameworks');
    expect(await screen.findByText('No framework is waiting for review')).toBeInTheDocument();
    fireEvent.click(tablist().getByRole('tab', { name: /Other Actions/ }));
    expect(screen.getByText('No other action is due')).toBeInTheDocument();
  });

  it('says so when nothing at all is waiting', async () => {
    postJSON.mockResolvedValue({ ...ANSWER, items: [], counts: { all: 0 } });
    renderAt();
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  it('names a source that could not be read, with its own page, and still shows the rest', async () => {
    postJSON.mockResolvedValue({
      ...ANSWER,
      items: [ITEMS[0], ITEMS[2]],
      sources: ANSWER.sources.map((row) =>
        row.id === 'podcast-transcripts'
          ? {
              ...row,
              count: 0,
              error: 'Podcast transcripts awaiting approval could not be read just now.',
            }
          : row
      ),
    });
    renderAt();
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Podcast transcripts awaiting approval could not be read');
    expect(
      within(notice).getByRole('link', { name: 'Open Podcast transcripts awaiting approval' })
    ).toHaveAttribute('href', '/admin/recording-hub?tab=transcripts');
    expect(screen.getByText('Sent from Drafts')).toBeInTheDocument();

    // On a tab the failed source does not feed, the notice is not shown.
    fireEvent.click(tablist().getByRole('tab', { name: /Governance/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    postJSON.mockResolvedValue(ANSWER);
    fireEvent.click(tablist().getByRole('tab', { name: /Needs a Decision/ }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(postJSON).toHaveBeenCalledTimes(2);
  });

  it('shows the read failing whole as an error with Try again', async () => {
    postJSON.mockRejectedValueOnce(new Error('Failed to read the decisions waiting'));
    renderAt();
    expect(await screen.findByText('The decisions waiting could not be read')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Sent from Drafts')).toBeInTheDocument();
  });

  it('says when a list shows only its newest, and what a role leaves out', async () => {
    postJSON.mockResolvedValue({
      ...ANSWER,
      sources: [
        ...ANSWER.sources.map((row) =>
          row.id === 'review-queue' ? { ...row, truncated: true } : row
        ),
        source({
          id: 'reminders',
          label: 'Reminders due or overdue',
          category: 'other',
          restricted: true,
        }),
      ],
    });
    renderAt();
    await screen.findByText('Sent from Drafts');
    expect(screen.getByRole('link', { name: 'Review Queue' })).toHaveAttribute(
      'href',
      '/admin/review-queue'
    );
    expect(
      screen.getByText(/Not shown for your role: Reminders due or overdue/)
    ).toBeInTheDocument();
  });

  it('shows the first rows and the rest on request', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      item({
        id: `alert:a${i}`,
        category: 'governance',
        kind: 'alert',
        title: `Alert ${i}`,
        stage: 'acknowledge',
        status: 'open',
        href: `/admin/health?tab=alerts&alert=a${i}`,
        source: { collection: 'workflow_alerts', id: `a${i}` },
      })
    );
    postJSON.mockResolvedValue({ ...ANSWER, items: many, counts: { all: 20, governance: 20 } });
    renderAt();
    await screen.findByText('Alert 0');
    expect(rows()).toHaveLength(15);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 20' }));
    expect(rows()).toHaveLength(20);
  });

  it('does not read until it is enabled', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <DecisionCenter enabled={false} />
      </MemoryRouter>
    );
    expect(postJSON).not.toHaveBeenCalled();
  });
});

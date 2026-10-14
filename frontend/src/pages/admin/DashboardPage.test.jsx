import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import DashboardPage, { PIPELINE_STAGES } from './DashboardPage';

const postJSON = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
}));

const SNAPSHOT = {
  success: true,
  stats: {
    blog: { needsReview: 3, inProgress: 4, published: 5, total: 12 },
    framework: { needsReview: 1, inProgress: 2, published: 3, total: 6 },
    architecture: { needsReview: 2, inProgress: 1, published: 4, total: 7 },
    coder_corner: { needsReview: 0, inProgress: 1, published: 2, total: 3 },
    rejected: 9,
  },
  readyToPublish: 2,
};

/** The Decision Center's read (functions/src/lib/decision-center.js). */
const DECISIONS = {
  success: true,
  items: [
    {
      id: 'content:content-1',
      category: 'queues',
      kind: 'blog',
      title: 'Queued article',
      stage: 'review',
      status: 'ingested',
      waitingSince: null,
      priority: 'normal',
      href: '/admin/queue/content-1?source=content',
      source: { collection: 'content', id: 'content-1', Live: false },
      detail: 'Azure',
    },
  ],
  counts: { all: 1, frameworks: 0, queues: 1, pipelines: 0, governance: 0, other: 0 },
  sources: [],
  errors: [],
};

const answer = (route) => Promise.resolve(route === 'getDecisionCenter' ? DECISIONS : SNAPSHOT);

/** Render the dashboard inside a router, as the admin shell does. */
function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    postJSON.mockReset();
    postJSON.mockImplementation(answer);
  });

  it('renders backend snapshot totals and the decisions waiting', async () => {
    renderDashboard();
    expect(await screen.findByText('6 items waiting for you')).toBeInTheDocument();
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getAdminDashboardSnapshot', {}));
    expect(screen.getByText('Blogs')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getAllByText('12').length).toBeGreaterThan(0);
    expect(screen.getAllByText('9').length).toBeGreaterThan(0);
    expect(await screen.findByText('Queued article')).toBeInTheDocument();
    // 14 pieces live across the four published buckets.
    expect(screen.getByRole('link', { name: '14 pieces live' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '8 in editor' })).toBeInTheDocument();
  });

  it('links every number in the header to the list it counts', async () => {
    renderDashboard();
    // Fails if a header count goes back to plain text, or points somewhere
    // that does not list what it counts.
    expect(await screen.findByRole('link', { name: '6 items waiting for you' })).toHaveAttribute(
      'href',
      '/admin/queue?status=needs_review'
    );
    expect(screen.getByRole('link', { name: '14 pieces live' })).toHaveAttribute(
      'href',
      '/admin/live-pages'
    );
    expect(screen.getByRole('link', { name: '8 in editor' })).toHaveAttribute(
      'href',
      '/admin/editor'
    );
    expect(screen.getByRole('link', { name: '9 rejected' })).toHaveAttribute(
      'href',
      '/admin/queue?status=rejected'
    );
  });

  it('shows the Decision Center where the newest-five list was, each item opening at its stage', async () => {
    renderDashboard();
    const row = (await screen.findByText('Queued article')).closest('a');
    expect(postJSON).toHaveBeenCalledWith('getDecisionCenter', {});
    expect(row).toHaveAttribute('href', '/admin/queue/content-1?source=content');
    expect(within(row).getByText('Blog · Review · Azure')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Decisions by area' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(6);
  });

  it('opens each pipeline stage at its own page, the Review Queue on the view its count is', async () => {
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    for (const stage of PIPELINE_STAGES) {
      const link = screen.getByRole('link', { name: new RegExp(`^${stage.label}: `) });
      expect(link, stage.id).toHaveAttribute('href', stage.to);
    }
    // The Review Queue opens on its default view, needs_review, which is the
    // needsReview counter the badge shows (in_review included since #1014).
    expect(PIPELINE_STAGES.find((s) => s.id === 'review').to).toBe('/admin/queue');
  });

  it('shows ONE pipeline graphic, with six stages from New Content to Live Pages (ADR 0033)', async () => {
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    expect(PIPELINE_STAGES.map((s) => s.label)).toEqual([
      'New Content',
      'Drafts',
      'Review Queue',
      'Editor',
      'Publish',
      'Live Pages',
    ]);
    // The quick-action row that duplicated the pipeline is gone: the Review
    // Queue is linked once in the pipeline and once in the Explore strip, and
    // nowhere describes itself as "Triage incoming".
    expect(screen.queryByText('Triage incoming')).not.toBeInTheDocument();
    expect(screen.queryByText('Polish drafts')).not.toBeInTheDocument();
    // The Card renders no data-slot attribute, so the old
    // `closest('[data-slot="card"], div')` only ever found the nearest div
    // and could not fail. The graphic is the ordered list under the section
    // heading, one item per stage, in order.
    expect(screen.getByRole('heading', { name: 'The pipeline' })).toBeInTheDocument();
    const pipeline = screen.getByTestId('pipeline');
    expect(pipeline.tagName).toBe('OL');
    const stages = within(pipeline).getAllByTestId('pipeline-stage');
    expect(stages.map((stage) => stage.getAttribute('aria-label').split(':')[0])).toEqual(
      PIPELINE_STAGES.map((s) => s.label)
    );
    const review = screen.getByRole('link', { name: /^Review Queue: .*6 items$/ });
    expect(within(review).getByText('6')).toBeInTheDocument();
    const live = screen.getByRole('link', { name: /^Live Pages: .*14 items$/ });
    expect(live).toHaveAttribute('href', '/admin/live-pages');
  });

  it('shows the Publish stage its count: ready to publish and not live', async () => {
    // Fails if the stage loses its countKey, or the count is read from a
    // stats bucket rather than the snapshot's readyToPublish.
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    const publish = screen.getByRole('link', { name: /^Publish: .*2 items$/ });
    expect(publish).toHaveAttribute('href', '/admin/published');
    expect(within(publish).getByText('2')).toBeInTheDocument();
  });

  it('lets every stage description wrap to two lines rather than cutting it to one', async () => {
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    const descriptions = screen.getAllByTestId('pipeline-stage-description');
    expect(descriptions).toHaveLength(6);
    for (const description of descriptions) {
      expect(description).toHaveClass('line-clamp-2');
      expect(description).not.toHaveClass('truncate');
    }
  });

  it('says what each type tile counts and opens the list its note counts', async () => {
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    // The known mismatch: the Blogs tile showed the total across every stage
    // and opened the queue on its needs-review default without saying so.
    const blogs = screen.getByRole('link', { name: /^Blogs: 12 across every stage, 3 waiting/ });
    expect(blogs).toHaveAttribute('href', '/admin/queue?contentType=blog&status=needs_review');
    expect(within(blogs).getByText('12')).toBeInTheDocument();
    expect(within(blogs).getByText('3 to review')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /^Architecture: 7 across every stage, 2 waiting/ })
    ).toHaveAttribute('href', '/admin/queue?contentType=architecture&status=needs_review');
    expect(
      screen.getByRole('link', { name: /^Frameworks: 6 across every stage, 1 waiting/ })
    ).toHaveAttribute('href', '/admin/frameworks?status=needs_review');
    expect(
      screen.getByRole('link', { name: /^Coder Corner: 3 across every stage, 0 waiting/ })
    ).toHaveAttribute('href', '/admin/coder-corner?status=needs_review');
    const rejected = screen.getByRole('link', { name: /^Rejected: 9\./ });
    expect(rejected).toHaveAttribute('href', '/admin/queue?status=rejected');
    expect(within(rejected).getByText('Auto-deletes in 24h')).toBeInTheDocument();
    // One tile shape: five tiles, each with its note line, filled or held.
    const tiles = screen.getAllByTestId('stat-tile');
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) expect(within(tile).getAllByTestId('stat-tile-note')).toHaveLength(1);
  });

  it('explains every menu group on the first screen', async () => {
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    const explore = screen.getByRole('region', { name: 'Explore ContentForge' });
    for (const label of ['Pipeline', 'Enhanced', 'Creative', 'Amplify', 'Spotlight', 'Platform']) {
      expect(within(explore).getByText(label)).toBeInTheDocument();
    }
    expect(within(explore).getByRole('link', { name: /Ambassador/ })).toHaveAttribute(
      'href',
      '/admin/ambassador'
    );
  });

  it('recounts through the backend and re-reads the snapshot', async () => {
    renderDashboard();
    await screen.findByText('6 items waiting for you');
    postJSON.mockClear();
    postJSON.mockImplementation(answer);
    screen.getByRole('button', { name: /Recount/ }).click();
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('recalculateDashboardStats', {}));
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getAdminDashboardSnapshot', {}));
  });
});

describe('DashboardPage when the snapshot read fails (AP-F5, #929)', () => {
  beforeEach(() => {
    postJSON.mockReset();
  });

  it('shows an error state with a way to try again, never "all caught up"', async () => {
    postJSON.mockImplementation((route) =>
      route === 'getAdminDashboardSnapshot'
        ? Promise.reject(new Error('503 from the API'))
        : answer(route)
    );
    renderDashboard();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The dashboard could not be loaded');
    expect(alert).toHaveTextContent('503 from the API');
    expect(screen.queryByText(/all caught up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pieces live/)).not.toBeInTheDocument();

    // Try again re-reads; with the backend back the dashboard renders.
    postJSON.mockImplementation(answer);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('6 items waiting for you')).toBeInTheDocument();
  });

  it('keeps the last numbers and marks them stale when a later read fails', async () => {
    postJSON.mockImplementation(answer);
    renderDashboard();
    expect(await screen.findByText('6 items waiting for you')).toBeInTheDocument();

    // Recount: the recalculation succeeds and the re-read fails.
    postJSON.mockImplementation((route) =>
      route === 'getAdminDashboardSnapshot' ? Promise.reject(new Error('timed out')) : answer(route)
    );
    fireEvent.click(screen.getByRole('button', { name: /recount/i }));

    expect(await screen.findByText('Numbers may be stale')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('timed out');
    expect(screen.getByText('6 items waiting for you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument();
  });
});

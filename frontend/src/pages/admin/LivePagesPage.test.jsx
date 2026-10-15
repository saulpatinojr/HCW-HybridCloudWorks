/**
 * Honest error state, retry, and 500-item truncation banner for LivePagesPage
 * (AP-F6, #930); and the row's Archive, which asks nothing before it acts
 * because the toast it raises carries Undo (AP-F13, #937;
 * livePages/useLivePageArchive.test.jsx has the flow itself).
 *
 * The banner reads only how many records came back, so the tests at the limit
 * stand a bare element in for each row (#1194): five hundred real rows in
 * jsdom ran past the 5 s timeout in a loaded full run. They still go through
 * the real read, count and banner; only the row's own markup is skipped, and
 * every other test renders the real row.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import LivePagesPage from './LivePagesPage';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const getJSON = vi.fn();
const fetchPublicContentList = vi.fn();
const archiveLivePage = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getJSON: (...args) => getJSON(...args),
  fetchPublicContentList: (...args) => fetchPublicContentList(...args),
}));

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

// The hook's state is stubbed; which rows may be archived is its real rule.
vi.mock('./livePages/useLivePageArchive', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useLivePageArchive: () => ({
      archivingId: '',
      archiveError: '',
      locallyArchivedKeys: {},
      archiveLivePage: (...args) => archiveLivePage(...args),
      archiveBlockedReason: actual.archiveBlockedReason,
    }),
  };
});

// The real row unless a test sets `rows.standIn`; beforeEach puts it back.
const rows = vi.hoisted(() => ({ standIn: false }));

vi.mock('./livePages/LivePageRow', async (importOriginal) => {
  const { default: LivePageRow } = await importOriginal();
  return {
    default: (props) =>
      rows.standIn ? <div data-testid="live-page-row" /> : <LivePageRow {...props} />,
  };
});

const liveItem = (n) => ({
  id: `content-${n}`,
  Title: `Live Page ${n}`,
  slug: `live-page-${n}`,
  Live: true,
  contentStatus: 'published',
  publishedAt: '2026-10-01T00:00:00.000Z',
  'Cloud Provider': 'Azure',
  type: 'framework',
  publishedUrl: `https://hybridcloudworks.com/frameworks/live-page-${n}`,
});

/** The page for a publisher unless `role` says otherwise: Archive is a publisher's edge (AP-F4). */
function renderPage(role = 'publisher') {
  return render(
    <AdminRoleProvider value={role}>
      <MemoryRouter>
        <LivePagesPage />
      </MemoryRouter>
    </AdminRoleProvider>
  );
}

describe('LivePagesPage', () => {
  beforeEach(() => {
    rows.standIn = false;
    getJSON.mockReset();
    fetchPublicContentList.mockReset();
    fetchPublicContentList.mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows error state with Try again on fetch failure, recovering on retry', async () => {
    getJSON.mockRejectedValue(new Error('500 Internal Server Error'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Live pages could not be loaded');
    expect(alert).toHaveTextContent('500 Internal Server Error');

    getJSON.mockResolvedValue({ items: [liveItem(1)] });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Live Page 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('displays the truncation banner when 500 or more items are returned', async () => {
    rows.standIn = true;
    const items = Array.from({ length: 500 }, (_, n) => liveItem(n));
    getJSON.mockResolvedValue({ items });
    renderPage();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('The first 500 items are shown');
    expect(screen.getByText('500 live pages found')).toBeInTheDocument();
    expect(screen.getAllByTestId('live-page-row')).toHaveLength(500);
  });

  it('does not display the truncation banner one short of the limit, at 499 items', async () => {
    rows.standIn = true;
    getJSON.mockResolvedValue({ items: Array.from({ length: 499 }, (_, n) => liveItem(n)) });
    renderPage();

    expect(await screen.findByText('499 live pages found')).toBeInTheDocument();
    expect(screen.getAllByTestId('live-page-row')).toHaveLength(499);
    expect(screen.queryByText(/The first 500 items are shown/)).not.toBeInTheDocument();
  });

  it('does not display truncation banner when items are under 500', async () => {
    getJSON.mockResolvedValue({ items: [liveItem(1), liveItem(2)] });
    renderPage();

    expect(await screen.findByText('Live Page 1')).toBeInTheDocument();
    expect(screen.queryByText(/The first 500 items are shown/)).not.toBeInTheDocument();
  });

  it('archives a row from its button with no confirm step, and names the Archive board in its help', async () => {
    archiveLivePage.mockReset();
    getJSON.mockResolvedValue({ items: [liveItem(1), liveItem(2)] });
    renderPage();

    const row = (await screen.findByText('Live Page 2')).closest('div.rounded-lg');
    fireEvent.click(within(row).getByRole('button', { name: 'Archive' }));

    expect(archiveLivePage).toHaveBeenCalledTimes(1);
    expect(archiveLivePage.mock.calls[0][0]).toMatchObject({
      id: 'content-2',
      __source: 'content',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /how this works/i }));
    expect(
      screen.getByText(/Archive board; the toast offers Undo for ten seconds/)
    ).toBeInTheDocument();
  });

  it('disables Archive on a live page in a status with no archive edge, and its title says why', async () => {
    archiveLivePage.mockReset();
    getJSON.mockResolvedValue({
      items: [liveItem(1), { ...liveItem(2), contentStatus: 'editing' }],
    });
    renderPage();

    const editingRow = (await screen.findByText('Live Page 2')).closest('div.rounded-lg');
    const blocked = within(editingRow).getByRole('button', { name: 'Archive' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute(
      'title',
      'Only a published or rejected page can be archived; this one is Editing. Open Editor to move it on first.'
    );
    fireEvent.click(blocked);
    expect(archiveLivePage).not.toHaveBeenCalled();

    const publishedRow = screen.getByText('Live Page 1').closest('div.rounded-lg');
    const offered = within(publishedRow).getByRole('button', { name: 'Archive' });
    expect(offered).toBeEnabled();
    expect(offered).not.toHaveAttribute('title');
  });

  it('tells an editor Archive needs the publisher role, and a click archives nothing', async () => {
    archiveLivePage.mockReset();
    getJSON.mockResolvedValue({ items: [liveItem(1)] });
    renderPage('editor');

    const row = (await screen.findByText('Live Page 1')).closest('div.rounded-lg');
    const reason = within(row).getByText('Taking a page off the site needs the publisher role.');
    const gated = within(row).getByRole('button', { name: 'Archive' });
    expect(gated).toHaveAttribute('aria-disabled', 'true');
    expect(gated).toHaveAttribute('aria-describedby', reason.id);
    fireEvent.click(gated);
    expect(archiveLivePage).not.toHaveBeenCalled();
  });
});

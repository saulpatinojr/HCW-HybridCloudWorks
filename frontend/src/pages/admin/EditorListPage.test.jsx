/**
 * The Editor list's two honest states (AP-F6, #930).
 *
 * The three reads behind the page ignored their hooks' errors, so a 401 or a
 * 5xx rendered as "No items match your filters"; and each read asks for the
 * server's maximum, so a board past that length was cut without a word and the
 * search ran over the part that arrived. These tests pin the error state with
 * its retry and the banner a cut board carries.
 *
 * The banner reads only how long each board came back, so the tests at the
 * limit stand a bare element in for each live row (#1194): five hundred real
 * rows in jsdom ran past the 5 s timeout in a loaded full run. They still go
 * through the real reads, counts and banner; only the row's own markup is
 * skipped, and every other test renders the real row.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import EditorListPage, { LIST_PAGE } from './EditorListPage';

const getJSON = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getJSON: (...args) => getJSON(...args),
}));

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

const transition = vi.fn();

vi.mock('./queue/useContentTransitions', () => ({
  useContentTransitions: () => ({
    loading: {},
    errors: {},
    recall: vi.fn(),
    transition: (...args) => transition(...args),
  }),
}));

// The real row unless a test sets `rows.standIn`; beforeEach puts it back.
const rows = vi.hoisted(() => ({ standIn: false }));

vi.mock('./editor-list/LiveItemRow', async (importOriginal) => {
  const { default: LiveItemRow } = await importOriginal();
  return {
    /** The real row, or a bare element when a test sets `rows.standIn` (#1194). */
    default: (props) =>
      rows.standIn ? <div data-testid="live-item-row" /> : <LiveItemRow {...props} />,
  };
});

/** One live content record, in the shape the list route returns. */
const liveItem = (n) => ({
  id: `live-${n}`,
  title: `Live item ${n}`,
  Live: true,
  contentStatus: 'published',
  blogPublishedAt: '2026-10-01T00:00:00.000Z',
  'Cloud Provider': 'Azure',
});

/** A getJSON that answers the live board with the given items and the others with nothing. */
const answerWith = (liveItems) => (path) =>
  Promise.resolve({ items: path.includes('live=true') ? liveItems : [] });

/** Render the page inside a router, as the admin shell does. */
function renderPage() {
  return render(
    <MemoryRouter>
      <EditorListPage />
    </MemoryRouter>
  );
}

describe('EditorListPage', () => {
  beforeEach(() => {
    rows.standIn = false;
    getJSON.mockReset();
    transition.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows the read failure with a way to try again, not an empty board', async () => {
    getJSON.mockRejectedValue(new Error('401 Unauthorized'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The editor lists could not be loaded');
    expect(alert).toHaveTextContent('401 Unauthorized');
    expect(screen.queryByText(/No items match your filters/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No live published content found/)).not.toBeInTheDocument();
    const liveReads = () =>
      getJSON.mock.calls.filter(([path]) => path.includes('live=true')).length;
    await waitFor(() => expect(liveReads()).toBe(1));

    // Try again re-reads all three boards; with the backend back, the list renders.
    getJSON.mockImplementation(answerWith([liveItem(1)]));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Live item 1')).toBeInTheDocument();
    expect(liveReads()).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says when a board came back cut at the server limit', async () => {
    rows.standIn = true;
    getJSON.mockImplementation(
      answerWith(Array.from({ length: LIST_PAGE }, (_, n) => liveItem(n)))
    );
    renderPage();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(`The first ${LIST_PAGE} items of a board are shown`);
    expect(getJSON).toHaveBeenCalledWith(expect.stringContaining(`limit=${LIST_PAGE}`));
    expect(screen.getAllByTestId('live-item-row')).toHaveLength(LIST_PAGE);
  });

  it('carries no banner for a board one short of the limit', async () => {
    rows.standIn = true;
    getJSON.mockImplementation(
      answerWith(Array.from({ length: LIST_PAGE - 1 }, (_, n) => liveItem(n)))
    );
    renderPage();

    expect(await screen.findAllByTestId('live-item-row')).toHaveLength(LIST_PAGE - 1);
    expect(screen.queryByText(/items of a board are shown/)).not.toBeInTheDocument();
  });

  it('carries no banner for a board under the limit', async () => {
    getJSON.mockImplementation(answerWith([liveItem(1), liveItem(2)]));
    renderPage();

    expect(await screen.findByText('Live item 1')).toBeInTheDocument();
    expect(screen.queryByText(/items of a board are shown/)).not.toBeInTheDocument();
  });

  /**
   * Restore on the Archive board puts a page back on the site (AP-F13,
   * #937). The board drops its row, and the live board read before the
   * restore is read again, so the page appears there without a reload.
   */
  it('reads the live list again after a restore on the Archive board, and shows the page there', async () => {
    const restored = {
      id: 'arch-1',
      title: 'Brought back',
      contentStatus: 'archived',
      Live: false,
      'Cloud Provider': 'Azure',
      archivedAt: '2026-10-15T10:00:00.000Z',
    };
    let live = [liveItem(1)];
    /**
     * What the list route answers for a path: the live list, the archived list
     * with the restored row, or nothing.
     */
    const board = (path) => {
      if (path.includes('live=true')) return live;
      return path.includes('archived') ? [restored] : [];
    };
    getJSON.mockImplementation((path) => Promise.resolve({ items: board(path) }));
    /** How many times the page has read the live list, so a restore's re-read can be counted. */
    const liveReads = () =>
      getJSON.mock.calls.filter(([path]) => path.includes('live=true')).length;
    renderPage();
    expect(await screen.findByText('Live item 1')).toBeInTheDocument();
    expect(liveReads()).toBe(1);

    transition.mockResolvedValueOnce({ success: true, from: 'archived', to: 'published' });
    live = [liveItem(1), { ...restored, contentStatus: 'published', Live: true }];
    fireEvent.click(screen.getByRole('button', { name: /^Archive \(1\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore to live' }));

    await waitFor(() => expect(liveReads()).toBe(2));
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'arch-1' }),
      'published',
      expect.objectContaining({ markLive: true })
    );
    expect(await screen.findByText('Brought back')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archive (0)' })).toBeInTheDocument();
  });
});

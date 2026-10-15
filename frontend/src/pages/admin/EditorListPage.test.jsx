/**
 * The Editor list's two honest states (AP-F6, #930).
 *
 * The three reads behind the page ignored their hooks' errors, so a 401 or a
 * 5xx rendered as "No items match your filters"; and each read asks for the
 * server's maximum, so a board past that length was cut without a word and the
 * search ran over the part that arrived. These tests pin the error state with
 * its retry and the banner a cut board carries.
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

vi.mock('./queue/useContentTransitions', () => ({
  useContentTransitions: () => ({
    loading: {},
    errors: {},
    recall: vi.fn(),
    transition: vi.fn(),
  }),
}));

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
    getJSON.mockReset();
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
    getJSON.mockImplementation(
      answerWith(Array.from({ length: LIST_PAGE }, (_, n) => liveItem(n)))
    );
    renderPage();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(`The first ${LIST_PAGE} items of a board are shown`);
    expect(getJSON).toHaveBeenCalledWith(expect.stringContaining(`limit=${LIST_PAGE}`));
  });

  it('carries no banner for a board under the limit', async () => {
    getJSON.mockImplementation(answerWith([liveItem(1), liveItem(2)]));
    renderPage();

    expect(await screen.findByText('Live item 1')).toBeInTheDocument();
    expect(screen.queryByText(/items of a board are shown/)).not.toBeInTheDocument();
  });
});

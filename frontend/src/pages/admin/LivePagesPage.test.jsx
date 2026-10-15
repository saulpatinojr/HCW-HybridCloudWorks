/**
 * Honest error state, retry, and 500-item truncation banner for LivePagesPage (AP-F6, #930).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import LivePagesPage from './LivePagesPage';

const getJSON = vi.fn();
const fetchPublicContentList = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getJSON: (...args) => getJSON(...args),
  fetchPublicContentList: (...args) => fetchPublicContentList(...args),
}));

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

vi.mock('./livePages/useLivePageDeletion', () => ({
  useLivePageDeletion: () => ({
    deleteTarget: null,
    setDeleteTarget: vi.fn(),
    deletingId: null,
    deleteError: null,
    locallyDeletedKeys: new Set(),
    handleDeleteLivePage: vi.fn(),
  }),
}));

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

function renderPage() {
  return render(
    <MemoryRouter>
      <LivePagesPage />
    </MemoryRouter>
  );
}

describe('LivePagesPage', () => {
  beforeEach(() => {
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
    const items = Array.from({ length: 500 }, (_, n) => liveItem(n));
    getJSON.mockResolvedValue({ items });
    renderPage();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('The first 500 items are shown');
    expect(screen.getByText('500 live pages found')).toBeInTheDocument();
  });

  it('does not display truncation banner when items are under 500', async () => {
    getJSON.mockResolvedValue({ items: [liveItem(1), liveItem(2)] });
    renderPage();

    expect(await screen.findByText('Live Page 1')).toBeInTheDocument();
    expect(screen.queryByText(/The first 500 items are shown/)).not.toBeInTheDocument();
  });
});

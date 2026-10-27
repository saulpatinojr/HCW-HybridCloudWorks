import React from 'react';
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import BlogsPage from './BlogsPage';
import { getJSON, sendJSON } from '@/lib/api';
import { runJob } from '@/lib/jobs';
vi.mock('@/lib/api', () => ({ getJSON: vi.fn(), sendJSON: vi.fn() }));
vi.mock('@/lib/jobs', () => ({ runJob: vi.fn() }));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/admin/TypedReviewList', () => ({
  default: ({ renderCard }) =>
    renderCard({ item: { id: 'article', Title: 'Kiro article', contentStatus: 'ingested' } }),
}));
vi.mock('@/components/admin/ImageGalleryPicker', () => ({
  ImageGalleryPicker: ({ onSelect }) => (
    <button
      type="button"
      onClick={() => onSelect({ imageUrl: '/api/public/media/covers/default.png' })}
    >
      Select gallery image
    </button>
  ),
}));
const kiro = {
  id: 'kiro',
  name: 'Kiro Blog',
  provider: 'aws',
  kind: 'rss',
  url: 'https://kiro.dev/blog/feed.rss',
  enabled: true,
  builtIn: true,
  official: true,
  maxItems: 10,
  fallbackImageUrl: '',
  _etag: 'v1',
};
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/blogs']}>
      <BlogsPage />
    </MemoryRouter>
  );
const sources = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Blog sources', exact: true }));
beforeEach(() => {
  vi.clearAllMocks();
  getJSON.mockResolvedValue({ sources: [kiro] });
  sendJSON.mockResolvedValue({});
});

it('opens articles in the established review and editor routes', () => {
  renderPage();
  expect(screen.getByRole('link', { name: 'Review article' })).toHaveAttribute(
    'href',
    '/admin/review-queue/article?source=content'
  );
  expect(screen.getByRole('link', { name: 'Edit article' })).toHaveAttribute(
    'href',
    '/admin/editor/article'
  );
});
it('edits a source, selects and clears a gallery default, pauses intake, and preserves its etag', async () => {
  renderPage();
  sources();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit source' }));
  expect(screen.getByLabelText('Provider')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Kiro updates' } });
  fireEvent.click(screen.getByRole('button', { name: 'Choose default image' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select gallery image' }));
  expect(screen.getByLabelText('Fallback image URL')).toHaveValue(
    '/api/public/media/covers/default.png'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear default' }));
  expect(screen.getByLabelText('Fallback image URL')).toHaveValue('');
  fireEvent.click(screen.getByLabelText('Enabled for intake'));
  fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
  await waitFor(() =>
    expect(sendJSON).toHaveBeenCalledWith(
      'cms/blog-sources/kiro',
      'PUT',
      expect.objectContaining({ name: 'Kiro updates', enabled: false, _etag: 'v1' })
    )
  );
  expect(await screen.findByText(/Source saved/)).toBeInTheDocument();
});
it('shows edit conflicts without discarding the form', async () => {
  sendJSON.mockRejectedValueOnce(new Error('This source changed. Refresh before saving.'));
  renderPage();
  sources();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit source' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Refresh before saving');
  expect(screen.getByLabelText('Source name')).toHaveValue('Kiro Blog');
});
it('adds a custom source and supports searching and filtering', async () => {
  renderPage();
  sources();
  await screen.findByRole('heading', { name: 'Kiro Blog' });
  fireEvent.change(screen.getByLabelText('Search sources'), { target: { value: 'missing' } });
  expect(screen.getByText('No sources match these filters.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Another blog' } });
  fireEvent.change(screen.getByLabelText('RSS feed URL'), {
    target: { value: 'https://example.com/feed' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
  await waitFor(() =>
    expect(sendJSON).toHaveBeenCalledWith(
      'cms/blog-sources',
      'POST',
      expect.objectContaining({ name: 'Another blog' })
    )
  );
});
it('reports failed intake and allows retry after a source load error', async () => {
  getJSON.mockRejectedValueOnce(new Error('Sources unavailable'));
  runJob.mockResolvedValue({ status: 'failed', error: 'Intake failed' });
  renderPage();
  sources();
  expect(await screen.findByRole('alert')).toHaveTextContent('Sources unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Intake failed');
});
it('reports successful intake and explains the publishing workflow', async () => {
  runJob.mockResolvedValue({ status: 'succeeded', result: { newContent: 3, errors: [] } });
  renderPage();
  sources();
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
  expect(await screen.findByText(/3 new articles/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Publishing workflow' }));
  expect(
    screen.getByRole('heading', { name: 'From source to published article' })
  ).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open Publish' })).toHaveAttribute(
    'href',
    '/admin/publish'
  );
});

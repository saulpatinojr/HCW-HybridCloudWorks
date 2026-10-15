import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import QueuePage from './QueuePage';

const postJSON = vi.fn();
const getJSON = vi.fn();
const logAdminAction = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  getJSON: (...args) => getJSON(...args),
}));

vi.mock('@/lib/auditLog', () => ({
  logAdminAction: (...args) => logAdminAction(...args),
}));

describe('QueuePage', () => {
  beforeEach(() => {
    postJSON.mockReset();
    getJSON.mockReset();
    logAdminAction.mockReset();
  });

  it('renders queue totals from the backend snapshot', async () => {
    postJSON.mockResolvedValue({
      success: true,
      totalCount: 2,
      items: [
        {
          id: 'content-1',
          Title: 'First queued item',
          contentStatus: 'ingested',
          cloudProvider: 'AWS',
          summary: 'Summary one',
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue']}>
        <QueuePage />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Review Queue' })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('getQueueSnapshot', {
        statusFilter: 'needs_review',
        contentTypeFilter: 'all',
        kindFilter: 'all',
        ideaOriginFilter: 'all',
        itemLimit: 100,
      })
    );

    expect(screen.getByText('Showing 1 of 2 matching items.')).toBeInTheDocument();
    expect(screen.getByText('First queued item')).toBeInTheDocument();
  });

  it('approves a queue item into the publish stage with the normalized publish target', async () => {
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getQueueSnapshot') {
        return {
          success: true,
          totalCount: 1,
          items: [
            {
              id: 'content-2',
              Title: 'Azure review item',
              contentStatus: 'inspected',
              cloudProvider: 'Azure',
              type: 'blog',
              publishTarget: 'blog',
              summary: 'Ready for publish',
            },
          ],
        };
      }

      if (endpoint === 'transitionContentStatus') {
        return { success: true };
      }

      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue?status=needs_review']}>
        <QueuePage />
      </MemoryRouter>
    );

    expect(await screen.findByText('Azure review item')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Send to Publish/i }));

    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('transitionContentStatus', {
        contentId: 'content-2',
        newStatus: 'approved',
        publishTarget: 'blog',
        markLive: false,
        reviewNotes: 'Approved in queue for blog publish stage',
      })
    );

    // The server writes the audit row for a transition; the client no longer
    // doubles it (ADR 0033 §1).
    expect(logAdminAction).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.queryByText('Azure review item')).not.toBeInTheDocument();
    });
  });

  it('queues a forge-from-url job from the paste box and reports the job id', async () => {
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getQueueSnapshot') return { success: true, totalCount: 0, items: [] };
      if (endpoint === 'enqueueJob') return { ok: true, jobId: 'job-77' };
      return {};
    });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue']}>
        <QueuePage />
      </MemoryRouter>
    );

    const input = await screen.findByPlaceholderText(/paste an article to forge/i);
    fireEvent.change(input, { target: { value: 'https://learn.microsoft.com/azure/aks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forge' }));

    // The exact payload key matters: the job's worker reads payload.url. The
    // classification rides along (ADR 0033 §4): a pasted URL is an imported
    // source, and what it becomes defaults to an article.
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('enqueueJob', {
        type: 'forge-from-url',
        payload: {
          url: 'https://learn.microsoft.com/azure/aks',
          kind: 'article',
          ideaOrigin: 'imported-source',
        },
      })
    );
    expect(await screen.findByText(/Forge queued \(job job-77\)/)).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('points repository drafts at the Drafts page instead of importing them here', async () => {
    postJSON.mockResolvedValue({ success: true, totalCount: 0, items: [] });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue']}>
        <QueuePage />
      </MemoryRouter>
    );

    const link = await screen.findByRole('link', { name: 'Open Drafts' });
    expect(link).toHaveAttribute('href', '/admin/drafts');
    expect(
      screen.queryByRole('button', { name: 'Import drafts from the repository' })
    ).not.toBeInTheDocument();
    // The retired straight-to-review import is never called from the queue.
    const endpoints = [...postJSON.mock.calls, ...getJSON.mock.calls].map(([endpoint]) => endpoint);
    expect(endpoints.some((endpoint) => String(endpoint).includes('import-repo'))).toBe(false);
  });

  it('rejects a non-http paste without calling the backend', async () => {
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getQueueSnapshot') return { success: true, totalCount: 0, items: [] };
      return {};
    });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue']}>
        <QueuePage />
      </MemoryRouter>
    );

    const input = await screen.findByPlaceholderText(/paste an article to forge/i);
    fireEvent.change(input, { target: { value: 'not-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forge' }));

    expect(await screen.findByText(/valid http\(s\) article URL/i)).toBeInTheDocument();
    expect(postJSON).not.toHaveBeenCalledWith('enqueueJob', expect.anything());
  });
});

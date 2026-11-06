/**
 * /admin/interviews: the list reads GET cms/interviews and shows each
 * interview's guest, stage (with the reason a stage stopped), status and
 * whether it is on the site, links to its page, offers New interview, and
 * says so plainly when there are none or the read failed.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InterviewsPage from './InterviewsPage';

const getJSON = vi.fn();
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/lib/api', () => ({ getJSON: (...args) => getJSON(...args) }));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/interviews']}>
      <InterviewsPage />
    </MemoryRouter>
  );

// A block body on purpose: a function returned from beforeEach is run by
// Vitest as the test's teardown, and the mock is a function.
beforeEach(() => {
  getJSON.mockReset();
});

describe('InterviewsPage', () => {
  it('lists each interview with its guest, stage, status and link', async () => {
    getJSON.mockResolvedValue({
      ok: true,
      interviews: [
        {
          id: 'int-1',
          title: 'Landing zones in practice',
          guest: { name: 'Ada Example', role: 'Architect' },
          contentStatus: 'published',
          live: true,
          stage: 'ready',
          updatedAt: '2026-11-05T10:00:00Z',
        },
        {
          id: 'int-2',
          title: '',
          guest: null,
          contentStatus: 'draft',
          live: false,
          stage: 'failed',
          stageError: 'The URL answered with an empty file.',
        },
      ],
    });
    renderPage();
    const link = await screen.findByRole('link', { name: 'Landing zones in practice' });
    expect(link).toHaveAttribute('href', '/admin/interviews/int-1');
    expect(screen.getByText('Ada Example, Architect')).toBeInTheDocument();
    expect(screen.getByText(/Published · on the site/)).toBeInTheDocument();
    expect(
      screen.getByText(/Draft ready for your review · updated 2026-11-05/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Untitled interview' })).toBeInTheDocument();
    expect(
      screen.getByText('Stopped with a problem: The URL answered with an empty file.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New interview/ })).toHaveAttribute(
      'href',
      '/admin/interviews/new'
    );
    expect(getJSON).toHaveBeenCalledWith('cms/interviews');
  });

  it('says there are none yet, and reads again on Refresh', async () => {
    getJSON.mockResolvedValue({ ok: true, interviews: [] });
    renderPage();
    expect(await screen.findByText('No interviews yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
  });

  it('shows the API’s sentence when the list cannot be read', async () => {
    getJSON.mockImplementation(async () => {
      throw new Error('Failed to list the interviews (reference abc)');
    });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to list the interviews');
    expect(screen.queryByText('No interviews yet.')).not.toBeInTheDocument();
  });
});

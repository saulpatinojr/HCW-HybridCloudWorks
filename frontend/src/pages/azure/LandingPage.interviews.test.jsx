/**
 * Azure's landing page links the interviews once there is one, and not before.
 * The link lives here and not in the header, whose toolbar is a fixed grid of
 * nine slots (see Header.interviews.test.jsx).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));
vi.mock('@/hooks/useAudioEpisodes', () => ({ default: () => ({ episodes: [] }) }));

async function renderLanding({ hasInterviews }) {
  vi.resetModules();
  vi.doMock('@/data/interviews/available', () => ({ hasInterviews }));
  const { default: LandingPage } = await import('./LandingPage');
  return render(
    <MemoryRouter initialEntries={['/azure']}>
      <LandingPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.doUnmock('@/data/interviews/available');
});

describe('Azure landing page: interviews', () => {
  it('links the interviews once there is one', async () => {
    await renderLanding({ hasInterviews: true });
    expect(screen.getByRole('heading', { name: 'Interviews' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All interviews/ })).toHaveAttribute(
      'href',
      '/azure/interviews'
    );
  });

  it('says nothing of interviews while there are none', async () => {
    await renderLanding({ hasInterviews: false });
    expect(screen.queryByRole('heading', { name: 'Interviews' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /interviews/i })).not.toBeInTheDocument();
  });

  it('keeps its other sections either way', async () => {
    await renderLanding({ hasInterviews: true });
    for (const name of ['Frameworks', 'Azure Podcasts', 'Certification Tracks']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });
});

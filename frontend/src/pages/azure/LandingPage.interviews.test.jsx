/**
 * Azure's landing page links the interviews once there is one, and not before.
 * The link lives here and not in the header, whose toolbar is a fixed grid of
 * nine slots (see Header.interviews.test.jsx). Whether there is one is read
 * live from the public list (ADR 0040, D6), under the same key the Interviews
 * page and the pre-render seed use.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rawInterview } from '@/test-utils/interviews';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));
vi.mock('@/hooks/useAudioEpisodes', () => ({ default: () => ({ episodes: [] }) }));

const state = vi.hoisted(() => ({ list: [], reads: 0 }));
vi.mock('@/lib/publicApi', async (importOriginal) => ({
  // The page's other reads (frameworks, podcasts) keep the real client, which
  // has no API base in a test and answers nothing; only the interview list is stubbed.
  ...(await importOriginal()),
  fetchPublicInterviews: vi.fn(async () => {
    state.reads += 1;
    return state.list;
  }),
  fetchPublicInterview: vi.fn(async () => null),
}));

const { default: LandingPage } = await import('./LandingPage');

async function renderLanding({ hasInterviews }) {
  state.list = hasInterviews ? [{ slug: 'first-one', ...rawInterview() }] : [];
  const rendered = render(
    <MemoryRouter initialEntries={['/azure']}>
      <LandingPage />
    </MemoryRouter>
  );
  // The list is read in an effect; wait for the read to have been made and
  // let its answer land, so "nothing of interviews" is judged after it.
  await waitFor(() => expect(state.reads).toBeGreaterThan(0));
  await act(async () => {});
  return rendered;
}

beforeEach(() => {
  state.list = [];
  state.reads = 0;
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

  it('offers the book view only where it is offered: on a wide screen, not to everyone', async () => {
    // The page shows it on a wide screen to a visitor who has not asked for less
    // motion; promising it unqualified would promise a phone something it never gets.
    const { container } = await renderLanding({ hasInterviews: true });
    const text = container.textContent;
    expect(text).toMatch(/On a wide screen there is also a book view/);
    expect(text).not.toMatch(/or turn the pages of a book/);
  });

  it('says nothing of interviews while there are none', async () => {
    await renderLanding({ hasInterviews: false });
    expect(screen.queryByRole('heading', { name: 'Interviews' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /interviews/i })).not.toBeInTheDocument();
  });

  it('carries no interview text: the card is the same sentence whatever is published', async () => {
    const { container } = await renderLanding({ hasInterviews: true });
    expect(container.textContent).not.toContain('Test Guest');
    expect(container.textContent).not.toContain('A Test Interview');
  });

  it('keeps its other sections either way', async () => {
    await renderLanding({ hasInterviews: true });
    for (const name of ['Frameworks', 'Azure Podcasts', 'Certification Tracks']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });
});

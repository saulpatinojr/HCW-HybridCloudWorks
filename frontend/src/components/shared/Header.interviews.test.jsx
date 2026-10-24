/**
 * The header and Azure's interviews.
 *
 * Two things, both found by looking at the page (CodeRabbit on #1337, and a
 * browser run), and neither visible to a test that only counts links:
 *
 * - The toolbar is a fixed grid of nine 100 px slots and its divider sits in the
 *   same place on every hub. A tenth link for Azure overflowed it at desktop
 *   widths, so Azure's interviews are linked from its landing page and the
 *   header stays at nine links whether or not an interview exists.
 * - The header finds the provider from the URL alone. An interview page that
 *   was not a known page type made it fall back to the generic provider list,
 *   so a reader of an interview lost the Azure menu.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AZURE_HUB = [
  'Home',
  'Azure',
  'News',
  'Blogs',
  'Architecture',
  'Podcast',
  'Frameworks',
  'Learn',
  'Labs',
];

async function labelsAt(pathname, { hasInterviews = false } = {}) {
  vi.resetModules();
  vi.doMock('@/data/interviews/available', () => ({ hasInterviews }));
  const { default: Header } = await import('./Header');
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Header />
    </MemoryRouter>
  );
  const nav = screen.getByRole('navigation', { name: 'Primary' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent.trim());
}

afterEach(() => {
  vi.doUnmock('@/data/interviews/available');
});

describe('Header: Azure keeps its nine links', () => {
  it.each([false, true])('with interviews = %s', async (hasInterviews) => {
    expect(await labelsAt('/azure', { hasInterviews })).toEqual(AZURE_HUB);
  });
});

describe('Header: the interview pages are Azure pages', () => {
  it.each(['/azure/interviews', '/azure/interviews/a-conversation-about-landing-zones'])(
    'keeps the Azure menu on %s, not the generic provider list',
    async (pathname) => {
      expect(await labelsAt(pathname, { hasInterviews: true })).toEqual(AZURE_HUB);
    }
  );
});

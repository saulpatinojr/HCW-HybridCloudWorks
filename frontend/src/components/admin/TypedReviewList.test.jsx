import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TypedReviewList from './TypedReviewList';
import { getJSON } from '@/lib/api';
vi.mock('@/lib/api', () => ({ getJSON: vi.fn(async () => ({ items: [] })) }));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/pages/admin/queue/useContentTransitions', () => ({
  useContentTransitions: () => ({ loading: {}, errors: {} }),
}));
vi.mock('@/components/admin/ConfirmModal', () => ({ default: () => null }));

it('distinguishes an empty article search from an empty status and lets the reader clear it', async () => {
  render(
    <MemoryRouter initialEntries={['/admin/blogs']}>
      <TypedReviewList
        type="blog"
        nouns={{ singular: 'article', plural: 'articles' }}
        showHeader={false}
        enableSearch
        renderCard={() => null}
      />
    </MemoryRouter>
  );
  expect(await screen.findByText('No articles in this status')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search article titles and summaries'), {
    target: { value: 'missing article' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search articles' }));
  expect(await screen.findByText('No articles match this search')).toBeInTheDocument();
  expect(screen.getByText(/Try another title or summary/)).toBeInTheDocument();
  expect(getJSON.mock.lastCall[0]).toContain('search=missing+article');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh / clear' }));
  expect(await screen.findByText('No articles in this status')).toBeInTheDocument();
  expect(getJSON.mock.lastCall[0]).not.toContain('search=');
});

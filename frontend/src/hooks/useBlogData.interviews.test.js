/**
 * The blog list never shows an interview (ADR 0040, D6): an interview is a
 * `content` document of its own type with its own page, and the public
 * content list can carry one beside the posts.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] }));
vi.mock('@/lib/publicApi', () => ({
  PUBLIC_CORPUS_LIMIT: 250,
  fetchPublicContentList: vi.fn(async () => state.items),
}));

const { useBlogData } = await import('./useBlogData');

const published = (over) => ({
  id: over.id,
  Title: over.title,
  slug: over.id,
  cloudProvider: 'Azure',
  content: 'A body with enough words to count as a post for the list.',
  publishedAt: '2026-10-01T00:00:00Z',
  contentStatus: 'published',
  Live: true,
  ...over,
});

describe('useBlogData and interviews', () => {
  it('lists the post and leaves the interview out, however its type is cased', async () => {
    state.items = [
      published({ id: 'a-post', title: 'A post', type: 'blog' }),
      published({ id: 'an-interview', title: 'An interview', type: 'interview' }),
      published({ id: 'another-interview', title: 'Another', type: 'Interview' }),
    ];
    const { result } = renderHook(() => useBlogData('azure'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.posts.map((post) => post.id)).toEqual(['a-post']);
  });
});

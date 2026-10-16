import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import ReviewPage from './ReviewPage';

const mockGetJSON = vi.fn();
const mockPostJSON = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => mockGetJSON(...args),
  postJSON: (...args) => mockPostJSON(...args),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/components/admin/BlogReviewBoard', () => ({
  default: ({ blog }) => <div data-testid="blog-review-board">{blog.title}</div>,
}));

vi.mock('@/components/admin/FrameworkReviewBoard', () => ({
  default: ({ blog }) => <div data-testid="framework-review-board">{blog.title}</div>,
}));

vi.mock('@/components/admin/ArchitectureReviewBoard', () => ({
  default: ({ blog }) => <div data-testid="architecture-review-board">{blog.title}</div>,
}));

vi.mock('@/components/admin/PipelineStepper', () => ({
  default: () => <div data-testid="pipeline-stepper" />,
}));

vi.mock('@/components/admin/shared/StatusBadge', () => ({
  default: () => <div data-testid="status-badge" />,
}));

vi.mock('@/components/admin/shared/TaxonomyChips', () => ({
  default: () => <div data-testid="taxonomy-chips" />,
}));

describe('ReviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state when fetching item', () => {
    mockGetJSON.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(
      <MemoryRouter initialEntries={['/admin/review-queue/post-101']}>
        <Routes>
          <Route path="/admin/review-queue/:blogId" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Loading content…/i)).toBeInTheDocument();
  });

  it('renders unavailable empty state if fetch fails or returns null', async () => {
    mockGetJSON.mockRejectedValue(new Error('Item not found'));

    render(
      <MemoryRouter initialEntries={['/admin/review-queue/invalid-id']}>
        <Routes>
          <Route path="/admin/review-queue/:blogId" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('This item could not be loaded')).toBeInTheDocument();
    });
  });

  it('renders blog review board for a blog item', async () => {
    mockGetJSON.mockResolvedValue({
      item: {
        id: 'post-101',
        title: 'Reviewing Awesome Blog Post',
        type: 'blog',
        contentStatus: 'needs_review',
      },
    });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue/post-101']}>
        <Routes>
          <Route path="/admin/review-queue/:blogId" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Reviewing Awesome Blog Post' })
      ).toBeInTheDocument();
      expect(screen.getByTestId('blog-review-board')).toBeInTheDocument();
    });
  });

  it('renders framework review board for a framework item', async () => {
    mockGetJSON.mockResolvedValue({
      item: {
        id: 'fw-202',
        title: 'Reviewing Framework Post',
        type: 'framework',
        contentStatus: 'needs_review',
      },
    });

    render(
      <MemoryRouter initialEntries={['/admin/review-queue/fw-202']}>
        <Routes>
          <Route path="/admin/review-queue/:blogId" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Reviewing Framework Post' })
      ).toBeInTheDocument();
      expect(screen.getByTestId('framework-review-board')).toBeInTheDocument();
    });
  });
});

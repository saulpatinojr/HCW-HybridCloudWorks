import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { runAxe } from '@/test-utils/axe';
import AdminLayout from './AdminLayout';
import QueuePage from './QueuePage';
import SetSlugPanel from './SetSlugPanel';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const postJSON = vi.fn();
const getJSON = vi.fn();
const logAdminAction = vi.fn();

vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  getJSON: (...args) => getJSON(...args),
}));

vi.mock('@/lib/auditLog', () => ({
  logAdminAction: (...args) => logAdminAction(...args),
}));

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

describe('Admin accessibility assertions (QA-4 / AP-F9)', () => {
  beforeEach(() => {
    postJSON.mockReset();
    getJSON.mockReset();
    logAdminAction.mockReset();
  });

  it('verifies accessibility of the Admin shell (AdminLayout)', async () => {
    postJSON.mockResolvedValue({
      stats: {
        blog: { needsReview: 1, inProgress: 0, published: 2 },
      },
    });

    const { container } = render(
      <AdminRoleProvider value="super_admin">
        <MemoryRouter initialEntries={['/admin/dashboard']}>
          <Routes>
            <Route path="/admin" element={<AdminLayout />}>
              <Route path="dashboard" element={<div>Dashboard Content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AdminRoleProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    });

    const results = await runAxe(container, {
      rules: {
        // In unit tests with partial routes/MemoryRouter, region landmark can be scoped
        region: { enabled: false },
      },
    });

    expect(results).toHaveNoViolations();
  });

  it('verifies accessibility of QueuePage', async () => {
    postJSON.mockResolvedValue({
      success: true,
      totalCount: 1,
      items: [
        {
          id: 'item-1',
          Title: 'Test Queue Article',
          contentStatus: 'needs_review',
          cloudProvider: 'Azure',
          summary: 'A short summary for testing a11y',
        },
      ],
    });

    const { container } = render(
      <AdminRoleProvider value="super_admin">
        <MemoryRouter initialEntries={['/admin/review-queue']}>
          <QueuePage />
        </MemoryRouter>
      </AdminRoleProvider>
    );

    await screen.findByRole('heading', { level: 1, name: 'Review Queue' });

    const results = await runAxe(container, {
      rules: {
        region: { enabled: false },
        'heading-order': { enabled: false },
      },
    });

    expect(results).toHaveNoViolations();
  });

  it('verifies accessibility of a form panel (SetSlugPanel)', async () => {
    const item = {
      id: 'doc-123',
      Title: 'Example Slug Item',
      slug: 'current-slug-value',
      Slug: 'suggested-slug-value',
    };

    const { container } = render(
      <MemoryRouter>
        <SetSlugPanel item={item} onSuccess={vi.fn()} onCancel={vi.fn()} />
      </MemoryRouter>
    );

    await screen.findByText('Set slug & republish');

    const results = await runAxe(container, {
      rules: {
        region: { enabled: false },
      },
    });

    expect(results).toHaveNoViolations();
  });
});

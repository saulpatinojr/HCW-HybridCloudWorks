import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import FrameworksPage, { FrameworkCard } from './FrameworksPage';

vi.mock('@/components/admin/TypedReviewList', () => ({
  default: ({ type, nouns, help }) => (
    <div data-testid="typed-review-list">
      <span>{type}</span>
      <span>{nouns.singular}</span>
      <ul>
        {help.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
    </div>
  ),
  canApproveIn: (status) => status === 'needs_review',
  canRejectIn: (status) => status === 'needs_review',
}));

vi.mock('@/components/admin/shared/StatusBadge', () => ({
  default: ({ content }) => <div>Status: {content.contentStatus || 'draft'}</div>,
}));

vi.mock('@/components/admin/shared/TaxonomyChips', () => ({
  default: () => <div>TaxonomyChips</div>,
}));

describe('FrameworksPage', () => {
  it('renders TypedReviewList configured for framework', () => {
    render(
      <MemoryRouter>
        <FrameworksPage />
      </MemoryRouter>
    );

    expect(screen.getByTestId('typed-review-list')).toBeInTheDocument();
    expect(screen.getAllByText('framework')).toHaveLength(2);
    expect(
      screen.getByText(/What arrives here: content created with the Framework type/i)
    ).toBeInTheDocument();
  });

  it('renders FrameworkCard with title, provider, summary, and actions', () => {
    const item = {
      id: 'fw-1',
      title: 'Azure Cloud Adoption Framework',
      cloudProvider: 'Azure',
      category: 'Governance',
      summary: 'Guidance and best practices for cloud migration.',
      sourceUrl: 'https://learn.microsoft.com/azure/cloud-adoption-framework',
      contentStatus: 'needs_review',
    };

    const handleApprove = vi.fn();
    const handleReject = vi.fn();
    const navigate = vi.fn();

    render(
      <MemoryRouter>
        <FrameworkCard
          item={item}
          statusFilter="needs_review"
          handleApprove={handleApprove}
          handleReject={handleReject}
          navigate={navigate}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Azure Cloud Adoption Framework')).toBeInTheDocument();
    expect(screen.getByText('Azure')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.getByText(/Guidance and best practices/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/i })).toBeInTheDocument();
  });
});

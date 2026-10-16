import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CoderCornerPage from './CoderCornerPage';

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
  canApproveIn: vi.fn(),
  canRejectIn: vi.fn(),
}));

describe('CoderCornerPage', () => {
  it('renders TypedReviewList configured for coder_corner', () => {
    render(
      <MemoryRouter>
        <CoderCornerPage />
      </MemoryRouter>
    );

    expect(screen.getByTestId('typed-review-list')).toBeInTheDocument();
    expect(screen.getByText('coder_corner')).toBeInTheDocument();
    expect(screen.getByText('coder corner item')).toBeInTheDocument();
    expect(
      screen.getByText(/What arrives here: content created with the Coder Corner type/i)
    ).toBeInTheDocument();
  });
});

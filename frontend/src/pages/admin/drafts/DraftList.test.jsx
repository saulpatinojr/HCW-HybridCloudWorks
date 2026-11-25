/**
 * The Drafts list's "sent from" chip is a real link back to the Page that
 * sent the draft, outside the row's own button (review of #1890).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DraftList from './DraftList';

vi.mock('@/components/admin/shared/useTaxonomy', () => ({
  useTaxonomy: () => ({ taxonomy: { kinds: [], ideaOrigins: [] } }),
}));

const DRAFT = {
  id: 'd1',
  title: 'Reading a commit graph',
  stage: 'drafting',
  origin: 'drafts',
  actions: {},
  originRef: {
    page: 'ambassador',
    id: 'program-example',
    part: null,
    label: 'Example Program',
  },
};

describe('DraftList', () => {
  it('links a draft back to the program it was started for, outside the row button', () => {
    render(
      <MemoryRouter>
        <DraftList drafts={[DRAFT]} loading={false} selectedId={null} onSelect={vi.fn()} />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: 'Ambassador · Example Program' });
    expect(link).toHaveAttribute('href', '/admin/ambassador?tab=programs&program=program-example');
    const rowButton = screen.getByRole('button', { name: /Reading a commit graph/ });
    expect(within(rowButton).queryByRole('link')).not.toBeInTheDocument();
  });
});

/**
 * The next-step link (#1886): rendered by TaxonomyChips beside the "sent
 * from" chip, so every Pipeline list that shows a live piece offers it.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import NextStepLink from './NextStepLink';
import TaxonomyChips from './TaxonomyChips';

vi.mock('./useTaxonomy', () => ({
  useTaxonomy: () => ({ taxonomy: { kinds: [], ideaOrigins: [] } }),
}));

const REF = { page: 'ambassador', id: 'program-example', part: null, label: 'Example Program' };
const LIVE = { id: 'c1', Live: true, contentStatus: 'published', originRef: REF };

describe('NextStepLink', () => {
  it('links a live piece to the record it was written for', () => {
    render(
      <MemoryRouter>
        <NextStepLink item={LIVE} />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: /File as evidence/ });
    expect(link).toHaveAttribute('href', '/admin/ambassador?tab=programs&program=program-example');
  });

  it('renders nothing before the piece is live', () => {
    const { container } = render(
      <MemoryRouter>
        <NextStepLink item={{ ...LIVE, Live: false, contentStatus: 'approved' }} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TaxonomyChips with a live piece', () => {
  it('shows the next step beside the "sent from" chip', () => {
    render(
      <MemoryRouter>
        <TaxonomyChips
          item={{ ...LIVE, originRef: { ...REF, page: 'speaking', id: 'talk-example' } }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /Back to the talk/ })).toHaveAttribute(
      'href',
      '/admin/speaking?talk=talk-example'
    );
  });

  it('leaves it out inside a row that is itself a link, and when the source is hidden', () => {
    const { rerender } = render(<TaxonomyChips item={LIVE} sourceAsLink={false} />);
    expect(screen.queryByText(/File as evidence/)).not.toBeInTheDocument();
    rerender(<TaxonomyChips item={LIVE} showSource={false} />);
    expect(screen.queryByText(/File as evidence/)).not.toBeInTheDocument();
  });
});

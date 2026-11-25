/**
 * The "sent from" chip (#1886): rendered by TaxonomyChips, so every Pipeline
 * page shows it; a link back to the record, or a plain chip inside a row that
 * is itself a button.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OriginChip from './OriginChip';
import TaxonomyChips from './TaxonomyChips';

vi.mock('./useTaxonomy', () => ({
  useTaxonomy: () => ({ taxonomy: { kinds: [], ideaOrigins: [] } }),
}));

const REF = {
  page: 'ambassador',
  id: 'program-example',
  part: null,
  label: 'Example Program',
};

describe('OriginChip', () => {
  it('links back to the record on the Page that sent it', () => {
    render(
      <MemoryRouter>
        <OriginChip originRef={REF} />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: 'Ambassador · Example Program' });
    expect(link).toHaveAttribute('href', '/admin/ambassador?tab=programs&program=program-example');
  });

  it('is a plain chip when asked, for a row that is already a button', () => {
    render(<OriginChip originRef={REF} asLink={false} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Ambassador · Example Program')).toBeInTheDocument();
  });

  it('renders nothing for content no Page sent', () => {
    const { container } = render(<OriginChip originRef={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TaxonomyChips', () => {
  it('shows the sending Page beside the kind and idea origin, on every page that uses it', () => {
    render(
      <MemoryRouter>
        <TaxonomyChips item={{ kind: 'article', ideaOrigin: 'manual', originRef: REF }} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /Example Program/ })).toBeInTheDocument();
  });

  it('can leave it out', () => {
    render(<TaxonomyChips item={{ originRef: REF }} showSource={false} />);
    expect(screen.queryByText(/Example Program/)).not.toBeInTheDocument();
  });
});

/**
 * The footer's programme credit (#1302, #1078): a plain text link to the
 * GitKraken Ambassador programme page, opened in a new tab with the same
 * rel the social links carry, and no logo until the owner drops the badge
 * asset in. The signup placement is mocked out: PlacedNewsletterSignup has
 * its own test and a request of its own.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('@/components/shared/PlacedNewsletterSignup', () => ({
  default: () => null,
}));

import Footer from '@/components/shared/Footer';

describe('Footer', () => {
  it('links the GitKraken Ambassador programme page as text, in a new tab, without a logo', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: 'GitKraken Ambassador' });
    expect(link).toHaveAttribute('href', 'https://www.gitkraken.com/ambassador');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.querySelector('img, svg')).toBeNull();
  });

  it('keeps the site links around it', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    for (const name of ['About', 'Contact', 'Privacy Policy', 'Terms', 'Admin']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});

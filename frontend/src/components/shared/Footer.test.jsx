/** Public footer links; private ambassador programmes do not belong here. */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('@/components/shared/PlacedNewsletterSignup', () => ({
  default: () => null,
}));

import Footer from '@/components/shared/Footer';

describe('Footer', () => {
  it('does not advertise a private ambassador membership', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link', { name: /ambassador/i })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Footer' })).toBeInTheDocument();
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

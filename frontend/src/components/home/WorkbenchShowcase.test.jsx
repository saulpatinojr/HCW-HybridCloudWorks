import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import WorkbenchShowcase from './WorkbenchShowcase';

function renderShowcase() {
  return render(
    <MemoryRouter>
      <WorkbenchShowcase />
    </MemoryRouter>
  );
}

describe('WorkbenchShowcase (Audit P1-2)', () => {
  it('renders the interactive workbench section and heading', () => {
    renderShowcase();
    expect(screen.getByTestId('workbench-showcase')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Engineered Workbenches\. Zero Local Setup\./i })
    ).toBeInTheDocument();
  });

  it('renders the Landing Zone Builder workbench card with 1-click CTA and FOCUS 1.4 copy', () => {
    renderShowcase();
    const lzCard = screen.getByTestId('workbench-card-landing-zone');
    expect(lzCard).toBeInTheDocument();
    expect(lzCard).toHaveTextContent(/Multi-Cloud Landing Zone Builder/i);
    expect(lzCard).toHaveTextContent(/Azure Verified Modules/i);
    expect(lzCard).toHaveTextContent(/FOCUS 1\.4/i);

    const launchLzLink = screen.getByRole('link', { name: /Launch Landing Zone Builder/i });
    expect(launchLzLink).toHaveAttribute('href', '/tools/landing-zone');
  });

  it('renders the Ephemeral Container Browser Labs card with 1-click CTA and trust guarantees', () => {
    renderShowcase();
    const labCard = screen.getByTestId('workbench-card-labs');
    expect(labCard).toBeInTheDocument();
    expect(labCard).toHaveTextContent(/Ephemeral Container Browser Labs/i);
    expect(labCard).toHaveTextContent(/read:user Only/i);
    expect(labCard).toHaveTextContent(/~15 Min/i);
    expect(labCard).toHaveTextContent(/tflint/i);

    const launchLabLink = screen.getByRole('link', { name: /Launch Browser Labs/i });
    expect(launchLabLink).toHaveAttribute('href', '/education/labs');
  });
});

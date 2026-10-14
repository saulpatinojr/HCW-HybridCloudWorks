import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LabPreflightCard, { PREFLIGHT_TOOLS } from './LabPreflightCard';

describe('LabPreflightCard (Audit P2-2)', () => {
  it('renders pre-flight briefing heading, description, and trust pills', () => {
    render(<LabPreflightCard />);
    expect(screen.getByTestId('lab-preflight-card')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Hybrid Lab Pre-Flight Briefing/i })
    ).toBeInTheDocument();

    const trustPills = screen.getByTestId('lab-preflight-trust');
    expect(trustPills).toHaveTextContent('15-Min Scenarios');
    expect(trustPills).toHaveTextContent('Browser Terminal');
    expect(trustPills).toHaveTextContent('Zero Cloud Account Required');
  });

  it('renders pre-installed toolchains with commands and roles', () => {
    render(<LabPreflightCard />);
    for (const tool of PREFLIGHT_TOOLS) {
      expect(screen.getByText(tool.cmd)).toBeInTheDocument();
      expect(screen.getByText(tool.role)).toBeInTheDocument();
    }
  });

  it('renders explicit read:user identity scope guarantee and privacy disclosure', () => {
    render(<LabPreflightCard />);
    const privacy = screen.getByTestId('lab-privacy-assurance');
    expect(privacy).toHaveTextContent('Privacy & Security Disclosure');
    expect(privacy).toHaveTextContent('read:user scope');
    expect(privacy).toHaveTextContent(/never request repository access/i);
  });

  it('renders in compact mode with appropriate max-width styling', () => {
    const { container } = render(<LabPreflightCard compact />);
    const section = container.querySelector('[data-testid="lab-preflight-card"]');
    expect(section).toHaveClass('max-w-2xl');
  });
});

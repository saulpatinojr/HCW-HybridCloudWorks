import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { HelmetProvider } from 'react-helmet-async';
import ArchitectureDetailTemplate from './ArchitectureDetailTemplate';
import { initialBlueprintForm } from '@/components/admin/ArchitectureReviewBoard';

const mockFetchPublicContentItem = vi.fn();

vi.mock('@/lib/publicApi', () => ({
  fetchPublicContentItem: (...args) => mockFetchPublicContentItem(...args),
}));

function renderArchitectureRoute(path, provider) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path={`/${provider}/architecture-designs/:slug`}
            element={<ArchitectureDetailTemplate provider={provider} />}
          />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>
  );
}

describe('ArchitectureDetailTemplate — Mini Landing Page (#1084)', () => {
  beforeEach(() => {
    mockFetchPublicContentItem.mockReset();
    mockFetchPublicContentItem.mockResolvedValue(null);
  });

  it('renders /azure/architecture-designs/secure-2-tier-azure with Hero promise, full-width diagram, and 4 doorway panes', async () => {
    renderArchitectureRoute('/azure/architecture-designs/secure-2-tier-azure', 'azure');

    expect(
      await screen.findByRole('heading', { name: 'Secure 2-Tier Application on Azure' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('mini-landing-promise')).toHaveTextContent(
      /Application Gateway with WAF, segmented VNet subnets with NSGs, and a Private Endpoint to Azure SQL/i
    );
    expect(screen.getByTestId('topology-diagram')).toBeInTheDocument();

    expect(screen.getByTestId('landing-pane-how-it-works')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-key-services')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-security')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-outcome')).toBeInTheDocument();

    // Technical action links in MiniLandingFrame
    expect(screen.getByRole('link', { name: /Landing Zone Builder/i })).toHaveAttribute(
      'href',
      '/tools/landing-zone?preset=secure-2-tier'
    );
    expect(screen.getByRole('link', { name: /Test in Browser Lab/i })).toHaveAttribute(
      'href',
      '/education/labs/terraform-validate'
    );

    // Overview tab contains "When NOT to Use This Architecture"
    expect(screen.getByTestId('blueprint-when-not-to-use')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-when-not-to-use')).toHaveTextContent(
      /Low-budget dev\/test sandboxes/i
    );

    // Clicking the Outcome doorway pane switches the deep dive to Cost Analysis
    fireEvent.click(screen.getByTestId('landing-pane-door-outcome'));
    expect(await screen.findByText('Estimated Monthly Cost')).toBeInTheDocument();
    expect(screen.getByText('$680 - $1,250 / month')).toBeInTheDocument();

    // Cost Analysis tab contains FinOps Cost Traps (FOCUS 1.1 Specification)
    expect(screen.getByTestId('blueprint-finops-cost-traps')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-finops-cost-traps')).toHaveTextContent(
      /Application Gateway.*Capacity Units/i
    );
  });

  it('hides empty panes and empty deep-dive tabs instead of rendering placeholder text (#1084 item 3)', async () => {
    mockFetchPublicContentItem.mockResolvedValue({
      type: 'architecture',
      title: 'Minimal Custom Blueprint',
      promise: 'A concise custom pattern with only How It Works populated.',
      howItWorks: ['Ingress hits the edge gateway.', 'Requests route to the private worker pool.'],
      keyServices: [],
      practices: [],
      outcome: [],
      overview: '',
      terraformCode: '',
      deploymentSteps: [],
      estimatedCost: '',
      costAnalysis: {},
    });

    renderArchitectureRoute('/azure/architecture-designs/minimal-custom-blueprint', 'azure');

    expect(
      await screen.findByRole('heading', { name: 'Minimal Custom Blueprint' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-how-it-works')).toBeInTheDocument();

    // Empty panes and trade-offs are omitted
    expect(screen.queryByTestId('landing-pane-key-services')).not.toBeInTheDocument();
    expect(screen.queryByTestId('landing-pane-security')).not.toBeInTheDocument();
    expect(screen.queryByTestId('landing-pane-outcome')).not.toBeInTheDocument();
    expect(screen.queryByTestId('blueprint-when-not-to-use')).not.toBeInTheDocument();
    expect(screen.queryByTestId('blueprint-finops-cost-traps')).not.toBeInTheDocument();

    // Zero placeholder text on the public page
    expect(
      screen.queryByText(/Detailed architecture overview will be loaded from Firestore/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Terraform code will be loaded from Firestore/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Architecture diagram will be displayed here/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('$500-$2,000')).not.toBeInTheDocument();
    expect(screen.queryByText(/Use Reserved Instances/i)).not.toBeInTheDocument();
  });

  it('accepts promise, howItWorks, keyServices, practices, outcome, whenNotToUse, and finopsCostTraps in initialBlueprintForm (#1084 item 1)', () => {
    const form = initialBlueprintForm({
      title: 'Secure 2-Tier Application on Azure',
      promise: 'Edge WAF + VNet NSGs + Private Endpoint to Azure SQL.',
      howItWorks: ['Step 1', 'Step 2'],
      keyServices: [{ name: 'Application Gateway', icon: 'shield', role: 'WAF v2' }],
      practices: ['Prevention mode WAF'],
      outcome: ['Zero public database exposure'],
      whenNotToUse: [
        {
          condition: 'Single static site',
          reason: 'Over-engineered',
          alternative: 'Azure Storage static website',
        },
      ],
      finopsCostTraps: [
        {
          risk: 'Idle WAF instances',
          impact: '$100+/mo',
          mitigation: 'Autoscale min instances to 1',
        },
      ],
      landingZonePreset: 'secure-2-tier',
      interactiveLabId: 'terraform-validate',
    });

    expect(form.promise).toBe('Edge WAF + VNet NSGs + Private Endpoint to Azure SQL.');
    expect(form.howItWorks).toEqual(['Step 1', 'Step 2']);
    expect(form.keyServices).toEqual([
      { name: 'Application Gateway', icon: 'shield', role: 'WAF v2' },
    ]);
    expect(form.practices).toEqual(['Prevention mode WAF']);
    expect(form.outcome).toEqual(['Zero public database exposure']);
    expect(form.whenNotToUse).toEqual([
      {
        condition: 'Single static site',
        reason: 'Over-engineered',
        alternative: 'Azure Storage static website',
      },
    ]);
    expect(form.finopsCostTraps).toEqual([
      {
        risk: 'Idle WAF instances',
        impact: '$100+/mo',
        mitigation: 'Autoscale min instances to 1',
      },
    ]);
    expect(form.landingZonePreset).toBe('secure-2-tier');
    expect(form.interactiveLabId).toBe('terraform-validate');
  });

  it('renders /gcp/architecture-designs/global-load-balancing with Mini Landing Page elements (#Phase4)', async () => {
    renderArchitectureRoute('/gcp/architecture-designs/global-load-balancing', 'gcp');

    expect(
      await screen.findByRole('heading', { name: 'Global Load Balancing' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('mini-landing-promise')).toHaveTextContent(
      /Global anycast IP routing, sub-second regional failover, and Cloud Armor edge security/i
    );
    expect(screen.getByTestId('topology-diagram')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-how-it-works')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-key-services')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-security')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-outcome')).toBeInTheDocument();
  });

  it('renders /finops/architecture-designs/multi-cloud-cost-optimization with Mini Landing Page elements (#Phase4)', async () => {
    renderArchitectureRoute('/finops/architecture-designs/multi-cloud-cost-optimization', 'finops');

    expect(
      await screen.findByRole('heading', { name: 'Multi-Cloud Cost Optimization' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('mini-landing-promise')).toHaveTextContent(
      /Normalized FOCUS 1.0 cost datasets uniting Azure, AWS, and GCP billing exports/i
    );
    expect(screen.getByTestId('topology-diagram')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-how-it-works')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-key-services')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-security')).toBeInTheDocument();
    expect(screen.getByTestId('landing-pane-outcome')).toBeInTheDocument();
  });
});

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  COPILOT_REVIEW_RUNBOOK_URL,
  CopilotReviewNote,
  HostingerMcpNote,
  LISTED_FACT_LABELS,
  MCP_SERVERS_HREF,
  MUSE_READER_RUNBOOK_URL,
  MuseReaderNote,
  ReplicateMcpNote,
  TFC_AZURE_RUNS_URL,
  TFC_AZURE_VARIABLES_URL,
  TerraformRunIdentityNote,
} from './ListedCredential';

const renderNote = (Note) =>
  render(
    <MemoryRouter>
      <Note />
    </MemoryRouter>
  );

describe('a listed credential', () => {
  it.each([
    ['Replicate MCP', ReplicateMcpNote],
    ['Hostinger MCP', HostingerMcpNote],
    ['Copilot review', CopilotReviewNote],
    ['Muse reader', MuseReaderNote],
    ['Terraform run identity', TerraformRunIdentityNote],
  ])('%s shows all five lines, each with something to read', (_name, Note) => {
    const { container } = renderNote(Note);
    expect(LISTED_FACT_LABELS).toEqual(['Stored in', 'Cost', 'Test', 'Replace', 'Expires']);
    for (const label of LISTED_FACT_LABELS) {
      const term = screen.getByText(label);
      expect(term.nextElementSibling.textContent, `${label} is empty`).toMatch(/\w{3}/);
    }
    expect(container.textContent).toMatch(/not on the Keys tab/i);
    expect(screen.getByRole('link', { name: 'Credentials tab' })).toHaveAttribute(
      'href',
      '/admin/integrations?tab=credentials'
    );
  });

  it.each([
    ['Replicate', ReplicateMcpNote],
    ['Hostinger', HostingerMcpNote],
  ])(
    'sends the %s connection to the AI Engine’s MCP tab to test and reconnect it',
    (vendor, Note) => {
      renderNote(Note);
      const links = screen.getAllByRole('link', { name: 'AI Engine → MCP Servers' });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link).toHaveAttribute('href', MCP_SERVERS_HREF);
      const replace = screen.getByText('Replace').nextElementSibling;
      expect(within(replace).getByText(new RegExp(`sign in at\\s+${vendor} again`))).toBeTruthy();
    }
  );

  it('says where the Copilot review key is stored and links the runbook that replaces it', () => {
    renderNote(CopilotReviewNote);
    expect(screen.getByText(/Secrets and variables → Agents/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'the runbook' })).toHaveAttribute(
      'href',
      COPILOT_REVIEW_RUNBOOK_URL
    );
    expect(screen.getByText(/cannot test it/i)).toBeInTheDocument();
  });

  it('says what the Muse reader secret can reach, that it costs nothing, how to check and replace it, and when it stops working', () => {
    const { container } = renderNote(MuseReaderNote);
    expect(container.textContent).toMatch(/sp-muse-reader-plat-prod-cus-01/);
    expect(container.textContent).toMatch(/Reader role only/);
    const fact = (label) => screen.getByText(label).nextElementSibling;
    expect(fact('Stored in').textContent).toMatch(/muse_reader_client_secret/);
    expect(fact('Cost').textContent).toMatch(/^Nothing\./);
    // Every "costs nothing" claim links the Microsoft page that says so.
    expect(within(fact('Cost')).getAllByRole('link')).toHaveLength(3);
    expect(fact('Test').textContent).toMatch(/cannot test it/);
    expect(within(fact('Test')).getByRole('link', { name: 'the runbook' })).toHaveAttribute(
      'href',
      MUSE_READER_RUNBOOK_URL
    );
    expect(fact('Replace').textContent).toMatch(/muse_reader_secret_generation/);
    expect(
      within(fact('Replace')).getByRole('link', { name: 'the workspace’s Variables page' })
    ).toHaveAttribute('href', TFC_AZURE_VARIABLES_URL);
    expect(within(fact('Replace')).getByRole('link', { name: 'its Runs page' })).toHaveAttribute(
      'href',
      TFC_AZURE_RUNS_URL
    );
    // The numbers are infra/muse-reader.tf's: 180 days to the reminder, 30 more of slack.
    expect(fact('Expires').textContent).toMatch(/210 days/);
    expect(fact('Expires').textContent).toMatch(/day 180/);
    // Never a value, and never an id of the directory or the app.
    expect(container.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );
  });

  it('says the Terraform run identity has no secret and names the Graph permission it holds', () => {
    const { container } = renderNote(TerraformRunIdentityNote);
    expect(container.textContent).toMatch(/id-plat-terraform-prod-cus-01/);
    expect(screen.getByRole('link', { name: 'Application.ReadWrite.OwnedBy' })).toHaveAttribute(
      'href',
      expect.stringContaining('learn.microsoft.com')
    );
    const fact = (label) => screen.getByText(label).nextElementSibling;
    expect(fact('Stored in').textContent).toMatch(/there is no password or key/);
    expect(fact('Expires').textContent).toMatch(/does not expire/);
  });
});

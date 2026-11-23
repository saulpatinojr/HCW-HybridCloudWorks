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
  ReplicateMcpNote,
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
});

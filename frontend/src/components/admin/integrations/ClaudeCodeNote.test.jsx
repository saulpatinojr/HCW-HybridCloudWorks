import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ClaudeCodeNote, {
  CLAUDE_CODE_REPOSITORIES,
  CLAUDE_CODE_ROTATE_COMMAND,
  CLAUDE_CODE_RUNS_URL,
  CLAUDE_CODE_SECRET,
  CLAUDE_CODE_TOKEN_DOCS_URL,
} from './ClaudeCodeNote';

const renderNote = () =>
  render(
    <MemoryRouter>
      <ClaudeCodeNote />
    </MemoryRouter>
  );

describe('ClaudeCodeNote', () => {
  it('says what the token is, where it is stored, what it costs, how to test it, how to replace it and when it expires', () => {
    renderNote();
    for (const label of ['Stored in', 'Cost', 'Test', 'Replace', 'Expires']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText(CLAUDE_CODE_SECRET).length).toBeGreaterThan(0);
    expect(screen.getByText(/not on the Keys tab/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot test it/i)).toBeInTheDocument();
  });

  it('links every place it names: the run list, the issuer’s page and the Credentials tab', () => {
    renderNote();
    expect(screen.getByRole('link', { name: 'the run list' })).toHaveAttribute(
      'href',
      CLAUDE_CODE_RUNS_URL
    );
    expect(screen.getByRole('link', { name: 'how it works' })).toHaveAttribute(
      'href',
      CLAUDE_CODE_TOKEN_DOCS_URL
    );
    expect(screen.getByRole('link', { name: 'Credentials tab' })).toHaveAttribute(
      'href',
      '/admin/integrations?tab=credentials'
    );
  });

  it('gives one pasteable line that sets the secret in all five repositories, with no placeholder and no value', () => {
    expect(CLAUDE_CODE_REPOSITORIES).toHaveLength(5);
    for (const repository of CLAUDE_CODE_REPOSITORIES) {
      expect(CLAUDE_CODE_ROTATE_COMMAND).toContain(`'${repository}'`);
    }
    expect(CLAUDE_CODE_ROTATE_COMMAND).toContain(`gh secret set ${CLAUDE_CODE_SECRET} --repo`);
    expect(CLAUDE_CODE_ROTATE_COMMAND).not.toMatch(/[<>]|\n|--body/);
    renderNote();
    expect(screen.getByText(CLAUDE_CODE_ROTATE_COMMAND)).toBeInTheDocument();
  });
});

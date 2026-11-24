import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProposalCleanupCard, { cleanupSummary } from './ProposalCleanupCard';

const RUN = {
  ranAt: '2027-02-01T04:00:00.000Z',
  dryRun: true,
  cycleYear: 2026,
  eligibleCount: 3,
  strippedCount: 0,
  leftCount: 0,
  hasMore: false,
};

describe('cleanupSummary', () => {
  it('says so when no run is recorded', () => {
    expect(cleanupSummary(null).label).toBe('No run recorded yet');
    expect(cleanupSummary(undefined).sentence).toContain('04:00 UTC');
  });

  it('reads a dry run as switched off, with what it would have stripped', () => {
    const { label, sentence } = cleanupSummary(RUN);
    expect(label).toBe('Switched off (dry run)');
    expect(sentence).toContain('changed nothing');
    expect(sentence).toContain('would have stripped 3 proposals for cycles up to 2026.');
    expect(cleanupSummary({ ...RUN, eligibleCount: 1 }).sentence).toContain('1 proposal for');
    // A run whose mode is missing is never shown as switched on.
    expect(cleanupSummary({ ...RUN, dryRun: undefined }).label).toBe('Switched off (dry run)');
  });

  it('reads an armed run with what it stripped, what it left and whether more remains', () => {
    const { label, sentence } = cleanupSummary({
      ...RUN,
      dryRun: false,
      strippedCount: 500,
      leftCount: 1,
      hasMore: true,
    });
    expect(label).toBe('Switched on');
    expect(sentence).toContain('stripped 500 proposals');
    expect(sentence).toContain('1 proposal was left for the next run.');
    expect(sentence).toContain('There is more to do');
  });
});

describe('ProposalCleanupCard', () => {
  it('shows the rule, the last run and the link to the steps', () => {
    render(<ProposalCleanupCard run={RUN} />);
    expect(screen.getByText('Yearly clean-up of proposals')).toBeInTheDocument();
    expect(screen.getByText(/Accepted proposals are never stripped/)).toBeInTheDocument();
    expect(screen.getByText('Switched off (dry run).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Developer API runbook' })).toHaveAttribute(
      'href',
      expect.stringContaining('docs/runbooks/developer-api.md#the-yearly-clean-up-of-proposals')
    );
  });

  it('renders with no run at all', () => {
    render(<ProposalCleanupCard />);
    expect(screen.getByText('No run recorded yet.')).toBeInTheDocument();
  });
});

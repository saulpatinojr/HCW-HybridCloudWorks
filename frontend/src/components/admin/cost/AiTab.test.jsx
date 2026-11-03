/**
 * AI: the month's figures, a card per provider drawn by its kind, the tables
 * by provider and by what spent it (sources in words), and the link to the
 * full ledger.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import AiTab, { USAGE_LEDGER_HREF } from './AiTab';
import { SUMMARY } from './fixture';

const renderTab = (summary = SUMMARY) =>
  render(
    <MemoryRouter>
      <AiTab summary={summary} />
    </MemoryRouter>
  );

describe('AiTab', () => {
  it('shows the month’s figures against the budget', () => {
    renderTab();
    expect(screen.getByText('Estimated spend this month').closest('div')).toHaveTextContent(
      '$4.23'
    );
    expect(
      screen
        .getAllByText('Calls', { selector: 'dt' })
        .some((dt) => dt.closest('div').textContent.includes('120'))
    ).toBe(true);
    expect(screen.getByText('Unpriced calls').closest('div')).toHaveTextContent('3');
    expect(screen.getByText('Monthly AI budget').closest('div')).toHaveTextContent('$20.00');
    expect(screen.getByRole('progressbar', { name: 'Monthly AI budget' })).toHaveAttribute(
      'aria-valuetext',
      '21.2% used'
    );
  });

  it('says when no budget is set and where to set one', () => {
    renderTab({ ...SUMMARY, ai: { ...SUMMARY.ai, budgetUsd: null } });
    expect(screen.getByText('no budget set')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set one under Alerts' })).toHaveAttribute(
      'href',
      '/admin/cost?tab=alerts'
    );
    expect(screen.queryByRole('progressbar', { name: 'Monthly AI budget' })).toBeNull();
  });

  it('draws each provider by its kind', () => {
    renderTab();
    // credits: the bar of credits used, the reset date, the plan.
    const credits = screen.getByRole('progressbar', { name: 'ElevenLabs credits used' });
    expect(credits).toHaveAttribute('aria-valuetext', '84% used');
    expect(screen.getByText('Credits left').closest('div')).toHaveTextContent('1,600');
    expect(screen.getByText('creator plan')).toBeInTheDocument();
    expect(
      screen.getByText('Resets').closest('div').querector?.('time') ??
        screen.getByTitle('2026-11-26T00:00:00.000Z')
    ).toBeTruthy();
    // budget: spend against budget and images.
    expect(screen.getByRole('progressbar', { name: 'Replicate (images) budget' })).toHaveAttribute(
      'aria-valuetext',
      '4% used'
    );
    expect(screen.getByText('Images').closest('div')).toHaveTextContent('20');
    // azure-budget: links to the Azure tab.
    expect(
      screen.getByRole('progressbar', { name: 'Microsoft Foundry (Azure) budget' })
    ).toHaveAttribute('aria-valuetext', '7.1% used, 14.1% forecast');
    expect(screen.getByRole('link', { name: 'Open the Azure tab' })).toHaveAttribute(
      'href',
      '/admin/cost?tab=azure'
    );
    // ledger and free: month to date, calls and the note; not configured is said.
    expect(
      screen.getByText('Google exposes no balance API; this is the site’s own estimate.')
    ).toBeInTheDocument();
    expect(screen.getByText('Free, rate-limited tier.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /OpenAI/ })).toHaveTextContent('not configured');
  });

  it('lists the ledger by provider and by what spent it, with sources in words', () => {
    renderTab();
    const byProvider = screen.getByRole('table', { name: 'This month by provider' });
    const anthropic = within(byProvider).getByText('anthropic').closest('tr');
    expect(anthropic).toHaveTextContent('$1.73');
    expect(anthropic).toHaveTextContent('+ 3 unpriced');
    const bySource = screen.getByRole('table', { name: 'This month by what spent it' });
    expect(within(bySource).getByText('Admin playground').closest('tr')).toHaveTextContent('108');
    expect(within(bySource).getByText('AI — articleDraft')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the full ledger/ })).toHaveAttribute(
      'href',
      USAGE_LEDGER_HREF
    );
  });

  it('says when a provider’s credits could not be read', () => {
    const providers = SUMMARY.ai.providers.map((p) =>
      p.id === 'elevenlabs' ? { ...p, error: 'HTTP 401 from ElevenLabs.' } : p
    );
    renderTab({ ...SUMMARY, ai: { ...SUMMARY.ai, providers } });
    expect(screen.getByText(/Credits could not be read: HTTP 401/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'ElevenLabs credits used' })).toBeNull();
  });
});

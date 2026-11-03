/**
 * Azure: one card per scope with the budget bar, the figures, the by-service
 * table cut to eight rows with Show all, and the error sentence on a scope that
 * failed; when nothing could be read the tab says why and what to do.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import AzureTab, { SERVICE_ROWS, forecastNote } from './AzureTab';
import { SUMMARY } from './fixture';

const renderTab = (summary = SUMMARY) =>
  render(
    <MemoryRouter>
      <AzureTab summary={summary} />
    </MemoryRouter>
  );

describe('forecastNote', () => {
  it('says whose forecast the figure is', () => {
    expect(forecastNote('azure')).toMatch(/Azure's own/);
    expect(forecastNote('straight-line')).toMatch(/straight-line/);
    expect(forecastNote(null)).toBe('no forecast');
  });
});

describe('AzureTab', () => {
  it('draws one card per scope with its budget bar, figures and by-service table', () => {
    renderTab();
    expect(screen.getByText(/reaches Cost Management up to a day late/)).toBeInTheDocument();
    const app = screen.getByRole('heading', { name: /Application subscription/ });
    expect(app).toHaveTextContent('subscription · sub-app-site-prod-cus');
    const bar = screen.getByRole('progressbar', { name: 'Budget site-monthly-budget: $150.00' });
    expect(bar).toHaveAttribute('aria-valuenow', '78');
    expect(bar).toHaveAttribute('aria-valuetext', '78% used, 106.7% forecast');
    expect(screen.getByText('78% used, 106.7% forecast')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Azure alerts at 50%, 75%, 90%, 100% of the spend and at 100% of the forecast/
      )
    ).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Cost by service: Application subscription' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(SERVICE_ROWS);
    expect(rows[0]).toHaveTextContent('Azure Functions');
    expect(rows[0]).toHaveTextContent('$61.20');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });

  it('names a resource group as one, and says when a scope could not be read', () => {
    renderTab();
    expect(
      screen.getByRole('heading', { name: /Microsoft Foundry resource group/ })
    ).toHaveTextContent('resource group · rg-ai-site-prod-cus');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This scope could not be read: Azure answered 403'
    );
    expect(screen.getAllByText(/No Azure budget on this scope/)).toHaveLength(1);
  });

  it('says why Azure is not available and what to do', () => {
    renderTab({
      ...SUMMARY,
      azure: { available: false, reason: 'COST_SCOPES is not set.', scopes: [], totals: {} },
    });
    expect(screen.getByText('Azure costs are not available')).toBeInTheDocument();
    // The server's reason, then a pointer to the runbook. The role is named
    // only when the reason itself is about the role (2026-11-03: a 429 was
    // shown with role advice beside it).
    const text = screen.getByText(/COST_SCOPES is not set\./);
    expect(text).toHaveTextContent(/docs\/runbooks\/cost\.md/);
    expect(text).not.toHaveTextContent(/Cost Management Reader/);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows earlier figures, with when they were read, when a refresh was refused', () => {
    const [first, ...rest] = SUMMARY.azure.scopes;
    const note =
      'These figures were read at 2026-11-13 09:00 UTC and could not be renewed this time: HTTP 429.';
    renderTab({
      ...SUMMARY,
      azure: { ...SUMMARY.azure, scopes: [{ ...first, error: null, note }, ...rest] },
    });
    expect(screen.getByText(note)).toBeInTheDocument();
    // The kept scope reads as working: only the fixture's own failed scopes say "could not be read".
    expect(screen.queryAllByText(/This scope could not be read/)).toHaveLength(
      rest.filter((scope) => scope.error).length
    );
  });
});

/**
 * Alerts: the signals grouped by severity with a word and an icon, each a
 * link to its tab; the rules in words; and the settings form that PUTs the
 * whole object and shows the server's sentence on a refusal.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import AlertsTab, { REMINDERS_HREF, RULES, SettingsForm, settingsOf } from './AlertsTab';
import { COST_SETTINGS_ROUTE } from '@/lib/cost';
import { SETTINGS, SUMMARY } from './fixture';

// The Radix Switch measures its thumb with ResizeObserver, which jsdom lacks.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: vi.fn(),
  sendJSON: (...args) => sendJSON(...args),
}));

beforeEach(() => {
  sendJSON.mockReset().mockImplementation(async (_route, _method, body) => ({
    ok: true,
    settings: body,
  }));
});

const renderTab = (summary = SUMMARY, onRefresh = vi.fn()) => {
  render(
    <MemoryRouter>
      <AlertsTab summary={summary} onRefresh={onRefresh} />
    </MemoryRouter>
  );
  return { onRefresh };
};

describe('settingsOf', () => {
  it('turns the inputs into the object the server takes, an empty budget being null', () => {
    expect(
      settingsOf({
        aiMonthlyBudgetUsd: '',
        renewalLeadDays: '10',
        telegram: false,
        monthlyDigest: true,
        refreshHours: '12',
      })
    ).toEqual({
      aiMonthlyBudgetUsd: null,
      renewalLeadDays: 10,
      telegram: false,
      monthlyDigest: true,
      refreshHours: 12,
    });
    expect(
      settingsOf({
        ...SETTINGS,
        aiMonthlyBudgetUsd: '25.5',
        renewalLeadDays: '7',
        refreshHours: '6',
      }).aiMonthlyBudgetUsd
    ).toBe(25.5);
  });
});

describe('AlertsTab', () => {
  it('groups the signals by severity, worst first, each a link with a word and an icon', () => {
    renderTab();
    const critical = screen.getByRole('region', { name: 'Critical' });
    expect(within(critical).getAllByRole('link')).toHaveLength(1);
    expect(within(critical).getByRole('link')).toHaveAttribute('href', '/admin/cost?tab=azure');
    expect(within(critical).getByRole('link')).toHaveTextContent(
      'Critical · Azure forecasts USD 160.00'
    );
    expect(within(critical).getByRole('link').querySelector('svg')).not.toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Warning' })).getAllByRole('link')
    ).toHaveLength(3);
    const info = screen.getByRole('region', { name: 'Information' });
    expect(within(info).getByRole('link')).toHaveAttribute('href', '/admin/cost?tab=services');
    expect(screen.getByText('Information (1)')).toBeInTheDocument();
  });

  it('says when there is nothing to act on', () => {
    renderTab({ ...SUMMARY, signals: [] });
    expect(screen.getByText('Nothing to act on')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Critical' })).toBeNull();
  });

  it('lists every rule in words and points Telegram at the reminders sheet', () => {
    renderTab();
    for (const rule of RULES) expect(screen.getByText(rule)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Platform Settings, Reminders' })).toHaveAttribute(
      'href',
      REMINDERS_HREF
    );
  });

  it('binds the form to the settings and PUTs the whole object, then asks the page to re-read', async () => {
    const { onRefresh } = renderTab();
    const form = screen.getByRole('form', { name: 'Alert settings' });
    expect(within(form).getByLabelText('Monthly AI budget (USD)').value).toBe('20');
    expect(within(form).getByLabelText(/days before/).value).toBe('7');
    expect(within(form).getByLabelText(/Re-read Azure every/).value).toBe('6');
    expect(within(form).getByRole('switch', { name: /Telegram/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    fireEvent.change(within(form).getByLabelText('Monthly AI budget (USD)'), {
      target: { value: '30' },
    });
    fireEvent.change(within(form).getByLabelText(/days before/), { target: { value: '14' } });
    fireEvent.click(within(form).getByRole('switch', { name: /closing figures/ }));
    fireEvent.submit(form);
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON).toHaveBeenCalledWith(COST_SETTINGS_ROUTE, 'PUT', {
      aiMonthlyBudgetUsd: 30,
      renewalLeadDays: 14,
      telegram: true,
      monthlyDigest: false,
      refreshHours: 6,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(onRefresh).toHaveBeenCalledWith(false);
  });

  it('shows the server’s sentence when the save is refused, and keeps the draft', async () => {
    const save = vi.fn().mockRejectedValue(new Error('renewalLeadDays must be 1 to 60'));
    render(
      <MemoryRouter>
        <SettingsForm settings={SETTINGS} save={save} />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText(/days before/), { target: { value: '99' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Alert settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('renewalLeadDays must be 1 to 60');
    expect(screen.getByLabelText(/days before/).value).toBe('99');
  });
});

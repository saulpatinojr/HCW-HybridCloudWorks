/**
 * Services: the ledger is read once; the totals, the chips, the form (add,
 * and edit in place), the overdue and upcoming sections, the grouped list,
 * and Remove behind the shared confirm. A write puts the server's answer
 * into the list and tells the page; a refusal shows the server's sentence.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import ServicesTab, { draftOf, fieldsOf, groupByCategory, newDraft } from './ServicesTab';
import { COST_SERVICES_ROUTE } from '@/lib/cost';
import { ITEMS, SERVICES_ANSWER, SUMMARY } from './fixture';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const getJSON = vi.fn();
const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue(SERVICES_ANSWER);
  sendJSON.mockReset();
});

const renderTab = () => {
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ServicesTab summary={SUMMARY} onChanged={onChanged} />
    </MemoryRouter>
  );
  return { onChanged };
};

const region = (name) => within(screen.getByRole('region', { name }));
/** A totals figure by its label (the form has a field of the same name). */
const figure = (label) => screen.getByText(label, { selector: 'dt' }).closest('div');
/** A category heading, not the option of the same name in the form's Category list. */
const NOT_OPTIONS = { ignore: 'option, script, style' };
/** The card header holding a category's title and its "n items, $x a month" line. */
function group(label) {
  let node = screen.getByText(label, NOT_OPTIONS);
  while (node && !/a month/.test(node.textContent)) node = node.parentElement;
  return node;
}

describe('the draft and the fields', () => {
  it('round-trips an item through the form shape, and sends what the server takes', () => {
    const draft = draftOf(ITEMS[0]);
    expect(draft).toMatchObject({ name: 'Cloudflare Pro', amount: '20', autoRenew: true });
    expect(draftOf(ITEMS[4]).amount).toBe('');
    expect(
      fieldsOf({ ...newDraft(), name: '  Thing ', amount: ' 12.5 ', currency: 'eur' })
    ).toMatchObject({
      name: 'Thing',
      amount: 12.5,
      currency: 'EUR',
      nextRenewal: null,
      cycle: 'monthly',
    });
    expect(fieldsOf(newDraft()).amount).toBeNull();
    expect(Object.keys(fieldsOf(newDraft()))).toEqual([
      'name',
      'vendor',
      'category',
      'plan',
      'amount',
      'currency',
      'cycle',
      'nextRenewal',
      'autoRenew',
      'status',
      'paymentMethod',
      'link',
      'note',
    ]);
  });

  it('groups by category in the categories’ order, dropping empty ones', () => {
    expect(groupByCategory(ITEMS).map((g) => [g.id, g.items.length])).toEqual([
      ['infrastructure', 2],
      ['ai', 1],
      ['communication', 1],
      ['content', 1],
    ]);
  });
});

describe('ServicesTab', () => {
  it('reads the ledger once and shows totals, chips, overdue, upcoming and the grouped list', async () => {
    renderTab();
    await screen.findByText('Infrastructure', NOT_OPTIONS);
    expect(getJSON).toHaveBeenCalledTimes(1);
    expect(getJSON).toHaveBeenCalledWith(COST_SERVICES_ROUTE);
    expect(figure('Per month')).toHaveTextContent('$68.54');
    expect(figure('Per year')).toHaveTextContent('$822.48');
    expect(figure('Items')).toHaveTextContent('5');
    expect(figure('Next renewal')).toHaveTextContent('Cloudflare Pro');
    expect(screen.getByRole('button', { name: 'Add Resend' })).toBeInTheDocument();
    expect(region('Overdue').getAllByRole('listitem')).toHaveLength(1);
    expect(region('Overdue').getByText(/3 days overdue/)).toBeInTheDocument();
    expect(region('Overdue').getByText('does not renew on its own')).toBeInTheDocument();
    expect(region('Renewing in the next 30 days').getAllByRole('listitem')).toHaveLength(2);
    const trial = screen.getAllByText('Plaud Pro trial').at(-1).closest('li');
    expect(within(trial).getByText('Trial')).toBeInTheDocument();
    expect(trial).toHaveTextContent('amount unknown');
    expect(trial).toHaveTextContent('No renewal date');
    expect(group('Communication')).toHaveTextContent('1 item, $25.00 a month');
    // Listed under "Renewing in the next 30 days" and again in its category.
    expect(screen.getAllByTitle('2026-11-15').length).toBeGreaterThan(0);
  });

  it('a chip pre-fills the form, Add POSTs the fields, the answer joins the list and the page is told', async () => {
    const { onChanged } = renderTab();
    await screen.findByText('Infrastructure', NOT_OPTIONS);
    fireEvent.click(screen.getByRole('button', { name: 'Add Resend' }));
    const form = screen.getByRole('form', { name: 'Add a subscription' });
    expect(within(form).getByLabelText('Name').value).toBe('Resend');
    expect(within(form).getByLabelText('Vendor').value).toBe('Resend');
    expect(within(form).getByLabelText('Category').value).toBe('communication');
    expect(within(form).getByLabelText('Link to the billing page').value).toBe(
      'https://resend.com/'
    );
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '20' } });
    fireEvent.change(within(form).getByLabelText('Billing cycle'), { target: { value: 'annual' } });
    expect(within(form).getByText('Counts as $1.67 a month.')).toBeInTheDocument();

    const saved = {
      ...ITEMS[0],
      id: 'svc-resend',
      name: 'Resend',
      vendor: 'Resend',
      category: 'communication',
      amount: 20,
      cycle: 'annual',
      nextRenewal: null,
      monthlyEquivalent: 1.67,
      daysUntilRenewal: null,
    };
    sendJSON.mockResolvedValue({ ok: true, item: saved });
    fireEvent.submit(form);
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    const [[route, method, body]] = sendJSON.mock.calls;
    expect(route).toBe(COST_SERVICES_ROUTE);
    expect(method).toBe('POST');
    expect(body).toMatchObject({
      name: 'Resend',
      amount: 20,
      cycle: 'annual',
      category: 'communication',
    });
    await waitFor(() => expect(group('Communication')).toHaveTextContent('2 items'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Add Resend' })).toBeNull();
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it('shows the server’s sentence when a save is refused, and keeps the draft', async () => {
    renderTab();
    await screen.findByText('Infrastructure', NOT_OPTIONS);
    const form = screen.getByRole('form', { name: 'Add a subscription' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'X' } });
    sendJSON.mockRejectedValue(new Error('name must be 1 to 120 characters'));
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'name must be 1 to 120 characters'
    );
    expect(within(form).getByLabelText('Name').value).toBe('X');
  });

  it('Edit opens the row in place, PATCHes the fields and replaces the row from the answer', async () => {
    const { onChanged } = renderTab();
    await screen.findByText('Infrastructure', NOT_OPTIONS);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit Publer Business' })[0]);
    const form = screen.getByRole('form', { name: 'Edit: Publer Business' });
    expect(within(form).getByLabelText('Amount').value).toBe('300');
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '360' } });
    sendJSON.mockResolvedValue({
      ok: true,
      item: { ...ITEMS[2], amount: 360, monthlyEquivalent: 30 },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON.mock.calls[0][0]).toBe(`${COST_SERVICES_ROUTE}/svc-publer`);
    expect(sendJSON.mock.calls[0][1]).toBe('PATCH');
    expect(sendJSON.mock.calls[0][2]).toMatchObject({ amount: 360 });
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Edit: Publer Business' })).toBeNull()
    );
    expect(group('Communication')).toHaveTextContent('$30.00 a month');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('Remove asks first, then DELETEs and drops the row', async () => {
    const { onChanged } = renderTab();
    await screen.findByText('Infrastructure', NOT_OPTIONS);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Plaud Pro trial' })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Remove Plaud Pro trial?' });
    expect(dialog).toHaveTextContent('does not cancel the subscription with the vendor');
    sendJSON.mockResolvedValue({ ok: true, id: 'svc-trial' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`${COST_SERVICES_ROUTE}/svc-trial`, 'DELETE')
    );
    await waitFor(() => expect(screen.queryByText('Plaud Pro trial')).toBeNull());
    expect(screen.queryByText('Content', NOT_OPTIONS)).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('says when the ledger could not be read, with a retry', async () => {
    getJSON.mockRejectedValue(new Error('HTTP 403'));
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403');
    getJSON.mockResolvedValue(SERVICES_ANSWER);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByText('Infrastructure', NOT_OPTIONS);
  });
});

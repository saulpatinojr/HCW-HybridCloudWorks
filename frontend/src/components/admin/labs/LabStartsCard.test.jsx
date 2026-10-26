/**
 * The "Lab sessions started" card on the Labs hub Dashboard. What must hold: it
 * waits for sign-in before it reads anything; it shows today, 7 days, 30 days,
 * the total and the per-lab breakdown from the read; it says the day counting
 * began and that no earlier history exists; "Copy as text for a letter" writes
 * the sentence with the real numbers to the clipboard; a failed read says so
 * and can be retried; and it never renders a field the counter does not have.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import LabStartsCard from './LabStartsCard';
import { labs } from '@/data/labs/catalogue';

const getJSON = vi.fn();
let authReady = true;

vi.mock('@/lib/api', () => ({ getJSON: (...args) => getJSON(...args) }));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady }) }));

const LAB = labs.find((lab) => lab.id === 'terraform-validate-walkthrough');

const READ = Object.freeze({
  since: '2026-10-26',
  today: '2026-11-09',
  counts: { today: 2, last7: 9, last30: 14, total: 14 },
  perLab: [
    { labId: 'terraform-validate-walkthrough', today: 1, last7: 6, last30: 10, total: 10 },
    { labId: 'landing-zone-builder-output', today: 1, last7: 3, last30: 4, total: 4 },
  ],
});

let writeText;
beforeEach(() => {
  authReady = true;
  getJSON.mockReset().mockResolvedValue(READ);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('reading', () => {
  it('reads cms/labs/starts once sign-in is ready, and not before', async () => {
    authReady = false;
    const { rerender } = render(<LabStartsCard />);
    expect(getJSON).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Reading the lab session counts');

    authReady = true;
    rerender(<LabStartsCard />);
    await screen.findByTestId('lab-starts-table');
    expect(getJSON).toHaveBeenCalledTimes(1);
    expect(getJSON).toHaveBeenCalledWith('cms/labs/starts');
  });
});

describe('the figures', () => {
  it('shows today, last 7 days, last 30 days and the total', async () => {
    render(<LabStartsCard />);
    await screen.findByTestId('lab-starts-table');
    const stat = (id) => document.querySelector(`[data-stat="${id}"]`);
    expect(within(stat('today')).getByText('2')).toBeInTheDocument();
    expect(within(stat('today')).getByText('Today')).toBeInTheDocument();
    expect(within(stat('last7')).getByText('9')).toBeInTheDocument();
    expect(within(stat('last7')).getByText('Last 7 days')).toBeInTheDocument();
    expect(within(stat('last30')).getByText('14')).toBeInTheDocument();
    expect(within(stat('last30')).getByText('Last 30 days')).toBeInTheDocument();
    expect(within(stat('total')).getByText('14')).toBeInTheDocument();
    expect(within(stat('total')).getByText('Total')).toBeInTheDocument();
  });

  it('breaks the figures down per lab, with the lab’s title', async () => {
    render(<LabStartsCard />);
    const table = await screen.findByTestId('lab-starts-table');
    const row = table.querySelector('[data-lab="terraform-validate-walkthrough"]');
    expect(within(row).getByText(LAB.title)).toBeInTheDocument();
    expect([...row.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      '1',
      '6',
      '10',
      '10',
    ]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('says the day counting began and that there is no earlier history', async () => {
    render(<LabStartsCard />);
    const since = await screen.findByTestId('lab-starts-since');
    expect(since).toHaveTextContent('Counting since 26 October 2026');
    expect(since).toHaveTextContent('Nothing earlier was recorded');
    expect(since).toHaveTextContent('deleted about two hours after it was last updated');
  });

  it('says plainly that it counts sessions, not people, and what is not counted', async () => {
    render(<LabStartsCard />);
    await screen.findByTestId('lab-starts-table');
    const card = screen.getByTestId('lab-starts-card');
    expect(card).toHaveTextContent('not people');
    expect(card).toHaveTextContent('not counted');
    expect(card).toHaveTextContent('editor level or above');
  });

  it('with no starts yet, shows zeros, the since day and no per-lab table', async () => {
    getJSON.mockResolvedValue({
      since: '2026-10-26',
      today: '2026-10-26',
      counts: { today: 0, last7: 0, last30: 0, total: 0 },
      perLab: [],
    });
    render(<LabStartsCard />);
    expect(await screen.findByTestId('lab-starts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('lab-starts-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('lab-starts-since')).toHaveTextContent(
      'Counting since 26 October 2026'
    );
    expect(screen.getByTestId('lab-starts-sentence')).toHaveTextContent(
      'no lab sessions were started'
    );
  });
});

describe('copy as text for a letter', () => {
  it('shows the sentence and writes exactly that sentence to the clipboard', async () => {
    render(<LabStartsCard />);
    const sentence = (await screen.findByTestId('lab-starts-sentence')).textContent;
    expect(sentence).toContain('From 26 October 2026 to 9 November 2026');
    expect(sentence).toContain(
      '14 lab sessions were started for visitors through the Hybrid Cloud Works website'
    );
    expect(sentence).toContain('9 of them in the last 7 days and 14 in the last 30 days');
    expect(sentence).not.toMatch(/coder|hostinger|cloudflare|learner/i);

    fireEvent.click(screen.getByRole('button', { name: /Copy as text for a letter/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sentence));
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
  });

  it('says so when the clipboard is not available, and leaves the sentence to select', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<LabStartsCard />);
    await screen.findByTestId('lab-starts-sentence');
    fireEvent.click(screen.getByRole('button', { name: /Copy as text for a letter/ }));
    expect(await screen.findByText(/clipboard is not available here/)).toBeInTheDocument();
  });
});

describe('when the read fails', () => {
  it('says so, offers Try again, and recovers', async () => {
    getJSON.mockRejectedValueOnce(new Error('Forbidden'));
    render(<LabStartsCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The lab session counts could not be read');
    expect(alert).toHaveTextContent('Forbidden');
    expect(screen.queryByTestId('lab-starts-sentence')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByTestId('lab-starts-table')).toBeInTheDocument();
    expect(getJSON).toHaveBeenCalledTimes(2);
  });

  it('refuses an answer of the wrong shape instead of showing guesses', async () => {
    getJSON.mockResolvedValue({ counts: { total: 'many' } });
    render(<LabStartsCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('not in the expected shape');
    expect(screen.queryByTestId('lab-starts-sentence')).not.toBeInTheDocument();
  });
});

describe('what it renders', () => {
  it('shows nothing beyond the counts: a field the counter does not have never appears', async () => {
    getJSON.mockResolvedValue({
      ...READ,
      clientHash: 'abc123-hash',
      ip: '203.0.113.9',
      perLab: [{ ...READ.perLab[0], sessionId: 'sess-9', email: 'a@example.com' }],
    });
    render(<LabStartsCard />);
    await screen.findByTestId('lab-starts-table');
    const text = screen.getByTestId('lab-starts-card').textContent;
    for (const leak of ['abc123-hash', '203.0.113.9', 'sess-9', 'a@example.com']) {
      expect(text).not.toContain(leak);
    }
  });
});

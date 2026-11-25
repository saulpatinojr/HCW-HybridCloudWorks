/**
 * Scheduled tasks: one table per place a job runs, each row with its
 * schedule in words and as written, what it does and what it leaves behind,
 * and a link to where it lives. Whether the rows match the real schedules is
 * scripts/scheduled-tasks-list.test.mjs; this is how they are shown.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import ScheduledTasksTab from './ScheduledTasksTab';
import { SCHEDULE_GROUPS, SCHEDULED_TASKS } from './scheduledTasks';

// Wednesday 25 November 2026, 12:00 UTC.
const NOW = new Date(Date.UTC(2026, 10, 25, 12, 0));

const renderTab = () => render(<ScheduledTasksTab now={NOW} />);
const tableOf = (label) =>
  screen.getByRole('table', { name: `Scheduled tasks that run in ${label}` });
const rowOf = (table, name) => within(table).getByText(name).closest('tr');

describe('ScheduledTasksTab', () => {
  it('has one table per place, in order, with a heading, an explanation and every row', () => {
    renderTab();
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(
      SCHEDULE_GROUPS.map((group) => {
        const count = SCHEDULED_TASKS.filter((task) => task.group === group.id).length;
        return `${group.label} (${count} ${count === 1 ? 'task' : 'tasks'})`;
      })
    );
    for (const group of SCHEDULE_GROUPS) {
      const rows = within(tableOf(group.label)).getAllByRole('row').slice(1);
      expect(rows, group.id).toHaveLength(
        SCHEDULED_TASKS.filter((t) => t.group === group.id).length
      );
      expect(screen.getByText(group.explain)).toBeTruthy();
    }
    expect(
      screen.getByText(new RegExp(`${SCHEDULED_TASKS.length} tasks in 4 places`))
    ).toBeTruthy();
  });

  it('shows a workflow with its schedule in words, as written, its next run and what it leaves', () => {
    renderTab();
    const row = rowOf(tableOf('GitHub Actions'), 'Update AVM Versions');
    expect(within(row).getByText('update-avm-versions.yml')).toBeTruthy();
    expect(within(row).getByText('Every Tuesday at 06:30 UTC')).toBeTruthy();
    expect(within(row).getByText('30 6 * * 2')).toBeTruthy();
    expect(within(row).getByText('Next: Tue 1 Dec, 06:30 UTC')).toBeTruthy();
    expect(within(row).getByText(/Leaves behind: Opens a pull request/)).toBeTruthy();
    const link = within(row).getByRole('link', { name: /Open Update AVM Versions/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/update-avm-versions.yml'
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows a Function App timer in NCRONTAB, linked to the code that sets it', () => {
    renderTab();
    const row = rowOf(tableOf('Function App'), 'Health pulse');
    expect(within(row).getByText('healthPulse')).toBeTruthy();
    expect(within(row).getByText('Every 5 minutes, from :02')).toBeTruthy();
    expect(within(row).getByText('0 2-59/5 * * * *')).toBeTruthy();
    expect(within(row).getByText('Next: Wed 25 Nov, 12:02 UTC')).toBeTruthy();
    expect(within(row).getByRole('link').getAttribute('href')).toBe(
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/schedulers.js'
    );
  });

  it('reads lab host times on the host clock, and gives them no next run in UTC', () => {
    renderTab();
    const table = tableOf('Lab host');
    const row = rowOf(table, 'Vault snapshot');
    expect(within(row).getByText('Every day at 03:45 (lab host clock)')).toBeTruthy();
    expect(within(row).getByText('OnCalendar=*-*-* 03:45:00')).toBeTruthy();
    expect(within(table).queryByText(/^Next:/)).toBeNull();
  });

  it('says the Claude session lives in the owner’s account, and links claude.ai/code', () => {
    renderTab();
    const row = rowOf(tableOf('Claude'), 'Daily: finish what the scheduled jobs left');
    expect(within(row).getByText('Every day at 09:13 UTC')).toBeTruthy();
    expect(within(row).getByText(/not in this repository/)).toBeTruthy();
    expect(within(row).getByRole('link').getAttribute('href')).toBe('https://claude.ai/code');
  });

  it('lists the most frequent first, then in the order the week meets them', () => {
    renderTab();
    const names = within(tableOf('GitHub Actions'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].querySelector('div').textContent);
    expect(names.slice(0, 2)).toEqual(['Remove CI Access Windows', 'Monitor Functions Registered']);
    // Daily jobs before weekly ones; the weekly ones Monday first, by time.
    expect(names.indexOf('Cloudflare DNS audit')).toBeLessThan(names.indexOf('CodeQL'));
    expect(names.indexOf('CodeQL')).toBeLessThan(names.indexOf('Audit published pages'));
    expect(names[names.length - 1]).toBe('Check cloud module pins');
  });
});

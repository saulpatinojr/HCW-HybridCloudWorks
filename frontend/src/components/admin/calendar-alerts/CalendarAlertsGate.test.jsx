/**
 * The admin layout's door to the pop-up: it loads the pop-up for an editor or
 * above and for nobody else.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({ getJSON: (...args) => getJSON(...args), sendJSON: vi.fn() }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AdminRoleProvider } from '@/hooks/useAdminRole';
import { resetPromptMemory } from '@/lib/calendarAlerts';
import CalendarAlertsGate from './CalendarAlertsGate';

const due = {
  id: 'a1',
  title: 'Renew the domain',
  dueDate: '2026-10-28',
  dueTime: null,
  link: '',
  note: '',
  status: 'open',
  snoozedUntil: null,
  doneAt: null,
  state: 'open',
  daysUntilDue: 2,
};

function renderGate(role) {
  return render(
    <AdminRoleProvider value={role}>
      <MemoryRouter>
        <CalendarAlertsGate />
      </MemoryRouter>
    </AdminRoleProvider>
  );
}

beforeEach(() => {
  getJSON.mockReset();
  getJSON.mockResolvedValue({ ok: true, today: '2026-10-26', alerts: [due], total: 1 });
  resetPromptMemory();
});

describe('CalendarAlertsGate', () => {
  it('loads the pop-up for an editor', async () => {
    renderGate('editor');
    expect(await screen.findByRole('dialog', { name: 'Calendar alerts' })).toBeInTheDocument();
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it.each(['viewer', null, 'nonsense'])(
    'loads nothing and asks nothing for the role %s',
    async (role) => {
      const { container } = renderGate(role);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container).toBeEmptyDOMElement();
      expect(getJSON).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
  );
});

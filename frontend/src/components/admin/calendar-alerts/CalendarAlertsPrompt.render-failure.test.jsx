/**
 * The pop-up draws something it cannot draw (an answer the browser can read
 * but React cannot render). The gate's boundary swallows it, so the portal
 * around it is still there. A separate file because it feeds the real pop-up
 * a deliberately broken alert.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({ getJSON: (...args) => getJSON(...args), sendJSON: vi.fn() }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AdminRoleProvider } from '@/hooks/useAdminRole';
import { resetPromptMemory } from '@/lib/calendarAlerts';
import CalendarAlertsGate from './CalendarAlertsGate';

describe('CalendarAlertsGate when the pop-up throws while drawing', () => {
  it('leaves the portal standing', async () => {
    resetPromptMemory();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getJSON.mockResolvedValue({
      ok: true,
      today: '2026-10-26',
      alerts: [
        {
          id: 'bad',
          // An object where text belongs: React refuses to draw it.
          title: { not: 'text' },
          dueDate: '2026-10-27',
          dueTime: null,
          link: '',
          note: '',
          state: 'open',
          status: 'open',
          daysUntilDue: 1,
        },
      ],
    });
    render(
      <AdminRoleProvider value="editor">
        <MemoryRouter>
          <p>The portal</p>
          <CalendarAlertsGate />
        </MemoryRouter>
      </AdminRoleProvider>
    );
    // The pop-up loads lazily; wait for it to read, then for the draw that fails.
    await waitFor(() => expect(getJSON).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText('The portal')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

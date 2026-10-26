/**
 * A calendar pop-up that cannot load, or cannot draw, must cost the admin
 * nothing. This is the other half of CalendarAlertsGate.test.jsx, in its own
 * file because it replaces the pop-up's module for every test in the file.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// The pop-up's file fails to load, as a stale chunk or a dropped connection does.
vi.mock('./CalendarAlertsPrompt', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

import { AdminRoleProvider } from '@/hooks/useAdminRole';
import CalendarAlertsGate from './CalendarAlertsGate';

describe('CalendarAlertsGate when the pop-up cannot be loaded', () => {
  it('renders nothing, throws nothing, and leaves the page around it standing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AdminRoleProvider value="editor">
        <MemoryRouter>
          <p>The portal</p>
          <CalendarAlertsGate />
        </MemoryRouter>
      </AdminRoleProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('The portal')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

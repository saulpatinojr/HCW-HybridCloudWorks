/**
 * PlatformTab.test.jsx — Tests for PlatformTab administrator management (AP-B5, #940).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlatformTab, { ADMINS_ROUTE } from './PlatformTab';

const getJSON = vi.fn();
const sendJSON = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

const mockAdmins = [
  {
    id: 'oid-1',
    uid: 'oid-1',
    email: 'super@hcw.dev',
    role: 'super_admin',
    active: true,
  },
  {
    id: 'oid-2',
    uid: 'oid-2',
    email: 'editor@hcw.dev',
    role: 'editor',
    active: true,
  },
  {
    id: 'oid-3',
    uid: 'oid-3',
    email: 'inactive@hcw.dev',
    role: 'viewer',
    active: false,
  },
];

describe('PlatformTab', () => {
  beforeEach(() => {
    getJSON.mockReset().mockResolvedValue({ admins: mockAdmins });
    sendJSON.mockReset().mockResolvedValue({ success: true });
  });

  it('loads and renders the list of administrators', async () => {
    render(<PlatformTab />);

    expect(screen.getByText('Loading administrators...')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('super@hcw.dev')).toBeTruthy();
      expect(screen.getByText('editor@hcw.dev')).toBeTruthy();
      expect(screen.getByText('inactive@hcw.dev')).toBeTruthy();
    });

    expect(getJSON).toHaveBeenCalledWith(ADMINS_ROUTE);
  });

  it('renders role badges and active statuses', async () => {
    render(<PlatformTab />);

    await waitFor(() => {
      expect(screen.getAllByText('super admin').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('editor').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('viewer').length).toBeGreaterThanOrEqual(1);
    });

    const activeBadges = screen.getAllByText('Active');
    expect(activeBadges).toHaveLength(2);
    expect(screen.getByText('Inactive')).toBeTruthy();
  });

  it('requires confirmation before changing an admin role', async () => {
    render(<PlatformTab />);

    await waitFor(() => {
      expect(screen.getByText('editor@hcw.dev')).toBeTruthy();
    });

    const select = screen.getByLabelText('Change role for editor@hcw.dev');
    fireEvent.change(select, { target: { value: 'publisher' } });

    // Confirm modal should appear
    expect(screen.getByText('Change Administrator Role')).toBeTruthy();
    expect(
      screen.getByText(
        'Are you sure you want to change the role of editor@hcw.dev from "editor" to "publisher"?'
      )
    ).toBeTruthy();

    // Confirm the action
    const confirmButton = screen.getByRole('button', { name: 'Change Role' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/admins/oid-2',
        'PATCH',
        expect.objectContaining({
          role: 'publisher',
          reason: 'Role changed to publisher from Platform tab',
        })
      );
    });
  });

  it('cancels role change when cancel is clicked in modal', async () => {
    render(<PlatformTab />);

    await waitFor(() => {
      expect(screen.getByText('editor@hcw.dev')).toBeTruthy();
    });

    const select = screen.getByLabelText('Change role for editor@hcw.dev');
    fireEvent.change(select, { target: { value: 'publisher' } });

    expect(screen.getByText('Change Administrator Role')).toBeTruthy();

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    expect(sendJSON).not.toHaveBeenCalled();
    expect(screen.queryByText('Change Administrator Role')).toBeNull();
  });

  it('requires confirmation before deactivating an admin', async () => {
    render(<PlatformTab />);

    await waitFor(() => {
      expect(screen.getByText('editor@hcw.dev')).toBeTruthy();
    });

    const deactivateButton = screen.getByRole('button', { name: 'Deactivate editor@hcw.dev' });
    fireEvent.click(deactivateButton);

    expect(screen.getByText('Deactivate Administrator')).toBeTruthy();
    expect(
      screen.getByText(
        'Are you sure you want to deactivate editor@hcw.dev? They will lose admin access immediately.'
      )
    ).toBeTruthy();

    const confirmButton = screen.getByRole('button', { name: 'Deactivate' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/admins/oid-2',
        'PATCH',
        expect.objectContaining({
          active: false,
          reason: 'Deactivated from Platform tab',
        })
      );
    });
  });

  it('displays an error if demotion of last super admin is rejected', async () => {
    sendJSON.mockRejectedValueOnce(
      new Error('Cannot demote or deactivate the last active super admin')
    );

    render(<PlatformTab />);

    await waitFor(() => {
      expect(screen.getByText('super@hcw.dev')).toBeTruthy();
    });

    const select = screen.getByLabelText('Change role for super@hcw.dev');
    fireEvent.change(select, { target: { value: 'editor' } });

    const confirmButton = screen.getByRole('button', { name: 'Change Role' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(
        screen.getByText('Cannot demote or deactivate the last active super admin')
      ).toBeTruthy();
    });
  });

  it('refreshes admin list on clicking refresh', async () => {
    render(<PlatformTab />);

    await waitFor(() => {
      expect(screen.getByText('super@hcw.dev')).toBeTruthy();
    });

    const refreshButton = screen.getByRole('button', { name: 'Refresh administrators' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(getJSON).toHaveBeenCalledTimes(2);
    });
  });
});

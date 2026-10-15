/**
 * The toaster mounts with the admin shell, statically (AP-F12, #936). It was
 * a lazy Suspense child of App, so a toast fired by a page before the
 * toaster's chunk arrived could expire before anything could show it. Here
 * one is fired before the layout renders at all and is on screen after.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from '@/components/ui/use-toast';

vi.mock('@/lib/api', () => ({
  postJSON: vi.fn(),
}));

import { postJSON } from '@/lib/api';
import AdminLayout from './AdminLayout';

beforeEach(() => {
  // The shell's badge counts; this test is not about them.
  postJSON.mockResolvedValue({ stats: {} });
});

describe('AdminLayout toaster', () => {
  it('shows a toast fired before the layout first painted', async () => {
    let handle;
    act(() => {
      handle = toast({ title: 'Saved before the shell was up' });
    });
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<p>Dashboard body</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('Saved before the shell was up')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Notifications/ })).toBeInTheDocument();
    act(() => {
      handle.dismiss();
    });
  });
});

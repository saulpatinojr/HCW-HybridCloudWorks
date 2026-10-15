/**
 * The toaster mounts with the admin shell, statically (AP-F12, #936). It was
 * a lazy Suspense child of App, so a toast fired by a page before the
 * toaster's chunk arrived could expire before anything could show it. Here
 * one is fired before the layout renders at all and is on screen after.
 *
 * And the shell leaving does not strand a toast: its clock is the store's,
 * so a toast on screen when the admin left is gone by a later visit rather
 * than shown again on a fresh five seconds.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from '@/components/ui/use-toast';

vi.mock('@/lib/api', () => ({
  postJSON: vi.fn(),
}));

import { postJSON } from '@/lib/api';
import AdminLayout from './AdminLayout';

const fired = [];

beforeEach(() => {
  // The shell's badge counts; this test is not about them.
  postJSON.mockResolvedValue({ stats: {} });
});

afterEach(() => {
  act(() => {
    fired.splice(0).forEach((handle) => handle.dismiss());
  });
  vi.useRealTimers();
});

/** Mount the admin shell on its index route, as a visit to /admin does. */
async function renderShell() {
  const view = render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<p>Dashboard body</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  // Let the badge read settle inside act, so it does not land outside one.
  await act(async () => {});
  return view;
}

/** Advance the fake clock inside act, so the toaster's re-render is flushed. */
function advance(ms) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('AdminLayout toaster', () => {
  it('shows a toast fired before the layout first painted', async () => {
    act(() => {
      fired.push(toast({ title: 'Saved before the shell was up' }));
    });
    await renderShell();
    expect(await screen.findByText('Saved before the shell was up')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Notifications/ })).toBeInTheDocument();
  });

  it('a toast left behind when the shell unmounts is not shown on the next visit', async () => {
    vi.useFakeTimers();
    const first = await renderShell();
    act(() => {
      fired.push(toast({ title: 'Saved just before leaving' }));
    });
    expect(screen.getByText('Saved just before leaving')).toBeInTheDocument();

    first.unmount();
    advance(5000);

    await renderShell();
    expect(screen.getByText('Dashboard body')).toBeInTheDocument();
    expect(screen.queryByText('Saved just before leaving')).toBeNull();
  });

  it('a visit inside the toast’s lifetime shows what is left of it, not a fresh five seconds', async () => {
    vi.useFakeTimers();
    const first = await renderShell();
    act(() => {
      fired.push(toast({ title: 'Published' }));
    });
    advance(3000);
    first.unmount();
    advance(1000);

    await renderShell();
    expect(screen.getByText('Published')).toBeInTheDocument();
    // Five seconds after it was fired, not after the shell came back.
    advance(1000);
    expect(screen.queryByText('Published')).toBeNull();
  });
});

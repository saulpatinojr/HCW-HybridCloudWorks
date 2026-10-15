/**
 * The toaster stacks (AP-F12, #936): two toasts fired within 100 ms are both
 * on screen, each with its own status role, and the viewport is not an
 * atomic live region that would re-announce the list and swallow the one
 * replaced.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Toaster } from './toaster';
import { toast } from './use-toast';

const fired = [];

afterEach(() => {
  act(() => {
    fired.splice(0).forEach((handle) => handle.dismiss());
  });
});

describe('Toaster', () => {
  it('shows two toasts fired within 100 ms, both at once', async () => {
    render(<Toaster />);
    act(() => {
      fired.push(toast({ title: 'First outcome', description: 'published' }));
      fired.push(toast({ title: 'Second outcome', description: 'failed' }));
    });
    expect(await screen.findByText('First outcome')).toBeInTheDocument();
    expect(screen.getByText('Second outcome')).toBeInTheDocument();
    expect(screen.getByText('published')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();

    // Each toast is its own status item; the list itself is a plain region.
    const items = screen.getAllByRole('status');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const viewport = screen.getByRole('region', { name: /Notifications/ });
    expect(viewport).not.toHaveAttribute('aria-live');
    expect(viewport).not.toHaveAttribute('aria-atomic');
  });

  it('shows a toast fired before it mounted', async () => {
    fired.push(toast({ title: 'Fired early' }));
    render(<Toaster />);
    expect(await screen.findByText('Fired early')).toBeInTheDocument();
  });
});

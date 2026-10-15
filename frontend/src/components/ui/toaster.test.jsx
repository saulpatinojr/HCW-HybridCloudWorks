/**
 * The toaster stacks (AP-F12, #936): two toasts fired within 100 ms are both
 * on screen, each with its own status role, and the viewport is not an
 * atomic live region that would re-announce the list and swallow the one
 * replaced.
 *
 * And the store's clock is the only one. Radix still says when the toasts are
 * being read — the pointer over its region, a backgrounded window — and the
 * toaster passes that to the store's pause and resume; Radix's own close
 * timer never runs, so a toast the store holds stays on screen.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Toaster } from './toaster';
import { pauseToast, toast, useToast } from './use-toast';

const fired = [];

afterEach(() => {
  act(() => {
    fired.splice(0).forEach((handle) => handle.dismiss());
  });
  vi.useRealTimers();
});

/** Fire a toast inside act and keep its handle, so afterEach can clear it. */
function fire(props) {
  let handle;
  act(() => {
    handle = toast(props);
  });
  fired.push(handle);
  return handle;
}

/** Advance the fake clock inside act, so the toaster's re-render is flushed. */
function advance(ms) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The labelled region Radix wraps the viewport in, where it listens for the pointer. */
const toastRegion = () => screen.getByRole('region', { name: /Notifications/ });

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

  it('a toast under the pointer outlives its lifetime; the pointer leaving runs out what was left', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    fire({ title: 'Deleted', description: 'one draft' });
    advance(2000);

    fireEvent.pointerMove(toastRegion());
    advance(60000);
    expect(screen.getByText('Deleted')).toBeInTheDocument();

    fireEvent.pointerLeave(toastRegion());
    advance(2999);
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Deleted')).toBeNull();
  });

  it('a backgrounded window holds the toasts too, and coming back resumes them', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    fire({ title: 'Saved' });
    advance(1000);

    fireEvent.blur(window);
    advance(60000);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    fireEvent.focus(window);
    advance(3999);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('Radix never closes a toast on its own clock: one the store holds stays on screen', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const handle = fire({ title: 'Held by the store' });
    // Paused in the store directly, with nothing hovered: only Radix's own
    // timer, were it running, could take it away now.
    pauseToast(handle.id);
    advance(60000);
    expect(screen.getByText('Held by the store')).toBeInTheDocument();
  });

  it('a toast closed by hand while hovered does not stay paused in the store', () => {
    vi.useFakeTimers();
    const store = renderHook(() => useToast());
    render(<Toaster />);
    fire({ title: 'Closed while hovered' });

    fireEvent.pointerMove(toastRegion());
    fireEvent.click(document.querySelector('[toast-close]'));
    expect(screen.queryByText('Closed while hovered')).toBeNull();

    // Its toast unmounted, so Radix will never resume it; the pointer never
    // left, and still the store lets it go when its time runs out.
    advance(4999);
    expect(store.result.current.toasts).toHaveLength(1);
    advance(1);
    expect(store.result.current.toasts).toEqual([]);
  });

  it('the toaster unmounting mid-hover resumes what it paused', () => {
    vi.useFakeTimers();
    const store = renderHook(() => useToast());
    const view = render(<Toaster />);
    fire({ title: 'Left mid-hover' });
    advance(1000);
    fireEvent.pointerMove(toastRegion());

    view.unmount();
    advance(3999);
    expect(store.result.current.toasts).toHaveLength(1);
    advance(1);
    expect(store.result.current.toasts).toEqual([]);
  });
});

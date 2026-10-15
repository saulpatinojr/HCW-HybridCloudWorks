/**
 * The unsaved-changes guard as state (ADR 0033 §2; AP-F12, #936): an in-app
 * link click is held as a pending leave for the page's modal, Cancel keeps
 * the page, and confirm replays the click — or, with the link gone, takes
 * the route through the router.
 *
 * A confirmed leave through a plain link — one the router does not take, as
 * a link in the draft's Markdown preview — is a document navigation, and its
 * own `beforeunload` is not asked a second time. Only that one: a reload
 * after it is asked, and a leave the router takes in place stands nothing
 * down.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { LEAVE_CONFIRM, UNSAVED_MESSAGE, useUnsavedGuard } from './useUnsavedGuard';

// Listeners a test put on the window, removed even when the test fails.
const windowCleanups = [];

afterEach(() => {
  windowCleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

/** A page holding the guard: a router link, a plain link, and the owner's answers as buttons. */
function Harness({ dirty: initialDirty }) {
  const [dirty, setDirty] = useState(initialDirty);
  const leave = useUnsavedGuard(dirty);
  const [linkShown, setLinkShown] = useState(true);
  return (
    <>
      {linkShown && <Link to="/queue">Review Queue</Link>}
      <a href="/drafts-preview-link">Preview link</a>
      <a href="https://example.test/elsewhere">Elsewhere</a>
      <span data-testid="leaving">{String(leave.leaving)}</span>
      <button type="button" onClick={leave.confirmLeave}>
        confirm
      </button>
      <button type="button" onClick={leave.cancelLeave}>
        cancel
      </button>
      <button type="button" onClick={() => setLinkShown(false)}>
        hide link
      </button>
      <button type="button" onClick={() => setDirty(false)}>
        save
      </button>
      <button type="button" onClick={() => setDirty(true)}>
        edit
      </button>
    </>
  );
}

/** Mount the guard on the drafts route, so a followed link unmounts it as leaving the page does. */
const renderGuard = (dirty) =>
  render(
    <MemoryRouter initialEntries={['/drafts']}>
      <Routes>
        <Route path="/drafts" element={<Harness dirty={dirty} />} />
        <Route path="/queue" element={<h1>Queue page</h1>} />
      </Routes>
    </MemoryRouter>
  );

/** Mount the guard beside the routes, so it is still listening after the router has navigated. */
const renderGuardBesideRoutes = () =>
  render(
    <MemoryRouter initialEntries={['/drafts']}>
      <Harness dirty />
      <Routes>
        <Route path="/drafts" element={<p>Drafts page</p>} />
        <Route path="/queue" element={<h1>Queue page</h1>} />
      </Routes>
    </MemoryRouter>
  );

/** Fire `beforeunload` as a reload or a tab close does, and say whether the guard asked. */
function unloadAsks() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Stand in for an engine that fires a link navigation's `beforeunload` inside
 * the click: after every other handler, on a link click nothing cancelled.
 * Returns what each of those prompts answered, and the listener's removal.
 */
function askInsideTheClick() {
  const asked = [];
  const listener = (event) => {
    const followed = event.target?.closest?.('a[href]') && !event.defaultPrevented;
    if (followed) asked.push(unloadAsks());
  };
  const stop = () => window.removeEventListener('click', listener);
  window.addEventListener('click', listener);
  windowCleanups.push(stop);
  return { asked, stop };
}

describe('useUnsavedGuard', () => {
  it('names the modal copy from the one message', () => {
    expect(LEAVE_CONFIRM.description).toBe(UNSAVED_MESSAGE);
    expect(LEAVE_CONFIRM.title).toBe('Leave this draft?');
  });

  it('clean: a link is followed at once', () => {
    renderGuard(false);
    fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
    expect(screen.getByText('Queue page')).toBeInTheDocument();
  });

  it('dirty: the click is held as a pending leave, and Cancel keeps the page', () => {
    renderGuard(true);
    expect(screen.getByTestId('leaving')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
    expect(screen.getByTestId('leaving')).toHaveTextContent('true');
    expect(screen.queryByText('Queue page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.getByTestId('leaving')).toHaveTextContent('false');
    expect(screen.queryByText('Queue page')).toBeNull();
  });

  it('dirty: confirm replays the click through the link', () => {
    renderGuard(true);
    fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(screen.getByText('Queue page')).toBeInTheDocument();
  });

  it('dirty: with the link gone by the time of the answer, the route is taken anyway', () => {
    renderGuard(true);
    fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'hide link' }));
    expect(screen.queryByRole('link', { name: 'Review Queue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(screen.getByText('Queue page')).toBeInTheDocument();
  });

  it('a save while the question is open withdraws it, and the next edit does not bring it back', () => {
    renderGuard(true);
    fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
    expect(screen.getByTestId('leaving')).toHaveTextContent('true');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(screen.getByTestId('leaving')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    expect(screen.getByTestId('leaving')).toHaveTextContent('false');
    // And the withdrawn question's link is not replayed by a later confirm.
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(screen.queryByText('Queue page')).toBeNull();
  });

  it('dirty: a reload or a tab close is asked', () => {
    renderGuard(true);
    expect(unloadAsks()).toBe(true);
    expect(unloadAsks()).toBe(true);
  });

  // jsdom does not navigate: a followed plain link prints its "Not
  // implemented: navigation" line, as the off-site click below always has.
  it('a confirmed leave through a plain link is not asked again by its beforeunload; a reload after it is', () => {
    renderGuard(true);
    fireEvent.click(screen.getByRole('link', { name: 'Preview link' }));
    expect(screen.getByTestId('leaving')).toHaveTextContent('true');
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    // The document navigation the owner just agreed to: not asked again.
    expect(unloadAsks()).toBe(false);
    // Anything after it — a reload, a tab close — is asked as before.
    expect(unloadAsks()).toBe(true);
  });

  it('the same holds when the browser asks inside the replayed click', () => {
    renderGuard(true);
    const inside = askInsideTheClick();
    fireEvent.click(screen.getByRole('link', { name: 'Preview link' }));
    // The held click was cancelled, so no prompt came with it.
    expect(inside.asked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    inside.stop();
    // The replayed click's own prompt, fired before click() returned.
    expect(inside.asked).toEqual([false]);
    expect(unloadAsks()).toBe(true);
  });

  it('a confirmed leave whose navigation never unloads the page stands the prompt down only briefly', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    renderGuard(true);
    fireEvent.click(screen.getByRole('link', { name: 'Preview link' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    // No `beforeunload` came; a reload two seconds later is asked.
    now.mockReturnValue(1_002_000);
    expect(unloadAsks()).toBe(true);
  });

  it('a confirmed leave the router takes in place stands nothing down', () => {
    renderGuardBesideRoutes();
    const inside = askInsideTheClick();
    fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    inside.stop();
    expect(screen.getByText('Queue page')).toBeInTheDocument();
    // The Link cancelled its click and navigated in place: no prompt came,
    // and the guard, still mounted, asks on the next reload.
    expect(inside.asked).toEqual([]);
    expect(unloadAsks()).toBe(true);
  });

  it('a modified click or an off-site link is not held', () => {
    renderGuard(true);
    const link = screen.getByRole('link', { name: 'Review Queue' });
    fireEvent.click(link, { ctrlKey: true });
    expect(screen.getByTestId('leaving')).toHaveTextContent('false');
    const away = screen.getByRole('link', { name: 'Elsewhere' });
    fireEvent.click(away);
    expect(screen.getByTestId('leaving')).toHaveTextContent('false');
  });
});

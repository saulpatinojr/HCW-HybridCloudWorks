/**
 * The unsaved-changes guard as state (ADR 0033 §2; AP-F12, #936): an in-app
 * link click is held as a pending leave for the page's modal, Cancel keeps
 * the page, and confirm replays the click — or, with the link gone, takes
 * the route through the router.
 */
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { LEAVE_CONFIRM, UNSAVED_MESSAGE, useUnsavedGuard } from './useUnsavedGuard';

function Harness({ dirty: initialDirty }) {
  const [dirty, setDirty] = useState(initialDirty);
  const leave = useUnsavedGuard(dirty);
  const [linkShown, setLinkShown] = useState(true);
  return (
    <>
      {linkShown && <Link to="/queue">Review Queue</Link>}
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

const renderGuard = (dirty) =>
  render(
    <MemoryRouter initialEntries={['/drafts']}>
      <Routes>
        <Route path="/drafts" element={<Harness dirty={dirty} />} />
        <Route path="/queue" element={<h1>Queue page</h1>} />
      </Routes>
    </MemoryRouter>
  );

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

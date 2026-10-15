/**
 * Transcripts, the review action by role (AP-F4, #928): below the publisher
 * role the action says why it is unavailable, in words that match the button
 * it sits under, and a failed transcript, which has no review button, carries
 * no sentence at all.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminRoleProvider } from '@/hooks/useAdminRole';
import TranscriptsTab from './TranscriptsTab';

const APPROVE_REASON = 'Approving a transcript for the host needs the publisher role.';
const RETURN_REASON = 'Returning a transcript to draft needs the publisher role.';

/** The hub as useRecordingHub hands it to the tab, so each test names only its items. */
function hubWith(items) {
  return {
    items,
    loading: false,
    loadError: null,
    detail: null,
    busyKey: null,
    reload: vi.fn(),
    open: vi.fn(),
    closeDetail: vi.fn(),
    review: vi.fn(),
    retryHost: vi.fn(),
  };
}

/** Render the tab under the role AdminAuthGuard would provide, so the gates read it. */
function renderTab(role, items) {
  const hub = hubWith(items);
  render(
    <AdminRoleProvider value={role}>
      <TranscriptsTab hub={hub} />
    </AdminRoleProvider>
  );
  return hub;
}

describe('TranscriptsTab review action by role (AP-F4)', () => {
  it('gives a failed transcript no review button, and no reason beside nothing', () => {
    for (const role of ['viewer', 'editor']) {
      renderTab(role, [
        {
          id: 't-failed',
          title: 'Failed episode',
          status: 'failed',
          error: 'The model timed out.',
        },
      ]);
      expect(screen.getByText('The model timed out.')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Approve|Return to draft/ })
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/needs the publisher role/)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('says returning to draft, not approving, under a published transcript', () => {
    const hub = renderTab('editor', [{ id: 't-live', title: 'Live episode', status: 'published' }]);
    const button = screen.getByRole('button', { name: /Return to draft/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(RETURN_REASON);
    expect(screen.queryByText(APPROVE_REASON)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(hub.review).not.toHaveBeenCalled();
  });

  it('says approving under a transcript still waiting for review', () => {
    const hub = renderTab('viewer', [{ id: 't-draft', title: 'New episode', status: 'draft' }]);
    const button = screen.getByRole('button', { name: /Approve/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(APPROVE_REASON);
    expect(screen.queryByText(RETURN_REASON)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(hub.review).not.toHaveBeenCalled();
  });

  it('leaves both buttons as written for a publisher', () => {
    const hub = renderTab('publisher', [
      { id: 't-draft', title: 'New episode', status: 'draft' },
      { id: 't-live', title: 'Live episode', status: 'published' },
    ]);
    expect(screen.queryByText(/needs the publisher role/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    fireEvent.click(screen.getByRole('button', { name: /Return to draft/ }));
    expect(hub.review).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 't-draft' }),
      'published'
    );
    expect(hub.review).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 't-live' }),
      'draft'
    );
  });
});

/**
 * The two ways out of the archive (AP-F13, #937): Restore to live is the
 * publisher's transition back to `published`, and Delete permanently is the
 * one irreversible action, so it alone asks first. Either way the row leaves
 * the board without a refetch, and a refusal is shown beside the rows. A
 * delete names the status the row was read in, so a page restored elsewhere
 * meanwhile is refused and kept; a restore asks the page for a fresh live
 * list.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ArchiveBoard from './ArchiveBoard';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

const archived = (n) => ({
  id: `a${n}`,
  title: `Archived ${n}`,
  type: 'blog',
  contentStatus: 'archived',
  Live: false,
  'Cloud Provider': 'Azure',
  archivedAt: '2026-10-15T10:00:00.000Z',
});

function renderOpen(items = [archived(1), archived(2)], { onRestored } = {}) {
  render(<ArchiveBoard archivedList={items} loading={false} onRestored={onRestored} />);
  fireEvent.click(screen.getByRole('button', { name: /^Archive \(/ }));
}

/** The error authedFetch throws for a refusal: the server's sentence, its status and code. */
const refusal = (status, message, code) => Object.assign(new Error(message), { status, code });

const rowOf = (title) => screen.getByText(title).closest('div.rounded-lg');

beforeEach(() => {
  postJSON.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ArchiveBoard', () => {
  it('lists the archived rows, each with Restore to live and Delete permanently', () => {
    renderOpen();
    expect(screen.getByRole('heading', { name: 'Archive (2)' })).toBeInTheDocument();
    const row = rowOf('Archived 1');
    expect(within(row).getByRole('button', { name: 'Restore to live' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete permanently' })).toBeInTheDocument();
  });

  it('Restore to live is the transition back to published, and the row leaves', async () => {
    postJSON.mockResolvedValue({ success: true, from: 'archived', to: 'published' });
    renderOpen();

    fireEvent.click(within(rowOf('Archived 1')).getByRole('button', { name: 'Restore to live' }));

    await waitFor(() => expect(screen.queryByText('Archived 1')).not.toBeInTheDocument());
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith(
      'transitionContentStatus',
      expect.objectContaining({ contentId: 'a1', newStatus: 'published', markLive: true })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Archived 2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archive (1)' })).toBeInTheDocument();
  });

  it('Delete permanently asks first, then removes the record through deleteContentItem', async () => {
    postJSON.mockResolvedValue({ success: true });
    renderOpen();

    fireEvent.click(
      within(rowOf('Archived 2')).getByRole('button', { name: 'Delete permanently' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete this page permanently?');
    expect(postJSON).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(screen.queryByText('Archived 2')).not.toBeInTheDocument());
    expect(postJSON).toHaveBeenCalledTimes(1);
    // Only while it is still archived: the status the row was read in.
    expect(postJSON).toHaveBeenCalledWith('deleteContentItem', {
      contentId: 'a2',
      expectedStatus: 'archived',
    });
    expect(screen.getByText('Archived 1')).toBeInTheDocument();
  });

  it('keeps the row and shows the conflict when the page was restored elsewhere since the board loaded', async () => {
    const said =
      'This item is published now, not archived, and was not deleted; reload to see where it is.';
    postJSON.mockRejectedValue(refusal(409, said, 'STATUS_CHANGED'));
    renderOpen();

    fireEvent.click(
      within(rowOf('Archived 2')).getByRole('button', { name: 'Delete permanently' })
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(said);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Delete failed');
    expect(screen.getByText('Archived 2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archive (2)' })).toBeInTheDocument();
  });

  it('asks the page to read the live list again after a restore, and only after one that landed', async () => {
    const onRestored = vi.fn();
    postJSON.mockRejectedValueOnce(new Error('HTTP 403'));
    renderOpen(undefined, { onRestored });

    fireEvent.click(within(rowOf('Archived 1')).getByRole('button', { name: 'Restore to live' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Restore failed: HTTP 403');
    expect(onRestored).not.toHaveBeenCalled();

    postJSON.mockResolvedValueOnce({ success: true, from: 'archived', to: 'published' });
    fireEvent.click(within(rowOf('Archived 1')).getByRole('button', { name: 'Restore to live' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('cancelling the confirm deletes nothing', async () => {
    renderOpen();
    fireEvent.click(
      within(rowOf('Archived 1')).getByRole('button', { name: 'Delete permanently' })
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postJSON).not.toHaveBeenCalled();
    expect(screen.getByText('Archived 1')).toBeInTheDocument();
  });

  it('keeps the row and shows the refusal when the API says no', async () => {
    postJSON.mockRejectedValue(new Error('HTTP 403'));
    renderOpen();

    fireEvent.click(within(rowOf('Archived 1')).getByRole('button', { name: 'Restore to live' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Restore failed: HTTP 403');
    expect(screen.getByText('Archived 1')).toBeInTheDocument();
  });
});

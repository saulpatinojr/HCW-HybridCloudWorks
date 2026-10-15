/**
 * ConfirmModal: the question, its two answers, and the busy state (AP-F12,
 * #936) — while the confirmed request runs the confirm button is disabled
 * under a progress label and nothing dismisses the dialog.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

/** Open the modal on a destructive question, overridable per test, and hand back both answers. */
const renderModal = (over = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmModal
      open
      title="Delete item?"
      description="This cannot be undone."
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />
  );
  return { onConfirm, onCancel };
};

describe('ConfirmModal', () => {
  it('asks, and reports each answer', () => {
    const { onConfirm, onCancel } = renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Delete item?' });
    expect(dialog).toHaveTextContent('This cannot be undone.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape and the close button are a cancel', async () => {
    const { onCancel } = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2));
  });

  it('busy: the confirm button is disabled under its progress label, and nothing dismisses the dialog', async () => {
    const { onConfirm, onCancel } = renderModal({ busy: true, busyLabel: 'Deleting…' });
    const dialog = screen.getByRole('dialog', { name: 'Delete item?' });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    const busy = screen.getByRole('button', { name: 'Deleting…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(busy);
    expect(onConfirm).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Delete item?' })).toBeInTheDocument();
  });

  it('renders the preview between the description and the buttons', () => {
    renderModal({ preview: <ul aria-label="Affected">{<li>one</li>}</ul> });
    expect(screen.getByRole('list', { name: 'Affected' })).toHaveTextContent('one');
  });
});

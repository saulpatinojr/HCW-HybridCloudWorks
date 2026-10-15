/**
 * The Keyword Matrix's deletes ask through ConfirmModal, held busy while the
 * request runs, instead of a browser dialog (ADR 0033 §2; AP-F12, #936).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const deleteKeywordSynonym = vi.fn();
const deleteKeywordAugmentation = vi.fn();
const toast = vi.fn();

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/useImagePrompts', () => ({
  useImagePrompts: () => ({
    fetchKeywordSynonyms: async () => [{ id: 'db', canonical: 'Database', patterns: ['mysql'] }],
    saveKeywordSynonym: vi.fn(),
    deleteKeywordSynonym: (...a) => deleteKeywordSynonym(...a),
    fetchKeywordAugmentations: async () => [
      { id: 'kiro', label: 'Kiro', patterns: ['kiro'], directive: 'Show the Kiro icon.' },
    ],
    saveKeywordAugmentation: vi.fn(),
    deleteKeywordAugmentation: (...a) => deleteKeywordAugmentation(...a),
  }),
}));

const { default: KeywordMatrixPanel } = await import('./KeywordMatrixPanel.jsx');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KeywordMatrixPanel deletes', () => {
  it('a synonym group: asks in the modal, sends nothing on Cancel, deletes once on confirm while busy', async () => {
    let settle;
    deleteKeywordSynonym.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    render(<KeywordMatrixPanel />);
    const button = await screen.findByRole('button', { name: 'Delete synonym group Database' });

    fireEvent.click(button);
    const first = await screen.findByRole('dialog', { name: 'Delete synonym group "Database"?' });
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteKeywordSynonym).not.toHaveBeenCalled();

    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Delete synonym group "Database"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(deleteKeywordSynonym).toHaveBeenCalledWith('db');
    const busy = await within(dialog).findByRole('button', { name: 'Deleting…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(deleteKeywordSynonym).toHaveBeenCalledTimes(1);

    settle(true);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({ title: 'Deleted', description: 'Database' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an augmentation: the same modal, named for it', async () => {
    deleteKeywordAugmentation.mockResolvedValue(true);
    render(<KeywordMatrixPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete augmentation Kiro' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete augmentation "Kiro"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteKeywordAugmentation).toHaveBeenCalledWith('kiro'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({ title: 'Deleted', description: 'Kiro' })
    );
  });
});

/**
 * The CSV import dialog (ADR 0033 §4). What must hold: a paste or a file
 * over the character limit is refused before anything is sent, the message
 * names the limit, and nothing clipped ever reaches `onImport`; a text
 * within the limit is sent whole with the ticked programs.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import CsvImportDialog from './CsvImportDialog';

const source = { reader: 'example-classes', label: 'Example classes (CSV)', hint: 'The export.' };
const programs = [{ id: 'p1', name: 'Example Program' }];
const header = 'MTM Class ID,Course,Start Date\n';

function renderDialog(props = {}) {
  const onImport = vi.fn().mockResolvedValue(true);
  render(
    <CsvImportDialog
      source={source}
      programs={programs}
      onClose={() => {}}
      onImport={onImport}
      importing={false}
      maxChars={60}
      {...props}
    />
  );
  return onImport;
}

describe('CsvImportDialog size limit', () => {
  it('refuses a paste over the limit, names the limit, and never sends a prefix', async () => {
    const onImport = renderDialog();
    const long = `${header}1,${'x'.repeat(80)},2026-01-02`;
    fireEvent.change(screen.getByLabelText('Or paste the CSV'), { target: { value: long } });
    expect(screen.getByRole('alert')).toHaveTextContent(
      `The pasted text is ${long.length.toLocaleString('en-US')} characters; the limit is 60.`
    );
    const button = screen.getByRole('button', { name: /Import 1 row/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('sends a text within the limit whole, with the ticked programs', async () => {
    const onImport = renderDialog();
    const text = `${header}1,AZ-104,2026-01-02`;
    fireEvent.change(screen.getByLabelText('Or paste the CSV'), { target: { value: text } });
    fireEvent.click(screen.getByLabelText('Example Program'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Import 1 row/ }));
    });
    expect(onImport).toHaveBeenCalledWith(text, ['p1']);
    expect(screen.getByText(/Up to 60 characters/)).toBeInTheDocument();
  });

  it('refuses a file over the limit before reading it in, and takes one within it', async () => {
    const onImport = renderDialog();
    const input = screen.getByLabelText('Choose the CSV file');
    const big = { name: 'big.csv', text: async () => `${header}${'y'.repeat(100)}` };
    await act(async () => {
      fireEvent.change(input, { target: { files: [big] } });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'big.csv is 131 characters; the limit is 60. Split the export and import each part.'
    );
    expect(screen.getByLabelText('Or paste the CSV')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Import rows/ })).toBeDisabled();

    const small = { name: 'small.csv', text: async () => `${header}2,SC-900,2026-02-03` };
    await act(async () => {
      fireEvent.change(input, { target: { files: [small] } });
    });
    await waitFor(() => expect(screen.getByText(/small\.csv ·/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Import 1 row/ }));
    });
    expect(onImport).toHaveBeenCalledWith(`${header}2,SC-900,2026-02-03`, []);
  });
});

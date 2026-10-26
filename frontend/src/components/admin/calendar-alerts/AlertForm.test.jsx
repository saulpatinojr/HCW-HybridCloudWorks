/**
 * The add/edit form: what it refuses beside the field, what it sends, and
 * what it does with the server's refusal.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AlertForm, {
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  fieldProblems,
  initialFields,
  toPayload,
} from './AlertForm';

const TODAY = '2026-10-26';

const existing = {
  id: 'a1',
  title: 'Renew the domain',
  dueDate: '2026-11-02',
  dueTime: '14:30',
  link: 'https://example.com/renew',
  note: 'Ask for the transfer code.',
};

const type = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the pure helpers', () => {
  it('starts an empty form on today, and an edit form on the alert', () => {
    expect(initialFields(null, TODAY)).toEqual({
      title: '',
      dueDate: TODAY,
      dueTime: '',
      link: '',
      note: '',
    });
    expect(initialFields(existing, TODAY)).toEqual({
      title: 'Renew the domain',
      dueDate: '2026-11-02',
      dueTime: '14:30',
      link: 'https://example.com/renew',
      note: 'Ask for the transfer code.',
    });
  });

  it('finds what is wrong, by field', () => {
    const ok = initialFields(existing, TODAY);
    expect(fieldProblems(ok)).toEqual({});
    expect(fieldProblems({ ...ok, title: '  ' }).title).toMatch(/title/);
    expect(fieldProblems({ ...ok, title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }).title).toMatch(
      /longer/
    );
    expect(fieldProblems({ ...ok, dueDate: '' }).dueDate).toMatch(/day/);
    expect(fieldProblems({ ...ok, link: 'http://example.com' }).link).toMatch(/https/);
    expect(fieldProblems({ ...ok, link: 'javascript:alert(1)' }).link).toMatch(/https/);
    expect(fieldProblems({ ...ok, link: '/admin/health' })).toEqual({});
    expect(fieldProblems({ ...ok, note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }).note).toMatch(/longer/);
  });

  it('sends blank optional fields empty, so an edit can clear them', () => {
    expect(
      toPayload({ title: ' T ', dueDate: '2026-11-02', dueTime: '', link: ' ', note: ' ' })
    ).toEqual({ title: 'T', dueDate: '2026-11-02', dueTime: null, link: '', note: '' });
  });
});

describe('adding', () => {
  it('names each field in plain words, with the date and time in UTC', () => {
    render(<AlertForm today={TODAY} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('form', { name: 'Add alert' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Due date (UTC day)')).toHaveValue(TODAY);
    expect(screen.getByLabelText('Time (optional, UTC)')).toHaveValue('');
    expect(screen.getByLabelText('Link (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument();
    expect(screen.getByText(/do not put passwords or keys in it/)).toBeInTheDocument();
  });

  it('refuses an empty title beside the field and sends nothing', async () => {
    const onSubmit = vi.fn();
    render(<AlertForm today={TODAY} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    expect(await screen.findByText('Give the alert a title.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Title')).toHaveAccessibleDescription('Give the alert a title.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a link that is not https or a portal page', async () => {
    const onSubmit = vi.fn();
    render(<AlertForm today={TODAY} onSubmit={onSubmit} onCancel={vi.fn()} />);
    type('Title', 'Something');
    type('Link (optional)', 'http://example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    expect(await screen.findByText(/Use a web address that starts with https/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the fields as the server reads them', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<AlertForm today={TODAY} onSubmit={onSubmit} onCancel={vi.fn()} />);
    type('Title', '  Call the registrar ');
    type('Due date (UTC day)', '2026-11-05');
    type('Time (optional, UTC)', '09:15');
    type('Link (optional)', 'https://example.com/call');
    type('Note (optional)', 'Ask about the transfer.');
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Call the registrar',
      dueDate: '2026-11-05',
      dueTime: '09:15',
      link: 'https://example.com/call',
      note: 'Ask about the transfer.',
    });
  });

  it("counts the note's characters as it is typed", () => {
    render(<AlertForm today={TODAY} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/^0 of 500 characters/)).toBeInTheDocument();
    type('Note (optional)', 'hello');
    expect(screen.getByText(/^5 of 500 characters/)).toBeInTheDocument();
  });

  it("shows the server's sentence when it refuses, and stays open to fix it", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('There are already 300 alerts.'));
    render(<AlertForm today={TODAY} onSubmit={onSubmit} onCancel={vi.fn()} />);
    type('Title', 'One more');
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There are already 300 alerts.');
    expect(screen.getByLabelText('Title')).toHaveValue('One more');
    expect(screen.getByRole('button', { name: 'Add alert' })).toBeEnabled();
  });

  it('cannot be submitted twice while it is saving', async () => {
    let finish;
    const onSubmit = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<AlertForm today={TODAY} onSubmit={onSubmit} onCancel={vi.fn()} />);
    type('Title', 'Once');
    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish({});
  });

  it('Cancel closes without sending', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<AlertForm today={TODAY} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('editing', () => {
  it('starts on the alert and saves the changes', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<AlertForm alert={existing} today={TODAY} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByRole('form', { name: 'Edit alert' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Renew the domain');
    expect(screen.getByLabelText('Time (optional, UTC)')).toHaveValue('14:30');

    type('Time (optional, UTC)', '');
    type('Link (optional)', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Renew the domain',
      dueDate: '2026-11-02',
      dueTime: null,
      link: '',
      note: 'Ask for the transfer code.',
    });
  });
});

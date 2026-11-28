/**
 * The guided application (ADR 0033 §4). What must hold: the sections come in
 * the form's order and each kind renders its own control; a text answer
 * shows the live count against its limit; an answer is stored as one
 * `{ questionId, text }` and a structured one JSON-encoded; Copy puts the
 * worded answer on the clipboard and Copy all the whole packet; activities
 * pick from the attached evidence and stop at the limit.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

import GuidedResponses from './GuidedResponses';

const questions = [
  { id: 'name', section: 'Profile', prompt: 'First name', kind: 'profile' },
  { id: 'why', section: 'Questions', prompt: 'Why?', kind: 'text', maxChars: 20 },
  { id: 'member', section: 'Questions', prompt: 'Are you a member?', kind: 'yesno' },
  { id: 'cat', section: 'Questions', prompt: 'Category', kind: 'choice', options: ['A', 'B'] },
  { id: 'site', section: 'Questions', prompt: 'Website', kind: 'url' },
  {
    id: 'grid',
    section: 'Tools',
    prompt: 'How often?',
    kind: 'scale',
    rows: ['Teams'],
    options: ['Daily', 'Never'],
  },
  { id: 'links', section: 'Network', prompt: 'Networks', kind: 'links', options: ['GitHub'] },
  { id: 'acts', section: 'Expertise', prompt: 'Activities', kind: 'activities', maxItems: 1 },
  {
    id: 'area',
    section: 'Expertise',
    prompt: 'Technology area',
    kind: 'choice',
    options: ['Azure: Networking'],
    allowOther: true,
  },
];

const evidence = [
  { id: 'e1', title: 'KCDC talk', date: '2026-08-14', url: 'https://kcdc.info' },
  { id: 'e2', title: 'Meetup', date: '2026-09-01' },
];

function Harness({ initial = [], onChange = () => {}, attached = evidence }) {
  const [responses, setResponses] = useState(initial);
  return (
    <GuidedResponses
      questions={questions}
      responses={responses}
      evidence={attached}
      title="Example Program 2026"
      onChange={(next) => {
        setResponses(next);
        onChange(next);
      }}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete navigator.clipboard;
});

describe('GuidedResponses', () => {
  it('renders the sections in order with a control per kind and counts the answered', () => {
    render(<Harness />);
    const legends = screen.getAllByRole('group').map((g) => g.querySelector('legend').textContent);
    expect(legends).toEqual(['Profile', 'Questions', 'Tools', 'Network', 'Expertise']);
    expect(screen.getByText('0 of 9 answered', { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Why?').tagName).toBe('TEXTAREA');
    expect(within(screen.getByRole('radiogroup')).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByLabelText('Category').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Website')).toHaveAttribute('type', 'url');
    expect(screen.getByLabelText('Teams').tagName).toBe('SELECT');
    expect(screen.getByRole('button', { name: 'Add link' })).toBeInTheDocument();
    expect(screen.getByText(/Tag up to 1 activities/)).toBeInTheDocument();
  });

  it('stores a text answer with its live count, a yes/no, a choice and a structured grid', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Why?'), { target: { value: 'Because' } });
    expect(onChange).toHaveBeenLastCalledWith([{ questionId: 'why', text: 'Because' }]);
    expect(screen.getByText('7 / 20 characters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { questionId: 'why', text: 'Because' },
      { questionId: 'member', text: 'Yes' },
    ]);

    fireEvent.change(screen.getByLabelText('Teams'), { target: { value: 'Daily' } });
    expect(onChange.mock.calls.at(-1)[0].find((r) => r.questionId === 'grid').text).toBe(
      JSON.stringify({ Teams: 'Daily' })
    );
    // Clearing an answer removes its entry rather than leaving an empty one.
    fireEvent.change(screen.getByLabelText('Why?'), { target: { value: '' } });
    expect(onChange.mock.calls.at(-1)[0].map((r) => r.questionId)).toEqual(['member', 'grid']);
    expect(screen.getByText('2 of 9 answered', { exact: false })).toBeInTheDocument();
  });

  it('lets a choice with allowOther take a typed value, and opens a stored off-list value in that mode', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const select = screen.getByLabelText('Technology area');
    expect(screen.queryByLabelText('Technology area (other)')).toBeNull();
    fireEvent.change(select, { target: { value: '__other__' } });
    const other = screen.getByLabelText('Technology area (other)');
    fireEvent.change(other, { target: { value: 'M365: Teams' } });
    expect(onChange).toHaveBeenLastCalledWith([{ questionId: 'area', text: 'M365: Teams' }]);
    // Back to a listed option closes the input and stores the option.
    fireEvent.change(select, { target: { value: 'Azure: Networking' } });
    expect(onChange).toHaveBeenLastCalledWith([{ questionId: 'area', text: 'Azure: Networking' }]);
    expect(screen.queryByLabelText('Technology area (other)')).toBeNull();
  });

  it('opens a stored off-list choice in other mode, and a choice without allowOther offers no Other', () => {
    render(<Harness initial={[{ questionId: 'area', text: 'Data Platform: SQL' }]} />);
    expect(screen.getByLabelText('Technology area (other)')).toHaveValue('Data Platform: SQL');
    expect(screen.getByLabelText('Technology area')).toHaveValue('__other__');
    expect(
      within(screen.getByLabelText('Category'))
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Choose…', 'A', 'B']);
  });

  it('shows an activity no longer attached as a removable row, even with nothing attached, and frees the limit on removal', () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ questionId: 'acts', text: '["gone"]' }]} onChange={onChange} />);
    // At the limit of 1 with an invisible selection: the attached rows are blocked...
    expect(screen.getByLabelText(/KCDC talk/)).toBeDisabled();
    const gone = screen.getByLabelText(/No longer attached \(gone\)/);
    expect(gone).toBeChecked();
    // ...until the stale selection is removed.
    fireEvent.click(gone);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByLabelText(/KCDC talk/)).not.toBeDisabled();
    expect(screen.queryByLabelText(/No longer attached/)).toBeNull();
  });

  it('shows a stale activity when no evidence is attached at all', () => {
    render(<Harness initial={[{ questionId: 'acts', text: '["gone"]' }]} attached={[]} />);
    expect(screen.getByText(/Nothing attached yet/)).toBeInTheDocument();
    expect(screen.getByLabelText(/No longer attached \(gone\)/)).toBeChecked();
    expect(screen.getByText(/1 \/ 1/)).toBeInTheDocument();
  });

  it('names a bad URL and keeps the link rows as network + URL', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Website'), { target: { value: 'ftp://x' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Must start with http:// or https://.');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Network 1'), { target: { value: 'GitHub' } });
    fireEvent.change(screen.getByLabelText('URL 1'), { target: { value: 'https://github.com/x' } });
    expect(onChange.mock.calls.at(-1)[0].find((r) => r.questionId === 'links').text).toBe(
      JSON.stringify([{ network: 'GitHub', url: 'https://github.com/x' }])
    );
  });

  it('tags activities from the attached evidence and stops at the limit', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/KCDC talk/));
    expect(onChange).toHaveBeenLastCalledWith([{ questionId: 'acts', text: '["e1"]' }]);
    expect(screen.getByLabelText(/Meetup/)).toBeDisabled();
    expect(screen.getByText(/1 \/ 1/)).toBeInTheDocument();
  });

  it('copies one worded answer, and Copy all the packet in the form’s order', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard = { writeText };
    render(
      <Harness
        initial={[
          { questionId: 'name', text: 'Sam' },
          { questionId: 'acts', text: '["e1"]' },
        ]}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy answer: Activities' }));
    });
    expect(writeText).toHaveBeenLastCalledWith('KCDC talk — 2026-08-14 · https://kcdc.info');
    expect(screen.getByRole('button', { name: 'Copy answer: Why?' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy all answers' }));
    });
    const [packet] = writeText.mock.calls.at(-1);
    expect(
      packet.startsWith('Example Program 2026\n\n## Profile\n\nFirst name\nSam\n\n## Questions\n')
    ).toBe(true);
    expect(packet).toContain('Why?\n(not answered)');
    expect(screen.getByRole('button', { name: 'Copy all answers' })).toHaveTextContent('Copied');
  });

  it('says so when the clipboard is unavailable', async () => {
    render(<Harness initial={[{ questionId: 'name', text: 'Sam' }]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy answer: First name' }));
    });
    expect(screen.getByRole('button', { name: 'Copy answer: First name' })).toHaveTextContent(
      'Copy failed'
    );
  });
});

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { useReducedMotion } from 'framer-motion';
import BrainMap from './BrainMap';
vi.mock('framer-motion', () => ({ useReducedMotion: vi.fn() }));
const nodes = [
  { id: 'a', title: 'Docker release', type: 'note', tags: ['docker'] },
  { id: 'b', title: 'Pipeline research', type: 'reference', tags: ['docker'] },
  { id: 'c', title: 'Unrelated Azure', type: 'reference', tags: [] },
];
const edges = [{ from: 'a', to: 'b', kind: 'explicit' }];
beforeEach(() => {
  localStorage.clear();
  useReducedMotion.mockReturnValue(true);
});
describe('interactive map', () => {
  it('opens a full-screen dialog, closes with X or Escape and returns focus', async () => {
    render(<BrainMap nodes={nodes} edges={edges} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Knowledge map' });
    expect(within(dialog).getByRole('region', { name: 'Knowledge canvas' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Full screen' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('restores the palette and label size after remounting without storing note text', async () => {
    const first = render(<BrainMap nodes={nodes} edges={edges} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText('Appearance', { exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Warm', exact: true }));
    fireEvent.change(screen.getByLabelText('Map label size'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Note color'), { target: { value: '#075985' } });
    first.unmount();
    render(<BrainMap nodes={nodes} edges={edges} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Explore Docker release' });
    expect(screen.getByRole('button', { name: 'Warm', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByLabelText('Map label size')).toHaveValue('10');
    expect(screen.getByLabelText('Note color')).toHaveValue('#075985');
    expect(localStorage.getItem('hcw.brain.map.appearance.v1')).not.toContain('Docker release');
    fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }));
    expect(screen.getByRole('button', { name: 'Cloud', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
  it('explores a node with the keyboard, isolates its neighborhood and opens its real item', async () => {
    const open = vi.fn();
    render(<BrainMap nodes={nodes} edges={edges} onSelect={open} />);
    const graph = screen.getByRole('group', { name: 'Interactive knowledge graph' });
    fireEvent.keyDown(
      await within(graph).findByRole('button', { name: 'Explore Docker release' }),
      { key: 'Enter' }
    );
    expect(screen.getByRole('heading', { name: 'Docker release' })).toBeInTheDocument();
    expect(screen.getByText('Connections · 1')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Selected neighborhood'));
    expect(
      within(graph).queryByRole('button', { name: 'Explore Unrelated Azure' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open note', exact: true }));
    expect(open).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selected node' }));
    expect(screen.getByRole('heading', { name: 'Follow an idea' })).toBeInTheDocument();
    expect(
      await within(graph).findByRole('button', { name: 'Explore Unrelated Azure' })
    ).toBeInTheDocument();
  });
  it('shows an honest empty filter state and honors reduced motion', async () => {
    useReducedMotion.mockReturnValue(true);
    render(<BrainMap nodes={nodes} edges={edges} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Animate layout' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Find in map'), { target: { value: 'missing topic' } });
    expect(await screen.findByText(/No items match these filters/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Find in map'), { target: { value: '' } });
    expect(
      await screen.findByRole('button', { name: 'Explore Docker release' })
    ).toBeInTheDocument();
  });
});

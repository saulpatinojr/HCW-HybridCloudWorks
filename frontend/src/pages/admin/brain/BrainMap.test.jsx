import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useReducedMotion } from 'framer-motion';
import BrainMap from './BrainMap';
vi.mock('framer-motion', () => ({ useReducedMotion: vi.fn() }));
const nodes = [
  { id: 'a', title: 'Docker release', type: 'note', tags: ['docker'] },
  { id: 'b', title: 'Pipeline research', type: 'reference', tags: ['docker'] },
  { id: 'c', title: 'Unrelated Azure', type: 'reference', tags: [] },
];
const edges = [{ from: 'a', to: 'b', kind: 'explicit' }];
beforeEach(() => useReducedMotion.mockReturnValue(true));
describe('interactive map', () => {
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

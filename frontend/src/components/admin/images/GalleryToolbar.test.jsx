import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GalleryToolbar from './GalleryToolbar';

// The state chips filter the one gallery below them, so they are toggle
// buttons in a group, not tabs: there is no separate panel for each.
describe('GalleryToolbar state chips', () => {
  const renderToolbar = (onChange = vi.fn()) =>
    render(
      <GalleryToolbar
        filters={{ state: 'active' }}
        onChange={onChange}
        facets={{ counts: { active: 3 } }}
        folders={[]}
        providerValues={[]}
        slotValues={[]}
        tagValues={[]}
        loading={false}
        onRefresh={() => {}}
      />
    );

  it('are a labelled group of toggle buttons, not tabs', () => {
    renderToolbar();
    expect(screen.getByRole('group', { name: 'Image state' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('button', { name: /Active/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Archived/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('switch the filter when pressed', () => {
    const onChange = vi.fn();
    renderToolbar(onChange);
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'trash', offset: 0 }));
  });
});

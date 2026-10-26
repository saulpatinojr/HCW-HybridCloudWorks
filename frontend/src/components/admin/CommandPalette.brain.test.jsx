import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CommandPalette from './CommandPalette';
import { brainApi } from '@/lib/brainApi';
import { listContentItems } from '@/lib/api';
vi.mock('@/hooks/useBrainAccess', () => ({ useBrainAccess: () => ({ enabled: true }) }));
vi.mock('@/hooks/useAdminRole', () => ({ useAdminRole: () => 'editor' }));
vi.mock('@/lib/brainApi', () => ({ brainApi: { search: vi.fn() } }));
vi.mock('@/lib/api', () => ({ listContentItems: vi.fn() }));
describe('private owner command-palette search', () => {
  it('uses the private search for notes and creator content without forwarding keywords to the legacy GET search', async () => {
    brainApi.search.mockResolvedValue({
      items: [
        { id: 'note-private', type: 'note', title: 'Confidential idea' },
        {
          id: 'ref_article',
          type: 'reference',
          title: 'Related article',
          href: '/admin/editor/article',
        },
      ],
    });
    render(
      <MemoryRouter>
        <CommandPalette debounceMs={1} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search pages and content' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search pages and content' }), {
      target: { value: 'Confidential' },
    });
    expect(await screen.findByRole('option', { name: /Confidential idea/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Related article/ })).toBeInTheDocument();
    expect(brainApi.search).toHaveBeenCalledWith({ q: 'Confidential' });
    expect(listContentItems).not.toHaveBeenCalled();
  });
});

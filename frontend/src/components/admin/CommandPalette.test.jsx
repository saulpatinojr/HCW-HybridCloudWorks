/**
 * The admin command palette (AP-F13, #937). What must hold: Ctrl-K, Cmd-K
 * and the button open a labelled dialog with focus in the search box; typing
 * filters the registry pages; the arrow keys move the highlight and Enter
 * opens it; the content search asks the API once per pause in typing and its
 * results open the editor; Escape closes.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CommandPalette, {
  CONTENT_SEARCH_LIMIT,
  CONTENT_SEARCH_MAX_LENGTH,
  canSearchContent,
  filterPages,
  pagesFor,
} from './CommandPalette';
import { NAV_ITEMS, visibleNavFor } from '@/config/adminNav';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const listContentItems = vi.fn();
vi.mock('@/lib/api', () => ({ listContentItems: (...args) => listContentItems(...args) }));

/** The router's current path, printed so a test can read where Enter or a click went. */
function Probe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{pathname}</output>;
}

/** The palette under `role`, as AdminLayout mounts it inside the guard's role provider. */
function renderPalette(role = 'super_admin') {
  return render(
    <AdminRoleProvider value={role}>
      <MemoryRouter initialEntries={['/admin/labs']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <CommandPalette debounceMs={30} />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AdminRoleProvider>
  );
}

/** K with a modifier, pressed on the window, where the palette listens. */
const pressShortcut = (modifier = { ctrlKey: true }) =>
  fireEvent.keyDown(window, { key: 'k', ...modifier });
/** The palette's search box, by its accessible name. */
const input = () => screen.getByRole('combobox', { name: 'Search pages and content' });
/** Every option in the palette's listbox, in order. */
const options = () => within(screen.getByRole('listbox')).getAllByRole('option');
/** Set what the search box holds, as typing it would. */
const type = (value) => fireEvent.change(input(), { target: { value } });

beforeEach(() => {
  listContentItems.mockReset();
  listContentItems.mockResolvedValue([]);
});

describe('filterPages', () => {
  it('matches every typed word against the label, description and group', () => {
    expect(filterPages('').length).toBe(NAV_ITEMS.length);
    expect(filterPages('image gallery').map((i) => i.label)).toEqual(['Image Gallery']);
    // Social Hub's description also says "live pages": a description match
    // is a match, so a page is findable by what it does, not only its name.
    expect(filterPages('live pages').map((i) => i.label)).toEqual(['Live Pages', 'Social Hub']);
    expect(filterPages('pipeline').length).toBeGreaterThan(3);
    expect(filterPages('zzzz')).toEqual([]);
  });
});

describe('CommandPalette', () => {
  it('opens on Ctrl-K and Cmd-K, from the button, as a labelled dialog with focus in the box', async () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    pressShortcut({ ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Go to a page or open content' });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(input()).toHaveFocus());
    expect(input()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    pressShortcut({ ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    pressShortcut({ metaKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Search pages and content' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('lists every registry page until something is typed, then filters them', async () => {
    renderPalette();
    pressShortcut();
    await screen.findByRole('dialog');
    expect(options()).toHaveLength(NAV_ITEMS.filter((i) => !i.requiresBrain).length);

    type('live');
    const shown = options().map((o) => o.textContent);
    expect(shown.some((text) => text.startsWith('Live Pages'))).toBe(true);
    expect(shown.some((text) => text.startsWith('Dashboard'))).toBe(false);
  });

  it('moves the highlight with the arrow keys and opens the page on Enter', async () => {
    renderPalette();
    pressShortcut();
    await screen.findByRole('dialog');

    // Four hubs, in registry order: Newsletter, Social, Linkie, Recording.
    type('hub');
    expect(options().length).toBeGreaterThan(1);
    expect(options()[0]).toHaveTextContent('Newsletter Hub');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id);

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'false');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[1].id);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/newsletter-hub');
  });

  it('asks the API once per pause in typing, never for one character, and opens a result in the editor', async () => {
    listContentItems.mockResolvedValue([
      {
        id: 'c 1',
        Title: 'Azure networking, explained',
        'Cloud Provider': 'Azure',
        contentStatus: 'published',
      },
    ]);
    renderPalette();
    pressShortcut();
    await screen.findByRole('dialog');

    type('a');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(listContentItems).not.toHaveBeenCalled();

    type('az');
    type('azu');
    type('azur');
    const result = await screen.findByRole('option', { name: /Azure networking, explained/ });
    expect(listContentItems).toHaveBeenCalledTimes(1);
    expect(listContentItems).toHaveBeenCalledWith({ search: 'azur', limit: CONTENT_SEARCH_LIMIT });
    expect(result).toHaveTextContent('Azure · published');
    expect(result).toHaveTextContent('Content');

    fireEvent.click(result);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/editor/c%201');
  });

  it('says when no content matches, and shows a refusal rather than an empty list', async () => {
    renderPalette();
    pressShortcut();
    await screen.findByRole('dialog');

    type('nothing');
    // The line reads "Searching content…" until the answer lands.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No content is titled like that.')
    );

    listContentItems.mockRejectedValue(new Error('HTTP 503'));
    type('nothing at all');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('HTTP 503'));
  });

  it('asks the API only for 2 to 100 trimmed characters, and says so past the limit', async () => {
    // The list route answers 400 for a trimmed term over 100 characters
    // (cms-content.js LIST_SEARCH_MAX_CHARS, #1184); the palette never sends
    // one, and says why there are no content results instead.
    expect(CONTENT_SEARCH_MAX_LENGTH).toBe(100);
    renderPalette();
    pressShortcut();
    await screen.findByRole('dialog');

    type(`  ${'a'.repeat(101)}  `);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Content search takes up to 100 characters; shorten it to search content.'
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(listContentItems).not.toHaveBeenCalled();

    // Exactly 100 once trimmed, padding and all: asked, with the trimmed term.
    const hundred = 'b'.repeat(100);
    type(`   ${hundred}   `);
    await waitFor(() => expect(listContentItems).toHaveBeenCalledTimes(1));
    expect(listContentItems).toHaveBeenCalledWith({ search: hundred, limit: CONTENT_SEARCH_LIMIT });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No content is titled like that.')
    );

    // One trimmed character is below the floor, padded or not.
    listContentItems.mockClear();
    type('   c   ');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(listContentItems).not.toHaveBeenCalled();
  });

  /**
   * The palette is cut to the role the way the menu is (AP-F4, #928): it is
   * not a way round the menu to a page the server refuses the role.
   */
  it('lists a viewer the menu’s pages only, and never asks the content search', async () => {
    expect(pagesFor('viewer').map((i) => i.label)).toEqual(['Dashboard', 'Health']);
    expect(canSearchContent('viewer')).toBe(false);
    renderPalette('viewer');
    pressShortcut();
    await screen.findByRole('dialog');

    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^Dashboard/),
      expect.stringMatching(/^Health/),
    ]);
    expect(input()).toHaveAttribute('placeholder', 'Go to a page…');
    type('azure');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(listContentItems).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('No page matches.');
  });

  it('lists an editor every page but Publish, and searches content for it', async () => {
    expect(canSearchContent('editor')).toBe(true);
    renderPalette('editor');
    pressShortcut();
    await screen.findByRole('dialog');

    const editorPages = visibleNavFor('editor').flatMap((g) => g.items);
    expect(options()).toHaveLength(editorPages.length);
    type('publish');
    expect(options().map((o) => o.textContent)).not.toContainEqual(
      expect.stringMatching(/^Publish/)
    );
    await waitFor(() => expect(listContentItems).toHaveBeenCalledTimes(1));
  });

  it('reads a missing role as the viewer’s, as the menu does', () => {
    expect(pagesFor(null)).toEqual(pagesFor('viewer'));
    expect(canSearchContent(null)).toBe(false);
  });

  it('forgets the query when closed, so the next opening lists every page', async () => {
    renderPalette();
    pressShortcut();
    await screen.findByRole('dialog');
    type('live');
    expect(options().length).toBeLessThan(NAV_ITEMS.length);

    pressShortcut();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    pressShortcut();
    await screen.findByRole('dialog');
    expect(input()).toHaveValue('');
    expect(options()).toHaveLength(NAV_ITEMS.filter((i) => !i.requiresBrain).length);
  });
});

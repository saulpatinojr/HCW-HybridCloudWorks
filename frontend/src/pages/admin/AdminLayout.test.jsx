/**
 * The sidebar is the navigation registry (config/adminNav.js, ADR 0033 §3):
 * the groups a first-time user can read, the order the work happens in, and
 * one sentence per item shown on hover. These tests pin the decisions the
 * owner made on 2026-10-03, so the next edit to the array is a visible one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@/lib/api', () => ({
  postJSON: vi.fn(),
}));

import { postJSON } from '@/lib/api';
import { AdminRoleProvider } from '@/hooks/useAdminRole';
import AdminLayout, { NAV_GROUPS } from './AdminLayout';

const group = (label) => NAV_GROUPS.find((g) => g.label === label);

describe('the navigation registry', () => {
  it('has the seven groups, in the order the owner chose', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Home',
      'Pipeline',
      'Enhanced',
      'Creative',
      'Amplify',
      'Spotlight',
      'Platform',
    ]);
  });

  it('runs the Pipeline in the order the work happens, ending at Live Pages', () => {
    expect(group('Pipeline').items.map((i) => i.label)).toEqual([
      'New Content',
      'Drafts',
      'Review Queue',
      'Editor',
      'Publish',
      'Live Pages',
    ]);
  });

  it('replaces the generic Content group with Enhanced, holding Listen & Learn and Labs', () => {
    expect(group('Content')).toBeUndefined();
    const labels = group('Enhanced').items.map((i) => i.label);
    expect(labels).toContain('Listen & Learn');
    expect(labels).toContain('Labs');
    expect(labels).toContain('Frameworks');
    expect(labels).toContain('Coder Corner');
  });

  it('keeps Labs and Listen & Learn out of Platform and Spotlight', () => {
    expect(group('Platform').items.map((i) => i.label)).toEqual([
      'Platform Settings',
      'Health',
      'Integrations',
    ]);
    expect(group('Spotlight').items.map((i) => i.label)).toEqual([
      'Speaking',
      'Certifications',
      'Ambassador',
    ]);
  });

  it('names the two image pages so their relationship is in the names', () => {
    const labels = group('Creative').items.map((i) => i.label);
    expect(labels).toContain('Image Prompts');
    expect(labels).toContain('Image Gallery');
    expect(labels).not.toContain('Prompts');
  });

  it('gives every group and every item a one-sentence description', () => {
    for (const g of NAV_GROUPS) {
      expect(g.description.length, g.label).toBeGreaterThan(20);
      for (const item of g.items) {
        expect(item.description.length, item.label).toBeGreaterThan(20);
        expect(item.to, item.label).toMatch(/^\/admin/);
        expect(item.icon, item.label).toBeTypeOf('object');
      }
    }
  });

  it('declares no text tag on any menu item (#566)', () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
      expect(item, item.label).not.toHaveProperty('pill');
    }
  });

  it('no longer offers the routes that were merged away', () => {
    const everyRoute = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    for (const retired of [
      '/admin/ops-health',
      '/admin/diagnostics',
      '/admin/connections',
      '/admin/api-keys',
    ]) {
      expect(everyRoute).not.toContain(retired);
    }
    expect(new Set(everyRoute).size).toBe(everyRoute.length);
  });
});

/**
 * The rendered sidebar (#566): the live badges, the brand readable, the
 * sidebar pinned, one main landmark, and the descriptions on hover.
 */
describe('the admin sidebar', () => {
  let stored;

  beforeEach(() => {
    stored = { 'contentforge-sidebar-collapsed': 'false' };
    vi.stubGlobal('localStorage', {
      getItem: (key) => (key in stored ? stored[key] : null),
      setItem: (key, value) => {
        stored[key] = String(value);
      },
    });
    postJSON.mockResolvedValue({
      stats: {
        blog: { needsReview: 2, inProgress: 1, published: 5 },
        news: { needsReview: 1 },
        framework: { inProgress: 3, published: 2 },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The role is what AdminAuthGuard provides in the app (AP-F4); the whole
  // menu is the owner's view, so these tests see it as a super_admin.
  function renderAdmin(path = '/admin/labs', role = 'super_admin') {
    return render(
      <AdminRoleProvider value={role}>
        <main id="main-content" tabIndex={-1}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route path="labs" element={<h1>Labs page</h1>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </main>
      </AdminRoleProvider>
    );
  }

  it('renders none of the retired tags', async () => {
    renderAdmin();
    const nav = screen.getByRole('navigation', { name: 'ContentForge' });
    await screen.findByText('3');
    for (const tag of ['New', 'Podcast', 'Publer', 'Linkie', 'Resend', 'VPS']) {
      expect(within(nav).queryByText(tag)).not.toBeInTheDocument();
    }
  });

  it('keeps the live count badges for the review queue, the editor and live pages', async () => {
    renderAdmin();
    // queue = 2 + 1 needing review; editor = 1 + 3 in progress; live = 5 + 2.
    const queue = screen.getByRole('link', { name: /^Review Queue/ });
    const editor = screen.getByRole('link', { name: 'Editor' });
    const live = screen.getByRole('link', { name: 'Live Pages' });
    expect(await within(queue).findByText('3')).toBeInTheDocument();
    expect(within(editor).getByText('4')).toBeInTheDocument();
    expect(within(live).getByText('7')).toBeInTheDocument();
  });

  it('keeps the badge on the collapsed icon rail', async () => {
    stored['contentforge-sidebar-collapsed'] = 'true';
    renderAdmin();
    const queue = screen.getByRole('link', { name: /^Review Queue/ });
    expect(await within(queue).findByText('3')).toBeInTheDocument();
  });

  it('explains every item on hover with the registry sentence', () => {
    renderAdmin();
    const queue = screen.getByRole('link', { name: /^Review Queue/ });
    expect(queue).toHaveAttribute('title', group('Pipeline').items[2].description);
    const labs = screen.getByRole('link', { name: 'Labs' });
    expect(labs.getAttribute('title')).toMatch(/learning environments/i);
  });

  it('shows both lines of the brand, with room for them', () => {
    const { container } = renderAdmin();
    // Scoped to the rail: the phone top bar carries the brand too (AP-F1).
    const aside = within(container.querySelector('aside'));
    const title = aside.getByText('ContentForge');
    expect(aside.getByText('Influencer CMS')).toBeInTheDocument();
    expect(title.className).not.toContain('leading-none');
    expect(title.parentElement.parentElement.className).not.toMatch(/(^|\s)h-14(\s|$)/);
  });

  it('labels the newsletter page Newsletter Hub', () => {
    renderAdmin();
    const link = screen.getByRole('link', { name: 'Newsletter Hub' });
    expect(link).toHaveAttribute('href', '/admin/mailing-list');
    expect(screen.queryByText('Mailing List')).not.toBeInTheDocument();
  });

  it('pins the sidebar and scrolls the content column instead of the window', () => {
    const { container } = renderAdmin();
    const aside = container.querySelector('aside');
    expect(aside.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(aside.className).toMatch(/(^|\s)top-0(\s|$)/);
    expect(aside.className).toMatch(/(^|\s)h-dvh(\s|$)/);
    expect(screen.getByRole('navigation', { name: 'ContentForge' }).className).toContain(
      'overflow-y-auto'
    );
    const shell = aside.parentElement;
    expect(shell.className).toMatch(/(^|\s)h-dvh(\s|$)/);
    expect(shell.className).toContain('overflow-hidden');
    const content = container.querySelector('#admin-main');
    expect(content.className).toContain('overflow-y-auto');
    expect(within(content).getByText('Labs page')).toBeInTheDocument();
  });

  it('leaves exactly one main landmark on an admin route', () => {
    renderAdmin();
    const mains = screen.getAllByRole('main');
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveAttribute('id', 'main-content');
  });

  it('folds the live count into the link name, so a screen reader hears it and the badge is decoration (AP-F2)', async () => {
    renderAdmin();
    const queue = await screen.findByRole('link', { name: 'Review Queue, 3 waiting' });
    expect(within(queue).getByText('3')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: 'Labs' })).toBeInTheDocument();
  });

  it('shows a collapsed item its label on hover and on focus, under the name it announces (AP-F2)', async () => {
    stored['contentforge-sidebar-collapsed'] = 'true';
    const { container } = renderAdmin();
    const rail = within(container.querySelector('aside'));
    const queue = await rail.findByRole('link', { name: 'Review Queue, 3 waiting' });

    // Icon only until asked, and the label is no longer hidden in a title,
    // which a touch or keyboard user never sees.
    expect(within(queue).queryByText('Review Queue')).not.toBeInTheDocument();
    expect(queue.getAttribute('title')).not.toContain('Review Queue');

    // Hover: a visible label, whose text is where the link's name starts.
    fireEvent.mouseEnter(queue);
    const label = within(queue).getByText('Review Queue');
    expect(label).toBeVisible();
    expect(queue).toHaveAccessibleName(new RegExp(`^${label.textContent}`));
    // Fixed, so the nav's scroll container cannot clip it at the rail's edge.
    expect(label.closest('[data-rail-label]').className).toMatch(/(^|\s)fixed(\s|$)/);
    fireEvent.mouseLeave(queue);
    expect(within(queue).queryByText('Review Queue')).not.toBeInTheDocument();

    // Focus: the same label, for a keyboard; Escape dismisses it in place.
    act(() => queue.focus());
    expect(within(queue).getByText('Review Queue')).toBeVisible();
    fireEvent.keyDown(queue, { key: 'Escape' });
    expect(within(queue).queryByText('Review Queue')).not.toBeInTheDocument();
    expect(queue).toHaveFocus();
    act(() => queue.blur());

    // The footer's icon-only controls get the same treatment.
    const signOut = rail.getByRole('button', { name: 'Sign Out' });
    fireEvent.mouseEnter(signOut);
    expect(within(signOut).getByText('Sign Out')).toBeVisible();
  });

  it('adds no hover label to the expanded rail, where the label is already text', async () => {
    const { container } = renderAdmin();
    const queue = await within(container.querySelector('aside')).findByRole('link', {
      name: 'Review Queue, 3 waiting',
    });
    fireEvent.mouseEnter(queue);
    act(() => queue.focus());
    expect(container.querySelector('[data-rail-label]')).toBeNull();
    expect(within(queue).getAllByText('Review Queue')).toHaveLength(1);
  });

  it('sets a document title for every admin route from the registry (AP-F3)', () => {
    document.title = 'HybridCloudWorks';
    renderAdmin('/admin/labs');
    expect(document.title).toBe('Labs · ContentForge');
  });

  /**
   * Role gating (AP-F4, #928): the menu is the registry cut to the role the
   * guard verified, and the role is printed under the brand. The server still
   * refuses on its own; this is the viewer not learning that from a 403.
   */
  describe('cut to the signed-in role (AP-F4)', () => {
    const rail = () => within(screen.getByRole('navigation', { name: 'ContentForge' }));

    it('shows a viewer the Dashboard and Health, and none of Publish, Integrations or Platform Settings', () => {
      const { container } = renderAdmin('/admin/labs', 'viewer');
      const nav = rail();
      expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/admin');
      expect(nav.getByRole('link', { name: 'Health' })).toHaveAttribute('href', '/admin/health');
      for (const hidden of [
        /^Publish/,
        /^Integrations/,
        /^Platform Settings/,
        /^Review Queue/,
        /^Editor/,
        /^Labs/,
      ]) {
        expect(nav.queryByRole('link', { name: hidden })).not.toBeInTheDocument();
      }
      // A group with nothing left in it is not drawn as a bare heading.
      for (const heading of ['Pipeline', 'Enhanced', 'Creative', 'Amplify', 'Spotlight']) {
        expect(nav.queryByText(heading)).not.toBeInTheDocument();
      }
      expect(nav.getByText('Platform')).toBeInTheDocument();
      expect(
        within(container.querySelector('aside')).getByText('Your role: Viewer')
      ).toBeInTheDocument();
    });

    it('shows a publisher the Publish, Integrations and Platform Settings items', async () => {
      const { container } = renderAdmin('/admin/labs', 'publisher');
      const nav = rail();
      expect(await nav.findByRole('link', { name: /^Publish/ })).toHaveAttribute(
        'href',
        '/admin/published'
      );
      expect(nav.getByRole('link', { name: 'Integrations' })).toBeInTheDocument();
      expect(nav.getByRole('link', { name: 'Platform Settings' })).toBeInTheDocument();
      expect(nav.getAllByRole('link')).toHaveLength(NAV_GROUPS.flatMap((g) => g.items).length);
      expect(
        within(container.querySelector('aside')).getByText('Your role: Publisher')
      ).toBeInTheDocument();
    });

    it('shows an editor everything but Publish', () => {
      renderAdmin('/admin/labs', 'editor');
      const nav = rail();
      expect(nav.queryByRole('link', { name: /^Publish/ })).not.toBeInTheDocument();
      expect(nav.getByRole('link', { name: 'Integrations' })).toBeInTheDocument();
      expect(nav.getByRole('link', { name: /^Review Queue/ })).toBeInTheDocument();
      expect(nav.getAllByRole('link')).toHaveLength(NAV_GROUPS.flatMap((g) => g.items).length - 1);
    });

    it('shows the viewer menu, and no role line, when no role has been provided', () => {
      const { container } = renderAdmin('/admin/labs', null);
      const nav = rail();
      expect(nav.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        '/admin',
        '/admin/health',
      ]);
      expect(within(container.querySelector('aside')).queryByText(/Your role/)).toBeNull();
    });
  });
});

/**
 * The phone shell (estate review 2026-10-06, AP-F1): below `md` the rail is
 * not rendered; a top bar carries a menu button that opens a drawer with every
 * label visible, and the drawer closes on navigation.
 */
describe('the phone drawer', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    postJSON.mockResolvedValue({ stats: { blog: { needsReview: 2 } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderShell(role = 'super_admin') {
    return render(
      <AdminRoleProvider value={role}>
        <main id="main-content" tabIndex={-1}>
          <MemoryRouter initialEntries={['/admin/labs']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route path="labs" element={<h1>Labs page</h1>} />
                <Route path="queue" element={<h1>Queue page</h1>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </main>
      </AdminRoleProvider>
    );
  }

  it('hides the rail below md and offers a menu button in a top bar', () => {
    const { container } = renderShell();
    const aside = container.querySelector('aside');
    expect(aside.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(aside.className).toMatch(/(^|\s)md:flex(\s|$)/);
    const bar = screen.getByRole('button', { name: 'Open menu' }).closest('div');
    expect(bar.className).toMatch(/(^|\s)md:hidden(\s|$)/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a labelled drawer with every item readable, and closes it when an item is chosen', async () => {
    const { findByRole, getByRole, queryByRole } = screen;
    renderShell();
    getByRole('button', { name: 'Open menu' }).click();
    const drawer = await findByRole('dialog');
    const menu = within(drawer).getByRole('navigation', { name: 'ContentForge menu' });
    // Labels are text in the drawer, not tooltips: a phone has no hover.
    expect(within(menu).getByText('Review Queue')).toBeInTheDocument();
    expect(within(menu).getByText('Platform Settings')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Sign Out' })).toBeInTheDocument();
    within(menu)
      .getByRole('link', { name: /Review Queue/ })
      .click();
    await screen.findByText('Queue page');
    await vi.waitFor(() => expect(queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cuts the drawer to the role too, and prints the role in its header (AP-F4)', async () => {
    renderShell('viewer');
    screen.getByRole('button', { name: 'Open menu' }).click();
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Your role: Viewer')).toBeInTheDocument();
    const menu = within(within(drawer).getByRole('navigation', { name: 'ContentForge menu' }));
    expect(menu.getByText('Health')).toBeInTheDocument();
    expect(menu.queryByText('Platform Settings')).not.toBeInTheDocument();
    expect(menu.queryByText('Review Queue')).not.toBeInTheDocument();
  });

  it('gives the content column phone padding and a wider desktop column than before', () => {
    const { container } = renderShell();
    const column = container.querySelector('#admin-main > div');
    expect(column.className).toContain('max-w-5xl');
    expect(column.className).toMatch(/(^|\s)p-4(\s|$)/);
    expect(column.className).toMatch(/(^|\s)md:p-6(\s|$)/);
  });
});

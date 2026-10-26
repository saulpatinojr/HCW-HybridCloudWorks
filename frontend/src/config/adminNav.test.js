import { describe, it, expect } from 'vitest';
import {
  NAV_GROUPS,
  NAV_ITEMS,
  ROLE_NAMES,
  labelSlug,
  navGroupFor,
  navItemById,
  navItemFor,
  roleLabel,
  roleLevel,
  satisfiesRole,
  visibleNavFor,
} from './adminNav';

describe('navItemFor', () => {
  it('matches a route exactly, then by longest prefix, never the bare /admin for deeper paths', () => {
    expect(navItemFor('/admin').label).toBe('Dashboard');
    expect(navItemFor('/admin/review-queue').label).toBe('Review Queue');
    expect(navItemFor('/admin/review-queue/abc123').label).toBe('Review Queue');
    expect(navItemFor('/admin/editor/abc123').label).toBe('Editor');
    expect(navItemFor('/admin/ai-engine/docs/gemini').label).toBe('AI Engine');
    expect(navItemFor('/admin/nope')).toBeNull();
    expect(navItemFor('')).toBeNull();
  });

  it('does not read a renamed slug as a prefix of its old one', () => {
    // /admin/platform-settings must not resolve through /admin/platform (the
    // old slug, now a redirect) and the reverse; only an exact match or a
    // deeper path under the item counts.
    expect(navItemFor('/admin/platform')).toBeNull();
    expect(navItemFor('/admin/platform-settings').label).toBe('Platform Settings');
  });
});

/**
 * The finding (AP-F13, #937): the menu said "Publish", the address bar said
 * /admin/published, the heading said something else again. The route is the
 * label's slug, so the three cannot drift; the old slugs are redirects
 * (adminRedirects.test.jsx).
 */
describe('the route is the label', () => {
  it('slugs a label the way the routes are spelt', () => {
    expect(labelSlug('Review Queue')).toBe('review-queue');
    expect(labelSlug('Listen & Learn')).toBe('listen-and-learn');
    expect(labelSlug('Platform Settings')).toBe('platform-settings');
    expect(labelSlug('  Dashboard ')).toBe('dashboard');
  });

  it('routes every item at /admin/<slug of its label>', () => {
    for (const item of NAV_ITEMS) {
      const expected = item.label === 'Dashboard' ? '/admin' : `/admin/${labelSlug(item.label)}`;
      expect(item.to, item.label).toBe(expected);
    }
  });

  it('gives every item a unique id, the route segment, findable by navItemById', () => {
    const ids = NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(navItemById('dashboard').to).toBe('/admin');
    expect(navItemById('review-queue').label).toBe('Review Queue');
    expect(navItemById('newsletter-hub').to).toBe('/admin/newsletter-hub');
    expect(navItemById('queue')).toBeNull();
  });
});

describe('navGroupFor', () => {
  it('finds the group an item belongs to', () => {
    const labs = NAV_ITEMS.find((i) => i.label === 'Labs');
    expect(navGroupFor(labs).label).toBe('Enhanced');
    expect(navGroupFor({ to: '/x' })).toBeNull();
  });
});

describe('the registry', () => {
  it('is frozen so a page cannot rewrite the menu', () => {
    expect(Object.isFrozen(NAV_GROUPS)).toBe(true);
    expect(Object.isFrozen(NAV_ITEMS)).toBe(true);
  });
});

/**
 * Role gating (AP-F4, #928): every item names the lowest role the server
 * accepts on the routes it exists to call, and the menu is cut to it.
 */
describe('the role ladder', () => {
  it('is the server ladder, lowest first, and an unknown name sits below all of it', () => {
    expect(ROLE_NAMES).toEqual(['viewer', 'editor', 'publisher', 'super_admin']);
    expect(ROLE_NAMES.map(roleLevel)).toEqual([1, 2, 3, 4]);
    expect(roleLevel('PUBLISHER')).toBe(3);
    expect(roleLevel('publishor')).toBe(0);
    expect(roleLevel(null)).toBe(0);
  });

  it('satisfies a requirement at the role and above, never on an unknown requirement', () => {
    expect(satisfiesRole('editor', 'editor')).toBe(true);
    expect(satisfiesRole('super_admin', 'viewer')).toBe(true);
    expect(satisfiesRole('editor', 'publisher')).toBe(false);
    expect(satisfiesRole(null, 'viewer')).toBe(false);
    expect(satisfiesRole('super_admin', 'owner')).toBe(false);
  });

  it('prints a role the way the chrome shows it', () => {
    expect(roleLabel('super_admin')).toBe('Super admin');
    expect(roleLabel('viewer')).toBe('Viewer');
    expect(roleLabel('')).toBe('Unknown role');
  });
});

describe('minRole on every item', () => {
  it('names a role from the ladder on every item', () => {
    for (const item of NAV_ITEMS) {
      expect(ROLE_NAMES, item.label).toContain(item.minRole);
    }
  });

  it('reads the server: the Dashboard and Health are viewer reads, Publish is the publisher write, the rest is editor', () => {
    /** An item's role by its label, so the assertions read as the table above ITEMS does. */
    const roleOf = (label) => NAV_ITEMS.find((item) => item.label === label).minRole;
    expect(roleOf('Dashboard')).toBe('viewer');
    expect(roleOf('Health')).toBe('viewer');
    expect(roleOf('Publish')).toBe('publisher');
    for (const label of ['Review Queue', 'Live Pages', 'Integrations', 'Platform Settings']) {
      expect(roleOf(label), label).toBe('editor');
    }
    const rest = NAV_ITEMS.filter(
      (item) => !['Dashboard', 'Health', 'Publish'].includes(item.label)
    );
    expect(rest.every((item) => item.minRole === 'editor')).toBe(true);
  });
});

describe('visibleNavFor', () => {
  /** The labels `role` is shown, flat, so a case compares the whole menu in one line. */
  const labels = (role) => visibleNavFor(role).flatMap((group) => group.items.map((i) => i.label));
  /** The groups `role` is shown, so an empty group that was dropped shows up as a missing id. */
  const groupIds = (role) => visibleNavFor(role).map((group) => group.id);

  it('shows a viewer the Dashboard and Health only, with the empty groups dropped', () => {
    expect(labels('viewer')).toEqual(['Dashboard', 'Health']);
    expect(groupIds('viewer')).toEqual(['home', 'platform']);
  });

  it('shows an editor everything but Publish, in registry order', () => {
    const editor = labels('editor');
    expect(editor).not.toContain('Publish');
    expect(editor).toEqual(
      NAV_ITEMS.filter((i) => !i.requiresBrain)
        .map((i) => i.label)
        .filter((l) => l !== 'Publish')
    );
    expect(groupIds('editor')).toEqual(NAV_GROUPS.map((g) => g.id));
  });

  it('shows a publisher and a super_admin the whole registry', () => {
    expect(labels('publisher')).toEqual(
      NAV_ITEMS.filter((i) => !i.requiresBrain).map((i) => i.label)
    );
    expect(labels('super_admin')).toEqual(
      NAV_ITEMS.filter((i) => !i.requiresBrain).map((i) => i.label)
    );
  });

  it('treats an unknown or missing role as a viewer, never as more', () => {
    expect(labels('owner')).toEqual(labels('viewer'));
    expect(labels(null)).toEqual(labels('viewer'));
    expect(labels(undefined)).toEqual(labels('viewer'));
  });

  it('keeps the Dashboard for every role, first', () => {
    for (const role of [...ROLE_NAMES, null]) {
      expect(labels(role)[0], String(role)).toBe('Dashboard');
    }
  });

  it('hands back the registry items themselves, so navGroupFor still finds them', () => {
    const health = visibleNavFor('viewer')
      .flatMap((group) => group.items)
      .find((item) => item.label === 'Health');
    expect(navGroupFor(health).id).toBe('platform');
    expect(Object.isFrozen(NAV_GROUPS)).toBe(true);
  });
});

describe('owner-only Second Brain navigation', () => {
  it('requires a server-derived capability even for a super_admin', () => {
    expect(
      visibleNavFor('super_admin')
        .flatMap((g) => g.items)
        .some((i) => i.id === 'second-brain')
    ).toBe(false);
    expect(
      visibleNavFor('editor', { brain: true })
        .flatMap((g) => g.items)
        .some((i) => i.id === 'second-brain')
    ).toBe(true);
    expect(
      visibleNavFor('viewer', { brain: true })
        .flatMap((g) => g.items)
        .some((i) => i.id === 'second-brain')
    ).toBe(false);
  });
});

/**
 * Symmetrical Header navigation tests:
 * - Main landing page shows only the 9 provider links in `<nav aria-label="Primary">`,
 *   with no top-left logo image, no `Learn` or `Tools` caret dropdowns, no `9/9 Live`
 *   pill, and no `Providers` mega-menu pulldown.
 * - Every provider page uses the exact same `repeat(9, 100px)` 9-column grid:
 *   `Home`, `<Provider>`, `News`, `Blogs`, `<Architecture|Code>`,
 *   `<Podcast|FOCUS|Workflows|Modules|Sandboxes>`, `<Frameworks|Tools>`, `Learn`, `Labs`.
 *   `Labs` is left out, its slot empty, for a provider with no lab (#1613).
 * - `Learn` points directly to `/:provider/education` and `Labs` points directly to
 *   `/:provider/education/labs` without caret menus.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Header, { LEARN_MENU_ITEMS } from './Header';
import { providersWithLabs } from '@/data/labs/catalogue';
import { VALID_PROVIDERS } from '@/context/ProviderContext';

function renderAt(pathname) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Header />
    </MemoryRouter>
  );
}

const primaryNav = () => screen.getByRole('navigation', { name: 'Primary' });
const primaryLabels = () =>
  within(primaryNav())
    .getAllByRole('link')
    .map((link) => link.textContent.trim());
const primaryHrefs = () =>
  within(primaryNav())
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));

describe('Header symmetrical layout & decluttered chrome', () => {
  it('retains LEARN_MENU_ITEMS for mobile and cross-provider links', () => {
    expect(LEARN_MENU_ITEMS.map((item) => item.path)).toEqual(['/education', '/education/labs']);
  });

  it.each([
    '/',
    '/azure',
    '/aws',
    '/gcp',
    '/vmware',
    '/github',
    '/finops',
    '/terraform',
    '/docker',
    '/ansible',
  ])(
    'removes the top-left logo image, caret dropdowns, 9/9 Live pill, and Providers pulldown on %s',
    (pathname) => {
      renderAt(pathname);
      expect(screen.queryByAltText(/HybridCloudWorks logo/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /toggle learn menu/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /toggle tools menu/i })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /toggle providers menu/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /platform health/i })).not.toBeInTheDocument();
    }
  );

  it.each([
    '/',
    '/azure',
    '/aws',
    '/gcp',
    '/vmware',
    '/github',
    '/finops',
    '/terraform',
    '/docker',
    '/ansible',
  ])(
    'uses an identical repeat(9, 100px) primary grid on %s so every navbar lines up pixel-for-pixel',
    (pathname) => {
      renderAt(pathname);
      expect(primaryNav().style.gridTemplateColumns).toBe('repeat(9, 100px)');
      // Nine links, except on a hub with no lab, whose Labs slot is empty (#1613).
      const provider = pathname.slice(1);
      const expected = provider && !providersWithLabs().includes(provider) ? 8 : 9;
      expect(within(primaryNav()).getAllByRole('link')).toHaveLength(expected);
    }
  );

  it('lists the 9 providers on the main landing page in Primary nav', () => {
    renderAt('/');
    expect(primaryLabels()).toEqual([
      'Azure',
      'AWS',
      'Google Cloud',
      'VMware',
      'GitHub',
      'FinOps',
      'Terraform',
      'Docker',
      'Ansible',
    ]);
    expect(primaryHrefs()).toEqual([
      '/azure',
      '/aws',
      '/gcp',
      '/vmware',
      '/github',
      '/finops',
      '/terraform',
      '/docker',
      '/ansible',
    ]);
  });
});

describe('Header provider-specific direct Learn and Labs links', () => {
  it.each([
    [
      '/azure',
      ['Home', 'Azure', 'News', 'Blogs', 'Architecture', 'Podcast', 'Frameworks', 'Learn', 'Labs'],
      [
        '/',
        '/azure',
        '/azure/rss',
        '/azure/blog',
        '/azure/architecture-designs',
        '/azure/audio-architecture',
        '/azure/frameworks',
        '/azure/education',
        '/azure/education/labs',
      ],
    ],
    [
      '/aws',
      ['Home', 'AWS', 'News', 'Blogs', 'Architecture', 'Podcast', 'Frameworks', 'Learn', 'Labs'],
      [
        '/',
        '/aws',
        '/aws/rss',
        '/aws/blog',
        '/aws/architecture-designs',
        '/aws/audio-architecture',
        '/aws/frameworks',
        '/aws/education',
        '/aws/education/labs',
      ],
    ],
    [
      '/gcp',
      [
        'Home',
        'Google Cloud',
        'News',
        'Blogs',
        'Architecture',
        'Podcast',
        'Frameworks',
        'Learn',
        'Labs',
      ],
      [
        '/',
        '/gcp',
        '/gcp/rss',
        '/gcp/blog',
        '/gcp/architecture-designs',
        '/gcp/audio-architecture',
        '/gcp/frameworks',
        '/gcp/education',
        '/gcp/education/labs',
      ],
    ],
    [
      '/vmware',
      ['Home', 'VMware', 'News', 'Blogs', 'Architecture', 'Podcast', 'Frameworks', 'Learn', 'Labs'],
      [
        '/',
        '/vmware',
        '/vmware/rss',
        '/vmware/blog',
        '/vmware/architecture-designs',
        '/vmware/audio-architecture',
        '/vmware/frameworks',
        '/vmware/education',
        '/vmware/education/labs',
      ],
    ],
    // FinOps and GitHub have no lab, so no Labs link (#1613).
    [
      '/finops',
      ['Home', 'FinOps', 'News', 'Blogs', 'Architecture', 'FOCUS', 'Frameworks', 'Learn'],
      [
        '/',
        '/finops',
        '/finops/rss',
        '/finops/blog',
        '/finops/architecture-designs',
        '/finops/focus',
        '/finops/frameworks',
        '/finops/education',
      ],
    ],
    [
      '/github',
      ['Home', 'GitHub', 'News', 'Blogs', 'Code', 'Workflows', 'Tools', 'Learn'],
      [
        '/',
        '/github',
        '/github/rss',
        '/github/blog',
        '/github/code',
        '/github/workflows',
        '/github/tools',
        '/github/education',
      ],
    ],
    [
      '/terraform',
      ['Home', 'Terraform', 'News', 'Blogs', 'Code', 'Modules', 'Tools', 'Learn', 'Labs'],
      [
        '/',
        '/terraform',
        '/terraform/rss',
        '/terraform/blog',
        '/terraform/code',
        '/terraform/modules',
        '/terraform/tools',
        '/terraform/education',
        '/terraform/education/labs',
      ],
    ],
    [
      '/docker',
      ['Home', 'Docker', 'News', 'Blogs', 'Code', 'Sandboxes', 'Tools', 'Learn', 'Labs'],
      [
        '/',
        '/docker',
        '/docker/rss',
        '/docker/blog',
        '/docker/code',
        '/docker/sandboxes',
        '/docker/tools',
        '/docker/education',
        '/docker/education/labs',
      ],
    ],
    [
      '/ansible',
      ['Home', 'Ansible', 'News', 'Blogs', 'Code', 'Podcast', 'Tools', 'Learn', 'Labs'],
      [
        '/',
        '/ansible',
        '/ansible/rss',
        '/ansible/blog',
        '/ansible/code',
        '/ansible/audio-architecture',
        '/ansible/tools',
        '/ansible/education',
        '/ansible/education/labs',
      ],
    ],
  ])('renders the provider navigation on %s', (pathname, expectedLabels, expectedHrefs) => {
    renderAt(pathname);
    expect(primaryLabels()).toEqual(expectedLabels);
    expect(primaryHrefs()).toEqual(expectedHrefs);
  });

  it.each(['/docker/sandboxes', '/docker/building-images', '/docker/desktop'])(
    'keeps the Docker hub nav on %s, a static route outside the provider layout',
    (pathname) => {
      renderAt(pathname);
      expect(primaryLabels()).toEqual([
        'Home',
        'Docker',
        'News',
        'Blogs',
        'Code',
        'Sandboxes',
        'Tools',
        'Learn',
        'Labs',
      ]);
    }
  );

  it.each(VALID_PROVIDERS)(
    'shows Labs on /%s only when that provider has a labs page the site builds (#1613)',
    (provider) => {
      renderAt(`/${provider}`);
      const labs = within(primaryNav()).queryByRole('link', { name: 'Labs' });
      if (providersWithLabs().includes(provider)) {
        expect(labs).toHaveAttribute('href', `/${provider}/education/labs`);
      } else {
        expect(labs).toBeNull();
      }
    }
  );

  it('has providers without labs, so the hidden case above is exercised', () => {
    const without = VALID_PROVIDERS.filter((p) => !providersWithLabs().includes(p));
    expect([...without].sort()).toEqual(['finops', 'github']);
  });

  it('highlights Labs and not Learn when viewing a provider labs page', () => {
    renderAt('/azure/education/labs');
    const learnLink = within(primaryNav()).getByRole('link', { name: 'Learn' });
    const labsLink = within(primaryNav()).getByRole('link', { name: 'Labs' });
    expect(labsLink).toHaveAttribute('aria-current', 'page');
    expect(learnLink).not.toHaveAttribute('aria-current');
  });

  it('highlights Learn and not Labs when viewing a provider education page', () => {
    renderAt('/azure/education');
    const learnLink = within(primaryNav()).getByRole('link', { name: 'Learn' });
    const labsLink = within(primaryNav()).getByRole('link', { name: 'Labs' });
    expect(learnLink).toHaveAttribute('aria-current', 'page');
    expect(labsLink).not.toHaveAttribute('aria-current');
  });
});

describe('Header Search & Mobile Navigation', () => {
  it('renders the search trigger button and opens the CommandPalette dialog', () => {
    renderAt('/');
    const searchBtn = screen.getByRole('button', { name: /search site/i });
    expect(
      screen.queryByRole('dialog', { name: /command search palette/i })
    ).not.toBeInTheDocument();

    fireEvent.click(searchBtn);
    expect(screen.getByRole('dialog', { name: /command search palette/i })).toBeInTheDocument();
  });

  it('lets the mobile menu scroll and provides search trigger inside mobile navigation drawer', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle menu/i }));
    const mobile = screen.getByRole('navigation', { name: 'Mobile' });
    expect(mobile.className).toMatch(/overflow-y-auto/);
    expect(mobile.className).toMatch(/max-h-\[calc\(100dvh-4rem\)\]/);
    expect(within(mobile).getByRole('link', { name: 'Docker' })).toHaveAttribute('href', '/docker');

    const mobileSearchBtn = screen.getByRole('button', { name: /search blueprints, labs, certs/i });
    expect(mobileSearchBtn).toBeInTheDocument();

    fireEvent.click(mobileSearchBtn);
    expect(screen.getByRole('dialog', { name: /command search palette/i })).toBeInTheDocument();
  });
});

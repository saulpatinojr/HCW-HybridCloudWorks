/**
 * The header's Learn menu (#681): the two cross-provider Learn pages are
 * reachable from every hub, and the Tools menu still is. Until this menu
 * existed nothing in the header linked to `/education` at all.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Header, { LEARN_MENU_ITEMS } from './Header';

function renderAt(pathname) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Header />
    </MemoryRouter>
  );
}

describe('Header Learn menu', () => {
  it('names the index and the labs page', () => {
    expect(LEARN_MENU_ITEMS.map((item) => item.path)).toEqual(['/education', '/education/labs']);
  });

  it.each(['/', '/azure', '/terraform/tools', '/education/labs'])(
    'opens from %s and links both Learn pages',
    (pathname) => {
      renderAt(pathname);
      const button = screen.getByRole('button', { name: /toggle learn menu/i });
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('menu', { name: 'Learn' })).not.toBeInTheDocument();

      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      const menu = screen.getByRole('menu', { name: 'Learn' });
      expect(within(menu).getByRole('menuitem', { name: 'Learn any cloud' })).toHaveAttribute(
        'href',
        '/education'
      );
      expect(within(menu).getByRole('menuitem', { name: 'Browser labs' })).toHaveAttribute(
        'href',
        '/education/labs'
      );
    }
  );

  it('closes on Escape and returns focus to its button', () => {
    renderAt('/');
    const button = screen.getByRole('button', { name: /toggle learn menu/i });
    fireEvent.click(button);
    expect(screen.getByRole('menu', { name: 'Learn' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Learn' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes on a click outside', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle learn menu/i }));
    expect(screen.getByRole('menu', { name: 'Learn' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Learn' })).not.toBeInTheDocument();
  });

  it('keeps the Tools menu working beside it', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle tools menu/i }));
    const menu = screen.getByRole('menu', { name: 'Tools' });
    expect(within(menu).getByRole('menuitem', { name: 'Pricing Comparison' })).toHaveAttribute(
      'href',
      '/tools/comparison'
    );
    // Opening one menu does not open the other.
    expect(screen.queryByRole('menu', { name: 'Learn' })).not.toBeInTheDocument();
  });

  it('lists the Learn pages in the mobile menu too', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle menu/i }));
    const mobile = screen.getByRole('navigation', { name: 'Mobile' });
    expect(within(mobile).getByRole('link', { name: 'Browser labs' })).toHaveAttribute(
      'href',
      '/education/labs'
    );
    expect(within(mobile).getByRole('link', { name: 'Learn any cloud' })).toHaveAttribute(
      'href',
      '/education'
    );
  });
});

describe('Header provider links (Docker, 2026-09-28)', () => {
  const primaryLabels = () =>
    within(screen.getByRole('navigation', { name: 'Primary' }))
      .getAllByRole('link')
      .map((link) => link.textContent.trim());

  it('puts Docker between Terraform and Ansible on the all-providers list', () => {
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
    expect(screen.getByRole('link', { name: 'Docker' })).toHaveAttribute('href', '/docker');
  });

  it('shows the Docker hub its own pages, like Terraform with Sandboxes for Modules', () => {
    renderAt('/docker');
    expect(primaryLabels()).toEqual(['News', 'Blogs', 'Code', 'Sandboxes', 'Tools', 'Learning']);
    const hrefs = within(screen.getByRole('navigation', { name: 'Primary' }))
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/docker/rss',
      '/docker/blog',
      '/docker/code',
      '/docker/sandboxes',
      '/docker/tools',
      '/docker/education',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /toggle tools menu/i }));
    expect(
      within(screen.getByRole('menu', { name: 'Tools' })).getByRole('menuitem', {
        name: 'Docker Tools',
      })
    ).toHaveAttribute('href', '/docker/tools');
  });

  it.each(['/docker/sandboxes', '/docker/building-images', '/docker/desktop'])(
    'keeps the Docker hub nav on %s, a static route outside the provider layout',
    (pathname) => {
      // The header reads the provider from the path through parseRoute, which
      // knows only the page types in routeFactory's ROUTE_MAP. Without
      // `sandboxes`, `buildingImages` and `desktop` there (#774, #772, #773),
      // these pages would show the all-providers list.
      renderAt(pathname);
      expect(primaryLabels()).toEqual(['News', 'Blogs', 'Code', 'Sandboxes', 'Tools', 'Learning']);
    }
  );

  it('sizes the all-providers columns to their labels', () => {
    // The all-providers list does not fit fixed 90px columns beside the logo:
    // with eight providers it was 936px and squeezed the logo to zero width
    // at every desktop width; nine would be 1030px.
    renderAt('/');
    expect(screen.getByRole('navigation', { name: 'Primary' }).style.gridTemplateColumns).toBe(
      'repeat(11, max-content)'
    );
  });

  it('keeps 90px columns on a hub, so its links line up from one hub to the next', () => {
    renderAt('/terraform');
    expect(screen.getByRole('navigation', { name: 'Primary' }).style.gridTemplateColumns).toBe(
      'repeat(8, 90px)'
    );
  });

  it('lets the mobile menu scroll rather than run off a short screen', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle menu/i }));
    const mobile = screen.getByRole('navigation', { name: 'Mobile' });
    expect(mobile.className).toMatch(/overflow-y-auto/);
    expect(mobile.className).toMatch(/max-h-\[calc\(100dvh-4rem\)\]/);
    expect(within(mobile).getByRole('link', { name: 'Docker' })).toHaveAttribute('href', '/docker');
  });
});

describe('Header Global Navigation Enhancements (Stage 2 / Audit P1-1)', () => {
  it('renders the cloud status pill linking to platform health', () => {
    renderAt('/');
    const statusLink = screen.getByRole('link', { name: /platform health/i });
    expect(statusLink).toHaveAttribute('href', '/#platform-health');
    expect(statusLink).toHaveTextContent(/9\/9 live/i);
  });

  it('renders the search trigger button and opens the CommandPalette dialog', () => {
    renderAt('/');
    const searchBtn = screen.getByRole('button', { name: /search site/i });
    expect(
      screen.queryByRole('dialog', { name: /command search palette/i })
    ).not.toBeInTheDocument();

    fireEvent.click(searchBtn);
    expect(screen.getByRole('dialog', { name: /command search palette/i })).toBeInTheDocument();
  });

  it('renders the Providers mega-menu with 3-tier categorization and FOCUS 1.4', () => {
    renderAt('/');
    const megaMenuBtn = screen.getByRole('button', { name: /toggle providers menu/i });
    expect(megaMenuBtn).toBeInTheDocument();
    expect(screen.queryByTestId('providers-megamenu')).not.toBeInTheDocument();

    fireEvent.click(megaMenuBtn);
    const megaMenu = screen.getByTestId('providers-megamenu');
    expect(megaMenu).toBeInTheDocument();

    // 3 Tiers
    expect(within(megaMenu).getByText('Cloud Providers')).toBeInTheDocument();
    expect(within(megaMenu).getByText('Platform Providers')).toBeInTheDocument();
    expect(within(megaMenu).getByText('Service Providers')).toBeInTheDocument();

    // Providers in tiers
    expect(within(megaMenu).getByRole('link', { name: /aws/i })).toHaveAttribute('href', '/aws');
    expect(within(megaMenu).getByRole('link', { name: /azure/i })).toHaveAttribute(
      'href',
      '/azure'
    );
    expect(within(megaMenu).getByRole('link', { name: /google cloud/i })).toHaveAttribute(
      'href',
      '/gcp'
    );
    expect(within(megaMenu).getByRole('link', { name: /vmware/i })).toHaveAttribute(
      'href',
      '/vmware'
    );
    expect(within(megaMenu).getByRole('link', { name: /terraform/i })).toHaveAttribute(
      'href',
      '/terraform'
    );
    expect(within(megaMenu).getByRole('link', { name: /ansible/i })).toHaveAttribute(
      'href',
      '/ansible'
    );
    expect(within(megaMenu).getByRole('link', { name: /docker/i })).toHaveAttribute(
      'href',
      '/docker'
    );
    expect(within(megaMenu).getByRole('link', { name: /github/i })).toHaveAttribute(
      'href',
      '/github'
    );
    expect(within(megaMenu).getByRole('link', { name: /finops/i })).toHaveAttribute(
      'href',
      '/finops'
    );

    // FOCUS 1.4 badge in mega-menu
    expect(within(megaMenu).getByText('FOCUS 1.4')).toBeInTheDocument();
  });

  it('provides search trigger inside mobile navigation drawer', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle menu/i }));
    const mobileSearchBtn = screen.getByRole('button', { name: /search blueprints, labs, certs/i });
    expect(mobileSearchBtn).toBeInTheDocument();

    fireEvent.click(mobileSearchBtn);
    expect(screen.getByRole('dialog', { name: /command search palette/i })).toBeInTheDocument();
  });
});

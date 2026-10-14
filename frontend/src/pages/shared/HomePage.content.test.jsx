/**
 * Nothing on the home page is typed in and presented as measured
 * (2026-09-29). The stat row, the latest list, the blueprint carousel and the
 * health panel each read something real, and these tests hold each to its
 * source; homeContent.js says what the sources are.
 */
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));

const page = vi.hoisted(() => ({ current: null }));
vi.mock('@/lib/publicApi', () => ({
  fetchPublicContentPage: vi.fn(() => page.current()),
}));

// '' is a build with no API base, where the health panel never asks.
const base = vi.hoisted(() => ({ current: '' }));
vi.mock('@/lib/functionsBase', () => ({ getFunctionsBase: () => base.current }));

import { fetchPublicContentPage } from '@/lib/publicApi';
import { architecturesByProvider } from '@/data/architectures';
import {
  BLUEPRINTS_BY_PROVIDER,
  BLUEPRINT_COUNT,
  LATEST_LIMIT,
} from '@/components/home/homeContent';
import HomePage, { HEALTH_TIMESTAMP_CLASS, STATUS_SOURCES, getHealthBadgeClass } from './HomePage';

/** Two real rows, as `GET public/content` served them on 2026-09-29. */
const DOCS = [
  {
    id: 'a1',
    type: 'blog',
    Title: 'Ansible + Azure Arc: Use Ansible modules to deploy machine extensions',
    title: 'Ansible + Azure Arc',
    Summary: '<p>Deploy and manage Azure Arc machine extensions with Ansible.</p>',
    slug: 'ansible-azure-arc-use-ansible-modules',
    'Cloud Provider': 'Azure',
    'Published At': '2026-06-05T18:05:16.000Z',
    publishedAt: '2026-06-18T07:31:52.772Z',
  },
  {
    id: 'a2',
    type: 'architecture',
    title: 'Enterprise Hub-and-Spoke with Zero Trust Edge',
    summary: 'A production-grade Azure landing zone pattern.',
    slug: 'enterprise-hub-and-spoke-zero-trust-edge',
    cloudProvider: 'Azure',
  },
];

let fetchSpy;
beforeEach(() => {
  page.current = () => Promise.resolve({ items: DOCS, total: 24 });
  base.current = '';
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
});
afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

describe('the stat row', () => {
  it('counts the blueprints the architecture pages export, and the published articles', async () => {
    renderHome();
    const stats = screen.getByTestId('home-stats');
    const expected = Object.values(BLUEPRINTS_BY_PROVIDER).flat().length;
    expect(BLUEPRINT_COUNT).toBe(expected);
    expect(stats).toHaveTextContent(`${expected}Blueprints`);
    expect(await within(stats).findByText('24')).toBeInTheDocument();
    expect(stats).toHaveTextContent('Articles');
    expect(fetchPublicContentPage).toHaveBeenCalledWith({ limit: LATEST_LIMIT });
  });

  it('shows no modules or uptime figure, and no count with a "+" or "%" on it', () => {
    renderHome();
    const stats = screen.getByTestId('home-stats');
    expect(stats).not.toHaveTextContent(/modules|uptime/i);
    expect(stats.textContent).not.toMatch(/[+%]/);
    expect(document.body).not.toHaveTextContent('99.9');
  });

  it('holds the article tile open while it loads, and drops it when the count cannot be had', async () => {
    let fail;
    page.current = () => new Promise((_, reject) => (fail = reject));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHome();
    const stats = screen.getByTestId('home-stats');
    expect(stats).toHaveTextContent('…Articles');
    await act(async () => fail(new Error('offline')));
    expect(stats).not.toHaveTextContent('Articles');
    consoleError.mockRestore();
  });

  it('merchandises technical capability badges beneath the hero stat row (#Audit P0-5)', () => {
    renderHome();
    const badges = screen.getByTestId('capability-badges');
    expect(badges).toHaveTextContent('Terraform AVM Generator');
    expect(badges).toHaveTextContent('Ephemeral Container Labs');
    expect(badges).toHaveTextContent('FOCUS 1.4 FinOps');
  });
});

describe('Latest articles', () => {
  it('lists published items, each opening its own page, dated from the article', async () => {
    renderHome();
    const list = await screen.findByTestId('latest-articles');
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/azure/blog/ansible-azure-arc-use-ansible-modules',
      '/azure/architecture-designs/enterprise-hub-and-spoke-zero-trust-edge',
    ]);
    expect(links[0]).toHaveTextContent('Ansible + Azure Arc: Use Ansible modules');
    expect(links[0]).toHaveTextContent('Deploy and manage Azure Arc machine extensions');
    expect(links[0]).not.toHaveTextContent('<p>');
    expect(within(links[0]).getByText('Jun 5, 2026')).toHaveAttribute(
      'datetime',
      '2026-06-05T18:05:16.000Z'
    );
    expect(links[1]).toHaveTextContent('Azure :: Architecture');
  });

  it('carries none of the sample headlines, relative times or the invented 24-hour count', async () => {
    renderHome();
    await screen.findByTestId('latest-articles');
    expect(document.body).not.toHaveTextContent(/HRS AGO|DAYS? AGO|Last 24 Hours/i);
    expect(document.body).not.toHaveTextContent('Multi-Region Event Triggers');
    expect(document.body).not.toHaveTextContent('Latest from the providers');
  });

  it('says so, in a visitor’s words, when nothing is published or it cannot load', async () => {
    page.current = () => Promise.resolve({ items: [], total: 0 });
    const { unmount } = renderHome();
    expect(await screen.findByText(/Nothing has been published yet/)).toBeInTheDocument();
    unmount();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    page.current = () => Promise.reject(new Error('HTTP 500'));
    renderHome();
    expect(await screen.findByText(/could not be loaded just now/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('HTTP 500');
    consoleError.mockRestore();
  });

  it('differentiates Original Engineering Deep-Dives from Multi-Cloud Release Wire (#Audit P1-3)', async () => {
    renderHome();
    expect(
      await screen.findByRole('heading', { name: /Original Engineering Deep-Dives/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Engineering Deep-Dives & Release Wire/i })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Release Wire/i).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the blueprint carousel', () => {
  it('opens a page that exists for every card it can show', () => {
    vi.useFakeTimers();
    renderHome();
    const seen = new Set();
    for (let tick = 0; tick <= BLUEPRINT_COUNT; tick += 1) {
      const carousel = screen.getByTestId('blueprint-carousel');
      for (const link of within(carousel).getAllByRole('link')) {
        const href = link.getAttribute('href');
        seen.add(href);
        const [, provider, section, slug] = href.split('/');
        expect(section, href).toBe('architecture-designs');
        expect(Object.keys(BLUEPRINTS_BY_PROVIDER), href).toContain(provider);
        // A detail page is only linked where the detail template can fill it.
        if (slug) expect(architecturesByProvider[provider]?.[slug], href).toBeDefined();
      }
      act(() => vi.advanceTimersByTime(5000));
    }
    expect(document.body).not.toHaveTextContent('Snapshot');
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe('Platform Health', () => {
  it('names what it measures and links each provider’s own status page', () => {
    renderHome();
    const links = screen.getAllByRole('link');
    for (const source of STATUS_SOURCES) {
      const matching = links.filter((link) => link.getAttribute('href') === source.href);
      expect(matching, source.key).toHaveLength(1);
      expect(matching[0]).toHaveTextContent(source.label);
      expect(matching[0]).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(document.body).not.toHaveTextContent('GitHub Actions');
  });

  it.each([
    ['there is no API to ask', ''],
    ['the check fails', '/api'],
  ])('stops saying CHECKING once %s', async (_, apiBase) => {
    base.current = apiBase;
    renderHome();
    expect(await screen.findByText('Health check unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('CHECKING');
    expect(screen.getAllByText('UNKNOWN')).toHaveLength(STATUS_SOURCES.length);
    if (apiBase)
      expect(fetchSpy).toHaveBeenCalledWith('/api/public/platform-health', expect.anything());
  });

  it('dates a result by when the server checked, not when the page asked', async () => {
    base.current = '/api';
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          cached: true,
          statuses: {
            aws: 'OPERATIONAL',
            azure: 'OPERATIONAL',
            gcp: 'DEGRADED',
            github: 'OPERATIONAL',
          },
          checkedAt: '2026-09-29T08:05:00.000Z',
        }),
        { status: 200 }
      )
    );
    renderHome();
    const expected = new Date('2026-09-29T08:05:00.000Z').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(await screen.findByText(`Checked at ${expected}`)).toBeInTheDocument();
    expect(screen.getByText('DEGRADED')).toBeInTheDocument();
    expect(screen.getAllByText('OPERATIONAL')).toHaveLength(3);
  });

  it('prints its timestamp in the theme’s muted text token, never a fixed grey', () => {
    renderHome();
    const stamp = screen.getByTestId('health-checked-at');
    expect(stamp.className).toBe(HEALTH_TIMESTAMP_CLASS);
    expect(HEALTH_TIMESTAMP_CLASS).toContain('text-muted-foreground');
    expect(HEALTH_TIMESTAMP_CLASS).not.toMatch(/text-(?:slate|gray|zinc|neutral)-\d/);
  });

  it.each(['OPERATIONAL', 'DEGRADED', 'REGIONAL IMPACT'])(
    'writes a %s badge in the -800 shade in light mode, which holds AA on its tint',
    (status) => {
      // The -600 shades measured 3.41:1 and 3.03:1 under axe (2026-09-29).
      const lightText = getHealthBadgeClass(status)
        .split(/\s+/)
        .find((token) => /^text-(?:emerald|amber)-\d+$/.test(token));
      expect(lightText).toMatch(/-800$/);
    }
  );
});

describe('Capabilities Matrix (Audit P1-4 & P3-3)', () => {
  it('links all 4 provider architecture blueprints under Architectures', () => {
    renderHome();
    expect(screen.getByRole('link', { name: /Azure Architectures/i })).toHaveAttribute(
      'href',
      '/azure/architecture-designs'
    );
    expect(screen.getByRole('link', { name: /AWS Architectures/i })).toHaveAttribute(
      'href',
      '/aws/architecture-designs'
    );
    expect(
      screen.getByRole('link', { name: /Google Cloud \(GCP\) Architectures/i })
    ).toHaveAttribute('href', '/gcp/architecture-designs');
    expect(screen.getByRole('link', { name: /FinOps Architectures/i })).toHaveAttribute(
      'href',
      '/finops/architecture-designs'
    );
  });

  it('links all 7 learning hubs including Terraform, GitHub, VMware, and FOCUS 1.4 FinOps', () => {
    renderHome();
    expect(screen.getByRole('link', { name: /Azure Learning/i })).toHaveAttribute(
      'href',
      '/azure/education'
    );
    expect(screen.getByRole('link', { name: /AWS Learning/i })).toHaveAttribute(
      'href',
      '/aws/education'
    );
    expect(screen.getByRole('link', { name: /Google Cloud \(GCP\) Learning/i })).toHaveAttribute(
      'href',
      '/gcp/education'
    );
    expect(screen.getByRole('link', { name: /Terraform Learning/i })).toHaveAttribute(
      'href',
      '/terraform/education'
    );
    expect(screen.getByRole('link', { name: /GitHub Learning/i })).toHaveAttribute(
      'href',
      '/github/education'
    );
    expect(screen.getByRole('link', { name: /VMware Learning/i })).toHaveAttribute(
      'href',
      '/vmware/education'
    );
    expect(screen.getByRole('link', { name: /FinOps \(FOCUS 1\.4\) Learning/i })).toHaveAttribute(
      'href',
      '/finops/education'
    );
  });

  it('standardizes on Google Cloud (GCP) across all capability pillars', () => {
    renderHome();
    expect(screen.getByRole('link', { name: /Google Cloud \(GCP\) Frameworks/i })).toHaveAttribute(
      'href',
      '/gcp/frameworks'
    );
  });
});

describe('Interactive Workbench Showcase (Audit P1-2)', () => {
  it('mounts the flagship workbench showcase directly below the hero section', () => {
    renderHome();
    expect(screen.getByTestId('workbench-showcase')).toBeInTheDocument();
    expect(screen.getByTestId('workbench-card-landing-zone')).toBeInTheDocument();
    expect(screen.getByTestId('workbench-card-labs')).toBeInTheDocument();
  });
});

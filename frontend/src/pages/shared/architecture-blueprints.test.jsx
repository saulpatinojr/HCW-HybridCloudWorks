/**
 * Each architecture page renders the blueprints its sibling data module exports
 * (issue #373).
 *
 * WHY THIS SUITE EXISTS. The pre-render decides whether to advertise
 * `/<provider>/architecture-designs` by importing
 * `src/pages/<provider>/architecture-blueprints.js` and counting it
 * (`staticSectionItems` in scripts/prerender-routes.mjs). That count is only worth
 * acting on while the page renders the same array — a page that stopped
 * importing its module would keep its sitemap entry and show nothing, which is
 * the bug this whole mechanism exists to fix, restored by a refactor.
 *
 * The API is given nothing on purpose. What is left on the page is then exactly
 * the module's contribution, which is the half `manifest.sections` cannot see.
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

import AwsArchitecturePage from '@/pages/aws/ArchitecturePage';
import AzureArchitecturePage from '@/pages/azure/ArchitecturePage';
import FinOpsArchitecturePage from '@/pages/finops/ArchitecturePage';
import GcpArchitecturePage from '@/pages/gcp/ArchitecturePage';
import { staticBlueprints as awsBlueprints } from '@/pages/aws/architecture-blueprints';
import { staticBlueprints as azureBlueprints } from '@/pages/azure/architecture-blueprints';
import { staticBlueprints as finopsBlueprints } from '@/pages/finops/architecture-blueprints';
import { staticBlueprints as gcpBlueprints } from '@/pages/gcp/architecture-blueprints';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));

// The corpus held one architecture document on 2026-09-07 and none of these
// pages is empty, which is the whole reason an API count could not answer the
// question. Nothing is returned here so the answer is unambiguous.
vi.mock('@/hooks/usePublicData', () => ({
  usePublicData: () => ({ data: [], loading: false, error: null, refetch: () => {} }),
}));

vi.mock('@/lib/publicApi', () => ({
  fetchPublicContentList: () => Promise.resolve([]),
  PUBLIC_CORPUS_LIMIT: 250,
}));

// The AWS page wraps its grid in StaggerList, whose reveal hook constructs an
// IntersectionObserver that jsdom does not provide. Stubbed rather than mocking
// the animation component away, so these assertions run against the markup the
// page actually ships. The children are rendered either way — the observer only
// drives the entrance variant.
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
});

const PAGES = [
  ['aws', AwsArchitecturePage, awsBlueprints],
  ['azure', AzureArchitecturePage, azureBlueprints],
  ['finops', FinOpsArchitecturePage, finopsBlueprints],
  ['gcp', GcpArchitecturePage, gcpBlueprints],
];

/** The AWS page reads its provider from the path, so every page gets a real one. */
function renderAt(provider, Page) {
  return render(
    <MemoryRouter initialEntries={[`/${provider}/architecture-designs`]}>
      <Routes>
        <Route path="/:provider/architecture-designs" element={<Page />} />
      </Routes>
    </MemoryRouter>
  );
}

describe.each(PAGES)('the %s architecture page', (provider, Page, blueprints) => {
  it('renders every blueprint its data module exports', () => {
    renderAt(provider, Page);
    expect(blueprints.length).toBeGreaterThan(0);
    for (const { title } of blueprints) {
      // getAllByText with a string matches the WHOLE normalized text of an
      // element, so "Global Load Balancing" cannot be satisfied by a longer
      // title that merely starts with it. Not `toHaveLength(1)`: AWS and Azure
      // repeat the first blueprint in a featured panel above the grid.
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it('renders them in the order the module lists them', () => {
    renderAt(provider, Page);
    // FinOps and GCP hoist a `featured: true` blueprint above the grid. It is
    // the module's first entry in both, so document order and module order
    // agree — asserted rather than assumed, since a module reordered without
    // moving the flag would otherwise fail this with a confusing message.
    const featured = blueprints.findIndex((blueprint) => blueprint.featured);
    expect(featured).toBeLessThan(1);

    // First occurrence, for the same repeated-featured-panel reason.
    const rendered = blueprints.map(({ title }) => screen.getAllByText(title)[0]);
    for (let i = 1; i < rendered.length; i += 1) {
      const relation = rendered[i - 1].compareDocumentPosition(rendered[i]);
      expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

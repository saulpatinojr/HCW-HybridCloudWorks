/**
 * Every retired admin path still lands somewhere (AP-F13, #937): the eight
 * slugs renamed to their menu labels, and the five that were redirects
 * before them. What must hold is that the whole location survives — the
 * nested segment, the query and the hash — because the deep links the API
 * mails and the Decision Center builds are exactly the ones that moved.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_LEGACY_ROUTES, adminLegacyRoutes, legacyTarget } from './adminRedirects';
import { NAV_ITEMS } from './adminNav';

/** The location the router ends at, path, query and hash, printed for the assertions. */
function Probe() {
  const { pathname, search, hash } = useLocation();
  return <output data-testid="location">{`${pathname}${search}${hash}`}</output>;
}

/** Where the admin block sends `from`: the legacy routes, then a probe for whatever they land on. */
function landingFor(from) {
  render(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route path="/admin">
          {adminLegacyRoutes()}
          <Route path="*" element={<Probe />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  return screen.getByTestId('location').textContent;
}

describe('legacyTarget', () => {
  it('appends the rest of the path, the query and the hash', () => {
    expect(legacyTarget('/admin/review-queue', { rest: 'abc', search: '?source=content' })).toBe(
      '/admin/review-queue/abc?source=content'
    );
    expect(
      legacyTarget('/admin/platform-settings', { search: '?tab=audio', hash: '#voices' })
    ).toBe('/admin/platform-settings?tab=audio#voices');
    expect(legacyTarget('/admin/health')).toBe('/admin/health');
  });

  it('keeps a query the target already carries and adds the caller’s after it', () => {
    expect(legacyTarget('/admin/integrations?tab=keys', { search: '?group=ai' })).toBe(
      '/admin/integrations?tab=keys&group=ai'
    );
  });
});

describe('the admin redirects', () => {
  it.each(ADMIN_LEGACY_ROUTES.map(({ path, to }) => [path, to]))(
    '/admin/%s lands on %s',
    (path, to) => {
      expect(landingFor(`/admin/${path}`)).toBe(to);
    }
  );

  it('carries a nested id and its query through a renamed slug', () => {
    expect(landingFor('/admin/queue/abc123?source=content')).toBe(
      '/admin/review-queue/abc123?source=content'
    );
  });

  it.each([
    ['/admin/platform?tab=audio', '/admin/platform-settings?tab=audio'],
    ['/admin/mailing-list?tab=drafts&issue=i1', '/admin/newsletter-hub?tab=drafts&issue=i1'],
    ['/admin/social?tab=compose&contentId=c1', '/admin/social-hub?tab=compose&contentId=c1'],
  ])('carries the tab deep link %s through a renamed slug', (from, to) => {
    expect(landingFor(from)).toBe(to);
  });

  it('keeps every renamed slug as a redirect to a registry route', () => {
    const routes = new Set(NAV_ITEMS.map((item) => item.to));
    for (const { path, to } of ADMIN_LEGACY_ROUTES) {
      expect(routes.has(to.split('?')[0]), `${path} → ${to}`).toBe(true);
      expect(routes.has(`/admin/${path}`), `${path} is still a live route`).toBe(false);
    }
  });

  it('is mounted by App.jsx, which declares the route each redirect lands on', () => {
    // Read as text, the way App.routes.test.jsx reads the route table: the
    // failure is a declaration missing, which no render of this file can see.
    const source = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
    expect(source).toContain('{adminLegacyRoutes()}');
    const declared = new Set([...source.matchAll(/<Route\s+path="([^"]*)"/g)].map((m) => m[1]));
    for (const { to } of ADMIN_LEGACY_ROUTES) {
      const segment = to.split('?')[0].replace('/admin/', '');
      expect(declared.has(segment), `App.jsx declares ${segment}`).toBe(true);
    }
    for (const { path } of ADMIN_LEGACY_ROUTES) {
      expect(declared.has(path), `App.jsx no longer declares ${path} as a page`).toBe(false);
    }
  });
});

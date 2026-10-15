/**
 * The admin paths that used to exist, and where each one goes now.
 *
 * Every slug the registry (adminNav.js) has ever retired is kept alive here,
 * because a path outlives the menu that named it: it is in bookmarks, in the
 * Telegram and newsletter messages the API sent, in the browser history of
 * every device the owner signed in from. A retired path answers with a
 * redirect, never the not-found page.
 *
 * THE QUERY, THE HASH AND THE REST OF THE PATH TRAVEL WITH IT. The first
 * three redirects here were `<Navigate to="/admin/health" />` and dropped
 * `?tab=`, which was harmless for a page with one view. The slugs renamed
 * for AP-F13 (#937) are the deep-linked ones — `/admin/platform?tab=audio`
 * from an ElevenLabs refusal, `/admin/queue/<id>?source=content` from the
 * Decision Center — so `LegacyRedirect` rebuilds the whole location, and
 * each entry is registered as `<path>/*` so a nested segment comes too.
 *
 * App.jsx mounts `adminLegacyRoutes()` inside the `/admin` block;
 * adminRedirects.test.jsx walks every entry and checks that App.jsx declares
 * the route it lands on.
 */
import React from 'react';
import { Navigate, Route, useLocation, useParams } from 'react-router';
import { LEGACY_ROUTES as INTEGRATIONS_LEGACY_ROUTES } from '@/components/admin/integrations/tabs';

/** `[path, to]`: the old segment under /admin, and the absolute path it is now. */
export const ADMIN_LEGACY_ROUTES = Object.freeze([
  // #442: /admin/recordings became the Plaud tab of the Recording Hub.
  { path: 'recordings', to: '/admin/recording-hub' },
  // #569: the two diagnostics pages became the Health Hub.
  { path: 'ops-health', to: '/admin/health' },
  { path: 'diagnostics', to: '/admin/health' },
  // #570: the two pages the Integrations Hub replaced land on their tab.
  ...INTEGRATIONS_LEGACY_ROUTES,
  // AP-F13 (#937): the route is the menu label's slug. These were the eight
  // whose slug said something other than the label.
  { path: 'submit', to: '/admin/new-content' },
  { path: 'queue', to: '/admin/review-queue' },
  { path: 'published', to: '/admin/publish' },
  { path: 'mailing-list', to: '/admin/newsletter-hub' },
  { path: 'social', to: '/admin/social-hub' },
  { path: 'linkie', to: '/admin/linkie-hub' },
  { path: 'speaking-events', to: '/admin/speaking' },
  { path: 'platform', to: '/admin/platform-settings' },
]);

/**
 * The new location for the one the browser is at: `to`, then whatever
 * followed the old segment, then the query and hash untouched. A `to` that
 * already carries a query (the Integrations tabs) keeps it and appends the
 * caller's parameters after it.
 */
export function legacyTarget(to, { rest = '', search = '', hash = '' } = {}) {
  const [toPath, toQuery = ''] = String(to).split('?');
  const path = rest ? `${toPath.replace(/\/$/, '')}/${rest.replace(/^\//, '')}` : toPath;
  const params = new URLSearchParams(toQuery);
  for (const [key, value] of new URLSearchParams(search)) params.append(key, value);
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

function LegacyRedirect({ to }) {
  const { '*': rest = '' } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={legacyTarget(to, { rest, search, hash })} replace />;
}

/** The `<Route>` elements App.jsx mounts under `/admin`, one per legacy path. */
export function adminLegacyRoutes() {
  return ADMIN_LEGACY_ROUTES.map(({ path, to }) => (
    <Route key={path} path={`${path}/*`} element={<LegacyRedirect to={to} />} />
  ));
}

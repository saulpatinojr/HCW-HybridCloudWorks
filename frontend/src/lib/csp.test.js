/**
 * The Content-Security-Policy shipped with the static site.
 *
 * A CSP is only a control if it says no to something. This one had drifted into
 * saying yes to the entire Firebase/GCP surface long after the last Firebase
 * import was deleted, while omitting the one origin admin sign-in cannot work
 * without (T-404). Both halves are asserted here, because neither
 * shows up in a build, a lint, or any test that renders a component — a CSP
 * failure appears in a browser console on a deployed site and nowhere else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODER_APPS_ORIGIN, CODER_ORIGIN } from '@/data/labs/catalogue';
import { addonOrigins } from '@/data/addons/catalogue';

const config = JSON.parse(readFileSync(join(process.cwd(), 'staticwebapp.config.json'), 'utf8'));
const CSP = config.globalHeaders['Content-Security-Policy'];

/** Everything allowed for one directive. */
const directive = (name) => {
  const match = CSP.split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return match ? match.slice(name.length).trim().split(/\s+/).filter(Boolean) : [];
};

describe('Content-Security-Policy', () => {
  it('grants nothing to Firebase or Google Cloud where code could reach it', () => {
    // Zero Firebase imports remain in the bundle. Every one of these was a
    // standing permission for an origin the app cannot reach any more.
    //
    // Scoped to the three directives that grant *code* a destination. A
    // blanket check over the whole policy is wrong here and this test caught
    // that: `fonts.googleapis.com` is a Google origin the site genuinely uses,
    // for the Material Symbols stylesheet `index.html` loads.
    const reachable = [
      ...directive('connect-src'),
      ...directive('script-src'),
      ...directive('frame-src'),
    ].join(' ');

    for (const dead of [
      'firebaseio.com',
      'cloudfunctions.net',
      'run.app',
      'firebaseapp.com',
      'apis.google.com',
      'accounts.google.com',
      'googletagmanager.com',
      // The Firebase-era wildcard. `fonts.googleapis.com` in style-src is a
      // different, live thing — hence the exact-suffix match.
      '*.googleapis.com',
    ]) {
      expect(reachable).not.toContain(dead);
    }
  });

  it('keeps the font origins index.html actually loads', () => {
    // Removing these breaks the Material Symbols icon font site-wide, which is
    // exactly the kind of silent regression a CSP cleanup invites.
    expect(directive('style-src')).toContain('https://fonts.googleapis.com');
    expect(directive('font-src')).toContain('https://fonts.gstatic.com');
  });

  it('grants nothing to Cosmos DB', () => {
    // The standing constraint: the browser must never hold a Cosmos data-plane
    // client or key. `*.documents.azure.com` in connect-src contradicted it.
    expect(CSP).not.toContain('documents.azure.com');
  });

  it('permits the Entra endpoints MSAL actually uses', () => {
    // Absent from both directives before this. Admin sign-in cannot complete
    // without the first, and silent token renewal — a hidden iframe against
    // the same authority — cannot work without the second.
    expect(directive('connect-src')).toContain('https://login.microsoftonline.com');
    expect(directive('frame-src')).toContain('https://login.microsoftonline.com');
  });

  it('permits the API in both deployment topologies', () => {
    // `'self'` covers a same-origin `/api` base; the named Cloudflare host
    // covers the cross-origin one.
    //
    // This used to be `https://*.azurewebsites.net`, and that is now the one
    // address the browser CANNOT use: the Function App origin is restricted to
    // Cloudflare IP ranges (infra: functions_origin_lock_enabled), so a direct
    // call answers 403. Traffic goes through api-azure.<domain>, and CSP is
    // enforced against the URL the browser actually requests — so the host
    // named here has to be the proxied one, not the origin behind it.
    //
    // Narrower as a side effect worth keeping: the wildcard admitted every
    // Azure Websites host on the internet, this admits exactly one name.
    const connect = directive('connect-src');
    expect(connect).toContain("'self'");
    expect(connect).toContain('https://api-azure.hybridcloudworks.com');
    expect(connect).not.toContain('https://*.azurewebsites.net');
  });

  // Every <audio> the site renders streams from the API's public media route
  // (Listen & Learn episodes, the Recording Hub, the ElevenLabs live check) or
  // from the RSS.com podcast enclosure hosts (EpisodePlayer on /:provider/audio).
  // Without media-src the default-src 'self' applied, and in the cross-origin
  // topology it blocked all of them before a byte loaded: the player showed
  // 0:00 with nothing in the network panel (found 2026-09-26 on the Audio
  // tab). The hosts are the API origin and the RSS.com media hosts, and nothing
  // broader.
  it('lets audio stream from the API host and the RSS.com enclosure hosts, and from nowhere else', () => {
    const media = directive('media-src');
    expect(media).toEqual([
      "'self'",
      'https://api-azure.hybridcloudworks.com',
      'https://media.rss.com',
      'https://content.rss.com',
    ]);
    expect(directive('connect-src')).toContain(media[1]);
  });

  it('keeps the third-party origins the app still calls', () => {
    // CustomSessionizeWidget and SpeakingEventsPage fetch both of these.
    const connect = directive('connect-src');
    expect(connect).toContain('https://sessionize.com');
    expect(connect).toContain('https://nominatim.openstreetmap.org');
  });

  // The Landing Zone Builder's "Validate on the lab" is locked to the site's
  // pane by a Cloudflare Turnstile token (ADR 0032 decision 6, revised
  // 2026-09-28). The widget is a script from challenges.cloudflare.com that
  // draws an iframe from the same origin, so it needs exactly script-src and
  // frame-src there, and Cloudflare's CSP reference asks for nothing else
  // (connect-src only for pre-clearance, which is off). One exact origin: no
  // *.cloudflare.com, and nothing in connect-src, where it would let code
  // send the page's data to Cloudflare.
  it('lets Turnstile load its script and frame from its one origin, and nothing broader', () => {
    expect(directive('script-src')).toEqual([
      "'self'",
      'https://static.cloudflareinsights.com',
      'https://challenges.cloudflare.com',
    ]);
    expect(directive('frame-src')).toContain('https://challenges.cloudflare.com');
    // The whole frame-src list is pinned in the lab panes test below.
    expect(directive('frame-src').filter((source) => source.endsWith('.cloudflare.com'))).toEqual([
      'https://challenges.cloudflare.com',
    ]);
    expect(directive('connect-src')).not.toContain('https://challenges.cloudflare.com');
    expect(CSP).not.toMatch(/\*\.cloudflare\.com/);
    // Every directive that lists the origin, by exact source token compared
    // with ===. A substring match on the policy text would also count a
    // look-alike host, and CodeQL rightly flags one.
    const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
    const granting = CSP.split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([, ...sources]) => sources.some((source) => source === TURNSTILE_ORIGIN))
      .map(([name]) => name);
    expect(granting.sort()).toEqual(['frame-src', 'script-src']);
  });

  // The lab workspaces open in panes on the site (#751; owner decision
  // 2026-09-28, ADR 0032). The pane frames Coder's dashboard, and code-server
  // is a workspace app one label below it (CODER_WILDCARD_ACCESS_URL), so
  // frame-src needs exactly those two sources. The AddOn panes (ADR 0035)
  // add one exact origin per AVAILABLE catalogue row, `<id>.lab…`, and the
  // catalogue is the source of that list. Nothing broader: not
  // *.lab.hybridcloudworks.com, which would admit every other lab name, and
  // not *.hybridcloudworks.com. And nothing in connect-src: the site reads
  // the workspaces' and the AddOns' status through the Function App, never
  // from the lab host.
  it('lets the site frame the lab workspaces from exactly their two sources, and each available AddOn from its one', () => {
    const LAB_SOURCES = [CODER_ORIGIN, CODER_APPS_ORIGIN];
    expect(LAB_SOURCES).toEqual([
      'https://coder.lab.hybridcloudworks.com',
      'https://*.coder.lab.hybridcloudworks.com',
    ]);
    const ADDON_SOURCES = addonOrigins();
    expect(ADDON_SOURCES).toEqual([
      'https://migration.lab.hybridcloudworks.com',
      'https://network-assessment.lab.hybridcloudworks.com',
      'https://cloud-assessment.lab.hybridcloudworks.com',
    ]);
    expect(directive('frame-src')).toEqual([
      "'self'",
      'https://login.microsoftonline.com',
      'https://challenges.cloudflare.com',
      ...LAB_SOURCES,
      ...ADDON_SOURCES,
    ]);
    // Every directive that lists any of those sources, compared token by
    // token with ===, like the Turnstile check above.
    const PANE_SOURCES = [...LAB_SOURCES, ...ADDON_SOURCES];
    const granting = CSP.split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([, ...sources]) => sources.some((source) => PANE_SOURCES.includes(source)))
      .map(([name]) => name);
    expect(granting).toEqual(['frame-src']);
    // No broader lab or site wildcard, and no scheme-only source, anywhere.
    const everySource = CSP.split(';').flatMap((part) => part.trim().split(/\s+/).slice(1));
    for (const broad of [
      'https://*.lab.hybridcloudworks.com',
      'https://*.hybridcloudworks.com',
      '*.hybridcloudworks.com',
      'https:',
      '*',
    ]) {
      expect(directive('frame-src')).not.toContain(broad);
    }
    const labNames = everySource.filter(
      (source) =>
        source === 'https://lab.hybridcloudworks.com' ||
        source.endsWith('.lab.hybridcloudworks.com')
    );
    expect(labNames).toEqual([...LAB_SOURCES, ...ADDON_SOURCES]);
  });

  it('still refuses framing and defaults closed', () => {
    expect(directive('default-src')).toEqual(["'self'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
  });

  it('allows no inline or eval script', () => {
    const script = directive('script-src');
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });
});

describe('indexing headers', () => {
  const headersFor = (route) => config.routes.find((entry) => entry.route === route)?.headers || {};

  // T-737. robots.txt Disallow stops a crawler FETCHING a URL; it does not stop
  // the URL being indexed when something links to it — Google will list a
  // disallowed URL with no snippet. And the Helmet `noindex` these pages render
  // is client-side, so a crawler that does not execute JavaScript never sees
  // it, and `app-shell.html` — what an un-prerendered route falls back to —
  // carries none at all. An HTTP header is the only one of the three that a
  // crawler always sees.
  it.each([['/admin/*'], ['/preview/*']])('serves %s with noindex, nofollow', (route) => {
    expect(headersFor(route)['X-Robots-Tag']).toBe('noindex, nofollow');
  });

  it('puts the noindex routes before the catch-all HTML cache rule', () => {
    // Static Web Apps applies the FIRST matching route rule. Behind `/*.html`
    // these would never be evaluated.
    const order = config.routes.map((entry) => entry.route);
    const htmlRule = order.indexOf('/*.html');
    expect(htmlRule).toBeGreaterThan(-1);
    for (const route of ['/admin/*', '/auth/*', '/preview/*']) {
      expect(order.indexOf(route)).toBeLessThan(htmlRule);
    }
  });

  it('does not mark any public route noindex', () => {
    // The failure that would matter more than the one being fixed.
    //
    // `/auth/*` joined the list with #520: it is the Entra redirect target, a
    // page whose only job is to consume a fragment and navigate away. Indexing
    // it would publish a titled, empty page — and one that appears in search
    // results holding somebody's authorization code in the URL.
    const noindexed = config.routes
      .filter((entry) => entry.headers?.['X-Robots-Tag']?.includes('noindex'))
      .map((entry) => entry.route);
    expect(noindexed.sort()).toEqual(['/admin/*', '/auth/*', '/preview/*']);
  });
});

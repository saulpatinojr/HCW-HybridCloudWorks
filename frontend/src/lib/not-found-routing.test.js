// @vitest-environment node
/**
 * An unknown address answers 404, and the app's own pages still load (#1613).
 *
 * WHAT WENT WRONG. `staticwebapp.config.json` had a `navigationFallback`: a
 * catch-all that answered every path without a file of its own with the app
 * (`app-shell.html`) and HTTP 200. Microsoft documents that status on the
 * Static Web Apps configuration page, under "Fallback routes":
 * https://learn.microsoft.com/azure/static-web-apps/configuration#fallback-routes
 * So `/this-page-does-not-exist` answered 200 and showed "not found", which
 * Google calls a "Soft 404". Its Page indexing report of 2026-11-09 listed 90.
 * The 404 override already in the file (`responseOverrides`) never ran,
 * because the catch-all answered first.
 *
 * WHAT REPLACED IT. No catch-all. A public page has a file of its own, written
 * by the pre-render step, and answers 200. Anything else gets the 404
 * override: the same app, so a reader still sees the site's not-found page,
 * but with status 404. The only exceptions are the private areas, which are
 * never pre-rendered on purpose (see routes-are-complete.test.js): /admin,
 * /preview, /auth and /newsletter/confirm each have a rule in `routes` that
 * sends the app with 200 and `X-Robots-Tag: noindex, nofollow`. A rule with
 * `rewrite` cannot set a status of its own (Static Web Apps refuses it, see
 * Microsoft's answer at https://learn.microsoft.com/answers/a/2021258).
 *
 * WHY THERE IS NO RULE FOR PUBLIC DETAIL PAGES. A rule like
 * `/azure/news/*` was tried first, for the detail pages the app fetches from
 * the API. In the Static Web Apps emulator it also caught `/azure/news`
 * itself, the pre-rendered list page, and served the empty app in its place.
 * Microsoft's page explains why that can happen: a request for a folder is
 * matched as its `index.html` ("Exact route" on the configuration page), and
 * `/azure/news/index.html` is under `/azure/news/`. So `matches()` below
 * counts a folder as its index file, and no rule may cover a pre-rendered
 * page.
 *
 * THE PRICE, stated so nobody is surprised by it: a public page that has no
 * file answers 404, even though the app still shows it to a reader. That is
 *   - an article published after the last deploy, until the next content
 *     manifest refresh is merged and the site is deployed again (publishing
 *     does not start a deploy);
 *   - a news, coder-corner, framework or code item that exists only in the
 *     API, because the manifest lists blog articles, interviews and
 *     architecture designs only (designs since #1628). On 2026-11-09 the
 *     manifest counted none of those.
 *
 * The rules are matched the way Static Web Apps matches them: in order, first
 * match wins, and a `*` is allowed only at the end ("Routes" and "Wildcard
 * pattern" on the configuration page above).
 */
import { describe, it, expect } from 'vitest';
import config from '../../staticwebapp.config.json';
import manifest from '../../data/content-manifest.json';
import { routes } from '../../scripts/prerender-entry.jsx';
import { seedFor, seedKeyFor } from '../../scripts/prerender.mjs';
import { buildManifest } from '../../../scripts/build-content-manifest.mjs';
import { certifications as awsCertifications } from '@/data/aws/certifications';
import { architecturesByProvider } from '@/data/architectures';
import { labsPath, providersWithLabs } from '@/data/labs/catalogue';
import { STATIC_SEARCH_ITEMS } from '@/data/searchIndex';
import * as landingZonePresets from '@/lib/landingZone/presets';

const SHELL = '/app-shell.html';

/** The private areas: the only rewrites, each marked noindex. */
const PRIVATE_ROUTES = ['/admin', '/admin/*', '/preview/*', '/auth/*', '/newsletter/confirm'];

/**
 * Does a Static Web Apps route pattern match a request for this page?
 *
 * A pre-rendered page `/a/b` is the file `/a/b/index.html`, and Static Web
 * Apps matches a folder request as that file, so both spellings are tried.
 * A pattern is exact, or ends in `*` and matches everything after its prefix.
 */
function matches(pattern, page) {
  const candidates = [page, `${page === '/' ? '' : page}/index.html`];
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return candidates.some((path) => path.startsWith(prefix));
  }
  return candidates.includes(pattern);
}

const rewriteRules = () => config.routes.filter((rule) => rule.rewrite);
const redirectRules = () => config.routes.filter((rule) => rule.redirect);

describe('unknown addresses answer 404 (#1613)', () => {
  it('has no catch-all fallback', () => {
    // The catch-all answered every unknown path with 200. Putting it back,
    // even with an exclude list, brings the Soft 404s back.
    expect(config.navigationFallback).toBeUndefined();
    expect(config.routes.map((rule) => rule.route)).not.toContain('/*');
  });

  it('answers an unknown path with the app and status 404', () => {
    expect(config.responseOverrides['404']).toEqual({ rewrite: SHELL, statusCode: 404 });
  });

  it('rewrites the private areas to the app, marked noindex, and nothing else', () => {
    expect(rewriteRules().map((rule) => rule.route)).toEqual(PRIVATE_ROUTES);
    for (const rule of rewriteRules()) {
      expect(rule.rewrite, rule.route).toBe(SHELL);
      expect(rule.statusCode, `${rule.route}: a rewrite cannot carry a status`).toBeUndefined();
      expect(rule.headers?.['X-Robots-Tag'], rule.route).toBe('noindex, nofollow');
    }
  });

  it('matches a folder as its index file, the way that hid the list pages', () => {
    // The case the emulator found: the rule for the detail pages caught the
    // list page above them. If this ever reads false, the check below is
    // blind to that mistake.
    expect(matches('/azure/news/*', '/azure/news')).toBe(true);
    expect(matches('/admin/*', '/administrator')).toBe(false);
    expect(matches('/admin', '/admin')).toBe(true);
  });

  it('covers no pre-rendered page with a rewrite or a redirect', () => {
    // Microsoft's page does not say whether a rule or a file wins when both
    // match one address, and in the emulator the rule won: the page was
    // replaced by the empty app. So no rule may cover one.
    const prerendered = routes(manifest);
    expect(prerendered.length).toBeGreaterThan(200);
    for (const rule of [...rewriteRules(), ...redirectRules()]) {
      const covered = prerendered.filter((page) => matches(rule.route, page));
      expect(covered, `${rule.route} covers pre-rendered pages`).toEqual([]);
    }
  });

  it('pre-renders the AWS certification, microcredential and catalogue architecture pages', () => {
    // These were answered by the catch-all and are linked from pre-rendered
    // pages, so without a file they would now answer 404.
    const prerendered = new Set(routes());
    const expected = [
      ...awsCertifications.map((cert) => `/aws/education/${cert.slug}`),
      ...Object.entries(architecturesByProvider).flatMap(([provider, catalogue]) =>
        Object.keys(catalogue).map((slug) => `/${provider}/architecture-designs/${slug}`)
      ),
    ];
    expect(expected.length).toBeGreaterThan(30);
    expect(expected.filter((page) => !prerendered.has(page))).toEqual([]);
    expect(
      [...prerendered].filter((page) => page.startsWith('/aws/education/microcredentials/'))
    ).not.toHaveLength(0);
  });

  it('links only to design addresses that have a pre-built page (#1628)', () => {
    // The search palette and the landing-zone presets build their links in
    // JavaScript, so nothing else checks them. On 2026-11-10 six of them
    // pointed at designs no list or API held, which answer 404 to a crawler.
    const prerendered = new Set(routes());
    const designLinks = new Set();
    const collect = (value) => {
      if (typeof value === 'string') {
        if (value.includes('/architecture-designs')) designLinks.add(value.replace(/[?#].*$/, ''));
      } else if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(collect);
      }
    };
    collect(STATIC_SEARCH_ITEMS);
    collect(Object.values(landingZonePresets).filter((v) => v && typeof v === 'object'));
    expect(designLinks.size).toBeGreaterThan(10);
    expect([...designLinks].filter((link) => !prerendered.has(link))).toEqual([]);
  });

  it('pre-renders every design the manifest carries at its architecture address, seeded (#1628)', () => {
    // A design published through the admin screens but not written into
    // `data/architectures.js` used to get no page under
    // /<provider>/architecture-designs/, so that address answered 404 to a
    // crawler. The manifest route now sends designs with every field the
    // design page reads, and the builder lists each at that address with its
    // seed. Checked twice: on the committed manifest, and on one the real
    // builder makes from a sample design, so the check has something to hold
    // even before the next manifest refresh brings the first design in.
    const sample = buildManifest(
      [{ id: 'a1', slug: 'a-post', cloudProvider: 'azure', type: 'blog' }],
      null,
      [],
      [
        {
          id: 'd1',
          slug: 'sample-design',
          cloudProvider: 'Azure',
          type: 'architecture',
          diagramXml: '<mxfile/>',
        },
      ]
    );
    for (const built of [manifest, sample]) {
      const pages = new Set(routes(built));
      const designs = Object.entries(built.data).filter(([key]) => key.startsWith('architecture:'));
      for (const [key, design] of designs) {
        const provider = String(
          design.cloudProvider || design['Cloud Provider'] || ''
        ).toLowerCase();
        const page = `/${provider}/architecture-designs/${key.slice('architecture:'.length)}`;
        expect(pages.has(page), page).toBe(true);
        expect(seedKeyFor(page), page).toBe(key);
      }
    }
    expect(routes(sample)).toContain('/azure/architecture-designs/sample-design');
    expect(seedFor(sample, '/azure/architecture-designs/sample-design')).toEqual({
      'architecture:sample-design': sample.data['architecture:sample-design'],
    });
  });

  /** The 301s for each AWS certification's old slug, in catalogue order. */
  const certRedirects = () =>
    awsCertifications.flatMap((cert) =>
      (cert.previousSlugs || []).map((old) => ({
        route: `/aws/education/${old}`,
        redirect: `/aws/education/${cert.slug}`,
        statusCode: 301,
      }))
    );

  /**
   * The 301s from a provider's old labs address, `/<provider>/labs`, to its
   * labs page, `/<provider>/education/labs` (ADR 0033 moved the labs under
   * Learn). The app still answers the old address in the browser, but it has
   * no page of its own, so without these it answers 404 (#1613). Only for a
   * provider whose labs page the site builds; FinOps and GitHub have none.
   */
  const labsRedirects = () =>
    providersWithLabs().map((provider) => ({
      route: `/${provider}/labs`,
      redirect: labsPath(provider),
      statusCode: 301,
    }));

  /**
   * The 301s from a design's old blog address to its own design address. A
   * design that exists only in the API was pre-built as an article at
   * `/<provider>/blog/<slug>` until #1628, and that address was in the
   * sitemap; since then it is built at `/<provider>/architecture-designs/<slug>`
   * and the blog address has no file. Listed by hand: only the designs that
   * were published (and so in the sitemap) before the move. On 2026-11-12 the
   * owner renamed the design to its `<topic>-<id>` address (#1628), so both
   * its old blog address and its old design address now go to the new one:
   * [provider, old slug, current slug].
   */
  const MOVED_DESIGNS = [['azure', 'enterprise-hub-and-spoke-zero-trust-edge', 'network-2loi8bh7']];
  const designRedirects = () =>
    MOVED_DESIGNS.flatMap(([provider, old, current]) => [
      {
        route: `/${provider}/blog/${old}`,
        redirect: `/${provider}/architecture-designs/${current}`,
        statusCode: 301,
      },
      {
        route: `/${provider}/architecture-designs/${old}`,
        redirect: `/${provider}/architecture-designs/${current}`,
        statusCode: 301,
      },
    ]);

  /**
   * The 301s from each article's old title address to its `<topic>-<id>`
   * address (#1628). The owner renamed the 23 live articles on 2026-11-12, and
   * the old addresses were in the sitemap. Listed by hand: [provider, old, new].
   */
  const RENAMED_ARTICLES = [
    [
      'azure',
      'azure-foundry-hosted-agents-accelerating-ai-agent-deployment-optimization-featur',
      'ai-0n8jwlc9',
    ],
    [
      'azure',
      'microsoft-foundry-end-to-end-observability-and-roi-for-production-ai-agents',
      'ai-80th4hpu',
    ],
    [
      'azure',
      'a-developers-guide-to-managing-models-cost-and-quality-in-microsoft-foundry',
      'ai-avb8ugpo',
    ],
    [
      'azure',
      'new-microsoft-certified-azure-ai-fundamentals-certification',
      'certification-amsljuhn',
    ],
    [
      'azure',
      'new-microsoft-certified-sql-ai-developer-associate-certification',
      'certification-bn4ejnai',
    ],
    [
      'azure',
      'announcing-the-new-microsoft-certified-azure-ai-apps-and-agents-developer-associ',
      'certification-bpcasr5v',
    ],
    [
      'azure',
      'in-preview-public-preview-code-first-observability-for-foundry-agents-in-vs-code',
      'governance-1k5ayjbe',
    ],
    [
      'azure',
      'operationalizing-azure-updates-with-microsoft-release-communications-and-proacti',
      'governance-3lmh4mqz',
    ],
    [
      'azure',
      'launched-generally-available-azure-api-management-premium-v2-and-standard-v2-now',
      'governance-7mckl1cs',
    ],
    ['azure', 'launched-generally-available-agent-kit-for-azure-cosmos-db', 'governance-7zcmioei'],
    [
      'azure',
      'leveraging-ai-for-efficient-azure-update-discovery-with-microsoft-release-commun',
      'governance-8nxzy0yr',
    ],
    [
      'azure',
      'leveraging-ai-powered-discovery-for-azure-updates-with-microsoft-release-communi',
      'governance-c3brws9d',
    ],
    [
      'azure',
      'announcing-private-preview-deploy-ansible-playbooks-using-azure-policy-via-machi',
      'governance-cxju174v',
    ],
    [
      'azure',
      'autonomous-self-healing-for-azure-vmware-solution-private-clouds',
      'hybrid-56bv3djx',
    ],
    [
      'azure',
      'unlocking-on-prem-genai-with-azure-arc-agentic-retrieval-in-foundry-local',
      'hybrid-97iiobfb',
    ],
    [
      'azure',
      'ansible-azure-arc-use-ansible-modules-to-deploy-and-manage-azure-arc-machine-ext',
      'hybrid-cpjhv5a3',
    ],
    [
      'azure',
      'automating-arc-enabled-sql-server-license-type-configuration-with-azure-policy',
      'hybrid-d5h8ghmv',
    ],
    [
      'azure',
      'discover-and-assess-file-shares-for-migration-to-azure-files-with-azure-migrate',
      'migration-9r8sqzqf',
    ],
    [
      'aws',
      'aws-transform-enhances-migration-assessments-with-new-agentic-capabilities-IVrBFJ',
      'migration-ivrbfj6y',
    ],
    [
      'azure',
      'unveiling-microsofts-secure-future-initiative-sfi-a-blueprint-for-next-generatio-91IWYg',
      'security-91iwygpr',
    ],
    [
      'azure',
      'nist-vs-microsoft-zero-trust-why-cloud-architects-should-care-LSzyB6',
      'security-lszyb6gb',
    ],
    [
      'azure',
      'microsoft-sovereign-cloud-empowering-europe-with-unprecedented-data-control-and--ibDYCO',
      'sovereignty-ibdycon0',
    ],
    [
      'azure',
      'microsoft-sovereign-cloud-unleashing-disconnected-operations-with-enhanced-gover-Ttt3Hv',
      'sovereignty-ttt3hv8d',
    ],
  ];
  const articleRedirects = () =>
    RENAMED_ARTICLES.map(([provider, old, renamed]) => ({
      route: `/${provider}/blog/${old}`,
      redirect: `/${provider}/blog/${renamed}`,
      statusCode: 301,
    }));

  it("sends each renamed article's old address to its new one with a 301 (#1628)", () => {
    expect(articleRedirects()).toHaveLength(23);
    for (const rule of articleRedirects()) {
      expect(redirectRules()).toContainEqual(rule);
    }
  });

  it("sends each AWS certification's old slug to its current page with a 301", () => {
    expect(certRedirects().length).toBeGreaterThan(0);
    expect(redirectRules().filter((rule) => rule.route.startsWith('/aws/education/'))).toEqual(
      certRedirects()
    );
  });

  it("sends each provider's old labs address to its labs page with a 301", () => {
    expect(labsRedirects().length).toBeGreaterThan(0);
    expect(redirectRules().filter((rule) => rule.route.endsWith('/labs'))).toEqual(labsRedirects());
  });

  it("sends each moved design's old blog address to its design page with a 301 (#1628)", () => {
    for (const rule of designRedirects()) {
      expect(redirectRules()).toContainEqual(rule);
    }
  });

  it('has no redirect but those four kinds, each to a page the site builds', () => {
    expect(redirectRules()).toEqual([
      ...certRedirects(),
      ...labsRedirects(),
      ...designRedirects(),
      ...articleRedirects(),
    ]);
    const prerendered = new Set(routes(manifest));
    for (const rule of redirectRules()) {
      expect(prerendered.has(rule.redirect), `${rule.route} -> ${rule.redirect}`).toBe(true);
    }
  });

  it('puts every redirect and rewrite before the header-only rules', () => {
    // First match wins, so a header rule like `/*.html` placed earlier would
    // stop a rewrite or redirect from ever running.
    const order = config.routes.map((rule) => Boolean(rule.rewrite || rule.redirect));
    const firstHeaderOnly = order.indexOf(false);
    expect(firstHeaderOnly).toBeGreaterThan(-1);
    expect(order.slice(firstHeaderOnly)).not.toContain(true);
  });
});

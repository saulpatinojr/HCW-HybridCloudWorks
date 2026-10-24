/**
 * The AddOn catalogue (ADR 0035; the HCW AddOn Integration Standard,
 * docs/standards/addon-integration-standard.md, section 4).
 *
 * PURE DATA. An AddOn is an independently built tool the site shows in a
 * sandboxed pane at `/tools/<id>`: its own origin on a lab name, its own
 * release cadence, its own secrets on the lab host. The site holds one row
 * here per AddOn and derives everything else from it: the page
 * (pages/tools/AddOnPanePage.jsx), the Tools menu (components/shared/Header.jsx),
 * the pre-render list (scripts/prerender-entry.jsx), the `frame-src` entry
 * the CSP needs (csp.test.js reads `addonOrigins()`) and the parity check
 * against the Function App's closed registry
 * (functions/src/lib/addons/registry.js). `catalogue.test.js` holds every
 * row to the shape below.
 *
 * ADDING AN ADDON IS ADDING A ROW, a server registry entry, one app setting
 * (`ADDON_<ID>_URL` in infra/functionapp.tf), one `addons[]` entry in
 * lab-host/ansible/group_vars/all.yml and one `frame-src` source in
 * frontend/staticwebapp.config.json. Routes stay hand-declared in App.jsx,
 * one lazy page per row, because routes-are-complete.test.js expects every
 * absolute route to be declared and pre-rendered one by one.
 *
 * `id` is the path segment, the hostname label (`<id>.lab.hybridcloudworks.com`)
 * and the setting suffix at once: lowercase, hyphenated, no spaces, which the
 * test enforces. `status` is `available` for a row the site frames; a
 * `coming` row renders an explainer and no frame, is kept out of the menu,
 * the CSP and the server registry's reachable set, and must carry
 * `comingSince` and `comingReason`, so nothing is promised without saying
 * since when and why.
 *
 * `capabilities` is what the PAGE GRANTS THE PANE (sandbox and `allow`
 * flags), not what the AddOn can do; the running image reports its own
 * `capabilities` in `/api/health` and the status proxy passes those through
 * for the admin card. The two lists differ on purpose.
 *
 * EVERY COPY FIELD IS VISITOR COPY. `title`, `menuLabel`, `summary`,
 * `comingReason` and `articleSlugs[].title` render on public pages and name
 * nothing behind the site; public-copy.test.js scans this directory.
 * `origin`, `panePath`, `healthPath` and `docsUrl` are addresses, not copy,
 * and legitimately contain `api`.
 */
/**
 * Where the tools live: `/tools/<id>`, global rather than under a provider
 * (standard, section 5). `staticRoutes` in lib/routeFactory.ts names each
 * row's path for links, and the test holds the two to each other.
 */
export const TOOLS_PATH = '/tools';

/** The fields every row carries, in the order the test reports a missing one. */
export const ADDON_FIELDS = Object.freeze([
  'id',
  'title',
  'summary',
  'origin',
  'panePath',
  'healthPath',
  'providers',
  'technology',
  'status',
  'capabilities',
  'docsUrl',
  'articleSlugs',
]);

/** Optional fields: `menuLabel` on any row; `comingSince` and `comingReason` only while `coming`. */
export const ADDON_OPTIONAL_FIELDS = Object.freeze(['menuLabel', 'comingSince', 'comingReason']);

/** A row is framed only while `available`. */
export const ADDON_STATUSES = Object.freeze(['available', 'coming']);

/**
 * The provider hubs a row may name. A subset of VALID_PROVIDERS
 * (context/ProviderContext.jsx), which the test checks; metadata for hub
 * cards only, since tools are global (`/tools/<id>`, never `/:provider/tools/<id>`).
 */
export const ADDON_PROVIDERS = Object.freeze(['azure']);

/**
 * What a row may grant its pane (standard, section 8). `navigate` lets the
 * page act on a `navigate` message; `downloads` adds `allow-downloads` to
 * the sandbox; `popups` adds `allow-popups` (discouraged: a popup inherits
 * the sandbox); `clipboard` (read and write), `clipboard-write` (write only,
 * the narrower grant a "Copy report" button needs) and `fullscreen` are
 * Permissions Policy grants to the AddOn's origin. Never `allow-top-navigation`.
 */
export const ADDON_CAPABILITIES = Object.freeze([
  'navigate',
  'downloads',
  'popups',
  'clipboard',
  'clipboard-write',
  'fullscreen',
]);

/** Every AddOn origin is exactly `https://<id>` followed by this; the test enforces it. */
export const ADDON_ORIGIN_SUFFIX = '.lab.hybridcloudworks.com';

/**
 * The site origins an AddOn may post its pane messages to. The lab host
 * derives the same list for each container (`caddy_frame_ancestors` minus
 * `'self'`), and the AddOn publishes it in `/api/health.siteOrigins`.
 */
export const SITE_ORIGINS = Object.freeze([
  'https://hybridcloudworks.com',
  'https://www.hybridcloudworks.com',
]);

export const addons = Object.freeze([
  Object.freeze({
    id: 'migration',
    title: 'Azure migration assessment',
    menuLabel: 'Migration Hub',
    summary:
      'Upload an exported inventory of your Azure estate and get a staged migration assessment, example automation and runbooks. Nothing you upload is kept beyond two hours.',
    origin: 'https://migration.lab.hybridcloudworks.com',
    panePath: '/',
    healthPath: '/api/health',
    providers: Object.freeze(['azure']),
    technology: Object.freeze(['azure-resource-mover', 'terraform']),
    status: 'available',
    // `downloads` (allow-downloads on the sandbox) confirmed by the owner on 2026-10-10, ADR 0035 decision 9, #1044;
    // the accepted-risk row in TODO.md applies. The pane keeps its "Copy report" control as the fallback.
    capabilities: Object.freeze(['navigate', 'downloads']),
    docsUrl: 'https://github.com/saulpatinojr/HCW-AzMigrateOrchestrator_Addon#readme',
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'network-assessment',
    title: 'Cloud network assessment',
    summary:
      'Upload an export of your Azure network resources and get an assessment of its topology, segmentation and exposure, with the findings explained. Nothing you upload is kept beyond two hours.',
    origin: 'https://network-assessment.lab.hybridcloudworks.com',
    panePath: '/',
    healthPath: '/api/health',
    providers: Object.freeze(['azure']),
    technology: Object.freeze(['azure-networking', 'resource-graph']),
    status: 'available',
    capabilities: Object.freeze(['downloads', 'clipboard-write']),
    docsUrl: 'https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn#readme',
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'cloud-assessment',
    title: 'Cloud assessment',
    summary:
      'Upload an export of your Azure resources and get a scored assessment against a catalogue of reliability, security, cost and operations criteria. Nothing you upload is kept beyond two hours.',
    origin: 'https://cloud-assessment.lab.hybridcloudworks.com',
    panePath: '/',
    healthPath: '/api/health',
    providers: Object.freeze(['azure']),
    technology: Object.freeze(['well-architected', 'resource-graph']),
    status: 'available',
    capabilities: Object.freeze(['downloads', 'clipboard-write']),
    docsUrl: 'https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn#readme',
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'cloud-crawler',
    title: 'Cloud architecture drift check',
    summary:
      'Upload an export of your Azure resources or your Terraform and see where what is built has drifted from your architecture decisions, with draft decision records and review notes. Nothing you upload is kept beyond two hours.',
    origin: 'https://cloud-crawler.lab.hybridcloudworks.com',
    panePath: '/',
    healthPath: '/api/health',
    providers: Object.freeze(['azure']),
    technology: Object.freeze(['resource-graph', 'terraform', 'architecture-decisions']),
    status: 'coming',
    // The App has not tagged a release and the AddOn is a skeleton (its README, 2026-10-24), so there is no
    // image to run. The row opens when the first image is published and the owner pins its digest.
    comingSince: '2026-10-24',
    comingReason:
      'The tool is being built. It opens here as soon as its first release is published.',
    capabilities: Object.freeze(['navigate', 'downloads']),
    docsUrl: 'https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn#readme',
    articleSlugs: Object.freeze([]),
  }),
]);

/** The rows the site frames and lists in the Tools menu: `available` ones, in catalogue order. */
export const availableAddons = Object.freeze(
  addons.filter((addon) => addon.status === 'available')
);

/** The catalogue row with this id, or null for an id the catalogue does not have. */
export function addonById(addonId) {
  return addons.find((addon) => addon.id === addonId) ?? null;
}

/** The site page that holds one AddOn's pane: `/tools/<id>`. */
export function addonPanePath(addon) {
  return `${TOOLS_PATH}/${encodeURIComponent(addon.id)}`;
}

/** What the pane loads: the AddOn's own origin and its pane path. */
export function addonPaneUrl(addon) {
  return `${addon.origin}${addon.panePath}`;
}

/**
 * The address the frame is given: the pane URL with the site's theme as
 * `?theme=dark|light`, because a pane on another origin cannot read the
 * site's `dark` class and would otherwise follow the visitor's device setting
 * (website issue #1353). Any other value, or none, leaves the URL as it is.
 * An AddOn that does not read the parameter ignores it.
 */
export function addonFrameUrl(addon, theme) {
  const url = new URL(addonPaneUrl(addon));
  if (theme === 'dark' || theme === 'light') url.searchParams.set('theme', theme);
  return url.toString();
}

/** The origins of the available rows, exactly as the CSP's `frame-src` must list them. */
export function addonOrigins() {
  return availableAddons.map((addon) => addon.origin);
}

/** The available rows listed under a provider, in catalogue order. */
export function addonsForProvider(provider) {
  return availableAddons.filter((addon) => addon.providers.includes(provider));
}

export default addons;

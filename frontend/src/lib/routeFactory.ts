/**
 * Centralized Route Factory
 *
 * This module provides type-safe, provider-aware route generation for the entire application.
 * All links throughout the platform should use these functions instead of hard-coded paths.
 *
 * @module routeFactory
 */

/**
 * Supported cloud provider types
 */
export type ProviderType =
  'aws' | 'azure' | 'gcp' | 'github' | 'terraform' | 'finops' | 'vmware' | 'ansible' | 'docker';

/**
 * All available page routes in the application
 */
export type PageType =
  | 'landing'
  | 'blog'
  | 'audio'
  | 'audioArchitecture'
  | 'video'
  | 'frameworks'
  | 'architectureDesigns'
  | 'education'
  | 'rosettastone'
  | 'comparison'
  | 'migration'
  | 'resources'
  | 'decisions'
  | 'tools'
  | 'modules'
  | 'code'
  | 'coderCorner'
  | 'workflows'
  | 'focus'
  | 'sandboxes'
  | 'buildingImages'
  | 'desktop'
  | 'rss'
  | 'news'
  | 'architectures'
  | 'labs'
  | 'interviews';

/**
 * Centralized route definitions
 * Maps page types to path templates
 */
const ROUTE_MAP: Record<PageType, string> = {
  landing: '',
  blog: 'blog',
  audio: 'audio',
  audioArchitecture: 'audio-architecture',
  video: 'video',
  frameworks: 'frameworks',
  architectureDesigns: 'architecture-designs',
  education: 'education',
  rosettastone: 'rosettastone',
  comparison: 'comparison',
  migration: 'migration',
  resources: 'resources',
  decisions: 'decisions',
  tools: 'tools',
  modules: 'modules',
  code: 'code',
  coderCorner: 'coder-corner',
  workflows: 'workflows',
  focus: 'focus',
  // Docker's own page (#774): the Docker Sandboxes recipe. Here so the header
  // recognises `/docker/sandboxes` as a Docker hub page, as `modules` does
  // for `/terraform/modules`.
  sandboxes: 'sandboxes',
  // Docker's two guides (#772, #773), here for the same reason as `sandboxes`.
  buildingImages: 'building-images',
  desktop: 'desktop',
  rss: 'rss',
  news: 'news',
  architectures: 'architectures',
  labs: 'labs',
  // Azure's interviews (`/azure/interviews` and `/azure/interviews/:id`). Here so
  // the header recognises them as Azure pages and keeps the Azure menu, as
  // `sandboxes` does for Docker: the header finds the provider from the URL
  // alone, and a segment not in this map made it fall back to the generic
  // provider list on the interview pages (seen in a browser, 2026-10-24).
  interviews: 'interviews',
};

const ROUTE_REVERSE_MAP = Object.entries(ROUTE_MAP).reduce(
  (acc, [key, value]) => {
    acc[value] = key as PageType;
    return acc;
  },
  {} as Record<string, PageType>
);

/**
 * Validates that a provider is supported
 */
function isValidProvider(provider: string): provider is ProviderType {
  const validProviders: ProviderType[] = [
    'aws',
    'azure',
    'gcp',
    'github',
    'terraform',
    'finops',
    'vmware',
    'ansible',
    'docker',
  ];
  return validProviders.includes(provider as ProviderType);
}

/**
 * Validates that a page type is supported
 */
function isValidPage(page: string): page is PageType {
  return page in ROUTE_MAP;
}

/**
 * Core route factory function
 * Generates provider-aware routes with validation
 *
 * @param provider - The cloud provider (aws, azure, gcp, etc.)
 * @param page - The page type (blog, frameworks, etc.)
 * @param hash - Optional hash fragment (e.g., #section-id)
 * @returns Fully formed route path
 *
 * @example
 * ```ts
 * getRoute('aws', 'blog') // '/aws/blog'
 * getRoute('github', 'frameworks', '#modules') // '/github/frameworks#modules'
 * getRoute('terraform', 'landing') // '/terraform'
 * ```
 */
export function getRoute(
  provider: ProviderType | string,
  page: PageType | string = 'landing',
  hash?: string
): string {
  // Validate provider and use local variable
  let validProvider: ProviderType = provider as ProviderType;
  if (!isValidProvider(provider)) {
    console.warn(`[routeFactory] Invalid provider: ${provider}. Falling back to 'aws'.`);
    validProvider = 'aws';
  }

  // Validate page and use local variable
  let validPage: PageType = page as PageType;
  if (!isValidPage(page)) {
    console.warn(`[routeFactory] Invalid page: ${page}. Falling back to 'landing'.`);
    validPage = 'landing';
  }

  // Build path
  const basePath = `/${validProvider}`;
  const pagePath = ROUTE_MAP[validPage];
  const hashFragment = hash ? hash : '';

  // Landing page is just the provider base
  if (validPage === 'landing') {
    return `${basePath}${hashFragment}`;
  }

  return `${basePath}/${pagePath}${hashFragment}`;
}

/**
 * Build a provider route with a custom subpath
 * Keeps provider validation centralized while supporting deep links
 */
export function getProviderPath(provider: ProviderType | string, subpath: string): string {
  let validProvider: ProviderType = provider as ProviderType;
  if (!isValidProvider(provider)) {
    console.warn(`[routeFactory] Invalid provider: ${provider}. Falling back to 'aws'.`);
    validProvider = 'aws';
  }

  const cleanedSubpath = subpath.replace(/^\/+/, '');
  return `/${validProvider}/${cleanedSubpath}`;
}

/**
 * Convenience object with all route generators
 * Use this for cleaner syntax throughout the app
 *
 * @example
 * ```tsx
 * import { routes } from '@/lib/routeFactory';
 *
 * <Link to={routes.blog('aws')}>AWS Blog</Link>
 * <Link to={routes.frameworks('terraform')}>Terraform Frameworks</Link>
 * ```
 */
export const routes = {
  landing: (provider: ProviderType) => getRoute(provider, 'landing'),
  blog: (provider: ProviderType) => getRoute(provider, 'blog'),
  audio: (provider: ProviderType) => getRoute(provider, 'audio'),
  audioArchitecture: (provider: ProviderType) => getRoute(provider, 'audioArchitecture'),
  video: (provider: ProviderType) => getRoute(provider, 'video'),
  frameworks: (provider: ProviderType) => getRoute(provider, 'frameworks'),
  architectureDesigns: (provider: ProviderType) => getRoute(provider, 'architectureDesigns'),
  education: (provider: ProviderType) => getRoute(provider, 'education'),
  rosettastone: (provider: ProviderType) => getRoute(provider, 'rosettastone'),
  comparison: (provider: ProviderType) => getRoute(provider, 'comparison'),
  migration: (provider: ProviderType) => getRoute(provider, 'migration'),
  resources: (provider: ProviderType) => getRoute(provider, 'resources'),
  decisions: (provider: ProviderType) => getRoute(provider, 'decisions'),
  tools: (provider: ProviderType) => getRoute(provider, 'tools'),
  modules: (provider: ProviderType) => getRoute(provider, 'modules'),
  code: (provider: ProviderType) => getRoute(provider, 'code'),
  coderCorner: (provider: ProviderType) => getRoute(provider, 'coderCorner'),
  workflows: (provider: ProviderType) => getRoute(provider, 'workflows'),
  focus: (provider: ProviderType) => getRoute(provider, 'focus'),
  sandboxes: (provider: ProviderType) => getRoute(provider, 'sandboxes'),
  buildingImages: (provider: ProviderType) => getRoute(provider, 'buildingImages'),
  desktop: (provider: ProviderType) => getRoute(provider, 'desktop'),
  rss: (provider: ProviderType) => getRoute(provider, 'rss'),
  /** The interview list. Only Azure routes it; App.jsx answers any other provider with the not-found page. */
  interviews: (provider: ProviderType) => getRoute(provider, 'interviews'),
  /**
   * A provider's labs under its Learn section (ADR 0033 §3): the list at
   * `/:provider/education/labs` and one lab's pane at
   * `/:provider/education/labs/:labId`. Both are children of the
   * `/:provider` block in App.jsx, declared before `education/:certSlug` so
   * `labs` is never read as a certification slug (ADR 0033 §6 item 6). The
   * cross-provider index stays at `staticRoutes.labs`.
   */
  labs: (provider: ProviderType) => getProviderPath(provider, 'education/labs'),
  labPane: (provider: ProviderType, labId: string) =>
    getProviderPath(provider, `education/labs/${encodeURIComponent(labId)}`),
} as const;

/**
 * Special routes that don't follow the provider pattern
 */
export const staticRoutes = {
  home: '/',
  about: '/about',
  contact: '/contact',
  // The cross-provider Learn pages. A static first segment, so they outrank
  // `/:provider/education` in App.jsx (#681).
  education: '/education',
  labs: '/education/labs',
  comparison: '/tools/comparison',
  // AddOn panes (ADR 0035): one entry per row of data/addons/catalogue.js,
  // `/tools/<id>` with the id camel-cased; the catalogue test holds them to
  // each other.
  migration: '/tools/migration',
  networkAssessment: '/tools/network-assessment',
  cloudAssessment: '/tools/cloud-assessment',
  cloudCrawler: '/tools/cloud-crawler',
  resources: '/tools/resources',
  decisions: '/tools/decisions',
  landingZone: '/tools/landing-zone',
} as const;

/**
 * Get all available routes for a given provider
 * Useful for navigation menus and sitemaps
 *
 * @param provider - The cloud provider
 * @returns Object with all routes for that provider
 */
export function getAllRoutes(provider: ProviderType) {
  return {
    landing: routes.landing(provider),
    blog: routes.blog(provider),
    audio: routes.audio(provider),
    audioArchitecture: routes.audioArchitecture(provider),
    video: routes.video(provider),
    frameworks: routes.frameworks(provider),
    architectureDesigns: routes.architectureDesigns(provider),
    education: routes.education(provider),
    rosettastone: routes.rosettastone(provider),
    comparison: routes.comparison(provider),
    migration: routes.migration(provider),
    resources: routes.resources(provider),
    decisions: routes.decisions(provider),
    tools: routes.tools(provider),
    modules: routes.modules(provider),
    code: routes.code(provider),
    coderCorner: routes.coderCorner(provider),
    workflows: routes.workflows(provider),
    focus: routes.focus(provider),
    sandboxes: routes.sandboxes(provider),
    buildingImages: routes.buildingImages(provider),
    desktop: routes.desktop(provider),
    rss: routes.rss(provider),
    interviews: routes.interviews(provider),
  };
}

/**
 * Parse a path to extract provider and page
 * Useful for determining current context from URL
 *
 * @param path - Current pathname (e.g., '/aws/blog')
 * @returns Object with provider and page, or null if invalid
 *
 * @example
 * ```ts
 * parseRoute('/aws/blog') // { provider: 'aws', page: 'blog' }
 * parseRoute('/github') // { provider: 'github', page: 'landing' }
 * parseRoute('/invalid/route') // null
 * ```
 */
export function parseRoute(path: string): { provider: ProviderType; page: PageType } | null {
  // Remove leading slash and split
  const segments = path.replace(/^\//, '').split('/');

  if (segments.length === 0) return null;

  const [provider, pageSegment = ''] = segments;
  const page = pageSegment ? ROUTE_REVERSE_MAP[pageSegment] : 'landing';

  // Validate
  if (!isValidProvider(provider)) return null;
  if (!page || !isValidPage(page)) return null;

  return { provider, page };
}

/**
 * Check if a route exists in the application
 *
 * @param path - Path to validate
 * @returns True if the route is valid
 */
export function isValidRoute(path: string): boolean {
  // Check static routes
  const staticRoutesValues = Object.values(staticRoutes) as string[];
  if (staticRoutesValues.includes(path)) {
    return true;
  }

  // Check dynamic provider routes
  return parseRoute(path) !== null;
}

/**
 * Generate breadcrumb trail for current route
 *
 * @param path - Current pathname
 * @returns Array of breadcrumb objects
 *
 * @example
 * ```ts
 * getBreadcrumbs('/aws/blog')
 * // [
 * //   { label: 'Home', path: '/' },
 * //   { label: 'AWS', path: '/aws' },
 * //   { label: 'Blog', path: '/aws/blog' }
 * // ]
 * ```
 */
export function getBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const breadcrumbs: Array<{ label: string; path: string }> = [{ label: 'Home', path: '/' }];

  const parsed = parseRoute(path);
  if (!parsed) return breadcrumbs;

  const { provider, page } = parsed;

  // Add provider breadcrumb
  breadcrumbs.push({
    label: provider.toUpperCase(),
    path: routes.landing(provider),
  });

  // Add page breadcrumb if not landing
  if (page !== 'landing') {
    breadcrumbs.push({
      label: page.charAt(0).toUpperCase() + page.slice(1),
      path: getRoute(provider, page),
    });
  }

  return breadcrumbs;
}

/**
 * Get the canonical URL for SEO
 *
 * @param provider - Cloud provider
 * @param page - Page type
 * @param baseURL - Base URL of the site (e.g., 'https://hybridcloudworks.com')
 * @returns Full canonical URL
 */
export function getCanonicalURL(
  provider: ProviderType,
  page: PageType = 'landing',
  baseURL: string = 'https://hybridcloudworks.com'
): string {
  const route = getRoute(provider, page);
  return `${baseURL}${route}`;
}

/**
 * Development helper: Log all routes for a provider
 * Only runs in development mode
 */
export function debugRoutes(provider: ProviderType): void {
  if (import.meta.env.DEV) {
    console.warn(`Routes for ${provider.toUpperCase()}:`);
    const allRoutes = getAllRoutes(provider);
    Object.entries(allRoutes).forEach(([key, path]) => {
      console.warn(`${key.padEnd(15)} → ${path}`);
    });
  }
}

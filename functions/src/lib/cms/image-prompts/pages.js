/**
 * The pages a prompt set may be assigned to, and the pages a content
 * document is assigned through (PR #841 split of image-prompts.js).
 */
import { ContentValidationError } from '../content-update-validation.js';

/** Verbatim from the source — the pages a prompt set may be assigned to. */
export const ADMIN_PROMPT_PAGE_ALLOWLIST = new Set([
  '/aws',
  '/aws/news',
  '/aws/blog',
  '/aws/architecture-designs',
  '/aws/frameworks',
  '/aws/education',
  '/aws/audio-architecture',
  '/azure',
  '/azure/news',
  '/azure/blog',
  '/azure/architecture-designs',
  '/azure/frameworks',
  '/azure/education',
  '/azure/audio-architecture',
  '/gcp',
  '/gcp/news',
  '/gcp/blog',
  '/gcp/architecture-designs',
  '/gcp/frameworks',
  '/gcp/education',
  '/gcp/audio-architecture',
  '/finops',
  '/finops/news',
  '/finops/blog',
  '/finops/architecture-designs',
  '/finops/frameworks',
  '/finops/education',
  '/finops/tools',
  '/finops/focus',
  '/vmware',
  '/vmware/news',
  '/vmware/blog',
  '/vmware/architecture-designs',
  '/vmware/frameworks',
  '/vmware/education',
  '/vmware/audio-architecture',
  '/terraform',
  '/terraform/news',
  '/terraform/blog',
  '/terraform/code',
  '/terraform/modules',
  '/terraform/tools',
  '/ansible',
  '/ansible/news',
  '/ansible/blog',
  '/ansible/code',
  '/ansible/education',
  '/github',
  '/github/news',
  '/github/blog',
  '/github/workflows',
  '/github/code',
  '/github/tools',
  // Docker's pages (#775): the hub, news, blog, code, the sandbox recipe
  // (#774), tools and learning. No architecture or frameworks page exists.
  '/docker',
  '/docker/news',
  '/docker/blog',
  '/docker/code',
  '/docker/sandboxes',
  '/docker/tools',
  '/docker/education',
]);

/**
 * The page a prompt set is assigned to, checked against the allowlist.
 *
 * @param {unknown} pagePath - the page the body names
 * @returns {string} the normalised path
 * @throws {ContentValidationError} when it is missing or not on the list (authored, #945)
 */
export function assertAllowedPromptPage(pagePath) {
  const normalized = String(pagePath || '').trim();
  if (!normalized) {
    throw new ContentValidationError('pagePath is required');
  }
  if (!ADMIN_PROMPT_PAGE_ALLOWLIST.has(normalized)) {
    throw new ContentValidationError(`pagePath is not allowed: ${normalized}`);
  }
  return normalized;
}

// ── content → page resolution ─────────────────────────────────────────────

const PROVIDER_SLUGS = Object.freeze({
  aws: 'aws',
  'amazon web services': 'aws',
  azure: 'azure',
  'microsoft azure': 'azure',
  gcp: 'gcp',
  'google cloud': 'gcp',
  'google cloud platform': 'gcp',
  google: 'gcp',
  finops: 'finops',
  terraform: 'terraform',
  github: 'github',
  docker: 'docker',
  vmware: 'vmware',
  ansible: 'ansible',
});

const TYPE_SUFFIXES = Object.freeze({
  news: '/news',
  blog: '/blog',
  architecture: '/architecture-designs',
  framework: '/frameworks',
  coder_corner: '/code',
});

/** The spellings a content document names its provider under, first match wins. */
const PROVIDER_FIELDS = Object.freeze(['cloudProvider', 'Cloud Provider', 'provider', 'Provider']);

/** The provider slug (`aws`, `gcp`, …) a content document names, or ''. */
export function providerSlugFor(data = {}) {
  const raw = String(PROVIDER_FIELDS.map((key) => data[key]).find(Boolean) || '')
    .trim()
    .toLowerCase();
  return PROVIDER_SLUGS[raw] || (ADMIN_PROMPT_PAGE_ALLOWLIST.has(`/${raw}`) ? raw : '');
}

/**
 * The allowlisted pages whose assignment applies to a content document, most
 * specific first: `/{provider}{type page}` then the provider landing. Empty
 * when the provider is unknown — there is nothing to assign to.
 */
export function pagePathsForContent(data = {}) {
  const slug = providerSlugFor(data);
  if (!slug) return [];
  const type = String(data.type || data.contentType || 'blog')
    .trim()
    .toLowerCase();
  const suffix = TYPE_SUFFIXES[type] || TYPE_SUFFIXES.blog;
  return [`/${slug}${suffix}`, `/${slug}`].filter((path) => ADMIN_PROMPT_PAGE_ALLOWLIST.has(path));
}

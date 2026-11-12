/**
 * What the page derives from the draft: provider, target, slug, step, and the
 * readiness checklist.
 *
 * All pure. None of it touches state, which is why it is the easiest part of
 * the page to test and was among the last to get any coverage (#634).
 */
import { isValidHttpUrl } from './draftStage';
import { parseLineItems } from './persistStage';

/**
 * One row per content type, rather than the same switch written three times.
 *
 * `getPreviewSection`, `getPublishTargetLabel` and `getPromptLibraryPagePath`
 * each used to carry their own copy of this mapping, which is three places to
 * update and three chances to miss one.
 */
const CONTENT_TYPE_META = {
  framework: { section: 'frameworks', label: 'Framework' },
  architecture: { section: 'architecture-designs', label: 'Architecture' },
  coder_corner: { section: 'code', label: 'Coder Corner' },
  blog: { section: 'blog', label: 'Blog' },
};

/** Blog is the fallback for anything unrecognised, as it always was. */
const metaFor = (contentType) => CONTENT_TYPE_META[contentType] || CONTENT_TYPE_META.blog;

/** The public section a draft of this type publishes into. */
export function getPreviewSection(contentType) {
  return metaFor(contentType).section;
}

/** The operator-facing name for that target. */
export function getPublishTargetLabel(contentType) {
  return metaFor(contentType).label;
}

/** Where the prompt library keeps this page's assignment, or '' with no provider. */
export function getPromptLibraryPagePath(contentType, providerSegment) {
  const normalizedProvider = String(providerSegment || '')
    .trim()
    .toLowerCase();
  if (!normalizedProvider) return '';
  return `/${normalizedProvider}/${metaFor(contentType).section}`;
}

/**
 * A URL-safe slug from the title, capped at 80 characters.
 *
 * The cap can land mid-word; that is existing behaviour and the readiness
 * checklist only asks for eight characters, so it has never mattered.
 */
/**
 * The address a draft will publish at, for the preview. Every page's is
 * `<topic>-<8 id characters>` (#1628); the id is not known until the draft is
 * saved, so x's stand in for it.
 */
export function previewSlugFor({ topic = '' } = {}) {
  return `${topic || 'topic'}-xxxxxxxx`;
}

export function slugifyTitle(value = '') {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

/** An explicit choice beats one inferred from the URL. */
export function getResolvedProvider(provider, inferredProvider) {
  return provider || inferredProvider || '';
}

/** Only a blog has a separate landing zone; everything else follows the provider. */
export function getResolvedBlogLandingProvider(contentType, blogLandingProvider, resolvedProvider) {
  if (contentType !== 'blog') return resolvedProvider;
  return blogLandingProvider || resolvedProvider;
}

/**
 * Which provider a URL implies, or ''.
 *
 * A table rather than a chain of ifs, so adding one is a row. Order is
 * significant and preserved: the first row with any matching marker wins.
 */
const PROVIDER_URL_MARKERS = [
  // `cloud.google` is redundant beside `google` and matches nothing extra. It
  // is kept because removing it changes nothing and the intent is clearer.
  ['Azure', ['azure', 'microsoft']],
  ['Aws', ['aws', 'amazon']],
  ['Gcp', ['gcp', 'google', 'cloud.google']],
  ['Github', ['github']],
  ['Terraform', ['terraform']],
  ['Finops', ['finops']],
  // LAST, for the reason `docker` is last in lib/providers.js: a URL about
  // Docker on Azure, on GitHub or with Terraform belongs to that provider,
  // so Docker wins only when nothing above matched (#775).
  ['Docker', ['docker']],
];

export function inferProviderFromUrl(url = '') {
  const normalized = String(url).toLowerCase();
  const hit = PROVIDER_URL_MARKERS.find(([, markers]) =>
    markers.some((marker) => normalized.includes(marker))
  );
  return hit ? hit[0] : '';
}

/** Images can only be generated once there is a draft and both prompts. */
export function canGenerateDraftImages(summaryPrompt, detailsPrompt, draftReady) {
  return Boolean(draftReady && summaryPrompt.trim() && detailsPrompt.trim());
}

/** The furthest stage the draft has reached, for the header. */
export function getCurrentStep({
  hasSourceUrls,
  draftReady,
  hasUploadedImages,
  hasSelectedGeneratedImages,
}) {
  if (!hasSourceUrls) return 1;
  if (!draftReady) return 2;
  if (!hasUploadedImages && !hasSelectedGeneratedImages) return 3;
  return 4;
}

/** Framework drafts need at least one valid official source; others do not. */
function frameworkSourcesCheck(contentType, frameworkSourceUrls) {
  const notFramework = contentType !== 'framework';
  return {
    key: 'framework-sources',
    label: 'Framework source URLs captured',
    done: notFramework || parseLineItems(frameworkSourceUrls).filter(isValidHttpUrl).length > 0,
    hint: notFramework
      ? 'Not required for non-framework content types.'
      : 'Provide one or more official documentation URLs (one per line).',
  };
}

/** Only a blog needs a landing zone. */
function landingZoneCheck(contentType, resolvedBlogLandingProvider) {
  const notBlog = contentType !== 'blog';
  return {
    key: 'landing-zone',
    label: 'Blog landing zone selected',
    done: notBlog || Boolean(resolvedBlogLandingProvider),
    hint: notBlog
      ? 'Not required for non-blog content types.'
      : `Target landing zone: /${(resolvedBlogLandingProvider || 'provider').toLowerCase()}/blog`,
  };
}

/** The hint names the sections still missing, which is what the operator needs. */
function schemaSectionsCheck(sectionBlocks, normalizedContent) {
  const required = sectionBlocks
    .filter((section) => section.required)
    .map((section) => ({ ...section, present: normalizedContent.includes(section.heading) }));
  const missing = required.filter((section) => !section.present).map((section) => section.title);
  return {
    key: 'schema-sections',
    label: 'Required section blocks present',
    done: missing.length === 0,
    hint: missing.join(', ') || 'All required sections are present.',
  };
}

/** The thresholds a draft has to clear before Stage 4 will save it. */
export function buildReadinessChecks({
  sourceUrl,
  contentType,
  frameworkSourceUrls,
  resolvedProvider,
  resolvedBlogLandingProvider,
  inferredProvider,
  previewSlug,
  previewPath,
  draftTitle,
  title,
  draftSummary,
  draftContent,
  hasHeroSelected,
  sectionBlocks,
}) {
  const normalizedContent = draftContent.trim();

  return [
    {
      key: 'url',
      label: 'Valid source URL',
      done: isValidHttpUrl(sourceUrl),
      hint: 'Paste a full http(s) URL before generating draft content.',
    },
    frameworkSourcesCheck(contentType, frameworkSourceUrls),
    {
      key: 'provider',
      label: 'Cloud provider selected',
      done: Boolean(resolvedProvider),
      hint: inferredProvider
        ? `Detected provider from URL: ${inferredProvider}.`
        : 'Select provider manually or keep auto-detect if unsure.',
    },
    landingZoneCheck(contentType, resolvedBlogLandingProvider),
    {
      key: 'slug',
      label: 'Publication slug ready',
      done: previewSlug.length >= 8,
      hint: previewSlug ? previewPath : 'Add/adjust title to generate a clean slug.',
    },
    {
      key: 'title',
      label: 'Publishable title',
      done: (draftTitle || title).trim().length >= 12,
      hint: 'Aim for a descriptive title (12+ characters).',
    },
    {
      key: 'summary',
      label: 'Summary complete',
      done: draftSummary.trim().length >= 80,
      hint: 'Write a summary that clearly explains value and outcome.',
    },
    {
      key: 'content',
      label: 'Content body complete',
      done: normalizedContent.length >= 700,
      hint: 'Content should be substantial and publication-ready.',
    },
    schemaSectionsCheck(sectionBlocks, normalizedContent),
    {
      key: 'hero',
      label: 'At least one image selected',
      done: hasHeroSelected,
      hint: 'Select one or more uploaded or AI-generated images to include in the draft.',
    },
  ];
}

/**
 * The id the builder files its preview images under: `preview-<ms>-<8 hex>`,
 * unique per page load so two builders open at once never share a gallery.
 */
export function createPreviewSessionId(now = Date.now()) {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) =>
          b.toString(16).padStart(2, '0')
        ).join('');
  return `preview-${now}-${rand}`;
}

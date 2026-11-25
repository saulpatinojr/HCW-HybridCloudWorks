/**
 * The fields an article keeps in the content manifest, and therefore the only
 * article fields the manifest route returns (public-content-manifest.js) and
 * the only ones scripts/build-content-manifest.mjs writes to
 * frontend/data/content-manifest.json, the file the pre-render reads.
 *
 * ONE LIST, TWO READERS (#1845). Until 2026-11-25 scripts/ kept its own copy
 * and a test compared the two as text. scripts/ now imports this file, as it
 * already imported public-reads.js, so there is nothing left to drift. Keep
 * this module free of imports: scripts/ loads it without installing
 * functions/'s packages.
 *
 * A field missing here is silently absent from every pre-rendered article,
 * which shows up as a rendering bug in the static HTML and nowhere else.
 */
export const ARTICLE_FIELDS = Object.freeze([
  // identity and routing
  'id',
  'slug',
  'Slug',
  'cloudProvider',
  'Cloud Provider',
  // the body, in the shapes the template looks for
  'Content',
  'content',
  'blogDraft',
  'code',
  'codeLanguage',
  'codeSnippet',
  'terraformCode',
  // headings and summary
  'Title',
  'title',
  'Summary',
  'summary',
  'description',
  'excerpt',
  'keyTopics',
  // taxonomy. `type` is what the section pages select on (framework,
  // coder_corner); the manifest counts it per provider so the pre-render can
  // keep a section with nothing in it out of the sitemap (issue #373).
  'type',
  'Category',
  'category',
  'Tags',
  'tags',
  'language',
  // attribution and dates
  'Author',
  'siteAuthor',
  'editorAuthor',
  'createdByName',
  'publishedByName',
  'Published At',
  'publishedAt',
  'publishedDate',
  'datePublished',
  'blogPublishedAt',
  'ReadTime',
  'readTime',
  // media
  'imageUrl',
  'heroImageUrl',
  'contentImageUrl',
  'altCoverImage',
  'altCoverImageVariants',
  'aiImageUrls',
  'aiImageVariants',
  // outbound links
  'url',
  'sourceUrl',
  'Source URL',
  'repoUrl',
  'CD Url',
]);

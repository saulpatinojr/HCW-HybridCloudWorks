/** The idea-note format: the types, formats, statuses, keys and limits a note is held to (idea-notes.mjs). */

export const IDEA_TYPES = Object.freeze([
  'blog',
  'framework',
  'architecture',
  'coder_corner',
  'interview',
]);
export const IDEA_FORMATS = Object.freeze([
  'how-to',
  'build-log',
  'article',
  'video',
  'podcast',
  'newsletter',
]);
export const IDEA_STATUSES = Object.freeze(['idea', 'outlined', 'drafted', 'published', 'parked']);

/** The formats a blog draft can be: the template's two tracks (docs/content/blog-template.md). */
export const FORMAT_TO_TRACK = Object.freeze({ 'how-to': 'how-to', 'build-log': 'build-log' });

/** The limits the import enforces (repo-draft.js), plus the ones this format adds. */
export const LIMITS = Object.freeze({
  title: 300,
  subtitle: 500,
  tags: 12,
  tag: 40,
  theme: 40,
  part: 20,
});

/** The statuses from which an idea must have something written under its properties. */
export const NEEDS_BODY = Object.freeze(['outlined', 'drafted', 'published']);

export const KNOWN_KEYS = Object.freeze([
  'type',
  'theme',
  'format',
  'status',
  'title',
  'subtitle',
  'tags',
  'reading',
  'part',
  'date',
]);

/** Lower-case words joined by hyphens: the shape of a theme, a tag and a draft's file name. */
export const WORDS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The file name a draft gets is held to the shape the markdown reader's path rule takes
 * (repo-draft.js REPO_DRAFT_PATH_PATTERN, MAX_REPO_PATH_LENGTH), so the same file
 * name also works if the old import-from-repo route is ever used.
 */
export const DRAFT_PATH = /^docs\/content\/blog-[a-z0-9-]+\.md$/;
export const MAX_DRAFT_PATH = 120;
export const MAX_NAME_CHARS = 80;

export const BLOCKED_FENCES = Object.freeze(['dataview', 'dataviewjs', 'tasks', 'query']);

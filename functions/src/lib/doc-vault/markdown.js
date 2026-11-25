/**
 * doc-vault/markdown.js — the pure half of "Upload files" on /admin/doc-vault:
 * one markdown or text file → the fields of a document.
 *
 * A file may open with a front-matter block between two `---` lines, as the
 * owner's Obsidian notes and docs/content articles do. Four keys are read:
 * `title`, `category`, `tags` (a list in brackets, a comma-separated line, or
 * Obsidian's one-per-line `- item` form) and `link` (also `url`, `related`).
 * Every other key is left out and named in a warning, so nothing is lost
 * without being said. A file with no front matter is all text: the title comes
 * from its first `# heading`, else from the file name.
 *
 * The result is built from those four names and nothing else. A key such as
 * `id`, `slug`, `version`, `createdBy`, `deletedAt`, `docType`, `partitionKey`,
 * `contentStatus`, `Live` or `__proto__` in the front matter is only ever a
 * name in the "not kept" warning; it cannot reach a stored field. The block is
 * read into a Map, never an object, so a key cannot touch a prototype either.
 *
 * LINEAR TIME. The parser before this one (repo-draft.js, for articles) had
 * quadratic regular expressions. This one splits the text into lines once and
 * walks them; the only patterns are anchored, one quantifier, over a single
 * character class, so none can backtrack. The test file feeds it long runs of
 * spaces, quotes, dashes and colons and holds the time to a growth ratio.
 *
 * Nothing here does I/O and nothing here logs the text.
 */
import {
  DEFAULT_CATEGORY,
  MAX_BODY_BYTES,
  MAX_TITLE_CHARS,
  byteLength,
  canonicalCategory,
  normalizeText,
  validateFields,
} from './model.js';
import { authoredMessage, isAuthoredError } from '../http/error-response.js';
import { readFrontMatter } from './front-matter.js';
import { categoryOf, linkOf, noteIgnoredKeys, tagsOf, titleOf } from './file-fields.js';

/** Room for the front matter on top of the body cap. */
export const FRONT_MATTER_ALLOWANCE_BYTES = 16 * 1024;
/** The most a file can be: the body cap and the front matter. */
export const MAX_FILE_BYTES = MAX_BODY_BYTES + FRONT_MATTER_ALLOWANCE_BYTES;

/** What the file name must end in. A Word or PDF file is not text and is refused up front. */
export const FILE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.txt', '.text']);
const MAX_FILENAME_CHARS = 255;

const refuse = (status, code, error) => ({ ok: false, status, code, error });

/**
 * The file name's stem and whether its extension is one we read. Only the
 * last path segment counts: a browser sends a bare name, but the route does
 * not trust that.
 */
export function describeFilename(filename) {
  if (typeof filename !== 'string') return null;
  const base = filename.split(/[\\/]/).pop().trim();
  if (!base || base.length > MAX_FILENAME_CHARS) return null;
  for (let i = 0; i < base.length; i += 1) {
    if (base.charCodeAt(i) < 32) return null;
  }
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
  if (!FILE_EXTENSIONS.includes(extension)) return null;
  return { stem: base.slice(0, dot).trim() };
}

const TOO_LARGE = `That file is too large (at most about ${Math.round(MAX_FILE_BYTES / 1024)} KB: a ${MAX_BODY_BYTES / 1024} KB document and its front matter). Nothing was saved.`;

/** The refusal for a file that cannot be read at all, or null. */
function fileRefusal(named, text) {
  if (!named) {
    return refuse(
      400,
      'BAD_FILENAME',
      `Only text files are read here: a name ending in ${FILE_EXTENSIONS.join(', ')}. A Word or PDF file needs its text pasted in instead.`
    );
  }
  if (typeof text !== 'string') return refuse(400, 'INVALID', 'text is required: the whole text of the file.');
  if (byteLength(text) > MAX_FILE_BYTES) return refuse(413, 'TOO_LARGE', TOO_LARGE);
  if (text.includes('\u0000')) return refuse(422, 'NOT_TEXT', 'The file holds binary data, not text. Nothing was saved.');
  return null;
}

/** The category for files that name none: the default when none was chosen; null for an unknown one. */
function batchCategory(defaultCategory) {
  const unchosen = defaultCategory === undefined || defaultCategory === null || defaultCategory === '';
  return unchosen ? DEFAULT_CATEGORY : canonicalCategory(defaultCategory);
}

/** The checks before the text is read: `{ refusal }`, or `{ fallback }`, the batch's category. */
function checkUpload(named, text, defaultCategory) {
  const refusal = fileRefusal(named, text);
  if (refusal) return { refusal };
  const fallback = batchCategory(defaultCategory);
  if (!fallback) {
    return { refusal: refuse(400, 'INVALID', 'The category chosen for the files is not one the Doc Vault has.') };
  }
  return { fallback };
}

/** The front matter and the text after it, blank lines at the top dropped. */
function splitFile(text, warnings) {
  const lines = normalizeText(text).split('\n');
  const { meta, bodyStart, unclosed } = readFrontMatter(lines);
  if (unclosed) {
    warnings.push('The file opens with --- but the front-matter block never closes, so all of it was kept as text.');
  }
  const bodyLines = lines.slice(bodyStart);
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  return { meta, bodyLines, body: bodyLines.join('\n').trimEnd() };
}

/**
 * One file → the fields of a document, plus anything said about the way.
 * Pure. Never throws.
 *
 * @param {{ filename: unknown, text: unknown, defaultCategory?: unknown }} file
 * @returns {{ ok: true, fields: object, warnings: string[], titleFrom: string }
 *   | { ok: false, status: number, code: string, error: string }}
 */
export function parseVaultFile({ filename, text, defaultCategory }) {
  const named = describeFilename(filename);
  const upload = checkUpload(named, text, defaultCategory);
  if (upload.refusal) return upload.refusal;

  const warnings = [];
  const { meta, bodyLines, body } = splitFile(text, warnings);
  if (!body.trim()) {
    return refuse(422, 'EMPTY_BODY', 'The file has no text to keep (only front matter, or nothing).');
  }
  const { title, titleFrom } = titleOf(meta, bodyLines, named.stem);
  if (title.length > MAX_TITLE_CHARS) {
    return refuse(422, 'TITLE_TOO_LONG', `The title is ${title.length} characters; at most ${MAX_TITLE_CHARS}.`);
  }
  const category = categoryOf(meta, upload.fallback, warnings);
  const tags = tagsOf(meta, warnings);
  const relatedLink = linkOf(meta, warnings);
  noteIgnoredKeys(meta, warnings);

  try {
    const fields = validateFields({ title, category, tags, body, relatedLink });
    return { ok: true, fields, warnings, titleFrom };
  } catch (error) {
    if (isAuthoredError(error)) {
      return refuse(422, 'INVALID', authoredMessage(error, 'The file could not be read as a document.'));
    }
    throw error;
  }
}

/**
 * doc-vault/tags-links.js — a document's tags and its related link: how
 * each is cleaned and checked, and which links the page may show as one.
 * fields.js calls these for a request; markdown.js's file reader uses them
 * too, more leniently. model.js re-exports what callers use.
 */
import { MAX_LINK_CHARS, MAX_TAGS, MAX_TAG_CHARS, fail, hasControlCharacter } from './limits.js';

/** A tag as stored: trimmed, without a leading '#' (Obsidian writes them with one). */
export const cleanTag = (value) => {
  let tag = String(value ?? '').trim();
  while (tag.startsWith('#')) tag = tag.slice(1);
  return tag.trim();
};

/**
 * The tags of a request: a list, or a comma-separated string, de-duplicated
 * without regard to case. More than 12, or one over 40 characters, is refused
 * (a file upload is more forgiving: markdown.js trims and says so).
 */
export function readTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list)) fail('tags must be a list of words');
  const seen = new Set();
  const tags = [];
  for (const item of list) {
    if (typeof item !== 'string') fail('tags must be a list of words');
    const tag = cleanTag(item);
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS) fail(`A tag can be at most ${MAX_TAG_CHARS} characters.`);
    if (hasControlCharacter(tag, { allowLayout: false })) fail('A tag cannot hold control characters.');
    const folded = tag.toLowerCase();
    if (!seen.has(folded)) {
      seen.add(folded);
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) fail(`A document can have at most ${MAX_TAGS} tags.`);
  return tags;
}

/**
 * Is this a link the page may show as one: an https address, or a route of
 * this admin (`/admin/...`)? Anything else (javascript:, data:, http:, a
 * protocol-relative address) is not, so a stored link cannot run script when
 * clicked.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeLink(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_LINK_CHARS) return false;
  if (hasControlCharacter(value, { allowLayout: false }) || value.includes(' ')) return false;
  return value.startsWith('/') ? isAdminRoute(value) : isHttpsAddress(value);
}

/** `/admin` or a page under it, with no backslash, no empty segment and no segment over 120 characters. */
function isAdminRoute(value) {
  if (value !== '/admin' && !value.startsWith('/admin/')) return false;
  if (value.includes('\\') || value.includes('//')) return false;
  return value.split('/').every((segment) => segment.length <= 120);
}

/** An https address with a host and no user name or password in it. */
function isHttpsAddress(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function readLink(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('relatedLink must be text');
  const link = value.trim();
  if (!link) return null;
  if (!isSafeLink(link)) {
    fail(
      `The link must be an https address, or a page of this admin that starts with /admin/ (at most ${MAX_LINK_CHARS} characters).`
    );
  }
  return link;
}

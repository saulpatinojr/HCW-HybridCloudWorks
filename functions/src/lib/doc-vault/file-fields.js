/**
 * doc-vault/file-fields.js — the four front-matter fields an uploaded file
 * may set (doc-vault/markdown.js): its title, category, tags and link, each
 * read leniently, with a warning for anything that was changed or left out.
 * The result is built from these four names and nothing else, as
 * markdown.js's header explains.
 */
import { MAX_TAGS, MAX_TAG_CHARS, canonicalCategory, cleanTag, isSafeLink } from './model.js';
import { readInlineList } from './front-matter.js';

const MAX_NAMED_KEYS = 5;

const TITLE_KEYS = ['title'];
const CATEGORY_KEYS = ['category'];
const TAG_KEYS = ['tags', 'tag'];
const LINK_KEYS = ['link', 'url', 'related'];
const KNOWN_KEYS = new Set([...TITLE_KEYS, ...CATEGORY_KEYS, ...TAG_KEYS, ...LINK_KEYS]);

const firstOf = (meta, keys) => {
  for (const key of keys) if (meta.has(key)) return meta.get(key);
  return undefined;
};

const asText = (value) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));

/** The first non-empty line of the text, when it is a level-1 markdown heading. */
function firstHeading(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('# ')) return null;
    let end = line.length;
    while (end > 2 && line[end - 1] === '#') end -= 1;
    return line.slice(2, end).trim() || null;
  }
  return null;
}

/** Key names worth naming in a warning: short, and only characters a key can have. */
function ignoredKeys(meta) {
  return [...meta.keys()].filter((key) => !KNOWN_KEYS.has(key)).map((key) => key.slice(0, 40));
}

/** Title: front matter, else the first heading, else the file name. */
export function titleOf(meta, bodyLines, stem) {
  const fromMeta = asText(firstOf(meta, TITLE_KEYS)).trim();
  if (fromMeta) return { title: fromMeta, titleFrom: 'front matter' };
  const heading = firstHeading(bodyLines, 0) ?? '';
  if (heading) return { title: heading, titleFrom: 'heading' };
  return { title: stem, titleFrom: 'file name' };
}

/** Category: front matter if it names one we have, else the one chosen for the batch. */
export function categoryOf(meta, fallback, warnings) {
  const wanted = asText(firstOf(meta, CATEGORY_KEYS)).trim();
  if (!wanted) return fallback;
  const match = canonicalCategory(wanted);
  if (match) return match;
  warnings.push(`The category in the file is not one the Doc Vault has, so it was filed as ${fallback}.`);
  return fallback;
}

/** Tags: lenient, because a vault note can carry far more than a document may. */
export function tagsOf(meta, warnings) {
  const rawTags = firstOf(meta, TAG_KEYS);
  if (rawTags === undefined) return [];
  const tags = [];
  const seen = new Set();
  const list = Array.isArray(rawTags) ? rawTags : readInlineList(rawTags);
  let shortened = false;
  let dropped = false;
  for (const item of list) {
    const cleaned = cleanTag(item);
    if (!cleaned) continue;
    const tooLong = cleaned.length > MAX_TAG_CHARS;
    const tag = tooLong ? cleaned.slice(0, MAX_TAG_CHARS).trim() : cleaned;
    shortened ||= tooLong;
    const folded = tag.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (tags.length < MAX_TAGS) tags.push(tag);
    else dropped = true;
  }
  if (dropped) warnings.push(`Only the first ${MAX_TAGS} tags were kept.`);
  if (shortened) warnings.push(`A tag was shortened to ${MAX_TAG_CHARS} characters.`);
  return tags;
}

/** Link: kept only when the page could show it safely. */
export function linkOf(meta, warnings) {
  const rawLink = asText(firstOf(meta, LINK_KEYS)).trim();
  if (!rawLink) return null;
  if (isSafeLink(rawLink)) return rawLink;
  warnings.push('The link in the file is not an https address or an /admin page, so it was left out.');
  return null;
}

/** The warning that names the front-matter keys that were not kept, when there are any. */
export function noteIgnoredKeys(meta, warnings) {
  const left = ignoredKeys(meta);
  if (!left.length) return;
  const shown = left.slice(0, MAX_NAMED_KEYS).join(', ');
  const more = left.length > MAX_NAMED_KEYS ? ` and ${left.length - MAX_NAMED_KEYS} more` : '';
  warnings.push(`Front matter not kept: ${shown}${more}. Only title, category, tags and link are read.`);
}

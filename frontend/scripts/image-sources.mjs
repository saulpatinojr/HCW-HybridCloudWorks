/**
 * Finding every image URL a built page, a stylesheet or the content
 * manifest asks for: `<img>`, `srcset`, preload links, inline styles, CSS
 * `url()` and Markdown images. Split out of check-image-hosts.mjs, which
 * explains the check in its header and re-exports the three readers.
 */
import { decodeAttribute, startTags, styleAttributeValues } from './stage-swa-config.mjs';

const FONT_URL = /\.(woff2?|ttf|otf|eot)([?#]|$)|^data:(font\/|application\/(x-)?font)/i;
const IMAGE_ELEMENTS = new Set(['img', 'source', 'video', 'input', 'link']);
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
const HTML_IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/**
 * The candidate URLs of a srcset, read the way the HTML specification reads
 * them: skip whitespace and commas, take the next run of non-whitespace as
 * the URL, drop any commas it ends with, and unless it ended with one skip
 * the descriptors up to the next comma. A split on ", " is not that: a hand
 * written `a.png 1x,b.png 2x` has no space after its comma and would lose
 * its second candidate, and a data URI carries commas of its own.
 */
function srcsetUrls(value) {
  const urls = [];
  let position = 0;
  while (position < value.length) {
    position = skipWhile(value, position, (ch) => /[\s,]/.test(ch));
    if (position >= value.length) break;
    const start = position;
    position = skipWhile(value, position, (ch) => !/\s/.test(ch));
    const token = value.slice(start, position);
    const url = token.replace(/,+$/, '');
    if (url) urls.push(url);
    if (!token.endsWith(',')) position = skipWhile(value, position, (ch) => ch !== ',');
  }
  return urls;
}

/** The first position from `position` on whose character fails `test` (or the end). */
function skipWhile(value, position, test) {
  let next = position;
  while (next < value.length && test(value[next])) next += 1;
  return next;
}

/** Every image URL a page's markup fetches, with the element and attribute it came from. */
export function imageSourcesInHtml(html) {
  const found = [];
  // Attributes are read by startTags, in all three forms and only in
  // attribute position, so `src=` in an alt text is not taken for the source.
  for (const { name: tag, attributes } of startTags(html)) {
    if (!IMAGE_ELEMENTS.has(tag)) continue;
    const read = (name) => attributes.get(name);
    found.push(...(tag === 'link' ? linkImageSources(read) : elementImageSources(tag, read)));
  }
  found.push(...inlineCssImageSources(html));
  return found;
}

/** A `<link>` fetches an image when it preloads or prefetches one, or is an icon. */
function linkImageSources(read) {
  const rel = (read('rel') || '').toLowerCase();
  const preloadsImage =
    /\b(preload|prefetch)\b/.test(rel) && (read('as') || '').toLowerCase() === 'image';
  if (!preloadsImage && !/\bicon\b/.test(rel)) return [];
  const found = [];
  const href = read('href');
  if (href) found.push({ url: href, where: 'link.href' });
  const imagesrcset = read('imagesrcset');
  if (imagesrcset) {
    for (const url of srcsetUrls(imagesrcset)) found.push({ url, where: 'link.imagesrcset' });
  }
  return found;
}

/** An `<img>`, `<source>`, `<video>` poster or image `<input>`: its source and srcset. */
function elementImageSources(tag, read) {
  if (tag === 'input' && (read('type') || '').toLowerCase() !== 'image') return [];
  const found = [];
  for (const name of tag === 'video' ? ['poster'] : ['src']) {
    const value = read(name);
    if (value) found.push({ url: value, where: `${tag}.${name}` });
  }
  const srcset = read('srcset');
  if (srcset) for (const url of srcsetUrls(srcset)) found.push({ url, where: `${tag}.srcset` });
  return found;
}

// The CSS a page carries inline fetches images exactly as a stylesheet
// does: a background in a <style> block or in a style attribute is an image
// request, and the stylesheet scan below would never see it.
function inlineCssImageSources(html) {
  const found = [];
  for (const match of html.matchAll(STYLE_ELEMENT)) {
    for (const entry of imageSourcesInCss(match[1])) {
      found.push({ url: entry.url, where: 'style element url()' });
    }
  }
  for (const value of styleAttributeValues(html)) {
    for (const entry of imageSourcesInCss(value)) {
      found.push({ url: entry.url, where: 'style attribute url()' });
    }
  }
  return found;
}

/** Every `url()` in a stylesheet that is not a font. */
export function imageSourcesInCss(css) {
  const found = [];
  for (const match of css.matchAll(CSS_URL)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (url && !FONT_URL.test(url)) found.push({ url, where: 'css url()' });
  }
  return found;
}

/**
 * Every image an article body renders, from the manifest's `data` map. Every
 * body field is read, as scripts/scan-inline-images.mjs does, because the
 * images are not always in the field the page renders.
 */
export function imageSourcesInManifest(manifest) {
  const found = [];
  for (const [key, article] of Object.entries(manifest?.data ?? {})) {
    if (!article || typeof article !== 'object') continue;
    const body = ['blogDraft', 'Content', 'content']
      .map((field) => (typeof article[field] === 'string' ? article[field] : ''))
      .join('\n');
    for (const match of body.matchAll(HTML_IMG_SRC)) {
      found.push({ url: decodeAttribute(match[1] ?? match[2] ?? ''), where: `${key} <img>` });
    }
    for (const match of body.matchAll(MARKDOWN_IMAGE)) {
      found.push({ url: match[1], where: `${key} markdown` });
    }
  }
  return found.filter((entry) => entry.url);
}

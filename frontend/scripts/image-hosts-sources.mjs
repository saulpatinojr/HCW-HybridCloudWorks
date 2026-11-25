/**
 * What an image reference looks like in each place check-image-hosts.mjs
 * reads (moved out of that file by #1845): the src, srcset and poster of
 * image elements, the image a <link> preloads or names as an icon, every
 * non-font url() in a stylesheet or in a page's inline CSS. Each reader
 * returns `{ url, where }` entries; check-image-hosts.mjs decides what they
 * mean, and reads the article bodies itself.
 */
import { startTags, styleAttributeValues } from './stage-swa-config.mjs';

const FONT_URL = /\.(woff2?|ttf|otf|eot)([?#]|$)|^data:(font\/|application\/(x-)?font)/i;
const IMAGE_ELEMENTS = new Set(['img', 'source', 'video', 'input', 'link']);
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;

const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/** The first index at or after `position` whose character `pattern` does not match. */
function skipMatching(value, position, pattern) {
  let at = position;
  while (at < value.length && pattern.test(value[at])) at += 1;
  return at;
}

/** The index of the next comma at or after `position`, or the end of the value. */
function nextComma(value, position) {
  const at = value.indexOf(',', position);
  return at === -1 ? value.length : at;
}

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
  let position = skipMatching(value, 0, /[\s,]/);
  while (position < value.length) {
    const end = skipMatching(value, position, /\S/);
    const token = value.slice(position, end);
    const url = token.replace(/,+$/, '');
    if (url) urls.push(url);
    position = token.endsWith(',') ? end : nextComma(value, end);
    position = skipMatching(value, position, /[\s,]/);
  }
  return urls;
}

/**
 * The images a <link> fetches: an icon, or a preload or prefetch of an image
 * (its href and every imagesrcset candidate). Any other link fetches none.
 */
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

/**
 * The images any other image element fetches: a video's poster, everyone
 * else's src, and every srcset candidate. An <input> fetches one only when it
 * is `type="image"`.
 */
function elementImageSources(tag, read) {
  if (tag === 'input' && (read('type') || '').toLowerCase() !== 'image') return [];
  const found = [];
  const name = tag === 'video' ? 'poster' : 'src';
  const value = read(name);
  if (value) found.push({ url: value, where: `${tag}.${name}` });
  const srcset = read('srcset');
  if (srcset) for (const url of srcsetUrls(srcset)) found.push({ url, where: `${tag}.srcset` });
  return found;
}

/**
 * The CSS a page carries inline fetches images exactly as a stylesheet
 * does: a background in a <style> block or in a style attribute is an image
 * request, and the stylesheet scan would never see it.
 */
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

/** Every image URL a page's markup fetches, with the element and attribute it came from. */
export function imageSourcesInHtml(html) {
  const found = [];
  // Attributes are read by startTags, in all three forms and only in
  // attribute position, so `src=` in an alt text is not taken for the source.
  for (const { name: tag, attributes } of startTags(html)) {
    if (!IMAGE_ELEMENTS.has(tag)) continue;
    const read = (name) => attributes.get(name);
    const sources = tag === 'link' ? linkImageSources(read) : elementImageSources(tag, read);
    found.push(...sources);
  }
  found.push(...inlineCssImageSources(html));
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

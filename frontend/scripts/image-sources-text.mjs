/**
 * Finding image URLs in plain text: CSS `url()` (fonts left out) and the
 * `<img>` and Markdown images in the content manifest's article bodies.
 * Split out of image-sources.mjs, which re-exports both readers.
 */
import { decodeAttribute } from './stage-swa-config.mjs';

const FONT_URL = /\.(woff2?|ttf|otf|eot)([?#]|$)|^data:(font\/|application\/(x-)?font)/i;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
const HTML_IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

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

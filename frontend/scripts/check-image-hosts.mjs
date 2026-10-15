/**
 * Every image the build ships comes from a host the policy names (AP-F11, #935).
 *
 * WHAT WAS WRONG. `img-src` was `'self' data: https: blob:` — every HTTPS host on
 * the internet. The site loads images from a handful of them, and the rest of
 * that grant was an exfiltration channel: any script that ran on the page
 * could send what it held to any URL it liked, as an image request nothing
 * would block. The policy now names the hosts, measured from what the pages
 * render and recorded in docs/architecture/how-it-is-built.md.
 *
 * WHY A GATE AND NOT A LIST. A named list drifts the moment nobody reads it:
 * an article cover from a new host, a badge re-hosted somewhere else, and the
 * image breaks on the deployed site with nothing in CI to say so. This runs
 * after every build (`postbuild`, so the CI frontend job and the deploy both
 * run it), reads what the build actually shipped, and fails when an image
 * points at a host the staged policy does not allow. The fix is one line in
 * `staticwebapp.config.json` — with its reason in the doc — or re-hosting the
 * image through the media route, and either way it is a decision, not a
 * surprise.
 *
 * WHAT IT READS.
 *   - The pre-rendered pages in dist: `src` and `srcset` on img and source,
 *     `poster` on video, image inputs, and `link` elements that preload an
 *     image or declare an icon. A `preload` with `as="image"` is fetched as an
 *     image and checked against img-src like one.
 *   - The stylesheets in dist, and the CSS the pages carry inline in a
 *     `<style>` block or a `style` attribute: every `url()` that is not a
 *     font. A CSS background is an image request too.
 *   - The article bodies in data/content-manifest.json, as HTML `<img>` and
 *     Markdown images. The article pages are pre-rendered from this file, so
 *     dist already carries their markup; the bodies are read as well because
 *     an article published after a deploy renders the same markup
 *     client-side until the next build, and its hosts must already be in the
 *     policy for that to work.
 *
 * WHAT IT DOES NOT READ, and why that is stated rather than hidden. The JS
 * bundles: the only absolute image URLs in them are the placeholders of three
 * admin URL inputs (measured 2026-10-15), and runtime image sources are
 * data-driven, not literals. The live API data the About page, the speaking
 * events and the audio pages fetch: CI cannot reach the API through
 * Cloudflare's bot protection, so those hosts were inventoried from the
 * owner's workstation and the command to repeat that is in the doc.
 *
 * RETIRED HOSTS. Rows still carry URLs on the Firebase-era bucket, which is
 * gone (#518): the About page and the cover resolver already drop them before
 * rendering, but two article pages still reach it for a gallery image
 * (measured 2026-10-15: four references on two pages). Those references are
 * reported here and not counted as failures, because allowing a dead host
 * would buy nothing and failing on it would block every build until the
 * content is edited. The entry is removed when the last reference goes: a
 * retired host that nothing references any more FAILS this check, so the
 * list cannot outlive its reason. The bucket's Cloud Storage spelling,
 * `storage.googleapis.com`, is not listed: the first run of this gate found
 * nothing rendered from it, which is exactly the rule.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeAttribute } from './stage-swa-config.mjs';

/**
 * Hosts whose references are reported and tolerated, with the reason. An
 * entry with zero references fails the check, so it is deleted the day the
 * content stops naming it.
 */
export const RETIRED_IMAGE_HOSTS = Object.freeze({
  'https://firebasestorage.googleapis.com':
    'the Firebase-era storage bucket is gone (#518); two article pages still carry its URLs for a gallery image until they are re-hosted through the media route',
});

const FONT_URL = /\.(woff2?|ttf|otf|eot)([?#]|$)|^data:(font\/|application\/(x-)?font)/i;
const HTML_ELEMENT = /<(img|source|video|input|link)\b([^>]*)>/gi;
const ATTRIBUTE = (name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i');
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
const HTML_IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*"([^"]*)"/gi;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

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
    while (position < value.length && /[\s,]/.test(value[position])) position += 1;
    if (position >= value.length) break;
    const start = position;
    while (position < value.length && !/\s/.test(value[position])) position += 1;
    const token = value.slice(start, position);
    const url = token.replace(/,+$/, '');
    if (url) urls.push(url);
    if (!token.endsWith(',')) {
      while (position < value.length && value[position] !== ',') position += 1;
    }
  }
  return urls;
}

/** Every image URL a page's markup fetches, with the element and attribute it came from. */
export function imageSourcesInHtml(html) {
  const found = [];
  for (const match of html.matchAll(HTML_ELEMENT)) {
    const tag = match[1].toLowerCase();
    const attributes = match[2];
    const read = (name) => {
      const value = ATTRIBUTE(name).exec(attributes)?.[1];
      return value === undefined ? undefined : decodeAttribute(value);
    };
    if (tag === 'link') {
      const rel = (read('rel') || '').toLowerCase();
      const preloadsImage =
        /\b(preload|prefetch)\b/.test(rel) && (read('as') || '').toLowerCase() === 'image';
      if (!preloadsImage && !/\bicon\b/.test(rel)) continue;
      const href = read('href');
      if (href) found.push({ url: href, where: 'link.href' });
      const imagesrcset = read('imagesrcset');
      if (imagesrcset) {
        for (const url of srcsetUrls(imagesrcset)) found.push({ url, where: 'link.imagesrcset' });
      }
      continue;
    }
    if (tag === 'input' && (read('type') || '').toLowerCase() !== 'image') continue;
    for (const name of tag === 'video' ? ['poster'] : ['src']) {
      const value = read(name);
      if (value) found.push({ url: value, where: `${tag}.${name}` });
    }
    const srcset = read('srcset');
    if (srcset) for (const url of srcsetUrls(srcset)) found.push({ url, where: `${tag}.srcset` });
  }
  // The CSS a page carries inline fetches images exactly as a stylesheet
  // does: a background in a <style> block or in a style attribute is an image
  // request, and the stylesheet scan below would never see it.
  for (const match of html.matchAll(STYLE_ELEMENT)) {
    for (const entry of imageSourcesInCss(match[1])) {
      found.push({ url: entry.url, where: 'style element url()' });
    }
  }
  for (const match of html.matchAll(STYLE_ATTRIBUTE)) {
    for (const entry of imageSourcesInCss(decodeAttribute(match[1]))) {
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

/**
 * What a URL needs from img-src: `'self'` for a relative path, its origin
 * for http and https, and otherwise its scheme as a token (`data:`, `blob:`,
 * and equally `ftp:` or `javascript:`). Only a URL with NO scheme is
 * relative: anything else goes to `allowedBy` under its own name, so a
 * scheme the policy never heard of is reported missing rather than waved
 * through as a page of the site. A protocol-relative URL resolves on https.
 */
export function imageOrigin(url) {
  const value = url.trim();
  if (value.startsWith('//')) {
    try {
      return new URL(`https:${value}`).origin;
    } catch {
      return value;
    }
  }
  const scheme = SCHEME.exec(value)?.[1].toLowerCase();
  if (!scheme) return "'self'";
  if (scheme === 'http' || scheme === 'https') {
    try {
      return new URL(value).origin;
    } catch {
      return value;
    }
  }
  return `${scheme}:`;
}

/**
 * Whether an origin is admitted by a list of img-src sources. `'self'` admits
 * only relative URLs: the site answers on the apex and on www, and an absolute
 * URL to one of them would fail on the other. A `https://*.example` source
 * admits every subdomain and not the bare domain, as the browser reads it.
 */
export function allowedBy(origin, sources) {
  if (origin === "'self'" || origin === 'data:' || origin === 'blob:')
    return sources.includes(origin);
  if (!origin.startsWith('https://')) return false;
  const host = origin.slice('https://'.length);
  return sources.some((source) => {
    if (source === origin) return true;
    if (source.startsWith('https://*.')) {
      const suffix = source.slice('https://*'.length);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return false;
  });
}

/** The img-src sources of a policy, or an empty list when the directive is absent. */
export function imgSrcOf(policy) {
  const directive = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === 'img-src' || part.startsWith('img-src '));
  return directive ? directive.slice('img-src'.length).trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * Every origin the references use, judged against the sources: `allowed`,
 * `retired` (tolerated, with its reason) or `missing` (a failure). A retired
 * host with no reference is a failure of its own.
 *
 * @param {{ sources: string[], references: { url: string, file: string, where: string }[] }} input
 */
export function evaluate({ sources, references, retired = RETIRED_IMAGE_HOSTS }) {
  const byOrigin = new Map();
  for (const reference of references) {
    const origin = imageOrigin(reference.url);
    const row = byOrigin.get(origin) ?? { origin, count: 0, files: [], where: new Set() };
    row.count += 1;
    if (!row.files.includes(reference.file)) row.files.push(reference.file);
    row.where.add(reference.where);
    byOrigin.set(origin, row);
  }
  const rows = [...byOrigin.values()]
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin))
    .map((row) => {
      const status = allowedBy(row.origin, sources)
        ? 'allowed'
        : retired[row.origin]
          ? 'retired'
          : 'missing';
      return { ...row, where: [...row.where].sort(), status, reason: retired[row.origin] };
    });
  const failures = rows
    .filter((row) => row.status === 'missing')
    .map(
      (row) =>
        `img-src does not allow ${row.origin}, used by ${row.count} image reference(s) (${row.where.join(', ')}) in ${row.files
          .slice(0, 3)
          .join(', ')}${row.files.length > 3 ? ` and ${row.files.length - 3} more` : ''}. ` +
        'Name it in frontend/staticwebapp.config.json img-src with the reason in docs/architecture/how-it-is-built.md, or re-host the image through the media route.'
    );
  for (const [host, reason] of Object.entries(retired)) {
    if (allowedBy(host, sources)) {
      failures.push(
        `${host} is both retired (${reason}) and allowed by img-src; a dead host earns no entry.`
      );
    } else if (!byOrigin.has(host)) {
      failures.push(
        `Nothing references ${host} any more; remove it from RETIRED_IMAGE_HOSTS in frontend/scripts/check-image-hosts.mjs (it was kept because ${reason}).`
      );
    }
  }
  return { rows, failures };
}

/** Every file under a directory with one of the extensions, as `[relative path, text]`. */
function filesUnder(root, extensions) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.some((extension) => name.endsWith(extension))) {
        files.push([relative(root, path), readFileSync(path, 'utf8')]);
      }
    }
  };
  walk(root);
  return files;
}

/** The references in a build and its manifest, each with the file it came from. */
export function collectReferences({ dist, manifestPath }) {
  const references = [];
  let pages = 0;
  let stylesheets = 0;
  for (const [file, text] of filesUnder(dist, ['.html', '.css'])) {
    if (file.endsWith('.css')) {
      stylesheets += 1;
      for (const entry of imageSourcesInCss(text))
        references.push({ ...entry, file: `dist/${file}` });
    } else {
      pages += 1;
      for (const entry of imageSourcesInHtml(text))
        references.push({ ...entry, file: `dist/${file}` });
    }
  }
  let articles = 0;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    articles = Object.keys(manifest?.data ?? {}).length;
    for (const entry of imageSourcesInManifest(manifest)) {
      references.push({
        url: entry.url,
        where: entry.where.split(' ').pop(),
        file: entry.where.split(' ')[0],
      });
    }
  }
  return { references, pages, stylesheets, articles };
}

function main() {
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  const staged = join(dist, 'staticwebapp.config.json');
  const manifestPath = fileURLToPath(new URL('../data/content-manifest.json', import.meta.url));
  if (!existsSync(staged)) {
    console.error(
      '[check-image-hosts] dist/staticwebapp.config.json is missing. Run this after stage-swa-config.mjs, which writes it.'
    );
    process.exit(1);
  }
  const policy =
    JSON.parse(readFileSync(staged, 'utf8')).globalHeaders?.['Content-Security-Policy'] ?? '';
  const sources = imgSrcOf(policy);
  if (sources.length === 0) {
    console.error('[check-image-hosts] the staged policy has no img-src directive.');
    process.exit(1);
  }

  const { references, pages, stylesheets, articles } = collectReferences({ dist, manifestPath });
  const { rows, failures } = evaluate({ sources, references });

  console.log(
    `[check-image-hosts] ${references.length} image reference(s) in ${pages} page(s), ${stylesheets} stylesheet(s) and ${articles} article bod(ies), against img-src ${sources.join(' ')}`
  );
  for (const row of rows) {
    const note =
      row.status === 'retired'
        ? `RETIRED, tolerated: ${row.reason}`
        : row.status === 'missing'
          ? 'NOT IN img-src'
          : row.where.join(', ');
    console.log(`  ${String(row.count).padStart(5)}  ${row.origin.padEnd(46)} ${note}`);
  }
  for (const failure of failures) console.error(`::error::${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log('[check-image-hosts] every image host the build ships is in img-src');
}

// Guarded so the pure functions above can be imported by check-image-hosts.test.js
// without the import reading dist.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[check-image-hosts] ${error.message}`);
    process.exit(1);
  }
}

/**
 * Re-host the images an article body hotlinks (issue #374).
 *
 * Curated articles keep their body as ingested, upstream `<img>` and
 * `![alt](url)` references included. The cover already re-hosts — the
 * publish-time cover trigger writes to blob storage and the page serves it
 * from `/api/public/media/…` — but nothing did the same for the body, and on
 * 2026-09-06 the published-pages audit found an article whose two body images
 * loaded with zero natural width: the publisher refuses cross-site hotlinking.
 * The reader saw two empty boxes.
 *
 * WHAT THIS DOES. At publish time, every external image URL in the rendered
 * body field is fetched once through the same guarded fetcher the cover
 * mirror uses (`triggers/fetch-image.js`: protocol and private-IP checks,
 * redirect cap, size cap, timeout), stored under the article's id in the
 * public `covers` container, and the body's references are rewritten to the
 * site's own media path. A URL that cannot be fetched — or that the fetcher
 * refuses because what came back is not an image (#415) — is left exactly as
 * it was, the alt text still renders, and it is recorded on the document, so
 * the editor can see what did not come across instead of finding out from a
 * reader.
 *
 * WHY IT NEVER FAILS A PUBLISH. The image is decoration on an article that
 * passed the quality and image gates already; a publisher's hotlink policy is
 * not a reason to hold the article. Every failure is per-URL, caught, and
 * summarised in `inlineImages` on the document.
 *
 * WHY THE BLOB NAME IS A HASH OF THE URL. Re-publishing the same article must
 * not upload the same image twice, and two articles hotlinking the same asset
 * must not collide — the path is `<contentId>/inline/<sha256(url)[0:16]>.<ext>`,
 * so a republish overwrites its own copy and nothing else.
 *
 * Pure core (`findInlineImageUrls`, `rewriteBody`, `inlineBlobPath`) over an
 * injected edge (`storage.uploadBlob`, `fetchImage`), the house style in this
 * directory. `createDefaultInlineImageRehoster` in inline-images-default.js
 * wires the real edge for the three publish call sites.
 */
import { createHash } from 'node:crypto';

import { mediaUrlFor } from '../blob-paths.js';
import { isExternalUrlString, requireImageExtension } from '../triggers/fetch-image.js';
import { errorFacts } from '../http/error-response.js';

/** Public media container the re-hosted copies live in; the cover trigger's. */
export const INLINE_IMAGE_CONTAINER = 'covers';

/**
 * The body fields an article can carry, in the page's own precedence
 * (BlogDetailTemplate: `blogDraft || Content || content`). ALL of them are
 * rewritten, not just the one that renders today: on 2026-09-06 the audited
 * article held an RSS stub in `Content` and its eleven images in `content`,
 * and a step that only looked at the rendering field would have rewritten the
 * stub and left every image where it was. Rewriting each field an image
 * appears in is cheap (one fetch per distinct URL, whichever fields share it)
 * and survives an editor switching which field the page uses.
 */
export const BODY_FIELDS = Object.freeze(['blogDraft', 'Content', 'content']);

/** Hosts whose images are already ours and must not be fetched again. */
const OWN_HOSTS = new Set(['hybridcloudworks.com', 'www.hybridcloudworks.com']);

const HTML_IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// `![alt](url)` and `![alt](url "title")`. The URL stops at whitespace or the
// closing parenthesis; a nested parenthesis in a URL is rare enough that a
// miss there is a leave-alone, not a wrong rewrite.
const MARKDOWN_IMG = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Every body field this document carries as non-empty text, in precedence order. */
export function resolveBodyFields(doc = {}) {
  return BODY_FIELDS.filter((field) => typeof doc[field] === 'string' && doc[field].trim());
}

/** True for a URL the site already serves itself. */
export function isOwnMediaUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/api/public/media/')) return true;
  try {
    return OWN_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Every distinct external image URL the body references, in first-seen order.
 * Relative paths, data: URIs and the site's own media are not external and
 * are not returned.
 */
export function findInlineImageUrls(body) {
  const text = String(body ?? '');
  const found = [];
  const seen = new Set();
  const consider = (raw) => {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) return;
    if (!isExternalUrlString(url) || isOwnMediaUrl(url)) return;
    seen.add(url);
    found.push(url);
  };
  for (const match of text.matchAll(HTML_IMG_SRC)) consider(match[1] ?? match[2]);
  for (const match of text.matchAll(MARKDOWN_IMG)) consider(match[1]);
  return found;
}

/**
 * `<contentId>/inline/<sha256(url)[0:16]>.<ext>` — stable per article and URL.
 *
 * The extension comes from the type the fetcher measured, and there is no
 * default (#415): this used to fall back to `png` for anything unmapped, which
 * is how a `video/mp4` would have been stored under a name claiming to be an
 * image. A type with no extension throws rather than being named, and `one()`
 * records it as a failed image like any other.
 */
export function inlineBlobPath(contentId, url, contentType) {
  const ext = requireImageExtension(contentType);
  const digest = createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
  return `${contentId}/inline/${digest}.${ext}`;
}

/**
 * Log-safe text: every http(s) URL replaced by `[url]`. The fetcher's messages
 * embed the URL they were fetching (and, after a redirect, another one), and
 * the log must name hosts at most — never what was being read.
 *
 * A URL runs to the next blank. It used to stop at the first `)`, `'`, `"`,
 * `<` or `>` as well, and a URL may hold the first two, so the rest of one
 * (`.../a(1)/photo.png?sig=...`) stayed in the text. A bracket or quote that
 * closes around a URL now goes with it, which costs a log line nothing.
 */
export function scrubUrls(text) {
  return String(text ?? '').replace(/https?:\/\/\S+/gi, '[url]');
}

/** Origin and path of a URL, no query string or fragment; the URL itself if unparsable. */
export function sourceOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

/**
 * Replace every occurrence of each `from` with its `to`. Plain text, no regex.
 * Longest `from` first: when one URL is a prefix of another
 * (`…/img.png` and `…/img.png?size=2`), replacing the shorter one first would
 * also rewrite the head of the longer one and leave an invalid mixed URL.
 */
export function rewriteBody(body, replacements) {
  let out = String(body ?? '');
  const ordered = [...replacements].sort((a, b) => String(b.from).length - String(a.from).length);
  for (const { from, to } of ordered) {
    if (from && to && from !== to) out = out.split(from).join(to);
  }
  return out;
}

/** Every external image URL across the body fields, once each, in the order first seen. */
function uniqueImageUrls(bodies) {
  const urls = [];
  const seen = new Set();
  for (const body of Object.values(bodies || {})) {
    for (const url of findInlineImageUrls(body)) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** The host of a URL, or a placeholder when it cannot be read. */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

/**
 * A small pool: `concurrency` workers each pull the next URL until none
 * remain.
 */
async function runPool(urls, concurrency, one) {
  const queue = [...urls];
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, urls.length)) },
    async () => {
      while (queue.length) await one(queue.shift());
    }
  );
  await Promise.all(workers);
}

/** Default number of images fetched at once; see createInlineImageRehoster. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * @param {object} deps
 * @param {{ uploadBlob: Function }} deps.storage
 * @param {Function} deps.fetchImage `(url) => Promise<{ buffer, contentType } |
 *   { refused, contentType, reason }>` — see triggers/fetch-image.js. A
 *   `refused` result is a media type this site will not store; it is a value
 *   rather than a throw so this step can leave the URL alone deliberately.
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 * @param {number} [deps.concurrency] images in flight at once. Sequential
 *   fetching made the worst case N × the 15 s fetch timeout — eleven images on
 *   a slow origin would have held a publish for nearly three minutes — so a
 *   small pool bounds that without hammering the origin.
 */
export function createInlineImageRehoster({
  storage,
  fetchImage,
  log = {},
  concurrency = DEFAULT_CONCURRENCY,
}) {
  /**
   * Re-host every external image across the given body fields. A URL shared
   * by two fields is fetched and stored once.
   *
   * @param {{ contentId: string, bodies: Record<string, string> }} input
   * @returns {Promise<{ bodies: Record<string, string>, rewritten: Array<{from: string, to: string}>, failed: Array<{url: string, reason: string}> }>}
   */
  async function rehost({ contentId, bodies }) {
    const urls = uniqueImageUrls(bodies);
    const rewritten = [];
    const failed = [];
    /** Record one URL as not re-hosted and say so once, without leaking it. */
    const leaveAlone = (url, reason, forLog = scrubUrls(reason)) => {
      failed.push({ url, reason });
      // Host only, never the full URL or the document: enough to see a
      // publisher refusing us, not enough to leak what was being read.
      const host = hostOf(url);
      // The fetcher's own messages embed URLs; the log line carries none.
      log.warn?.(
        `[inlineImages] could not re-host an image from ${host}: ${forLog}`
      );
    };
    const one = async (url) => {
      try {
        const fetched = await fetchImage(url);
        // A media-type refusal is a value, not a throw (#415): the response
        // arrived and was read, it just is not an image this site serves. The
        // URL stays exactly as the body had it — the reader still gets
        // whatever the origin serves, and the alt text still renders — and the
        // remaining images carry on being re-hosted.
        // Logged as the refusal's code: the sentence quotes the remote
        // server's Content-Type (#1802). The caller still gets the sentence.
        if (fetched.refused) return leaveAlone(url, fetched.reason, fetched.refused);
        const { buffer, contentType } = fetched;
        const blobPath = inlineBlobPath(contentId, url, contentType);
        // Provenance without the query string: enough to say where the copy
        // came from, not enough to replay a signed or tracking URL.
        await storage.uploadBlob(INLINE_IMAGE_CONTAINER, blobPath, buffer, contentType, {
          metadata: { sourceUrl: sourceOf(url) },
        });
        rewritten.push({ from: url, to: mediaUrlFor(INLINE_IMAGE_CONTAINER, blobPath) });
      } catch (error) {
        // The summary keeps the reason; the log line gets the error's class and code only.
        leaveAlone(url, String(error?.message || error || 'unknown'), errorFacts(error));
      }
    };
    await runPool(urls, concurrency, one);
    // Results are re-ordered to the body's order so the summary is
    // deterministic whatever finished first.
    const order = new Map(urls.map((url, i) => [url, i]));
    rewritten.sort((a, b) => order.get(a.from) - order.get(b.from));
    failed.sort((a, b) => order.get(a.url) - order.get(b.url));
    const out = {};
    for (const [field, body] of Object.entries(bodies || {}))
      out[field] = rewriteBody(body, rewritten);
    return { bodies: out, rewritten, failed };
  }

  return { rehost };
}

/**
 * The publish-time step: the content-document update that re-hosting the
 * body fields' images produces, or null when there is nothing to do.
 *
 * Never throws. A rehoster that blows up whole (not per-URL) is logged and
 * the article publishes with its body untouched, which is what happened before
 * this step existed.
 *
 * @returns {Promise<null | { [field: string]: string, inlineImages: object }>}
 */
export async function buildInlineImageUpdate({ contentData, contentId, rehost, nowIso, log = {} }) {
  if (typeof rehost !== 'function') return null;
  const fields = resolveBodyFields(contentData).filter(
    (field) => findInlineImageUrls(contentData[field]).length > 0
  );
  if (fields.length === 0) return null;
  const bodies = Object.fromEntries(fields.map((field) => [field, contentData[field]]));
  try {
    const result = await rehost({ contentId, bodies });
    const changed = Object.fromEntries(
      fields
        .filter(
          (field) => result.bodies?.[field] !== undefined && result.bodies[field] !== bodies[field]
        )
        .map((field) => [field, result.bodies[field]])
    );
    return {
      ...changed,
      inlineImages: {
        fields,
        rewritten: result.rewritten.length,
        failed: result.failed.length,
        // Origin and path, like the blob provenance: a signed or tracking
        // query string does not belong in Cosmos either.
        failedUrls: result.failed.map((f) => sourceOf(f.url)),
        at: nowIso,
      },
    };
  } catch (error) {
    log.warn?.(
      `[inlineImages] re-hosting skipped: ${errorFacts(error)}`
    );
    return null;
  }
}

/**
 * draft-from-url.js — one URL in, a publication-shaped draft (or a forge
 * source document) out. The shared half of `generateArticleDraft` and the
 * `forge-from-url` job (Blog Machine T-602, docs/content/blog-machine.md).
 *
 * Two consumers, one scrape:
 *   - The HTTP RPC scrapes and hands the result to `createDrafter` — whose
 *     output shape the Publish-Ready Builder and the editor already expect —
 *     under the caller's 90 s client timeout (the handler enforces its own
 *     budget below that; see generate-article-draft-http.js).
 *   - The job scrapes into a `content` document shaped like the RSS ingest
 *     writes (lib/rss/feeds.js is the field-convention source), lands it
 *     `inspected` with `inspectTrigger: false` — the forge does its own
 *     drafting from source markdown, so routing it through the inspector
 *     would run two model pipelines over the same page — and lets
 *     `runForgePipeline` take it from there under the 28-minute job budget.
 *
 * `sourceUrl` is recorded on the document for admin provenance and is never
 * rendered publicly (owner decision, docs/content/blog-machine.md).
 */
import { load as loadHtml } from 'cheerio';
import { scrapeArticle } from './scrape.js';
import { normalizeSupportingDocuments, MAX_SUPPORTING_DOCUMENTS } from './drafting.js';
import { generateSlug } from '../rss/feeds.js';
import { AFTER_MODEL_MARGIN_MS, startBudgetClock } from '../ai/time-budget.js';
import { guardedFetch } from '../http/guarded-fetch.js';

/** Beyond the primary URL, at most this many extra KB articles are scraped —
 * each is a network fetch plus markdown extraction inside the HTTP budget. */
export const MAX_EXTRA_URL_SCRAPES = 3;

/** Per supporting-document fetch: bytes and time. A KB PDF larger than this
 * belongs in the upload path, which the Builder already offers. */
const DOCUMENT_FETCH_LIMIT_BYTES = 3 * 1024 * 1024;
const DOCUMENT_FETCH_TIMEOUT_MS = 15000;

export function isHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** og:title → <title> → fallback. The scraper keeps the full page head for
 * exactly this kind of read (its comment says so). */
export function extractPageTitle(html, fallback = '') {
  if (!html) return fallback;
  const $ = loadHtml(html);
  const og = $('meta[property="og:title"]').attr('content');
  const title = (og || $('title').first().text() || '').trim();
  return title.slice(0, 300) || fallback;
}

export function extractPageDescription(html) {
  if (!html) return '';
  const $ = loadHtml(html);
  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';
  return String(description).trim().slice(0, 500);
}

/** Same keyword map the Publish-Ready Builder uses client-side
 * (SubmitUrlsPage.jsx inferProviderFromUrl), capitalised to the stored
 * 'Cloud Provider' convention; 'Multi' when nothing matches. */
const URL_PROVIDER_KEYWORDS = [
  ['Azure', ['azure', 'microsoft']],
  ['Aws', ['aws', 'amazon']],
  ['Gcp', ['gcp', 'google']],
  ['Github', ['github']],
  ['Terraform', ['terraform']],
  ['Finops', ['finops']],
  // Last, as in the client's pageMeta.js: Docker on Azure is Azure.
  ['Docker', ['docker']],
];

export function inferProviderFromUrl(url = '') {
  const normalized = String(url).toLowerCase();
  const match = URL_PROVIDER_KEYWORDS.find(([, keywords]) =>
    keywords.some((keyword) => normalized.includes(keyword))
  );
  return match ? match[0] : 'Multi';
}

/**
 * Scrape one URL into the pieces both consumers need. Throws a coded error —
 * `BAD_URL` before any network touch, `SCRAPE_FAILED` with the scraper's own
 * reason after — so callers can map to 400 vs 422 without string-matching.
 */
export async function scrapeToSource(url, { scrape = scrapeArticle, env, log, resolve } = {}) {
  if (!isHttpUrl(url)) {
    const err = new Error('A valid http(s) URL is required.');
    err.code = 'BAD_URL';
    throw err;
  }
  const scraped = await scrape(String(url).trim(), { env, log, resolve });
  if (!scraped?.success || !String(scraped.markdown || '').trim()) {
    const err = new Error(`Could not extract the article: ${scraped?.error || 'empty result'}`);
    err.code = 'SCRAPE_FAILED';
    throw err;
  }
  return {
    url: String(url).trim(),
    markdown: scraped.markdown,
    title: extractPageTitle(scraped.html),
    description: extractPageDescription(scraped.html),
    images: Array.isArray(scraped.images) ? scraped.images : [],
    wordCount: scraped.wordCount || 0,
    scrapeMode: scraped.scrapeMode || null,
  };
}

/** Fetch one KB document URL server-side into a supporting-document entry
 * (PDF → base64 inlineData, text → textContent). Returns null on any
 * failure — a KB reference the model does not see degrades the draft, it
 * does not fail it. */
async function fetchDocumentUrl(url, { fetchImpl = globalThis.fetch, resolve, log = {} } = {}) {
  if (!isHttpUrl(url)) return null;
  try {
    // The URL is the caller's. guardedFetch refuses private, link-local and
    // loopback targets (and re-checks every redirect) before any byte is read
    // back into the draft (2026-10-06 review, AP-B2).
    // The byte cap and the deadline both live in the guard, and the deadline
    // covers the body: a document origin that sends headers and then stalls
    // is cut off, not waited on.
    const { response, buffer, text } = await guardedFetch(url, {
      fetch: fetchImpl,
      resolve,
      timeoutMs: DOCUMENT_FETCH_TIMEOUT_MS,
      maxBytes: DOCUMENT_FETCH_LIMIT_BYTES,
    });
    if (!response.ok) return null;
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const name = new URL(url).pathname.split('/').filter(Boolean).at(-1) || url;
    if (contentType.includes('application/pdf')) {
      return { name, mimeType: 'application/pdf', base64Data: buffer.toString('base64') };
    }
    const content = text();
    if (!content.trim()) return null;
    return { name, textContent: content.slice(0, 18000) };
  } catch (error) {
    log.warn?.(`[draft-from-url] document fetch failed for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * The `generateArticleDraft` semantics: primary URL scraped, extra KB
 * articles and server-fetched documents folded in as supporting material,
 * one drafter call out. Accepts both callers' payload dialects — the
 * Publish-Ready Builder's ({urls, customInstructionPrompt, documentUrls,
 * supportingDocuments}) and the editor's ({draftText, instructions}).
 *
 * The time budget is the second argument, not a payload field, because the
 * payload is the client's JSON body and a client must not be able to set
 * its own. The scrapes and fetches spend from it, and the drafter gets what
 * is left.
 *
 * @param {object} deps
 * @param {{ generateDraft: Function }} deps.drafter
 * @param {(url: string, opts?: object) => Promise<object>} [deps.scrape]
 * @param {typeof fetch} [deps.fetch]
 * @param {Function} [deps.resolve] - DNS resolver for the SSRF guard; tests only
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 */
export function createUrlDrafter({
  drafter,
  scrape = scrapeArticle,
  fetch: fetchImpl,
  resolve,
  env,
  log = {},
}) {
  async function draftFromUrl({
    url,
    urls = [],
    cloudProvider = null,
    customInstructionPrompt = '',
    instructions = '',
    draftText = '',
    documentUrls = [],
    supportingDocuments = [],
    usageOut = null,
  } = {}, { budgetMs = null } = {}) {
    const budgetLeft = startBudgetClock(budgetMs);
    const primary = String(url || (Array.isArray(urls) ? urls[0] : '') || '').trim();
    const source = await scrapeToSource(primary, { scrape, env, log, resolve });

    // Supporting material, in trust order, capped at the drafter's ceiling:
    // explicit uploads first, then the caller's current draft, then fetched
    // KB documents, then extra KB article scrapes.
    const documents = [...normalizeSupportingDocuments(supportingDocuments)];
    if (String(draftText || '').trim()) {
      documents.push({ name: 'Current article draft', textContent: String(draftText) });
    }
    for (const documentUrl of (Array.isArray(documentUrls) ? documentUrls : []).slice(
      0,
      MAX_SUPPORTING_DOCUMENTS
    )) {
      if (documents.length >= MAX_SUPPORTING_DOCUMENTS) break;
      const fetched = await fetchDocumentUrl(documentUrl, { fetchImpl, resolve, log });
      if (fetched) documents.push(fetched);
    }
    const extraUrls = (Array.isArray(urls) ? urls : [])
      .map((u) => String(u || '').trim())
      .filter((u) => u && u !== source.url)
      .slice(0, MAX_EXTRA_URL_SCRAPES);
    for (const extraUrl of extraUrls) {
      if (documents.length >= MAX_SUPPORTING_DOCUMENTS) break;
      try {
        const extra = await scrapeToSource(extraUrl, { scrape, env, log, resolve });
        documents.push({
          name: `KB article: ${extra.title || extraUrl}`,
          textContent: extra.markdown,
        });
      } catch (error) {
        log.warn?.(`[draft-from-url] extra scrape failed for ${extraUrl}: ${error.message}`);
      }
    }

    const mergedInstructions = [customInstructionPrompt, instructions]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .join('\n\n');

    const provider = cloudProvider || inferProviderFromUrl(source.url);
    const parsed = await drafter.generateDraft({
      url: source.url,
      cloudProvider: provider,
      scrapedTitle: source.title,
      description: source.description,
      markdown: source.markdown,
      customInstructionPrompt: mergedInstructions,
      supportingDocuments: normalizeSupportingDocuments(documents),
      usageOut,
      budgetMs: budgetLeft(),
    });

    return {
      draft: {
        ...parsed,
        sourceUrls: [source.url, ...extraUrls],
      },
    };
  }

  return { draftFromUrl };
}

/** How long the HTTP handler lets one draft take. The client aborts at 90 s
 * (frontend lib/api.js pins generateArticleDraft to 90000), so answering at
 * 75 s returns a real error the UI can show instead of a dead socket; the
 * unattended path with no such ceiling is the forge-from-url job.
 *
 * The same budget, less AFTER_MODEL_MARGIN_MS, is handed down to the AI
 * router, so a slow first provider fails over inside it (router.js header,
 * SYNCHRONOUS CALLS HAVE A TIME BUDGET). The race in `withBudget` stays as
 * the backstop for a scrape that hangs. sync-budgets.test.js pins both
 * numbers against the client's. */
export const DRAFT_HTTP_BUDGET_MS = 75000;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const STATUS_BY_CODE = {
  BAD_URL: 400,
  SCRAPE_FAILED: 422,
  DRAFT_BUDGET_EXCEEDED: 504,
  AI_BUDGET_EXHAUSTED: 504,
};

function withBudget(promise, budgetMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `Draft generation exceeded ${Math.round(budgetMs / 1000)} s. Try again, trim the supporting material, or use the queue's Forge-from-URL box, which runs without a browser timeout.`
      );
      err.code = 'DRAFT_BUDGET_EXCEEDED';
      reject(err);
    }, budgetMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * POST /api/generateArticleDraft — the HTTP shape over `draftFromUrl`.
 * Editor-gated like every content RPC; errors map by code (400 bad input,
 * 422 unscrapeable page, 504 budget, 502 generation) so the Builder shows
 * the real reason rather than a generic failure.
 */
export function createGenerateArticleDraftHandler({
  guard,
  urlDrafter,
  budgetMs = DRAFT_HTTP_BUDGET_MS,
}) {
  return async function generateArticleDraft(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { ok: false, error: 'A JSON body is required.' });
    }
    try {
      const result = await withBudget(
        urlDrafter.draftFromUrl(body, { budgetMs: budgetMs - AFTER_MODEL_MARGIN_MS }),
        budgetMs
      );
      return json(200, { ok: true, ...result });
    } catch (error) {
      const status = STATUS_BY_CODE[error?.code] || 502;
      context?.error?.(`[generateArticleDraft] ${error?.message || error}`);
      return json(status, { ok: false, error: String(error?.message || error) });
    }
  };
}

/**
 * The forge-from-url source document: the RSS ingest's field conventions
 * (dual-cased body, 'Cloud Provider', sourceUrl, storageCollection) with the
 * differences that matter spelled out — `inspected` + `inspectTrigger: false`
 * so the change-feed inspector does not race the forge over the same page,
 * and `source: 'forge-url'` so provenance survives into the queue badges.
 */
export function buildUrlSourceDoc({ source, provider, now = () => new Date(), uuid }) {
  const stamp = now().toISOString();
  const title = source.title || `Article from ${new URL(source.url).hostname}`;
  return {
    id: uuid(),
    'Created At': stamp,
    Author: 'Hybrid Cloud Works',
    'Cloud Provider': provider,
    Title: title,
    Content: source.markdown,
    content: source.markdown,
    Summary: source.description || '',
    Slug: generateSlug(title),
    Live: false,
    Status: 'Draft',
    Tags: [],
    source: 'forge-url',
    sourceTrustLevel: 'manual',
    trustedSource: true,
    sourceUrl: source.url,
    storageCollection: 'content',
    approvedForNews: false,
    contentStatus: 'inspected',
    inspectTrigger: false,
    contentImageUrl: source.images?.[0]?.src || source.images?.[0] || '',
    scrapeMode: source.scrapeMode || null,
    fetchedAt: stamp,
    updatedAt: stamp,
  };
}

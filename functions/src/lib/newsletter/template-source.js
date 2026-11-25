/**
 * template-source.js — fetching the owner's chosen Resend template (#557).
 *
 * `GET /templates/{id}` through resend-client.js, behind a short in-process
 * cache: the issue page re-renders its preview on every read and edit, and a
 * Resend round trip each time would be slow and spend the team's rate limit.
 * Five minutes per template id, and the whole cache is dropped whenever a
 * different template id is selected (settings saved with another template, or
 * read by a handler after another instance saved one), so choosing a template
 * takes effect on the next preview.
 *
 * Only a PUBLISHED template with HTML is cached. A failure is never cached, so
 * publishing the template in Resend is picked up on the next request.
 *
 * Every answer is `{ html }` or `{ problem: { code, message } }` and nothing
 * throws: the caller decides whether a problem means "show the built-in
 * design" (preview, test send) or "refuse" (approve). `code` is fixed text,
 * safe for a log line; `message` is for the owner and never carries Resend's
 * own sentence, which could echo the template.
 */
import { createResendClient } from './resend-client.js';
import { templateUnusableReason } from './template-layout.js';

export const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;
/** A bound on memory; only one template is ever selected at a time. */
const MAX_CACHED_TEMPLATES = 10;

/**
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createTemplateCache({ ttlMs = TEMPLATE_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  let selected;
  return {
    get(templateId) {
      const entry = entries.get(templateId);
      if (!entry) return null;
      if (now() - entry.at >= ttlMs) {
        entries.delete(templateId);
        return null;
      }
      return entry.html;
    },
    set(templateId, html) {
      if (!entries.has(templateId) && entries.size >= MAX_CACHED_TEMPLATES) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(templateId, { html, at: now() });
    },
    /** The template id now chosen in settings; a different one empties the cache. */
    select(templateId) {
      if (templateId === selected) return;
      entries.clear();
      selected = templateId;
    },
    get size() {
      return entries.size;
    },
  };
}

/** The process's cache, shared by the issue routes and the settings save. */
export const sharedTemplateCache = createTemplateCache();

const problem = (code, message) => ({ problem: { code, message } });

/** Why Resend's answer gives no usable template, or null when it holds published HTML. */
function templateProblem(result) {
  if (result.status === 0) {
    return problem('TEMPLATE_FETCH_FAILED', 'Resend did not answer when the template was requested.');
  }
  if (result.status === 404) {
    return problem('TEMPLATE_NOT_FOUND', 'The chosen template no longer exists in Resend.');
  }
  if (!result.ok) {
    return problem('TEMPLATE_FETCH_FAILED', `Resend refused the template request (HTTP ${result.status}).`);
  }
  return publishedProblem(result.data);
}

/** Why a fetched template cannot be used: not published, or no HTML; null when it can. */
function publishedProblem(data) {
  const status = typeof data?.status === 'string' ? data.status.trim().toLowerCase() : '';
  if (status !== 'published') {
    return problem('TEMPLATE_NOT_PUBLISHED', 'The chosen template is not published in Resend. Publish it, then try again.');
  }
  const html = data?.html;
  if (typeof html !== 'string' || !html.trim()) {
    return problem('TEMPLATE_NOT_HTML', 'The chosen template has no HTML.');
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.templateId a validated Resend template id
 * @param {string|null|undefined} options.apiKey
 * @param {typeof fetch} [options.fetch]
 * @param {ReturnType<typeof createTemplateCache>} [options.cache]
 * @returns {Promise<{ html: string } | { problem: { code: string, message: string } }>}
 */
export async function loadTemplateHtml({ templateId, apiKey, fetch: fetchImpl, cache = sharedTemplateCache }) {
  cache.select(templateId);
  if (!apiKey) {
    return problem('RESEND_NOT_CONFIGURED', 'Resend is not configured: RESEND_API_KEY is not set.');
  }
  const cached = cache.get(templateId);
  if (cached !== null) return { html: cached };

  let result;
  try {
    result = await createResendClient({ apiKey, fetch: fetchImpl }).getTemplate(templateId);
  } catch {
    result = { ok: false, status: 0, data: null };
  }
  const refusal = templateProblem(result);
  if (refusal) return refusal;
  const html = result.data.html;
  // Only a template the layout can use is held. An unusable one (no body
  // marker, the marker twice, oversized) is returned so the caller can say why,
  // but not cached: the owner's fix in Resend must show on the next request,
  // not five minutes later.
  if (!templateUnusableReason(html)) cache.set(templateId, html);
  return { html };
}

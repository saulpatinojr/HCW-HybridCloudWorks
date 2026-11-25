/** Reading Cloudflare's account audit log for the DNS audit, page by page (cloudflare-dns-audit.mjs). */
import { API_BASE, AuditReadError, MAX_PAGES, PAGE_LIMIT } from './dns-audit-settings.mjs';
import { str } from './dns-audit-entries.mjs';

/** The list URL for one page. `since`/`before` are RFC3339 strings. */
export function auditLogUrl({ accountId, since, before, cursor }) {
  const url = new URL(`${API_BASE}/accounts/${encodeURIComponent(accountId)}/logs/audit`);
  url.searchParams.set('since', since);
  url.searchParams.set('before', before);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('direction', 'asc');
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

/** The `errors[].message` lines of a Cloudflare envelope, or nothing; never the body itself. */
function envelopeErrors(doc) {
  if (!doc || !Array.isArray(doc.errors)) return '';
  const messages = doc.errors.map((e) => str(e?.message)).filter(Boolean);
  return messages.length ? ` (${messages.join('; ')})` : '';
}

/**
 * Read the whole window, following `result_info.cursor`. Returns
 * `{ entries, pages }` or throws AuditReadError with a content-free reason.
 */
export async function fetchAuditLog({ accountId, since, before, token, fetchImpl = fetch }) {
  const entries = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = auditLogUrl({ accountId, since, before, cursor });
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AuditReadError(`page ${page}: the request failed (${error?.message ?? error})`);
    }
    const text = await response.text();
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    if (!response.ok) {
      throw new AuditReadError(`page ${page}: HTTP ${response.status}${envelopeErrors(doc)}`);
    }
    if (!doc || doc.success !== true || !Array.isArray(doc.result)) {
      throw new AuditReadError(`page ${page}: the answer is not the \`success: true\` envelope with a \`result\` array${envelopeErrors(doc)}`);
    }
    entries.push(...doc.result);
    const next = str(doc.result_info?.cursor);
    if (!next || doc.result.length === 0) return { entries, pages: page };
    if (seen.has(next)) throw new AuditReadError(`page ${page}: the cursor repeated; refusing to loop`);
    seen.add(next);
    cursor = next;
  }
  throw new AuditReadError(`more than ${MAX_PAGES} pages of ${PAGE_LIMIT} in the window; narrow it with --since and --before`);
}

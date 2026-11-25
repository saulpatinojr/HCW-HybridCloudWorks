/** The deployed-site smoke test's tiny check runner and the assertions its checks share (smoke-deployed.mjs). */

// ── tiny check runner ────────────────────────────────────────────────────────

export const results = [];
export const record = (tier, name, ok, detail = '') => {
  results.push({ tier, name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
};

export async function check(tier, name, fn) {
  try {
    const detail = await fn();
    record(tier, name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(tier, name, false, err?.message || String(err));
  }
}
// ── assertion helpers (exported for the unit test) ───────────────────────────

/** Mirrors the server's isPublicDocument: a leak here is T-201/T-206 broken. */
export function looksPublic(doc = {}) {
  const status = String(doc.contentStatus || '');
  return (
    doc.Live === true ||
    doc.Status === 'Live' ||
    ['published', 'published_blog', 'published_news', 'published_both'].includes(status)
  );
}

/** Body fields the T-206 projection must keep out of LIST responses. */
export const LIST_MUST_NOT_CARRY = [
  'content',
  'Content',
  'postContent',
  'blogDraft',
  'overviewHtml',
  'codeSnippet',
  'commandExample',
  'sidebarContent',
];

export function looksValidEstate(body) {
  if (!body || typeof body.configured !== 'boolean') return false;
  if (!body.configured) return true;
  return Boolean(body.arc && body.agent && body.coder);
}

export function looksValidCoderStatus(body) {
  if (!body || typeof body.configured !== 'boolean') return false;
  if (!body.configured) return true;
  return typeof body.reachable === 'boolean';
}

export function projectionLeaks(item = {}) {
  return LIST_MUST_NOT_CARRY.filter((f) => f in item);
}

export const expectStatus = (res, wanted) => {
  if (res.status !== wanted) {
    throw new Error(`expected HTTP ${wanted}, got ${res.status}`);
  }
};

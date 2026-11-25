/** Reading HCP Terraform's applies, whose windows explain the Terraform token's DNS edits (cloudflare-dns-audit.mjs). */
import { APPLY_END_STAMPS, APPLY_LEAD_MS, APPLY_TAIL_MS, AuditReadError, MAX_RUN_PAGES, TFC_API, TFC_ORGANIZATION, TFC_WORKSPACE } from './dns-audit-settings.mjs';
import { str } from './dns-audit-entries.mjs';

/** One JSON:API GET against HCP Terraform; every failure is an AuditReadError, because an unread run record cannot clear a change. */
async function tfcGet(path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${TFC_API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.api+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AuditReadError(`HCP Terraform ${path}: the request failed (${error?.message ?? error})`);
  }
  const text = await response.text();
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = null;
  }
  if (!response.ok) throw new AuditReadError(`HCP Terraform ${path}: HTTP ${response.status}`);
  if (!doc || typeof doc !== 'object') throw new AuditReadError(`HCP Terraform ${path}: the answer is not JSON`);
  return doc;
}

/**
 * The applies of the workspace that touch the window: `[{ runId, start, end,
 * outcome }]` with epoch milliseconds, from HCP Terraform's own run record.
 * Every run whose apply BEGAN counts, whatever became of it: `start` is
 * `applying-at`, and `end` the first of APPLY_END_STAMPS that is set, or the
 * end of the window for an apply still running. An apply that errored or was
 * cancelled wrote records until it stopped (the 2026-10-06 and 2026-10-10
 * edits on the first live runs were exactly those), so `filter[status]=applied`
 * would hide the very applies that explain them. Plan-only runs carry no
 * `applying-at` and are skipped. Read newest first, every status, and stopped
 * once a page was created wholly before the window.
 */
export async function fetchTerraformApplies({ token, since, before, fetchImpl = fetch }) {
  const ws = await tfcGet(`/organizations/${TFC_ORGANIZATION}/workspaces/${TFC_WORKSPACE}`, token, fetchImpl);
  const workspaceId = str(ws?.data?.id);
  if (!workspaceId) throw new AuditReadError(`HCP Terraform returned no id for workspace ${TFC_ORGANIZATION}/${TFC_WORKSPACE}`);
  const sinceMs = Date.parse(since) - APPLY_TAIL_MS;
  const beforeMs = Date.parse(before) + APPLY_LEAD_MS;
  const windows = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const doc = await tfcGet(`/workspaces/${workspaceId}/runs?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`, token, fetchImpl);
    if (!Array.isArray(doc.data)) throw new AuditReadError('HCP Terraform returned a runs payload without a `data` array');
    let oldestOnPage = Number.POSITIVE_INFINITY;
    for (const run of doc.data) {
      const created = Date.parse(str(run?.attributes?.['created-at']));
      if (!Number.isNaN(created)) oldestOnPage = Math.min(oldestOnPage, created);
      const apply = applyWindowOf(run, beforeMs);
      if (apply && apply.end >= sinceMs && apply.start <= beforeMs) windows.push(apply);
    }
    if (isLastRunsPage(doc, oldestOnPage, sinceMs)) return windows;
  }
  throw new AuditReadError(`more than ${MAX_RUN_PAGES} pages of runs in the window; narrow it with --since and --before`);
}

/**
 * One run's apply as `{ runId, start, end, outcome }`, or null for a run that
 * never applied (a plan, a discard, a run still waiting) or whose end cannot
 * be read. An apply still running ends at `beforeMs`.
 */
function applyWindowOf(run, beforeMs) {
  const a = run?.attributes ?? {};
  const stamps = a['status-timestamps'] ?? {};
  const start = Date.parse(str(stamps['applying-at']));
  if (Number.isNaN(start)) return null;
  const endStamp = APPLY_END_STAMPS.find((k) => str(stamps[k]) !== '');
  const end = endStamp ? Date.parse(str(stamps[endStamp])) : beforeMs;
  if (Number.isNaN(end)) return null;
  return { runId: str(run.id), start, end, outcome: str(a.status) || 'unknown' };
}

/** Whether no page follows this one, or this page was created wholly before the window. */
function isLastRunsPage(doc, oldestOnPage, sinceMs) {
  const nextPage = doc.meta?.pagination?.['next-page'];
  return doc.data.length === 0 || nextPage === null || nextPage === undefined || oldestOnPage < sinceMs;
}

/** Reading Azure Resource Manager (ARM) for verify-alert-state.mjs: one read, its pages, and how a failed read is classified. */
import { ARM } from './alert-state-expected.mjs';
import { execSync } from 'node:child_process';
import { redact } from './plan-report.mjs';

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

/**
 * How an ARM error is classified, in the order the tests are tried; anything
 * none of them matches is `failed`.
 */
const ERROR_CLASSES = [
  ['unauthenticated', (status) => status === 401],
  // A provider the subscription has not registered. Resource Health answers
  // this as 409 AuthError, "Make sure the resource provider has been
  // registered with this subscription" (sub-plat-mgmt-prod-cus, 2026-10-15);
  // ARM's own spelling is the code MissingSubscriptionRegistration. The
  // message counts only in that measured shape: a 403 AuthorizationFailed
  // whose text happens to name registration is still a refusal, and its fix
  // is the role, not the provider.
  [
    'not-registered',
    (status, code, message) =>
      /^MissingSubscriptionRegistration$/i.test(code) ||
      (status === 409 && /^AuthError$/i.test(code) && /resource provider has been registered/i.test(message)),
  ],
  ['denied', (status, code) => status === 403 || /AuthorizationFailed/i.test(code)],
  ['group-not-found', (status, code) => status === 404 && /ResourceGroupNotFound/i.test(code)],
  ['not-found', (status) => status === 404],
];

/** Turn an ARM error response into a classified, publishable reason. */
export function classifyError(status, body) {
  const code = body?.error?.code ?? body?.code ?? '';
  const message = body?.error?.message ?? body?.message ?? '';
  const reason = redact(`HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`).slice(0, 300);
  const matched = ERROR_CLASSES.find(([, test]) => test(status, code, message));
  return { status: matched ? matched[0] : 'failed', reason };
}

/**
 * GET an ARM URL, following `nextLink` while it stays on the ARM host.
 *
 * The host check is not decoration: the next page is requested with the
 * same bearer token, and a link that pointed anywhere else would hand it
 * over. A link that leaves ARM ends the read as a failure.
 */
export async function armGet(path, { token, fetchImpl = fetch, list = false }) {
  let url = `${ARM}${path}`;
  const rows = [];
  for (let page = 0; url; page += 1) {
    const read = await readPage(url, page, { token, fetchImpl, list });
    if (read.result) return read.result;
    rows.push(...read.rows);
    url = read.next;
  }
  return { status: 'ok', rows };
}

/** Why the next page is not requested at all, or null when it may be. */
function pageRefusal(url, page) {
  if (page >= 50) return 'more than 50 pages; refusing to keep paging';
  if (!url.startsWith(`${ARM}/`)) return 'nextLink left management.azure.com';
  return null;
}

/**
 * One page of an ARM read: `{ result }` when the read ends here (a refusal, a
 * failure, or a single object), else `{ rows, next }` for a list page.
 */
async function readPage(url, page, { token, fetchImpl, list }) {
  const refusal = pageRefusal(url, page);
  if (refusal) return { result: { status: 'failed', reason: refusal } };
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    return { result: { status: 'failed', reason: redact(`request failed: ${err?.message ?? err}`) } };
  }
  const body = await res.json().catch(() => null);
  return pageResult(res, body, list);
}

function pageResult(res, body, list) {
  if (!res.ok) return { result: classifyError(res.status, body) };
  if (!list) return { result: { status: 'ok', body } };
  if (!Array.isArray(body?.value)) return { result: { status: 'failed', reason: 'response carried no value array' } };
  return { rows: body.value, next: body.nextLink ?? null };
}

/** One live rule, normalised across the three ARM shapes. */
export function normaliseRule(armType, row) {
  const p = row?.properties ?? {};
  let actionGroupIds;
  if (armType === 'Microsoft.Insights/scheduledQueryRules') {
    actionGroupIds = p.actions?.actionGroups ?? [];
  } else if (armType === 'Microsoft.Insights/metricAlerts') {
    actionGroupIds = (p.actions ?? []).map((a) => a.actionGroupId);
  } else {
    actionGroupIds = (p.actions?.actionGroups ?? []).map((a) => a.actionGroupId);
  }
  return {
    name: row?.name ?? '(unnamed)',
    armType,
    enabled: p.enabled,
    autoMitigate: p.autoMitigate,
    actionGroupIds: actionGroupIds.filter((id) => typeof id === 'string'),
    severity: p.severity,
    evaluationFrequency: p.evaluationFrequency,
    windowSize: p.windowSize,
    muteActionsDuration: p.muteActionsDuration,
  };
}

/** A token for ARM from the signed-in az session. Throws when there is none. */
export function azAccessToken(exec = execSync) {
  // A fixed command with no interpolated value, so the shell execSync uses
  // (needed on Windows, where az is az.cmd) has nothing to misread.
  const out = exec('az account get-access-token --resource https://management.azure.com/ -o json --only-show-errors', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const token = JSON.parse(out).accessToken;
  if (!token) throw new Error('az returned no accessToken');
  return token;
}

/**
 * Subscription ids the workflow names outright, as `display-name=guid` pairs
 * separated by commas (ALERT_SUBSCRIPTION_IDS in verify-alert-state.yml).
 *
 * WHY (CodeRabbit on #1053): the ids otherwise come only from
 * `GET /subscriptions`, which lists the subscriptions the caller can see.
 * github_alert_reader holds one custom role at resource-group scope and no
 * subscription-level read, and whether that alone puts a subscription in the
 * list is not something Microsoft documents. Naming the ids means the rule
 * reads never depend on it: a subscription the list leaves out is still read
 * at the groups the identity was granted. Each entry is held to a name and a
 * GUID before it reaches a path; anything else stops the check (exit 2)
 * rather than being skipped.
 *
 * @returns {Map<string, string>} display name -> subscription id
 */
export function knownSubscriptionIds(text) {
  const known = new Map();
  for (const entry of String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9-]+)=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(entry);
    if (!m) throw new Error(`ALERT_SUBSCRIPTION_IDS holds an entry that is not display-name=GUID: ${redact(entry).slice(0, 80)}`);
    known.set(m[1], m[2].toLowerCase());
  }
  return known;
}

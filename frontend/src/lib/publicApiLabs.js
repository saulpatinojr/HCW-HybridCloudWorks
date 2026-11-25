/**
 * The public calls behind the Hybrid Lab pages: the estate and Coder status,
 * add-on status, validation jobs and visitor sessions. Split out of
 * publicApi.js, which re-exports everything here.
 */
import { requireFunctionsBase } from '@/lib/functionsBase';
import { publicGet } from './publicApiGet';

/**
 * A labs status body has a boolean `configured` or it is not one. The two
 * routes below answer `{ configured: false }` when the thing they describe
 * has not been provisioned, so the flag is the one field a caller can rely
 * on; a body without it is a different route wearing the same path.
 */
function requireConfiguredFlag(body, what) {
  if (!body || typeof body !== 'object' || typeof body.configured !== 'boolean') {
    throw new Error(`${what} response carried no configured flag`);
  }
  return body;
}

/**
 * GET public/labs/estate — the live view of the Hybrid Lab host (#664):
 * `{ configured: false }` until the resource group exists, otherwise
 * `{ configured: true, arc: { status, statusSince, agentVersion, osName },
 * policy: { compliant, nonCompliant, notApplicable } | null,
 * agent: { online, queued, lastHeartbeatAt } | null,
 * coder: { reachable, running, max } | null, asOf }`. `statusSince` is when
 * Arc's status last changed, not a heartbeat; `agent.lastHeartbeatAt` is the
 * job runner's, null unless it is online (#1009). Read through the
 * Function App's managed identity and cached a minute server-side; the
 * browser never talks to Azure.
 *
 * Returns null only when the route itself is missing (404), which the card
 * renders as its own sentence rather than as "not provisioned" — the two are
 * different facts. Throws with the server's sentence otherwise, like
 * `fetchCloudPricing`.
 *
 * @returns {Promise<object|null>}
 */
export async function fetchLabsEstate() {
  const body = await publicGet('public/labs/estate');
  if (!body) return null;
  return requireConfiguredFlag(body, 'Labs estate');
}

/**
 * GET public/labs/coder-status — Coder's state through the server-side proxy
 * (#680): `{ configured: false }` without a `CODER_URL`, otherwise
 * `{ configured: true, reachable, templates: [{ name, activeVersion }],
 * capacity: { running, max }, asOf }`. `reachable: false` is a cached
 * failure and means the card must say "unreachable", not show numbers.
 *
 * Same null-on-404 and throw-otherwise contract as `fetchLabsEstate`.
 *
 * @returns {Promise<object|null>}
 */
export async function fetchCoderStatus() {
  const body = await publicGet('public/labs/coder-status');
  if (!body) return null;
  return requireConfiguredFlag(body, 'Coder status');
}

/**
 * GET public/addons/{id}/status — one AddOn's state through the server-side
 * proxy (ADR 0035 decision 4): `{ configured: false }` while its
 * `ADDON_<ID>_URL` setting is unset, otherwise `{ configured: true,
 * reachable, version, edition, capabilities, asOf }`. The pane at
 * `/tools/<id>` opens only on `configured` and `reachable` both true.
 *
 * Same null-on-404 and throw-otherwise contract as `fetchCoderStatus`; an
 * id the registry does not name answers 404, so it reads as null.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function fetchAddonStatus(id) {
  const body = await publicGet(`public/addons/${encodeURIComponent(id)}/status`);
  if (!body) return null;
  return requireConfiguredFlag(body, 'Add-on status');
}

/**
 * GET public/labs/submit — whether the lab would take a public job now
 * (#672): `{ configured, open, code, reason, bounds }`. `open` is false while
 * public submission is switched off (`code: 'PUBLIC_SUBMISSION_CLOSED'`),
 * while no lab agent is online, while the queue is full, and when the server
 * could not tell; the Validate on the lab button maps `code` to its own line
 * (labValidateRules.js) and never shows `reason`. Through the same short-lived GET cache
 * as the other public reads, so a page that mounts twice asks once.
 *
 * Returns null only when the route itself is missing (404); throws when the
 * body carries no boolean `open`, so a caller can never read "open" out of
 * a response that did not say it.
 *
 * @returns {Promise<{ configured: boolean, open: boolean, code: string|null, reason: string|null, bounds?: object }|null>}
 */
export async function fetchLabSubmissionStatus() {
  const body = await publicGet('public/labs/submit');
  if (!body) return null;
  const checked = requireConfiguredFlag(body, 'Lab submission status');
  if (typeof checked.open !== 'boolean') {
    throw new Error('Lab submission status response carried no open flag');
  }
  return checked;
}

/**
 * A failed lab call as an Error carrying the server's status and code; the page words it from the code.
 * The message is the server's `error`, or its `reason` (the visitor session routes answer a
 * refusal with a sentence for the visitor in `reason`, #1464), and only then the HTTP status.
 */
async function labError(res, what) {
  const data = await res.json().catch(() => ({}));
  const sentence = [data.error, data.reason].find(
    (value) => typeof value === 'string' && value.trim()
  );
  const error = new Error(sentence || `${what} failed with HTTP ${res.status}`);
  error.status = res.status;
  error.code = typeof data.code === 'string' ? data.code : null;
  return error;
}

/**
 * POST public/labs/submit — queue one `terraform-validate` job on the lab
 * (#672). The body is `{ type: 'terraform-validate', payload, payloadEncoding
 * }`, built by lib/landingZone/labPayload.js from the builder's own files;
 * the server caps the payload at 64 KB and owns every other bound (two an
 * hour per visitor, fifty a day, the queue ceiling, the switch). Resolves to
 * `{ jobId, type, status }`; throws with `status` and `code` so the button
 * can say which bound refused it. Never cached and never retried here.
 *
 * @param {{ type: string, payload: string, payloadEncoding: string }} body
 * @returns {Promise<{ ok: true, jobId: string, type: string, status: string }>}
 */
export async function submitLabValidation(body) {
  const base = requireFunctionsBase('public/labs/submit');
  const res = await fetch(`${base}/public/labs/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await labError(res, 'Lab submission');
  const data = await res.json();
  if (typeof data.jobId !== 'string' || !data.jobId) {
    throw new Error('Lab submission response carried no job id');
  }
  return data;
}

/**
 * GET public/labs/job?jobId= — one public job's status and visitor report
 * (#672): `{ id, type, status, exitCode, report, createdAt, claimedAt,
 * finishedAt }`, `report` null until the job ends (never the job's raw
 * output; labValidateRules.js `visitorReport` reads it).
 * Uncached, because the point of the call is to see the status move. A job
 * the server does not know, or no longer keeps (a day after it finished), is
 * a 404 and throws like any other refusal.
 *
 * @param {string} jobId
 * @returns {Promise<object>}
 */
export async function fetchPublicLabJob(jobId) {
  const path = `public/labs/job?${new URLSearchParams({ jobId })}`;
  const base = requireFunctionsBase(path);
  const res = await fetch(`${base}/${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await labError(res, 'Lab job read');
  const data = await res.json();
  if (!data.job || typeof data.job.status !== 'string') {
    throw new Error('Lab job response carried no job');
  }
  return data.job;
}

/**
 * GET public/labs/visitor-session — check if visitor lab sessions are configured/open,
 * active session for this client, and bounds (#1016).
 *
 * @returns {Promise<{ configured: boolean, open: boolean, code: string, reason: string, session?: object|null, bounds?: object }|null>}
 */
export async function fetchVisitorSessionStatus() {
  const base = requireFunctionsBase('public/labs/visitor-session');
  const res = await fetch(`${base}/public/labs/visitor-session`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await labError(res, 'Visitor session status');
  const data = await res.json();
  return requireConfiguredFlag(data, 'Visitor session status');
}

/**
 * POST public/labs/visitor-session — request an ephemeral visitor lab session (#1016).
 * A refusal throws with `status`, `code` and the server's sentence as the message: 409
 * `VISITOR_START_IN_PROGRESS` (a start of this visitor is still being set up, so wait and read
 * the status again), 429 `TURNSTILE_RATE_LIMITED` or `VISITOR_RATE_LIMITED`, 503
 * `LAB_CAPACITY_REACHED`, and so on.
 *
 * @param {{ labId: string, turnstileToken: string }} body
 * @returns {Promise<{ ok: true, sessionId: string, labId: string, accessUrl: string, expiresAt: string }>}
 */
export async function startVisitorSession(body) {
  const base = requireFunctionsBase('public/labs/visitor-session');
  const res = await fetch(`${base}/public/labs/visitor-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await labError(res, 'Start visitor session');
  const data = await res.json();
  if (typeof data.sessionId !== 'string' || !data.sessionId) {
    throw new Error('Visitor session response carried no session id');
  }
  return data;
}

/**
 * DELETE public/labs/visitor-session?sessionId=... — stop/terminate a visitor lab session (#1016).
 * The answer is `{ ok, status: 'ended', cleanup }`: `cleanup` says whether the lab is gone
 * (`done`), will be removed by a later try (`pending`), or needs a person (`failed`). The visitor
 * is done with the session in every case (#1403, item 7).
 *
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, status: string, cleanup?: 'done' | 'pending' | 'failed' }>}
 */
export async function stopVisitorSession(sessionId) {
  const path = `public/labs/visitor-session?${new URLSearchParams({ sessionId })}`;
  const base = requireFunctionsBase(path);
  const res = await fetch(`${base}/${path}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw await labError(res, 'Stop visitor session');
  return res.json();
}

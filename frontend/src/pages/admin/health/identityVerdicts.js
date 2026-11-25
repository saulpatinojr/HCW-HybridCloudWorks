/**
 * The pure halves of the Health page's on-demand checks: decoding and
 * summarising the session's token, comparing it with the admin registry,
 * judging the Labs probes, and the plain-text report. No request is made here.
 * Moved out of probes.jsx, which re-exports them, when that file grew too
 * long; what may and may not be shown is described at the top of probes.jsx.
 */

// ── Pure helpers (exported for the tests) ─────────────────────────────────────

/** The job the Labs console submits in its default state. */
export const LABS_PROBE_JOB = Object.freeze({ type: 'shell-echo', payload: '' });

/**
 * Job states in which the probe is demonstrably not hung: it either finished,
 * or an agent has it. `queued` is the one state that says nothing.
 */
const SETTLED_JOB_STATUSES = new Set([
  'claimed',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
]);

/**
 * Decode a JWT payload without verifying it. Verification is the API's job;
 * this only needs to read what the browser is already holding.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * `exp` as a relative time. Seconds since the epoch, per RFC 7519.
 *
 * @param {number} expSeconds
 * @param {number} nowMs
 * @returns {{ label: string, expired: boolean|null }}
 */
export function relativeExpiry(expSeconds, nowMs = Date.now()) {
  if (!Number.isFinite(expSeconds)) return { label: 'no exp claim', expired: null };
  const delta = Math.round(expSeconds - nowMs / 1000);
  const abs = Math.abs(delta);
  let unit;
  if (abs < 60) unit = `${abs} s`;
  else if (abs < 3600) unit = `${Math.floor(abs / 60)} min`;
  else unit = `${(abs / 3600).toFixed(1)} h`;
  return delta >= 0
    ? { label: `in ${unit}`, expired: false }
    : { label: `${unit} ago`, expired: true };
}

/**
 * Do an `aud` value and an `azp` value name the same app registration?
 *
 * A v2 access token puts the resource's bare client-id GUID in `aud`; a v1 one
 * puts the App ID URI, `api://<guid>`. `azp` is always the bare GUID. Comparing
 * them raw would call `api://X` and `X` different apps, and report the SPA and
 * the API as separate registrations when they are in fact the one registration
 * — a false PASS on the check that exists to catch exactly that.
 */
function sameApp(audience, azp) {
  const bare = (value) =>
    String(value)
      .replace(/^api:\/\//i, '')
      .toLowerCase();
  return bare(audience) === bare(azp);
}

/**
 * Reduce a decoded token to what may be shown. Claim names, and the values of
 * `aud`, `roles`, `exp` and `tid` — nothing that identifies the person.
 *
 * Every comparison is exact equality on each value, because that is what the
 * verifier does: an `aud` that differs from ENTRA_API_AUDIENCE by so much as
 * a scheme prefix is a 401, and the App Role value is compared as a
 * case-sensitive string. `aud` may be a string or an array (RFC 7519 §4.1.3);
 * jsonwebtoken accepts an array when any element equals the expected
 * audience, so the check here is membership, not equality on a joined string.
 *
 * @param {object|null} payload
 * @param {{ expectedAudience?: string, tenantId?: string, adminAppRole?: string }|null} expectations
 * @param {number} [nowMs]
 */
/** A string claim, or null when it is absent or not a string. */
const stringOrNull = (value) => (typeof value === 'string' ? value : null);

/**
 * `azp` (v2) or `appid` (v1) — the client that ASKED for this token, as
 * distinct from `aud`, the API it is for.
 */
const requestingClient = (payload) => stringOrNull(payload.azp) ?? stringOrNull(payload.appid);

/** `test(want)` when the API gave an expectation; null (cannot compare) when it did not. */
const compareIfExpected = (want, test) => (want ? test(want) : null);

export function summarizeToken(payload, expectations, nowMs = Date.now()) {
  if (!payload) return null;
  const audiences = (Array.isArray(payload.aud) ? payload.aud : [payload.aud])
    .filter((value) => value !== null && value !== undefined)
    .map(String);
  const roleNames = Array.isArray(payload.roles) ? payload.roles.map(String) : [];
  const tid = stringOrNull(payload.tid);
  const expiry = relativeExpiry(Number(payload.exp), nowMs);
  const expected = expectations || {};

  const scopes =
    typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean).map(String) : [];
  const azp = requestingClient(payload);

  return {
    claimNames: Object.keys(payload).sort(),
    aud: audiences.length ? audiences.join(', ') : null,
    audienceMatches: compareIfExpected(expected.expectedAudience, (want) =>
      audiences.includes(want)
    ),
    roleNames,
    hasAdminRole: compareIfExpected(expected.adminAppRole, (want) => roleNames.includes(want)),
    tenantMatches: compareIfExpected(expected.tenantId, (want) => tid === want),
    scopes,
    hasRequiredScope: compareIfExpected(expected.requiredScope, (want) => scopes.includes(want)),
    tokenVersion: stringOrNull(payload.ver),
    versionMatches: compareIfExpected(
      expected.requiredTokenVersion,
      (want) => payload.ver === want
    ),
    azp,
    // THE ROW THAT PINS THE REGISTRATION TOPOLOGY (#519).
    //
    // `azp` is the client that asked; `aud` is the API it is for. One app
    // registration serving both makes them the same GUID, which is the
    // condition DECISION 3 in verify-token.js warns about and #522 exists to
    // end. After the split they differ, and if anyone ever points
    // VITE_ENTRA_CLIENT_ID back at the API's client id this goes red on a page
    // an admin already visits — instead of nothing happening at all.
    clientIsSeparateFromApi:
      azp && audiences.length ? !audiences.some((value) => sameApp(value, azp)) : null,
    expiresLabel: expiry.label,
    expired: expiry.expired,
  };
}

/**
 * Reduce the getCurrentAdminStatus body to booleans and role names. The `uid`
 * and `email` it carries are compared or counted, never kept.
 *
 * @param {object|null} body
 * @param {string|null} tokenOid the token's `oid` (or `sub`), used once, here
 */
export function summarizeAdminStatus(body, tokenOid) {
  if (!body) return null;
  const uid = typeof body.uid === 'string' && body.uid ? body.uid : null;
  return {
    isAdmin: body.isAdmin === true,
    role: body.role ?? null,
    active: body.active === true,
    permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
    uidPresent: uid !== null,
    uidMatchesToken: uid && tokenOid ? uid === tokenOid : null,
    emailPresent: typeof body.email === 'string' && body.email.length > 0,
  };
}

/**
 * The identity verdict: the token carries the audience and the role, and the
 * registry agrees it is this principal and that they are an admin. Unknown
 * until both halves have been read.
 */
export function evaluateIdentity(token, admin) {
  if (!token || !admin) return { pass: null, reason: 'token or registry not read' };
  const checks = [
    ['aud matches the API audience', token.audienceMatches],
    ['admin App Role present in roles', token.hasAdminRole],
    // Since #515 a token without the delegated scope is refused outright, so a
    // token that reached this page and lacks it means the SPA is requesting the
    // wrong scope — not that the caller is unauthorized.
    ['delegated scope present in scp', token.hasRequiredScope],
    ['token version matches', token.versionMatches],
    ['registry says isAdmin', admin.isAdmin],
    ['registry uid equals token oid', admin.uidMatchesToken],
  ];
  const failed = checks.filter(([, value]) => value === false).map(([name]) => name);
  if (failed.length) return { pass: false, reason: `failed: ${failed.join('; ')}` };
  // A comparison that could not be made (the API gave no expectation to
  // compare against) is not a failure, and must not be scored as one — but it
  // is not a pass either. Say which one, so the report names the gap.
  const unknown = checks.filter(([, value]) => value !== true).map(([name]) => name);
  if (unknown.length) return { pass: null, reason: `could not compare: ${unknown.join('; ')}` };
  return { pass: true, reason: 'every comparison holds' };
}

/**
 * The authenticated Labs probe's failure checks, in order: each answers the
 * reason the probe failed, or nothing when its step held.
 */
const LABS_PROBE_FAILURES = [
  // The runner itself threw before any step recorded a result.
  (probe) => probe.error,
  ({ enqueue }) =>
    (!enqueue || enqueue.httpStatus !== 200) &&
    `enqueueLabJob answered ${enqueue?.httpStatus ?? 'no status'}`,
  ({ enqueue }) =>
    (!enqueue.jobId || enqueue.status !== 'queued') &&
    'enqueueLabJob did not return { jobId, status: "queued" }',
  ({ read }) => !read?.found && 'lab_jobs document not found after enqueue',
  // A failed final read is not "still queued" — it is unknown, and unknown is
  // its own failure here: the probe cannot vouch for the document's state.
  ({ enqueue, final }) =>
    final?.error &&
    `final getLabJob read failed (${final.error}) — lab_jobs/${enqueue.jobId} state unknown`,
  // No fallback to the earlier read: the verdict is about the state at the
  // END of the probe, and a closing read that returned nothing observed none.
  ({ enqueue, final }) =>
    !final?.status &&
    `final lab_jobs/${enqueue.jobId} state unknown — the closing getLabJob read returned no status`,
  ({ enqueue, final }) =>
    !SETTLED_JOB_STATUSES.has(final.status) &&
    `lab_jobs/${enqueue.jobId} is still "${final.status}"`,
];

/**
 * The verdict for the authenticated Labs probe.
 *
 * The documented response of enqueueLabJob is HTTP 200 with
 * `{ jobId, type, status: 'queued' }` (lib/labs.js). The document must then
 * exist and, after the cancel, be in a state that is not `queued` — terminal,
 * or held by an agent — so nothing is left hanging.
 *
 * @param {object|null} probe
 * @returns {{ pass: boolean|null, reason: string }}
 */
export function evaluateLabsProbe(probe) {
  if (!probe) return { pass: null, reason: 'NOT RUN — press "Run authenticated probe"' };
  // Stops at the first failure: a later check may read what an earlier one found missing.
  const failure = LABS_PROBE_FAILURES.reduce((found, check) => found || check(probe), null);
  if (failure) return { pass: false, reason: failure };
  return { pass: true, reason: `documented no-op response; document ${probe.final.status}` };
}

/** The verdict for the unauthenticated probe: a 401 or 403, nothing else. */
export function evaluateUnauthenticatedProbe(result) {
  if (!result) return { pass: null, reason: 'NOT RUN — press "Run unauthenticated probe"' };
  if (result.error) return { pass: false, reason: result.error };
  const pass = result.httpStatus === 401 || result.httpStatus === 403;
  return { pass, reason: `HTTP ${result.httpStatus}` };
}

/**
 * A verdict in the shared vocabulary (ADR 0033 §2, lib/status.js): a
 * comparison that holds is healthy, one that fails is critical — the check
 * ran and said no — and one that could not be made is unknown. The same words
 * the badges, the Overview and the Integrations page use, so the report reads
 * like the screen it describes.
 */
export const verdictStatus = (value) => {
  if (value === true) return 'healthy';
  if (value === false) return 'critical';
  return 'unknown';
};

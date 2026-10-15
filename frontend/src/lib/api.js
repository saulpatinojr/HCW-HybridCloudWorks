/**
 * Shared authenticated API utility for CMS admin calls.
 * Injects an Entra ID access token (audience = the Functions API) into all
 * requests via MSAL — see lib/entraAuth.js.
 *
 * ===========================================================================
 * WHY entraAuth IS IMPORTED DYNAMICALLY (T-736)
 * ===========================================================================
 * `import { acquireApiToken } from '@/lib/entraAuth'` was a static import, and
 * entraAuth imports `@azure/msal-browser`. Any module that imports anything
 * from this file therefore dragged 236 kB of MSAL into its chunk — including
 * `useGenerateCuratedImages`, which is on the public `/:provider/news` route.
 * So an anonymous visitor downloaded and executed MSAL to look at a news grid.
 *
 * That hook's own header claims its role gate "stops the hook dragging MSAL
 * onto the critical path of a public page". The runtime gate does work; the
 * module graph never followed it, because a static import is resolved before
 * any gate runs.
 *
 * The import moves inside `authedFetch`, which is already `async` and already
 * awaits the token — so no caller signature changes and no call site needs to
 * know. MSAL now loads when the first authenticated request is made, which on
 * a public route is never.
 *
 * Keep it dynamic. A static `import` of entraAuth anywhere in this file's
 * graph silently undoes this, with no test failure and no visible symptom
 * beyond a slower public page — which is exactly how it got here.
 * `msal-not-on-public-routes.test.js` is what actually holds the line.
 */
import { requireFunctionsBase } from '@/lib/functionsBase';

const DEFAULT_TIMEOUT_MS = 20000;
const FUNCTION_TIMEOUT_MS = {
  generateReviewerDigestManual: 30000,
  deleteRejectedContent: 90000,
  generateArticleDraft: 90000,
  createContentFromRecording: 90000,
  generatePreviewImages: 30000,
  // A batch of articles each fetching its body images (15 s per image, four
  // at a time) — sized with the Function host's 230 s cap, not the default.
  'cms/content/rehost-images': 200000,
  // The Drafts page's "Import from docs/content": the directory listing,
  // then each file not yet imported — a raw fetch and a commit lookup under
  // an 8 s deadline apiece, in parallel — then the writes. Not retried: the
  // import is idempotent, but a retry would audit every path twice.
  'cms/drafts/import-repo': 60000,
  // The ElevenLabs live check: an account read, one Text to Dialogue request
  // with its own retries, an upload and a second read. Deliberately absent
  // from SAFE_RETRY_FUNCTIONS: a client retry would render, and bill, twice.
  'cms/podcast/elevenlabs/sample': 120000,
  // The AI Engine's Test and Playground (ADR 0033). The server caps the Test
  // at 45 s (proxy.js TEST_TIMEOUT_MS) and a Playground call at the
  // provider's own 120 s chat timeout; the client sits above each so the
  // server's named error arrives instead of a client-side "timed out".
  // Before this both ran under the 20 s default and a slow provider's
  // answer was discarded while its spinner kept turning.
  testAiProvider: 50000,
  aiProxy: 125000,
  // The MCP OAuth callback: the code exchange (8 s cap) and then the same
  // tool sync Sync Tools runs (30 s cap, SSE 25 s), in one request. Under
  // the 20 s default a slow sync would read as a failed sign-in.
  'cms/mcp/oauth/complete': 60000,
  // Forge Studio's AI actions: the handler runs under an 85 s budget
  // (forge-studio.js FORGE_ASSIST_HTTP_BUDGET_MS); sync-budgets.test.js in
  // functions pins this value above it.
  'cms/forge/assist': 95000,
};
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const SAFE_RETRY_FUNCTIONS = new Set([
  'generateReviewerDigestManual',
  'deleteRejectedContent',
  'listContentItems',
  'aiStackReadiness',
]);

function timeoutForFunction(fnName) {
  return FUNCTION_TIMEOUT_MS[fnName] || DEFAULT_TIMEOUT_MS;
}

/**
 * Build the full endpoint URL for an Azure Functions route.
 * @param {string} fnName - Route name (e.g. 'submitContentUrls', 'cms/content')
 * @returns {string} Full URL
 */
export function getEndpoint(fnName) {
  return `${requireFunctionsBase(fnName)}/${fnName}`;
}

/**
 * Fetch with a function-aware timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @param {string} fnName
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs, fnName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `${fnName} timed out after ${Math.round(timeoutMs / 1000)}s (${url}). This may indicate slow backend processing or a temporary network issue.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the RFC 6750 parameters out of a `WWW-Authenticate` header.
 *
 * The API says why it refused a request (#517), and the reason is the
 * difference between "sign in again" and "someone has to fix a setting".
 * Exported so it can be tested without a network.
 *
 * Returns `{}` for a missing, non-Bearer or unparseable header — a caller that
 * learns nothing should behave as it did before the header existed, not throw.
 *
 * @param {string|null|undefined} header
 * @returns {{error?: string, error_description?: string, realm?: string, claims?: string}}
 */
export function parseWwwAuthenticate(header) {
  const value = typeof header === 'string' ? header.trim() : '';
  if (!/^Bearer\b/i.test(value)) return {};

  const params = {};
  // Quoted values only, escaped characters included — the RFC 7235
  // quoted-string, which is what Entra and this API both emit.
  //
  // THIS IS ONE HALF OF A PAIR. `quoteString` in the API's require-role.js
  // escapes `\` and `"` on the way out; this unescapes them on the way in, and
  // the two must agree or a description arrives mangled. An earlier version of
  // each stripped instead, and stripping is lossy in a way that looks like
  // success.
  //
  // A token68 or unquoted parameter yields nothing rather than a half-guess:
  // a parser that drops half a value is worse than one that drops all of it,
  // because half a value still reads as complete.
  const pattern = /([a-z_]+)="((?:[^"\\]|\\.)*)"/gi;
  let match = pattern.exec(value);
  while (match !== null) {
    params[match[1].toLowerCase()] = match[2].replace(/\\(.)/g, '$1');
    match = pattern.exec(value);
  }
  return params;
}

/**
 * How long a rate-limited route asks the caller to wait, and the route's
 * machine-readable reason, when the refusal body gave them (the Mailing List
 * routes answer a Resend 429 with `retryAfterSeconds`, #504). Read from the
 * body because a cross-origin `Retry-After` header is not exposed to the page.
 */
function attachRefusalHints(error, errData) {
  if (Number.isFinite(errData?.retryAfterSeconds) && errData.retryAfterSeconds > 0) {
    error.retryAfterSeconds = errData.retryAfterSeconds;
  }
  if (typeof errData?.code === 'string') error.code = errData.code;
}

/**
 * Authenticated fetch wrapper.
 * Automatically injects an Entra Bearer token from MSAL's cache, which MSAL
 * renews on its own once the cached token has expired.
 * Retries once on transient 429/5xx failures with a 2-second backoff.
 *
 * @param {string} fnName - Azure Functions route name
 * @param {object} options - fetch options (method, body, etc.), plus:
 *   `token`: a bearer token the caller has ALREADY acquired. When given, no
 *   acquisition happens here — the Admin Diagnostics page needs the token it
 *   decodes and the token it sends to be one acquisition, and a
 *   caller-supplied Authorization header alone did not achieve that (the
 *   acquisition still ran). Nothing else should need this; every other
 *   caller wants the acquisition.
 *   `freshToken`: acquire with a forced refresh, for a caller that wants a
 *   token newer than the cache holds. getCurrentAdminStatus used to force one
 *   on every call so a just-granted App Role showed at once — and every
 *   mounted instance of useAdminAuth paid a round trip to Entra for it
 *   (AP-F12, #936). The hook asks for it on an explicit re-check only; a page
 *   load takes the cached token, renewed by MSAL when it has actually expired.
 * @returns {Promise<Response>}
 */
export async function authedFetch(
  fnName,
  { token: presetToken, freshToken = false, ...options } = {}
) {
  let token = presetToken;
  if (!token) {
    // Throws 'Not authenticated. Please sign in.' with no active account —
    // same contract as the Firebase version.
    const { acquireApiToken } = await import('@/lib/entraAuth');
    token = await acquireApiToken({ forceRefresh: Boolean(freshToken) });
  }
  const url = getEndpoint(fnName);

  // Caller headers first, Authorization LAST, and any Authorization the caller
  // supplied is dropped on the way in. The previous order let a caller's
  // header silently replace the token this function had just acquired; the
  // only sanctioned way to change what is sent is the `token` option above.
  const callerHeaders = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'authorization')
  );
  const headers = {
    'Content-Type': 'application/json',
    ...callerHeaders,
    Authorization: `Bearer ${token}`,
  };

  const timeoutMs = timeoutForFunction(fnName);
  const shouldRetry = SAFE_RETRY_FUNCTIONS.has(fnName);
  const attemptFetch = () => fetchWithTimeout(url, { ...options, headers }, timeoutMs, fnName);

  let res;
  try {
    res = await attemptFetch();
  } catch (err) {
    if (!shouldRetry) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res = await attemptFetch();
  }

  if (shouldRetry && !res.ok && RETRYABLE_STATUSES.has(res.status)) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    res = await attemptFetch();
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const detailText = errData?.details ? ` Details: ${JSON.stringify(errData.details)}` : '';
    // `message` is where the API puts the actual cause. Several handlers
    // answer `{ error: 'Failed to generate caption', message: <why> }`, and
    // this used to throw only `error` — so the Social Hub toast read "Failed
    // to generate caption" and nothing else while the sentence that named the
    // real problem was discarded one line away. The same shape that cost
    // #358 two days on Publer, reproduced inside this client (#498).
    const cause =
      typeof errData?.message === 'string' &&
      errData.message.trim() &&
      errData.message !== errData.error
        ? ` — ${errData.message.trim()}`
        : '';
    const error = new Error(
      (errData.error || `${fnName} failed with HTTP ${res.status}. Try again or check the logs.`) +
        cause +
        detailText
    );
    // The status code, kept on the error rather than flattened into prose.
    // Without it every failure looks the same to a caller, and useAdminAuth
    // could not tell "the server says you are not an admin" from "the server
    // rejected the token" — which is how an expired session rendered as
    // Access Denied with an offer to re-provision the owner (#503). Callers
    // that only show `err.message` are unaffected; a thrown Error with extra
    // own-properties behaves exactly as before.
    error.status = res.status;
    error.fnName = fnName;
    attachRefusalHints(error, errData);
    // The reason, when the API gave one (#517). `error.status` told a caller
    // that the request failed; this tells them what would fix it — and the
    // distinction matters most on a 401, where `invalid_token` means sign in
    // again and `insufficient_scope` means signing in again changes nothing.
    // Readable cross-origin only because cors.js names it in
    // Access-Control-Expose-Headers.
    error.wwwAuthenticate = parseWwwAuthenticate(res.headers?.get?.('www-authenticate'));
    throw error;
  }

  return res;
}

/**
 * POST JSON to an authenticated Azure Functions route.
 * @param {string} fnName - Azure Functions route name
 * @param {object} body - JSON payload
 * @returns {Promise<object>} Parsed JSON response
 */
export async function postJSON(fnName, body) {
  const res = await authedFetch(fnName, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * GET an authenticated REST route (e.g. 'cms/certifications').
 * @param {string} fnName - route path after the API base
 * @returns {Promise<object>} Parsed JSON response
 */
export async function getJSON(fnName, options = {}) {
  // `options` reaches authedFetch unchanged, so `token` (a pre-acquired
  // bearer token — see authedFetch) works here too.
  const res = await authedFetch(fnName, { ...options, method: 'GET' });
  return res.json();
}

/**
 * GET /api/cms/content with its filters as the list route reads them
 * (functions/src/lib/cms-content.js buildListQuery): `search` matches titles
 * and summaries (#1178), and `status`, `live`, `type`, `kind`, `ideaOrigin`,
 * `sort` and `limit` as there. Empty values are left off the query. Resolves
 * to the items, in the admin snapshot projection.
 * @param {Record<string, string|number|boolean|undefined>} [params]
 * @returns {Promise<object[]>}
 */
export async function listContentItems(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  const res = await getJSON(qs ? `cms/content?${qs}` : 'cms/content');
  return res.items || [];
}

/**
 * Send JSON to an authenticated REST route with an explicit method
 * (PATCH/PUT/DELETE). Omit body for body-less requests.
 * @param {string} fnName - route path after the API base
 * @param {string} method - HTTP method
 * @param {object} [body] - JSON payload
 * @param {{ headers?: Record<string, string> }} [options] - extra request
 *   headers, such as the If-Match a Platform settings save sends (#946). A
 *   cross-origin header must also be in the API's CORS allowlist
 *   (functions/src/lib/auth/cors.js); Authorization is never taken from here.
 * @returns {Promise<object>} Parsed JSON response
 */
export async function sendJSON(fnName, method, body, { headers } = {}) {
  const res = await authedFetch(fnName, {
    method,
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

/**
 * integrations/probe-answer.js — the second half of a Test button's probe
 * (connection-probe.js has the table of probes and the route): the GET
 * itself, the upstream's answer redacted before it is parsed, the key
 * verdict, and the answer the page gets. Nothing the upstream says on a
 * failure reaches the answer (#945). connection-probe.js re-exports what
 * callers use.
 */
import { isCredentialRejected } from '../key-verdict.js';
import { errorCode, logFailure } from '../http/error-response.js';
import { readUpstreamError } from './upstream-error.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * A probe should answer in seconds or be reported as unreachable. Without a
 * deadline a hung upstream holds the request until the host's own timeout,
 * and the operator sees a spinner with no verdict.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Remove credential values from a string that is about to be shown or logged.
 *
 * Applied to every outbound string, not only the ones known to be risky. Two
 * of the three probes carry their credential in the URL, and the messages that
 * leak it are the ones nobody wrote deliberately — a transport error quoting
 * its request target, a proxy echoing the line it could not parse.
 *
 * Short values are left alone. A one or two character "secret" is not one, and
 * blanking every occurrence of it would corrupt unrelated text into nonsense;
 * an unseeded probe never reaches here anyway, because a missing key is
 * refused before the call is built.
 *
 * @param {string} text
 * @param {Array<string|undefined>} secrets
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    // Both the raw value and its percent-encoded form. A credential that
    // travels in a URL is encoded on the way out, so an upstream echoing its
    // request target back quotes the ENCODED bytes — and redacting only the
    // raw string would sail straight past it. A Telegram token's colon
    // becomes `%3A`, which is exactly enough difference to miss.
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('***');
    }
  }
  return out;
}

/**
 * `url` with `query` set on it — or `url` itself, untouched, when there is
 * nothing to add, so a probe without an `authenticate` step sends exactly the
 * URL its table entry built.
 */
export function withQuery(url, query) {
  const entries = Object.entries(query);
  if (!entries.length) return url;
  const target = new URL(url);
  for (const [key, value] of entries) target.searchParams.set(key, String(value));
  return target.toString();
}

/**
 * The 200 `{ ok: false }` answer for a probe whose request got no response.
 * The transport's own text stays out of the answer and the log (#945): an
 * undici failure quotes its request target in `cause`, and for three of
 * these probes that target contains a credential. Its code says which
 * failure it was, and the correlation id finds the line.
 *
 * @param {unknown} error - what the fetch threw
 * @returns {object} the HTTP response
 */
export function unreachableAnswer(context, request, probe, error) {
  const correlationId = logFailure(context, `${probe.name}Probe could not reach ${probe.service}`, error, request);
  return json(200, {
    ok: false,
    error: `${probe.service} could not be reached (${errorCode(error?.cause ?? error)}).`,
    correlationId,
  });
}

/** The upstream's text as data: parsed JSON, or (for an answer that is not JSON) the first of it raw. */
function parseUpstream(safeText) {
  try {
    return safeText ? JSON.parse(safeText) : null;
  } catch {
    // Not every upstream error is JSON, and the raw text is more use to an
    // operator than discarding it.
    return { raw: safeText.slice(0, 2000) };
  }
}

/** The key verdicts a probe's answer earns: good for every setting it used, or bad for a refused credential. */
async function reportVerdicts(probe, response, data, reportVerdict) {
  if (response.ok) {
    // Only the settings this call actually exercised — which is why
    // `settings` is the probe's list and not "everything the service has".
    // Telegram's getMe never sees the chat id, so a success here must not
    // turn the chat id's light green.
    for (const setting of probe.settings) {
      await reportVerdict(setting, { ok: true });
    }
  } else if (isCredentialRejected(response.status)) {
    await reportVerdict(probe.settings[0], {
      ok: false,
      status: response.status,
      // Already safe: `data` was parsed from the redacted text above.
      detail: readUpstreamError(data),
    });
  }
}

/**
 * The probe's GET, once its request is built and any token exchange is
 * done (`step.minted`), and the page's answer. A step that could not reach
 * the token endpoint (`step.answer`) is answered as it is.
 */
export async function runProbe({ probe, request_, step, secrets, fetchImpl, reportVerdict }, request, context) {
  if (step.answer) return step.answer;
  const { minted } = step;
  let response;
  let text;
  try {
    response = await fetchImpl(withQuery(request_.url, minted.query), {
      method: 'GET',
      headers: { ...request_.headers, ...minted.headers },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    return unreachableAnswer(context, request, probe, error);
  }

  // REDACTED BEFORE IT IS PARSED, which is the whole reason this is one
  // line rather than a call at each site that emits a string. The first
  // version redacted `error` and the log and passed the parsed `data`
  // through untouched — and `data` is the upstream's body, which for a
  // provider that echoes the request line back carries the credential
  // straight into the response. Its own test caught it. Everything
  // downstream now derives from this string, so there is one place to get
  // right instead of four.
  //
  // Replacing a substring inside a JSON string value leaves the document
  // valid. A credential containing a quote could in principle break the
  // parse, and that degrades into the `raw` branch below, which is the safe
  // direction to fail in.
  const safeText = redactSecrets(text, secrets);

  const data = parseUpstream(safeText);

  await reportVerdicts(probe, response, data, reportVerdict);

  // A success relays the redacted answer: the Test runners read the bot's
  // username or the show's title from it. A failure answers with exactly
  // PROBE_FAILURE_FIELDS: `error` names the service and the status, and
  // the upstream's body stays out (#945, #1200 review L2). This route is
  // editor-level, and the browser never read `data` on a failure
  // (`unwrapProxy` takes `error`); the provider's own sentence on a 401 or
  // 403, which #463 and #358 made the diagnosis, is kept where they put
  // it: the key verdict's lastFailDetail, which only the super_admin
  // API-keys page reads.
  if (response.ok) {
    const relayed = typeof probe.summarize === 'function' ? probe.summarize(data) : data;
    return json(200, { ok: true, status: response.status, data: relayed });
  }
  return json(200, probeFailure(probe, response.status));
}

/** The only fields a failed probe answers with (#945): no upstream body. */
export const PROBE_FAILURE_FIELDS = Object.freeze(['ok', 'status', 'error']);

/**
 * A probe the upstream refused, as the page is told: the service and the
 * status, in this module's words.
 *
 * @param {{ service: string, failureSentence?: Function|null }} probe - the probe that ran
 * @param {number} status - the upstream's HTTP status
 * @returns {{ ok: false, status: number, error: string }}
 */
export function probeFailure(probe, status) {
  const sentence = typeof probe.failureSentence === 'function' ? probe.failureSentence(status) : null;
  return { ok: false, status, error: sentence ? `${sentence} (HTTP ${status}).` : `${probe.service} answered HTTP ${status}.` };
}

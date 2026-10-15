/**
 * proxyEnvelope.js - reading what `publerProxy`, `linkieProxy` and
 * `connectionProbe` actually return.
 *
 * THE PROXIES ANSWER HTTP 200 FOR EVERY OUTCOME. `authedFetch` throws on a
 * non-2xx status, so most calls in this app can treat "it resolved" as "it
 * worked" - but not these three. A refused credential, a 404 upstream and a
 * gateway error all arrive here as a RESOLVED promise carrying
 * `{ ok: false, status, data }`, and the only signal is `ok`.
 *
 * Three "Test Connection" runners on the Integrations page did not check it.
 * `testPubler` read `Array.isArray(accounts)` on the envelope - which is an
 * object and never an array - so it computed zero and reported
 * "Connected - 0 social account(s)" for every outcome including a 403. The
 * button said Connected while the timer beside it had been failing for hours,
 * which is worse than having no button: it is the same defect as #463 item 1,
 * one layer up, and this module exists so it cannot be written a fourth time.
 *
 * Mirrors `functions/src/lib/integrations/upstream-error.js`, deliberately
 * rather than importing it: that module ships in the Functions bundle and this
 * one in the browser's.
 */

/** Longer than any useful message, short enough for a toast. */
const MAX_DETAIL_LENGTH = 300;

function firstString(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  // A JSON:API `errors[]` holds objects; JSON:API calls the sentence `detail`.
  // `description` is Telegram's field and is last, so appending it cannot
  // change what any existing caller reads (#483).
  for (const key of ['detail', 'message', 'title', 'error', 'description']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key];
  }
  return '';
}

/**
 * The first human-readable sentence in an upstream error body.
 *
 * Publer answers `{ errors: ['...'] }`, a JSON:API service `{ errors: [{ detail }] }`,
 * Resend a plain `{ message }`, and `{ error }` is common enough to be worth the
 * two extra lines. `raw` is where the proxy parks a body it could not parse.
 *
 * @param {unknown} data parsed upstream body
 * @returns {string} the message, or '' when the body carried none
 */
export function readUpstreamMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = Array.isArray(data)
    ? data
    : [data.errors, data.error, data.message, data.detail, data.description, data.raw];
  for (const candidate of candidates.flat?.() ?? candidates) {
    const found = firstString(candidate);
    if (found.trim()) return found.trim().slice(0, MAX_DETAIL_LENGTH);
  }
  return '';
}

/**
 * The upstream body, or a thrown Error naming what went wrong.
 *
 * @param {unknown} res whatever `postJSON('<name>Proxy', ...)` resolved to
 * @param {string} service the service's name, for the message
 * @returns {unknown} `res.data` - the upstream body - on success
 * @throws {Error} when the envelope reports a failure
 */
export function unwrapProxy(res, service) {
  if (res && res.ok === false) {
    // A server sentence is complete and is said as it is: a proxy's own
    // refusal (`code`, a missing app setting), "<Service> could not be
    // reached (<code>).", and every connectionProbe failure, which since
    // #945 answers `{ ok, status, error }` with no upstream body. Only a
    // relayed upstream refusal (the Publer and Linkie proxies, #463) is
    // composed here from its status and the upstream's own sentence. A
    // correlation id, when the server sent one, is named for the log.
    const reference =
      typeof res.correlationId === 'string' && res.correlationId
        ? ` (reference ${res.correlationId})`
        : '';
    if (typeof res.error === 'string' && res.error) throw new Error(`${res.error}${reference}`);
    const reason = readUpstreamMessage(res.data) || 'the request was refused';
    throw new Error(
      Number.isFinite(res.status)
        ? `${service} answered ${res.status} - ${reason}${reference}`
        : `${reason}${reference}`
    );
  }
  // A shape that is not the envelope at all. Treated as a failure rather than
  // assumed good: silently reading `undefined` as "zero of them" is exactly
  // how the runners this replaces reported success for a refusal.
  //
  // The test is `ok === true`, NOT "has a data property". The proxy sets `ok`
  // on every response, so its absence means this did not come from the proxy
  // - and the most likely thing that reaches here without it is an already
  // unwrapped JSON:API body, `{ data: [...] }`, which the looser check would
  // have accepted and unwrapped a second time. That is the same species of
  // accident this module exists to prevent, so it fails loudly.
  if (!res || typeof res !== 'object' || res.ok !== true) {
    throw new Error(`${service} returned an unrecognised response`);
  }
  return res.data;
}

/**
 * How many items an upstream list endpoint returned.
 *
 * Tolerates the three shapes these APIs use: a bare array, `{ data: [] }`
 * (Resend, JSON:API) and `{ <name>: [] }`. Returns `null` when none matches,
 * so a caller can say "connected" without inventing a count it does not have.
 *
 * @param {unknown} body the unwrapped upstream body
 * @param {string} [key] an additional wrapper key to accept
 * @returns {number | null}
 */
export function countList(body, key) {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === 'object') {
    for (const candidate of [key && body[key], body.data, body.items, body.results]) {
      if (Array.isArray(candidate)) return candidate.length;
    }
  }
  return null;
}

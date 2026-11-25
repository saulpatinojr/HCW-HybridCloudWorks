/**
 * The AddOn health read behind the status proxy (status.js): one bounded
 * GET of `<url>/api/health`, and the allow-list projection of its body.
 *
 * Split out of status.js so each file stays small enough to read in one
 * sitting; status.js re-exports what callers and tests use from here.
 * Nothing in this file logs, and no sentence it writes carries the URL.
 */

/** An AddOn that has not answered its health read in five seconds is reported unreachable, not waited for. */
export const ADDON_TIMEOUT_MS = 5_000;

// The whole string, not a prefix: a semver core with an optional pre-release and build. The only length bound is
// the whole string's (SHORT_STRING_MAX), so a long but valid pre-release is accepted and nothing past the version
// can ride into the cache and out to every status caller.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHORT_STRING_MAX = 40;
const CAPABILITIES_MAX = 20;

/** A short string, or null: what `edition` may be. */
const shortString = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= SHORT_STRING_MAX ? value : null;

/** What can be wrong with a health body, by code: sentences this module wrote, so a log line may carry them. */
export const HEALTH_BODY_FAULTS = {
  HEALTH_NOT_OK: 'the health body did not say ok',
  HEALTH_NO_VERSION: 'the health body carried no semver version',
  HEALTH_TOO_LARGE: 'the health body was too large',
};

/** A health body fault as an error that carries its code, so its sentence is looked up and never read back. */
const healthBodyFault = (code) => Object.assign(new Error(HEALTH_BODY_FAULTS[code]), { code });

/**
 * The three fields the projection copies from a health body, each checked
 * for shape. Throws when the body is not the documented health envelope, so
 * the caller reports unreachable rather than guessing at fields.
 */
export function projectHealth(body) {
  if (!body || typeof body !== 'object' || body.ok !== true) {
    throw healthBodyFault('HEALTH_NOT_OK');
  }
  const version =
    typeof body.version === 'string' && body.version.length <= SHORT_STRING_MAX && SEMVER.test(body.version)
      ? body.version
      : null;
  if (!version) throw healthBodyFault('HEALTH_NO_VERSION');
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((c) => typeof c === 'string' && c.length <= SHORT_STRING_MAX).slice(0, CAPABILITIES_MAX)
    : [];
  // The AddOn's own `asOf` when it is a parseable timestamp of bounded length; the caller falls back to the read time.
  const asOf =
    typeof body.asOf === 'string' && body.asOf.length <= SHORT_STRING_MAX && !Number.isNaN(Date.parse(body.asOf))
      ? body.asOf
      : null;
  return { version, edition: shortString(body.edition), capabilities, asOf };
}

/**
 * One GET of the AddOn's health. Throws on anything but 200, a redirect
 * included: the proxy never follows one to another origin.
 */
/** The most a health body may be; the envelope is a few hundred bytes, so this is generous and still a bound. */
export const ADDON_HEALTH_MAX_BYTES = 16 * 1024;

/**
 * The response body as text, read no further than `max` bytes: the stream is cancelled the moment the count passes
 * it, so a faulty endpoint cannot make this Function App buffer an unbounded body. A response without a readable
 * stream (a test stand-in) is read whole and then measured.
 */
async function readBoundedText(response, max) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > max) throw healthBodyFault('HEALTH_TOO_LARGE');
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      await reader.cancel();
      throw healthBodyFault('HEALTH_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Read and project the AddOn's health. One deadline (ADDON_TIMEOUT_MS) covers
 * the whole exchange, body included; the body is refused past
 * ADDON_HEALTH_MAX_BYTES, by Content-Length when the AddOn sends one and by a
 * byte count while the stream is read, before anything is parsed.
 */
export async function readHealth(fetchImpl, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADDON_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.base}${config.healthPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200) {
      // End the exchange before the deadline is cleared: a rejected answer's body is never read, so cancel it.
      await response.body?.cancel?.().catch(() => {});
      throw Object.assign(new Error(`the health read answered ${response.status}`), {
        status: response.status,
      });
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > ADDON_HEALTH_MAX_BYTES) {
      throw healthBodyFault('HEALTH_TOO_LARGE');
    }
    return projectHealth(JSON.parse(await readBoundedText(response, ADDON_HEALTH_MAX_BYTES)));
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error(`timeout after ${ADDON_TIMEOUT_MS} ms`), { code: 'FETCH_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

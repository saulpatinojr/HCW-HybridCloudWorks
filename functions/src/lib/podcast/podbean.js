/**
 * podbean.js — the Podbean API, as much of it as publishing needs (ADR 0029
 * §1c). The show moved from RSS.com to Podbean on 2026-10-13; this file is
 * the client that replaced `rsscom.js` in the same role.
 *
 * ## What was verified, and where from
 *
 * Read on 2026-10-13 from Podbean's own API documentation data,
 * `https://developers.podbean.com/podbean-api-docs/api_data.json` — the JSON
 * the apidoc page at `/podbean-api-docs/` renders from. Nothing below was
 * measured against the live API yet; the requests these tests pin are the
 * ones that document describes.
 *
 * - Base URL `https://api.podbean.com/v1`.
 * - Token, client credentials (the grant that manages your own account):
 *   `POST /v1/oauth/token` with HTTP Basic auth `client_id:client_secret` and
 *   the form body `grant_type=client_credentials`. Optional `expires_in` and
 *   `podcast_id`; without `podcast_id` the account's default podcast is used,
 *   which is the one show this site has. Answers `{ access_token, token_type:
 *   'Bearer', expires_in, scope }` with `expires_in` in seconds and the scope
 *   `podcast_read episode_read podcast_update episode_publish
 *   private_members`. Refused as `400 { error: 'invalid_grant',
 *   error_description: 'The grant type is unauthorized for this client_id' }`.
 * - `GET /v1/podcast?access_token=…` → `{ podcast: { id, title, … } }`. The
 *   cheapest read there is, and the one the connection probe makes.
 * - `GET /v1/files/uploadAuthorize?access_token&filename&filesize&content_type`
 *   → `{ presigned_url, expire_in, file_key }`. The field list calls the
 *   lifetime `expire_at` and the example `expire_in`; both are a number of
 *   seconds and this file reads neither. Refused, for one, as `{ error:
 *   'storage_limit_reach', error_description: "You've uploaded too much this
 *   month…" }`. The bytes are then `PUT` to `presigned_url` — an S3 URL, not
 *   api.podbean.com — with the `Content-Type` that was authorised and NO
 *   token: the URL is the credential.
 * - `POST /v1/episodes`, form-encoded, needs the `episode_publish` scope.
 *   Required: `access_token`, `title`, `content` ("HTML code except style and
 *   script is supported"), `status` (`publish` | `draft`), `type` (`public` |
 *   `premium` | `private`). Optional: `media_key` (the `file_key` above),
 *   `logo_key`, `transcripts_key`, `remote_media_url`, `remote_logo_url`,
 *   `remote_transcripts_url`, `season_number`, `episode_number`,
 *   `apple_episode_type` (`full` | `trailer` | `bonus`, default `full`),
 *   `publish_timestamp` (unix seconds), `content_explicit` (`clean` |
 *   `explicit`). Answers `{ episode: { id, title, content, logo, media_url,
 *   player_url, permalink_url, publish_time, status, type, season_number,
 *   episode_number, apple_episode_type, transcripts_url, content_explicit } }`.
 *   There is no guid in the answer.
 * - `POST /v1/episodes/{episode_id}` updates with the same parameters; `title`
 *   and `type` are required even for a partial update, so callers send title,
 *   content, status and type every time. Answers `{ episode }`.
 * - Errors are `{ error, error_description }`; an expired or revoked token is
 *   `400 { error: 'invalid_token', error_description: 'The access token
 *   provided is invalid' }`.
 * - Rate limit, as a client library reports it rather than the docs: a bucket
 *   of 60 requests refilling at 2 per second. A 429 is retryable.
 * - The token travels as the `access_token` query or form parameter, which is
 *   what Podbean's own examples do. A third-party spec says `Authorization:
 *   Bearer` also works; this file uses the documented form.
 * - `POST /v1/episodes/{id}/delete` exists. This file does not implement it.
 *
 * ## The reads (#1115, 2026-10-13) — from the same document, equally unmeasured
 *
 * The Recording Hub reads the show's state and its statistics through the
 * methods below (`host-reads.js`, `host-stats.js`). Every one is a `GET`
 * through `call()`, with the token as `access_token`:
 *
 * - `GET /v1/episodes/{id}` → `{ episode }`, the shape the create answers.
 * - `GET /v1/podcastStats/stats?start&end&period&episode_id` → a map of date
 *   → downloads, `{ "2023-09-10": 1, "2023-09-11": 10 }`; `period` is `d`
 *   (daily keys) or `m` (monthly keys). `episode_id` is optional and its
 *   absence means the whole show. Podbean clamps `end` to yesterday.
 * - `GET /v1/podcastStats/countries|platforms|sources?start&end&period` → a
 *   map of name → downloads (`{ "US": 4026 }`, `{ "Android": 1685 }`,
 *   `{ "Apple Podcasts": 2048 }`). Data for up to 24 months.
 * - `GET /v1/podcastStats/userRetention?period=m|w` → a map of a period's
 *   label → `[{ listeners, retention }]`.
 * - `GET /v1/analytics/podcastAnalyticReports?types[]=…` →
 *   `{ followers, likes, comments, total_episode_length }` (seconds). `types`
 *   is an array parameter; this file sends it as repeated `types[]=`, the
 *   PHP-style encoding Podbean's own examples use for arrays. UNVERIFIED
 *   against the live API: if it answers a validation error naming `types`,
 *   the one line to change is `ANALYTIC_TYPES_PARAM` below.
 * - `GET /v1/analytics/podcastDailyListener` needs the Unlimited plan and
 *   documents no shape; not implemented.
 *
 * Dates are `YYYY-MM-DD` and periods are from the documented sets; both are
 * refused as VALIDATION before any request, the way `contentTypeOrRefuse`
 * refuses a content type, so a bad argument is a plain sentence and not a
 * Podbean 400 with the request to compare it against.
 *
 * ## What this file deliberately does not do
 *
 * No retries of `POST /v1/episodes`. The unit of retry is the episode
 * document (`host-publish.js`): a caller that failed re-runs the publish and
 * the document says which Podbean episode it already has. Retrying the create
 * inside the client is how a duplicate episode would be made, and a duplicate
 * on a public feed is the failure #437 lists first.
 *
 * ONE EXCEPTION, and it is narrow: a resource call refused with
 * `invalid_token` drops the cached token, fetches a fresh one and repeats the
 * call once. A request refused for its token was refused before Podbean did
 * anything with it, so the repeat cannot duplicate an episode; and a token
 * expiring between the cache check and the request is the ordinary way this
 * would otherwise fail on a long upload. A second `invalid_token` is
 * `TOKEN_REJECTED` and is not repeated again.
 *
 * No parsing of responses beyond JSON. The shapes above are what the docs
 * promise; a response that changes shape should fail loudly in the
 * orchestrator's recorded error, not be papered over here.
 *
 * ## The token and the secret never leave this file
 *
 * The access token travels in a query string, which makes the usual habit of
 * quoting a failed URL into an error message a credential leak. No message,
 * `detail` or recorded error built here contains a URL with `access_token=`,
 * the token, the client secret or the Basic header: every string that leaves
 * passes through `scrub`, which removes all of them, and the presigned PUT's
 * errors name only the upload host, never its signed URL.
 *
 * ## Configuration
 *
 * `PODBEAN_CLIENT_ID` and `PODBEAN_CLIENT_SECRET` are Key Vault references
 * (`PODBEAN-CLIENT-ID`, `PODBEAN-CLIENT-SECRET` in `infra/functionapp.tf`),
 * from a developer app created at https://developers.podbean.com/. They are
 * read through `readKey`, so an unresolved `@Microsoft.KeyVault(…)` string is
 * "not configured" rather than a credential, and `isConfigured` says which one
 * is missing in a sentence an operator can act on. One gate: every call here
 * needs a token, and a token needs both.
 */
import { createHash } from 'node:crypto';
import { readKey } from '../ai/router.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { AuthoredError, errorCode } from '../http/error-response.js';

export const PODBEAN_API_BASE_URL = 'https://api.podbean.com/v1';

/** JSON calls, the token exchange included. Generous because the create call may be slow. */
export const PODBEAN_TIMEOUT_MS = 30_000;

/**
 * The audio PUT. A Listen & Learn episode is 64 kbps mono, so twenty minutes
 * is under 10 MB; five minutes is ample for that and for a human recording
 * several times the size, and still a deadline rather than forever.
 */
export const PODBEAN_UPLOAD_TIMEOUT_MS = 300_000;

/**
 * How long before its stated expiry a cached token stops being used. A token
 * that expires between the check and the request costs the one re-auth above;
 * a minute's margin makes that the rare case rather than the boundary one.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export const CLIENT_ID_SETTING = 'PODBEAN_CLIENT_ID';
export const CLIENT_SECRET_SETTING = 'PODBEAN_CLIENT_SECRET';

const SETTING_SECRETS = Object.freeze({
  [CLIENT_ID_SETTING]: 'PODBEAN-CLIENT-ID',
  [CLIENT_SECRET_SETTING]: 'PODBEAN-CLIENT-SECRET',
});

/** OAuth error codes on the token endpoint that mean "these credentials", not "try later". */
const CREDENTIAL_ERRORS = new Set(['invalid_client', 'invalid_grant', 'unauthorized_client']);

/** `period` for the download, country, platform and source statistics: daily or monthly keys. */
export const STATS_PERIODS = Object.freeze(['d', 'm']);
/** `period` for user retention: monthly or weekly cohorts. */
export const RETENTION_PERIODS = Object.freeze(['m', 'w']);
/** The `types` the analytic report documents. */
export const ANALYTIC_REPORT_TYPES = Object.freeze([
  'followers',
  'likes',
  'comments',
  'total_episode_length',
]);
/** How the array parameter is spelled on the wire (see the header: unverified live). */
const ANALYTIC_TYPES_PARAM = 'types[]';

/**
 * One error type for everything the client raises, so a caller can record it
 * on a document without inspecting the cause.
 *
 * The message is this module's sentence (#945): the operation, the HTTP
 * status and the OAuth `error` code, or the socket's code, and never the
 * API's description, an error body or a socket's text. It is an
 * AuthoredError, so the transcript's host record and the hub store and
 * show it as written; what the API said stays on `detail`, in memory.
 *
 * `status` is the upstream HTTP status, or `null` when no response was had
 * (timeout, DNS, not configured). `detail` is what the API said, flattened
 * from `{ error, error_description }` to one line and scrubbed of the token
 * and the secret. `code` is ours:
 *
 *   NOT_CONFIGURED        a setting is missing; nothing was sent
 *   CREDENTIALS_REJECTED  the token endpoint refused the client id/secret
 *                         (invalid_client, invalid_grant, unauthorized_client,
 *                         or a 401/403 there), or a resource call answered
 *                         401/403 for a reason other than the token — the
 *                         app's permissions, checked in the developer portal
 *   TOKEN_REJECTED        `invalid_token` on a resource call, twice (see above)
 *   STORAGE_LIMIT         `storage_limit_reach`: the plan's monthly upload
 *                         allowance is spent; not retryable until it resets
 *   VALIDATION            any other 400, or a refusal before the network
 *   NOT_FOUND             404
 *   UPSTREAM              anything else; retryable for 408, 429 and 5xx
 *   TIMEOUT, NETWORK      no response from api.podbean.com; retryable
 *   UPLOAD_REJECTED       401/403 from the presigned URL's host — an expired
 *                         URL, never the token; retryable (a re-run mints one)
 *   UPLOAD_FAILED         any other status from that host
 *   UPLOAD_UNREACHABLE    no response from that host; the message names it
 *
 * `retryable` is true when repeating the same call later could succeed
 * without a change on our side.
 */
export class PodbeanError extends AuthoredError {
  /**
   * @param {string} message - the sentence, written in this module
   * @param {{ status?: number|null, code?: string, detail?: string|null, retryable?: boolean }} [options]
   */
  constructor(
    message,
    { status = null, code = 'UPSTREAM', detail = null, retryable = false } = {}
  ) {
    super(message, { code, status });
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/** An OAuth `error` code or a socket code has this shape; a sentence does not. */
const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * `400 invalid_grant`, or `503` when the answer carried no code: the parts
 * of a failed answer a stored sentence may name. The description stays out.
 *
 * @param {number} status - the HTTP status
 * @param {unknown} data - the parsed body, or null
 * @returns {string}
 */
function statusAndCode(status, data) {
  const code = typeof data?.error === 'string' ? data.error.trim() : '';
  return CODE_SHAPE.test(code) ? `${status} ${code}` : String(status);
}

/**
 * The code a transport failure is known by: its own (`ENOTFOUND`), its
 * cause's (undici's `fetch failed` keeps the socket code there), or its
 * class name. Never its message, which can quote the URL it was given.
 *
 * @param {unknown} error - what fetch threw
 * @returns {string}
 */
function transportCode(error) {
  for (const candidate of [error?.code, error?.cause?.code]) {
    if (typeof candidate === 'string' && CODE_SHAPE.test(candidate)) return candidate;
  }
  return errorCode(error);
}

/**
 * Whether publishing can run at all, and if not, why, in one sentence.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function isConfigured(env = process.env) {
  const missing = [CLIENT_ID_SETTING, CLIENT_SECRET_SETTING]
    .filter((setting) => !readKey(env, setting))
    .map((setting) => `${setting} (Key Vault secret ${SETTING_SECRETS[setting]})`);
  if (!missing.length) return { ok: true };
  return {
    ok: false,
    reason: `Podbean publishing is not configured: ${missing.join(' and ')} ${
      missing.length === 1 ? 'is' : 'are'
    } not set, so episodes stay on the manual upload path.`,
  };
}

/**
 * A bare `type/subtype` media type, no parameters, per RFC 2045 token
 * characters. `audio/mpeg`, `audio/mp4` pass; `audio/mpeg; charset=x`, an
 * empty string and whitespace do not.
 */
const MIME_SHAPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/**
 * The one rule for a content type, shared by the two calls that must agree on
 * it: `authorizeUpload` sends it as `content_type`, and `uploadMedia` sends it
 * as the PUT's `Content-Type`, which the presigned URL is signed for.
 * Trimmed, non-empty, `type/subtype`, or refused before any network call —
 * never defaulted, because a default applied in one place and not the other
 * is exactly the mismatch the storage host would reject.
 */
function contentTypeOrRefuse(value, where) {
  const type = typeof value === 'string' ? value.trim() : '';
  if (!type || !MIME_SHAPE.test(type)) {
    throw new PodbeanError(
      `${where} needs a content type shaped like audio/mpeg; got ${JSON.stringify(value ?? null)}.`,
      { status: null, code: 'VALIDATION', retryable: false }
    );
  }
  return type;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A statistics date, `YYYY-MM-DD` and a real calendar day, or refused before
 * any request. Podbean's own examples use this shape and nothing else; a
 * `Date`, an ISO timestamp or `2026-2-3` would reach it as a 400 whose text
 * names neither the parameter nor the value.
 */
function dateOrRefuse(value, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  const real = DATE_SHAPE.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
  if (!real) {
    throw new PodbeanError(
      `A statistics read needs ${name} as YYYY-MM-DD; got ${JSON.stringify(value ?? null)}.`,
      { status: null, code: 'VALIDATION', retryable: false }
    );
  }
  return text;
}

/** A `period` from the set the endpoint documents, or refused before any request. */
function periodOrRefuse(value, allowed) {
  if (!allowed.includes(value)) {
    throw new PodbeanError(
      `A statistics read needs period as one of ${allowed.join(', ')}; got ${JSON.stringify(value ?? null)}.`,
      { status: null, code: 'VALIDATION', retryable: false }
    );
  }
  return value;
}

/** `{ start, end, period }` validated together, as the four range statistics take them. */
function rangeOrRefuse({ start, end, period = 'd' } = {}) {
  const from = dateOrRefuse(start, 'start');
  const to = dateOrRefuse(end, 'end');
  if (from > to) {
    throw new PodbeanError(`A statistics read needs start (${from}) on or before end (${to}).`, {
      status: null,
      code: 'VALIDATION',
      retryable: false,
    });
  }
  return { start: from, end: to, period: periodOrRefuse(period, STATS_PERIODS) };
}

/** An episode id as Podbean issues them: a non-empty string, trimmed. Refused before any request. */
function episodeIdOrRefuse(value, where) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) {
    throw new PodbeanError(`${where} needs an episode id; got ${JSON.stringify(value ?? null)}.`, {
      status: null,
      code: 'VALIDATION',
      retryable: false,
    });
  }
  return id;
}

/**
 * ` (server_error)` when the answer carried an OAuth `error` code, else
 * nothing: the note a stored sentence may append to a status.
 *
 * @param {unknown} data - the parsed body, or null
 * @returns {string}
 */
function codeNote(data) {
  const code = typeof data?.error === 'string' ? data.error.trim() : '';
  return CODE_SHAPE.test(code) ? ` (${code})` : '';
}

/** `{ error, error_description }` → `error: description`, or the text, cut short. */
function describeErrorBody(data, text) {
  if (data && typeof data === 'object') {
    const parts = [data.error, data.error_description, data.message]
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => part.trim());
    if (parts.length) return parts.join(': ');
  }
  return String(text || '').slice(0, 300);
}

/** The body as JSON, or null when it is empty or not JSON; never throws. */
function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Build a client. Cheap; holds no connection, and caches the access token
 * for as long as Podbean says it lives (less `TOKEN_EXPIRY_MARGIN_MS`).
 * Every method throws `PodbeanError` and nothing else.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {Function} [options.fetch] injected for tests; normally global fetch
 * @param {() => number} [options.now] epoch milliseconds; injected for tests
 */
export function createPodbeanClient({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  signal = null,
} = {}) {
  const configured = isConfigured(env);
  const clientId = configured.ok ? readKey(env, CLIENT_ID_SETTING) : '';
  const clientSecret = configured.ok ? readKey(env, CLIENT_SECRET_SETTING) : '';
  const basic = configured.ok
    ? Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')
    : '';
  const accountKey = clientId ? createHash('sha256').update(clientId).digest('hex').slice(0, 16) : '';

  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;
  /** Every token this client has held, so a stale one quoted back is still scrubbed. */
  const seenTokens = new Set();

  /**
   * Remove every credential from a string about to leave this file. The
   * `access_token=` pattern catches a token this client never saw (an echo of
   * someone else's request line); the literal values catch an echo in any
   * other shape, raw or percent-encoded.
   */
  function scrub(value) {
    let out = String(value ?? '').replace(/access_token=[^&\s"'<>]*/gi, 'access_token=***');
    for (const secret of [clientSecret, basic, ...seenTokens]) {
      // Any length: a short credential is still a credential, and a few
      // over-redacted characters in an error message cost nothing (CodeRabbit
      // on #1117 — the old floor of 8 rested on no documented contract).
      if (typeof secret !== 'string' || !secret) continue;
      for (const form of new Set([secret, encodeURIComponent(secret)])) {
        out = out.split(form).join('***');
      }
    }
    return out;
  }

  /** Throw NOT_CONFIGURED, with isConfigured's sentence, unless both settings are set. */
  function requireConfigured() {
    if (!configured.ok) {
      throw new PodbeanError(configured.reason, { status: null, code: 'NOT_CONFIGURED' });
    }
  }

  /**
   * A transport failure (no response) on an api.podbean.com call: the
   * sentence names the operation and the code; the socket's text, scrubbed,
   * stays on `detail`.
   *
   * @param {string} operation - what was being done, in words
   * @param {unknown} error - what fetch threw
   * @returns {PodbeanError}
   */
  function transportError(operation, error) {
    const detail = scrub(error?.message || String(error));
    if (error?.code === 'FETCH_TIMEOUT') {
      return new PodbeanError(
        `Podbean did not answer while ${operation} within ${PODBEAN_TIMEOUT_MS} ms.`,
        {
          status: null,
          code: 'TIMEOUT',
          detail,
          retryable: true,
        }
      );
    }
    return new PodbeanError(
      `Podbean could not be reached while ${operation} (${transportCode(error)}).`,
      { status: null, code: 'NETWORK', detail, retryable: true }
    );
  }

  /**
   * POST /v1/oauth/token. Basic auth, form body, nothing in the URL. Cached
   * until `expires_in` less the margin; a response without a usable
   * `expires_in` is used for this call and not cached, rather than guessed at.
   */
  async function getToken() {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    requireConfigured();
    if (cached && now() < cached.expiresAt) return cached.token;
    cached = null;

    const operation = 'requesting an access token';
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, `${PODBEAN_API_BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        timeoutMs: PODBEAN_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      throw transportError(operation, error);
    }
    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      const detail = scrub(describeErrorBody(data, text));
      const suffix = ` (${statusAndCode(response.status, data)})`;
      const oauthError = typeof data?.error === 'string' ? data.error : '';
      if (
        CREDENTIAL_ERRORS.has(oauthError) ||
        response.status === 401 ||
        response.status === 403
      ) {
        throw new PodbeanError(
          `Podbean refused the client ID and secret while ${operation}${suffix}.`,
          { status: response.status, code: 'CREDENTIALS_REJECTED', detail, retryable: false }
        );
      }
      const { code, retryable } = classify(response.status);
      throw new PodbeanError(
        `Podbean answered ${response.status} while ${operation}${codeNote(data)}.`,
        { status: response.status, code, detail, retryable }
      );
    }

    const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
    if (!token) {
      throw new PodbeanError('Podbean answered the token request without an access token.', {
        status: response.status,
        code: 'UPSTREAM',
        retryable: false,
      });
    }
    seenTokens.add(token);
    const lifetime = Number(data.expires_in);
    if (Number.isFinite(lifetime) && lifetime * 1000 > TOKEN_EXPIRY_MARGIN_MS) {
      cached = { token, expiresAt: now() + lifetime * 1000 - TOKEN_EXPIRY_MARGIN_MS };
    }
    return token;
  }

  /**
   * One authenticated call. `query` goes on the URL for a GET, `form` is the
   * body of a POST; the token is added to whichever carries it. An array
   * value in `query` is repeated under its key, one entry per element (the
   * analytic report's `types[]`). Repeats once, with a fresh token, on
   * `invalid_token` — the only repeat in this file.
   */
  async function call(operation, method, path, { query, form } = {}, { reauthed = false } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const token = await getToken();
    const url = new URL(`${PODBEAN_API_BASE_URL}${path}`);
    let body;
    if (method === 'GET') {
      url.searchParams.set('access_token', token);
      for (const [key, value] of Object.entries(query || {})) {
        if (Array.isArray(value)) {
          for (const entry of value) url.searchParams.append(key, String(entry));
        } else if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    } else {
      const params = new URLSearchParams();
      params.set('access_token', token);
      for (const [key, value] of Object.entries(form || {})) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      body = params.toString();
    }

    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        timeoutMs: PODBEAN_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      throw transportError(operation, error);
    }
    const text = await response.text();
    const data = parseJson(text);
    if (response.ok) return data;

    const oauthError = typeof data?.error === 'string' ? data.error : '';
    const detail = scrub(describeErrorBody(data, text));

    if (oauthError === 'invalid_token') {
      cached = null;
      if (!reauthed) return call(operation, method, path, { query, form }, { reauthed: true });
      throw new PodbeanError(
        `Podbean refused a freshly issued access token while ${operation} (${statusAndCode(response.status, data)}).`,
        { status: response.status, code: 'TOKEN_REJECTED', detail, retryable: false }
      );
    }
    if (oauthError === 'storage_limit_reach') {
      throw new PodbeanError(
        `Podbean refused the upload: the account's storage allowance is used up (${statusAndCode(response.status, data)}).`,
        { status: response.status, code: 'STORAGE_LIMIT', detail, retryable: false }
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new PodbeanError(
        `Podbean refused the app's access while ${operation} (${statusAndCode(response.status, data)}); ` +
          "check the app's permissions at developers.podbean.com.",
        { status: response.status, code: 'CREDENTIALS_REJECTED', detail, retryable: false }
      );
    }
    const { code, retryable } = classify(response.status);
    throw new PodbeanError(
      `Podbean answered ${response.status} while ${operation}${codeNote(data)}.`,
      { status: response.status, code, detail, retryable }
    );
  }

  return {
    /** `isConfigured(env)` for this client, so a caller need not re-read env. */
    configured,

    /**
     * A stand-in for the account this client reads: the first sixteen hex
     * digits of SHA-256 over the client id, `''` when not configured. Not a
     * secret and not the id, so it can sit on a cached document; a cache
     * keyed to it is a miss the moment the settings point at another
     * account, rather than serving the previous account's rows until expiry
     * (CodeRabbit on #1127).
     */
    accountKey,

    /** The access token, from the cache while it lives. */
    getToken,

    /** `GET /v1/podcast` → `{ podcast: { id, title, … } }`. */
    getPodcast() {
      return call('reading the podcast', 'GET', '/podcast');
    },

    /**
     * `GET /v1/episodes?offset&limit` → `{ episodes: [Episode], offset, limit,
     * has_more, count }`, newest first (`limit` at most 100). Read-only:
     * `host-publish.js` uses it to find an episode that an earlier create may
     * have made without its answer arriving, before it creates another.
     */
    listEpisodes({ offset = 0, limit = 20 } = {}) {
      return call('listing episodes', 'GET', '/episodes', { query: { offset, limit } });
    },

    /** `GET /v1/episodes/{id}` → `{ episode }`. Read-only; the hub's live status for one episode. */
    async getEpisode(episodeId) {
      const id = episodeIdOrRefuse(episodeId, 'An episode read');
      return call('reading the episode', 'GET', `/episodes/${encodeURIComponent(id)}`);
    },

    /**
     * `GET /v1/podcastStats/stats` → `{ [date]: downloads }`, daily keys for
     * `period: 'd'` and monthly for `'m'`. Without `episodeId` the figures are
     * the whole show's; with it, that episode's. `end` later than yesterday
     * is clamped by Podbean, not refused.
     */
    async getDownloadStats({ start, end, period = 'd', episodeId } = {}) {
      const range = rangeOrRefuse({ start, end, period });
      const query = { ...range };
      if (episodeId !== undefined && episodeId !== null) {
        query.episode_id = episodeIdOrRefuse(episodeId, 'A per-episode download read');
      }
      return call('reading download statistics', 'GET', '/podcastStats/stats', { query });
    },

    /** `GET /v1/podcastStats/countries` → `{ [countryCode]: downloads }` for the range. */
    async getCountryStats(range = {}) {
      return call('reading country statistics', 'GET', '/podcastStats/countries', {
        query: rangeOrRefuse(range),
      });
    },

    /** `GET /v1/podcastStats/platforms` → `{ [platform]: downloads }` for the range. */
    async getPlatformStats(range = {}) {
      return call('reading platform statistics', 'GET', '/podcastStats/platforms', {
        query: rangeOrRefuse(range),
      });
    },

    /** `GET /v1/podcastStats/sources` → `{ [source]: downloads }` (apps and directories) for the range. */
    async getSourceStats(range = {}) {
      return call('reading source statistics', 'GET', '/podcastStats/sources', {
        query: rangeOrRefuse(range),
      });
    },

    /** `GET /v1/podcastStats/userRetention?period=m|w` → `{ [cohortLabel]: [{ listeners, retention }] }`. */
    async getUserRetention({ period = 'm' } = {}) {
      return call('reading listener retention', 'GET', '/podcastStats/userRetention', {
        query: { period: periodOrRefuse(period, RETENTION_PERIODS) },
      });
    },

    /**
     * `GET /v1/analytics/podcastAnalyticReports?types[]=…` → one number per
     * requested type: `{ followers, likes, comments, total_episode_length }`.
     * Every type must be one the API documents; the whole list is the default.
     */
    async getAnalyticReports({ types = ANALYTIC_REPORT_TYPES } = {}) {
      const list = Array.isArray(types) ? types : [];
      const unknown = list.filter((type) => !ANALYTIC_REPORT_TYPES.includes(type));
      if (!list.length || unknown.length) {
        throw new PodbeanError(
          `An analytic report read needs types from ${ANALYTIC_REPORT_TYPES.join(', ')}; got ${JSON.stringify(types ?? null)}.`,
          { status: null, code: 'VALIDATION', retryable: false }
        );
      }
      return call('reading the analytic report', 'GET', '/analytics/podcastAnalyticReports', {
        query: { [ANALYTIC_TYPES_PARAM]: list },
      });
    },

    /**
     * `GET /v1/files/uploadAuthorize` → `{ presigned_url, file_key, … }`. The
     * caller PUTs the bytes to `presigned_url` and sends `file_key` as the
     * episode's `media_key`.
     */
    async authorizeUpload({ filename, filesize, contentType } = {}) {
      const type = contentTypeOrRefuse(contentType, 'An upload authorisation');
      const name = typeof filename === 'string' ? filename.trim() : '';
      if (!name) {
        throw new PodbeanError('An upload authorisation needs a filename.', {
          status: null,
          code: 'VALIDATION',
        });
      }
      if (!Number.isInteger(filesize) || filesize <= 0) {
        throw new PodbeanError(
          `An upload authorisation needs the file size in bytes; got ${JSON.stringify(filesize ?? null)}.`,
          { status: null, code: 'VALIDATION' }
        );
      }
      return call('authorising the upload', 'GET', '/files/uploadAuthorize', {
        query: { filename: name, filesize, content_type: type },
      });
    },

    /**
     * PUT the bytes to a presigned URL. No token: the URL is the credential,
     * and it points at a storage host that has no use for ours.
     *
     * @param {string} presignedUrl
     * @param {Buffer|Uint8Array} bytes
     * @param {string} contentType must equal the `content_type` the upload was authorised for
     */
    async uploadMedia(presignedUrl, bytes, contentType) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      requireConfigured();
      let host;
      try {
        const parsed = new URL(presignedUrl);
        if (parsed.protocol !== 'https:') throw new Error('not https');
        host = parsed.hostname;
      } catch {
        throw new PodbeanError('The upload authorisation did not carry an https URL to PUT to.', {
          status: null,
          code: 'VALIDATION',
        });
      }
      if (!bytes || !bytes.length) {
        throw new PodbeanError('Refusing to upload zero bytes of audio.', {
          status: null,
          code: 'VALIDATION',
        });
      }
      // Validated before fetch sees it: an empty or malformed header value
      // makes fetch throw, and that throw would otherwise be misreported as
      // the upload host being unreachable.
      const type = contentTypeOrRefuse(contentType, 'The audio PUT');
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, presignedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': type, 'Content-Length': String(bytes.length) },
          body: bytes,
          timeoutMs: PODBEAN_UPLOAD_TIMEOUT_MS,
          signal,
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        // The PUT goes to the storage host the presigned URL names, not to
        // api.podbean.com, so a DNS failure or a timeout there must not read
        // as "Podbean could not be reached" — an operator would check the
        // wrong host. The message names the host and never the signed URL.
        const detail = scrub(error?.message || String(error)).split(presignedUrl).join(host);
        const what =
          error?.code === 'FETCH_TIMEOUT'
            ? `did not answer the PUT within ${PODBEAN_UPLOAD_TIMEOUT_MS} ms`
            : `could not be reached for the PUT (${transportCode(error)})`;
        throw new PodbeanError(
          `The upload host ${host} ${what} — re-run to authorise a fresh upload.`,
          { status: null, code: 'UPLOAD_UNREACHABLE', detail, retryable: true }
        );
      }
      if (!response.ok) {
        const text = typeof response.text === 'function' ? await response.text() : '';
        // The host's own body stays on `detail`; the sentence names the
        // host and the status only (#945).
        const detail = scrub(String(text || '').slice(0, 300));
        if (response.status === 401 || response.status === 403) {
          // That request carries no token, so its refusal must not read as
          // "the token was rejected". The usual cause is an expired URL
          // (Podbean grants ten minutes), and a re-run authorises a new one.
          throw new PodbeanError(
            `The upload host ${host} refused the PUT (HTTP ${response.status}) — ` +
              'the presigned URL may have expired; re-run to authorise a fresh upload.',
            { status: response.status, code: 'UPLOAD_REJECTED', detail, retryable: true }
          );
        }
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new PodbeanError(
          `The upload host ${host} answered ${response.status} to the PUT.`,
          { status: response.status, code: 'UPLOAD_FAILED', detail, retryable }
        );
      }
      return { status: response.status, bytes: bytes.length };
    },

    /** `POST /v1/episodes`. `fields` are the form fields verbatim (snake_case). Never repeated. */
    createEpisode(fields) {
      return call('creating the episode', 'POST', '/episodes', { form: fields });
    },

    /** `POST /v1/episodes/{id}`. Send title, content, status and type every time. */
    updateEpisode(episodeId, fields) {
      return call(
        'updating the episode',
        'POST',
        `/episodes/${encodeURIComponent(String(episodeId))}`,
        { form: fields }
      );
    },
  };
}

/**
 * The code and retryability of an HTTP failure that no more specific rule
 * claimed: 400 is VALIDATION, 404 NOT_FOUND, 408/429/5xx a retryable
 * UPSTREAM, anything else a final UPSTREAM.
 *
 * @param {number} status
 * @returns {{ code: string, retryable: boolean }}
 */
function classify(status) {
  if (status === 400) return { code: 'VALIDATION', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  if (status === 408 || status === 429 || status >= 500) {
    return { code: 'UPSTREAM', retryable: true };
  }
  return { code: 'UPSTREAM', retryable: false };
}

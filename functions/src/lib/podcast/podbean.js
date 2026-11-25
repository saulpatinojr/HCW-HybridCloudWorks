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
import { PodbeanError, transportCode } from './podbean-error.js';
import { call, getToken, isAbort, PODBEAN_TIMEOUT_MS, requireConfigured, stopIfAborted } from './podbean-request.js';
import {
  analyticTypesOrRefuse,
  contentTypeOrRefuse,
  episodeIdOrRefuse,
  periodOrRefuse,
  rangeOrRefuse,
  RETENTION_PERIODS,
  uploadFileOrRefuse,
  ANALYTIC_REPORT_TYPES,
} from './podbean-validate.js';

// The error type lives in podbean-error.js, the token and the call in
// podbean-request.js, and the checks before a call in podbean-validate.js;
// exported again here so callers keep importing from podbean.js.
export { PodbeanError } from './podbean-error.js';
export { PODBEAN_API_BASE_URL, PODBEAN_TIMEOUT_MS, TOKEN_EXPIRY_MARGIN_MS } from './podbean-request.js';
export { ANALYTIC_REPORT_TYPES, RETENTION_PERIODS, STATS_PERIODS } from './podbean-validate.js';

/**
 * The audio PUT. A Listen & Learn episode is 64 kbps mono, so twenty minutes
 * is under 10 MB; five minutes is ample for that and for a human recording
 * several times the size, and still a deadline rather than forever.
 */
export const PODBEAN_UPLOAD_TIMEOUT_MS = 300_000;

export const CLIENT_ID_SETTING = 'PODBEAN_CLIENT_ID';
export const CLIENT_SECRET_SETTING = 'PODBEAN_CLIENT_SECRET';

const SETTING_SECRETS = Object.freeze({
  [CLIENT_ID_SETTING]: 'PODBEAN-CLIENT-ID',
  [CLIENT_SECRET_SETTING]: 'PODBEAN-CLIENT-SECRET',
});

/** How the array parameter is spelled on the wire (see the header: unverified live). */
const ANALYTIC_TYPES_PARAM = 'types[]';

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

/**
 * Remove every credential from a string about to leave this file. The
 * `access_token=` pattern catches a token this client never saw (an echo of
 * someone else's request line); the literal values catch an echo in any
 * other shape, raw or percent-encoded.
 */
function scrubSecrets(c, value) {
  let out = String(value ?? '').replace(/access_token=[^&\s"'<>]*/gi, 'access_token=***');
  for (const secret of [c.clientSecret, c.basic, ...c.seenTokens]) {
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

/**
 * A transport failure (no response) on an api.podbean.com call: the
 * sentence names the operation and the code; the socket's text, scrubbed,
 * stays on `detail`.
 *
 * @param {object} c - the client's state
 * @param {string} operation - what was being done, in words
 * @param {unknown} error - what fetch threw
 * @returns {PodbeanError}
 */
function transportError(c, operation, error) {
  const { scrub } = c;
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

/** The host of a presigned upload address, which must be https; refused otherwise. */
function uploadHost(presignedUrl) {
  try {
    const parsed = new URL(presignedUrl);
    if (parsed.protocol !== 'https:') throw new Error('not https');
    return parsed.hostname;
  } catch {
    throw new PodbeanError('The upload authorisation did not carry an https URL to PUT to.', {
      status: null,
      code: 'VALIDATION',
    });
  }
}

/** The error for an upload host that answered the PUT with a failure. */
async function putRefusal(c, host, response) {
  const text = typeof response.text === 'function' ? await response.text() : '';
  // The host's own body stays on `detail`; the sentence names the
  // host and the status only (#945).
  const detail = c.scrub(String(text || '').slice(0, 300));
  if (response.status === 401 || response.status === 403) {
    // That request carries no token, so its refusal must not read as
    // "the token was rejected". The usual cause is an expired URL
    // (Podbean grants ten minutes), and a re-run authorises a new one.
    return new PodbeanError(
      `The upload host ${host} refused the PUT (HTTP ${response.status}) — ` +
        'the presigned URL may have expired; re-run to authorise a fresh upload.',
      { status: response.status, code: 'UPLOAD_REJECTED', detail, retryable: true }
    );
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new PodbeanError(
    `The upload host ${host} answered ${response.status} to the PUT.`,
    { status: response.status, code: 'UPLOAD_FAILED', detail, retryable }
  );
}

/** Whatever upload request was refused before the PUT: not configured, a bad address, no bytes. */
function checkUpload(c, presignedUrl, bytes) {
  stopIfAborted(c.signal);
  requireConfigured(c);
  const host = uploadHost(presignedUrl);
  if (!bytes || !bytes.length) {
    throw new PodbeanError('Refusing to upload zero bytes of audio.', {
      status: null,
      code: 'VALIDATION',
    });
  }
  return host;
}

/**
 * PUT the bytes to a presigned URL. No token: the URL is the credential,
 * and it points at a storage host that has no use for ours.
 *
 * @param {object} c - the client's state
 * @param {string} presignedUrl
 * @param {Buffer|Uint8Array} bytes
 * @param {string} contentType must equal the `content_type` the upload was authorised for
 */
async function uploadMedia(c, presignedUrl, bytes, contentType) {
  const { scrub, signal } = c;
  const host = checkUpload(c, presignedUrl, bytes);
  // Validated before fetch sees it: an empty or malformed header value
  // makes fetch throw, and that throw would otherwise be misreported as
  // the upload host being unreachable.
  const type = contentTypeOrRefuse(contentType, 'The audio PUT');
  let response;
  try {
    response = await fetchWithTimeout(c.fetchImpl, presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': type, 'Content-Length': String(bytes.length) },
      body: bytes,
      timeoutMs: PODBEAN_UPLOAD_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (isAbort(signal, error)) throw error;
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
  if (!response.ok) throw await putRefusal(c, host, response);
  return { status: response.status, bytes: bytes.length };
}

/** The download statistics query: the range, and the episode when one is named. */
function downloadQuery({ start, end, period = 'd', episodeId }) {
  const query = { ...rangeOrRefuse({ start, end, period }) };
  if (episodeId !== undefined && episodeId !== null) {
    query.episode_id = episodeIdOrRefuse(episodeId, 'A per-episode download read');
  }
  return query;
}

/** The client's state: its settings, its token cache, and the credential scrubbing. */
function clientState({ env, fetchImpl, now, signal }) {
  const configured = isConfigured(env);
  const clientId = configured.ok ? readKey(env, CLIENT_ID_SETTING) : '';
  const clientSecret = configured.ok ? readKey(env, CLIENT_SECRET_SETTING) : '';
  const c = {
    fetchImpl,
    now,
    signal,
    configured,
    clientSecret,
    basic: configured.ok ? Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64') : '',
    accountKey: clientId ? createHash('sha256').update(clientId).digest('hex').slice(0, 16) : '',
    /** @type {{ token: string, expiresAt: number } | null} */
    cached: null,
    /** Every token this client has held, so a stale one quoted back is still scrubbed. */
    seenTokens: new Set(),
  };
  c.scrub = (value) => scrubSecrets(c, value);
  c.errorDetail = (data, text) => c.scrub(describeErrorBody(data, text));
  c.transportError = (operation, error) => transportError(c, operation, error);
  return c;
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
  const c = clientState({ env, fetchImpl, now, signal });
  const get = (operation, path, query) => call(c, { operation, method: 'GET', path, query });
  const post = (operation, path, form) => call(c, { operation, method: 'POST', path, form });

  return {
    /** `isConfigured(env)` for this client, so a caller need not re-read env. */
    configured: c.configured,

    /**
     * A stand-in for the account this client reads: the first sixteen hex
     * digits of SHA-256 over the client id, `''` when not configured. Not a
     * secret and not the id, so it can sit on a cached document; a cache
     * keyed to it is a miss the moment the settings point at another
     * account, rather than serving the previous account's rows until expiry
     * (CodeRabbit on #1127).
     */
    accountKey: c.accountKey,

    /** The access token, from the cache while it lives. */
    getToken: () => getToken(c),

    /** `GET /v1/podcast` → `{ podcast: { id, title, … } }`. */
    getPodcast() {
      return get('reading the podcast', '/podcast');
    },

    /**
     * `GET /v1/episodes?offset&limit` → `{ episodes: [Episode], offset, limit,
     * has_more, count }`, newest first (`limit` at most 100). Read-only:
     * `host-publish.js` uses it to find an episode that an earlier create may
     * have made without its answer arriving, before it creates another.
     */
    listEpisodes({ offset = 0, limit = 20 } = {}) {
      return get('listing episodes', '/episodes', { offset, limit });
    },

    /** `GET /v1/episodes/{id}` → `{ episode }`. Read-only; the hub's live status for one episode. */
    async getEpisode(episodeId) {
      const id = episodeIdOrRefuse(episodeId, 'An episode read');
      return get('reading the episode', `/episodes/${encodeURIComponent(id)}`);
    },

    /**
     * `GET /v1/podcastStats/stats` → `{ [date]: downloads }`, daily keys for
     * `period: 'd'` and monthly for `'m'`. Without `episodeId` the figures are
     * the whole show's; with it, that episode's. `end` later than yesterday
     * is clamped by Podbean, not refused.
     */
    async getDownloadStats(options = {}) {
      return get('reading download statistics', '/podcastStats/stats', downloadQuery(options));
    },

    /** `GET /v1/podcastStats/countries` → `{ [countryCode]: downloads }` for the range. */
    async getCountryStats(range = {}) {
      return get('reading country statistics', '/podcastStats/countries', rangeOrRefuse(range));
    },

    /** `GET /v1/podcastStats/platforms` → `{ [platform]: downloads }` for the range. */
    async getPlatformStats(range = {}) {
      return get('reading platform statistics', '/podcastStats/platforms', rangeOrRefuse(range));
    },

    /** `GET /v1/podcastStats/sources` → `{ [source]: downloads }` (apps and directories) for the range. */
    async getSourceStats(range = {}) {
      return get('reading source statistics', '/podcastStats/sources', rangeOrRefuse(range));
    },

    /** `GET /v1/podcastStats/userRetention?period=m|w` → `{ [cohortLabel]: [{ listeners, retention }] }`. */
    async getUserRetention({ period = 'm' } = {}) {
      return get('reading listener retention', '/podcastStats/userRetention', {
        period: periodOrRefuse(period, RETENTION_PERIODS),
      });
    },

    /**
     * `GET /v1/analytics/podcastAnalyticReports?types[]=…` → one number per
     * requested type: `{ followers, likes, comments, total_episode_length }`.
     * Every type must be one the API documents; the whole list is the default.
     */
    async getAnalyticReports({ types = ANALYTIC_REPORT_TYPES } = {}) {
      const list = analyticTypesOrRefuse(types);
      return get('reading the analytic report', '/analytics/podcastAnalyticReports', {
        [ANALYTIC_TYPES_PARAM]: list,
      });
    },

    /**
     * `GET /v1/files/uploadAuthorize` → `{ presigned_url, file_key, … }`. The
     * caller PUTs the bytes to `presigned_url` and sends `file_key` as the
     * episode's `media_key`.
     */
    async authorizeUpload({ filename, filesize, contentType } = {}) {
      const type = contentTypeOrRefuse(contentType, 'An upload authorisation');
      const name = uploadFileOrRefuse(filename, filesize);
      return get('authorising the upload', '/files/uploadAuthorize', {
        filename: name,
        filesize,
        content_type: type,
      });
    },

    /**
     * PUT the bytes to a presigned URL. No token: the URL is the credential,
     * and it points at a storage host that has no use for ours.
     */
    uploadMedia: (presignedUrl, bytes, contentType) => uploadMedia(c, presignedUrl, bytes, contentType),

    /** `POST /v1/episodes`. `fields` are the form fields verbatim (snake_case). Never repeated. */
    createEpisode(fields) {
      return post('creating the episode', '/episodes', fields);
    },

    /** `POST /v1/episodes/{id}`. Send title, content, status and type every time. */
    updateEpisode(episodeId, fields) {
      return post('updating the episode', `/episodes/${encodeURIComponent(String(episodeId))}`, fields);
    },
  };
}

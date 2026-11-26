/**
 * cloudflare/client.js — the calls the Cloudflare page makes to Cloudflare's
 * API (#1905), for one zone, with the admin token.
 *
 * Every call goes through guardedFetch (https only, no redirects, a deadline
 * and a size cap), to a path built here from fixed pieces and ids the
 * handlers have already checked. The token goes in the Authorization header
 * and nowhere else: it is never in a URL, an error, an answer or a log line.
 *
 * A refusal from Cloudflare becomes a CloudflareError with a sentence written
 * here, chosen by the HTTP status. Cloudflare's own words are never passed
 * on (they can quote what was sent back); only its numeric error codes are,
 * so the owner can look one up.
 *
 * API reference: https://developers.cloudflare.com/api/
 */
import { guardedFetch } from '../http/guarded-fetch.js';
import { AuthoredError, codeShaped } from '../http/error-response.js';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const TOKEN_SETTING = 'CLOUDFLARE_ADMIN_TOKEN';
export const ZONE_SETTING = 'CF_ZONE_ID';
/** A Cloudflare zone id: 32 lower-case hex characters. */
export const ZONE_ID_PATTERN = /^[a-f0-9]{32}$/;

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** DNS records are listed 100 a page, and at most this many pages (5,000 records). */
const DNS_PAGE_SIZE = 100;
const DNS_MAX_PAGES = 50;

/** A refusal or failure from Cloudflare, with a sentence written here. */
export class CloudflareError extends AuthoredError {
  /**
   * @param {string} message the sentence for the answer
   * @param {{ status: number, upstreamStatus?: number|null, codes?: string[], code?: string }} options
   */
  constructor(message, { status, upstreamStatus = null, codes = [], code = 'CLOUDFLARE_REFUSED' }) {
    super(message, { code, status });
    this.upstreamStatus = upstreamStatus;
    this.codes = codes;
  }
}

/** Cloudflare's numeric error codes from an answer, never its messages. */
function errorCodes(body) {
  const list = Array.isArray(body?.errors) ? body.errors : [];
  return list.map((entry) => codeShaped(entry?.code)).filter(Boolean).slice(0, 5);
}

/** The sentence and the status this API answers with for a Cloudflare refusal. */
function refusal(upstreamStatus, codes) {
  const suffix = codes.length ? ` (Cloudflare error code ${codes.join(', ')})` : '';
  if (upstreamStatus === 400) {
    return { status: 400, sentence: `Cloudflare refused the change as not valid${suffix}. Check the value and try again.` };
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      status: 502,
      sentence: `Cloudflare refused the token for this (HTTP ${upstreamStatus})${suffix}. It may be wrong, expired, or missing the permission for this kind of change; check it on Integrations → Keys.`,
    };
  }
  if (upstreamStatus === 404) return { status: 404, sentence: `Cloudflare has no such item${suffix}.` };
  if (upstreamStatus === 409) return { status: 409, sentence: `Cloudflare refused the change because it conflicts with what is there${suffix}.` };
  if (upstreamStatus === 429) return { status: 429, sentence: 'Cloudflare is limiting requests right now. Wait a minute and try again.' };
  return { status: 502, sentence: `Cloudflare answered with an error (HTTP ${upstreamStatus})${suffix}. Try again shortly.` };
}

/**
 * @param {object} options
 * @param {string} options.token the admin token, read by the caller with readSetting
 * @param {string} options.zoneId the zone id, already checked against ZONE_ID_PATTERN
 * @param {typeof fetch} [options.fetch] for tests
 * @param {Function} [options.resolve] for tests
 * @param {Function} [options.dispatcherFor] for tests
 */
export function createCloudflareClient({ token, zoneId, fetch: fetchImpl, resolve, dispatcherFor }) {
  if (!ZONE_ID_PATTERN.test(String(zoneId || ''))) throw new Error('createCloudflareClient: zone id has the wrong shape');
  const zonePath = `/zones/${zoneId}`;

  /** One call. Answers `{ status, body }` for a 2xx; throws CloudflareError otherwise. */
  async function call(method, path, { query = null, body = undefined, allow404 = false } = {}) {
    const url = new URL(`${CLOUDFLARE_API_BASE}${path}`);
    for (const [name, value] of Object.entries(query || {})) url.searchParams.set(name, String(value));
    const deps = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      httpsOnly: true,
      maxRedirects: 0,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    };
    if (fetchImpl) deps.fetch = fetchImpl;
    if (resolve) deps.resolve = resolve;
    if (dispatcherFor) deps.dispatcherFor = dispatcherFor;

    let response;
    let text;
    try {
      ({ response, text } = await guardedFetch(url.toString(), deps));
    } catch {
      // A timeout, a refused address or an oversized answer: none of its
      // text is passed on, and the handler logs this error's code.
      throw new CloudflareError('Cloudflare could not be reached. Try again shortly.', {
        status: 502,
        code: 'CLOUDFLARE_UNREACHABLE',
      });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text());
    } catch {
      parsed = null;
    }
    const status = response.status;
    if (status === 404 && allow404) return { status, body: null };
    if (status >= 200 && status < 300 && parsed && parsed.success !== false) return { status, body: parsed };
    const codes = errorCodes(parsed);
    const { status: answer, sentence } = refusal(status >= 200 && status < 300 ? 502 : status, codes);
    throw new CloudflareError(sentence, { status: answer, upstreamStatus: status, codes });
  }

  /** Whether a read is allowed: true for a 2xx, false for 401/403, null for anything else. */
  async function canRead(path, query) {
    try {
      await call('GET', path, { query });
      return true;
    } catch (error) {
      if (error?.upstreamStatus === 401 || error?.upstreamStatus === 403) return false;
      return null;
    }
  }

  return Object.freeze({
    zoneId,
    getZone: async () => (await call('GET', zonePath)).body.result,
    canRead: (family) => {
      const probes = {
        settings: [`${zonePath}/settings/ssl`],
        dns: [`${zonePath}/dns_records`, { per_page: 1 }],
        rules: [`${zonePath}/rulesets`],
        cache: [`${zonePath}/settings/cache_level`],
      };
      const [path, query] = probes[family];
      return canRead(path, query);
    },
    listSettings: async () => (await call('GET', `${zonePath}/settings`)).body.result,
    patchSetting: async (settingId, value) =>
      (await call('PATCH', `${zonePath}/settings/${encodeURIComponent(settingId)}`, { body: { value } })).body.result,
    purge: async (body) => (await call('POST', `${zonePath}/purge_cache`, { body })).body.result,
    listDns: async () => {
      const records = [];
      for (let page = 1; page <= DNS_MAX_PAGES; page += 1) {
        const { body } = await call('GET', `${zonePath}/dns_records`, { query: { page, per_page: DNS_PAGE_SIZE } });
        records.push(...(Array.isArray(body.result) ? body.result : []));
        const totalPages = Number(body.result_info?.total_pages) || 1;
        if (page >= totalPages) break;
      }
      return records;
    },
    getDns: async (recordId) => (await call('GET', `${zonePath}/dns_records/${encodeURIComponent(recordId)}`)).body.result,
    createDns: async (record) => (await call('POST', `${zonePath}/dns_records`, { body: record })).body.result,
    patchDns: async (recordId, changes) =>
      (await call('PATCH', `${zonePath}/dns_records/${encodeURIComponent(recordId)}`, { body: changes })).body.result,
    listRulesets: async () => (await call('GET', `${zonePath}/rulesets`)).body.result,
    getPhase: async (phase) => {
      const { body } = await call('GET', `${zonePath}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`, {
        allow404: true,
      });
      return body ? body.result : null;
    },
    putPhase: async (phase, ruleset) =>
      (await call('PUT', `${zonePath}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`, { body: ruleset })).body
        .result,
  });
}

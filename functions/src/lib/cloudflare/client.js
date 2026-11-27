/**
 * cloudflare/client.js — the calls the Cloudflare page makes to Cloudflare's
 * API (#1905), for one zone, with the admin token.
 *
 * The site's zone is named by its id (CF_ZONE_ID, set by Terraform). Any
 * other managed zone (protected.js MANAGED_ZONES; the lab zone, #1911) is
 * named by its name, and its id is looked up once with the same token
 * (`GET /zones?name=`), then kept for the instance's life. A lookup must
 * find exactly one active zone of exactly that name, or it is refused with
 * a sentence saying the token cannot reach it; a failed lookup is never
 * kept, and a kept id is forgotten when Cloudflare answers 403 or 404 for
 * the zone itself (the zone was removed, or the token lost it). A 403 or
 * 404 for something inside the zone (a record, a setting, a rule set) says
 * nothing about the zone, so the id is kept.
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
 * Each call is a small function at the top level of this file, handed the
 * connection (`conn`: the token and the test doubles), so no one function
 * holds the whole client.
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
/**
 * DNS records are listed 100 a page, and at most this many pages (5,000
 * records). A zone with more is cut at the cap, and the list says so
 * (`truncated: true`) rather than passing a part off as the whole.
 */
export const DNS_PAGE_SIZE = 100;
export const DNS_MAX_PAGES = 50;

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

const TOKEN_REFUSED = {
  status: 502,
  sentence: (suffix, upstream) =>
    `Cloudflare refused the token for this (HTTP ${upstream})${suffix}. It may be wrong, expired, or missing the permission for this kind of change; check it on Integrations → Keys.`,
};

/** The status this API answers with, and its sentence, for each status Cloudflare refuses with. */
const REFUSALS = Object.freeze({
  400: { status: 400, sentence: (suffix) => `Cloudflare refused the change as not valid${suffix}. Check the value and try again.` },
  401: TOKEN_REFUSED,
  403: TOKEN_REFUSED,
  404: { status: 404, sentence: (suffix) => `Cloudflare has no such item${suffix}.` },
  409: { status: 409, sentence: (suffix) => `Cloudflare refused the change because it conflicts with what is there${suffix}.` },
  429: { status: 429, sentence: () => 'Cloudflare is limiting requests right now. Wait a minute and try again.' },
});
const OTHER_REFUSAL = {
  status: 502,
  sentence: (suffix, upstream) => `Cloudflare answered with an error (HTTP ${upstream})${suffix}. Try again shortly.`,
};

/** The sentence and the status this API answers with for a Cloudflare refusal. */
export function refusal(upstreamStatus, codes) {
  const suffix = codes.length ? ` (Cloudflare error code ${codes.join(', ')})` : '';
  const entry = REFUSALS[upstreamStatus] || OTHER_REFUSAL;
  return { status: entry.status, sentence: entry.sentence(suffix, upstreamStatus) };
}

/** The address of one call: the base, the path built by the caller, and its query. */
function urlOf(path, query) {
  const url = new URL(`${CLOUDFLARE_API_BASE}${path}`);
  for (const [name, value] of Object.entries(query || {})) url.searchParams.set(name, String(value));
  return url.toString();
}

/** What guardedFetch is handed: the method, the token header, the body and the limits. */
function fetchOptions(conn, method, body) {
  const hasBody = body !== undefined;
  return {
    method,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
    httpsOnly: true,
    maxRedirects: 0,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    ...conn.doubles,
  };
}

/** One fetch. A timeout, a refused address or an oversized answer becomes one fixed sentence. */
async function send(url, options) {
  try {
    return await guardedFetch(url, options);
  } catch {
    // None of the transport's text is passed on; the handler logs this error's code.
    throw new CloudflareError('Cloudflare could not be reached. Try again shortly.', {
      status: 502,
      code: 'CLOUDFLARE_UNREACHABLE',
    });
  }
}

/** The answer's JSON, or null when it is not JSON. */
function parseAnswer(text) {
  try {
    return JSON.parse(text());
  } catch {
    return null;
  }
}

const isSuccess = (status, body) => status >= 200 && status < 300 && Boolean(body) && body.success !== false;

/** The error for an answer that is not a success (a 2xx Cloudflare marks failed counts as 502). */
function refusalError(status, body) {
  const codes = errorCodes(body);
  const upstream = status >= 200 && status < 300 ? 502 : status;
  const { status: answer, sentence } = refusal(upstream, codes);
  return new CloudflareError(sentence, { status: answer, upstreamStatus: status, codes });
}

/** One call. Answers `{ status, body }` for a 2xx (or a 404 the caller allows); throws CloudflareError otherwise. */
async function call(conn, method, path, { query = null, body = undefined, allow404 = false } = {}) {
  const { response, text } = await send(urlOf(path, query), fetchOptions(conn, method, body));
  const parsed = parseAnswer(text);
  const status = response.status;
  if (status === 404 && allow404) return { status, body: null };
  if (isSuccess(status, parsed)) return { status, body: parsed };
  throw refusalError(status, parsed);
}

/** The `result` of a call. */
const resultOf = async (conn, method, path, options) => (await call(conn, method, path, options)).body.result;

/**
 * Whether a read is allowed: true for a 2xx, false for 401/403, null for
 * anything else. `path` is a promise, so a zone lookup that fails counts as
 * the read failing.
 */
async function canRead(conn, path, query) {
  try {
    await call(conn, 'GET', await path, { query });
    return true;
  } catch (error) {
    const refused = error?.upstreamStatus === 401 || error?.upstreamStatus === 403;
    return refused ? false : null;
  }
}

/** The one cheap read per family the status route tries. */
const READ_PROBES = Object.freeze({
  settings: ['/settings/ssl'],
  dns: ['/dns_records', { per_page: 1 }],
  rules: ['/rulesets'],
  cache: ['/settings/cache_level'],
});

/** Every DNS record, a page at a time, up to the page cap; `truncated` when the zone holds more. */
async function listDns(conn, zonePath) {
  const records = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, DNS_MAX_PAGES); page += 1) {
    const { body } = await call(conn, 'GET', `${zonePath}/dns_records`, { query: { page, per_page: DNS_PAGE_SIZE } });
    if (Array.isArray(body.result)) records.push(...body.result);
    totalPages = Number(body.result_info?.total_pages) || 1;
  }
  return { records, truncated: totalPages > DNS_MAX_PAGES };
}

/** One phase's entry point ruleset, or null when the phase has none yet. */
async function getPhase(conn, zonePath, phase) {
  const { body } = await call(conn, 'GET', `${zonePath}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`, {
    allow404: true,
  });
  return body ? body.result : null;
}

/** Zone ids looked up by name, kept for the instance's life (a name's id does not change while the zone exists). */
const ZONE_IDS = new Map();

/** Forgets every looked-up zone id (tests), or one name's (a zone check that found another zone there). */
export function forgetZoneIds(name = null) {
  if (name === null) ZONE_IDS.clear();
  else ZONE_IDS.delete(name);
}

/** The sentence for a managed zone the token cannot find. */
export const zoneUnreachableMessage = (name) =>
  `The admin token cannot reach the zone ${name}: add it to the token's Zone Resources in the Cloudflare dashboard (the Cloudflare admin runbook, part 2), then try again.`;

/** The answers to a zone read that mean the zone is gone, or the token no longer reaches it. */
const ZONE_GONE = Object.freeze([403, 404]);

/**
 * The zone itself (`GET /zones/{id}`). When the id was looked up by name and
 * Cloudflare answers 403 or 404, the kept id is forgotten, so the next
 * request looks the zone up again.
 */
async function readZone(conn, path, lookedUpName) {
  try {
    return await resultOf(conn, 'GET', path);
  } catch (error) {
    if (lookedUpName && ZONE_GONE.includes(error?.upstreamStatus)) forgetZoneIds(lookedUpName);
    throw error;
  }
}

/** The one active zone of exactly this name in a lookup's answer, or null (none, several, or not active). */
function onlyActive(result, name) {
  const named = (Array.isArray(result) ? result : []).filter((zone) => String(zone?.name ?? '').toLowerCase() === name);
  return named.length === 1 && named[0]?.status === 'active' ? named[0] : null;
}

/** The id of the one active zone with exactly this name, read once with the token and then kept. */
async function lookupZoneId(conn, name) {
  if (ZONE_IDS.has(name)) return ZONE_IDS.get(name);
  const result = await resultOf(conn, 'GET', '/zones', { query: { name, per_page: 5 } });
  const id = String(onlyActive(result, name)?.id ?? '').toLowerCase();
  if (!ZONE_ID_PATTERN.test(id)) {
    throw new CloudflareError(zoneUnreachableMessage(name), { status: 502, code: 'CLOUDFLARE_ZONE_UNREACHABLE' });
  }
  ZONE_IDS.set(name, id);
  return id;
}

/**
 * The zone's base path, answered at once for a known id and looked up on
 * first use for a name. One client looks up at most once, failure included,
 * so a status read does not repeat a lookup that has just failed.
 */
function zoneBaseOf(conn, zoneId, zoneName) {
  if (zoneId) return () => Promise.resolve(`/zones/${zoneId}`);
  let pending = null;
  return () => {
    pending ??= lookupZoneId(conn, zoneName).then((id) => `/zones/${id}`);
    return pending;
  };
}

/** The test doubles, when given, passed through to guardedFetch. */
function doublesOf({ fetch: fetchImpl, resolve, dispatcherFor }) {
  const doubles = {};
  if (fetchImpl) doubles.fetch = fetchImpl;
  if (resolve) doubles.resolve = resolve;
  if (dispatcherFor) doubles.dispatcherFor = dispatcherFor;
  return doubles;
}

/**
 * @param {object} options
 * @param {string} options.token the admin token, read by the caller with readSetting
 * @param {string} [options.zoneId] the site zone's id, already checked against ZONE_ID_PATTERN
 * @param {string} [options.zoneName] another managed zone's name, whose id is looked up (when no zoneId)
 * @param {typeof fetch} [options.fetch] for tests
 * @param {Function} [options.resolve] for tests
 * @param {Function} [options.dispatcherFor] for tests
 */
export function createCloudflareClient(options) {
  const { token, zoneId = null, zoneName = null } = options;
  if (zoneId !== null && !ZONE_ID_PATTERN.test(String(zoneId))) throw new Error('createCloudflareClient: zone id has the wrong shape');
  if (zoneId === null && !zoneName) throw new Error('createCloudflareClient: give a zone id or a zone name');
  const conn = { token, doubles: doublesOf(options) };
  const base = zoneBaseOf(conn, zoneId, zoneName);
  const at = async (suffix = '') => `${await base()}${suffix}`;
  const setting = (id) => at(`/settings/${encodeURIComponent(id)}`);
  const record = (id) => at(`/dns_records/${encodeURIComponent(id)}`);
  const phase = (id) => at(`/rulesets/phases/${encodeURIComponent(id)}/entrypoint`);

  return Object.freeze({
    zoneId,
    zoneName,
    getZone: async () => readZone(conn, await at(), zoneId ? null : zoneName),
    canRead: (family) => canRead(conn, at(READ_PROBES[family][0]), READ_PROBES[family][1]),
    listSettings: async () => resultOf(conn, 'GET', await at('/settings')),
    getSetting: async (settingId) => resultOf(conn, 'GET', await setting(settingId)),
    patchSetting: async (settingId, value) => resultOf(conn, 'PATCH', await setting(settingId), { body: { value } }),
    purge: async (body) => resultOf(conn, 'POST', await at('/purge_cache'), { body }),
    listDns: async () => listDns(conn, await at()),
    getDns: async (recordId) => resultOf(conn, 'GET', await record(recordId)),
    createDns: async (fields) => resultOf(conn, 'POST', await at('/dns_records'), { body: fields }),
    patchDns: async (recordId, changes) => resultOf(conn, 'PATCH', await record(recordId), { body: changes }),
    listRulesets: async () => resultOf(conn, 'GET', await at('/rulesets')),
    getPhase: async (phaseId) => getPhase(conn, await at(), phaseId),
    putPhase: async (phaseId, ruleset) => resultOf(conn, 'PUT', await phase(phaseId), { body: ruleset }),
  });
}

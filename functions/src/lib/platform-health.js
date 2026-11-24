/**
 * Cloud provider status aggregation, ported from
 * The old Firebase implementation was replaced by this Azure Functions module.
 *
 * The four indicators on the landing page are the only consumer. Before this
 * route existed they sat at `CHECKING` and then rendered "Health check
 * unavailable" to every anonymous visitor, because the frontend was calling a
 * route that had never been ported — a miss that stayed invisible while the
 * base URL still pointed at the decommissioned Google host (T-101).
 *
 * Three properties are load-bearing:
 *
 *   1. **Every provider degrades independently.** A check that throws, times
 *      out, or returns an unexpected shape yields `UNKNOWN` for that provider
 *      only. One dead upstream must not blank the panel, and must never fail
 *      the request — this is an anonymous endpoint on the landing page.
 *   2. **The result is cached.** Without it, an anonymous route that fans out
 *      to four third-party status APIs is a way to make *this* site hammer
 *      *them*, at whatever rate someone chooses to call it. The cache is what
 *      bounds upstream load to one round of checks per TTL per instance.
 *   3. **No dependency was added.** The source used `axios` and `rss-parser`;
 *      this uses global `fetch` and, for Azure, a presence test on the raw
 *      feed, which keeps both out of an anonymous route's cold start. `axios`
 *      has since left `package.json`; `rss-parser` is still there because
 *      the RSS ingest (`lib/rss/ingest.js`) and the podcast timer
 *      (`lib/timers/podcasts.js`) use it, but nothing on this route does.
 */

import { errorFacts } from './http/error-response.js';
const CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;
const USER_AGENT = 'HybridCloudWorks-PlatformHealth/1.0';

export const PROVIDERS = Object.freeze(['aws', 'azure', 'gcp', 'github']);

/**
 * Status vocabulary the landing page renders. `REGIONAL IMPACT` is the source's
 * spelling, space included, and the page styles it by exact string.
 */
export const STATUS = Object.freeze({
  OPERATIONAL: 'OPERATIONAL',
  DEGRADED: 'DEGRADED',
  REGIONAL: 'REGIONAL IMPACT',
  UNKNOWN: 'UNKNOWN',
});

const normalizeStatus = (isOperational) => (isOperational ? STATUS.OPERATIONAL : STATUS.DEGRADED);

/**
 * AWS reports one entry per active event with a region name. A global event is
 * a real outage; anything else is regional, which the page shows differently.
 *
 * @param {Array<{region_name?: string}>} activeEvents
 * @returns {string}
 */
export function getAwsStatusFromEvents(activeEvents) {
  if (activeEvents.length === 0) return STATUS.OPERATIONAL;
  const hasGlobalImpact = activeEvents.some((event) =>
    ['Global', 'GLOBAL'].includes(event?.region_name || '')
  );
  return hasGlobalImpact ? STATUS.DEGRADED : STATUS.REGIONAL;
}

/**
 * `status.aws.amazon.com/data.json` is served as UTF-16 with a BOM, so it
 * cannot be read as text without deciding the endianness first. Ported rather
 * than simplified because getting this wrong yields valid-looking mojibake that
 * `JSON.parse` rejects — which reads as "AWS is down" rather than "we cannot
 * decode this".
 *
 * @param {ArrayBuffer|Buffer} buffer
 * @returns {string}
 */
export function decodeUtf16JsonBuffer(buffer) {
  const bytes = Buffer.from(buffer);
  const encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le';
  return new TextDecoder(encoding).decode(bytes).replace(/^﻿/, '');
}

/**
 * Azure publishes RSS, not JSON. The source used `rss-parser` and then looked
 * at nothing but `items.length`, so this tests for the presence of an `<item>`
 * element instead of parsing the feed. A regex over XML is not a parser and is
 * not treated as one — it answers exactly one boolean question, and a feed it
 * cannot read returns `false` rather than a wrong parse.
 *
 * @param {string} xml
 * @returns {boolean}
 */
export function feedHasItems(xml) {
  return /<item[\s>]/i.test(String(xml || ''));
}

/**
 * Fetch with a timeout, returning `null` on anything that is not a 2xx with a
 * usable body. Callers turn `null` into `UNKNOWN`.
 *
 * @param {string} url
 * @param {{as?: 'json'|'text'|'buffer', fetchImpl?: Function}} [options]
 */
async function fetchUpstream(url, { as = 'json', fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) return null;
  if (as === 'text') return response.text();
  if (as === 'buffer') return response.arrayBuffer();
  return response.json();
}

/**
 * Run one provider check, converting every failure mode into `UNKNOWN`.
 *
 * @param {string} provider
 * @param {() => Promise<string>} check
 * @param {{warn: Function}} context
 */
async function safeCheck(provider, check, context) {
  try {
    const status = await check();
    return [provider, status || STATUS.UNKNOWN];
  } catch (error) {
    // `warn`, not `error`: a third-party status page being unreachable is not
    // a fault in this application, and paging on it would be noise.
    context.warn?.(`[platformHealth] ${provider} status check failed:`, errorFacts(error));
    return [provider, STATUS.UNKNOWN];
  }
}

/**
 * Query all four providers in parallel.
 *
 * @param {{warn: Function}} context
 * @param {{fetchImpl?: Function}} [deps]
 * @returns {Promise<Record<string, string>>}
 */
export async function getProviderStatuses(context, { fetchImpl = fetch } = {}) {
  const opts = { fetchImpl };

  const entries = await Promise.all([
    safeCheck(
      'aws',
      async () => {
        const buffer = await fetchUpstream('https://status.aws.amazon.com/data.json', {
          ...opts,
          as: 'buffer',
        });
        if (!buffer) return STATUS.UNKNOWN;
        const events = JSON.parse(decodeUtf16JsonBuffer(buffer));
        const active = Array.isArray(events) ? events.filter((e) => e?.status !== '0') : [];
        return getAwsStatusFromEvents(active);
      },
      context
    ),
    safeCheck(
      'azure',
      async () => {
        const xml = await fetchUpstream(
          'https://rssfeed.azure.status.microsoft/en-us/status/feed/',
          { ...opts, as: 'text' }
        );
        if (xml === null) return STATUS.UNKNOWN;
        return normalizeStatus(!feedHasItems(xml));
      },
      context
    ),
    safeCheck(
      'gcp',
      async () => {
        const data = await fetchUpstream('https://status.cloud.google.com/incidents.json', opts);
        if (!Array.isArray(data)) return STATUS.UNKNOWN;
        // An incident without an `end` is still open.
        return normalizeStatus(data.filter((incident) => !incident?.end).length === 0);
      },
      context
    ),
    safeCheck(
      'github',
      async () => {
        const data = await fetchUpstream('https://www.githubstatus.com/api/v2/status.json', opts);
        if (!data?.status) return STATUS.UNKNOWN;
        return normalizeStatus(data.status.indicator === 'none');
      },
      context
    ),
  ]);

  return Object.fromEntries(entries);
}

/**
 * Build the handler.
 *
 * The cache is per-instance and in memory, which is the right shape here: it
 * exists to bound *upstream* load, and on Flex Consumption the worst case is
 * one round of checks per instance per TTL. A shared cache in Cosmos would add
 * a write to an anonymous read path to save a handful of outbound requests
 * every five minutes.
 *
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {Function} [deps.fetchImpl]
 * @param {number} [deps.ttlMs]
 */
export function createPlatformHealthHandler({
  now = () => Date.now(),
  fetchImpl = fetch,
  ttlMs = CACHE_TTL_MS,
} = {}) {
  let cache = null;

  const respond = (payload, cached) => ({
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // The browser polls hourly; these let any cache in front of the Function
      // App absorb the rest.
      'Cache-Control': 'public, max-age=60, s-maxage=300',
    },
    body: JSON.stringify({ ok: true, cached, ...payload }),
  });

  return async function getPlatformHealth(request, context) {
    const currentMs = now();
    if (cache && currentMs - cache.fetchedAt < ttlMs) {
      return respond(cache.payload, true);
    }

    try {
      const statuses = await getProviderStatuses(context, { fetchImpl });
      const payload = {
        statuses,
        checkedAt: new Date(currentMs).toISOString(),
      };
      cache = { fetchedAt: currentMs, payload };
      return respond(payload, false);
    } catch (error) {
      // Every individual check already degrades to UNKNOWN, so reaching here
      // means something structural. Serve a stale payload if one exists —
      // out-of-date indicators beat an error on the landing page — and
      // otherwise report every provider unknown rather than a 500.
      context.error('[platformHealth] failed to build response:', errorFacts(error));
      if (cache) return respond(cache.payload, true);
      return respond(
        {
          statuses: Object.fromEntries(PROVIDERS.map((p) => [p, STATUS.UNKNOWN])),
          checkedAt: new Date(currentMs).toISOString(),
        },
        false
      );
    }
  };
}

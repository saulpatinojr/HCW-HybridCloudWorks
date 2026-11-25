/**
 * host-routes.js — the two podcast hub routes that read the Podbean host:
 * the show's overview and its statistics. handlers.js builds the hub's
 * routes and hands these its dependencies (`h`: guard, store, now, and the
 * Podbean settings check and client).
 */
import { readHostOverview } from './host-reads.js';
import { HOST_STATS_DEFAULT_RANGE, HOST_STATS_RANGES, parseRange, readHostStats } from './host-stats.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The names of the parts of a host read that failed, or "no". */
const errorNames = (errors) => Object.keys(errors || {}).join(',') || 'no';

/**
 * GET /api/cms/podcast/host/overview[?refresh=1] — what Podbean says now
 * about the show and its episodes, joined to the transcripts that
 * published them, with each episode's downloads over the last thirty
 * days (host-reads.js). Served from `admin_config/podbean_host_overview`
 * while that is under fifteen minutes old unless `refresh=1`, and a
 * refresh still serves it while it is under a minute old, so refresh
 * traffic from every session together is one live read a minute. The
 * cached document is keyed to the Podbean account. Without the Podbean
 * settings, 200 `{ configured: false, reason }` and no call.
 */
export async function getHostOverview(h, request, context) {
  const auth = await h.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const configured = h.hostConfigured();
    if (!configured.ok) {
      return json(200, { success: true, configured: false, reason: configured.reason });
    }
    const refresh = request.query?.get?.('refresh') === '1';
    const overview = await readHostOverview({
      client: h.hostClient(),
      store: h.store,
      now: h.now,
      refresh,
      log: context.log,
    });
    // Counts and codes only: the rows carry episode titles.
    context.log?.(
      `getPodcastHostOverview: ${overview.cached ? 'cached' : 'live'}, ${overview.episodes.length} rows, ` +
        `${errorNames(overview.errors)} errors`
    );
    return json(200, { success: true, configured: true, ...overview });
  } catch (error) {
    context.error(`getPodcastHostOverview failed: ${error?.code || 'UNEXPECTED'}`);
    return json(500, { error: 'Failed to read the host overview' });
  }
}

/** The statistics range asked for, the default when none was; null for a range not offered. */
function requestedRange(request) {
  const requested = request.query?.get?.('range');
  return requested ? parseRange(requested) : HOST_STATS_DEFAULT_RANGE;
}

/** Read the statistics for a valid range, or say the Podbean settings are missing. */
async function readStats(h, request, context, range) {
  const configured = h.hostConfigured();
  if (!configured.ok) {
    return json(200, { success: true, configured: false, range, reason: configured.reason });
  }
  const refresh = request.query?.get?.('refresh') === '1';
  const stats = await readHostStats({
    client: h.hostClient(),
    store: h.store,
    range,
    now: h.now,
    refresh,
    log: context.log,
  });
  context.log?.(
    `getPodcastHostStats: ${range} ${stats.cached ? 'cached' : 'live'}, ` +
      `${errorNames(stats.errors)} errors`
  );
  return json(200, { success: true, configured: true, ...stats });
}

/**
 * GET /api/cms/podcast/host/stats?range=30d|90d|12m[&refresh=1] — the
 * show's downloads by day or month, countries, platforms, sources,
 * listener retention and audience counts, from Podbean (host-stats.js).
 * Served from `admin_config/podbean_host_stats_<range>` while that is
 * under an hour old unless `refresh=1`. 400 for a range not offered;
 * without the Podbean settings, 200 `{ configured: false, reason }`.
 */
export async function getHostStats(h, request, context) {
  const auth = await h.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const range = requestedRange(request);
    if (!range) {
      return json(400, { error: `range must be one of ${HOST_STATS_RANGES.join(', ')}` });
    }
    return await readStats(h, request, context, range);
  } catch (error) {
    context.error(`getPodcastHostStats failed: ${error?.code || 'UNEXPECTED'}`);
    return json(500, { error: 'Failed to read the host statistics' });
  }
}


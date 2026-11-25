/**
 * worker.js — the reachability probe that runs where Bot Fight Mode cannot
 * see it (ADR 0024, T-519).
 *
 * Azure's availability agents are datacenter clients, and Cloudflare's free
 * Bot Fight Mode answers datacenter clients asking for
 * https://api-azure.<domain>/api/health with a 403 interstitial. A WAF skip
 * rule against it was built, applied and confirmed inert, because Bot Fight
 * Mode does not run on the Ruleset Engine (T-519; recorded in ADR 0024). So
 * the standard web test in infra/observability.tf cannot be armed, and without
 * this Worker the one signal that survives the app being completely down —
 * reachability — would have no alert behind it. With it, that alert is
 * `alert-api-reachability-*`, armed since 2026-09-01.
 *
 * This Worker is the alternative: a cron-triggered probe running on
 * Cloudflare itself. A subrequest from a same-account Worker to its own zone
 * is not challenged by Bot Fight Mode; it enters the zone's pipeline (so the
 * origin-secret transform rule stamps it like any visitor request) and
 * reaches the origin from Cloudflare's own egress ranges (so the Function
 * App's ip_restriction Deny admits it). What it exercises is the edge → WAF →
 * transform → origin path — everything a browser's request traverses except
 * the client-to-edge leg, which is Cloudflare's availability, not ours.
 *
 * The result is reported as AvailabilityData to Application Insights, so the
 * probe lands in the same `availabilityResults` table the retired standard
 * web test would have written and the alert on it lives in the same fabric as
 * every other rule (infra/observability.tf, `edge_probe_availability`). The
 * alert fires on MISSING successes, not on present failures, so a dead
 * Worker, a dead cron, and a dead ingestion path all look like the outage
 * they are indistinguishable from.
 *
 * Failure handling is deliberately one-sided: a probe that cannot reach the
 * API still reports (success=false, with the status or error text as the
 * message); a probe that cannot reach the App Insights ingestion endpoint
 * reports nothing, and the absence fires the alert. Retrying ingestion from
 * here would only delay that signal.
 *
 * PROBE_NAME must match the name the Terraform alert queries for —
 * infra/observability.tf and wrangler.toml each carry a comment pointing at
 * the other.
 */

/**
 * `InstrumentationKey=...;IngestionEndpoint=https://...` → { iKey, endpoint }.
 * A Key Vault reference that did not resolve arrives as the literal
 * `@Microsoft.KeyVault(...)` string elsewhere in this estate; here the
 * equivalent failure is an unset Worker secret, so absence is loud.
 */
export function parseConnectionString(raw) {
  const parts = connectionStringParts(raw);
  const iKey = parts.get('InstrumentationKey');
  const endpoint = parts.get('IngestionEndpoint');
  if (!iKey || !endpoint) {
    throw new Error(
      'APPLICATIONINSIGHTS_CONNECTION_STRING must carry InstrumentationKey and IngestionEndpoint'
    );
  }
  return { iKey, endpoint: endpoint.endsWith('/') ? endpoint : `${endpoint}/` };
}

/**
 * `a=1;b=2` → Map { a → '1', b → '2' }. Empty pairs are skipped, and a name
 * given twice keeps its last value. A Map, so no name can reach an object's
 * built-in properties.
 */
function connectionStringParts(raw) {
  const parts = new Map();
  for (const pair of String(raw || '').split(';')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    parts.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return parts;
}

/** Milliseconds → the hh:mm:ss.fff TimeSpan string AvailabilityData expects. */
export function msToTimeSpan(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const f = clamped % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(f, 3)}`;
}

/** One availability envelope in the v2/track shape. */
export function buildEnvelope({ iKey, name, start, durationMs, success, message }) {
  return {
    name: 'Microsoft.ApplicationInsights.Availability',
    time: new Date(start).toISOString(),
    iKey,
    data: {
      baseType: 'AvailabilityData',
      baseData: {
        ver: 2,
        id: crypto.randomUUID(),
        name,
        duration: msToTimeSpan(durationMs),
        success,
        runLocation: 'cloudflare-edge',
        message,
      },
    },
  };
}

/**
 * Ask the health endpoint once and report what happened. Success is exactly
 * what the standard web test would have checked: HTTP 200 (validation_rules
 * in infra/observability.tf checks nothing else either — the endpoint returns
 * one bit by design, T-402).
 */
export async function runProbe(env, fetcher = fetch) {
  const { iKey, endpoint } = parseConnectionString(env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  const start = Date.now();
  let success = false;
  let message;
  try {
    const res = await fetcher(env.PROBE_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    success = res.status === 200;
    message = `HTTP ${res.status}`;
  } catch (err) {
    message = String(err?.message || err);
  }
  const durationMs = Date.now() - start;

  const envelope = buildEnvelope({
    iKey,
    name: env.PROBE_NAME,
    start,
    durationMs,
    success,
    message,
  });

  // No retry, no catch: an ingestion failure surfaces as missing telemetry,
  // which is the condition the alert fires on.
  await fetcher(`${endpoint}v2/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(15_000),
  });

  return { success, message, durationMs };
}

export default {
  async scheduled(controller, env, ctx) {
    // The catch is for DIAGNOSIS, not recovery (T-746). runProbe deliberately
    // does not retry or trap the ingestion POST — a probe that lies about its
    // own health is worse than one that goes quiet — but without this, the
    // rejection went nowhere at all. When alert-api-reachability fires it
    // conflates three causes on purpose (API unreachable / Worker or cron dead
    // / ingestion path dead), and this line is the only thing that tells them
    // apart. A mistyped `wrangler secret put` otherwise produces a permanent
    // Sev 1 with parseConnectionString throwing silently every five minutes,
    // which is the likeliest failure at first deploy.
    //
    // Rethrown after logging so the invocation is still recorded as failed;
    // swallowing it would trade one silence for another.
    ctx.waitUntil(
      runProbe(env).catch((error) => {
        console.error(
          `[availability-probe] run failed: ${error?.stack || error?.message || error}`
        );
        throw error;
      })
    );
  },
};

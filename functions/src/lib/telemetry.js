/**
 * telemetry.js — Application Insights custom events from the Function App.
 *
 * The app has never emitted a custom event. Everything it reports reaches
 * App Insights as `traces` through `context.log`, which is the right table
 * for a line an operator reads and the wrong one for a row an alert counts:
 * a scheduled-query rule over `traces` keys on message text, and message
 * text is edited. The missing-run alerts for the Cosmos export (ADR 0028 §5)
 * count `customEvents` by `name` and `customDimensions.mode`, so the export
 * needs a way to write one.
 *
 * This is the smallest one: the same `v2/track` envelope the edge probe
 * posts (`edge/availability-probe/worker.js`, AvailabilityData there,
 * EventData here), with the ingestion endpoint and key taken from
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` — which the Flex Consumption app
 * carries because `infra/functionapp.tf` sets
 * `site_config.application_insights_connection_string`. No SDK: the
 * `applicationinsights` package brings OpenTelemetry and its own collectors
 * into an app whose host already collects logs, for one event a day.
 *
 * Failure is one-sided on purpose. A missing setting or a failed POST is
 * logged and returns `false`; it never throws. The export that just
 * finished is not undone by a telemetry outage, and the event's absence is
 * exactly the condition the alert fires on — retrying from here would only
 * delay that signal. Every property value is stringified because
 * `customDimensions` is a string bag; numbers arrive as their decimal text.
 */

import { errorFacts } from './http/error-response.js';
/**
 * `InstrumentationKey=...;IngestionEndpoint=https://...` → { iKey, endpoint }.
 * @param {string|undefined} raw
 * @returns {{ iKey: string, endpoint: string }}
 */
export function parseConnectionString(raw) {
  const parts = Object.fromEntries(
    String(raw || '')
      .split(';')
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
      })
  );
  const iKey = parts.InstrumentationKey;
  const endpoint = parts.IngestionEndpoint;
  if (!iKey || !endpoint) {
    throw new Error(
      'APPLICATIONINSIGHTS_CONNECTION_STRING must carry InstrumentationKey and IngestionEndpoint'
    );
  }
  return { iKey, endpoint: endpoint.endsWith('/') ? endpoint : `${endpoint}/` };
}

/** Every value as a string; null and undefined dropped. `customDimensions` holds text only. */
export function stringifyProperties(properties = {}) {
  const out = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

/**
 * One EventData envelope in the v2/track shape.
 * @param {{ iKey: string, name: string, properties?: Record<string, unknown>, time?: Date }} args
 */
export function buildEventEnvelope({ iKey, name, properties = {}, time = new Date() }) {
  // Normalised once and sent normalised: the alert query matches the event
  // name exactly, and a padded name would be validated here and then miss.
  const eventName = typeof name === 'string' ? name.trim() : '';
  if (!eventName) throw new Error('event name is required');
  return {
    name: 'Microsoft.ApplicationInsights.Event',
    time: new Date(time).toISOString(),
    iKey,
    data: {
      baseType: 'EventData',
      baseData: { ver: 2, name: eventName, properties: stringifyProperties(properties) },
    },
  };
}

/**
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetcher]
 * @param {{ warn?: Function, log?: Function }} [deps.log]
 * @param {() => Date} [deps.now]
 */
export function createEventTracker({
  env = process.env,
  fetcher = globalThis.fetch,
  log = {},
  now = () => new Date(),
} = {}) {
  /**
   * Post one custom event. Resolves `true` when ingestion accepted it,
   * `false` otherwise — never rejects.
   * @param {string} name
   * @param {Record<string, unknown>} [properties]
   */
  async function trackEvent(name, properties = {}) {
    // Everything that can throw — a missing setting, a bad name, a property
    // that will not serialise (BigInt, a cycle), the POST — is inside one
    // try, because the promise above is "never rejects" and a throw here
    // would fail the job whose success it was reporting.
    try {
      const target = parseConnectionString(env.APPLICATIONINSIGHTS_CONNECTION_STRING);
      const envelope = buildEventEnvelope({ iKey: target.iKey, name, properties, time: now() });
      const body = JSON.stringify(envelope);
      const res = await fetcher(`${target.endpoint}v2/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn?.(`[telemetry] ${name} rejected by ingestion: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (error) {
      log.warn?.(`[telemetry] ${name} not sent: ${errorFacts(error)}`);
      return false;
    }
  }

  return { trackEvent };
}

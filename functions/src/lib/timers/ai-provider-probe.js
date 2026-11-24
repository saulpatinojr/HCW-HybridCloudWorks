/**
 * ai-provider-probe.js — `probeAiProviders`, weekly on Monday at 06:15 UTC
 * (#701, owner decision 2026-09-29).
 *
 * That day NVIDIA's trial tier became the BACKUP for content features
 * (PROVIDER_PLACEMENT_DEFAULTS in lib/ai/ai-config.js). Measured through the
 * portal's Test, it took 56-117 s to answer one word, and once the Test was
 * capped at 16 tokens and 45 s it did not answer at all. The owner was
 * promised a weekly re-check, so that a feature can move back to 'first' on
 * evidence rather than on memory.
 *
 * This is that re-check, and it is the Test, not a second instrument. It runs
 * `testProviderConnection` from lib/ai/proxy.js, the code behind the Test
 * button, with the same one-word prompt, the same 16-token cap and the same
 * 45 s limit. It writes the same fields onto each provider document, plus
 * `lastTestedBy: 'probe'`. So the AI Engine card shows a probe result the way
 * it shows a click: "Tested 2d ago by the weekly check", the latency beside
 * the Connected badge, or the error ("timeout after 45000 ms") under it.
 *
 * EVERY PROVIDER WITH A KEY, NOT ONLY NVIDIA. Whether NVIDIA should go first
 * is a comparison with the paid providers, and a latency means little
 * without theirs, measured the same minute from the same instance. A key is
 * the router's own definition of "configured" (router.js header). The
 * portal's enabled switch is not consulted, for the reason the Test is not
 * feature-gated (proxy.js header): a provider switched off is exactly one
 * whose evidence someone may want before switching it back on. The cost is
 * the Test's, one short call per provider a week, a fraction of a cent in
 * all. The Usage tab lists it as its own source ('ai-engine:probe'), and
 * NVIDIA's rows price at zero.
 *
 * One provider at a time, so no call's wait overlaps another's measurement.
 * The worst case, every provider timing out, is four times 45 s, well inside
 * the host's default function timeout.
 *
 * A provider that fails is a RESULT, not a failure of the timer. The run
 * returns it, the card shows it, and the timer succeeds. The timer throws
 * only when it cannot run at all.
 *
 * THE LIST STEP (ADR 0034 slice 2, #857). After the Tests, the same run
 * refreshes the model catalogue (lib/ai/model-catalog.js) for every provider
 * with a key, through the optional `catalog.refresh` dependency. It runs
 * AFTER the probe so a catalogue failure — Cosmos refusing the write, every
 * list endpoint down — cannot cost the probe results already written onto
 * the cards: it is logged, reported under `catalog.error`, and the run
 * still returns the Tests.
 */
import { testProviderConnection } from '../ai/proxy.js';
import { errorFacts, errorCode } from '../http/error-response.js';

/**
 * @param {object} deps
 * @param {{ upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {{ availableProviders: Function, callProvider: Function,
 *   getCostEstimate: Function }} deps.ai
 * @param {{ refresh: () => Promise<object> }} [deps.catalog] the model
 *   catalogue refresh; absent, the run is the probe alone
 * @param {object} [deps.log] the invocation context
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => number} [deps.clock]
 */
export function createAiProviderProbe({ store, ai, catalog = null, log = {}, now, uuid, clock }) {
  async function refreshCatalog() {
    try {
      return await catalog.refresh();
    } catch (error) {
      log.error?.('probeAiProviders catalogue refresh failed:', errorFacts(error));
      return { error: errorCode(error) };
    }
  }

  async function run() {
    const providers = ai.availableProviders();
    const results = [];
    for (const providerId of providers) {
      const outcome = await testProviderConnection(
        { store, ai, now, uuid, clock, log },
        { providerId, trigger: 'probe' }
      );
      results.push({
        provider: providerId,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }
    const summary = {
      probed: results.length,
      connected: results.filter((r) => r.status === 'connected').length,
      results,
    };
    if (catalog) summary.catalog = await refreshCatalog();
    return summary;
  }
  return { run };
}

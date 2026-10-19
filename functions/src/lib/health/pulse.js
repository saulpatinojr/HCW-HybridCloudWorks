/**
 * pulse.js — `healthPulse`, every five minutes: the Health Hub checking the
 * platform while nobody is looking (#1010).
 *
 * Before this the hub only knew what someone had asked it in a browser, so a
 * dependency that broke at night was "not tested yet" until morning, and
 * nothing said whether the checks themselves were still running. The pulse
 * runs every check the backend can make on its own (pulse-checks.js), records
 * each result in the same store a browser's Test writes to
 * (probe-results.js) with `checkedBy: 'pulse'`, and then records its own
 * heartbeat. The page reads both: every card says when it was last checked
 * and by whom, and the hub says "Pulse: every 5 min, last 3 min ago" — or
 * that the pulse is late, which is itself the most important finding.
 *
 * WHAT IT CHECKS. One ops snapshot (the same `buildSnapshot` the Overview
 * reads) answers Cosmos, runtime configuration, unresolved Key Vault
 * references, storage, scheduled publishing, publishing failures, review
 * queue age, orphaned images, live-page links, the forge and Telegram
 * notices. Three point queries answer the lab agents' heartbeats, the AI
 * providers' last recorded tests and the MCP servers' last syncs. Two more
 * answer the Hybrid Lab's recurrence checks (#1009, labs/lab-checks.js):
 * whether each host runs main (`lab-drift`, from the agents' applied
 * commits and the hourly read of main that checkAgentHealth stores), and
 * whether Coder serves the template of the host's commit (`coder-template`,
 * from the host's daily Coder upkeep report). And two more: whether the last
 * real lab job ran end to end (`lab-canary`, the hourly canary's record), and
 * whether Coder accepts the site's status token (`coder-token`, Coder's last
 * recorded answers to it). And one more (#1282): whether Portainer on the
 * lab host is up and sound (`portainer`, from the host's own fifteen-minute
 * read of it, admin_config/host_checks), so the card has a value within one
 * pulse of the host's first report and nobody has to press Run.
 *
 * WHAT IT DOES NOT. It calls no third party and spends nothing: the service
 * tests (Publer, Resend, the models) stay on their Test buttons, and the AI
 * providers are judged by what their last Test recorded, not by a new prompt.
 *
 * FAILURE. A check that throws is a result for its probe when the cause is
 * the dependency (the snapshot failing is Cosmos's verdict), and otherwise is
 * left unrecorded and listed on the heartbeat, so a bug in one check never
 * writes a false verdict. If Cosmos itself cannot be written, the heartbeat
 * cannot be either: the run throws, the host records the failure, and the
 * page sees the pulse go late — which is the honest outcome.
 */
import { PULSE_INTERVAL_MS, PULSE_LATE_AFTER_MS } from './status-model.js';
import {
  SNAPSHOT_CHECKS,
  aiProvidersVerdict,
  cosmosFailure,
  labAgentsFromRows,
  labAgentsVerdict,
  mcpServersVerdict,
} from './pulse-checks.js';
import {
  PROBE_RESULTS_CONTAINER,
  PULSE_DOC_ID,
  PULSE_DOC_TYPE,
  recordProbeResult,
} from './probe-results.js';
import { healthProbe } from './probe-catalogue.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { recordedFailure } from '../http/error-response.js';
import {
  CODER_TEMPLATE_PROBE,
  CODER_TOKEN_PROBE,
  LAB_CANARY_PROBE,
  LAB_DRIFT_PROBE,
  PORTAINER_PROBE,
  readCoderTemplate,
  readCoderToken,
  readLabCanary,
  readLabDrift,
  readPortainer,
} from '../labs/lab-checks.js';

export const PULSE_ACTOR = 'pulse';

/**
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function,
 *   queryDocs: Function, upsertDoc: Function }} deps.store
 * @param {() => Promise<object>} deps.buildSnapshot the ops-health snapshot builder
 * @param {() => Date} [deps.now]
 * @param {() => number} [deps.clock] for durations
 * @param {object} [deps.log] the invocation context
 */
export function createHealthPulse({
  store,
  buildSnapshot,
  now = () => new Date(),
  clock = () => Date.now(),
  log = {},
}) {
  /** Time one check: `{ probeId, outcome, durationMs }` or `{ probeId, error }`. */
  async function timed(probeId, check) {
    const started = clock();
    try {
      const outcome = await check();
      return { probeId, outcome, durationMs: clock() - started };
    } catch (error) {
      return { probeId, error };
    }
  }

  async function snapshotChecks(nowMs) {
    const started = clock();
    let snapshot;
    try {
      snapshot = await buildSnapshot();
    } catch (error) {
      // The snapshot IS the Cosmos check. Nothing else it would have answered
      // is recorded: no evidence is not the same as bad evidence.
      return [{ probeId: 'cosmos', outcome: cosmosFailure(error), durationMs: clock() - started }];
    }
    const durationMs = clock() - started;
    return Object.entries(SNAPSHOT_CHECKS).map(([probeId, check]) => {
      try {
        return { probeId, outcome: check(snapshot, nowMs), durationMs };
      } catch (error) {
        return { probeId, error };
      }
    });
  }

  const registryChecks = (nowMs) =>
    Promise.all([
      timed('lab-agents', async () =>
        labAgentsVerdict(
          labAgentsFromRows(
            await store.queryDocs('lab_agents', 'SELECT TOP 200 c.id, c.lastSeenAt, c.status, c.active FROM c', []),
            nowMs
          ),
          nowMs
        )
      ),
      timed('ai-providers', async () =>
        aiProvidersVerdict(
          await store.queryDocs(
            'ai_providers',
            'SELECT TOP 50 c.id, c.enabled, c.status, c.latencyMs, c.lastTested, c.lastTestError, c.lastTestedBy FROM c',
            []
          ),
          nowMs
        )
      ),
      timed('mcp-servers', async () =>
        mcpServersVerdict(
          await store.queryDocs(
            'mcp_servers',
            'SELECT TOP 50 c.id, c.name, c.enabled, c.status, c.lastTested, c.lastError FROM c',
            []
          ),
          nowMs
        )
      ),
      // Its own words, without the per-agent lines the Labs cards carry.
      timed(LAB_DRIFT_PROBE, async () => {
        const { agents: _perAgent, ...verdict } = await readLabDrift(store, nowMs);
        return verdict;
      }),
      timed(CODER_TEMPLATE_PROBE, () => readCoderTemplate(store, nowMs)),
      timed(LAB_CANARY_PROBE, () => readLabCanary(store, nowMs)),
      timed(CODER_TOKEN_PROBE, () => readCoderToken(store, nowMs)),
      // The lab host's own reading of Portainer (#1282): one point read.
      timed(PORTAINER_PROBE, () => readPortainer(store, nowMs)),
    ]);

  async function record(checkedAt, row) {
    const entry = healthProbe(row.probeId);
    await recordProbeResult(store, {
      probeId: row.probeId,
      kind: entry.kind,
      status: row.outcome.status,
      summary: row.outcome.summary,
      detail: row.outcome.detail ?? null,
      durationMs: Number.isFinite(row.durationMs) ? Math.round(row.durationMs) : null,
      checkedAt,
      checkedBy: PULSE_ACTOR,
      recordedBy: PULSE_ACTOR,
    });
  }

  /**
   * One pulse: every check read and recorded, then the heartbeat. A check
   * that throws, or whose result cannot be written, is a failure on the
   * heartbeat in a stored sentence with its code and a reference (#945).
   *
   * @returns {Promise<{ checks: number, recorded: number, failures: number, durationMs: number }>}
   */
  async function run() {
    const startedAt = now();
    const started = clock();
    const nowMs = startedAt.getTime();
    const checkedAt = startedAt.toISOString();

    const rows = [...(await snapshotChecks(nowMs)), ...(await registryChecks(nowMs))];
    // The pulse document is served to the Health view, so each failure is a
    // sentence with the code and a log line's reference, never the check's
    // or the store's own words (#945).
    const failures = rows
      .filter((row) => row.error)
      .map((row) => ({
        probeId: row.probeId,
        error: recordedFailure(log, 'The check failed.', row.error),
      }));

    // Sequential: a dozen small writes, each its own ETag'd read and replace.
    // In parallel they would all land in the same second as any Test all a
    // browser is running, for no gain on a five-minute timer.
    let recorded = 0;
    for (const row of rows.filter((candidate) => candidate.outcome)) {
      try {
        await record(checkedAt, row);
        recorded += 1;
      } catch (error) {
        failures.push({
          probeId: row.probeId,
          error: recordedFailure(log, 'The check result was not recorded.', error),
        });
      }
    }

    // The heartbeat last, and not guarded: if it cannot be written the run
    // fails, and the page sees the pulse go late.
    const durationMs = clock() - started;
    await store.upsertDoc(PROBE_RESULTS_CONTAINER, {
      id: PULSE_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: PULSE_DOC_TYPE,
      lastBeatAt: checkedAt,
      intervalMs: PULSE_INTERVAL_MS,
      lateAfterMs: PULSE_LATE_AFTER_MS,
      durationMs,
      checks: rows.length,
      recorded,
      failures: failures.slice(0, 20),
    });

    if (failures.length) {
      log.warn?.(`[healthPulse] ${failures.length} check(s) not recorded: ${JSON.stringify(failures)}`);
    }
    return { checks: rows.length, recorded, failures: failures.length, durationMs };
  }

  return { run };
}

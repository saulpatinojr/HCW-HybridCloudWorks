/**
 * agent-health.js — `checkAgentHealth`, every 5 minutes (T-401), and the two
 * messages the owner gets about a lab agent: offline, and back.
 *
 * The Labs VPS agent heartbeats every 30 s (lib/lab-agent.js writes
 * `lastSeenAt`). Each run reads the registry once and decides three things
 * from that one read (planAgentHealth, pure):
 *
 *   1. MARK. An agent that has not heartbeated for STALE_AFTER_MS — the same
 *      90 s (three missed beats) the online rule uses — and is not already
 *      `offline` is marked `offline`. `offlineSince` is its last heartbeat,
 *      when it went quiet, not when this run happened to notice. An agent
 *      that announces its own shutdown is marked by its heartbeat instead
 *      (lib/lab-agent.js), at once.
 *   2. SAY IT IS OFFLINE, once it has been offline OFFLINE_NOTIFY_AFTER_MS
 *      (5 minutes) or more, and once per outage: `offlineNotifiedAt` on the
 *      agent's own document records the message, so a restart, a second
 *      instance or the next run cannot repeat it. An agent the registry has
 *      deactivated is marked but never announced: it cannot heartbeat at all
 *      (auth/require-agent.js, gate 2), so its silence is on purpose.
 *   3. SAY IT IS BACK. lib/lab-agent.js sends that on the first normal
 *      heartbeat after an outage the owner was told about. This run sends it
 *      when that attempt did not go (the notifier's cooldown, Telegram
 *      down), so every "offline" is followed by one "back online".
 *
 * WHY FIVE MINUTES (#1009). Until 2026-10-08 the heartbeat that announced a
 * graceful stop sent a critical "Lab agent offline" at once. That day's 04:30
 * reboot was back in 43 seconds, and the owner had a red alert and no word
 * that it was over. A restart now says nothing; an outage that outlasts five
 * minutes says so once, and its end says so once.
 *
 * AN OUTAGE THE OWNER WAS TOLD ABOUT LASTS UNTIL THEY ARE TOLD IT ENDED. If
 * the agent drops again before the "back online" went, `offlineSince` keeps
 * the first start and no second "offline" is sent, so the owner reads one
 * outage with one start and one end.
 *
 * Every state change is logged at warn. host.json holds Function logs at
 * Warning, so the information line this used to write ("N agent(s) marked
 * offline") was never ingested, and a mark could not be found afterwards.
 * Those lines are content-free, counts and never document ids, and so is the
 * run's result; the owner's message, which is not telemetry, names the agent.
 *
 * A MARK IS A DECISION FROM A READ, so it is written with that read's ETag.
 * A heartbeat that lands between this run's read and its mark has made the
 * agent fresh again; an unguarded mark would overwrite it with `offline` and
 * could send a false outage message. The guarded mark loses with a 412
 * instead, and this run leaves that agent to the next one (review of #1018).
 * The stamps that record a message went (`offlineNotifiedAt`, the "back
 * online" clear) are not guarded: they record a fact about the message, true
 * whatever else changed on the document.
 *
 * ONCE AN HOUR, MAIN (#1009). After the three decisions, a run whose last
 * read of main is DRIFT_READ_INTERVAL_MS old reads main's lab-host/ and
 * vps-agent/ commits from GitHub into admin_config/lab_drift
 * (labs/drift.js), starting at the oldest commit an active agent reports
 * having converged from. Here because this timer already reads the registry
 * every five minutes and is armed, and the health pulse, which judges the
 * lag, calls no third party. Last, and never fatal: the marks and messages
 * above are done before GitHub is asked anything, and a failed read is
 * recorded on the document and logged at warn, not thrown.
 *
 * AND THE CODER STATUS TOKEN, ONCE AN HOUR (#1009; CodeRabbit, #1056). Last
 * of all, `coderTokenCheck` asks Coder with the status token directly, never
 * through the labs page's minute cache, when the recorded answer is an hour
 * old (labs/coder-status.js checkTokenIfDue), so the health pulse's
 * `coder-token` probe has evidence whatever visitors do and without the lab
 * canary armed. Never fatal, like the read of main.
 *
 * AND THE DELIVERY MONITOR, ONCE AN HOUR. After that, `deliveryWatch` reads
 * the runs of the repository's "Monitor delivery health" check from GitHub's
 * public API and tells the owner on Telegram when it goes red, and when it is
 * green again (delivery-monitor-watch.js). Never fatal, like the others.
 *
 * AND THE COST WATCH. Last, `costWatch` keeps the Cost page's snapshot fresh
 * (every few hours, as its settings say) and tells the owner on Telegram when
 * a budget, a credit balance or a renewal turns into a warning (cost/watch.js,
 * ADR 0039). Same reasoning as the delivery watch: the notifier is here and
 * this timer is armed, so no new timer and no new secret. Never fatal.
 */
import { refreshDriftRecord } from '../labs/drift.js';
import { errorFacts } from '../http/error-response.js';
import {
  AGENT_HEALTH_QUERY,
  agentIdOf,
  BACK_ONLINE_SENT,
  isoOf,
  isPreconditionFailed,
  msOf,
  offlineMessage,
  planAgentHealth,
  tellOwnerAgentBack,
} from './agent-health-plan.js';

// The decisions and the messages live in agent-health-plan.js; they are
// exported again here so callers keep importing from agent-health.js.
export {
  AGENT_HEALTH_QUERY,
  AGENT_OFFLINE_SOURCE,
  AGENT_ONLINE_SOURCE,
  agentIdOf,
  BACK_ONLINE_SENT,
  backOnlineMessage,
  OFFLINE_NOTIFY_AFTER_MS,
  offlineMessage,
  outageMinutes,
  outageStart,
  planAgentHealth,
  STALE_AFTER_MS,
  tellOwnerAgentBack,
} from './agent-health-plan.js';

const patchAgent = (d, agent, updates, options = {}) =>
  d.store.patchDoc('lab_agents', agentIdOf(agent), updates, { partitionKey: agentIdOf(agent), ...options });

/**
 * Write the marks, each guarded by the ETag of the read that decided it.
 * Returns the ids whose mark lost to a heartbeat, which this run then
 * leaves alone. A row read without an ETag is marked unguarded, as before.
 */
async function writeMarks(d, marks) {
  const lost = new Set();
  for (const { agent, updates } of marks) {
    const guard = typeof agent._etag === 'string' ? { ifMatch: agent._etag } : {};
    try {
      await patchAgent(d, agent, updates, guard);
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      lost.add(agentIdOf(agent));
    }
  }
  return lost;
}

/** One "offline" message for every agent due; stamps each when it went. Returns how many. */
async function tellOwnerOffline(d, agents, atMs) {
  const { notifier, log } = d;
  if (agents.length === 0 || !notifier?.notifyTelegram) return 0;
  let result;
  try {
    result = await notifier.notifyTelegram(offlineMessage(agents, atMs));
  } catch (error) {
    log.warn?.(`[checkAgentHealth] owner notification failed: ${errorFacts(error)}`);
    return 0;
  }
  if (result?.sent !== true) {
    log.warn?.(
      `[checkAgentHealth] offline message for ${agents.length} agent(s) not sent (${result?.reason || 'no reason given'}); the next run tries again`
    );
    return 0;
  }
  for (const agent of agents) await patchAgent(d, agent, { offlineNotifiedAt: isoOf(atMs) });
  log.warn?.(`[checkAgentHealth] offline message sent for ${agents.length} agent(s)`);
  return agents.length;
}

/** The "back online" messages a heartbeat could not send. Returns how many went. */
async function tellOwnerBack(d, agents, atMs) {
  let sent = 0;
  for (const agent of agents) {
    const backAtMs = msOf(agent.backOnlineAt) ?? msOf(agent.lastSeenAt) ?? atMs;
    if (await tellOwnerAgentBack({ notifier: d.notifier, agent, backAtMs, log: d.log, label: '[checkAgentHealth]' })) {
      await patchAgent(d, agent, BACK_ONLINE_SENT);
      sent += 1;
    }
  }
  if (sent > 0) d.log.warn?.(`[checkAgentHealth] back-online message sent for ${sent} agent(s)`);
  return sent;
}

/**
 * The hourly read of the delivery monitor's runs: 'green', 'red', 'none',
 * 'unread', 'not due' or 'failed'. Never throws; the run's own work is done.
 */
async function watchDelivery(d) {
  try {
    const outcome = await d.deliveryWatch.checkIfDue();
    if (!outcome?.checked) return 'not due';
    return outcome.verdict || 'none';
  } catch (error) {
    d.log.warn?.(`[checkAgentHealth] the delivery monitor watch failed (${error?.code ?? 'error'})`);
    return 'failed';
  }
}

/**
 * The cost watch: 'refreshed', 'checked', 'not due' or 'failed'. Never
 * throws; cost/watch.js already catches its own failures.
 */
async function watchCosts(d) {
  try {
    const outcome = await d.costWatch.checkIfDue();
    if (!outcome?.checked) return outcome?.reason === 'failed' ? 'failed' : 'not due';
    return outcome.refreshed ? 'refreshed' : 'checked';
  } catch (error) {
    d.log.warn?.(`[checkAgentHealth] the cost watch failed (${error?.code ?? 'error'})`);
    return 'failed';
  }
}

/**
 * The hourly status-token check: 'accepted', 'refused', 'not due',
 * 'skipped' (no token, or Coder gave no verdict) or 'failed'. Never throws.
 */
async function checkToken(d) {
  try {
    const outcome = await d.coderTokenCheck();
    if (!outcome?.checked) return outcome?.reason === 'not due' ? 'not due' : 'skipped';
    return outcome.refusedStatus ? 'refused' : 'accepted';
  } catch (error) {
    d.log.warn?.(`[checkAgentHealth] the status token check failed (${error?.code ?? 'error'})`);
    return 'failed';
  }
}

/**
 * The hourly read of main for the drift check: 'read', 'failed' or 'not
 * due'. Never throws; the run's own work is already done.
 */
async function readMain(d, agents, atMs) {
  try {
    const outcome = await refreshDriftRecord({
      store: d.store,
      reader: d.driftReader,
      agents,
      now: () => new Date(atMs),
      log: d.log,
    });
    if (!outcome.read) return 'not due';
    return outcome.ok ? 'read' : 'failed';
  } catch (error) {
    d.log.warn?.(
      `[checkAgentHealth] the drift record could not be written (${error?.code ?? 'error'}); the next run tries again`
    );
    return 'failed';
  }
}

/** The marks, each guarded; logs how many were written and how many lost to a heartbeat. */
async function markOffline(d, plan) {
  const lost = await writeMarks(d, plan.marks);
  const marked = plan.marks.length - lost.size;
  if (marked > 0) d.log.warn?.(`[checkAgentHealth] marked ${marked} agent(s) offline after three missed heartbeats`);
  if (lost.size > 0) {
    d.log.warn?.(
      `[checkAgentHealth] ${lost.size} agent(s) heartbeated between this run's read and its mark; left as they are`
    );
  }
  return { lost, marked };
}

/** The hourly side jobs, each only when it was given, added to the run's summary. */
async function runSideJobs(d, summary, agents, atMs) {
  if (d.driftReader) summary.mainRead = await readMain(d, agents, atMs);
  if (d.coderTokenCheck) summary.tokenCheck = await checkToken(d);
  if (d.deliveryWatch) summary.deliveryWatch = await watchDelivery(d);
  if (d.costWatch) summary.costWatch = await watchCosts(d);
}

async function run(d) {
  const atMs = d.now().getTime();
  const agents = await d.store.queryDocs('lab_agents', AGENT_HEALTH_QUERY, []);
  const plan = planAgentHealth(agents, atMs);
  const { lost, marked } = await markOffline(d, plan);

  const notifiedOffline = await tellOwnerOffline(
    d,
    plan.notifyOffline.filter((agent) => !lost.has(agentIdOf(agent))),
    atMs
  );
  const notifiedBack = await tellOwnerBack(d, plan.notifyBack, atMs);
  const summary = { markedOffline: marked, heartbeatWon: lost.size, notifiedOffline, notifiedBack };
  await runSideJobs(d, summary, agents, atMs);
  return summary;
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object|null} [deps.notifier]
 * @param {() => Date} [deps.now]
 * @param {object} [deps.log]
 * @param {{ hostCommits: Function }|null} [deps.driftReader] main's history
 *   (labs/drift.js createMainHistoryReader); null skips the hourly read
 * @param {(() => Promise<{ checked: boolean, refusedStatus?: number|null, reason?: string }>)|null}
 *   [deps.coderTokenCheck] the hourly status-token check (coder-status.js
 *   checkTokenIfDue); null skips it
 * @param {{ checkIfDue: Function }|null} [deps.deliveryWatch] the hourly read
 *   of the delivery monitor's runs (delivery-monitor-watch.js); null skips it
 * @param {{ checkIfDue: Function }|null} [deps.costWatch] the Cost page's
 *   snapshot refresh and Telegram signals (cost/watch.js); null skips it
 */
export function createAgentHealthCheck({
  store,
  notifier = null,
  now = () => new Date(),
  log = {},
  driftReader = null,
  coderTokenCheck = null,
  deliveryWatch = null,
  costWatch = null,
}) {
  const d = { store, notifier, now, log, driftReader, coderTokenCheck, deliveryWatch, costWatch };
  return { run: () => run(d) };
}

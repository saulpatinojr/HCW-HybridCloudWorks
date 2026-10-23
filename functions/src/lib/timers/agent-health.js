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
 */
import { AGENT_DOWN_STATUSES, AGENT_STALE_AFTER_MS } from '../labs.js';
import { refreshDriftRecord } from '../labs/drift.js';

export const STALE_AFTER_MS = AGENT_STALE_AFTER_MS;
/** How long an agent must have been offline before the owner is told (#1009). */
export const OFFLINE_NOTIFY_AFTER_MS = 5 * 60 * 1000;
export const AGENT_OFFLINE_SOURCE = 'lab_agent_offline';
/**
 * Its own notifier source, so the 15-minute cooldown on "offline" never holds
 * back the "back online" that ends it.
 */
export const AGENT_ONLINE_SOURCE = 'lab_agent_online';

/**
 * The whole registry, once a run. It holds a handful of documents; TOP bounds
 * a mistake. The fields are every one the three decisions read, `_etag`,
 * which guards the marks those decisions write, and `applied`, where the
 * hourly read of main starts (#1009).
 */
export const AGENT_HEALTH_QUERY =
  'SELECT TOP 100 c.id, c.agentId, c.active, c.status, c.lastSeenAt, c.hostname, c.offlineSince, c.offlineNotifiedAt, c.backOnlineAt, c.applied, c._etag FROM c';

const isPreconditionFailed = (error) => error?.code === 412 || error?.statusCode === 412;

/** The patch that settles a "back online" owed: both fields null, one round trip. */
export const BACK_ONLINE_SENT = Object.freeze({ offlineNotifiedAt: null, backOnlineAt: null });

const msOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};
const isoOf = (ms) => new Date(ms).toISOString();
export const agentIdOf = (agent) => agent?.agentId || agent?.id;
const hostOf = (agent) => agent?.hostname || 'host unknown';

/** Whole minutes from an outage's start to `endMs`, at least 1; null when the start is unknown. */
export function outageMinutes(offlineSince, endMs) {
  const startMs = msOf(offlineSince);
  if (startMs === null || !Number.isFinite(endMs)) return null;
  return Math.max(1, Math.round((endMs - startMs) / 60_000));
}

/**
 * Where an outage starts when an agent is marked offline: the start the owner
 * was already given, if they are still owed its end; otherwise the agent's
 * last heartbeat; otherwise now (it never heartbeated).
 */
export function outageStart(agent, atMs) {
  if (agent?.offlineNotifiedAt && msOf(agent.offlineSince) !== null) return agent.offlineSince;
  const seenMs = msOf(agent?.lastSeenAt);
  return isoOf(seenMs ?? atMs);
}

/**
 * The run's decisions from one read of the registry.
 *
 * @param {object[]} agents - rows of AGENT_HEALTH_QUERY
 * @param {number} atMs
 * @returns {{
 *   marks: { agent: object, updates: object }[],
 *   notifyOffline: object[],
 *   notifyBack: object[],
 * }} `notifyOffline` and `notifyBack` are the agents as they stand after the marks
 */
export function planAgentHealth(agents, atMs) {
  const marks = [];
  const after = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const seenMs = msOf(agent?.lastSeenAt);
    const stale = seenMs === null || atMs - seenMs >= STALE_AFTER_MS;
    if (agent?.status === 'offline' || !stale) {
      after.push(agent);
      continue;
    }
    const updates = { status: 'offline', offlineSince: outageStart(agent, atMs) };
    // A "back online" that never went is cancelled by the agent dropping
    // again: the owner's last word, "offline", is true once more.
    if (agent.backOnlineAt) updates.backOnlineAt = null;
    marks.push({ agent, updates });
    after.push({ ...agent, ...updates });
  }

  const dueBy = atMs - OFFLINE_NOTIFY_AFTER_MS;
  const notifyOffline = after.filter(
    (a) =>
      a.status === 'offline' &&
      a.active === true &&
      !a.offlineNotifiedAt &&
      (msOf(a.offlineSince) ?? atMs) <= dueBy
  );
  // After the marks, an agent that is not down is heartbeating: a stale one
  // was marked offline above.
  const notifyBack = after.filter(
    (a) => !AGENT_DOWN_STATUSES.includes(a.status) && Boolean(a.offlineNotifiedAt)
  );
  return { marks, notifyOffline, notifyBack };
}

/** The "offline" message, one for every agent that came due in a run. */
export function offlineMessage(agents, atMs) {
  const lines = agents.map((a) => {
    const minutes = outageMinutes(a.offlineSince, atMs);
    const since = a.offlineSince
      ? `offline since ${a.offlineSince}${minutes ? ` (${minutes} min)` : ''}`
      : 'offline';
    const last = a.lastSeenAt ? `last heartbeat ${a.lastSeenAt}` : 'never heartbeated';
    return `${agentIdOf(a)} (${hostOf(a)}): ${since}, ${last}`;
  });
  return {
    title: `Lab agent offline (${agents.length})`,
    message: `Offline for ${OFFLINE_NOTIFY_AFTER_MS / 60_000} minutes or more. Public lab submission fails closed until it is back, and a "back online" message follows when it is.\n${lines.join('\n')}`,
    // 'critical' draws the red marker; 'error' is not a level the notifier
    // knows and fell through to the informational one (review of #910).
    severity: 'critical',
    source: AGENT_OFFLINE_SOURCE,
  };
}

/** The "back online" message that ends an outage the owner was told about. */
export function backOnlineMessage(agent, backAtMs) {
  const minutes = outageMinutes(agent?.offlineSince, backAtMs);
  const since = agent?.offlineSince ? `, offline since ${agent.offlineSince}` : '';
  return {
    title: minutes ? `Lab agent back online after ${minutes} min` : 'Lab agent back online',
    message: `${agentIdOf(agent)} (${hostOf(agent)}) heartbeated again at ${isoOf(backAtMs)}${since}. It is taking lab jobs again.`,
    severity: 'info',
    source: AGENT_ONLINE_SOURCE,
  };
}

/**
 * Send the "back online" message. True only when the notifier says it went;
 * anything else leaves the debt on the document for the next run. Never throws.
 *
 * @param {{ notifier?: object|null, agent: object, backAtMs: number, log?: object, label: string }} args
 */
export async function tellOwnerAgentBack({ notifier, agent, backAtMs, log = {}, label }) {
  if (!notifier?.notifyTelegram) return false;
  try {
    const result = await notifier.notifyTelegram(backOnlineMessage(agent, backAtMs));
    if (result?.sent === true) return true;
    log.warn?.(
      `${label} back-online message not sent (${result?.reason || 'no reason given'}); checkAgentHealth tries again`
    );
  } catch (error) {
    log.warn?.(`${label} back-online notification failed: ${error?.message || error}`);
  }
  return false;
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
 */
export function createAgentHealthCheck({
  store,
  notifier = null,
  now = () => new Date(),
  log = {},
  driftReader = null,
  coderTokenCheck = null,
  deliveryWatch = null,
}) {
  const patchAgent = (agent, updates, options = {}) =>
    store.patchDoc('lab_agents', agentIdOf(agent), updates, { partitionKey: agentIdOf(agent), ...options });

  /**
   * Write the marks, each guarded by the ETag of the read that decided it.
   * Returns the ids whose mark lost to a heartbeat, which this run then
   * leaves alone. A row read without an ETag is marked unguarded, as before.
   */
  async function writeMarks(marks) {
    const lost = new Set();
    for (const { agent, updates } of marks) {
      const guard = typeof agent._etag === 'string' ? { ifMatch: agent._etag } : {};
      try {
        await patchAgent(agent, updates, guard);
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
        lost.add(agentIdOf(agent));
      }
    }
    return lost;
  }

  /** One "offline" message for every agent due; stamps each when it went. Returns how many. */
  async function tellOwnerOffline(agents, atMs) {
    if (agents.length === 0 || !notifier?.notifyTelegram) return 0;
    let result;
    try {
      result = await notifier.notifyTelegram(offlineMessage(agents, atMs));
    } catch (error) {
      log.warn?.(`[checkAgentHealth] owner notification failed: ${error?.message || error}`);
      return 0;
    }
    if (result?.sent !== true) {
      log.warn?.(
        `[checkAgentHealth] offline message for ${agents.length} agent(s) not sent (${result?.reason || 'no reason given'}); the next run tries again`
      );
      return 0;
    }
    for (const agent of agents) await patchAgent(agent, { offlineNotifiedAt: isoOf(atMs) });
    log.warn?.(`[checkAgentHealth] offline message sent for ${agents.length} agent(s)`);
    return agents.length;
  }

  /** The "back online" messages a heartbeat could not send. Returns how many went. */
  async function tellOwnerBack(agents, atMs) {
    let sent = 0;
    for (const agent of agents) {
      const backAtMs = msOf(agent.backOnlineAt) ?? msOf(agent.lastSeenAt) ?? atMs;
      if (await tellOwnerAgentBack({ notifier, agent, backAtMs, log, label: '[checkAgentHealth]' })) {
        await patchAgent(agent, BACK_ONLINE_SENT);
        sent += 1;
      }
    }
    if (sent > 0) log.warn?.(`[checkAgentHealth] back-online message sent for ${sent} agent(s)`);
    return sent;
  }

  async function run() {
    const atMs = now().getTime();
    const agents = await store.queryDocs('lab_agents', AGENT_HEALTH_QUERY, []);
    const plan = planAgentHealth(agents, atMs);

    const lost = await writeMarks(plan.marks);
    const marked = plan.marks.length - lost.size;
    if (marked > 0) log.warn?.(`[checkAgentHealth] marked ${marked} agent(s) offline after three missed heartbeats`);
    if (lost.size > 0) {
      log.warn?.(
        `[checkAgentHealth] ${lost.size} agent(s) heartbeated between this run's read and its mark; left as they are`
      );
    }

    const notifiedOffline = await tellOwnerOffline(
      plan.notifyOffline.filter((agent) => !lost.has(agentIdOf(agent))),
      atMs
    );
    const notifiedBack = await tellOwnerBack(plan.notifyBack, atMs);
    const summary = { markedOffline: marked, heartbeatWon: lost.size, notifiedOffline, notifiedBack };
    if (driftReader) summary.mainRead = await readMain(agents, atMs);
    if (coderTokenCheck) summary.tokenCheck = await checkToken();
    if (deliveryWatch) summary.deliveryWatch = await watchDelivery();
    return summary;
  }

  /**
   * The hourly read of the delivery monitor's runs: 'green', 'red', 'none',
   * 'unread', 'not due' or 'failed'. Never throws; the run's own work is done.
   */
  async function watchDelivery() {
    try {
      const outcome = await deliveryWatch.checkIfDue();
      if (!outcome?.checked) return 'not due';
      return outcome.verdict || 'none';
    } catch (error) {
      log.warn?.(`[checkAgentHealth] the delivery monitor watch failed (${error?.code ?? 'error'})`);
      return 'failed';
    }
  }

  /**
   * The hourly status-token check: 'accepted', 'refused', 'not due',
   * 'skipped' (no token, or Coder gave no verdict) or 'failed'. Never throws.
   */
  async function checkToken() {
    try {
      const outcome = await coderTokenCheck();
      if (!outcome?.checked) return outcome?.reason === 'not due' ? 'not due' : 'skipped';
      return outcome.refusedStatus ? 'refused' : 'accepted';
    } catch (error) {
      log.warn?.(`[checkAgentHealth] the status token check failed (${error?.code ?? 'error'})`);
      return 'failed';
    }
  }

  /**
   * The hourly read of main for the drift check: 'read', 'failed' or 'not
   * due'. Never throws; the run's own work is already done.
   */
  async function readMain(agents, atMs) {
    try {
      const outcome = await refreshDriftRecord({
        store,
        reader: driftReader,
        agents,
        now: () => new Date(atMs),
        log,
      });
      if (!outcome.read) return 'not due';
      return outcome.ok ? 'read' : 'failed';
    } catch (error) {
      log.warn?.(
        `[checkAgentHealth] the drift record could not be written (${error?.code ?? 'error'}); the next run tries again`
      );
      return 'failed';
    }
  }
  return { run };
}

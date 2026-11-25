/**
 * agent-health-plan.js — the decisions and messages of `checkAgentHealth`
 * (agent-health.js): which agents to mark offline, who the owner is told
 * about, and the words of the "offline" and "back online" messages.
 * agent-health.js says why, and exports all of this again.
 */
import { AGENT_DOWN_STATUSES, AGENT_STALE_AFTER_MS } from '../labs.js';
import { errorFacts } from '../http/error-response.js';

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

export const isPreconditionFailed = (error) => error?.code === 412 || error?.statusCode === 412;

/** The patch that settles a "back online" owed: both fields null, one round trip. */
export const BACK_ONLINE_SENT = Object.freeze({ offlineNotifiedAt: null, backOnlineAt: null });

export const msOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};
export const isoOf = (ms) => new Date(ms).toISOString();
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
    log.warn?.(`${label} back-online notification failed: ${errorFacts(error)}`);
  }
  return false;
}


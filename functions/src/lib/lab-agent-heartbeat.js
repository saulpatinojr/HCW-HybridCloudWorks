/**
 * lab-agent-heartbeat.js — what a Labs agent's heartbeat writes
 * (heartbeatAgent in lab-agent.js, which authenticates the agent first and
 * re-exports parseAppliedRecord): its liveness fields, the commit its host
 * applied, and the offline and back-online transitions with the owner's
 * message they may owe.
 */
import { json } from './http/admin-handler.js';
import { errorFacts } from './http/error-response.js';
import { AGENT_DOWN_STATUSES } from './labs.js';
import { MAX_CLOCK_SKEW_MS, parseIsoDateTime } from './labs/coder-automation.js';
import {
  BACK_ONLINE_SENT,
  OFFLINE_NOTIFY_AFTER_MS,
  outageMinutes,
  tellOwnerAgentBack,
} from './timers/agent-health.js';

/**
 * A shutdown the agent announces itself, and the first normal heartbeat
 * after one.
 *
 * A `systemctl stop` sends SIGTERM and the agent heartbeats `stopping`, then
 * `offline` (vps-agent/index.js). That heartbeat marks it offline here, at
 * once, so the online rule (lib/labs.js) closes the public door without
 * waiting for the 90 s of silence the health timer measures. It does NOT
 * tell the owner any more: until 2026-10-08 it sent a critical "Lab agent
 * offline" on the spot, and that morning's 04:30 reboot, back in 43 seconds,
 * left the owner with a red alert and no word that it was over (#1009). The
 * health timer now says "offline" once an outage has lasted
 * OFFLINE_NOTIFY_AFTER_MS, and records that it did on the agent's document
 * (`offlineNotifiedAt`).
 *
 * The first normal heartbeat after such an outage owes the owner its end:
 * it stamps `backOnlineAt`, sends "Lab agent back online after N min", and
 * clears both fields once the message has gone. When it does not go (the
 * notifier's cooldown, Telegram down) the fields stay, and the health timer
 * sends it on its next run (lib/timers/agent-health.js). Best effort either
 * way: the heartbeat is recorded whether or not a message goes.
 *
 * An agent that drops again while the owner is still owed the end of an
 * outage keeps that outage's start (`offlineSince`), and the unsent "back
 * online" is cancelled: to the owner it is one outage.
 */
function outageUpdates(agent, updates) {
  const goingOffline = updates.status === 'offline' && agent.status !== 'offline';
  const comingBack = agent.status === 'offline' && !AGENT_DOWN_STATUSES.includes(updates.status);
  const owesBack = comingBack && Boolean(agent.offlineNotifiedAt);
  const extra = {};
  if (goingOffline) {
    if (!(agent.offlineNotifiedAt && agent.offlineSince)) extra.offlineSince = updates.lastSeenAt;
    if (agent.backOnlineAt) extra.backOnlineAt = null;
  }
  if (owesBack) extra.backOnlineAt = updates.lastSeenAt;
  return { goingOffline, comingBack, owesBack, extra };
}

/**
 * The warn lines a transition writes, and the "back online" it may owe.
 *
 * Content-free: Warning is the level host.json ingests, so these name the
 * transition and never the agent's document id. The registry holds one agent
 * per host, and the owner's message, which is not telemetry, names it.
 */
async function reportOutage({ store, notifier }, context, agent, outage, atMs) {
  const id = agent.agentId;
  if (outage.goingOffline) {
    context.warn?.(
      `heartbeatAgent: an agent reported its own shutdown and is marked offline; the owner is told only if it stays offline ${OFFLINE_NOTIFY_AFTER_MS / 60_000} minutes`
    );
  }
  if (!outage.comingBack) return;
  const minutes = outageMinutes(agent.offlineSince, atMs);
  context.warn?.(
    `heartbeatAgent: an agent is back online${minutes ? ` after ${minutes} min` : ''}${outage.owesBack ? '; the owner was told it was offline' : ''}`
  );
  if (!outage.owesBack) return;
  const sent = await tellOwnerAgentBack({
    notifier,
    agent,
    backAtMs: atMs,
    log: context,
    label: 'heartbeatAgent:',
  });
  if (!sent) return;
  try {
    await store.patchDoc('lab_agents', id, BACK_ONLINE_SENT, { partitionKey: id });
    context.warn?.('heartbeatAgent: back-online message sent');
  } catch (err) {
    // The message went; the next health run would send it again, which is
    // the lesser fault than claiming here that it did not.
    context.warn?.(`heartbeatAgent: back-online message sent, but clearing the debt failed: ${errorFacts(err)}`);
  }
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The commit the agent's host last converged from, as a heartbeat carries it
 * (`applied`, vps-agent/lib/applied-commit.js; #1009), checked: a full
 * lower-case sha and two ISO 8601 date-times with a zone, normalised to UTC.
 * Null for anything else, and for a date more than MAX_CLOCK_SKEW_MS ahead of
 * the site's clock: both say when something already happened, and the host's
 * clock is checked, not trusted (labs/coder-automation.js has the same rule).
 *
 * Not an authorization input, unlike `capabilities` and `oid`: it is the
 * host's own account of itself, which is all the drift check
 * (labs/drift.js) can have, and a host that lies about it only hides its own
 * lag from its owner.
 *
 * @returns {{ commit: string, committedAt: string, appliedAt: string } | null}
 */
export function parseAppliedRecord(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.commit !== 'string' || !COMMIT_SHA.test(raw.commit)) return null;
  const committedAt = parseIsoDateTime(raw.committedAt);
  const appliedAt = parseIsoDateTime(raw.appliedAt);
  if (!committedAt || !appliedAt) return null;
  const ahead = (iso) => Date.parse(iso) - nowMs > MAX_CLOCK_SKEW_MS;
  if (ahead(committedAt) || ahead(appliedAt)) return null;
  return { commit: raw.commit, committedAt, appliedAt };
}

/** True when the stored record already says exactly this. */
const sameApplied = (stored, next) =>
  stored?.commit === next.commit &&
  stored?.committedAt === next.committedAt &&
  stored?.appliedAt === next.appliedAt;

/**
 * The fields one heartbeat writes for this agent, from the body it sent and
 * the time it arrived.
 *
 * `capabilities` and `oid` are NOT writable through this path — they are
 * the registry's authorization inputs, and an endpoint the VPS can reach
 * must not be able to grant the VPS new job types or rebind its identity.
 * `applied`, the commit the host converged from, is (parseAppliedRecord).
 */
function heartbeatUpdates(agent, body, at) {
  const activeJobs =
    Number.isInteger(body.activeJobs) && body.activeJobs >= 0 ? body.activeJobs : 0;
  const status = ['idle', 'busy', 'stopping', 'offline'].includes(body.status)
    ? body.status
    : 'idle';

  // Built conditionally, not with `undefined` placeholders: patchDoc treats
  // an undefined value as a field DELETION, so spreading absent optionals
  // would wipe the stored hostname and version on every heartbeat — and
  // would route each one through the read-modify-write path, turning a
  // 30-second poll into two round trips instead of one.
  // Both shutdown statuses win over the job-derived `busy`. The agent sends
  // `stopping` while it drains its jobs and `offline` with activeJobs > 0
  // when its shutdown deadline expires with work still running; rewriting
  // either to `busy` read a departing agent as online and let the public
  // door queue work its poller will never claim (review of #1018).
  let effective = status;
  if (!AGENT_DOWN_STATUSES.includes(status) && activeJobs > 0) effective = 'busy';
  const updates = {
    status: effective,
    activeJobs,
    lastSeenAt: at.toISOString(),
  };
  if (typeof body.hostname === 'string') updates.hostname = body.hostname.slice(0, 255);
  if (typeof body.version === 'string') updates.version = body.version.slice(0, 64);
  if (typeof body.certificateExpiresAt === 'string') {
    const certExp = parseIsoDateTime(body.certificateExpiresAt);
    if (certExp && agent.certificateExpiresAt !== certExp) updates.certificateExpiresAt = certExp;
  }

  // The host's applied commit (#1009), one patch operation as one object, and
  // only when it changed: it moves once per bootstrap.sh run, not per beat.
  // An absent or refused record leaves the stored one as it was; the drift
  // verdict judges its age, so a host that stops reporting is not hidden.
  const applied = parseAppliedRecord(body.applied, at.getTime());
  if (applied && !sameApplied(agent.applied, applied)) updates.applied = applied;

  return updates;
}

/** Everything after the agent is authenticated: the liveness write, then the outage report. */
export async function recordHeartbeat({ store, now, notifier }, { body, agent }, context) {
  const at = now();
  const updates = heartbeatUpdates(agent, body, at);

  // The transitions the health timer would otherwise have to find: the
  // record said the agent was up and this heartbeat says it has gone, or
  // the record said offline and this one is normal.
  const outage = outageUpdates(agent, updates);
  Object.assign(updates, outage.extra);

  try {
    await store.patchDoc('lab_agents', agent.agentId, updates, {
      partitionKey: agent.agentId,
    });
  } catch (err) {
    context.error('heartbeatAgent failed:', errorFacts(err));
    return json(500, { ok: false, error: 'Failed to record heartbeat' });
  }

  await reportOutage(
    { store, notifier },
    context,
    { ...agent, hostname: updates.hostname ?? agent.hostname },
    outage,
    at.getTime()
  );

  return json(200, { ok: true });
}

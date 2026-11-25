/**
 * labs/drift-verdict.js — the Labs drift check's verdict (drift.js has the
 * read of main and the header that explains the check): for each lab agent,
 * whether the host has converged from main's newest lab-host change, and
 * the fleet's worst. Pure over the stored record and the agents.
 */
import { appliedOf } from '../labs.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a merged change may wait for bootstrap.sh before the host is behind. */
export const DRIFT_LAG_LIMIT_MS = 24 * HOUR_MS;

/** Six missed hourly reads, and the comparison is no longer evidence that nothing new merged. */
export const DRIFT_READ_STALE_AFTER_MS = 6 * HOUR_MS;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

/** Epoch ms of a stored ISO date-time, or NaN. */
export const msOf = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return Number.NaN;
  return Date.parse(value);
};

// ── The verdict ──────────────────────────────────────────────────────────────

/** Most severe first: the order a fleet's verdict is chosen in. */
const SEVERITY = Object.freeze(['critical', 'offline', 'degraded', 'unknown', 'healthy']);
const worst = (statuses) =>
  SEVERITY.find((status) => statuses.includes(status)) ?? 'unknown';

const short = (sha) => String(sha).slice(0, 8);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "just now", "12 min ago", "3 h ago", "2 d ago": the words of health/pulse-checks.js ago(). */
export function agoText(value, nowMs) {
  const then = msOf(value);
  if (!Number.isFinite(then)) return 'at an unknown time';
  const minutes = Math.round(Math.max(0, nowMs - then) / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const agentName = (agent) => agent?.agentId || agent?.id || 'an agent';

/** The commits on main under HOST_PATHS that the applied commit does not have, oldest first. */
export function pendingCommits(applied, drift) {
  const appliedMs = msOf(applied.committedAt);
  return (Array.isArray(drift?.hostCommits) ? drift.hostCommits : [])
    .filter((commit) => commit?.sha !== applied.commit && msOf(commit?.committedAt) > appliedMs)
    .sort((a, b) => msOf(a.committedAt) - msOf(b.committedAt));
}

/** Whether the stored read started early enough to see every commit after this one. */
const covers = (drift, applied) => !drift?.since || msOf(drift.since) <= msOf(applied.committedAt);

function behindVerdict(name, applied, pending, drift, nowMs) {
  const oldest = pending[0];
  const lagMs = nowMs - msOf(oldest.committedAt);
  const count = `${drift?.truncated ? 'at least ' : ''}${plural(pending.length, 'change')}`;
  const detail = pending
    .slice(0, 10)
    .map((commit) => `${short(commit.sha)} ${commit.committedAt}${commit.title ? ` ${commit.title}` : ''}`)
    .join('\n');
  if (lagMs > DRIFT_LAG_LIMIT_MS) {
    return {
      status: 'critical',
      summary: `${name} is behind main: ${count} under lab-host/ or vps-agent/ merged after ${short(applied.commit)}, the oldest ${agoText(oldest.committedAt, nowMs)}. Run bootstrap.sh on the lab host.`,
      detail,
    };
  }
  return {
    status: 'healthy',
    summary: `${name} converged from ${short(applied.commit)} ${agoText(applied.appliedAt, nowMs)}; ${count} merged since ${agoText(oldest.committedAt, nowMs)}, raised if still not applied a day after merging.`,
    detail,
  };
}

/** The verdict while main has no successful read yet: it failed, or it has not been asked; null once it has. */
function mainUnreadVerdict(where, drift) {
  if (drift?.lastSuccessAt) return null;
  if (drift?.lastError) {
    // Attempted and failed: not the same as not yet asked (CodeRabbit, #1054).
    return {
      status: 'unknown',
      summary: `${where}; main could not be read (${drift.lastError}). checkAgentHealth tries again hourly, and this clears only once a read succeeds.`,
    };
  }
  return {
    status: 'unknown',
    summary: `${where}; main has not been read yet. checkAgentHealth reads it on its first run and then hourly.`,
  };
}

/** One agent's verdict, before the freshness of the read is taken into account. */
function agentVerdict(agent, drift, nowMs) {
  const name = agentName(agent);
  const applied = appliedOf(agent);
  if (!applied) {
    return {
      status: 'critical',
      summary: `${name} has not reported the commit it converged from. bootstrap.sh records it at the end of every run that completes (/etc/hcw/applied-commit.json); until one does, the host is taken to be behind main.`,
    };
  }
  const where = `${name} converged from ${short(applied.commit)} ${agoText(applied.appliedAt, nowMs)}`;
  const unread = mainUnreadVerdict(where, drift);
  if (unread) return unread;
  if (!covers(drift, applied)) {
    return {
      status: 'unknown',
      summary: `${where}, older than the last read of main reaches back; the next hourly read covers it.`,
    };
  }
  const pending = pendingCommits(applied, drift);
  if (pending.length > 0) return behindVerdict(name, applied, pending, drift, nowMs);
  return {
    status: 'healthy',
    summary: `${where}; nothing under lab-host/ or vps-agent/ has merged to main since.`,
  };
}

/**
 * A stale read cannot vouch for "nothing new": a healthy verdict on it is
 * unknown. A behind verdict stands, since the lag only grows.
 */
function withFreshness(verdict, drift, nowMs) {
  const lastSuccessMs = msOf(drift?.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) return verdict;
  if (nowMs - lastSuccessMs > DRIFT_READ_STALE_AFTER_MS) return staleVerdict(verdict, drift, nowMs);
  // Still evidence, so the verdict stands; but the newest attempt failed,
  // and the reader is told so rather than shown a good read as current
  // (CodeRabbit, #1054). `lastError` is cleared by every successful read.
  if (!drift.lastError) return verdict;
  return {
    ...verdict,
    summary: `${verdict.summary} The latest read of main failed (${drift.lastError}); this is from the read ${agoText(drift.lastSuccessAt, nowMs)}.`,
  };
}

/** A verdict from a read of main too old to stand on: said so, and a healthy one is not known any more. */
function staleVerdict(verdict, drift, nowMs) {
  const note = ` Main was last read ${agoText(drift.lastSuccessAt, nowMs)}${drift.lastError ? ` (${drift.lastError})` : ''}.`;
  if (verdict.status === 'healthy') {
    return { ...verdict, status: 'unknown', summary: `${verdict.summary}${note} Newer changes may be missing.` };
  }
  return { ...verdict, summary: `${verdict.summary}${note}` };
}

/**
 * Whether every active agent's host runs main. Pure.
 *
 * @param {{ agents: object[], drift: object|null, nowMs: number }} input
 *   `agents` are lab_agents rows (`id`, `active`, `applied`); `drift` is
 *   admin_config/lab_drift or null
 * @returns {{ status: string, summary: string, detail: string|null,
 *   agents: Record<string, { status: string, summary: string }> }}
 *   `agents` is each agent's own verdict, by id, for its card
 */
export function labDriftVerdict({ agents, drift, nowMs }) {
  const active = (Array.isArray(agents) ? agents : []).filter((agent) => agent?.active === true);
  if (active.length === 0) {
    return {
      status: 'unknown',
      summary: 'No active lab agent is registered, so there is no host to compare with main.',
      detail: null,
      agents: {},
    };
  }
  const verdicts = active.map((agent) => ({
    id: agentName(agent),
    ...withFreshness(agentVerdict(agent, drift, nowMs), drift, nowMs),
  }));
  const status = worst(verdicts.map((verdict) => verdict.status));
  const lead = verdicts.find((verdict) => verdict.status === status);
  const others = verdicts.filter((verdict) => verdict !== lead).map((verdict) => verdict.summary);
  const detail = [lead.detail, ...others].filter(Boolean).join('\n') || null;
  return {
    status,
    summary: lead.summary,
    detail,
    agents: Object.fromEntries(
      verdicts.map((verdict) => [verdict.id, { status: verdict.status, summary: verdict.summary }])
    ),
  };
}

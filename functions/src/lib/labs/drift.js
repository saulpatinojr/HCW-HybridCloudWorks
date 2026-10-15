/**
 * drift.js — whether the lab host runs main (#1009; the drift half of LAB-4,
 * #950).
 *
 * On 2026-10-08 the host was six merged pull requests behind main, the docs
 * said LAB-5 was live, and nothing anywhere said otherwise: bootstrap.sh is
 * re-run by hand after a merge, and nobody had. This module makes that lag a
 * signal. It does not heal it: nothing here runs the playbook, and nothing
 * should, because a merge that changes sshd or the Docker daemon is applied
 * by the owner, watching.
 *
 * THREE PIECES, AND WHERE EACH COMES FROM
 *
 *   applied   The commit the host last converged from. site.yml's last task
 *             writes /etc/hcw/applied-commit.json (only after every role and
 *             check passed), the agent sends it on every heartbeat
 *             (vps-agent/lib/applied-commit.js), and lib/lab-agent.js stores
 *             it on the agent's registry document as `applied`.
 *   main      The commits on main that touch what the host runs: lab-host/
 *             (the playbook and the Coder template) and vps-agent/ (the agent
 *             runs from a checkout of the same commit). Read here from
 *             GitHub's public REST API, once an hour, by checkAgentHealth
 *             (lib/timers/agent-health.js), into admin_config/lab_drift.
 *   verdict   labDriftVerdict below, pure: the health pulse records it as the
 *             `lab-drift` probe every five minutes, and getLabsSnapshot puts
 *             it on each agent's card.
 *
 * WHY THE PUBLIC GITHUB API, AND NOT THE SITE'S OWN BUILD COMMIT. The
 * Functions app is deployed by hand (deploy-functions.yml is dispatch-only),
 * so the commit it was built from says nothing about main: a host that lags
 * main by a week can be ahead of a site deployed a fortnight ago. The
 * repository is public, so the read needs no token and adds no secret; the
 * Drafts import already reads the same API the same way, through the same
 * pinned, redirect-refusing, size-capped fetch (cms/repo-draft-source.js),
 * which this reuses rather than copies. The call is server-side, so the SPA's
 * Content-Security-Policy is not involved, and the Function App's egress is
 * open to the Internet (infra/network.tf). The unauthenticated limit is 60
 * requests an hour per outbound address; this spends two an hour, and a
 * refusal (`RATE_LIMITED`) is recorded and shown, never guessed past.
 *
 * WHY ONLY THOSE TWO PATHS. A docs or frontend merge changes nothing on the
 * host, and counting it would have the owner re-run the playbook daily for
 * nothing, which is how an alarm comes to be ignored. The squash-merged main
 * is linear, so "merged after the applied commit" is "committed after it":
 * the comparison is by committer date, against the applied commit's own
 * committer date, which the host reports beside its sha.
 *
 * THE RULE. A host is behind when a commit under lab-host/ or vps-agent/
 * merged after its applied commit, and the oldest such commit merged more
 * than DRIFT_LAG_LIMIT_MS (24 h) ago: a day is the owner's window to re-run
 * bootstrap.sh after a merge. A host that has never reported a commit is
 * behind by definition: it has not completed a run since this check exists.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { appliedOf } from '../labs.js';
import { API_ORIGIN, API_PATH_PREFIX, REPO_REF } from '../cms/repo-draft.js';
import {
  GITHUB_FETCH_TIMEOUT_MS,
  MAX_API_BYTES,
  RepoSourceError,
  fetchPinned,
} from '../cms/repo-draft-source.js';
import { isAuthoredError, storedFailure } from '../http/error-response.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const LAB_DRIFT_DOC_ID = 'lab_drift';
export const LAB_DRIFT_DOC_TYPE = 'lab_drift';
const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

/** What the host runs from its checkout: the playbook and template, and the agent. */
export const HOST_PATHS = Object.freeze(['lab-host', 'vps-agent']);

/** How long a merged change may wait for bootstrap.sh before the host is behind. */
export const DRIFT_LAG_LIMIT_MS = 24 * HOUR_MS;

/**
 * How often main is read. A little under an hour, so a five-minute timer that
 * starts a few seconds late does not slip to every sixty-five minutes.
 */
export const DRIFT_READ_INTERVAL_MS = 55 * MINUTE_MS;

/** Six missed hourly reads, and the comparison is no longer evidence that nothing new merged. */
export const DRIFT_READ_STALE_AFTER_MS = 6 * HOUR_MS;

/**
 * Commits asked for per path. A web-flow-signed commit object is about 4 KB,
 * so fifty stay well inside the fetch's 512 KB cap. Reading `since` the oldest
 * applied commit, more than fifty means a host far behind; the list is then
 * marked truncated and the verdict says "at least".
 */
export const COMMITS_PER_PATH = 50;
export const MAX_STORED_COMMITS = 100;
export const MAX_TITLE_LENGTH = 100;

/** The applied-commit rule lives beside the online rule (labs.js); re-exported for this module's callers. */
export { appliedOf };

const GITHUB_JSON = 'application/vnd.github+json';
const SHA = /^[0-9a-f]{40}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

const msOf = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return Number.NaN;
  return Date.parse(value);
};
const isoOrNull = (value) => (Number.isFinite(msOf(value)) ? new Date(msOf(value)).toISOString() : null);

/** One commit of GitHub's list as this module keeps it, or null when it is not one. */
function toCommit(row) {
  const sha = typeof row?.sha === 'string' ? row.sha : '';
  const committedAt = isoOrNull(row?.commit?.committer?.date);
  if (!SHA.test(sha) || !committedAt) return null;
  const message = typeof row?.commit?.message === 'string' ? row.commit.message : '';
  return { sha, committedAt, title: message.split('\n')[0].trim().slice(0, MAX_TITLE_LENGTH) };
}

/** Newest first, one row per sha. */
function mergeCommits(lists) {
  const bySha = new Map();
  for (const commit of lists.flat()) bySha.set(commit.sha, commit);
  return [...bySha.values()].sort((a, b) => msOf(b.committedAt) - msOf(a.committedAt));
}

/**
 * The commits on main under HOST_PATHS, through GitHub's public REST API
 * (`GET /repos/{owner}/{repo}/commits?sha=main&path=…&since=…`). Throws the
 * coded errors of cms/repo-draft-source.js (RATE_LIMITED, TIMEOUT, …).
 *
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [deps]
 */
export function createMainHistoryReader({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = GITHUB_FETCH_TIMEOUT_MS,
} = {}) {
  /**
   * The commits on main under one path since a date, newest first. A body
   * that is not a commit list is a coded RepoSourceError (#945).
   *
   * @param {string} path - a HOST_PATHS entry
   * @param {string|null} since - an ISO date, or null for the default window
   * @returns {Promise<object[]>}
   */
  async function commitsTouching(path, since) {
    const query = new URLSearchParams({ sha: REPO_REF, path, per_page: String(COMMITS_PER_PATH) });
    if (since) query.set('since', since);
    const bytes = await fetchPinned(fetchImpl, `${API_ORIGIN}${API_PATH_PREFIX}commits?${query}`, {
      accept: GITHUB_JSON,
      maxBytes: MAX_API_BYTES,
      timeoutMs,
    });
    let rows;
    try {
      rows = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RepoSourceError('GitHub answered with something that is not JSON.', {
        code: 'UPSTREAM_SHAPE',
      });
    }
    if (!Array.isArray(rows)) {
      throw new RepoSourceError('The commit list is not a list.', { code: 'UPSTREAM_SHAPE' });
    }
    return rows.map(toCommit).filter(Boolean);
  }

  return {
    /**
     * Every commit on main under HOST_PATHS committed at or after `since`
     * (all of them, newest first, up to COMMITS_PER_PATH a path, when it is
     * null), and whether either list may have been cut short.
     */
    async hostCommits(since = null) {
      const lists = [];
      // One after the other: two calls an hour does not need parallelism,
      // and a rate limit then stops the second rather than racing it.
      for (const path of HOST_PATHS) lists.push(await commitsTouching(path, since));
      return {
        commits: mergeCommits(lists).slice(0, MAX_STORED_COMMITS),
        truncated: lists.some((list) => list.length >= COMMITS_PER_PATH),
      };
    },
  };
}

/** The oldest applied commit date among active agents: where the read of main must start. */
export function readSince(agents) {
  const dates = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.active === true)
    .map(appliedOf)
    .filter(Boolean)
    .map((applied) => msOf(applied.committedAt));
  return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
}

/**
 * What a failed read stores and shows: a RepoSourceError's `CODE: sentence`,
 * written in this repository and carrying no secret, or a fixed sentence
 * with the code for anything else, never a socket's or GitHub's own words
 * (#945).
 *
 * @param {unknown} error - what the read threw
 * @returns {string}
 */
function describeReadError(error) {
  const sentence = storedFailure(error, "main's lab-host history could not be read.").slice(0, 300);
  return isAuthoredError(error) && error.code ? `${error.code}: ${sentence}` : sentence;
}

/** The fields a failed read keeps from the last good one, so the comparison stays usable. */
function keptFrom(current) {
  return {
    since: current?.since ?? null,
    truncated: current?.truncated === true,
    hostCommits: Array.isArray(current?.hostCommits) ? current.hostCommits : [],
    lastSuccessAt: current?.lastSuccessAt ?? null,
  };
}

/**
 * Read main's host commits into admin_config/lab_drift, at most once per
 * DRIFT_READ_INTERVAL_MS. Called by checkAgentHealth with the registry rows
 * it already read.
 *
 * A read, then a write decided from it, so the write is ETag-guarded:
 * `replaceDocIfMatch` under the document's `_etag`, or `createDoc` for the
 * first. A 412 or 409 means another instance wrote it in between, and this
 * run leaves it alone. A failed GitHub read is recorded, never thrown: the
 * last good list is kept, `lastError` says why, and the verdict turns
 * unknown once the list is DRIFT_READ_STALE_AFTER_MS old.
 *
 * Telemetry is content-free: the warn line names the error code, never a
 * sha, a path or the document.
 *
 * @returns {Promise<{ read: boolean, ok?: boolean, written?: boolean }>}
 */
export async function refreshDriftRecord({ store, reader, agents, now = () => new Date(), log = {} }) {
  const at = now();
  const atMs = at.getTime();
  const current = await store.readDoc(CONTAINER, LAB_DRIFT_DOC_ID, ADMIN_CONFIG_PARTITION);
  const lastAttemptMs = msOf(current?.lastAttemptAt);
  if (Number.isFinite(lastAttemptMs) && atMs - lastAttemptMs < DRIFT_READ_INTERVAL_MS) {
    return { read: false };
  }

  const base = {
    id: LAB_DRIFT_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: LAB_DRIFT_DOC_TYPE,
    paths: [...HOST_PATHS],
    lastAttemptAt: at.toISOString(),
  };
  const since = readSince(agents);
  let next;
  let ok;
  try {
    const { commits, truncated } = await reader.hostCommits(since);
    next = { ...base, since, truncated, hostCommits: commits, lastSuccessAt: at.toISOString(), lastError: null };
    ok = true;
  } catch (error) {
    next = { ...base, ...keptFrom(current), lastError: describeReadError(error) };
    ok = false;
    log.warn?.(
      `[checkAgentHealth] main's lab-host history could not be read (${error?.code ?? 'error'}); the drift check keeps its last read`
    );
  }

  try {
    if (current) await store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK);
    else await store.createDoc(CONTAINER, next);
  } catch (error) {
    if (error?.code === 412 || error?.code === 409) return { read: true, ok, written: false };
    throw error;
  }
  return { read: true, ok, written: true };
}

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
  if (!drift?.lastSuccessAt && drift?.lastError) {
    // Attempted and failed: not the same as not yet asked (CodeRabbit, #1054).
    return {
      status: 'unknown',
      summary: `${where}; main could not be read (${drift.lastError}). checkAgentHealth tries again hourly, and this clears only once a read succeeds.`,
    };
  }
  if (!drift?.lastSuccessAt) {
    return {
      status: 'unknown',
      summary: `${where}; main has not been read yet. checkAgentHealth reads it on its first run and then hourly.`,
    };
  }
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
  if (nowMs - lastSuccessMs <= DRIFT_READ_STALE_AFTER_MS) {
    // Still evidence, so the verdict stands; but the newest attempt failed,
    // and the reader is told so rather than shown a good read as current
    // (CodeRabbit, #1054). `lastError` is cleared by every successful read.
    if (!drift.lastError) return verdict;
    return {
      ...verdict,
      summary: `${verdict.summary} The latest read of main failed (${drift.lastError}); this is from the read ${agoText(drift.lastSuccessAt, nowMs)}.`,
    };
  }
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

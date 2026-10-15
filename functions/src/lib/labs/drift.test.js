/**
 * Whether the lab host runs main (#1009; the drift half of LAB-4, #950).
 *
 * The load-bearing assertions: a host behind main for more than a day is
 * critical and names what it lacks; a host that never reported is critical,
 * not "unknown"; a read of main that went stale or never covered the host's
 * commit cannot vouch for "nothing new"; GitHub is asked for exactly the two
 * host paths on main, from the oldest applied commit, at most hourly; and a
 * failed read is recorded, never thrown, never logged with a sha or a path.
 */
import { describe, it, expect, vi } from 'vitest';

import { RepoSourceError } from '../cms/repo-draft-source.js';
import {
  COMMITS_PER_PATH,
  DRIFT_LAG_LIMIT_MS,
  DRIFT_READ_INTERVAL_MS,
  DRIFT_READ_STALE_AFTER_MS,
  HOST_PATHS,
  LAB_DRIFT_DOC_ID,
  agoText,
  appliedOf,
  createMainHistoryReader,
  labDriftVerdict,
  pendingCommits,
  readSince,
  refreshDriftRecord,
} from './drift.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const nowMs = NOW.getTime();
const hoursAgo = (h) => new Date(nowMs - h * 60 * 60 * 1000).toISOString();
const sha = (c) => c.repeat(40);

const APPLIED = { commit: sha('a'), committedAt: hoursAgo(72), appliedAt: hoursAgo(48) };
const agent = (over = {}) => ({ id: 'vps-hostinger-01', active: true, applied: APPLIED, ...over });
const commit = (c, hours, title = `change ${c}`) => ({ sha: sha(c), committedAt: hoursAgo(hours), title });
const drift = (over = {}) => ({
  id: LAB_DRIFT_DOC_ID,
  since: APPLIED.committedAt,
  hostCommits: [],
  lastSuccessAt: hoursAgo(1),
  lastAttemptAt: hoursAgo(1),
  lastError: null,
  truncated: false,
  ...over,
});

describe('labDriftVerdict', () => {
  it('is healthy when nothing under lab-host/ or vps-agent/ merged after the applied commit', () => {
    const verdict = labDriftVerdict({ agents: [agent()], drift: drift({ hostCommits: [commit('a', 72)] }), nowMs });
    expect(verdict.status).toBe('healthy');
    expect(verdict.summary).toBe(
      'vps-hostinger-01 converged from aaaaaaaa 2 d ago; nothing under lab-host/ or vps-agent/ has merged to main since.'
    );
    expect(verdict.agents['vps-hostinger-01'].status).toBe('healthy');
  });

  it('is critical once the oldest unapplied change merged more than a day ago, and names it', () => {
    const verdict = labDriftVerdict({
      agents: [agent()],
      drift: drift({ hostCommits: [commit('c', 2), commit('b', 30), commit('a', 72)] }),
      nowMs,
    });
    expect(verdict.status).toBe('critical');
    expect(verdict.summary).toBe(
      'vps-hostinger-01 is behind main: 2 changes under lab-host/ or vps-agent/ merged after aaaaaaaa, the oldest 30 h ago. Run bootstrap.sh on the lab host.'
    );
    // Oldest first, so the line the owner reads first is the one that has waited longest.
    expect(verdict.detail.split('\n')[0]).toBe(`bbbbbbbb ${hoursAgo(30)} change b`);
  });

  it('tolerates a change merged within the day, and says when it will be raised', () => {
    const verdict = labDriftVerdict({ agents: [agent()], drift: drift({ hostCommits: [commit('b', 5)] }), nowMs });
    expect(verdict.status).toBe('healthy');
    expect(verdict.summary).toMatch(/1 change merged since 5 h ago, raised if still not applied a day after merging\.$/);
  });

  it('turns critical exactly past the limit', () => {
    const justUnder = new Date(nowMs - DRIFT_LAG_LIMIT_MS + 60_000).toISOString();
    const justOver = new Date(nowMs - DRIFT_LAG_LIMIT_MS - 60_000).toISOString();
    const at = (committedAt) =>
      labDriftVerdict({
        agents: [agent()],
        drift: drift({ hostCommits: [{ sha: sha('b'), committedAt, title: '' }] }),
        nowMs,
      }).status;
    expect(at(justUnder)).toBe('healthy');
    expect(at(justOver)).toBe('critical');
  });

  it('says "at least" when the read of main was cut short', () => {
    const verdict = labDriftVerdict({
      agents: [agent()],
      drift: drift({ hostCommits: [commit('b', 30)], truncated: true }),
      nowMs,
    });
    expect(verdict.summary).toContain('at least 1 change under lab-host/');
  });

  it('is critical, not unknown, for an active agent that never reported a commit', () => {
    const verdict = labDriftVerdict({ agents: [agent({ applied: undefined })], drift: drift(), nowMs });
    expect(verdict.status).toBe('critical');
    expect(verdict.summary).toMatch(/has not reported the commit it converged from/);
    expect(verdict.summary).toMatch(/\/etc\/hcw\/applied-commit\.json/);
  });

  it('is critical for a host that never reported even before main has been read', () => {
    expect(labDriftVerdict({ agents: [agent({ applied: null })], drift: null, nowMs }).status).toBe('critical');
  });

  it('is unknown when main has not been read yet, and says so differently when the read failed', () => {
    const unread = labDriftVerdict({ agents: [agent()], drift: null, nowMs });
    expect(unread.status).toBe('unknown');
    expect(unread.summary).toMatch(/; main has not been read yet\. checkAgentHealth reads it on its first run and then hourly\.$/);

    const failed = labDriftVerdict({
      agents: [agent()],
      drift: { lastError: 'RATE_LIMITED: used up', lastSuccessAt: null },
      nowMs,
    });
    expect(failed.status).toBe('unknown');
    expect(failed.summary).toMatch(
      /; main could not be read \(RATE_LIMITED: used up\)\. checkAgentHealth tries again hourly, and this clears only once a read succeeds\.$/
    );
    expect(failed.summary).not.toContain('has not been read yet');
  });

  it('is unknown when the last read started after the host’s commit, so it cannot see what is between', () => {
    const verdict = labDriftVerdict({ agents: [agent()], drift: drift({ since: hoursAgo(10) }), nowMs });
    expect(verdict.status).toBe('unknown');
    expect(verdict.summary).toMatch(/the next hourly read covers it/);
  });

  it('cannot vouch for "nothing new" from a stale read, but a lag it already shows stands', () => {
    const stale = hoursAgo(DRIFT_READ_STALE_AFTER_MS / 3_600_000 + 1);
    const quiet = labDriftVerdict({
      agents: [agent()],
      drift: drift({ lastSuccessAt: stale, lastError: 'TIMEOUT: GitHub did not answer within 8000 ms.' }),
      nowMs,
    });
    expect(quiet.status).toBe('unknown');
    expect(quiet.summary).toMatch(/Main was last read 7 h ago \(TIMEOUT: GitHub did not answer within 8000 ms\.\)\. Newer changes may be missing\.$/);

    const behind = labDriftVerdict({
      agents: [agent()],
      drift: drift({ lastSuccessAt: stale, hostCommits: [commit('b', 40)] }),
      nowMs,
    });
    expect(behind.status).toBe('critical');
    expect(behind.summary).toMatch(/Main was last read 7 h ago\.$/);
  });

  it('keeps a fresh read’s verdict when the newest read failed, and says the newest one failed', () => {
    const quiet = labDriftVerdict({
      agents: [agent()],
      drift: drift({ lastSuccessAt: hoursAgo(2), lastError: 'TIMEOUT: GitHub did not answer within 8000 ms.' }),
      nowMs,
    });
    expect(quiet.status).toBe('healthy');
    expect(quiet.summary).toMatch(
      /The latest read of main failed \(TIMEOUT: GitHub did not answer within 8000 ms\.\); this is from the read 2 h ago\.$/
    );

    const behind = labDriftVerdict({
      agents: [agent()],
      drift: drift({ lastSuccessAt: hoursAgo(2), lastError: 'RATE_LIMITED: used up', hostCommits: [commit('b', 40)] }),
      nowMs,
    });
    expect(behind.status).toBe('critical');
    expect(behind.summary).toMatch(/The latest read of main failed \(RATE_LIMITED: used up\)/);

    // A successful read clears lastError, and then nothing is added.
    expect(labDriftVerdict({ agents: [agent()], drift: drift(), nowMs }).summary).not.toMatch(/latest read/);
  });

  it('judges active agents only, and says so when there are none', () => {
    const verdict = labDriftVerdict({ agents: [agent({ active: false, applied: null })], drift: drift(), nowMs });
    expect(verdict).toEqual({
      status: 'unknown',
      summary: 'No active lab agent is registered, so there is no host to compare with main.',
      detail: null,
      agents: {},
    });
  });

  it('leads with the worst agent and keeps the others in the detail and by id', () => {
    const verdict = labDriftVerdict({
      agents: [agent({ id: 'fine' }), agent({ id: 'silent', applied: null })],
      drift: drift(),
      nowMs,
    });
    expect(verdict.status).toBe('critical');
    expect(verdict.summary).toMatch(/^silent has not reported/);
    expect(verdict.detail).toMatch(/^fine converged from aaaaaaaa/);
    expect(Object.keys(verdict.agents).sort()).toEqual(['fine', 'silent']);
  });
});

describe('the pieces', () => {
  it('pendingCommits keeps commits after the applied one, oldest first, never the applied one itself', () => {
    const pending = pendingCommits(APPLIED, {
      hostCommits: [commit('c', 1), { ...commit('a', 0), sha: APPLIED.commit }, commit('b', 2), commit('z', 100)],
    });
    expect(pending.map((c) => c.sha[0])).toEqual(['b', 'c']);
  });

  it('appliedOf accepts only a whole record', () => {
    expect(appliedOf(agent())).toBe(APPLIED);
    expect(appliedOf(agent({ applied: { ...APPLIED, commit: 'abc' } }))).toBeNull();
    expect(appliedOf(agent({ applied: { ...APPLIED, appliedAt: 'yesterday' } }))).toBeNull();
    expect(appliedOf({})).toBeNull();
  });

  it('readSince is the oldest commit an active agent converged from, or null', () => {
    const older = { ...APPLIED, committedAt: hoursAgo(100) };
    expect(
      readSince([agent(), agent({ id: 'b', applied: older }), agent({ id: 'off', active: false, applied: { ...APPLIED, committedAt: hoursAgo(500) } })])
    ).toBe(older.committedAt);
    expect(readSince([agent({ applied: null })])).toBeNull();
    expect(readSince(null)).toBeNull();
  });

  it('agoText says ages in the pulse’s words', () => {
    expect(agoText(hoursAgo(0), nowMs)).toBe('just now');
    expect(agoText(hoursAgo(0.5), nowMs)).toBe('30 min ago');
    expect(agoText(hoursAgo(5), nowMs)).toBe('5 h ago');
    expect(agoText(hoursAgo(72), nowMs)).toBe('3 d ago');
    expect(agoText('nonsense', nowMs)).toBe('at an unknown time');
  });
});

/** A fetch that answers GitHub's commit list for each path from `byPath`. */
function githubFetch(byPath, { status = 200, headers = {} } = {}) {
  const calls = [];
  const impl = vi.fn(async (url) => {
    calls.push(url);
    const path = new URL(url).searchParams.get('path');
    const body = JSON.stringify(byPath[path] ?? []);
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      body: null,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  });
  return { impl, calls };
}

const row = (c, date, message = `Change ${c}\n\nbody`) => ({
  sha: sha(c),
  commit: { committer: { date }, message },
});

describe('createMainHistoryReader', () => {
  it('asks GitHub for main’s commits under each host path, from the given time, and nothing else', async () => {
    const { impl, calls } = githubFetch({
      'lab-host': [row('c', '2026-10-10T10:00:00Z'), row('b', '2026-10-09T10:00:00Z')],
      'vps-agent': [row('c', '2026-10-10T10:00:00Z'), row('d', '2026-10-08T10:00:00Z')],
    });
    const reader = createMainHistoryReader({ fetch: impl });
    const { commits, truncated } = await reader.hostCommits('2026-10-07T00:00:00.000Z');

    expect(calls).toHaveLength(HOST_PATHS.length);
    for (const [i, path] of HOST_PATHS.entries()) {
      const url = new URL(calls[i]);
      expect(url.origin).toBe('https://api.github.com');
      expect(url.pathname).toBe('/repos/saulpatinojr/HCW-HybridCloudWorks/commits');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        sha: 'main',
        path,
        per_page: String(COMMITS_PER_PATH),
        since: '2026-10-07T00:00:00.000Z',
      });
    }
    // One row per sha, newest first, the title only, dates normalised.
    expect(commits).toEqual([
      { sha: sha('c'), committedAt: '2026-10-10T10:00:00.000Z', title: 'Change c' },
      { sha: sha('b'), committedAt: '2026-10-09T10:00:00.000Z', title: 'Change b' },
      { sha: sha('d'), committedAt: '2026-10-08T10:00:00.000Z', title: 'Change d' },
    ]);
    expect(truncated).toBe(false);
    // No credential travels: the repository is public.
    expect(impl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect(impl.mock.calls[0][1].redirect).toBe('error');
  });

  it('asks without `since` when no host has reported, and marks a full page as truncated', async () => {
    const full = Array.from({ length: COMMITS_PER_PATH }, (_, i) =>
      row(i.toString(16).padStart(1, '0').slice(-1), `2026-10-0${(i % 9) + 1}T00:00:00Z`)
    );
    const { impl, calls } = githubFetch({ 'lab-host': full });
    const { truncated } = await createMainHistoryReader({ fetch: impl }).hostCommits(null);
    expect(new URL(calls[0]).searchParams.has('since')).toBe(false);
    expect(truncated).toBe(true);
  });

  it('drops rows that are not commits rather than guessing', async () => {
    const { impl } = githubFetch({
      'lab-host': [{ sha: 'short', commit: { committer: { date: '2026-10-10T00:00:00Z' } } }, { sha: sha('e') }, row('f', '2026-10-10T00:00:00Z')],
    });
    const { commits } = await createMainHistoryReader({ fetch: impl }).hostCommits(null);
    expect(commits.map((c) => c.sha)).toEqual([sha('f')]);
  });

  it('throws GitHub’s rate limit as a coded error', async () => {
    const { impl } = githubFetch({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791633600' } });
    await expect(createMainHistoryReader({ fetch: impl }).hostCommits(null)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

/** An admin_config store with an ETag'd document, the cosmos-client contract. */
function driftStore(initial = null) {
  let doc = initial ? { ...initial, _etag: 'e1' } : null;
  return {
    get doc() {
      return doc;
    },
    readDoc: vi.fn(async () => doc),
    createDoc: vi.fn(async (_c, next) => {
      if (doc) throw Object.assign(new Error('exists'), { code: 409 });
      doc = { ...next, _etag: 'e1' };
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (_c, next) => {
      if (next._etag !== doc?._etag) throw Object.assign(new Error('changed'), { code: 412 });
      doc = { ...next, _etag: `${doc._etag}+` };
      return doc;
    }),
  };
}

describe('refreshDriftRecord', () => {
  const reader = (commits = [commit('b', 3)], truncated = false) => ({
    hostCommits: vi.fn(async () => ({ commits, truncated })),
  });

  it('creates the record on the first read, from the oldest applied commit', async () => {
    const store = driftStore();
    const r = reader();
    const outcome = await refreshDriftRecord({ store, reader: r, agents: [agent()], now: () => NOW });
    expect(outcome).toEqual({ read: true, ok: true, written: true });
    expect(r.hostCommits).toHaveBeenCalledWith(APPLIED.committedAt);
    expect(store.doc).toMatchObject({
      id: LAB_DRIFT_DOC_ID,
      configScope: 'admin_config',
      docType: 'lab_drift',
      paths: ['lab-host', 'vps-agent'],
      since: APPLIED.committedAt,
      hostCommits: [commit('b', 3)],
      truncated: false,
      lastAttemptAt: NOW.toISOString(),
      lastSuccessAt: NOW.toISOString(),
      lastError: null,
    });
  });

  it('reads at most once an interval', async () => {
    const store = driftStore(drift({ lastAttemptAt: new Date(nowMs - DRIFT_READ_INTERVAL_MS + 1000).toISOString() }));
    const r = reader();
    expect(await refreshDriftRecord({ store, reader: r, agents: [agent()], now: () => NOW })).toEqual({ read: false });
    expect(r.hostCommits).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('replaces the record under the ETag it read', async () => {
    const store = driftStore(drift({ lastAttemptAt: hoursAgo(2) }));
    await refreshDriftRecord({ store, reader: reader(), agents: [agent()], now: () => NOW });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch.mock.calls[0][1]._etag).toBe('e1');
    expect(store.replaceDocIfMatch.mock.calls[0][2]).toEqual({ partitionKey: 'admin_config' });
  });

  it('records a failed read with its reason, keeps the last good list, and logs only the code', async () => {
    const kept = [commit('b', 30)];
    const store = driftStore(drift({ lastAttemptAt: hoursAgo(2), lastSuccessAt: hoursAgo(2), hostCommits: kept }));
    const failing = {
      hostCommits: vi.fn(async () => {
        // fetchPinned's shape: a coded RepoSourceError, written in this repository.
        throw new RepoSourceError("GitHub's unauthenticated rate limit is used up.", { code: 'RATE_LIMITED' });
      }),
    };
    const log = { warn: vi.fn() };
    const outcome = await refreshDriftRecord({ store, reader: failing, agents: [agent()], now: () => NOW, log });
    expect(outcome).toEqual({ read: true, ok: false, written: true });
    expect(store.doc).toMatchObject({
      hostCommits: kept,
      lastSuccessAt: hoursAgo(2),
      lastAttemptAt: NOW.toISOString(),
      lastError: "RATE_LIMITED: GitHub's unauthenticated rate limit is used up.",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "[checkAgentHealth] main's lab-host history could not be read (RATE_LIMITED); the drift check keeps its last read"
    );
    const line = log.warn.mock.calls[0][0];
    expect(line).not.toContain(APPLIED.commit);
    expect(line).not.toContain(LAB_DRIFT_DOC_ID);
  });

  it("stores a socket's failure as a sentence with its code, never the socket's words (#945)", async () => {
    const store = driftStore(drift({ lastAttemptAt: hoursAgo(2) }));
    const failing = {
      hostCommits: vi.fn(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 140.82.112.6:443'), { code: 'ECONNREFUSED' });
      }),
    };
    await refreshDriftRecord({ store, reader: failing, agents: [agent()], now: () => NOW, log: { warn: vi.fn() } });
    expect(store.doc.lastError).toBe("main's lab-host history could not be read (ECONNREFUSED).");
  });

  it('leaves the record to whoever wrote it in between', async () => {
    const store = driftStore(drift({ lastAttemptAt: hoursAgo(2) }));
    store.replaceDocIfMatch.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 412 }));
    expect(await refreshDriftRecord({ store, reader: reader(), agents: [agent()], now: () => NOW })).toEqual({
      read: true,
      ok: true,
      written: false,
    });
  });

  it('throws a store failure that is not a lost race, for its caller to log', async () => {
    const store = driftStore();
    store.createDoc.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 503 }));
    await expect(
      refreshDriftRecord({ store, reader: reader(), agents: [agent()], now: () => NOW })
    ).rejects.toMatchObject({ code: 503 });
  });
});

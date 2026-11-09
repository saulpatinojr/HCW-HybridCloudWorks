/**
 * Drift detection, at the boundaries that decide whether it is worth having.
 *
 * The two incidents this exists to catch were one commit and thirty-five, so
 * the interesting assertions are about AGE and about what counts as a commit at
 * all — not about the happy path, which is a table render.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  SERVICES,
  DEFAULT_THRESHOLD_HOURS,
  parseRunIds,
  baselineOf,
  lastSuccessfulRun,
  RUNS_PER_PAGE,
  MAX_RUN_PAGES,
  parseLastAppliedRun,
  missingTfcTokenMessage,
  parseCommitDate,
  oldestCommit,
  ageHours,
  isStale,
  formatReport,
  driftFor,
  COMMITS_PER_PAGE,
  cell,
} from './check-deploy-drift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'monitor-deploy-drift.yml');

const NOW = Date.parse('2026-09-01T04:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const commit = (sha, date, message = 'a change') => ({
  sha,
  commit: { committer: { date }, message },
});

/**
 * One HCP Terraform runs document, in the JSON:API shape
 * `/workspaces/:id/runs?include=configuration_version.ingress_attributes`
 * answers: the run points at a configuration version, the configuration
 * version points at ingress attributes, both resolved through `included`.
 * Same fixtures as check-tfc-plan.test.mjs, because it is the same walk.
 */
const APPLIED_SHA = 'deadbeef'.repeat(5);
const appliedRun = ({ id = 'run-applied', status = 'applied', cvId = 'cv-1', appliedAt = hoursAgo(60) } = {}) => ({
  id,
  type: 'runs',
  attributes: { status, 'status-timestamps': { 'applied-at': appliedAt } },
  relationships: cvId
    ? { 'configuration-version': { data: { id: cvId, type: 'configuration-versions' } } }
    : {},
});
const cvFor = (id, iaId) => ({
  id,
  type: 'configuration-versions',
  relationships: iaId ? { 'ingress-attributes': { data: { id: iaId, type: 'ingress-attributes' } } } : {},
});
const iaFor = (id, sha) => ({ id, type: 'ingress-attributes', attributes: { 'commit-sha': sha } });
const runsDocument = ({ run = appliedRun(), sha = APPLIED_SHA, included } = {}) => ({
  data: run ? [run] : [],
  included: included ?? [cvFor('cv-1', 'ia-1'), iaFor('ia-1', sha)],
});

describe('parseRunIds', () => {
  it('reads the ids a listing page names, in the order it names them', () => {
    expect(parseRunIds({ workflow_runs: [{ id: 9, conclusion: 'failure' }, { id: 7 }] })).toEqual([9, 7]);
  });

  it('is empty for a workflow with no runs — a fact, not an error', () => {
    expect(parseRunIds({ workflow_runs: [] })).toEqual([]);
  });

  it('throws on a shape it cannot read, rather than reporting it as no runs', () => {
    expect(() => parseRunIds({})).toThrow(/workflow_runs/);
    expect(() => parseRunIds(null)).toThrow(/workflow_runs/);
    expect(() => parseRunIds({ workflow_runs: [{}] })).toThrow(/`id`/);
    expect(() => parseRunIds({ workflow_runs: [{ id: 'later' }] })).toThrow(/`id`/);
  });
});

describe('baselineOf', () => {
  const success = {
    id: 9,
    status: 'completed',
    conclusion: 'success',
    head_sha: 'abc123',
    run_number: 82,
    created_at: hoursAgo(3),
  };

  it('reads the head sha of a run whose record says completed and success', () => {
    expect(baselineOf(success)).toEqual({ sha: 'abc123', runNumber: 82, at: hoursAgo(3) });
  });

  it('is null for a run that did not deploy, whatever the listing said of it', () => {
    expect(baselineOf({ ...success, conclusion: 'failure' })).toBe(null);
    expect(baselineOf({ ...success, conclusion: 'cancelled' })).toBe(null);
    expect(baselineOf({ ...success, status: 'in_progress', conclusion: null })).toBe(null);
    // "Re-run jobs" takes a completed run back to in_progress under the same
    // id, so the status is read as well as the conclusion.
    expect(baselineOf({ ...success, status: 'in_progress' })).toBe(null);
    expect(baselineOf({ ...success, status: 'queued', conclusion: null })).toBe(null);
  });

  it('throws on a record it cannot read, rather than reading it as a run that did not deploy', () => {
    // A payload with no status is not a run record, and a completed run has
    // a conclusion. Null here would reach the ❌ "never deployed" row; a
    // throw reaches the ⚠️ "could not read" row, which is the honest one.
    expect(() => baselineOf(null)).toThrow(/no `status`/);
    expect(() => baselineOf({})).toThrow(/no `status`/);
    expect(() => baselineOf({ ...success, status: undefined })).toThrow(/no `status`/);
    expect(() => baselineOf({ ...success, status: '' })).toThrow(/no `status`/);
    expect(() => baselineOf({ ...success, conclusion: null })).toThrow(/no `conclusion`/);
    expect(() => baselineOf({ ...success, conclusion: undefined })).toThrow(/no `conclusion`/);
    expect(() => baselineOf({ ...success, conclusion: '' })).toThrow(/no `conclusion`/);
  });

  it('throws on a successful run with no head_sha, rather than skipping to an older one', () => {
    expect(() => baselineOf({ ...success, head_sha: '' })).toThrow(/head_sha/);
    expect(() => baselineOf({ ...success, head_sha: undefined })).toThrow(/head_sha/);
  });
});

/**
 * The read that replaced `runs?status=success&per_page=1` (#1564). The
 * fakes answer by path, the way GitHub did on 2026-11-05: the filtered
 * listing is a search that lags the run, the unfiltered listing names every
 * id, and the run by id is the truth.
 */
describe('lastSuccessfulRun', () => {
  const record = (
    id,
    { status = 'completed', conclusion = 'success', sha = `sha-${id}`, at = hoursAgo(100 - id) } = {}
  ) => ({ id, status, conclusion, head_sha: sha, run_number: id, created_at: at, run_started_at: at });

  /** A fake API: the listing pages, the runs by id, and what was asked. */
  const api = ({ pages, runs, stale }) => {
    const asked = [];
    const read = async (path) => {
      asked.push(path);
      if (path.includes('status=success')) return { workflow_runs: stale ?? [] };
      const page = path.match(/[?&]page=(\d+)/);
      if (page) return { workflow_runs: (pages[Number(page[1]) - 1] ?? []).map((id) => ({ id })) };
      const id = path.match(/\/actions\/runs\/(\d+)$/);
      if (id && runs[id[1]]) return runs[id[1]];
      throw new Error(`unstubbed: ${path}`);
    };
    return { read, asked };
  };

  it('takes the newest success by its own record, not the one a stale status=success listing names', async () => {
    // The newest run, 9, finished a minute ago and the search has not caught
    // up: the filtered listing still answers the run before it. The old read
    // would have measured drift against run 7 and called the just-deployed
    // commit one commit of drift.
    const { read, asked } = api({
      pages: [[9, 7, 5]],
      runs: { 9: record(9), 7: record(7), 5: record(5, { conclusion: 'failure' }) },
      stale: [{ id: 7, head_sha: 'sha-7', conclusion: 'success' }],
    });
    const out = await lastSuccessfulRun('deploy-functions.yml', read);
    expect(out.sha).toBe('sha-9');
    expect(out.runNumber).toBe(9);
    expect(asked.some((path) => path.includes('status='))).toBe(false);
    expect(asked[0]).toBe(`/actions/workflows/deploy-functions.yml/runs?per_page=${RUNS_PER_PAGE}&page=1`);
    expect(asked).toContain('/actions/runs/9');
  });

  it('finds the success when the stale listing answers nothing at all', async () => {
    const { read } = api({ pages: [[9]], runs: { 9: record(9) }, stale: [] });
    expect((await lastSuccessfulRun('w.yml', read)).sha).toBe('sha-9');
  });

  it('ignores the status and conclusion the listing carries, which can lag the run', async () => {
    // The listing shows run 9 as queued; its record says it completed.
    const read = async (path) => {
      if (path.includes('page=1')) return { workflow_runs: [{ id: 9, status: 'queued', conclusion: null }] };
      if (path.endsWith('/actions/runs/9')) return record(9);
      throw new Error(`unstubbed: ${path}`);
    };
    expect((await lastSuccessfulRun('w.yml', read)).sha).toBe('sha-9');
  });

  it('passes over a newer run that is still going, or failed, to the newest that deployed', async () => {
    const { read } = api({
      pages: [[11, 9, 7]],
      runs: {
        11: record(11, { status: 'in_progress', conclusion: null }),
        9: record(9, { conclusion: 'failure' }),
        7: record(7),
      },
    });
    expect((await lastSuccessfulRun('w.yml', read)).sha).toBe('sha-7');
  });

  it('orders by the records, not by the listing', async () => {
    // "Re-run jobs" keeps an older run's id, place in the listing and
    // created_at, and moves its run_started_at; the listing order is not the
    // deploy order.
    const { read } = api({
      pages: [[9, 7]],
      runs: {
        9: record(9, { at: hoursAgo(10) }),
        7: { ...record(7, { at: hoursAgo(20) }), run_started_at: hoursAgo(1) },
      },
    });
    expect((await lastSuccessfulRun('w.yml', read)).sha).toBe('sha-7');
  });

  it('is null for a workflow that has never run — a fact, not an error', async () => {
    const { read } = api({ pages: [[]], runs: {} });
    expect(await lastSuccessfulRun('w.yml', read)).toBe(null);
  });

  it('is null when the whole history was read and nothing in it succeeded', async () => {
    const { read } = api({
      pages: [[9, 7]],
      runs: { 9: record(9, { conclusion: 'failure' }), 7: record(7, { conclusion: 'cancelled' }) },
    });
    expect(await lastSuccessfulRun('w.yml', read)).toBe(null);
  });

  it('reads the next page when a full page holds no success', async () => {
    const first = Array.from({ length: RUNS_PER_PAGE }, (_, i) => 100 + i);
    const runs = Object.fromEntries(first.map((id) => [id, record(id, { conclusion: 'failure' })]));
    runs[7] = record(7);
    const { read, asked } = api({ pages: [first, [7]], runs });
    expect((await lastSuccessfulRun('w.yml', read)).sha).toBe('sha-7');
    expect(asked.filter((path) => path.includes('&page=')).length).toBe(2);
  });

  it('throws, rather than calling it never deployed, when the page cap is reached without a success', async () => {
    // A hundred failures in a row and older runs unread: "never deployed"
    // and "has not deployed lately" cannot be told apart from here, and the
    // row renders ⚠️ with the reason instead of ❌ on a guess.
    const ids = Array.from({ length: RUNS_PER_PAGE }, (_, i) => 100 + i);
    const pages = Array.from({ length: MAX_RUN_PAGES }, () => ids);
    const runs = Object.fromEntries(ids.map((id) => [id, record(id, { conclusion: 'failure' })]));
    await expect(lastSuccessfulRun('w.yml', api({ pages, runs }).read)).rejects.toThrow(
      new RegExp(`newest ${MAX_RUN_PAGES * RUNS_PER_PAGE} runs`)
    );
  });

  it('throws on a listing it cannot read, rather than reading it as never deployed', async () => {
    await expect(lastSuccessfulRun('w.yml', async () => ({}))).rejects.toThrow(/workflow_runs/);
  });

  it('throws when the only listed run has no status, rather than calling the workflow never deployed', async () => {
    const { read } = api({ pages: [[9]], runs: { 9: { id: 9, head_sha: 'sha-9' } } });
    await expect(lastSuccessfulRun('w.yml', read)).rejects.toThrow(/Run 9 came back with no `status`/);
  });

  it('throws when a completed run has no conclusion', async () => {
    const { read } = api({ pages: [[9]], runs: { 9: record(9, { conclusion: null }) } });
    await expect(lastSuccessfulRun('w.yml', read)).rejects.toThrow(/Run 9 is `completed` with no `conclusion`/);
  });
});

describe('parseLastAppliedRun', () => {
  it("reads the ingress commit, run id and applied-at of the newest applied run", () => {
    const out = parseLastAppliedRun(runsDocument({ run: appliedRun({ appliedAt: '2026-08-30T01:21:00Z' }) }));
    expect(out).toEqual({ sha: APPLIED_SHA, runId: 'run-applied', at: '2026-08-30T01:21:00Z' });
  });

  it('lower-cases the sha, so a differently-cased apply is not counted as one commit of drift', () => {
    const out = parseLastAppliedRun(runsDocument({ sha: APPLIED_SHA.toUpperCase() }));
    expect(out.sha).toBe(APPLIED_SHA);
  });

  it('returns null for a workspace that has never applied — a fact, not an error', () => {
    expect(parseLastAppliedRun({ data: [] })).toBe(null);
  });

  it('throws on a shape it cannot read, rather than reporting it as never-applied', () => {
    expect(() => parseLastAppliedRun({})).toThrow(/`data` array/);
    expect(() => parseLastAppliedRun(null)).toThrow(/`data` array/);
    expect(() => parseLastAppliedRun({ data: [appliedRun()] })).toThrow(/`included` section/);
  });

  // The filter is checked, not trusted. If HCP Terraform ignored or renamed
  // `filter[status]`, the newest run of ANY kind would come back — a plan
  // awaiting confirmation, say — and its commit would read as applied: the
  // reopened defect, arriving by a different door.
  it('refuses a newest run that is not applied, however it was listed', () => {
    expect(() => parseLastAppliedRun(runsDocument({ run: appliedRun({ status: 'planned' }) }))).toThrow(
      /in state "planned" under filter\[status\]=applied/
    );
    // null, not undefined: undefined would take the fixture's default.
    expect(() => parseLastAppliedRun(runsDocument({ run: appliedRun({ status: null }) }))).toThrow(
      /in state "unknown"/
    );
  });

  // An apply from an API-uploaded configuration IS the newest apply, and
  // nothing on main can be compared with it. That is an answer this row
  // cannot give, not zero drift.
  it('throws on an applied run with no VCS commit, rather than skipping to an older one', () => {
    expect(() => parseLastAppliedRun(runsDocument({ run: appliedRun({ cvId: null }) }))).toThrow(
      /carries no VCS commit/
    );
    expect(() =>
      parseLastAppliedRun(runsDocument({ included: [cvFor('cv-1', null)] }))
    ).toThrow(/carries no VCS commit/);
  });

  // The walk is check-tfc-plan.mjs's, so its absent-versus-dangling rule
  // holds here: a referenced resource missing from `included` is a payload
  // that did not carry what was asked for.
  it('throws when the configuration version or ingress attributes are referenced but not included', () => {
    expect(() => parseLastAppliedRun(runsDocument({ included: [] }))).toThrow(/did not include it/);
    expect(() => parseLastAppliedRun(runsDocument({ included: [cvFor('cv-1', 'ia-1')] }))).toThrow(
      /did not include it/
    );
  });

  it('throws when the ingress attributes carry no string sha', () => {
    expect(() =>
      parseLastAppliedRun(
        runsDocument({ included: [cvFor('cv-1', 'ia-1'), { id: 'ia-1', type: 'ingress-attributes', attributes: {} }] })
      )
    ).toThrow(/no string commit-sha/);
  });
});

describe('missingTfcTokenMessage', () => {
  it('names the secret, the workspace and where to seed it', () => {
    const message = missingTfcTokenMessage();
    expect(message).toContain('TFC_TOKEN is not set');
    expect(message).toContain('hcw/hcw-azure');
    expect(message).toContain('repository secret');
    expect(message).toContain('#963');
  });
});

describe('parseCommitDate', () => {
  it('prefers the committer date and falls back to the author date', () => {
    expect(parseCommitDate({ commit: { committer: { date: 'A' }, author: { date: 'B' } } })).toBe(
      'A'
    );
    expect(parseCommitDate({ commit: { author: { date: 'B' } } })).toBe('B');
  });

  it('throws when neither is present', () => {
    expect(() => parseCommitDate({ commit: {} })).toThrow(/date/);
  });
});

describe('oldestCommit', () => {
  // THE ASSERTION THIS FILE EXISTS FOR. Getting this wrong reports how recently
  // someone merged instead of how long the drift has lasted — which reads as
  // healthy immediately after the merge that created it, exactly backwards.
  it('picks the oldest by date', () => {
    const out = oldestCommit([
      commit('new', hoursAgo(1), 'newest'),
      commit('mid', hoursAgo(30), 'middle'),
      commit('old', hoursAgo(50), 'oldest'),
    ]);
    expect(out.sha).toBe('old');
    expect(out.message).toBe('oldest');
  });

  // The first version took the last element, on the true-but-narrow grounds
  // that GitHub returns newest first. driftFor merges one list per declared
  // path, so the merged array is newest-first only within each segment — with
  // two paths the last element is the SECOND path's oldest, which can be far
  // newer. Found in review; the fix was to stop assuming order at all.
  it('does not care what order the list is in', () => {
    const rows = [
      commit('mid', hoursAgo(30), 'middle'),
      commit('old', hoursAgo(50), 'oldest'),
      commit('new', hoursAgo(1), 'newest'),
    ];
    expect(oldestCommit(rows).sha).toBe('old');
    expect(oldestCommit([...rows].reverse()).sha).toBe('old');
  });

  it('skips undated commits rather than treating them as epoch zero', () => {
    // Date.parse(undefined) is NaN; a naive min would make it 1970 and report
    // fifty-five years of drift.
    const out = oldestCommit([{ sha: 'undated', commit: { message: 'no date' } }, commit('old', hoursAgo(9), 'real')]);
    expect(out.sha).toBe('old');
    expect(out.message).toBe('real');
  });

  it('is null when nothing in the list has a date', () => {
    expect(oldestCommit([{ sha: 'a', commit: { message: 'x' } }])).toBe(null);
  });

  it('takes only the first line of the message', () => {
    expect(oldestCommit([commit('a', hoursAgo(1), 'subject\n\nbody')]).message).toBe('subject');
  });

  it('is null for nothing', () => {
    expect(oldestCommit([])).toBe(null);
    expect(oldestCommit(undefined)).toBe(null);
  });
});

describe('ageHours', () => {
  it('floors to whole hours', () => {
    expect(ageHours(hoursAgo(2), NOW)).toBe(2);
    expect(ageHours(new Date(NOW - 2.9 * 3_600_000).toISOString(), NOW)).toBe(2);
  });

  it('never goes negative for a commit dated in the future', () => {
    // Clock skew between the runner and GitHub is real and a negative age would
    // render as a healthy service.
    expect(ageHours(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(0);
  });

  it('throws on a value that is not a date', () => {
    expect(() => ageHours('not-a-date', NOW)).toThrow();
  });
});

describe('isStale', () => {
  it('fires AT the threshold, not after it', () => {
    expect(isStale(24, 24)).toBe(true);
    expect(isStale(23, 24)).toBe(false);
    expect(isStale(25, 24)).toBe(true);
  });
});

describe('formatReport', () => {
  it('passes a service that is behind but inside the threshold', () => {
    const { failed, text } = formatReport(
      [{ name: 'Function App', count: 1, oldest: { message: 'x' }, hours: 3 }],
      DEFAULT_THRESHOLD_HOURS
    );
    expect(failed).toBe(false);
    expect(text).toContain('✅');
  });

  // The manifest 404: ONE commit, two days old. A count-based check cannot
  // distinguish this from an ordinary merge; an age-based one does.
  it('fails one commit that is older than the threshold', () => {
    const { failed, text } = formatReport(
      [{ name: 'Function App', count: 1, oldest: { message: 'add the route' }, hours: 49 }],
      DEFAULT_THRESHOLD_HOURS
    );
    expect(failed).toBe(true);
    expect(text).toContain('49h');
  });

  it('passes thirty-five commits merged in the last hour', () => {
    const { failed } = formatReport(
      [{ name: 'Static Web App', count: 35, oldest: { message: 'x' }, hours: 0 }],
      DEFAULT_THRESHOLD_HOURS
    );
    expect(failed).toBe(false);
  });

  it('fails a service that has never deployed', () => {
    const { failed, text } = formatReport([{ name: 'X', neverDeployed: true }], 24);
    expect(failed).toBe(true);
    expect(text).toContain('never deployed');
  });

  it('fails an unreadable service, and marks it differently from drift', () => {
    const { failed, text } = formatReport([{ name: 'X', error: 'GitHub answered 403' }], 24);
    expect(failed).toBe(true);
    expect(text).toContain('⚠️');
    expect(text).toContain('403');
    // A broken check and a stale deploy send someone to different places.
    expect(text).toContain('could not read the answer');
  });

  it('is green when nothing is behind', () => {
    const { failed, text } = formatReport([{ name: 'X', count: 0, oldest: null, hours: 0 }], 24);
    expect(failed).toBe(false);
    expect(text).toContain('within the threshold');
  });

  // ❌ and not ⚠️: this was READ. Production runs a commit main does not
  // contain, which a drift count would have reported as zero.
  it('fails a baseline that is not on main, and says so rather than counting zero drift', () => {
    const { failed, text } = formatReport(
      [{ name: 'Terraform Infrastructure', notOnMain: { sha: APPLIED_SHA, status: 'diverged', runId: 'run-x' } }],
      24
    );
    expect(failed).toBe(true);
    const row = text.split('\n').find((l) => l.startsWith('| Terraform Infrastructure'));
    expect(row).toContain('❌');
    expect(row).toContain('applied from deadbeef');
    expect(row).toContain('not on main (diverged)');
    expect(row).not.toContain('✅');
  });

  // F5 (#963): the footer said "Both deploys" over three rows.
  it('describes all three rows in the footer, not two', () => {
    const { text } = formatReport([{ name: 'X', neverDeployed: true }], 24);
    expect(text).toContain('none of the three');
    expect(text).not.toContain('Both deploys');
  });
});

describe('driftFor', () => {
  /** The record `GET /actions/runs/41` answers for the run that deployed. */
  const DEPLOYED_RUN = { id: 41, status: 'completed', conclusion: 'success', head_sha: 'deployed', run_number: 1 };
  // A URL with no stub throws, and `ghJson` retries a thrown fetch once
  // after RETRY_DELAY_MS, so a test that leans on that throw passes
  // `retryDelayMs: 0` or waits two seconds for it.
  const stub = (map) => async (url) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    if (!key) throw new Error(`unstubbed: ${url}`);
    return { ok: true, status: 200, json: async () => map[key] };
  };

  it('excludes the deployed commit itself from the drift', async () => {
    // `since` is inclusive, so the deployed commit comes back in the list when
    // it touched this path. Counting it would make a service report itself one
    // commit behind seconds after a successful deploy.
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/runs?per_page=': { workflow_runs: [{ id: 41 }] },
        '/actions/runs/41': DEPLOYED_RUN,
        '/commits/deployed': { commit: { committer: { date: hoursAgo(5) } } },
        '/commits?sha=main': [commit('deployed', hoursAgo(5), 'the deployed one')],
      }),
    });
    expect(out.count).toBe(0);
    expect(out.oldest).toBe(null);
    expect(out.hours).toBe(0);
  });

  it('reports the age of the oldest undeployed commit', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/runs?per_page=': { workflow_runs: [{ id: 41 }] },
        '/actions/runs/41': DEPLOYED_RUN,
        '/commits/deployed': { commit: { committer: { date: hoursAgo(60) } } },
        '/commits?sha=main': [
          commit('new', hoursAgo(2), 'recent'),
          commit('old', hoursAgo(49), 'add the manifest route'),
        ],
      }),
    });
    expect(out.count).toBe(2);
    expect(out.hours).toBe(49);
    expect(out.oldest.message).toBe('add the manifest route');
  });

  it('paginates past the first page', async () => {
    // Drift matters most when it is large, so stopping at 100 under-reports
    // exactly the case this exists for: it would return a too-recent oldest and
    // therefore a healthier age than the truth.
    const pageOne = Array.from({ length: COMMITS_PER_PAGE }, (_, i) =>
      commit(`p1-${i}`, hoursAgo(10), 'recent')
    );
    const pageTwo = [commit('ancient', hoursAgo(200), 'the forgotten one')];
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async (url) => {
        if (url.includes('/runs?per_page='))
          return { ok: true, json: async () => ({ workflow_runs: [{ id: 41 }] }) };
        if (url.endsWith('/actions/runs/41')) return { ok: true, json: async () => DEPLOYED_RUN };
        if (url.includes('/commits/deployed'))
          return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(300) } } }) };
        // `&page=`, not `page=` — `per_page=100` contains `page=100`, which
        // contains `page=1`, so the loose form matched every page and this test
        // failed against correct code. A stub that lies is worse than no stub.
        if (url.includes('&page=1')) return { ok: true, json: async () => pageOne };
        if (url.includes('&page=2')) return { ok: true, json: async () => pageTwo };
        return { ok: true, json: async () => [] };
      },
    });
    expect(out.count).toBe(COMMITS_PER_PAGE + 1);
    expect(out.hours).toBe(200);
    expect(out.oldest.message).toBe('the forgotten one');
  });

  it('de-duplicates a commit that touches two of a service multiple declared paths', async () => {
    const shared = commit('both', hoursAgo(40), 'touches both paths');
    const out = await driftFor(
      { name: 'Two paths', workflow: 'w.yml', paths: ['a', 'b'] },
      {
        token: 't',
        owner: 'o',
        repo: 'r',
        nowMs: NOW,
        fetchImpl: async (url) => {
          if (url.includes('/runs?per_page='))
            return { ok: true, json: async () => ({ workflow_runs: [{ id: 41 }] }) };
          if (url.endsWith('/actions/runs/41')) return { ok: true, json: async () => DEPLOYED_RUN };
          if (url.includes('/commits/deployed'))
            return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(99) } } }) };
          return { ok: true, json: async () => [shared] };
        },
      }
    );
    expect(out.count).toBe(1);
  });

  it('reports undated commits as an error rather than as zero drift', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async (url) => {
        if (url.includes('/runs?per_page='))
          return { ok: true, json: async () => ({ workflow_runs: [{ id: 41 }] }) };
        if (url.endsWith('/actions/runs/41')) return { ok: true, json: async () => DEPLOYED_RUN };
        if (url.includes('/commits/deployed'))
          return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(99) } } }) };
        return { ok: true, json: async () => [{ sha: 'x', commit: { message: 'no date' } }] };
      },
    });
    expect(out.error).toContain('none with a readable date');
    expect(out.hours).toBeUndefined();
  });

  it('treats a non-array commits payload as unreadable, not as no drift', async () => {
    // Defaulting to [] here would report the service up to date — the same
    // healthier-than-reality direction as every other defect found in this
    // file. A ⚠️ says "could not read"; a ✅ says "nothing to deploy", and only
    // one of those is honest about an unrecognised payload.
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async (url) => {
        if (url.includes('/runs?per_page='))
          return { ok: true, json: async () => ({ workflow_runs: [{ id: 41 }] }) };
        if (url.endsWith('/actions/runs/41')) return { ok: true, json: async () => DEPLOYED_RUN };
        if (url.includes('/commits/deployed'))
          return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(99) } } }) };
        return { ok: true, json: async () => ({ message: 'not an array' }) };
      },
    });
    expect(out.error).toContain('non-array commits payload');
    expect(out.count).toBeUndefined();
    expect(formatReport([out], 24).failed).toBe(true);
  });

  it('returns the failure as a row instead of throwing, so one service cannot hide the others', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    expect(out.error).toContain('403');
  });

  it('renders ⚠️, not ❌ never deployed, when the only run record has no status', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/runs?per_page=': { workflow_runs: [{ id: 41 }] },
        '/actions/runs/41': { id: 41, head_sha: 'deployed' },
      }),
    });
    expect(out.error).toMatch(/no `status`/);
    expect(out.neverDeployed).toBeUndefined();
    expect(formatReport([out], 24).text).toContain('⚠️');
  });

  it('retries a body that cannot be read, and takes the second answer', async () => {
    // GitHub sent 200 headers and the body then failed. That is inside the
    // one retry, like a dropped connection, not a verdict on the service.
    let bodies = 0;
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      retryDelayMs: 0,
      fetchImpl: async (url) => {
        if (url.includes('/runs?per_page=')) {
          bodies += 1;
          if (bodies === 1) return { ok: true, status: 200, json: async () => { throw new Error('socket hang up'); } };
          return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 41 }] }) };
        }
        if (url.endsWith('/actions/runs/41')) return { ok: true, status: 200, json: async () => DEPLOYED_RUN };
        if (url.includes('/commits/deployed'))
          return { ok: true, status: 200, json: async () => ({ commit: { committer: { date: hoursAgo(5) } } }) };
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    expect(bodies).toBe(2);
    expect(out.error).toBeUndefined();
    expect(out.deployedSha).toBe('deployed');
  });

  it('gives up on a body that stalls past the deadline, twice, and says so', async () => {
    // Headers arrived; the body never does. Without the deadline on the body
    // this would wait on undici's defaults, past the job's own timeout.
    let bodies = 0;
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      retryDelayMs: 0,
      timeoutMs: 20,
      fetchImpl: async () => {
        bodies += 1;
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      },
    });
    expect(bodies).toBe(2);
    expect(out.error).toMatch(/body could not be read/);
    expect(formatReport([out], 24).text).toContain('⚠️');
  });
});

/**
 * The Terraform row, end to end against stubbed HCP Terraform and GitHub.
 *
 * The direction under test is the one the row was reopened for: nothing that
 * is not an apply may render ✅. The stubs answer by URL, so a test can also
 * assert which APIs were and were not asked — the old reader's
 * `/actions/workflows/tfc-plan-check.yml/runs` must not be among them.
 */
describe('driftFor — Terraform Infrastructure', () => {
  const TERRAFORM = SERVICES.find((s) => s.terraform);

  /** GitHub and HCP Terraform, keyed by URL fragment; records every URL asked. */
  const stub = (map, asked = []) => async (url) => {
    asked.push(url);
    const key = Object.keys(map).find((k) => url.includes(k));
    if (!key) throw new Error(`unstubbed: ${url}`);
    const answer = map[key];
    if (answer && typeof answer === 'object' && 'status' in answer && answer.ok === false) return answer;
    return { ok: true, status: 200, json: async () => answer };
  };

  const workspace = { data: { id: 'ws-1', type: 'workspaces' } };
  const RUNS = '/workspaces/ws-1/runs?filter%5Bstatus%5D=applied&page%5Bsize%5D=1&include=configuration_version.ingress_attributes';

  it('is a service that exists, keyed on the workspace rather than a workflow', () => {
    expect(TERRAFORM).toBeDefined();
    expect(TERRAFORM.workflow).toBeUndefined();
  });

  // THE ASSERTION THIS BLOCK EXISTS FOR. Without a token the row must say it
  // could not read, and it must not reach for GitHub to find a substitute
  // baseline — that substitute is what was green on nothing.
  it('renders ⚠️, never ✅, when TFC_TOKEN is unset, and asks nothing of either API', async () => {
    const asked = [];
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: undefined,
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({}, asked),
    });
    expect(out.error).toContain('TFC_TOKEN is not set');
    expect(out.count).toBeUndefined();
    expect(asked).toEqual([]);

    const { failed, text } = formatReport([out], DEFAULT_THRESHOLD_HOURS);
    expect(failed).toBe(true);
    const row = text.split('\n').find((l) => l.startsWith('| Terraform Infrastructure'));
    expect(row).toContain('⚠️');
    expect(row).not.toContain('✅');
  });

  it('treats an empty TFC_TOKEN as unset', async () => {
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: '',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({}),
    });
    expect(out.error).toContain('TFC_TOKEN is not set');
  });

  it("counts the infra commits on main after the applied run's commit, and reads no workflow run", async () => {
    const asked = [];
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub(
        {
          '/organizations/hcw/workspaces/hcw-azure': workspace,
          [RUNS]: runsDocument({ sha: APPLIED_SHA.toUpperCase() }),
          [`/compare/${APPLIED_SHA}...main`]: { status: 'ahead', ahead_by: 2 },
          [`/commits/${APPLIED_SHA}`]: { commit: { committer: { date: hoursAgo(60) } } },
          '/commits?sha=main&path=infra': [
            // The applied commit itself, as `since` is inclusive; a
            // differently-cased apply must still be excluded.
            commit(APPLIED_SHA, hoursAgo(60), 'the applied one'),
            commit('new', hoursAgo(2), 'recent'),
            commit('old', hoursAgo(49), 'add the container'),
          ],
        },
        asked
      ),
    });
    expect(out.error).toBeUndefined();
    expect(out.deployedSha).toBe(APPLIED_SHA);
    expect(out.count).toBe(2);
    expect(out.hours).toBe(49);
    expect(out.oldest.message).toBe('add the container');
    expect(asked.some((u) => u.includes('app.terraform.io/api/v2' + RUNS))).toBe(true);
    expect(asked.some((u) => u.includes('/actions/workflows/'))).toBe(false);
    expect(formatReport([out], DEFAULT_THRESHOLD_HOURS).text).toContain('2 commit(s), oldest 49h');
  });

  it('renders ⚠️ when HCP Terraform refuses the read, naming the status', async () => {
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/organizations/hcw/workspaces/hcw-azure': { ok: false, status: 403, json: async () => ({}) },
      }),
    });
    expect(out.error).toContain('HCP Terraform answered 403');
    const { failed, text } = formatReport([out], DEFAULT_THRESHOLD_HOURS);
    expect(failed).toBe(true);
    expect(text).toContain('⚠️');
    expect(text).not.toContain('✅');
  });

  it('renders ⚠️ when the runs document carries no included section', async () => {
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/organizations/hcw/workspaces/hcw-azure': workspace,
        [RUNS]: { data: [appliedRun()] },
      }),
    });
    expect(out.error).toContain('`included` section');
  });

  // An apply from a branch, or from a main that has since been rewritten:
  // production runs infrastructure main does not contain. Counting main's
  // commits since that commit's date would report some number — possibly
  // zero — about the wrong question.
  it('reports an applied commit that is not on main as such, not as drift', async () => {
    const asked = [];
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub(
        {
          '/organizations/hcw/workspaces/hcw-azure': workspace,
          [RUNS]: runsDocument(),
          [`/compare/${APPLIED_SHA}...main`]: { status: 'diverged', ahead_by: 3, behind_by: 1 },
        },
        asked
      ),
    });
    expect(out.notOnMain).toEqual({ sha: APPLIED_SHA, status: 'diverged', runId: 'run-applied' });
    expect(out.count).toBeUndefined();
    expect(out.error).toBeUndefined();
    // Nothing was counted: the commits API was never asked.
    expect(asked.some((u) => u.includes('/commits?'))).toBe(false);

    const { failed, text } = formatReport([out], DEFAULT_THRESHOLD_HOURS);
    expect(failed).toBe(true);
    expect(text).toContain('not on main (diverged)');
  });

  it('treats `behind` as off main too, and `identical` as on it', async () => {
    const run = (status) =>
      driftFor(TERRAFORM, {
        token: 't',
        tfcToken: 'tfc',
        owner: 'o',
        repo: 'r',
        nowMs: NOW,
        fetchImpl: stub({
          '/organizations/hcw/workspaces/hcw-azure': workspace,
          [RUNS]: runsDocument(),
          [`/compare/${APPLIED_SHA}...main`]: { status },
          [`/commits/${APPLIED_SHA}`]: { commit: { committer: { date: hoursAgo(1) } } },
          '/commits?sha=main&path=infra': [],
        }),
      });
    expect((await run('behind')).notOnMain.status).toBe('behind');
    const identical = await run('identical');
    expect(identical.notOnMain).toBeUndefined();
    expect(identical.count).toBe(0);
  });

  it('renders ⚠️ on a compare status it does not recognise', async () => {
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/organizations/hcw/workspaces/hcw-azure': workspace,
        [RUNS]: runsDocument(),
        [`/compare/${APPLIED_SHA}...main`]: { message: 'no status here' },
      }),
    });
    expect(out.error).toContain('compare payload with status null');
  });

  it('reports a workspace that has never applied as never deployed', async () => {
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/organizations/hcw/workspaces/hcw-azure': workspace,
        [RUNS]: { data: [], included: [] },
      }),
    });
    expect(out.neverDeployed).toBe(true);
    expect(formatReport([out], DEFAULT_THRESHOLD_HOURS).failed).toBe(true);
  });

  it('renders ⚠️ when the workspace lookup answers without an id', async () => {
    const out = await driftFor(TERRAFORM, {
      token: 't',
      tfcToken: 'tfc',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({ '/organizations/hcw/workspaces/hcw-azure': { data: {} } }),
    });
    expect(out.error).toContain('no id for workspace hcw/hcw-azure');
  });
});

describe('SERVICES', () => {
  it('reads the two deploys (functions and frontend) from their workflows, and nothing else from a workflow', () => {
    expect(
      SERVICES.filter((s) => s.workflow)
        .map((s) => s.workflow)
        .sort()
    ).toEqual(['deploy-azure-frontend.yml', 'deploy-functions.yml']);
  });

  // F4 (#963). tfc-plan-check.yml is a dispatch-only READ of a plan and goes
  // green with the token unset, on an unconfirmed plan, and on a plan nobody
  // applied. It is not evidence of an apply and must not come back as one.
  it('does not key any row on tfc-plan-check.yml', () => {
    expect(SERVICES.some((s) => s.workflow === 'tfc-plan-check.yml')).toBe(false);
  });

  it('reads the Terraform row from the hcw/hcw-azure workspace on HCP Terraform', () => {
    const terraform = SERVICES.find((s) => s.name === 'Terraform Infrastructure');
    expect(terraform.terraform).toEqual({ organization: 'hcw', workspace: 'hcw-azure' });
    expect(terraform.workflow).toBeUndefined();
  });

  it('gives every service at least one path, or drift would always be zero', () => {
    for (const s of SERVICES) expect(s.paths.length).toBeGreaterThan(0);
  });

  // F5 (#963): `cosmos-containers.json` was listed at the repository root,
  // where it does not exist (it is infra/cosmos-containers.json, under a path
  // already listed). A path that matches nothing is silent — the row counts
  // the other paths and looks complete.
  it('declares only paths that exist in the repository', () => {
    for (const s of SERVICES) {
      for (const path of s.paths) {
        expect(existsSync(join(REPO, path)), `${s.name}: ${path} does not exist`).toBe(true);
      }
    }
  });
});

/**
 * How monitor-deploy-drift.yml reaches the script is part of the fix, not
 * packaging around it: a job without the token renders the Terraform row ⚠️
 * on every run, which is honest and useless. Pinned the way
 * check-workflow-health.invocation.test.mjs pins that script's `2>&1`.
 */
describe('monitor-deploy-drift.yml wiring', () => {
  /** Non-comment lines only, so prose about the token cannot satisfy the assertion. */
  const lines = readFileSync(WORKFLOW, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
  const jobStart = (name) => lines.findIndex((l) => l === `  ${name}:`);
  const checkJob = lines.slice(jobStart('check'), jobStart('workflows'));
  const workflowsJob = lines.slice(jobStart('workflows'));

  it('finds both jobs', () => {
    expect(jobStart('check')).toBeGreaterThan(-1);
    expect(jobStart('workflows')).toBeGreaterThan(jobStart('check'));
  });

  it('passes TFC_TOKEN to the step that measures the drift', () => {
    const step = checkJob.findIndex((l) => l.includes('- name: Measure the drift'));
    const invocation = checkJob.findIndex((l) => l.includes('check-deploy-drift.mjs'));
    expect(step).toBeGreaterThan(-1);
    expect(invocation).toBeGreaterThan(step);
    const env = checkJob.slice(step, invocation).map((l) => l.trim());
    expect(env).toContain('TFC_TOKEN: ${{ secrets.TFC_TOKEN }}');
  });

  // The secret is reachable only from a job GitHub has admitted into an
  // environment (zizmor secrets-outside-env), and `automation` rather than
  // `production` because a scheduled run cannot wait on an approval gate —
  // the same reasoning as tfc-plan-check.yml.
  it('puts the check job, and only the check job, in the automation environment', () => {
    expect(checkJob.map((l) => l.trim())).toContain('environment: automation');
    expect(workflowsJob.some((l) => /^\s*environment:/.test(l))).toBe(false);
    expect(workflowsJob.some((l) => l.includes('TFC_TOKEN'))).toBe(false);
  });

  it('grants nothing but reads', () => {
    expect(lines.some((l) => /^\s+\w+:\s*write\b/.test(l))).toBe(false);
    expect(lines.map((l) => l.trim())).toContain('contents: read # reads the commit log; writes nothing');
  });
});

describe('cell', () => {
  // Commit subjects and error text are not ours to constrain. A `|` ends the
  // cell early, the row grows a column, and the table stops being a table —
  // in the one artefact an operator reads to decide whether to deploy.
  it('escapes a pipe', () => {
    expect(cell('fix: handle a | b')).toBe('fix: handle a \\| b');
  });

  it('escapes a backslash, so it survives as a backslash', () => {
    expect(cell('use C:\\path')).toBe('use C:\\\\path');
  });

  // The ordering case. Escape only `|` and the subject below becomes
  // `a \\| b`: Markdown renders the doubled backslash as one literal
  // backslash and then reads the pipe as a live column break — the escape
  // is what breaks the table. Escaping `\` first is what makes the pipe
  // stay escaped.
  it('keeps a pipe escaped even when the subject already contains a backslash', () => {
    expect(cell('a \\| b')).toBe('a \\\\\\| b');
  });

  it('folds newlines, which break a row as thoroughly as a pipe', () => {
    expect(cell('line one\nline two')).toBe('line one line two');
    expect(cell('crlf\r\nhere')).toBe('crlf here');
  });

  it('is empty for null and undefined rather than printing the words', () => {
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
  });

  it('leaves ordinary text alone', () => {
    expect(cell('add the manifest route')).toBe('add the manifest route');
  });
});

describe('formatReport escaping', () => {
  it('keeps the row a single row when a commit subject contains a pipe', () => {
    const { text } = formatReport(
      [{ name: 'Function App', count: 1, oldest: { message: 'feat: a | b' }, hours: 50 }],
      24
    );
    const row = text.split('\n').find((l) => l.startsWith('| Function App'));
    // Three cells means three unescaped separators plus the leading and
    // trailing ones. An unescaped pipe in the subject would make it more.
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(4);
    expect(row).toContain('a \\| b');
  });

  it('escapes error text too, which comes from anywhere', () => {
    const { text } = formatReport([{ name: 'X', error: 'boom | bang' }], 24);
    expect(text).toContain('boom \\| bang');
  });
});

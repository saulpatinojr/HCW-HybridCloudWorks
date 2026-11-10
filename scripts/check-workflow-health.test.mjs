/**
 * Tests for the workflow-health verdict.
 *
 * These are off-line and fixture-driven on purpose. The network half of
 * `check-workflow-health.mjs` cannot run in CI without a token, and a guard
 * whose logic can only be exercised against the live API is a guard nobody can
 * change safely — the lesson `workspace-query.tests.ps1` was written for, kept
 * here now that its subject is gone.
 *
 * The fixtures are REAL run histories, copied from the API on 2026-09-08, not
 * invented ones. `validate-deployed.yml` is the case the tool exists for;
 * `deploy-azure-frontend.yml` is the case it must NOT fire on, and it was the
 * one that nearly produced a false positive, because two of its five recent
 * runs were cancelled.
 */
import { describe, expect, it } from 'vitest';
import {
  assessWorkflow,
  assessAll,
  renderReport,
  DEFAULT_STALE_DAYS,
  positiveIntOr,
  DEFAULT_SAMPLE,
  MAX_PER_PAGE,
  listingRefusal,
  runsRefusal,
  readTuning,
  treeRefusal,
  partitionByPresence,
  FAILING_SCHEDULED_RUNS,
  consecutiveScheduledFailures,
  findingsKey,
  hasFinding,
  selfWorkflowPath,
} from './check-workflow-health.mjs';

const NOW = new Date('2026-09-08T05:00:00Z');
const OPTS = { now: NOW, staleDays: DEFAULT_STALE_DAYS };

/** Real: the only two runs this workflow ever had, both red, three weeks back. */
const VALIDATE_DEPLOYED = {
  path: '.github/workflows/validate-deployed.yml',
  runs: [
    { conclusion: 'failure', created_at: '2026-08-18T02:03:03Z' },
    { conclusion: 'failure', created_at: '2026-08-18T00:08:31Z' },
  ],
};

/** Real: used successfully the same day, but with cancellations in the window. */
const DEPLOY_FRONTEND = {
  path: '.github/workflows/deploy-azure-frontend.yml',
  runs: [
    { conclusion: 'success', created_at: '2026-09-08T02:21:08Z' },
    { conclusion: 'success', created_at: '2026-09-08T02:08:52Z' },
    { conclusion: 'success', created_at: '2026-09-08T01:26:38Z' },
    { conclusion: 'cancelled', created_at: '2026-09-08T01:16:45Z' },
    { conclusion: 'cancelled', created_at: '2026-09-07T23:55:27Z' },
  ],
};

/** Real: a dispatch-only tool whose red X IS its verdict, not a breakage. */
const TFC_PLAN_CHECK = {
  path: '.github/workflows/tfc-plan-check.yml',
  runs: [
    { conclusion: 'failure', created_at: '2026-08-31T20:02:12Z' },
    { conclusion: 'success', created_at: '2026-08-31T20:00:42Z' },
    { conclusion: 'failure', created_at: '2026-08-31T19:59:37Z' },
  ],
};

describe('assessWorkflow', () => {
  it('calls a workflow broken when nothing succeeded and nobody came back', () => {
    const got = assessWorkflow(VALIDATE_DEPLOYED, OPTS);
    expect(got.verdict).toBe('broken');
    // The number is the finding. A verdict that does not say how long it sat
    // is one somebody has to go and look up, which is how it gets skipped.
    expect(got.why).toContain('21d ago');
    expect(got.why).toContain('2026-08-18');
  });

  it('does not fire on a workflow that succeeded, whatever else is in the window', () => {
    // Two cancellations here. Counting a cancellation as a failure would have
    // flagged a workflow used successfully three times the same morning.
    expect(assessWorkflow(DEPLOY_FRONTEND, OPTS).verdict).toBe('healthy');
  });

  it('does not fire on a dispatch tool whose red run is a real verdict', () => {
    // tfc-plan-check.yml exits 1 to REPORT an unexpected plan. One success in
    // the window is enough to say the workflow itself works.
    expect(assessWorkflow(TFC_PLAN_CHECK, OPTS).verdict).toBe('healthy');
  });

  it('holds fire on a fresh failure — that is somebody mid-debug', () => {
    const got = assessWorkflow(
      {
        path: '.github/workflows/whatever.yml',
        runs: [{ conclusion: 'failure', created_at: '2026-09-07T12:00:00Z' }],
      },
      OPTS
    );
    expect(got.verdict).toBe('unproven');
    expect(got.why).toContain('work in progress');
  });

  it('separates "no evidence" from "evidence of absence"', () => {
    // A workflow that has never run is not a broken one. Reporting it as
    // broken is the T-514 mistake in a new costume.
    expect(assessWorkflow({ path: 'a.yml', runs: [] }, OPTS).verdict).toBe('unproven');
    // In-flight runs carry conclusion: null and are not evidence either.
    expect(
      assessWorkflow(
        { path: 'b.yml', runs: [{ conclusion: null, created_at: '2026-09-08T04:59:00Z' }] },
        OPTS
      ).verdict
    ).toBe('unproven');
  });

  it('will not call a workflow broken on cancellations alone', () => {
    const got = assessWorkflow(
      {
        path: 'c.yml',
        runs: [
          { conclusion: 'cancelled', created_at: '2026-07-01T00:00:00Z' },
          { conclusion: 'cancelled', created_at: '2026-07-02T00:00:00Z' },
        ],
      },
      OPTS
    );
    expect(got.verdict).toBe('unproven');
    expect(got.why).toContain('none of which reached a verdict');
  });

  it('counts timed_out and startup_failure as failures, since neither is a success', () => {
    for (const conclusion of ['timed_out', 'startup_failure']) {
      const got = assessWorkflow(
        { path: 'd.yml', runs: [{ conclusion, created_at: '2026-08-01T00:00:00Z' }] },
        OPTS
      );
      expect(got.verdict, conclusion).toBe('broken');
    }
  });
});

describe('renderReport', () => {
  it('names the broken workflow and exits loud', () => {
    const text = renderReport(assessAll([VALIDATE_DEPLOYED, DEPLOY_FRONTEND], OPTS), {
      staleDays: DEFAULT_STALE_DAYS,
    });
    expect(text).toContain('validate-deployed.yml');
    expect(text).toContain('Fix it or delete it.');
    // The healthy one must not be listed as a finding.
    expect(text).not.toContain('- `.github/workflows/deploy-azure-frontend.yml`');
  });

  it('says so plainly when nothing is broken', () => {
    const text = renderReport(assessAll([DEPLOY_FRONTEND], OPTS), {
      staleDays: DEFAULT_STALE_DAYS,
    });
    expect(text).toContain('No workflow is failing-and-abandoned');
  });
});

describe('the fixtures are the real thing', () => {
  // A fixture that drifted into a shape the API never produces would make
  // every test above pass while testing nothing. These pin the two fields the
  // verdict actually reads.
  it('every fixture run carries a conclusion field and an ISO created_at', () => {
    for (const wf of [VALIDATE_DEPLOYED, DEPLOY_FRONTEND, TFC_PLAN_CHECK]) {
      for (const run of wf.runs) {
        expect(Object.hasOwn(run, 'conclusion'), wf.path).toBe(true);
        expect(run.created_at, wf.path).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      }
    }
  });
});

describe('positiveIntOr', () => {
  // WORKFLOW_STALE_DAYS and WORKFLOW_SAMPLE reached Number() directly until
  // review caught it on #426. `Number('soon')` is NaN and NaN does not throw:
  // it would have gone into a request URL as `per_page=NaN`, and made every
  // staleness comparison false. A mistyped variable must not become a finding
  // about a workflow.
  it('takes a positive whole number', () => {
    expect(positiveIntOr('30', 10)).toBe(30);
    expect(positiveIntOr(7, 10)).toBe(7);
  });

  it('falls back for anything that is not one, rather than yielding NaN', () => {
    for (const bad of ['soon', '', '   ', undefined, null, 'NaN', '1e', '-5', '0', '2.5', {}]) {
      const got = positiveIntOr(bad, 10);
      expect(Number.isFinite(got), `positiveIntOr(${JSON.stringify(bad)}) was not finite`).toBe(
        true
      );
      expect(got).toBe(10);
    }
  });

  it('never returns NaN for a value Number() would accept as one', () => {
    // The specific regression: Number(undefined) is NaN, Number({}) is NaN.
    expect(Number(positiveIntOr('soon', 10))).not.toBeNaN();
    expect(String(positiveIntOr('soon', 10))).toBe('10');
  });
});

describe('a workflow nobody has concluded either way', () => {
  // Review asked for neutral/action_required/stale to be counted as failures.
  // They are not, and must not be: both gated deploys in this repository carry
  // cancelled runs today, and action_required is the terminal state of a
  // deploy nobody approved — counting either would report a healthy workflow
  // as broken. The real gap it found was that such a workflow hides in the
  // collapsed block forever, however long it sits there. That is what these
  // pin: the classification is unchanged, the visibility is not.
  const now = new Date('2026-09-08T00:00:00Z');
  const nonVerdict = (created_at, conclusion = 'cancelled') => ({
    path: '.github/workflows/x.yml',
    runs: [{ conclusion, created_at }],
  });

  it('is still unproven, not broken, whatever the conclusion was', () => {
    for (const c of ['cancelled', 'neutral', 'action_required', 'stale', 'skipped']) {
      const got = assessWorkflow(nonVerdict('2026-01-01T00:00:00Z', c), { now, staleDays: 10 });
      expect(got.verdict, `${c} should not be a failure verdict`).toBe('unproven');
    }
  });

  it('carries how long it has been unproven', () => {
    const got = assessWorkflow(nonVerdict('2026-01-01T00:00:00Z'), { now, staleDays: 10 });
    expect(got.ageDays).toBe(250);
  });

  it('is surfaced outside the collapsed block once it is older than the window', () => {
    const old = assessWorkflow(nonVerdict('2026-01-01T00:00:00Z'), { now, staleDays: 10 });
    const report = renderReport([old], { staleDays: 10 });
    const [visible, collapsed] = report.split('<details>');
    expect(visible).toContain('concluded nothing either way for over 10 days');
    expect(visible).toContain('.github/workflows/x.yml');
    expect(collapsed ?? '').not.toContain('.github/workflows/x.yml');
  });

  it('stays collapsed while it is inside the window', () => {
    const fresh = assessWorkflow(nonVerdict('2026-09-07T00:00:00Z'), { now, staleDays: 10 });
    const report = renderReport([fresh], { staleDays: 10 });
    const [visible, collapsed] = report.split('<details>');
    expect(visible).not.toContain('.github/workflows/x.yml');
    expect(collapsed ?? '').toContain('.github/workflows/x.yml');
  });
});

describe('what "nobody has been back" is measured from', () => {
  const now = new Date('2026-09-08T00:00:00Z');

  it('a recent cancellation means somebody HAS been back, so it is not abandoned', () => {
    // The regression: age came from the newest FAILURE. A workflow that failed
    // 30 days ago and had a run cancelled yesterday was called abandoned, in a
    // sentence that said "nobody has been back" about a workflow somebody was
    // back at yesterday. Caught in review on #426.
    const got = assessWorkflow(
      {
        path: '.github/workflows/x.yml',
        runs: [
          { conclusion: 'failure', created_at: '2026-08-09T00:00:00Z' },
          { conclusion: 'cancelled', created_at: '2026-09-07T00:00:00Z' },
        ],
      },
      { now, staleDays: 10 }
    );
    expect(got.verdict).toBe('unproven');
    expect(got.ageDays).toBeCloseTo(1, 5);
  });

  it('still calls it broken when nothing of any kind is recent', () => {
    const got = assessWorkflow(
      {
        path: '.github/workflows/x.yml',
        runs: [
          { conclusion: 'failure', created_at: '2026-08-09T00:00:00Z' },
          { conclusion: 'cancelled', created_at: '2026-08-10T00:00:00Z' },
        ],
      },
      { now, staleDays: 10 }
    );
    expect(got.verdict).toBe('broken');
    // Dated from the newest run, not the newest failure.
    expect(got.why).toContain('2026-08-10');
  });

  it('does not claim everything is inside the window while showing one that is not', () => {
    const stalled = assessWorkflow(
      {
        path: '.github/workflows/old.yml',
        runs: [{ conclusion: 'cancelled', created_at: '2026-01-01T00:00:00Z' }],
      },
      { now, staleDays: 10 }
    );
    const report = renderReport([stalled], { staleDays: 10 });
    expect(report).toContain('No workflow is failing-and-abandoned.');
    expect(report).toContain('concluded nothing either way for over 10 days');
    // The self-contradiction: the headline used to assert this too.
    expect(report).not.toContain('inside the 10-day window.');
  });
});

describe('the per_page ceiling', () => {
  // GitHub does not reject an oversized per_page — verified against the live
  // API, which answered HTTP 200 with 100 runs for per_page=500. So this is
  // not about avoiding an error; it is about not silently measuring something
  // other than what was asked for. Raised in review on #426.
  it('clamps to the API ceiling instead of passing the value through', () => {
    expect(positiveIntOr('500', 10, MAX_PER_PAGE)).toBe(100);
    expect(positiveIntOr('101', 10, MAX_PER_PAGE)).toBe(100);
  });

  it('leaves a value at or under the ceiling alone', () => {
    expect(positiveIntOr('100', 10, MAX_PER_PAGE)).toBe(100);
    expect(positiveIntOr('25', 10, MAX_PER_PAGE)).toBe(25);
  });

  it('still falls back for a non-number, ceiling or not', () => {
    expect(positiveIntOr('soon', 10, MAX_PER_PAGE)).toBe(10);
  });

  it('does not clamp when no ceiling is given', () => {
    // WORKFLOW_STALE_DAYS has no API ceiling and must not inherit one.
    expect(positiveIntOr('365', 10)).toBe(365);
  });
});

describe('readTuning — the wiring, not just the helper', () => {
  it('applies the API ceiling to the sample size', () => {
    expect(readTuning({ WORKFLOW_SAMPLE: '500' }).sample).toBe(100);
  });

  it('does not apply it to the staleness window', () => {
    expect(readTuning({ WORKFLOW_STALE_DAYS: '365' }).staleDays).toBe(365);
  });

  it('falls back for both when the environment is empty', () => {
    expect(readTuning({})).toEqual({ staleDays: DEFAULT_STALE_DAYS, sample: DEFAULT_SAMPLE });
  });

  it('never yields NaN for either', () => {
    const got = readTuning({ WORKFLOW_SAMPLE: 'soon', WORKFLOW_STALE_DAYS: 'later' });
    expect(Number.isFinite(got.sample)).toBe(true);
    expect(Number.isFinite(got.staleDays)).toBe(true);
  });
});

describe('the messages say what was actually measured', () => {
  const now = new Date('2026-09-08T00:00:00Z');

  it('does not call a cancellation a failure when dating recent activity', () => {
    // ageDays comes from the newest run of ANY kind. A message saying "the
    // newest failure is 1d old" when the newest failure is 30d old and the
    // 1d-old run was cancelled claims a failure that does not exist.
    // Caught in review on #426, after the age source changed two commits
    // earlier and this string was not swept with it.
    const got = assessWorkflow(
      {
        path: '.github/workflows/x.yml',
        runs: [
          { conclusion: 'failure', created_at: '2026-08-09T00:00:00Z' },
          { conclusion: 'cancelled', created_at: '2026-09-07T00:00:00Z' },
        ],
      },
      { now, staleDays: 10 }
    );
    expect(got.why).not.toContain('newest failure');
    expect(got.why).toContain('newest run of any kind');
  });

  it('says the same thing in the broken message', () => {
    const got = assessWorkflow(
      {
        path: '.github/workflows/x.yml',
        runs: [{ conclusion: 'failure', created_at: '2026-08-09T00:00:00Z' }],
      },
      { now, staleDays: 10 }
    );
    expect(got.why).toContain('newest attempt of any kind');
  });
});

describe('what `broken` claims, and what it does not', () => {
  const now = new Date('2026-09-08T00:00:00Z');

  // Review on #426 asked for `broken` to require that EVERY finished run in
  // the sample be a failing conclusion, with a mixed sample becoming
  // `unproven`. Declined, and this is the case that decides it: a workflow
  // that failed a month ago, had a run cancelled a month ago, never succeeded,
  // and has not been touched since. Under the stricter rule it lands in the
  // `unproven` section, whose line reads "none of which reached a verdict"
  // about a run that reached a verdict of failure — and one stray cancellation
  // in the window would have been enough to hide validate-deployed.yml, the
  // case this file exists for. What makes the looser rule safe is the second
  // assertion here: the verdict states the arithmetic it used, so a mixed
  // sample reads as mixed and nobody has to take "broken" on trust.
  const MIXED = {
    path: '.github/workflows/x.yml',
    runs: [
      { conclusion: 'failure', created_at: '2026-08-09T00:00:00Z' },
      { conclusion: 'cancelled', created_at: '2026-08-10T00:00:00Z' },
    ],
  };

  it('is broken on "nothing succeeded and something failed", not on "every run failed"', () => {
    expect(assessWorkflow(MIXED, { now, staleDays: 10 }).verdict).toBe('broken');
  });

  it('never claims the sample was all red — it prints the count it counted', () => {
    const got = assessWorkflow(MIXED, { now, staleDays: 10 });
    expect(got.why).toContain('1 of 2 sampled run(s) failed, none succeeded');
  });
});

describe('runsRefusal', () => {
  // The same subject as listingRefusal, one level down: can the rows be
  // trusted to be the rows that were asked for? Both failures here used to be
  // silent in different ways — `got.workflow_runs || []` turned a missing
  // array into "no runs", which reads as `unproven`, and a truthy non-array
  // reached `runs.filter(...)` and threw, and an uncaught throw exits 1, which
  // in this tool means "a workflow is broken". Raised in review on #428.
  const CI = { path: '.github/workflows/ci.yml', id: 328179407 };

  it('accepts a listing whose runs all belong to the workflow asked for', () => {
    expect(
      runsRefusal(
        {
          workflow_runs: [
            { workflow_id: CI.id, conclusion: 'success', created_at: '2026-09-08T00:00:00Z' },
            { workflow_id: CI.id, conclusion: 'failure', created_at: '2026-09-07T00:00:00Z' },
          ],
        },
        CI
      )
    ).toBeNull();
    // An empty history is a real answer and not a refusal; assessWorkflow
    // calls it unproven, which is the correct verdict for a workflow that has
    // never run.
    expect(runsRefusal({ workflow_runs: [] }, CI)).toBeNull();
  });

  it('refuses a payload with no workflow_runs array, rather than reading it as no runs', () => {
    for (const payload of [
      null,
      undefined,
      {},
      { workflow_runs: null },
      { workflow_runs: {} },
      { workflow_runs: 'nope' },
    ]) {
      const got = runsRefusal(payload, CI);
      expect(got, `runsRefusal accepted ${JSON.stringify(payload)}`).not.toBeNull();
      expect(got).toContain('no `workflow_runs` array');
      expect(got).toContain('nothing is asserted');
    }
  });

  it('refuses a run belonging to a different workflow, and says which', () => {
    const got = runsRefusal(
      { workflow_runs: [{ workflow_id: 999, conclusion: 'success', created_at: 'x' }] },
      CI
    );
    expect(got).not.toBeNull();
    expect(got).toContain('1 run(s) that are not workflow 328179407');
    expect(got).toContain('first: 999');
  });

  it('fails CLOSED on a row it cannot identify at all', () => {
    // The 2026-09-08 regression in the first version of this guard was a
    // leading truthy check that let an unidentifiable row through. A guard
    // against a response carrying the wrong rows must not quietly accept a row
    // it cannot read.
    for (const run of [{}, { workflow_id: null }, { workflow_id: undefined }, null]) {
      const got = runsRefusal({ workflow_runs: [run] }, CI);
      expect(got, `runsRefusal accepted run ${JSON.stringify(run)}`).not.toBeNull();
      expect(got).toContain('no workflow_id on the run');
    }
  });
});

describe('listingRefusal', () => {
  // FIXTURE CHANGED DELIBERATELY, AND SAID OUT LOUD: this read
  // `new Array(19)` — nineteen holes, a shape the API never produces. Once
  // listingRefusal started reading each entry's `path` and `id` (below), that
  // stand-in became a listing of nineteen unreadable entries and the refusal
  // fired correctly on it. The fixture is now what the endpoint actually
  // returns. No assertion was weakened; the subject was made real, which is
  // the same reason `the fixtures are the real thing` exists in this file.
  const listingOf = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: 100 + i, path: `.github/workflows/w${i}.yml` }));

  it('accepts a complete listing', () => {
    expect(listingRefusal({ total_count: 19, workflows: listingOf(19) })).toBeNull();
    // total_count absent is not evidence of truncation.
    expect(listingRefusal({ workflows: [] })).toBeNull();
  });

  it('refuses a truncated one', () => {
    const got = listingRefusal({ total_count: 150, workflows: new Array(100) });
    expect(got).toContain('paginated');
    expect(got).toContain('nothing is asserted');
  });

  it('refuses a listing whose shape it cannot read', () => {
    for (const bad of [null, undefined, {}, { workflows: 'nope' }]) {
      expect(listingRefusal(bad)).toContain('nothing is asserted');
    }
  });

  it('refuses an entry it cannot filter or ask for runs, instead of crashing', () => {
    // main() does `w.path.startsWith(...)` and requests `/workflows/${w.id}/runs`.
    // Before this guard an entry missing either threw a TypeError, and an
    // uncaught throw from the awaited main() exits 1 — measured. Exit 1 in this
    // tool means "a workflow is broken", so an unreadable LISTING reported a
    // broken WORKFLOW: the collapse of `broken` into `unproven` that the
    // three-way exit split exists to prevent, arriving by the error path.
    // Raised in review on #428.
    for (const entry of [
      {},
      { id: 1 },
      { path: 42, id: 1 },
      { path: '', id: 1 },
      { path: 'a.yml' },
      { path: 'a.yml', id: '1' },
      null,
    ]) {
      const got = listingRefusal({ total_count: 1, workflows: [entry] });
      expect(got, `listingRefusal accepted ${JSON.stringify(entry)}`).not.toBeNull();
      expect(got).toContain('nothing is asserted');
    }
  });

  it('names which entry, so the payload can be found', () => {
    const got = listingRefusal({
      total_count: 2,
      workflows: [{ id: 1, path: '.github/workflows/ci.yml' }, { id: 2 }],
    });
    expect(got).not.toBeNull();
    expect(got).toContain('entry 1');
  });

  it('does not tell the reader to raise per_page, which is already at the ceiling', () => {
    // The request asks for MAX_PER_PAGE already, so "raise per_page" is an
    // impossible instruction — an operator would try it, watch nothing change
    // and conclude the tool is broken rather than the situation. Caught in
    // review on #426.
    const got = listingRefusal({ total_count: 150, workflows: new Array(100) });
    expect(got).not.toMatch(/raise per_page/i);
    expect(got).toContain(String(MAX_PER_PAGE));
    expect(got).toContain('Following pages');
  });
});

/**
 * A workflow whose file is not on the default branch is named, not judged
 * (#1564).
 *
 * The listing is the shape the live API gave on 2026-11-05: GitHub listed
 * `zz-probe-guide-drift.yml` as `active` on the strength of its one run on
 * `probe/guide-drift-1356`, and every health run since 2026-10-25 called it
 * broken. The file was never on `main`.
 */
describe('a workflow whose file is not on the default branch', () => {
  /** As the workflow listing names them, both `active`, only one in the tree. */
  const LISTED = [
    { id: 1, path: '.github/workflows/deploy-azure-frontend.yml', state: 'active' },
    { id: 2, path: '.github/workflows/zz-probe-guide-drift.yml', state: 'active' },
  ];
  /** As `GET /contents/.github/workflows?ref=main` names them. */
  const TREE = [
    { path: '.github/workflows/deploy-azure-frontend.yml', type: 'file' },
    { path: '.github/workflows/ci.yml', type: 'file' },
  ];
  /** The probe's real history: one deliberate failure, 11 days before NOW. */
  const PROBE = {
    path: '.github/workflows/zz-probe-guide-drift.yml',
    runs: [{ conclusion: 'failure', created_at: '2026-08-28T05:00:00Z' }],
  };

  it('is split out by path, and the one on the branch is kept', () => {
    const { present, absent } = partitionByPresence(LISTED, TREE);
    expect(present.map((w) => w.path)).toEqual(['.github/workflows/deploy-azure-frontend.yml']);
    expect(absent.map((w) => w.path)).toEqual(['.github/workflows/zz-probe-guide-drift.yml']);
  });

  it('does not count `state`, which GitHub leaves active for a branch-only workflow', () => {
    const { absent } = partitionByPresence(LISTED, TREE);
    expect(absent[0].state).toBe('active');
  });

  it('would have been called broken had it been assessed, which is the row this removes', () => {
    expect(assessWorkflow(PROBE, OPTS).verdict).toBe('broken');
  });

  it('is named on its own line, after the verdicts, and does not make the report a finding', () => {
    const { present, absent } = partitionByPresence(LISTED, TREE);
    const results = assessAll(
      present.map((w) => (w.path === DEPLOY_FRONTEND.path ? DEPLOY_FRONTEND : PROBE)),
      OPTS
    );
    const text = renderReport(results, { staleDays: DEFAULT_STALE_DAYS, absent, defaultBranch: 'main' });
    expect(text).toContain('No workflow is failing-and-abandoned');
    expect(text).toContain('Not on `main`, run history only, not assessed: `.github/workflows/zz-probe-guide-drift.yml`');
    expect(text).not.toContain('- `.github/workflows/zz-probe-guide-drift.yml`');
    expect(results.some((r) => r.verdict === 'broken')).toBe(false);
  });

  it('names the default branch it read, not an assumed one', () => {
    const text = renderReport([], { staleDays: DEFAULT_STALE_DAYS, absent: [PROBE], defaultBranch: 'trunk' });
    expect(text).toContain('Not on `trunk`');
  });

  it('prints no such line when every listed workflow is on the branch', () => {
    const text = renderReport(assessAll([DEPLOY_FRONTEND], OPTS), { staleDays: DEFAULT_STALE_DAYS, absent: [] });
    expect(text).not.toContain('run history only');
  });
});

describe('treeRefusal', () => {
  it('accepts a directory listing', () => {
    expect(treeRefusal([{ path: '.github/workflows/ci.yml' }], 'main')).toBe(null);
    expect(treeRefusal([], 'main')).toBe(null);
  });

  it('refuses a payload that is not an array, rather than reading it as an empty directory', () => {
    // The contents API answers an object for a file; a missing path is a
    // 404 that `api()` already throws on, and this guard is the second line.
    // Treating any of them as "no files" would name every workflow absent
    // and assess nothing.
    expect(treeRefusal({ path: '.github/workflows', type: 'file' }, 'main')).toMatch(/not an array/);
    expect(treeRefusal(null, 'main')).toMatch(/not an array/);
    expect(treeRefusal({ message: 'Not Found' }, 'main')).toMatch(/not an array/);
  });

  it('refuses an entry with no usable path, and says which', () => {
    expect(treeRefusal([{ path: '.github/workflows/ci.yml' }, { name: 'x.yml' }], 'main')).toMatch(/Entry 1 /);
    expect(treeRefusal([{ path: '' }], 'main')).toMatch(/Entry 0 /);
  });

  it('names the branch it was asked for', () => {
    expect(treeRefusal(null, 'trunk')).toContain('on trunk');
  });
});

/**
 * The `failing` verdict (#1661): the last two scheduled runs both failed.
 *
 * The fixture is real, copied from the API on 2026-11-10 for
 * `update-avm-versions.yml`, the weekly workflow that #1658 found red two
 * weeks running. Until #1661 this file called it healthy (there is a success
 * in its sample), and it could never have been `broken` either: a weekly
 * workflow's newest run is never ten days old. Its history also holds an
 * earlier pair of failures (2026-10-06 and 2026-10-13) that went just as
 * unnoticed until a later run happened to pass.
 */
describe('a scheduled workflow that keeps failing (#1661)', () => {
  const NOV10 = { now: new Date('2026-11-10T12:00:00Z'), staleDays: DEFAULT_STALE_DAYS };
  const RUN = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/';
  const avm = (event, conclusion, created_at, id) => ({
    workflow_id: 367129209,
    event,
    status: 'completed',
    conclusion,
    created_at,
    html_url: `${RUN}${id}`,
  });
  /** Real: `GET /actions/workflows/367129209/runs?per_page=10` (it has 8 runs in all). */
  const AVM_RUNS = [
    avm('schedule', 'failure', '2026-11-10T06:38:22Z', 42769853620),
    avm('schedule', 'failure', '2026-11-03T06:38:11Z', 41591128676),
    avm('schedule', 'success', '2026-10-27T06:56:09Z', 40464057243),
    avm('workflow_dispatch', 'success', '2026-10-20T09:14:35Z', 39399242636),
    avm('schedule', 'success', '2026-10-20T06:53:21Z', 39383029293),
    avm('schedule', 'failure', '2026-10-13T14:28:18Z', 38413631920),
    avm('schedule', 'failure', '2026-10-06T13:30:32Z', 37471351063),
    avm('schedule', 'success', '2026-09-29T13:12:45Z', 36573458178),
  ];
  /** Real: the same with `&event=schedule`, which drops the one dispatched run. */
  const AVM = {
    path: '.github/workflows/update-avm-versions.yml',
    runs: AVM_RUNS,
    scheduledRuns: AVM_RUNS.filter((r) => r.event === 'schedule'),
  };
  const sched = (conclusion, created_at, event = 'schedule') => ({
    event,
    conclusion,
    created_at,
    html_url: `${RUN}${created_at.slice(0, 10)}`,
  });
  const wf = (scheduledRuns, runs = scheduledRuns) => ({ path: '.github/workflows/weekly.yml', runs, scheduledRuns });

  it('keeps the threshold at two, as a named constant', () => {
    expect(FAILING_SCHEDULED_RUNS).toBe(2);
  });

  it('calls update-avm-versions.yml failing on 2026-11-10, despite the success two weeks before', () => {
    const got = assessWorkflow(AVM, NOV10);
    expect(got.verdict).toBe('failing');
    // The line states its arithmetic and where to look, as the other verdicts do.
    expect(got.why).toContain('last 2 scheduled runs failed (2026-11-10, 2026-11-03)');
    expect(got.why).toContain('last success 2026-10-27');
    expect(got.why).toContain(`newest failed run ${RUN}42769853620`);
  });

  it('would have called it failing on 2026-10-13 too, the earlier pair nobody saw', () => {
    const before = AVM.scheduledRuns.filter((r) => r.created_at <= '2026-10-13T23:59:59Z');
    const got = assessWorkflow(wf(before), { now: new Date('2026-10-14T00:00:00Z'), staleDays: 10 });
    expect(got.verdict).toBe('failing');
    expect(got.why).toContain('(2026-10-13, 2026-10-06)');
  });

  it('does not fire on one failure after a success', () => {
    const got = assessWorkflow(
      wf([sched('failure', '2026-11-10T06:00:00Z'), sched('success', '2026-11-03T06:00:00Z')]),
      NOV10
    );
    expect(got.verdict).toBe('healthy');
  });

  it('does not fire on a single scheduled run, red or not', () => {
    expect(consecutiveScheduledFailures([sched('failure', '2026-11-10T06:00:00Z')])).toBeNull();
    expect(assessWorkflow(wf([sched('failure', '2026-11-10T06:00:00Z')]), NOV10).verdict).toBe('unproven');
  });

  it('steps over cancelled and skipped scheduled runs and still counts the two failures', () => {
    const got = assessWorkflow(
      wf([
        sched('cancelled', '2026-11-10T06:00:00Z'),
        sched('failure', '2026-11-09T06:00:00Z'),
        sched('skipped', '2026-11-08T06:00:00Z'),
        sched('cancelled', '2026-11-07T06:00:00Z'),
        sched('failure', '2026-11-06T06:00:00Z'),
        sched('success', '2026-11-05T06:00:00Z'),
      ]),
      NOV10
    );
    expect(got.verdict).toBe('failing');
    expect(got.why).toContain('(2026-11-09, 2026-11-06)');
    // The link is the newest FAILED run, not the newer cancelled one.
    expect(got.why).toContain(`${RUN}2026-11-09`);
  });

  it('does not count a cancelled run as the second failure', () => {
    const got = assessWorkflow(
      wf([
        sched('failure', '2026-11-10T06:00:00Z'),
        sched('cancelled', '2026-11-03T06:00:00Z'),
        sched('success', '2026-10-27T06:00:00Z'),
      ]),
      NOV10
    );
    expect(got.verdict).toBe('healthy');
  });

  it('does not count a failed run that was started by hand', () => {
    const dispatched = sched('failure', '2026-11-10T09:00:00Z', 'workflow_dispatch');
    const scheduled = [sched('failure', '2026-11-10T06:00:00Z'), sched('success', '2026-11-03T06:00:00Z')];
    // From the filtered listing, which should not carry it at all...
    expect(assessWorkflow(wf([dispatched, ...scheduled]), NOV10).verdict).toBe('healthy');
    // ...and from the mixed sample alone, when no filtered listing is given.
    expect(assessWorkflow({ path: 'x.yml', runs: [dispatched, ...scheduled] }, NOV10).verdict).toBe('healthy');
  });

  it('finds the pair in the mixed sample when no filtered listing is given', () => {
    expect(assessWorkflow({ path: AVM.path, runs: AVM_RUNS }, NOV10).verdict).toBe('failing');
  });

  it('does not need staleness: two fresh failures of a workflow that never succeeded are failing, not work in progress', () => {
    const got = assessWorkflow(
      wf([sched('failure', '2026-11-10T06:00:00Z'), sched('failure', '2026-11-03T06:00:00Z')]),
      NOV10
    );
    expect(got.verdict).toBe('failing');
    expect(got.why).toContain('no success in the runs read');
  });

  it('reports a workflow that is also broken as broken, once', () => {
    // Never succeeded, both scheduled runs failed, newest 20 days ago: both
    // rules match, and `broken` is the stronger claim.
    const got = assessWorkflow(
      wf([sched('failure', '2026-10-21T06:00:00Z'), sched('failure', '2026-10-14T06:00:00Z')]),
      NOV10
    );
    expect(got.verdict).toBe('broken');
    expect(got.why).toContain('2 of 2 sampled run(s) failed, none succeeded');
  });

  it('makes the run exit 1, the same as broken', () => {
    expect(hasFinding(assessAll([AVM], NOV10))).toBe(true);
    expect(hasFinding(assessAll([DEPLOY_FRONTEND], OPTS))).toBe(false);
    expect(hasFinding(assessAll([VALIDATE_DEPLOYED], OPTS))).toBe(true);
  });

  it('is listed in the report with its own heading, and the all-clear headline is not printed above it', () => {
    const text = renderReport(assessAll([AVM, DEPLOY_FRONTEND], NOV10), { staleDays: DEFAULT_STALE_DAYS });
    expect(text).toContain('**1 scheduled workflow(s) failed their last 2 scheduled runs in a row.**');
    expect(text).toContain('- `.github/workflows/update-avm-versions.yml` — last 2 scheduled runs failed');
    expect(text).not.toContain('No workflow is failing-and-abandoned');
  });

  it('prints both sections when one workflow is broken and another failing', () => {
    const text = renderReport(assessAll([AVM, VALIDATE_DEPLOYED], NOV10), { staleDays: DEFAULT_STALE_DAYS });
    expect(text).toContain('have never succeeded in the sampled window');
    expect(text).toContain('failed their last 2 scheduled runs in a row');
  });

  it('does not judge the workflow running the check, which would keep it red for ever', () => {
    const SELF = '.github/workflows/monitor-deploy-drift.yml';
    const got = assessWorkflow({ ...AVM, path: SELF }, { ...NOV10, selfPath: SELF });
    expect(got.verdict).toBe('healthy');
    expect(hasFinding([got])).toBe(false);
    const text = renderReport([got], { staleDays: DEFAULT_STALE_DAYS });
    expect(text).toContain(`Not judged as failing because it is the workflow running this check: \`${SELF}\``);
    // Any other workflow is still judged.
    expect(assessWorkflow(AVM, { ...NOV10, selfPath: SELF }).verdict).toBe('failing');
  });

  it('every fixture run carries the fields this verdict reads, as the API gave them', () => {
    for (const run of AVM_RUNS) {
      expect(['schedule', 'workflow_dispatch']).toContain(run.event);
      expect(run.html_url).toMatch(/^https:\/\/github\.com\/saulpatinojr\/HCW-HybridCloudWorks\/actions\/runs\/\d+$/);
      expect(run.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });
});

describe('findingsKey: what the monitor compares before commenting again (#1661)', () => {
  it('is empty when there is no finding', () => {
    expect(findingsKey([{ path: 'a.yml', verdict: 'healthy' }])).toBe('');
  });

  it('keys a broken workflow by path alone and a failing one by its newest failed run, sorted', () => {
    const key = findingsKey([
      { path: 'b.yml', verdict: 'failing', newestFailedRun: 'https://example.test/runs/2' },
      { path: 'a.yml', verdict: 'broken', why: 'grows every day' },
      { path: 'c.yml', verdict: 'unproven' },
    ]);
    expect(key).toBe('<!-- workflow-health findings: a.yml b.yml@https://example.test/runs/2 -->');
  });

  it('ends the report, hidden, only when there is a finding', () => {
    const text = renderReport([{ path: 'a.yml', verdict: 'broken', why: 'x' }], { staleDays: 10 });
    expect(text.split('\n').at(-1)).toBe('<!-- workflow-health findings: a.yml -->');
    expect(renderReport([], { staleDays: 10 })).not.toContain('workflow-health findings');
  });
});

describe('selfWorkflowPath', () => {
  it('reads the workflow file out of GITHUB_WORKFLOW_REF', () => {
    expect(
      selfWorkflowPath({
        GITHUB_REPOSITORY: 'saulpatinojr/HCW-HybridCloudWorks',
        GITHUB_WORKFLOW_REF:
          'saulpatinojr/HCW-HybridCloudWorks/.github/workflows/monitor-deploy-drift.yml@refs/heads/main',
      })
    ).toBe('.github/workflows/monitor-deploy-drift.yml');
  });

  it('is null outside Actions or for a ref from another repository', () => {
    expect(selfWorkflowPath({})).toBeNull();
    expect(selfWorkflowPath({ GITHUB_REPOSITORY: 'a/b' })).toBeNull();
    expect(
      selfWorkflowPath({ GITHUB_REPOSITORY: 'a/b', GITHUB_WORKFLOW_REF: 'c/d/.github/workflows/x.yml@refs/heads/main' })
    ).toBeNull();
  });
});

describe('runsRefusal with an event filter (#1661)', () => {
  const W = { path: '.github/workflows/update-avm-versions.yml', id: 367129209 };

  it('accepts a listing whose runs all came from the event asked for', () => {
    expect(runsRefusal({ workflow_runs: [{ workflow_id: W.id, event: 'schedule' }] }, W, { event: 'schedule' })).toBeNull();
    expect(runsRefusal({ workflow_runs: [] }, W, { event: 'schedule' })).toBeNull();
  });

  it('refuses a run from another event, or with none, rather than judging it as scheduled', () => {
    for (const run of [{ workflow_id: W.id, event: 'workflow_dispatch' }, { workflow_id: W.id }]) {
      const got = runsRefusal({ workflow_runs: [run] }, W, { event: 'schedule' });
      expect(got, JSON.stringify(run)).toContain('asked for event schedule');
      expect(got).toContain('nothing is asserted');
    }
  });

  it('does not look at the event when none was asked for', () => {
    expect(runsRefusal({ workflow_runs: [{ workflow_id: W.id, event: 'push' }] }, W)).toBeNull();
  });
});

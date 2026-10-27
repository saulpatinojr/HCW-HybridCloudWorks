# ADR 0026: Required checks filter inside the job, not at the trigger

**Status:** Accepted
**Decision date:** 2026-09-01
**Owners:** Workload owner

## Context

The `main` ruleset requires its status contexts on every pull request, and by
2026-09-01 there were fourteen of them: six build-and-test jobs from `ci.yml`
(frontend, functions, scripts, vps-agent, edge probe, Python harness), three
CodeQL analyses (javascript-typescript, python, actions), two IaC jobs
(`fmt, validate, tflint` and Trivy), `dependency-review`, the repository
policy validator, and the CodeQL rollup. Every one of them exists because of
a specific failure this repository actually had — a lockfile that disagreed
with its `package.json`, a sandbox flag list edit that shipped green because
nothing ran the vps-agent suite (T-743), a workflow that could push to `main`
past the ruleset because it held `contents: write` (T-726) — so none of them
is decorative.

The cost was that all fourteen ran in full on every pull request, whatever
the pull request touched. A documentation-only change — the most common PR
shape in a repository whose tracker, changelog and wiki are all in-repo —
paid for six `npm ci` installs, a complete frontend build with pre-rendering,
and three CodeQL analyses, roughly two to three minutes of wall clock and
nine-plus billed job-minutes, to validate files none of those jobs read.

The obvious fix — `paths:` filters on the `pull_request` trigger — is
foreclosed by a property of required contexts that this repository already
documented as the T-523 doctrine in `iac-validate.yml`: a required context
whose workflow was filtered out at the trigger is not auto-satisfied by
GitHub. The pull request sits at "Expected — waiting for status to be
reported" indefinitely. With trigger-level path filters, that would describe
most pull requests — a self-inflicted outage on the merge path.

## Considered options

1. **Do nothing.** Fourteen full runs per pull request; no risk, pure cost.
2. **Shrink the required-context list and add trigger-level `paths:` filters**
   to the workflows removed from it, in that order. Fewer visible checks and
   less compute — but each removed context is a merge gate that T-705's
   deploy guard and the manifest auto-merge path lean on, and the docs
   citing "twelve required contexts" as load-bearing would all need
   updating. The protection lost is exactly the protection those contexts
   were added to provide.
3. **Keep every context and move the filtering inside the job** — the
   pattern `iac-validate.yml` already runs in production (T-523, #220):
   check out with history, diff against the pull request's base, and when
   the job's dependency set did not change, skip the expensive steps while
   the job still completes and posts its context.

## Decision

Chosen option: **filter inside the job (option 3)**, because it removes the
waste without touching a single merge gate: all fourteen contexts still
report on every pull request, and the ruleset, the deploy guard, and the
documentation that reasons about required contexts are all undisturbed.

Two details of the implementation are the substance of the decision:

- **Each job's filter names its real dependency set, not its directory.**
  The functions tests read `infra/` Terraform source, `.azure/api-surface.json`
  and the `docs/content/blog-machine.md` grammar contract, so an infra or contract
  change still runs them. The scripts tests pin `.github/workflows/`
  contracts and `infra/roles`, so a workflow edit still runs them. CodeQL
  filters by language extension repository-wide, not by directory. A filter
  scoped to the component's own tree would have quietly disarmed exactly the
  cross-tree assertions this repository added on purpose.
- **Non-pull-request events bypass the filter entirely.** The push to `main`
  runs the full matrix — a merge is precisely when the combined result
  should be confirmed — and the weekly CodeQL schedule analyses everything,
  so a newly published query never waits for a pull request to touch the
  affected language.
- **A diff that cannot be computed fails toward running, not skipping.**
  `set -e` is inert inside an `if` condition, so the original
  pipe-into-grep shape read a failed `git diff` (an unfetchable base sha)
  as "no changes" and skipped required work — found by review on #319, and
  present in `iac-validate.yml`'s production copy since #220. Every detect
  step now captures the diff first and treats a capture failure as
  "run everything".

## Consequences

- **Positive:** a documentation-only pull request drops from two-to-three
  minutes of full-matrix work to nine roughly-ten-second no-ops; billed
  job-minutes per docs push drop by around eighty percent. Feedback on the
  checks that *do* run arrives with less queue contention. No ruleset
  change, no protection regression, no context renamed.
- **Negative:** the filter lists are hand-maintained dependency maps. A new
  cross-tree read added to a test suite without a matching filter update
  means that suite silently skips on the pull requests that should run it —
  the same failure class T-743 fixed once already. The mitigation is that
  pushes to `main` still run everything, so a wrongly-skipped suite fails at
  merge rather than never; but that is detection after the fact, not
  prevention. Reviewers of test changes should ask whether the filter moved
  with them (the code-review skill's checklists are the natural home for
  that question).
- **Risk accepted, stated before it can surprise:** the CodeQL rollup
  context's behaviour on a pull request where *zero* analyses upload results
  is unverified — the change shipping this decision could not test it,
  because touching workflows triggers the `actions` analysis. If the first
  docs-only pull request after merge hangs on an Expected CodeQL rollup, the
  remedy is removing that one rollup context from the ruleset (the three
  per-language analyses still gate) or reverting.
- **Follow-ups:** watch the first documentation-only pull request for the
  rollup behaviour above; extend the same doctrine comment to any future
  workflow that becomes a required context, so the next reader learns the
  rule from the file they are editing.

## Addendum, 2026-10-27 ([#1428](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1428))

Two weaknesses were closed in `ci.yml`: one named above (a missing filter entry
is found only at the merge) and one found while building
[#1427](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1427) (a
filter that `grep` cannot read). The decision itself, filtering inside the job
so that the required check names never change, is unchanged.

- **A filter that `grep` cannot read now fails the job instead of switching
  it off.** `grep -E` answers 0 (a changed file matches), 1 (none does) or 2
  (it could not read the pattern). The detect steps used to test that with
  `if grep ...`, which takes 2 as "no", so a broken filter skipped its job as
  "no relevant change". The four detect steps in `ci.yml` now keep the answer
  and fail on anything but 0 or 1, naming the job and the filter.
  `scripts/ci-workflow-steps.test.mjs` runs each of them against a deliberately
  broken filter. `codeql.yml` and `iac-validate.yml` have the same `if grep`
  shape and have not been changed yet.
- **The test that checks the filters now runs before the merge.** The
  "Negative" consequence above says a missing filter entry is found at the
  merge, after the fact. `scripts/ci-filters.test.mjs` (the check that every
  filter lists the files its tests read) used to run only when the scripts
  row's own filter matched, so a pull request that changed only a frontend or
  functions test met it on `main`. It now also runs in its own step on every
  pull request, outside the filter.

This decision is about cost, so the cost of the second change is stated here
too. A pull request that touches nothing a job's filter lists (a documentation-only
one, say) used to run the scripts row as a short no-op. That row now also installs
its packages and runs the guard, about 17 seconds more on a runner (a 5-second
install and a 12-second guard step, read from the job record of this change's own
CI run, [run 40484003062](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40484003062)).
The row is not on the longest path, so nobody waits longer, and runner time is
free on a public repository. If it ever matters, the guard can be skipped where the row's own
`Test` step already runs it.

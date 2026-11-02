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

Two weaknesses were closed, both in how a job decides whether it is needed:
one named above (a missing filter entry is found only at the merge, closed in
`ci.yml`) and one found while building
[#1427](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1427) (a
filter that `grep` cannot read, closed in `ci.yml` and then in `codeql.yml` and
`iac-validate.yml`). The decision itself, filtering inside the job so that the
required check names never change, is unchanged.

- **A filter that `grep` cannot read now fails the job instead of switching
  it off.** `grep -E` answers 0 (a changed file matches), 1 (none does) or 2
  (it could not read the pattern). The detect steps used to test that with
  `if grep ...`, which takes 2 as "no", so a broken filter skipped its job as
  "no relevant change". The four detect steps in `ci.yml` now keep the answer
  and fail on anything but 0 or 1, naming the job and the filter.
  `scripts/ci-workflow-steps.test.mjs` runs each of them against a deliberately
  broken filter. `codeql.yml` and `iac-validate.yml` had the same `if grep`
  shape and were fixed the same way in
  [#1429](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1429):
  `scripts/codeql-iac-workflow-steps.test.mjs` runs their detect steps too, and
  fails if an `if grep` returns to any workflow (the few that remain are listed
  there, each with its reason).
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

## Addendum, 2026-11-01: what the skip looks like on a pull request

The "Risk accepted" line above said the roll-up's behaviour on a pull request
where no analysis uploads results was unverified. Three pull requests on
2026-11-01 answered it, and also showed a side effect this record had not
named. Nothing about the decision changes; an accepted record is not rewritten,
so, as with the addendum above, what was learned is added here, and this is
written so the next reader does not spend time on a warning that is expected.

One precise word first. The `Analyze …` job never skips: its `Detect language
changes` step always runs and records whether the pull request changed a file
of that language, and it is the two CodeQL steps after it (initialise and
analyse) that skip when it did not. The check is therefore always posted, and
nothing is uploaded for that language.

GitHub posts its own `CodeQL` status on a pull request (the roll-up that code
scanning posts, separate from the three `Analyze …` jobs) as soon as the first
language uploads results, and that status lists every `/language:*` category
that ran on `main` but has not uploaded for the pull request yet. Whether the
list clears depends on why a category is missing.

- **When a language is still running, the warning clears itself.** On
  [#1485](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1485)
  (this addendum's own pull request, which edits `codeql.yml` and so runs all
  three languages), the `actions` analysis finished first and the status
  ([the same check run](https://github.com/saulpatinojr/HCW-HybridCloudWorks/runs/124785617486))
  read `2 configurations not found`, naming `javascript-typescript` and
  `python`, with the conclusion `neutral`. It stayed neutral while either was
  still running; about two minutes later, once both had uploaded, the same
  check run was updated in place to `No new alerts in code changed by this
  pull request` with the conclusion `success`. So the warning clears only
  after every analysis that is going to run has uploaded, and on a pull
  request where every language runs it is a snapshot taken too early that
  goes away on its own.
- **When a language skips, the warning stays, and that is the skip.** On
  [#1484](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1484),
  which changed JavaScript, JSON, Markdown and YAML only, the `actions` and
  `python` jobs skipped their analysis
  ([Analyze actions](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/41284680765/job/124783471447),
  [Analyze python](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/41284680765/job/124783471719),
  both green with `skipping analysis, still reporting this context` in the
  log). GitHub's own `CodeQL` status (the roll-up that code scanning posts
  after results arrive) then reported `2 configurations not found`, with the
  text "Code scanning cannot determine the alerts introduced by this pull
  request, because 2 configurations present on `refs/heads/main` were not
  found" and the two `/language:*` categories, and its conclusion was
  `neutral`
  ([the status](https://github.com/saulpatinojr/HCW-HybridCloudWorks/runs/124784100043)).
  Nothing will upload for a skipped language, so this status is never
  updated. The meaning is only that those two analyses ran on `main` and not
  on this pull request, which is exactly the skip. A pull request that changes no
  file of a language cannot introduce an alert in that language, and `main`
  is still analysed in full on every merge and on the weekly schedule, so no
  coverage is lost.
- **When every language skips, no roll-up is posted and nothing hangs.** On
  [#1458](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1458),
  which changed one JSON file, all three Analyze jobs skipped and reported
  green
  ([run 41259169180](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/41259169180)),
  and the commit carries no `CodeQL` status at all. The roll-up is not one of
  the ruleset's required checks any more (read from the `Default` ruleset on
  2026-11-01: the three `Analyze …` contexts are required, `CodeQL` is not;
  the Context section above counted it among the fourteen required contexts
  of 2026-09-01, and no record of when it left was found), so its absence,
  like its `neutral` conclusion, does not hold a merge. The risk named above
  did not materialise, and the first follow-up above ("watch the first
  documentation-only pull request for the rollup behaviour") is closed by
  this observation.
- **No official page explains the warning.** GitHub's troubleshooting hub
  ([Troubleshoot analysis errors](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors))
  and its
  [Results are different than expected](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/results-different-than-expected)
  page cover stale configurations, not this message, as of 2026-11-01. The
  comment above the `Detect language changes` step in `codeql.yml` now says
  the same thing in short, so the explanation is in the file a reader opens
  first.

The alternative, analysing every language on every pull request so the
warning never stays, is the cost this decision was taken to avoid, and the
warning carries no information the skip log does not. It is accepted and
documented rather than removed, and the accepted risk is recorded where this
repository keeps them, in the "Accepted risks" table of
[`TODO.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/TODO.md)
(linked by its GitHub address, because the docs site build rejects a relative
link to a file outside `docs/`).

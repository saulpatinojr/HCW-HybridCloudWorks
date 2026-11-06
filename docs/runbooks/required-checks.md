# Required checks and the `main` ruleset

**Audience:** whoever edits `.github/workflows/ci.yml`, renames a CI job, or
updates the repository's merge rules.
**Source of truth for the list:** `scripts/ruleset-contexts.test.mjs`.
**History:** [#1545](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1545)
and [ADR 0026](../decisions/0026-required-checks-filter-inside-the-job.md).

## What the ruleset is

The `Default` ruleset (id 20680114,
[settings page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/rules/20680114))
is the repository's set of merge rules for `main`. One of its rules,
`required_status_checks`, names the checks that must be green before a pull
request can merge, and it is "strict": the pull request's head must be up to
date with `main` as well. A "check" here is the name of a workflow job, as it
appears in the pull request's checks list.

## The required list

Five checks. `gate` stands for everything in `ci.yml`; the other four are
jobs of workflows that are still separate.

| Check | Workflow | What it covers |
|---|---|---|
| `gate` | `ci.yml` | Every CI job: the verify matrix (frontend, functions, scripts, vps-agent, edge; only the rows whose files changed exist, see "The verify matrix is built from the path filter" below), the frontend unit suite's two shards (`frontend-unit`) and their merge (`frontend-unit-merge`), the browser suites' two shards (`e2e`), the lab-host lint, the lab-host role tests, the Coder template checks, the Python harness, the complexity delta and (after a merge) the coverage upload. `gate` waits for all of them and fails if any failed or was cancelled; a job skipped because the change did not touch its files is fine (a shard of a skipped suite, and the merge after skipped shards, count as skipped too). See "The two slow suites run as shards" below. |
| `Validate root and documentation policy` | `repository-policy.yml` | Repository layout, the redaction gate, PowerShell syntax and the Pester tests. |
| `dependency-review` | `dependency-review.yml` | New dependencies with known vulnerabilities or disallowed licences. |
| `fmt, validate, tflint` | `iac-validate.yml` | Terraform formatting, validation and TFLint for `infra/` and `infra-lab/`. |
| `Trivy IaC misconfiguration scan` | `iac-validate.yml` | Trivy's misconfiguration scan of the same two roots. |

What left the list with #1545: the ten single CI job names (`frontend`,
`functions (azure)`, `scripts (operations)`, `vps-agent`, `harness (python)`,
`ansible-lint (lab-host)`, `coder (lab-host)`, `e2e (playwright)` and the
former Coverage and Complexity Delta workflows' jobs, which are now CI jobs
under `gate`), and the three CodeQL contexts (`Analyze javascript-typescript`,
`Analyze actions`, `Analyze python`). The owner applied the list on
2026-11-04 (14:11 UTC, read back from the API), and the second pull request of
#1545 then moved CodeQL off pull requests; see "CodeQL runs after the merge"
below.

## CodeQL runs after the merge, not before it (2026-11-04)

`codeql.yml` runs on every push to `main` and every Monday, and no longer on
pull requests. While its three `Analyze …` contexts were required, the
workflow had to run on every pull request (a required check whose workflow
never ran is never satisfied, ADR 0026) and carried a detect step per
language so that a pull request with no file of that language skipped the
analysis. With `gate` the only CI context the ruleset names, that run, its
detect step and its shape test went.

What this trades away, in plain words:

- **An alert lands after the merge.** A change that introduces a CodeQL
  finding is merged first and flagged a few minutes later, by the push run
  on `main` (about four minutes for the three languages). Before, the
  finding was on the pull request. So the session that merges looks at
  [code scanning](https://github.com/saulpatinojr/HCW-HybridCloudWorks/security/code-scanning)
  after the merge and fixes a new alert in a follow-up pull request; the
  alert's own page says which commit introduced it.
- **Code scanning's review comments on pull requests go away.** They were
  the one thread type a session could not resolve itself when the alert was
  intended (the owner dismissed the alert instead, `.claude/CLAUDE.md`,
  "A code scanning alert is fixed in code, or dismissed by the owner"). That
  dismissal step now happens on the alert's page after the merge, with no
  pull request thread to close.
- **What does not change:** every language is analysed in full on every
  merge and every Monday, as before; the weekly run is what finds a newly
  published query's matches in code nobody touched.

To put CodeQL back on pull requests: add `pull_request: { branches: [main] }`
to the `on:` block of `codeql.yml` (the ruleset does not need to change, since
its contexts are not required), and consider bringing back the per-language
detect step from the version before #1545's second pull request, or every
pull request pays the full four minutes.

## Why `gate` is safe, and why it reads each result itself

GitHub counts a job that was skipped by its own `if:` as a passing check: the
table on
[Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
(read 2026-11-04) says "A job is skipped by a conditional: the job reports
Success", and lists `success`, `skipped` and `neutral` as the successful
statuses. That is what lets the `e2e`, `ansible-lint`, `coder-template` and
`harness` jobs skip outright on a change that does not touch their files.

The same page warns about the other side: a job that is skipped because a job
it depends on failed "may not block merging". A gate that relied on GitHub's
default (`gate` is skipped when a needed job fails) would therefore count as
passing on exactly the failure it exists to catch. So `gate` runs with
`if: ${{ !cancelled() }}`, which keeps it running whatever happened above it,
and its one step reads the `needs` context (the result of every job it names:
`success`, `failure`, `cancelled` or `skipped`, per
[Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts))
and fails on any `failure` or `cancelled`.

What still must not happen: a `paths:` filter on the `pull_request` trigger of
`ci.yml`. A workflow that never ran posts nothing, and the same page says
those checks "stay in a Pending state and block merging". The filtering lives
inside the workflow (ADR 0026).

## Applying the list to the ruleset (cut-over for #1545)

Order matters. The pull request that adds `gate` must merge under the old
list, so the old fifteen job names are all still declared in the workflows;
then the ruleset is updated; then follow-ups may rename or remove jobs. A
pull request opened in the minutes between the merge and the update is fine
either way: the old names are posted (as "skipped" when not needed), and
skipped counts as passing.

1. Confirm the `gate` job exists on `main`:
   [ci.yml on main](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/ci.yml)
   ends with a job whose `name:` is `gate`. If it does not, stop: the pull
   request for #1545 has not merged.
2. Build the payload from the ruleset as it is **now**, not from a copy in
   this page: the API replaces the whole ruleset with what it is sent, so a
   rule added since this page was written (a new merge protection, say)
   would be lost if a saved copy were sent. The line below reads the live
   ruleset, keeps every rule as it is, and swaps only the
   `required_status_checks` list for the five above. These are session
   commands (the cut-over is a session's step, not the owner's), so they are
   bash, for Git Bash, one line each.

   The line below is bash:

   ```bash
   gh api repos/saulpatinojr/HCW-HybridCloudWorks/rulesets/20680114 --jq '{name, target, enforcement, bypass_actors, conditions, rules: [.rules[] | if .type == "required_status_checks" then .parameters.required_status_checks = [{context: "gate", integration_id: 15368}, {context: "Validate root and documentation policy", integration_id: 15368}, {context: "dependency-review", integration_id: 15368}, {context: "fmt, validate, tflint", integration_id: 15368}, {context: "Trivy IaC misconfiguration scan", integration_id: 15368}] else . end]}' > "$HOME/ruleset-1545.json"
   ```

   `integration_id` 15368 is GitHub Actions, the app that posts every one of
   these checks; it is the value the API returned for every context in the
   old list. Then read the file once before sending it: it should hold the
   four rules read on 2026-11-04 (`deletion`, `non_fast_forward`,
   `pull_request` with `required_review_thread_resolution: true` and
   `required_approving_review_count: 0`, and `required_status_checks` with
   `strict_required_status_checks_policy: true`), plus any rule added since,
   and the five contexts. If a rule you did not expect is there, stop and
   find out why before going on; the payload keeps it either way.
3. Apply it. The line below is bash:

   ```bash
   gh api -X PUT repos/saulpatinojr/HCW-HybridCloudWorks/rulesets/20680114 --input "$HOME/ruleset-1545.json" --jq '.updated_at'
   ```

   A successful call prints the new `updated_at` time. An HTTP 422 names the
   field it did not accept; an HTTP 404 means the token cannot administer the
   repository (the owner's own `gh auth login` can). The endpoint is
   documented on
   [REST API endpoints for rules](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)
   ("Update a repository ruleset").
4. Read it back and compare with the table above. The line below is bash:

   ```bash
   gh api repos/saulpatinojr/HCW-HybridCloudWorks/rulesets/20680114 --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
   ```

   Expected: the five names, one per line, and nothing else.
5. Open a pull request's checks list, for example
   <https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1549/checks> (the
   pull request that made this change): it should show `gate` among the
   required checks and the old single job names as plain (not required)
   checks. Then edit `.claude/CLAUDE.md`'s ruleset bullet to drop the "takes
   effect when the ruleset is updated" wording, and record the date here.

   **Done 2026-11-04.** A session's `PUT` was refused by its safety check as
   a CI bypass, so the owner applied the payload; the read-back at 14:11 UTC
   showed the five contexts and `strict_required_status_checks_policy:
   true`, and the CLAUDE.md wording was dropped in the second pull request
   of #1545.

**Rollback:** build the payload the same way (step 2, from the live ruleset)
with the twelve old contexts that are still job names on pull requests (the
ten single CI job names `frontend`, `functions (azure)`, `scripts
(operations)`, `vps-agent`, `harness (python)`, `ansible-lint (lab-host)`,
`coder (lab-host)`, `e2e (playwright)`, plus `Validate root and documentation
policy`, `dependency-review`, `fmt, validate, tflint` and `Trivy IaC
misconfiguration scan`) in place of the five, and send the same `PUT`. The
three CodeQL `Analyze …` contexts cannot go back on the list until
`codeql.yml` runs on pull requests again (the section above says how); a
required context no workflow posts blocks every merge.

## Renaming a CI job after the cut-over

A job inside `ci.yml` can be renamed, added or removed freely: `gate` is the
only CI context the ruleset names, and `scripts/ci-workflow-steps.test.mjs`
checks that `gate` needs every other job. Renaming one of the other four
required jobs, or `gate` itself, still needs the ruleset edited in the same
change, as before.

## The verify matrix is built from the path filter (2026-11-04)

The `verify` job is a matrix (one job run per row) of five rows: `frontend`,
`functions (azure)`, `scripts (operations)`, `vps-agent` and
`edge (availability probe)`. Until the third pull request of #1545 every row
started a runner on every pull request and, when its files had not changed,
exited after 8 to 13 seconds, because a matrix row cannot carry an `if:` of
its own (measured on the docs-only
[#1555](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1555),
[run 41889186903](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/41889186903)).

Now the `changes` job decides each row's filter, in one detect step per row
(the comments above each step are the reasons for the paths in its filter),
and its last step, "Build the verify matrix", writes the matrix as JSON: the
rows whose files changed, in the matrix's own shape. The `verify` job reads
it with `matrix: ${{ fromJSON(needs.changes.outputs.verify) }}`, so a row
whose files did not change is never created and starts no runner. How that
works is on
[Running variations of jobs in a workflow, "Using an output to define two matrices"](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations#using-an-output-to-define-two-matrices)
(GitHub Docs, read 2026-11-04). The rows themselves (folder, Node line, commands) are the
`ROWS` list in that step, written as YAML so that
`scripts/version-floors.json` can still hold the functions row to Node.js 24;
`yq` (on the runner image) turns the list into JSON and `jq` picks the rows.

Two things to know when editing it:

- **The `scripts (operations)` row is always in the matrix** (`always: true`
  in `ROWS`). Three of its steps run on every pull request whatever changed
  (the OIDC subjects check, the former-owner URL check and the path-filter
  guard, #1001, #1009, #1428), so the row exists even on a docs-only change,
  with `relevant=false`, and runs only those guards. Because of it the
  matrix is never empty, which is why `verify` has no `if:` of its own.
- **The row's answer travels as `matrix.relevant`.** The row's lint, build
  and test steps run when it is `'true'`; a row other than scripts is only
  ever created with `'true'`. On a push to `main` every row is created and
  relevant, as before.

`scripts/ci-workflow-steps.test.mjs` runs the five detect steps and the build
step with bash (where `jq` and `yq` exist; always on GitHub Actions) and
checks the matrix for a docs-only change (the scripts row alone), a frontend
change and a push, against the same answer worked out in JavaScript
(`verifyMatrix` in `scripts/lib/ci-filters.mjs`). `scripts/ci-filters.test.mjs`
still checks that every row's filter lists every file its tests read.

## The two slow suites run as shards (2026-11-04)

A shard is one part of a test suite, run on its own runner at the same time
as the other parts, so the suite finishes in a fraction of the time. The
measurement that asked for it is on
[#1545](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1545#issuecomment-6640623195):
on the frontend-only
[#1557](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1557)
([run 41900589838](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/41900589838))
the `frontend` row took 280 s, 192 s of it the vitest run with coverage and
43 s the lint, and `e2e (playwright)` took 247 s, 195 s of it the browser
suites, so the pull request reached all-green 302 s after the push against a
target of under 240 s. No placeholder job was left; the two real suites set
the time. Since the fourth pull request of #1545 each runs as two shards:

- **The frontend unit suite** left the `frontend` row (which keeps lint,
  format, route validation and the build) for the `frontend-unit` job, a
  matrix of two shards. Each shard runs `npm run test:shard -- --shard=N/2`
  (`frontend/package.json`): vitest splits the test files in two, the shard
  collects coverage for its half and writes a blob report (one file holding
  its results and its coverage) under `frontend/.vitest/blob/`, which the
  job keeps as an artifact. The shard checks no coverage threshold: half a
  suite is always under the ratchet (shard 1 of 2 measured 48% of lines
  against the 75.5% threshold), and vitest checks a shard's coverage like
  any other run's, so the script sets every threshold to 0 for that run.
  The `frontend-unit-merge` job then downloads both blobs and runs
  `npm run test:merge` (`vitest run --merge-reports --coverage`), which
  reports as if the suite had run once and checks the thresholds in
  `frontend/vitest.config.js` on the whole suite; after a merge to `main`
  its `coverage/lcov.info` is what `coverage (qlty)` uploads. The merge job
  has no `if:` of its own: when the shards were skipped it is skipped with
  them, and when a shard failed it is skipped and `gate` fails on the shard.
  Vitest's own description is on
  [Improving Performance, "Sharding"](https://vitest.dev/guide/improving-performance.html#sharding)
  and [Reporters, "Blob Reporter"](https://vitest.dev/guide/reporters.html#blob-reporter)
  (read 2026-11-04).
- **The browser suites** run as two Playwright shards of the `e2e` job
  (`--shard=N/2`), each with its own build and preview server and its own
  report kept on failure (`playwright-report-shard-N`). Nothing merges the
  two reports: a failed shard's report names the test that failed.

`scripts/ci-workflow-steps.test.mjs` holds the shape: two shards each, the
shard and merge commands, the frontend row without a `test:` line, the
artifact names and `gate` needing every job.

## Merge queue: evaluated, not adopted (2026-11-04)

The strict rule means every merge to `main` makes every other open pull
request "behind", and an "Update branch" re-runs its checks. A merge queue is
GitHub's answer to that: it "provides the same benefits as the Require
branches to be up to date before merging branch protection", by building the
merged result on a temporary branch and running the checks there once, so
authors do not update their branch by hand
([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
read 2026-11-04).

Recommendation: **not yet**, for three reasons, each from that page.

1. Every workflow that posts a required check must also listen for the
   `merge_group` event, or "the required check is never reported and the
   merge fails". That is five required checks across four workflow files to change in one step, with the
   ruleset.
2. A merge is then an "add to queue", not a merge. The repository's review
   loop (a reviewer's verdict on the current head, the three-round cap,
   sessions merging their own pull requests) is written around the merge
   button; it would need rewriting for a queue.
3. The page does not say which plans or repository visibilities offer merge
   queues; that was not verified for this public repository on its plan.

What #1545 does instead removes most of the cost the queue would address: a
docs-only re-run after "Update branch" is now the `changes` job, the
scripts row of the verify matrix (the other four rows are not created, see
the section above), the policy and dependency checks, and `gate`. If
the re-run storm is still a problem after the measurements the issue asks
for, the queue is the next step, and this section is where to record it.

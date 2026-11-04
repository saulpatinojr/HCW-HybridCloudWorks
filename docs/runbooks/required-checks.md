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
| `gate` | `ci.yml` | Every CI job: the verify matrix (frontend, functions, scripts, vps-agent, edge), the browser suites, the lab-host Ansible and Coder checks, the Python harness, the complexity delta and (after a merge) the coverage upload. `gate` waits for all of them and fails if any failed or was cancelled; a job skipped because the change did not touch its files is fine. |
| `Validate root and documentation policy` | `repository-policy.yml` | Repository layout, the redaction gate, PowerShell syntax and the Pester tests. |
| `dependency-review` | `dependency-review.yml` | New dependencies with known vulnerabilities or disallowed licences. |
| `fmt, validate, tflint` | `iac-validate.yml` | Terraform formatting, validation and TFLint for `infra/` and `infra-lab/`. |
| `Trivy IaC misconfiguration scan` | `iac-validate.yml` | Trivy's misconfiguration scan of the same two roots. |

What left the list with #1545: the ten single CI job names (`frontend`,
`functions (azure)`, `scripts (operations)`, `vps-agent`, `harness (python)`,
`ansible-lint (lab-host)`, `coder (lab-host)`, `e2e (playwright)` and the
former Coverage and Complexity Delta workflows' jobs, which are now CI jobs
under `gate`), and the three CodeQL contexts (`Analyze javascript-typescript`,
`Analyze actions`, `Analyze python`). CodeQL keeps running on pull requests for
now; a follow-up moves it to pushes to `main` and the weekly schedule once the
ruleset no longer requires its contexts.

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
2. Write the payload below to a file (the lines are bash, for Git Bash, as a
   session runs them). It is the whole ruleset, because the API replaces the
   ruleset with what it is sent: the three unchanged rules are repeated
   exactly as read from the API on 2026-11-04, and only the
   `required_status_checks` list differs.

   ```bash
   cat > "$HOME/ruleset-1545.json" <<'JSON'
   {
     "name": "Default",
     "target": "branch",
     "enforcement": "active",
     "bypass_actors": [],
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       {
         "type": "pull_request",
         "parameters": {
           "allowed_merge_methods": ["merge", "squash", "rebase"],
           "dismiss_stale_reviews_on_push": true,
           "require_code_owner_review": false,
           "require_extra_approval_for_unattributed_changes": false,
           "require_last_push_approval": false,
           "required_approving_review_count": 0,
           "required_review_thread_resolution": true,
           "required_reviewers": []
         }
       },
       {
         "type": "required_status_checks",
         "parameters": {
           "do_not_enforce_on_create": false,
           "strict_required_status_checks_policy": true,
           "required_status_checks": [
             { "context": "gate", "integration_id": 15368 },
             { "context": "Validate root and documentation policy", "integration_id": 15368 },
             { "context": "dependency-review", "integration_id": 15368 },
             { "context": "fmt, validate, tflint", "integration_id": 15368 },
             { "context": "Trivy IaC misconfiguration scan", "integration_id": 15368 }
           ]
         }
       }
     ]
   }
   JSON
   ```

   `integration_id` 15368 is GitHub Actions, the app that posts every one of
   these checks; it is the value the API returned for every context in the
   old list.
3. Apply it (bash):

   ```bash
   gh api -X PUT repos/saulpatinojr/HCW-HybridCloudWorks/rulesets/20680114 --input "$HOME/ruleset-1545.json" --jq '.updated_at'
   ```

   A successful call prints the new `updated_at` time. An HTTP 422 names the
   field it did not accept; an HTTP 404 means the token cannot administer the
   repository (the owner's own `gh auth login` can).
4. Read it back and compare with the table above (bash):

   ```bash
   gh api repos/saulpatinojr/HCW-HybridCloudWorks/rulesets/20680114 --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
   ```

   Expected: the five names, one per line, and nothing else.
5. Open any pull request's checks list: it should show `gate` among the
   required checks and the old single job names as plain (not required)
   checks. Then edit `.claude/CLAUDE.md`'s ruleset bullet to drop the "takes
   effect when the ruleset is updated" wording, and record the date here.

**Rollback:** send the same `PUT` with the old fifteen contexts
(`PRE_1545_REQUIRED_CONTEXTS` in `scripts/ruleset-contexts.test.mjs`) in
place of the five. Every one of them is still a job name, so the old list
works unchanged.

## Renaming a CI job after the cut-over

A job inside `ci.yml` can be renamed, added or removed freely: `gate` is the
only CI context the ruleset names, and `scripts/ci-workflow-steps.test.mjs`
checks that `gate` needs every other job. Renaming one of the other four
required jobs, or `gate` itself, still needs the ruleset edited in the same
change, as before.

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
   merge fails". That is five workflows to change in one step, with the
   ruleset.
2. A merge is then an "add to queue", not a merge. The repository's review
   loop (CodeRabbit's approval of the current head, the three-round cap,
   sessions merging their own pull requests) is written around the merge
   button; it would need rewriting for a queue.
3. The page does not say which plans or repository visibilities offer merge
   queues; that was not verified for this public repository on its plan.

What #1545 does instead removes most of the cost the queue would address: a
docs-only re-run after "Update branch" is now the `changes` job, five
seconds-long matrix rows, the policy and dependency checks, and `gate`. If
the re-run storm is still a problem after the measurements the issue asks
for, the queue is the next step, and this section is where to record it.

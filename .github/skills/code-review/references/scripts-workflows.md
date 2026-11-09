# Operational scripts and CI review — `scripts/`, `.github/workflows/`

`scripts/` holds Node 26 ESM operational tooling (Vitest-tested, ESLint) and
PowerShell operator scripts. `.github/workflows/` holds CI, validation,
monitors, and manual release workflows — all on GitHub-hosted runners.

## What to check in the diff

### `scripts/*.mjs`
- Every non-trivial script here has a sibling `*.test.mjs`; changed behavior
  without a test change is a flag. The tests run with `npm test` from
  `scripts/` (the same command `ci.yml` runs).
- Several scripts are **workflow contracts** — they're invoked by a workflow
  with specific inputs/outputs, and some have invocation tests pinning that
  (`check-unresolved-secrets.invocation.test.mjs`,
  `check-workflow-health.invocation.test.mjs`, `manifest-workflow.test.mjs`,
  `workflow-write-permissions.test.mjs`, `oidc-subjects.test.mjs`). When a
  script's CLI or output changes, find and review the workflow that calls it
  in the same pass — a script that writes its refusal to stderr and a job that
  captures only stdout each look correct alone.
- Scripts that hit Azure (`smoke-deployed.mjs`, container-spec generation)
  use `@azure/identity` — no keys, no connection strings. Scripts that hit
  GitHub use the app-token helper (`github-app-token.mjs`), not PATs.
- Monitors (`check-deploy-drift.mjs`, `check-unresolved-secrets.mjs`,
  `check-tfc-plan.mjs`, `assert-expected-plan.mjs`,
  `check-workflow-health.mjs`) exist to distinguish real failures from
  reporting failures — review that error paths exit non-zero and that
  "success" means the thing actually verified, not that the command ran
  (this repo has been burned by that distinction; see `.claude/CLAUDE.md`).
  `check-workflow-health.mjs` splits that three ways rather than two: it
  exits 2 when it could not read the run history at all, because "I could
  not look" and "I looked and it is fine" are opposite conclusions.

### PowerShell (`*.ps1`)
- Must pass `scripts/validate-powershell.ps1` (parse and encoding) and its
  own tests, `scripts/validate-powershell.tests.ps1`. Owner-pasteable commands
  follow the CLAUDE.md rules: no placeholders, no bash-isms, one line where
  possible.
- `validate-repository-structure.ps1` is the Markdown allowlist — a diff
  extending the allowlist deserves scrutiny: the usual right fix is moving
  the doc to `docs/`, not growing the allowlist.

### Workflows (`.github/workflows/*.yml`)
- **Permissions**: each workflow declares least-privilege `permissions:`;
  `workflow-write-permissions.test.mjs` pins which workflows may write.
  A new `write` scope is a finding unless justified.
- **Pinning**: third-party actions pinned per repository policy
  (dependency-review and repository-policy workflows enforce).
- **Runtime versions**: `node-version:` is `'26'`, except where the job
  builds, tests, deploys or runs `functions/` code, which is `'24'` (the
  Flex Consumption ceiling). `scripts/version-floors.test.mjs` fails a pin
  below its floor in `scripts/version-floors.json`; a new functions pin also
  needs its selector added to `platformCeilings.functions.appliesTo`.
- **Runner image**: every job's `runs-on` names the Ubuntu release
  (`ubuntu-26.04`), exactly the one `kinds.ubuntu.platformCeilings.runners`
  records, never `ubuntu-latest`, which GitHub moves on its own schedule.
  `scripts/version-floors.test.mjs` fails any other label, and
  `update-version-floors.yml` moves the ceiling when GitHub makes the next LTS
  generally available. A new `ubuntu-latest` is a finding.
- **No auto-apply/auto-deploy, with one approved exception**: the
  functions release is an explicit manual dispatch (`deploy-functions.yml`)
  and Terraform applies only via HCP Terraform review. The exception is
  `deploy-azure-frontend.yml`, which also runs on a push to `main` that
  changes `frontend/**` (owner decision 2026-11-09, #1613). It deploys with
  no approval: the owner removed the required reviewers from the `production`
  environment the same day. Its controls are the trigger's `branches: [main]`
  and the main-only guard step in its build job. Any other trigger change that
  makes deployment automatic on push/merge is blocking, and so is widening
  that exception: more branches or tags, more paths than `frontend/**`,
  removing the guard step, or dropping `environment: production` from its
  deploy job (its Azure sign-in matches on that name). Because
  `deploy-functions.yml` uses the same `production` environment, the backend
  deploy has no approval either until #1617 moves it to a reviewed
  `production-backend`; until then, anything that lets the backend deploy
  start by itself is blocking too.
- **Untrusted input**: no `pull_request_target` with checkout of PR code, no
  interpolation of PR titles/bodies/branch names into `run:` shells.
- **Monitors** (`monitor-*.yml`, `verify-alert-state.yml`): check schedule
  frequency against cost/noise and that failure actually surfaces (creates an
  issue / fails visibly) rather than dying silently. A monitor that cannot
  pass from a GitHub-hosted runner is not a monitor: `validate-deployed.yml`
  was deleted on 2026-09-08 after twenty-one days red.

## Verification commands

Run from `scripts/` — including for workflow-only diffs: several tests in
this suite (`workflow-write-permissions.test.mjs`, the invocation tests) pin
`.github/workflows/` content, so a workflow change can fail them without
touching any `.mjs` file:

```bash
npm run lint
npm test
```

PowerShell validation (`pwsh` required — note in the report if unavailable):

```powershell
./scripts/validate-powershell.ps1
./scripts/validate-repository-structure.ps1
```

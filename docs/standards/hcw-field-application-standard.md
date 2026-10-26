# HCW field application standard

Version 1.0, drafted 2026-10-25 for ticket [PF-2 (#255)](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/255).
It is the one shared rulebook for the four field application repositories, and
the place that records, in the open, where a repository follows it and where it
does not yet.

The four repositories (each is the upstream "App" of a product; the web-front
"AddOn" editions are covered by the
[AddOn integration standard](addon-integration-standard.md) and are out of scope
here):

| Short name | Repository | Default branch head read on 2026-10-25 |
| --- | --- | --- |
| NE | [HCW-NetworkEyes_App](https://github.com/saulpatinojr/HCW-NetworkEyes_App) | `940cbb6e` |
| CC | [HCW-CloudCrawler_App](https://github.com/saulpatinojr/HCW-CloudCrawler_App) | `fa1f38a5` |
| CA | [HCW-CloudAssessor_App](https://github.com/saulpatinojr/HCW-CloudAssessor_App) | `190052bf` |
| MO | [HCW-MigrateOrchestrator_App](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App) | `2d90dd0` |

This page is accurate only as of the commits above. The repositories change
every day (CloudAssessor gained its contributing files, issue forms and release
guard on the day this page was written), so re-read a row before relying on it.

## 1. How to read this page

- **MUST** means every repository does it, or has a written exception in
  section 6. **SHOULD** means every repository does it unless it has a reason,
  and a missing one becomes a ticket. **MAY** is a choice the repository owns.
- Every statement about a repository was read from its default branch, the
  GitHub settings API or a workflow dry run on 2026-10-25. Nothing here was
  taken from memory. Where a fact could not be checked, the page says so (see
  section 9).
- The comparison starts from the table in
  [pull request #289](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/289)
  (merged 2026-10-25) and re-reads every row. Where this page disagrees with
  that table, this page is the newer reading: for example CloudAssessor's
  Dependabot now uses `uv` (fixed after the ticket was written), and
  CloudCrawler's Dependabot file lists only `github-actions` and `uv`.
- Words used: a **ruleset** is a repository's merge rules; a **SHA pin** names
  an action by its full commit hash instead of a movable tag; **OIDC** is a
  short-lived login that a workflow exchanges for a credential, so no password
  is stored; **provenance** is a signed statement of which workflow built an
  artifact; an **SBOM** (software bill of materials) lists the components in
  it; a **digest** is the exact content hash of an image; **CodeQL** is
  GitHub's code scanner; **Dependabot** opens pull requests for outdated
  dependencies; **Trivy**, **hadolint** and **actionlint** are scanners and
  linters for images, Dockerfiles and workflows; a **dry run** prints what a
  task would change without changing it; an **ADR** is an architecture
  decision record; a **composite action** is a reusable bundle of workflow
  steps kept in `.github/actions/`.
- The owner decides what is mandatory. Items marked **Owner decision** are
  proposals until the owner answers on
  [PF-2](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/255).

## 2. Requirements

### 2.1 Identity

| ID | Level | Requirement | Evidence it can be done |
| --- | --- | --- | --- |
| ID-1 | MUST | A public repository named `HCW-<Product>_App` for the upstream App (the AddOn is `HCW-<Product>_AddOn`). The default branch is `main`. | All four. MO was renamed from `HCW-AzMigrateOrchestrator_App` (noted in [#289](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/289); this repository's [CHANGELOG](../repo/changelog.md) records that the App had already been renamed when the AddOn was renamed on 2026-10-24). |
| ID-2 | MUST | A one-sentence description that names the product and says it is the upstream engine or appliance. | All four have one. |
| ID-3 | SHOULD | Topics (five to eight) and a homepage that points at the product's page on hybridcloudworks.com. | CA has topics and a homepage that points at its product page. MO has topics and a homepage that is the site root. NE and CC have no topics, and CC has no homepage. |
| ID-4 | MUST | A `LICENSE` file, and a `NOTICE` file when third-party material is redistributed. The proposed default licence is MIT unless the owner decides otherwise. | LICENSE in all four; MIT in CC, CA, MO and Apache-2.0 in NE; NOTICE in CA and MO only. **Owner decision** (E-1). |
| ID-5 | MUST | "Automatically delete head branches" is on, so merged branches do not pile up. | On in NE, CA, MO; off in CC. |
| ID-6 | SHOULD | The repository wiki is off. Documentation lives in the repository and in the umbrella documentation site ([ADR 0027](../decisions/0027-documentation-site.md), which retired the wiki on 2026-09-06). Discussions stay off until an owner decision turns them on. (An ADR is an architecture decision record, see DOC-6.) | Wiki is off in NE and MO, on in CC and CA. CA's own rules name the wiki as a documentation home (E-4). |

### 2.2 Documentation

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| DOC-1 | MUST | The `README.md` has these sections, in this order, using these words in the headings: what it is, Status, Quick start (the commands that work on a clean machine), Configuration (points at `.env.example`), Repository layout, Documentation, Contributing, security and licence. | None of the four matches yet; see the README outlines in section 4. |
| DOC-2 | MUST | `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): an `## [Unreleased]` section on top, then `## [X.Y.Z] - YYYY-MM-DD` sections. It records completed work only. | NE, CC, CA follow it. MO's headings are `## 0.2.1 — 2026-10-04 (…)` and `## Unreleased`, and it does not mention the format. |
| DOC-3 | MUST | `CLAUDE.md` at the repository root, with the section "How to communicate with the owner" (plain words, numbered steps for the owner, links to what is named). | All four have it ([NE](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/CLAUDE.md), [CC](https://github.com/saulpatinojr/HCW-CloudCrawler_App/blob/main/CLAUDE.md), [CA](https://github.com/saulpatinojr/HCW-CloudAssessor_App/blob/main/CLAUDE.md), [MO](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/blob/main/CLAUDE.md)). |
| DOC-4 | MUST | The repository's documentation model (which markdown files may exist and where) is written down in `CLAUDE.md` or the README. | NE (seven root documents), CA (five root documents) and MO (`docs/` tree) state it. CC states it only through its ADR folder. |
| DOC-5 | SHOULD | A script checks the documentation model in CI. | NE (`validate_documentation_model.py`) and CA (`scripts/check-docs-governance.py`) have one. CC and MO have none found. |
| DOC-6 | SHOULD | Material design choices are recorded as ADRs (architecture decision records) in `docs/adr/`. Repositories whose model allows no `docs/` folder keep decisions in `REVIEW.md` or `TODO.md` instead. | CC (`docs/adr/`) and MO (`docs/adr/`, the canonical ADR log for both of its repositories) follow it; NE and CA use the exception. |
| DOC-7 | MAY | A GitHub Pages site. No repository publishes one today; the open tickets are [CC-5 #11](https://github.com/saulpatinojr/HCW-CloudCrawler_App/issues/11), [NE-8 #247](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/247), [CA-9 #32](https://github.com/saulpatinojr/HCW-CloudAssessor_App/issues/32) and [AMO-13 #54](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/issues/54). Until one exists, the board view "GitHub Pages" stays empty. | None publish Pages. |

### 2.3 Community and contribution files

GitHub finds these files at the root, in `docs/` or in `.github/`. New files go
in `.github/`; a file that already sits at the root stays there.

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| COM-1 | MUST | `SECURITY.md` that tells reporters how to report privately (GitHub's private vulnerability reporting, optionally with an e-mail address), and private vulnerability reporting switched on. | File in all four; setting `enabled: true` in all four. |
| COM-2 | MUST | `CONTRIBUTING.md`. | All four. CA added it on 2026-10-25 (commit `190052bf`). |
| COM-3 | MUST | `CODE_OF_CONDUCT.md`. | All four. CA added it on 2026-10-25 (commit `190052bf`). |
| COM-4 | SHOULD | `SUPPORT.md` that says where to ask a question. | None of the four has one (G-13). |
| COM-5 | MUST | `.github/CODEOWNERS`. | All four. |
| COM-6 | MUST | A pull request template with at least these sections: Summary, Verification (exact commands, and what was not run), Security and data. | All four have a template. MO's has Summary, Verification, Rules, Infrastructure and AI provenance, with no security section (G-1). |
| COM-7 | MUST | Issue **forms** (YAML) for a bug, a feature request and a work item, plus `config.yml` with blank issues turned off and security reports routed to the private form. | NE: 3 forms (bug, feature, work item) and config. CA: the same, since 2026-10-25. CC: forms for bug, feature, ADR and FinOps finding, a markdown `infrastructure_change.md`, config, and no work-item form. MO: 2 forms (bug, feature), the markdown `rule-change.md`, no work-item form and no `config.yml`. |

### 2.4 Labels, issues and the board

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| LAB-1 | MUST | These labels exist in every repository: `P0`, `P1`, `P2`, `P3`; `severity:critical`, `severity:high`, `severity:medium`, `severity:low`; `workstream:ci`, `workstream:dependencies`, `workstream:docs`, `workstream:governance`, `workstream:pages`, `workstream:release`, `workstream:security`, `workstream:testing`; `product:networkeyes`, `product:cloudcrawler`, `product:cloudassessor`, `product:azmigrate` (one per repository); `needs-owner-decision`. Each label maps to exactly one board option (`P0` is "P0 Critical", `workstream:docs` is "Presentation and Documentation"); the mapping is in the `board-fill` task. | No repository has the full set. Missing: NE `P0`, `severity:critical`, `workstream:pages`; CC `P0`, `severity:critical`; CA `P0`, `severity:critical`, `workstream:pages`; MO `P0`, `P1`, `severity:critical`, `severity:high`, `workstream:dependencies`, `workstream:pages` (G-3). |
| LAB-2 | MUST | Every issue carries one priority, one severity, one workstream and one product label. | 54 of the 84 board items had all four fields filled from labels on the morning of 2026-10-25. The other 30 had no labels and are listed in G-3. |
| LAB-3 | MUST | The board [HCW Field Applications](https://github.com/users/saulpatinojr/projects/7) is public, has auto-add on (turned on by the owner on 2026-10-24, per PF-3), and has the fields, options and views in section 3. | Verified on 2026-10-25; see section 3. |
| LAB-4 | MUST | Board values are filled from labels by the `board-fill` task of the `repository-admin` workflow ([NE file](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/.github/workflows/390-repository-admin.yml)), not by hand. Issue forms use the board's own option lists, and a test in NE keeps them equal. | Task exists and ran on 2026-10-25. |

### 2.5 Branch and tag protection

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| PRO-1 | MUST | Two active rulesets: **Protect main** (no deletion, no force push, pull request required with 0 approvals, required status checks, repository admins may bypass only through a pull request) and **Protect release tags** (`refs/tags/v*` cannot be deleted, moved or updated, no bypass). | Identical rules in all four, read through the rulesets API on 2026-10-25. |
| PRO-2 | MUST | The required checks include at least: lint, tests, secret scan and the image build. | See the required-checks table in section 4. NE requires no image build (`Docker Build Smoke Test` is not required) and no code-scanning check (G-6). MO requires `appliance-image` but no lint or dependency audit job. |
| PRO-3 | MUST | Rulesets change only through the `repository-admin` workflow (a dry run first, then `apply`), and the check list in that workflow equals the live ruleset. | CC, CA, MO match. **NE does not**: the workflow lists 7 checks and the live ruleset has 10, so `protect-main` with `apply` would remove `Dockerfile Lint (hadolint)`, `Workflow Lint (actionlint)` and `Dependency Review` (G-2). Observed: the dry run [40203506783](https://github.com/saulpatinojr/HCW-NetworkEyes_App/actions/runs/40203506783) prints a payload with the 7 checks. Inferred from the workflow code: the task replaces the live ruleset with that payload (`PUT`), so the 3 newer checks would be removed. |
| PRO-4 | SHOULD | Every tag pattern that a release uses is covered by the tag ruleset. | NE also has the tag `engine-v0.1.0`, which `refs/tags/v*` does not cover (G-4). |
| PRO-5 | MUST | The default Actions token is read-only and Actions cannot approve pull requests. | `read` and `false` in all four. |
| PRO-6 | SHOULD | The Actions setting "Require actions to be pinned to a full-length commit SHA" is on. | Off in all four, although every `uses:` is already pinned (G-9). |

### 2.6 Pull requests and automation

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| AUT-1 | MUST | The composite action `.github/actions/self-merging-pr` ([NE copy](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/.github/actions/self-merging-pr/action.yml)) is present and has the same content in every repository. It opens a pull request with a short-lived GitHub App token so that required checks run, and turns on squash auto-merge. | Byte-identical in all four on 2026-10-25 (the same git blob `eccfa960`, 6741 bytes, read through the contents API). |
| AUT-2 | MUST | A rehearsal that proves the action end to end without a real change: `rehearse-self-merging-pr.yml`. | CC, CA, MO have the workflow. NE has the rehearsal as the `rehearsal` input of workflow 200 (E-2). |
| AUT-3 | MUST | No CI-suppression marker (the bracketed skip words) in a commit message, pull request title or body. The action's own input text says why: it would skip the required checks too. | Stated in the action; not machine-checked. |
| AUT-4 | SHOULD | Commit subjects read `type(scope): what changed`, with types such as `feat`, `fix`, `build`, `ci`, `docs`, `test`, `chore`, `refactor`. | The last 12 non-merge commits: NE and CC follow it; CA and MO mix it with plain sentences. |

### 2.7 Continuous integration

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| CI-1 | MUST | Every `uses:` of a third-party action is pinned to a full 40-character commit SHA with the version in a trailing comment (`# v4.6.0`). Dependabot proposes the updates. | 70 of 70 (NE), 35 of 35 (CC), 43 of 43 (CA), 55 of 55 (MO) are SHA-pinned and carry a version comment. |
| CI-2 | MUST | Every workflow has a top-level `permissions:` block (`contents: read` unless it needs more); a job that needs more asks for it itself. | All workflows in all four. |
| CI-3 | MUST | The minimum job set exists and runs on every pull request: **lint**, **test**, **secret scan**, **dependency audit**, **image build** (or build and pack for MO). CC, CA, MO name jobs with short lowercase ids (`lint`, `test`, `secret-scan`, `pip-audit`, `image`); NE uses display names (E-2). | NE, CC and CA have the set. MO has no blocking dependency audit; its OSV scanner in `scanners.yml` is report only (G-6). |
| CI-4 | SHOULD | `actions/checkout` sets `persist-credentials: false`. | 12 of 12 (CC), 7 of 23 (NE), 4 of 17 (MO), 3 of 15 (CA) (G-8). |
| CI-5 | SHOULD | Every job sets `timeout-minutes`. | 27 of 28 (NE), 8 of 14 (CC), 7 of 18 (MO), 2 of 16 (CA) (G-8). |
| CI-6 | SHOULD | Workflows are linted with `actionlint` and Dockerfiles with `hadolint`, both pinned. | NE: both ([#289](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/289)). MO: hadolint. CC and CA: neither (G-8). |
| CI-7 | MUST | The README's Quick start gives the same commands CI runs, so a laptop result predicts the CI result. | NE adds `scripts/ci/local-container-checks.sh` for the container checks. Not re-run for the others (see section 9). |

### 2.8 Dependencies

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| DEP-1 | MUST | `.github/dependabot.yml` covers `github-actions` (directories `/` and `/.github/actions/*`) and **every** package ecosystem that has a manifest, weekly, with updates grouped. | `github-actions` is in all four. Gaps: CC has a Dockerfile but no `docker` entry; MO has Terraform under `infrastructure/terraform/appliance-azure` but no `terraform` entry; NE has `docker-compose.yml` but no `docker-compose` entry; `groups` (one pull request per batch of updates) are missing for CA's `github-actions`, `docker` and `terraform` entries and for MO's `docker` and `docker-compose` entries (G-5). |
| DEP-2 | MUST | Lockfiles are committed (`uv.lock`, `package-lock.json`) and checked in CI. | `uv.lock` in NE, CC, CA; `package-lock.json` in MO and in NE's web app; checks: NE has the "Python Lockfile Consistency" job; CC and CA have `scripts/check-lockfiles.sh`; MO has no named lockfile check (G-5). |
| DEP-3 | MUST | A dependency review job runs on pull requests. | All four. Required by the ruleset only in NE (G-6). |

### 2.9 Security scanning

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| SEC-1 | MUST | GitHub secret scanning and push protection are on. | On in all four. Validity checks and non-provider patterns are off in all four (G-10). |
| SEC-2 | MUST | A secret scan runs in CI (gitleaks; NE also runs detect-secrets as the gating scan). | All four. |
| SEC-3 | MUST | CodeQL covers every language in the repository (Python, JavaScript and TypeScript, and `actions` for the workflows). Prefer an advanced workflow with a config file, so the check has a stable name that a ruleset can require. | **NE's default setup scans only `actions`**; its roughly 276 Python and 141 TypeScript and JavaScript files are not scanned (G-16). CC scans `actions` and Python. CA scans Python and JavaScript/TypeScript but not `actions`. MO scans JavaScript/TypeScript and `actions`; its 2 Python files are not scanned. Required by the ruleset only in MO (G-6). |
| SEC-4 | SHOULD | Every image to be published is scanned (Trivy or Docker Scout) before it is pushed. | Configured in CA (Trivy in `publish-images.yml`), MO (Trivy), NE (Docker Scout in workflow 200, plus a local Trivy script). CC builds an image in CI but does not scan it (G-7). |
| SEC-5 | MUST | Everything published carries a software bill of materials (SBOM) and build provenance. | Configured in the workflows: NE (SBOM, provenance and cosign signature in workflow 200); CC (CycloneDX SBOM and attestation for the wheel); CA and MO (`sbom: true`, `provenance: true`, `attest-build-provenance`). No container image has been published yet (see IMG-1), so this has not been observed on a real release. |
| SEC-6 | MAY | OpenSSF Scorecard and OSV scanner as report-only jobs. | MO only (`scanners.yml`). |

### 2.10 Releases

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| REL-1 | MUST | Versions are plain `X.Y.Z`; release tags are `vX.Y.Z`; a GitHub Release is created from a tag, with the notes taken from the matching `CHANGELOG.md` section. | Tags follow it in CA and MO. NE has `v0.8.0`, `v0.1.0` and also `engine-v0.1.0`. CC has no tag yet (first release in preparation). Notes: all four MO releases have empty notes, and MO's changelog keeps its `0.3.1` entry under Unreleased; CA's two releases hold only the line "See CHANGELOG.md for v0.2.1." (G-4). Milestones are not used anywhere (0 in all four) and stay a MAY. |
| REL-2 | MUST | A release guard runs on every pull request and again on the tag: all version strings agree, the tag equals the version, the changelog has a dated section, and only commits on `main` are released. The reference is [`scripts/check-release-version.py`](https://github.com/saulpatinojr/HCW-CloudCrawler_App/blob/main/scripts/check-release-version.py) with its `--rehearse` dry run. | CC has the full guard. CA added `scripts/check-release-version.py` on 2026-10-25 (run in `ci.yml` and `publish-core.yml`; its content was not compared with CC's copy). NE (`320-release-engine.yml`, `engine-v` tags) and MO (`release-cli.yml`) check the tag against the package version at tag time only, not on pull requests, and do not check the changelog or that the commit is on `main` (G-4). |
| REL-3 | MUST | Publishing uses OIDC or trusted publishing. No registry password or token is stored in the repository's secrets. | CC (PyPI trusted publishing), CA and MO (Docker Hub OIDC connection), NE workflow 200 (OIDC). Exception: NE workflow 370 uses the stored `DOCKERHUB_PERSONAL_TOKEN` (tracked as R-026 step 3 in NE's `REVIEW.md`). |
| REL-4 | MAY | `.github/release.yml` to group generated notes by label. | CC only. |

### 2.11 Container images

An image that is meant to qualify for Docker's free open-source programme
(DSOS) also follows the
[open-source Docker app dossier](oss-docker-app-dossier.md): thirteen
checks (licence, copyright holder, how the image is published, wording, active
development and more), each with how to check it, and a template that records
the proof for a product.

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| IMG-1 | MUST | Images to be published are named `docker.io/hybridcloudworks/img-<short>-<job>-<type>`, for example `img-ne-appliance-app`, `img-ca-appliance-app`, `img-mo-appliance-app`. `<short>` is the product's two-letter code, `<job>` is what the image does (`appliance`, `lab`), `<type>` is `app` or `addon`. The tag is the full release tag (`v0.1.0`). | NE, CA and MO workflows are configured with this name, but nothing has been published: Docker Hub shows no tags for the three `img-*-appliance-app` repositories on 2026-10-25, `DOCKERHUB_ENABLED` is not set in CA or MO, and MO's changelog says the image was never published. CC publishes no image. The convention is recorded in this repository's [CHANGELOG](../repo/changelog.md) entry for the add-on images; it had no standards page until this one. |
| IMG-2 | MUST | Every `FROM` is pinned to a digest, and the final stage runs as a numeric non-root user. | Digests: every `FROM` line in the 7 Dockerfiles of the four repositories. User: `1001` (NE), `10001` (CC, CA); MO uses the name `node`, which Kubernetes `runAsNonRoot` cannot verify (G-8). |

### 2.12 Configuration, secrets and variables

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| CFG-1 | MUST | `.env.example` lists every environment variable with a comment and no real value. | File present in all four; that it is complete was not checked. |
| CFG-2 | MUST | The GitHub App credentials are the variable `APP_CLIENT_ID` and the secret `APP_PRIVATE_KEY`, held in the `admin-ops` environment (main branch only). The one personal token allowed is `PROJECT_TOKEN`, because a personal-account Project (v2) cannot be reached with an App token. | CC, CA, MO follow it. NE also reads `GH_APP_ID` and `GH_APP_PRIVATE_KEY` in the `notify-appliances` job of workflow 200 (G-11). |

### 2.13 Agent instructions

| ID | Level | Requirement | Evidence |
| --- | --- | --- | --- |
| AGT-1 | MUST | `CLAUDE.md` is the working agreement (DOC-3). | All four. |
| AGT-2 | SHOULD | `.github/copilot-instructions.md` and `AGENTS.md` exist when the repository is worked on with those tools, and say the same as `CLAUDE.md`. | MO has both; CC has `copilot-instructions.md`; NE and CA have neither. |

## 3. The project board

Board: [HCW Field Applications](https://github.com/users/saulpatinojr/projects/7)
(user project 7, public). It was brought to this specification on 2026-10-25
(ticket [PF-3 (#256)](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/256)).

| Item | Specification |
| --- | --- |
| Fields | Repository (built in), Product, Workstream, Status, Priority, Severity, Effort, Owner, Blocking Reason, Target Release, Validation Environment, Evidence, Last Reviewed. |
| Status | Intake, Triaged, Ready, In Progress, In Review, Blocked, Validation, Done, Accepted Risk, Not Applicable. New items arrive as Intake (the built-in "item added" workflow uses the first option). |
| Priority | P0 Critical, P1 High, P2 Medium, P3 Low. |
| Severity | Critical, High, Medium, Low. |
| Workstream | Presentation and Documentation, Security and Dependencies, Pull Requests and CI, Testing and Validation, GitHub Pages, Governance, Release. |
| Product | HCW NetworkEyes, Cloud Crawler, Cloud Assessor, Azure Migration Orchestrator, Portfolio. |
| Views (table layout) | Portfolio Overview `is:open`; Presentation and Documentation `workstream:"Presentation and Documentation"`; Security and Dependencies `workstream:"Security and Dependencies"`; Pull Requests and CI `workstream:"Pull Requests and CI"`; Testing and Validation `workstream:"Testing and Validation"`; GitHub Pages `workstream:"GitHub Pages"`; Blocked and Owner Decision Required `label:"needs-owner-decision" is:open`; Completed `status:Done`. |

The option lists for Product, Workstream, Priority, Severity, Effort and
Validation Environment live in the `board-fields` task of
`390-repository-admin.yml` and in NE's `work_item.yml` form. Change both
together; a NE test fails when they differ.

## 4. Evidence tables

### Required checks in the "Protect main" ruleset (live, 2026-10-25)

| Repository | Required checks |
| --- | --- |
| NE | `Lint & Format`, `Unit Tests (Python 3.14)`, `Web lint, typecheck & tests`, `Python Lockfile Consistency`, `Python Dependency Audit (pip-audit)`, `Secret Scanning (detect-secrets, gating)`, `Repository Guardrails`, `Dockerfile Lint (hadolint)`, `Workflow Lint (actionlint)`, `Dependency Review` |
| CC | `lint`, `test`, `contract`, `pip-audit`, `secret-scan`, `image` |
| CA | `lint`, `test`, `boundary`, `catalog-check`, `secret-scan`, `image`, `terraform` |
| MO | `build-test`, `codeql`, `secret-scan`, `packed-consumer`, `generated-terraform`, `appliance-image` |

### README outlines (second-level headings, as found)

| Repository | Headings |
| --- | --- |
| NE | Documentation map; Repository layout; Repository topology; Quick start; Configuration; Repository conventions |
| CC | What it does; Is there a user interface?; Status; Getting started; Signing in with Microsoft Entra; Releasing the engine; Repository layout; Rules that do not bend; Branch and tag protection; Repository standards; Contributing, security, license |
| CA | Project status; Overview; Repository layout; Quick start; Installation; Configuration; Documentation; Repository conventions |
| MO | The two repositories; Quick start; Repository map; Releases and artifacts; Principles baked into code; Contributing, security, license |

### Other repository facts

| Item | NE | CC | CA | MO |
| --- | --- | --- | --- | --- |
| Licence | Apache-2.0 | MIT | MIT | MIT |
| Workflows | numbered `200`..`390` (6) | descriptive (7) | descriptive (7) | descriptive (11) |
| Dependabot ecosystems | uv, github-actions, docker (4 dirs), npm | github-actions, uv | uv, github-actions, docker, terraform | npm, github-actions, docker, docker-compose |
| CodeQL | default setup | workflow `codeql.yml` | job in `security.yml` | job in `security.yml` |
| Wiki | off | on | on | off |
| Auto-delete branches | on | off | on | on |
| Topics | none | none | 6 | 8 |

## 5. Conformance of each repository to the MUST items

"Yes" means observed. "Cfg" means configured in a workflow but not yet seen on a
real release. "Part" means partly, with the gap number from section 7. "E-n"
means a written exception in section 6. "Not checked" is listed in section 9.

| ID | NE | CC | CA | MO |
| --- | --- | --- | --- | --- |
| ID-1 name, ID-2 description | Yes | Yes | Yes | Yes |
| ID-4 licence | Yes, E-1 | Yes | Yes | Yes |
| ID-5 delete merged branches | Yes | No (G-12) | Yes | Yes |
| DOC-1 README outline | Part (G-14) | Part (G-14) | Part (G-14) | Part (G-14) |
| DOC-2 changelog format | Yes | Yes | Yes | Part (G-14) |
| DOC-3 / AGT-1 `CLAUDE.md` | Yes | Yes | Yes | Yes |
| DOC-4 documentation model written | Yes | Part (G-14) | Yes | Yes |
| COM-1 security policy and private reporting | Yes | Yes | Yes | Yes |
| COM-2 CONTRIBUTING | Yes | Yes | Yes | Yes |
| COM-3 CODE_OF_CONDUCT | Yes | Yes | Yes | Yes |
| COM-5 CODEOWNERS | Yes | Yes | Yes | Yes |
| COM-6 pull request template | Yes | Yes | Yes | Part (G-1) |
| COM-7 issue forms and `config.yml` | Yes | Part (G-1) | Yes | Part (G-1) |
| LAB-1 label set | Part (G-3) | Part (G-3) | Part (G-3) | Part (G-3) |
| LAB-2 labels on every issue | Part (G-3) | Yes | Part (G-3) | Part (G-3) |
| LAB-3 / LAB-4 board | Yes | Yes | Yes | Yes |
| PRO-1 two rulesets | Yes | Yes | Yes | Yes |
| PRO-2 required checks cover lint, test, secret scan, image | Part (G-6) | Yes | Yes | Part (G-6) |
| PRO-3 admin workflow equals live ruleset | **No (G-2)** | Yes | Yes | Yes |
| PRO-5 read-only token | Yes | Yes | Yes | Yes |
| AUT-1 self-merging action | Yes | Yes | Yes | Yes |
| AUT-2 rehearsal | E-2 | Yes | Yes | Yes |
| AUT-3 no CI-suppression markers | Not checked | Not checked | Not checked | Not checked |
| CI-1 pinned with version comment | Yes | Yes | Yes | Yes |
| CI-2 top-level permissions | Yes | Yes | Yes | Yes |
| CI-3 minimum job set | Yes, E-2 | Yes | Yes | Part (G-6) |
| CI-7 README commands equal CI | Not checked | Not checked | Not checked | Not checked |
| DEP-1 Dependabot covers every ecosystem | Part (G-5) | Part (G-5) | Part (G-5) | Part (G-5) |
| DEP-2 lockfiles checked | Yes | Yes | Yes | Part (G-5) |
| DEP-3 dependency review job | Yes | Yes | Yes | Yes |
| SEC-1 secret scanning and push protection | Yes | Yes | Yes | Yes |
| SEC-2 CI secret scan | Yes | Yes | Yes | Yes |
| SEC-3 CodeQL covers every language | **No (G-16)** | Yes | Part (G-16) | Yes |
| SEC-5 SBOM and provenance | Cfg | Cfg | Cfg | Cfg |
| REL-1 versions, tags and notes | Part (G-4) | n/a (no release yet) | Part (G-4) | Part (G-4) |
| REL-2 release guard | Part (G-4) | Yes | Yes | Part (G-4) |
| REL-3 no stored registry credential | Part (G-11) | Yes | Yes | Yes |
| IMG-1 image name | Cfg | n/a (no image) | Cfg | Cfg |
| IMG-2 digest pins and numeric user | Yes | Yes | Yes | Part (G-8) |
| CFG-1 `.env.example` | Yes | Yes | Yes | Yes |
| CFG-2 credential names | Part (G-11) | Yes | Yes | Yes |

## 6. Exceptions

Only an exception with a reason and an owner counts as justified. A line with
"Owner decision" is not yet justified.

| ID | Repository | What differs | Reason | Status |
| --- | --- | --- | --- | --- |
| E-1 | NE | Licence is Apache-2.0, the others MIT. | No reason is written down in the repository. | **Owner decision** |
| E-2 | NE | Numbered workflows (`200`..`390`), job display names such as `Lint & Format`, and the rehearsal as an input of workflow 200 instead of its own file. | NE's guardrail tests pin the workflow set and its bands ([`CLAUDE.md`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/CLAUDE.md), "Workflows are numbered in bands"). Required-check names must stay as they are. | Justified |
| E-3 | MO | Node and TypeScript instead of Python: no `pip-audit`, no `uv`, `npm` and `package-lock.json` instead. | The product is a TypeScript monorepo. (The missing blocking dependency audit is not part of this exception; it is G-6.) | Justified |
| E-4 | CA | Documentation model allows five root documents and sends everything else to the GitHub Wiki ([`CLAUDE.md`](https://github.com/saulpatinojr/HCW-CloudAssessor_App/blob/main/CLAUDE.md), "Documentation model"). | Predates ADR 0027, which retired the wiki. | **Owner decision** (move to `docs/` or keep the wiki) |
| E-5 | NE, CA | Community files only in `.github/`; no `docs/` folder. | The documentation models of both repositories allow only a few root documents. | Justified |
| E-6 | MO | The downstream web-front edition can never reach Azure: `azure-auth`, `azure-arm` and `azure-execution` are never published as packages ([`CLAUDE.md`](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/blob/main/CLAUDE.md)). | Safety rule of the product. No standard item may weaken it, and publishing steps (REL-3) must keep those packages out of the publish list. | Justified |
| E-7 | CC | No image is published and no tag exists yet. | The first release (`v0.1.0`) is in preparation. | Justified until the first tag |

## 7. Gaps and proposed tickets

None of these tickets exists yet. Each one carries the labels the standard asks
for (priority, severity, workstream, product) and belongs on the board. Where
the fix changes a ruleset or a setting, it goes through the `repository-admin`
workflow or is done by the owner in the browser.

| Gap | Proposed ticket | Labels | Done when |
| --- | --- | --- | --- |
| G-1 | Community files. CC: add a work-item issue form. MO: add `.github/ISSUE_TEMPLATE/config.yml`, a work-item form, turn `rule-change.md` into a form, and add a security section to the pull request template. (CA finished its part on 2026-10-25.) Split into one ticket per repository. | P3, severity:low, workstream:governance, product:cloudcrawler / product:azmigrate | COM-6 and COM-7 read "Yes" for both. |
| G-2 | NE: update `REQUIRED_CHECKS` in `390-repository-admin.yml` to the 10 live checks (plus any added by G-6), and add a test that fails when the list differs from the job names in workflow 300. | P1, severity:high, workstream:governance, product:networkeyes | A dry run of `protect-main` prints the same check list as the live ruleset. |
| G-3 | All four: add the missing labels (LAB-1), keep them in one `labels.json` like CC's, and add the four labels to the issues that have none: [NE #291](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/291), [CA #1](https://github.com/saulpatinojr/HCW-CloudAssessor_App/issues/1), [CA #2](https://github.com/saulpatinojr/HCW-CloudAssessor_App/issues/2), [CA #3](https://github.com/saulpatinojr/HCW-CloudAssessor_App/issues/3), [CA #9](https://github.com/saulpatinojr/HCW-CloudAssessor_App/issues/9), [MO #21](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/issues/21), and the 24 older closed issues (23 in NE, 1 in CA) that the pull request adding this page lists. The board already holds values for all of them, set by inference on 2026-10-25, so the board is complete; the labels are what is missing. | P2, severity:medium, workstream:governance, product:portfolio | LAB-1 and LAB-2 read "Yes" in all four. |
| G-4 | Releases: add the full guard (`check-release-version.py` with its `--rehearse` mode, the changelog check and the "commit is on `main`" check) to NE and MO, and bring CA's copy in line with CC's; extend NE's tag ruleset to cover `engine-v*` or rename the tag family; fill the release notes from the changelog section for CA and MO and move MO's `0.3.1` entry out of Unreleased. | P2, severity:medium, workstream:release, product:portfolio | REL-1, REL-2 and PRO-4 read "Yes". |
| G-5 | Dependabot: add `docker` to CC, `terraform` to MO, `docker-compose` to NE; add `groups` to CA (`github-actions`, `docker`, `terraform`) and MO (`docker`, `docker-compose`); give MO a named lockfile check. | P3, severity:low, workstream:dependencies, product:portfolio | DEP-1 and DEP-2 read "Yes" in all four. |
| G-6 | Required checks, through the `repository-admin` workflow after each job has run once: require `Dependency Review` and the CodeQL check where they exist (CC, CA; MO already requires `codeql` and needs `dependency-review`); require `Docker Build Smoke Test` in NE; give MO a blocking lint job and a blocking npm dependency audit and require them. | P2, severity:medium, workstream:security, product:portfolio | PRO-2, CI-3 and DEP-3 are enforced by the ruleset. |
| G-7 | CC: scan the image built in CI with Trivy (digest-pinned, as in CA). | P3, severity:low, workstream:security, product:cloudcrawler | SEC-4 reads "Yes". |
| G-8 | CI hygiene: set `persist-credentials: false` on every checkout and `timeout-minutes` on every job (counts in CI-4 and CI-5); add `actionlint` and `hadolint` to CC and CA; give MO's image a numeric user. | P3, severity:low, workstream:ci, product:portfolio | CI-4, CI-5, CI-6, IMG-2 read "Yes". |
| G-9 | Owner: switch on "Require actions to be pinned to a full-length commit SHA" in the four repositories ([NE](https://github.com/saulpatinojr/HCW-NetworkEyes_App/settings/actions), [CC](https://github.com/saulpatinojr/HCW-CloudCrawler_App/settings/actions), [CA](https://github.com/saulpatinojr/HCW-CloudAssessor_App/settings/actions), [MO](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/settings/actions)). All current `uses:` lines are pinned, so nothing should break. | P2, severity:medium, workstream:security, product:portfolio | PRO-6 reads "Yes". |
| G-10 | Owner decision: secret scanning validity checks and non-provider patterns (off in all four). | P3, severity:low, workstream:security, product:portfolio | Decision recorded. |
| G-11 | NE: use `APP_CLIENT_ID` and `APP_PRIVATE_KEY` in the `notify-appliances` job instead of `GH_APP_ID` and `GH_APP_PRIVATE_KEY` and delete the two old secrets; decide the stored `DOCKERHUB_PERSONAL_TOKEN` used by workflow 370 (step 3 of R-026 in NE's `REVIEW.md`). | P3, severity:low, workstream:security, product:networkeyes | CFG-2 and REL-3 read "Yes". |
| G-12 | CC: switch on "Automatically delete head branches" ([settings page](https://github.com/saulpatinojr/HCW-CloudCrawler_App/settings)). | P3, severity:low, workstream:governance, product:cloudcrawler | ID-5 reads "Yes". |
| G-13 | `SUPPORT.md` in all four; topics and homepage for NE and CC; decide the wiki for CC and CA (ID-6, E-4); optional `AGENTS.md` and `copilot-instructions.md` for NE and CA. | P3, severity:low, workstream:docs, product:portfolio | ID-3, ID-6, COM-4, AGT-2 read "Yes". |
| G-14 | README outline (DOC-1) in all four, Keep a Changelog headings in MO (DOC-2), a documentation model statement in CC (DOC-4), commit style (AUT-4) written into each `CONTRIBUTING.md`. | P3, severity:low, workstream:docs, product:portfolio | DOC-1, DOC-2, DOC-4, AUT-4 read "Yes". |
| G-15 | Owner decision: licence of NE (E-1) and which repositories need a `NOTICE`. | P3, severity:low, workstream:governance, product:portfolio | E-1 resolved. |
| G-16 | CodeQL coverage. NE: replace default setup (which scans only `actions`) with an advanced workflow for Python, JavaScript/TypeScript and `actions`, and require its check. CA: add `actions`. | P2, severity:medium, workstream:security, product:portfolio | SEC-3 reads "Yes" in all four. |

## 8. Keeping this page true

- **Owner:** the repository owner decides the MUST list. A change to a MUST row
  is an ADR-style entry in [`CHANGELOG.md`](../repo/changelog.md) of this
  repository, the repositories it affects each get a ticket, and the
  conformance table is updated in the same pull request.
- **Review cadence:** re-read the four repositories every quarter, and after
  any change to the `repository-admin` workflow, a ruleset or the board.
  Re-running the commands in section 9 reproduces every figure on this page.
- **Single copy:** the page lives here, in the umbrella repository, because
  NE and CA allow almost no extra markdown and this repository already holds
  the other standards. The four READMEs should link here ("Repository conventions" in NE and CA, "Repository standards" in CC; part of G-14).

## 9. How the evidence was gathered, and what was not checked

Read-only, on 2026-10-25, with the `gh` command line signed in as the owner. An
independent reviewer (the `cloud-documentation-archivist` agent) re-checked a
sample of the figures against the repositories, and the errors it found were
corrected before this page was published. The sources were:

- Files and settings: `gh api repos/<owner>/<repo>`, `/git/trees/main?recursive=1`,
  `/rulesets` and `/rulesets/<id>`, `/labels`, `/milestones`, `/releases`, `/tags`,
  `/private-vulnerability-reporting`, `/code-scanning/default-setup`,
  `/actions/permissions` and `/actions/permissions/workflow`.
- Workflow contents, `dependabot.yml`, composite action and Dockerfiles: read
  from each repository's `origin/main` and parsed (counts of `uses:`,
  `persist-credentials`, `timeout-minutes`, version comments).
- The `repository-admin` workflow ([NE run 40202353505](https://github.com/saulpatinojr/HCW-NetworkEyes_App/actions/runs/40202353505),
  [run 40202402877](https://github.com/saulpatinojr/HCW-NetworkEyes_App/actions/runs/40202402877)
  and [run 40203506783](https://github.com/saulpatinojr/HCW-NetworkEyes_App/actions/runs/40203506783)
  were dry runs).

Not checked:

- Whether `.env.example` lists every variable the code reads (CFG-1).
- Whether each README's Quick start commands still work (CI-7).
- Whether the commit-style reading (AUT-4) holds beyond the last 12 commits.
- That the issue forms render as intended on github.com.
- The AddOn repositories, and the umbrella repository's own conformance.
- Whether any pull request open in the four repositories changes a row above.
- Whether CA's new `check-release-version.py` is the same file as CC's.
- Docker Hub was read as a public visitor (no tags on the three `img-*-appliance-app` repositories); a private tag would not show.
- Branch-protection behaviour in practice: only the ruleset definitions were
  read, nothing was pushed to test them.

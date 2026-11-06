# Dependency review — how the nine repositories are kept under watch

> **Status: in use from 2026-10-25.** Written when the owner asked for "a method
> to do continuous review of dependencies". What each repository runs below was
> read from its workflow files that day, not guessed from their names (a first
> pass judged by file name was wrong for two repositories and is corrected here).

**Scope:** the nine program repositories: this website (`HCW-HybridCloudWorks`),
the four add-ons and the four apps. What watches their dependencies and images
without anyone asking, the five-minute look a person takes each week, and what
to do with what it shows.

**Authority:** this page does not authorize a change. The apps belong to the
other agent's workstream: for them it lists findings and does not fix them.

## What watches by itself

1. **Dependabot, version updates.** Every repository has a `.github/dependabot.yml`
   that opens grouped pull requests for the ecosystems it holds (below). They are
   ordinary pull requests: they run CI, and once it is green a session tells the
   owner, who decides on the merge (the Dependabot exception in `.claude/CLAUDE.md`).
2. **Dependabot alerts and security updates.** On in all nine repositories (read
   through the API on 2026-10-25). An alert is GitHub saying *a package in your
   lockfile has a known vulnerability*; a security update is the pull request
   that fixes it.
3. **Gates on a pull request.** A dependency review (blocks a pull request that
   adds a package with a known high or critical vulnerability) and CodeQL
   (reads the code for vulnerability patterns), where the table says so.
4. **Image scans.** Trivy before each add-on image is published (the push stops on
   a fixable HIGH or CRITICAL); every Tuesday, Trivy again on the digests the lab
   host runs, with an issue opened when something fixable turns up
   (`lab-supply-chain.yml`, which covers the two lab images and every
   add-on image pinned in `group_vars`, four since #1357); and Docker Scout on
   the same add-on digests every Wednesday, once the Docker Scout credential is stored ([the Scout
   runbook](docker-scout.md)). Until it is stored, that run fails on purpose,
   so a check that never ran cannot look green.
5. **Secret scanning.** GitHub's own, with push protection (blocks a push that
   contains a credential), plus Gitleaks in the workflows listed.

## What each repository actually runs

Read from the workflow files on 2026-10-25 ("yes" means a workflow uses that
tool). Dependabot ecosystems are from each `dependabot.yml`.

| Repository | Dependency review | CodeQL | Gitleaks | Scorecard | pip-audit | npm audit | Trivy | Scout | Terraform scan | Dependabot ecosystems |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| HCW-HybridCloudWorks (this site) | yes | yes | - | - | - | - | yes | the new workflow | yes | docker, github-actions, npm (5), terraform (2) |
| HCW-MigrateOrchestrator_AddOn | yes | yes | yes | - | - | - | yes | - | - | docker, github-actions, npm |
| HCW-NetworkEyes_AddOn | yes | yes | yes | - | yes | - | yes | - | - | github-actions, uv |
| HCW-CloudAssessor_AddOn | yes | yes | yes | - | yes | - | yes | - | - | github-actions, uv |
| HCW-CloudCrawler_AddOn | yes | yes | yes | - | yes | - | yes | - | - | github-actions, npm, terraform, uv |
| HCW-MigrateOrchestrator_App | yes | yes | yes | yes | - | - | yes | - | - | docker, docker-compose, github-actions, npm |
| **HCW-NetworkEyes_App** | **-** | **-** | **-** | - | yes | yes | - | yes (see below) | - | docker, github-actions, npm, uv |
| HCW-CloudAssessor_App | yes | yes | yes | - | yes | - | yes | - | - | docker, github-actions, terraform, uv |
| HCW-CloudCrawler_App | yes | yes | yes | - | yes | - | - | - | - | github-actions, npm, terraform, uv |

Three things in that table are deliberate, not gaps:

- **The Python add-ons have no `docker` entry in Dependabot.** Their base image
  follows the website's pin (their `dependabot.yml` says so): a Dependabot bump of
  either half of that pair would fail CI by design. Each add-on's own
  `base-update` workflow opens the move instead ("The Python add-ons' base
  image", below).
- **The add-ons' dependency review and CodeQL live inside their `security.yml`**,
  not in files of their own, which is why file names do not show them.
- **The site has no Gitleaks job**; it relies on GitHub's secret scanning and push
  protection, which are on.

## The five-minute look, once a week

Run this in PowerShell, signed in to GitHub with `gh` (it only reads). It prints
the number of open alerts for each repository. A query that fails (for example
because code scanning is switched off there, or your login cannot see the
repository) prints `unavailable`, never `0`:

```powershell
foreach ($r in 'HCW-HybridCloudWorks','HCW-MigrateOrchestrator_AddOn','HCW-NetworkEyes_AddOn','HCW-CloudAssessor_AddOn','HCW-CloudCrawler_AddOn','HCW-MigrateOrchestrator_App','HCW-NetworkEyes_App','HCW-CloudAssessor_App','HCW-CloudCrawler_App') { $dn = gh api "repos/saulpatinojr/$r/dependabot/alerts?state=open&per_page=100" --paginate --jq '.[].number'; $d = if ($LASTEXITCODE -eq 0) { ($dn | Measure-Object).Count } else { 'unavailable' }; $cn = gh api "repos/saulpatinojr/$r/code-scanning/alerts?state=open&per_page=100" --paginate --jq '.[].number'; $c = if ($LASTEXITCODE -eq 0) { ($cn | Measure-Object).Count } else { 'unavailable' }; "$r  dependabot=$d  code-scanning=$c" }
```

Expected: nine lines. On 2026-10-25 the nonzero ones were
`HCW-NetworkEyes_App dependabot=3` and `HCW-MigrateOrchestrator_App
code-scanning=17` (16 on a re-run later the same day, so expect the number to move); everything else read 0. To see what the alerts are in one
repository, these two commands print one line per alert (the first for
Dependabot, the second for code scanning; they read different fields, so each
has its own filter):

```powershell
gh api "repos/saulpatinojr/HCW-NetworkEyes_App/dependabot/alerts?state=open&per_page=100" --paginate --jq '.[] | "\(.security_advisory.severity) \(.dependency.package.name) fixed in \(.security_vulnerability.first_patched_version.identifier) \(.dependency.manifest_path)"'
```

```powershell
gh api "repos/saulpatinojr/HCW-MigrateOrchestrator_App/code-scanning/alerts?state=open&per_page=100" --paginate --jq '.[] | "\(.rule.security_severity_level // .rule.severity) \(.rule.id) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
```

Also look at the open issue titled *Lab supply chain: pins behind upstream or
image vulnerabilities*, if there is one: it is the Tuesday scan's report.

## What to do with what you see

This is a **proposed** rule, for the owner to change:

| What | When |
| --- | --- |
| Critical or High, with a fix | this week |
| Medium, with a fix | this month |
| Low | with the next change that touches the package |
| Any severity, with **no fix yet** | write it down, assess whether the vulnerable code is reachable, and record either an interim mitigation or a risk decision with a named owner (an accepted risk goes in `TODO.md`); track the fix. Do not assume a newer base image removes it: check at the next release |
| An alert Dependabot cannot open a pull request for | fix the lockfile by hand (below) |

**A package that is only a peer.** On 2026-10-25 the migration add-on had five
open alerts on `vite` 6.4.3, which the lockfile held as an automatic peer of the
Tailwind plugin, below the fixed 6.4.4. Nothing depended on `vite` directly at the
root, so Dependabot had nothing to open a pull request for. `npm update vite`
moved it to the 8.3.5 the pane already used and deduplicated the two copies; the
change was compared package by package against the old lockfile (the Linux
binaries and the upstream tarball hashes were checked), tested, and merged, and
the alerts closed themselves. That is the pattern: update the one package, read
the lockfile diff, then test.

## Open findings, 2026-10-25

| Repository | Finding | Whose |
| --- | --- | --- |
| HCW-NetworkEyes_App | no dependency review, no CodeQL, no Gitleaks; GitHub secret scanning and push protection are **off** (turn them on at <https://github.com/saulpatinojr/HCW-NetworkEyes_App/settings/security_analysis>); 3 open Dependabot alerts, all medium (`postcss-selector-parser`, `brace-expansion` twice, in `apps/cna-web/package-lock.json`) | the apps' workstream; the settings are the owner's |
| HCW-NetworkEyes_App | its image workflow runs `docker/scout-action` after an OIDC login with no Docker user or token, the combination that was refused on 2026-10-25; it has never run, because publishing is not enabled in that repository | the apps' workstream |
| HCW-NetworkEyes_App | three Docker credentials stored as secrets (`DOCKERHUB_TOKEN`, `DOCKERHUB_PERSONAL_TOKEN`, `DOCKERHUB_PERSONAL_USERNAME`; names only were read); the registry-cleanup workflow uses the personal token because deleting a tag is beyond what the OIDC connections grant | the owner decides whether they are still needed |
| HCW-MigrateOrchestrator_App | 17 open code-scanning alerts when first read, 16 later on 2026-10-25: four CodeQL rules in JavaScript (`js/incomplete-sanitization`, `js/incomplete-url-substring-sanitization`, `js/polynomial-redos`, `js/identity-replacement`) and the OpenSSF Scorecard checks (branch protection, code review, token permissions, pinned dependencies, fuzzing and others) | the apps' workstream |

Fixed on 2026-10-25: the migration add-on's five `vite` alerts (release 0.3.2
preparation, `HCW-MigrateOrchestrator_AddOn` pull request 40).

## The Python add-ons' base image

Written 2026-11-03 for
[#1386](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1386), the
issue that found the add-ons drifting from the website's base image with
nothing to move them. The facts below were read from the add-on repositories
that day.

The three Python add-ons (Cloud Assessor, Network Eyes and Cloud Crawler;
MigrateOrchestrator builds on a Node image and is not one of them) are built on
the same base image as the lab image: the `BASE_IMAGE`, `BASE_DIGEST` and
`BASE_PYTHON_VERSION` lines of this repository's
[`lab-image/versions.env`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/versions.env),
which the weekly
[`lab-supply-chain.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/lab-supply-chain.yml)
run moves. Each add-on keeps a copy in
`infrastructure/docker/versions.env` and repeats it on both `FROM` lines of its
Dockerfile, and its `security` workflow's `base-follows-website` job goes red on
`main` while the copy's `BASE_IMAGE` or `BASE_DIGEST` differs from the
website's (it does not compare `BASE_PYTHON_VERSION`).

**Where the add-on pull request comes from.** Not from this repository. Since
2026-10-27 each add-on carries a `base-update` workflow that runs once a day at
07:37 UTC, reads the website's `versions.env` at the commit `main` points to
that day (and names that commit in what it opens), and when the two differ
opens one pull request on the branch `base-update/website-base`
that moves `versions.env` and every `FROM` line together
([Cloud Assessor's `base-update.yml`](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/blob/main/.github/workflows/base-update.yml),
[Network Eyes'](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/blob/main/.github/workflows/base-update.yml),
[Cloud Crawler's](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/blob/main/.github/workflows/base-update.yml)).
It opens the pull request with the add-on's own GitHub App token (the HCW Main
Admin App, which commits as `hcw-main-admin[bot]`; the add-on's `core-update`
workflow, the one that follows this repository's shared files, already uses
it), so the add-on's required checks run on it; a person reviews and merges.
It has done this for real: Cloud Assessor
[#55](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/pull/55) and
[#57](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/pull/57) were
opened by it and merged by a person on 2026-10-27. What to do when it is red
is in each add-on's own runbook, section "Keeping the base image on the
website's pin"
([Cloud Assessor's](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/blob/main/docs/operations/runbook.md),
[Network Eyes'](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/blob/main/docs/operations/runbook.md),
[Cloud Crawler's](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/blob/main/docs/operations/runbook.md)).
So the website's weekly run does not open add-on pull requests, and the
`hcw-manifest` App (the GitHub App this repository's own bot workflows commit
as, the one the issue proposed installing on the three add-ons) does not need
to be installed there for this.

**The one move it refuses.** The workflow moves the base within a Python minor
line (3.14.8 to 3.14.10, say) on its own. A move to another minor line it
refuses, naming the two lines, and the run ends red with no pull request:
the add-on's Dockerfile names `python3.14` paths and its `pyproject.toml` pins
`requires-python` to the line, so a person has to move those with it. That
is the state on 2026-11-03: the website moved to `python:3.15.2-slim-trixie`
on 2026-10-31
([#1468](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1468)),
and every daily run since then has ended with "the website moved Python from
3.14 to 3.15 ... a person must decide" (for example Cloud Assessor
[run 41597788687](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/actions/runs/41597788687)),
while `base-follows-website` is red on `main` in all three. The fix is a
pull request in each add-on, by the add-on's own workstream, that moves the
Python line in the Dockerfile and `pyproject.toml` together with the base
lines; the next daily run after that merge should then go green again.

To see the drift at a glance, this prints the base digest each repository
carries (PowerShell, read only). When nothing is drifting all four digests are
identical; on 2026-11-03 the three add-ons still printed the 3.14 digest, which
is the drift described above:

```powershell
foreach ($r in 'HCW-HybridCloudWorks:lab-image', 'HCW-CloudAssessor_AddOn:infrastructure/docker', 'HCW-NetworkEyes_AddOn:infrastructure/docker', 'HCW-CloudCrawler_AddOn:infrastructure/docker') { $n, $d = $r -split ':'; $t = gh api "repos/saulpatinojr/$n/contents/$d/versions.env" -H "Accept: application/vnd.github.raw"; "{0,-26} {1}" -f $n, (($t | Select-String '^BASE_DIGEST=').Line) }
```

## What this does not cover

- It does not read the apps' dependencies for you; it tells you where to look.
- It does not update a pinned base image by itself: the lab images are bumped by
  [`lab-supply-chain.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/lab-supply-chain.yml),
  and the Python add-ons' base by each add-on's own
  `base-update` workflow (the section above).
- A finding in Azure itself (a resource, not a package) is out of scope here.

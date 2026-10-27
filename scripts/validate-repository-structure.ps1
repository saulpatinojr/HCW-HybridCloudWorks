$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$errors = [System.Collections.Generic.List[string]]::new()

# `.agents`, `.claude`, `hooks` and `tooling` are the agent harness — agent
# definitions, skills, playbooks, the Claude Code lifecycle hooks and the local
# workflow state manager that drive tooling against this repository. They are
# deliberately source-controlled, but they are not the site and they are not
# human-facing project documentation, so the documentation policy below does
# not apply to them and they are excluded from the Markdown scan entirely.
#
# `.agentic` is that harness's per-run state and is gitignored, but the check
# below enumerates the live filesystem with -Force rather than the git index,
# so it must be allowlisted here or every local run reports it as unexpected.
$harnessDirectories = @('.agents', '.claude', 'hooks', 'tooling', '.agentic')

# .vscode is the Azure Functions dev loop — the tasks.json that runs
# `func host start` against functions/, and the launch.json that attaches the
# debugger to it. The Azure Functions extension generates them and expects
# them tracked, so they are source-controlled rather than gitignored. Note
# this check enumerates the live filesystem with -Force, not the git index:
# gitignoring .vscode would not have quieted it, only allowlisting does.
# node_modules is gitignored and never reaches a CI checkout, but a root-level
# `vitest` run leaves a .vite cache there and this check walks the live
# filesystem, not the git index. It is already pruned from the Markdown scan by
# $unscannedDirectories below; allowlisting it here keeps local runs from going
# red on a regenerable cache that CI will never see.
# `edge` holds Cloudflare Worker source (ADR 0024) — code that runs on the
# edge rather than in Azure, deployed by the owner with wrangler, unit-tested
# in CI. Its documentation lives on the docs site (runbooks/availability-probe)
# like every other component's; the directory carries only source, config and
# tests.
#
# `docs` is the documentation source (2026-09-06, issue #360): MkDocs builds it
# into https://docs.hybridcloudworks.com through docs-pages.yml. It replaced
# `wiki/`, whose pages were overlaid onto the GitHub Wiki; the Wiki was retired
# on 2026-09-06 and its feature is now switched off in repository settings.
# `site` is the build output and is gitignored, but this
# check walks the filesystem, so it is allowed here for local runs.
#
# .qlty holds qlty.toml, the Qlty CLI and Qlty Cloud configuration (#568). Qlty
# reads it only from .qlty/ at the repository root, so it lives there by tool
# convention, like mkdocs.yml below. A local `qlty check` also runs ruff, which
# leaves .ruff_cache at the root; that cache ignores itself (it writes its own
# .gitignore) and never reaches CI, but this check walks the filesystem.
#
# `infra-lab` is the second Terraform root module (#661, ADR 0032): the
# Hostinger lab host and its DNS, in the hcw-lab HCP Terraform workspace. It
# sits beside infra/ rather than inside it so the two states never meet.
# obsidian-plugin is the desktop companion's source and tests. Its operating
# instructions live under docs/runbooks with the rest of the application.
$allowedDirectories = @('.azure', '.github', '.qlty', '.ruff_cache', '.vscode', 'docs', 'edge', 'frontend', 'functions', 'infra', 'infra-lab', 'lab-host', 'lab-image', 'node_modules', 'obsidian-plugin', 'scripts', 'site', 'vps-agent') + $harnessDirectories

# The engineering plan documents are companions to the approved architecture and
# are referenced from README.md and from each other; they stay at the root.
#
# CHANGELOG.md and TODO.md are the working documents mandated by the
# Code Review SOP (CODE_REVIEW_PROMPT.md v1.0, Phase 10). They are the
# machine-readable handoff surface an orchestrating agent reads between sessions
# — TODO.md in particular must exist even when empty, so that "no outstanding
# work" is a readable state rather than a missing file. They are deliberately
# exempt from the docs/ policy below: docs/ holds human-facing narrative
# documentation, these hold review state. The docs site pulls all three in at
# build time (scripts/docs/hooks.py), so they are published without moving.
#
# This consolidation has now happened twice, for the same reason both times.
#
# CHECKLIST.md and Variables.md were merged into REVIEW.md on 2026-08-20 and
# deleted: three documents described one thing — the required-input inventory,
# the variable catalogue, and the blockers that depend on both — with the same
# facts in each and disagreeing between them, which is what let a variable read
# `Missing` in one and `Set` in another.
#
# REVIEW.md itself was retired on 2026-08-29 for the same failure one level up:
# it restated TODO.md's owner-gated items. Its work sections went to TODO.md
# and from there, on 2026-09-05, to GitHub issues; its Part 4 inventory is
# docs/standards/required-inputs.md, which keeps the §4.x numbering that
# roughly sixteen code comments cite.
#
# Do not recreate any of the three.
$allowedRootFiles = @(
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  'README.md',
  # MkDocs configuration for the docs site (issue #360). MkDocs reads it from
  # the directory it is run in, so it lives at the root by tool convention.
  'mkdocs.yml',
  # Scanner suppression files (#567). gitleaks and checkov read them from the
  # directory they run in, so they live at the root by tool convention. Every
  # entry in either is a row in docs/security/scanner-triage.md.
  '.gitleaksignore',
  '.checkov.yaml',
  # CodeRabbit's configuration (owner request 2026-10-08). CodeRabbit reads it
  # only from the repository root, so it lives there by tool convention.
  '.coderabbit.yaml',
  # The repository licence (owner decision 2026-09-28, #780: Apache-2.0).
  # GitHub detects a repository's licence from a LICENSE file at the root, and
  # Apache practice keeps NOTICE beside it, so both live at the root by
  # convention. Both are also required below.
  'LICENSE',
  'NOTICE',
  # Three files left the root on 2026-08-29. Architecture_Plan.md and
  # Migration_Plan.md were archived records rather than live documents and moved
  # to wiki/ (now docs/history/), so they publish as documentation instead of
  # reading as current work.
  # REVIEW.md held the owner-gated half of the open work, every item of which was
  # already mirrored in TODO.md under "Gate: owner" — a second document restating
  # the first; its work sections went to TODO.md (now GitHub issues) and its
  # Part 4 inventory is docs/standards/required-inputs.md.
  #
  # Each is REJECTED here rather than permitted, so none can quietly return.
  # The three left are the ones that are actually maintained.
  'CHANGELOG.md',
  'TODO.md',
  # The dated handoff note for continuing work away from the desk (owner request
  # 2026-10-27, #1450). It is replaced at each handoff, not appended to, and it
  # is NOT part of the docs site (scripts/docs/hooks.py pulls in only README,
  # CHANGELOG and TODO). It is the one root file added on request, so it is
  # also scanned by scripts/docs/check_redaction.py: a pasted tenant id or a
  # local path in it fails the docs workflow like it would in docs/.
  'MEMORY.md'
)

# Guard the casing explicitly: on a case-insensitive filesystem (Windows,
# default macOS) `Todo.md` and `TODO.md` collide, so a careless checkout or
# editor save can silently reintroduce a lower-case variant. (Written for
# `Review.md` vs `REVIEW.md`, the collision that actually happened; REVIEW.md is
# gone but the hazard is identical for the files left.) The allowlist above is
# compared case-sensitively by -in on Linux CI but not on Windows, so this
# check is what actually holds the line for local runs.
$casingSensitiveNames = @('TODO.md', 'CHANGELOG.md', 'MEMORY.md')

# Directory names never walked by the Markdown scan, at any depth.
#
# .terraform holds vendored provider plugins, several of which ship their own
# CHANGELOG.md. It is gitignored, so CI never sees it — but this scan walks the
# filesystem, not the git index, so without this entry the gate fails for any
# developer who has run `terraform init`. Same for build and coverage output,
# and for .qlty, whose gitignored sources/ checkout carries plugin READMEs
# after any local `qlty check`.
$unscannedDirectories = @('.git', 'node_modules', '.terraform', 'dist', 'coverage', '.reports', '.qlty', '.ruff_cache') + $harnessDirectories
$unscannedPattern = '(^|/)(' + (($unscannedDirectories | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')/'

$actualDirectories = Get-ChildItem -LiteralPath $repositoryRoot -Directory -Force |
  Where-Object Name -ne '.git' |
  Select-Object -ExpandProperty Name
foreach ($directory in $actualDirectories) {
  if ($directory -notin $allowedDirectories) {
    $errors.Add("Unexpected root directory: $directory")
  }
}

$actualRootFiles = Get-ChildItem -LiteralPath $repositoryRoot -File -Force |
  Select-Object -ExpandProperty Name
foreach ($file in $actualRootFiles) {
  if ($file -notin $allowedRootFiles) {
    $errors.Add("Unexpected root file: $file")
  }
  # Reject a case variant of a SOP document (e.g. Todo.md vs TODO.md).
  $casingMatch = $casingSensitiveNames |
    Where-Object { $_ -ieq $file -and $_ -cne $file }
  if ($casingMatch) {
    $errors.Add("Root file has wrong casing: found '$file', expected '$casingMatch'")
  }
}

# The SOP documents must exist. TODO.md is the one an orchestrating agent reads
# for the accepted risks and the index to open issues, so its absence is
# indistinguishable from "the file was never written" — require it even when it
# holds no items.
foreach ($requiredFile in @('README.md', 'CHANGELOG.md', 'TODO.md')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $requiredFile))) {
    $errors.Add("Missing required SOP document: $requiredFile")
  }
}

# The licence files must exist (#780). Without LICENSE, GitHub reports the
# repository as unlicensed, and sponsor programmes that require an OSI-approved
# licence treat it that way too. NOTICE carries the copyright line and says
# that third-party marks are not covered by the licence.
foreach ($requiredFile in @('LICENSE', 'NOTICE')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $requiredFile))) {
    $errors.Add("Missing required licence file: $requiredFile")
  }
}

# `docs` left this list on 2026-09-06 when it became the documentation source
# (issue #360); it is allowlisted above instead.
$prohibitedDocumentationPaths = @(
  'frontend/documentation',
  'frontend/docs',
  'frontend/README.md',
  'frontend/CHANGELOG.md',
  'frontend/TODO.md',
  'frontend/TODO2.0.md',
  'frontend/scripts/README.md',
  'vps-agent/README.md'
)
foreach ($relativePath in $prohibitedDocumentationPaths) {
  if (Test-Path -LiteralPath (Join-Path $repositoryRoot $relativePath)) {
    $errors.Add("Human-facing documentation must be under docs/: $relativePath")
  }
}

# Prune the harness (and .git / node_modules) from the walk rather than
# filtering afterwards, so the scan does not descend thousands of agent files.
# The previous filter compared against '*\.git\*' with Windows separators and
# therefore matched nothing on the Linux CI runner.
$scanRoots = Get-ChildItem -LiteralPath $repositoryRoot -Directory -Force |
  Where-Object { $_.Name -notin $unscannedDirectories }

$markdownFiles = @(Get-ChildItem -LiteralPath $repositoryRoot -Filter '*.md' -File -Force)
foreach ($scanRoot in $scanRoots) {
  $markdownFiles += Get-ChildItem -LiteralPath $scanRoot.FullName -Recurse -Filter '*.md' -File -Force |
    Where-Object {
      $rel = [System.IO.Path]::GetRelativePath($repositoryRoot, $_.FullName).Replace('\', '/')
      $rel -notmatch $unscannedPattern
    }
}

foreach ($markdownFile in $markdownFiles) {
  $relativePath = [System.IO.Path]::GetRelativePath($repositoryRoot, $markdownFile.FullName).Replace('\', '/')
  $isAllowed = $relativePath -eq 'README.md' -or
    $relativePath -in $allowedRootFiles -or
    # GitHub Copilot reads frontend/.copilot/ (agent prompts, instructions,
    # llms.txt) from the frontend project; .github/templates/ holds the
    # document templates used as needed. Both restored 2026-09-06 (owner
    # decision) after #346 removed them in error.
    $relativePath.StartsWith('frontend/.copilot/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $relativePath.StartsWith('.github/ISSUE_TEMPLATE/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $relativePath.StartsWith('.github/templates/', [System.StringComparison]::OrdinalIgnoreCase) -or
    # GitHub Copilot code review reads agent skills from .github/skills/ —
    # the canonical home of the hcw-code-review skill (owner decision,
    # 2026-09-01, relocated from .claude/skills/ which Copilot cannot read).
    $relativePath.StartsWith('.github/skills/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $relativePath -eq '.github/pull_request_template.md' -or
    # Tooling-adjacent documentation, allowed by the same README clause that
    # keeps Markdown "next to that tooling": GitHub renders CONTRIBUTING,
    # SECURITY, SUPPORT and CODE_OF_CONDUCT from .github/ as the repository's
    # community health files (the last two by owner decision, #1033), and
    # infra/README.md is the Terraform-standard module doc for the deployment
    # source of truth. Narrative documentation still belongs under docs/.
    $relativePath -eq '.github/CONTRIBUTING.md' -or
    $relativePath -eq '.github/SECURITY.md' -or
    $relativePath -eq '.github/SUPPORT.md' -or
    $relativePath -eq '.github/CODE_OF_CONDUCT.md' -or
    $relativePath -eq 'infra/README.md' -or
    # infra-lab/README.md is the same Terraform-standard module doc for the
    # hcw-lab root module (#661), and carries the owner's adoption steps and
    # the plan counts that must be read before any apply.
    $relativePath -eq 'infra-lab/README.md' -or
    # lab-image/README.md is the same kind of file for the hcw-lab Dockerfile
    # (#674): what the two build targets carry, their measured sizes, and how a
    # version in versions.env is bumped, next to the files it describes.
    $relativePath -eq 'lab-image/README.md' -or
    # lab-image/sandbox-template/ is the Docker Sandboxes recipe (#676): its
    # README is the build, load and run procedure next to the Dockerfile, and
    # AGENTS.md is a file the Dockerfile copies into the image — the agent's
    # briefing, which has to be Markdown because that is what agents read.
    $relativePath -match '^lab-image/sandbox-template/(README|AGENTS)\.md$' -or
    # lab-host/ is the Ansible bootstrap for the Hostinger lab host (#662).
    # Its README and one README per role are the same tooling-adjacent kind
    # as infra/README.md: the Ansible convention keeps a role's README inside
    # the role, next to the argument_specs it summarises.
    $relativePath -eq 'lab-host/README.md' -or
    $relativePath -match '^lab-host/ansible/roles/[a-z_]+/README\.md$' -or
    # lab-host/coder/ holds the Coder Compose file and the hcw-lab workspace
    # template (#679). Its README is the deploy and update procedure next to
    # the files it describes, and the template's README is what Coder shows
    # learners on the template page, so it has to sit in the template directory.
    $relativePath -match '^lab-host/coder/(templates/[a-z-]+/)?README\.md$' -or
    # Documentation source: pages here are reviewed via PR and published to
    # https://docs.hybridcloudworks.com by .github/workflows/docs-pages.yml on
    # merge to main (issue #360; replaced wiki/ on 2026-09-06). This is the one
    # sanctioned in-repo home for narrative documentation.
    $relativePath.StartsWith('docs/', [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $isAllowed) {
    $errors.Add("Unexpected Markdown outside docs/: $relativePath")
  }
}

$readme = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'README.md')
foreach ($requiredText in @('docs.hybridcloudworks.com', 'Azure Static Web Apps', 'Azure Functions')) {
  if (-not $readme.Contains($requiredText)) {
    $errors.Add("README is missing required current-state text: $requiredText")
  }
}

$planPath = Join-Path $repositoryRoot '.azure/infrastructure-plan.json'
if (-not (Test-Path -LiteralPath $planPath)) {
  $errors.Add('Missing machine-readable infrastructure plan.')
} else {
  $plan = Get-Content -Raw -LiteralPath $planPath | ConvertFrom-Json
  if ($plan.meta.status -ne 'approved') {
    $errors.Add('Infrastructure plan status must remain approved until superseded explicitly.')
  }
}

if ($errors.Count -gt 0) {
  # -ErrorAction Continue, because $ErrorActionPreference is 'Stop' at the top
  # of this file and Write-Error is therefore TERMINATING: without it the
  # first finding stops the script, the rest are never printed and `exit 1`
  # is never reached. The job still fails — the terminating error exits
  # non-zero on its own — so the bug is invisible from CI's red/green and
  # shows up only as an operator fixing one problem, re-running, and finding
  # another. Measured on pwsh 7.4.6: 1 of 3 findings printed before, 3 of 3
  # after, exit code 1 either way.
  $errors | ForEach-Object { Write-Error $_ -ErrorAction Continue }
  exit 1
}

Write-Output 'Repository structure policy passed.'

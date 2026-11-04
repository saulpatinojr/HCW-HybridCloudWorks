# Contributing

This repository is the HybridCloudWorks website, its Azure backend, supporting
infrastructure, and delivery source. It runs under a strict documentation and
review discipline — read this before your first pull request.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). For
questions and requests rather than changes, see [SUPPORT.md](SUPPORT.md).

## Where things go

| Content | Home |
| --- | --- |
| Narrative documentation (architecture, runbooks, ADRs, analysis) | [docs.hybridcloudworks.com](https://docs.hybridcloudworks.com) — source in `docs/`, built by MkDocs (`mkdocs build --strict` runs on every PR) and deployed to GitHub Pages on merge |
| Open work (engineering and owner-gated alike) | [GitHub issues](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues), each carried on the public [HCW Work Board](https://github.com/users/saulpatinojr/projects/6) with a Priority; `TODO.md` at the root keeps only accepted risks and an index |
| Completed work | `CHANGELOG.md` at the root |
| Tooling-adjacent docs (this file, `infra/README.md`, templates) | Next to the tooling, allowlisted in `scripts/validate-repository-structure.ps1` |

CI enforces this via the Repository Policy workflow. If you add a Markdown
file and CI rejects it, the fix is usually to move the content under `docs/` —
not to extend the allowlist.

## Workflow

1. Branch from `main`. No direct pushes to `main`.
2. Keep the SOP documents true: all new work — engineering and owner-gated
   alike — is a [GitHub issue](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues), added to the
   [HCW Work Board](https://github.com/users/saulpatinojr/projects/6) with its Priority set (owner decision
   2026-09-05, #362);
   `TODO.md` holds only the accepted risks and an index to the open issues;
   completed work goes to `CHANGELOG.md`; and new required inputs go to
   `docs/standards/required-inputs.md`. A code comment that points at open
   work names its issue (`#nnn`), never `TODO.md`. A `T-nnn` in a comment is
   provenance: it names a tracker item that closed by 2026-09-05, and its
   record is in `CHANGELOG.md` or the commit that closed it
   (`git log --grep T-nnn`).
3. Open a PR using the template; fill the verification section with what you
   actually ran.
4. CI must be green: the `gate` check (build/test), repository policy, dependency review, and — for
   `infra/**` — IaC validation (fmt, validate, tflint, Trivy).

## Infrastructure changes (`infra/`)

The environment is **live production** with state in HCP Terraform Cloud.

- Read `infra/README.md` and the
  [Deployment Runbook](https://docs.hybridcloudworks.com/runbooks/deployment-runbook/) first.
- Never rename a resource address without a `moved` block.
- Never commit state, saved plans, real `tfvars` values, or credentials.
- Attach the plan output (or TFC run link) to the PR.
- Production applies require human approval in HCP Terraform; nothing in
  GitHub auto-applies.

## Security

Never commit secrets. Required-Inputs holds references and formats only; a real
value appearing anywhere in Git history is treated as disclosed and rotated.
Report vulnerabilities per [SECURITY.md](SECURITY.md).

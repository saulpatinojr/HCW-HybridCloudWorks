# IaC Repository Standard

The standard every HybridCloudWorks infrastructure repository conforms to.
HCW-HybridCloudWorks is the reference implementation. An
`iac-repo-standardizer` agent in `.claude/agents/` used to apply it to other
repositories; it was removed on 2026-08-20 (`ba1168eb`), so the standard is
now applied by reading this page and checked in review.

## Principles

1. **The repository is the deployment source of truth.** If it isn't in Git,
   it isn't real; if it's in the portal but not in Git, it's drift.
2. **Credential-free by default.** Validation never needs secrets; delivery
   uses OIDC federation or remote execution. Static cloud credentials are
   prohibited everywhere, including CI secrets.
3. **Additive over restructuring.** Against a live environment, structure
   follows state: no address renames without `moved` blocks, no plan with
   destroy/create pairs on stateful resources.
4. **Documentation has exactly three homes.** Narrative → the published
   documentation site, built from `docs/` in the repository
   ([ADR 0027](../decisions/0027-documentation-site.md); it replaced the GitHub
   Wiki on 2026-09-06). Standing repository record → the SOP root documents
   `README.md`, `CHANGELOG.md` and `TODO.md`: what the repository is, what
   verifiably shipped, and the risks accepted rather than fixed. Open work is
   not among them — it moved to GitHub issues on 2026-09-05, and `TODO.md` is
   the index pointing there. Tooling docs → next to the tooling, allowlisted
   by the structure validator.
5. **Landing-zone absorbable.** Workload repos never create management
   groups, subscription-level policy, or deny assignments; they carry the
   tag contract and survive being moved under an ALZ.

## Required surface

### Root
| Item | Requirement |
| --- | --- |
| `README.md` | Status, documentation authority, layout table, delivery guardrails; updated with every structural or status change (CI-enforced) |
| `TODO.md` / `CHANGELOG.md` | Code Review SOP documents, exact casing, CI-enforced. Required-Inputs holds input references and formats, never values |
| `.gitignore` | `*.tfstate*`, `*.tfplan`, `.terraform/`, real `*.tfvars`, `.env*`, build output |
| `.editorconfig` | LF, UTF-8, consistent indentation |
| Structure validator | Script + CI workflow enforcing the root allowlist and Markdown policy |
| Version floors | Every runtime, OS and base image on its newest supported release, one tolerance per kind (Python, Terraform, Alpine and HashiCorp Vault N-2 patches; Node.js N-2 minors on the newest line its platform allows; PostgreSQL N-2 minors; Ubuntu the newest LTS; Debian the newest major), recorded in `scripts/version-floors.json`, and every lab job image in `vps-agent/lib/capabilities.js` governed by a kind, built here, or named as unsourced; every workflow job's `runs-on` names the newest Ubuntu LTS that GitHub-hosted runners offer as generally available (`ubuntu-26.04`), never `ubuntu-latest`; `scripts/version-floors.test.mjs` fails a pin below its floor, and a `package-lock.json` whose root `engines.node` differs from its `package.json`; `update-version-floors.yml` moves the floors and the runners ceiling weekly, and with them every `engines.node` range they leave behind within its line (#715, #1152) |

### `.github/`
| Item | Requirement |
| --- | --- |
| `CODEOWNERS` | Infra and workflow paths require infra review |
| `CONTRIBUTING.md`, `SECURITY.md` | Contribution rules; private vulnerability reporting |
| PR template | Infrastructure section: plan linked, no unexpected destroys, no unmoved renames, no secrets, tags preserved, required-input inventory updated |
| Issue templates | Bug report, feature request, ADR and FinOps finding (`.github/ISSUE_TEMPLATE/`). The infrastructure change request template was removed with the migration surface (`59e471b`); the PR template's "Infrastructure changes only" section now carries the plan, destroy and rollback checks |
| `dependabot.yml` | `github-actions` + every package ecosystem present |
| Workflows | Least-privilege `permissions:`; actions pinned (SHA preferred); credential-free CI + IaC validation on every PR; delivery gated by `workflow_dispatch` + protected Environment; never auto-apply on push |

### Terraform root (`infra/`)
| Item | Requirement |
| --- | --- |
| `README.md` | Posture, layout, local validation commands, guardrails, ALZ notes |
| File split | `backend.tf`, `providers.tf` (pinned versions), `variables.tf` (descriptions, `sensitive`, validations), `outputs.tf`, committed `.terraform.lock.hcl` |
| `.tflint.hcl` | terraform-recommended preset + provider ruleset |
| `terraform.tfvars.example` | Placeholders only |
| Stateful resources | `lifecycle { prevent_destroy = true }` |
| Tags | One `var.tags` on every resource: `workload`, `environment`, `owner`, `costCenter`, `managedBy`, `criticality`, `dataClassification` |
| Naming | CAF-style prefixes for new resources; never rename live resources to chase convention |
| State | Remote backend (HCP Terraform or locked+versioned azurerm backend), never Git |
| Identity | OIDC-federated deployment identity, subject-scoped to repo + ref/environment |
| Secrets | Values never transit Terraform state; seeded out-of-band, referenced in the required-input inventory |

### Documentation site (`docs/`)
| Page | Holds |
| --- | --- |
| [Deployment runbook](../runbooks/deployment-runbook.md) | Validate → plan → apply → verify → rollback → day-2 → ALZ absorption |
| [IaC repository standard](../standards/iac-repository-standard.md) | This page |
| [ADR register](../decisions/index.md) | One ADR per irreversible or material decision, written before implementation |

### Variable naming

| Rule | Example |
| --- | --- |
| **Max 2 words** (3 only when 2 is genuinely ambiguous) | `CLIENT_ID`, `TENANT_ID`, `SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `APP_HOSTNAME` |
| **Casing follows the language; the word count does not.** UPPER_SNAKE for GitHub, lower_snake for HCL | `CLIENT_ID` (GitHub) ↔ `client_id` (Terraform output) |
| No provider prefixes — the repo targets one platform; say what the value *is* | `client_id`, not `github_deploy_client_id` |
| Third word only to break a real collision | `app_principal_id` vs `deploy_principal_id`; `FUNCTIONS_STORAGE_ACCOUNT` vs the content account |
| An output that feeds a GitHub variable mirrors its name | output `app_hostname` → variable `APP_HOSTNAME` |
| Contractual names are exempt and never renamed | `VITE_*`, `GITHUB_TOKEN`, `process.env` app settings, provider-required attributes |
| Apply at creation; renaming a *set* variable is a coordinated one-PR change across setting + consumers | — |

Applies to GitHub Actions variables and secrets, Terraform variables **and
outputs**, and app settings the repository controls. Outputs count because
they are operator-facing — someone reads them off the state backend's
Outputs tab and pastes the value somewhere.

### Posture switches are counted by parts, not by words (decided 2026-08-28)

T-753 reported that a large share of `infra/variables.tf` runs to four or five
words — `functions_storage_admin_ip_rules`, `cosmos_allow_azure_datacenter_ips`,
`functions_scm_lock_enabled` — against a rule that caps names at two. It
recorded that code and standard disagreed and **neither was marked as the
loser**. The standard is the loser, and this is the amendment.

A posture switch or a scoped setting is named `<subject>_<predicate>`, and each
half is counted as one part even when it is itself compound:

| Name | Subject | Predicate |
| --- | --- | --- |
| `functions_storage_admin_ip_rules` | `functions_storage` — a different account from `storage` | `admin_ip_rules` |
| `cosmos_allow_azure_datacenter_ips` | `cosmos` | `allow_azure_datacenter_ips` |
| `functions_scm_lock_enabled` | `functions_scm` | `lock_enabled` |

**Why this way round.** The two-word rule exists so an operator reading a name
off the Outputs tab knows what the value is. Compressing these to two literal
words works against that: `storage_ip_rules` does not say *which* of the two
storage accounts, and this estate has one account whose firewall protects
content and another whose firewall gates deploys — confusing them during a
firewall window is how a deploy silently fails on a network denial that does
not announce itself as one. The rule's own escape hatch already anticipated
this ("third word only to break a real collision"); what it lacked was
permission for the subject to be two words when the resource genuinely is.

**What does NOT change.** The prohibition on provider prefixes, the
output-mirrors-variable rule, and the requirement that a rename of a *set*
variable is a coordinated one-PR change. And this carve-out is for posture
switches and scoped settings — not a general licence: a plain value still gets
two words.

**The alternative was rejected on cost, not on principle.** Renaming these
would touch the HCP Terraform workspace, `scripts/set-github-variables.ps1`,
every consuming workflow and the runbooks, to make already-clear names shorter.
That is a coordinated change with an outage mode — a variable renamed in code
but not in the workspace reverts to its default, and every one of these
defaults to the *safe* value, so the estate would quietly disarm itself.

Sweeps cover **every** file that declares a name, not a curated list:
`output` blocks live in feature files (`oidc.tf`), not only
`outputs.tf`. Each name sorts into exactly one bucket — **safe now**
(outputs; unset variables), **coordinated** (variables already set in the
state backend or GitHub — report, never rename silently), or
**contractual** (never touched). Review enforces it now that the
`iac-repo-standardizer` agent is gone, including flagging duplicate outputs for
consolidation.

## The bootstrap identity

Every credential-free repository has exactly one credential it cannot create:
the one the Terraform runner authenticates with. A configuration cannot
provision the identity it needs in order to provision anything. Repositories
routinely ship without this written down, because each file is individually
correct and only the join between them is missing — the standard therefore
makes the join a required artefact.

| Rule | Why |
| --- | --- |
| A runnable bootstrap script exists in `scripts/`, idempotent, with a preflight that reports what is missing rather than failing on it | It runs once, years apart, usually by someone who has not read the repo |
| The bootstrap identity is **excluded from Terraform state** and lives in its own resource group | If Terraform manages the credential it authenticates with, a destroy or bad plan locks the workspace out with no way back |
| The provider block's *lack* of credentials carries a comment saying where they come from | Otherwise the next reader "fixes" it by adding a client secret |
| The runbook's first section is bootstrap, and states plainly that nothing below it works until bootstrap is done | Ordering is the whole message |
| Where two OIDC handshakes exist (runner→cloud and CI→cloud), the runbook tables them side by side | They are both called "the OIDC setup" and only one is in the repository; confusing them is the default failure |
| The runner's own credentials are inventoried alongside application inputs | An unrecorded input is an input nobody provisions |
| Prefer federating a **user-assigned managed identity** over an app registration | App registrations need Entra directory roles; cloud-resource Owner does not grant them. Managed identities are ordinary resources and federate to arbitrary external issuers |

The preflight is what makes the script worth writing. Assume the operator has
a directory created minutes ago and no resources anywhere: check the CLI, the
sign-in, the tenant match, the subscription's visibility, the role assignments
actually held, and the resource providers registered — and when one fails, say
which command fixes it. In particular, detect the case where the operator
administers the directory but holds no resource-plane RBAC at all; that is the
normal state of a fresh tenant and it produces error messages that suggest the
wrong fix.

## ALZ-readiness checklist

- [ ] No management groups, subscription-level policy assignments, or deny
      assignments created in-repo
- [ ] Tag contract applied to every resource
- [ ] Diagnostics routed through a workspace that can be re-pointed
- [ ] Region explicit in a variable
- [ ] Runbook documents the absorption sequence (audit-mode policy inventory
      → remediate/exempt via PR + ADR → move subscription → verify RBAC,
      budget, OIDC, zero-drift plan)

## Standardization run — definition of done

1. Branch with additive changes; `fmt`, `validate`, tflint, and the
   structure validator all green.
2. SOP documents updated: CHANGELOG entry, and a tracker item for deferred
   work and for decisions only a human can make. (This repository moved that
   tracker from `TODO.md` to GitHub issues on 2026-09-05; `TODO.md` now holds
   accepted risks and the pointers to the board.)
3. Draft PR listing what was added, what was deliberately left alone and
   why, and the remaining gaps ranked by deploy-readiness impact.
4. Documentation-site pages created or updated to match.

---

*Adopted 2026-08-17. Reference implementation: HCW-HybridCloudWorks.*

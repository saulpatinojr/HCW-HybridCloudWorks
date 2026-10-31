# Architecture Decision Records

This directory is the canonical record of HybridCloudWorks architecture decisions. The architecture
describes the system as a whole; an ADR explains why a material choice was made, its purpose, its
tradeoffs, and when it must be reconsidered.

## Policy

Create an ADR before implementing a decision that changes any of the following:

- cloud service, hosting model, data store, network boundary, identity model, or trust boundary;
- availability, recovery, security, performance, observability, or cost posture;
- Terraform state, module strategy, deployment authority, or GitHub governance;
- migration, compatibility, cutover, decommission, or repository ownership;
- external integration contract or irreversible operational behavior.

ADR numbers are never reused. The register carries one historical exception: 0021 was assigned
twice, first to the deferred Container Apps CI runner record and then to Key Vault purge protection,
before this rule was written down; both records are kept and marked so the collision cannot be
mistaken for a revision. Accepted ADRs are immutable except for spelling, links, and status. A
changed decision gets a new ADR that supersedes the old one. Pull requests implementing architecture
must link the applicable ADRs. If no ADR applies, the pull request must say why the change is not
architecturally significant.

## Status lifecycle

`Proposed` → `Accepted` → `Superseded` or `Deprecated`

- **Proposed:** under review and not authorized for implementation.
- **Accepted:** approved direction; implementation may still be incomplete.
- **Superseded:** replaced by a newer ADR, which must be linked.
- **Deprecated:** retained for history but no longer applicable.

## Required sections

Every ADR includes:

1. status and decision date;
2. context and problem;
3. purpose and decision drivers;
4. decision;
5. consequences and accepted risks;
6. alternatives considered;
7. validation and revisit triggers;
8. related decisions and references.

## Decision register

> **Reading a `T-NNN` in these records.** Several ADRs cite findings as `T-503`,
> `T-519`, `T-706` and so on. These were the repository's own tracked-finding
> identifiers, assigned in the root `TODO.md` and used by the
> [2026-08 architecture review](../architecture/architecture-review-2026-08.md),
> which states each finding in full under its own heading. The scheme was retired on
> 2026-09-05 when open work moved to GitHub issues; a `T-` number in an accepted
> ADR is a historical citation, not a live ticket, and the sentence around it is
> meant to carry the meaning on its own.

| ADR | Decision | Status | Primary purpose |
| --- | --- | --- | --- |
| [0001](../decisions/0001-single-repository.md) | Consolidate HCW into one repository | Accepted | Prevent application/platform drift |
| [0002](../decisions/0002-cloudflare-edge.md) | Retain Cloudflare as the initial edge | Accepted | Preserve edge capability within budget |
| [0003](../decisions/0003-cosmos-serverless.md) | Start with Cosmos DB Serverless | Accepted | Match document workload and spiky demand |
| [0004](../decisions/0004-functions-boundaries.md) | Separate API, worker, and labs Function Apps | Superseded by 0019 | Enforce trust and permission boundaries |
| [0005](../decisions/0005-github-terraform-delivery.md) | Use AVM Terraform and GitHub OIDC delivery | Accepted; module clause superseded by 0020; amended 2026-10-07 (the Terraform run identity's grants: ABAC condition held by the operator script, Contributor scoped to its resource groups in two steps, team tokens owner-gated) | Make infrastructure changes reviewable and credentialless |
| [0006](../decisions/0006-admin-identity.md) | Use Entra ID for administrators only | Accepted | Protect administration without requiring public accounts |
| [0007](../decisions/0007-static-first-frontend.md) | Preserve static-first rendering on Static Web Apps | Accepted | Keep public content fast and backend-independent |
| [0008](../decisions/0008-selective-private-link.md) | Use selective Private Link | Accepted | Secure sensitive data while containing network cost |
| [0009](../decisions/0009-production-state.md) | Use one production workload state | Accepted | Match current operating scale without environment sprawl |
| [0010](../decisions/0010-observability.md) | Centralize bounded observability | Accepted; alerting layer delivered by 0022 | Make health and change outcomes measurable |
| [0011](../decisions/0011-single-region-recovery.md) | Use single-region, zone-aware recovery | Accepted | Balance reliability with the USD 150 ceiling |
| [0012](../decisions/0012-asynchronous-workflows.md) | Use queues and idempotent workers for side effects | Accepted | Make publishing and integrations retry-safe |
| [0013](../decisions/0013-ai-provider-strategy.md) | Use Azure OpenAI as a feature-gated default | Accepted; provisioning gate ratified by 0018 | Remove the Vertex dependency without making AI critical path |
| [0014](../decisions/0014-storage-and-media.md) | Keep source media private in ZRS Blob Storage | Accepted; ZRS amended to LRS by 0018 | Protect and recover media economically |
| [0015](../decisions/0015-cost-governance.md) | Enforce a USD 150 monthly design ceiling | Accepted | Make cost an implementation constraint |
| [0016](../decisions/0016-reversible-migration.md) | Use reversible migration and explicit decommission gates | Accepted; decommission gate closed by 0023 | Prevent premature data or rollback loss |
| [0017](../decisions/0017-repository-history-remediation.md) | Re-root the default branch after credential rotation | Accepted | Remove reachable secret-bearing Git history |
| [0018](../decisions/0018-as-built-plan-v02.md) | Supersede plan v0.1 with the as-built v0.2 plan | Accepted; two debt rows closed by 0021 and 0022 | Make the approved plan describe the real system; disposition every deviation |
| [0019](../decisions/0019-single-function-app.md) | One Function App execution boundary | Accepted | Ratify least-privilege-by-contract over process separation |
| [0020](../decisions/0020-native-terraform-root-module.md) | Flat native-provider Terraform root module (no AVM) | Accepted | Keep resource addresses stable on a live state |
| [0021](../decisions/0021-key-vault-purge-protection.md) | Key Vault purge protection stays disabled | Superseded by [0031](../decisions/0031-security-scanner-owner-decisions.md) on 2026-09-14, which turned it on | Keep teardown-and-recreate available on a single-environment estate |
| [0021 (number reused)](../decisions/0021-container-apps-ci-runner.md) | Container Apps self-hosted CI runner failover | Superseded — deferred 2026-08-18 before the number was reassigned to Key Vault purge protection | Kept as the record of why a self-hosted CI runner was rejected. Its own text says the gated-off resources remain in `infra/ci-runner.tf`; that file was deleted on 2026-08-24 and the record is now purely historical |
| [0022](../decisions/0022-alerting-fabric.md) | The alerting fabric, and the signal it does not cover | Accepted | Make failure visible without competing with the telemetry that explains it |
| [0023](../decisions/0023-migration-estate-retirement.md) | Retire the migration-era estate, grants and reverse path | Accepted | Close the decommission gate deliberately rather than by neglect |
| [0024](../decisions/0024-edge-availability-probe.md) | Reachability probing from a Cloudflare Worker | Proposed (built and armed 2026-09-01 — see the note on the record) | Give the missing reachability alert a path that runs on the current Cloudflare plan, whose bot protection answers every datacenter-based monitoring client with a 403 |
| [0025](../decisions/0025-cosmos-firewall-datacenter-sentinel.md) | The Cosmos datacenter-IP sentinel — kept, then removed | Accepted; recommendation reversed by its own addendum | Weigh the review finding that the Cosmos firewall admits any Azure datacenter address against the cost of closing it — then remove that allowance once a cheaper route appeared |
| [0026](../decisions/0026-required-checks-filter-inside-the-job.md) | Required checks filter inside the job, not at the trigger | Accepted | Keep every merge gate while paying only for checks that can fail |
| [0027](../decisions/0027-documentation-site.md) | Documentation is a MkDocs site under `docs/`, published to docs.hybridcloudworks.com | Accepted | One reviewed, validated, redaction-gated source for every page; the Wiki is retired |
| [0028](../decisions/0028-cosmos-out-of-account-export.md) | Cosmos recovery is a weekly full export plus daily change-feed deltas, run by the Function App, kept on the RA-GRS content account | Proposed | Survive account or region loss for about $4 a month, proven by a timed restore. Four points in the design still await the owner's approval on the issue that commissioned it |
| [0029](../decisions/0029-podcast-hosting-and-audio-surface.md) | Podcast hosting is Podbean, the podcast page is the one audio surface, and the media route serves byte ranges | Accepted; §1 amended 2026-10-13 (§1c: the show moved from RSS.com to Podbean, and publishing with it) | Replace the retired host, put both audio systems on one seekable page, and unblock a self-hosted feed for later |
| [0030](../decisions/0030-newsletter-provider.md) | The newsletter provider is Resend, and the site owns the schedule | Accepted | Klaviyo's free plan cannot send a weekly newsletter past 115 subscribers; keep the cadence in the timer that already drafts it, and end the half-wired read-only integration |
| [0031](../decisions/0031-security-scanner-owner-decisions.md) | Key Vault purge protection on, Microsoft-managed keys, no private endpoints, and storage resource logs within the log cap | Accepted | Clear the Qlty security findings with real changes where the owner chose them, and a recorded decision where not |
| [0032](../decisions/0032-learner-labs-platform.md) | The learner labs platform: a Terraform-managed Hostinger host in its own `hcw-lab` workspace, Ubuntu 26.04 with Docker only, Azure Arc as the hybrid control plane, Coder as the learner identity boundary, digest-pinned images from `lab-image/`, and public submission locked to the site's pane | Accepted 2026-09-27; §6 revised 2026-09-28 (public submission open only from the Landing Zone Builder's pane, by origin and Cloudflare Turnstile, bounds unchanged); amended 2026-10-07 (Arc agent guest configuration off, owner decision) | Record once the decisions the four lab epics (#656, #657, #658, #659) build on, so a lab experiment can never reach production state, secrets or sign-in |
| [0033](../decisions/0033-contentforge-alignment.md) | ContentForge as one content operating system: a navigation registry with a sentence per item, one pipeline graphic, a content taxonomy (kind and idea origin) kept apart from publish type, Forge Studio as a workspace, per-task AI routing, image lineage from prompt set to gallery, one aggregated calendar, an audio library of books and chapters with versions, labs per provider, a new Ambassador module, and Health over every hub | Accepted 2026-10-03 | Twenty-six admin pages had grown one hub at a time; the inventory found a blocking approve bug, two identical pipeline strips, five status vocabularies and features that created things and lost them |
| [0034](../decisions/0034-ai-model-selection.md) | AI model selection: one global priority list, a per-task mode (recommended, global, custom chain), a model catalogue the providers populate, every modality a task, and policy locks in code | Accepted 2026-10-04 | Three overlapping controls (order, placement, routing) put the free trial tier ahead of the paid provider the owner had just chosen; model lists were typed into the seed
| [0035](../decisions/0035-addon-pane-model.md) | The AddOn pane model: each independently built tool is a sandboxed pane on its own lab name, with a generic site page at `/tools/<id>`, a catalogue row, a Function App status proxy, a `frame-src` entry and a generic `addons` Ansible role on the lab host, digest-pinned from Docker Hub | Accepted 2026-10-10; decisions 8 (AddOn containers beside Coder on the host) and 9 (`allow-downloads`) confirmed by the owner in #1044 | Show the three App-to-AddOn program tools (migration, cloud assessment, network assessment) without taking their code, secrets or release cadence into the site, keeping `connect-src` closed and the secret boundary on the lab host
| [0036](../decisions/0036-code-conductor-brain.md) | The Code Conductor brain is a second private workspace with its own Cosmos database (`hcw_code_brain`) in the existing account, its own switches, owner, desktop client and `code_brain_sync` scope, sharing the creator Second Brain's save and sync code | Accepted 2026-10-31; built switched off, activation is the owner's | Reuse the proven notes-and-sync setup for engineering notes without any path between the two workspaces, and back the new notes up before they exist

## Template

Copy the [ADR template](../decisions/template.md) for new decisions. Do not edit an accepted ADR to represent a new
decision; create the next numbered record and mark the earlier ADR superseded.

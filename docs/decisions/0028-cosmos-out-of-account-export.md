# ADR 0028: Cosmos recovery is a weekly full export plus daily change-feed deltas, run by the Function App, kept on the RA-GRS content account

**Status:** Proposed. The measurement settles the shape; four decisions listed
on issue #231 await the owner's approval.
**Decision date:** 2026-09-06
**Owners:** Workload owner and architecture owner

## Context

The Cosmos account `cosmos-site-prod-cus` is serverless, single-region
(Central US) for life, and has held `Continuous30Days` backup since 2026-08-28
(ADR 0018, T-707). Continuous backup gives point-in-time restore inside the
account. It does not give a copy that survives the account: Microsoft's own
words are that the backups "aren't automatically geo-disaster resistant". An
account deletion, a subscription loss or a Central US failure takes the data
and its backup together. Issue #231 exists to close that gap and to prove it
closed with a timed restore.

The design waited on one number. On 2026-09-06 the owner read the account's
`DataUsage` metric: **2,386,591,744 bytes, 2.39 GB**, index and every
container included. The cost model built on it lives in
[Cost analysis](../architecture/cost-analysis.md#cosmos-backup-and-export-costed-against-the-measured-size-2026-09-06);
the short version is that reading the whole account once costs about $0.60 in
request units, so *how often the whole account is read* is the only cost lever
that matters, and storage tier is a rounding error.

Three facts about the estate shape the runtime:

- **The Cosmos firewall admits the Function App's subnet and nothing in a
  datacenter range** (ADR 0025). A GitHub runner cannot reach the account, so
  the exporter cannot be a workflow. It has to run inside Azure.
- **The Function App's managed identity already holds Cosmos Built-in Data
  Contributor on the account and Storage Blob Data Contributor on
  `stsiteprodcus01`** (`infra/cosmos.tf`, `infra/storage.tf`). No new identity
  and no new credential is needed; the exporter is a read on one side and a
  write on the other, both already granted.
- **The app already runs timers that fan work out onto a storage queue and a
  queue-triggered worker** (`jobs-sweeper.js`, `jobs-worker.js`). A 2.39 GB
  read does not fit in one timer invocation with a 30-minute default timeout;
  61 bounded per-container jobs — one per exported container — do.

## Purpose and decision drivers

- **Reliability.** Recover the authored content and the configuration that
  runs the site after the account itself is lost, to an objective someone has
  agreed to, proven by a restore that was timed rather than assumed.
- **Cost.** The whole platform bills in the tens of dollars a month under a
  USD 150 ceiling. Recovery must not become a visible line; the model says it
  need not.
- **Security.** No new credential, no account key, no document contents or
  identifiers in logs, no backup data in git or in a workflow artifact.
- **Operational excellence.** The export is monitored by its absence: an alert
  fires when a run *did not* complete, because a job that fails quietly is the
  same as no backup.

## Decision

### 1. Cadence: a weekly full export, daily change-feed deltas, deletes reconciled by the weekly full

Every Sunday the exporter reads every included container in full. Every other
day it reads each included container's change feed from the continuation token
the previous run stored, so a daily delta carries only the documents that
changed. The cost model puts this at **about $3–4 a month** in request units
against **about $18** for a daily full, for the same 24-hour recovery point.

Deletes are handled explicitly, because the default (latest-version) change
feed mode does not emit them. The weekly full is the reconciliation: a
document deleted on Tuesday is absent from Sunday's full, so a restore from
"latest full plus deltas since" brings back at most one week of documents that
had been deleted on purpose. That is accepted and written into the restore
runbook as a known property, not discovered during a drill. Cosmos offers an
all-versions-and-deletes change feed mode that does emit deletes; it requires
continuous backup (which the account has) and a reader that never falls outside
the retention window. It is the revisit path if a week of resurrected deletes
turns out to matter; it does not change the cost.

### 2. Scope: six classes of container, three of them exported

The 74 provisioned containers are classified against
`infra/cosmos-containers.json` and the dispositions in
`scripts/lib/migration-manifest.mjs`. The list is code — a single exported
array the exporter reads and a test asserts covers every provisioned container
exactly once — so a new container fails the build until someone classifies it.

| Class | Rule | Containers | Export |
| --- | --- | --- | --- |
| **A — authored** | Written by a person or by an AI run a person reviewed; not recoverable from anywhere else | `content`, `content_versions`, `blogs`, `content_templates`, `certifications`, `certEvents`, `speakerevents`, `podcasts`, `episodes`, `youtubevideos`, `recordings`, `plaud_ingest`, `newsletters`, `roadmap_items`, `wiki_pages`, `listen_and_learn`, `listen_and_learn_episodes`, `podcast_transcripts`, `designs`, `frameworks`, `pillar_details`, `pillar_items`, `social_posts`, `prompts`, `prompt_keyword_synonyms`, `prompt_keyword_augmentations`, `image_prompts`, `image_prompts_sets`, `image_prompt_sets`, `image_prompt_sets_prompts`, `image_prompt_pages`, `generated_content_images`, `curated_article_images`, `character_profiles`, `character_modules`, `character_images`, `character_tag_adjectives`, `tool_workspaces`, `tool_migration_workspaces`, `tool_assessment_sessions`, `tool_architecture_plans`, `tool_exports`, `mcp_servers`, `lab_agents` | Weekly full + daily deltas |
| **B — configuration** | Small, and the site does not run without it | `admins`, `admin_config`, `admin_settings`, `site_settings`, `system`, `config`, `config_providers`, `config_settings`, `config_tags`, `ai_providers` | Weekly full + daily deltas |
| **C — operational record** | Rows the platform writes about itself; useful for forensics, not needed to run | `admin_audit_logs`, `audits`, `ai_usage`, `telegram_bot_activity`, `workflow_alerts`, `workflow_digests`, `content_stats_markers` | Weekly full only, no deltas |
| **Excluded — regenerable** | Refilled by a scheduled job or a publish; the source is a class A container or the network | `_snapshots` (re-published from `content`), `homepage_feeds`, `rss_cache`, `tool_service_cache`, `tool_price_history` (daily snapshots the pricing refresh writes; refilled going forward, not backfilled) | Not exported |
| **Excluded — seed** | Re-created by a seeding script in this repository | `azure_landing_content`, `tool_service_catalog` | Not exported; the script is the backup |
| **Excluded — transient** | TTL-bounded runtime state, worthless after the window | `jobs`, `lab_jobs`, `lab_public_quota`, `submission_quota`, `tool_ai_plan_quota`, `tool_export_quota` | Not exported |

That is 44 + 10 + 7 = 61 exported, 13 excluded, 74 in all. (72 at this
record's writing; `podcast_transcripts` joined class A on 2026-09-08 for #435 —
the podcast's own container, kept apart from `listen_and_learn_episodes` by
owner ruling — and `tool_price_history` joined the regenerable exclusions on
2026-09-15 for #613 Phase 3.) Issue #231 reports the
metric against 73 containers; the spec provisioned 72 at the time, so implementation starts
with an inventory of the live account against `infra/cosmos-containers.json`,
and an unprovisioned container is classified or removed before the first run.

### 3. Runtime: one timer, one queue message per container, one worker per message

- A timer (`cosmosExportScheduler`) runs daily at 03:00 UTC, decides *full* or
  *delta* from the day of week, mints a run id from the UTC date, and enqueues
  one message per exported container onto the existing platform jobs queue.

  > **Amended 2026-09-07 (#416).** "03:00 UTC" was written here on 2026-09-06
  > and was not true when written. The schedule is the bare NCRONTAB hour
  > `0 0 3 * * *`, and the Function App then set
  > `WEBSITE_TIME_ZONE = America/Chicago`, so the exporter ran at 03:00
  > Central — 08:00 UTC in CDT, 09:00 in CST. Nothing computed wrongly (the
  > run id and the full/delta decision were already taken from the UTC clock),
  > but the operator-facing alert description said 03:00 UTC too. The owner's
  > decision was that all times in this app are UTC, so the app setting was
  > removed rather than this sentence corrected: the exporter now does run at
  > 03:00 UTC, five hours earlier than it had been. Nothing else in this ADR
  > changes — the slot was chosen as low-traffic and 03:00 UTC (22:00 Central)
  > is as quiet as 03:00 Central was.
- The queue worker exports one container per message: full runs page through
  `SELECT * FROM c` with continuation tokens; delta runs read the change feed
  from the stored continuation and store the new one. Each page is appended to
  a gzip-compressed newline-delimited JSON block blob. Every job is bounded by
  the size of one container, which is what makes the 30-minute limit a
  non-issue.
- Each container job ends by writing a marker blob carrying document count,
  byte count and the `_ts` high-water mark. The last worker to finish (the one
  that finds all markers present) writes the run manifest. Nothing in any log
  line names a document; the telemetry carries container name, counts and
  duration only.
- A failed container job is retried by the queue's own poison handling, and a
  run with a missing marker after six hours is a failed run, surfaced by the
  alert below rather than by anyone reading the logs.

### 4. Storage: a private `cosmos-export` container on the RA-GRS content account, Cool tier, 35-day lifecycle

`stsiteprodcus01` is already RA-GRS with versioning and soft delete, already
`Deny` by default at the network, and already the account the Function App
writes to. The export goes to a new private container with a prefix per run
(`full/2026-09-07/`, `delta/2026-09-08/`) plus a `state/` prefix for
continuation tokens. Blobs are written at the Cool tier, and a lifecycle rule
scoped to the `cosmos-export` container deletes base blobs 35 days after
creation, so the store holds five weekly fulls and their deltas: about 12 GB,
under fifty cents a month.

The copy lives in a different Azure resource, in a different resource group,
geo-replicated to a paired region. It does not live in a different
subscription; that alternative is recorded below as the revisit path if
subscription-loss becomes the scenario being designed for.

> **Amended 2026-10-16 (PLAT-8, #968).**
> 1. **Export Immutability:** A time-based WORM immutability policy
>    (`azurerm_storage_container_immutability_policy.cosmos_export`) is enforced
>    on `cosmos-export` with a 35-day retention period (`immutability_period_in_days = 35`,
>    unlocked by default, lockable via `cosmos_export_immutability_locked`). This ensures
>    neither the application managed identity (`func_blob`) nor any non-owner role can delete
>    or overwrite backup blobs during the retention period.
> 2. **Continuation State Container:** Because container-level immutability blocks in-place
>    blob updates, change-feed continuation tokens (`state/${container}.json`) are isolated in
>    a dedicated mutable container `cosmos-export-state` (`azurerm_storage_container.cosmos_export_state`).
> 3. **90-Day Log Retention & PII Data-Plane Auditing:** Log Analytics workspace retention is
>    increased from 30 to 90 days (`logs_retention_in_days = 90`). Diagnostic settings for Cosmos DB
>    now enable `DataPlaneRequests`, filtered at ingestion time by an Azure Monitor workspace table
>    transformation (`transformKql`) to PII containers (`ambassador`), preserving a 90-day access
>    audit trail without exceeding the workspace daily ingestion quota.
> 4. **Out-of-Subscription Copy:** Full exports are archived quarterly to an offline or secondary
>    subscription storage account to mitigate subscription-loss risk.

### 5. Monitoring: alert on the missing run

A scheduled query rule in the existing alerting fabric (ADR 0022) fires to the
existing action group when no `cosmosExportCompleted` custom event with
`mode = full` has arrived in eight days, or none with `mode = delta` in two.
Success is silent; only absence pages. This is the same shape as the
`edge_probe_availability` rule.

### 6. Objectives: RPO 24 hours, RTO 8 hours, proven by a drill

Proposed for the owner's approval, as they were on #231. The drill that proves
them: restore the latest full plus its deltas into a fresh Cosmos account in a
scratch resource group, count documents per container against the run
manifest, spot-check that the site's public reads answer from it, time the
whole thing, tear it down. Cost model: about $3 in write request units per
drill, once a quarter. The runbook records what was *restored* and how long it
took, not what was configured.

### 7. Functions host storage: LRS when this was written, GRS since ADR 0031

> **Superseded on this point by [ADR 0031](0031-security-scanner-owner-decisions.md)
> (2026-09-14):** the owner chose geo-redundancy for the host account
> (checkov CKV_AZURE_206, trivy AZU-0058, "Function host storage
> geo-redundancy: yes"), and `infra/storage.tf` sets `Standard_GRS`. The
> estate assessment of 2026-10-06 (PLAT-7, #967) read Terraform as
> disagreeing with this section; it is this section that is older.

`stsitefuncprodcus01` holds two kinds of thing, and the two decisions are
about different kinds. The **deployment packages**, in the private
`function-releases` container the deployment runbook's break-glass
re-publish reads, are rebuilt by `deploy-functions.yml` from a commit, so
their loss costs one redeploy: that is the reasoning this section recorded
in 2026-09, and it still holds. The **host state** (timer schedule status,
singleton and listener leases, in-flight queue messages) has no commit to
be rebuilt from, so ADR 0031 chose GRS: the geo copy preserves it through a
regional loss, for cents a month on an account holding a few megabytes.
Recorded here so #231's checkbox has a decision behind it.

## Consequences and accepted risks

- **Up to a week of resurrected deletes** on a restore, because deletes reach
  the copy only through the weekly full. Accepted; the all-versions-and-deletes
  change feed is the revisit path.
- **The exporter shares the Function App's identity and its queue.** A bug in
  the exporter competes with the platform's other jobs for the same worker. The
  per-container bound and the 03:00 UTC slot are the mitigation; a dedicated
  queue is the escalation.
- **The copy is in the same subscription as the source.** Account and region
  loss are covered; subscription loss is not. Recorded, not solved.
- **One more timer and one more worker branch to test**, with a contract test
  that the classification covers every provisioned container.
- **Cost:** about $0.70–0.95 a week, $3–4 a month, all-in with storage; about
  $5 a month for the whole recovery posture including continuous backup and a
  quarterly drill.

## Alternatives considered

- **Daily full export.** Same 24-hour recovery point, about five times the
  request-unit cost, and it protects nothing extra. Rejected on the
  measurement.
- **Rely on continuous backup alone.** Does not survive account loss, which is
  the scenario the issue names. Rejected.
- **Export from a GitHub Actions workflow with OIDC.** Cannot reach the account
  through the firewall without re-opening the datacenter range ADR 0025 closed.
  Rejected.
- **Azure Data Factory or Synapse Link.** Both are capable and both are new
  services with their own bills and identities on a platform where recovery
  should cost cents. Rejected for now; the revisit trigger is the data
  outgrowing what a queue worker can page in 30 minutes per container.
- **A separate storage account in another subscription.** Better isolation,
  one more identity and network posture to maintain. Deferred; the revisit
  trigger is subscription loss entering the threat model.
- **Change feed in all-versions-and-deletes mode from day one.** Solves deletes
  exactly, at the price of a hard dependency on the retention window that a
  stalled delta reader would fall out of silently. Deferred; the weekly full
  reconciles deletes at a cost that is already being paid.

## Validation and revisit triggers

Validated when:

- The classification test covers every container in
  `infra/cosmos-containers.json` exactly once.
- Four consecutive weeks of runs produce a manifest each, with the alert rule
  proven to fire by a deliberately skipped run.
- A restore drill hits RPO 24 hours and RTO 8 hours and is written up with its
  timings in the runbook.

Revisit when:

- `DataUsage` grows past about 20 GB (a full read approaching $5), or a single
  container cannot be paged inside one worker invocation.
- A restore drill misses its objective.
- Subscription loss enters the threat model.
- A week of resurrected deletes causes a visible problem.

## Related decisions and references

- [ADR 0003](0003-cosmos-serverless.md) — serverless Cosmos, the reason
  single-region is permanent.
- [ADR 0018](0018-as-built-plan-v02.md) — the deviation register that
  recorded the move to `Continuous30Days`.
- [ADR 0022](0022-alerting-fabric.md) — the scheduled-query alert fabric the
  missing-run alert joins.
- [ADR 0025](0025-cosmos-firewall-datacenter-sentinel.md) — why the exporter
  cannot be a GitHub workflow.
- [Cost analysis — Cosmos backup and export](../architecture/cost-analysis.md#cosmos-backup-and-export-costed-against-the-measured-size-2026-09-06)
- Issue #231 — the acceptance criteria this design answers.
- Microsoft Learn: *Continuous backup with point-in-time restore in Azure
  Cosmos DB*; *Change feed modes in Azure Cosmos DB*; *Azure Cosmos DB
  serverless pricing*.

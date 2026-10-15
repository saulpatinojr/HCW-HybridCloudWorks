# Azure Well-Architected Assessment

**Status:** Draft
**Workload:** hybridcloudworks.com
**Target maturity:** Production-ready foundation with documented cost-driven exceptions
**Evidence read:** 2026-10-15 (PLAT-9, #969)

This assessment began as an architecture baseline, not evidence of deployed controls. A control
moves from `Planned` to `Verified` only after Terraform validation, deployment, and the listed
production signal are captured. Since 2026-10-15 the Status column carries what the repository and
the live estate show, read on the date in the row: `Verified <date>` is the listed signal captured;
`Implemented` is the control in code or configuration with its signal not yet captured, the missing
measurement named in the row; `Partial` is part of the target built and the gap named; `by decision`
marks a gap the owner chose (the decision record is cited). No row is `Planned` any more: every
control has at least its first half built, and the Verification signal cell says where.

## Executive scorecard

| Pillar | Current prototype | Target foundation | Principal constraint |
| --- | --- | --- | --- |
| Reliability | High risk | Production-ready single-region | USD 150 ceiling; Cosmos Serverless is single-region |
| Security | High risk | Strong identity and secret baseline | Public web/API origins and Function host storage initially |
| Cost Optimization | Partial | Budget-governed and measurable | No actual Azure baseline exists yet |
| Operational Excellence | Partial | GitHub-governed and observable | One production environment initially |
| Performance Efficiency | Partial | Static-first and elastic | Cold starts and Cosmos partition design require measurement |

## 1. Reliability

### Objective

Keep published content readable during backend failures, recover mutable state within the agreed
window, and make asynchronous side effects repeatable without duplication.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Static failure isolation | Public pages and data are materialized into the frontend artifact | Static HTML per route is written at build (`frontend/scripts/prerender.mjs`) and article pages prerender from the committed content manifest (`publish-content-manifest.yml`); the hydrated SPA still reads the API, and no API or Cosmos outage drill is recorded. Read 2026-10-15 | Partial |
| Zone resilience | Declined on cost: Cosmos and the Function App are single-zone, storage is geo-redundant (RA-GRS content, GRS host), not zone-redundant (ADR 0011 amendment 2026-10-06) | Resource configuration; no zone-failure evidence sought | Decided against |
| Data recovery | Cosmos continuous backup (30 days) plus the nightly out-of-account export (ADR 0028); Blob versioning and soft delete | Restore drill records RTO/RPO; drill run 2026-10-13 (RTO 01:39:04, RPO 22 h, 11,971 docs, PLAT-1 #961) | Verified |
| Retry safety | Idempotency keys, conditional state transitions, bounded retry, poison queues | Jobs are claimed with an etag-conditioned replace and never retried on their own (`functions/src/lib/jobs.js`); a duplicate delivery runs once (`jobs.test.js`); five failed handoffs land in `platform-jobs-poison`, and `alert-jobs-poison` fired on the 2026-10-15 fire test (#964); change-feed side effects use rising-edge etag claims. The one-effect proof is a unit test, not a live one | Implemented |
| Deployment recovery | Immutable artifacts and known-good rollback package | Rollback is a reviewed forward deploy (`deploy-azure-frontend.yml` header; `deployment-runbook.md`); the Functions package is built inside the deploy job and no known-good package is kept; no rollback drill recorded (ADR 0011 asks for one a quarter). Read 2026-10-15 | Partial |
| Dependency resilience | Timeouts, circuit/fallback behavior, non-AI degradation | One outbound fetch helper with a 30 s deadline (`http/fetch-with-timeout.js`); AI providers fail over in order under a bounded time budget (`ai/router.js`, `ai/time-budget.js`, unit-tested); no circuit breaker and no fault injection against live dependencies. Read 2026-10-15 | Partial |
| Health model | Public synthetic test, admin journey, worker/queue health, dependency telemetry | The edge probe on `/api/health` feeds `alert-api-reachability` (armed 2026-09-01); timers, the queue and the host have `alert-timer-overdue`, `alert-jobs-poison` and `alert-lab-heartbeat`; delivery proven by mail and SMS 2026-08-30, and ten of the fifteen rules in the alerting runbook's Fire record were seen to fire by 2026-10-15 (#964); the admin journey runs only in CI against a stubbed identity | Partial |

### Accepted risks

- One primary Azure region.
- Cosmos DB Serverless cannot add another region.
- Hostinger remains an external labs dependency.
- Functions Flex has no deployment slots.

These risks are accepted only while the workload remains within the cost-conscious availability
target. Sustained usage, business criticality, or a tighter RTO/RPO reopens the hosting and data SKU
decisions.

## 2. Security

### Objective

Use identity as the primary control plane, minimize externally reachable privilege, protect secrets
and mutable data, and preserve auditable administrator actions.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Administrator authentication | Entra SPA/API registrations and admin app role/group | Every admin handler goes through the role guard (`auth/require-role.js`, `auth/default-guard.js`): Entra token, app role and the `admins/{oid}` record, denials audited; the route inventory test refuses a route that is neither guarded nor on the public allowlist; `require-role.test.js` proves 403 on a missing or insufficient role. Live denial rows in `admin_audit_logs` are the production signal and were not read here. Read 2026-10-15 | Implemented |
| Service authentication | System-assigned managed identity and data-plane RBAC | System-assigned identity with identity-based host storage (`infra/functionapp.tf`); shared-key access off on both storage accounts (`infra/storage.tf`; read live 2026-10-15 on the lab backup account and hourly on the host account by `monitor-functions-registered.yml`); Cosmos local auth off with data-plane role assignment; `app-settings-secrets.test.js` fails on any literal secret; no key outputs | Verified 2026-10-15 |
| Deployment authentication | Separate GitHub OIDC identities for plan and apply | User-assigned identities federated to GitHub by subject and split by job (`infra/oidc.tf`, `oidc-subjects.test.mjs`); no Azure client secret in GitHub; HCP Terraform's plan and apply share one identity, the split recorded as an option in ADR 0005. Read 2026-10-15 | Partial |
| Secret protection | Key Vault RBAC, purge protection, 90-day soft delete, diagnostics | Key Vault RBAC, purge protection, 90-day soft delete, default-Deny network and AuditEvent diagnostics (`infra/keyvault.tf`, `infra/observability.tf`); `alert-kv-config-write` fired 2026-10-11, `alert-kv-errors` and `alert-kv-data-write` fired 2026-10-15 (#964, the Fire record) | Verified 2026-10-15 |
| Network access | Flex-delegated integration subnet and selective Private Link for Cosmos, content storage and Key Vault | Service-endpoint firewalls on Key Vault, both storage accounts and Cosmos admit the delegated integration subnet only (`infra/network.tf`, read live 2026-10-14 on #980); the owner declined Private Link and private DNS on 2026-10-06 (ADR 0031), so the target's private-DNS half is not built, by decision | Partial, by decision |
| Encryption | TLS 1.2+ in transit and Microsoft-managed encryption at rest; no CMK requirement initially | TLS 1.2 minimum on both storage accounts, HTTPS-only with HTTP/2 on the Function App, HSTS with preload from the Static Web App (`staticwebapp.config.json`); Microsoft-managed keys by owner decision (ADR 0031); Trivy blocks HIGH and CRITICAL IaC findings in CI; no protocol test runs against production. Read 2026-10-15 | Implemented |
| Storage exposure | Anonymous blob access and shared-key application access disabled | No nested public items and private containers on both accounts, shared key off by default (`infra/storage.tf`); the content account's firewall admits the integration subnet only, so an anonymous fetch is refused at the network before any container (its unused localhost CORS entry removed in #1179); public media is served through the app from a container allowlist. No anonymous fetch was tried against production. Read 2026-10-15 | Implemented |
| API protection | Explicit public route allowlist; Entra on admin; schema validation and rate controls | Explicit public route allowlist with a reason per route (`route-inventory.test.js`), Entra on admin, body validation per handler, a daily cap with compare-and-increment, rate limiting keyed on a Cloudflare-verified identity that fails closed (`auth/client-identity.js`), the origin locked to Cloudflare's ranges with `assert-origin-lock.mjs` reading the live rules after every deploy (held to the published list weekly from #1179) | Verified 2026-10-15 |
| Audit | Immutable-enough admin and integration audit records with correlation IDs | Admin mutations, denials and integration proxy writes land in `admin_audit_logs` with action, user, time, user agent and details (`content-workflow/shared.js`, `auth/default-guard.js`, `integrations/rest-proxy.js` since #1167); rows carry no correlation or deployment id and the container accepts upserts. Read 2026-10-15 | Partial |
| Supply chain | Pinned actions/modules, CodeQL, dependency review, secret/IaC scans, artifact attestations | Actions pinned by SHA and tested to be; CodeQL for JavaScript, Actions and Python; dependency review and Trivy as required checks; GitGuardian's secret check on every pull request; provenance attestation for the lab image only (`publish-lab-image.yml`); checkov and zizmor run locally through Qlty, not as a CI gate; the Functions and frontend releases carry no attestation. Read 2026-10-15 | Partial |

### Accepted risks

- Cloudflare-fronted Azure origins remain publicly addressable initially.
- Isolated Function host storage and Azure OpenAI retain public service endpoints initially.
- API Management, Front Door Premium Private Link, Defender upgrades, and Private Link for every host
  storage subresource are deferred pending threat and cost evidence.

Authorization at the Azure API remains mandatory even when Cloudflare blocks a request at the edge.

## 3. Cost Optimization

### Objective

Keep expected monthly Azure spend below USD 150 without trading away the agreed security, recovery,
or user experience baseline.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Budget | Resource-group budget at USD 150 with 50/75/90/100 percent thresholds | Two subscription-scoped budgets at USD 150 with 50/75/90/100 % actual and a 100 % forecast threshold, routed to the ops action group and mail (`infra/budget.tf`; subscription scope rather than resource group, by its own comment); test notifications reached mail and SMS on 2026-08-30; the Management budget read applied 2026-10-14 | Verified 2026-10-14 |
| Allocation | Required tags on all eligible resources | One required tag map applied through `local.tags` everywhere (`infra/variables.tf`); no CI or policy check reports coverage, as the cost analysis says. Read 2026-10-15 | Partial |
| Compute | Flex Consumption, zero always-ready instances initially | Flex Consumption FC1, 2048 MB per instance, maximum 20 instances, always-ready zero by decision (ADR 0031); September billed USD 6.09 (cost analysis); cold-start latency is not measured (`infra/functionapp.tf` says so). Read 2026-10-15 | Implemented |
| Database | Cosmos Serverless; RU-aware queries/indexes | Serverless account, explicit index paths and composite indexes per container (`infra/cosmos.tf`, `cosmos-containers.json`), `alert-cosmos-throttle` on 429s; September billed USD 5.71; per-operation and per-partition RU telemetry was pruned for the log cap (#947 tracks RU logging). Read 2026-10-15 | Implemented |
| Storage | ZRS where recovery value warrants it; lifecycle and short recovery retention | RA-GRS content and GRS host accounts by decision (ADR 0031), not ZRS; 7-day blob and container soft delete; lifecycle rules for noncurrent versions, exports and uploads (`infra/storage.tf`); September capacity and transactions measured in the cost analysis. Read 2026-10-15 | Implemented |
| Observability | 30-day workspace retention, sampling, daily cap and cap alerts | 30-day retention, a 0.25 GB daily cap that refuses unlimited (`infra/main.tf`, `infra/variables.tf`), adaptive sampling excluding requests (`functions/host.json`), `alert-logs-capacity` at 80 % of the cap; September ingestion billed USD 0.00 | Verified 2026-10-15 |
| AI | Explicit feature flag, TPM and token bounds, dynamic quota off | Foundry deployments capped at 50K TPM with local auth off and a USD 75 budget (`infra/foundry.tf`); every feature switchable off by an administrator; tokens and estimated cost recorded per call in `ai_usage`; the first measured Foundry month is pending (#849, November). Read 2026-10-15 | Implemented |
| Edge | Retain Cloudflare instead of Azure Front Door fixed fee | Cloudflare kept (ADR 0002) against Front Door's fixed fee (cost analysis); DNS and the origin-secret ruleset in Terraform (`infra/frontend.tf`); the site itself is DNS-only to the Static Web App (apex and www read 2026-10-15), so there is no cache-hit ratio to measure for it, and the Cloudflare plan cost is listed as open | Implemented |

Potential savings are not realized savings. After deployment, actual billed cost becomes the baseline,
and architectural changes are measured against both cost and service-quality indicators.

## 4. Operational Excellence

### Objective

Make every production change reviewable, repeatable, observable, reversible, and attributable.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Infrastructure as code | Thin Terraform roots composed from pinned AVMs | A native-provider root module (ADR 0020 superseded AVM composition); fmt, validate, tflint and Trivy are required checks; `terraform test` runs for `infra-lab/` only; no policy-as-code gate. Read 2026-10-15 | Partial |
| State | Remote locked production state with version/recovery protection | Remote state in the HCP Terraform `hcw-azure` workspace, locked and versioned (`infra/backend.tf`); deploys refuse to run during an apply and fail closed without the token (#1166); recovery is a state version restore in HCP Terraform (`deployment-runbook.md`); no lock-contention test recorded. Read 2026-10-15 | Implemented |
| Plan/apply separation | Read-only PR plan and protected production apply | Plans run in HCP Terraform and a human confirms the apply; `tfc-plan-check.yml` compares a run's plan with the declared permanent diff (`assert-expected-plan.mjs`) on dispatch; plan and apply share one identity, and nothing proves the applied plan equals the reviewed one. Read 2026-10-15 | Partial |
| Change safety | Protected branch/environment, CODEOWNERS, concurrency, no self-approval | Ruleset 20680114 with no bypass actors, required status checks, conversation resolution and the `production` environment gate on deploys; `CODEOWNERS` exists; zero required approvals and code-owner review off by owner decision while Copilot credits are out (to 2026-10-31; #972). Read 2026-10-15 | Partial, by decision |
| Application delivery | Build once, scan/test/attest once, promote immutable artifact | The frontend is built once and re-checked from its artifact before deploy; the Functions package is built and deployed in one job; provenance attestation for the lab image only; `monitor-deploy-drift.yml` names production lagging `main`. Read 2026-10-15 | Partial |
| Observability | Per-component App Insights in one Log Analytics workspace | One workspace-based Application Insights component on the central workspace (`infra/main.tf`); custom events for alertable signals (`lib/telemetry.js`); a rule table with a meaning and first steps per rule in the alerting runbook; no dashboards, SLO definitions or frontend telemetry component. Read 2026-10-15 | Partial |
| Incident readiness | Severity model, owner, rollback, restore, dependency runbooks | A severity, a meaning and first steps per rule; restore, rollback and dependency runbooks; the Cosmos restore drill run 2026-10-13 (RTO 1 h 39 min, RPO 22 h) with `check-drill-age.yml` holding it quarterly; no tabletop or rollback exercise recorded | Partial |
| Migration evidence | Counts, hashes, query results, routes, and external contract tests | Phase 4 evidence log: document counts reconciled (0 missing, 0 extra), blob MD5 and byte checks, partition keys signed off 2026-08-21 (`docs/history/phase-4-data-migration.md`); the reverse path and rehearsal estate retired (ADR 0023) | Verified 2026-08-21 |

One production environment increases change risk. Pull-request preview environments, emulators, local
tests, and artifact validation partially compensate, but a persistent staging environment should be
reconsidered if change volume or contributors increase.

## 5. Performance Efficiency

### Objective

Serve public pages rapidly from the edge and scale dynamic work according to measured demand without
unbounded cost.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Public delivery | Pre-rendered HTML and immutable assets cached at Cloudflare/SWA | Pre-rendered HTML per route; `/assets/*` immutable for a year and HTML no-cache (`staticwebapp.config.json`); the deploy fails below 60 prerendered documents; Core Web Vitals, TTFB and cache-hit ratio are not measured. Read 2026-10-15 | Implemented |
| API scaling | Flex per-function scaling with bounded concurrency | Flex per-function scaling to 20 instances with dynamic concurrency (`functions/host.json`); `alert-func-http5xx` and `alert-func-latency` (P95 over 5 s); from #1179, `alert-export-window-latency` measures the nightly export's effect on API P95; cold starts are not measured. Read 2026-10-15 | Implemented |
| Async work | Queue buffering isolates spikes and protects third parties | Long handlers enqueue to `platform-jobs` and return 202; a stale-queued sweeper re-enqueues; the poison alert counts arrivals; no queue age or depth signal and no completion-time measurement (ADR 0012 asks for both). Read 2026-10-15 | Partial |
| Cosmos partitioning | Query-contract-led, high-cardinality keys and selective indexes | RU/query, cross-partition rate, hot partitions | Design gate |
| Payload design | Projection, pagination, bounded documents and media in Blob | List routes project a field allowlist with a default limit of 60 and a maximum of 250 (`lib/public-reads.js`); job payloads capped at 64 KB; media in Blob through the media route; TTLs on cache and counter documents. Read 2026-10-15 | Implemented |
| AI efficiency | Bounded context/output, caching where semantically safe, fallback | Provider failover, a prompt-cache marker on static system prompts and bounded `max_tokens` (`ai/router.js`), a time budget per call; tokens and cost recorded per call; the weekly provider probe re-measures latency; cache-hit rate is not measured. Read 2026-10-15 | Implemented |
| Frontend bundles | Static/dynamic split, route-level loading, compression | Routes load lazily and vendor chunks are split with the React runtime pinned to its own chunk (`vite.config.js`); the 456 kB critical path was measured and fixed; no chunk-size report or route budget gate in CI; compression is left to the Static Web App and Cloudflare. Read 2026-10-15 | Partial |

## Cross-pillar tradeoffs

| Decision | Benefit | Cost or risk | Revisit trigger |
| --- | --- | --- | --- |
| Cloudflare over Front Door | Lower fixed cost; preserves current edge | No Azure Private Link origin integration | Origin-bypass incident or stronger compliance need |
| Serverless Cosmos | Excellent idle/spiky economics | Single-region and migration required for multiregion | RTO/RPO tightens or RU profile becomes sustained |
| Selective Private Link | Private editorial data and secrets | Endpoint/DNS cost; host state remains public | Threat model or budget justifies full host privatization |
| Single Function App (ADR 0019) | Consolidated scaling, single telemetry sink, eliminated cold starts | Shared execution runtime across functions | Operating burden or security boundary requires physical isolation |
| One production environment | Lowest fixed cost and simplest state | Reduced preproduction fidelity | Higher change volume or multiple contributors |
| ZRS storage | Zone-level durability | Higher cost than LRS | Actual asset recovery value is low or budget pressure persists |

## Definition of architecture complete

Architecture approval requires:

- no missing source capability domain;
- explicit identity, network, data, recovery, observability, cost, and delivery boundaries;
- a named owner and measurable signal for every material control;
- accepted risks and revisit triggers;
- approved resource topology and infrastructure plan;
- no unresolved choice that would materially change Terraform state or production exposure.

Implementation completion requires separate evidence. This document alone does not claim that any
Azure control is deployed or verified.

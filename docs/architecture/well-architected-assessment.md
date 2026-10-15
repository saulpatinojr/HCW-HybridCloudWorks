# Azure Well-Architected Assessment

**Status:** Draft
**Workload:** hybridcloudworks.com
**Target maturity:** Production-ready foundation with documented cost-driven exceptions

This assessment is an architecture baseline, not evidence of deployed controls. A control moves from
`Planned` to `Verified` only after Terraform validation, deployment, and the listed production signal
are captured.

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
| Static failure isolation | Public pages and data are materialized into the frontend artifact | API/Cosmos outage drill leaves public pages readable | Planned |
| Zone resilience | Declined on cost: Cosmos and the Function App are single-zone, storage is geo-redundant (RA-GRS content, GRS host), not zone-redundant (ADR 0011 amendment 2026-10-06) | Resource configuration; no zone-failure evidence sought | Decided against |
| Data recovery | Cosmos continuous backup (30 days) plus the nightly out-of-account export (ADR 0028); Blob versioning and soft delete | Restore drill records RTO/RPO; drill run 2026-10-13 (RTO 01:39:04, RPO 22 h, 11,971 docs, PLAT-1 #961) | Verified |
| Retry safety | Idempotency keys, conditional state transitions, bounded retry, poison queues | Duplicate-delivery tests cause one external effect | Planned |
| Deployment recovery | Immutable artifacts and known-good rollback package | Rollback drill and post-rollback smoke results | Planned |
| Dependency resilience | Timeouts, circuit/fallback behavior, non-AI degradation | Fault injection for AI and third-party APIs | Planned |
| Health model | Public synthetic test, admin journey, worker/queue health, dependency telemetry | Alert fires and routes to an owner | Planned |

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
| Administrator authentication | Entra SPA/API registrations and admin app role/group | Non-admin token receives 403 on every admin route | Planned |
| Service authentication | System-assigned managed identity and data-plane RBAC | No workload account keys in settings or state outputs | Planned |
| Deployment authentication | Separate GitHub OIDC identities for plan and apply | No Azure client secret in GitHub; trust subject matches environment | Planned |
| Secret protection | Key Vault RBAC, purge protection, 90-day soft delete, diagnostics | Secret access and deletion alert tests | Planned |
| Network access | Flex-delegated integration subnet and selective Private Link for Cosmos, content storage and Key Vault | Private DNS resolves and public data-plane access is rejected | Planned |
| Encryption | TLS 1.2+ in transit and Microsoft-managed encryption at rest; no CMK requirement initially | Protocol/configuration tests and policy evaluation | Planned |
| Storage exposure | Anonymous blob access and shared-key application access disabled | Anonymous object fetch fails unless intentionally published | Planned |
| API protection | Explicit public route allowlist; Entra on admin; schema validation and rate controls | Route inventory and negative auth/abuse tests | Planned |
| Audit | Immutable-enough admin and integration audit records with correlation IDs | Mutation is traceable to user, operation, deployment, and result | Planned |
| Supply chain | Pinned actions/modules, CodeQL, dependency review, secret/IaC scans, artifact attestations | Required checks and provenance visible on release | Planned |

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
| Budget | Resource-group budget at USD 150 with 50/75/90/100 percent thresholds | Budget alerts route to an owner | Planned |
| Allocation | Required tags on all eligible resources | CI policy reports 100 percent tag coverage | Planned |
| Compute | Flex Consumption, zero always-ready instances initially | Executions, GB-seconds, cold-start latency, monthly cost | Planned |
| Database | Cosmos Serverless; RU-aware queries/indexes | RU by operation and partition; 429 and monthly billed cost | Planned |
| Storage | ZRS where recovery value warrants it; lifecycle and short recovery retention | Capacity, transactions, tier transitions, restore value | Planned |
| Observability | 30-day workspace retention, sampling, daily cap and cap alerts | Ingested GB, dropped/sampled telemetry, incident usefulness | Planned |
| AI | Explicit feature flag, TPM and token bounds, dynamic quota off | Cost per generation and monthly AI share | Planned |
| Edge | Retain Cloudflare instead of Azure Front Door fixed fee | Edge cost and cache-hit ratio | Planned |

Potential savings are not realized savings. After deployment, actual billed cost becomes the baseline,
and architectural changes are measured against both cost and service-quality indicators.

## 4. Operational Excellence

### Objective

Make every production change reviewable, repeatable, observable, reversible, and attributable.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Infrastructure as code | Thin Terraform roots composed from pinned AVMs | fmt, init, validate, tests, policy and security checks | Planned |
| State | Remote locked production state with version/recovery protection | Lock contention test and state recovery procedure | Planned |
| Plan/apply separation | Read-only PR plan and protected production apply | Applied plan hash matches reviewed artifact | Planned |
| Change safety | Protected branch/environment, CODEOWNERS, concurrency, no self-approval | Repository ruleset export and test PR | Planned |
| Application delivery | Build once, scan/test/attest once, promote immutable artifact | Artifact digest is identical from build through deploy | Planned |
| Observability | Per-component App Insights in one Log Analytics workspace | Correlated traces, dashboards, SLO alerts and runbooks | Planned |
| Incident readiness | Severity model, owner, rollback, restore, dependency runbooks | Tabletop and rollback exercises | Planned |
| Migration evidence | Counts, hashes, query results, routes, and external contract tests | Signed cutover checklist and rollback decision | Planned |

One production environment increases change risk. Pull-request preview environments, emulators, local
tests, and artifact validation partially compensate, but a persistent staging environment should be
reconsidered if change volume or contributors increase.

## 5. Performance Efficiency

### Objective

Serve public pages rapidly from the edge and scale dynamic work according to measured demand without
unbounded cost.

| Control | Target design | Verification signal | Status |
| --- | --- | --- | --- |
| Public delivery | Pre-rendered HTML and immutable assets cached at Cloudflare/SWA | Core Web Vitals, TTFB, cache-hit ratio | Planned |
| API scaling | Flex per-function scaling with bounded concurrency | p50/p95/p99 latency, cold starts, error rate | Planned |
| Async work | Queue buffering isolates spikes and protects third parties | Queue age/depth, completion time, poison count | Planned |
| Cosmos partitioning | Query-contract-led, high-cardinality keys and selective indexes | RU/query, cross-partition rate, hot partitions | Design gate |
| Payload design | Projection, pagination, bounded documents and media in Blob | Response size, document size, query duration | Planned |
| AI efficiency | Bounded context/output, caching where semantically safe, fallback | Tokens/request, latency, failure and cache rate | Planned |
| Frontend bundles | Static/dynamic split, route-level loading, compression | Build chunk report and route performance budgets | Planned |

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

# Architecture review — 2026-08-28

> **CLOSED 2026-08-31. This page is a dated record, not a live list.** All 62
> findings are resolved or handed to the owner. The three that still need an
> owner — `T-719`, `T-721` and `T-749` — were stated in full in
> [TODO.md](../repo/todo.md) rather than by reference to this page, and closed
> there by 2026-09-05; their outcomes are in [CHANGELOG.md](../repo/changelog.md).
> Open work is GitHub issues. Do not add findings here; a new
> review is a new dated page.

The review of record for the six-layer architecture review opened on
2026-08-28. This page carries the evidence, the failure mode, and the
recommendation for each finding, organised by the layer an engineer would be
working in rather than by severity.

Findings keep the `T-7NN` identifiers TODO.md assigned. Nothing here is fixed;
recording and fixing in one change would make the record unreviewable.

> **The `file:line` anchors below are pinned to merged main at `31f9613`, the
> commit this review ran against, and are not maintained.** They were already
> drifting — `main.tf` alone grew from 2,037 to 2,286 lines while these findings
> were being worked — and on 2026-08-29 T-754 split that file into
> `functionapp.tf`, `storage.tf`, `cosmos.tf`, `frontend.tf`, `keyvault.tf`,
> `budget.tf`, `network.tf` and a 97-line `main.tf`, so an `infra/main.tf:1174`
> now resolves to nothing at all.
>
> They are left exactly as written. An anchor is evidence of what a reader saw
> at a stated commit; rewriting it to today's line numbers would make the record
> claim something it never checked. Search for the resource by address instead —
> every one of them kept its address through the split, which is what made the
> split safe.

## Method

Six specialist reviews were run in parallel against merged `main` at
`31f9613`, one per technology layer:

| Layer | Surface reviewed |
| --- | --- |
| Azure platform | `infra/*.tf` topology, identity, secrets flow, resilience, observability, cost |
| Terraform IaC | the same files as *code* — module shape, pinning, state safety, drift |
| Backend | `functions/` — routes, guards, Cosmos, change feed, jobs, integrations |
| Frontend | `frontend/` — routing, data layer, bundle, SEO, accessibility |
| CI/CD | `.github/workflows/` — permissions, pinning, OIDC, deploy safety |
| Edge and ops | `edge/`, `scripts/`, `tooling/`, `vps-agent/` |

Each reviewer was given the repository's own standards as the yardstick —
the ADRs for intent, [IaC-Repository-Standard](../standards/iac-repository-standard.md) and
[Naming-Convention](../standards/naming-convention.md) for Terraform, the contract tests for
the backend surface — and was instructed to cite `file:line` for every claim,
to prefer fewer verified findings over broad suspicion, and to record the
areas that came back sound so that silence carries information.

## What was excluded

Deliberately **not** re-reported, because they are owner gates already tracked
rather than review findings: T-518 (timers disarmed), T-519 (availability
probe Worker undeployed), ~~T-526 (Telegram webhook still pointing at GCP)~~ — closed 2026-08-28, and it
was already done when this review was written, the
unseeded Key Vault secrets `PREVIEW-SIGNING-SECRET` and `REPLICATE-API-KEY`,
the unseeded `admin_config` documents (`default_heroes`, `social_autopost`),
and the absent analytics provider that blocks Blog Machine backlog #4. The
deliberate feature-flag defaults that implement those gates are likewise not
findings.

## Evidence standard

Three levels appear in this page, and they are distinguished because a review
that presents them identically is not a review:

- **Verified** — re-read against the code during the review session, by a
  second reader, after the finding was written. Every Critical finding and the
  three data-durability High findings carry this.
- **Reported** — the reviewing agent cited `file:line` and the anchor resolves,
  but no second reader re-derived it. Most Medium and Low findings carry this.
- **Verify** — the claim could not be settled from the repository. Exactly one
  finding is in this state (T-705's live GitHub environment configuration) and
  it is marked in place rather than asserted.

## Cross-cutting observations

Three patterns appear in more than one layer, and are worth more than the sum
of the individual findings.

**A control exists but does not bind.** The `production` GitHub environment
(T-705) records who deployed without gating whether they may. `Confirm-Plan`
and `ShouldProcess` (T-702) both present as confirmation gates and both
self-approve. `prevent_destroy` (T-708) guards the Cosmos account but not the
data. The `role` field on job types (T-701) exists, defaults to `editor`, and
is declared by none of the eight. In each case a reader of the code would
reasonably conclude the control is in force.

**A decision's premise expired without the decision being revisited.** ADR
0018 accepted LRS storage while Firebase held a second copy; ADR 0023 removed
that copy (T-706). The Cosmos containers were guarded as "empty as of
2026-08-20" and now hold roughly 70k documents (T-708). Both were correct
when written.

**A capability was built and then bypassed.** `triggers/fetch-image.js` has a
complete SSRF guard that two other fetch paths do not use (T-734). Four
call sites use `fetchWithTimeout`-shaped patterns and five do not (T-712).
`fetchPublicContentList` accepts `provider` and `type` and no caller passes
either (T-716). `lib/contentModel.js` exists to normalise content fields and
four hooks reimplement it instead (T-738).

---

## 1. Azure platform

### T-706 — Media storage is a single LRS copy (High, verified)

> **Status (2026-08-28):** **FIXED** — moved to **RA-GRS**, not ZRS. Two reasons: the risk is account and regional loss, which zone redundancy does not cover, and LRS→ZRS is not Terraform-expressible (Azure requires a customer-initiated conversion). The TFC plan succeeded with `prevent_destroy` in force, which proves it is an in-place update rather than a replacement.

`infra/main.tf:434` · `docs/decisions/0018-as-built-plan-v02.md:56-57,73-74` ·
`docs/decisions/0023-migration-estate-retirement.md:79-81`

ADR 0018 accepted `LRS` explicitly *"while the Firebase source retains the
authoritative copy,"* recording a revisit trigger of "when Firebase
decommission removes the second copy, or when media becomes irreproducible."
ADR 0023 closed the reverse path and made production authoritative. Every
blob written since the 2026-08-21 cutover — CMS uploads, generated Listen &
Learn audio, AI cover images — therefore exists in exactly one copy in one
region. Blob versioning and soft delete (`main.tf:454-502`) protect against
overwrite and deletion, not against account or regional loss. The
accepted-risk predicate has expired and the risk is consequently no longer
accepted; it is merely unreviewed.

**Recommendation.** Convert the content account to ZRS or RA-GRS — an
in-place replication change, small at this media volume — or add object
replication to a second-region account. Record it as ADR 0018's revisit
trigger firing, in a superseding ADR, so the next reader sees a decision
rather than a drift.

### T-707 — Cosmos recovery is a 7-day window with no out-of-account copy (High, verified)

> **Status (2026-08-28):** **PARTLY FIXED; remainder on [issue #231](https://github.com/HybridCloudWorks/HCW-HybridCloudWorks/issues/231).** Backup tier 7 → 30 days. The out-of-account copy cannot be closed by any account setting, so it belongs with the recovery objectives; it is also gated behind T-518.

`infra/main.tf:284-287,203-217` · `docs/decisions/0023-migration-estate-retirement.md:79-81`

The only restore path for all production website data is 7-day point-in-time
restore whose backup storage is co-located with a single-region serverless
account. Three failure classes are unrecoverable: corruption discovered after
seven days — likely, because the platform runs cleanup timers that delete and
rewrite documents, so discovery is slow; deletion of the account itself
(`prevent_destroy` is a Terraform-side guard, and it has been lifted once
already); and a Central US regional failure. Serverless is single-region for
life and the conversion is irreversible, so the geography cannot be widened
later without a migration. ADR 0018's T-504 debt row asked for "periodic
backup"; what closed it was continuous backup, which is a different control —
it shortens recovery time, it does not add a second copy.

**Recommendation.** Add a scheduled export of every container to blob storage
on a geo-redundant account — a few MB per day at this scale — or at minimum
move to `Continuous30Days` and document the residual out-of-account gap
explicitly.

### T-709 — One action group, one receiver, delivery never observed (High, verified)

> **Status (2026-08-28):** **CODE HALF FIXED; owner action open.** An optional SMS receiver is available via a `dynamic` block, so an unset variable leaves the action group byte-identical. Delivery has still never been observed — `az monitor action-group test-notifications` remains owner-run.
>
> **Status (2026-09-01):** **CLOSED.** Both channels have now been observed delivering: the sample budget email arrived on 2026-08-30 and the SMS the same evening, via `az monitor action-group test-notifications create` from the CLI — the portal's test button reported status **Unknown** twice and delivered nothing. The full command shape and the evidence standard are recorded in [TODO.md](../repo/todo.md) under "Live confirmation still requiring an authorized operator".

`infra/observability.tf:30-47,157-189`

Every alert rule routes through a single action group; Azure alert rules
cannot carry a direct email, so there is no second path. That group lives in
the Management subscription and is reached across a subscription boundary
whose delivery is proven only to be *accepted* by ARM, and its terminus is one
mailbox with no SMS or push fallback. The file's own comment states the
consequence: if the reference is accepted and silently inert, the estate has
alert rules that exist, evaluate, and page nobody — "strictly WORSE than the
visible emptiness" the alerting fabric replaced. The post-apply delivery test
that would settle it is the load-bearing step, and no record of it having run
exists in the repository.

**Recommendation.** Run `az monitor action-group test-notifications` and
record the result in the [Deployment runbook](../runbooks/deployment-runbook.md) §4. Add a
second receiver — SMS or the Azure mobile app receiver, both free. If the
cross-subscription hop proves inert, build the fallback ADR 0022 already
names: a second action group in the application subscription.

### T-718 — Cosmos firewall admits every Azure datacenter IP (Medium, reported)

`infra/main.tf:252-269` · `infra/variables.tf:315-318`

The `0.0.0.0` sentinel is enabled by default so `heal-computed-properties` can
reach Cosmos from GitHub-hosted runners, which have no stable egress IPs. Its
effect is to admit any workload in any Azure tenant at the network layer,
leaving AAD as the only control — which is a real control, since local auth is
disabled, but it is one layer where the design intends two. The finding is the
inconsistency rather than the exposure: T-503 solved the identical
"runners have no stable IPs" problem on the Functions host storage account
with an add-IP / work / remove-IP window, so the pattern, the identity and the
role model already exist in this repository.

**Recommendation.** Apply the T-503 per-run window pattern to the Cosmos
firewall in the healer workflow, then set `cosmos_allow_azure_datacenter_ips`
to `false`.

### T-719 — The 5xx and latency alerts stop evaluating at the workspace cap (Medium, reported)

`infra/observability.tf:329-341,78-99` · `infra/main.tf:80-84,110-112`

Flex Consumption publishes no HTTP metrics, so `function_http_5xx` and
`function_response_time` had to be written as log rules — which re-creates,
for the two most important workload signals, the silent-under-cap failure mode
the alerting fabric was designed to eliminate. The workspace was found at its
cap before pruning, and the post-prune daily volume was never confirmed
against an uncapped day, so the current margin is an estimate. The whole chain
now depends on `logs_daily_cap` firing at 80% and a human acting within hours.

**Recommendation.** Confirm the volume on an uncapped day and record the
measured GB/day. If headroom is under roughly 2x, pull the documented lever —
`host.json` log level, or moving AppTraces (about 38% of the cap) to the Basic
table plan — rather than waiting for the 80% alert to become routine.

### T-720 — Key Vault reference failures are silent and indistinguishable (Medium, reported)

> **Status (2026-08-28):** **FIXED** — `/api/health` reports a COUNT of unresolved `@Microsoft.KeyVault(…)` references (a count, not names: the endpoint is anonymous and T-402 already ruled out an unauthenticated inventory). `secrets-health.test.js` asserts agreement with `readKey` against the real function, since a disagreement there would report a healthy estate while the app behaves as though the key is absent. The alert on it needs an apply — owner.

`infra/main.tf:1174-1260,665-673,1699-1703`

More than twenty app settings are `@Microsoft.KeyVault(...)` references. An
unresolved reference arrives at the application as the literal string, and
`readKey()` treats that as "no key configured" — which is deliberate and
convenient while secrets are still being seeded. The cost is that four
distinct failures become one indistinguishable symptom: unseeded, RBAC
revoked, network denied by an inert service endpoint, and rotated-then-broken
all present as a feature quietly turning itself off, in production,
indefinitely. Application Insights sees no exception, because the code path is
a clean fallback. The Terraform comments document this trap three times; no
signal anywhere observes it.

**Recommendation.** Have `/api/health` — already the availability probe's
target — report the count of app settings still holding the literal
`@Microsoft.KeyVault` prefix against the expected-seeded list, and add a
scheduled-query rule on it. One cheap signal converts four silent failure
classes into one visible one.

### T-721 — Telemetry costs five times the workload it observes (Medium, reported)

`docs/architecture/cost-analysis.md:74-84` · `infra/main.tf:138-144,128-133`

Neither line is over budget, but together they are roughly 80% of predictable
Azure spend on a platform that documents cost discipline to the cent.
Telemetry runs about USD 17-21 a month against an application-subscription
workload of roughly USD 4, and its documented levers — host log level, the
Basic table plan for AppTraces — are unexercised. Separately, the Static Web
App Standard tier (about USD 9/month) is justified in-file by custom domain
plus SSL, SPA routing and 100 GB bandwidth, all of which the Free tier also
provides; the genuinely Standard-only features are the SLA and PR staging
environments, which the rationale does not mention.

**Recommendation.** After the T-719 measurement, drop the host trace level or
move AppTraces to the Basic plan. Re-justify SWA Standard against the two
features that actually require it, and downgrade if neither is load-bearing.

### T-748 — The Terraform principal holds unusable Key Vault Secrets Officer (Low, reported)

> **Status (2026-08-28):** **FIXED** — removed. Verified `data.azurerm_client_config` is still used for the vault tenant_id, so nothing is orphaned.

`infra/main.tf:1728-1732,1679-1687`

HCP Terraform's runners are neither in the VNet nor a trusted Azure service,
so the assignment cannot write from a TFC run today — the grant's current
effect is nil. That is not the same as harmless: whenever `admin_ip_rules`
opens a seeding window, a shared remote execution environment gains live write
access to every production secret alongside the named human. The repository's
own doctrine (`oidc.tf:241-251`, "deploys do not read secrets") argues against
it, and because secret *values* are deliberately never managed by Terraform,
the grant has no consumer to lose.

**Recommendation.** Delete `azurerm_role_assignment.terraform_kv_secrets`; the
`admin_object_ids` window already covers seeding.

### T-749 — SCM remains default-Allow (Low, reported, overlaps T-520)

`infra/main.tf:1055-1077` · `infra/variables.tf:886-889`

The credential half of this is already closed — basic auth is off on both SCM
and FTP — so exposure is Entra-token-gated, and the per-run window in
`deploy-functions.yml` exists precisely to make `Deny` survivable. The finding
is only that the flip has a stated precondition (an observed working deploy
through the window) that deploys have presumably satisfied several times since
2026-08-24.

**Recommendation.** Confirm one post-window deploy succeeded, then set
`functions_scm_lock_enabled = true`. The design work is already done.

---

## 2. Terraform IaC

### T-708 — The Cosmos database and containers carry no `prevent_destroy` (High, verified)

> **Status (2026-08-28):** **FIXED** — `prevent_destroy` now covers the database, the container `for_each` and `leases`; the stale "containers are empty" comment is corrected to ~70k documents.

`infra/main.tf:305,365-412,1886-1897` · guards present at `298,516,807,1710` ·
`docs/standards/iac-repository-standard.md` ("Stateful resources | `lifecycle { prevent_destroy = true }`")

Verified by enumeration: the guard covers the Cosmos *account*, both storage
accounts and the Key Vault, and nothing else. `prevent_destroy` on a parent
does not protect its children — a container destroy or replace plans and
applies cleanly. Three properties compound it: the containers are generated
from `cosmos-containers.json` rather than hand-written, partition keys are
immutable so any key change is a destroy-and-create, and the in-file comment
asserting "every container here is empty as of 2026-08-20" is now stale
against roughly 70k production documents. A regenerated spec that renames a
container or alters a key currently produces a data-destroying plan whose only
gate is a human reading the plan carefully — and T-724 explains why plans here
are read by pattern rather than in full.

**Recommendation.** Add `lifecycle { prevent_destroy = true }` to the
database, to the container `for_each` resource (it applies to every instance),
and to `leases`. Deliberate drops then become the same reviewed two-step the
account already imposes. Refresh the stale comment in the same change.

### T-722 — The `swa_token` output contradicts its own file header (Medium, verified)

> **Status (2026-08-28):** **RESOLVED as a recorded exception.** The header no longer contradicts itself. The output is kept because the token is in state via the resource attribute regardless, so deleting it would hide rather than retire it; it is now in TODO.md accepted risks, and `deploy-azure-frontend.yml` isolates it in a job that installs nothing. Retiring it is T-727, owner-gated.

`infra/outputs.tf:5-7` vs `18-22`

The header states that sensitive key and connection-string outputs are
intentionally omitted because all runtime access uses managed identity. Eleven
lines below it, `output "swa_token"` exposes the Static Web App API key. It is
marked `sensitive`, so it is not printed casually, but it is surfaced on the
TFC Outputs tab to anyone with state read, and it is consumed by GitHub
Actions as exactly the kind of static credential the IaC standard's Principle
2 prohibits. The token is in state via the resource attribute regardless; the
output is what makes it convenient.

**Recommendation.** If the SWA deploy can move to an Entra token from the
existing OIDC identity, delete the output and the CI secret together (see
T-727). If the token is genuinely still required, keep it but record it as an
accepted exception the way purge protection was, and fix the header sentence
so the file stops contradicting itself.

### T-723 — Two secrets-in-state surfaces (Medium, reported)

> **Status (2026-08-28):** **FIXED, better than recommended.** `cloudflare_origin_secret` is recorded in accepted risks with its rotation consequence. For the azapi export, the invariant it depends on is now ENFORCED rather than the symptom hidden: `app-settings-secrets.test.js` fails when a secret-shaped setting is not a Key Vault reference, reporting the name only — printing the value would put a credential in a CI log. Marking the export sensitive would not have stopped a credential being there.

`infra/main.tf:1454-1465,1467-1495,2029-2035` · `infra/variables.tf:834-839`

The IaC standard says values never transit Terraform state. Two places
qualify. The `azapi_resource_action` that reads app settings back exports
`["properties"]` — the *entire live settings map*, not just what HCL declares —
into state, unredacted and unmarked. It is safe only while every
secret-shaped setting remains a Key Vault reference; the first setting written
out-of-band with a literal value lands in state and in TFC plan JSON.
Separately, `cloudflare_origin_secret` is a real shared-secret value in state,
which is unavoidable because Terraform configures the Cloudflare end — but it
is an unrecorded exception.

**Recommendation.** Mark the azapi output sensitive where surfaced and comment
the "Key-Vault-references-only" invariant it depends on. Record the
origin-secret exposure, with its rotation consequence, in TODO.md's accepted
risks.

### T-724 — The permanent plan diff is asserted only in a comment (Medium, verified)

> **Status (2026-08-28):** **FIXED.** `scripts/assert-expected-plan.mjs` compares a plan against the three azapi ADDRESSES and one attribute, catches a destroy hiding beside the expected three, catches a second setting changing on the resource that is legitimately expected to change, and fails when an expected change STOPS appearing (a strip that is not running is how AzureWebJobsStorage returns). Its test pins EXPECTED against `main.tf` both ways. Not in CI: the plan lives in HCP Terraform and `iac-validate.yml` has no token — owner.

`infra/main.tf:1379-1407,1462-1464,1492-1494,1551-1553` ·
`docs/decisions/0018-as-built-plan-v02.md:71-72`

The read-then-strip design is a correct workaround for azurerm issue #29149
and is thoroughly documented. Its cost is that a clean plan no longer exists:
every plan reads "1 to change, 3 to add, 3 to destroy", and the comment says
that a plan reporting exactly that "and nothing else means NO DRIFT". ADR
0018's convergence proof was an empty plan; operators are now trained to
approve a specific non-empty shape by pattern-matching it. Real drift hiding
inside or beside the expected trio is precisely what pattern-approval misses —
and T-708 is the finding that makes the consequence data loss rather than
inconvenience.

**Recommendation.** Encode the assertion: a CI step over the TFC plan JSON
that fails when the change set differs from the three known azapi addresses
plus the one known attribute. Keep the existing "delete when #29149 closes"
exit note, and add a checklist item to re-test the issue on every azurerm
minor upgrade.

### T-725 — Version constraints understate the real floor and lack a ceiling (Medium, reported)

> **Status (2026-08-28):** **FIXED** — `~> 1.5` and `~> 4.52`.

`infra/providers.tf:6,23-27` · `.terraform.lock.hcl` (cloudflare 4.52.8)

`cloudflare_record.content` exists only from provider 4.52, but the constraint
is `~> 4.0`, which admits 4.0 through 4.51 — versions that fail `validate` on
that attribute. The lock file is currently the only thing keeping the
constraint honest, so a workspace or CI re-resolve without it breaks
confusingly. Separately `required_version = ">= 1.5"` has no upper bound, so a
future Terraform 2.x is silently permitted, which the standard's pinning rule
does not intend. Worth noting alongside: Cloudflare v4 is superseded by v5,
which renames `cloudflare_record` to `cloudflare_dns_record`, so an upgrade
ADR is eventually due.

**Recommendation.** Tighten to `~> 4.52` and `~> 1.5` (or `>= 1.5, < 2.0`).
Track the v5 migration separately.

### T-750 — CORS origins hardcoded where the sibling block derives them (Low, reported)

> **Status (2026-08-28):** **WILL NOT FIX — the finding is wrong, and acting on it broke CI.** `cors-platform-origins.test.js` reads that block AS TEXT and compares the literal origins against `lib/auth/cors.js`, deliberately reading text rather than Terraform state so it can fail on a checkout with no Azure credentials. Interpolations defeat it twice: `${var.domain}` is not a string it can compare, and a comment between `cors {` and `allowed_origins` breaks its block regex outright — the worse half, because the guard then passes while checking nothing. The drift it prevents is the 2026-08-23 outage where the portal authenticated and every API call failed with "Failed to fetch". The asymmetry with the storage account's block is therefore justified: only this list has a text-level guard. Reverted, with the two specific don'ts recorded in place.

`infra/main.tf:993-1000` vs `483-487`

The function app's platform `cors` block hardcodes both apex origins and a
literal Static Web App hostname, while the storage account's CORS block five
hundred lines earlier correctly derives from `var.domain`, and the SWA
hostname is available as `azurerm_static_web_app.hcw.default_host_name`. A
`domain` change therefore updates one CORS surface and not the other, and a
recreated SWA silently invalidates the literal.

**Recommendation.** Build the list with `concat` from `var.domain` and the
resource attribute. The change is value-identical today, so a no-op plan
proves it correct.

### T-751 — The timer catalogue is maintained twice by hand (Low, reported)

> **Status (2026-08-28):** **FIXED** — guarded by a text-reading test in the same shape as the CORS guard, and mutation-tested: removing one name from the validation produces the intended failure naming that timer. Raising `required_version` to reference the local inside the validation was rejected as the alternative — it would exclude Terraform 1.5–1.8 for a lint.

`infra/main.tf:864-890` vs `infra/variables.tf:1008-1023`

The eighteen timer flag suffixes appear in both the catalogue local and the
`enabled_timers` validation list. Adding a timer to the catalogue without
updating the validation makes it impossible to arm, because validation rejects
the name — a failure mode adjacent to the typo class the validation exists to
prevent. `route-inventory.test.js` covers code against catalogue, not
catalogue against validation.

**Recommendation.** Raising `required_version` (see T-725) to `>= 1.9` lets
the validation reference `local.timer_catalogue` directly, collapsing the
pair. Until then, a CI check or a paired comment.

### T-752 — Tag contract values diverge from their source variables (Low, reported)

> **Status (2026-08-28):** **PARTLY FIXED.** `environment` now derives from `var.environment`. `workload` is deliberately not reconciled: the live estate is tagged `hybridcloudworks` while names carry `site`, and changing it rewrites the tag on every resource — an owner-visible decision, not a side effect of a Low finding.

`infra/variables.tf:937-949,158-162,188-192`

`tags.environment` is the literal `"prod"`, independent of `var.environment`,
so a non-prod deployment of this root tags every resource `prod` unless the
operator overrides the whole map. `tags.workload` is `"hybridcloudworks"`
while every resource name carries the workload token `site` — two answers to
"which workload is this" in one estate, which is what a tag contract exists to
prevent.

**Recommendation.** Build the applied map in a local:
`merge(var.tags, { environment = var.environment, workload = var.workload_name })`,
keeping `var.tags` for org-stable keys. Verify against live tag values first —
if the live tag really is `hybridcloudworks`, changing it is harmless but wide.

### T-753 — Variable names exceed the standard's two-word rule (Low, reported)

> **Status (2026-08-28):** **RESOLVED by amending the standard, which is now marked as the loser.** Posture switches are counted by parts, not words, with each half allowed to be compound when the resource genuinely is. The rename was rejected on cost with the reason recorded: every one of these defaults to the SAFE value, so a variable renamed in code but not in the workspace would quietly disarm the estate.

`infra/variables.tf:359,370,390,550,574,628,315` among others

The IaC standard caps variable names at two words, three for genuine
collisions, and states the rule applies to Terraform variables. A large share
of recent additions run four or five words. Most are already set in the
workspace, so by the standard's own buckets they are "coordinated — report,
never rename silently". This is that report.

**Recommendation.** Either run the coordinated rename, or amend the standard
to carve out compound gate and rollback switches. Today code and standard
disagree and neither is marked as the loser.

### T-754 — `main.tf` is a 2,037-line six-concern file (Low, reported)

`infra/main.tf` · `docs/decisions/0020-native-terraform-root-module.md`

ADR 0020's revisit triggers — a second repository or environment, ALZ
module-level policy, a major azurerm migration — have not fired, so the flat
native root remains the right shape and is *not* a finding. The residue is:
the repository already splits `hub.tf`, `oidc.tf` and `observability.tf` by
concern, and `main.tf` holds everything else — resource groups, Cosmos, two
storage accounts, networking, the function app pair, Key Vault, budgets and
DNS.

**Recommendation.** Split into `cosmos.tf`, `storage.tf`, `network.tf`,
`function-app.tf`, `keyvault.tf`, `budget.tf` and `dns.tf`. Resource addresses
are unchanged, so this is state-safe by construction and needs no `moved`
blocks; do it in a PR whose plan shows the T-724 trio and nothing else.

---

## 3. Backend

### T-701 — An editor can publish live, bypassing the publisher gate (Critical, verified)

> **Status (2026-08-28):** **FIXED** — `registerJobType` now requires an explicit role; all nine types declare one; `publish-content` is `publisher`; escalation compares hierarchy level. `jobs.roles.test.js` pins both properties. The new validation immediately caught a ninth registration this review had missed (the built-in `noop`).

`functions/src/lib/jobs.js:106,202,219-222` ·
`functions/src/functions/publish-jobs.js:39-50` ·
`functions/src/lib/cms/publish.js:467`

`POST /api/publishContent` requires the `publisher` role. The `publish-content`
job type registers without a `role`, so it takes `registerJobType`'s `'editor'`
default, and `enqueueJob` escalates only when `spec.role !== 'editor'` —
so for this type it never escalates. The worker then calls
`processPublishContent(…, markLive: true)` directly, and that function is
guard-free by design because the only role check lives in the HTTP wrapper.
An editor-level token posting `{"type":"publish-content","payload":{"contentId":"…"}}`
to `enqueueJob` publishes content live.

Verification widened the finding: **none of the eight registered job types
declares a role** — `forge-article`, `forge-from-url`, `voice-calibration`,
`generate-weekly-digest`, `batch-inspect`, `generate-listen-and-learn`,
`publish-content` and `fetch-rss-feeds` all inherit `editor`. Most are
plausibly correct at that level, but nothing establishes that; the jobs
platform is a second door onto every pipeline it wraps and no mechanism
requires that door to match the first one's lock.

**Recommendation.** Make `role` mandatory in `registerJobType` — remove the
default so a new job type cannot silently inherit `editor` — and declare
`role: 'publisher'` on `publish-content`. Add a test asserting each job type's
role is at least the role of the HTTP route that performs the same action.

### T-710 — Jobs stranded in `running` are never reaped (High, verified)

> **Status (2026-08-28):** **FIXED** — the sweeper reaps jobs abandoned in `running` using each type's own `timeoutMs` plus a grace margin, and fires `onComplete`. It writes a terminal status rather than re-enqueuing: a dead worker may already have completed real side effects.

`functions/src/lib/jobs.js:331-335,458-461` ·
`functions/src/functions/jobs-sweeper.js:4-6,34-39`

The sweeper re-drives jobs that have sat `queued` too long; verified against
its own header, nothing reaps `running`. When a worker dies mid-run — host
restart, scale-in, deploy, or the platform timeout beating a job's own
28-minute budget — the document stays `running` permanently: redelivery sees
`status !== 'queued'` and returns `skipped`, the sweeper ignores it, and
`getJob` reports `running` indefinitely to a client that will poll forever.
The `onComplete` failure hook never fires either, so the Telegram failure
notification that exists precisely for "a failed approval from the phone comes
back to the phone" is also lost. The queued-job gap was closed deliberately;
this is the same failure one state later.

**Recommendation.** Add a second sweeper query for
`status = 'running' AND startedAt < now - (maxTimeoutMs + margin)`,
transitioning those to `timeout` with an explicit error and invoking the
type's `onComplete`. Separately, confirm the platform timeout exceeds 28
minutes — `host.json` sets no `functionTimeout`, so the job budget is
currently racing the platform default.

### T-711 — `buildSnapshot` fans out up to 2,000 concurrent point reads (High, verified)

> **Status (2026-08-28):** **FIXED** — deduplicated (one document carries up to four images) and batched with `ARRAY_CONTAINS`. The existing fixture proves the count is unchanged.

`functions/src/lib/ops-health.js:154-157,190-198` ·
`functions/src/lib/telegram/bot.js:270,400` ·
`functions/src/functions/telegram-http.js:38-41`

`buildSnapshot` reads `SELECT TOP 2000` from `generated_content_images`, then
`Promise.all`s a `readDoc` per row — an unthrottled fan-out of up to two
thousand point reads per call, to count orphans. That table grows by up to
four rows per AI cover run, so the bound is reachable rather than theoretical.
Every `/status`, `/queue`, `/alerts`, `/digest` and `/ai` triggers it, **as
does every free-form Telegram message**, and so does the ops-health route.
Against the roughly 5,000 RU/s budget the public-reads header cites, a single
snapshot can 429 the anonymous list endpoints — that is, a Telegram message
can degrade the public website.

**Recommendation.** Replace the per-image probe with a single
`SELECT VALUE COUNT(1)` over a maintained `orphaned` flag, or compute the
count in a timer and store it. If the probe must stay, cap concurrency to
about twenty and cache the snapshot for 30-60 seconds — the Telegram path
currently re-derives it per message.

### T-712 — External calls in the change-feed path have no timeout (High, verified)

> **Status (2026-08-28):** **FIXED** — one shared `fetchWithTimeout`, lifted out of `scrape.js`. The Replicate poll also gains a wall-clock deadline, since an iteration count does not bound elapsed time when each iteration both sleeps and requests.

`functions/src/lib/triggers/ai-cover.js:151,171` ·
`functions/src/lib/timers/publer-sync.js:124` ·
`functions/src/lib/notify.js:80` · `functions/src/lib/telegram/bot.js:470`

Replicate (both the POST and its 60-iteration poll), Publer and Telegram
`sendMessage` are all called through bare `fetchImpl` with no `AbortController`
or signal. Node's `fetch` has no default timeout. All three are reached from
change-feed handlers, where a hung connection blocks the invocation, the lease
is never checkpointed, and every subsequent change on that container queues
behind it — a single unresponsive third party stalls the pipeline rather than
failing one document. This is an inconsistency rather than an unknown: the
correct pattern already exists at `ai/router.js:301-310`,
`content/scrape.js:41-50`, `triggers/fetch-image.js:75-83` and
`timers/link-check.js:33-40`.

**Recommendation.** Route every outbound call through one `fetchWithTimeout`
helper — `scrape.js`'s is already general enough — with an explicit
per-integration budget, and give the Replicate poll a wall-clock deadline
rather than only an iteration count.

### T-730 — A Telegram send failure becomes a job-duplicating retry storm (Medium, reported)

> **Status (2026-08-28):** **FIXED** — the send is inside the guard, and the route wraps `handleUpdate` as well, so nothing past the secret check can return non-200.

`functions/src/lib/telegram/bot.js:436-447` ·
`functions/src/functions/telegram-http.js:110-112`

`handleUpdate`'s try/catch wraps command dispatch, but `await send(reply)` sits
outside it. A network-level rejection from the sender — which has no timeout
either, per T-712 — propagates out of `handleUpdate`, out of the webhook
handler, and the host returns 500. The route's own header states the invariant
this breaks: always 200 once the secret is valid, because "a 500 on a bad
command turns one broken message into a retry storm that re-runs the command."
For `/forge`, `/approve`, `/rss` and `/inspect` each Telegram retry re-runs the
enqueue, so a transient outage produces duplicate publish and forge jobs.
`handleUpdate`'s own JSDoc promises it never throws.

**Recommendation.** Move the send inside the try, or give it its own catch
returning `{handled: true, sendFailed: true}`. Belt and braces: wrap
`bot.handleUpdate` at the route so nothing past the secret check can return
other than 200.

### T-731 — The change feed has no per-invocation work budget (Medium, reported)

> **Status (2026-08-28):** **FIXED, not as recommended.** The content feed drops to 8 items and the handler carries a 10-minute budget (inside `DEFAULT_CLAIM_TIMEOUT_MS`, which is the bound that matters). The review said "return early"; that would advance the lease past documents never looked at, and the feed only redelivers on a subsequent write, so their triggers would never fire again. It throws instead. Never checked before the first document, or one heavier than the budget would redeliver forever.

`functions/src/functions/change-feed.js:86-93` ·
`functions/src/lib/triggers/handlers.js:128-166`

`maxItemsPerInvocation` is 50, and a single `content` document can require an
AI cover (up to four Replicate generations, each with `Prefer: wait=60` plus
up to 120 seconds of polling), an inspection with model calls, a caption
generation and a Publer call. A batch of documents all carrying
`altCoverImageTrigger` cannot complete inside any plausible function timeout,
and because the lease checkpoints only after the handler returns, a killed
invocation redelivers the whole batch. Rising-edge claims prevent duplicate
spend on completed items, but in-flight items hold a claim for the full
fifteen-minute window, so the feed can livelock rather than fail visibly.

**Recommendation.** Lower `maxItemsPerInvocation` for the content feed to
single digits, and add a wall-clock budget to the handler loop that returns
early once a fraction of the timeout is consumed. The remaining documents
redeliver next invocation, which the claims already make safe.

### T-732 — The guard test probes only the first verb of each registration (Medium, verified)

> **Status (2026-08-28):** **FIXED** — the property now probes every non-OPTIONS verb. Nothing was actually unguarded, which the widened test confirms.

`functions/src/functions/route-inventory.test.js:216` ·
`functions/src/lib/auth/http-route.js:274-301`

The guard property invokes each registration with `options.methods[0]` only,
while `httpRouteByMethod` fans up to three verbs behind one registration — for
example PUT, PATCH and DELETE on `cms/config/{collection}/{id}`. So only the
first verb is ever guard-checked. Every merged verb was checked by hand during
this review and all call `requireRole` (15/15 in `admin-integrations.js`, 8/8
in `admin-crud.js`, 5/5 in `cms/image-prompts.js`), so this is a hole in the
safety net rather than a live vulnerability — but this test is explicitly the
replacement for the `firestore.rules` default-deny catch-all, and that
catch-all had no per-verb blind spot.

**Recommendation.** Iterate every non-`OPTIONS` method in `options.methods`
and assert `guardCalls() > 0` for each. Property 4's second test already walks
all verbs and can be reused.

### T-733 — One trigger's failure cancels the rest, and the stats update (Medium, reported)

> **Status (2026-08-28):** **FIXED** — each trigger branch is isolated, and `applyTransition` with it.

`functions/src/lib/triggers/handlers.js:128-166`

The `inspectTrigger` branch is individually wrapped; `altCoverImageTrigger`,
`forgeReadyNotifyTrigger` and `socialCaptionTrigger` are not. They rely on each
`run()` catching internally — but each of those catch blocks ends in a
`patchDoc` that can itself throw. When it does, the document-level catch takes
over and the remaining triggers *and* `dashboardStats.applyTransition` are
skipped for that document — the counter maintenance the adjacent comment
identifies as the thing that must run last. The per-trigger failure semantics
are deliberate and documented; the isolation that would make them per-trigger
is missing.

**Recommendation.** Wrap each trigger branch in its own try/catch recording
`out.<trigger> = 'error'`, matching the inspect branch, and run
`applyTransition` in a `finally` so counters are never collateral damage.

### T-734 — Scraped external URLs are fetched with no SSRF guard (Medium, reported)

> **Status (2026-08-28):** **FIXED** — `generateAltTexts` now uses the SSRF-validating fetcher, which also gained the missing size cap (Content-Length honoured before buffering, buffered length re-checked after) for every caller.

`functions/src/lib/content/inspect.js:246,309-310`

`generateAltTexts` fetches URLs taken from `scraped.images` — that is, from
whatever page `sourceUrl` pointed at — using bare `fetchImpl`, then base64s the
result into a multimodal model call. There is no protocol check, no
private-range refusal, no timeout and no response-size ceiling before
`arrayBuffer()`. The repository already contains exactly the right primitive:
`triggers/fetch-image.js` validates the protocol, refuses localhost, resolves
the host to IPv4, refuses private ranges, and re-checks on every redirect hop.
Neither `inspect.js` nor `content/scrape.js` uses it. Editor-arming and the
`CONTENTFORGE_ALT_TEXT_ENABLED` flag are what keep this Medium.

**Recommendation.** Call `fetchImage` from `triggers/fetch-image.js` in both
places, and add a byte ceiling before buffering.

### T-735 — A lost `forge_ready` notification is lost permanently (Medium, reported)

> **Status (2026-08-28):** **FIXED** — records a numeric attempt counter and two strings, never a boolean, so it cannot re-arm the rising edge. The file header claiming it "writes NOTHING" is corrected rather than left to mislead.

`functions/src/lib/triggers/forge-ready-notify.js:102-117`

On any not-sent outcome the handler writes nothing, leaving the trigger flag
true and a live claim — deliberately, so that a failure marker cannot re-fire
the feed into a loop. The reasoning holds as far as it goes, but its escape
hatch is "any later write to the document retries", and nothing writes to a
`forge_ready` document again unless a human acts. So a transient Telegram
failure at that moment strands the draft: the owner is never told it is
staged, and the only evidence is a flag sitting true in Cosmos. T-712 widens
the window, since the send has no timeout.

**Recommendation.** Stamp a bounded attempt counter and a retry-after
timestamp on the not-sent path — numeric fields, so the flag logic is not
re-armed — and have a sweeper re-drive `forge_ready` documents whose trigger
is still armed past a threshold.

### T-760 — Dead exports that are wrong if anyone uses them (Low, reported)

> **Status (2026-08-28):** **FIXED** — both deleted.

`functions/src/lib/cosmos-client.js:571-574,587-614`

`batchRead` calls `readDoc` without a partition key, which
`resolvePartitionKey` throws on for the five non-`/id` containers the module
goes to considerable lengths to protect. `watchChangeFeed` is a hand-rolled
polling loop that swallows errors to `console.error`, which is documented
elsewhere in the codebase as not reaching Application Insights. Neither is
referenced anywhere in `src/`; the real feed is `app.cosmosDB` in
`change-feed.js`.

**Recommendation.** Delete both. If `batchRead` is wanted later it should take
partition keys.

### T-761 — The daily forge budget has one enforcement point and a race (Low, reported)

> **Status (2026-08-28):** **FIXED.** `claimForgeBudget` is a server-side compare-and-increment taken before any model call, after the dedupe check (a duplicate costs no tokens) and before generation (a half-finished run has already spent). Editor forging stays uncapped as allowed, but is now COUNTED — otherwise the ceiling is measured against a number ignoring half the spending.

`functions/src/lib/timers/forge-scheduled.js:82-98` ·
`functions/src/lib/content/forge.js:263-293` ·
`functions/src/functions/forge-jobs.js:54-59`

`autoForge.dailyLimit` is read and compared only in the scheduler.
`bumpForgeStats` is a best-effort read-modify-write that swallows its own
failures, and the `forge-article` job accepts up to ten documents per call
with no budget check. Editor-initiated forging being unlimited is a defensible
choice; the finding is that the ledger the scheduler trusts is written by a
path that can silently fail, and `remaining` is computed once before a
sequential loop, so a concurrent manual forge is never observed. This is the
system's only AI-spend ceiling.

**Recommendation.** If the cap is meant as a real budget, move the check inside
`runForgePipeline` using `incrementIf` against `today.forged` — the
compare-and-increment primitive already exists and is used correctly for the
submission quota.

---

## 4. Frontend

### T-714 — Pre-rendered HTML is discarded at boot (High, verified)

> **Status (2026-08-28):** **OPEN — needs an owner decision.** The seed mechanism exists but is deliberately never mounted in the browser; switching to `hydrateRoot` without wiring it trades a spinner for hydration mismatches on every page. This needs real-browser verification, not a quiet edit.
>
> **Status (2026-09-01):** **CLOSED (#296).** The wiring landed: `main.jsx` calls `hydrateRoot` when the mount point's `data-prerendered-route` stamp matches the live path, seeded from the same element, and client-renders as before when it does not. Verified by five Playwright tests in a real browser, including a node-identity probe; both guards mutation-tested. Record in [CHANGELOG.md](../repo/changelog.md).

`frontend/src/main.jsx:16` · `frontend/scripts/prerender.mjs:219-220` ·
`frontend/src/App.jsx:275`

The build writes 104 real HTML documents, and `prerender.mjs:219` states "the
client bundle still hydrates into it." Verified: it does not.
`ReactDOM.createRoot(rootElement).render(...)` discards the container's
existing children and renders from scratch — only `hydrateRoot` adopts
server-rendered markup. Because every route is a `React.lazy` behind a single
`<Suspense>`, the visible sequence is: the pre-rendered article paints, React
clears the container, a spinner appears, and the content returns once the
route chunk downloads. That is strictly worse than either a pure SPA or true
hydration, and it discards the LCP and CLS benefit the entire pre-render step
exists to produce.

**Recommendation.** Serialize the prerender seed into the document (for
example `window.__HCW_PRERENDER__`, read by `hooks/prerenderData.js`), switch
to `hydrateRoot`, and preload the route chunk for the rendered path so the
lazy boundary resolves synchronously. If hydration is judged too risky in the
short term, document the pre-render as crawler-only and stop claiming
hydration in `prerender.mjs`.

### T-715 — A 456 kB chart bundle is preloaded on every page (High, verified)

> **Status (2026-08-28):** **PARTLY FIXED, MEASURED — and the prescribed fix does not work.** rolldown places jsx-runtime by its own rules: claiming react in an earlier chunk moved only `scheduler`, and removing the manual chart chunk made things worse (shared vendor grew to 651 kB). Splitting the libraries so only a small chunk rides with jsx-runtime does work: **868 kB → 571 kB preloaded**. recharts (237 kB) and d3 (60 kB) are now lazy-only; chart.js still rides along. Unused `d3` dependency removed.

`frontend/vite.config.js:29-39,124-179` · `frontend/dist/index.html` ·
`frontend/package.json:63,66,80`

The `pickChartsChunk` predicate is applied before all other chunking rules,
which places React's `jsx-runtime` *inside* `vendor-charts` — making that
chunk a static dependency of the app entry. Verified in the built output:
`dist/index.html` and every pre-rendered page carry
`<link rel="modulepreload" href="/assets/vendor-charts-*.js">` for 456 kB raw,
and the entry chunk opens by importing from it. The home page therefore ships
chart.js, recharts and d3 to render zero charts. Compounding it: `d3` is a
declared dependency that **no source file imports** (verified: zero matches
across `frontend/src`), `recharts` is used in one admin file and `chart.js` in
one widget — two charting stacks for two components.

**Recommendation.** Drop `d3` from `package.json`, consolidate on one charting
library, and scope `pickChartsChunk` to `node_modules/` paths — `id.includes('d3')`
is a loose substring test that matches unrelated paths. Then add a build
assertion that fails if `dist/index.html` modulepreloads any chunk above about
150 kB; this class of regression is invisible without one.

### T-716 — Public list pages download the whole corpus, three times (High, reported)

> **Status (2026-08-28):** **FIXED** — request-layer dedupe keyed on path+query, plus one `PUBLIC_CORPUS_LIMIT`. Deliberately NOT pushed server-side: client provider matching includes text inference the server does not perform, so filtering there would silently drop posts (see T-738).

`frontend/src/hooks/useBlogData.js:216,231` ·
`frontend/src/hooks/useProviderLandingContent.js:160,188` ·
`frontend/src/hooks/useFrameworkData.js:190,199` ·
`frontend/src/lib/publicApi.js:37-47`

`fetchPublicContentList` accepts `type` and `provider`, and the server expands
provider aliases — none of the three call sites passes either. `/aws/blog`
fetches every published document with bodies included and then discards
non-AWS rows in JavaScript. The three hooks use three distinct cache keys and
two different limits for what is otherwise the same request, and
`usePublicData` has no shared cache, so a visitor moving `/aws` → `/aws/blog`
→ `/aws/frameworks` triggers three near-identical full-corpus downloads.

**Recommendation.** Pass `{ provider, type }` server-side, unify the limit,
and give `usePublicData` a module-level promise cache keyed on the request URL
so concurrent and repeat callers share one in-flight request.

### T-717 — A failed fetch renders the previous route's content (High, reported)

> **Status (2026-08-28):** **FIXED** — a failed fetch clears `data` instead of leaving the previous route's article under the new route's canonical, and the wrapper hooks surface `error` instead of hardcoding null.

`frontend/src/hooks/usePublicData.js:43-50,79-84` ·
`frontend/src/components/templates/BlogDetailTemplate.jsx:63-68` ·
`frontend/src/hooks/useBlogData.js:254` · `frontend/src/hooks/useFrameworkData.js:214`

On a key change the hook deliberately keeps the previous data to avoid an
empty flash. On rejection it sets `error` and clears `loading` but leaves
`data` untouched. The two behaviours combine badly: navigating
`/aws/blog/a` → `/aws/blog/b` with a failed request for `b` renders **article
A's** title, body and image while the template emits canonical, `og:url` and
`og:title` for **b** — wrong content under a correct-looking URL and correct
metadata. `BlogDetailTemplate` destructures only `{data, loading}`, and the
wrapper hooks hardcode `error: null`, so no error reaches any UI on the blog
or framework paths. There is no retry either: one network blip is terminal.

**Recommendation.** Clear `data` when the key changes *and* the fetch errors,
keeping the carry-over only for the pending state; surface `error` through the
wrapper hooks; render an error state in the detail templates; add one bounded
retry for network and 5xx failures in `publicGet`.

### T-736 — MSAL is in the static import graph of a public route (Medium, reported)

> **Status (2026-08-28):** **FIXED and measured.** Two static edges, not the one reported: `useAdminAuth` AND `lib/api.js`, the latter inherited by anything importing `postJSON`. Both dynamic now. NewsPage static closure 1,060,504 → 816,158 bytes, `entraAuth` and `vendor-msal` gone from it. A chunk-graph test holds the line, with a guard-the-guard case.

`frontend/src/hooks/useGenerateCuratedImages.js:4,80` →
`frontend/src/hooks/useAdminAuth.js:17-18` → `frontend/src/lib/entraAuth.js`

The header comment on `useGenerateCuratedImages` states that its role gate
"stops the hook dragging MSAL onto the critical path of a public page." The
runtime gate does work; the module graph does not follow it. Because
`useAdminAuth` is a static import, the built `NewsPage` chunk statically
imports `entraAuth`, which imports `vendor-msal` — so an anonymous visitor to
`/azure/news` downloads and executes 236 kB of `@azure/msal-browser` and runs
`onAuthStateChanged`. `App.jsx:226` and `useAuthRedirectLanding.js:43` got this
right with a dynamic import; this path did not.

**Recommendation.** Move the role check behind a dynamic
`import('@/hooks/useAdminAuth')`, or split the "am I an editor" read into a
small module that does not pull `entraAuth`. Add a chunk-graph assertion that
no public page chunk reaches `vendor-msal`.

### T-737 — Eleven public routes are neither pre-rendered nor in the sitemap (Medium, reported)

> **Status (2026-08-28):** **FIXED.** 16 standalone routes pre-rendered; build 104 → 120 documents and sitemap 104 → 120 entries. `routes-are-complete.test.js` checks both directions — a declared route not pre-rendered, and a pre-rendered route that no longer exists (which would publish a 200-status NotFound page). `X-Robots-Tag: noindex` added for `/admin/*` and `/preview/*`, ordered before the `/*.html` rule since SWA applies the first match.

`frontend/scripts/prerender-entry.jsx:26-37,61-72` ·
`frontend/scripts/prerender.mjs:245-253` · `frontend/dist/sitemap.xml`

`routes()` enumerates only `/`, `/about`, `/contact` and the
`/:provider/<section>` grid. Confirmed missing from both the sitemap and disk:
`/tools/migration`, `/tools/comparison`, `/tools/resources`, `/tools/decisions`,
`/finops/tools`, `/finops/focus`, `/terraform/modules`, `/terraform/tools`,
`/github/workflows`, `/github/tools` and `/templates/*` — all declared in
`App.jsx` and all indexable. They fall back to `app-shell.html`, which has a
generic title and no canonical. Separately, `seedFor` matches only
`/blog/([^/]+)$`, so `architecture-designs/:slug`, `frameworks/:slug`,
`coder-corner/:slug`, `news/:slug` and `code/:slug` — the templates with the
richest metadata — are never pre-rendered. Related: `staticwebapp.config.json`
sets no `X-Robots-Tag` for `/admin/*` or `/preview/*`, and a `robots.txt`
`Disallow` prevents crawling but not URL-only indexing; the Helmet `noindex`
is client-side only and `app-shell.html` carries none.

**Recommendation.** Derive the static-route list from the same source `App.jsx`
uses, or add a validation asserting every non-parameterised public route
appears in `routes()`. Extend `seedFor` to the other detail sections, and add
`X-Robots-Tag: noindex` route headers for `/admin/*` and `/preview/*`.

### T-738 — Provider normalization is reimplemented four times and has diverged (Medium, verified)

> **Status (2026-08-28):** **FIXED, and the finding under-stated itself.** One table-driven normalizer in `lib/providers.js`, walked by its own test so a new provider is covered when added. Separately: `contentModel.normalizeContentProvider` matched EXACT keys, so "Microsoft Azure" became `microsoftazure` and "AWS Lambda" became `awslambda` — and it feeds `getContentPublicPath`, so it built public URLs no route serves, for the normal case rather than an exotic one.

`frontend/src/hooks/useBlogData.js:13-53` ·
`frontend/src/hooks/useProviderLandingContent.js:24-57` ·
`frontend/src/lib/contentModel.js:53-68` · `frontend/src/lib/blogUtils.js:8-19`

Four independent provider-canonicalisation implementations with different
alias tables. The divergence is live, not hypothetical:
`useProviderLandingContent` handles `vmware`, `ansible`, `broadcom` and
`redhat`; `useBlogData` does not. So a VMware or Ansible document without an
explicit provider field appears on the landing page and vanishes from
`/vmware/blog`. The same shape repeats for field aliasing — `Title || title`,
the five-way published-date coalesce — reimplemented in `BlogDetailTemplate`,
both hooks, `useEditorState` and a dozen admin files, even though
`blogUtils.normalizeContentFields` exists for exactly this.

**Recommendation.** Make `lib/contentModel.js` the single normalizer for
provider canonicalisation, field aliasing and dates; have every hook and
template consume it; delete the local copies. A table-driven test over the
alias set is the cheap guard against re-divergence.

### T-739 — N+1 fetch on the public news grid (Medium, reported)

> **Status (2026-08-28):** **FIXED.** New anonymous `GET public/curated-images?ids=…`, one ARRAY_CONTAINS query for the grid, bounded at 50 ids so it cannot become a point-read amplifier. Seven disclosure cases are run through BOTH handlers and compared, so a rule changed in one and not the other fails rather than leaking. A failed batch yields `undefined` per id, not null, so the hook falls back per-article instead of reading one bad request as "no article has a cover".

`frontend/src/hooks/useGenerateCuratedImages.js:209-216,120`

`generateImagesForArticles` maps over the article list and issues one
`GET public/curated-image/{id}` per article. For a twelve-card news grid that
is twelve extra round trips before any cover image appears, on a route that
has already fetched the feed. There is no batch endpoint and no per-id memo,
so a remount repeats all of them.

**Recommendation.** Add a batched `public/curated-images?ids=…` read, or return
the image URL on the feed document itself — `fetchPublicFeed` already folds two
queries into one round trip — and memoize resolved ids across mounts.

### T-740 — Route transitions are silent and unfocused (Medium, reported)

> **Status (2026-08-28):** **FIXED.** Focus moves to `#main-content` (`preventScroll`, or it fights the scroll reset), a polite live region announces the new title, `PageLoader` gains `role="status"` and a name, `Skeleton` gains a dark token. Hash links are left alone entirely — `#section` means "go here", and stealing focus would undo it.

`frontend/src/components/shared/ScrollToTop.jsx:7-9` ·
`frontend/src/App.jsx:174-178,273` ·
`frontend/src/components/performance/Skeleton.tsx:52`

Route changes scroll to top but never move focus. `<main id="main-content"
tabIndex={-1}>` exists and is the obvious target but is never focused, and
there is no `aria-live` route announcer — so screen-reader and keyboard users
remain parked on the previous page's link with no announcement after every
navigation. The `PageLoader` shown on every lazy route is a bare spinning
`div` with no `role="status"` and no accessible name, so the transition is
silent as well as unfocused. Separately, `Skeleton` hardcodes `bg-slate-200`
with no dark-mode token, so dark-theme skeletons render as near-white blocks.
The header itself is in good shape — correct `aria-expanded`, `aria-controls`,
`role="menu"` and Escape handling.

**Recommendation.** Focus `#main-content` in `ScrollToTop`'s effect (guarding
hash links), add a visually-hidden `aria-live="polite"` region announcing the
new document title, give `PageLoader` `role="status"` and a label, and
tokenize the Skeleton background.

### T-762 — Duplicate route declarations leave dead branches (Low, reported)

> **Status (2026-08-28):** **FIXED.** Three shadowed static routes removed; the `/:provider` block already served all three, and does it inside `ProviderLayout`. The dispatchers read `slug` from `useParams` instead of sniffing the pathname. The first version of the guard MISSED the bug — it compared absolute paths to each other, but the shape is an absolute route shadowing a RELATIVE child — and now detects that; all four shadowing shapes fail.

`frontend/src/App.jsx:227-228,282-311,317-333,510-535` ·
`frontend/src/context/ProviderContext.jsx:169-183`

`/terraform/code`, `/github/code` and `/finops/architecture-designs` are
declared both inside the `/:provider` block and as static top-level routes.
Static wins, so the terraform and github list branches in
`ProviderCodeDispatcher` are unreachable while their `:slug` detail branches
still run — one URL family served by two code paths. More consequentially,
the top-level declarations sit *outside* `ProviderLayout`, so `useProvider()`
is null on `/finops/tools`, `/terraform/modules`, `/github/workflows` and
their siblings while it is populated on adjacent routes; `App.jsx:227-228`
compensates with a second, independent derivation of the provider from
`location.pathname`. The dispatchers also infer list-versus-detail by sniffing
`pathname.split('/').pop()` when the route already supplies `:slug` via
`useParams`.

**Recommendation.** Nest the provider-specific static routes inside the
`/:provider` element so context is uniform, delete the duplicated top-level
declarations, and switch the dispatchers to `useParams().slug`. Related:
`pages/azure/EducationPage.jsx` is 1,544 lines compiling to a 141 kB chunk of
largely inline catalogue data, which belongs in `public/data/*.json`.

---

## 5. CI/CD

### T-705 — The production environment gates nothing, and dispatch accepts any ref (Critical, verified + one verify item)

> **Status (2026-08-28):** **PARTLY FIXED; owner action open.** Both deploy workflows now refuse a dispatch from any ref but `main`, and Required-Inputs §4.4 no longer asserts a gate whose existence could not be confirmed. The environment protection rules themselves still need configuring.

`.github/workflows/deploy-functions.yml:16,35-40` ·
`.github/workflows/deploy-azure-frontend.yml:16,24-30` · `infra/oidc.tf:153-166`

Both deploy workflows are `workflow_dispatch`-only and bind their job to
`environment: production`. Because the federated credential's subject is
environment-scoped (`repo:…:environment:production`), the OIDC token matches
**regardless of which ref the dispatch runs against**. So the 14-check PR gate
and the 12 required contexts are bypassable by anyone with write access:
dispatch a deploy from an unreviewed branch and it ships to production with
full Azure credentials. The frontend deploy is the same shape, with the SWA
token available to any-ref dispatch.

Both workflow files' own comments state that GitHub auto-creates a missing
environment with no protection rules, so binding to it "records who deployed
without gating whether they may." **`TODO.md:300` contradicts this**,
recording the environment as VERIFIED and "Gates production deploys". The
GitHub environments API is not reachable through the review session's proxy,
so which is true is a **verify** item — but the two records cannot both be
right, and that alone needs resolving.

**Recommendation.** Configure required reviewers and a `main`-only
deployment-branch restriction on the `production` environment; optionally add
a guard step failing when `github.ref != 'refs/heads/main'`. Then reconcile
Required-Inputs §4.4 with the configuration that actually exists.

### T-713 — The storage firewall stays open if a deploy dies mid-window (High, reported)

> **Status (2026-08-28):** **FIXED** — the hourly monitor now probes storage default action and leftover `ci-*` rules, so an orphaned deploy window pages within the hour.
>
> **Corrected 2026-10-12 (#1050).** That fix read the storage account's network rules only. The Function App's own `ci-deploy-scm-*` and `ci-smoke-*` access restrictions, which this finding names, had no probe, and `scripts/assert-origin-lock.mjs` accepts any single-host `ci-*` rule because a concurrent run may hold one. The same monitor now matches each Function App `ci-*` rule to its run by the id in its name and fails, naming the rule and the command that removes it, when the run has ended (`scripts/check-ci-access-windows.mjs`).

`.github/workflows/deploy-functions.yml:97-101,145,248-264,294-300`

The deploy flips the Functions host storage account to
`--default-action Allow` for the duration of the package upload and trigger
sync. The `always()` close steps do not run on runner loss, infrastructure
failure, or a force-cancelled job — in those cases the account, which is the
host's secret repository, stays network-open indefinitely with only Entra
data-plane auth remaining. Stale `ci-deploy-scm-*` and `ci-smoke-*` allow rules
for a since-recycled runner IP persist the same way. Nothing detects either:
`monitor-functions-registered.yml` checks function count and app settings but
never firewall posture.

**Recommendation.** Add `defaultAction == Deny` and a zero-`ci-*`-rules
assertion to the hourly monitor workflow, which already authenticates with an
identity holding sufficient rights. An orphaned window then pages within the
hour instead of persisting silently.

### T-726 — A scheduled workflow pushes to main past the gate (Medium, reported)

> **Status (2026-08-28):** **FIXED.** Two jobs: `build` holds the Azure identity and never `contents: write`; `commit` holds `contents: write`, installs nothing, and runs only git and node built-ins. `build` installs with `--ignore-scripts`. The ruleset bypass itself is owner-gated.

`.github/workflows/publish-content-manifest.yml:28-29,60,71-86` ·
`.github/workflows/sync-wiki.yml:27`

For this scheduled `git push` to succeed against a main protected by twelve
required contexts, the ruleset must bypass the Actions token — which means
every workflow holding `contents: write` carries a token that can push
arbitrary commits to main past all checks. Additionally the workflow runs
`npm ci` in `scripts/` while holding **both** `contents: write` and
`id-token: write` (the full deploy identity), which is the single highest
supply-chain concentration in the pipeline. And the manifest content itself —
articles written by humans and by the forge — lands on main and flows into
prerender output with no review.

**Recommendation.** Commit via a scoped bot or an auto-merging PR, or narrow
the ruleset bypass to a deploy key limited to this path. Run the Cosmos read
with `--ignore-scripts`, or in a job separate from the one holding
`contents: write`.

### T-727 — The SWA deployment token is the last long-lived credential (Medium, reported)

> **Status (2026-08-28):** **MITIGATED.** The token now lives in a job that installs nothing, so a compromised build dependency cannot reach it. It can still poison that deploy's content — it produced it — but not take the credential and publish again tomorrow, which is the harm named. Retiring it (OIDC, or an environment secret on a protected `production`) is owner-gated.

`.github/workflows/deploy-azure-frontend.yml:46-57,152`

`AZURE_STATIC_WEB_APPS_API_TOKEN` is the one remaining stored, non-expiring
credential in the pipeline; everything else is federated OIDC. It is used in
the same job that has just built the frontend from npm dependencies, so a
compromised build dependency has it in reach, and exfiltration grants standing
ability to publish arbitrary content to the public site until someone rotates
it manually.

**Recommendation.** Move to OIDC-based SWA deployment, or store the token as
an environment secret behind the (to-be-protected, per T-705) `production`
environment and set a rotation cadence. See also T-722.

### T-728 — One identity serves monitors and deploys alike (Medium, reported)

`infra/oidc.tf:41-46,176-202` · `monitor-functions-registered.yml:90-94` ·
`verify-alert-state.yml:62-66` · `heal-computed-properties.yml:71-75`

Every workflow authenticates as the same client id, and the branch credential
trusts `ref:refs/heads/main`. So the read-only monitor and alert-verify jobs —
which need Monitoring Reader and a Website read at most — run as an identity
that also holds Storage Account Contributor, Storage Blob Data Contributor,
Website Contributor and Cosmos data writes. A compromise of any scheduled
workflow's dependency chain yields the full deploy blast radius.

**Recommendation.** Split into a reader identity for monitor and verify and a
deploy identity for the rest, each with its own federated credential.

### T-729 — No concurrency control on the frontend deploy, and no rollback anywhere (Medium, reported)

> **Status (2026-08-28):** **FIXED.** `concurrency: swa-deploy`, cancel-in-progress false. Rollback is documented with the constraint that makes it non-obvious: you cannot roll back by dispatching an older ref, because the T-705 guard refuses any ref but main. Deliberately not automated — a post-deploy check from a GitHub runner is a datacenter client, which Bot Fight Mode 403s, so it would roll back healthy deploys.

`.github/workflows/deploy-azure-frontend.yml:15-30` ·
`.github/workflows/deploy-functions.yml:302-345`

The frontend workflow declares no `concurrency` group, so two overlapping
dispatches race the SWA upload with nondeterministic last-writer-wins. The
functions deploy handles concurrency correctly, but neither has a rollback
path: a failed post-deploy smoke test leaves the new, bad package live and
merely marks the run red. Mean time to recovery is therefore "a human notices
a red run and re-dispatches an older ref" — which T-705 shows is not even
branch-restricted.

**Recommendation.** Add `concurrency: {group: swa-deploy, cancel-in-progress: false}`
to the frontend workflow. Document and ideally automate rollback: re-run of
the last green run's ref, or retain the previous package URL and re-point on
smoke failure.

### T-755 — The Trivy checksum shares an origin with the binary (Low, reported)

> **Status (2026-08-28):** **FIXED** — digest pinned in-repo and verified against the real artifact (`sha256sum -c` passed locally) before committing.

`.github/workflows/iac-validate.yml:119-130,159-165`

The sha256 manifest is downloaded from the same GitHub release as the tarball
it verifies, so an attacker who can re-point the release — exactly the
trivy-action incident the workflow's own comment documents — controls both.
The comment already recommends the fix.

**Recommendation.** Embed the tarball's sha256 literal in the workflow beside
`TRIVY_VERSION`.

### T-756 — A dispatch input is interpolated into a shell command (Low, reported)

> **Status (2026-08-28):** **FIXED** — passed through `env:`.

`.github/workflows/heal-computed-properties.yml:94`

`node apply-computed-sortdate.mjs --${{ inputs.mode || 'apply' }}` splices a
dispatch input into a `run:` string. Exploitability is near nil — a
`type: choice` input is validated against its options at dispatch time, and
dispatching requires write access — but it is the only deviation from the
env-var pattern the repository otherwise applies deliberately.

**Recommendation.** Pass via `env:` and reference `"$MODE"`, matching
`validate-deployed.yml:106-109` — a file deleted on 2026-09-08, so the
pattern is now read from any other workflow that passes a value through
`env:`. The recommendation itself was applied at the time and is unaffected.

### T-757 — Gate coverage gaps (Low, reported)

> **Status (2026-08-28):** **HALF FIXED, HALF WRONG.** The `vps-agent` half is closed (see T-743). The frontend half is wrong: `test:admin` is plain `vitest run` with no include filter and has been since T-320 closed exactly this — 33 files, 315 tests, all of them. The finding was inferred from the script's NAME. The name was the defect and is gone: `test` is the CI-correct run, `test:watch` the watch mode.

`.github/workflows/ci.yml:41,49-50`

A broken change to `vps-agent/` merges with only `npm ci` validating it — see
T-743 for why that surface deserves more — and frontend regressions outside
the admin suite are invisible to the gate, which runs `test:admin` only.
Neither is a vulnerability (PR permissions are read-only); both are accepted
risk worth recording rather than rediscovering.

**Recommendation.** Add at least a lint or typecheck step for `vps-agent`, and
widen the frontend test script as the suite stabilises.

### T-758 — `dependency-review` requests write on a fork-facing trigger (Low, reported)

> **Status (2026-08-28):** **FIXED** — both the write scope and the comment option removed.

`.github/workflows/dependency-review.yml:21-24,36`

On fork pull requests the token is silently downgraded to read, so
`comment-summary-in-pr: always` degrades to a warning and posts nothing —
inconsistent gate output rather than a vulnerability. The write scope adds no
enforcement value, since the check status alone gates the merge.

**Recommendation.** Either accept the degraded fork behaviour explicitly, or
drop the comment option and `pull-requests: write` together.

---

## 6. Edge and operational surfaces

### T-702 — Both confirmation gates self-approve without a TTY (Critical, verified)

> **Status (2026-08-28):** **FIXED** — `Confirm-Plan` refuses non-interactively instead of assenting, naming `-Force` as the deliberate unattended path; the six destructive scripts declare `ConfirmImpact = 'High'`.

`scripts/lib/deploy-console.ps1:208-209` ·
`scripts/bootstrap-terraform-oidc.ps1:110,352,420` ·
`scripts/cutover/02-swa-token.ps1:35,55-59` ·
`scripts/cutover/04-telegram-webhook.ps1:48,99-107`

`Confirm-Plan` returns `$true` unconditionally when
`-not [Environment]::UserInteractive -or [Console]::IsInputRedirected`. That is
the single human gate in front of tenant-root elevation, workspace-variable
writes and the `COSMOS_ENDPOINT` secret delete. The second gate does not
prompt either: verified by enumeration, all eight scripts declare
`SupportsShouldProcess` **without** `ConfirmImpact = 'High'`, so under the
default `$ConfirmPreference = 'High'` `ShouldProcess` returns `$true`
silently. The net effect is that
`pwsh -File bootstrap-terraform-oidc.ps1 -ElevateAccess < /dev/null` — a CI
runner, a piped invocation, a wrapper script — escalates to tenant-root User
Access Administrator with zero prompts, and `02-swa-token.ps1 -Rotate`
invalidates the live SWA deploy token the same way.

**Recommendation.** Make `Confirm-Plan` *refuse* in a non-interactive context —
return `$false` with guidance — and require an explicit `-Yes` or `-Force`
switch to proceed unattended. Add `ConfirmImpact = 'High'` to every
destructive script.

### T-703 — The root-elevation removal reports success on its own failure (Critical, verified)

> **Status (2026-08-28):** **FIXED** — `Invoke-Az` records whether the call failed, `Test-LastAzFailed` exposes it, and an unreadable read-back is now the red path with the manual removal command printed.

`scripts/bootstrap-terraform-oidc.ps1:445-470` ·
`scripts/lib/deploy-console.ps1:435-447`

`-ElevateAccess` grants tenant-root User Access Administrator, then deletes it
with `-AllowFailure` and re-reads the assignments to confirm. But `Invoke-Az`
returns `$null` on **both** "no assignment found" and "the call failed" under
`-AllowFailure` — verified at lines 441 and 444-445. So a throttled,
network-failed or permission-denied `role assignment list` takes the success
branch and prints "Root-scope elevation removed (verified by reading
assignments back)" over a grant that is still live. The comment immediately
above states this exact false-green is what the read-back exists to prevent.
The residue is a standing tenant-wide privilege with no owner and no expiry —
the worst thing this repository's tooling can leave behind.

**Recommendation.** Have `Invoke-Az` distinguish failure from empty — a
sentinel return, or check `$LASTEXITCODE` at the call site — and treat an
*unreadable* result as the red path, never the green one.

### T-704 — The T-526 cutover script has no working dry run (Critical, verified)

> **Status (2026-08-28):** **FIXED** — the Key Vault window is `ShouldProcess`-guarded, the verify block is skipped under `-WhatIf`, and the decorative secret line is replaced by a behavioural check (401 without the token, 200 with it) that also proves the vault token matches the deployed one. **T-526 is safe to run.**

`scripts/cutover/04-telegram-webhook.ps1:63-72,133,146-153` ·
contrast `scripts/cutover/03-keyvault-secrets.ps1:70`

Three defects in the script that T-526 is waiting to run, all verified.

1. The Key Vault firewall open at line 68 is **not** wrapped in
   `ShouldProcess`, unlike its twin in `03-keyvault-secrets.ps1`. So `-WhatIf`
   still mutates the production vault's network ACL and extracts
   `TELEGRAM-BOT-TOKEN` — the dry run is not dry.
2. Under `-WhatIf` the `setWebhook` call is correctly skipped, but the verify
   block runs unconditionally and throws at line 153 when the URL has not
   changed. The dry run therefore always ends red and teaches the operator
   nothing.
3. Line 150 prints `custom secret: set` from
   `$(if ($after.has_custom_certificate -or $secret) …)`. `$secret` is always a
   non-empty string by that point, and `has_custom_certificate` describes
   self-signed certificates, not `secret_token`. Telegram's `getWebhookInfo`
   never returns the secret, so this line reads "set" unconditionally and
   verifies nothing.

**Recommendation.** Guard line 68 with `ShouldProcess`; skip the verify block
when `$WhatIfPreference` is set; replace the secret check with a real one —
re-POST to the target with the derived `secret_token` header and assert it is
no longer 401. **Do this before running T-526**, not after.

### T-741 — The harness closes an empty workflow as `completed` (Medium, reported)

> **Status (2026-08-28):** **FIXED** — such a close is now `empty`, distinct from `abandoned`; the CI assertion says so. Both harness scenarios were reproduced locally before pushing.

`tooling/workflow.py:341-344,398` · `.github/workflows/ci.yml:120-125`

`evaluate_workflow` correctly refuses `completed` when the required set is
empty, falling through to `partial`. `close_workflow` then overwrites that:
it sets `abandoned` if there were errors and `completed` otherwise, with no
`required` check. A workflow whose every node was skipped as optional closes
as `completed`. The CI smoke test does exactly this — `ci-probe` is not in the
agent registry, so it is unavailable and treated as optional — and then
*asserts* the result is `completed`. The module's own docstring says the tool
exists to stop an audit trail that claims work which never ran.

**Recommendation.** Close as `completed` only when at least one node validated
and none were skipped; otherwise `abandoned`, or a new `empty` status. Update
the CI assertion to match.

### T-742 — The harness CI check never exercises the validator (Medium, reported)

> **Status (2026-08-28):** **FIXED.** A CI step now manufactures an available agent (none is committed, which is why every node took the unavailable branch), asserts it IS available or the step would silently re-test the broken path, then proves a valid handoff passes and two forgeries do not. Verified by mutating the validator three ways.

`.github/workflows/ci.yml:117-137` · `tooling/workflow.py:273-301,322-329` ·
`hooks/claude_event.py:86-94`

Both harness scenarios drive their nodes through the unavailable-agent branch,
so no handoff file is ever written and `handoff_valid` and `scalar` — the
regex parsing that decides whether an agent's claimed work is real — are never
called. A regression in the frontmatter regex, the workflow/agent id
cross-check, or the evidence-and-artifact requirement passes CI green, and the
Stop guard would then release on a workflow carrying fabricated handoffs.

**Recommendation.** Add a CI step writing a valid handoff for an available node
and asserting `validate` exits 0, plus a mutated copy (wrong agent id, missing
evidence) asserting exit 1.

### T-743 — The `vps-agent` CI check runs no tests (Medium, reported)

> **Status (2026-08-28):** **FIXED.** `buildDockerArgs` extracted and pinned by 37 tests using `node:test` — no dependency added, since this package's single-dependency lockfile was its one virtue as a check. It also refuses a capability that sets a sandbox-controlled flag. The first version of the test was WRONG (it compared against the module's own constant, so `--user 0:0` passed); mutation testing caught it and the contract is now written out literally.

`.github/workflows/ci.yml:49-50` · `vps-agent/package.json:10-12` ·
`vps-agent/lib/docker-runner.js:77-93`

The matrix entry declares no lint, build or test step, so the job's only work
is `npm ci` — a lockfile check on a single dependency. There is no `test`
script and no test files anywhere under `vps-agent/`. This is the surface that
shells out to `docker run` with attacker-influenced payloads and holds a
long-lived Entra certificate; the sandbox flag list (`--network none`,
`--cap-drop ALL`, `--user 65534`, `--read-only`) is the entire security
boundary and nothing asserts it stays intact. An edit dropping `--network none`
ships green.

**Recommendation.** Add unit tests asserting the exact `dockerArgs` array
`runInDocker` builds per capability, that `buildCommand` never receives a
shell-interpolated payload, and that `executeJob` refuses an unknown job type;
wire `test: npm test` into the matrix row.

### T-744 — `maxConcurrentJobs` is not enforced (Medium, reported)

> **Status (2026-08-28):** **FIXED** — a `pendingClaims` counter covers the window between deciding to claim and `executeJob` owning the slot.

`vps-agent/index.js:123,157-167,177` · `vps-agent/lib/api.js:57`

`poll()` checks `activeJobs >= config.maxConcurrentJobs` *before* awaiting
`api.claimJob()`, but `activeJobs` is incremented only inside `executeJob`,
after the claim returns. `poll` runs on a bare `setInterval` at 15 seconds
while the claim timeout is 20 seconds, so a slow claim lets a second poll pass
the guard with the counter still at zero. With the documented
`LABS_AGENT_MAX_CONCURRENT=1` and a 256 MB / 0.5 CPU budget, two concurrent
Terraform containers is a real resource-exhaustion path on a small VPS.

**Recommendation.** Reserve the slot before the await — increment a pending
counter in `poll()`, include it in the guard, release it in a `finally`.

### T-745 — The availability alert has no ingestion-lag headroom (Medium, verified)

> **Status (2026-08-28):** **FIXED** — 30-minute window expecting 6 results, firing below 3; the Worker cadence comment moved with it, since the two must change together.
>
> **Status (2026-09-01): that was half true, and the wrong half.** The threshold moved to 3 and every prose description — this line, the resource's `description`, the inline comment, `wrangler.toml` — moved to "30-minute window". `window_duration` stayed at `PT15M`. Three rows per window against a threshold of 3 tolerates nothing, so the finding was not merely open, it was **inverted**: the pre-fix shape (`PT15M`, threshold 2) tolerated one miss and the "fixed" one tolerated none. Caught 2026-09-01 while preparing to arm `availability_probe_alert_enabled` for the first time, so it never fired. `window_duration` is now `PT30M`, matching the recommendation below and the four places that already claimed it.

`edge/availability-probe/wrangler.toml` (`[triggers] crons`) ·
`infra/observability.tf` (`azurerm_monitor_scheduled_query_rules_alert_v2.edge_probe_availability`) ·
`edge/availability-probe/worker.js` (`buildEnvelope`)

**The analysis below is the state as found on 2026-08-28 and is deliberately
left as written** — it is the evidence for the finding, not a description of the
rule today. Read the status lines above for that. (Same treatment as ADR 0025,
whose heading changed while its analysis did not.) Today the rule is `PT30M`
with `threshold = 3`.

The telemetry shape genuinely matches the alert — `PROBE_NAME` equals the
query's `name ==` filter, the envelope is a well-formed
`Microsoft.ApplicationInsights.Availability` payload, and the `*/5` cron
against a `PT15M` window with `threshold < 2` is arithmetically what the
comments claim. The gap is timing. The query window is `[now-15m, now]` with
no grace for ingestion delay, and App Insights availability rows typically
land one to three minutes late and occasionally more. At any evaluation the
newest one or two probes may not yet be queryable, so the "one dropped run is
tolerated" budget the ADR claims is already spent: a single lagged ingestion
plus one missed cron pages Sev 1 against a healthy site.

**Recommendation.** Widen to `PT30M` with `threshold = 3` — still detects a
real outage inside about fifteen minutes while tolerating lag plus one drop —
or keep `PT15M` and drop the threshold to 1.

### T-746 — A failed probe leaves no diagnosable trace (Medium, verified)

> **Status (2026-08-28):** **FIXED** — Workers Logs enabled and the handler logs before rethrowing. Diagnosis, not recovery: the one-sided no-retry design is unchanged.

`edge/availability-probe/worker.js:60-64,133-140,145-149` ·
`edge/availability-probe/wrangler.toml`

`scheduled` calls `ctx.waitUntil(runProbe(env))` with no catch, and `runProbe`
deliberately does not retry or trap the ingestion POST. That one-sided design
is correct — but `wrangler.toml` declares no `[observability]` block, so
Workers Logs is off and the rejection goes nowhere. When
`alert-api-reachability` fires, the three causes it deliberately conflates —
API unreachable, Worker or cron dead, ingestion path dead — have no tiebreaker
anywhere. A mistyped `wrangler secret put` produces a permanent Sev 1 with
`parseConnectionString` throwing silently every five minutes. This matters
most at T-519 deploy time, when a bad secret is the likeliest first failure.

**Recommendation.** Add `[observability] enabled = true` to `wrangler.toml`,
and wrap the `scheduled` body in a try/catch that `console.error`s the reason
before rethrowing, so the Worker's own tail distinguishes the three cases.

### T-747 — The Worker package is absent from Dependabot (Medium, reported)

> **Status (2026-08-28):** **FIXED — and it exposed something larger.** Adding the entry made Dependabot re-validate the file, which failed: the `/infra` terraform entry carried `cooldown.semver-major-days`, unsupported for that ecosystem. An unsupported property invalidates the WHOLE file, so **no ecosystem had been getting updates at all**. Pre-existing and latent, because Dependabot only re-validates when the file changes. Fixed in the same PR. This is a finding the review did not make, surfaced by acting on its lowest-value item.

`.github/dependabot.yml`

The configuration lists `/frontend`, `/functions`, `/scripts` and
`/vps-agent`, but not `/edge/availability-probe`. Impact today is zero — the
package has no dependencies — so this is a completeness finding recorded so
that adding a dependency later does not silently enter an unwatched package.

**Recommendation.** Add the directory now, while it is a one-line change with
no findings attached.

### T-759 — Job images are pinned by mutable tag on a root-equivalent socket (Low, reported)

> **Status (2026-08-28):** **FIXED.** All three images pinned by digest, each read from the registry's `Docker-Content-Digest` header and cross-checked against the Docker Hub API. `capabilities.test.js` fails on a tag-only reference, and the update procedure is written beside the digests.

`vps-agent/lib/capabilities.js:19,30,45` · `vps-agent/lib/api.js:16-21`

`alpine:3.20`, `hashicorp/terraform:1.9` and `alpine/ansible:2.17.0` are tags,
not digests, and the runner pulls implicitly at `docker run` time — with
`--network none` applied to the container, not to the pull. A repushed tag
changes what executes on the VPS with no repository change and no review.
Compounding it, the agent must have Docker socket access, which is
root-equivalent on that host: the certificate-credential blast radius argued
in `api.js` is bounded at the API but not on the VPS itself. There is no
systemd unit, Dockerfile or update runbook anywhere in the repository for this
component, and `ClientCertificateCredential` reads the PEM once at
construction, so certificate rotation requires a restart that nothing
schedules.

**Recommendation.** Pin each image by `@sha256:` digest and pre-pull out of
band. Run the agent as a non-root user in the `docker` group, and write the
install, update and certificate-rotation runbook.

---

## Examined and found sound

Recorded so that the absence of a finding carries information.

**Identity and access.** Federated-only deploy identity with both subject
forms, scoped rather than subscription-level role grants, traced-to-consumer
grant hygiene, clean revocation records, and subject assertions under test
(`scripts/oidc-subjects.test.mjs`). Managed identity throughout the data
plane; shared keys disabled on both storage accounts and Cosmos local auth
off.

**Backend security primitives.** The three-gate role model (correct hierarchy
comparison, fail-closed on lookup error, unknown-role requirement throws,
bounded cache keyed post-verification); the public read surface (server-side
visibility filter in both SQL and JavaScript with the correct wide/narrow
asymmetry, `TOP` on every query, field projection rather than `SELECT *`,
byte-identical 404 for missing and non-public); the signed preview route
(HMAC over id and expiry, constant-time compare after a length check, uniform
refusal); the anonymous submission quota (compare-and-increment with a
loser-aware reset path, exact under burst); the rising-edge claim evaluator
(etag-conditioned with 412 re-read, unreadable timestamps refused rather than
taken over); the AI router (timeout, bounded retry, provider-unusable versus
bad-request failover, single repair round trip); the SSRF guard in
`fetch-image.js`; the Telegram webhook's constant-time secret comparison; and
the job worker core's etag-conditioned claim and timeout race.

**Contract integrity.** `.azure/api-surface.json` and the registered routes
agree bidirectionally at method level, with duplicate-claim detection and
`notImplemented` enforced as unregistered. No drift found.

**Terraform discipline.** The root-module shape was re-evaluated against ADR
0020's revisit triggers rather than assumed (none have fired); credential-free
provider blocks with the bootstrap-identity comment the standard requires; a
committed lock file with the wrong-workspace hazard documented; exactly one
`ignore_changes` block in the estate and it is justified; both azapi uses
re-verified as still necessary on azurerm 5.1.0 with pinned api_versions and a
documented removal condition; account-level lifecycle guards; every variable
typed, described and validated with no dead entries; the out-of-band custom
role following the standard's bootstrap-split pattern.

**CI supply chain.** Every third-party action across all thirteen workflows is
pinned to a full commit SHA with a version comment, and Trivy was replaced by
a checksum-verified pinned binary after the marketplace compromise. Every
workflow declares an explicit `permissions:` block and nothing defaults to
write-all. No `pull_request_target` anywhere, and all PR-triggered workflows
hold zero cloud credentials by explicit doctrine. No untrusted input reaches a
`run:` string apart from T-756. The "always report the context, filter inside
the job" pattern in `iac-validate.yml` correctly avoids the stuck-"Expected"
trap while keeping infra checks required.

**Frontend correctness gates.** The prerender refuses to publish
error-boundary output, 404-page renders and sub-420-character shells, and
generates the sitemap from routes actually written, so sitemap, canonical and
disk cannot disagree. Canonical and trailing-slash policy is coherent.
Keeping `app-shell.html` distinct from `dist/index.html` correctly avoids
serving home-page content at HTTP 200 for arbitrary URLs. `/preview` isolation
holds on all four mechanisms. CSP carries no `unsafe-inline` in `script-src`
and is guarded by a test tying `connect-src` to the API base. Asset caching
rules are right for hashed-asset delivery. `usePublicData`'s race safety and
prerender seeding are correct.

**Edge probe.** Secret handling is write-only, out-of-band, and loud on
absence; failure semantics are deliberate and all four paths are tested; the
telemetry matches the alert exactly. The two findings against it (T-745,
T-746) are operability, not correctness.

**VPS agent design.** No data-plane credential, server-side capability
authorization, certificate rather than shared secret, argv-array command
construction, and a thorough container sandbox. Its findings are about test
coverage and operations, not the security model.

## Remediation, 2026-08-28

35 of the 62 findings are fixed, one is recorded as **will not fix** with its
reason, and the rest were listed in TODO.md and closed there by 2026-09-05
(see [CHANGELOG.md](../repo/changelog.md)). Each finding above
carries its own status line; this section records what the remediation taught
that the review itself did not know.

**Two findings were wrong, and following them caused harm.**

- **T-750** asked for the function app's CORS origins to be derived from
  `var.domain`. Doing so broke `functions (azure)`: `cors-platform-origins.test.js`
  reads that block as TEXT and compares literal origins against `cors.js`, so an
  interpolation is not a string it can compare — and the comment placed inside
  the block broke its regex outright, which is worse, because the guard then
  passes while checking nothing. Reverted; the literals are load-bearing.
- **T-715** correctly diagnosed a 456 kB chart bundle on every page, then
  prescribed a fix that does not work. rolldown places React's jsx-runtime by
  its own rules, so claiming react in an earlier chunk moved only `scheduler`,
  and removing the manual chart chunk made the critical path worse. What worked
  was splitting the libraries, measured on built output: 868 kB → 571 kB.

**One finding was understated.** T-701 reported that `publish-content`
inherited the wrong role. Verification found that **none of the eight job types
declared a role at all**, which made the fix structural (require it in
`registerJobType`) rather than a one-line patch — and the new validation
immediately caught a ninth registration the review had missed.

**One finding exposed something larger than itself.** T-747 was the lowest-value
item in the review: add `/edge/availability-probe` to Dependabot, "zero impact
today". Adding it made Dependabot re-validate the file, which failed — the
`/infra` terraform entry carried a property unsupported for that ecosystem, and
an unsupported property invalidates the whole file. **No ecosystem had been
receiving dependency updates at all.** Latent because Dependabot re-validates
only on change, and nothing had changed that file since the property was
introduced.

**What the remediation confirmed about method.** The Terraform plan succeeding
with `prevent_destroy` in force is what proves T-706's replication change is an
in-place update rather than a replacement — a green check that means something
specific. Conversely, two CI failures came from changes verified by inspection
rather than execution, so Terraform is now run locally before pushing, and the
backend suite is re-run after infra changes: a test source-scans `main.tf`, so
"infra-only" is not a category that exists here.

## Disposition

The five Critical findings are the natural first work item, and T-704 has a
sequencing constraint: it should land before T-526 is executed, because that
script's `-WhatIf` currently mutates the production Key Vault rather than
simulating.

After those, the three data-durability findings (T-706, T-707, T-708) are the
ones whose cost is unbounded if they are ever exercised, and two of the three
are small changes.

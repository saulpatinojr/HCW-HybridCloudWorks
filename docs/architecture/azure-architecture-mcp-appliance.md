# Azure Architecture MCP Appliance on Azure MCP Server 3.0: architecture analysis and implementation design

**Status:** Proposal for owner decision (2026-10-21). Nothing in this document is provisioned, and no repository named here has been changed by it. It is the analysis the owner asked for before deciding whether to open a new App repository and a new AddOn repository for the Azure Architecture MCP Appliance.
**Baseline:** Azure MCP Server **3.0.0**, git tag `Azure.Mcp.Server-3.0.0`, branch `release/azure/3.x` of `microsoft/mcp`. The newer **4.0.0-beta** line on `main` is noted where it matters and is never substituted.
**Inputs reviewed:** the `microsoft/mcp` source at the pinned tag and branch head; the Microsoft Learn pages for the Azure MCP Server; the three HCW repositories (`HCW-HybridCloudWorks`, `HCW-CloudAssessor_App`, `HCW-CloudAssessor_AddOn`) as the pattern the new pair would follow.
**Reading order:** the 28 sections below are in the order the owner specified. Each probability estimate (section 25) states what is estimated, its assumptions, dependencies, risks, confidence, and the factors that move it.

---

## 1. Executive summary

- **Azure MCP Server 3.0 is a real, pinnable, GA baseline.** It shipped on 2026-10-12 as tag `Azure.Mcp.Server-3.0.0` (commit `61715e6a9054d7922809b01e08a2efa85e032a6d`); the `release/azure/3.x` branch carries five commits past it (changelog edits, an Advisor remediation deserialisation backport and SSRF updates) with no 3.0.1 tag. `main` is already at `4.0.0-beta.2` (2026-10-20). Pin **3.0.0** by package version and the container by **digest**; treat the 3.x branch head as the source of truth for docs, not as a runtime version.
- **Most of what the owner listed exists in 3.0, but four assumptions need correcting.** There is **no generic Azure Resource Graph query tool** (Resource Graph is used internally by `advisor`, `insights` and `optimization`, and `aztfexport query` only generates a command). There is **no Cost Management tool** (`pricing` reads retail prices and `optimization` reads Advisor cost recommendations). The **aztfexport, conftest and azqr tools are local-only**: they are marked `LocalRequired`, they generate commands rather than execute them (except `extension azqr`, which runs a locally installed azqr 3.x), and the server hides them in HTTP mode; the Azure Terraform documentation and Verified Modules lookups, by contrast, work remotely (section 5.3). A remotely hosted Azure MCP cannot export Terraform or run azqr for you. And **sensitive tools are gated by MCP elicitation**: a tool marked `Secret` or `Destructive` is refused when the client cannot ask a human, which this design relies on rather than works around.
- **Identity: OBO is first-class and is the production and lab answer.** `--transport http` plus `--outgoing-auth-strategy UseOnBehalfOf` validates an inbound Entra bearer token (scope `Mcp.Tools.ReadWrite` on the server app registration), then exchanges it with a federated identity credential backed by a user-assigned managed identity. No client secret, no stored user token, per-user RBAC and audit. The exchange is **bound to the inbound token's tenant**, so "select tenant" means "sign in to that tenant"; multi-tenant consent for the server app is a validation spike, not a given.
- **Recommended shape:** Azure MCP stays the source of truth for Azure observations. The **Full Appliance** (new App repository) is the MCP host that calls Azure MCP directly, runs on Container Apps beside a pinned Azure MCP container, and owns the decision, claim, evidence, contradiction, review and governance records. The **AddOn** (new AddOn repository) is a derived, upload-and-ingest edition that never holds an Azure credential and never calls Azure: it normalises evidence handed to it, runs deterministic detectors, and exposes the same MCP tool contract. The **website** owns sign-in, the chat loop, the tenant and subscription pickers, and the views; in the lab path it is the only component that forwards the user's delegated token to Azure MCP, request-scoped and never persisted.
- **Why the website integrates only with the AddOn:** the AddOn's edition boundary (no cloud SDK, refuses to start under identity variables, content-free logs, two-hour expiry) is the strongest tested property the program has. Keeping Azure calls out of the AddOn keeps that property intact and keeps the lab host free of Azure egress. The Full Appliance is the proving ground and the enterprise deployment, not a site dependency.
- **MVP:** decision-to-live drift for zone redundancy, public access, private endpoints, tags and Advisor retirement, fed by uploaded Resource Graph exports and by Azure MCP `advisor`, `pricing`, `policy`, `group` and `subscription` tools under OBO, with ADR drafting from `cloudarchitect design` output. Cost Management, Defender, dependency maps and policy-as-code export are deferred.
- **Probability of a working MVP in the Full Appliance within 10 working weeks for one owner with Claude-assisted sessions: about 0.65.** The dominant risks are OBO tenant consent, time, and the volume of detector fixtures, not Azure MCP capability.

## 2. Goal validation

| Goal as stated | Validation | Notes |
| --- | --- | --- |
| Combine Azure MCP Server 3.0 with a custom Architecture MCP Appliance | Feasible | Azure MCP 3.0 is an MCP server over stdio or HTTP; the appliance is an MCP client to it and an MCP server to the website. No fork of Azure MCP is needed. |
| Evaluate Azure environments through Azure MCP with tenant isolation | Feasible with a constraint | OBO gives per-user RBAC and the token tenant pins the exchange. Isolation across tenants in one deployment depends on a multi-tenant server app registration, which the shipped azd template does not provision (section 8). |
| No Azure credentials stored in the architecture platform | Feasible | Full Appliance: managed identity or OBO, never a secret. AddOn: no credential at all, technically enforced. Website: the delegated token lives in the browser's MSAL cache and is forwarded per request. |
| Azure MCP as source of truth for observations; appliance as source of truth for decisions, claims, evidence, contradictions, reviews, proposals, governance | Feasible | This is the correct split. One refinement: the appliance stores an **evidence record derived from** an Azure MCP result (hash, provenance, redacted payload), not the raw result as truth. The raw result can be re-fetched. |
| Consume Resource Graph, Advisor, Pricing, Cloud Architect, Well-Architected, aztfexport, Terraform, azqr and custom sources into one evidence model | Feasible, with sources split by path | Advisor, Pricing, Policy, Cloud Architect and Well-Architected arrive through Azure MCP. Resource Graph exports, aztfexport output, Terraform state and plan, and azqr reports arrive as **uploaded or pipeline-produced artifacts**, because Azure MCP 3.0 does not execute those tools remotely. |
| Trust model: local, OBO, managed identity, isolated per-session deployments | All four are real options | Section 8 compares them. Isolated per-session deployments are possible (Container Apps dynamic sessions or jobs) but are not needed for the MVP. |
| Three repositories with the stated responsibilities and the default lifecycle Full Appliance → Validation → AddOn → Website | Feasible | The existing `HCW-CloudAssessor_App` and `_AddOn` pair already proves the engine-moves-downstream model (ADR 0001, ADR 0028). The new pair reuses that skeleton. |

**Corrections to the brief, stated once here and applied throughout:**

1. "Azure Resource Graph" is not an Azure MCP 3.0 tool. It is a data source behind other tools and an upload format for the appliance.
2. "Azure Cost Management" is absent from Azure MCP 3.0. The existing `HCW-CloudAssessor_App` already carries a Cost Management collector under managed identity; that is the extension path (section 6).
3. "aztfexport", "conftest validation" and "azqr support" exist only as local-execution tools. In a remote deployment they are hidden and calls are rejected with "requires local execution".
4. "Sensitive action confirmation" exists as MCP elicitation for tools marked `Secret` or `Destructive`. A client that lacks the elicitation capability gets those calls **rejected**, not silently executed, unless the server is started with `--dangerously-disable-elicitation`. Our MCP client must either declare elicitation or stay on read-only, non-secret tools.
5. The "AddOn collects evidence" responsibility is kept, but as **collection runs, ingestion, normalisation and provenance**, not as fetching from Azure. The AddOn never calls Azure (section 11 explains why and what it costs).

## 3. Assumptions

| # | Assumption | Why it is reasonable | What changes if wrong |
| --- | --- | --- | --- |
| A1 | The new App and AddOn repositories follow the `HCW-CloudAssessor_App` / `_AddOn` skeleton: Python 3.14, FastAPI, pydantic, uv workspace, one engine package that moves downstream unchanged, hardened Dockerfile, SHA-pinned workflows. | The owner's brief says the attached repositories are the example; ADR 0002 names one shared skeleton. | A different stack re-opens the engine-package and Docker decisions; nothing in the architecture depends on Python. |
| A2 | The Azure MCP Server is consumed as a **separate process or container**, never linked as a library. | 3.0 is a .NET 10 ahead-of-time-compiled binary with its own release cadence (twice weekly). A library embedding would couple the appliance to that cadence. | None; this is the only sensible option. |
| A3 | The website's chat orchestration runs in the existing Function App (Node 24), which already holds an MCP client over streamable HTTP with OAuth (`functions/src/lib/ai/mcp.js`) and an AI proxy to the Foundry model. | Confirmed in the website repository review (section 4). | If the owner wants the chat loop outside the site, the AddOn would host it and the website contract would grow a message channel. Section 12 records the trade-off. |
| A4 | Users of the lab sign in with a work account in a tenant where they hold at least Reader on the subscriptions they select. | OBO cannot grant permissions a user lacks. | Visitors without Azure use the upload path, which needs no sign-in. |
| A5 | The Azure MCP container image for 3.0.0 is `mcr.microsoft.com/azure-sdk/azure-mcp:3.0.0`. | README and command reference name that registry path; the 3.0.0 changelog prints `mcr.microsoft.com/azure-mcp:3.0.0`, which contradicts them. | Resolve at implementation by `docker manifest inspect` on both names and pin the digest that resolves. The discrepancy is recorded in section 5. |
| A6 | The MCP Python SDK (`mcp` 2.3.0, 2026-10-02) or `fastmcp` (4.1.3, 2026-10-20) will be the appliance's server and client library. | Current releases on PyPI as of 2026-10-21. | Pin at implementation time after a contract test proves streamable HTTP and the 2026-07-28 stateless semantics interoperate with Azure MCP 3.0. |
| A7 | No real tenant, subscription or resource identifiers appear in any repository; samples use `00000000-0000-0000-0000-000000000001` and `hcw-sample-*` names. | Existing rule in both repositories and the website docs gate. | None. |
| A8 | Pull requests in the new repositories open ready for review and follow the template, as both existing repositories require. | Existing working agreements. | None. |

## 4. Repository architecture review

The three attached repositories are the pattern, not the target. This review records what each one gives the new pair and where it falls short of the brief.

### 4.1 Main website (`HCW-HybridCloudWorks`)

**What it already has that the goal needs.**

- Entra sign-in for administrators through MSAL, one SPA registration and one API registration, with server-side token validation (`frontend/src/lib/entraAuth.js`, `functions/src/lib/auth/verify-token.js`, ADR 0006). The lab sign-in reuses the SPA registration and adds a second scope; it does not need a new identity system.
- An MCP client over streamable HTTP with session handling, SSE fallback, OAuth connect and a tool-sync routine (`functions/src/lib/ai/mcp.js`, `mcp-oauth.js`, `mcp-policy.js`), exposed today to super-admins only through the AI Engine page.
- An AI proxy to the provisioned Foundry resource (`infra/foundry.tf`, `functions/src/functions/ai-proxy-http.js`, ADR 0013 and ADR 0034).
- The AddOn pane model: a frozen catalogue row per AddOn, a generic sandboxed pane page, a one-way `hcw-addon` message contract, a status proxy with a one-minute cache, one exact `frame-src` origin per AddOn, and a generic Ansible role on the lab host (ADR 0035, `docs/standards/addon-integration-standard.md`).
- Docs gates that will apply to this document: a redaction gate (no non-placeholder GUIDs, no local paths, no wiki links), a stale-state gate and `mkdocs build --strict`.

**Where it falls short of the brief.**

- The site never sends a message to an AddOn and the pane has no sign-in. A chat experience with tenant and subscription pickers cannot live inside the current pane contract; it needs a site page that talks to the Function App, which talks to the AddOn (section 12).
- `docs/architecture/app-to-addon/cloud-assessment.md` and `TODO.md` still describe the cloud-assessment row as `coming`, while the code has it `available` with a pinned digest. Not a blocker; recorded as drift the next PR in that area should fix.
- The MCP client is admin-only and single-tenant. For the lab it needs a per-request bearer passthrough mode and a tool allow-list per server (section 12).

### 4.2 Example App (`HCW-CloudAssessor_App`)

**What it gives the Full Appliance.**

- A live Resource Graph collector under a user-assigned managed identity with scope allow-listing, paging, throttling retries and a startup refusal of any secret-bearing variable (`src/cloud_assessor_appliance/collectors/resource_graph.py`, `identity.py`, `edition.py`).
- A Cost Management collector (month-to-date by resource group and by `costCenter` tag, budgets, anomaly alerts) with a one-hour cache and graceful `None` on throttling or a missing role (`collectors/cost_management.py`). This is the seed of the cost roadmap in section 6.
- A declarative criteria catalogue with evaluator kinds that are only ever added (`tag-present`, `property-equals`, `property-exists`, `sku-in`, `count-threshold`, `cross-resource`, `cost-evidence`), severity and pillar weights, and the rule that unknown lowers coverage, never score.
- Terraform for the appliance on Container Apps with Reader and Cost Management Reader on each scope.

**Where it falls short of the brief.**

- No decision, claim or contradiction model: findings are criteria results, not drift against a stated decision. The ADR model in section 14 is new work.
- No MCP server and no MCP client; no OBO. The appliance is a REST service with a pane.
- Results are one in-memory snapshot, not an evidence ledger with hashes, provenance and expiry.
- The `NOT-AN-AUDIT.md` text in appliance bundles still says "lab edition" and "uploaded"; a small defect the new engine should not inherit.
- No end-to-end tests; the golden-file equivalent is one sample-expectation test.

### 4.3 Example AddOn (`HCW-CloudAssessor_AddOn`)

**What it gives the new AddOn.**

- The edition boundary as code and as tests: `edition.py` refuses to start under `IDENTITY_ENDPOINT`, `MSI_ENDPOINT`, `AZURE_CLIENT_SECRET`, `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID` or `AZURE_TENANT_ID`, refuses importable `azure`, `msal` or `boto3`, and installs a meta-path finder that blocks them; `tests/security/test_edition_boundary.py` proves it, including that no code or pane references `management.azure.com`, `login.microsoftonline.com` or `graph.microsoft.com`.
- Fail-closed human verification, owner tokens hashed and compared in constant time, exact-origin CORS, the 5 MB / 5,000-row / 200-item / 120-minute limits, a content-free log writer, and the `hcw-addon` pane protocol.
- A Dockerfile that asserts in the build that cloud SDKs cannot be imported, a publish workflow that proves the boundary inside the image, Trivy, SBOM and provenance.
- An upstream-engine update workflow (`core-update.yml`) that opens a bump PR when the App releases: the promotion mechanism the lifecycle requirement asks for already exists.

**Where it falls short of the brief.**

- Upload-only and single-shot: no session, no evidence ledger, no MCP server, no way to receive evidence from the website other than a file upload by the visitor.
- Every `learnUrl` is still `verify: true`; the new catalogue should not ship that debt.

### 4.4 What the review implies for the new pair

1. Reuse the skeleton, the edition boundary and the publish pipeline verbatim. They are the most valuable assets in the program.
2. Add an MCP server to both editions and an MCP client to the Full Appliance only.
3. Replace the single snapshot with an evidence ledger and add the ADR, claim and contradiction models as a new engine package that moves downstream unchanged, exactly as `cloud-assessor-core` does.
4. Add a **trusted-caller** HTTP path to the AddOn so the website's Function App can hand it evidence and user context without the AddOn ever validating an Entra token itself (which would require a `login.microsoftonline.com` dependency the boundary test forbids).

## 5. Azure MCP 3.0 capability matrix

### 5.1 What to pin

| Item | Value | Evidence |
| --- | --- | --- |
| Release | Azure MCP Server **3.0.0**, 2026-10-12 | `servers/Azure.Mcp.Server/CHANGELOG.md` at the tag; `src/Azure.Mcp.Server.csproj` has `<Version>3.0.0</Version>` |
| Git tag | `Azure.Mcp.Server-3.0.0` → commit `61715e6a9054d7922809b01e08a2efa85e032a6d` | `git ls-remote --tags https://github.com/microsoft/mcp.git` on 2026-10-21 |
| Branch | `release/azure/3.x`, head `6369a8a7` ("Update changelog for Azure MCP Server version 3.0.51 for vscode", #3923) | Same listing. Five commits past the tag: changelog, backport #3893 (Advisor remediation deserialisation), SSRF update merge #3920, "set version to 3.0 for GA". No `3.0.1` tag exists. |
| Package versions | NuGet `Azure.Mcp` 3.0.0; npm `@azure/mcp@3.0.0` (confirmed on the npm registry); PyPI `msmcp-azure==3.0.0`; MCP bundles per platform on the GitHub release | 3.0.0 changelog "Getting Started" |
| Container | `mcr.microsoft.com/azure-sdk/azure-mcp:3.0.0`, pinned by digest at implementation | README "Docker" and the command reference name `mcr.microsoft.com/azure-sdk/azure-mcp`; the 3.0.0 changelog prints `mcr.microsoft.com/azure-mcp:3.0.0`. Treat the README path as authoritative and verify both before pinning. |
| Newer majors | `4.0.0-beta.1` (2026-10-19) and `4.0.0-beta.2` (2026-10-20) on `main`; `src/Azure.Mcp.Server.csproj` on `main` reads `4.0.0-beta.2` | Tag listing and `main` changelog. Not substituted. Notable 4.x changes that would tempt substitution: Advisor service-group scope and `--prioritized`, `optimization recommendation list` without `--subscription`. Record them as "revisit on 4.0 GA". |
| Protocol | "Migrated to the MCP 2026-07-28 stateless protocol with automatic backward compatibility for clients using the 2025-11-25 protocol" | 3.0.0 changelog "Key Features" |
| Core libraries | `ModelContextProtocol` 2.2.0, `Microsoft.Identity.Web` 4.6.0, `Microsoft.Security.AntiSSRF` 1.0.0 | `Directory.Packages.props` on the 3.x branch |

### 5.2 Server modes and flags that the design relies on

From `servers/Azure.Mcp.Server/docs/azmcp-commands.md` ("Server Start Command Options") and `core/Microsoft.Mcp.Core/src/Areas/Server/Options/ServerStartOptions.cs`:

| Flag | Values | Design use |
| --- | --- | --- |
| `--transport` | `stdio` (default) or `http` ("supported only in the Docker image distribution and other builds with HTTP enabled") | Local: stdio. Remote: http from the container image. |
| `--mode` | `namespace` (default), `consolidated`, `all`, `single` | `all` with `--namespace` filters, so tool names are stable and allow-listable. |
| `--namespace` / `--tool` | repeatable; `--tool` forces `all` mode | Expose only `advisor`, `pricing`, `policy`, `group`, `subscription`, `wellarchitectedframework`, `cloudarchitect`, `resourcehealth`, `optimization`, `quota`, `role` as needed per deployment. |
| `--read-only` | boolean | Always on. Filters at listing and again at execution (`CommandFactoryToolLoader.cs` lines 70 and 157; `SingleProxyToolLoader.cs` line 742). |
| `--structured-output-mode` | `duplicated` or `compact` | `compact`: concise `content`, full `structuredContent`. Enable only for clients negotiating 2025-06-18 or newer. |
| `--outgoing-auth-strategy` | `NotSet`, `UseHostingEnvironmentIdentity`, `UseOnBehalfOf` | OBO in lab and production; hosting identity for enterprise single-permission deployments. OBO is refused unless `--transport http` without `--dangerously-disable-http-incoming-auth` (`ServerStartCommand.cs` line 297). |
| `--dangerously-disable-elicitation` | boolean | Never set. |
| `--dangerously-disable-ssrf-protections-by-namespace` | namespaces or `ALL` | Never set. |
| `--disable-proxy-tools` | boolean | Set, so no registry-proxied external servers are exposed. |
| `--cloud` | `AzureCloud`, `AzureChinaCloud`, `AzureUSGovernment`, custom authority | Parameterised; default public cloud. |

### 5.3 Capability verification

Legend: **Exists** (verified in source and docs at the pin), **Partial** (exists with a constraint that matters to this design), **Missing**, **Requires extension** (the appliance must supply it). Tool annotation strings are quoted from the command reference, which prints them as `Destructive | Idempotent | OpenWorld | ReadOnly | Secret | LocalRequired`.

| Capability | Status | What 3.0 provides | Constraint for this design | Evidence |
| --- | --- | --- | --- | --- |
| Azure Resource Graph | **Partial / requires extension** | No `resourcegraph` namespace and no raw KQL tool. Resource Graph is used inside `advisor metadata list` ("from Azure Resource Graph", table `advisorresources`), `insights get` ("via Azure Resource Graph + MCP sampling") and the `optimization` tools. `azureterraform aztfexport query` accepts a Resource Graph query but only **generates** an aztfexport command. | The appliance ingests Resource Graph **exports** (upload or pipeline) and, in the Full Appliance, keeps its own Resource Graph collector (the existing App pattern). | Command reference lines 481-576, 3162-3185, 5407-5447; `tools/Azure.Mcp.Tools.Advisor/src/Services/AdvisorService.cs` lines 12-13, 79, 333; `tools/Azure.Mcp.Tools.Insights/src/Services/InsightsService.cs` lines 8-9, 34-35. |
| Azure Advisor | **Exists** | `advisor recommendation list` (filters: category, impact, status, recommendation-type-id, resource-type, resource, search, sub-category, `--tracking-ids`, `--retirement-date <op>:<date>`), `recommendation summary` (group-by including `retirement-date`), `recommendation update` (destructive, not read-only), `metadata list` and `metadata get` (global catalogue, service-retirement metadata by Service Health tracking id), `remediation get` (guidance plus CLI, PowerShell, Bicep, ARM and Terraform artifacts), `recommendation apply` (to ARM and Terraform files; Bicep not supported). | `update` is excluded under `--read-only`. Retirement filters are one-sided ("`le:<end-date>` includes overdue active recommendations and is not a bounded next-N window"). | Command reference lines 481-576; Learn "Advisor MCP tools"; `AdvisorService.cs` line 133 (`Microsoft.Advisor/recommendations` via ARM) and lines 333-334 (`advisorresources` metadata query). |
| Azure Cloud Architect | **Exists** | `cloudarchitect design`: a local, stateless guided-question tool with `--question`, `--question-number`, `--total-questions`, `--answer`, `--next-question-needed`, `--confidence-score`, `--state` (the complete architecture state as JSON: components, tiers, explicit/implicit/assumed requirements, confidence factors). Stops asking at confidence 0.7 or higher. | Does not touch Azure. Output is prose plus a state object; the appliance transforms it into a draft ADR (section 14). | Command reference lines 5581-5603; Learn "Azure MCP Server tools for Azure Cloud Architect". |
| Azure Pricing | **Exists** | `pricing get` against the Azure Retail Prices API (`https://prices.azure.com`, with `.cn` and `.us` variants) with `--sku`, `--service`, `--region`, `--service-family`, `--price-type` (Consumption, Reservation, DevTestConsumption), `--currency`, `--include-savings-plan`, `--filter`. At least one filter required. | Retail list price only. No negotiated price, no actual spend. The appliance labels these estimates "estimated retail cost". | Command reference lines 4159-4186; `tools/Azure.Mcp.Tools.Pricing/src/Services/PricingService.cs` lines 174-176. |
| Azure Well-Architected | **Exists (guidance only)** | `wellarchitectedframework serviceguide get [--service]`: bundled service guides across the five pillars, or the list of supported services. Returns `{ guidance }`. | Reference material, not an assessment of a live estate. The appliance stores it as **Imported** evidence of the declared standard, never as an observation. | Command reference lines 5529-5536; `tools/Azure.Mcp.Tools.WellArchitectedFramework/src/Resources/ServiceGuides`. |
| Azure Terraform | **Exists (local-only, generative)** | `azureterraform azurerm get`, `azapi get`, `avm list/versions/get` (documentation lookups, open-world, not local-required); `aztfexport resource/resourcegroup/query` and `conftest workspace/plan` (**generate commands**, `LocalRequired`). `azureterraformbestpractices get`. | Documentation tools work remotely; export and policy tools do not. Terraform artifacts reach the appliance as uploads or from a pipeline. | Command reference lines 5357-5470. |
| aztfexport | **Partial (command generation, local-only)** | "Returns a command for local execution or installation instructions; does not execute the export or modify Azure resources." | Same as above. The appliance ingests aztfexport output (`.tf` plus `aztfexportResourceMapping.json`) as Imported evidence. | Command reference lines 5407-5445. |
| conftest validation | **Partial (command generation, local-only)** | `conftest workspace` and `conftest plan` build a conftest command against Azure policy sets. | The appliance can run conftest in its own pipeline against uploaded plans; Azure MCP does not run it. | Command reference lines 5447-5465. |
| azqr | **Exists (local-only execution)** | `extension azqr --subscription [--resource-group]`: runs a locally installed Azure Quick Review CLI **3.0.0 or later** and returns XLSX and JSON report paths. `Destructive=false, ReadOnly=true, LocalRequired=true`. Advertised only when a supported azqr is on `PATH` (beta.50, #3503). | Hidden in HTTP mode: `CommandFactoryToolLoader.cs` line 71 filters `LocalRequired` tools when `IsHttpMode`, and line 173 rejects execution. azqr JSON reports are an **upload** format for the appliance. | Command reference lines 4119-4130; `tools/Azure.Mcp.Tools.Extension/src/Commands/AzqrCommand.cs` lines 20-29, 53. |
| Azure Cost Management | **Missing / requires extension** | No `costmanagement`, `consumption` or `budget` tool. `optimization recommendation list/alternatives/explain` reads Advisor cost recommendations and VM SKU alternatives; `pricing get` reads retail prices. | Actual and forecast spend come from the appliance's own Cost Management collector under managed identity (the existing App already has one) or from an uploaded cost export. Section 6 sets the roadmap. | Command reference search for "cost management", "consumption": only `--price-type` matches. |
| Structured outputs | **Exists** | `--structured-output-mode duplicated|compact` emits `outputSchema` and `structuredContent` in every server mode. | Enable for the appliance's MCP client; keep `content` parsing as a fallback for tools without an output schema. | Command reference lines 188-209, 3.0.0 changelog "Structured Output". |
| Remote hosting | **Exists** | `--transport http` from the container image; azd templates for Container Apps with managed identity (Foundry, Copilot Studio) and with OBO; `/health` anonymous; `/.well-known/oauth-protected-resource` metadata; CORS policy; MCP routing-header validation. | Stated as "Remote MCP Server (Preview)" in the 3.0.0 changelog's documentation links; the container entrypoint is fixed (`./server-binary server start`), so flags go through a derived image or environment. | README "Remote Setup"; `azd-templates/README.md`; `ServerStartCommand.cs` lines 525-600; `Dockerfile` ENTRYPOINT. |
| Read-only mode | **Exists** | `--read-only` filters to tools whose metadata says `ReadOnly`, at listing and at call time. | Every deployment in this design runs read-only. `advisor recommendation update`, `workbooks create/update/delete` and all database query tools disappear. | `CommandFactoryToolLoader.cs` lines 70, 157; `RegistryToolLoader.cs` lines 61, 157; `SingleProxyToolLoader.cs` lines 742-760. |
| Sensitive action confirmation | **Exists (elicitation)** | For a tool marked `Secret` or `Destructive`, the server sends an `elicitation/create` request with an Approve/Reject single-select. If the client did not declare elicitation, the call is rejected: "requires user consent, but the client does not support elicitation. Operation rejected for security." | `insights get` is `Secret=true` (it uses MCP sampling), so it needs both elicitation and sampling from the client; it is deferred (section 26). | `core/Microsoft.Mcp.Core/src/Areas/Server/Commands/ToolLoading/BaseToolLoader.cs` lines 247-330. |
| OBO authentication | **Exists** | `--outgoing-auth-strategy UseOnBehalfOf` (the default in authenticated HTTP mode). Inbound: Entra bearer validated by Microsoft.Identity.Web for issuer, audience and the `Mcp.Tools.ReadWrite` scope (delegated) or `Mcp.Tools.ReadWrite.All` role (application). Outbound: `HttpOnBehalfOfTokenCredentialProvider` hands the request's `MicrosoftIdentityTokenCredential` to the Azure SDK. Server credential is a federated identity credential backed by a user-assigned managed identity (azd OBO template). | The provider throws if a requested tenant differs from the token's `tid` claim. Application tokens cannot be exchanged. Namespaces whose downstream API exposes no delegated permission cannot be called under OBO (`communication`, `confidentialledger`, `cosmos`, `acr`, `signalr`, `applicationinsights` profiler, `monitor` health models). Everything this design needs runs on the Azure Resource Manager `user_impersonation` delegated permission. | `docs/Authentication.md` lines 90-180; `HttpOnBehalfOfTokenCredentialProvider.cs` lines 21-55; `azd-templates/api-permissions.md`; `KNOWN-ISSUES.md`. |
| Managed Identity authentication | **Exists** | `--outgoing-auth-strategy UseHostingEnvironmentIdentity` (remote) and the default credential chain locally; `AZURE_TOKEN_CREDENTIALS=prod` restricts the chain to Environment, Azure Pipelines, Workload Identity and Managed Identity; `AZURE_CLIENT_ID` selects a user-assigned identity. | All users share one identity and one audit identity. | `docs/Authentication.md` lines 41-61, 129-162. |

### 5.4 Adjacent 3.0 tools the design uses or watches

| Namespace | Tools used | Why |
| --- | --- | --- |
| `subscription`, `group` | `subscription list [--tenant-id]`, `group list`, `group resource list` | The subscription picker and resource-group inventory. |
| `policy` | `policy assignment list --subscription [--scope]` | Policy evidence (assignments only; definitions and compliance states are not in 3.0). |
| `resourcehealth` | `availability-status get`, `health-events list` | Availability evidence. |
| `quota` | `region availability list`, `usage check` | Capacity assumptions behind SKU claims. |
| `role` | `role assignment list --scope` | Ownership and least-privilege evidence (read). |
| `azurebackup` | `policy get`, `protecteditem get` | Backup and retention evidence in the Full Appliance (Recovery Services and Backup vaults). |
| `insights` | `insights get` | Watched, not used: needs sampling and elicitation. |
| `monitor` | `activitylog list`, Log Analytics queries | Change evidence in the Full Appliance; Log Analytics queries need a workspace and a user with Log Analytics Reader. |
| `extension cli generate` | generates `az` commands from intent | Watched: generates only, never executes; its downstream API needs a first-party permission not relevant here. |

## 6. Gap analysis

| Gap | Severity for the goal | Closing it |
| --- | --- | --- |
| No raw Resource Graph query through Azure MCP | High | **Full Appliance:** own Resource Graph collector (reuse `collectors/resource_graph.py`) under managed identity, with a scope allow-list and paging. **AddOn and lab:** uploaded Resource Graph JSON or CSV export, exactly as today. Also acceptable: the website runs a Resource Graph query **in the browser** with the user's delegated ARM token and hands the result to the AddOn as an upload; this keeps the Function App out of ARM calls but widens the SPA's scopes. Recorded as an option, not the recommendation. |
| No Cost Management through Azure MCP | Medium | Full Appliance keeps a Cost Management collector under managed identity (Cost Management Reader). The AddOn accepts an uploaded cost export (CSV from the portal or a FOCUS-format export). Roadmap in section 14.6. |
| Terraform export, conftest and azqr are local-only | Medium | Treat them as **pipeline tools**: a GitHub Actions workflow in the Full Appliance repository runs `aztfexport`, `conftest` and `azqr` against a lab subscription with workload identity federation and uploads the artifacts to the appliance's ingest endpoint. The AddOn ingests the same artifact formats from a visitor's upload. |
| Elicitation required for `Secret` and `Destructive` tools | Low with read-only | Run read-only and avoid `Secret` tools; implement elicitation in the Full Appliance's MCP client later so `insights get` and future tools can be approved by a human in the website. |
| OBO is bound to the token's tenant | High for "select tenant" | Section 8.5: register the server app as multi-tenant and validate OBO from a second tenant in a spike before promising tenant selection. Until proven, "select tenant" is implemented as "sign in again against the chosen tenant". |
| Diagnostic settings, resource locks, SQL backup retention and Defender state are not in Resource Graph exports and have no 3.0 tool | Medium | Full Appliance collectors over Azure Resource Manager (`Microsoft.Insights/diagnosticSettings`, `Microsoft.Authorization/locks`) under managed identity; AddOn reports **unknown** by design, exactly as the existing engine's `UNKNOWN_BY_DESIGN` list does. |
| No ADR, claim, evidence or contradiction model in any repository | High (it is the product) | New engine package `architecture-core` (section 13 and 14), seeded in the Full Appliance, moved downstream unchanged. |
| No MCP server in either appliance | High | Add one MCP server (streamable HTTP, stateless) to the engine's app layer with the tool catalogue of section 16; expose the same tools in both editions, with Azure-calling tools present only in the Full Appliance. |
| The website pane contract is one-way and anonymous | Medium | Add a site page outside the pane (section 12) rather than widening the pane contract; the pane stays the upload-only visitor path. |

## 7. Recommended architecture

### 7.1 One picture

```text
                 user's browser (site)                         website Function App (Node 24)
 ┌───────────────────────────────────────────┐     ┌──────────────────────────────────────────────┐
 │ MSAL sign-in (existing SPA registration)  │     │ chat orchestrator  (LLM via Foundry proxy)   │
 │ token A: site API audience                │────▶│ validates token A; forwards token B per call │
 │ token B: Azure MCP server app scope       │     │ MCP client #1 → Azure MCP (bearer = token B) │
 │ /tools/architecture-lab page              │◀────│ MCP client #2 → AddOn   (trusted-caller key) │
 └───────────────────────────────────────────┘     └───────────┬───────────────────┬──────────────┘
                                                               │ https, OBO        │ https, allow-listed
                                                               ▼                   ▼
                                     ┌────────────────────────────────┐   ┌──────────────────────────────┐
                                     │ Azure MCP Server 3.0.0 (ACA)   │   │ AddOn (lab host, no Azure)   │
                                     │ --transport http --read-only   │   │ MCP server: evidence_*,      │
                                     │ --outgoing-auth-strategy       │   │ drift_*, adr_*, review_*     │
                                     │   UseOnBehalfOf                │   │ ingest: ARG/azqr/tf uploads  │
                                     │ FIC ← user-assigned MI         │   │ ledger: in-memory, 2 h TTL   │
                                     └───────────────┬────────────────┘   └──────────────────────────────┘
                                                     │ delegated ARM token (user's RBAC)
                                                     ▼
                                              Azure Resource Manager / Advisor / Policy / Retail Prices

 Full Appliance (new App repo, enterprise deployment, proving ground)  — not integrated with the site
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ACA environment: [azure-mcp:3.0.0 by digest, internal ingress] ◀── [appliance: MCP host + server]│
 │ identity: managed identity (hosting) or OBO; collectors: Resource Graph, Cost Management, ARM   │
 │ pipeline jobs: aztfexport, conftest, azqr → ingest; persistent ledger (Cosmos DB or Postgres)   │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Principles

1. **Azure MCP is the only writer of Azure observations in the lab path, and it is read-only.** Every observation the appliance holds carries the Azure MCP tool name, server version, request parameters (redacted), the `structuredContent` hash and the time it was retrieved.
2. **The appliance is the only writer of decisions, claims, evidence records, contradictions, reviews, proposals, approvals and governance records.** Azure MCP results are inputs; the appliance never edits Azure.
3. **No credential is stored by any appliance edition.** Full Appliance: managed identity or OBO through Azure MCP. AddOn: none, enforced by the edition boundary. Website: the browser holds MSAL tokens; the Function App forwards one per request and discards it.
4. **Deterministic first.** Drift verdicts come from typed detectors over normalised evidence. The LLM narrates, drafts and asks; it never decides a verdict.
5. **Unknown lowers coverage, never score.** Carried over from the existing engine and applied to drift: an unobservable property yields `unknown`, not `contradicted`.
6. **Everything that moves downstream moves unchanged.** The engine package (`architecture-core`) is seeded in the Full Appliance, versioned, and adopted by the AddOn through the existing bump-PR workflow.

### 7.3 Components

| Component | Lives in | Role |
| --- | --- | --- |
| `architecture-core` package | Full Appliance repo (moves to AddOn unchanged) | pydantic models (section 13 and 14), normalisers, detectors (section 15), scoring, redaction, report bundle |
| Appliance app (FastAPI + MCP server) | Both repos, edition-gated | HTTP API for the site and pane, MCP server for tool access, session and ledger |
| Azure MCP host (MCP client) | Full Appliance only | Calls Azure MCP over stdio (dev) or HTTP (ACA); maps results to evidence |
| Collectors (Resource Graph, Cost Management, ARM extras) | Full Appliance only | Fill gaps Azure MCP 3.0 does not cover; managed identity |
| Pipeline jobs (aztfexport, conftest, azqr) | Full Appliance repo workflows | Produce artifacts and post them to the ingest endpoint |
| Website lab page and chat orchestrator | Website repo | Sign-in, pickers, chat loop, tool activity, evidence and drift views, approvals |
| Azure MCP Server 3.0.0 | Deployed asset, not a repo | Observations under OBO (lab, production) or managed identity (enterprise) |

## 8. Identity and authentication design

### 8.1 The four models compared

| Model | How it works in 3.0 | Credential at rest in the platform | Per-user RBAC | Audit | Tenant isolation | Operational cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **1. Local Azure MCP** (stdio) | Developer's credential chain (`AZURE_TOKEN_CREDENTIALS=AzureCliCredential` to pin Azure CLI); no inbound auth | None in the platform; the developer's own cache | Yes (the developer) | Developer | Developer's tenant only | Lowest | **Development** |
| **2. OBO-based** (http) | Inbound Entra bearer with `Mcp.Tools.ReadWrite`; server exchanges it with a federated identity credential backed by a user-assigned managed identity | None (no secret; the inbound token is request-scoped) | Yes | Per user | Bound to the token's `tid`; multi-tenant needs a multi-tenant server app and consent (8.5) | Higher setup (two app registrations, consent) | **Labs and production** |
| **3. Managed-identity-based** (http, `UseHostingEnvironmentIdentity`) | Server identity calls Azure; inbound can be delegated or application tokens | None | No, shared | Server identity only | One identity per deployment; isolation by deployment | Lowest for remote | **Enterprise single-permission deployments** of the Full Appliance; also fixtures and CI |
| **4. Isolated user-session deployments** | One Azure MCP container (Container Apps job or dynamic session) per user session, with model 2 or 3 inside | None | Yes if OBO inside | Per session | Strongest (process boundary per user) | Highest (cold start, cost, orchestration) | **Future / high-assurance tier**; not for MVP |

### 8.2 Recommendations

- **Development:** model 1. `azmcp server start --read-only --mode all --namespace advisor --namespace pricing --namespace policy --namespace group --namespace subscription --namespace wellarchitectedframework --namespace cloudarchitect --structured-output-mode compact`, started by the appliance as a child process over stdio, with `AZURE_TOKEN_CREDENTIALS=AzureCliCredential`. Contract tests record `tools/list` and sample `structuredContent` as golden files.
- **Labs:** model 2, read-only, the namespaces above, deployed from a derived image (section 18) on Container Apps. One deployment per environment (lab, production), never one per user. The website SPA is the pre-authorised client of the server app.
- **Production:** model 2 with the same shape, separate app registrations and environment, and the Full Appliance's persistent ledger. Offer model 3 inside a customer's subscription when a customer wants a single service identity (the enterprise package of the Full Appliance), and model 4 as a later high-assurance option.

### 8.3 Token flow in the lab path

```text
browser ──(1) MSAL: token A for the site API──────────────────────▶ Function App
browser ──(2) MSAL: token B, scope <server-app-id>/Mcp.Tools.ReadWrite ──┐
                                                                          │ header X-Azure-Mcp-Token, per request
Function App ──(3) validates A and B (same tid and oid); opens AddOn session with the trusted-caller key,
                   {tid, oid} from A and the selected subscriptionIds
Function App ──(4) MCP call to Azure MCP, Authorization: Bearer B ─────▶ Azure MCP (OBO → ARM, user's RBAC)
Function App ──(5) evidence_ingest(result, provenance) ───────────────▶ AddOn (never sees B)
Function App ──(6) drift_evaluate / adr_* / review_* (model-callable set) ▶ AddOn
browser ◀──(7) streamed chat, tool activity, evidence, drift, proposals
```

Rules:

- **Token B is validated before it is forwarded, and it must belong to the same person as token A.** The Function App checks B's signature and issuer against Entra, its audience (the Azure MCP server app) and its scope (`Mcp.Tools.ReadWrite`), and then requires B's `tid` and `oid` claims to equal A's. A mismatch is refused with 403 and logged as a count, never with the claim values; the authorization tests in section 21 include this case. Without this check a valid B for a different user or tenant would read Azure under that identity while the ledger attributed the evidence to A.
- Token B is never written to a store, a log, a queue or a Cosmos DB document. The Function App's chat session record holds message text, tool activity (tool name, parameter names, result hash, duration, status) and evidence identifiers.
- **The session carries a scope allow-list.** The subscriptions the user selected in step 3 of section 12.2 are stored server-side in the Function App's session and in the AddOn session. Every Azure MCP call's `subscription` argument and every evidence record's subject is checked against that list before the call or the ingest proceeds; the model's tool arguments never widen it.
- Token B is acquired silently by MSAL for the chosen tenant authority. Changing tenant re-acquires B. The Azure MCP OBO provider rejects a mismatch between the requested tenant and the token's `tid`, which the orchestrator relies on as a second guard.
- The AddOn's trusted-caller path requires a key the lab host vault holds (same pattern as the human-verification secret) and accepts `{tenantId, userId, sessionId}` as asserted claims. It never validates Entra tokens and never calls `login.microsoftonline.com`, so the edition boundary test keeps passing.

### 8.4 App registrations

| Registration | Purpose | Key settings |
| --- | --- | --- |
| **Azure MCP server app** (one per environment) | Audience of token B; performs OBO | Expose API scope `Mcp.Tools.ReadWrite`; delegated permission Azure Resource Manager `user_impersonation` (the first-party application id `797f4846-ba00-4fd7-ba43-dac1f8f63013`); federated identity credential issued to the deployment's user-assigned managed identity (audience `api://AzureADTokenExchange`); pre-authorise the site SPA client id; define the application role `Mcp.Tools.ReadWrite.All` (the role Azure MCP requires on application tokens, section 5.3) and assign it to the App edition's user-assigned managed identity for the hosting-identity variant of section 10.2; `signInAudience` single-tenant for the MVP, multi-tenant after the 8.5 spike |
| **Site SPA** (existing) | Acquires A and B | Add `api://<server-app-id>/Mcp.Tools.ReadWrite` as a requested delegated permission; redirect URIs unchanged |
| **Site API** (existing) | Audience of A | Unchanged |
| **Full Appliance server app** (enterprise OBO variant) | Audience for a customer's own clients | Same shape as the Azure MCP server app, owned by the customer tenant |

No client secret exists in any of these. The azd OBO template's Foundry walkthrough creates a client secret for Foundry's OAuth passthrough; that path is not used here.

### 8.5 The tenant question, honestly

The Azure MCP OBO provider exchanges tokens for the tenant in the inbound token's `tid` claim and throws on any other requested tenant (`HttpOnBehalfOfTokenCredentialProvider.cs` lines 35-48). The azd OBO template provisions a single-tenant server app, and the protected-resource metadata advertises one authorisation server (`ServerStartCommand.cs` lines 535-560). Two consequences:

1. "Select tenant" in the lab flow is implemented as **"sign in against the selected tenant"**: MSAL acquires token B from that tenant's authority, and every call in the session uses that B.
2. For users outside the tenant that owns the server app, the server app must be **multi-tenant** and must have been consented to in the user's tenant. Microsoft.Identity.Web supports multi-tenant web APIs when `AzureAd__TenantId` is `organizations` or `common`, but this document has **not verified** that Azure MCP 3.0 accepts that configuration end to end. It is the first spike of the roadmap (section 22), and until it passes, the lab serves users of the HCW tenant and subscriptions they can read there, plus the upload path for everyone else.

### 8.6 What the Full Appliance does differently

The Full Appliance runs in Azure beside its own Azure MCP container. It uses model 3 by default (one user-assigned managed identity with Reader, Cost Management Reader and the Resource Graph permission on the allow-listed scopes) because its collection runs are scheduled, not user-initiated, and because an enterprise customer owns the subscription. It can be switched to model 2 by deploying the OBO variant and pointing its MCP client at a bearer from the customer's client application. Both variants refuse every secret-bearing environment variable at startup, exactly as `identity.py` does today.

## 9. Repository responsibilities matrix

| Responsibility | Website | Full Appliance | AddOn | Note |
| --- | --- | --- | --- | --- |
| Sign-in, tenant and subscription selection | **Owns** | Client-side only in the enterprise package | None (no sign-in in the pane) | ADR 0006 pattern reused |
| Chat loop and LLM access | **Owns** (Foundry proxy) | Optional, for the enterprise package | None | The AddOn exposes tools, not a chat |
| Azure MCP client (OBO, request-scoped) | **Owns in the lab path** | **Owns in Azure** | None, by boundary | The only two Azure MCP callers |
| Collectors beyond Azure MCP (Resource Graph live, Cost Management, ARM extras) | None | **Owns** | None | Managed identity |
| Pipeline artifacts (aztfexport, conftest, azqr) | None | **Owns** (workflows) | Ingests uploads | Local-only tools |
| Engine package `architecture-core` | Consumes contracts | **Seeds and versions** | Adopts unchanged | ADR 0001 model |
| Evidence ledger | Shows | Persistent (Cosmos DB or PostgreSQL) | In-memory, 2 h TTL, 200 items | |
| ADR, claim, contradiction, drift, review, approval records | Shows and approves | **Owns persistently** | Session-scoped | |
| Governance records, policy-as-code export, fitness functions | Shows (later) | **Owns** | Not promoted | Section 17 |
| Deployment: Container Apps, Bicep, Terraform, azd | Site infra only | **Owns** | Image only; lab host Ansible row in the website | |
| Human verification, limits, owner tokens, content-free logs | Status proxy | Appliance equivalents | **Owns** | Existing invariants |
| Documentation and ADRs | Site ADRs and the program pages | Own ADRs (upstream) | Own ADRs plus copies | |

## 10. Full Appliance architecture

### 10.1 Layout (new App repository)

```text
packages/architecture-core/          engine: models, normalise, detectors, score, report, redaction (pydantic only)
src/architecture_appliance/
  app.py                              FastAPI + MCP server mount (streamable HTTP, stateless)
  edition.py                          "appliance": requires managed identity, refuses secret-bearing variables
  mcp_host/                           MCP client to Azure MCP: transport (stdio|http), tool allow-list,
                                      elicitation handler (later), result→evidence mapping, contract pins
  collectors/                         resource_graph.py, cost_management.py, arm_extras.py (locks, diagnostics)
  ledger/                             repository interface; cosmos.py | postgres.py | memory.py
  tools/                              MCP tool implementations (section 16)
  security/                           cors, headers, limits, ratelimit, logging, redaction, trusted_caller
  web/                                operator pane (vanilla), reuses the hcw-addon protocol for the enterprise site
infrastructure/
  azd/ (azure.yaml, infra/*.bicep)    one-command enterprise deployment
  terraform/                          alternative root with the same resources
  docker/                             Dockerfile (stages: deps, appliance, lab proof), versions.env, azure-mcp.Dockerfile
.github/workflows/                    ci, security, publish-core, publish-images, release, pipeline-artifacts
docs/adr/                             ADRs 0001.. (this document's decisions become 0001 to 0006)
```

### 10.2 Runtime

- Two containers in one Container Apps environment: `azure-mcp` (derived image from `mcr.microsoft.com/azure-sdk/azure-mcp:3.0.0` by digest, internal ingress only, flags baked in: `--transport http --read-only --mode all --namespace ... --structured-output-mode compact --disable-proxy-tools --outgoing-auth-strategy UseHostingEnvironmentIdentity` or `UseOnBehalfOf`) and `appliance` (external ingress through Front Door or API Management in production, internal in the lab subscription). This internal `azure-mcp` is the **App edition's companion**, reachable only from the appliance in the same environment.
- **The lab path uses a separate Azure MCP deployment**, the one section 8.2 describes under "Labs": the same derived image with `UseOnBehalfOf`, deployed with **external HTTPS ingress** and Azure MCP's own Entra inbound authentication (optionally behind Front Door), so the website's Function App reaches it over HTTPS with the user's delegated token. The Function App is attached to the site's own virtual network, not to this Container Apps environment, so an internal-only endpoint would be unreachable from it; a private path (VNet integration of the Function App into the environment's network, or private endpoints) is a later hardening step, recorded in section 19 under private networking.
- The appliance's MCP host talks to its companion `azure-mcp` over the environment's internal DNS. With hosting identity, the appliance authenticates to `azure-mcp` with an application token carrying the `Mcp.Tools.ReadWrite.All` role (defined on the server app and assigned to the appliance's managed identity, section 8.4) from its own managed identity. With OBO, it forwards the customer client's delegated token.
- Scheduled collection runs (timer): `subscription list` → `group list` → `advisor recommendation list` and `summary` → `policy assignment list` → `resourcehealth availability-status get` → own Resource Graph query → own Cost Management read → `evidence_ingest` for each result → `drift_evaluate` against open decisions → `review_propose` for every new contradiction or retirement.
- Persistent ledger with append-only evidence and immutable decision versions; Cosmos DB (the site already runs one under managed identity) or PostgreSQL Flexible Server. Partition key `tenantId`, then `workspaceId`.

### 10.3 What stays Full-Appliance-only

Live collectors, pipeline artifact producers, the persistent ledger, governance exports, elicitation-backed tools, sampling-backed tools (`insights get`), multi-subscription and cross-tenant inventory, and any tool that writes to Azure (none in this design; recorded so the rule is explicit).

## 11. AddOn architecture

### 11.1 What the AddOn is

The same engine in a lab edition: an MCP server plus an HTTP API, framed by the site as today for the upload path, and reachable by the site's Function App as a trusted caller for the chat path. It holds a session ledger in memory, expires it after two hours, caps it at 200 items and 5 MB uploads, verifies humans on uploads, isolates owners with hashed tokens, logs nothing visitor-specific, and **cannot reach Azure**.

### 11.2 What changes from the current Cloud Assessor AddOn

| Area | Today | New AddOn |
| --- | --- | --- |
| Inputs | Resource Graph JSON or CSV upload | Resource Graph JSON or CSV, azqr JSON, Terraform state and plan JSON, aztfexport mapping, Advisor and Pricing results **handed in by the site** (`evidence_ingest`) |
| Outputs | Assessment bundle | Evidence list, drift findings, draft ADRs, review proposals, bundle with `NOT-AN-AUDIT.md` |
| Interface | REST plus pane | REST plus pane plus MCP server (`/mcp`, streamable HTTP, stateless) |
| Callers | Visitor's browser (pane) | Visitor's browser (pane, upload path) and the site's Function App (trusted caller, chat path) |
| Identity | None | None. Trusted-caller key from the host vault; `{tenantId, userId, sessionId}` asserted by the site |
| Edition boundary | Enforced | Enforced unchanged; the boundary test additionally asserts the MCP server exposes no Azure-calling tool |

### 11.3 Why the AddOn never calls Azure MCP itself

Routing the user's delegated token through the lab host would (a) put a bearer for Azure Resource Manager scopes on a VPS the program deliberately keeps credential-free, (b) require Azure egress from the lab host, (c) require the AddOn to reference `login.microsoftonline.com` for validation or at least to handle Entra tokens, which the boundary test forbids, and (d) widen every security claim the labels make ("no cloud connectivity by design"). The cost of the chosen design is one extra hop (site → AddOn) for evidence and a trusted-caller key on the host. That is cheaper than weakening the one property the program has proven.

### 11.4 Edition flag

`edition.py` keeps the refusal list and adds a positive assertion: the MCP tool list, computed at startup, contains no tool whose metadata says `callsAzure: true`. The test suite reads the list over the MCP protocol and fails if one appears.

## 12. Website integration architecture

### 12.1 The boundary and why it exists

Stated precisely, the boundary has two halves. For **appliance state** (evidence, decisions, drift, proposals, approvals) the website integrates only with the AddOn, never with the Full Appliance. For **Azure observations in the lab path** the website calls Azure MCP itself, directly, with the signed-in user's delegated token, and hands the results to the AddOn. An implementation therefore needs both integrations: the AddOn as the only appliance it talks to, and Azure MCP as a separate, read-only observation source. The website integrates only with the AddOn, and not with the Full Appliance, because:

- **The site must not become a general Azure caller on behalf of an unbounded public.** The lab path forwards a signed-in user's token to Azure MCP for the duration of a request, within a session's subscription allow-list, and that is the full extent of the site's Azure involvement. The Full Appliance's collectors, ledgers and pipelines are enterprise concerns.
- **The AddOn has the release cadence, limits and labels built for anonymous and lightly authenticated visitors.** The Full Appliance is built for a tenant that owns it.
- **One integration contract.** The site already derives everything from one catalogue row and one standard. Adding a second appliance kind would double the contract surface for no visitor benefit.

Advantages: a stable contract, a tested boundary, visitor-safe limits, no new secrets on the site. Trade-offs: features reach visitors only after promotion; the AddOn cannot run scheduled collections or persist across sessions; evidence that only live collectors can produce (locks, diagnostics, spend) stays unknown in the lab. Future expansion: a signed-in "bring your own appliance" mode where an enterprise Full Appliance registers itself as a catalogue row for that tenant's users, under the same pane and status contracts, without the site ever integrating the Full Appliance generically.

### 12.2 The lab page

Route `/tools/architecture-lab` (new catalogue row `architecture-lab`, status `coming` until the AddOn ships). It is a site page, not a framed pane, because it needs sign-in and the chat loop:

1. **Sign in** with the existing MSAL flow; the page requests token A and, after tenant choice, token B.
2. **Select tenant**: a list of tenants from the user's profile (MSAL account `tenantProfiles`) or a typed tenant id; selection re-acquires B against that authority (section 8.5).
3. **Select subscription**: `subscription list` through Azure MCP with B; the page shows `subscriptionId`, `displayName`, `state`.
4. **Connect to the AddOn**: the Function App opens an AddOn session (`POST /api/sessions` with the trusted-caller key and `{tenantId, userId, subscriptionIds}`, the subscriptions chosen in step 3), receives a session id and an expiry (two hours). The subscription allow-list is kept server-side on both sides and bounds every later call (section 8.3 rules); changing the selection re-opens the session.
5. **Ask architecture questions**: the chat orchestrator runs the LLM with two tool sets: Azure MCP (read-only allow-list, every `subscription` argument checked against the session's list) and the AddOn's **model-callable** tools only: `evidence_ingest`, `evidence_list`, `evidence_get`, `drift_evaluate`, `drift_list`, `contradiction_list`, `adr_create` (drafts only), `adr_get`, `adr_list`, `claim_list`, `review_propose`, `review_list`, `review_get`, `cost_estimate_attach`. The human-only tools (`adr_update`, `adr_supersede`, `review_decide`, and any status change to `accepted`) are not in the model's tool set at all; the site's approval route calls them with the user's own token A (section 16, caller classes).
6. **View tool activity**: every tool call is streamed as `{tool, server, parameterNames, status, durationMs, resultHash, evidenceId}`; no parameter values and no raw results.
7. **View evidence**: a table from `evidence_list` with class, source, retrieved time, expiry, confidence and a redacted summary.
8. **View drift**: `drift_list` grouped by decision, with verdict, the claim, the observed value, and the evidence ids.
9. **Approve review proposals**: the page's approve and reject buttons call the site's `POST /api/lab/reviews/{id}/decision` route, which calls `review_decide` with `approve` or `reject` and a comment; the approval record carries the user's object id from token A, not a name. The model cannot reach this step.
10. **Disconnect**: `DELETE /api/sessions/{id}` on the AddOn, MSAL cache cleared for B, the chat transcript kept only if the user chooses to download it.

### 12.3 Contracts added to the site

| Contract | Shape |
| --- | --- |
| Catalogue row | `{ id: 'architecture-lab', origin, panePath: null, healthPath: '/api/health', status, capabilities: ['chat'] }`; `chat` renders the lab page instead of a pane |
| Function App routes | `POST /api/lab/sessions` (body `{tenantId, subscriptionIds}`), `POST /api/lab/chat` (streamed), `GET /api/lab/evidence`, `GET /api/lab/drift`, `POST /api/lab/reviews/{id}/decision` (the only path to `review_decide`), `DELETE /api/lab/sessions/{id}`; all require token A; chat and evidence routes require header `X-Azure-Mcp-Token` carrying B, validated and bound to A as section 8.3 says |
| Status proxy | unchanged, six fields |
| MCP client changes | per-request bearer passthrough; tool allow-list per server from configuration; elicitation declared as unsupported (so `Secret` and `Destructive` tools are rejected by Azure MCP, which is the intended outcome) |
| App settings | `ADDON_ARCHITECTURE_LAB_URL`, `AZMCP_LAB_URL`, `AZMCP_LAB_SERVER_APP_ID`, `LAB_ADDON_TRUSTED_CALLER_KEY` (Key Vault reference) |
| CSP | `connect-src` unchanged (the browser never calls Azure MCP or the AddOn directly on this page) |

## 13. Evidence model

### 13.1 Classes

| Class | Meaning | Typical source | Default confidence | Default expiry |
| --- | --- | --- | --- | --- |
| **Declared** | What a decision, claim or standard says should be true | ADR text, catalogue criteria, Well-Architected service guide | 1.0 (it is a statement, not a fact) | None |
| **Observed** | What Azure reported at a point in time | Azure MCP tool result under OBO or managed identity; live Resource Graph collector | 0.95 | 24 h (lab: session) |
| **Imported** | What an artifact produced elsewhere says | Uploaded Resource Graph export, azqr JSON, Terraform state or plan, aztfexport mapping, cost export | 0.80 (unauthenticated upload), 0.90 (pipeline with provenance) | 7 days (lab: session) |
| **Derived** | A deterministic transformation of other evidence | Normalised resource, aggregated count, cost estimate from pricing rows | min of inputs | min of inputs |
| **Inferred** | A model-produced reading of evidence | LLM summary, Cloud Architect answers | 0.50, capped at 0.74 | 24 h |
| **Proposed** | A change someone or something suggests | Review proposal, Advisor remediation package, migration consideration | n/a | until decided |

Rules: a verdict of `contradicted` or `supported` requires at least one **Observed** or **Imported** evidence record; **Inferred** evidence can raise a question but never a verdict; confidence of anything unauthenticated is capped at 0.74, carried over from ADR 0011.

### 13.2 Record

```json
{
  "evidenceId": "ev_01JB...",                  // ULID
  "class": "observed",
  "kind": "azure-mcp-result",                  // azure-mcp-result | arg-export | azqr-report | tf-state | tf-plan | aztfexport-mapping | cost-export | waf-guide | cloud-architect-state | custom
  "schemaVersion": "1.0",
  "subject": { "scope": "subscription", "subscriptionId": "00000000-0000-0000-0000-000000000001", "resourceIds": ["/subscriptions/.../hcw-sample-sql-01"] },
  "payload": { "...": "redacted, normalised content; the raw input is hashed in memory and discarded, never stored" },
  "payloadHash": "sha256:...",                 // of the canonical JSON of the raw payload, taken in memory before redaction
  "redaction": { "rules": ["secrets", "connection-strings", "guid-placeholders"], "removedCount": 3 },
  "provenance": { "...": "SourceProvenance, section 14.1" },
  "confidence": 0.95,
  "retrievedAt": "2026-10-21T14:03:00Z",
  "expiresAt": "2026-10-22T14:03:00Z",
  "collectionRunId": "run_01JB...",
  "correlations": [{ "type": "resource", "value": "/subscriptions/.../hcw-sample-sql-01" }, { "type": "recommendationTypeId", "value": "00000000-0000-0000-0000-000000000002" }]
}
```

### 13.3 Ingestion pipeline (deterministic, same in both editions)

1. **Validate**: size and row limits; content type; a schema check per `kind` (a Resource Graph export is a JSON array of rows, the `az graph query` envelope the AddOn's frozen upload contract already accepts (`{"count": n, "data": [...]}` or `{"data": [...]}`, see the program's final package, section "AddOn-side HTTP contract"), or CSV, with `id`, `type`, `location`, `properties` per row; azqr JSON must carry its `version` and `recommendations`; Terraform plan must be `format_version` 1.x with `resource_changes`; state must have `version` 4). No existing upload format is dropped.
2. **Hash**: canonical JSON (sorted keys, no whitespace) → SHA-256 → `payloadHash`, computed in memory over the raw input, which is then discarded; only the redacted form of step 3 is ever stored, in either edition. Duplicates within a session are linked, not stored twice.
3. **Redact**: remove values matching secret patterns (keys, connection strings, SAS tokens), replace GUIDs in public outputs with placeholders, drop tag values on an allow-list-fail (tags are user text; see prompt injection in section 19).
4. **Parse and normalise** into the common resource shape `{ id, type, name, location, zones, sku, identity, tags, properties, derived: { zoneRedundant, publicNetworkAccess, privateEndpointCount, cmk, ... } }` using one normaliser per `kind`. Terraform resources map through a provider-type table (`azurerm_mssql_database` → `microsoft.sql/servers/databases`).
5. **Correlate**: by ARM resource id (case-folded), by recommendation type id, by Service Health tracking id, by Terraform address, by tag `owner`/`costCenter`.
6. **Assign confidence and expiry** by class and source.
7. **Record provenance** and append to the ledger inside a `CollectionRun`.

### 13.4 Provenance

`SourceProvenance` carries: `sourceType` (`azure-mcp`, `upload`, `pipeline`, `collector`, `llm`), `tool` (for example `advisor_recommendation_list`), `serverName` and `serverVersion` from the MCP `initialize` result (expected `Azure MCP Server` 3.0.0), `protocolVersion`, `parametersRedacted` (names and hashed values), `identityMode` (`obo`, `managed-identity`, `none`), `actorId` (object id hash), `artifactName` and `artifactHash` for uploads, `workflowRunId` for pipeline artifacts.

## 14. ADR model

### 14.1 Schemas

```text
DecisionRecord
  decisionId, version, status (draft|proposed|accepted|superseded|deprecated|rejected)
  title, context, decisionDrivers[], decision, consequences[], openQuestions[]
  constraints[], assumptions[], risks[]
  alternatives[] → Alternative
  claims[] → Claim
  scope { tenantId?, subscriptionIds[], resourceGroupNames[], tagSelectors[] }
  evidenceRequirements[] { claimId, requiredClasses[], maxAgeHours }
  cost { chosenAlternativeId, estimates[] → CostEstimate }
  supersedes[], supersededBy?, relatedDecisions[]
  provenance → SourceProvenance (cloud-architect | human | import)
  createdBy (oid hash), createdAt, acceptedBy?, acceptedAt?

Alternative
  alternativeId, title, description, pros[], cons[], costEstimates[] → CostEstimate, selected (bool), rejectionReason?

Claim
  claimId, decisionId, statement (human text), detectorId, parameters {}
  selector { resourceTypes[], tagSelectors[], nameGlobs[], subscriptionIds[] }
  severity (critical|high|medium|low), required (bool)
  expectation { property, operator, value }          // deterministic, mirrors the detector contract

Evidence (section 13.2)

Contradiction
  contradictionId, claimId, decisionId, evidenceIds[], observed {}, expected {}
  verdict (contradicted), firstSeenAt, lastSeenAt, resolvedAt?, resolution (fixed|decision-changed|accepted-risk|false-positive)?

DriftFinding
  findingId, claimId, decisionId, resourceId?, verdict (supported|contradicted|unknown|not-applicable)
  observed {}, expected {}, evidenceIds[], confidence, unknownReason?, detectorVersion, evaluatedAt

CollectionRun
  runId, startedAt, finishedAt, trigger (scheduled|manual|session), identityMode, scope
  sources[] { sourceType, tool?, status, itemCount, evidenceIds[] }, errors[] (content-free), summary { observed, imported, unknown }

ReviewProposal
  proposalId, kind (retirement|contradiction|advisor|cost|expiry|supersession)
  decisionId?, claimIds[], evidenceIds[], impactedResourceIds[]
  title, rationale, migrationConsiderations[], recommendedActions[] { action, source (advisor-remediation|catalog|llm), effort?, destructive? }
  dueBy?, status (open|approved|rejected|expired), createdAt

Approval
  approvalId, proposalId, decision (approve|reject), comment, actorId (oid hash), actorRole, at, evidenceSnapshotHash

SourceProvenance (section 13.4)
```

### 14.2 From Cloud Architect output to a draft ADR

`cloudarchitect design` returns prose and a `state` JSON that tracks components, tiers (infrastructure, platform, application, data, security, operations), requirements (explicit, implicit, assumed) and confidence factors. The transformation `adr.draft_from_cloud_architect` is deterministic over the state and uses the LLM only to phrase prose:

| ADR field | Source |
| --- | --- |
| Context | the explicit requirements and the initial question |
| Constraints | explicit requirements tagged as limits (region, compliance, budget) |
| Assumptions | the `assumed` requirements, each marked as needing confirmation |
| Alternatives | component options the state records per tier; the recommended set is `selected` |
| Claims | one per recommended component property that a detector can check (for example "zone-redundant database" → `zone-redundancy` detector on `microsoft.sql/servers/databases`) |
| Risks | the confidence factors below 0.7 and every assumption |
| Consequences | prose from the recommendation, labelled Inferred |
| Open questions | questions the tool would have asked next, if `nextQuestionNeeded` was true when the session ended |
| Evidence requirements | one per claim: Observed or Imported, max age 24 h |

The draft is `status: draft`, provenance `cloud-architect`, confidence capped at 0.74 until a human accepts it.

### 14.3 Retirement-based reviews

1. `advisor recommendation list --sub-category ServiceUpgradeAndRetirement --retirement-date le:<today+180d>` and `advisor metadata list --sub-category ServiceUpgradeAndRetirement` are ingested as Observed evidence; the metadata gives the recommendation type, the Service Health tracking id and the retirement date.
2. Each record is correlated to resources (`properties.resourceMetadata.resourceId` or `impactedField`) and to decisions whose scope or claims cover those resources or resource types.
3. For each correlated decision, or for each impacted resource with no decision, `review_propose(kind=retirement)` creates a proposal with: impacted resources, the retirement date, the Advisor description, `advisor remediation get` output as recommended actions (marked `destructive` as Advisor reports), and migration considerations assembled by rule (same-SKU replacement available in `optimization recommendation alternatives`, region pairs, data migration needed).
4. The LLM may phrase the rationale; the proposal's facts come from evidence ids only.

### 14.4 Advisor contradiction

A decision claim "no high-impact Advisor reliability findings on production" (`advisor-findings` detector) is contradicted when `advisor recommendation list --category HighAvailability --impact High --status New` returns a record whose resource is in scope. Dismissed and postponed records are not contradictions; they produce an `accepted-risk` note with the Advisor dismiss reason.

### 14.5 Cost-aware decisions

Each `Alternative` carries `CostEstimate[]` with `basis`:

| Basis | Source | Label |
| --- | --- | --- |
| `estimated-retail` | `pricing get` rows × declared quantities × hours | "Estimated retail cost" |
| `estimated-effective` | retail × a declared discount or reservation assumption (Declared evidence) | "Estimated effective cost" |
| `actual` | Cost Management actuals (Full Appliance collector or uploaded export) | "Actual spend" |
| `forecast` | Cost Management forecast (future) | "Forecast spend" |

A claim "monthly estimated retail cost of the chosen alternative ≤ ceiling" is checkable in the lab; "actual spend ≤ ceiling" is checkable only where actuals exist, else `unknown`.

### 14.6 Cost Management integration roadmap

| Step | Where | What | Depends on |
| --- | --- | --- | --- |
| C0 (MVP) | Both | `pricing get` estimates per alternative; `optimization recommendation list` findings as evidence | Azure MCP 3.0 |
| C1 | Full Appliance | Cost Management actuals by resource group and tag under managed identity (reuse the existing collector); evidence kind `cost-actual` | Cost Management Reader |
| C2 | AddOn | Uploaded cost export (portal CSV or FOCUS 1.x) parsed to `cost-actual` Imported evidence | Normaliser only |
| C3 | Full Appliance | Forecast and budgets; `cost-ceiling` detector gains `forecast` basis | Cost Management forecast API |
| C4 | Watch | If a later Azure MCP major adds Cost Management tools, replace C1 reads with Azure MCP results under OBO; not assumed for 3.0 | Azure MCP roadmap |

## 15. Detector catalogue

Every detector is a pure function `detect(claim, evidence[]) → DriftFinding[]` over normalised resources, versioned, with golden fixtures. Operators: `eq`, `neq`, `in`, `gte`, `lte`, `exists`, `absent`, `subset`, `all`, `any`. Verdict rules: predicate true → `supported`; predicate false on Observed or Imported evidence → `contradicted`; property not present and not derivable → `unknown` with a reason; resource outside the selector → `not-applicable`. Required evidence age is enforced before evaluation; stale evidence → `unknown (expired)`.

| Detector id | Claim example | Resource types (first wave) | Property and logic | Evidence source | Determinism |
| --- | --- | --- | --- | --- | --- |
| `zone-redundancy` | "Production data platform must be zone redundant" | `microsoft.sql/servers/databases` (`properties.zoneRedundant == true`), `microsoft.storage/storageaccounts` (`sku.name` ends with `ZRS`, `GZRS`, `RAGZRS`), `microsoft.documentdb/databaseaccounts` (`properties.locations[].isZoneRedundant` all true), `microsoft.dbforpostgresql/flexibleservers` (`properties.highAvailability.mode == ZoneRedundant`), `microsoft.web/serverfarms` (`properties.zoneRedundant`), `microsoft.containerservice/managedclusters` (every `agentPoolProfiles[].availabilityZones` has ≥ 2), `microsoft.compute/virtualmachinescalesets` (`zones` length ≥ 2), `microsoft.network/publicipaddresses` (`zones` length ≥ 2). `microsoft.compute/virtualmachines`: a single VM row can show that the VM is zonal (`zones` non-empty) but never that anything is zone *redundant*, because redundancy is a property of the instance set; the detector answers `unknown` with that reason unless the claim's `instanceSet` parameter names a tag key, in which case the VMs sharing that tag value form the set and the set is supported only when its members span ≥ 2 distinct zones (Derived evidence). A set in one zone is contradicted. | ARG export, `group resource list` | Full |
| `region-allowed` | "Only `centralus` and `eastus2`" | all | `location in allowedRegions` | ARG export | Full |
| `paired-region-dr` | "Secondary in the paired region" | storage (`properties.secondaryLocation`), SQL failover groups, Cosmos DB `locations` | secondary location equals the pair of primary; the region-pair table is Declared evidence shipped with the catalogue, dated | ARG export | Full |
| `public-access-disabled` | "No public network access on data services" | storage, SQL servers, Key Vault, Cosmos DB, PostgreSQL, Container Registry, Service Bus, Event Hubs | `properties.publicNetworkAccess == Disabled` (type-specific aliases normalised) | ARG export | Full |
| `private-endpoint-present` | "Every data service has a private endpoint" | as above | `derived.privateEndpointCount >= 1` from `properties.privateEndpointConnections` or joined `microsoft.network/privateendpoints` rows | ARG export | Full |
| `encryption-at-rest` | "Encryption at rest enabled" | storage, disks, SQL | `properties.encryption.services.*.enabled`, `properties.encryption.type`, TDE state where present | ARG export | Full; TDE needs sub-resource rows, else `unknown` |
| `cmk` | "Customer-managed keys for storage and Key Vault-backed services" | storage (`properties.encryption.keySource == Microsoft.Keyvault`), Cosmos DB (`properties.keyVaultKeyUri` exists), disks (`properties.encryption.type` CMK variants) | ARG export | Full |
| `diagnostics-enabled` | "Diagnostic settings send logs to the workspace" | all with logs | `Microsoft.Insights/diagnosticSettings` rows per resource | Full Appliance ARM collector; AddOn `unknown` by design | Full where collected |
| `backup-protected` | "Production VMs and file shares are backed up" | VMs, file shares, SQL | `azurebackup protecteditem get` results or `recoveryservicesresources` rows in an ARG export that includes that table | Azure MCP (Full), ARG export with the table | Full |
| `retention-minimum` | "Logs retained ≥ 90 days" | Log Analytics workspaces (`properties.retentionInDays`), backup policies (`azurebackup policy get` retention) | `gte` | ARG export, Azure MCP | Full |
| `lock-present` | "Production resource groups carry a CanNotDelete lock" | resource groups | `Microsoft.Authorization/locks` rows | Full Appliance ARM collector; AddOn `unknown` | Full where collected |
| `managed-identity` | "Compute resources carry a managed identity" | VMs, web apps, function apps, Container Apps | `identity.type in (SystemAssigned, UserAssigned, SystemAssigned,UserAssigned)`. Presence only: a resource can carry a managed identity and still hold a connection string in its settings, so this detector never asserts "no secrets". A "no secrets in configuration" claim needs a separate, source-specific detector over application settings, which a Resource Graph export does not carry (wave two, Full Appliance collector) | ARG export | Full |
| `availability-set-or-zones` | "VMs in zones or availability sets" | VMs | `zones` non-empty or `properties.availabilitySet.id` exists | ARG export | Full |
| `sku-allowed` | "App Service plans Premium v3 or above" | any with `sku` | `sku.tier in allowed` or `sku.name in allowed` | ARG export | Full |
| `cost-ceiling` | "Estimated retail cost ≤ 1,500 USD per month" | decision level | sum of `CostEstimate(basis=estimated-retail)` of the selected alternative `lte` ceiling; `actual` basis when present | `pricing get`, cost export | Full for estimates |
| `tag-required` | "Every resource has `owner` and `costCenter`" | all | `tags[key]` exists and matches a pattern | ARG export | Full |
| `ownership-known` | "Owner tag resolves to a known team" | all | `tags.owner in Declared team list` | ARG export plus Declared list | Full |
| `advisor-findings` | "No high-impact reliability recommendations open" | subscription | count of `advisor recommendation list` rows with the claim's filters, in scope, `status == New` equals 0 | Azure MCP | Full |
| `retirement-exposure` | "No resource depends on a service retiring within 180 days" | subscription | `advisor recommendation list --sub-category ServiceUpgradeAndRetirement --retirement-date le:<date>` rows in scope equals 0 | Azure MCP | Full |
| `policy-assignment-present` | "The baseline initiative is assigned at the subscription" | subscription | `policy assignment list` contains the declared definition id at the scope | Azure MCP | Full |
| `terraform-plan-no-destroy` | "No destroy of protected resources in the next plan" | Terraform plan | `resource_changes[].change.actions` contains no `delete` for selected addresses | Imported plan | Full |
| `terraform-state-matches-live` | "State and live agree on zone redundancy" | Terraform state plus ARG export | property equality after normalisation | Imported both | Full; drift between them is its own finding kind |
| `azqr-no-high` | "azqr reports no high-impact failures in scope" | azqr JSON | count of `impact == High and result == Fail` in scope equals 0 | Imported report | Full |

Zone-redundancy worked example (the acceptance scenario of section 21): decision D-0001 claim C-1 `zone-redundancy` with selector `{ resourceTypes: [microsoft.sql/servers/databases], tagSelectors: { env: prod } }`; an uploaded Resource Graph export row for `hcw-sample-sql-01` with `tags.env = prod` and `properties.zoneRedundant = false`; the detector emits `DriftFinding(verdict=contradicted, observed={zoneRedundant:false}, expected={zoneRedundant:true})` and the engine records a `Contradiction` and a `ReviewProposal(kind=contradiction)`.

## 16. MCP tool catalogue (appliance)

Names use the `namespace_action` style Azure MCP uses in `all` mode so the website's allow-list treats both servers alike. Annotations follow the MCP tool annotation hints. `Edition` says where the tool exists.

| Tool | Annotations | Edition | Purpose |
| --- | --- | --- | --- |
| `session_open`, `session_close` | readOnly: false, destructive: false | Both (HTTP path for the site; MCP in Full) | Open and close a ledger session for `{tenantId, userId}` |
| `evidence_ingest` | readOnly: false, idempotent: true (hash-keyed) | Both | Validate, hash, redact, normalise and store an artifact or an Azure MCP result with provenance |
| `evidence_list`, `evidence_get` | readOnly: true | Both | Browse the ledger (redacted payloads) |
| `evidence_verify` | readOnly: true | Both | Recompute a hash and report tampering or expiry |
| `evidence_expire_review` | readOnly: true | Both | List evidence past or near expiry per decision |
| `collection_run_start`, `collection_run_finish` | readOnly: false | Both | Bracket an ingestion batch |
| `collection_run_azure` | readOnly: false (it writes evidence, findings and proposals to the ledger); destructive: false; `callsAzure: true`, and every Azure call it makes is read-only | **Full only** | Drive the Azure MCP host through the standard tool sequence and ingest each result |
| `adr_create`, `adr_get`, `adr_list`, `adr_update` (new version) | readOnly per verb | Both | Decision records |
| `adr_draft_from_cloud_architect` | readOnly: false | Both (input is the Cloud Architect state the site passes in) | Section 14.2 |
| `adr_supersede` | readOnly: false | Both | Link a new decision to the old one and flip statuses |
| `claim_add`, `claim_list` | per verb | Both | Claims with detector bindings |
| `drift_evaluate` | readOnly: false (writes findings) | Both | Run every detector for a decision or scope against current evidence |
| `drift_list`, `contradiction_list` | readOnly: true | Both | Findings and open contradictions |
| `review_propose`, `review_list`, `review_get` | per verb | Both | Proposals (retirement, contradiction, advisor, cost, expiry, supersession) |
| `review_decide` | readOnly: false | Both | Approve or reject with an actor id hash; writes `Approval` |
| `cost_estimate_attach` | readOnly: false | Both | Attach `pricing get` rows and quantities to an alternative |
| `report_bundle` | readOnly: true | Both | `report.md`, `report.json`, `findings.csv`, `adr/*.md`, `NOT-AN-AUDIT.md` |
| `governance_export_policy` | readOnly: true | **Full only** | Policy-as-code export of claims (Azure Policy JSON and conftest Rego) |
| `inventory_cross_subscription` | readOnly: true; `callsAzure: true` | **Full only** | Scheduled multi-subscription inventory through the collector |

Every tool returns `structuredContent` with a versioned schema and a concise `content` text, mirroring Azure MCP's `compact` mode so the website renders both servers the same way.

**Caller classes.** Each tool also carries `meta.caller`, with two values, and the website's orchestrator enforces it:

- `model`: tools the chat model may call. Reads, drafts and proposals: `evidence_ingest`, `evidence_list`, `evidence_get`, `evidence_verify`, `evidence_expire_review`, `collection_run_start`, `collection_run_finish`, `adr_create` (which always creates a `draft`), `adr_draft_from_cloud_architect`, `adr_get`, `adr_list`, `claim_add` (on drafts only), `claim_list`, `drift_evaluate`, `drift_list`, `contradiction_list`, `review_propose`, `review_list`, `review_get`, `cost_estimate_attach`, `report_bundle`.
- `human`: tools that change an authoritative record and need a person's explicit action: `adr_update`, `adr_supersede`, any status change to `accepted`, `review_decide`, `session_open`, `session_close`, and the Full-only `collection_run_azure`, `governance_export_policy` and `inventory_cross_subscription` (operator or scheduler, never the model). The website exposes them only through its own authenticated routes (section 12.3), with the user's token A; they are absent from the model's tool list, so an injected instruction cannot reach them.

## 17. Capability classification and promotion matrix

### 17.1 Classification

Scales: business value and MVP suitability **H/M/L**; implementation and operational complexity **1 (low) to 5 (high)**; security impact **L/M/H** (how much a defect would matter). Deployment suitability names the editions where the capability can run.

| Capability | Classification | Value | Impl. | Ops | Security | MVP | Deployable in |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Evidence ledger with hashing, redaction, provenance, expiry | Shared | H | 3 | 2 | H | H | Full, AddOn |
| Resource Graph export ingestion (JSON, CSV) | Shared | H | 2 | 1 | M | H | Full, AddOn |
| Azure MCP result ingestion (`evidence_ingest` kind `azure-mcp-result`) | Shared | H | 2 | 1 | M | H | Full, AddOn (handed in by the site) |
| Azure MCP host (MCP client, OBO or MI) | Full Appliance only (site has its own) | H | 3 | 3 | H | H | Full |
| Live Resource Graph collector | Full Appliance only | H | 2 | 2 | H | M | Full |
| Cost Management collector | Full Appliance only | M | 3 | 2 | M | L | Full |
| ARM extras collector (locks, diagnostics) | Full Appliance only | M | 2 | 2 | M | L | Full |
| ADR, claim, alternative, contradiction, proposal, approval models | Shared | H | 3 | 1 | M | H | Full, AddOn |
| Deterministic detectors (first wave, section 15) | Shared | H | 3 | 1 | M | H | Full, AddOn |
| Drift evaluation and contradiction records | Shared | H | 2 | 1 | M | H | Full, AddOn |
| Retirement review generation | Shared | H | 2 | 1 | L | H | Full, AddOn (evidence handed in) |
| Advisor contradiction | Shared | M | 1 | 1 | L | H | Full, AddOn |
| Cloud Architect to draft ADR | Shared | M | 2 | 1 | L | M | Full, AddOn |
| Cost estimates from retail pricing | Shared | M | 2 | 1 | L | M | Full, AddOn |
| Actual and forecast spend | Full Appliance only (AddOn: upload) | M | 3 | 2 | M | L | Full (AddOn upload later) |
| aztfexport, Terraform state and plan ingestion | Shared | M | 3 | 1 | M | M | Full, AddOn |
| conftest and azqr pipeline execution | Full Appliance only | M | 2 | 2 | M | L | Full (workflows) |
| azqr report ingestion | Shared | M | 2 | 1 | L | M | Full, AddOn |
| Well-Architected guide as Declared evidence | Shared | L | 1 | 1 | L | M | Full, AddOn |
| MCP server surface (section 16) | Shared | H | 3 | 2 | H | H | Full, AddOn |
| Persistent ledger (Cosmos DB or PostgreSQL) | Full Appliance only | H | 3 | 3 | H | M | Full |
| Scheduled collection runs | Full Appliance only | H | 2 | 2 | M | M | Full |
| Elicitation-backed tools and `insights get` | Full Appliance only, future | M | 3 | 2 | M | L | Full |
| Policy-as-code export | Full Appliance only | M | 3 | 1 | M | L | Full |
| Cross-subscription inventory | Full Appliance only | M | 2 | 2 | M | L | Full |
| Lab page: sign-in, pickers, chat, tool activity, views, approvals | Website only | H | 4 | 2 | H | H | Website |
| Trusted-caller session API | Shared contract; AddOn implementation | H | 2 | 1 | H | H | AddOn (Full for the enterprise site) |
| Operator pane (upload path) | Shared | M | 2 | 1 | M | H | Full, AddOn |
| Per-session isolated Azure MCP deployments | Future enhancement | M | 4 | 5 | H | L | Full |
| Bring-your-own-appliance catalogue row | Future enhancement | M | 3 | 3 | H | L | Website, Full |

### 17.2 Additional architect features, ranked

Scores 1 (worst) to 5 (best). Rank is by the sum with determinism and MVP suitability weighted double.

| Rank | Feature | Value | Complexity (5 = simple) | Risk (5 = low) | Determinism | MVP suitability | Where first | Promoted to AddOn? | Exposed on the site? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Evidence expiration review | 4 | 5 | 5 | 5 | 5 | Full | Yes | Yes |
| 2 | Decision supersession | 4 | 5 | 5 | 5 | 5 | Full | Yes | Yes |
| 3 | Azure Policy evidence (assignments via `policy assignment list`) | 4 | 4 | 5 | 5 | 4 | Full | Yes | Yes |
| 4 | Backup validation (`azurebackup` reads, ARG table) | 4 | 3 | 4 | 5 | 3 | Full | Yes (export-based only) | Yes |
| 5 | Architecture fitness functions (claims run on a schedule with thresholds) | 4 | 3 | 4 | 5 | 3 | Full | Partially (one-shot in the lab) | Yes, as "run checks" |
| 6 | Cross-subscription inventory | 3 | 4 | 4 | 5 | 2 | Full | No (needs collectors) | No |
| 7 | DR readiness validation (paired region, failover groups, `resiliency` reads) | 4 | 2 | 3 | 4 | 2 | Full | Partially (paired-region detector) | Later |
| 8 | SLO validation (Resource Health events and Monitor metrics against a declared SLO) | 4 | 2 | 3 | 3 | 2 | Full | No (needs Monitor and time windows) | Later |
| 9 | Policy-as-code export | 3 | 3 | 4 | 4 | 2 | Full | No | No |
| 10 | Change impact analysis (Terraform plan against claims) | 4 | 2 | 3 | 4 | 2 | Full | Yes (plan upload) | Later |
| 11 | Dependency maps (private endpoints, VNets, identities joined from exports) | 3 | 2 | 4 | 4 | 2 | Full | Yes (export-based) | Later |
| 12 | Defender for Cloud evidence | 4 | 2 | 3 | 4 | 1 | Full | No (no 3.0 tool; needs the Security Center API) | No |
| 13 | Architecture diagrams (from inventory; `deploy architecture diagram generate` is for app topologies, not estates) | 2 | 2 | 4 | 2 | 1 | Full | No | Later |

### 17.3 Promotion matrix

| Capability | Phase 1: build in Full | Phase 2: validate in Full | Phase 3: promote to AddOn | Phase 4: expose on the site | Why, or why not |
| --- | --- | --- | --- | --- | --- |
| Evidence ledger, ingestion, hashing, redaction, provenance | Weeks 1-2 | Golden files; security tests | Yes, unchanged engine | Yes (evidence view) | Core of every path |
| ADR and claim models, detectors wave 1 (zone redundancy, region, public access, private endpoint, tags, ownership, SKU, managed identity) | Weeks 2-4 | Fixtures per detector; acceptance tests | Yes | Yes (drift view) | Deterministic, export-based |
| Retirement reviews, Advisor contradiction | Weeks 3-4 | Recorded Azure MCP results | Yes (evidence handed in) | Yes (chat and proposals) | Azure MCP read-only tools under OBO |
| Cloud Architect → draft ADR | Week 5 | Golden state fixtures | Yes | Yes (chat) | Local tool, deterministic transform |
| Retail cost estimates, cost ceiling | Week 5 | Golden pricing rows | Yes | Yes | Read-only, unauthenticated API |
| Terraform plan and state, aztfexport mapping, azqr ingestion | Weeks 6-7 | Sample artifacts | Yes | Yes (upload) | Upload formats |
| MCP server surface | Weeks 2-6 | Contract tests | Yes | Via the Function App | Same contract both editions |
| Trusted-caller session API | Week 6 | Isolation tests | Yes (it is the AddOn's) | Yes | Needed by the lab path |
| Live collectors (Resource Graph, Cost Management, ARM extras) | Weeks 7-9 | Lab subscription | **No** | **No** | Needs a credential the AddOn cannot hold |
| Persistent ledger, scheduled runs | Weeks 8-10 | Lab subscription | **No** | **No** | Enterprise concern; the lab is session-scoped by design |
| Pipeline execution of aztfexport, conftest, azqr | Weeks 9-10 | Workflow runs | **No** (outputs are promoted as upload formats) | Indirectly | Local-only tools |
| Elicitation and `insights get` | Later | Needs a client that renders approvals | **No** until the site renders elicitation | Later | Sampling and secret-tool consent |
| Policy-as-code export, cross-subscription inventory, Defender evidence, SLO validation | Later | Lab subscription | **No** | **No** | Collector-dependent or write-adjacent |
| Per-session Azure MCP deployments | Later | Cost and cold-start study | **Never** | Only as an enterprise option | Operational weight |

**Never enters the AddOn:** anything that needs an Azure credential, a persistent store, a scheduler, a pipeline runner, elicitation or sampling, or that writes to Azure. **Website candidates:** everything the AddOn exposes plus the lab page itself. **AddOn candidates:** every engine capability whose inputs can be an upload or a handed-in Azure MCP result.

## 18. Deployment architecture

### 18.1 Nothing hard-coded

All of the following are parameters with no defaults for identifiers: `tenantId`, `subscriptionId`, `location`, `resourceGroupName`, `environmentName`, `dnsLabel`, `customDomain`, `serverAppClientId`, `siteClientId`, `managedIdentityName`, `azureMcpImageDigest`, `applianceImageDigest`, `namespaces[]`. Names derive from `environmentName` with the `rg-<tier>-<workload>-<env>-<region>` convention the website uses, computed in the template, never typed by hand.

### 18.2 Azure Developer CLI (recommended first path for the Full Appliance)

`azure.yaml` with two services (`azure-mcp`, `appliance`) and `infra/main.bicep`. The Azure MCP service builds a derived image:

```dockerfile
# infrastructure/docker/azure-mcp.Dockerfile — flags are baked in because the upstream entrypoint is fixed
FROM mcr.microsoft.com/azure-sdk/azure-mcp@sha256:<digest-resolved-for-3.0.0>
ENTRYPOINT ["./server-binary", "server", "start", "--transport", "http", "--read-only", "--mode", "all", \
  "--namespace", "advisor", "--namespace", "pricing", "--namespace", "policy", "--namespace", "group", \
  "--namespace", "subscription", "--namespace", "wellarchitectedframework", "--namespace", "cloudarchitect", \
  "--namespace", "resourcehealth", "--namespace", "optimization", \
  "--structured-output-mode", "compact", "--disable-proxy-tools", "--outgoing-auth-strategy", "UseOnBehalfOf"]
```

The upstream README is explicit that the container command must not be overridden at the platform; a derived image is the supported way to pass flags.

Environment for the `azure-mcp` container (names from the azd OBO template and the sovereign-cloud page; values from Bicep outputs):

| Variable | Purpose |
| --- | --- |
| `AzureAd__Instance`, `AzureAd__TenantId`, `AzureAd__ClientId` | Inbound token validation (Microsoft.Identity.Web) |
| `AzureAd__ClientCredentials__0__SourceType` = `SignedAssertionFromManagedIdentity`, `AzureAd__ClientCredentials__0__ManagedIdentityClientId`, `AzureAd__ClientCredentials__0__TokenExchangeUrl` = `api://AzureADTokenExchange` | Federated identity credential for the OBO exchange |
| `ASPNETCORE_URLS` | Bind address inside the container (the server refuses non-loopback binding without `ALLOW_INSECURE_EXTERNAL_BINDING=true`, per the 4.0.0-beta.1 note; verify the 3.0 behaviour in the spike) |
| `AZURE_CLOUD` | Sovereign cloud selection, default public |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry |

Environment for the `appliance` container:

| Variable | Purpose |
| --- | --- |
| `AA_EDITION` = `appliance` | Edition gate |
| `AA_AZMCP_URL` | Internal URL of the Azure MCP container |
| `AA_AZMCP_SERVER_APP_ID` | Audience for application tokens (hosting identity mode) |
| `AZURE_CLIENT_ID` | User-assigned managed identity for collectors and for the application token |
| `AA_SCOPES` | Allow-listed subscription and resource-group scopes |
| `AA_LEDGER` = `cosmos` or `postgres`, `AA_LEDGER_ENDPOINT` | Persistent ledger, managed identity auth |
| `AA_ALLOWED_ORIGINS`, `AA_FRAME_ANCESTORS`, `AA_SITE_ORIGINS` | Pane and CORS, as today |
| `AA_TRUSTED_CALLER_KEY` | Key Vault reference, only when the enterprise site path is enabled |
| `AA_LOG_SILENT`, `AA_TELEMETRY` | Logging switches |

Secret-bearing variables (`AZURE_CLIENT_SECRET`, `AZURE_CLIENT_CERTIFICATE_PATH`, `AZURE_USERNAME`, `AZURE_PASSWORD`) make the appliance refuse to start, as today.

### 18.3 Bicep

Modules: `identity.bicep` (user-assigned identity, role assignments Reader and Cost Management Reader at each scope, federated identity credential on the server app via the Microsoft Graph Bicep extension or a deployment script), `aca.bicep` (environment, Log Analytics, two container apps, internal ingress for `azure-mcp`, external for `appliance`), `ledger.bicep` (Cosmos DB serverless with managed identity data-plane role, or PostgreSQL Flexible with Entra auth), `network.bicep` (optional VNet-integrated environment with private endpoints), `observability.bicep` (Application Insights, alerts). App registrations are created by an `azd` pre-provision hook (as the upstream template does) because Bicep cannot create them natively without the Graph extension.

### 18.4 Terraform

A root under `infrastructure/terraform/` mirroring the Bicep modules with `azurerm` for infrastructure and `azuread` for the two app registrations, the exposed scope, the pre-authorised client and the federated identity credential; the website's HCP Terraform convention (remote state, plan check workflow) is reused. Either path must be able to stand alone; the repository tests both with `terraform validate` and `bicep build` in CI.

### 18.5 Container strategy

- Appliance image: the existing multi-stage pattern (hash-pinned dependencies, no pip at runtime, uid 10001, health check), with a `lab` proof stage that asserts no cloud SDK imports; published to Docker Hub by digest with SBOM and provenance.
- Azure MCP image: derived image as above, rebuilt only when the pinned digest or the flag set changes; scanned with Trivy in CI; the digest recorded in `infrastructure/docker/versions.env`.
- The AddOn ships one image, the lab edition of the same appliance repository build, deployed by the website's `addons` Ansible role on the lab host by digest, port assigned in `group_vars`.

### 18.6 App registrations and OBO configuration

Done once per environment by the azd hook or Terraform: server app with the delegated scope `Mcp.Tools.ReadWrite` and the application role `Mcp.Tools.ReadWrite.All`, delegated ARM `user_impersonation`, federated identity credential to the managed identity, pre-authorised site SPA, and the application role assigned to the App edition's managed identity; admin consent granted in the HCW tenant. Federated identity means no secret exists to rotate; the identity's token exchange is bound to the subject the credential names.

### 18.7 Logging and telemetry

Content-free structured logs (counts, flags, durations, hashed identifiers), as the existing `security/logging.py` enforces; Application Insights for both containers with sampling; Azure MCP's own telemetry stays enabled but, per the 3.0 changelog, "no longer records option values". Correlation: one `X-Request-Id` from the site through the appliance to Azure MCP (`Mcp-` routing headers are left to the SDK).

### 18.8 Rollback and cleanup

- Container Apps revisions: deploy a new revision with 0 % traffic, probe `/api/health` and `/health` (Azure MCP), shift traffic, keep the previous revision for instant rollback. Image digests, not tags, identify what is live.
- Ledger migrations are forward-only and additive during the MVP.
- Cleanup: `azd down --purge` removes Azure resources; app registrations are **not** removed by `azd down` (an upstream gotcha) and are deleted by the hook or by Terraform destroy; the Key Vault soft-delete window is respected; the lab host row is removed from `group_vars` and the role prunes the container.

## 19. Security review

| Requirement | Design |
| --- | --- |
| Read-only default | Azure MCP runs `--read-only`; the appliance's Azure-facing tools are read-only; the only writes are to the appliance's own ledger |
| RBAC enforcement | OBO means the user's own RBAC; hosting identity holds Reader and Cost Management Reader on allow-listed scopes only; the appliance never elevates |
| Per-user isolation | Ledger rows keyed by `tenantId`, `userId` (object id hash) and `sessionId`; the AddOn session API returns 404 for a foreign session id, as the owner-token rule does today |
| Per-tenant isolation | OBO is tenant-bound; the ledger partition key is `tenantId`; the website never mixes tokens across tenants in one session |
| Audit logging | Every tool call becomes a ledger entry: who (hash), what tool, parameter names, result hash, outcome; Azure-side audit stays per-user under OBO |
| Redaction | Ingestion redacts secrets and connection strings; public outputs replace GUIDs with placeholders; logs are content-free by construction |
| Rate limiting | AddOn: existing token bucket and concurrency caps; Function App: per-user and per-session budgets for Azure MCP calls; Azure MCP behind Front Door or API Management rate policies in production |
| SSRF protection | Azure MCP 3.0 validates every endpoint with `Microsoft.Security.AntiSSRF` and refuses private destinations by default; the appliance's outbound allow-list contains only the Azure MCP URL (lab: none at all for the AddOn); uploaded artifacts never cause an outbound request |
| Prompt injection | Evidence is untrusted text: tag values, resource names and Advisor descriptions are shown to the model as data inside structured fields, never as instructions; detectors are deterministic, so no injected text can change a verdict; the website's orchestrator refuses tool calls not on the allow-list and never forwards model text as a tool parameter that selects scope beyond the session's subscriptions |
| Dependency scanning | pip-audit, Dependabot and dependency review on every PR; `uv.lock` hash-pinned; npm audit in the site |
| Image scanning | Trivy on both images; the base image digest checked weekly against the website's pin, as the existing workflow does |
| API Management | Optional in production in front of the appliance: subscription keys for enterprise clients, JWT validation policy mirroring the appliance's own, rate limits, request size limits |
| Front Door and WAF | Production ingress for the appliance and for Azure MCP when exposed beyond the environment; managed rule set, bot protection, geo filtering by policy; origin locked to Front Door's identifier header |
| Private networking | Enterprise profile: VNet-integrated Container Apps environment, private endpoints for the ledger and Key Vault, no public ingress on Azure MCP (internal only) |
| Key Vault | Holds only the trusted-caller key and telemetry connection strings; read through managed identity; no Azure credential ever lives there |
| Managed identities | One user-assigned identity per environment; federated to the server app; role assignments scoped to the allow-list |

## 20. Threat model (STRIDE)

| Threat | Asset | Scenario | Mitigation | Residual |
| --- | --- | --- | --- | --- |
| Spoofing | Token B | An attacker replays a captured bearer against Azure MCP | TLS everywhere, short token lifetime, audience bound to the server app, Front Door or environment-internal ingress, no token in logs | Low |
| Spoofing | Trusted-caller key | A forged site request opens AddOn sessions | Key from the host vault, rotated; the AddOn accepts the key only from the site's egress, over https; sessions carry no Azure power anyway | Low |
| Tampering | Evidence | A user uploads a doctored export to force a verdict | Imported evidence confidence 0.80 and labelled; hashes recorded; the report says what was uploaded by whom (hash) and when; verdicts from uploads are marked "from an upload" | Accepted (it is their own lab result) |
| Tampering | Detector logic | A dependency or image change alters verdicts | Golden fixtures per detector; hash-pinned dependencies; image digests | Low |
| Repudiation | Approvals | A user denies approving a proposal | `Approval` carries object id hash, time, and the evidence snapshot hash; website audit log | Low |
| Information disclosure | Resource inventory | A foreign session id or tenant reads another's evidence | 404 on foreign ids; partition by tenant; two-hour expiry in the lab; content-free logs | Low |
| Information disclosure | Secrets in evidence | A Resource Graph export contains a key in a tag or property | Redaction at ingest with pattern rules and property deny-list; secrets never enter the payload stored or shown | Medium (patterns are not perfect; documented) |
| Denial of service | Azure MCP, appliance | Floods of chat or uploads | Human verification on uploads, rate limits per user and session, size and row limits, concurrency caps, Front Door rate policies | Medium |
| Elevation of privilege | Azure | The platform does something the user cannot | OBO only; read-only server; no write tools; hosting identity limited to Reader roles; the appliance has no Azure-writing code path | Low |
| Elevation of privilege | Model | Injected text drives the orchestrator to call tools outside scope | Allow-listed tools, scope pinned to the session's subscriptions, destructive and secret tools rejected by Azure MCP's elicitation gate because the client declares none | Low |

## 21. Testing strategy

| Layer | What | Where | Tooling |
| --- | --- | --- | --- |
| Unit | Normalisers, hashing, redaction, every detector, scoring, ADR transforms | `packages/architecture-core/tests` | pytest, hypothesis for operators |
| Golden-file | Sample exports, azqr reports, Terraform plans, recorded Azure MCP `structuredContent`, Cloud Architect states → expected evidence, findings, proposals, bundle | `tests/golden` in the engine | pinned fixtures; a `--update-golden` flag that CI forbids |
| MCP contract | `tools/list` of Azure MCP 3.0.0 (names, `inputSchema`, `outputSchema`, annotations) pinned as a snapshot; the appliance's own `tools/list` snapshot; `initialize` result records `serverInfo.version == 3.0.0` | Full Appliance `tests/contract` | a real `azmcp` 3.0.0 binary in CI (npm `@azure/mcp@3.0.0`), stdio, `AZURE_TOKEN_CREDENTIALS` unset so no Azure call happens for listing |
| Integration | The Azure MCP host against the Docker image in HTTP mode with inbound authentication **enabled**: the container binds to the runner's loopback only, and the test obtains an application token for the server app through GitHub's workload identity federation (a CI client app registration holding the `Mcp.Tools.ReadWrite.All` role, no secret). The target is an isolated lab subscription that holds only the fictional sample estate. `--dangerously-disable-http-incoming-auth` is never used, in CI or anywhere else. Cost Management and Resource Graph collectors run the same way | Full Appliance `tests/integration`, nightly | GitHub Actions OIDC, recorded on first run and replayed on PRs |
| Security | Edition boundary (both editions), no secrets, content-free logs, image boundary proof, startup refusal under identity variables | `tests/security` | existing suites extended with the MCP tool-list assertion |
| Isolation | Two sessions, two tenants: evidence, findings and proposals never cross; foreign ids 404; expiry sweeps | `tests/isolation` | pytest against the ASGI app |
| Authorization | Site routes: missing, expired, wrong-audience and wrong-tenant token A; missing B on chat; B whose `tid` or `oid` differs from A's (refused 403, no claim value logged); an Azure MCP call or an evidence subject outside the session's subscription allow-list (refused); a model tool call naming a `human` caller-class tool (refused); AddOn trusted-caller key missing or wrong | website `functions` tests, AddOn tests | existing verify-token tests extended |
| Prompt injection | Fixtures with instructions hidden in tag values, resource names and Advisor descriptions; assert no tool call outside the allow-list and no verdict change | website orchestrator tests, engine tests | scripted model stub |
| Acceptance | The five scenarios below, end to end in the Full Appliance with recorded Azure MCP results, then in the AddOn with handed-in results | `tests/acceptance` | Playwright for the lab page in the website |

Acceptance scenarios:

| Scenario | Given | When | Then |
| --- | --- | --- | --- |
| Zone redundancy contradiction | D-0001 claims `zone-redundancy` for `env=prod` SQL databases; an export shows `hcw-sample-sql-01` with `zoneRedundant=false` | `drift_evaluate` | one `DriftFinding(contradicted)`, one `Contradiction`, one `ReviewProposal(kind=contradiction)`; score unaffected by an `unknown` sibling |
| Retirement review generation | recorded `advisor recommendation list` with one `ServiceUpgradeAndRetirement` record dated within 180 days against `hcw-sample-redis-01`, and D-0002 covering that resource type | `review_propose(kind=retirement)` after ingestion | a proposal naming the resource, the date, the Advisor remediation steps and D-0002, status `open` |
| Advisor contradiction detection | D-0003 claims no high-impact reliability findings; recorded `advisor recommendation list` returns one `New` high-impact HighAvailability record in scope and one `Dismissed` | `drift_evaluate` | `contradicted` with one evidence id; the dismissed record appears as `accepted-risk`, not a contradiction |
| Cost ceiling violation | D-0004 chooses an alternative with 3 × `Standard_D4s_v5` 730 h in `centralus`; recorded `pricing get` rows | `cost_estimate_attach` then `drift_evaluate` | `cost-ceiling` finding `contradicted` when the sum exceeds the ceiling, labelled "estimated retail cost", `unknown` for the `actual` basis |
| Cross-tenant isolation | two sessions with different `tenantId` | session 2 calls `evidence_get`, `drift_list` and `review_decide` with session 1 ids | 404 for every call; session 1 state unchanged; logs contain no ids |

## 22. Implementation roadmap

Weeks are working weeks for one owner with Claude-assisted sessions. Every week ends with a PR that opens ready for review and passes the repository's gates.

| Week | Full Appliance (new App repo) | AddOn (new AddOn repo) | Website | Exit criterion |
| --- | --- | --- | --- | --- |
| 0 | Create both repositories from the existing skeleton; ADR 0001 (pin Azure MCP 3.0.0), ADR 0002 (engine moves downstream), ADR 0003 (AddOn never calls Azure); contract test that records `azmcp` 3.0.0 `tools/list` | Skeleton only | Catalogue row `architecture-lab` as `coming` | CI green in both repos; contract snapshot committed |
| 1 | `architecture-core`: evidence record, provenance, hashing, redaction, Resource Graph export normaliser; `evidence_*` tools; MCP server mounted | — | — | Golden files for two sample exports |
| 2 | ADR, claim, alternative models; `adr_*`, `claim_*` tools; detectors `zone-redundancy`, `public-access-disabled`, `private-endpoint-present`, `tag-required`, `sku-allowed`, `managed-identity`, `region-allowed` | — | — | Zone-redundancy acceptance test passes |
| 3 | Azure MCP host over stdio (dev model); `advisor`, `subscription`, `group`, `policy` result normalisers; `advisor-findings`, `retirement-exposure`, `policy-assignment-present` detectors; `review_*` tools | — | **Spike:** multi-tenant OBO against a second tenant with the azd OBO template (section 8.5) | Retirement and Advisor acceptance tests pass with recorded results; spike result recorded as ADR 0004 |
| 4 | `pricing` normaliser, `cost_estimate_attach`, `cost-ceiling`; `cloudarchitect` state → draft ADR; report bundle with ADR markdown | — | Lab page design (static), Function App routes stubbed | Cost acceptance test passes |
| 5 | Trusted-caller session API; isolation tests; first engine release `architecture-core` 0.1.0 | Adopt 0.1.0 through the bump workflow; lab edition tests; image published | MCP client bearer passthrough and allow-lists | Cross-tenant isolation acceptance passes in both editions |
| 6 | Terraform plan and state, aztfexport mapping, azqr JSON normalisers; detectors `terraform-plan-no-destroy`, `azqr-no-high` | Adopt; upload path for the new formats in the pane | Lab page: sign-in, pickers, chat, tool activity | A visitor can upload an azqr report and see findings |
| 7 | Derived Azure MCP image; azd + Bicep for Container Apps (OBO variant for the lab subscription) | — | Lab page: evidence, drift, proposals, approvals | Lab environment reachable from the Function App |
| 8 | Live Resource Graph collector and ARM extras under managed identity; `diagnostics-enabled`, `lock-present`, `backup-protected` | Row `available` on the lab host by digest | End-to-end Playwright for the ten-step flow | Lab path demo works for an HCW-tenant user |
| 9 | Persistent ledger (Cosmos DB), scheduled collection runs, Cost Management collector (C1) | — | — | Full Appliance runs unattended for a week in the lab subscription |
| 10 | Terraform root, pipeline workflows for aztfexport, conftest, azqr; VALIDATION.md; release 0.1.0 of the appliance | 0.1.0 | Program page in `docs/architecture/app-to-addon/architecture-lab.md` | MVP declared |

## 23. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner decision needed? |
| --- | --- | --- | --- | --- | --- |
| R1 | Multi-tenant OBO through Azure MCP 3.0 does not work as configured, so tenant selection collapses to the HCW tenant | Medium | High for the lab story | Week-3 spike; fallback is "sign in to the chosen tenant" with a single-tenant deployment per tenant for enterprise | Yes, if the spike fails |
| R2 | Azure MCP 4.0 GA arrives mid-build and the team is tempted to move | High | Medium | Contract test pins 3.0.0; an ADR records the upgrade criteria (tool-list diff reviewed, OBO re-validated, golden files regenerated) | No |
| R3 | Container image name discrepancy (`azure-sdk/azure-mcp` versus `azure-mcp`) causes a wrong pin | Low | Low | Resolve by manifest inspection; pin the digest; record both names | No |
| R4 | The Function App's token forwarding is mistaken for storage by a reviewer or auditor | Medium | Medium | Document the request-scoped rule; add a test that the chat session store contains no bearer; content-free logs | No |
| R5 | Resource Graph exports lack sub-resources (TDE, diagnostics, locks) so many claims stay `unknown` in the lab | High | Medium | Honest coverage figure; Full Appliance collectors close the gap; the lab explains "unknown by design" as today | No |
| R6 | Elicitation becomes necessary (a needed tool is `Secret`) and the site has no approval UI | Low (read-only set is not secret) | Medium | Keep to the read-only non-secret allow-list; schedule elicitation support with the `insights get` feature | No |
| R7 | Detector fixture volume overwhelms one owner | Medium | Medium | First wave of eight detectors; fixtures generated from the fictional sample estate; one detector per PR | No |
| R8 | Lab host egress policy blocks the site → AddOn path or the AddOn's MCP endpoint | Low | Medium | The AddOn's MCP endpoint is reached by the Function App over https like `/api/health` today; no new egress from the host | No |
| R9 | Azure Retail Prices API shape or availability changes | Low | Low | Golden rows; estimates labelled retail; graceful `unknown` | No |
| R10 | Entra admin consent for the server app is delayed | Medium | High for week 7 | Request consent in week 0; the upload path works without it | Yes (owner is the admin) |
| R11 | Advisor retirement data is sparse in the lab subscription, so the retirement path is only demonstrable with recorded fixtures | Medium | Low | Fictional recorded results; the Full Appliance validates live in week 9 | No |

## 24. Feasibility assessment

| Area | Feasibility | Basis |
| --- | --- | --- |
| Azure MCP 3.0 as observation source | High | GA release, read-only mode, structured output, OBO and managed identity verified in source and docs |
| Credential-free appliance | High | Already proven by the existing App (managed identity only) and AddOn (no credential) |
| Deterministic drift from exports and Advisor | High | The existing evaluator engine already does the same shape of work; the new models add decisions and claims |
| Tenant selection across tenants | Medium | Depends on the multi-tenant OBO spike |
| Cost awareness | Medium | Retail estimates now; actuals need the collector; forecast later |
| Terraform, azqr, aztfexport | Medium | Upload and pipeline paths only; no remote execution |
| Website lab page | Medium-High | MSAL, Foundry proxy and MCP client exist; the page and the orchestrator are new work |
| Full Appliance on Container Apps with azd | High | Upstream templates show the pattern; the existing App has Terraform for the same shape |
| Per-session isolated Azure MCP | Medium, deferred | Possible with Container Apps jobs or dynamic sessions; not needed for the MVP |

## 25. Probability of success

Each estimate names what is estimated and the factors that move it. Confidence levels are subjective and stated as such.

### 25.1 MVP (section 27) delivered in the Full Appliance within 10 working weeks

- **Estimate:** 0.65
- **Assumptions:** one owner with Claude-assisted sessions; the existing skeleton is reused; Azure MCP stays pinned at 3.0.0; a lab subscription with Reader exists.
- **Dependencies:** Entra admin consent for the server app (R10); a fictional sample estate large enough for fixtures.
- **Risks:** R1, R7, R10.
- **Confidence level:** medium (the engine work is well understood; the calendar is the uncertainty).
- **Raises it:** starting with upload-only detectors (no Azure dependency for weeks 1-2); one detector per PR; recorded Azure MCP results from day one.
- **Lowers it:** adding collectors or the persistent ledger before the detectors are green; chasing 4.0 features.

### 25.2 The AddOn adopts the engine unchanged and the lab page works end to end for HCW-tenant users within 12 weeks

- **Estimate:** 0.55
- **Assumptions:** 25.1 lands; the website's Function App gains the bearer passthrough and the lab routes; the lab host row ships by digest.
- **Dependencies:** the Full Appliance's trusted-caller API; the OBO deployment in the lab subscription; the site's review process (three bot reviewers, up to three rounds each).
- **Risks:** R4, R8, site review cadence.
- **Confidence level:** medium-low.
- **Raises it:** the website PR opened from a written specification in one go, as ADR 0035 did; Playwright for the ten steps written before the page.
- **Lowers it:** redesigning the pane contract instead of adding a page; attempting multi-tenant before the HCW-tenant path works.

### 25.3 Tenant selection across tenants (multi-tenant OBO) works on Azure MCP 3.0 without upstream changes

- **Estimate:** 0.50
- **Assumptions:** Microsoft.Identity.Web multi-tenant web API configuration is accepted by the 3.0 server; the server app is multi-tenant; the second tenant consents.
- **Dependencies:** a second tenant to test with; the week-3 spike.
- **Risks:** R1; the protected-resource metadata advertises a single authorisation server, which some clients may require to match.
- **Confidence level:** low (not verified in this analysis).
- **Raises it:** the OBO provider only checks `tid` equality and Microsoft.Identity.Web supports `organizations`; nothing in the 3.0 source pins a single tenant beyond configuration.
- **Lowers it:** the azd template and docs only show single-tenant; any issuer validation hard-coded to one tenant.

### 25.4 The architecture holds without storing an Azure credential anywhere for one year of operation

- **Estimate:** 0.85
- **Assumptions:** federated identity credentials stay supported; the edition boundary tests stay in CI; no one adds a secret for convenience.
- **Dependencies:** none external.
- **Risks:** a future requirement for a background job in the AddOn (which would need a credential and is forbidden by design).
- **Confidence level:** high.
- **Raises it:** tests that fail the build on any secret-bearing variable; the lab's inability to import an SDK.
- **Lowers it:** an enterprise customer demanding client-secret auth for their client app (acceptable on their side; it still is not stored by the appliance).

### 25.5 Azure MCP 3.0 remains the right pin for 12 months

- **Estimate:** 0.40
- **Assumptions:** 4.0 reaches GA within a few months (the 3.0 cycle took 50 betas over six months); 3.x receives security backports for a while.
- **Dependencies:** upstream support policy, which is not published as a dated commitment.
- **Risks:** R2; a security fix that lands only in 4.x.
- **Confidence level:** medium.
- **Raises it:** the backport activity visible on the 3.x branch (#3893, #3920).
- **Lowers it:** 4.0's Advisor and optimization improvements that the roadmap would want; upstream's twice-weekly cadence.

## 26. Deferred features

| Feature | Reason deferred | Revisit trigger |
| --- | --- | --- |
| `insights get` (Resource Graph aggregation with MCP sampling) | Needs client-side sampling and elicitation; the site has neither | When the lab page can render an approval prompt and the Function App supports sampling |
| Cost Management actuals in the AddOn | Needs a credential or an upload format; the upload normaliser is step C2 | After C1 proves the evidence kind |
| Forecast spend | Cost Management forecast API in the Full Appliance only | After C1 |
| Defender for Cloud evidence | No Azure MCP 3.0 tool; needs the Security Center API under a role the lab does not hold | When a `defender` namespace appears upstream or a collector is justified |
| SLO validation | Needs Monitor metrics over windows and a declared SLO model | After the ledger and scheduler exist |
| Dependency maps and diagrams | Value is real but non-deterministic rendering; `deploy architecture diagram generate` targets app topologies, not estates | After wave-two detectors |
| Policy-as-code export | Needs stable claim semantics first | After ten decisions exist in a real tenant |
| Per-session isolated Azure MCP deployments | Operational weight; no MVP need | An enterprise customer asks for process-level isolation |
| Bring-your-own-appliance catalogue row | Changes the site's contract | After the lab path is stable |
| Adoption of Azure MCP 4.0 | Not GA; breaking changes still landing | 4.0.0 GA tag plus a reviewed tool-list diff |

## 27. Recommended MVP

**Scope:** the Full Appliance with `architecture-core` 0.1.0, the eight wave-one detectors plus `advisor-findings`, `retirement-exposure`, `policy-assignment-present` and `cost-ceiling`; evidence from uploaded Resource Graph exports and from Azure MCP 3.0.0 `advisor`, `pricing`, `policy`, `group`, `subscription`, `wellarchitectedframework` and `cloudarchitect` under OBO (dev: stdio); ADR drafting from Cloud Architect; retirement and contradiction review proposals; the MCP server surface of section 16 minus the Full-only tools; the trusted-caller session API; the report bundle with `NOT-AN-AUDIT.md`. Then the AddOn adopting 0.1.0 unchanged and the website's lab page for HCW-tenant users.

**Out of scope for the MVP:** live collectors, persistent ledger, scheduled runs, Cost Management actuals, pipeline execution of aztfexport, conftest and azqr (their outputs are accepted as uploads), elicitation, multi-tenant OBO (spiked, not shipped), governance exports.

**Done when:** the five acceptance scenarios pass in both editions; the ten-step lab flow passes in Playwright for an HCW-tenant user; VALIDATION.md in both new repositories records what ran and what did not; the website's program page for the pair exists and the catalogue row is `available` by digest.

## 28. Recommended first implementation slice

One PR in the new App repository, nothing else:

1. **Pin and prove the baseline.** `tests/contract/test_azmcp_tools_list.py` starts `npx @azure/mcp@3.0.0 server start --read-only --mode all --namespace advisor --namespace pricing --namespace subscription --structured-output-mode compact` over stdio, sends `initialize` and `tools/list`, asserts `serverInfo.version` starts with `3.0.0`, and snapshots the tool names, `inputSchema` and annotations into `tests/contract/snapshots/azmcp-3.0.0-tools.json`. No Azure call is made.
2. **The evidence record and one normaliser.** `architecture-core` with `Evidence`, `SourceProvenance`, `CollectionRun`, canonical hashing, redaction rules, and the Resource Graph JSON normaliser producing the common resource shape.
3. **The decision and claim records and one detector.** `DecisionRecord`, `Claim`, `DriftFinding`, `Contradiction`, `ReviewProposal`, and `zone-redundancy` for SQL databases, storage accounts and App Service plans.
4. **Two MCP tools.** `evidence_ingest` and `drift_evaluate` on a stateless streamable-HTTP MCP server with in-memory state, returning `structuredContent`.
5. **The first acceptance test.** The zone-redundancy scenario from section 21 against the fictional sample estate (`00000000-0000-0000-0000-000000000001`, `hcw-sample-sql-01`), run through the MCP server, with the golden bundle committed.
6. **ADR 0001 to 0003** in the new repository: the Azure MCP 3.0.0 pin and the upgrade criteria; the engine-moves-downstream rule; the AddOn-never-calls-Azure rule.

That slice touches no Azure, needs no app registration, proves the contract against the real 3.0.0 binary, and leaves every later week adding one normaliser, one detector or one tool at a time.

---

## Appendix A. Sources (retrieved 2026-10-21)

| Source | Location |
| --- | --- |
| Azure MCP Server 3.0.0 changelog | `https://github.com/microsoft/mcp/blob/Azure.Mcp.Server-3.0.0/servers/Azure.Mcp.Server/CHANGELOG.md` |
| Command reference (3.x) | `https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/docs/azmcp-commands.md` |
| Authentication (3.x) | `https://github.com/microsoft/mcp/blob/release/azure/3.x/docs/Authentication.md` |
| Remote hosting azd templates and API permissions | `https://github.com/microsoft/mcp/tree/release/azure/3.x/servers/Azure.Mcp.Server/azd-templates` |
| Known issues (OBO and local-only tools) | `https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/KNOWN-ISSUES.md` |
| Core server source cited by line (`BaseToolLoader.cs`, `CommandFactoryToolLoader.cs`, `SingleProxyToolLoader.cs`, `ServerStartCommand.cs`, `ServerStartOptions.cs`, `HttpOnBehalfOfTokenCredentialProvider.cs`) | `https://github.com/microsoft/mcp/tree/release/azure/3.x/core/Microsoft.Mcp.Core/src` |
| Tool sources cited (`Advisor`, `Insights`, `Pricing`, `Extension`, `AzureTerraform`, `WellArchitectedFramework`, `CloudArchitect`) | `https://github.com/microsoft/mcp/tree/release/azure/3.x/tools` |
| Container Dockerfile (fixed entrypoint) | `https://github.com/microsoft/mcp/blob/release/azure/3.x/Dockerfile` |
| Package pins | `https://github.com/microsoft/mcp/blob/release/azure/3.x/Directory.Packages.props` |
| 4.0.0-beta changelog (not adopted) | `https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/CHANGELOG.md` |
| Learn: deploy with on-behalf-of authentication | `https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/deploy-remote-mcp-server-on-behalf-of` |
| Learn: tools index, Cloud Architect, Well-Architected, Pricing, Advisor MCP tools | `https://learn.microsoft.com/azure/developer/azure-mcp-server/tools/` and `https://learn.microsoft.com/azure/advisor/advisor-mcp-tools` |
| Learn: sovereign clouds and the token exchange setting | `https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/connect-sovereign-clouds` |
| Learn: securing MCP servers on Container Apps | `https://learn.microsoft.com/azure/container-apps/mcp-authentication` |
| azd OBO template | `https://github.com/Azure-Samples/azmcp-obo-template` |
| MCP Python SDK and FastMCP versions | `https://pypi.org/project/mcp/` (2.3.0), `https://pypi.org/project/fastmcp/` (4.1.3) |
| npm `@azure/mcp` 3.0.0 | `https://www.npmjs.com/package/@azure/mcp/v/3.0.0` |
| HCW repositories reviewed | `HCW-HybridCloudWorks` (ADR 0006, 0013, 0034, 0035; the AddOn integration standard; `functions/src/lib/ai/mcp.js`), `HCW-CloudAssessor_App` (`collectors/`, `identity.py`, `edition.py`, Terraform), `HCW-CloudAssessor_AddOn` (`edition.py`, `tests/security/test_edition_boundary.py`, ADR 0001 to 0003, workflows) |

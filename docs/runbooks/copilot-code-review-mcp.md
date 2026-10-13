# Copilot code review — MCP servers

> **Status: applied 2026-09-06.** The `github_copilot_review` identity is
> applied, `COPILOT_REVIEW_CLIENT_ID` and `COPILOT_REVIEW_APP_ID` are set, the
> App's key is stored, the setup workflow's manual dispatch signed in (run 2,
> green), and the five servers are pasted into repository settings. The owner
> steps were tracked in
> [issue #369](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/369),
> which was closed the same day. `.github/copilot-mcp.json` remains the
> reviewed source of record: GitHub does not read it from the repository, so
> any change to it is a pull request and then the paste in step 5 again.
>
> **First review session, same day (PR #378):** Copilot code review *does*
> run `copilot-setup-steps.yml` — but in its own runner, which resolves no
> `vars.*` at all, so the Azure login ran with empty inputs. The workflow now
> reads the four identifiers from Agents secrets first (step 2b below, done
> the same day as issue #381), and the read-only tool filter described under
> [What the review runner keeps](#what-the-review-runner-keeps) decides which
> servers a review can actually call. **First review after that merge (PR
> #382, same day):** every setup step green in Copilot's runner — Agents
> reads, federated login, App token — recorded in the
> [Verification record](#verification-record).
>
> **The App's key, 2026-10-11
> ([#1063](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1063)):**
> by 2026-09-28 the key was no longer in the Agents store (#1029), so the App-token step
> skipped. It was stored again on 2026-10-11, and `gh secret list --app agents`
> lists it with that date. A manual dispatch of the setup workflow cannot
> confirm it: the dispatched run reads Actions secrets, not the Agents store,
> so it prints the "not resolvable" notice whatever the Agents store holds.
> The check is the first Copilot session after its credits return on
> 2026-10-31. Its setup log should show the App-token step run, not skipped.

Every Copilot review in this repository ends with the hint *"Configure MCP
servers for context-aware, tailored reviews."* This page is that
configuration: which Model Context Protocol (MCP) servers the reviewer may
call, why those five, how the two that touch live systems are kept read-only
without a stored credential, what was deliberately left out, and the exact
steps to turn it on and to prove it is working.

## What this changes

Copilot code review runs in a GitHub-hosted session and, by default, can only
see the pull request and the repository, plus two built-in MCP servers
(GitHub, read-only on this repository, and Playwright). With MCP servers
configured it can also pull reference material and live state into the
review — the current Azure documentation for a Functions setting, the
Terraform Registry page for an `azurerm` argument, the Cloudflare Workers docs
for the availability probe, the role assignments actually present on a
resource group, the CI run that failed on the pull request — instead of
guessing or staying silent.

The configuration is **shared** with the Copilot cloud agent (the agent that
takes an issue and opens a pull request), and so is the setup-steps workflow
below. Anything enabled here is enabled there too. GitHub's reference:
[Configure MCP servers for your repository](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers),
[MCP servers and agent skills for code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review#mcp-servers-and-agent-skills)
and [Customizing Copilot code review's environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review#customizing-copilot-code-reviews-environment).

Three facts from those pages shape every choice below:

- **Copilot calls MCP tools autonomously.** Nothing asks the owner before a
  tool runs. GitHub's own guidance is to allowlist specific read-only tools
  rather than `*`. A review comment is also untrusted input to the reviewer,
  so every principal it can act as must be one that can change nothing.
- **Copilot code review runs `copilot-setup-steps.yml` before it starts**, in
  the same Actions-hosted environment the cloud agent uses. That is how an
  Azure sign-in reaches the Azure MCP Server without any secret being stored:
  the job exchanges its GitHub OIDC token for an Azure token, exactly as the
  deploy and monitor workflows do.
- **Copilot is more likely to use the servers when told to.** A
  review-focused skill directory (`.github/skills/code-review/`) and custom
  instructions that name the MCP context both raise the odds. The skill
  carries a section saying which server to consult for which component.

## The servers, and why each one

Every server is official (published by the vendor whose product it
documents or exposes) and read-only. Three need no credential at all. The two
that reach live systems — Azure and GitHub — are covered in their own
sections, because how they authenticate is the whole point.

| Server | Publisher | Transport | Why it is here |
| --- | --- | --- | --- |
| `microsoft-learn` | Microsoft — [Microsoft Learn MCP Server](https://learn.microsoft.com/en-us/training/support/mcp), source at [MicrosoftDocs/mcp](https://github.com/microsoftdocs/mcp) | Remote HTTP, `https://learn.microsoft.com/api/mcp`, no key | The estate is Azure Static Web Apps, Azure Functions (Flex Consumption, Node 24), Cosmos DB serverless, Key Vault, Entra ID and MSAL, Application Insights. A reviewer that can read the current Learn page for `host.json`, a Cosmos consistency setting or an MSAL scope catches drift from documented behaviour instead of asserting from training data. Tools: `microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search`. |
| `cloudflare-docs` | Cloudflare — [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/), source at [cloudflare/mcp-server-cloudflare](https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/docs-ai-search) | Remote HTTP, `https://docs.mcp.cloudflare.com/mcp`, no auth | `edge/availability-probe/` is a Worker on a cron trigger ([ADR 0024](../decisions/0024-edge-availability-probe.md)), and `infra/` manages Cloudflare DNS and the transform rules. This is the public documentation server only — not the account API server at `mcp.cloudflare.com`, which is OAuth and would give the reviewer a live account. Tool: `search_cloudflare_documentation`. |
| `terraform` | HashiCorp — [Terraform MCP server](https://developer.hashicorp.com/terraform/mcp-server), source at [hashicorp/terraform-mcp-server](https://github.com/hashicorp/terraform-mcp-server) | Local container `hashicorp/terraform-mcp-server:1.3.0@sha256:423a6b8e2ee0…` (digest-pinned; the full digest is in `.github/copilot-mcp.json`), started by the review session | `infra/` is a single Terraform root module against **live production**. Half of what an infra review checks is "does this argument exist on this provider version, and does changing it force replacement" — exactly what `get_provider_details` answers from the Registry. Restricted to the `registry` toolset and eight read tools (the [tools reference](https://developer.hashicorp.com/terraform/mcp-server/reference)); no `TFE_TOKEN` is passed, so the HCP Terraform workspace, runs, plans and state stay out of reach. The image is pinned by digest, not by tag — a tag can be retargeted, a digest cannot; bump both together, as with every other pinned dependency here. |
| `azure` | Microsoft — [Azure MCP Server](https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/), source at [microsoft/mcp](https://github.com/microsoft/mcp/tree/main/servers/Azure.Mcp.Server), package [`@azure/mcp`](https://www.npmjs.com/package/@azure/mcp) | Local, `npx @azure/mcp@3.0.0-beta.41`, started by the review session; signs in through the Azure CLI session `copilot-setup-steps.yml` leaves behind | Lets the reviewer check a Terraform or Functions change against what is actually deployed: the role assignments on a resource group, a Function App's current configuration, the activity log for the resource a PR touches, a storage account's network rules. See [The Azure server](#the-azure-server-read-only-federated-no-secret) for the identity and the fourteen tools. |
| `github-mcp-server` | GitHub — [GitHub MCP Server](https://github.com/github/github-mcp-server) | Local container `ghcr.io/github/github-mcp-server:v1.12.0@sha256:46cdbbd810fa…` (digest-pinned; full digest in `.github/copilot-mcp.json`), `--read-only`, thirty-one named read tools on its command line and in Copilot's allowlist; authenticates with a one-hour **GitHub App** installation token `copilot-setup-steps.yml` mints per session | Replaces the built-in GitHub server's default toolsets with a wider **read-only** set on **this repository only**: Actions (why did the CI job on this PR fail), code scanning and Dependabot alerts, discussions, plus the default repos, issues and pull requests. No personal access token of any kind. See [The GitHub server](#the-github-server-wider-read-only-still-one-repository) for the App and its ceiling. |

The tool allowlist is applied twice for the Terraform and Azure servers: on
the server's own command line (`--tools=...` / `--tool ...`, so the process
never registers anything else) and in Copilot's `tools` array (so Copilot
never asks for anything else). Either one alone would be enough; both are the
same belt-and-braces the `iac-validate.yml` guard uses.

### The Azure server: read-only, federated, no secret

**Why this is safe to hand to an autonomous reviewer**, in four layers, each
of which holds on its own:

1. **The identity can change nothing.** `github_copilot_review` in
   `infra/oidc.tf` is a new user-assigned managed identity holding **Reader**
   on the four workload resource groups (`rg-web-site-prod-cus`,
   `rg-db-site-prod-cus`, `rg-stor-site-prod-cus`, `rg-sec-site-prod-cus`)
   and nothing else. Reader is `*/read`: control-plane reads only. It carries
   no data action and no `list*/action`, so it cannot list storage keys,
   Cosmos keys, Function App settings or Key Vault secrets, and cannot read a
   blob, a document or a secret. It is deliberately **not** the existing
   `github_reader` identity, which lists the Function App's settings, and
   until #1098 also held a config write on it for the content manifest's
   origin window.
2. **There is no stored credential to leak.** `copilot-setup-steps.yml` runs
   `azure/login` under OIDC in the `copilot` environment; the identity's
   federated credential trusts exactly the subject
   `repo:saulpatinojr/HCW-HybridCloudWorks:environment:copilot` (in both
   the name and immutable-ID forms, like every credential in this estate).
   No ref-form credential exists on it, so no branch-triggered workflow can
   assume it by accident. The three values the workflow needs
   (`COPILOT_REVIEW_CLIENT_ID`, `TENANT_ID`, `SUBSCRIPTION_ID`) are repository
   **variables** — identifiers that grant nothing without a token, per
   [Variables and secrets](../standards/variables-and-secrets.md).
3. **The server refuses writes.** `--read-only` on the command line drops
   every mutating tool before the server registers anything.
4. **The tool list is fourteen names, chosen by hand** from the server's own
   metadata (`readOnly`, `secret`), pinned with `--tool` on the command line
   and again in Copilot's allowlist. Everything that reads *content* is out —
   Cosmos item query/search, blob get, Key Vault secret/key/certificate get,
   app-settings get, and every Log Analytics or Application Insights **log
   query** tool, since telemetry is readable under Reader. What is in:

    | Tool | Reads |
    | --- | --- |
    | `subscription_list`, `group_list`, `group_resource_list` | Inventory: what exists, in which group |
    | `role_assignment_list` | RBAC on a scope — the thing an `oidc.tf` review most needs to see live |
    | `functionapp_get`, `appservice_webapp_get`, `appservice_webapp_deployment_get` | Function App and site configuration, deployment history |
    | `storage_account_get`, `storage_blob_container_get` | Account and container properties (network rules, public access, versioning) — not blob content |
    | `cosmos_list` | Cosmos accounts (control plane) — not documents |
    | `monitor_activitylog_list` | Who changed what, when, on a resource |
    | `monitor_metrics_definitions`, `monitor_metrics_query`, `monitor_webtests_get` | Metrics and availability-test definitions — numbers, not log rows |

    `AZURE_TOKEN_CREDENTIALS=AzureCliCredential` pins the credential chain to
    the CLI session, so the server cannot fall through to any other
    credential that happens to be on the runner.

**What Reader can still see, said plainly:** resource configuration and
tags, role assignments, metrics, and the activity log. Application Insights
*telemetry* is technically readable under Reader too, which is why no
log-query tool is enabled — and the telemetry is content-free by policy
regardless (correlation identifiers, no payloads).

**Resolved on the first real review (PR #378, 2026-09-06).** Copilot code
review does run `copilot-setup-steps.yml` — the session log shows every step
by name — but not as an ordinary Actions job. Copilot's runner replays the
steps itself, and in that runner **`vars.*` resolves to nothing**: the first
review's `azure/login` printed a `with:` block with no `client-id`,
`tenant-id` or `subscription-id` at all, while a manual `gh workflow run` of
the same file, an ordinary Actions job, signed in fine. What the runner does
expose is the **Agents** store (the session log lists the injected secret
names), which is why GitHub's own Azure example reads its inputs with
`secrets.`. The workflow therefore reads each identifier as
`secrets.COPILOT_REVIEW_… || vars.…`: the Agents secret when present, the
repository variable otherwise, so both runners work. Holding identifiers in
a secret store is a documented exception to
[Variables and secrets](../standards/variables-and-secrets.md): the values
are still not credentials; the store is simply the only one Copilot reads.
The failure mode remains safe either way — no sign-in means the Azure server
has no credential and fails closed.

### The GitHub server: wider read-only, still one repository

The built-in GitHub MCP server already gives the reviewer read-only access to
this repository with a token GitHub scopes per review. What it does not give
is the **Actions** toolset (workflow runs and job logs — "why is this PR's CI
red"), **code scanning** and **Dependabot** alerts, or **discussions**. GitHub's
documented way to widen it ([Customizing the built-in GitHub MCP server](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers#customizing-the-built-in-github-mcp-server))
is a **personal access token** stored as an Agents secret. This repository
does not do that. **No personal access token is used, classic or
fine-grained**: both are bound to a person, both are long-lived, and
[Variables and secrets](../standards/variables-and-secrets.md) already holds
that this estate stores no such credential. The one pattern it does sanction
for GitHub → GitHub — the manifest publisher's — is a **GitHub App** whose
installation token is minted per run and lives one hour, and that is what
the reviewer uses too.

How it works, and what bounds it:

- **A dedicated App, read-only by construction.** *HCW Copilot Review
  Reader* is a GitHub App owned by the `HybridCloudWorks` organisation and
  installed on **this repository only**, with eight repository permissions,
  all **Read**: Actions, Code scanning alerts, Contents, Dependabot alerts,
  Discussions, Issues, Metadata, Pull requests. No account permissions, no
  webhook. An App's permissions are the **ceiling** for every token it can
  ever mint: the private key, if it leaked, could produce nothing but
  read-only, one-repository, one-hour tokens — the same access the token
  itself carries. That is the property a personal token cannot offer.
- **A one-hour token, minted per session.** `copilot-setup-steps.yml` runs
  `scripts/github-app-token.mjs` — the same minter the manifest publisher
  uses, which the script's header explains is preferred over the marketplace
  action — with `GITHUB_APP_PERMISSIONS` narrowing the token again to those
  eight read permissions, masks it, and writes it as
  `GITHUB_PERSONAL_ACCESS_TOKEN=…` into `$HOME/.copilot-review/github-mcp.env`
  with mode 600. (The variable name is the server's; the value is an App
  token, not a personal one.)
- **The server runs read-only, in the pinned container, with a named tool
  list.** The `github-mcp-server` entry replaces the built-in server with
  `ghcr.io/github/github-mcp-server:v1.12.0@sha256:…` (digest-pinned), run
  with `--env-file` on that file — so the token is never an argument another
  process could list — plus `--read-only`, which drops every write tool
  before the server registers anything, and `--tools` naming **thirty-one**
  read tools, the same list Copilot's `tools` allowlist carries, so a tool
  GitHub adds to a toolset later is not picked up until someone adds it
  here. They were chosen by running the pinned binary and reading what it
  registers: the Actions run, job and log tools; code-scanning and
  Dependabot alert reads; commits, file contents, branches, tags, releases
  and labels; issue and pull-request reads and searches; discussions; code
  and commit search. Left out on purpose: `get_me` (a person's identity —
  the token has none), `list_repository_collaborators` and the team tools
  (people, not code), `search_repositories` (the token sees one repository),
  and every tool in the `secret_protection`, `orgs`, `users`,
  `notifications`, `gists` and `copilot` toolsets (the last would let the
  reviewer start agent sessions).
- **Two stored values, neither a credential that acts alone.**
  `COPILOT_REVIEW_APP_ID` is a repository **variable** (an identifier, like
  the manifest App's). `COPILOT_REVIEW_APP_PRIVATE_KEY` is an **Agents
  secret**, the store Copilot's setup job reads. It is *not* prefixed
  `COPILOT_MCP_`, because the setup job — not an MCP server — needs it; that
  means it is also present in the agent's environment, which is exactly why
  the App is read-only and single-repository: the ceiling above is what
  makes that exposure acceptable.

**What this costs.** A GitHub App to create once (step 4), a private key to
store, and a token that expires an hour into a session — long enough for any
review, and the cloud agent simply loses GitHub tools after an hour rather
than holding a standing credential. If even that is not worth "Copilot can
read the failing CI job", delete the `github-mcp-server` entry from the file
and the built-in server continues exactly as today.

### What the review runner keeps

A Copilot **code review** session runs MCP in read-only mode
(`COPILOT_MCP_READ_ONLY_MODE=true` in its session log) and keeps only tools
whose **own definitions** carry the MCP annotation `readOnlyHint: true`. The
repository's `tools` allowlist cannot add that flag; it has to come from the
server (community thread
[#200048](https://github.com/orgs/community/discussions/200048), where
annotating a custom server's tools fixed the same symptom). A server left
with no annotated tools is dropped with `MCP server "…" has no allowed tools
after filtering — omitting from config`. The **cloud agent** shares the
configuration but not this mode.

The first review session (PR #378, 2026-09-06) showed the filter at work:

| Server | In that session | Why, and what changed |
| --- | --- | --- |
| `terraform` | **kept** | Its Registry tools are annotated read-only, and the image was ready in time. |
| `azure` | dropped | Every one of its fourteen tools is annotated read-only (verified locally), so the likely cause is time: `npx @azure/mcp` downloads a package and a platform binary before it can answer, and the runner enumerates tools seconds after start. The workflow now warms that download and pre-pulls the two container images before the servers start. |
| `github-mcp-server` | dropped | Never started: the Azure login had failed first, so the setup steps that mint and hand over its token did not run. Step 2b makes the login succeed in Copilot's runner. All thirty-one of its tools are annotated read-only. |
| `microsoft-learn`, `cloudflare-docs` | dropped | Remote servers that answer quickly, so the only explanation left is that their tools are not annotated `readOnlyHint: true`. Until the vendors annotate them, these two serve the **cloud agent** only; a review has to rely on the Terraform Registry, the live Azure state and the GitHub server. |
| `playwright` (built-in) | dropped | Its tools drive a browser and are not read-only; expected in every review. |

**The second session read differently, on the same runtime.** The review of
the same PR half an hour later (Actions run 34018454760, runtime
`vendored-93e753b4`, the same as the first) printed no "no allowed tools"
line at all. Instead the session reported `[mcp] server="…" status=connected`
for `cloudflare-docs`, `microsoft-learn`, `github-mcp-server`, `azure` and
`playwright` — and `terraform` did not appear in either form. Its closing
summary showed `invocations=0` for every server, and `github-mcp-server` was
"connected" although the setup steps that write its token file had been
skipped, so a `connected` line is not proof that a server works. Two
consequences for reading a log:

- The filter's reporting is not stable between sessions, so a row in the
  table above is evidence from one session, not a rule. What stays true is
  the mechanism GitHub documents: read-only mode keeps annotated tools only.
- The evidence that a server worked is a tool **invocation** in the summary
  line or an attribution under a review comment, not its status line.

The four Agents copies were present in that second session
(`COPILOT_AGENT_INJECTED_SECRET_NAMES` listed all five names, and "Loaded 5
secret(s)"), while the login still ran with an empty `with:` block — because
the step list came from `main`, as the next paragraph explains. The first
review **after** #378 merges is the test.

**Copilot reads `copilot-setup-steps.yml` from the default branch.** The
review sessions of PR #378 executed the step list `main` held at the time,
although that PR changed the file — the new steps did not appear in any of
its own reviews. So a change to the setup steps shows up in a Copilot session
only after it merges, and the PR that carries it is reviewed with the
previous version; judge such a change by the first review **after** its
merge. In Copilot's runner a failed step also skips every step after it,
which is why a failed login left the GitHub server without its token in
those sessions.
### Deliberately not configured

- **HCP Terraform access** for the Terraform server (`TFE_TOKEN`). Would
  expose workspace `hcw-azure`'s runs, plan JSON and state metadata to the
  reviewer. Plan evidence belongs in the pull request body, attached by a
  human, as `infra/README.md` already requires.
- **Any data-plane Azure role, and any Azure log-query tool.** Content is
  not context. A reviewer needs to know a container's network rules, not what
  is in it.
- **Reader on the Management subscription or the `conn` group.** The central
  Log Analytics workspace and the spoke network are out of scope for a code
  review, and out of reach for this identity.
- **Cloudflare account API server** (`https://mcp.cloudflare.com/mcp`). OAuth
  to the live account; the docs server covers the review use.
- **Any personal access token, classic or fine-grained.** User-bound and
  long-lived; the GitHub App above replaces the need for one entirely.
- **Reuse of the manifest publisher's App.** It holds `contents: write` and
  `pull_requests: write`; a reviewer must run under a principal whose ceiling
  is read, so it gets its own App.

## Apply (owner)

Repository administrator, Azure Owner on the application subscription (for
the apply approval), and `gh` and `az` signed in. Do the steps in this
order — the paste is last because two servers depend on what comes before.
The same list, as checkboxes, is
[issue #369](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/369).

**Steps 1 to 3 need the pull request merged first.** The workspace plans
from `main`, the client-id output exists only after that apply, and
`workflow_dispatch` only knows workflows that are on the default branch — so
before the merge, step 3 answers
`HTTP 404: workflow copilot-setup-steps.yml not found on the default branch`,
which is GitHub saying "not yet", not a broken workflow. Step 4 (the token)
has no such dependency and can be done at any time.

### 1. Merge, then approve the Terraform apply

Merging the pull request queues a plan on the `hcw-azure` workspace. Approve
it at <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>.

**Success looks like:** the known permanent diff (3 to add, 1 to change, 3
to destroy — the `RUNTIME_CONFIG_WRITER` strip, see
`scripts/assert-expected-plan.mjs`) **plus exactly seven adds**: one
`azurerm_user_assigned_identity`, two `azurerm_federated_identity_credential`,
four `azurerm_role_assignment` (Reader on `web`, `db`, `stor`, `sec`).
Nothing else changes or is destroyed. Any other destroy is a reason to stop
and read the plan, not to approve it.

### 2. Seed the client-id variable

PowerShell, from the repository root on `main`. The script reads the
`copilot_review_client_id` output from the workspace's applied state and
upserts it alongside the variables it already manages:

```powershell
git checkout main; git pull origin main; ./scripts/set-github-variables.ps1
```

**Success looks like:** a line naming `COPILOT_REVIEW_CLIENT_ID` and a GUID.
It is a variable, not a secret — the value is printed on purpose.

### 2b. Mirror the four identifiers into the Agents store

Done 2026-09-06 as
[issue #381](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/381);
kept here for a rotation, which has to change both copies. Copilot's own runner reads only Agents secrets (see
[the Azure server](#the-azure-server-read-only-federated-no-secret)), so the
four identifiers the workflow reads — three for the Azure login, one for the
GitHub App — must exist there as well as in the repository variables the
manual run uses. Nothing to retype: the first line prints the four values the
variables hold, and the later line copies each to the clipboard in turn for
the paste.

```powershell
gh variable list --repo saulpatinojr/HCW-HybridCloudWorks | Select-String 'COPILOT_REVIEW_CLIENT_ID|^TENANT_ID|^SUBSCRIPTION_ID|COPILOT_REVIEW_APP_ID'
```

Then, in the repository, **Settings → Secrets and variables → Agents →
Secrets → New repository secret**, four times (the Agents tab sits beside
the Actions tab at
<https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/secrets/actions>);
`gh secret set` cannot write this store:

| Agents secret | Value: the repository variable |
| --- | --- |
| `COPILOT_REVIEW_CLIENT_ID` | `COPILOT_REVIEW_CLIENT_ID` |
| `COPILOT_REVIEW_TENANT_ID` | `TENANT_ID` |
| `COPILOT_REVIEW_SUBSCRIPTION_ID` | `SUBSCRIPTION_ID` |
| `COPILOT_REVIEW_APP_ID` | `COPILOT_REVIEW_APP_ID` (exists once step 4 is done) |

To copy one value without retyping it, PowerShell:

```powershell
gh variable get COPILOT_REVIEW_CLIENT_ID --repo saulpatinojr/HCW-HybridCloudWorks | Set-Clipboard
```

and the same with `TENANT_ID`, `SUBSCRIPTION_ID` and `COPILOT_REVIEW_APP_ID`
in place of the variable name.

**Success looks like:** four secrets listed under Agents (five with the App
key), and the next review session's log showing `azure/login` with a
`client-id` line and a green *Azure Login* step.

### 3. Prove the sign-in, before Copilot has to

PowerShell:

```powershell
gh workflow run copilot-setup-steps.yml --repo saulpatinojr/HCW-HybridCloudWorks; Start-Sleep -Seconds 20; gh run list --repo saulpatinojr/HCW-HybridCloudWorks --workflow copilot-setup-steps.yml --limit 1
```

**Success looks like:** the run is `completed success` and its single step,
*Azure Login*, prints the subscription it signed into. **The failure that
matters** is `AADSTS700213: No matching federated identity record found` —
the subject GitHub presented does not match what Entra trusts. Compare the
subject quoted in the error against the workspace's `federated_subjects`
output (Outputs tab on the workspace page above); the two `:environment:copilot`
entries must be there. A login failure complaining about an empty `client-id`
means step 2 did not land.

### 4. Create the GitHub App and store its two values

No personal access token is created at any point in this step.

1. Open <https://github.com/organizations/HybridCloudWorks/settings/apps/new>
   and register the App:
    - **GitHub App name:** `HCW Copilot Review Reader`.
    - **Homepage URL:** `https://docs.hybridcloudworks.com/runbooks/copilot-code-review-mcp/`.
    - **Webhook:** untick *Active*. The App receives nothing.
    - **Repository permissions**, each set to **Read-only**: Actions, Code
      scanning alerts, Contents, Dependabot alerts, Discussions, Issues,
      Metadata (already Read-only), Pull requests. Leave every other
      repository, organisation and account permission at *No access*.
    - **Where can this GitHub App be installed?** *Only on this account*.
    - Click **Create GitHub App**.
2. On the App's page, note the **App ID** (a short integer near the top),
   then under *Private keys* click **Generate a private key**. A `.pem` file
   downloads; it is the only copy GitHub will ever give you.
3. Install it: in the App's left menu, **Install App** → `HybridCloudWorks`
   → *Only select repositories* → `HCW-HybridCloudWorks` → **Install**.
4. Store the App ID as a repository **variable**. Nothing to retype: the
   App's slug is fixed by its name (`hcw-copilot-review-reader`), so the
   installation you just made can be looked up and its App ID written in one
   line. PowerShell:

    ```powershell
    $appId = (gh api /orgs/HybridCloudWorks/installations | ConvertFrom-Json).installations | Where-Object app_slug -eq 'hcw-copilot-review-reader' | Select-Object -ExpandProperty app_id; gh variable set COPILOT_REVIEW_APP_ID --repo saulpatinojr/HCW-HybridCloudWorks --body $appId
    ```

    **Success looks like:** `gh variable list --repo saulpatinojr/HCW-HybridCloudWorks`
    shows `COPILOT_REVIEW_APP_ID` with the same integer the App page shows.
    If the first half returns nothing, the App is not yet installed on the
    organisation (step 3) — the variable would then be set empty, so check
    before moving on. If `gh api` answers `403`, the CLI token lacks the
    organisation scope: `gh auth refresh -h github.com -s admin:org`, then
    run the line again.

5. Store the private key as an **Agents** secret named
   `COPILOT_REVIEW_APP_PRIVATE_KEY`, pasting the whole `.pem` file contents
   including the `BEGIN` and `END` lines. In the repository, **Settings →
   Secrets and variables → Agents → Secrets → New repository secret** (the
   Agents tab sits beside the Actions tab at
   <https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/secrets/actions>).
   `gh secret set` cannot write this store, so this one is a browser step.
   Then delete the downloaded `.pem`; the secret is its home now.

**Success looks like:** the App listed at
<https://github.com/organizations/HybridCloudWorks/settings/installations>
as installed on one repository; `gh variable list --repo saulpatinojr/HCW-HybridCloudWorks`
shows `COPILOT_REVIEW_APP_ID`; and the secret appears under Agents with that
exact name. Both names are load-bearing: the workflow reads them verbatim and
reports "not configured" while either is missing.

### 5. Paste the MCP configuration

1. Copy the file's contents to the clipboard. PowerShell, from the
   repository root:

    ```powershell
    git checkout main; git pull origin main; Get-Content -Raw .github/copilot-mcp.json | Set-Clipboard
    ```

    The same in Git Bash, if that is the window open:

    ```bash
    git checkout main && git pull origin main && cat .github/copilot-mcp.json | clip
    ```

2. Open the repository's Copilot MCP settings. The page is reached from
   **Settings → Code, planning, and automation → Copilot → MCP servers**;
   the deep link that has carried this configuration is
   <https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/copilot/coding_agent>
   (GitHub moved the setting to a shared "MCP servers" page and says
   existing configurations were migrated; if that URL lands elsewhere, use
   the menu path).
3. In **MCP configuration**, replace whatever is in the box with the
   clipboard contents and click **Save MCP configuration**. GitHub validates
   the JSON on save.

    **Success looks like:** the page reloads with the five server names
    visible in the box and no red validation message. A failure is a
    validation error naming a key — the fix is in the file, via a pull
    request, not in the box.

4. Confirm the code-review toggle is on. Still under **Settings → Copilot**,
   open **Code review** and check **Allow Copilot to use MCP tools when
   reviewing pull requests** is enabled. It is on by default; this step is
   a read, not a change.

The Copilot firewall does not apply to MCP servers or to setup steps
([Customize the firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall)),
so no allowlist entry is needed for `learn.microsoft.com`,
`docs.mcp.cloudflare.com`, Docker Hub, npm or `management.azure.com`.

## Verify on the next pull request

1. Open or update any pull request; Copilot reviews it as it does today.
2. On the pull request timeline, the Copilot review entry has a
   **View session** link. Open it and read the **Setting up environment**
   section.

    **Success looks like:** the `copilot-setup-steps` steps listed as run,
    beginning with *Are the Azure identifiers resolvable here?* and *Warm the
    pinned MCP servers* (their presence proves the merged file is the one
    running), with *Azure Login* and *Mint a read-only App installation
    token* green. Then, in the MCP section, `terraform`, `azure` and
    `github-mcp-server` neither dropped with `MCP server "…" has no allowed
    tools after filtering` nor absent; that line, when it appears, is
    expected for `playwright`, `microsoft-learn` and `cloudflare-docs` — see
    [What the review runner keeps](#what-the-review-runner-keeps). A
    `status=connected` line alone proves little; the `[mcp] session=…
    summary` line's `invocations=` counts and the attributions in step 3 are
    the evidence a server was used. If `azure` or `github-mcp-server` is
    dropped with the login green, read the *Warm the pinned MCP servers*
    step's output first: a download or pull that failed there is the server
    that will be missing. A red *Azure Login* with an empty `with:` block
    means the runner is still executing a step list without the Agents
    reads — the file on `main` is older than this one — or step 2b's Agents
    secrets are absent; nothing is exposed either way.

3. When a review comment used a server, GitHub prints an attribution at the
   bottom of that comment naming the skill or MCP server. Not every comment
   will carry one; Copilot uses the context "when relevant". A review of a
   docs-only pull request may show none, and that is correct.

The first reviews to watch are an `infra/` change (expect Terraform Registry
and `azure` attributions — `role_assignment_list` on an `oidc.tf` change is
the canonical one) and a `functions/` change (expect Microsoft Learn).

### Verification record

One row per session log read against the list above, newest first. A row
records what a log showed, so it is written from the log, not from the
expectation; a pull request that adds a row for its own session opens as a
draft and fills the row in before it leaves draft.

| Read | Session | Setup steps | Servers | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-06 | First review after #378 merged: PR #382, Actions run 34019479901, runtime `vendored-93e753b4` | **All green, and the merged step list.** *Are the Azure identifiers resolvable here?* ran; *Azure Login* `Finished successfully` (8 s); *Warm the pinned MCP servers* warmed all three (`@azure/mcp`, both images) in 6 s; *Is the GitHub App configured?* armed; *Mint a read-only App installation token* green; *Hand the token to the GitHub MCP server* wrote the env file mode 600. `COPILOT_AGENT_INJECTED_SECRET_NAMES` listed the four identifiers and the key. | No "no allowed tools" line. `azure`, `github-mcp-server`, `microsoft-learn`, `cloudflare-docs` and `playwright` reported `connected`; `terraform` appeared in the loaded configuration but in no status line, as in the session before. Summary line: `invocations=0` for every server. | The diff was one Markdown table, so the reviewer had no reason to call a tool; zero invocations is consistent with the skill's per-component table and proves nothing about the servers either way. `terraform`'s silence is unexplained and is the open question for the next `infra/` review. What this session does prove: the Agents reads, the federated login and the App token mint all work in Copilot's runner. |

## Change or roll back

- **Change a server or tool:** edit `.github/copilot-mcp.json` in a pull
  request, then repeat step 5 after the merge. The file, not the settings
  box, is what gets reviewed — a change pasted straight into the box and not
  into the file will be overwritten by the next apply and confuse the next
  reader.
- **Widen or narrow what Azure shows:** the tool list in the file and the
  role assignments in `infra/oidc.tf` are the two dials; a wider tool with no
  role behind it fails closed, a wider role with no tool to use it is inert.
  Change both in one pull request, with the reason in the commit.
- **Turn MCP off for reviews only:** the toggle in step 5.4. The cloud agent
  keeps the servers.
- **Revoke the Azure access outright:** remove the `github_copilot_review`
  resources from `infra/oidc.tf` in a pull request (four role assignments,
  two credentials, one identity — seven destroys, the plan should show
  nothing else) and delete `COPILOT_REVIEW_CLIENT_ID`. The workflow then
  fails at login and the server fails closed.
- **Revoke the GitHub access:** uninstall or delete the App at
  <https://github.com/organizations/HybridCloudWorks/settings/installations>
  and delete the `COPILOT_REVIEW_APP_PRIVATE_KEY` Agents secret. Every token
  it ever minted dies with the installation. The `github-mcp-server` entry
  then fails closed; remove it from the file to fall back to the built-in
  server.
- **Remove everything:** clear the MCP configuration box and save. The two
  built-in servers remain.

## Related

- [ADR 0026 — required checks filter inside the job](../decisions/0026-required-checks-filter-inside-the-job.md):
  Copilot's review is advisory context for the human merge decision; the
  fourteen required contexts are unchanged by anything on this page.
- [Variables and secrets](../standards/variables-and-secrets.md) — why the
  client id is a variable and the token is the one justified secret;
  [Required inputs §4.2–4.4](../standards/required-inputs.md) — the live
  inventory of both.
- `.github/skills/code-review/SKILL.md` — the review skill Copilot loads,
  which names which server to consult per component.
- [Deployment runbook](deployment-runbook.md) — where plan evidence for
  `infra/` changes is produced, since the reviewer deliberately cannot reach
  HCP Terraform itself.

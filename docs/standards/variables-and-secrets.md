# Variables and secrets — naming and placement

[Naming-Convention](../standards/naming-convention.md) names *resources*. This page names
*values* — the variables, secrets, workspace settings and app settings that
resources are configured with — and decides where each one is stored.

Two questions, in this order:

1. **Placement.** Which of the four stores holds this value? Placement is a
   disclosure-boundary decision: it fixes who can read the value, what has to
   happen to rotate it, and which logs it can leak into. Get it wrong and no
   amount of naming discipline helps.
2. **Naming.** What is it called in that store? Naming is a legibility
   decision, and it is cheap only at creation — a name already set in HCP
   Terraform, GitHub or an app setting cannot be changed without a coordinated
   change across every consumer.

[Required inputs](../standards/required-inputs.md) is the *inventory* — what
exists, who consumes it, whether it is provisioned. This page is the *rule* that
decides where the next entry goes and what it is called. The two are meant to be
read together: the inventory records the fact, this page justifies it.

> **"CHECKLIST §n" below is a citation to a document that no longer exists.**
> `CHECKLIST.md` was the root required-input inventory until 2026-08-20, when it
> was merged into `REVIEW.md`; `REVIEW.md`'s Part 4 then became
> [Required inputs](../standards/required-inputs.md) on 2026-08-29, and
> `REVIEW.md` was deleted. Every `CHECKLIST §n` on this page is therefore a
> record of where a value was inventoried *at the time the placement was
> decided*, and it is kept for that reason rather than rewritten. **The section
> numbers do not carry across:** CHECKLIST was organised by consumer (§1
> Functions identity, §4 AI providers, §7 CI inputs) and Required inputs is
> organised by store (§4.1 the Terraform workspace, §4.2 GitHub variables, §4.6
> Key Vault). To find a value today, search Required inputs for its name.

> **This page contains no values, and must not acquire any.** It uses the
> inventory's placeholder format — `X` = letter, `0` = number, `!` = special
> character; GUIDs as `00000000-0000-0000-0000-000000000000`. That includes
> subscription, tenant and client IDs, which are identifiers rather than
> credentials but are still not published.

---

## The four stores

In precedence order. When more than one store could hold a value, the earlier
one wins.

| # | Store | Holds | Read by | Written by |
| --- | --- | --- | --- | --- |
| 1 | **Azure Key Vault** `kv-site-prod-cus-01` | Runtime application secrets | Function App managed identity, via `@Microsoft.KeyVault(SecretUri=…)` app settings. Nothing reads the vault at run time: `src/lib/secret-vault.js` can only write | A human, out-of-band, during a seeding window |
| 2 | **HCP Terraform workspace** `hcw-azure` | What Terraform needs to authenticate and to plan | The run environment and the `azurerm` / `cloudflare` providers | An operator in the workspace UI |
| 3 | **GitHub Actions variables** | Non-sensitive CI/CD configuration | `${{ vars.* }}` in workflows | `gh variable set`, or the repository settings UI |
| 4 | **GitHub Actions secrets** | Last resort — credentials to systems that offer no federation | `${{ secrets.* }}` in workflows | `gh secret set` |

The order is not arbitrary. It runs from *narrowest reader set and strongest
authentication* to *widest and weakest*:

- Key Vault values are readable only by a managed identity that must reach the
  vault over the Functions integration subnet — `network_acls.default_action`
  is `Deny` and the only VNet rule is that subnet. There is no credential to
  steal and no static reader.
- HCP Terraform workspace values are readable by anything that can start a run
  in that workspace, which is a small, named group.
- GitHub variables are readable by anyone who can read the repository — this
  one is public — and by any workflow, including ones added in a future PR.
- GitHub secrets are readable by any workflow with the right trigger. Masking
  is best-effort log redaction, not access control: a workflow that can read a
  secret can print it anywhere GitHub is not looking.

### Three outcomes that are not stores

A value that lands on one of these is *correctly placed nowhere*, and the
record of that decision is the artefact.

| Outcome | Meaning | Examples in this repository |
| --- | --- | --- |
| **Derived** | Terraform computes it from a resource it already manages, or a workflow fetches it after OIDC login. Nobody types it anywhere | `COSMOS_ENDPOINT`, `STORAGE_BLOB_ENDPOINT`, `STORAGE_ACCOUNT_NAME`, `KEY_VAULT_URI` — all set from resource attributes in `infra/functionapp.tf` |
| **Deliberately absent** | The value must *not* exist. Provisioning it changes behaviour for the worse | `COSMOS_KEY`, `AZURE_OPENAI_KEY`, `STORAGE_ACCOUNT_KEY`, `STORAGE_CONNECTION_STRING`, `COSMOS_CONNECTION_STRING` |
| **Generated in place** | The value is created on the host that consumes it and never moves | `LABS_AGENT_CERT_PATH` — the agent's private key is generated on the VPS by `lab-host/ansible` (role `labs_agent`), owned by root with group `hcw-labs-agent` and mode `0640` so the service user reads it and nobody else can, and only the public certificate is uploaded |

"Deliberately absent" is a placement outcome, not a gap, and it needs to be
written down as firmly as a real placement — otherwise the next person to see
an unset name provisions it to silence a linter. `COSMOS_KEY` is the worked
example: `connectCosmos()` uses a key only when the value is non-empty and
otherwise falls through to `DefaultAzureCredential`. An unset GitHub secret
interpolates to the empty string, so the workflow already takes the Entra path.
Setting it would switch the client to key authentication against an account
where `cosmos_local_auth_disabled = true` — key auth is off, so the "fix"
converts a working path into a rejected one. Two of the retired names
(`STORAGE_ACCOUNT_KEY`, `STORAGE_CONNECTION_STRING`) are additionally defended
by a test asserting the module cannot read them again, which is what
"deliberately absent" looks like when you want it to survive contact with a
future contributor.

### There is no fifth store

All workflows use GitHub-hosted runners. The repository has no Container Apps
runner job, runner image, Docker Hub dependency, or runner-specific secrets.

---

## Placement — the decision procedure

Ask these in order. The first question that answers `yes` decides the store;
stop there.

**Q1 — Should this value exist at all?**
If the platform offers an identity-based path to the same capability, the
credential must not be created. Cosmos with `local_auth_disabled`, Azure OpenAI
with `DefaultAzureCredential`, Storage with user-delegation SAS, and Cosmos
change-feed bindings with `__credential = "managedidentity"` all remove a secret
rather than store one.
→ **Deliberately absent.** Record the name, the reason, and what breaks if
someone provisions it.

**Q2 — Is the value generated on the machine that consumes it, and does it never
need to move?**
Private keys generated on their host are the case. Upload the public half only.
→ **Generated in place.** No store; record the file path and its permissions.

**Q3 — Can Terraform compute it from a resource it manages, or can a workflow
fetch it at run time after OIDC login?**
Endpoints, hostnames, vault URIs, account names, connection targets. A value
that can be derived must not be stored, because a stored copy is a second
source of truth that goes stale silently — and it goes stale precisely when the
resource is replaced, which is when you are least able to notice.
→ **Derived.** It appears as a resource attribute, a Terraform output, or an
`az` lookup in the workflow.

**Q4 — Is it read at run time by application code, and is it sensitive?**
→ **Store 1, Azure Key Vault.** The Function App gets it either as an app
setting holding a `@Microsoft.KeyVault(SecretUri=…)` reference, resolved by
the host before the process starts. There is no run-time read path: the
`getSecret()` route for multi-line values was deleted on 2026-08-29 (see below).
Terraform creates the vault, the RBAC and the *reference*; a human seeds the
*value*.

**Q5 — Does Terraform need it to authenticate, or as a plan input?**
→ **Store 2, HCP Terraform workspace.** Authentication values are
**Environment** variables; configuration inputs are **Terraform** variables. The
distinction is mechanical, not stylistic: an Environment variable is exported
into the run's process environment where the provider's own credential chain
reads it; a Terraform variable is bound to a `variable` block by exact name and
is invisible to anything that is not that block.

**Q6 — Does a GitHub workflow need it, and is it non-sensitive?**
Identifiers, hostnames, resource group names, public URLs, feature flags, runner
selection.
→ **Store 3, GitHub Actions variables.**

**Q7 — Is it still here?**
Then it is a credential to a system that offers GitHub no federation path.
→ **Store 4, GitHub Actions secrets**, and the CHECKLIST entry must say which
system, why federation is unavailable, and what the rotation trigger is. An
entry without that justification is a defect, not an inventory item.

---

## The hard cases

### A value that is not secret but is needed at build time by the frontend

**Store 3, always. Never store 4.**

Vite inlines every `VITE_*` variable into the bundle at build time. The value
ships to the browser and is readable with view-source. Storing it as a GitHub
secret therefore buys exactly nothing in confidentiality, and costs two real
things:

- **Log legibility.** GitHub masks a secret's value everywhere it appears in
  workflow output. A masked API base URL turns build logs, npm error messages
  and failed-request diagnostics into `***`, which is precisely the information
  you need when the build is failing. If the value is a common substring, it
  mangles unrelated lines too.
- **A false expectation.** The next reader sees `secrets.` and concludes the
  value is confidential. It is in the bundle. Now there is a documented
  disagreement between the storage mechanism and the truth, and the mechanism
  usually wins the argument.

This was exactly the `AZURE_FUNCTIONS_URL` defect (CHECKLIST §7): a public API
base URL referenced as `${{ secrets.AZURE_FUNCTIONS_URL }}` and fed straight
into `VITE_AZURE_FUNCTIONS_URL`. Fixed 2026-08-18 while the value was still
unset everywhere: the workflow now reads `${{ vars.FUNCTIONS_URL }}` — a
repository variable alongside the `VITE_*` entries five lines below it, with
the provider prefix dropped per the naming rule.

**The rule:** if the value ends up in a public artefact — a JS bundle, a
container image layer, an HTML page, a public DNS record — it is not a secret,
whatever it looks like.

### A value needed by both Terraform and a GitHub workflow

**One writer, and everything else derives.** Terraform owns the value; the
workflow obtains it. In order of preference:

1. **The workflow fetches it at run time** after `azure/login` with OIDC —
   `az functionapp show`, `az staticwebapp secrets list`, and so on. Nothing is
   stored, nothing goes stale.
2. **The Terraform output feeds a GitHub variable**, and the two names mirror
   each other exactly, per the IaC Repository Standard: output `app_hostname` →
   variable `APP_HOSTNAME`; output `client_id` → variable `CLIENT_ID`. The
   GitHub copy is a **cache**, not a source; when the resource is replaced, the
   cache is stale and the CHECKLIST entry is what tells the next person which
   side to trust.

What must not happen is the same value being typed independently into two
stores. `COSMOS_ENDPOINT` was the example: a runtime app setting derived from
the resource *and* a hand-set GitHub secret holding the same string. Since
2026-08-20 the GitHub side is the variable `vars.COSMOS_ENDPOINT`, written by
`scripts/set-github-variables.ps1` from the Terraform output, so the resource
is authoritative and the variable is its cache.

### Subscription, tenant and client IDs

**Store 3, GitHub Actions variables** — which is what the repository already
does (`vars.CLIENT_ID`, `vars.TENANT_ID`, `vars.SUBSCRIPTION_ID`).

Under workload identity federation these are identifiers, not credentials.
Possession of a client ID grants nothing. The trust decision is made by the
federated identity credential, which pins **issuer + subject + audience** —
`https://token.actions.githubusercontent.com`, `repo:<org>/<repo>:ref:…` or
`repo:<org>/<repo>:environment:production`, and
`api://AzureADTokenExchange`. A token that does not match all three is refused
with AADSTS70021 no matter who is holding the client ID.

Note the deliberate asymmetry with Terraform, where the same values are marked
`sensitive`:

| Mechanism | What it is | Why it is set the way it is |
| --- | --- | --- |
| Terraform `sensitive = true` | A log-hygiene flag — redacts the value from plan output and CI logs | Keeps subscription IDs out of run logs that get pasted into issues |
| GitHub `secrets` | A storage-and-masking mechanism with a different reader set from `vars` | Not warranted: nothing is protected, and masking a GUID that appears in error messages hurts diagnosis |

The two do not have to agree, and treating `sensitive` as a synonym for "must be
a GitHub secret" is how identifiers end up in the last-resort column.

**One documented exception: the Agents store for Copilot's runner.** The job
GitHub runs before a Copilot code review or cloud-agent session replays
`copilot-setup-steps.yml` in Copilot's own runner, and that runner resolves
no `vars.*` — observed on the first review session, PR #378, 2026-09-06,
where `azure/login` printed a `with:` block with every variable input empty.
The only store it exposes is **Agents**, and GitHub's own Azure example reads
its inputs from it with `secrets.`. So the client, tenant, subscription and
App identifiers are mirrored there as well (`COPILOT_REVIEW_CLIENT_ID`,
`COPILOT_REVIEW_TENANT_ID`, `COPILOT_REVIEW_SUBSCRIPTION_ID`,
`COPILOT_REVIEW_APP_ID` — owner step 2b, issue #381, done 2026-09-06 and
listed in [Required inputs §4.3](required-inputs.md)), and the workflow
prefers them with a fallback to the variables. They are still identifiers,
still not credentials; the store is chosen by what the reader can see, not by
what the value is. A rotation changes both copies.

### Why OIDC federation means zero long-lived cloud credentials in GitHub

Both cloud handshakes in this estate are federated, and neither has a secret:

| Handshake | Identity | Trust anchor | Created by |
| --- | --- | --- | --- |
| HCP Terraform → Azure | `id-plat-terraform-prod-cus-01` | `TFC_AZURE_PROVIDER_AUTH=true` plus federated credentials `tfc-plan` / `tfc-apply`, issuer `https://app.terraform.io` | `scripts/bootstrap-terraform-oidc.ps1`, once, outside Terraform state |
| GitHub Actions → Azure | the `github_deploy` user-assigned identity | Federated credentials on issuer `https://token.actions.githubusercontent.com`, subject-pinned to the deploy ref AND to the `production` environment, each in both the name and immutable-ID forms — four credentials | `infra/oidc.tf` |
| GitHub Copilot → Azure (read-only) | the `github_copilot_review` user-assigned identity | The same issuer, pinned to `…:environment:copilot` only, both forms — two credentials, no ref subject, so no branch-triggered workflow can assume it. Reader on the four workload groups and nothing else; the Azure MCP Server runs `--read-only` with fourteen hand-picked tools on top | `infra/oidc.tf` |
| GitHub Actions → Azure (read-only) | the `github_reader` user-assigned identity | The same issuer, but pinned to the deploy **ref only**, in both forms — two credentials, no environment subject. That asymmetry is load-bearing: a reader workflow that declares `environment:` presents `…:environment:<name>` instead of `…:ref:<ref>` and is refused with AADSTS700213, which is why `verify-alert-state.yml` and `monitor-functions-registered.yml` each carry a header saying not to add one | `infra/oidc.tf` |
| GitHub Actions → Azure (one job each) | the `github_alert_reader` (#1053) and `github_manifest_window` (#1098) user-assigned identities | The reader's trust exactly: the deploy ref only, both forms, two credentials each. The client-id a job sends picks the identity. The alert reader reads alert rules and action groups; the manifest window writes the Function App's config and lists nothing, so the reader no longer holds a write beside its app-settings read | `infra/oidc.tf` |

Neither mints anything longer-lived than a per-run token. So the **correct count
of Azure credentials in GitHub Actions secrets is zero**, and that is a
falsifiable property of the repository rather than an aspiration — any Azure
client secret, storage key, Cosmos key or deployment token appearing in store 4
is a defect by definition, because a federated path to the same capability
already exists and is already wired.

What that implies for store 4: it may only hold credentials to systems that are
**not Azure** and offer **no federation from GitHub**. Today that is HCP
Terraform and Firebase — two external systems, each with a named reason.
Qlty Cloud's coverage upload (`.github/workflows/coverage.yml`, #568) stores
nothing: it authenticates with GitHub OIDC (`oidc: true`), so there is no
`QLTY_COVERAGE_TOKEN` secret.
`AZURE_STATIC_WEB_APPS_API_TOKEN` fails this test on its first word.

### Secrets that must never transit Terraform state, and why Key Vault is seeded out-of-band

Terraform state is a **plaintext record of every value the configuration
touched**. `sensitive = true` redacts console output; it does not encrypt state.
Two consequences:

- **Never manage a secret value with `azurerm_key_vault_secret`.** The value
  would be written into state, and state lives in HCP Terraform — a third-party
  SaaS. That widens the disclosure boundary from "Azure RBAC on one vault" to
  "Azure RBAC + everyone who can read state + every plan diff + every run log".
- **Never read a secret back with `data.azurerm_key_vault_secret`.** The read
  value lands in state too, so using Key Vault as Terraform's secret source
  moves the secret *into* the place you were trying to keep it out of. This is
  why `cloudflare_api_token` is an HCP Terraform workspace variable rather than
  a vault lookup: as a provider argument it is never persisted to state, and a
  data-source read would be.

The vault's network posture makes the same point independently. `network_acls`
is `default_action = "Deny"` with one VNet rule, for the Functions integration
subnet. HCP Terraform's runners are neither in that VNet nor a trusted Azure
service, so the `Key Vault Secrets Officer` assignment on the Terraform executor
**cannot actually write a secret from a run**. The seeding path is the one the
configuration is built for: populate `admin_ip_rules`, apply, run
`az keyvault secret set` as a human, empty `admin_ip_rules`, apply again. Empty
is the correct steady state.

The division of labour is therefore fixed: **Terraform owns the vault, the RBAC,
the network rules, and the `@Microsoft.KeyVault(…)` references. A human owns the
values.** Rotation does not require a Terraform run at all.

**Since 2026-08-29 a human owns them through the admin portal.** Admin →
Platform → API Keys lists every declared secret in sections, with a light each,
and writes a pasted value straight to the vault. The app is inside the
integration subnet the vault already admits, so nothing has to open a firewall.
It holds a custom role with one data action — `setSecret` — so it can create a
new version and cannot read, delete or purge; the page has no read path to
render a value through even if someone added one. `az keyvault secret set` from
a desktop, through `scripts/cutover/06-seed-secret.ps1`, remains the break-glass
route for when the app itself is the thing that is broken. It accepts only a
name some app setting in the `infra/` module references, read from every `.tf`
file there. From the split of `main.tf` (#269) until 2026-09-29 it read
`main.tf` alone, found none, and stopped before doing anything (#814). CI now
runs its tests, so a file move cannot break it silently again.

### Multi-line and oversized secrets

**There are none left, and the run-time read path was deleted with them
(2026-08-29).** This section used to describe two: the GCP service-account JSON
(~2.3 KB, multi-line) and `GITHUB-APP-PRIVATE-KEY` (an RSA PEM). App settings
are visible in the portal and in `az webapp config appsettings list`, and
multi-line values survive that round trip badly, so both were read at run time
through `functions/src/lib/key-vault.js` — a vault SDK client, a `KEY_VAULT_URI`
setting and a data-plane RBAC grant, serving two callers.

Then one of them stopped being multi-line and the other turned out to have no
caller at all. GCP pricing reads the Cloud Billing Catalog API, which Google
documents as API-key authenticated: a single string, now the app setting
`GCP_BILLING_API_KEY` holding an ordinary vault reference. `GITHUB-APP-PRIVATE-KEY`
is read by nothing in the ported code. `key-vault.js` had zero call sites after
the first change, so it is gone, and with it `@azure/keyvault-secrets`,
`google-auth-library` and `KEY_VAULT_URI`. `KEY_VAULT_URI` came back later
for one purpose: the API Keys page writes through `secret-vault.js`, which
sets a secret and cannot read one.

The rule that remains is simpler than the one it replaces: **every secret is an
app setting holding a `@Microsoft.KeyVault(SecretUri=…)` reference, resolved by
the host before the process starts.** No exceptions, which is what makes
`app-settings-secrets.test.js`'s allowlist empty. A value too large or too
multi-line for an app setting is a reason to reconsider the value — as it was
here, twice — before it is a reason to reintroduce a run-time vault client.

---

## Placement matrix — every value in CHECKLIST, classified

### Store 1 — Azure Key Vault

Seeded by hand; referenced from `infra/functionapp.tf` app settings as
`@Microsoft.KeyVault(SecretUri=…)`.

| Value | CHECKLIST | Why store 1 |
| --- | --- | --- |
| `CF-ORIGIN-SECRET` | §3 | Runtime shared secret proving a request came via Cloudflare; the anonymous submission path depends on it |
| `CLIENT-IP-SALT` | §3 | Runtime salt for quota keys; rotating it resets live counters, so rotation must not need a Terraform run |
| `AWS-ACCESS-KEY-ID`, `AWS-SECRET-ACCESS-KEY` | not inventoried | Third-party static credentials — AWS offers the Function App no federation here. Scope the IAM policy to `pricing:GetProducts` only |
| `GEMINI-API-KEY` | §4 | Public Generative Language API, NOT Vertex — Vertex needs GCP ADC the Function App cannot hold. First in provider preference order since 2026-08-23. Unseeded resolves to the literal `@Microsoft.KeyVault(...)`, which the router reads as no key, so it falls through to OpenAI |
| `ANTHROPIC-API-KEY`, `OPENAI-API-KEY`, `REPLICATE-API-KEY` | §4, partially | Third-party SaaS keys. Distinct from Azure OpenAI, which is keyless. `REPLICATE-API-KEY` is a media key, not a text one: image generation reads it (`MEDIA_KEY_ENV` in `functions/src/lib/ai/router.js`), and so does the Replicate MCP policy (`mcp-policy.js`). `PERPLEXITY-API-KEY` was retired on 2026-10-09 (#1029): nothing read it, so its app setting, catalogue entry and Integrations card went, and the secret is the owner's to delete (below) |
| `FIRECRAWL-API-KEY`, `LINKIE-API-KEY`, `YOUTUBE-API-KEY` | not inventoried | Third-party SaaS keys |
| `PUBLER-API-KEY`, `PUBLER-WORKSPACE-ID` | not inventoried | The `-ID` value is an identifier rather than a credential, but it travels with its key and splitting them across stores buys nothing |
| `RESEND-API-KEY` | not inventoried | Newsletter list and sending (ADR 0030), replacing Klaviyo's two secrets. A Full access key; a sending-access key cannot manage contacts or broadcasts |
| `PODBEAN-CLIENT-ID`, `PODBEAN-CLIENT-SECRET` | not inventoried | Podcast publishing to Podbean (ADR 0029 §1c, #437), from a developer app at `https://developers.podbean.com/`. The `-ID` is an identifier that travels with its secret, as above; the server exchanges the pair for a short-lived access token and never sends either to a browser. They replaced the two RSS.com secrets on 2026-10-13, which were never seeded, so the vault holds nothing of RSS.com's to delete |
| `TELEGRAM-BOT-TOKEN`, `TELEGRAM-CHAT-ID` | not inventoried | As above |
| `QLTY-API-TOKEN` | not inventoried | Qlty personal access token for the Health Hub's Code and Security summary (#569, `lib/code-quality/qlty-summary.js`). Sent only as a Bearer header to `api.qlty.sh`; the summary route returns counts and paths, never finding text |
| `GITHUB-APP-INSTALLATION-ID`, `HOSTINGER-API-TOKEN` | not inventoried | **Read by nothing** (#1029, 2026-10-09): no app setting in `infra/` references either, and no code reads them. They were named for a site rebuild trigger and VPS control that never arrived here; Hostinger is reached through its hosted MCP server's OAuth connection (`hostinger-mcp`, `functions/src/lib/ai/mcp-oauth.js`), whose tokens live on its `mcp_servers` record, not in the vault. Whether they exist in the vault is unconfirmed, because a session holds no data-plane role; if they do, the owner deletes them (below) |
| `GCP-BILLING-API-KEY` | not inventoried | Cloud Billing Catalog API key for the public GCP price list — Google's documented auth for it. Replaced a ~2.3 KB service-account JSON on 2026-08-29 |
| `GITHUB-APP-PRIVATE-KEY` | not inventoried | Multi-line PEM. **Not referenced by any app setting in `infra/` and read by nothing** — it has no app setting and no seeding path, deliberately. Like the two above, unconfirmed in the vault, and the owner's to delete if it is there (below) |
| `TURNSTILE-SECRET-KEY` | not inventoried | Cloudflare Turnstile secret key for the Landing Zone Builder's "Validate on the lab" ([ADR 0032](../decisions/0032-learner-labs-platform.md), amendment of 2026-09-28), sent only to Cloudflare's siteverify. Its site key is public and is store 3 (`VITE_TURNSTILE_SITE_KEY`). The widget is created in the Cloudflare dashboard rather than as `cloudflare_turnstile_widget`, because that resource's read-only `secret` attribute would put this value in state, the rule in the next section |
| `CLOUDFLARE-ANALYTICS-TOKEN` | not inventoried | Read-only Cloudflare API token (Account → Account Analytics → Read, the HybridCloudWorks account only) the `ambassadorAudienceMonthly` timer reads the previous month's page views with (#1302), sent only as a Bearer header to Cloudflare's GraphQL endpoint. Store 1 and not store 2: the workspace's `cloudflare_api_token` writes DNS and account settings, and the Function App must never hold that one, so a second token that can only read is the least the read can run on. The site tag and account id beside it are identifiers Terraform writes as plain app settings, not secrets |

`infra/functionapp.tf` declares **31** `@Microsoft.KeyVault` references and no
run-time reads (2026-10-20: 29 on 2026-10-09 after #1029 removed the Perplexity
one, thirty on `main` before #1302 once the StreamYard and Podbean names had
arrived (#1101, #1117), thirty-one with `CLOUDFLARE-ANALYTICS-TOKEN`; setting
lines only, since comments in the module mention the form too, and
`secret-catalog.test.js` holds the catalogue to the same 31).
CHECKLIST §1–§8 inventories a handful of them. That gap is recorded below
rather than papered over.

**Deleting a secret nothing reads (#1029).** Four names above are read by
nothing: `PERPLEXITY-API-KEY`, `GITHUB-APP-INSTALLATION-ID`,
`HOSTINGER-API-TOKEN` and `GITHUB-APP-PRIVATE-KEY`. Deleting one is the
owner's, from an account with a data-plane role on the vault, and comes after
the `hcw-azure` run that drops the Perplexity reference, never before, so no
app setting ever points at a deleted secret. One line per name, PowerShell:

```powershell
az keyvault secret delete --vault-name kv-site-prod-cus-01 --name PERPLEXITY-API-KEY
```

```powershell
az keyvault secret delete --vault-name kv-site-prod-cus-01 --name GITHUB-APP-INSTALLATION-ID
```

```powershell
az keyvault secret delete --vault-name kv-site-prod-cus-01 --name HOSTINGER-API-TOKEN
```

```powershell
az keyvault secret delete --vault-name kv-site-prod-cus-01 --name GITHUB-APP-PRIVATE-KEY
```

Success prints the deleted secret's JSON, with a `recoveryId`. `SecretNotFound`
means it was never seeded, which is just as good. The vault keeps a deleted
secret for its soft-delete period, so `az keyvault secret recover` undoes a
mistake until then.

### Store 2 — HCP Terraform workspace

**Environment** variables — how the run authenticates. All four names are
dictated by HashiCorp and Microsoft and are contractual.

| Value | CHECKLIST | Kind | Why store 2 |
| --- | --- | --- | --- |
| `TFC_AZURE_PROVIDER_AUTH` | §8 | Environment | Switches the workspace to dynamic provider credentials; absent, no OIDC token is minted at all |
| `TFC_AZURE_RUN_CLIENT_ID` | §8 | Environment | The identity HCP Terraform assumes. Distinct from §7 `CLIENT_ID`, which is the GitHub Actions identity |
| `ARM_TENANT_ID` | §8 | Environment | Read by the `azurerm` credential chain, not by a `variable` block |
| `ARM_SUBSCRIPTION_ID` | §8 | Environment | Provider fallback only — `providers.tf` sets `subscription_id` explicitly on all four provider blocks, and the explicit value wins |

**Terraform** variables — plan inputs, bound by exact name to
`infra/variables.tf`. These are the ones with no default:

| Value | Why store 2 | `sensitive` |
| --- | --- | --- |
| `subscription_app`, `subscription_mgmt`, `subscription_conn` | Provider targets. No defaults on purpose: a wrong guess deploys the workload into a platform subscription, so an unset value must fail the plan. There is deliberately no `subscription_ident` — the Identity zone is empty, so an alias for it would be an unused declaration and one more value that has to be right before a plan can run | yes (log hygiene) |
| `entra_tenant_id` | Feeds the `ENTRA_TENANT_ID` app setting and JWT validation | yes (log hygiene) |
| `entra_api_audience` | Validated as the JWT `aud`. Empty silently disables audience validation, hence the non-empty validation block | no |
| `cloudflare_api_token` | A genuine credential, and the reason it is here rather than in Key Vault: as a provider argument it never enters state, whereas a vault data-source read would put it there. Since #1302 it also carries Account → Account Settings → Write, for the Web Analytics site; the token the Function App reads the figures with is a different, read-only one in store 1 (`CLOUDFLARE-ANALYTICS-TOKEN`) | yes |
| `cloudflare_zone_id` | Identifier | no |
| `budget_alert_email` | Notification target | no |
| `admin_ip_rules`, `cosmos_admin_ip_rules`, `functions_storage_admin_ip_rules` | Populated only for a seeding or inspection window; empty is the steady state | no |

Most of the rest of `infra/variables.tf` has a default and needs no workspace
entry. Nine are the exception, and they are the ones an operator actually
reaches for. Each but one carries the *safe* value as its default, so the
unsafe or armed value is a deliberate workspace edit and the default is the
rollback. The one is `labs_public_submission_enabled`, which carries the
posture the owner decided, the way `functions_origin_lock_enabled` does; its
rollback is `false` in the workspace:

| Value | Default | Why it is a workspace entry |
| --- | --- | --- |
| `schedulers_master_enabled` | `false` | Master kill switch for every catalogued timer — it is what `FEATURE_FLAG_SCHEDULERS` is set from. A hardcoded literal until 2026-08-24, which meant no timer could be armed without a code change and nothing said so |
| `newsletter_sending_enabled` | `false` | Whether approving a weekly newsletter issue sends it through Resend — it is what `NEWSLETTER_SENDING_ENABLED` is set from. Off, approval is refused before Resend is called ([ADR 0030](../decisions/0030-newsletter-provider.md) §2a) |
| `labs_public_submission_enabled` | `true` | Whether the Landing Zone Builder's "Validate on the lab" may queue a public job — it is what `LABS_PUBLIC_SUBMISSION_ENABLED` is set from ([ADR 0032](../decisions/0032-learner-labs-platform.md) decision 6, revised 2026-09-28). Even on, nothing is taken until `TURNSTILE-SECRET-KEY` resolves, and only from the site's pane. `false` is the kill switch |
| `enabled_timers` | `[]` | Which timers are armed, by flag suffix. Arming one needs **both** this and the master switch. An unrecognised name fails the plan rather than silently arming nothing |
| `availability_test_enabled` | `false` | Runs the `/api/health` availability test. Off until the Cloudflare side is settled: Bot Fight Mode serves datacenter clients a 403, so arming it first would create a permanently-firing alert |
| `availability_probe_alert_enabled` | `false` | The alert on the Cloudflare Worker reachability probe ([ADR 0024](../decisions/0024-edge-availability-probe.md)). It fires on *missing* probe successes, so flipping it before the Worker is deployed and observed writing `success == 1` rows creates a rule that fires immediately and permanently |
| `cosmos_export_enabled` | `false` | Arms the Cosmos exporter timer (`FEATURE_FLAG_COSMOS_EXPORT`) and creates its two missing-run alert rules in one flip ([ADR 0028](../decisions/0028-cosmos-out-of-account-export.md)). One variable for both so the alert cannot exist without the exporter. Flip it Monday to Saturday, after the exporter code is deployed and has been seen emitting `cosmosExportCompleted` |
| `storage_shared_access_key_enabled` | `false` | Shared-key auth on the content and Functions host accounts. False is the intended posture — both consumers use Entra — and `true` is the one-variable rollback if a key path turns out to be needed |
| `cloudflare_account_id` | `null` | The Cloudflare account that owns the zone, an identifier (#1302). Null leaves `cloudflare_web_analytics_site` uncreated, its two outputs null and the `CF_WEB_ANALYTICS_SITE_TAG` and `CF_ACCOUNT_ID` app settings empty, so the monthly audience read stays off; set, the site is created and the read can run. Defaulted rather than required because a required variable would fail every plan until typed in, for a resource no visitor-facing path depends on. The same value as the `CLOUDFLARE_ACCOUNT_ID` repository variable (store 3) |

Everything else there is a default nobody is expected to override.

### Store 3 — GitHub Actions variables

| Value | CHECKLIST | Why store 3 |
| --- | --- | --- |
| `CLIENT_ID` | §7 | Identifier under WIF; grants nothing without a matching federated subject |
| `READER_CLIENT_ID`, `ALERT_READER_CLIENT_ID`, `COPILOT_REVIEW_CLIENT_ID` | §7 | Identifiers for the read-only identities (`github_reader`; `github_alert_reader`, which reads alert rules; `github_copilot_review`, which Copilot code review signs in as) — same reasoning |
| `MANIFEST_WINDOW_CLIENT_ID` | §7 | Identifier for `github_manifest_window`, which opens and closes `publish-content-manifest.yml`'s origin window (#1098) — same reasoning |
| `COPILOT_REVIEW_APP_ID` | — | App ID of the read-only GitHub App Copilot code review reads GitHub with. An identifier, exactly like `MANIFEST_APP_ID`; the key is in store 4 |
| `TENANT_ID` | §7 | Identifier |
| `SUBSCRIPTION_ID` | §7 | Identifier |
| `APP_HOSTNAME` | §7 | Public DNS name. Mirrors the `function_hostname` output |
| `RESOURCE_GROUP` | §7 | Resource group name for the T-503 firewall window. Must equal the `resource_group_name` Terraform value |
| `FUNCTIONS_STORAGE_ACCOUNT` | §7 | An account name, not a key. Three words to break the collision with the content storage account, which the standard permits |
| `VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_TENANT_ID` | §6, §7 | Public-client registration values that ship in the bundle |
| `VITE_SOCIAL_X_URL`, `VITE_SOCIAL_LINKEDIN_URL`, `VITE_SOCIAL_GITHUB_URL` | §6, §7 | Public URLs |
| `VITE_TRANSLATIONS`, `VITE_DEFAULT_LANGUAGE` | §6 | Feature flags in a public bundle (`VITE_NEWS_ENABLE_INSIGHTS` was retired with the insights panel on 2026-09-05, T-765) |
| `VITE_TURNSTILE_SITE_KEY` | — | The Cloudflare Turnstile site key for "Validate on the lab". Public by construction (Cloudflare renders it into the page), so store 3 by the rule above; the matching secret key is store 1, `TURNSTILE-SECRET-KEY`. Set by hand from the Cloudflare dashboard, since Terraform does not manage the widget |
| `CF_WEB_ANALYTICS_TOKEN` | — | The Cloudflare Web Analytics site token the frontend build puts in every page's beacon as `VITE_CF_WEB_ANALYTICS_TOKEN` (#1302). Public by nature (it ships in the page, and the Cloudflare API authenticates with an API token, which this is not), so store 3 by the rule above; the read-only token that reads the figures back is store 1, `CLOUDFLARE-ANALYTICS-TOKEN`. A Terraform output (`web_analytics_site_token`), copied by hand until `scripts/set-github-variables.ps1` learns it |
| `DOCKERHUB_CONNECTION`, `DOCKERHUB_ENABLED` | — | The ID of the Docker OIDC connection `publish-lab-image.yml` signs in to Docker Hub through, and the switch that runs that job (#779). An identifier and a flag, so store 3: the connection trusts one GitHub subject, so the ID grants nothing on its own, which is the same reasoning as `CLIENT_ID`. Two words each, `DOCKERHUB` naming the system as `COPILOT_REVIEW_` does. The workflow maps the first onto `DOCKERHUB_OIDC_CONNECTIONID`, the contractual environment variable `docker/login-action` reads. Set by hand, since Docker Home, not Terraform, creates the connection ([Required inputs](required-inputs.md) §4.11) |

### Store 4 — GitHub Actions secrets, with justification

Every entry states which system it authenticates to and why federation is not
available. An entry that cannot answer both belongs in store 3 or nowhere.

| Value | CHECKLIST | Target system | Justification | Verdict |
| --- | --- | --- | --- | --- |
| `GITHUB_TOKEN` | — | GitHub | Injected per-run by GitHub, scoped by `permissions:`, expires with the job. Not stored by us at all | Correct, and contractual |
| `COPILOT_REVIEW_APP_PRIVATE_KEY` (Agents store, not Actions) | — | GitHub, read-only, this repository | Authenticates GitHub → *GitHub* for the MCP server Copilot code review uses, to reach the Actions, code-scanning, Dependabot and discussions toolsets the built-in per-review token cannot be given. The same shape as `MANIFEST_APP_PRIVATE_KEY`: a GitHub App's key, from which `copilot-setup-steps.yml` mints a one-hour installation token per session. The App holds eight **read** permissions on one repository and nothing else, so the key's ceiling is read-only — a leaked key mints nothing a leaked token would not already grant. **No personal access token, classic or fine-grained, is used**: those are user-bound and long-lived, and store 4 holds none | Justified — the one stored key in the Copilot configuration, and it can only ever produce read-only, one-hour tokens |
| `TFC_TOKEN` | §7 | HCP Terraform | Authenticates GitHub → *Terraform*, the reverse direction from §8. The HCP Terraform API has no inbound GitHub OIDC path. Read by `tfc-plan-check.yml`, which holds a plan to the permanent diff, and by `deploy-functions.yml`, which refuses to deploy while an apply is in flight (#454). Use a **team** token, not a user token, so it survives the user leaving | Justified |
| `MANIFEST_APP_PRIVATE_KEY` | — | GitHub, this repository | A GitHub App's key, with `vars.MANIFEST_APP_ID`. `scripts/github-app-token.mjs` mints a one-hour installation token from it and revokes it after use, for the four workflows that push a branch and open a pull request. The App is what lets those pull requests run CI, which a `GITHUB_TOKEN`-opened one does not | Justified |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | §7 | Google Cloud | Source-side credential for the one-shot Firestore export, for a system being decommissioned | **Deleted** — the migration completed and `migrate-data.yml` went with it (`59e471b`); the repository holds no such secret |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | §7 | **Azure** | None needed — see below | **Resolved 2026-08-30** — minted from ARM per run, secret deleted 2026-08-31 (T-727) |
| `AZURE_FUNCTIONS_URL` | §7 | — | A public API base URL | **Resolved 2026-08-18** — now `vars.FUNCTIONS_URL`, store 3 |
| `COSMOS_ENDPOINT` (GitHub-side) | §7 | — | A public hostname; with `local_auth_disabled = true` it grants nothing | **Resolved 2026-08-20** — now `vars.COSMOS_ENDPOINT`, store 3 |
| `COSMOS_KEY` | §7 | — | Must stay unset | Correctly absent |

### Not in any store

| Value | CHECKLIST | Outcome |
| --- | --- | --- |
| `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `STORAGE_ACCOUNT_NAME`, `STORAGE_BLOB_ENDPOINT`, `STORAGE_QUEUE_ENDPOINT`, `KEY_VAULT_URI` (app settings) | §2, §4 | Derived — set from resource attributes in `infra/functionapp.tf` |
| `AZURE_OPENAI_ENDPOINT` | §4 | Deliberately absent. Every model call goes to a provider's own API with a key from Key Vault, and there is no Azure OpenAI account (`infra/functionapp.tf`, the AI generation comment) |
| `NODE_ENV`, `REGION_NAME`, `WEBSITE_SITE_NAME` | §5 | Host-provided, or a literal in `infra/functionapp.tf` |
| `FEATURE_FLAG_SCHEDULERS` and the per-timer flags | §5 | Derived from store 2 Terraform variables — `schedulers_master_enabled` for the master flag, `enabled_timers` for the per-timer flags via `local.timer_flags`. The live value of each is whatever the latest `hcw-azure` apply set: a timer runs only when the master flag is on and its name is in `enabled_timers`. Until 2026-08-24 the master flag was a **literal** in `main.tf`, as this row used to say; that is what made all 18 timers permanent no-ops regardless of `enabled_timers` |
| `ENTRA_TENANT_ID`, `ENTRA_API_AUDIENCE` (app settings) | §1 | Derived from store 2 Terraform variables |
| `CF_WEB_ANALYTICS_SITE_TAG`, `CF_ACCOUNT_ID` (app settings) | — | Derived — the first from `cloudflare_web_analytics_site.hcw[0].site_tag`, the second from the store 2 variable `cloudflare_account_id` (#1302); both empty strings while that variable is null. Identifiers in the Cloudflare API path, not credentials |
| `STORAGE_ACCOUNT_KEY`, `STORAGE_CONNECTION_STRING`, `COSMOS_CONNECTION_STRING` | §2 | Deliberately absent; two are test-enforced |
| `COSMOS_KEY` | §7 | Deliberately absent |
| `AZURE_OPENAI_KEY` | §4 | Deliberately absent — see below |
| `LABS_AGENT_CERT_PATH` | §2b | Generated in place on the VPS |
| `LABS_AGENT_*` (the rest), the `LabAgent` app role, `lab_agents/{agentId}` | §2b | Host-local configuration and Entra/Cosmos objects, outside all four stores. The agent holds no database credential by design |
| `production-infra` | §7b | A GitHub Environment — a protection gate, not a value. `data-migration` was listed here too, described as an OIDC subject that could not be renamed without breaking login with AADSTS70021. That stopped being true on 2026-08-26 (T-524), when its two federated credentials were removed after `migrate-data.yml` was deleted in `59e471b`; the environment itself was deleted on 2026-08-30. Nothing in Azure trusts the subject and nothing in the repository declares the environment |

---

## Placement errors in the current configuration

Five, ranked by how much they mislead a reader, found in August. **None is open
any more** (re-checked 2026-09-29, #819): 1, 2 and 3 were resolved, 4 never
applied, and 5 is moot. Each entry keeps its reasoning, because the rule it
illustrates still holds.

**1. `AZURE_STATIC_WEB_APPS_API_TOKEN` was a long-lived Azure credential in
store 4 — resolved 2026-08-30 (T-727).** `deploy-azure-frontend.yml` now
fetches the token with `az staticwebapp secrets list` after `azure/login` on
each run, the secret was deleted on 2026-08-31, and the `swa_token` output is
retired (`infra/outputs.tf`). The original finding: by the zero-credentials rule this cannot be right: it is an Azure
deployment key, statically stored, with no expiry and no subject pinning, in the
store with the widest reader set. The workflow already authenticates to Azure
with OIDC elsewhere. Correct placement is **derived** — fetch the token at
deploy time with `az staticwebapp secrets list` after `azure/login`, and store
nothing. Two notes on the current state: the pinned
`Azure/static-web-apps-deploy` action takes only a deployment token as input, so
the fetch-then-pass shape is what removes the stored copy; and `infra/outputs.tf`
exposes the same token as the `swa_token` output, which means the value is also
in Terraform state — if the run-time fetch lands, that output has no remaining
consumer and should go with it.

**2. `AZURE_FUNCTIONS_URL` was a public URL in store 4 — resolved 2026-08-18.**
It fed `VITE_AZURE_FUNCTIONS_URL`, which is inlined into the public bundle, so
nothing was being protected — and masking it made every build-time API failure
read as `***`. The workflow now reads `${{ vars.FUNCTIONS_URL }}` (store 3,
provider prefix dropped per the naming rule). The rename was safe-now: the
value was unset everywhere when it happened. The variable itself remains to be
provisioned (CHECKLIST §7).

**3. `COSMOS_ENDPOINT` was in store 4 on the GitHub side — resolved
2026-08-20.** It is now the variable `vars.COSMOS_ENDPOINT` (store 3), and
`migrate-data.yml`, named below, is deleted. The original finding: an account endpoint
is a public hostname, derivable from the account name, and with
`cosmos_local_auth_disabled = true` it grants nothing to whoever reads it.
Correct placement is **derived** — `heal-computed-properties.yml` and
`migrate-data.yml` both run after `azure/login`, so
`az cosmosdb show --query documentEndpoint` removes the entry entirely. Store 3
is the acceptable fallback if a lookup is judged too slow.

**4. Docker Hub runner credentials are not used.** The runner-image workflow and
the Container Apps runner job were removed; no Docker Hub secrets belong in this
repository. Publishing the lab images to Docker Hub (#779) keeps that true: it
signs in through a Docker OIDC connection, so the only Docker values stored
are the connection's ID and an on/off switch, both store 3.

**5. `AZURE_OPENAI_KEY` was inventoried in CHECKLIST §4 as `Required: Yes`,
source Key Vault — now moot.** Under T-506 the configuration decided the
opposite: Azure OpenAI was keyless, with only an endpoint set. Since then Azure
OpenAI has gone entirely. Every model call goes to a provider's own API with a
key from Key Vault, there is deliberately no `AZURE_OPENAI_ENDPOINT`
(`infra/functionapp.tf`), and `lib/openai-client.js` no longer exists. The
placement stands: **deliberately absent**, in the same category as
`COSMOS_KEY`.

Two record-keeping gaps, which are not misplacements but do make the inventory
unusable as a seeding checklist:

- **The Key Vault contents are under-inventoried.** The Function App's
  settings declared 21 `@Microsoft.KeyVault` references on 2026-08-29, then in
  `main.tf` and in `infra/functionapp.tf` since the split (#269); CHECKLIST
  §1–§8 lists only a few of them.
  Every one of those resolves to empty until seeded, and an unseeded reference
  fails at *first invocation in production*, not at deploy — the failure mode
  the vault seeding runbook exists to prevent. `/api/health` now reports
  `unresolvedSecrets` as a count, which turns that class of failure into one
  number, but nothing alerts on it yet. **The inventory gap itself closed on
  2026-08-29**: `functions/src/lib/secret-catalog.js` lists every one with a
  section, a label and a description, CI asserts it against the `infra/`
  module pair by pair, and the portal's API Keys page renders it with a live status per
  secret — so the inventory this section calls missing now exists, in code,
  where it cannot go stale without failing a build.
- **There is no longer a second way in.** This entry used to record that
  `functions/src/lib/key-vault.js` had exactly one call site — `gcp.js`, for the
  service-account JSON — and that its failure mode was different from every
  other secret's: an app-setting reference fails the whole app at startup,
  whereas that one path failed only GCP pricing, and only when that tool was
  invoked, so a missing value was invisible until a specific feature was used.
  That asymmetry is gone. The module was deleted on 2026-08-29 when its one
  caller moved to an API key, so every secret now has the same, louder failure
  mode.

Nothing in this section renames a value that is currently set. `CLIENT_ID`,
`TENANT_ID`, `SUBSCRIPTION_ID`, `APP_HOSTNAME` and `RESOURCE_GROUP` are set and
keep their names; everything proposed for a move is `Missing` today.

---

## Naming

### The core rules

Carried from the [IaC Repository Standard](../standards/iac-repository-standard.md), and
unchanged by this page:

| Rule | Example |
| --- | --- |
| **Max 2 words.** A third only to break a real collision | `CLIENT_ID`, `TENANT_ID`, `APP_HOSTNAME`; `FUNCTIONS_STORAGE_ACCOUNT` vs the content account |
| **Casing follows the store; the word count does not** | `CLIENT_ID` (GitHub) ↔ `client_id` (Terraform output) |
| **No provider prefixes.** One platform, so say what the value *is* | `client_id`, not `azure_deploy_client_id` |
| **A name that crosses stores mirrors itself** | output `app_hostname` → variable `APP_HOSTNAME` |
| **Apply at creation.** Renaming a set value is a coordinated one-PR change across the setting and every consumer | — |

One rule this page adds: **name the value, not its plumbing.** `COSMOS_ENDPOINT`
describes what it is; `MIGRATION_COSMOS_TARGET_ENDPOINT_SECRET` describes how it
got there, and stops being true the moment the plumbing changes.

### Per store

| Store | Casing | Separator | Example | Platform limits that bite |
| --- | --- | --- | --- | --- |
| Terraform variable / output | `lower_snake_case` | `_` | `client_id`, `entra_api_audience` | Must be a valid HCL identifier |
| HCP Terraform, **Terraform** kind | Identical to the `variable` block name | `_` | `subscription_app` | A key that matches no `variable` block is **silently ignored** — no error, just an unset variable and a confusing plan |
| HCP Terraform, **Environment** kind | `UPPER_SNAKE_CASE` | `_` | `ARM_TENANT_ID` | Must match exactly what the tool reads; all four are contractual |
| Azure Key Vault secret | `UPPER-KEBAB-CASE` | `-` | `CF-ORIGIN-SECRET` | 1–127 characters, **alphanumerics and hyphens only** — no underscores, ever |
| Function App app setting | `UPPER_SNAKE_CASE`, matching `process.env.X` | `_` | `CF_ORIGIN_SECRET` | `__` is a **reserved hierarchy separator** (`COSMOS_CONNECTION__accountEndpoint`) — never use it for word separation |
| GitHub Actions variable | `UPPER_SNAKE_CASE` | `_` | `APP_HOSTNAME` | Alphanumerics and `_` only; must not start with a number; must not start with `GITHUB_`; names are case-insensitive |
| GitHub Actions secret | `UPPER_SNAKE_CASE` | `_` | `TFC_TOKEN` | Same restrictions as variables, and a secret and a variable must not share a name |
| Container Apps job secret | `lower-kebab-case` | `-` | `gh-app-private-key` | Lowercase alphanumerics and `-`; must start and end alphanumeric |
| GitHub Environment | `lower-kebab-case` | `-` | `production` | Not a value, but load-bearing WHILE a federated credential pins it: the environment name appears verbatim in the OIDC subject, so renaming one that is pinned breaks login with AADSTS70021. `production` is pinned today (`infra/oidc.tf`). `data-migration` was the example here until 2026-08-30, by which point nothing pinned it and it had been deleted — an environment is immutable only for as long as a credential names it |

### The Key Vault ↔ app setting transform

Key Vault secret names cannot contain underscores. Application code reads
`process.env.CF_ORIGIN_SECRET`. Both constraints are fixed, so the mapping is
mechanical and there is no per-secret decision to make:

```
app setting name    CF_ORIGIN_SECRET
                    │  uppercase; underscores → hyphens
                    ▼
Key Vault secret    CF-ORIGIN-SECRET
                    │
                    ▼
app setting value   @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/CF-ORIGIN-SECRET)
```

State it once and every future secret names itself. The alternative — deciding
per secret — produces `CF_ORIGIN_SECRET` next to `cfOriginSecret` next to
`cf-origin-secret` in the same vault, and a `getSecret()` call that 404s in
production while every test passes.

Omitting the version from the `SecretUri` is deliberate: the app picks up a
rotated value without a Terraform run, which is what makes rotation an
`az keyvault secret set` rather than a deployment.

### Contractual names — exempt, and never renamed

A name is contractual when **something outside this repository decides it**.
Renaming it does not produce a differently-named working system; it produces a
broken one, usually silently.

| Name | Dictated by | What breaks if renamed |
| --- | --- | --- |
| `TFC_AZURE_PROVIDER_AUTH`, `TFC_AZURE_RUN_CLIENT_ID` | HashiCorp | HCP Terraform never mints an OIDC token; the provider finds no credential |
| `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID` | Microsoft / `azurerm` | The provider credential chain does not see them |
| `ARM_CLIENT_ID`, `ARM_OIDC_TOKEN`, `ARM_USE_OIDC` | Microsoft / HashiCorp | Injected into the run environment automatically — never set these by hand |
| `VITE_*` prefix | Vite | Without the prefix the value is not inlined; the bundle reads `undefined` and the build still looks fine |
| `GITHUB_TOKEN` | GitHub | Injected per-run; the name is reserved and cannot be created as a secret anyway |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The AWS SDK | The SDK reads these exact names from the environment |
| `NODE_ENV`, `WEBSITE_SITE_NAME`, `REGION_NAME` | Node / the Functions host | Host-provided |
| Any app setting read as `process.env.X` by shipped code | This repository's own code | The read returns `undefined`, which most code treats as "feature off" rather than as an error |
| `GatewaySubnet`, `AzureFirewallSubnet`, `AzureBastionSubnet` and the other reserved subnet names | Azure | Covered in [Naming-Convention](../standards/naming-convention.md); listed here so nobody applies the 2-word rule to them |

Note what is **not** contractual, because that is where the mistakes are made:

- `AZURE_STATIC_WEB_APPS_API_TOKEN` — the *action input* is
  `azure_static_web_apps_api_token`; the secret name feeding it is ours, and
  five words long. Unset today, so it is a safe rename if it survives at all.
- `FUNCTIONS_URL` — ours. Renamed 2026-08-18 from `AZURE_FUNCTIONS_URL`
  (three words, provider prefix) while unset everywhere — the safe-now case
  below, exercised.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — ours, four words, and the `_JSON` suffix
  encodes an encoding rather than a meaning.
- `VITE_AZURE_FUNCTIONS_URL` — the `VITE_` prefix is contractual, the rest is
  ours. But `frontend/src/lib/functionsBase.js` reads it and a test enforces
  that it is the only reader, so this one is *coordinated*, not safe-now.
- `CF_WEB_ANALYTICS_TOKEN`, `CF_WEB_ANALYTICS_SITE_TAG`, `CF_ACCOUNT_ID` —
  ours, and each carries the provider prefix the core rules refuse, which
  `VITE_TURNSTILE_SITE_KEY` (another Cloudflare value) does not. Recorded as
  the exception rather than renamed (#1302), on the `CF_ORIGIN_SECRET`
  precedent in the per-store table above: shipped code reads all three
  (`frontend/scripts/cf-web-analytics.mjs` through `VITE_CF_WEB_ANALYTICS_TOKEN`,
  `functions/src/lib/timers/ambassador-audience.js` the two app settings), so
  each is *coordinated*, and the prefix is what tells the public site token
  apart from `CLOUDFLARE-ANALYTICS-TOKEN`, the read-only API credential that
  sits beside it. The account id is **one value spelled three ways** —
  `cloudflare_account_id` (Terraform variable), `CF_ACCOUNT_ID` (app
  setting), `CLOUDFLARE_ACCOUNT_ID` (repository variable, #948, named
  first) — and a rename of any one is a coordinated change across the three.

### Which bucket a rename falls into

Every name sorts into exactly one:

| Bucket | Meaning | Currently |
| --- | --- | --- |
| **Safe now** | Unset everywhere, or read only by code changed in the same PR | `AZURE_STATIC_WEB_APPS_API_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_JSON` — both `Missing`. (`AZURE_FUNCTIONS_URL` → `FUNCTIONS_URL` already exercised this path, 2026-08-18) |
| **Coordinated** | Already set in HCP Terraform or GitHub, or already read by shipped code. Report it; never rename silently | `CLIENT_ID`, `TENANT_ID`, `SUBSCRIPTION_ID`, `APP_HOSTNAME`, `RESOURCE_GROUP`, `VITE_AZURE_FUNCTIONS_URL` |
| **Contractual** | Never touched | The table above |

---

## Adding a new value — the short version

1. Run Q1–Q7. Write the answer into CHECKLIST with the store and the reason.
2. Name it for the store it landed in: 2 words, no provider prefix.
3. If it is a Key Vault secret, apply the underscore→hyphen transform and add
   the `@Microsoft.KeyVault` reference to `app_settings` in
   `infra/functionapp.tf` — the reference, never the value.
4. If it landed in store 4, the CHECKLIST entry must name the external system
   and say why federation is unavailable.
5. If the answer was "deliberately absent", record it anyway, with what breaks
   if someone provisions it. An absent value with no record gets provisioned.

---

## Related

- [IaC Repository Standard](../standards/iac-repository-standard.md) — the variable naming rule
  and the credential-free principle this page implements
- [Naming Convention](../standards/naming-convention.md) — resource names, and the platform
  limits that override them
- [Deployment Runbook](../runbooks/deployment-runbook.md) — §0 bootstrap, where the store 2
  environment variables are first entered
- Required-Inputs — the inventory: what exists, who consumes it, whether it is
  provisioned
- `infra/variables.tf` — the store 2 Terraform variables and their validations
- `infra/keyvault.tf` — the Key Vault, its network ACLs and RBAC
- `infra/functionapp.tf` — the app settings that reference it

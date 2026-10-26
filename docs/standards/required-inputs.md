# Required inputs

Every variable, secret and setting the workload needs, with live status.

> **Moved here from `REVIEW.md` on 2026-08-29**, when that file was retired and
> its open work folded into [TODO.md](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/TODO.md)
> (and from there into GitHub issues on 2026-09-05).
> `REVIEW.md` was the root document that held the owner-gated open work and, in
> its Part 4, this inventory; it no longer exists.
> REVIEW.md's own header explained why this inventory sat there rather than in
> the Wiki (now this docs site): the two procedures that write to it — a contributor recording a new
> required input ([CONTRIBUTING](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/CONTRIBUTING.md)),
> an operator moving an entry from `SET` to `VERIFIED` after an apply
> ([Deployment-Runbook](../runbooks/deployment-runbook.md)) — are gated on owner-level access.
>
> That argument stopped holding once REVIEW.md went away, and it was always
> weaker than it looked: `docs/` (then `wiki/`) is reviewed through pull requests exactly as the
> repository root is, so nothing about the write path changes by moving here.
> What does change is that a 228-line reference inventory is no longer sitting
> inside a document people opened to find out what to do next.
>
> **Section numbers are unchanged** (§4.1 … §4.10), because roughly sixteen code
> comments cite them by number. A citation reading `REVIEW.md §4.5` now reads
> `Required-Inputs §4.5` and lands in the same place. §4.11, the Docker Hub
> OIDC connection, was added at the end on 2026-09-28 so that no existing
> number moved.

**Related:** [Variables and secrets](../standards/variables-and-secrets.md) carries the *rules* —
naming, which store a value belongs in, and why. This page carries the
*inventory* — what exists, who consumes it, and whether it is confirmed. The two
overlap in subject and not in purpose; where they disagree about a rule, that
page wins, and where they disagree about live status, this one does.

---

Every variable, secret and setting the workload needs, with live status.

This section is the **inventory**: what exists, who consumes it, whether it is
confirmed. It deliberately does not restate naming or placement rules — those
live in [Variables and secrets](variables-and-secrets.md), which
is the placement authority and holds no status. The two are read together: that
page decides where a value belongs, this one records whether it is there.

> **This section must never contain actual values.** Formats use placeholders
> only: `X` = letter, `0` = number, `!` = special. If a real value ever appears
> here, treat it as disclosed and rotate it.

> **Which is why the `az` sign-in details are not here.** The estate's tenant,
> its four subscriptions, the scoped device-code login and the ways
> signing in fails live in [Cutover-Runbook](../history/cutover-runbook.md) **Step 0**. They
> are operator procedure rather than inventory, and the rule above forbids the
> one thing that makes such a procedure usable — a command carrying its real
> values instead of a placeholder. Putting them here would have meant either
> breaking that rule or shipping a login command nobody can paste. Recorded as
> a pointer so the question is answered in the file where it gets asked.

**Status vocabulary:** `SET` (present and confirmed) · `VERIFIED` (observed
working in the deployed system) · `MISSING` (consumed by code, not
provisioned) · `RETIRED` (no longer read by anything; listed so it is not
reintroduced).

**How each status below was established, because it is not uniform.** GitHub
variables, secrets and environments were enumerated live on 2026-08-25 with
`gh`, so their presence is observed. Key Vault was **not** readable in that
pass — the caller holds no data-plane role and `secret list` returned
`ForbiddenByRbac` — so §4.6 lists what the configuration *references*, which
establishes the consumer and the name but not the presence. HCP Terraform
workspace variables were likewise not read. Where a row carries a status with
no observation behind it, the section says so.

## 4.1 HCP Terraform workspace — `hcw/hcw-azure`, project `Site`

Not readable in this pass (no workspace token). The names and categories below
come from the configuration and from the contract each tool imposes; the
statuses were last confirmed 2026-08-20 and are carried forward.

**Environment variables** — how Terraform authenticates to Azure. These names
are dictated by HashiCorp and Microsoft, so they are contractual: exempt from
the repository's 2-word variable rule, never renamed. Category matters — set as
*Terraform* variables instead of *environment* variables they are silently
ignored and the run fails claiming no credentials were supplied.

| Name | Status | Notes |
| --- | --- | --- |
| `TFC_AZURE_PROVIDER_AUTH` | **SET** (`true`) | Absent ⇒ no OIDC token is minted and the provider finds no credential |
| `TFC_AZURE_RUN_CLIENT_ID` | **SET** | Client id of `id-plat-terraform-prod-cus-01`. Distinct from §4.2's `CLIENT_ID`, which is the GitHub Actions identity |
| `ARM_TENANT_ID` | **SET** (sensitive) | Same value as the `entra_tenant_id` Terraform variable — see the exceptions table in [Variables and secrets](variables-and-secrets.md) |
| `ARM_SUBSCRIPTION_ID` | **SET** (sensitive) | Provider fallback only; every provider pins `subscription_id` in HCL, so it never decides where resources land |

**Terraform variables — required.** Eight of the configuration's 74 variables
(counted 2026-10-20 with `grep -c '^variable "' infra/variables.tf`; this said
66 until #1302 recounted) have no default, so an unset one fails the plan rather than picking something.
That is deliberate for the subscriptions in particular: a wrong guess would
silently deploy the workload into a platform landing zone.

| Name | Sensitive | Consumer |
| --- | --- | --- |
| `subscription_app` | yes | Application landing zone — the workload |
| `subscription_mgmt` | yes | Platform Management — Log Analytics, action groups |
| `subscription_conn` | yes | Platform Connectivity — hub network |
| `entra_tenant_id` | yes | Entra tenant for admin sign-in and API audience |
| `entra_api_audience` | no | API scope the SPA requests |
| `cloudflare_api_token` | yes | Cloudflare provider — DNS, the origin transform rule and ruleset, and since #1302 the Web Analytics site, the configuration's one account-level resource. The dashboard token (`hcp-terraform-cloudflare-dns`) therefore carries Zone:Read, DNS:Edit, Transform Rules:Edit, Account Rulesets:Read and **Account → Account Settings → Write**, the permission Cloudflare's API reference lists for `POST /accounts/{account_id}/rum/site_info`. Add the last before the apply that sets `cloudflare_account_id` (below): without it every record and the ruleset apply and `cloudflare_web_analytics_site.hcw[0]` alone fails — by the ruleset's documented pattern with `Authentication error (10000)`, inferred from that case rather than observed on this endpoint (`infra/variables.tf`, the permission paragraph beside `cloudflare_origin_secret`) |
| `cloudflare_zone_id` | no | Cloudflare zone the rules attach to |
| `budget_alert_email` | no | Budget alert action group |

**Terraform variables — defaulted.** The other 66 carry defaults and need no
workspace entry. The table below lists the eleven that are posture switches
rather than settings — every one but `labs_public_submission_enabled` defaults
to the estate as it stands or to the safer value, so an apply never changes
behaviour without a workspace edit first; that one defaults to the posture the
owner chose on 2026-09-28, stays closed until its Key Vault secret resolves, and
is closed again by a workspace edit — plus three defaulted inputs that are not
switches: `cloudflare_origin_secret`, which must match a Key Vault secret
exactly, `arc_onboarding_principal_id`, which names an owner-created
principal, and `cloudflare_account_id`, which names the Cloudflare account and
gates the one resource that needs it:

| Name | Default | What arming it does |
| --- | --- | --- |
| `schedulers_master_enabled` | `false` | Master switch for every catalogued timer. Both this and a name in `enabled_timers` are required — T-518 |
| `enabled_timers` | `[]` | Per-timer allow-list, armed one name at a time, by flag suffix from `local.timer_catalogue` in `infra/functionapp.tf`. `AMBASSADOR_AUDIENCE_MONTHLY` (#1302) arms `ambassadorAudienceMonthly`, daily at 06:45 UTC, which records the previous month's audience figure once per month (daily rather than on the first because `alert-timer-overdue` cannot compute a calendar-month period); armed, it still reads nothing until `CLOUDFLARE-ANALYTICS-TOKEN` (§4.6) resolves and `cloudflare_account_id` (below) is set |
| `newsletter_sending_enabled` | `false` | Lets a publisher's approval send the weekly newsletter through Resend. Set it only after the postal address and reply-to are saved in Newsletter settings |
| `labs_public_submission_enabled` | `true` (owner decision 2026-09-28, [ADR 0032](../decisions/0032-learner-labs-platform.md) decision 6 revised) | Sets `LABS_PUBLIC_SUBMISSION_ENABLED`, which lets the Landing Zone Builder's "Validate on the lab" queue a public `terraform-validate` job, only from the site's pane (its origin and a Cloudflare Turnstile token) and within decision 6's bounds. Stays closed until `TURNSTILE-SECRET-KEY` (§4.6) resolves and an agent is online. **`false` in the workspace is the kill switch**: every public lab route then answers `PUBLIC_SUBMISSION_CLOSED` before reading anything |
| `availability_test_enabled` | `false` | Standard web test and its alert. Stays `false`: Bot Fight Mode still 403s Azure's availability agents, and the reachability signal is served by the ADR 0024 Worker probe instead |
| `availability_probe_alert_enabled` | `false` in code, **set `true` in the workspace 2026-09-01 (T-519 closed)** | Arms `edge_probe_availability` (`alert-api-reachability-prod-cus`) on the Worker probe's `availabilityResults` rows. Armed only after a full 30-minute window held 6 healthy rows |
| `cosmos_export_enabled` | `false` | Arms the Cosmos exporter (`FEATURE_FLAG_COSMOS_EXPORT`) and creates `cosmos_export_daily_missing` and `cosmos_export_full_missing` (`alert-cosmos-export-daily-prod-cus`, `alert-cosmos-export-full-prod-cus`) together — ADR 0028. Arm only after the exporter is deployed and a `cosmosExportCompleted` event has been seen, and not on a Sunday after 03:00 UTC |
| `functions_scm_lock_enabled` | `true` in code since 2026-10-14 (PLAT-10, #970), the workspace's value since 2026-08-25 | Denies SCM/Kudu by default; `deploy-functions.yml` opens a per-run window. Proven under `Deny` by run 32902534458 |
| `functions_origin_lock_enabled` | `true` | Restricts the origin to Cloudflare ranges. Already on |
| `purge_protection_enabled` | `true` | Key Vault purge protection. On by owner decision 2026-09-14, and one-way. See [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md). A workspace variable of this name set to `false` overrides it and must be deleted |
| `lab_hybrid_policy_enabled` | `false` | Creates the audit-only Linux security baseline policy assignment on `rg-lab-hybrid-prod-cus` (#663). **MISSING.** Set `true` (HCL on): ADR 0032 decision 3 makes machine configuration audit only, and #663's acceptance is a compliance state. The first run of `scripts/lab/Register-LabArc.ps1` grants the run identity Resource Policy Contributor on that group and then prints this variable; true before that grant fails the apply with `AuthorizationFailed`. [Labs host runbook](../runbooks/labs-host.md), "Arc onboarding", steps 2 and 3 |
| `cloudflare_origin_secret` | — (sensitive) | Must match Key Vault `CF-ORIGIN-SECRET` exactly; a mismatch throws on every anonymous request |
| `arc_onboarding_principal_id` | `null` | **MISSING.** Object id (not the appId) of `sp-arc-onboarding-lab-hybrid-prod-cus`, which the first run of `scripts/lab/Register-LabArc.ps1` creates and prints this value for; set, it plans the principal's only grant, Azure Connected Machine Onboarding on `rg-lab-hybrid-prod-cus` (#663). Not sensitive, HCL off, lower case. [Labs host runbook](../runbooks/labs-host.md), "Arc onboarding", steps 2 and 3 |
| `cloudflare_account_id` | `null` | **MISSING** (2026-10-20, #1302). The Cloudflare account that owns the zone: 32 lowercase hex characters, an identifier and not a credential, the same value the `CLOUDFLARE_ACCOUNT_ID` repository variable holds (§4.2) and the dashboard shows under API on the zone's Overview page. Set, it creates `cloudflare_web_analytics_site.hcw[0]` for `hybridcloudworks.com` with Cloudflare's lite option — which asks Cloudflare not to measure visitors in the EU; documented for the snippet Cloudflare's proxy injects, unverified for the hand-placed one this site carries, so the figure is aggregate page views, read as a floor. **EU option not yet confirmed**: after the apply the owner opens the site's Manage page in the Web Analytics dashboard, `https://dash.cloudflare.com/?to=/:account/web-analytics`, checks that the EU option shows as applied, and records the date in this row — fills the `web_analytics_site_token` and `web_analytics_site_tag` outputs (§4.10) and the `CF_WEB_ANALYTICS_SITE_TAG` and `CF_ACCOUNT_ID` app settings (§4.5). Null on purpose rather than required: the site serves no visitor-facing path, and a required variable would fail every plan — the merge's queued run, the speculative plans, `tfc-plan-check` — until the owner had typed the value in. Not sensitive, HCL off. Add Account → Account Settings → Write to `cloudflare_api_token` (above) before the apply that follows; a value of the wrong shape fails the plan on the variable's validation rather than the apply as a 404 |

## 4.2 GitHub repository variables

Enumerated live 2026-08-25. Twenty were present then, and twenty was the whole
list — the three scratch variables that used to sit here were deleted the same
day (T-525). `READER_CLIENT_ID` was added to the table on 2026-08-29 (T-728) and
is **not yet set**, so a reader comparing this against `gh variable list` should
find exactly that one difference until the split is applied. Seeded from
Terraform outputs by `scripts/set-github-variables.ps1` — never written by
hand, with these exceptions, each but the last for a value Terraform does not
manage: `COPILOT_REVIEW_APP_ID` identifies a GitHub App, so it is set by hand from the
App page (runbook step 4), `VITE_TURNSTILE_SITE_KEY` is the site key of a
Turnstile widget created in the Cloudflare dashboard, `DOCKERHUB_CONNECTION`
and `DOCKERHUB_ENABLED` belong to a Docker OIDC connection created in Docker
Home (§4.11), and the five Cloudflare audit inputs (`CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_DNS_AUDIT_OWNER_EMAIL`,
`CLOUDFLARE_CADDY_TOKEN_NAME`, `CLOUDFLARE_CADDY_HOST_IP`) are read from the
Cloudflare dashboard and the Caddy token's own settings (#948), so a rebuild
sets them by hand too. `CF_WEB_ANALYTICS_TOKEN` (#1302) is the one that *is* a
Terraform output: the script does not seed it yet, so the owner copies
`web_analytics_site_token` from the `hcw-azure` workspace by hand. Each row
says so.

| Name | Status | Consumer |
| --- | --- | --- |
| `CLIENT_ID` | **VERIFIED** | OIDC login for the workflows that WRITE — `deploy-functions.yml` and `deploy-azure-frontend.yml`. `heal-computed-properties.yml` signed in with it too until #816 deleted it |
| `COPILOT_REVIEW_CLIENT_ID` | **SET 2026-09-06** | OIDC login in `copilot-setup-steps.yml`, the job GitHub runs before Copilot code review and the Copilot cloud agent start. Identifies `github_copilot_review` (`infra/oidc.tf`): Reader on the four workload groups, nothing else. Seeded from the `copilot_review_client_id` output by `scripts/set-github-variables.ps1`; while unset the login fails closed and the Azure MCP server has no credential — see [Copilot code review MCP servers](../runbooks/copilot-code-review-mcp.md) |
| `COPILOT_REVIEW_APP_ID` | **SET 2026-09-06** | App ID of *HCW Copilot Review Reader*, the read-only GitHub App from which `copilot-setup-steps.yml` mints a one-hour installation token for the GitHub MCP server Copilot code review uses. An identifier, like `MANIFEST_APP_ID`; the key is the Agents secret in §4.3. Set by hand from the App page (runbook step 4) |
| `READER_CLIENT_ID` | **SET 2026-09-06** | OIDC login for the workflows that only read — `monitor-functions-registered.yml` and `monitor-unresolved-secrets.yml` (T-728). `verify-alert-state.yml` used it until #1053, and `publish-content-manifest.yml` until #1098. Both are gated on it and **skip silently while it is unset**, so a rebuilt repository seeds it in the same pass as the apply: an unset value looks like workflows not running, not like a failure |
| `ALERT_READER_CLIENT_ID` | **SET 2026-10-11** | OIDC login for `verify-alert-state.yml` alone (#1053): `github_alert_reader`, which holds *HCW Alert Rule Reader* (`infra/roles/alert-rule-reader.json`) in `rg-web-site-prod-cus` and `rg-mgmt-plat-prod-cus` and nothing else. The `alert_reader_client_id` output of `infra/`. The job is gated on it and **skips silently while it is unset** |
| `MANIFEST_WINDOW_CLIENT_ID` | **SET 2026-10-13** (from `id-site-github-manifest-prod-cus-01`'s client id, after run-KqX5v889iJZBFn3x created it, #1098) | OIDC login for `publish-content-manifest.yml`'s build job alone (#1098): `github_manifest_window`, which holds *HCW Function Config Refresh* (`infra/roles/function-config-refresh.json`) on `func-site-prod-cus-01` and Reader on `rg-web-site-prod-cus` and nothing else, so it can open and close the job's origin window and cannot read app settings. The job is gated on it and **skips silently while it is unset**: the content manifest stays at its last committed version until it is set |
| `TENANT_ID` | **VERIFIED** | OIDC login |
| `SUBSCRIPTION_ID` | **VERIFIED** | OIDC login, `az rest` calls, and the application half of `verify-alert-state.yml`'s `ALERT_SUBSCRIPTION_IDS` |
| `SUBSCRIPTION_MGMT_ID` | **SET 2026-10-11** | The Management subscription's id (`sub-plat-mgmt-prod-cus`), read only by `verify-alert-state.yml` (#1053). It and `SUBSCRIPTION_ID` become `ALERT_SUBSCRIPTION_IDS`, which the check uses for any subscription its identity's subscription list leaves out, since that identity's one role is at resource-group scope. Not secret: it is already an assignable scope in `infra/roles/*.json`. Unset, the check stops with exit 2 naming the empty entry, rather than skipping the Management rules |
| `RESOURCE_GROUP` | **VERIFIED** | Function App deploy and firewall windows |
| `FUNCTION_APP_NAME` | **VERIFIED** | Deploy target, SyncTriggers, access restrictions |
| `FUNCTIONS_STORAGE_ACCOUNT` | **VERIFIED** | Storage firewall window during deploy |
| `FUNCTIONS_STORAGE_OPEN_DEFAULT_ACTION` | unset (2026-10-15) | The literal `false` leaves the host storage account's default action at Deny through the deploy's upload window, so one deploy measures whether the flip to Allow is still needed (PLAT-10, #970; `deploy-functions.yml`, which names what Microsoft documents about who writes the package). Unset, or any other value, opens the default action for the window as before; the always() cleanup restores Deny either way. |
| `FUNCTIONS_URL` | **VERIFIED** | The frontend build's API base: `deploy-azure-frontend.yml` passes it as `VITE_AZURE_FUNCTIONS_URL` with `REQUIRE_API_BASE: 'true'`, so the build fails without it, and as `AZURE_FUNCTIONS_URL` for the public-data generation step. `deploy-functions.yml` no longer reads it: its origin-lock check curled this hostname and read Cloudflare's 403, and since PLAT-2 (#962) it reads the Function App's access restriction instead |
| `APP_HOSTNAME` | **VERIFIED** | Origin health probe through the temporary window |
| `COSMOS_ENDPOINT` | **SET, read by nothing** | Its one workflow reader, the computed-property healer, was deleted in #816 (the apply writes `cp_sortDate` now). A variable, not a secret — it is a public endpoint, and the earlier secret placement was corrected 2026-08-20. `scripts/set-github-variables.ps1` still seeds it, so it stays set until that script and this row go together |
| `DOCKERHUB_CONNECTION` | Set 2026-09-29 (§4.11, #779, closed) | The ID of the Docker OIDC connection, a UUID. `publish-lab-image.yml`'s `Publish to Docker Hub` job passes it to `docker/login-action` as `DOCKERHUB_OIDC_CONNECTIONID`, the name the action reads. An identifier, not a credential: it grants nothing without a GitHub token from this repository's `main`. Set by hand at a prompt with the one-liner in [Docker Hub publishing](../runbooks/docker-hub-publishing.md), step 2 |
| `DOCKERHUB_ENABLED` | `true` since 2026-09-29 | `true` turns on the `Publish to Docker Hub` job. Any other value, or none, leaves it skipped, and since 2026-10-08 that means nothing is published: Docker Hub is the lab images' only registry. Set by hand, after `DOCKERHUB_CONNECTION`: with it `true` and the ID missing, the job fails and names the variable. [Docker Hub publishing](../runbooks/docker-hub-publishing.md), step 3 |
| `COSMOS_RESOURCE_GROUP` | **SET, read by nothing** | Was the healer's ARM scope; the healer was deleted in #816. `scripts/set-github-variables.ps1` still seeds it from the `cosmos_resource_group` output, so it stays set until that script and this row go together |
| `MANIFEST_APP_ID` | **SET 2026-09-01** | App ID of the repository's GitHub App, paired with the `MANIFEST_APP_PRIVATE_KEY` secret (§4.3). An identifier, so a variable. Read by the four workflows that open pull requests through the App: `publish-content-manifest.yml`, `update-avm-versions.yml`, `update-learn-catalogue.yml` and `update-version-floors.yml` |
| `STORAGE_ACCOUNT` | **SET, read by nothing** | No workflow has read it since the migration surface was retired (59e471b0); `publish-content-manifest.yml` no longer does. `scripts/set-github-variables.ps1` still seeds it, so it stays set until that script and this row go together |
| `STORAGE_RESOURCE_GROUP` | **SET, read by nothing** | As above |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | **SET** | Workload identity federation for the one-shot Firestore migration. **Read by no workflow in the repository today** — the description here previously said "GCP pricing integration", which was never true: pricing runs in the Function App and now uses an API key. Inert; delete both when the migration record is closed |
| `GCP_SERVICE_ACCOUNT` | **SET** | As above — the federated principal's email, not a downloaded key |
| `VITE_ENTRA_CLIENT_ID` | **VERIFIED** | Frontend build — SPA registration |
| `VITE_ENTRA_TENANT_ID` | **VERIFIED** | Frontend build |
| `VITE_ENTRA_API_SCOPE` | **VERIFIED** | Frontend build — token audience |
| `VITE_SOCIAL_GITHUB_URL` | **SET** | Frontend build — footer links |
| `VITE_SOCIAL_LINKEDIN_URL` | **SET** | Frontend build |
| `VITE_SOCIAL_X_URL` | **SET** | Frontend build |
| `VITE_TURNSTILE_SITE_KEY` | **SET 2026-09-28** ([ADR 0032](../decisions/0032-learner-labs-platform.md), amendment of 2026-09-28) | Frontend build: the **site key** of the Cloudflare Turnstile widget for the Landing Zone Builder's "Validate on the lab". Public by construction, since Cloudflare puts it in the page, so a variable and never a secret. Set by hand, not by `scripts/set-github-variables.ps1`: the widget is created in the Cloudflare dashboard at `https://dash.cloudflare.com/?to=/:account/turnstile` (hostname `hybridcloudworks.com`, Managed mode), not by Terraform, whose `cloudflare_turnstile_widget` would hold the secret key in state. Unset, the build succeeds and the button stays disabled saying the build has no site key; a change needs a frontend deploy to reach the site |
| `CF_WEB_ANALYTICS_TOKEN` | unset (2026-10-20, #1302) until the owner's `hcw-azure` apply creates the site | Frontend build: `deploy-azure-frontend.yml` passes it as `VITE_CF_WEB_ANALYTICS_TOKEN` (§4.8), and `frontend/scripts/cf-web-analytics.mjs` builds the Cloudflare Web Analytics beacon into every page from it. Public by nature — it is the token the beacon carries in every page, readable in view-source, and it grants nothing, since the Cloudflare API authenticates with an API token and this is not one — so a variable and never a secret, like the Turnstile site key above. **Set by hand** from the `web_analytics_site_token` output (§4.10) on the Outputs tab of `https://app.terraform.io/app/hcw/workspaces/hcw-azure`, after the apply that follows `cloudflare_account_id` (§4.1); `scripts/set-github-variables.ps1` does not seed it. Unset, the build serves no beacon tag at all, byte for byte the committed `index.html`; a value that is not token-shaped fails the build naming the variable; a change needs a frontend deploy to reach the site. Nothing clears or refreshes it: when the site is destroyed (`cloudflare_account_id` unset again) or replaced (the account id changed, which forces a new site with a new token), every page keeps shipping a beacon with a dead or wrong token until the owner re-copies the new output, or clears the variable with `gh variable delete CF_WEB_ANALYTICS_TOKEN -R saulpatinojr/HCW-HybridCloudWorks`, and deploys the frontend; after the delete the next deploy ships no tag |
| `CLOUDFLARE_ACCOUNT_ID` | **SET 2026-10-18** (owner, #948) | `cloudflare-dns-audit.yml`: the account whose audit log `scripts/cloudflare-dns-audit.mjs` reads daily. An identifier (the dashboard shows it on the zone's Overview page, under API), so a variable. Set by hand; without it the daily run fails, on purpose |
| `CLOUDFLARE_ZONE_ID` | **SET 2026-10-18** (owner, #948; optional) | `cloudflare-dns-audit.yml`: the production zone's id, matched beside the zone name `hybridcloudworks.com` for an audit entry whose zone name is absent. The same value as the `cloudflare_zone_id` workspace variable in §4.1 |
| `CLOUDFLARE_DNS_AUDIT_OWNER_EMAIL` | **SET 2026-10-18** (owner, #948; optional) | `cloudflare-dns-audit.yml`: the owner's Cloudflare dashboard sign-in, which arms the `owner-dashboard` and `terraform-owner-token` allowlist entries so the owner's own edits read EXPECTED. Unset, they read UNEXPECTED and open an issue. Compared, never printed: the report masks every e-mail |
| `CLOUDFLARE_CADDY_TOKEN_NAME` | **SET 2026-10-18** (owner, #948; optional) | `cloudflare-dns-audit.yml`: the Caddy runtime token's name as the API Tokens page shows it, matched by the `caddy-acme` allowlist entry when an audit entry carries `actor.token_name` — which, read on the first live run, this account's token entries do not. `CLOUDFLARE_CADDY_HOST_IP` is the identity that works |
| `CLOUDFLARE_CADDY_HOST_IP` | **SET 2026-10-18** (session, from the token's own IP filter; #948; optional) | `cloudflare-dns-audit.yml`: the lab host's public IPv4 address, the one the Caddy token's client-IP filter allowed during the interim (148.230.91.226; since the 2026-10-18 rebuild the filter also holds the host's IPv6 address, and the `caddy-acme` allowlist entry is dated to the cut-over, so this value only explains the audit-log tail of the interim). Arms the `caddy-acme` allowlist entry so the token's `_acme-challenge.*.lab` TXT edits read EXPECTED and anything else from that address is the finding. Unset (and no token name in the log), every renewal reads UNEXPECTED and opens an issue |

## 4.3 GitHub repository secrets

Enumerated live 2026-09-29: **two**, and neither is an Azure credential.
Everything else a workflow needs is either a non-sensitive variable or reached
by OIDC. The one Azure-issued secret this section used to list is retired
(struck through below).

| Name | Status | Consumer |
| --- | --- | --- |
| ~~`AZURE_STATIC_WEB_APPS_API_TOKEN`~~ | **RETIRED 2026-08-30, DELETED 2026-08-31 (T-727)** | Nothing. `deploy-azure-frontend.yml` mints the deployment token from ARM under federated identity at deploy time, so no stored value is needed and there is nothing to rotate. The secret was removed from repository settings by the owner on 2026-08-31, after the role assignment applied |
| `TFC_TOKEN` | **SET 2026-08-30** | An HCP Terraform API token for the `hcw-azure` workspace. Not an Azure credential. `tfc-plan-check.yml` reads a run's JSON plan with it and holds the plan to the permanent diff (`scripts/assert-expected-plan.mjs`). `cloudflare-dns-audit.yml` reads the workspace's runs with it (read-only; every run whose apply began, whether it ended applied, errored or cancelled), so a Terraform-looking DNS edit is EXPECTED only while an apply was in progress (#948). `deploy-functions.yml` asks the workspace whether an apply is in flight before deploying, because a deploy and an apply that write the app-settings map minutes apart lose settings (#454); that guard fails closed without the token (PLAT-3, #963). `monitor-deploy-drift.yml` reads the workspace's last applied run with it, as the Terraform row's deployed baseline; without the token that row reads ⚠️ and the job fails, never ✅ |
| `MANIFEST_APP_PRIVATE_KEY` | **SET 2026-09-01** | Private key of the repository's GitHub App, with `MANIFEST_APP_ID` (§4.2). `scripts/github-app-token.mjs` mints a one-hour installation token from it, and revokes it after use, for the jobs that push a branch and open a pull request: `publish-content-manifest.yml`, `update-avm-versions.yml`, `update-learn-catalogue.yml` and `update-version-floors.yml`. Each job holds it for the length of two API calls and installs nothing, and each self-arms while it is unset |
| `CLOUDFLARE_AUDIT_LOG_TOKEN` | **SET 2026-10-18** (owner, #948) | A Cloudflare API token with *Account → Account Settings → Read* on the HybridCloudWorks account only, with an end date at most a year out: the one permission the Audit Logs v2 endpoint accepts (the token catalogue has no separate audit-log read; *Access: Audit Logs Read* is Zero Trust's and not this). `cloudflare-dns-audit.yml` hands it to `scripts/cloudflare-dns-audit.mjs` for one daily read of the account audit log ([Edge and DNS verification](../runbooks/edge-dns-verification.md), "The daily DNS audit"). Read-only, so a leak reads the audit log and changes nothing; roll it in the dashboard and set the secret again. While it is unset the daily run fails, on purpose. **Re-created 2026-10-18 evening**: the first token had been revoked by mistake during the LAB-1 cut-over (its name read like the Caddy token's) and the run answered HTTP 401 until the new one was set; a report-only run then read 284 entries, 0 unexpected. **Cloudflare token names** (owner decision 2026-10-18, after that mistake) say *where the token lives, what uses it, what it reaches*: `lab-host-caddy-hybridcloudinsights` for Caddy's, `hcp-terraform-cloudflare-dns` for the workspace's, and for this one `github-automation-dns-audit-account` (created as `lab-host-caddy-cloudflare`; rename pending, the value is unchanged by a rename) |

**No stored Azure credential is in this repository's secrets.** The Qlty
coverage upload (#568) uses GitHub OIDC and stores no token. `GITHUB_TOKEN` is
contractual and injected per run; it is never stored. Publishing the lab
images to Docker Hub (#779) adds no secret either: it signs in through a
Docker OIDC connection (§4.11).

The **Agents** store (Settings → Secrets and variables → Agents) is separate
from Actions secrets. Copilot's setup job and agent environment read it; a
name carrying the `COPILOT_MCP_` prefix is read by MCP servers only. It holds
the Copilot review identifiers and one key:

| Name | Status | Consumer |
| --- | --- | --- |
| `COPILOT_REVIEW_CLIENT_ID`, `COPILOT_REVIEW_TENANT_ID`, `COPILOT_REVIEW_SUBSCRIPTION_ID`, `COPILOT_REVIEW_APP_ID` | **SET 2026-09-06** — owner step 2b, [issue #381](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/381) | Copies of the four identifiers the repository variables also hold, because Copilot's own runner resolves no `vars.*` (seen on the first review session, PR #378, 2026-09-06) and reads only this store. `copilot-setup-steps.yml` prefers these and falls back to the variables, so a manual dispatch and a Copilot session both sign in. Rotate them with the variables: a changed client id or App ID has to land in both places. Holding identifiers in a secret store is the documented exception in [Variables and secrets](variables-and-secrets.md#subscription-tenant-and-client-ids) |
| `COPILOT_REVIEW_APP_PRIVATE_KEY` | **SET 2026-10-11** (#1063; `gh secret list --app agents` lists it). It was absent from at least 2026-09-28 until then (#1029), and the App-token step skipped meanwhile. Only a Copilot session can show that it resolves, because Copilot's runner is the only one that reads the Agents store. A manual dispatch of `copilot-setup-steps.yml` prints the "not resolvable" notice whatever the store holds. The first Copilot session after 2026-10-31 is the check. Restore with step 5 of the [Copilot code review runbook](../runbooks/copilot-code-review-mcp.md) | PEM private key of *HCW Copilot Review Reader*, the GitHub App installed on this repository only with eight **read** permissions. `copilot-setup-steps.yml` mints a one-hour installation token from it for the `github-mcp-server` entry in `.github/copilot-mcp.json`; the App's read-only permissions are the ceiling for anything the key can mint. **No personal access token, classic or fine-grained, is used anywhere in the configuration.** Not `COPILOT_MCP_`-prefixed because the setup job, not an MCP server, reads it. Justified in [Variables and secrets](variables-and-secrets.md#store-4-github-actions-secrets-with-justification); procedure in [Copilot code review MCP servers](../runbooks/copilot-code-review-mcp.md) |

## 4.4 GitHub environments

Enumerated live 2026-08-25.

| Name | Status | Notes |
| --- | --- | --- |
| `production` | **SET — two required reviewers, either of whom approves, and a `main`-only branch rule** (read live 2026-10-03) | Both deploy workflows bind to it, so it records who deployed. **It also gates them: two required reviewers, `saulpatinojr` and `hcw-architect`, either of whom can approve a deployment (self-review allowed), and the `main`-only deployment-branch rule.** The second reviewer was added on 2026-10-03; read it back with `gh api repos/saulpatinojr/HCW-HybridCloudWorks/environments/production`. Read live on 2026-10-02 it had one reviewer (`saulpatinojr`), which reversed the owner decision of 2026-08-29 that this row carried until then without re-reading the setting; when that first reviewer was added is not recorded. The 2026-08-29 decision, kept for its reasoning: ~~required reviewers deliberately not configured, because in a single-operator estate a required reviewer you approve yourself is not a control — it is a click that produces an audit trail implying oversight that did not happen~~. What still matters here is the other half. GitHub auto-creates a missing environment with no protection rules, and the federated credential's subject is environment-scoped (`repo:saulpatinojr/HCW-HybridCloudWorks:environment:production`, declared in `infra/oidc.tf`), so it matches from any branch — an unprotected environment leaves `workflow_dispatch` able to ship an unreviewed ref past all 12 required contexts (T-705). A `main`-only **deployment-branch rule** closes that, costs a solo operator nothing, and is not self-approval theatre. ~~**Owner action, reduced to one thing:** Settings → Environments → `production` → Deployment branches → *Selected branches* → `main`.~~ **Done 2026-09-02:** the `main`-only deployment-branch rule is set. The guard step in both workflows stays as the repository-side backstop; belt and braces is correct here because the environment rule is configured outside the repository and nothing in a checkout can prove it is still set |
| `copilot` | **SET** | Copilot cloud agent and Copilot code review. `copilot-setup-steps.yml` declares it, so the OIDC subject is `repo:saulpatinojr/HCW-HybridCloudWorks:environment:copilot`, trusted (both forms) only by `github_copilot_review` — a Reader-only identity, so a deployment-branch rule here would gain nothing and would block Copilot's own branches |
| `data-migration` | **RETIRED** | Its only consumer, `migrate-data.yml`, was deleted in `59e471b`. The two federated credentials that still trusted it were removed on 2026-08-26 (T-524), so nothing in Azure trusts the subject either |

## 4.5 Function App settings — Terraform-managed

No operator action. Every setting on `func-site-prod-cus-01` is declared in
`infra/functionapp.tf`; changing one by hand is reverted by the next apply and is how
configuration drift starts. Three properties are worth knowing rather than
listing every key:

- Settings whose value is a credential are **not** stored here. They are
  `@Microsoft.KeyVault(SecretUri=…)` references resolved by the app's managed
  identity at runtime — the inventory of those is §4.6.
- The vault reference maps `UPPER_SNAKE_CASE` app setting → `UPPER-KEBAB-CASE`
  secret, exactly. Key Vault forbids underscores, which is the whole reason for
  two spellings. Get it wrong and the reference resolves to nothing: the app
  deploys clean and a missing credential presents as missing *data*.
- An unseeded reference resolves to the literal `@Microsoft.KeyVault(…)`
  string, and the code treats that as "no key" rather than as a key. That is
  what keeps optional integrations inert instead of failing.

`AzureWebJobsStorage` must **not** be present. It is stripped inside the apply
(T-511) and `deploy-functions.yml` asserts its absence rather than repairing
it, because a repair would hide a regression in that fix.

Three plain settings are worth rows of their own: the one address the status
proxy reads that is **not** a vault reference, and the two identifiers the
monthly audience read is scoped by (#1302), which Terraform writes from its own
resources so that no copied value can drift:

| Name | Store | Status | Notes |
| --- | --- | --- | --- |
| `ADDON_MIGRATION_URL` | `infra/functionapp.tf`, a plain app setting (`https://migration.lab.hybridcloudworks.com`) | **SET** in Terraform by the ADR 0035 pull request; live on the next `hcw-azure` apply | The migration add-on's origin, read by `functions/src/lib/addons/status.js` for `GET /api/public/addons/migration/status`, which decides whether `/tools/migration` opens its pane ([ADR 0035](../decisions/0035-addon-pane-model.md) decision 4; [AddOn integration standard](addon-integration-standard.md) §10, §12). A public value, not a credential: it is already in the site's CSP `frame-src` and is the frame's `src`, so it is a Terraform literal with no vault seeding and no unresolved-reference monitor. **Unsetting it is the site-side kill switch**: the proxy answers `{ configured: false }` and the page shows its one sentence. `ADDON_NETWORK_ASSESSMENT_URL` and `ADDON_CLOUD_ASSESSMENT_URL` are declared in the pull request that makes each row `available`; until then those rows are `coming` and the proxy reads nothing for them |
| `CF_WEB_ANALYTICS_SITE_TAG` | `infra/functionapp.tf`, a plain app setting read from `cloudflare_web_analytics_site.hcw[0].site_tag` | **SET** in Terraform by #1302: `""` while `cloudflare_account_id` (§4.1) is unset, the site's tag once the apply creates it | The Web Analytics site the `ambassadorAudienceMonthly` timer scopes its read to, taken from the resource and never typed, so a recreated site cannot leave a stale tag behind. An identifier in the API path, not a credential; the credential is `CLOUDFLARE-ANALYTICS-TOKEN` (§4.6). Empty, the timer logs one line naming the setting and writes nothing. Unknown at plan time on the apply that creates the site, which `tfc-plan-check` reports once as an unknown `app_settings` difference it cannot declare; that one plan is read by hand, and later plans are clean |
| `CF_ACCOUNT_ID` | `infra/functionapp.tf`, a plain app setting from `cloudflare_account_id` | **SET** in Terraform by #1302: `""` until `cloudflare_account_id` is set | The Cloudflare account the read is scoped to. The GraphQL dataset (`rumPageloadEventsAdaptiveGroups`) is account-scoped, and an unfiltered `viewer { accounts }` is refused for any account the token cannot read, so the timer needs the id as well as the site tag. The same identifier as the `CLOUDFLARE_ACCOUNT_ID` repository variable (§4.2). Empty, the timer logs one line and writes nothing |

## 4.6 Key Vault secrets — `kv-site-prod-cus-01`

**Not observed in this pass.** `az keyvault secret list` returned
`ForbiddenByRbac` — the caller holds no data-plane role, which is itself the
correct posture. The names below are the thirty-one (setting lines, not comments; `secret-catalog.test.js` holds the catalogue to the same number; thirty until `CLOUDFLARE-ANALYTICS-TOKEN` arrived with #1302) the Terraform root module
in `infra/` references (including the Hybrid Lab's `CODER-URL` and `CODER-STATUS-TOKEN`, and `functions/src/lib/secret-catalog.js` lists every one) — the
app-settings map that holds them is in
`infra/functionapp.tf`, and `functions/src/lib/secret-catalog.test.js` reads
every `.tf` file in that directory as one module rather than any one file, so a
reference is found wherever it is declared. Each name therefore has a named
consumer, a fixed spelling, and an authoritative **Where to Re-obtain** location for disaster recovery; presence is what is unconfirmed. Three rows in
the table are not vault secrets and are not in that count: `FOUNDRY_ENDPOINT`,
`CONTENTFORGE_IMAGE_COST_USD` and `CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD` are
plain app settings, each marked so, listed beside the keys they belong with.
[Accepted risks](../repo/todo.md#accepted-risks) records the vault as holding 18
live secrets as of 2026-08-24.

Seeding one is an owner action through the approved vault procedure, and the
rule is worth restating: **do not seed a placeholder to quiet a linter.** An
unset input fails with a clear "not supplied"; a stubbed one fails as an
authentication or resolution error that reads like a permissions or networking
problem. The two cost very different amounts to diagnose. Generated secrets (`CLIENT-IP-SALT`, `PREVIEW-SIGNING-SECRET`, `CF-ORIGIN-SECRET`) are escrowed in the owner's password manager (Bitwarden) immediately upon creation. Upstream vendor credentials have authoritative portals or auto-renewal CLI commands documented below.

| Secret | Consumer | Where to Re-obtain | Notes |
| --- | --- | --- | --- |
| `CF-ORIGIN-SECRET` | Origin lock | Owner password manager (Bitwarden item: `CF-ORIGIN-SECRET`); generate via `openssl rand -hex 32`. Follow [Origin secret rotation](../runbooks/origin-secret-rotation.md) to synchronize with HCP Terraform `cloudflare_origin_secret` and Cloudflare Transform Rule | Must match the `cloudflare_origin_secret` workspace variable exactly |
| `CLIENT-IP-SALT` | Request hashing | Generated secret (`openssl rand -hex 32`) or generated via Admin Integrations UI (`https://hybridcloudworks.com/admin/integrations?tab=keys`). Escrowed in owner password manager (Bitwarden item: `CLIENT-IP-SALT`) | Changing it resets rate limits |
| `PREVIEW-SIGNING-SECRET` | Preview links signing | Generated secret (`openssl rand -hex 32`) or generated via Admin Integrations UI (`https://hybridcloudworks.com/admin/integrations?tab=keys`). Escrowed in owner password manager (Bitwarden item: `PREVIEW-SIGNING-SECRET`) | Changing it invalidates shared draft preview URLs |
| `GEMINI-API-KEY` | AI router; **Listen & Learn TTS** | Google AI Studio (`https://aistudio.google.com/app/apikey`) or Google Cloud Console (APIs & Services → Credentials). Auto-renewal via `scripts/roll-cloud-credentials.mjs --service gemini` | Gemini TTS reads every Listen & Learn episode (owner rule 2026-09-09, ADR 0029 §2b); `LISTEN_AND_LEARN_TTS_PROVIDER = gemini` is Terraform-managed on the Function App and may name only `gemini` or `azure`. The model is the owner's Best/Economy choice on the Platform settings page, overridable per run; audio is billed against this key |
| `ANTHROPIC-API-KEY` | AI router | Anthropic Console (`https://console.anthropic.com/settings/keys`) | Tried in the order set on `https://hybridcloudworks.com/admin/ai-engine`; by default Gemini, then OpenAI, then Anthropic (`DEFAULT_PROVIDER_ORDER`, `functions/src/lib/ai/ai-config.js`) |
| `OPENAI-API-KEY` | AI router | OpenAI Platform (`https://platform.openai.com/api-keys`) | Tried in the same order: second by default, before Anthropic |
| `NVIDIA-API-KEY` | AI router, **content features only** | NVIDIA API Catalog (`https://build.nvidia.com/settings/api-keys`), trial tier | Seeded 2026-09-28; the Key Vault reference resolves (#701). An `nvapi-` key created at `https://build.nvidia.com/settings/api-keys` for the NVIDIA API Catalog, a free trial tier at about 40 requests a minute under NVIDIA's trial terms; read those terms before seeding. Its place is the Priority list on `https://hybridcloudworks.com/admin/ai-engine?tab=services` and each task's mode on `https://hybridcloudworks.com/admin/ai-engine?tab=routing` (ADR 0034; the per-feature First / In order / Off control left with slice 4, #859): by default the backup for owner-triggered content (Forge drafting and grading, inspector, captions, Listen & Learn and podcast scripts), after the paid providers (owner decision 2026-09-29; it was first by default until then, and through the Test the trial tier took 56-117 s to answer). Never used for the anonymous public explain route — a policy lock no document lifts — and paced at 36 requests a minute per instance (`NVIDIA_REQUESTS_PER_MINUTE` overrides). The `probeAiProviders` timer, Monday 06:15 UTC, runs the AI Engine Test on every provider with a key and records the latency on each card; it runs only once `PROBE_AI_PROVIDERS` is in `enabled_timers`. Seed it on `https://hybridcloudworks.com/admin/integrations?tab=keys` before the Terraform run that adds its reference, so `monitor-unresolved-secrets.yml` never sees it unresolved; unseeded, the router treats the reference as no key and the paid providers serve as before. **A freshly seeded key can be refused from the app for up to about 40 minutes.** On 2026-10-04 a key seeded at 08:02 UTC got `403 Authorization failed` from the app at 1, 12 and 13 minutes, the same reply a made-up key gets, then passed from a workstation at about 23 minutes and from the app at 37; a key seconds old passed at once from Azure Cloud Shell. Test again later before reseeding, and delete the previous key at NVIDIA only after the new one passes from the app: the day's first key worked from the app for 15 minutes and was refused once it was rotated away |
| `FOUNDRY_ENDPOINT` (app setting, not a secret) | AI router, **content features** | Terraform-managed (`infra/foundry.tf`). Entra RBAC (`Cognitive Services OpenAI User`); no key is seeded | Set by Terraform from the Microsoft Foundry account in `infra/foundry.tf` (#849, owner decision 2026-10-04): `https://ais-site-prod-cus-01.openai.azure.com`. Nothing is seeded: the account has local authentication off, the Function App's system-assigned identity holds Cognitive Services OpenAI User on it, and the router sends an Entra token. The provider is placed first for the content features and locked off the anonymous public explain route; a USD 75 monthly budget on the `ai` resource group alerts at 50, 90 and 100 % (a budget notifies; it does not stop spend). Locally, `FOUNDRY_API_KEY` in `functions/.env` sends an api-key header for a developer's own account instead |
| `CONTENTFORGE_IMAGE_COST_USD` (app setting, not a secret) | Replicate image generation | Terraform-managed (`infra/functionapp.tf`); default `0.02` | Set by Terraform to `0.02`, the price per output image of `google/imagen-4-fast` on replicate.com read 2026-10-05; every generated image writes an `ai_usage` row carrying it, so Usage & Cost shows Replicate spend beside the token providers. Unset, rows are written unpriced and only the image count bounds the month. Change it with the model |
| `CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD` (app setting, not a secret) | Replicate image generation | Terraform-managed (`infra/functionapp.tf`); default `10` | Set by Terraform to `10`. Before every generation the client sums the month's Replicate rows and refuses with `IMAGE_BUDGET_EXHAUSTED` at or above this amount, or at `CONTENTFORGE_IMAGE_MONTHLY_MAX` images (default 200) whatever the price. Replicate bills on its own account, so this guard is the only thing that stops it: the owner declined a Replicate-side spend limit on 2026-10-05 (the balance there is small), so there is no external cap. One can be set at `https://replicate.com/account/billing` if that changes |
| `ELEVENLABS-API-KEY` | **Podcast TTS** | ElevenLabs Dashboard (`https://elevenlabs.io/app/developers/api-keys`). Restricted key permissions: `text_to_speech`, `user_read`, `voices_read`. Set credit limit to 10,000 | The podcast voice only — article and Plaud transcripts to Podbean (ADR 0029 §2a, scoped by §2b, host §1c); never Listen & Learn, and with no key the podcast saves a transcript-only draft rather than falling back to Gemini. **Free plan for testing from 2026-09-26** (§2a amended): 10,000 credits a month, one credit per character on Eleven v3, so one episode is nearly the month. Every render reads the account first and refuses a job the credits left cannot cover. Audio rendered on the free plan has no commercial licence and is never published to Podbean: approval refuses it. **Create the key** at `https://elevenlabs.io/app/developers/api-keys` with *Restrict key* on and only three permissions: **Text to Speech → Access** (`text_to_speech`; ElevenLabs lists no separate Text to Dialogue permission, so this is the one expected to cover it), **User → Read** (`user_read`, for the subscription read; without it every render fails closed and sends nothing) and **Voices → Read** (`voices_read`, for the Podcast voices picker's list, #725; without it the picker names the permission and lists nothing). Everything else stays *No access*. ElevenLabs does not document which permission each endpoint checks, so the picker and the live check below are what confirm them. Set the key's **credit limit to 10,000**, the free month, so the key alone can never spend past it after an upgrade. **Seed it** at `https://hybridcloudworks.com/admin/integrations?tab=keys`. Then, on the Audio tab of `https://hybridcloudworks.com/admin/platform-settings?tab=audio`, play and pick a voice for each host under **Podcast voices** (the code has no default voice since #725), **Save**, and press **Render a new sample** and confirm it: success is both voices playing, 257 characters billed, and credits left 257 below the month. After that, **Last sample** replays the render on every visit for no credits, so test playback there rather than rendering again. Versionless reference: a re-minted key needs an app restart to take effect |
| `AZURE-SPEECH-KEY` | Listen & Learn fallback TTS | Azure Portal → Cognitive Services / Speech resource → Keys and Endpoint | Inert until a Cognitive Services resource exists, which is a spend decision |
| `FIRECRAWL-API-KEY` | Content research | Firecrawl Dashboard (`https://firecrawl.dev/app/api-keys`) | Reads web page and extracts clean text |
| `REPLICATE-API-KEY` | AI router | Replicate Account Settings (`https://replicate.com/account/api-tokens`) | Generates cover images for posts |
| `PUBLER-API-KEY` | Social publishing | Publer Settings (`https://publer.io/settings`) or API playground | Owner-controlled; webhook changes need approval before activation |
| `PUBLER-WORKSPACE-ID` | Social publishing | Publer API playground (`https://publer.io` API docs/explorer; integer workspace ID) | Integer identifier, not a secret. A 401 indicates wrong workspace id |
| `RESEND-API-KEY` | Newsletter list and sending | Resend API Keys (`https://resend.com/api-keys`) created with **Full access** | ADR 0030. Created at `https://resend.com/api-keys` with **Full access** — a sending-access key cannot manage contacts or broadcasts, and the Integrations page's Resend test refuses it. Seed it before the Terraform run that adds its reference, so `monitor-unresolved-secrets.yml` never sees it unresolved |
| `LINKIE-API-KEY` | Link tooling | [app.linkie.bio/playground](https://app.linkie.bio/playground), Account Settings, API Keys ([how](https://linkie.bio/help/en/article/how-to-access-the-linkie-api-mzfuyh/)) | Manages link-in-bio pages and their posts. Create it with exactly: **Linkie pages** Read Only, **Automated posts** Read & Write (the key screen labels it **Posts**, seen 2026-10-24), **Analytics** Read Only. The hub lists pages, changes posts and reads traffic; it never writes to a page. Since October 2026 Linkie's scope names are `pages:*` (they were `profiles:*`), and a key made with only the old scopes answers 403 "Insufficient scope" |
| `TELEGRAM-BOT-TOKEN` | Notifications | Telegram BotFather (`@BotFather` in Telegram via `/token` or `/newbot`). Re-run `scripts/cutover/04-telegram-webhook.ps1` after rotation | Sends approve-or-reject messages for new content. Changing it stops notifications until webhook is re-registered |
| `TELEGRAM-CHAT-ID` | Notifications | Telegram API (`https://api.telegram.org/bot<TOKEN>/getUpdates` after messaging bot) or user chat ID | Numeric chat identifier, not a secret |
| `PODBEAN-CLIENT-ID` | Podcast publishing | Podbean Developer Portal (`https://developers.podbean.com/` → My Apps) | Issued at `https://developers.podbean.com/` (create an app; client credentials) (ADR 0029 §1c, #437). The app's client ID: an identifier, not a credential, paired with the secret below. Paste it on `https://hybridcloudworks.com/admin/integrations?tab=keys` |
| `PODBEAN-CLIENT-SECRET` | Podcast publishing | Podbean Developer Portal (`https://developers.podbean.com/` → My Apps → Client Secret) | Issued at `https://developers.podbean.com/` (create an app; client credentials) (ADR 0029 §1c, #437). Exchanged on the server for an access token; never sent to a browser. Unseeded, approving an episode leaves it on the manual upload path. After seeding both, the Podbean card's test on `https://hybridcloudworks.com/admin/integrations?tab=services` should answer `Connected — Hybrid Cloud Insights.` |
| `STREAMYARD-API-KEY` | Webinar registration & attendance | StreamYard Dashboard (`https://streamyard.com` → Team settings → Integrations → Zapier → Generate API key) | Authenticates webinar registration and attendance updates sent from StreamYard On-Air |
| `YOUTUBE-API-KEY` | Listen & Learn "watch next" links | Google Cloud Console (`https://console.cloud.google.com/apis/credentials`) scoped to YouTube Data API v3. Auto-renewal via `scripts/roll-cloud-credentials.mjs --service youtube` | Optional; without it episodes publish with an empty video list |
| `PLAUD-EMBEDDED-CLIENT-ID` | Recording Hub — upload transcription | Plaud Embedded Developer Portal (`https://docs.plaud.ai/plaud-embedded`) | Plaud Embedded Transcription API (#442), sent as `X-Client-Id`. A different credential from the Plaud MCP OAuth token pair, which lives on `mcp_servers/plaud` and never in the vault. Unseeded, the upload form answers 503 naming both settings |
| `PLAUD-EMBEDDED-API-KEY` | Recording Hub — upload transcription | Plaud Embedded Developer Portal (`https://docs.plaud.ai/plaud-embedded`) | Sent as `X-Client-Api-Key` beside the client id; issued in the Plaud Embedded portal (`docs.plaud.ai/plaud-embedded`) |
| `AWS-ACCESS-KEY-ID` | AWS pricing | AWS Management Console → IAM (`https://us-east-1.console.aws.amazon.com/iamv2/home#/users`) user `pricing-reader` (policy `pricing:GetProducts`). Auto-renewal via `scripts/roll-cloud-credentials.mjs --service aws` | Scope IAM policy to `pricing:GetProducts` only. Rotated paired with `AWS-SECRET-ACCESS-KEY` |
| `AWS-SECRET-ACCESS-KEY` | AWS pricing | AWS Management Console → IAM (`pricing-reader` access key pair). Auto-renewal via `scripts/roll-cloud-credentials.mjs --service aws` | The secret half of the AWS key above. The two are always changed together |
| `GCP-BILLING-API-KEY` | Google Cloud Billing Catalog | Google Cloud Console (`https://console.cloud.google.com/apis/credentials`) scoped to Cloud Billing Catalog API. Auto-renewal via `scripts/roll-cloud-credentials.mjs --service gcp-billing` | Restricted API key for Cloud Billing Catalog API. Rotated via Google Cloud API Keys v2 API |
| `QLTY-API-TOKEN` | Health Hub Code and Security tab | Qlty Settings (`https://qlty.sh/user/settings/tokens`), personal access token with read permissions | #569. A personal access token from `https://qlty.sh/user/settings/tokens`, read-only use: the project's open issues and metrics. Seed it on the Integrations Keys tab before the Terraform run that adds its reference, so `monitor-unresolved-secrets.yml` never sees it unresolved. Unseeded, the tab says Qlty is not configured |
| `TURNSTILE-SECRET-KEY` | Landing Zone Builder's "Validate on the lab" | Cloudflare Dashboard (`https://dash.cloudflare.com/?to=/:account/turnstile`) → Turnstile widget for `hybridcloudworks.com` → Settings → Secret Key | **SET 2026-09-28**, and resolving: the owner seeded it that day and ran Validate on the lab end to end from `https://hybridcloudworks.com/tools/landing-zone` ([ADR 0032](../decisions/0032-learner-labs-platform.md), amendment of 2026-09-28). The **secret key** of the Cloudflare Turnstile widget whose site key is `VITE_TURNSTILE_SITE_KEY` (§4.2); the Function App setting `TURNSTILE_SECRET_KEY` is a Key Vault reference to it, and `functions/src/lib/labs/public-lock.js` sends it to Cloudflare's siteverify and nowhere else. The widget is created in the Cloudflare dashboard at `https://dash.cloudflare.com/?to=/:account/turnstile`, not by Terraform, because `cloudflare_turnstile_widget` would hold this secret in state. **Seed it** at `https://hybridcloudworks.com/admin/integrations?tab=keys` (Hybrid Lab section, *Cloudflare Turnstile — secret key*) once the functions deploy that lists it has run. It cannot go first, as `RESEND-API-KEY` did: that page offers only what the deployed catalogue lists, and `deploy-functions.yml` will not start until the Terraform run adding the reference has applied. So between that run and the seed it was an expected unresolved reference (`EXPECTED_UNRESOLVED` in `scripts/check-unresolved-secrets.mjs`), reported every run but not as a failure; it came off that list once seeded, so an unresolved one now fails `monitor-unresolved-secrets.yml` like any other. Unresolved, the status read answers `TURNSTILE_NOT_CONFIGURED`, the builder says validation on the lab isn't available right now, and the lab takes no public job. Rotate by rotating it in the widget's settings and pasting the new value here |
| `CLOUDFLARE-ANALYTICS-TOKEN` | Ambassador hub — the monthly audience figure (#1302) | Cloudflare Dashboard (`https://dash.cloudflare.com/profile/api-tokens`) → Create Token → Custom token: permission **Account → Account Analytics → Read** and nothing else; Account Resources limited to the HybridCloudWorks account; TTL an end date at most a year out | **MISSING** (2026-10-20): an expected unresolved reference (`EXPECTED_UNRESOLVED` in `scripts/check-unresolved-secrets.mjs`) until seeded, and taken off that list when it is, so an unresolved one then fails `monitor-unresolved-secrets.yml` like any other. The read-only token `ambassadorAudienceMonthly` (`functions/src/lib/timers/ambassador-audience.js`) sends as a Bearer header to `https://api.cloudflare.com/client/v4/graphql` and nowhere else, to read the previous month's page views for the site in `CF_WEB_ANALYTICS_SITE_TAG` (§4.5). A **second** Cloudflare token, deliberately: the workspace's `cloudflare_api_token` (§4.1) writes DNS and account settings, and the Function App has no business holding it; this one reads page-view totals and changes nothing, so a leak reads a number. Name it where it lives / what uses it / what it reaches, the owner's convention of 2026-10-18: `azure-functions-cloudflare-analytics-account`. **Seed it** at `https://hybridcloudworks.com/admin/integrations?tab=keys` (*Cloudflare analytics token*) once the functions deploy that lists it has run; that page offers only what the deployed catalogue lists. Unresolved, the timer logs one line naming the setting and records nothing — no monthly figure, and not a failed run. Rotate by minting a new token at the same dashboard page, pasting it on Integrations → Keys, then revoking the old one |
| `CODER-URL` | Hybrid Lab status proxy | Host configuration: `https://coder.lab.hybridcloudworks.com` (public HTTPS endpoint on VPS host) | Base URL of the Coder deployment the Function App's status proxy reads; an address, not a credential, kept in the vault so its reference follows the same path as the token beside it. Its value is known before the host exists: `https://coder.lab.hybridcloudworks.com`, so seed it as soon as the reference is applied. Since 2026-09-28 it is the one setting the lab panes on the site need: with it resolved and Coder answering (`/api/v2/buildinfo`, no token), each lab's page opens its pane. Vault names are hyphenated and app settings underscored, per the naming table in [Variables and secrets](variables-and-secrets.md) |
| `CODER-STATUS-TOKEN` | Hybrid Lab status proxy | Lab Host Coder container CLI: `ssh hcw-lab` → `coder tokens create --user hcw-status` (permissions: `template:read`, `workspace:read`) | Read-only Coder API token for the status proxy. Coder issues it, so it can only be seeded after Coder runs on the lab host (#661) and the owner creates it (#682). The least-privileged form on Coder Community v2.37.3, measured 2026-09-28: a token scoped `template:read` and `workspace:read`, minted by the owner with `coder tokens create --user` for a Coder user of its own, `hcw-status`, that holds Template Admin, the only role below Owner whose token counts other users' running workspaces. The owner's steps, through `ssh hcw-lab` and the `coder` container's CLI with a token the owner makes in a pane, are in `lab-host/README.md`, "The status token for the site". It expires after a year and nothing renews it. It adds only the labs card's templates and running count: since 2026-09-28 the panes open without it, and without it (or with one Coder refuses) the card says only that Coder is reachable and the Function App logs a warning naming `CODER-STATUS-TOKEN`. It was an expected unresolved reference (`EXPECTED_UNRESOLVED` in `scripts/check-unresolved-secrets.mjs`) until it was seeded, and #765 removed it from that list |

## 4.6b Custom role definitions — owner-created, once

Five custom roles are referenced by `infra/` and **not created by it**.
`azurerm_role_definition` needs `Microsoft.Authorization/roleDefinitions/write`,
and the HCP Terraform run identity is Contributor + Role Based Access Control
Administrator. Neither carries it: Contributor excludes
`Microsoft.Authorization/*/Write` outright, and RBAC Administrator grants
`roleAssignments/write` plus `*/read` and nothing more. The identity may assign
roles; it may not invent them, and that split is deliberate.

So Terraform reads each definition back with `data "azurerm_role_definition"`.
Until the owner has created them, the **plan** fails with "role definition not
found" — which reads like a permissions problem and is actually a missing step
here. Run the parameterized bootstrap script once, from an account with Owner or User Access Administrator on
the subscription:

```powershell
# Defaults to active subscription from `az account show` if -SubscriptionId is omitted:
pwsh scripts/bootstrap-roles.ps1 -SubscriptionId "<workload-subscription-id>" -ManagementSubscriptionId "<mgmt-subscription-id>"
```

Or on POSIX shells:

```bash
# bash
scripts/bootstrap-roles.sh "<workload-subscription-id>" "<mgmt-subscription-id>"
```

| Role | Grants | Consumer |
| --- | --- | --- |
| `HCW Key Vault Secret Writer` | `setSecret` and nothing else — no get, no list, no delete, no purge | The API Keys page, so a pasted credential cannot be read back out |
| `HCW Function Config Refresh` | `Microsoft.Web/sites/config/Write`, with `config/list/action` excluded | The API Keys page, so a seeded secret goes live in seconds rather than on App Service's 24-hour cache cycle |
| `HCW Function Settings Reader` | `Microsoft.Web/sites/config/list/action` and nothing else | `monitor-functions-registered.yml`, the one thing the `Reader` role cannot express — listing app settings is an action, not a read |
| `HCW Static Web App Deployer` | `Microsoft.Web/staticSites/listSecrets/action` and nothing else | `deploy-azure-frontend.yml` via OIDC to retrieve just-in-time deployment token |
| `HCW Alert Rule Reader` | Read alert rules (scheduled query rules, metric alerts, activity log alerts), action groups, and Resource Health availability statuses in `rg-web-site-prod-cus` and `rg-mgmt-plat-prod-cus` | `verify-alert-state.yml` to verify alerting fabric rules |

The first two were declared as Terraform `resource` blocks when the API Keys
page landed, which would have failed the very apply that turns the page on.
The third arrived with the identity split (T-728). Until each exists, the
Terraform plan errors with "role definition not found" — which reads like a
permissions problem and is actually this step.

A fourth, `HCW Cosmos Container Definition Writer`
(`infra/roles/cosmos-container-writer.json`), was created on 2026-08-21 for
`heal-computed-properties.yml`. #816 deleted the healer, the JSON and the
Terraform assignment; the definition itself is the owner's to delete, once,
after the apply that destroys the assignment.
`scripts/terraform-role-definitions.test.mjs` now fails CI on the `resource`
form, on a `data` lookup naming a role no JSON here registers, or if the bootstrap
scripts miss any registered role definition.

Editing a role's permissions later is `az role definition update` against the
same JSON; nothing in `infra/` moves. A **rename** is the one change that needs
both sides.

## 4.7 VPS agent (Hostinger) — `.env`, never committed

Names from `vps-agent/.env.example`. The agent holds no database credential; it
reaches the API with a certificate-backed Entra client. On the lab host the
`labs_agent` role writes them to `/etc/hcw/labs-agent.env` (root, 0600): the
first four from the Ansible vault keys in the table below, the rest from the
role's defaults and `labs_agent_id`. Provisioning the identity and writing
those four keys is one owner step, `scripts/lab/Register-LabAgent.ps1`
([Labs host runbook](../runbooks/labs-host.md), "The lab agent's go-live").

`LABS_AGENT_API_BASE` · `LABS_AGENT_API_SCOPE` · `LABS_AGENT_CLIENT_ID` ·
`LABS_AGENT_TENANT_ID` · `LABS_AGENT_CERT_PATH` · `LABS_AGENT_ID` ·
`LABS_AGENT_MAX_CONCURRENT` · `LABS_AGENT_POLL_MS` · `LABS_AGENT_JOB_CPUS` ·
`LABS_AGENT_JOB_MEMORY` · `LABS_AGENT_JOB_PIDS` · `LABS_AGENT_JOB_NOFILE`

Status: **SET**, checked on 2026-09-29. `Register-LabAgent.ps1` has run,
including its step 4, which registers the agent on Admin → Labs → Agents and
so writes the `lab_agents/vps-hostinger-01` registry document (rows below).
`hcw-labs-agent.service` is active on the host, and its `claimLabJob` and
`heartbeatLabAgent` calls answer 200. `LABS_AGENT_CERT_PATH`
(`/etc/hcw/labs-agent.pem`, generated on the host) and `LABS_AGENT_ID`
(`vps-hostinger-01`) are set by the role; on a rebuilt host the agent stays
stopped until the four vault keys exist again. The last four are resource
limits with working defaults.

**Lab host inputs named by [ADR 0032](../decisions/0032-learner-labs-platform.md).**
The ADR is Accepted (2026-09-27), and each row's status is its own: the
host exists and has been bootstrapped, so the host-side rows are
observable, while a row for a store that has not been created stays
**MISSING**. Each row is here so the name is fixed before anything consumes
it, and so a status can change in the pull request that provisions it. The
placement follows [Variables and secrets](variables-and-secrets.md): a
Terraform provider credential is a workspace variable, a value the Function
App reads is a Key Vault secret, and a credential Ansible uses once is a vault
entry that never reaches the repository.

| Name | Store | Status | Notes |
| --- | --- | --- | --- |
| `hostinger_api_token` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, sensitive | **MISSING** | `hostinger/hostinger` provider credential. Issued in the Hostinger panel; this workspace only, never `hcw-azure` |
| `cloudflare_api_token` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, sensitive | **MISSING**, rechecked 2026-10-09 (#1029): the `hcw/hcw-lab` workspace is not created yet ([Labs host](../architecture/labs-host.md)), so none of its variables exist. The lab records that resolve today were not made by it | Cloudflare provider, for the `lab` records. Same name as the §4.1 variable and a different token, with **Zone:Read + DNS:Edit** on the one zone and nothing else (the provider needs Zone:Read to resolve the zone, as `infra/variables.tf` records for the §4.1 token; the lab token omits the Transform Rules and Rulesets permissions that one carries), so it cannot touch origin rules or settings. Cloudflare scopes tokens to a zone, not a record, so this token can still edit any DNS record in `hybridcloudworks.com`; that is the accepted risk in ADR 0032, bounded by living only in HCP Terraform and by the `hcw-azure` plan check showing any production record it altered |
| Caddy `CLOUDFLARE_API_TOKEN` | Ansible Vault, written to `/etc/caddy/env` on the host (owner `root`, group `caddy`, mode `0640`; the non-root `caddy` unit reads it through `EnvironmentFile`) | **SET**, checked 2026-10-09 (#1029): `/etc/caddy/env` is `root:caddy` `0640` and holds `CLOUDFLARE_API_TOKEN` with a value (its name read, never the value), and the host serves a Let's Encrypt wildcard for `*.lab.hybridcloudworks.com`, issued 2026-09-27, which only a DNS-01 challenge, and so this token, can obtain | Runtime DNS-01 token for certificate renewals. Since 2026-10-18 (#948) scoped to the dedicated lab zone `hybridcloudinsights.com` alone (*Zone → DNS → Edit* and *Zone → Zone → Read* on that zone, client-IP filter `Allow` **both** of the lab host's addresses, 148.230.91.226 and 2a02:4780:2d:bb25::1/128, because the host reaches the Cloudflare API over IPv6 since the 2026-10-18 rebuild and issuance failed until the second was added; a one-year end date; on a rebuild the token is **rolled**, which keeps its name and scope), the zone that `_acme-challenge.lab.hybridcloudworks.com` and `_acme-challenge.coder.lab.hybridcloudworks.com` are delegated to; Caddy writes there through `dns_challenge_override_domain`. The earlier production-zone token was revoked on 2026-10-18 after the first issuance through the delegation (21:04Z). Rotate on every host rebuild |
| `cloudflare_zone_id` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, not sensitive | **MISSING** | The `hybridcloudworks.com` zone identifier every `cloudflare_dns_record` needs (`infra/frontend.tf` uses `var.cloudflare_zone_id` for the same reason). Variables do not cross workspaces, so the same value is set here a second time. An identifier, not a credential; read it from the zone's Overview page in the Cloudflare dashboard |
| `hostinger_vps_id` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, not sensitive | **MISSING** | The id of the VPS the owner **already has**, which `infra-lab/main.tf` adopts with an `import` block. Creating a `hostinger_vps` calls Hostinger's purchase endpoint, so this value is what keeps the first plan an import and not a second server. The `id` field of `GET /api/vps/v1/virtual-machines`, and the number in the server's hPanel URL (`infra-lab/README.md`, step 1) |
| `hostinger_plan` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, not sensitive | **MISSING** | The `plan` field of the same response, copied exactly (for example `KVM 4`). ForceNew in the provider, so `infra-lab/main.tf` ignores changes to it and a postcondition fails the plan if it disagrees with the server rather than planning a cancel-and-purchase |
| `hostinger_data_center_id` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, not sensitive | **MISSING** | The `data_center_id` field of the same response. Guarded the same way as `hostinger_plan` |
| `hostinger_template_id` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, not sensitive | **MISSING** | The `template.id` field of the same response, the installed OS; `lab-host/bootstrap.sh` requires Ubuntu 26.04 LTS (and still accepts 24.04 LTS as a fallback). A change in the provider reinstalls the disk, so it is ignored and asserted like the two above; a reinstall is an hPanel decision, after which this is updated to match |
| `lab_hostname` | `infra-lab/variables.tf` default | **SET** by default (`lab.hybridcloudworks.com`) | The lab A record and the parent of the `*.lab`, `coder.lab` and `*.coder.lab` CNAMEs. No workspace entry needed |
| `ssh_public_key` | HCP Terraform workspace `hcw/hcw-lab`, Terraform variable, not sensitive | Optional, unset | The owner's SSH public key (`ssh-ed25519` or `ssh-rsa`; the provider refuses ECDSA). Set only if root has no key yet, as a second plan after the adoption (`infra-lab/README.md`, step 6): it registers the key in the Hostinger account and attaches it, which the `hardening` role then copies to `hcwadmin` |
| Arc onboarding service principal credential (`vault_arc_service_principal_id`, `vault_arc_service_principal_secret`) | Ansible Vault on the host, never in the repository or on the desktop; the `arc` role passes them to `azcmagent connect` in a root-only temporary `--config` file it deletes in the same run | **MISSING** | The application id and client secret of `sp-arc-onboarding-lab-hybrid-prod-cus`, which holds only *Azure Connected Machine Onboarding* on `rg-lab-hybrid-prod-cus` (`infra/lab-hybrid.tf`, granted through `arc_onboarding_principal_id` in §4.1). Written by `scripts/lab/Register-LabArc.ps1` through the host's `/usr/local/sbin/hcw-vault-set`: the secret is valid for 24 hours and goes from `az`'s output to `ssh`'s standard input, never printed or written to a file. Used once. Its `-Connect` run deletes the secret from Entra and all four `vault_arc_*` keys from the vault as soon as the host reads Connected ([Labs host runbook](../runbooks/labs-host.md), "Arc onboarding", step 4); the role needs none of them on a Connected host. Re-onboarding mints a new secret |
| `vault_arc_tenant_id`, `vault_arc_subscription_id` | Ansible Vault on the host, beside the credential | **MISSING** | The Entra tenant id and the `sub-app-site-prod-cus` subscription id `azcmagent connect` targets, the latter resolved by name by the same script. Identifiers, not secrets; kept in the vault because nothing else in the repository commits them, and removed with the credential |
| `arc_enabled` | The host: the local fact `/etc/ansible/facts.d/hcw_arc.fact`, which `lab-host/ansible/group_vars/all.yml` reads (not a secret) | **SET**: the fact exists on the host (checked 2026-09-29), and the machine is connected to Arc (#663) | True only when that file is JSON whose `enabled` is `true`. Written by `Register-LabArc.ps1 -Connect` once the grant is applied and the credential is in the vault; removed to turn Arc off ([Labs host runbook](../runbooks/labs-host.md), "Disconnecting"). On the host rather than in the repository because a rebuilt host is not onboarded, and a repository-wide `true` would stop its first run at the role's fail-closed check |
| `arc_agent_version`, `arc_apt_key_checksum`, `arc_resource_group`, `arc_location`, `arc_resource_name`, `arc_tags` | `lab-host/ansible/group_vars/all.yml` (not secrets) | **SET** | The `arc` role's pins and target: agent `1.68.03532.1399`, Microsoft's signing key by SHA256, `rg-lab-hybrid-prod-cus` in `centralus`, machine name `arcs-lab-hybrid-prod-cus-01` |
| `CODER_OAUTH2_GITHUB_ALLOWED_TEAMS` | `lab-host/ansible/group_vars` as `coder_oauth2_github_allowed_teams` (not a secret), rendered into Coder's Compose env file | **SET 2026-10-16**: `[HybridCloudWorks/lab-learners]` (owner decision that day, #954) | The GitHub teams, each `<organisation>/<team-slug>`, whose members may sign in to Coder. **Never empty while Coder runs** (an empty value lets every member of the allowed organisations in), and each team's organisation must be in `CODER_OAUTH2_GITHUB_ALLOWED_ORGS`, because Coder checks a team only inside an organisation the learner already passed; the `coder` role fails otherwise. Sign-ups are off beside it (`coder_oauth2_github_allow_signups: false`), so a learner's account is created by the owner (`docs/runbooks/labs-host.md`, "Coder sign-in: adding and removing a learner") |
| `CODER_OAUTH2_GITHUB_ALLOWED_ORGS` | `lab-host/ansible/group_vars` (not a secret), rendered into Coder's Compose env file | **SET 2026-09-28**: `[HybridCloudWorks]`, with `coder_enabled: true` (owner decision that day) | The GitHub organisations whose members may sign in to Coder. Required by ADR 0032 and **never empty while Coder runs**: an empty value removes the restriction and lets any GitHub account consume the VPS, so the Ansible role fails rather than render an empty list. Shutting learners out is an explicit action, not an emptied list: one learner by taking them out of the `lab-learners` team and suspending their Coder account, everyone by stopping the `coder` Compose service. Sign-ups are off as the normal setting since 2026-10-16 (#954), so no sign-in creates an account. The owner names the organisation on #682 |
| Coder GitHub OAuth app client id and secret (`CODER_OAUTH2_GITHUB_CLIENT_ID`, `CODER_OAUTH2_GITHUB_CLIENT_SECRET`) | Ansible Vault as `vault_coder_oauth2_github_client_id` and `vault_coder_oauth2_github_client_secret`, written by the `coder` role to `/etc/hcw/coder/coder.env` on the host (root, 0600) | **SET** in the host's vault (checked by key name, 2026-09-28) | Learner sign-in to Coder; nothing on the site reads it. Created by the owner in the GitHub organisation's OAuth apps (#682). Rotate on every host rebuild and whenever the app's callback URL changes; the env file is regenerated from Vault on each Ansible run and the `coder` container is recreated when it changes, so rotation is a Vault edit and a run |
| Coder PostgreSQL password (`POSTGRES_PASSWORD`, and inside `CODER_PG_CONNECTION_URL`) | Ansible Vault as `vault_coder_postgres_password`, written by the `coder` role to `/etc/hcw/coder/coder-postgres.env` (the database) and `/etc/hcw/coder/coder.env` (Coder), both root 0600 | **SET** in the host's vault (checked by key name, 2026-09-28) | The `coder` database user's password on the Compose network; never reachable from outside the host. Generate with `openssl rand -hex 32`: the role refuses any character outside RFC 3986 unreserved because the value sits unescaped in the connection URL. The database stores it at first initialisation, so rotation is `ALTER USER` first and then the Vault edit and run (`lab-host/README.md`, "Rotating the PostgreSQL password") |
| `vault_addon_migration_turnstile_secret` | Ansible Vault on the host, set with `hcw-vault-set`; the `addons` role renders it into the `hcw-addon-migration` container's `TURNSTILE_SECRET` and refuses to start the container while the key is unset | **MISSING** until the owner creates the add-on's human-verification widget and seeds the key ([Labs host runbook](../runbooks/labs-host.md), "Tool add-ons") [REVIEW REQUIRED]: one widget per add-on, separate from the site's own | The **secret key** of the migration add-on's own Cloudflare Turnstile widget (hostname `migration.lab.hybridcloudworks.com`), which the add-on sends to siteverify on every upload and nowhere else ([ADR 0035](../decisions/0035-addon-pane-model.md) decision 6; [AddOn integration standard](addon-integration-standard.md) §12). Separate from `TURNSTILE-SECRET-KEY` (§4.6), which is the site's widget for the Landing Zone Builder. Never on the site, in Key Vault, in `group_vars` or in the image. Rotate in the widget's settings, then the vault key and a `bootstrap.sh` run |
| `AMO_TURNSTILE_SITE_KEY` (the migration add-on's public site key) | `lab-host/ansible/group_vars/all.yml`, `addons[].env` for id `migration` (not a secret) | **SET** to Cloudflare's documented test key `1x00000000000000000000AA` by the ADR 0035 pull request [VERIFY]: the owner replaces it with the widget's site key when the widget is created; the `addons` role refuses to deploy a row whose environment still carries a test key, since the widget's real secret rejects the token a test key produces | The site key of the same widget, public by construction (the add-on publishes it in `/api/health.turnstile.siteKey` and renders the widget from it inside the pane). Required whenever the secret is set: the add-on refuses to start with a secret and no site key. The test key makes every challenge pass, so it must not outlive the widget's creation |
| `CODER-URL` | Key Vault `kv-site-prod-cus-01`; the Function App setting `CODER_URL` is a Key Vault reference to it | **SET**: the Key Vault reference resolves (ARM `configreferences`, checked 2026-09-29) | Base URL of the Coder deployment the Function App's status proxy reads; an address, not a credential, kept in the vault so its reference follows the same path as the token beside it. Its value is known before the host exists: `https://coder.lab.hybridcloudworks.com`, so seed it as soon as the reference is applied. Since 2026-09-28 it is the one setting the lab panes on the site need: with it resolved and Coder answering (`/api/v2/buildinfo`, no token), each lab's page opens its pane. Vault names are hyphenated and app settings underscored, per the naming table in [Variables and secrets](variables-and-secrets.md) |
| `CODER-STATUS-TOKEN` | Key Vault `kv-site-prod-cus-01`; the Function App setting `CODER_STATUS_TOKEN` is a Key Vault reference to it | **SET 2026-09-28**: the Key Vault reference resolves (ARM `configreferences`, checked 2026-09-29). Expires 2027-09-28; #763 is the renewal | Read-only Coder API token for the status proxy. Coder issues it, so it can only be seeded after Coder runs on the lab host (#661) and the owner creates it (#682). The least-privileged form on Coder Community v2.37.3, measured 2026-09-28: a token scoped `template:read` and `workspace:read`, minted by the owner with `coder tokens create --user` for a Coder user of its own, `hcw-status`, that holds Template Admin, the only role below Owner whose token counts other users' running workspaces. The owner's steps, through `ssh hcw-lab` and the `coder` container's CLI with a token the owner makes in a pane, are in `lab-host/README.md`, "The status token for the site". It expires after a year and nothing renews it. It adds only the labs card's templates and running count: since 2026-09-28 the panes open without it, and without it (or with one Coder refuses) the card says only that Coder is reachable and the Function App logs a warning naming `CODER_STATUS_TOKEN`. It was an expected unresolved reference (`EXPECTED_UNRESOLVED` in `scripts/check-unresolved-secrets.mjs`) until it was seeded, and #765 removed it from that list |
| `vault_labs_agent_api_base`, `vault_labs_agent_tenant_id`, `vault_labs_agent_client_id`, `vault_labs_agent_api_scope` | Ansible Vault on the host (`/etc/hcw/ansible/vault.yml`); the `labs_agent` role writes them to `/etc/hcw/labs-agent.env` as `LABS_AGENT_API_BASE`, `LABS_AGENT_TENANT_ID`, `LABS_AGENT_CLIENT_ID` and `LABS_AGENT_API_SCOPE` | **SET**: `/etc/hcw/labs-agent.env` exists on the host, and the agent authenticates with them (checked 2026-09-29) | Identifiers, not secrets. Written by `scripts/lab/Register-LabAgent.ps1`, which merges only these four into the vault, or creates it with only these four when it does not exist, and never prints another key. The API base is the Cloudflare hostname `https://api-azure.hybridcloudworks.com/api`, because the origin lock (`functions_origin_lock_enabled`, §4.1) refuses the lab host at the `azurewebsites.net` host. The scope is `api://<HCWSite API client id>/.default` |
| Agent app registration and service principal `sp-labs-agent-lab-hybrid-prod-cus-01` | Entra, owner-created by `Register-LabAgent.ps1`; `infra/` has no `azuread` provider | **SET**: the service principal exists in Entra (checked 2026-09-29) | Single tenant, no client secret, the lab host's public certificate as its credential (appended, never replacing another), and one grant: the `LabAgent` app role on the HCWSite API, gate 1 of the agent guard. One registration per agent host |
| `lab_agents/vps-hostinger-01` | Cosmos DB `cosmos-site-prod-cus`, database `hcw`, container `lab_agents` (partition key `/id`), written only through the API | **SET**: the agent is registered; its `claimLabJob` and `heartbeatLabAgent` calls answer 200 and it completed its first jobs on 2026-09-28 (Application Insights, checked 2026-09-29) | Gate 2 of the agent guard: `oid` the agent's service principal object id, `active: true`, `capabilities` the job types it may claim. Identifiers, not secrets. Written by **Register agent** at https://hybridcloudworks.com/admin/labs?tab=agents (`POST /api/cms/labs/agents`, editor or above, #740) with the agent id and the object id `Register-LabAgent.ps1` prints and waits on; **Deactivate** and **Activate** on the agent's card (`PATCH /api/cms/labs/agents/{agentId}`) revoke and restore it. The container's firewall admits only the Function App's subnet, so the API is the only writer. Until it exists the agent authenticates and is refused with `Agent access required` |
| `portainer_enabled`, `portainer_image`, `portainer_image_tag`, `portainer_image_digest` | `lab-host/ansible/group_vars/all.yml` (not secrets) | **SET** (`portainer_enabled: true`, #729) | The `portainer` role's switch and pin: Portainer Business Edition 2.45.2 (LTS) by index digest (2.45.1 at the 2026-09-26 decision; the pin has moved since), published on `127.0.0.1:9443` only (ADR 0032, amendment of 2026-09-26). `portainer_enabled` went `true` in #729 (owner decision 2026-09-26); `false` in a pull request turns it off and keeps its volume |
| Portainer administrator password | The owner's password manager; Portainer keeps its own copy in the `portainer-data` volume on the host. Never in the repository or Ansible Vault | **MISSING** (created at the first sign-in) | Created by the owner in Portainer's setup screen through the SSH tunnel, with the one-time setup token Portainer prints in its log ([Labs host runbook](../runbooks/labs-host.md), "Portainer through an SSH tunnel"). At least 12 characters. A host rebuild wipes the volume, so a new one is created after every rebuild |
| Portainer Business Edition licence key | Entered in Portainer's UI and kept in its volume; the owner keeps the key as Portainer issued it. Never in the repository or Ansible Vault | **MISSING** on the host | Portainer's 3 Nodes Free licence: one server instance, up to three nodes, internal business use, renewed yearly at no cost. The key the pre-reinstall server used may be reused, since that server no longer runs it; https://www.portainer.io/take-3 issues a new one |
| `vault_portainer_api_token` | Ansible Vault on the host, set with `hcw-vault-set`; the `portainer` role renders it to `/etc/hcw/portainer/api-token` (root, 0600, in a root 0700 directory), which `hcw-portainer-check.service` reads through `LoadCredential`, never on a command line, in the environment or in a log. The role never declares the key, because `hcw-vault-set` refuses a key the playbook defines | **SET 2026-10-19** (owner, #1282), **read live the same day**: the `bootstrap.sh` run of 07:13–07:17Z wrote `/etc/hcw/portainer/api-token` (07:16Z) and made the first read before it ended; the check's first line read `Portainer 2.45.2 EE up; environment local up with 8 containers (8 running, 0 unhealthy, 0 restarting, 0 exited); 8 images checked, 0 outdated; reported to the site`; the timer has repeated it every 15 minutes since (`journalctl -t hcw-portainer-check`) | The owner's own Portainer access token, description `hcw-portainer-write`, kept on the owner's administrator account (owner decision 2026-10-19 on #1282; a separate read-only Portainer user was proposed and declined). It carries the owner's whole authority in Portainer, which is why it is root-only and reaches the check as a credential, and why the check is held to `GET` by its test (`lab-host/ansible/roles/portainer/README.md`, "The check"). Its one consumer is `hcw-portainer-check`, which reads Portainer on the loopback every 15 minutes and reports counts and states, never a container's or an image's name, to the Health Hub's **Portainer** card (`lab-host/README.md`, "The Portainer check"). Rotate on every host rebuild: a new token in Portainer, `hcw-vault-set`, `bootstrap.sh`. The durable copy is the owner's password manager |
| `vault_enabled`, `vault_version`, `vault_checksum`, `vault_pgp_key_checksum` | `lab-host/ansible/group_vars/all.yml` (not secrets, and not Ansible Vault keys despite the prefix, which is the role's name) | **SET** (`vault_enabled: true`, #729) | The `vault` role's switch and pins: HashiCorp Vault 2.1.1, the SHA256 of its linux amd64 archive from the signed SHA256SUMS, and the SHA256 of HashiCorp's signing key (ADR 0032, amendment of 2026-09-26). `vault_enabled` went `true` in #729 (owner decision 2026-09-26); `false` in a pull request stops it and keeps `/var/lib/vault` |
| HashiCorp Vault unseal keys (five, three to unseal) and initial root token | The owner's password manager only. Never on the host, in the repository, in a log, in an issue or chat, or in Ansible Vault | **SET** (initialised with five shares and a threshold of three; owner-reported 2026-09-29) | Printed once by `vault operator init` over SSH ([Labs host runbook](../runbooks/labs-host.md), "HashiCorp Vault: initialising and unsealing"); Vault keeps no copy, and without three keys it stays sealed for good. Three are needed after every restart and reboot until the owner moves the host to auto-unseal (#726). From then on they are **recovery keys**: kept, because they authorise `generate-root`, a rekey and a migration back, and no longer able to unseal. A host rebuild makes them useless: delete them then and initialise the new Vault. This Vault holds lab-host secrets only; production secrets stay in `kv-site-prod-cus-01` |
| The auto-unseal switch, `/etc/ansible/facts.d/hcw_vault_seal.fact` (`{"enabled": true}`; `"disabled": true` beside it migrates back) | The host, written by the owner; `lab-host/ansible/group_vars/all.yml` reads it as `vault_seal_azurekeyvault_enabled` (not a secret) | **SET** 2026-09-29, on (the owner accepted it, [ADR 0032, amendment of 2026-09-29](../decisions/0032-learner-labs-platform.md#amendment-2026-09-29-vault-auto-unseal-through-the-arc-identity)) | Turns on Vault's `seal "azurekeyvault"` stanza for this installation. The `vault` role writes the stanza only after reading the key through Key Vault as the Arc identity. Written as step 4 of the [Labs host runbook](../runbooks/labs-host.md), "HashiCorp Vault: moving to auto-unseal"; a rebuilt host has none |
| Lab-only Key Vault `kv-labhybrid-prod-cus-01`, its key `vault-seal`, and the Arc identity's grant on the key | `infra/lab-hybrid.tf` (not secrets: the key never leaves Key Vault) | **MISSING** until the `hcw-azure` apply after #726 merges | RSA 3072, `wrapKey` and `unwrapKey` only, purge protection and `prevent_destroy`. The grant is Key Vault Crypto Service Encryption User on the key alone, for the principal Terraform reads from `arcs-lab-hybrid-prod-cus-01` at plan time. The `vault` role's defaults name the same vault and key, and `scripts/lab-host-vault-seal.test.mjs` fails when they differ |

## 4.8 Frontend build-time variables

`VITE_*` is contractual to Vite and never renamed. These are **build-time
substitutions, not runtime configuration**: whatever value is present when the
Static Web App is built is baked into the bundle, so nothing sensitive may ever
be one. All are non-sensitive by construction — client IDs, public URLs, and
the Turnstile site key, which Cloudflare itself puts in the page.

Seven of the nine are repository variables of the same name (§4.2). The two
exceptions:

| Name | Status | Notes |
| --- | --- | --- |
| `VITE_AZURE_FUNCTIONS_URL` | **SET** at build time from the `FUNCTIONS_URL` repository variable (§4.2) | `deploy-azure-frontend.yml` passes `vars.FUNCTIONS_URL` in with `REQUIRE_API_BASE: 'true'`, so a production build without it fails rather than shipping an SPA with no API base. The value is the cross-origin `api-azure` hostname with its `/api` prefix (`frontend/src/lib/functionsBase.js`). Also in `frontend/.env.example` for local development |
| `VITE_CF_WEB_ANALYTICS_TOKEN` | unset at build time until the `CF_WEB_ANALYTICS_TOKEN` repository variable (§4.2) is set (#1302) | `deploy-azure-frontend.yml` passes `vars.CF_WEB_ANALYTICS_TOKEN` in under this name, and `frontend/scripts/cf-web-analytics.mjs` builds the Cloudflare Web Analytics beacon into every page from it, before `</head>`, where the pre-render keeps it. Public by nature: it is the token the beacon carries in every page. Unset, the build emits no tag at all; a value that is not token-shaped fails the build naming this variable |

## 4.9 Local development

No secrets are required to run the frontend or the functions locally.

```
az login
```

`DefaultAzureCredential` picks that session up. **No `COSMOS_KEY` is needed and
none works** — `cosmos_local_auth_disabled` means the account refuses key auth
outright. Setting one switches the client to a key path the account rejects,
and the failure reads as a connectivity problem rather than a configuration
one.

## 4.10 Terraform outputs

Their role in this inventory is that they are the *source* of §4.2 rather than
a thing to be provisioned. `scripts/set-github-variables.ps1` reads them and
writes the repository variables; nothing there is set by hand, except
`CF_WEB_ANALYTICS_TOKEN`, which the script does not seed yet (#1302) and the
owner copies from the `web_analytics_site_token` output.

**Twenty-nine, and they live in two files.** Twenty-two in `infra/outputs.tf`
and seven in `infra/oidc.tf`.

**This count has now been wrong four times, each in the same way**, so the
method matters more than the number. It said twenty-three when first written,
omitting `deploy_principal_id`, because it was built by reading `outputs.tf`
alone. It was corrected to twenty-four on 2026-08-25 against the apply's own
output block. It then stayed at twenty-four while `swa_token` was retired
(#296, in favour of a token minted per run) and `reader_client_id` was added
(T-728) — two changes in opposite directions that happened to leave the total
looking plausible. Found in review on 2026-09-01, alongside the
`cloudflare_plan` removal below. It then said twenty-three again from
2026-09-05, when `copilot_review_client_id` was added to `oidc.tf` (#368), until the
sweep of 2026-09-29 (#819) counted the files: the same failure, one output
the other way. And `oidc.tf` read five from 2026-10-11, when
`alert_reader_client_id` arrived (#1053) without its line here, until #1098
ran the command below and found six before adding a seventh. And
`outputs.tf` read nineteen from 2026-10-14, when
`lab_hybrid_backups_storage_account` arrived with LAB-9 (#1147) without its
line here, until #1302 ran the command and found twenty before adding two.

**Count by reading the files, never by adjusting the previous number:**

```bash
grep -c '^output "' infra/outputs.tf infra/oidc.tf
```

It prints one line per file, not a total — which is what this section needs,
because it quotes both numbers:

```
infra/outputs.tf:22
infra/oidc.tf:7
```

The total is their sum. Said explicitly because "the command that produces the
count" implied a single number, and a command whose output does not look like
the thing it was described as producing is how a reader concludes they ran it
wrong.

From `infra/outputs.tf` (22): `api_base_url` · `app_principal_id` ·
`blob_endpoint` · `cosmos_database` · `cosmos_endpoint` ·
`cosmos_resource_group` · `function_app_name` · `function_hostname` ·
`function_url` · `functions_storage_account` · `insights_connection` ·
`lab_hybrid_backups_storage_account` · `storage_account` ·
`storage_resource_group` · `subnet_id` · `swa_hostname` · `vault_name` ·
`vault_uri` · `web_analytics_site_tag` · `web_analytics_site_token` ·
`web_resource_group` · `workspace_id`

**`web_analytics_site_token` and `web_analytics_site_tag` (#1302) are not
sensitive**, and not an exception to `outputs.tf`'s no-key rule, because
neither is a key: the token is the value the page's beacon carries, readable
in any browser's view-source, and the tag is the site's identifier in the
Cloudflare API path; the API authenticates with an API token, which these are
not. Both read `null` until `cloudflare_account_id` (§4.1) is set, through
`one()` over the counted resource, so a consumer gets "not created yet"
rather than an index error. The first is what `CF_WEB_ANALYTICS_TOKEN` (§4.2)
is copied from; the second is written into `CF_WEB_ANALYTICS_SITE_TAG` (§4.5)
by Terraform itself.

**`swa_token` is not among them.** It was retired in #296 (T-727): the Static
Web Apps deployment token is now read from ARM under the federated identity on
each run and lives for that run, rather than sitting in Terraform state and on
the HCP Terraform outputs page.

**`cloudflare_plan` was removed on 2026-09-01** and is not replaced. It read
`data.cloudflare_zone.current.plan`, which the Cloudflare provider deprecated in
v5 in favour of `/zones/{zone_id}/subscription` — reachable only through the
`cloudflare_zone_subscription` **resource**, which would put Terraform in charge
of the subscription and, in the provider's own words, "create/cancel associated
subscriptions". Not a trade worth making for a value nothing consumes.

The plan tier still matters — ADR 0024, the [availability probe runbook](../runbooks/availability-probe.md),
`infra/observability.tf` and `infra/variables.tf` all reason about "this
Cloudflare plan", because Bot Fight Mode, Origin Rules' Host Header override and
mTLS gate on it. Read it from the zone's Overview page in the Cloudflare
dashboard when a decision turns on it; it changes only when someone deliberately
changes it.

From `infra/oidc.tf` (7): `client_id` · `reader_client_id` ·
`alert_reader_client_id` · `manifest_window_client_id` ·
`copilot_review_client_id` · `deploy_principal_id` · `federated_subjects`

`reader_client_id` arrived with T-728, which split the read-only identity out
of the deploy identity — `monitor-functions-registered.yml` and
`monitor-unresolved-secrets.yml` authenticate with it.
`alert_reader_client_id` (#1053) is `verify-alert-state.yml`'s, and
`manifest_window_client_id` (#1098) is `publish-content-manifest.yml`'s; both
workflows used the reader before.
`copilot_review_client_id` is the read-only identity Copilot code review and
the Copilot cloud agent sign in as (`COPILOT_REVIEW_CLIENT_ID`, §4.2).

The four scratch outputs that fed §4.2's three now-deleted variables are gone
from `infra/outputs.tf`.

## 4.11 Docker Hub OIDC connection — owner-created, in Docker Home

The connection that lets `publish-lab-image.yml` push the lab images to
Docker Hub with no stored credential (#779). It lives on Docker's side, in
the `hybridcloudworks` organisation, and nothing in the repository can
create or read it. GitHub proves which workflow is running with its OIDC
token, and the connection's ruleset decides whether that token gets a
short-lived Docker access token, and for which repositories. The owner's
steps, with every field value, are in
[Docker Hub publishing](../runbooks/docker-hub-publishing.md).

| Input | Store | Status | Notes |
| --- | --- | --- | --- |
| OIDC connection with one ruleset | Docker Home, organisation `hybridcloudworks`, **Identity & auth** → **OIDC connections**. Created by an organisation owner or editor | Created 2026-09-29; first publish run 36516945081 succeeded. Rule to be edited by the owner after the 2026-10-07 transfer to `saulpatinojr` | Ruleset label `publish-lab-image-main`. Rule (subject claim) `repo:saulpatinojr@34853639/HCW-HybridCloudWorks@1268997852:ref:refs/heads/main`, the immutable form this repository's tokens carry since the transfer (before it, `HybridCloudWorks@312844660`) (`infra/oidc.tf` records the same subject for Azure). Resources: `hybridcloudworks/hcw-lab` and `hybridcloudworks/hcw-lab-runner` only. Scopes: read and write. Needs a Docker Team, Business or Hardened Images subscription, or the Docker-Sponsored Open Source programme (#678); the organisation's plan was not readable from outside Docker Home |
| Connection ID | GitHub repository variable `DOCKERHUB_CONNECTION` (§4.2) | Set 2026-09-29 | Copied from the connection after it is created |
| Docker Hub repositories `hybridcloudworks/hcw-lab`, `hybridcloudworks/hcw-lab-runner` | Docker Hub | **SET**, public, both populated since run 36516945081 (2026-09-29), same digests as GHCR | A ruleset can only name a repository that exists, so these come before the connection. Recreate as **Public** at `https://hub.docker.com/orgs/hybridcloudworks/repositories` if either is ever deleted |

No Docker password, personal access token or organisation access token is an
input. If one ever appears in a store, it is the wrong fix for a failing
login: the connection's **Failures** table in Docker Home says why an
exchange was refused.

## 4.12 Private Second Brain

Configure these through the existing Terraform workspace and identity process;
actual owner identifiers do not belong in this public document.

| Input | Store | Default | Purpose |
| --- | --- | --- | --- |
| `brain_enabled` | Terraform workspace → `BRAIN_ENABLED` | false | Arms the private workspace for the configured owner only |
| `brain_ai_enabled` | Terraform workspace → `BRAIN_AI_ENABLED` | false | Allows owner-requested Foundry retrieval/answers |
| `brain_owner_oid` | Terraform workspace → `BRAIN_OWNER_OID` | empty | Existing human owner's Entra object ID |
| `brain_owner_tenant_id` | Terraform workspace → `BRAIN_OWNER_TENANT_ID` | empty | Must match the API tenant when enabled |
| `brain_sync_client_id` | Terraform workspace → `BRAIN_SYNC_CLIENT_ID` | empty | Separate public desktop client restricted to `brain_sync` |

The owner also needs the existing API Admin role and an active editor-or-higher
registry entry. The plugin requires no client secret. Its encrypted local token
cache is separate from the vault. Identity setup, the test-vault pilot, and
private Publish retirement are in the [Second Brain runbook](../runbooks/second-brain.md).

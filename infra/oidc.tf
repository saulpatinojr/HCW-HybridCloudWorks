# =============================================================================
# oidc.tf — GitHub Actions deployment identity (federated, no stored secrets)
#
# Replaces the AZURE_CREDENTIALS GitHub secret, which held a static
# service-principal JSON. The README guardrail asks for OIDC and managed
# identities and forbids committed static cloud credentials; the workflows were
# not meeting it.
#
# WHY A USER-ASSIGNED MANAGED IDENTITY RATHER THAN AN APP REGISTRATION
#
# The usual recipe federates an Entra app registration. That requires directory
# permissions in Entra ID — Application Administrator or the tenant's
# "users may register applications" setting. Azure **Owner** does not grant it:
# Owner is Azure RBAC over subscriptions and resources, a different plane.
#
# A user-assigned managed identity is an ordinary Azure resource, and
# azurerm_federated_identity_credential attaches the trust to it directly. So
# everything here is creatable by an Azure Owner with no Entra role at all,
# which matches the permissions this deployment is expected to run under.
#
# The one thing that needs Entra rights is the API app registration behind
# var.entra_api_audience ("HCWSite API"). It is a prerequisite created by hand,
# once, and deliberately not automated here. scripts/cutover/01-entra-api.ps1
# does not create it: it asserts the registration, its scope, app roles and
# token version exist, then grants the role. If the registration is missing,
# that script stops rather than guessing. Required-Inputs §4.1 lists the
# workspace variable that carries its client id.
# =============================================================================

resource "azurerm_user_assigned_identity" "github_deploy" {
  # CAF's managed-identity format carries both region and instance:
  # id-<app or service name>-<environment>-<region>-<###>.
  name                = "id-${var.workload_name}-github-deploy-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  tags                = local.tags
}

# RETIRED 2026-10-06 (estate review, finding SEC-2; owner decision that day):
# the two `ref:refs/heads/main` credentials on THIS identity, name form here
# and immutable form below.
#
# They trusted a subject no workflow presents. Every job that signs in as
# the deploy identity declares `environment: production`, so GitHub composes
# the environment form and the production reviewers gate the sign-in. The
# ref form was the way around that gate: any job on `main` holding
# `id-token: write` — ten workflows do, for Qlty, Pages and the manifest —
# could have signed in as this identity with no reviewer and deployed code
# that runs as the Function App's own identity. Deleting the pair closes the
# route; `scripts/oidc-subjects.test.mjs` now asserts this identity trusts
# environment-form subjects only. The reader identity keeps its ref pair
# below: its workflows name no environment and it holds read roles.
#
# `subject` must match the token's claim EXACTLY. GitHub composes it as
# repo:<org>/<repo>:environment:<name> for a job that names an environment,
# so github_org and github_repo are load-bearing — a mismatch fails at
# azure/login with AADSTS70021 and no indication of which component was wrong.

# RETIRED 2026-08-26 (T-524): the two `environment:data-migration` credentials,
# name form here and immutable form below.
#
# They trusted a subject nothing presents. `migrate-data.yml` was the only
# consumer and was deleted in `59e471b`; of the four workflows that call
# azure/login, one names `environment: production` and three name no
# environment at all, so they present the ref form. Verified against
# scripts/oidc-subjects.test.mjs, which is the check that would have caught a
# mistake here: removing this pair leaves it passing, removing only one half
# fails it on the missing form, and sweeping up the branch pair by mistake
# fails it naming all three ref-form workflows.
#
# Retiring it was always an identity decision rather than a Terraform cleanup,
# which is why the remediation branch escalated it instead of deleting it. The
# owner authorised it on 2026-08-26. Recorded here rather than only in git
# because "why does this identity trust four subjects and not six" should be
# answerable from the file.
#
# What it cost: nothing operational. A federated credential grants no
# permission of its own — it decides which OIDC subject may act AS this
# identity — and with the production-write grants already revoked, a
# data-migration token inherited the same reduced role set a branch token gets.
# What it removes is a standing trust relationship for a job that cannot run.
#
# If a migration workflow is ever rebuilt: it needs BOTH forms back, name and
# immutable, or the guard fails and azure/login fails with AADSTS700213 on
# whichever form the token happens to carry.

# ---------------------------------------------------------------------------
# The SAME two subjects again, in GitHub's immutable-identifier form.
#
# GitHub now composes the subject with numeric org and repository IDs embedded:
#
#   repo:saulpatinojr@34853639/HCW-HybridCloudWorks@1268997852:ref:refs/heads/main
#
# rather than the documented repo:<org>/<repo>:ref:<ref>. Confirmed on
# 2026-08-20 from a real token — the first dispatch of deploy-functions.yml
# failed with AADSTS700213 and the presented subject in the error, and
# `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` reports
# `sub_claim_prefix` in the ID form while `use_default` is true. So this is
# GitHub's default now, not a customization anyone here made.
#
# Both forms are trusted rather than swapping to the new one, for two reasons.
# The rollout is GitHub's to reverse, and a credential that stops matching
# fails every deploy at login with an error naming nothing that changed. And
# the two are not redundant in the way they look: the name form survives an org
# rename breaking the IDs' association, the ID form survives a rename outright.
# Federated credentials are free and capped at 20; four is not a cost.
#
# Delete the name-form pair once the ID form has been stable for a release or
# two — not before, and not because it looks duplicated.
#
# The IDs are hardcoded deliberately. They are immutable by definition: that is
# the entire point of GitHub embedding them, and a variable would invite
# someone to "fix" them to something readable.
#
# Immutable is not the same as permanent, though. The owner ID belongs to the
# ACCOUNT, not the repository, so a transfer replaces it. On 2026-10-07 the
# repository moved from the HybridCloudWorks organisation (312844660) to the
# personal account saulpatinojr (34853639). The repository ID, 1268997852,
# survived the move; both owner halves of both forms did not, and every
# azure/login failed with AADSTS700213 naming
#   repo:saulpatinojr@34853639/HCW-HybridCloudWorks@1268997852:ref:refs/heads/main
# The old-owner credentials were replaced rather than kept beside the new
# ones: the organisation no longer owns the repository, so nothing can present
# them, and a trust nothing presents is the standing relationship T-524 and
# SEC-2 removed. scripts/oidc-subjects.test.mjs compares this prefix with the
# GITHUB_REPOSITORY_OWNER_ID and GITHUB_REPOSITORY_ID of the repository CI runs
# in, so a future transfer fails a pull request, not the first deploy after it.
# ---------------------------------------------------------------------------
locals {
  # repo:<owner>@<owner-id>/<repo>@<repo-id> — verified against the GitHub API
  # (`GET /repos/saulpatinojr/HCW-HybridCloudWorks/actions/oidc/customization/sub`
  # returned this `sub_claim_prefix` on 2026-10-08), not copied out of the
  # error message.
  github_immutable_prefix = "repo:${var.github_org}@34853639/${var.github_repo}@1268997852"
}

# The immutable half of the deploy identity's ref pair stood here until
# 2026-10-06 (SEC-2, see the note above the retired name form). Both halves
# went together: one without the other is half a credential and fails on
# whichever form the token carries.

# The immutable half of the data-migration pair was removed here on 2026-08-26
# with its name-form twin above (T-524). Both went together deliberately: one
# without the other is half a credential and fails on whichever form the token
# carries.

# ---------------------------------------------------------------------------
# environment:production — the subject the Function App deploy actually presents
#
# `de99aa0` put deploy-functions.yml behind `environment: production` to gate
# production deploys. That is a good change with a consequence nothing here
# accounted for: **declaring an environment changes the OIDC subject.** GitHub
# composes it as repo:<org>/<repo>:environment:<name>, NOT
# repo:<org>/<repo>:ref:<ref>, so the branch credential above cannot match a
# job that names an environment — the ref form is simply not what is presented.
#
# The result was a production deploy path that could not authenticate at all,
# and it stayed invisible because no deploy ran between that merge and
# 2026-08-25. The first dispatch after it failed at azure/login:
#
#   AADSTS700213: No matching federated identity record found for presented
#   assertion subject 'repo:HybridCloudWorks@312844660/
#   HCW-HybridCloudWorks@1268997852:environment:production'
#
# Both forms again, for the reasons given above the immutable block: the name
# form survives an org rename breaking the IDs' association, the ID form
# survives a rename outright. Six credentials against a cap of 20.
#
# The rule is per-workflow, not per-repository: a workflow that names an
# environment needs an environment credential, one that does not needs the
# branch credential. The branch pair was once needed because
# heal-computed-properties.yml and publish-content-manifest.yml declared no
# environment. publish-content-manifest has signed in as the reader identity
# since T-728, and the healer was deleted in #816 part 2, so no workflow on
# THIS identity presents the ref subject, and on 2026-10-06 the owner retired
# the pair (SEC-2). These two environment credentials are the identity's
# only trust now: a sign-in as the deploy identity passes the production
# environment's reviewers or does not happen.
# ---------------------------------------------------------------------------
resource "azurerm_federated_identity_credential" "github_production" {
  name                      = "github-${var.github_repo}-env-production"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_deploy.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_org}/${var.github_repo}:environment:production"
}

resource "azurerm_federated_identity_credential" "github_production_immutable" {
  name                      = "github-${var.github_repo}-env-production-immutable"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_deploy.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "${local.github_immutable_prefix}:environment:production"
}

# ---------------------------------------------------------------------------
# Roles for the deployment identity — scoped, not subscription Contributor
# ---------------------------------------------------------------------------

# Publish code to the Function App. Website Contributor covers deployment and
# app-settings management without granting rights over the rest of the group.
resource "azurerm_role_assignment" "github_deploy_functions" {
  scope                = azurerm_function_app_flex_consumption.hcw.id
  role_definition_name = "Website Contributor"
  principal_id         = azurerm_user_assigned_identity.github_deploy.principal_id
}

# Flex Consumption pulls the deployment package from the releases container, so
# the publishing identity must be able to write blobs to it.
resource "azurerm_role_assignment" "github_deploy_releases" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github_deploy.principal_id
}

# T-503 makes the host storage account default-Deny, and GitHub-hosted runners
# have public dynamic IPs — so deploy-functions.yml opens a per-run firewall
# window (add runner IP → upload → remove, always-run cleanup). Managing the
# account's network rules is a control-plane write, which the data-plane role
# above does not carry; Storage Account Contributor is the narrowest built-in
# that does. Two things to know about it, on the record:
#   - it also permits listKeys on this one account. The identity could already
#     write the deployment package (the blob role above) — i.e. arbitrary code
#     into the API — so this adds no capability an attacker holding the
#     identity would care about.
#   - scope is exactly this account, not the group or subscription.
resource "azurerm_role_assignment" "github_deploy_funcsa_network" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Account Contributor"
  principal_id         = azurerm_user_assigned_identity.github_deploy.principal_id
}

# ---------------------------------------------------------------------------
# THE READ-ONLY IDENTITY (T-728)
# ---------------------------------------------------------------------------
#
# Until 2026-08-29 one identity served every workflow. The hourly registration
# monitor and the alert-state verifier — which read and change nothing — ran as
# the identity that also holds Website Contributor on the API, Storage Account
# Contributor and Storage Blob Data Contributor on the host storage account, and
# the Cosmos container-definition role. A postinstall script anywhere in a
# scheduled workflow's dependency tree inherited the full deploy blast radius,
# for jobs whose entire job is to look.
#
# So the division is what the job DOES, not which team owns it:
#
#   github_deploy            writes something     deploy-functions,
#                                                 deploy-azure-frontend
#   github_reader            writes nothing       monitor-functions-registered,
#                                                 monitor-unresolved-secrets
#   github_manifest_window   one origin rule      publish-content-manifest
#
# verify-alert-state ran as github_reader until #1053 and now has an identity
# of its own, github_alert_reader below, that can read alert rules and action
# groups and nothing else.
#
# publish-content-manifest moved to the reader side with T-728, though the
# finding's recommendation named only the monitors. Its build job then queried
# Cosmos and wrote a JSON file into the repository — it never needed a
# data-plane write, and it held Cosmos Data Contributor only because it shared
# an identity with the healer. T-718 moved the query into the Function App and
# left the job one write, its origin window, which #1098 moved off this
# identity: github_manifest_window below says why.
#
# The workflows on this identity declare no `environment:`, so each presents
# the ref-form subject, and both the name and immutable-ID forms of it are
# trusted, for the reasons above the immutable block.
#
# scripts/oidc-subjects.test.mjs checks per identity now, not against one pool
# of subjects: a reader workflow needs a credential on THIS identity, and a
# pooled check would have passed on the deploy identity's.
resource "azurerm_user_assigned_identity" "github_reader" {
  name                = "id-${var.workload_name}-github-reader-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_reader_branch" {
  name                      = "github-${var.github_repo}-reader-branch"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_reader.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_org}/${var.github_repo}:ref:${var.github_deploy_ref}"
}

resource "azurerm_federated_identity_credential" "github_reader_branch_immutable" {
  name                      = "github-${var.github_repo}-reader-branch-immutable"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_reader.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "${local.github_immutable_prefix}:ref:${var.github_deploy_ref}"
}

# READER, not Monitoring Reader — and this reverses what the deploy identity
# carried, on a claim that was simply wrong.
#
# The removed block chose Monitoring Reader over Reader and argued it was the
# narrower of the two: "Reader grants read over every resource in the group ...
# the narrower role names the actual job." Monitoring Reader is not narrower.
# Checked against Microsoft's published definition rather than from memory, it
# is `*/read` PLUS Microsoft.OperationalInsights/workspaces/search/action and
# Microsoft.Support/* — a strict superset of Reader, which is `*/read` alone.
# Choosing it widened the grant while the comment claimed it narrowed it.
#
# The rest of that reasoning survives and applies here: neither role carries
# listKeys on the workspace, so this identity cannot read the ingestion keys and
# so cannot forge or drown the telemetry the alert rules evaluate.
#
# SCOPE IS THE RESOURCE GROUP. It holds the Function App, its plan, the Static
# Web App, Application Insights and the Functions host storage account, and the
# monitor reads across the first and the last of those. A per-resource grant
# would have to be re-declared every time a rule or resource is renamed, which
# is the coupling that leaves a verification path quietly broken.
resource "azurerm_role_assignment" "github_reader_web" {
  scope                = azurerm_resource_group.app["web"].id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.github_reader.principal_id
}

# The one thing Reader cannot express. monitor-functions-registered reads two
# app settings — AzureWebJobsStorage's presence and RUNTIME_CONFIG_WRITER's
# value, both symptoms of the azapi strip regressing — and listing app settings
# is Microsoft.Web/sites/config/list/action. An action, not a read, so `*/read`
# does not reach it.
#
# WHAT THIS CAN AND CANNOT SEE, because it looks alarming next to
# func_config_refresh, which excludes this exact action. The two are different
# principals with opposite jobs: the Function App may refresh its settings and
# must not read them back, and this identity may read them and can change
# nothing. That last clause was false until #1098: this identity also held
# Config Refresh on the site for publish-content-manifest's origin window, and
# RBAC is additive, so it could list app settings with this role and write them
# with that one. The window has an identity of its own now, and
# scripts/oidc-subjects.test.mjs fails if a write role lands back here.
# And what it reads is bounded — every credential in this estate is a
# @Microsoft.KeyVault(SecretUri=...) reference, so the list returns the
# reference string, not the resolved secret. That is not a convention anyone has
# to remember: functions/src/functions/app-settings-secrets.test.js fails CI on a
# literal secret value in app_settings, with a short allowlist of non-secrets.
data "azurerm_role_definition" "function_settings_reader" {
  name  = "HCW Function Settings Reader"
  scope = azurerm_resource_group.app["web"].id
}

resource "azurerm_role_assignment" "github_reader_function_settings" {
  scope              = azurerm_resource_group.app["web"].id
  role_definition_id = data.azurerm_role_definition.function_settings_reader.id
  principal_id       = azurerm_user_assigned_identity.github_reader.principal_id
}

# The deployment token, minted at deploy time instead of stored (T-727).
#
# Azure/static-web-apps-deploy CANNOT authenticate with a federated credential.
# That is not an oversight in this workflow: azure/static-web-apps#1304 is an
# open request asking Microsoft for exactly that, and until it lands the action
# takes a deployment token or nothing. So "move the SWA deploy to OIDC" cannot
# mean "stop using the token" — it means stop STORING it.
#
# What that changes, precisely, because the difference is easy to overstate:
#
#   - Retired: the `swa_token` Terraform output, visible on the HCP Terraform
#     Outputs tab to anyone with state read, and the long-lived
#     AZURE_STATIC_WEB_APPS_API_TOKEN GitHub secret. Neither exists after this.
#   - Unchanged: the token still exists in Terraform state via
#     azurerm_static_web_app.hcw.api_key, which is an attribute of the resource
#     and cannot be removed while the resource is managed here. outputs.tf said
#     this before the retirement and it is still true after it.
#
# The job now asks ARM for the token under the same federated identity it
# already uses, and it lives for the length of one run.
#
# WHY A CUSTOM ROLE. Microsoft.Web/staticSites/listSecrets/action is an action,
# not a read, so Reader cannot express it — the same shape as the function
# settings reader above. The built-ins that do carry it, Contributor and
# Website Contributor, also grant write over the site: the identity could
# reconfigure or delete the Static Web App to read one token. This grants the
# single action and nothing else.
data "azurerm_role_definition" "static_web_app_deployer" {
  name  = "HCW Static Web App Deployer"
  scope = azurerm_resource_group.app["web"].id
}

# Scoped to the ONE site, not the resource group the definition is assignable
# in. The definition has to be assignable at the group; the assignment does not
# have to use that breadth, and a future second static site should not inherit
# this by accident.
resource "azurerm_role_assignment" "github_deploy_swa_token" {
  scope              = azurerm_static_web_app.hcw.id
  role_definition_id = data.azurerm_role_definition.static_web_app_deployer.id
  principal_id       = azurerm_user_assigned_identity.github_deploy.principal_id
}

# ---------------------------------------------------------------------------
# github_manifest_window — publish-content-manifest's origin window (#1098)
# ---------------------------------------------------------------------------
# publish-content-manifest USED to hold Cosmos Data Reader on two containers and
# query the database from a GitHub-hosted runner. That one workload is what held
# the 0.0.0.0 sentinel open on the Cosmos firewall, so the query moved into the
# Function App — which runs inside the subnet that firewall already admits — and
# the workflow now fetches public/content-manifest over HTTP instead (T-718).
#
# Reaching the app means getting past the origin lock, so the workflow adds an IP
# allow rule for its own runner and removes it in an always() step. That is a
# write to the site's config, and HCW Function Config Refresh is the narrowest
# role in the estate that permits it: Microsoft.Web/sites/config/Write with
# config/list/action excluded. It is the definition the Function App uses, for a
# different job. Its name says "config refresh" because that was its first
# consumer; the actions are exactly what an access-restriction add/remove needs,
# and a second definition with an identical permission set would be a rename,
# not a control.
#
# AN IDENTITY OF ITS OWN SINCE #1098. Until then the window was granted to
# github_reader, beside HCW Function Settings Reader. RBAC is additive: a
# role's NotActions subtracts only inside that role, so the one principal could
# list app settings with one grant and write them with the other, and every
# step of every workflow on it, the hourly monitor included, held both. Each
# half now sits on a principal that lacks the other:
#
#   github_reader            lists app settings, writes nothing
#   github_manifest_window   writes the site's config, lists nothing
#
# Both hold Reader on the web group, which lists nothing either.
#
# READER ON THE WEB GROUP, THE READER'S OWN SCOPE. `az functionapp config
# access-restriction` reads the site and its config before it writes, and the
# close step reads the rules back to assert none is left; Config Refresh carries
# no read. Reader on the one site would cover those reads, and was this block's
# first shape. It was moved to the group (CodeRabbit on #1104) because of how
# the job signs in, not what it reads. Every az command takes its credential
# from the subscription it finds in the login's account list
# (azure-cli's Profile.get_subscription raises "Subscription ... not found"
# otherwise), so the subscription must be discoverable whether the login pins
# it or each command passes --subscription. Whether a grant on one resource
# makes it discoverable is not documented. A group-scope Reader beside a
# site-scope Config Refresh is exactly github_reader's shape, which signs in
# with SUBSCRIPTION_ID pinned every hour. Reader is `*/read` and no list
# action, so app settings, which come back only through config/list/action,
# stay out of reach: this identity holds that action on no scope.
#
# principal_type is explicit on both grants because the identity is created in
# the same apply, as for github_alert_reader.
#
# The workflow declares no `environment:` on its build job, so it presents the
# ref-form subject, trusted here in both the name and immutable-ID forms. The
# subjects are the reader's; the client-id the job sends
# (MANIFEST_WINDOW_CLIENT_ID) decides which identity it reaches, which
# scripts/oidc-subjects.test.mjs checks per job.
#
# REMOVED with the Cosmos query (T-718): github_reader_cosmos_content and
# github_reader_cosmos_blogs, Data Reader on those two containers. Nothing in CI
# reaches the Cosmos data plane now, which is the precondition
# cosmos_allow_azure_datacenter_ips = false depends on. REMOVED in #1098:
# github_reader_origin_window, this grant's predecessor on github_reader.
resource "azurerm_user_assigned_identity" "github_manifest_window" {
  name                = "id-${var.workload_name}-github-manifest-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_manifest_window_branch" {
  name                      = "github-${var.github_repo}-manifest-window-branch"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_manifest_window.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_org}/${var.github_repo}:ref:${var.github_deploy_ref}"
}

resource "azurerm_federated_identity_credential" "github_manifest_window_branch_immutable" {
  name                      = "github-${var.github_repo}-manifest-window-branch-immutable"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_manifest_window.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "${local.github_immutable_prefix}:ref:${var.github_deploy_ref}"
}

resource "azurerm_role_assignment" "github_manifest_window_config" {
  scope              = azurerm_function_app_flex_consumption.hcw.id
  role_definition_id = data.azurerm_role_definition.func_config_refresh.id
  principal_id       = azurerm_user_assigned_identity.github_manifest_window.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "github_manifest_window_read" {
  scope                = azurerm_resource_group.app["web"].id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.github_manifest_window.principal_id
  principal_type       = "ServicePrincipal"
}

# ---------------------------------------------------------------------------
# github_alert_reader — verify-alert-state.yml, and nothing else (#1053)
# ---------------------------------------------------------------------------
# The weekly check reads every declared alert rule and the action group back
# from Azure (scripts/verify-alert-state.mjs): one token, the subscription
# list, the three alert-rule lists in each resource group and each action
# group, all GETs. It ran as github_reader, which could not read the
# Management subscription at all, so the capacity rule, the lab rules, the
# two Management role-change rules and the action group read UNREADABLE every
# week. Reader on rg-mgmt-plat-prod-cus would have closed that, and it would
# also have let this identity query every log in the Management workspace
# (query is a read action) while it already held a Function App config write.
# The owner chose the narrower shape on 2026-10-11: an identity of its own,
# holding the custom "HCW Alert Rule Reader" role (infra/roles/
# alert-rule-reader.json: the four alert-rule and action-group reads, no
# data action) in the two groups the rules live in, and nothing else.
#
# The workflow declares no `environment:`, so it presents the ref-form
# subject, and both the name and immutable-ID forms of it are trusted, as for
# github_reader. The two identities trust the same subjects; the client-id a
# job sends (ALERT_READER_CLIENT_ID here) decides which one it reaches, which
# scripts/oidc-subjects.test.mjs checks per workflow.
resource "azurerm_user_assigned_identity" "github_alert_reader" {
  name                = "id-${var.workload_name}-github-alerts-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_alert_reader_branch" {
  name                      = "github-${var.github_repo}-alert-reader-branch"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_alert_reader.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_org}/${var.github_repo}:ref:${var.github_deploy_ref}"
}

resource "azurerm_federated_identity_credential" "github_alert_reader_branch_immutable" {
  name                      = "github-${var.github_repo}-alert-reader-branch-immutable"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_alert_reader.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "${local.github_immutable_prefix}:ref:${var.github_deploy_ref}"
}

# The definition is one object, assignable in both groups; each lookup names
# the group its assignment lands in, through that group's own provider.
# principal_type is explicit on both grants because the identity is created
# in the same apply: without it ARM looks the principal up in Entra first and
# can miss one that has not replicated yet (as for arc_onboarding).
data "azurerm_role_definition" "alert_rule_reader_app" {
  name  = "HCW Alert Rule Reader"
  scope = azurerm_resource_group.app["web"].id
}

data "azurerm_role_definition" "alert_rule_reader_mgmt" {
  provider = azurerm.mgmt

  name  = "HCW Alert Rule Reader"
  scope = azurerm_resource_group.platform_mgmt.id
}

resource "azurerm_role_assignment" "github_alert_reader_app" {
  scope              = azurerm_resource_group.app["web"].id
  role_definition_id = data.azurerm_role_definition.alert_rule_reader_app.id
  principal_id       = azurerm_user_assigned_identity.github_alert_reader.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "github_alert_reader_mgmt" {
  provider = azurerm.mgmt

  scope              = azurerm_resource_group.platform_mgmt.id
  role_definition_id = data.azurerm_role_definition.alert_rule_reader_mgmt.id
  principal_id       = azurerm_user_assigned_identity.github_alert_reader.principal_id
  principal_type     = "ServicePrincipal"
}

# ---------------------------------------------------------------------------
# github_copilot_review — what GitHub Copilot code review may see in Azure
# ---------------------------------------------------------------------------
# .github/copilot-mcp.json gives Copilot code review (and the Copilot cloud
# agent, which shares the configuration) the Azure MCP Server, restricted at
# the server to fourteen read-only control-plane tools. The server needs an
# Azure sign-in, and .github/workflows/copilot-setup-steps.yml provides one
# with azure/login under federated identity — this identity. Verified in
# Copilot's own runner on 2026-09-06 (PR #382's session): the login succeeds
# with the client id read from the Agents store, where the owner mirrored the
# copilot_review_client_id output because that runner resolves no repository
# variables.
#
# A THIRD IDENTITY, not a reuse of github_reader, because github_reader is not
# read-only: it holds the origin-window role on the Function App (a config
# WRITE, github_reader_origin_window above) and the app-settings LIST action.
# An autonomous reviewer that calls tools without asking must hold a principal
# that can change nothing, so that a prompt-injected review comment has nothing
# to reach for. This one is Reader, at resource-group scope, and nothing else.
#
# WHAT READER CAN AND CANNOT SEE HERE. `*/read` is control plane: resource
# existence, configuration, tags, role assignments, metrics definitions,
# activity log. It carries no data action and no `list*/action`, so this
# identity cannot list storage keys, Cosmos keys, Function App settings or
# Key Vault secrets, and cannot read a blob, a document or a secret — the
# Key Vault is RBAC-mode and needs a data-plane role for that. Application
# Insights telemetry IS readable under Reader (query is an ARM action), which
# is why the MCP tool list excludes every log-query tool and keeps only metrics;
# and the telemetry is content-free by policy either way — correlation
# identifiers, never paths, query strings or payloads — a rule the pull
# request template's security review and the code-review skill's
# cross-cutting checks (.github/skills/code-review/SKILL.md) enforce on every
# change.
#
# SUBJECT IS THE copilot ENVIRONMENT, in both forms, and nothing else. Copilot's
# setup-steps job declares `environment: copilot`, so GitHub composes
# `repo:<org>/<repo>:environment:copilot` — the ref form would not match. No
# ref-form credential, because no branch-triggered workflow should ever be able
# to assume this identity by accident. The `copilot` environment exists already
# (docs/standards/required-inputs.md §4.4).
#
# Scope is the four workload groups (web, db, stor, sec). Not `conn`: nothing a
# review asks about lives in the spoke network, and not the Management
# subscription, so the central Log Analytics workspace is out of reach entirely.
resource "azurerm_user_assigned_identity" "github_copilot_review" {
  name                = "id-${var.workload_name}-github-copilot-review-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_copilot_review_environment" {
  name                      = "github-${var.github_repo}-copilot-review-environment"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_copilot_review.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_org}/${var.github_repo}:environment:copilot"
}

resource "azurerm_federated_identity_credential" "github_copilot_review_environment_immutable" {
  name                      = "github-${var.github_repo}-copilot-review-environment-immutable"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_copilot_review.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "${local.github_immutable_prefix}:environment:copilot"
}

resource "azurerm_role_assignment" "github_copilot_review_reader" {
  for_each             = toset(["web", "db", "stor", "sec"])
  scope                = azurerm_resource_group.app[each.key].id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.github_copilot_review.principal_id
}

# REMOVED 2026-08-29 (T-728): azurerm_role_assignment.github_deploy_alert_reader,
# Monitoring Reader on rg-web for the deploy identity.
#
# It existed so verify-alert-state.yml could read the live rules back. That
# workflow is on github_reader now, and the deploy identity needs nothing from
# it: deploy-functions.yml reads the Function App through Website Contributor
# (Microsoft.Web/sites/*, which covers the function list, the access
# restrictions and the app-settings list) and the host storage account through
# Storage Account Contributor. Nothing it does touches Microsoft.Insights.

# Deliberately NOT granted to the active deployment path:
#   - Key Vault access. Deploys do not read secrets; the Function App's own
#     managed identity does that at runtime.
#   - Import-only Cosmos or storage roles on PRODUCTION. These were declared
#     behind migration_writer_enabled and were LIVE on this identity until
#     2026-08-24; the gate and all three declarations were removed with the
#     rehearsal itself. See the removal record at the end of this file.
#   - Data-plane access to the CONTENT storage account. This identity writes a
#     deployment package to the FUNCTIONS host account and nothing else; the
#     media the site serves is the Function App's to write, not CI's.
#   - anything at subscription scope.

# ---------------------------------------------------------------------------
# REMOVED (#816, part 2) — the healer's container-definition role
# ---------------------------------------------------------------------------
# azurerm_cosmosdb_sql_container cannot express computedProperties, so an apply
# that updates the `content` or `blogs` container used to wipe cp_sortDate
# (T-206). Until #816, heal-computed-properties.yml put it back every six hours
# through an ARM PUT, authorized by a custom role assigned here:
# `data.azurerm_role_definition.cosmos_container_writer` looked up
# "HCW Cosmos Container Definition Writer" and
# `azurerm_role_assignment.github_deploy_cosmos_container_writer` granted it to
# this identity at the account scope.
#
# The apply writes the property itself now, in the same run that could wipe it,
# and fails if a container lacks it afterwards
# (azapi_update_resource.cosmos_computed_properties in cosmos.tf, #829). So the
# workflow, the script's --apply path and the assignment went together, and
# this identity no longer holds any Cosmos control-plane write. The role
# DEFINITION was the owner's, created by hand from infra/roles/ because the
# Terraform identity cannot create definitions, so it is deleted by hand too,
# after the apply that destroys the assignment (Azure refuses to delete a
# definition that still has one).
#
# The two container-scoped DATA-PLANE grants (Cosmos Data Contributor on
# `content` and `blogs` for this identity) outlived that removal until
# 2026-10-06 (estate review, SEC-2). Their reader was the workflow's
# dispatch-only `--inspect`; with the workflow gone,
# `apply-computed-sortdate.mjs --inspect` runs locally under the operator's
# own sign-in, so the grants had no consumer and contradicted ADR 0025's
# "CI holds no Cosmos data-plane role". They are gone; the Function App's
# own identity is the only principal with a Cosmos data-plane role
# (func_cosmos in cosmos.tf).

# ---------------------------------------------------------------------------
# REMOVED 2026-08-24 — the production-import grants, and the gate that held them
# ---------------------------------------------------------------------------
#
# Three role assignments and var.migration_writer_enabled went together:
#
#   github_deploy_cosmos_migration          Cosmos DB Built-in Data Contributor
#                                           at DATABASE scope, dbs/hcw
#   github_deploy_content_blob_migration    Storage Blob Data Contributor on the
#                                           production content account
#   github_deploy_content_network_migration Storage Account Contributor on the
#                                           production content account
#
# The owner confirmed the migration rehearsal is finished. This is a REVOCATION,
# not a tidy-up: all three were live on the identity, so a CI principal held
# write access to every container in the production database and to the account
# holding the site's media, for a job that no longer exists.
#
# WHY THE DECLARATIONS ARE DELETED RATHER THAN LEFT AT count = 0. A variable gate
# is only "off" while the workspace agrees with the checked-in default, and here
# it demonstrably did not: variables.tf said false while all three assignments
# were live in Azure. Deleting the resources removes the configuration's ability
# to grant them at all — a workspace value for a variable that no longer exists
# is a warning, not a re-grant. It also means an apply that finds them in state
# destroys them, which a default nobody can see from here would not guarantee.
#
# WHAT SURVIVES, and the job each one is still doing:
#
#   github_deploy_functions                Website Contributor on the Function
#                                          App — deploy-functions.yml publishes.
#   github_deploy_releases                 Blob Data Contributor on the FUNCTIONS
#                                          host account only, for the deployment
#                                          package. Never the content account.
#   github_deploy_funcsa_network           Storage Account Contributor on the
#                                          FUNCTIONS host account only, for the
#                                          per-run firewall window.
#   github_deploy_cosmos_content           data-plane Data Contributor scoped to
#   github_deploy_cosmos_blogs             colls/content and colls/blogs, for
#                                          apply-computed-sortdate --inspect.
#
# (github_deploy_cosmos_container_writer, the custom container-definition role
# that sat in this list for the healer's ARM PUT, was removed in #816 part 2.)
#
# The two container-scoped Cosmos grants are UNAFFECTED by dropping the
# database-scoped one. They are separate assignments; the database scope was a
# superset sitting alongside them, not their parent. The identity kept data-plane
# access to exactly the two containers the healer read, and lost everything else.
#
# The two storage grants had no consumer to lose. Nothing in .github/workflows
# addresses the content storage account, and scripts/apply-computed-sortdate.mjs
# imports @azure/cosmos and @azure/identity and no blob client at all.
#
# REMOVED 2026-08-26, one cleanup later: the two `data-migration` federated
# credentials that used to sit near the top of this file. They were held back
# from this pass because retiring a trust relationship is an identity change
# rather than a Terraform cleanup, and that decision was the owner's to make
# (T-524). It was made on 2026-08-26 and the pair is gone; the reasoning is
# recorded where they used to be declared.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Values the GitHub workflows need. None are secret: federation means
# possession of these IDs grants nothing without a matching OIDC token from
# this repository and ref.
# ---------------------------------------------------------------------------
output "client_id" {
  description = "CLIENT_ID for azure/login — set as a repository variable, not a secret"
  value       = azurerm_user_assigned_identity.github_deploy.client_id
}

output "reader_client_id" {
  description = "READER_CLIENT_ID for azure/login in the read-only workflows — a repository variable, not a secret"
  value       = azurerm_user_assigned_identity.github_reader.client_id
}

output "alert_reader_client_id" {
  description = "ALERT_READER_CLIENT_ID for azure/login in verify-alert-state.yml (#1053) — a repository variable, not a secret"
  value       = azurerm_user_assigned_identity.github_alert_reader.client_id
}

output "manifest_window_client_id" {
  description = "MANIFEST_WINDOW_CLIENT_ID for azure/login in publish-content-manifest.yml's origin window (#1098) — a repository variable, not a secret"
  value       = azurerm_user_assigned_identity.github_manifest_window.client_id
}

output "copilot_review_client_id" {
  description = "COPILOT_REVIEW_CLIENT_ID for azure/login in copilot-setup-steps.yml — a repository variable, mirrored as an Agents secret of the same name because Copilot's own runner resolves no repository variables (runbook step 2b); an identifier in both stores, not a secret"
  value       = azurerm_user_assigned_identity.github_copilot_review.client_id
}

output "deploy_principal_id" {
  description = "Principal ID of the GitHub deployment identity — for granting further roles"
  value       = azurerm_user_assigned_identity.github_deploy.principal_id
}

# Ten entries since #1098, when the manifest window identity's ref pair was
# added. Eight since 2026-10-11, when the alert reader identity's ref pair
# was added (#1053). Six since 2026-10-06, down from eight: the deploy
# identity's ref pair was retired (SEC-2). Eight since 2026-09-06, when the Copilot review
# identity's environment pair was added; six before that since 2026-08-29, when
# the reader identity's ref pair was added (T-728). Keeping this list in step
# with the resources above is not cosmetic — it is what an operator diffs a
# failing token's subject against, so it has to name exactly what Entra trusts.
# Deleting the credentials without deleting the entries is what broke
# `terraform validate` on PR #230.
#
# NOTE for anyone debugging AADSTS700213 against this list: since SEC-2 the
# ref subject is trusted by the READER identity only. A ref-form token sent
# with CLIENT_ID (the deploy identity) fails here by design — a job that needs
# the deploy identity names `environment: production` and presents the
# environment form. Which identity a job reaches is decided by the client-id
# it presents, so check whether it sent CLIENT_ID, READER_CLIENT_ID,
# ALERT_READER_CLIENT_ID or MANIFEST_WINDOW_CLIENT_ID.
output "federated_subjects" {
  description = "Exact OIDC subject claims trusted by these identities — compare against a failing token"
  value = [
    azurerm_federated_identity_credential.github_production.subject,
    azurerm_federated_identity_credential.github_production_immutable.subject,
    azurerm_federated_identity_credential.github_reader_branch.subject,
    azurerm_federated_identity_credential.github_reader_branch_immutable.subject,
    azurerm_federated_identity_credential.github_alert_reader_branch.subject,
    azurerm_federated_identity_credential.github_alert_reader_branch_immutable.subject,
    azurerm_federated_identity_credential.github_manifest_window_branch.subject,
    azurerm_federated_identity_credential.github_manifest_window_branch_immutable.subject,
    azurerm_federated_identity_credential.github_copilot_review_environment.subject,
    azurerm_federated_identity_credential.github_copilot_review_environment_immutable.subject,
  ]
}

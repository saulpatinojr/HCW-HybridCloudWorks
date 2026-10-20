# =============================================================================
# outputs.tf — Azure infrastructure outputs
# Used by CI/CD workflows and application configuration.
#
# SECURITY NOTE: Sensitive key/connection-string outputs are intentionally
# omitted, with ONE remaining exception — `insights_connection` below, an
# Application Insights connection string kept for local development. All
# *runtime* access uses managed identity + RBAC; no static key is passed to
# application code. See Required-Inputs for the full secrets catalog.
#
# WHY THAT ONE IS DIFFERENT from the one retired below it. An Application
# Insights connection string is a telemetry INGESTION key: it grants the
# ability to write telemetry into the workspace, and nothing else. It cannot
# read data back, reach any other resource, or publish anything a user sees.
# The SWA deployment token granted standing ability to replace the entire
# public site. Both were `sensitive`; only one was worth the machinery.
#
# There was one, and the history is worth keeping because the note is only
# trustworthy if its corrections are visible. `swa_token` exported the Static
# Web App deployment key here from the beginning; T-722 caught that this
# paragraph read as an unqualified "no key outputs exist" eleven lines above one
# that did, and the sentence was amended to name the exception rather than be
# falsifiable by scrolling. T-727 then retired the output itself:
# deploy-azure-frontend.yml now mints the token from ARM under federated
# identity at deploy time, so nothing needs it exported.
#
# ONE THING THIS DOES NOT CLAIM. The token still exists in Terraform state, via
# `azurerm_static_web_app.hcw.api_key`, because that is an attribute of a
# resource this module manages. Removing the output removed its exposure on the
# HCP Terraform Outputs tab and the long-lived GitHub secret beside it. It did
# not remove the credential from state, and no output block ever could.
# =============================================================================

# -----------------------------------------------------------------------------
# Static Web App
# -----------------------------------------------------------------------------
output "swa_hostname" {
  description = "Default hostname of the Azure Static Web App (also the Cloudflare CNAME target)"
  value       = azurerm_static_web_app.hcw.default_host_name
}

# -----------------------------------------------------------------------------
# Cosmos DB
# -----------------------------------------------------------------------------
output "cosmos_endpoint" {
  description = "Cosmos DB account endpoint URL (no key — Function App uses managed identity)"
  value       = azurerm_cosmosdb_account.hcw.endpoint
}

output "cosmos_database" {
  description = "Cosmos DB database name"
  value       = azurerm_cosmosdb_sql_database.hcw.name
}

# The account's resource group. heal-computed-properties.yml addressed the
# containers through ARM with it until #816 deleted that workflow; nothing reads
# it now, but scripts/set-github-variables.ps1 still seeds COSMOS_RESOURCE_GROUP
# from it, so the two go together. Same pairing guarantee as
# web_resource_group: read from the account resource itself.
output "cosmos_resource_group" {
  description = "Resource group holding the Cosmos account — seeds the COSMOS_RESOURCE_GROUP repository variable"
  value       = azurerm_cosmosdb_account.hcw.resource_group_name
}

# cosmos_db_primary_key intentionally removed — use managed identity
# cosmos_db_connection_string intentionally removed — use managed identity

# -----------------------------------------------------------------------------
# Storage
# -----------------------------------------------------------------------------
output "storage_account" {
  description = "Content storage account name (NOT the Functions host account — see functions_storage_account)"
  value       = azurerm_storage_account.hcw.name
}

# The CONTENT account's group — used by repository-variable bootstrap and
# operator tooling when a controlled storage firewall window is required.
# Taken from the account's own attribute for the same pairing guarantee as
# web_resource_group below.
output "storage_resource_group" {
  description = "Resource group holding the content storage account — used with STORAGE_RESOURCE_GROUP when controlled access is required"
  value       = azurerm_storage_account.hcw.resource_group_name
}

output "functions_storage_account" {
  description = "Functions host storage account — the FUNCTIONS_STORAGE_ACCOUNT repository variable whose firewall deploy-functions.yml opens and closes per run (T-503)"
  value       = azurerm_storage_account.functions.name
}

# Taken from the storage account's own attribute rather than the resource
# group resource, so this output and functions_storage_account can never name
# a mismatched pair — RESOURCE_GROUP exists solely to scope the firewall
# window on that exact account.
output "web_resource_group" {
  description = "Resource group holding the Function App and its host storage account — the RESOURCE_GROUP repository variable deploy-functions.yml scopes its per-run firewall window to (T-503)"
  value       = azurerm_storage_account.functions.resource_group_name
}

output "blob_endpoint" {
  description = "Primary blob endpoint for constructing public asset URLs"
  value       = azurerm_storage_account.hcw.primary_blob_endpoint
}

# storage_connection_string intentionally removed — use managed identity

# -----------------------------------------------------------------------------
# Function App
# -----------------------------------------------------------------------------
output "function_hostname" {
  description = "Default hostname of the Azure Function App (also the Cloudflare CNAME target)"
  value       = azurerm_function_app_flex_consumption.hcw.default_hostname
}

# The bare resource name, which is what `func azure functionapp publish` and
# Azure/functions-action's `app-name` take — neither accepts a hostname or a URL.
#
# It exists as an output because it was hardcoded in two places and both went
# stale: deploy-functions.yml carried `func-site-prod-scus` and
# functions/package.json carried `hcw-functions-prod`, an estate older still.
# Neither app exists, so a deploy would have failed on "app not found" — which
# reads as a permissions or subscription problem before it reads as a typo.
output "function_app_name" {
  description = "Function App resource name — what a deploy targets. Not the hostname; see function_hostname for that"
  value       = azurerm_function_app_flex_consumption.hcw.name
}

output "function_url" {
  description = "Full HTTPS URL for the Function App ORIGIN. Not reachable by browsers or CI while the origin lock is on — see api_base_url"
  value       = "https://${azurerm_function_app_flex_consumption.hcw.default_hostname}"
}

# The address every CLIENT must use: browsers, CI smoke tests, anything that is
# not Cloudflare itself.
#
# This exists because function_url is a trap once functions_origin_lock_enabled
# is true. That output names the azurewebsites.net origin, which is exactly the
# thing the ip_restriction rules refuse — a browser or a GitHub-hosted runner
# gets 403, and the 403 says nothing about why. Anything that fed
# function_hostname into a client-facing setting was building a URL guaranteed
# to fail the moment the lock came on.
#
# Route: browser -> api-azure.<domain> (Cloudflare, proxied) -> origin. The
# late-transform rule stamps x-hcw-origin-secret on the way through, which is
# what lets client-identity.js trust CF-Connecting-IP.
#
# Consumers: VITE_AZURE_FUNCTIONS_URL (frontend build), the FUNCTIONS_URL
# GitHub variable, deploy-functions.yml's smoke test, and the connect-src
# entry in frontend/staticwebapp.config.json — which must name this host, since
# CSP is enforced against the URL the browser actually calls.
# NO `.${var.domain}` SUFFIX, and this is the v5 change most able to break
# quietly. Under v4 `name` was the relative label "api-azure", so this appended
# the zone to build the host. Under v5 `name` is already the full record name,
# and appending would produce api-azure.hybridcloudworks.com.hybridcloudworks.com
# — a valid Terraform expression that `validate` accepts and that would then
# flow into FUNCTIONS_URL, VITE_AZURE_FUNCTIONS_URL, the deploy smoke test and
# the connect-src entry in staticwebapp.config.json.
output "api_base_url" {
  description = "Public API base URL through Cloudflare — the only address clients can reach while the origin lock is on"
  value       = "https://${cloudflare_dns_record.azure_functions.name}/api"
}

output "app_principal_id" {
  description = "Function App managed identity principal ID — use this when granting additional RBAC roles"
  value       = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

# -----------------------------------------------------------------------------
# Key Vault
# -----------------------------------------------------------------------------
output "vault_uri" {
  description = "Azure Key Vault URI"
  value       = azurerm_key_vault.hcw.vault_uri
}

output "vault_name" {
  description = "Azure Key Vault name"
  value       = azurerm_key_vault.hcw.name
}

# -----------------------------------------------------------------------------
# Observability
# -----------------------------------------------------------------------------
# THE REMAINING EXCEPTION named in the header, stated here too so the two
# cannot drift apart. Ingestion-only: it writes telemetry and can do nothing
# else. Retiring it would mean local development could not emit telemetry at
# all, for no reduction in what an attacker could reach.
output "insights_connection" {
  description = "Application Insights connection string, ingestion-only (local development; production is wired via Terraform). The one recorded exception to the no-key-outputs rule — see the header"
  value       = azurerm_application_insights.hcw.connection_string
  sensitive   = true
}

output "workspace_id" {
  description = "Log Analytics workspace ID"
  value       = azurerm_log_analytics_workspace.hcw.id
}

# -----------------------------------------------------------------------------
# Cloudflare Web Analytics (#1302)
# -----------------------------------------------------------------------------
# NOT SENSITIVE, and not an exception to the header's rule, because neither
# value is a key. `site_token` ships in every page the beacon is loaded from —
# it is the `token` inside the snippet's data-cf-beacon attribute, readable in
# any browser's view-source — and the frontend build reads it from here to
# put it there. `site_tag` is the site's identifier in the Cloudflare API
# path. The API authenticates with an API token, and these are not one.
#
# `one()` over the splat, because the resource is counted on
# cloudflare_account_id (frontend.tf): until the owner sets that variable
# both outputs read null, and a consumer that gets null has its answer — the
# site does not exist yet — instead of an index error on a list of zero.
output "web_analytics_site_token" {
  description = "Cloudflare Web Analytics site token, the public value the page's beacon carries; null until cloudflare_account_id is set (#1302)"
  value       = one(cloudflare_web_analytics_site.hcw[*].site_token)
}

output "web_analytics_site_tag" {
  description = "Cloudflare Web Analytics site tag, the site's identifier in the API path; null until cloudflare_account_id is set (#1302)"
  value       = one(cloudflare_web_analytics_site.hcw[*].site_tag)
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------
output "subnet_id" {
  description = "Functions Flex integration subnet ID — use for additional service firewall rules"
  value       = azurerm_subnet.functions_integration.id
}

# -----------------------------------------------------------------------------
# DNS / Domains
# -----------------------------------------------------------------------------
# The former azure_functions_hostname / azure_swa_hostname outputs (Cloudflare
# CNAME targets) returned values identical to function_hostname / swa_hostname
# above and were consolidated into them — their Cloudflare-CNAME note now lives
# on those descriptions. Consume function_hostname / swa_hostname for CNAMEs.

# -----------------------------------------------------------------------------
# REMOVED 2026-09-01 — cloudflare_plan, and the cloudflare_zone data source that
# fed it.
#
# It was added 2026-08-20 because an architecture argument was being made on an
# assumption about the plan tier, which decides what the edge can and cannot do:
# Origin Rules' Host Header override, Super Bot Fight Mode and mTLS all gate on
# it. That argument was settled, and since then the output's only job was to
# emit THE SAME deprecation TWICE on every run. Not once — twice, and the count
# is quoted from a real run rather than reasoned about, because it was changed
# to "a deprecation warning" on 2026-09-01 by an automated review that asserted
# "a single deprecation warning (not two)" without one:
#
#   Warning: Deprecated value used
#   on outputs.tf line 223, in output "cloudflare_plan":
#       value       = data.cloudflare_zone.current.plan
#   Please use the `/zones/{zone_id}/subscription` API to update a zone's plan.
#
#   Warning: Deprecated value used
#   on outputs.tf line 223, in output "cloudflare_plan":
#       value       = data.cloudflare_zone.current.plan
#   Please use the `/zones/{zone_id}/subscription` API to update a zone's plan.
#
# Two complete blocks, same line, same text — Terraform emits provider
# deprecations once for the refresh and once for the plan.
#
# (Not to be confused with the "Value for undeclared variable" warnings on the
# same runs. Those came from three stale values in the TFC workspace, were
# unrelated to this output, and were fixed by deleting them there on 2026-09-02
# — `migration_writer_enabled`, `cosmos_scratch_enabled` and
# `storage_scratch_enabled`; CHANGELOG.md, "The settings sweep is done". That
# distinction is why the count is spelled out at all, and deleting it was the
# more costly half of the same automated edit.)
#
# THE REPLACEMENT THE WARNING NAMES IS NOT USABLE HERE, which is why this is a
# removal rather than a migration. In provider v5 the non-deprecated path to a
# zone's plan is `cloudflare_zone_subscription` — a RESOURCE, not a data
# source. Reading the plan through it would mean Terraform managing the
# subscription, and the warning says plainly what that risks: "Changing this
# value will create/cancel associated subscriptions." Trading a cosmetic
# warning for a plan Terraform can cancel is not a trade worth making for a
# value nothing consumes.
#
# The plan tier is a static fact that changes only when a human deliberately
# changes it, so it belongs in documentation rather than in a data read on
# every plan. docs/standards/required-inputs.md records where to read it.
#
# The data source went with it because this output was its only consumer.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# REMOVED 2026-08-24 — cosmos_scratch_endpoint, cosmos_scratch_account_name,
# storage_scratch_account and scratch_resource_group.
#
# They described the rehearsal estate, which is destroyed by this change
# (scratch.tf). The header above them also claimed they were consumed by
# scripts/set-github-variables.ps1 wave 2; that script's $waveTwo list holds no
# scratch entry, so the claim was already untrue before the estate went.
#
# The GitHub repository variables COSMOS_SCRATCH_ENDPOINT, STORAGE_SCRATCH_ACCOUNT
# and SCRATCH_RESOURCE_GROUP are therefore orphaned rather than merely stale:
# nothing writes them and nothing reads them. Clearing them is a repository
# settings change, not a Terraform one.
# -----------------------------------------------------------------------------

# The storage account the lab host ships its nightly backups to (LAB-9, #955;
# infra/lab-hybrid-backups.tf). Copied into lab-host/ansible/group_vars/all.yml
# as backups_storage_account by the pull request that adds the upload; the
# host mints its own token for it through the Arc agent, so this is a name,
# never a credential.
output "lab_hybrid_backups_storage_account" {
  description = "Storage account holding the lab host's off-host backups (container host-backups)."
  value       = azurerm_storage_account.lab_hybrid_backups.name
}

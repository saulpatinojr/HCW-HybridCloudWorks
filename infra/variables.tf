# =============================================================================
# variables.tf — Azure infrastructure variables
# All sensitive values are set as workspace variables in HCP Terraform Cloud
# Org: hcw | Project: Site | Workspace: hcw-azure
#
# Variable names here MUST match TF Cloud workspace variable keys exactly.
# See Required-Inputs at the repository root for the full variables/secrets catalog.
# =============================================================================

# -----------------------------------------------------------------------------
# Subscriptions — one per platform/application landing zone
#
# The platform is split across four subscriptions and each is reached through
# its own provider alias (providers.tf). Nothing here has a default: a wrong
# guess would silently deploy the workload into a platform subscription, so an
# unset value must fail the plan rather than pick something.
#
# These are IDs, not credentials — the identity is federated (no secret exists
# to leak) — but they stay `sensitive` to keep subscription IDs out of CI logs.
# -----------------------------------------------------------------------------
variable "subscription_app" {
  description = "Application landing zone: the HCWSite workload (sub-app-site-prod-cus)"
  type        = string
  sensitive   = true
}

variable "subscription_mgmt" {
  description = "Platform Management: central Log Analytics, action groups, and the Terraform identity's own resource group (sub-plat-mgmt-prod-cus)"
  type        = string
  sensitive   = true
}

variable "subscription_conn" {
  description = "Platform Connectivity: hub network and, later, centralized private DNS zones (sub-plat-conn-prod-cus)"
  type        = string
  sensitive   = true
}

# There is no subscription_ident. The Identity landing zone
# (sub-plat-ident-prod-cus) holds nothing: HCWSite authenticates against Entra
# ID, and app registrations are tenant objects rather than subscription
# resources. Declaring the variable would require a value for a subscription
# nothing deploys into — see the note in providers.tf.

# Exactly the resource providers this configuration's resources need, and no
# more. azurerm 5.0 registers none by default, and an unregistered provider
# fails at apply with MissingSubscriptionRegistration rather than at plan.
#
# Set this to [] when ALZ absorption takes registration over centrally: the
# deploy identity would then no longer need the /register/action permission,
# and re-registering under a policy that governs it is at best redundant.
variable "azure_resource_providers" {
  description = "Resource providers Terraform registers on each target subscription; empty the list when registration is centrally governed"
  type        = list(string)
  default = [
    "Microsoft.App", # Flex Consumption subnet delegation (Microsoft.App/environments)
    # No Microsoft.CognitiveServices: AI runs on external provider APIs, so
    # this subscription hosts no Azure OpenAI account to register it for.
    "Microsoft.Compute",             # automatic extension upgrade of the Arc machine's Azure Monitor Agent (#663)
    "Microsoft.DocumentDB",          # Cosmos DB
    "Microsoft.GuestConfiguration",  # machine configuration: the audit-only Linux baseline on the Arc machine (#663)
    "Microsoft.HybridCompute",       # Arc-enabled servers: the lab host's machine resource (#663)
    "Microsoft.HybridConnectivity",  # Arc-enabled servers: the Connected Machine agent's connectivity service (#663)
    "Microsoft.Insights",            # Application Insights, diagnostic settings, action groups, data collection rules
    "Microsoft.KeyVault",            # Key Vault
    "Microsoft.ManagedIdentity",     # user-assigned identities
    "Microsoft.Network",             # virtual network and subnets
    "Microsoft.OperationalInsights", # Log Analytics workspace
    "Microsoft.Storage",             # both storage accounts
    "Microsoft.Web",                 # Function App, service plan, static web app
  ]
}

# centralus, not southcentralus, and the whole estate is there deliberately.
#
# southcentralus was the original choice and it cost three apply-time failures:
# Cosmos has no subscription region access there, Static Web Apps is not
# offered there, and each failure was discovered during an apply rather than
# before one. centralus is the nearest region that hosts every service this
# workload uses, verified before the move rather than after:
#
#   az functionapp list-flexconsumption-locations   # centralus present
#   az provider show --namespace Microsoft.DocumentDB \
#     --query "resourceTypes[?resourceType=='databaseAccounts'].locations"
#   az cosmosdb locations list \
#     --query "[?properties.isSubscriptionRegionAccessAllowedForRegular]"
#
# Consolidating here retires cosmos_location and static_web_app_location as
# exceptions: they were only ever workarounds for southcentralus, and both now
# resolve to the same region as everything else.
variable "azure_location" {
  description = "Azure region for all resources — centralus hosts every service this workload uses"
  type        = string
  default     = "centralus"
}

# Static Web Apps is offered in FIVE regions only — centralus, eastus2,
# westus2, westeurope, eastasia. This now holds the SAME value as
# azure_location, and the variable stays anyway: the constraint has not gone
# away, it is merely satisfied. Fold it into azure_location and the next region
# change fails at apply with LocationNotAvailableForResourceType instead of at
# plan with the validation below.
#
# This is a control-plane location only. The site is served from Azure's global
# edge network either way, so the region does not decide where users are served
# from.
# Only for the FALLBACK speech provider. Listen & Learn synthesises with Gemini
# TTS by default, on the GEMINI_API_KEY the text models already use, and that
# path needs no variable at all. No Speech resource is declared in this
# configuration — provisioning a Cognitive Services account is a spend decision
# for the owner — so this merely names the region whose endpoint would be called
# if one is ever created, keeping the setting correct in advance. If the
# resource is created elsewhere, set this to that region or set
# AZURE_SPEECH_ENDPOINT to its full custom-subdomain URL.
variable "speech_region" {
  description = "Azure region of the fallback Speech resource for Listen & Learn audio — read as AZURE_SPEECH_REGION; unused while Gemini TTS is the provider"
  type        = string
  default     = "centralus"
}

variable "static_web_app_location" {
  description = "Region for the Static Web App — must be one of the five that offer it; equals azure_location today, kept separate because the constraint has not gone away"
  type        = string
  default     = "centralus"

  validation {
    condition     = contains(["centralus", "eastus2", "westus2", "westeurope", "eastasia"], var.static_web_app_location)
    error_message = "Static Web Apps is only available in centralus, eastus2, westus2, westeurope or eastasia."
  }
}

# Cosmos cannot sit in azure_location, and picking where it CAN sit takes two
# independent checks that disagree with each other. Both must pass:
#
#   1. Is the resource type deployable in the region at all? ARM decides, and
#      it is the list in the LocationNotAvailableForResourceType error:
#        az provider show --namespace Microsoft.DocumentDB \
#          --query "resourceTypes[?resourceType=='databaseAccounts'].locations"
#   2. Is THIS subscription cleared for that region? Cosmos decides, separately:
#        az cosmosdb locations list \
#          --query "[?properties.isSubscriptionRegionAccessAllowedForRegular]"
#
# southcentralus passes (1) and fails (2) — the subscription has no region
# access, reported as ServiceUnavailable and "high demand ... for the zonal
# redundant (Availability Zones) accounts", which reads as transient capacity
# and sends you to zone_redundant, where the answer is not.
#
# southcentralus2 passes (2) and fails (1) — Cosmos is simply not offered
# there, reported as LocationNotAvailableForResourceType.
#
# centralus passes both, which is why the whole estate moved there rather than
# leaving Cosmos stranded on its own. Like static_web_app_location, this now
# equals azure_location and stays a separate variable regardless: the two-API
# disagreement above is a property of Cosmos, not of southcentralus, and any
# future region change has to clear both checks again.
variable "cosmos_location" {
  description = "Region for the Cosmos account — must be both ARM-deployable and subscription-allowed; equals azure_location today, kept separate because both checks must be re-run for any new region"
  type        = string
  default     = "centralus"
}

variable "environment" {
  description = "Environment name (prod, staging, dev)"
  type        = string
  default     = "prod"
}

# -----------------------------------------------------------------------------
# Naming
# -----------------------------------------------------------------------------
# A data-plane identifier, NOT an Azure resource name, and therefore outside
# the CAF resource-naming convention.
#
# FOUR code paths hard-code this value as their fallback when COSMOS_DATABASE
# is unset, and all four must change together:
#
#   functions/src/lib/cosmos-client.js
#   scripts/lib/cli.mjs
#   scripts/apply-computed-sortdate.mjs
#   scripts/smoke-deployed.mjs
#
# Change it here without changing them there and those paths connect to a
# database that does not exist — which surfaces as an authorization error,
# not a "no such database" one, because the Cosmos SDK cannot distinguish
# "absent" from "not permitted" for a caller whose RBAC is scoped per-database.
variable "cosmos_database_name" {
  description = "Cosmos SQL database name. Data-plane contract shared with the Functions and scripts workspaces; change only in coordination with them"
  type        = string
  default     = "hcw"
}

variable "workload_name" {
  description = "Workload token in resource names — the application, not the organization (Naming-Convention wiki page)"
  type        = string
  default     = "site"
}

# Microsoft publishes no official region abbreviations, so this is a local
# convention and lives in the Naming-Convention wiki page's table. It is a
# variable because a second region must not require editing every name.
variable "region_abbreviation" {
  description = "Short form of azure_location used in resource names (cus = centralus)"
  type        = string
  default     = "cus"
}

# The CAF instance number. Microsoft's "Define your naming convention" lists
# `01` and `001` as the two accepted forms; this estate uses two digits, which
# is what kv-site-prod-scus-01 already established.
#
# It is NOT applied to every resource. CAF assigns the instance number per
# resource type, and its example table omits it on resource groups, Cosmos DB
# and route tables while requiring it on function apps, web apps, storage
# accounts, virtual networks, subnets, NSGs and managed identities. This
# configuration follows that table where CAF speaks, and for types CAF does
# not list (Key Vault, App Service plan, Log Analytics, Application Insights,
# action groups, Container Apps) applies the instance number where the name is
# GLOBAL scope or a second instance is plausible — which is the same logic CAF
# uses to decide its own table.
#
# The point of the suffix is not decoration. A global-scope name can be taken
# by an unrelated Azure customer, and when that happened to kv-site-prod-scus
# the instance number was the only fallback that did not break the pattern.
variable "instance" {
  description = "CAF instance number used in resource names — the fallback when a global-scope name is already taken"
  type        = string
  default     = "01"

  validation {
    condition     = can(regex("^[0-9]{2,3}$", var.instance))
    error_message = "instance must be two or three digits, e.g. 01 or 001 (CAF: Define your naming convention)."
  }
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------
variable "vnet_address_space" {
  description = "Address space for the workload (spoke) VNet"
  type        = string
  default     = "10.40.0.0/16"
}

# The hub must not overlap any spoke: peering rejects overlapping address
# space, and the failure arrives when the SECOND spoke is peered, long after
# the first choice looks fine. 10.0.0.0/16 for the hub and 10.40.0.0/16 for
# HCWSite leaves 10.1–10.39 for future spokes without re-addressing anything.
#
# Room is reserved inside the hub for the gateway, firewall and Bastion
# subnets even though none is created — subnets cannot be resized after
# creation, and a hub with no room for a firewall is a hub that gets rebuilt:
#
#   10.0.0.0/26   GatewaySubnet        (reserved, not created)
#   10.0.0.64/26  AzureFirewallSubnet  (reserved, not created — /26 minimum)
#   10.0.0.128/26 AzureBastionSubnet   (reserved, not created — /26 minimum)
#   10.0.1.0/24   shared services      (created)
variable "hub_address_space" {
  description = "Address space for the platform hub VNet; must not overlap any spoke"
  type        = string
  default     = "10.0.0.0/16"
}

variable "hub_shared_subnet_prefix" {
  description = "Shared-services subnet in the hub. Deliberately above the /26 ranges reserved for GatewaySubnet, AzureFirewallSubnet and AzureBastionSubnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "functions_subnet_prefix" {
  description = "Address prefix for the Functions Flex integration subnet"
  type        = string
  default     = "10.40.0.0/24"
}

# Every entry here is load-bearing for a firewall rule elsewhere in this
# configuration, not a convenience: Key Vault, Cosmos and Storage all set
# default_action = "Deny" and allow this subnet by VNet rule, and a VNet rule
# without the matching service endpoint is inert. Removing an entry does not
# loosen access, it silently denies the Function App.
#
# This empties out when the account it fronts moves to a private endpoint,
# which is why it is an input rather than a literal.
variable "functions_subnet_service_endpoints" {
  description = "Service endpoints on the Functions integration subnet; each one backs a VNet rule on the matching service"
  type        = list(string)
  default     = ["Microsoft.KeyVault", "Microsoft.AzureCosmosDB", "Microsoft.Storage"]
}

# -----------------------------------------------------------------------------
# Cosmos DB
# -----------------------------------------------------------------------------
variable "cosmos_db_account_name" {
  description = "Cosmos DB account name (globally unique)"
  type        = string
  # This name was already correct before the estate moved: `cus` names where
  # the DATA lives, and a database's region IS data residency rather than a
  # control-plane detail. The rest of the estate has now caught up to it.
  #
  # NO instance number, and that is CAF's call, not an oversight: the "Define
  # your naming convention" example table gives Cosmos `cosmos-<workload>-
  # <environment>` with no <###>, the same as SQL database, API Management and
  # Service Bus. It is one of the three types in this configuration CAF
  # deliberately leaves unnumbered (the others are resource groups and route
  # tables).
  #
  # The tension worth knowing about: a Cosmos account name is GLOBAL scope, so
  # it can be taken by an unrelated customer exactly as kv-site-prod-scus was.
  # If that ever happens here, append `-01` — the pattern accommodates it, and
  # doing so knowingly is different from carrying the suffix by default.
  default = "cosmos-site-prod-cus"
}

variable "cosmos_local_auth_disabled" {
  description = "Disable Cosmos key (local) authentication — AAD/managed-identity only. The durable answer to the key rotation-history question. Set false only if plan review surfaces a key consumer."
  type        = bool
  default     = true
}

variable "cosmos_allow_azure_datacenter_ips" {
  description = <<-EOT
    Include the '0.0.0.0' sentinel in the Cosmos firewall, allowing Azure
    datacenter IPs.

    FALSE SINCE 2026-08-30 (T-718). It was held open by exactly one workload —
    publish-content-manifest.yml querying Cosmos from a GitHub-hosted runner —
    and that query now runs inside the Function App, which reaches Cosmos over
    the integration subnet the firewall admits by virtual_network_rule. Nothing
    in CI holds a Cosmos data-plane role any more.

    NOT heal-computed-properties, which this said until 2026-08-29: it set
    computedProperties through ARM, a control-plane operation this firewall
    never gated, and #816 deleted it once the apply took that write over.
    `apply-computed-sortdate.mjs --inspect` reads documents and needs an
    operator window through cosmos_admin_ip_rules, the same
    populate/apply/work/empty procedure every other live-data inspection
    uses.

    Turning this back on re-admits every Azure tenant at the network layer.
    docs/decisions/0025-cosmos-firewall-datacenter-sentinel.md is the record of why that
    was worth removing and what it cost.
  EOT
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# REMOVED 2026-08-24 — the legacy rehearsal switches
#
# cosmos_scratch_enabled, storage_scratch_enabled and migration_writer_enabled
# all said "retained until an owner confirms the state and approves removal".
# The owner confirmed on 2026-08-24 that the migration rehearsal is finished, so
# they are gone along with everything they gated: the scratch estate (see the
# removal record in scratch.tf) and the three production-import role assignments
# (see the one at the end of oidc.tf).
#
# Each of the three read `default = false` here while the thing it gated was
# LIVE in Azure. That is why the resources were deleted outright rather than
# left behind a default that could not be trusted to be the effective value.
#
# Do not reintroduce these as variables. A rehearsal that needs a sandbox again
# should get a declaration with an owner-set lifetime written next to it, so the
# thing that decides when it is destroyed lives beside the thing being created.
# -----------------------------------------------------------------------------

variable "cosmos_admin_ip_rules" {
  description = <<-EOT
    Operator IPv4 addresses/CIDRs allowed through the Cosmos firewall, for
    smoke tier 2 or live-data inspection. Same pattern as
    admin_ip_rules on Key Vault: populate for the window, apply, work, empty
    it, apply again. Empty is the correct steady state.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for ip in var.cosmos_admin_ip_rules : can(cidrnetmask("${ip}/32")) || can(cidrnetmask(ip))])
    error_message = "cosmos_admin_ip_rules entries must be IPv4 addresses or CIDR ranges."
  }
}

# -----------------------------------------------------------------------------
# Storage
# -----------------------------------------------------------------------------
variable "functions_storage_network_default_action" {
  description = "Default network action on the Functions host storage account. \"Deny\" is the T-503 posture; \"Allow\" is the one-step rollback if the app stops cold-starting or deploys fail after the firewall lands."
  type        = string
  default     = "Deny"

  validation {
    condition     = contains(["Allow", "Deny"], var.functions_storage_network_default_action)
    error_message = "functions_storage_network_default_action must be \"Allow\" or \"Deny\"."
  }
}

variable "functions_storage_admin_ip_rules" {
  description = <<-EOT
    Operator IPv4 addresses/CIDRs allowed through the Functions host storage
    firewall, for manual package uploads or host-state inspection. Same
    pattern as admin_ip_rules and cosmos_admin_ip_rules: populate for the
    window, apply, work, empty, apply. Empty is the correct steady state —
    workflow deploys use their own per-run firewall window instead.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for ip in var.functions_storage_admin_ip_rules : can(cidrnetmask("${ip}/32")) || can(cidrnetmask(ip))])
    error_message = "functions_storage_admin_ip_rules entries must be IPv4 addresses or CIDR ranges."
  }
}

# Same shape as functions_storage_network_default_action above: the secure
# value is the default and the variable exists so the insecure one is a
# workspace edit rather than a code change under pressure.
variable "storage_shared_access_key_enabled" {
  description = <<-EOT
    Allow shared-key (account key) authentication on the content and Functions
    host storage accounts. False is the intended posture and disables the
    account keys entirely for data-plane access; Entra tokens still work.

    Both consumers are already identity-based and neither reads a key:

      - the Function App authenticates with its managed identity
        (storage_authentication_type = "SystemAssignedIdentity" plus
        AzureWebJobsStorage__accountName, main.tf);
      - deploy-functions.yml opens a network window and uploads with the
        deploy identity's Entra token, not with a key.

    Terraform itself is unaffected: azurerm_storage_container here takes
    storage_account_id, which is the Resource Manager API, not the data plane.

    ROLLBACK is one edit to `true` and an apply. Reach for it if a deploy
    starts failing with an authentication error against storage, or if the host
    stops cold-starting — the failure mode to expect is a 403 on a storage
    call, which does NOT present as storage (see the AzureWebJobsStorage note
    in main.tf: it presents as 404s on every route).
  EOT
  type        = bool
  default     = false
}

# The two storage accounts are the one place the CAF pattern cannot be read
# literally: storage account names take NO hyphens and cap at 24 characters, so
# the delimiters are dropped and the instance number runs straight onto the
# end. CAF names this shape itself — `st<workload><###>`, e.g. stworkload1data001
# — so this is the convention followed, not abandoned.
#
#   stsitefuncprodcus01   19 chars
#   stsiteprodcus01       15 chars
#
# Both are explicit rather than computed: a name a reader cannot predict from
# the convention should not be assembled out of it, and these are the names
# that appear in workflow files and support tickets.
variable "functions_storage_account_name" {
  description = "Functions host storage account (globally unique, 3-24 chars, lowercase alphanumeric — no hyphens, so the CAF instance number runs on unseparated)"
  type        = string
  default     = "stsitefuncprodcus01"
}

variable "storage_account_name" {
  description = "Azure Storage account name (globally unique, 3-24 chars, lowercase alphanumeric — no hyphens, so the CAF instance number runs on unseparated)"
  type        = string
  default     = "stsiteprodcus01"
}

# -----------------------------------------------------------------------------
# Function App
# -----------------------------------------------------------------------------
# CAF gives the function app an instance number in its own example table
# (func-<workload>-<environment>-<###>.azurewebsites.net), and the name is
# global across azurewebsites.net, so the suffix is also the collision
# fallback. Changing it changes the API hostname — see the Deployment Runbook
# for what has to be re-pointed.
variable "function_app_name" {
  description = "Azure Function App name (globally unique across azurewebsites.net)"
  type        = string
  default     = "func-site-prod-cus-01"
}

# -----------------------------------------------------------------------------
# Key Vault
# -----------------------------------------------------------------------------
variable "key_vault_name" {
  description = "Azure Key Vault name (globally unique, 3-24 chars)"
  type        = string
  # `-01` here is the original instance number used in earnest: the unsuffixed
  # kv-site-prod-scus is held by an unrelated Azure customer — vault names are
  # global and it is not soft-deleted anywhere in this tenant, so it cannot be
  # recovered. That incident is why the suffix is now a first-class part of the
  # convention rather than an improvisation. 19 characters, inside the
  # 24-character limit.
  #
  # NOTE ON REPLACEMENT: the vault this replaces is soft-deleted, not purged
  # (purge_soft_delete_on_destroy = false in providers.tf), so the OLD name
  # stays reserved for the retention window. That is harmless here only because
  # the new name differs. Reusing a destroyed vault's name requires a purge.
  default = "kv-site-prod-cus-01"
}

# ON by owner decision 2026-09-14 (ADR 0031), reversing the 2026-08-24
# acceptance recorded in ADR 0021. Purge protection is ONE-WAY: once an apply
# sets it, Azure refuses to clear it, so setting this variable back to false
# afterwards produces a failed apply, not a disabled vault. A deleted vault can
# no longer be purged and its name stays reserved for the 90-day soft-delete
# window — the teardown-and-recreate path ADR 0021 kept is given up on purpose.
#
# If a Terraform Cloud workspace variable of this name exists, it overrides this
# default. On the FIRST apply after this change — while the live vault still has
# purge protection off — the plan must show purge_protection_enabled changing to
# true on azurerm_key_vault.hcw; a first plan that does not is the workspace
# variable. Once it has been applied (or enabled out of band and seen by the
# refresh), no change there is the expected steady state, not an override.
variable "purge_protection_enabled" {
  description = "Enable Key Vault purge protection. On by owner decision 2026-09-14 (ADR 0031). One-way: Azure cannot turn it off once applied."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Budget
# -----------------------------------------------------------------------------
variable "foundry_account_name" {
  description = <<-EOT
    The Microsoft Foundry (AIServices) account the `foundry` provider calls
    (#849). Also its custom subdomain, so it must be globally unique, lowercase
    letters, digits and hyphens: the router reaches
    https://<name>.openai.azure.com/openai/v1/chat/completions.
  EOT
  type        = string
  default     = "ais-site-prod-cus-01"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,62}$", var.foundry_account_name))
    error_message = "foundry_account_name must be 2-63 lowercase letters, digits or hyphens."
  }
}

variable "foundry_budget_amount_usd" {
  description = "Monthly budget amount in USD for the Foundry resource group's alerts (#849, owner decision 2026-10-04). A budget notifies at its thresholds; it does not stop spend"
  type        = number
  default     = 75
}

variable "budget_amount_usd" {
  description = "Monthly budget ceiling in USD for the APPLICATION subscription"
  type        = number
  default     = 150
}

# A second ceiling, because the first one could not see the largest
# controllable cost on the platform.
#
# The application budget watches sub-app-site-prod-cus. Log Analytics bills in
# sub-plat-mgmt-prod-cus, which had no budget at all — so the one line that
# actually varies with load (ingestion, at roughly USD 2.30-2.76/GB) was the
# one line nothing was watching. A 0.25 GB/day cap is about 7.5 GB/month, so
# 25 is a ceiling the workspace should never reach while the cap holds, and one
# that fires early if the cap is ever raised without the spend being thought
# about.
variable "budget_amount_mgmt_usd" {
  description = "Monthly budget ceiling in USD for the Platform Management subscription — Log Analytics ingestion and retention"
  type        = number
  default     = 25
}

variable "budget_alert_email" {
  description = "Email address for budget alert notifications"
  type        = string
}

# T-709. Every alert rule in this estate routes through one action group, and
# that group had exactly one receiver: a single mailbox, reached across a
# subscription boundary whose delivery has never been observed. Azure alert
# rules cannot carry a direct email, so there is no second path anywhere — if
# that one hop is silently inert, the estate has rules that evaluate and page
# nobody, which observability.tf itself calls "strictly WORSE than the visible
# emptiness" it replaced.
#
# An SMS receiver is the cheapest independent channel (free, and it does not
# share the mailbox's failure modes). Empty by default: a phone number is owner
# data, and the vault/variable rules say real values never enter tracked files.
# Left empty the action group is exactly as it was, so this variable adds a
# capability rather than a requirement.
variable "ops_sms_receiver" {
  description = "Optional second alert channel: { country_code, phone_number }. Empty disables it."
  type = object({
    country_code = string
    phone_number = string
  })
  default = {
    country_code = ""
    phone_number = ""
  }
  validation {
    # Both or neither — a half-configured receiver is an ARM error at apply
    # time, which is a slow way to learn about a typo.
    condition = (
      (var.ops_sms_receiver.country_code == "" && var.ops_sms_receiver.phone_number == "") ||
      (var.ops_sms_receiver.country_code != "" && var.ops_sms_receiver.phone_number != "")
    )
    error_message = "ops_sms_receiver needs both country_code and phone_number, or neither."
  }
}

# Optional since #820. Unset (the default), each budget is created with the
# first of the month the plan runs in (local.budget_start_date, budget.tf).
# Set only to pin a specific month, which Azure accepts only if it is the
# current month or later, in UTC. Existing budgets ignore it either way.
#
# Until #820 this defaulted to 2026-08-01, and the comment here said to move
# it by hand before any apply that creates a budget. A literal that must be
# remembered is a failure scheduled for the first month nobody remembers.
variable "budget_start_date" {
  description = "Optional budget period start (RFC3339, first of a month). Unset uses the first of the month the plan runs in"
  type        = string
  default     = null

  validation {
    condition     = var.budget_start_date == null ? true : can(regex("^\\d{4}-\\d{2}-01T00:00:00Z$", var.budget_start_date))
    error_message = "budget_start_date must be null, or the first of a month, e.g. 2026-10-01T00:00:00Z."
  }
}

# -----------------------------------------------------------------------------
# Observability — availability test
#
# The only alert rule in observability.tf that costs money per evaluation and
# depends on something outside Azure to succeed. Hence three variables rather
# than three literals: arming it, and deciding what it costs, are workspace
# decisions.
# -----------------------------------------------------------------------------
variable "availability_test_enabled" {
  description = <<-EOT
    Run the /api/health availability test. FALSE until the Cloudflare side is
    settled.

    The test asks https://api-azure.<domain>/api/health from Azure's
    availability agents, which are datacenter clients. deploy-functions.yml
    records that a datacenter client asking this host for /api/health is served
    Cloudflare's Bot Fight Mode interstitial and a 403, and that a WAF skip
    rule against it was built, applied and confirmed inert. So arming this
    first would most likely create a permanently-firing alert, and an alert
    that always fires is an alert nobody reads.

    Arm it only after one execution has been observed succeeding — give the
    agents a path through Cloudflare (a rule matching the test's
    X-Customer-InstanceId header, or the ApplicationInsightsAvailability
    service tag), then flip this. The metric alert on the test is gated on this
    same variable, so flipping it creates the alert and arms the test together
    rather than leaving a reachability alert that nothing can fire.
  EOT
  type        = bool
  default     = false
}

variable "availability_test_geo_locations" {
  description = <<-EOT
    Availability-test agent locations, as Azure population tags (NOT region
    names — "us-tx-sn1-azr", not "southcentralus").

    Five is Microsoft's recommended minimum and is what makes the alert's
    3-of-5 vote meaningful: with fewer locations a single agent's network
    problem is a larger fraction of the vote. The five here are all US, because
    the audience is, and because each additional location is a recurring
    per-execution charge rather than a one-off.

    The alert's failure threshold is derived from the LENGTH of this list
    (observability.tf), so trimming it to cut cost narrows the vote with it
    rather than leaving a threshold that can no longer be reached.
  EOT
  type        = list(string)
  default = [
    "us-fl-mia-edge", # Central US — same region as the workload
    "us-tx-sn1-azr",  # South Central US
    "us-il-ch1-azr",  # North Central US
    "us-va-ash-azr",  # East US
    "us-ca-sjc-azr",  # West US
  ]

  validation {
    condition     = length(var.availability_test_geo_locations) >= 3
    error_message = "availability_test_geo_locations needs at least 3 entries; below that a single agent's network problem is a majority of the vote."
  }
}

variable "logs_daily_quota_gb" {
  description = <<-EOT
    Daily billable-ingestion cap on the Log Analytics workspace, in GB.

    A variable rather than the literal it was until 2026-08-31, because T-719
    needs a measurement this cap makes impossible to take. The two most
    important workload signals — function_http_5xx and function_response_time —
    are LOG rules, because Flex Consumption publishes no HTTP metrics, and log
    rules stop evaluating once the cap trips. The post-prune daily volume was
    never confirmed against a day with headroom, so the margin protecting them
    is an estimate.

    HOW TO TAKE THE MEASUREMENT. Raise this in the workspace to a number the
    platform cannot plausibly reach in a day, leave it for one full cap period
    (the reset is 08:00 UTC, not midnight — Azure assigns the hour and it
    cannot be configured), read the ingestion, then put it back. A day that
    sits exactly at the cap is truncation, not demand, and reading it as demand
    is the specific mistake this variable exists to make avoidable.

    -1 IS DELIBERATELY REFUSED, though Azure accepts it for "unlimited". The
    logs_daily_cap alert derives its threshold from this value times 0.8
    (observability.tf), so an unlimited workspace would give that rule a
    NEGATIVE threshold and it would fire on every evaluation, forever, about a
    cap that does not exist. Raising the number keeps the alert meaningful at
    the new level; removing the cap silently turns a guard into a mail rule.
  EOT
  type        = number
  default     = 0.25

  validation {
    condition     = var.logs_daily_quota_gb > 0
    error_message = "logs_daily_quota_gb must be greater than 0. Azure accepts -1 for an unlimited workspace, but the logs_daily_cap alert threshold is this value * 0.8, so a negative cap gives that rule a negative threshold and it fires on every evaluation. Raise the cap to measure; do not remove it."
  }
}

variable "logs_retention_in_days" {
  description = <<-EOT
    Log retention period in days for the Log Analytics workspace (PLAT-8, #968).

    30 days is the Azure PerGB2018 included minimum. 90 days satisfies the compliance
    audit finding for retaining security logs, audit events, syslog, and diagnostics.
    At the 0.25 GB/day daily cap, 90 days retention incurs negligible additional cost (~$1.50/mo).
  EOT
  type        = number
  default     = 90

  validation {
    condition     = var.logs_retention_in_days >= 30 && var.logs_retention_in_days <= 730
    error_message = "logs_retention_in_days must be between 30 and 730 days."
  }
}

variable "availability_probe_alert_enabled" {
  description = <<-EOT
    Arm the alert on the Cloudflare Worker reachability probe (ADR 0024).

    The probe itself lives outside Terraform: edge/availability-probe is a
    Worker on a 5-minute cron, deployed by the owner with wrangler, reporting
    each GET /api/health attempt to Application Insights as an availability
    result named edge-api-health. It exists because the standard web test
    above cannot run on this Cloudflare plan — Bot Fight Mode 403s every
    datacenter client and no WAF rule can exempt them — so this is the
    alternative path to the same signal, at no per-execution cost.

    The alert fires on ABSENT successes, not present failures, so a dead
    Worker, a dead cron and an unreachable API are all the same incident. The
    corollary: arming it before the probe is deployed and observed writing
    success rows creates a rule that fires immediately and permanently. Flip
    this only after the query in docs/runbooks/availability-probe.md shows
    success == 1 rows, per the same observed-behaviour rule as everything
    else armed from this workspace (Cutover-Runbook step 5).
  EOT
  type        = bool
  default     = false
}

# The one switch for the Cosmos exporter (ADR 0028, #231). It sets the
# FEATURE_FLAG_COSMOS_EXPORT app setting (functionapp.tf) AND creates the two
# missing-run alert rules (observability.tf), so the exporter and the alert on
# its absence arm together and disarm together. That pairing is why it is its
# own variable and not a name in enabled_timers: the alert is not a timer, and
# a reader of the workspace variables should see one switch called
# cosmos_export_enabled rather than infer the alert's existence from a set.
variable "cosmos_export_enabled" {
  description = <<-EOT
    Arm the Cosmos out-of-account export (ADR 0028, #231) and its two
    missing-run alerts.

    True sets FEATURE_FLAG_COSMOS_EXPORT = "true" on the Function App — the
    string the exporter timer reads, like every other timer flag — and
    creates alert-cosmos-export-daily and alert-cosmos-export-full in the
    web resource group. False, the default, writes "false" and creates no
    rule. The cosmos-export container and its 35-day lifecycle rule exist
    either way, empty and idle, so the apply that lands this variable
    changes nothing that runs.

    The alerts fire on ABSENCE of a cosmosExportCompleted custom event, which
    is why they are bound to the same variable as the flag: a rule created
    while the exporter is off fires on its first evaluation and never stops.
    Two residues remain, both bounded. The daily rule's first evaluation can
    precede the exporter's first 03:00 UTC run, in which case it mails once
    on the arming apply and is quiet after that run completes. And the full
    rule checks each Monday for the Sunday just gone, so a flag that arrives
    on a Sunday after 03:00 UTC has no full to find: flip this Monday to
    Saturday, or expect one Monday mail.

    Preconditions: the Function App has been deployed with the exporter code
    (the functions/ half of #231) and has been seen emitting the event —
    `customEvents | where name == "cosmosExportCompleted"` in Application
    Insights — and schedulers_master_enabled is true, because a timer
    registered through schedulers.js is held off by FEATURE_FLAG_SCHEDULERS
    = "false" whatever this variable says.
  EOT
  type        = bool
  default     = false
}

variable "cosmos_export_immutability_locked" {
  description = <<-EOT
    Lock the time-based immutability policy on the cosmos-export container (ADR 0028, PLAT-8).

    When false (unlocked), WORM retention (35 days) is enforced by Azure Storage against
    non-admin and application identities, while subscription owners can modify or delete
    the policy for testing and administrative maintenance. When true (locked), the policy
    becomes legally binding and completely irrevocable: neither subscription owners nor
    Microsoft support can shorten the retention period or delete the container/blobs until
    the 35-day retention expires.
  EOT
  type        = bool
  default     = false
}

variable "availability_test_frequency_seconds" {
  description = <<-EOT
    How often EACH location runs the test. Azure accepts 300, 600 or 900 only.

    This is the cost dial. Standard tests bill per execution and the free URL
    ping test retires 2026-09-30, so at 5 locations: 900 is 14,400 executions a
    month, 600 is 21,600, and 300 is 43,200. Against a platform spending about
    USD 3.23 a month on Azure today, the difference between the ends of that
    range is real money.

    900 buys detection within about 15 minutes while the five locations are
    staggered, so in practice the endpoint is asked roughly every 3 minutes.
    Drop to 300 when something depends on tighter detection than that.
  EOT
  type        = number
  default     = 900

  validation {
    condition     = contains([300, 600, 900], var.availability_test_frequency_seconds)
    error_message = "availability_test_frequency_seconds must be 300, 600 or 900 — the only values Azure accepts."
  }
}

# -----------------------------------------------------------------------------
# Auth / Entra ID
# -----------------------------------------------------------------------------
variable "entra_tenant_id" {
  description = "Entra ID tenant ID for JWT validation and OIDC deployment"
  type        = string
  sensitive   = true
}

# NOTE: `entra_client_id` was removed here. It fed the ENTRA_CLIENT_ID app
# setting, which the API used as its JWT audience — the single-registration
# model DECISION 3 replaces. Nothing in this configuration consumed it
# afterwards, and leaving a required variable with no consumer forces operators
# to supply a value for nothing. The SPA client id is still needed, but by the
# frontend build, not by this Terraform.

# DECISION 3 — two app registrations: a public-client SPA, and a separate API
# exposing api://<api-client-id>. The API validates `aud` against its OWN
# identifier.
#
# With a single registration an ID token minted for the SPA carries
# aud = <client-id>, indistinguishable from an access token for the API — so a
# token the browser was never meant to send to an API would be accepted by it.
#
# TRUE AGAIN SINCE 2026-09-12 (#522). The tenant ran a single registration until
# then, so the hazard above was live rather than hypothetical. The split does
# NOT change this variable: it changes the client, not the resource, so `aud` is
# still the API's own client id. If you are reading this while changing
# entra_api_audience because a new registration appeared, stop — the only value
# that moved is VITE_ENTRA_CLIENT_ID.
#
# No default, and functions/src/lib/auth/verify-token.js refuses to start
# without it. That is deliberate: jsonwebtoken only applies the audience check
# when `audience` is truthy, so an unset value does not fail — it SKIPS audience
# validation and successfully verifies any Microsoft-signed token for the
# tenant, including a Graph token.
variable "entra_api_audience" {
  # This said `api://<guid>` until 2026-08-24 and the live value is a bare
  # GUID, which is not a discrepancy — it is the v1/v2 token distinction. Entra
  # puts the App ID URI in `aud` for v1 access tokens and the API
  # registration's CLIENT ID in `aud` for v2 ones. The SPA requests v2, so the
  # bare GUID is correct here and the URI form would reject every real token.
  # Read the registration's `accessTokenAcceptedVersion` before changing it.
  description = "Audience the API validates `aud` against: the API registration's client id (a bare GUID) for v2 tokens, or its api://<guid> App ID URI for v1. Live value is the bare GUID"
  type        = string

  validation {
    condition     = length(trimspace(var.entra_api_audience)) > 0
    error_message = "entra_api_audience must not be empty; an empty audience silently disables audience validation."
  }
}

# -----------------------------------------------------------------------------
# GitHub OIDC deployment identities (used for federated credential setup)
# -----------------------------------------------------------------------------
# These two are not cosmetic. They compose the federated credential `subject`
# in oidc.tf, which GitHub's OIDC token must match EXACTLY. A stale value does
# not warn — the token is issued, Azure declines it, and azure/login fails with
# a generic AADSTS70021 "no matching federated identity record found".
#
# Both were stale until now: the repository moved to the HybridCloudWorks org,
# and nothing consumed these variables, so nothing surfaced the drift.
#
# Stale again on 2026-10-07: the owner transferred the repository from the
# HybridCloudWorks organisation to the personal account saulpatinojr, and every
# azure/login failed with AADSTS700213 from the next scheduled run. The owner
# and its numeric ID in oidc.tf's `github_immutable_prefix` move together;
# scripts/oidc-subjects.test.mjs now compares both with the repository CI runs
# in, so the next transfer fails a pull request instead of a deploy.
variable "github_org" {
  description = "GitHub account (organisation or user) that owns the repository — must match the owner in the OIDC token subject claim"
  type        = string
  default     = "saulpatinojr"
}

variable "github_repo" {
  description = "GitHub repository name (without org prefix) — must match the OIDC token subject claim"
  type        = string
  default     = "HCW-HybridCloudWorks"
}

variable "github_deploy_ref" {
  description = "Git ref allowed to assume the deployment identity. Deploys are gated to this branch."
  type        = string
  default     = "refs/heads/main"
}

# -----------------------------------------------------------------------------
# Key Vault seeding access
# -----------------------------------------------------------------------------
variable "admin_ip_rules" {
  description = <<-EOT
    Public IPv4 addresses or CIDRs permitted to reach Key Vault, for seeding
    secrets by hand. Empty is the correct steady state: the vault is then
    reachable only by the Function App over its subnet.

    Populate for the seeding window, apply, run the `az keyvault secret set`
    commands, then empty it and apply again. Secret values are never managed by
    Terraform, so they do not enter state or Terraform Cloud.

    THIS OPENS THE NETWORK, NOT THE DOOR. This used to say "as Azure Owner",
    which is wrong in a way that cost an hour on 2026-08-23: the vault sets
    `enable_rbac_authorization = true`, and Owner is a CONTROL-plane role that
    conveys no data-plane access to secret values. An operator with this IP
    allowed and no data-plane role gets `ForbiddenByRbac` from a vault whose
    firewall just let them in. Grant the role with `admin_object_ids` below.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for ip in var.admin_ip_rules : can(cidrnetmask("${ip}/32")) || can(cidrnetmask(ip))])
    error_message = "admin_ip_rules entries must be IPv4 addresses or CIDR ranges."
  }
}

variable "admin_object_ids" {
  description = <<-EOT
    Entra object ids granted **Key Vault Secrets Officer** on the vault, for
    reading and seeding secret values by hand.

    WHY THIS HAS TO EXIST. The vault is RBAC-authorised with zero access
    policies, and the only principals Terraform grants are the Function App
    (Secrets User) and Terraform's own service principal (Secrets Officer). No
    human was granted anything — while every cutover script in scripts/cutover
    assumes the operator can read secrets. `04-telegram-webhook.ps1` opened the
    firewall exactly as designed and was then refused by RBAC, which reads as a
    broken script rather than a missing role assignment.

    Being Owner of the subscription does NOT help: that is control-plane, and
    secret values are data-plane.

    Same lifecycle as admin_ip_rules — populate for the window, apply, do the
    work, empty it, apply again. Standing human access to production secrets is
    not the steady state, which is why the default is empty and why this is a
    reviewed variable rather than a portal click nobody records.

    Object ids, not e-mail addresses: `az ad signed-in-user show --query id -o tsv`.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for id in var.admin_object_ids :
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", id))
    ])
    error_message = "admin_object_ids entries must be Entra object id GUIDs, not e-mail addresses or display names."
  }
}

# -----------------------------------------------------------------------------
# Cloudflare (DNS management)
# -----------------------------------------------------------------------------
variable "cloudflare_api_token" {
  description = "Cloudflare API token — Zone:Read + DNS:Edit scoped to the domain, plus Transform Rules:Edit, Account Rulesets:Read and (for the Web Analytics site) Account Settings:Write; the permission list is beside cloudflare_origin_secret"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for the domain"
  type        = string
}

# The Cloudflare ACCOUNT, not the zone: cloudflare_web_analytics_site in
# frontend.tf is an account-level resource and the API takes the account id in
# its path. An identifier, not a credential: the dashboard prints it on the
# zone's Overview page under API, beside the zone id, and the GitHub
# repository variable CLOUDFLARE_ACCOUNT_ID already holds the same value for
# the daily DNS audit (docs/standards/required-inputs.md §4.2). Set it in the
# hcw-azure workspace as a plain Terraform variable with that value.
#
# Null by default, like arc_onboarding_principal_id, rather than required
# like cloudflare_zone_id, because of what an unset value does to the plan.
# The zone id is the address of every DNS record this estate serves on, so a
# plan with no zone id has nothing to say and SHOULD fail. The account id
# serves one resource that no visitor-facing path depends on, and a required
# variable would fail every plan — the merge's queued run, the speculative
# plans, tfc-plan-check's read — until the owner has typed the value into the
# workspace. Null keeps the apply whole: the Web Analytics site and its two
# app-setting readers are simply not created until the id is set, and the
# outputs read null. Thirty-two lowercase hex characters, which is the shape
# Cloudflare account ids take; a wrong value fails at plan time here rather
# than at apply time as a 404 on /accounts/<id>/rum/site_info that names the
# wrong thing.
variable "cloudflare_account_id" {
  description = "Cloudflare account id (32 hex characters) that owns the zone; null until set, which leaves cloudflare_web_analytics_site uncreated (#1302)"
  type        = string
  default     = null

  validation {
    condition     = var.cloudflare_account_id == null || can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be the 32-character lowercase hex account id the Cloudflare dashboard shows under API on the zone Overview page, or null."
  }
}

# -----------------------------------------------------------------------------
# Origin lock (DECISION 6)
#
# Two halves that are worthless apart, which is why they land together:
#
#   1. Cloudflare stamps every request it proxies with x-hcw-origin-secret.
#   2. The Function App refuses traffic that did not come from Cloudflare.
#
# With only (1), anyone who learns the header value replays it straight at the
# origin. With only (2), the app cannot tell a Cloudflare request from a
# direct one and client-identity.js keeps failing closed. Together they make
# CF-Connecting-IP trustworthy, which is the whole point: rate limiting on a
# spoofable identifier is not rate limiting.
# -----------------------------------------------------------------------------

# The SAME value that sits in Key Vault as CF-ORIGIN-SECRET, which the Function
# App reads at runtime. It is duplicated here because the two ends of a shared
# secret are configured by different systems and neither can read the other's
# copy: Terraform configures Cloudflare, the app reads the vault.
#
# THE TWO MUST MATCH EXACTLY. A mismatch is not a partial failure — every
# anonymous request is treated as bypassing Cloudflare and throws.
#
# Set as a SENSITIVE workspace variable in HCP Terraform, never in a tfvars
# file. Rotating it means writing both ends before the next request lands, so
# do it in a maintenance window, vault first.
#
# THE API TOKEN NEEDS MORE THAN DNS. cloudflare_ruleset requires Zone →
# Transform Rules:Edit and Account → Rulesets:Read on top of the Zone:Read and
# DNS:Edit the records need. A DNS-only token applies every cloudflare_dns_record
# cleanly and fails on the ruleset alone with "Authentication error (10000)",
# which names neither the token nor the permission.
#
# AND, SINCE #1302, ONE ACCOUNT-LEVEL WRITE. cloudflare_web_analytics_site
# (frontend.tf) is created through POST /accounts/{account_id}/rum/site_info,
# which Cloudflare's API reference lists under the permission Account →
# Account Settings → Write. Add it to the same token
# (hcp-terraform-cloudflare-dns in the dashboard) before the apply that
# creates the site. The failure without it is the same shape as the ruleset's:
# every record and the ruleset apply, and the one new resource errors — by
# the documented pattern, "Authentication error (10000)", though that exact
# code on this endpoint is inferred from the ruleset case rather than
# observed. The widening is accepted for this resource only: a Web Analytics
# site holds no secret and serves no visitor-facing path, so the trade the
# Turnstile note in frontend.tf refused still stands for anything that does.
variable "cloudflare_origin_secret" {
  description = "Shared secret Cloudflare injects as x-hcw-origin-secret; MUST equal the CF-ORIGIN-SECRET value in Key Vault"
  type        = string
  sensitive   = true
  default     = ""
}

# The kill switch. false is the pre-lock posture and the one-step rollback.
#
# Turning this on restricts the Function App to Cloudflare's published ranges,
# so anything reaching the origin directly stops working — including, until it
# was fixed alongside this variable, the post-deploy smoke test in
# deploy-functions.yml, which curled the azurewebsites.net hostname from a
# GitHub-hosted runner. That test now admits its own runner through a per-run
# allow rule (ci-smoke-<run id>) and removes it afterwards.
#
# deploy-functions.yml asserts this posture from the control plane after every
# deploy (PLAT-2, #962): it fails unless the site's unmatched-request action
# is Deny, so a deploy run while this is false goes red by design. It used to
# curl the proxied hostname instead, which Cloudflare's Bot Fight Mode answers
# with a 403 whatever this variable says.
#
# Enable only when cloudflare_origin_secret is set AND the vault holds the same
# value. Enabling with an empty secret locks the origin without giving
# Cloudflare a way to identify itself.
# Enabled 2026-08-20, after cloudflare_ruleset.origin_secret was created and
# verified: phase http_request_late_transform, scoped to the api-azure host,
# stamping x-hcw-origin-secret from the same value the vault holds.
#
# Set false to roll back in one step. That is the whole reason this is a
# variable and not a hardcoded block — the failure it guards against
# (Cloudflare ranges change, or a legitimate caller needs the origin) is a
# same-day problem, not a next-sprint one.

variable "functions_origin_lock_enabled" {
  description = "Restrict the Function App to Cloudflare IP ranges. Requires cloudflare_origin_secret to match Key Vault"
  type        = bool
  default     = true
}

# SCM (Kudu) is the deploy endpoint, and locking it is a per-run window rather
# than a standing rule — which is why this is a switch and not simply "Deny".
#
# The Flex Consumption deploy publishes THROUGH Kudu, and GitHub-hosted runners
# have no stable egress IPs, so a standing Deny breaks every deploy. The
# mechanism that makes Deny survivable lives in deploy-functions.yml: it adds
# this runner's IP as an SCM allow rule, deploys, and removes it in an
# always-run step that asserts the posture it found is the posture it left.
#
# Default true since 2026-10-14 (PLAT-10, #970). The workspace set it true on
# 2026-08-25, the window was proven under Deny by deploy run 32902534458 that
# day, and the SCM default action read Deny on 2026-10-14 (#981), so the code
# default now says what the estate does; the plan for the flip is empty.
# For a fresh workspace the order is still not optional: the window must be
# merged and observed working on a real deploy BEFORE this is true there,
# because the first deploy after a premature flip is the one that cannot get
# in to fix it. Setting it false in a workspace is the way to stand a new
# estate up.
#
# Turning it on does not remove the credential half, which is already closed —
# basic authentication is off on both SCM and FTP, so anything reaching the
# endpoint must present an Entra token. This closes the reachability half.
variable "functions_scm_lock_enabled" {
  description = "Deny SCM/Kudu by default, admitting deploy runners through a per-run firewall window. Requires the SCM window steps in deploy-functions.yml"
  type        = bool
  default     = true
}


# Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4).
#
# A literal list rather than an http data source on purpose: a data source puts
# a network call and an external dependency inside every plan, and a fetch that
# fails or returns a truncated body during an apply would silently rewrite the
# allow-list of the only door into this app. A list changes rarely, is
# reviewable in a diff, and fails at plan time when wrong.
#
# Re-check it when Cloudflare announces a change; the ranges have been stable
# for years but they are not immutable.
#
# Change it HERE, not as an hcw-azure workspace variable. After every deploy,
# deploy-functions.yml holds the Function App's live Allow rules to this
# default (scripts/assert-origin-lock.mjs reads it from this file, PLAT-2):
# a range the live rules admit that this list lacks, or one it lists that no
# rule admits, fails the deploy, so an override set only in the workspace
# would turn every deploy red.
variable "cloudflare_ip_ranges" {
  description = "Cloudflare IPv4 ranges allowed to reach the Function App origin when the origin lock is on"
  type        = list(string)
  default = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]
}

# -----------------------------------------------------------------------------
# Domain
# -----------------------------------------------------------------------------
variable "domain" {
  description = "Base domain for all services"
  type        = string
  default     = "hybridcloudworks.com"
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------
# NOTE (T-752): `environment` here is a fallback only — local.tags in main.tf
# overrides it from var.environment, so the two cannot drift. `workload` is
# deliberately NOT derived from var.workload_name: the live estate is tagged
# `hybridcloudworks` while resource NAMES carry the workload token `site`, and
# reconciling them rewrites the tag on every resource in the subscription. That
# is a deliberate, owner-visible change rather than a side effect of this one,
# so it is recorded in the review and left alone here.
variable "tags" {
  description = "Default tags applied to all Azure resources (see local.tags)"
  type        = map(string)
  default = {
    workload           = "hybridcloudworks"
    environment        = "prod"
    owner              = "platform"
    costCenter         = "content-platform"
    managedBy          = "terraform"
    criticality        = "high"
    dataClassification = "internal"
  }
}

# -----------------------------------------------------------------------------
# Cutover switches
# -----------------------------------------------------------------------------

# The master kill switch, which was a hardcoded string until 2026-08-24.
#
# main.tf wrote FEATURE_FLAG_SCHEDULERS = "false" as a literal while the
# comment beside it described a workspace-variable design and enabled_timers
# below documented "arming the first timer means setting BOTH". Only one of
# those two was actually settable, so every one of the 18 timers was a
# guaranteed no-op no matter what enabled_timers said — schedulers.js gates
# every timer on `FEATURE_FLAG_SCHEDULERS === 'false'` before it looks at the
# per-timer flag. A cutover step that reads "add the timer to enabled_timers
# and apply" would have completed successfully and changed nothing.
#
# Default false, so this change alone arms NOTHING: the live setting stays
# exactly the "false" it is today until an owner decides otherwise.
variable "schedulers_master_enabled" {
  description = <<-EOT
    Master kill switch for all 20 catalogued timers (FEATURE_FLAG_SCHEDULERS).

    False holds every timer off regardless of enabled_timers.
    schedulers.js checks this first and skips the handler before reading the
    per-timer flag, so it is a genuine kill switch and not a default.

    True hands control back to enabled_timers, which is still empty by default
    — so turning this on by itself also arms nothing. Both are required, which
    is the point: the master switch is what an operator flips to stop
    everything during an incident without editing eighteen entries.

    Migration-Plan §6 step 7 arms timers ONE AT A TIME. Set this true first,
    then add timers to enabled_timers one per apply, each observed firing at
    its intended UTC time before the next. (The app sets no WEBSITE_TIME_ZONE,
    so every NCRONTAB hour is a UTC hour — owner decision 2026-09-07, #416.)
  EOT
  type        = bool
  default     = false
}

# The newsletter's send switch (ADR 0030 §2a). Default false, so deploying the
# approval code emails nobody: approving is refused until an owner turns this
# on in a confirmed Terraform run.
variable "newsletter_sending_enabled" {
  description = <<-EOT
    Lets a publisher's approval on the Mailing List page send a weekly issue
    to the Newsletter segment through Resend (NEWSLETTER_SENDING_ENABLED).

    False refuses every approval with 503 NEWSLETTER_SENDING_DISABLED before
    Resend is called; building, previewing, editing and rejecting issues all
    still work. The page says sending is switched off instead of offering
    Approve.

    True is the owner's decision that the send path is ready. Before setting
    it, save the postal address and reply-to in Newsletter settings and confirm
    a test signup reached the Newsletter segment in Resend.
  EOT
  type        = bool
  default     = false
}

# The public lab submission's switch (ADR 0032 decision 6, revised
# 2026-09-28). Default TRUE, because the owner opened the path on that date,
# the same way functions_origin_lock_enabled carries the posture the owner
# chose as its default: the decision is reviewed in the pull request and read
# in the plan, rather than living only as a workspace edit.
#
# True does not open anything on its own. The lab takes a job only when this
# is on, the TURNSTILE-SECRET-KEY vault secret resolves, and a lab agent
# registered for terraform-validate is heartbeating, and each of the three
# fails closed with the builder saying which one is missing. Every POST must
# also come from the site's origin with a Turnstile token Cloudflare passes.
#
# Set false in the hcw-azure workspace to close it in one step: the builder's
# button then says public submission is switched off, and the three routes
# answer PUBLIC_SUBMISSION_CLOSED before reading anything.
variable "labs_public_submission_enabled" {
  description = <<-EOT
    Lets the Landing Zone Builder's "Validate on the lab" queue a public
    terraform-validate job on the lab host (LABS_PUBLIC_SUBMISSION_ENABLED),
    within ADR 0032 decision 6's bounds: 64 KB, 2 an hour per visitor, 50 a
    day, refused while more than 20 jobs are queued or no agent is online.

    Locked to the site's pane: every submission needs the site's Origin and a
    Cloudflare Turnstile token, checked against TURNSTILE-SECRET-KEY in Key
    Vault. Without that secret the path stays closed however this is set.

    False is the kill switch: every public lab route answers
    PUBLIC_SUBMISSION_CLOSED before it reads the body, the caller or the store.
  EOT
  type        = bool
  default     = true
}

variable "enabled_timers" {
  description = <<-EOT
    Timers to arm, by flag suffix — e.g. ["SYNC_RSS_FEEDS"] sets
    FEATURE_FLAG_SYNC_RSS_FEEDS = "true". Everything in
    local.timer_catalogue that is not listed here is set to "false"
    explicitly, so a timer is never merely absent.

    Migration-Plan §6 step 7 turns these on ONE AT A TIME, each observed firing
    once at the intended UTC time before the next is added — the app clock is
    UTC (#416), so a schedule's bare hour is the hour to expect. Set this in
    the HCP Terraform workspace so a cutover flip is a variable edit and an
    apply, not a pull request.

    schedulers_master_enabled above is a separate master kill switch and is
    still false: it holds every timer off regardless of what is listed here, so
    arming the first timer means setting BOTH.
  EOT
  type        = set(string)
  default     = []

  validation {
    # A typo here is indistinguishable from a timer that does not fire, which
    # is the single most expensive way to be wrong during a cutover window.
    condition = alltrue([
      for name in var.enabled_timers : contains([
        "PUBLISH_SCHEDULED_CONTENT", "SYNC_RSS_FEEDS", "FORGE_SCHEDULED",
        "MONITOR_PUBLISHING_PIPELINE", "GENERATE_REVIEWER_DIGEST", "CHECK_LIVE_LINKS",
        "CLEANUP_REJECTED_CONTENT", "CLEANUP_SOFT_DELETED_CONTENT",
        "REVERIFY_CERTIFICATIONS", "SCRAPE_SKILLS_HUB_RSS", "REFRESH_PLAUD_TOKEN",
        "CHECK_AGENT_HEALTH", "FETCH_PODCAST_FEEDS", "FETCH_BLOG_LISTINGS",
        "SYNC_SOCIAL_CALENDAR", "CLEANUP_TEMP_STORAGE", "CLEANUP_UNUSED_CERT_IMAGES",
        "PLATFORM_JOB_SWEEPER", "BUILD_WEEKLY_NEWSLETTER", "REFRESH_TOOL_SERVICE_CACHE",
        "LABS_WEEKLY_ROLLUP", "PROBE_AI_PROVIDERS", "SEND_REMINDERS", "HEALTH_PULSE",
        "LAB_CANARY", "AMBASSADOR_AUDIENCE_MONTHLY", "SWEEP_VISITOR_SESSIONS",
      ], name)
    ])
    error_message = "enabled_timers accepts only flag suffixes from local.timer_catalogue in functionapp.tf, e.g. SYNC_RSS_FEEDS — not the function name, and not the full FEATURE_FLAG_ prefix."
  }
}

variable "cors_extra_origins" {
  description = <<-EOT
    Browser origins allowed to call the API on top of the production allowlist
    compiled into functions/src/lib/auth/cors.js (hybridcloudworks.com and www).

    Needed for Migration-Plan §6 step 2, where the site runs on the Static Web
    App's own *.azurestaticapps.net hostname before DNS moves. That origin is
    not in the compiled list, so without it every API call from the
    parallel-running site fails CORS — which presents as a broken API, not as a
    missing allowlist entry.

    Empty it again once DNS has moved and the preview hostname is no longer
    serving anyone.
  EOT
  type        = list(string)
  default     = []
}

variable "config_generation" {
  description = <<-EOT
    An immutable identifier for the configuration generation this apply writes,
    reported back by the running worker as RUNTIME_CONFIG_GENERATION (T-513).

    ARM can only answer "what was written last". This is how a worker answers
    "what did I actually consume" — the two disagreed on 2026-08-22, when a
    fresh worker held the literal string `[]` for CORS_ALLOWED_ORIGINS while
    ARM held the real value.

    Set it to something that identifies the deployment and cannot repeat, e.g.
    `gh-<run-id>-<short-sha>` or `t513-cli-1` for a hand-run experiment.

    DO NOT wire this to timestamp(). A value that changes on every plan proposes
    a diff forever and restarts the host on every apply, which is both noise and
    a small outage each time.

    The default is deliberately a fixed string rather than anything derived: an
    unset generation must be visibly unset, not quietly plausible.
  EOT
  type        = string
  default     = "unset"
}

variable "bootstrap_admin_oids" {
  description = <<-EOT
    Entra object ids permitted to bootstrap the FIRST admin record
    (CMS_BOOTSTRAP_ALLOWED_UIDS). Consulted only while the `admins` container
    holds no active admin; every later role change requires super_admin.

    Prefer object ids over e-mail addresses. A B2B guest's UPN is not their mail
    address, and which of the two a token carries in `email` or
    `preferred_username` varies — an object id does not.

    It is an escape hatch that closes itself the moment a first admin exists.
    Empty it once the registry is seeded if you would rather it not be there.
  EOT
  type        = list(string)
  default     = []
}

variable "bootstrap_admin_emails" {
  description = <<-EOT
    E-mail addresses permitted to bootstrap the first admin record
    (CMS_BOOTSTRAP_ALLOWED_EMAILS). Matched case-insensitively against the
    token's `email` or `preferred_username`.

    A second chance alongside bootstrap_admin_oids, not a replacement for it.
  EOT
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Hybrid Lab: Azure Arc onboarding (#663, lab-hybrid.tf)
# -----------------------------------------------------------------------------

# The OBJECT id (not the application/client id) of the Arc onboarding service
# principal, sp-arc-onboarding-lab-hybrid-prod-cus. The owner creates it with
# no role as the first step of docs/runbooks/labs-host.md; Terraform then
# grants it Azure Connected Machine Onboarding on rg-lab-hybrid-prod-cus and
# nothing else. Null, the default, plans no grant. The two ids are easy to
# swap and a swapped value fails only at apply, as PrincipalNotFound, so the
# runbook reads the object id with `az ad sp show` rather than taking the
# appId the create command prints.
variable "arc_onboarding_principal_id" {
  description = "Object id of the owner-created Arc onboarding service principal; null until it exists (lab-hybrid.tf, #663)"
  type        = string
  default     = null

  validation {
    condition     = var.arc_onboarding_principal_id == null || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.arc_onboarding_principal_id))
    error_message = "arc_onboarding_principal_id must be a lowercase GUID (the service principal's object id) or null."
  }
}

# Posture switch for the audit-only Linux baseline assignment. Default false
# because the run identity cannot write a policy assignment until the owner
# has granted it Resource Policy Contributor on rg-lab-hybrid-prod-cus (the
# runbook step), and true before that fails the apply with AuthorizationFailed
# on Microsoft.Authorization/policyAssignments/write.
variable "lab_hybrid_policy_enabled" {
  description = "Create the audit-only Linux security baseline policy assignment on rg-lab-hybrid-prod-cus; needs the run identity's Resource Policy Contributor grant first (#663)"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Hybrid Lab: the expected SSH login (#953, LAB-7, lab-hybrid.tf)
# -----------------------------------------------------------------------------
# What alert-lab-ssh-login treats as an expected login: one of these users, by
# public key, with one of these keys. Anything else that sshd accepts pages.
#
# The users are the hardening role's administrative login,
# hardening_admin_user in lab-host/ansible/group_vars/all.yml. The
# fingerprints are those of the keys that role pins in
# hardening_admin_authorized_keys, in OpenSSH's `SHA256:` form (what
# `ssh-keygen -lf <key>.pub` prints and what sshd logs on an accepted login).
# scripts/lab-host-ssh-login-alert.test.mjs holds both lists to the Ansible
# ones, so a key rotated in one place and not the other fails CI rather than
# paging on every login. Public values: a fingerprint identifies a key and
# grants nothing.
variable "lab_ssh_admin_users" {
  description = "Users whose public-key SSH login to the lab host with a pinned key is expected (alert-lab-ssh-login, #953)"
  type        = list(string)
  default     = ["hcwadmin"]

  validation {
    condition     = length(var.lab_ssh_admin_users) > 0
    error_message = "lab_ssh_admin_users must name at least one user: empty, every login to the lab host would page."
  }

  validation {
    condition     = alltrue([for user in var.lab_ssh_admin_users : can(regex("^[a-z_][a-z0-9_-]{0,31}$", user))])
    error_message = "Each lab_ssh_admin_users entry must be a Linux user name: lower case, starting with a letter or underscore, at most 32 characters."
  }
}

variable "lab_ssh_admin_key_fingerprints" {
  description = "SHA256 fingerprints of the public keys pinned for the lab host's administrative login (alert-lab-ssh-login, #953)"
  type        = list(string)
  default     = ["SHA256:VTyaLLQLfYwi38RP1mHDD6Vtu0eSQsa4EPsNJTrdgG8"]

  validation {
    condition     = length(var.lab_ssh_admin_key_fingerprints) > 0
    error_message = "lab_ssh_admin_key_fingerprints must hold at least one fingerprint: empty, every login to the lab host would page."
  }

  validation {
    condition     = alltrue([for fingerprint in var.lab_ssh_admin_key_fingerprints : can(regex("^SHA256:[A-Za-z0-9+/]{43}$", fingerprint))])
    error_message = "Each lab_ssh_admin_key_fingerprints entry must be an OpenSSH SHA256 fingerprint, SHA256: and 43 base64 characters without padding, as `ssh-keygen -lf <key>.pub` prints it."
  }
}

# Whether an expected login must also arrive through Azure Arc SSH, which
# reaches sshd from the host's own loopback address. True since port 22 closed
# to the internet (#953 stage 3; ADR 0032, the 2026-10-16 staging): a login
# from any other address pages even with the pinned key. It was false while
# port 22 was open, until Arc SSH and hPanel's Web Console had both been seen
# working (2026-10-17).
variable "lab_ssh_loopback_only" {
  description = "Page on any SSH login to the lab host that does not arrive from loopback, as Arc SSH does; true since port 22 closed (alert-lab-ssh-login, #953)"
  type        = bool
  default     = true
}

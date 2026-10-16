# =============================================================================
# lab-hybrid.tf — the Azure half of the Hybrid Lab (ADR 0032 decision 3, #664)
# =============================================================================
#
# The lab host itself is a Hostinger VPS, provisioned from the separate
# `hcw-lab` workspace (`infra-lab/`) and onboarded to Azure Arc by Ansible.
# What lives in THIS workspace is only what the production estate needs in
# order to see it:
#
#   - the resource group the Arc machine is onboarded into,
#   - a Reader grant on that group for the Function App's managed identity, so
#     GET /api/public/labs/estate can read the machine's status through Azure
#     Resource Graph (functions/src/lib/labs/estate.js), and, from #663,
#   - the onboarding service principal's only grant, Azure Connected Machine
#     Onboarding on this group,
#   - a data collection rule sending heartbeat and auth/authpriv syslog to the
#     existing Management workspace,
#   - an audit-only machine-configuration assignment of the Linux security
#     baseline on this group, and, from #726,
#   - a lab-only Key Vault holding one key, the seal key HashiCorp Vault on the
#     host unseals itself with, and the Arc machine's grant to wrap and unwrap
#     on that key, and, from #955 (LAB-9, lab-hybrid-backups.tf),
#   - a storage account and immutable container the host ships its nightly
#     Coder dump and Vault raft snapshot to, with the Arc machine's second
#     grant: write and read on that container.
#
# Nothing else. The Arc machine resource is created by `azcmagent connect` on
# the host (lab-host/ansible/roles/arc), under that service principal (ADR
# 0032 decision 3; its credential is an Ansible Vault entry, never a Terraform
# value). Defender for Servers stays off (ADR 0032, alternatives considered):
# nothing here sets a Microsoft.Security pricing tier.
#
# The role assignment is the whole grant. Resource Graph returns only rows the
# caller can read, and Reader is `*/read` — so the identity can describe this
# group's contents and cannot change them, and cannot see any other group it
# was not already granted. No credential is minted or stored for this path:
# the Function App's system identity signs its own token.

# Not an entry in local.app_resource_groups (main.tf): that map names the
# `site` workload's groups, and this is the `hybrid` workload's, so the name
# takes a different middle segment and the ADR fixes it in full —
# rg-lab-hybrid-prod-cus. It is also a lifecycle boundary of its own: deleting
# the lab must never be "delete rg-web", and vice versa.
resource "azurerm_resource_group" "lab_hybrid" {
  name     = "rg-lab-hybrid-${var.environment}-${var.region_abbreviation}"
  location = var.azure_location
  tags     = local.tags
}

# Reader on the lab group only. Scoped to the group rather than the machine
# because the machine does not exist until the host is onboarded, and a grant
# on a resource that Terraform does not manage would have nothing to reference.
resource "azurerm_role_assignment" "func_lab_hybrid_reader" {
  scope                = azurerm_resource_group.lab_hybrid.id
  role_definition_name = "Reader"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

# -----------------------------------------------------------------------------
# Onboarding identity (#663)
# -----------------------------------------------------------------------------
# The service principal is OWNER-CREATED, not declared here, and the grant
# takes its object id as a variable. Two reasons, both structural:
#
#   - infra/ has no azuread provider, and the HCP Terraform run identity is an
#     Azure RBAC principal (Contributor + Role Based Access Control
#     Administrator) with no Entra directory role, the same boundary oidc.tf
#     records for app registrations.
#   - A secret minted by Terraform would sit in state. The credential is used
#     once by `azcmagent connect` from Ansible Vault and then deleted
#     (docs/runbooks/labs-host.md), so it never passes through here.
#
# Null until the owner has created the principal, so the rest of the estate
# keeps planning in the meantime. principal_type is explicit because the
# principal is new when this first applies: without it ARM looks the id up in
# Entra first and can miss a principal that has not replicated yet.
resource "azurerm_role_assignment" "arc_onboarding" {
  count = var.arc_onboarding_principal_id == null ? 0 : 1

  scope                = azurerm_resource_group.lab_hybrid.id
  role_definition_name = "Azure Connected Machine Onboarding"
  principal_id         = var.arc_onboarding_principal_id
  principal_type       = "ServicePrincipal"
}

# -----------------------------------------------------------------------------
# Data collection rule (#663)
# -----------------------------------------------------------------------------
# Heartbeat, auth/authpriv syslog, the four host counters the lab alerts read,
# and the warning-and-above lines of the service facilities, so ingestion
# stays at kilobytes a day against the workspace's daily cap (ADR 0032
# consequences). Until 2026-10-06 the rule carried heartbeat and auth syslog
# only, node_exporter listened on loopback for a scrape that never came, and
# nothing alerted on any lab signal — the estate review's finding LAB-2: the
# visitor learned the agent was offline before the owner did. The three
# rules below this one are what the added streams feed.
#
# Perf: four counters at 60 s is about 6 KB a day. Syslog: the daemon,
# syslog, kern, cron and user facilities at Warning and above only — Caddy's
# renewal errors, Vault's seal errors, the agent's crash lines and the
# failure notifier (`hcw-unit-failed@`, lab-host/ansible/roles/hardening)
# all log there — while auth stays at Info because a login is Info.
#
# Heartbeat has no data source: the Azure Monitor Agent writes a Heartbeat row
# every minute to each Log Analytics destination of every rule associated with
# it. Declaring the workspace as a destination IS the heartbeat.
#
# Levels are Info and above. sshd logs failed and accepted logins at Info, so
# dropping Info would drop the one signal this rule exists for; Debug is the
# only level left out, because it is where a chatty PAM module multiplies
# volume without adding a login event.
#
# The workspace is in the Management subscription and this rule is in the
# application one. A cross-subscription destination is allowed; a
# cross-region one is not, so the rule takes the workspace's own location
# rather than repeating var.azure_location and hoping the two agree.
#
# The association to the machine is NOT here. Its target is the Arc machine's
# resource id, which does not exist until `azcmagent connect` has run, so a
# Terraform association would fail every apply until then. The owner installs
# the Azure Monitor Agent extension and creates the association with the two
# `az` commands in docs/runbooks/labs-host.md once the machine is Connected.
# Both are needed: an association made outside the portal's DCR wizard does
# not install the agent.
resource "azurerm_monitor_data_collection_rule" "lab_hybrid" {
  name                = "dcr-lab-hybrid-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.lab_hybrid.name
  location            = azurerm_log_analytics_workspace.hcw.location
  kind                = "Linux"
  description         = "Lab host (Arc): heartbeat, auth/authpriv syslog, service syslog at Warning+, and four host counters (ADR 0032 decision 3, #663; LAB-2 2026-10-06)"

  destinations {
    log_analytics {
      name                  = "log-plat"
      workspace_resource_id = azurerm_log_analytics_workspace.hcw.id
    }
  }

  data_flow {
    streams      = ["Microsoft-Syslog"]
    destinations = ["log-plat"]
  }

  data_flow {
    streams      = ["Microsoft-Perf"]
    destinations = ["log-plat"]
  }

  data_sources {
    syslog {
      name           = "syslog-auth"
      facility_names = ["auth", "authpriv"]
      log_levels     = ["Info", "Notice", "Warning", "Error", "Critical", "Alert", "Emergency"]
      streams        = ["Microsoft-Syslog"]
    }

    syslog {
      name           = "syslog-services"
      facility_names = ["daemon", "syslog", "kern", "cron", "user"]
      log_levels     = ["Warning", "Error", "Critical", "Alert", "Emergency"]
      streams        = ["Microsoft-Syslog"]
    }

    performance_counter {
      name                          = "perf-host"
      sampling_frequency_in_seconds = 60
      streams                       = ["Microsoft-Perf"]
      counter_specifiers = [
        "Processor(*)\\% Processor Time",
        "Memory(*)\\% Used Memory",
        "Logical Disk(*)\\% Used Space",
        "Logical Disk(*)\\Free Megabytes",
      ]
    }
  }

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Machine configuration, audit only (#663)
# -----------------------------------------------------------------------------
# The built-in "Linux machines should meet requirements for the Azure compute
# security baseline" (fc9b3da7-8347-4380-8e70-0a0361d8dedd, v2.3.1 when this
# was written). Resource-group scope, never subscription: the IaC repository
# standard forbids a workload repository assigning subscription-level policy.
#
# Two parameters are load-bearing:
#   - IncludeArcMachines defaults to "false", and this group holds nothing BUT
#     an Arc machine. Left at its default the assignment would evaluate zero
#     resources and read as compliant forever.
#   - effect is AuditIfNotExists, the definition's only value besides
#     Disabled. It never changes the host. The machine-configuration service
#     creates the guest assignment from the definition's guestConfiguration
#     metadata by itself, so there is no DeployIfNotExists prerequisite and no
#     managed identity; the Connected Machine agent has the
#     machine-configuration agent built in.
#
# Gated by lab_hybrid_policy_enabled because this is the first policy
# assignment infra/ owns, and the run identity cannot write one: Contributor's
# NotActions exclude Microsoft.Authorization/*/Write, and Role Based Access
# Control Administrator writes role assignments only. The owner grants
# Resource Policy Contributor on this group (docs/runbooks/labs-host.md) and
# then sets the switch. Terraform does not grant that role to itself: an
# identity widening its own rights inside the plan it runs under is the
# escalation scripts/bootstrap-terraform-oidc.ps1's role split exists to
# prevent.
resource "azurerm_resource_group_policy_assignment" "lab_hybrid_linux_baseline" {
  count = var.lab_hybrid_policy_enabled ? 1 : 0

  name                 = "audit-linux-baseline-lab-hybrid"
  display_name         = "Lab host: Linux security baseline (audit only)"
  description          = "Audits the Arc-enabled lab host against the Azure compute security baseline for Linux. Audit only; changes nothing on the host (ADR 0032 decision 3, #663)."
  resource_group_id    = azurerm_resource_group.lab_hybrid.id
  policy_definition_id = "/providers/Microsoft.Authorization/policyDefinitions/fc9b3da7-8347-4380-8e70-0a0361d8dedd"

  parameters = jsonencode({
    IncludeArcMachines = { value = "true" }
    effect             = { value = "AuditIfNotExists" }
  })
}

# -----------------------------------------------------------------------------
# Vault auto-unseal: a lab-only Key Vault, one key, one grant (#726)
# -----------------------------------------------------------------------------
# HashiCorp Vault on the lab host seals itself on every restart. With a
# `seal "azurekeyvault"` stanza it unseals itself instead, by asking this key to
# unwrap its root key. It authenticates as the Arc machine's system-assigned
# identity through the agent's local endpoint, so nothing is stored on the
# host for it (ADR 0032, amendment of 2026-09-29, which records how that was
# verified against Vault 2.1.1's source).
#
# Three boundaries, each one load-bearing:
#
#   - A vault of its own, never kv-site-prod-cus-01. The host runs learner
#     workloads and an escape is root, which can use the Arc identity. So the
#     identity must reach nothing but this key.
#   - One key, created through Resource Manager rather than the Key Vault data
#     plane, so the Terraform run identity needs no data-plane role on any
#     vault (the doctrine that removed terraform_kv_secrets from keyvault.tf,
#     T-748). Creating a key this way needs only the
#     Microsoft.KeyVault/vaults/keys/write action, which Contributor carries.
#   - The grant is scoped to that one key, not the vault, and is the narrowest
#     built-in role covering what Vault calls: read the key, wrap, unwrap.

# The vault. Standard tier: the key is software-protected, and Standard charges
# nothing a month for either, only per operation (Azure Retail Prices API,
# Central US, read 2026-09-29: "Operations" $0.03 and "Advanced Key Operations"
# $0.15 per 10,000). The name is 24 characters, the Key Vault maximum: the
# pattern's kv-lab-hybrid-prod-cus-01 is 25, so the workload token loses its
# hyphen (docs/standards/naming-convention.md, "Constraints that override the
# pattern": the limit wins).
#
# The network stays open (default Allow) on purpose. The only caller is Vault
# on a VPS whose public address belongs to the hcw-lab workspace, and nothing
# in infra/ reads hcw-lab (ADR 0032 decision 1). An IP rule would copy that
# address here, and if the two ever disagreed Vault could not unseal: its
# recovery keys cannot unseal it, only this key can. Every call is still
# authenticated by Entra ID and authorised by the one key-scoped grant below,
# and every unwrap is logged with the caller's address by the diagnostic
# setting at the end of this section.
#
# Purge protection and prevent_destroy, because losing this key loses the
# Vault: HashiCorp's seal documentation says a Vault whose seal key is
# permanently deleted "cannot be recovered, even from backups". Purge
# protection is one-way: a deleted vault then stays soft-deleted, with its
# name reserved, for the 90 days below.
#trivy:ignore:AVD-AZU-0013
resource "azurerm_key_vault" "lab_hybrid" {
  #checkov:skip=CKV_AZURE_109:Default Allow on purpose: the only caller is the lab VPS, whose address infra/ does not own, and an IP rule that drifted would leave Vault unable to unseal. Entra ID plus one key-scoped grant gate every call. ADR 0032 amendment 2026-09-29. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_189:Public network access stays on for the reason given for CKV_AZURE_109: the lab VPS is outside Azure and has no private path. ADR 0032 amendment 2026-09-29. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_32:No private endpoints, owner decision 2026-09-14 (ADR 0031); the caller is a VPS outside Azure, which a private endpoint could not serve. docs/security/scanner-triage.md#checkov
  name                       = "kv-labhybrid-${var.environment}-${var.region_abbreviation}-01"
  location                   = azurerm_resource_group.lab_hybrid.location
  resource_group_name        = azurerm_resource_group.lab_hybrid.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 90
  purge_protection_enabled   = true
  rbac_authorization_enabled = true

  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = local.tags
}

# The seal key: RSA 3072, software-protected, usable for wrapKey and unwrapKey
# and nothing else, which is all Vault's azurekeyvault seal calls (it wraps its
# data key with RSA-OAEP-256). 3072 rather than 2048 because this key has no
# planned end of life and NIST SP 800-57 Part 1 does not accept 2048-bit RSA
# for new protection past 2030. Advanced key types cost $0.15 per 10,000
# operations against $0.03: Vault's seal health check wraps and unwraps once
# every 10 minutes while unsealed, about 8,800 operations a month, so about
# $0.13 a month rather than $0.03.
#
# Created through Resource Manager, which only ever CREATES a key. Microsoft's
# key quickstart: "It isn't possible to update existing keys, nor create new
# versions of existing keys. If the key already exists, then the existing key
# is retrieved from storage and used (no write operations will occur)." So a
# change to `body` could never be applied, and ignore_changes makes Terraform
# agree with that rather than show a diff forever. A different key is a new
# key with a new name, and a seal migration to it
# (lab-host/ansible/roles/vault/README.md). No tags, for the same reason.
#
# Resource Manager has no DELETE for a key either, and deleting this one would
# lose the Vault, so prevent_destroy makes Terraform refuse outright.
resource "azapi_resource" "lab_hybrid_vault_seal_key" {
  type      = "Microsoft.KeyVault/vaults/keys@2024-11-01"
  name      = "vault-seal"
  parent_id = azurerm_key_vault.lab_hybrid.id

  body = {
    properties = {
      kty     = "RSA"
      keySize = 3072
      keyOps  = ["wrapKey", "unwrapKey"]
    }
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [body]
  }
}

# The Arc machine, read rather than managed: `azcmagent connect` creates it and
# a disconnect deletes it (the note on the data collection rule above).
# ignore_not_found keeps every hcw-azure plan working while it does not exist,
# on a rebuilt host before onboarding, say, and the grant below then plans to
# nothing. The id is built from values known at plan time
# (data.azurerm_client_config rather than the sensitive var.subscription_app,
# and the group's name rather than its id), so the read happens during the
# plan and the grant's count is known there, even on an estate where the
# resource group does not exist yet.
#
# A rebuilt host is a new Arc machine with a new identity, so the next apply
# replaces the grant with one for the new principal, and removes it while the
# machine is gone. The name is the arc role's arc_resource_name
# (lab-host/ansible/group_vars/all.yml); scripts/lab-host-vault-seal.test.mjs
# holds the two together.
data "azapi_resource" "lab_hybrid_arc_machine" {
  type             = "Microsoft.HybridCompute/machines@2024-07-10"
  resource_id      = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/rg-lab-hybrid-${var.environment}-${var.region_abbreviation}/providers/Microsoft.HybridCompute/machines/arcs-lab-hybrid-${var.environment}-${var.region_abbreviation}-01"
  ignore_not_found = true
}

locals {
  # The machine's system-assigned identity, or "" while there is no machine.
  lab_hybrid_arc_principal_id = try(coalesce(data.azapi_resource.lab_hybrid_arc_machine.identity[0].principal_id, ""), "")
}

# The Arc identity's only grant: Key Vault Crypto Service Encryption User
# (e147488a-f6f5-4113-8e2d-b22465e65bf6), whose data actions are exactly
# keys/read, keys/wrap/action and keys/unwrap/action. Key Vault Crypto User
# would add sign, verify, encrypt, decrypt, update and backup, none of which
# Vault calls. The role also carries three Microsoft.EventGrid
# eventSubscriptions actions, which reach nothing at a key's scope: Key Vault
# publishes its events at the vault. Scoped to the key's Resource Manager id,
# so a second key added to this vault later is out of reach.
#
# Microsoft recommends vault-scope grants and one vault per application. This
# is one vault holding one key for one caller, and the key scope keeps it that
# way if a second key is ever added. principal_type is explicit for the reason
# given on arc_onboarding above.
#
# The Terraform run identity can make this assignment: it holds Role Based
# Access Control Administrator on the subscription with no ABAC condition
# (scripts/bootstrap-terraform-oidc.ps1, step 5). It grants itself nothing
# here.
resource "azurerm_role_assignment" "lab_hybrid_vault_seal" {
  count = local.lab_hybrid_arc_principal_id == "" ? 0 : 1

  scope                = azapi_resource.lab_hybrid_vault_seal_key.id
  role_definition_name = "Key Vault Crypto Service Encryption User"
  principal_id         = local.lab_hybrid_arc_principal_id
  principal_type       = "ServicePrincipal"
}

# Who touched the seal key, and from where. AuditEvent records every data-plane
# call with the caller's identity and IP address, so an unwrap from anywhere
# but the lab host shows up as a row, which is the check the open network above
# relies on. About 300 rows a day from the 10-minute health check, well under
# a megabyte a day against the workspace's 0.25 GB/day cap. Logs only, as on
# the Cosmos and content-queue settings in observability.tf: the vault's
# metrics would add rows and answer nothing the audit log does not.
resource "azurerm_monitor_diagnostic_setting" "lab_hybrid_key_vault" {
  name                       = "diag-kv-to-logs"
  target_resource_id         = azurerm_key_vault.lab_hybrid.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id

  enabled_log {
    category = "AuditEvent"
  }
}

# -----------------------------------------------------------------------------
# Lab alerts (LAB-2, estate review 2026-10-06)
# -----------------------------------------------------------------------------
# Three rules, all against the Management workspace the DCR above writes to,
# so they take the Management provider, resource group and alerts identity the
# way `logs_daily_cap` in observability.tf does. They route to the same action
# group as every production rule: a lab that goes dark is the owner's problem
# before it is a visitor's.
#
#   - heartbeat_missing: the Arc machine has not written a Heartbeat row in
#     30 minutes. The agent writes one a minute, so this is the host down, the
#     agent stopped, or the egress path to Azure gone. Stateful: one alert
#     until it resolves.
#   - disk_used: the root filesystem is past 85%. Docker images, Coder
#     workspaces and seven days of pg_dumps all live there, and a full disk
#     breaks Coder, Vault's raft store and job staging without a crash.
#     Stateful since 2026-10-16: one alert, resolved once the disk is back
#     under 85%. It muted for six hours instead, which mailed four times a day
#     while the disk stayed full and left every alert open after it was
#     pruned (ADR 0022 decision 6).
#   - unit_failed: `hcw-unit-failed@` logged a failure for a unit it watches
#     (the Coder backup, the labs agent, Caddy, Vault). The notifier writes one
#     line at daemon.err; the DCR ships daemon at Warning and above. Stateless
#     and muted for six hours, deliberately: the line is an event, not a state.
#     A stateful form would report Resolved once the line left the hour's
#     window, whether or not the unit came back.
#
# verify-alert-state.yml derives its list from these declarations since PLAT-4
# (#964), so these three are in it. Its identity since #1053,
# github_alert_reader, holds HCW Alert Rule Reader on platform_mgmt, where
# these rules live, so it reads them like the application's rules.
locals {
  lab_hybrid_machine_name = "arcs-lab-hybrid-${var.environment}-${var.region_abbreviation}-01"
  # How the three rules below find the host's rows. NOT `Computer ==
  # <arc name>`: for an Arc machine the Heartbeat, Perf and Syslog tables
  # carry the OS hostname in `Computer`, and the Arc resource name appears
  # only in `_ResourceId`. The first version of these rules matched on
  # `Computer` and alert-lab-heartbeat fired at its first evaluation after
  # the apply (2026-10-06), with the host up and heartbeating. `_ResourceId`
  # is lower-cased by the platform; the suffix compare is case-insensitive.
  lab_hybrid_host_rows = "where tolower(_ResourceId) endswith \"/providers/microsoft.hybridcompute/machines/${lower(local.lab_hybrid_machine_name)}\""
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_heartbeat_missing" {
  provider = azurerm.mgmt

  name                = "alert-lab-heartbeat-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "The lab host's Arc agent has written no Heartbeat row for 30 minutes: the host is down, the Azure Monitor Agent is stopped, or the host cannot reach Azure. Public lab submission fails closed meanwhile. Stateful. ADR 0032, LAB-2."
  severity            = 1

  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"

  auto_mitigation_enabled = true

  criteria {
    query                   = "Heartbeat | ${local.lab_hybrid_host_rows}"
    time_aggregation_method = "Count"
    operator                = "LessThan"
    threshold               = 1

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.alerts_mgmt.id]
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.alerts_mgmt_workspace]
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_disk_used" {
  provider = azurerm.mgmt

  name                = "alert-lab-disk-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "The lab host's root filesystem is past 85% used. Docker images, Coder workspaces, Vault's raft store and the pg_dumps share it; a full disk breaks them without a crash. Prune images or old dumps. Stateful: resolves once the disk is back under 85%. LAB-2."
  severity            = 2

  evaluation_frequency = "PT1H"
  window_duration      = "PT1H"

  # One alert per episode, resolved two clear evaluations after the prune.
  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      Perf
      | ${local.lab_hybrid_host_rows}
      | where ObjectName == "Logical Disk" and CounterName == "% Used Space" and InstanceName == "/"
      | summarize UsedPct = max(CounterValue)
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "UsedPct"
    operator                = "GreaterThan"
    threshold               = 85

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.alerts_mgmt.id]
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.alerts_mgmt_workspace]
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_unit_failed" {
  provider = azurerm.mgmt

  name                = "alert-lab-unit-failed-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "A watched systemd unit on the lab host entered the failed state: the nightly Coder backup, the labs agent, Caddy or Vault. The line names the unit. LAB-2."
  severity            = 2

  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  mute_actions_after_alert_duration = "PT6H"

  criteria {
    query                   = "Syslog | ${local.lab_hybrid_host_rows} | where ProcessName == \"hcw-unit-failed\""
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.alerts_mgmt.id]
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.alerts_mgmt_workspace]
}

# -----------------------------------------------------------------------------
# Lab security alerts (PLAT-4, estate review 2026-10-06)
# -----------------------------------------------------------------------------
# Two rules on signals this file already ships to the Management workspace and
# nothing paged on: the seal key's audit rows (the diagnostic setting above)
# and the auth syslog (the data collection rule). Same provider, resource
# group, identity and host predicate as the three LAB-2 rules above.

# The seal key used from anywhere but the host. The vault's network stays
# open on purpose (the note on azurerm_key_vault.lab_hybrid), and the comment
# there names the audit row's caller address as "the check the open network
# relies on". This is that check.
#
# THE HOST'S ADDRESS IS READ FROM ITS OWN HEARTBEAT, not written here.
# infra/ does not read the hcw-lab workspace that owns the VPS (ADR 0032
# decision 1), so no address can be copied in, and a copied one would drift.
# Heartbeat.ComputerIP is the public address the Azure Monitor Agent reaches
# Azure from, and Vault on the same host reaches Key Vault from the same one.
# When the host has written no heartbeat in the window, the list is empty and
# every wrap or unwrap pages, which is right: no live host, no legitimate
# caller.
#
# ASSUMPTION, recorded because the first fire test settles it: the agent and
# Vault leave the host by the same address family. If the host's Heartbeat
# rows carry an IPv6 address while Vault calls over IPv4 (or the reverse),
# this pages on Vault's own 10-minute health check, at once and every
# evaluation; the runbook's fire test is also the check for that.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_vault_unwrap" {
  provider = azurerm.mgmt

  name                = "alert-lab-vault-unwrap-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "The lab vault's seal key was asked to wrap or unwrap from an address the lab host has not heartbeated from in the last hour. Vault's identity is in use off the host, or the host's address changed. PLAT-4."
  severity            = 1

  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      let HostAddresses = Heartbeat
        | ${local.lab_hybrid_host_rows}
        | distinct ComputerIP;
      AzureDiagnostics
      | where ResourceProvider == "MICROSOFT.KEYVAULT"
      | where tolower(_ResourceId) == "${lower(azurerm_key_vault.lab_hybrid.id)}"
      | where OperationName in ("KeyUnwrap", "KeyWrap")
      | where CallerIPAddress !in (HostAddresses)
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.alerts_mgmt.id]
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.alerts_mgmt_workspace]
}

# A burst of failed SSH logins. Port 22 is open to the internet (the hardening
# role's ufw allowlist) with keys only and fail2ban banning a source after
# five failures in ten minutes, so a steady trickle of failures is the
# internet's background, not an incident. A BURST is: the last 15 minutes
# hold more than four times the average quarter-hour of the 23 hours 45
# minutes before them, and at least 50 lines. A relative threshold, because
# the background has never been measured here and a fixed number would be a
# guess; the floor keeps a quiet day's handful from tripping it.
#
# The lines counted are sshd's own (`sshd`, and `sshd-session`, the
# per-connection process OpenSSH 9.8 split out): an invalid user, a known
# user that failed to authenticate, and any "Failed …" method. One failed
# connection can write two of them; the ratio does not care, the floor does,
# and 50 lines is at most 50 attempts.
#
# summarize with no `by` always returns one row, so Burst is always exactly
# one value, 0 or 1 — the same construction as alert-cosmos-export-full.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_ssh_burst" {
  provider = azurerm.mgmt

  name                = "alert-lab-ssh-burst-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "Failed SSH logins on the lab host in the last 15 minutes are more than four times the day's quarter-hour average, and at least 50. A distributed attempt fail2ban's per-source ban does not stop, or a broken key. PLAT-4."
  severity            = 2

  evaluation_frequency = "PT15M"
  window_duration      = "P1D"

  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      Syslog
      | ${local.lab_hybrid_host_rows}
      | where Facility in ("auth", "authpriv")
      | where ProcessName startswith "sshd"
      | where SyslogMessage contains "invalid user" or SyslogMessage contains "authenticating user" or SyslogMessage startswith "Failed "
      | summarize Recent = countif(TimeGenerated > ago(15m)), Earlier = countif(TimeGenerated <= ago(15m))
      | project Burst = iff(Recent >= 50 and Recent > 4.0 * Earlier / 95, 1, 0)
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "Burst"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.alerts_mgmt.id]
  }

  tags = local.tags

  depends_on = [azurerm_role_assignment.alerts_mgmt_workspace]
}

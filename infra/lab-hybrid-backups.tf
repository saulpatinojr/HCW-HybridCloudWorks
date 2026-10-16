# =============================================================================
# lab-hybrid-backups.tf — where the lab host's backups go (LAB-9, #955)
# =============================================================================
#
# ADR 0032, amendment of 2026-10-14. The lab host (lab-hybrid.tf says what
# this workspace owns of it) kept its only backups on its own disk: seven days
# of Coder PostgreSQL dumps under /var/backups/coder, and nothing of Vault's
# raft store. A reinstall wipes the disk (docs/runbooks/labs-host.md,
# "Reinstalling the host"), so a destroyed host lost the Coder database and
# the Vault with it. Owner decision 2026-10-14, choosing this over the VPS
# provider's object storage and over local-only: the host ships its nightly
# dump and a nightly raft snapshot here, with the one identity it already has
# in Azure — the Arc machine's system-assigned identity, which Vault's seal
# signs in with (lab-hybrid.tf, azurerm_role_assignment.lab_hybrid_vault_seal).
#
# What is here, and why each choice:
#
#   - One StorageV2 account, Standard GRS. GRS because the point is a copy off
#     the VPS and off its region; the data is a few megabytes a night, so the
#     paired-region copy costs cents. Cool tier: written once, read at a
#     restore. Entra-only: shared keys off, OAuth the default, so the only
#     principal that can write is the one granted below, and there is no key
#     to leak. The public endpoint stays reachable for the same reason the lab
#     Key Vault's does: the writer is a VPS outside Azure with no private
#     path, and Entra plus one container-scoped grant gate every call.
#   - One container, host-backups, with a time-based immutability policy of
#     35 days. The host's identity can write a new blob and cannot delete or
#     overwrite one inside that window — a host that is compromised, and can
#     therefore write backups, cannot destroy them. Unlocked, so the owner can
#     shorten or remove it from the portal; locking would make the retention
#     irreversible, which this data does not warrant.
#   - Versioning and 35-day soft delete on blobs and on the container, the
#     second line behind the policy.
#   - The Arc identity's second grant: Storage Blob Data Contributor on the
#     container only (write a blob; list and read, which the restore needs).
#     Contributor rather than a write-only custom role because the restore
#     helper lists and downloads with the same identity, and the policy above,
#     not the role, is what denies deletion.
#   - Blob write, delete and read logs to the Management workspace, and one
#     alert per backup kind when no blob was written for a kind in two days.
#     A missing backup is a row in the action group, not a silence.
#
# The host side (lab-host/ansible: the upload helper, the raft snapshot timer,
# the restore helper) reads the account name from the output below, copied
# into lab-host/ansible/group_vars/all.yml by the pull request that adds it.
# Nothing here holds a credential: the host mints its own token through the
# Arc agent, as it does for the seal key.

# Account name: 3–24 lowercase alphanumerics, globally unique. stlabhybrid +
# environment + region is 20 characters for prod/cus.
#
# trivy AVD-AZU-0012 (network default Allow, no rules) is accepted on this
# account for the reason the lab Key Vault accepts AVD-AZU-0013: the writer
# is a VPS outside Azure whose address infra/ does not own, Entra-only auth
# and a container-scoped grant gate every call, and an IP rule that drifted
# would stop the nightly backup silently. docs/security/scanner-triage.md,
# "trivy". The ignore must be the line directly above the resource.
#trivy:ignore:AVD-AZU-0012
resource "azurerm_storage_account" "lab_hybrid_backups" {
  #checkov:skip=CKV_AZURE_59:Public network access stays on: the only writer is the lab VPS, outside Azure with no private path, the same reason given for the lab Key Vault (CKV_AZURE_109 there). Entra-only auth and one container-scoped grant gate every call. ADR 0032 amendment 2026-10-14. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_33:No private endpoints: the caller is a VPS outside Azure, which a private endpoint could not serve (ADR 0031 decision, ADR 0032 amendment 2026-10-14). docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys, owner decision 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_35:Default network action stays Allow for the reason given on CKV_AZURE_59: the writer's address is not owned by infra/ and a drifted IP rule would stop the nightly backup silently. ADR 0032 amendment 2026-10-14. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_33:No queues in this account; blob read/write/delete logs go to Log Analytics via azurerm_monitor_diagnostic_setting.lab_hybrid_backups_blob. docs/security/scanner-triage.md#checkov
  name                             = "stlabhybrid${var.environment}${var.region_abbreviation}01"
  resource_group_name              = azurerm_resource_group.lab_hybrid.name
  location                         = azurerm_resource_group.lab_hybrid.location
  account_tier                     = "Standard"
  account_replication_type         = "GRS"
  account_kind                     = "StorageV2"
  access_tier                      = "Cool"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  allow_nested_items_to_be_public  = false
  cross_tenant_replication_enabled = false

  # Entra only. The host signs in as the Arc machine; nothing holds a key.
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 35
    }

    container_delete_retention_policy {
      days = 35
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = local.tags
}

resource "azurerm_storage_container" "lab_hybrid_backups" {
  #checkov:skip=CKV2_AZURE_21:Blob read, write and delete logging is on for this account via azurerm_monitor_diagnostic_setting.lab_hybrid_backups_blob. docs/security/scanner-triage.md#checkov
  name                  = "host-backups"
  storage_account_id    = azurerm_storage_account.lab_hybrid_backups.id
  container_access_type = "private"

  # The account's guard does not reach its children: a plan that dropped or
  # replaced this container would take every backup with it.
  lifecycle {
    prevent_destroy = true
  }
}

# Time-based retention: a blob cannot be deleted or overwritten for 35 days
# after it is written, whoever asks. Unlocked (see the header); the owner
# changes it in the portal, never the host.
resource "azurerm_storage_container_immutability_policy" "lab_hybrid_backups" {
  storage_container_resource_manager_id = azurerm_storage_container.lab_hybrid_backups.id
  immutability_period_in_days           = 35
  locked                                = false
  protected_append_writes_enabled       = false
  protected_append_writes_all_enabled   = false

  # Removing the policy would make every backup deletable again; the owner
  # changes it in the portal, Terraform refuses to drop it.
  lifecycle {
    prevent_destroy = true
  }
}

# The Arc identity's second grant (the first is wrap/unwrap on the seal key,
# lab-hybrid.tf). Container scope, so the identity sees this container and
# nothing else in the account. Storage Blob Data Contributor
# (ba92f5b4-2d11-453d-a403-e96b0029c9fe): read, write, delete and list blobs
# — the delete the immutability policy above refuses inside its window, and
# the read and list the restore helper needs. principal_type explicit for the
# reason given on arc_onboarding in lab-hybrid.tf. Zero instances until the
# machine exists, like the seal grant.
resource "azurerm_role_assignment" "lab_hybrid_backups_writer" {
  count = local.lab_hybrid_arc_principal_id == "" ? 0 : 1

  scope                = azurerm_storage_container.lab_hybrid_backups.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = local.lab_hybrid_arc_principal_id
  principal_type       = "ServicePrincipal"
}

# Every blob operation, with the caller and its address, to the Management
# workspace: the alerts below read the writes, and a delete or a read from
# anywhere but the host is a row to look at. One blob a night per kind, so
# the volume is nothing against the workspace's daily cap.
resource "azurerm_monitor_diagnostic_setting" "lab_hybrid_backups_blob" {
  name                       = "diag-blob-to-logs"
  target_resource_id         = "${azurerm_storage_account.lab_hybrid_backups.id}/blobServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id
  # Resource-specific tables, so the rows land in StorageBlobLogs — the table
  # the two alerts below query — and not in AzureDiagnostics (the site's
  # content_blob setting in observability.tf makes the same choice).
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }

  enabled_log {
    category = "StorageRead"
  }
}

# No backup written for a kind in two days. The host writes one blob a night
# per kind under host-backups/<kind>/ (03:30 UTC plus up to ten minutes of
# jitter, the Coder backup timer's schedule); a 24-hour window would sit on
# that edge at every 03:3x evaluation, so the window is two days and a missed
# night pages within the next. Same provider, resource group, identity and
# action group as the LAB-2 rules in lab-hybrid.tf; verify-alert-state.yml
# derives its list from these declarations, which is why the two kinds are
# two resources rather than a for_each: scripts/lib/alert-declarations.mjs
# resolves a rule's name from var.* references only.
#
# Stateful since 2026-10-16 (ADR 0022 decision 6). They muted for a day
# instead, which is what the rows of the stateless form looked like: from
# their create on 2026-10-14 the Coder rule opened 22 alerts, one an hour,
# before the first dump landed, and none of them closed when it did. Stateful,
# a missed night is one alert, and it resolves two clear evaluations after the
# next backup lands.
locals {
  lab_hybrid_backup_blob_logs = "StorageBlobLogs | where AccountName == \"${azurerm_storage_account.lab_hybrid_backups.name}\" | where OperationName in (\"PutBlob\", \"PutBlockList\") | where StatusText == \"Success\""
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_backup_missing_coder" {
  provider = azurerm.mgmt

  name                = "alert-lab-backup-missing-coder-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "The lab host wrote no Coder PostgreSQL dump to ${azurerm_storage_account.lab_hybrid_backups.name}/host-backups/coder/ in two days. The nightly unit is failing or the host is not uploading; `sudo systemctl status coder-postgres-backup` and `sudo journalctl -t hcw-backup-upload` on the host say which. Stateful: resolves once a dump lands. LAB-9."
  severity            = 2

  evaluation_frequency = "PT1H"
  window_duration      = "P2D"

  auto_mitigation_enabled = true

  criteria {
    query                   = "${local.lab_hybrid_backup_blob_logs} | where ObjectKey startswith \"/${azurerm_storage_account.lab_hybrid_backups.name}/host-backups/coder/\""
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

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_backup_missing_vault" {
  provider = azurerm.mgmt

  name                = "alert-lab-backup-missing-vault-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "The lab host wrote no Vault raft snapshot to ${azurerm_storage_account.lab_hybrid_backups.name}/host-backups/vault/ in two days. The nightly unit is failing or the host is not uploading; `sudo systemctl status hcw-vault-backup` and `sudo journalctl -t hcw-backup-upload` on the host say which. Stateful: resolves once a snapshot lands. LAB-9."
  severity            = 2

  evaluation_frequency = "PT1H"
  window_duration      = "P2D"

  auto_mitigation_enabled = true

  criteria {
    query                   = "${local.lab_hybrid_backup_blob_logs} | where ObjectKey startswith \"/${azurerm_storage_account.lab_hybrid_backups.name}/host-backups/vault/\""
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

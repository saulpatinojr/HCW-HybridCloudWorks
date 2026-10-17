# =============================================================================
# main.tf — HCW Azure Infrastructure
#
# Manages:
#   - Resource Group
#   - Azure Static Web App (frontend hosting)
#   - Cosmos DB Serverless (website data)
#   - Azure Storage Account + containers (content and media)
#   - Azure Function App on Consumption plan (API and workers)
#   - Azure Key Vault (runtime secrets)
#   - Application Insights + Log Analytics (observability)
#   - Budget alerts (replaces GCP billing export + budget)
#   - Cloudflare DNS records for Azure services
#
# NOTE: User authentication is implemented by Microsoft Entra ID in the
# application. This module manages Azure resources and does not provision the
# Entra app registrations or app roles.
# =============================================================================

data "azurerm_client_config" "current" {}

# =============================================================================
# Resource Group
# =============================================================================
# Resource groups are the lifecycle and RBAC boundary, and each one names the
# Azure service category it groups (Naming-Convention wiki page). The split is
# drawn on destroy semantics, not on inventory: `web` is redeployable, and
# everything carrying prevent_destroy is kept out of it, because a group is
# what someone deletes when they mean "remove the app" and lifecycle
# protection on one resource must not block routine work on another.
locals {
  # segment => what lives there, for the reader. The key is the name segment.
  app_resource_groups = {
    web  = "Static Web App, Function App, plan, Application Insights, and the Functions host storage account, which is recreated with the app"
    db   = "Cosmos account, database and containers — prevent_destroy"
    stor = "Content storage account and its blob containers — prevent_destroy"
    sec  = "Key Vault — prevent_destroy"
    conn = "Spoke virtual network and the Functions integration subnet"
    # Back since #849 (2026-10-04) for the Microsoft Foundry account and its
    # budget. The earlier `ai` group held the Azure OpenAI account removed
    # when AI moved to external provider APIs; this one holds exactly the
    # account foundry.tf declares, and nothing unrelated goes in it.
    ai = "Microsoft Foundry account, its deployments and its budget (foundry.tf)"
  }
}

resource "azurerm_resource_group" "app" {
  for_each = local.app_resource_groups

  name     = "rg-${each.key}-${var.workload_name}-${var.environment}-${var.region_abbreviation}"
  location = var.azure_location
  tags     = local.tags
}

# Platform Management. Holds the central Log Analytics workspace every other
# subscription ships diagnostics to, and the action group those alerts route
# through — both platform concerns rather than workload ones, which is why
# they sit outside the application subscription entirely.
resource "azurerm_resource_group" "platform_mgmt" {
  provider = azurerm.mgmt

  name     = "rg-mgmt-plat-${var.environment}-${var.region_abbreviation}"
  location = var.azure_location
  tags     = local.tags
}

# =============================================================================
# Log Analytics Workspace (required by Application Insights)
# =============================================================================
resource "azurerm_log_analytics_workspace" "hcw" {
  # Same subscription as the resource group it lives in. resource_group_name
  # is only a string — the provider's subscription decides where the ARM call
  # goes, and without this alias the workspace lands in the application
  # subscription, where rg-mgmt-plat does not exist.
  provider = azurerm.mgmt

  name                = "log-plat-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.platform_mgmt.location
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  sku                 = "PerGB2018"
  retention_in_days   = var.logs_retention_in_days
  # T-505: the plan's telemetry cost ceiling. When the cap trips, ingestion
  # stops until the daily reset — Cosmos DataPlaneRequests (observability.tf)
  # is the likeliest culprit; prune that category before raising the cap.
  #
  # A workspace variable since 2026-08-31 (T-719): the measurement that would
  # tell anyone whether the margin is safe cannot be taken while the cap is
  # truncating the number. variables.tf carries the procedure and the reason
  # -1 is refused.
  daily_quota_gb = var.logs_daily_quota_gb
  tags           = local.tags
}

# =============================================================================
# Application Insights and Log Analytics observability
# =============================================================================
resource "azurerm_application_insights" "hcw" {
  name                = "appi-${var.workload_name}-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  workspace_id        = azurerm_log_analytics_workspace.hcw.id
  application_type    = "Node.JS"
  tags                = local.tags
}

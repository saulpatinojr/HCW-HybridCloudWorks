# ---------------------------------------------------------------------------
# Microsoft Foundry: a paid AI provider under its own budget (#849).
#
# Owner decision 2026-10-04: of about USD 75 a month, the first call is Foundry
# as a paid provider for the content features, with the cheapest text models.
# Prices read that day, per 1M tokens, Global Standard: gpt-5-nano $0.05 in /
# $0.40 out, gpt-5-mini $0.25 / $2.00. At the site's volume that is single
# dollars a month; the budget below alerts at its thresholds. It does not
# stop spend: nothing in Azure Cost Management does.
#
# NO KEY. The Function App reaches the account with its system-assigned
# identity and the "Cognitive Services OpenAI User" role: the router asks
# @azure/identity for a token for https://ai.azure.com (the audience the
# Foundry v1 endpoint documents; FOUNDRY_TOKEN_SCOPE overrides it) and
# sends it as the bearer. `local_auth_enabled = false` means the account has
# no API keys to seed, rotate, or leak, and nothing here needs a Key Vault
# window. The app setting the router keys availability on is the ENDPOINT
# (FOUNDRY_ENDPOINT), which Terraform sets from the account.
#
# The `ai` resource group returns for this: main.tf records that the old one
# held the Azure OpenAI account removed when AI moved to external provider
# APIs. It holds exactly this account and its budget.
# ---------------------------------------------------------------------------

resource "azurerm_cognitive_account" "foundry" {
  #checkov:skip=CKV_AZURE_134:Public endpoint, Entra-only (local_auth_enabled = false); the Functions subnet has no Cognitive Services service endpoint yet, so Disabled would cut the router off. Restricting it to the VNet is the follow-up named in the comment below, the owner's call. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_22:Microsoft-managed keys, as ADR 0031 (2026-09-14) chose for the storage and Cosmos accounts; the owner extended that choice to this account (created 2026-10-04) on 2026-11-24. A customer-managed key needs a paid Key Vault key; on this account it can be switched off again. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_238:The account makes no outbound call that needs an identity of its own; callers reach it with THEIR identity (the Function App's, through "Cognitive Services OpenAI User"). docs/security/scanner-triage.md#checkov
  name                = var.foundry_account_name
  location            = azurerm_resource_group.app["ai"].location
  resource_group_name = azurerm_resource_group.app["ai"].name
  kind                = "AIServices"
  sku_name            = "S0"

  # Required for Entra authentication and for the openai.azure.com host the
  # router calls (https://<subdomain>.openai.azure.com/openai/v1/...).
  custom_subdomain_name = var.foundry_account_name

  # Entra only. The router never holds a key for this provider, so no key
  # exists to seed; a key-based caller gets 401 here by design.
  local_auth_enabled = false

  # Public endpoint, Entra-gated. The Functions subnet has no service endpoint
  # for Cognitive Services today (variables.tf: functions_subnet_service_endpoints);
  # adding one and a network rule here is the follow-up if the owner wants the
  # account reachable from the VNet only.
  public_network_access_enabled = true

  tags = local.tags
}

# Deployment name = model name, so the router's model table ids are the
# deployment ids the v1 endpoint expects in `model`. Versions are the ones
# listed as Global Standard in centralus on 2026-10-04 (Region availability
# for Foundry Models sold by Azure). `capacity` is thousands of tokens per
# minute; 50 is far above the site's burst and well under the default quota.
resource "azurerm_cognitive_deployment" "foundry" {
  for_each = {
    "gpt-5-nano" = "2025-08-07"
    "gpt-5-mini" = "2025-08-07"
  }

  name                 = each.key
  cognitive_account_id = azurerm_cognitive_account.foundry.id

  model {
    format  = "OpenAI"
    name    = each.key
    version = each.value
  }

  sku {
    name     = "GlobalStandard"
    capacity = 50
  }
}

# The data-plane role the token needs. Control-plane roles (Reader, Owner) do
# not grant inference; this one does and nothing more.
resource "azurerm_role_assignment" "function_app_foundry_user" {
  scope                = azurerm_cognitive_account.foundry.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

# USD 75 a month on the `ai` resource group alone, so the Foundry spend has
# its own alerts beside the subscription budget in budget.tf: 50 and 90 %
# actual, 100 % actual and forecast, through the same action group. A budget
# notifies; it does not stop consumption, and the owner's response to an
# alert is to disable the provider on the AI Engine page. The
# start date follows budget.tf's reasoning (first of the plan's month,
# ignored after create).
resource "azurerm_consumption_budget_resource_group" "foundry" {
  name              = "${var.workload_name}-foundry-monthly-budget"
  resource_group_id = azurerm_resource_group.app["ai"].id
  amount            = var.foundry_budget_amount_usd
  time_grain        = "Monthly"

  time_period {
    start_date = local.budget_start_date
  }

  lifecycle {
    ignore_changes = [time_period[0].start_date]
  }

  dynamic "notification" {
    for_each = [50, 90, 100]
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThanOrEqualTo"
      threshold_type = "Actual"
      contact_emails = [var.budget_alert_email]
      contact_groups = [azurerm_monitor_action_group.ops.id]
    }
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_emails = [var.budget_alert_email]
    contact_groups = [azurerm_monitor_action_group.ops.id]
  }
}

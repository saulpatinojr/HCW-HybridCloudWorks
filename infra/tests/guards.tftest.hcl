# Offline contract tests for infra/ security guards (#982).
#
# Asserts plan-level guarantees:
# 1. No keyless AzureWebJobsStorage connection string on the Function App.
# 2. Deploy identity trusts environment-only subjects (SEC-2).
# 3. Cosmos DB built-in data role is scoped to the Function App.
# 4. Cosmos DB account enforces virtual network filtering and disables local keys (T-504).

mock_provider "azurerm" {}
mock_provider "azurerm" {
  alias = "mgmt"
}
mock_provider "azurerm" {
  alias = "conn"
}
mock_provider "azapi" {}
mock_provider "cloudflare" {}

override_data {
  target = data.azurerm_client_config.current
  values = {
    tenant_id       = "00000000-0000-0000-0000-000000000000"
    subscription_id = "00000000-0000-0000-0000-000000000000"
    client_id       = "00000000-0000-0000-0000-000000000000"
    object_id       = "00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = azurerm_cosmosdb_account.hcw
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-db/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-hcw"
  }
}

variables {
  subscription_app     = "00000000-0000-0000-0000-000000000000"
  subscription_mgmt    = "00000000-0000-0000-0000-000000000000"
  subscription_conn    = "00000000-0000-0000-0000-000000000000"
  entra_tenant_id      = "00000000-0000-0000-0000-000000000000"
  entra_api_audience   = "00000000-0000-0000-0000-000000000000"
  budget_alert_email   = "ops@example.com"
  cloudflare_api_token = "mock-token"
  cloudflare_zone_id   = "0123456789abcdef0123456789abcdef"
}

run "infrastructure_security_guards" {
  command = plan

  # 1. No keyless AzureWebJobsStorage connection string on the Function App
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.hcw.app_settings), "AzureWebJobsStorage")
    error_message = "Function App must not contain keyless AzureWebJobsStorage app setting (T-511)."
  }

  assert {
    condition     = contains(keys(azurerm_function_app_flex_consumption.hcw.app_settings), "AzureWebJobsStorage__accountName")
    error_message = "Function App must use identity-based AzureWebJobsStorage__accountName."
  }

  # 2. Environment-only subjects on deploy identity (SEC-2)
  assert {
    condition     = can(regex(":environment:production$", azurerm_federated_identity_credential.github_production.subject))
    error_message = "Deploy identity must trust environment-gated subjects only (SEC-2)."
  }

  assert {
    condition     = can(regex(":environment:production$", azurerm_federated_identity_credential.github_production_immutable.subject))
    error_message = "Deploy identity immutable credential must trust environment-gated subjects only."
  }

  # 3. Cosmos data role definition check
  assert {
    condition     = can(regex("00000000-0000-0000-0000-000000000002$", azurerm_cosmosdb_sql_role_assignment.func_cosmos.role_definition_id))
    error_message = "Cosmos DB built-in Data Contributor role definition must be assigned to the Function App."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_role_assignment.func_cosmos.scope == azurerm_cosmosdb_account.hcw.id
    error_message = "Cosmos DB role assignment must be scoped strictly to the Cosmos DB account."
  }

  # 4. Cosmos network isolation and keyless authentication (T-504)
  assert {
    condition     = azurerm_cosmosdb_account.hcw.is_virtual_network_filter_enabled == true
    error_message = "Cosmos DB account must enforce virtual network filtering (T-504)."
  }

  assert {
    condition     = azurerm_cosmosdb_account.hcw.local_authentication_enabled == false
    error_message = "Cosmos DB account must have local key authentication disabled (T-504)."
  }
}

# Offline contract tests for infra/ security guards (#982).
#
# Asserts plan-level guarantees:
# 1. No keyless AzureWebJobsStorage connection string on the Function App.
# 2. Deploy identity trusts environment-only subjects (SEC-2).
# 3. Cosmos DB built-in data role is granted to the Function App per database, never account-wide (#1469).
# 4. Cosmos DB account enforces virtual network filtering and disables local keys (T-504).
# 5. gsc_entra_app_id_uri is empty or an api:// URI with no trailing slash (#1612).

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

  # 3. The Function App's Cosmos data-plane grants (#1469): one per database
  # the app reads, the built-in Data Contributor role, scoped to
  # `<account id>/dbs/<database>`. The account-wide grant (`func_cosmos`)
  # was deleted by step 2 of #1469; no grant for this identity may be scoped
  # to the account again. A Terraform test can only read the resources the
  # configuration declares, so this holds every declared grant off the
  # account scope; scripts/assert-expected-plan.test.mjs reads infra/ as text
  # and refuses a role-assignment block scoped to the account id as well.
  assert {
    condition = alltrue([
      for grant in values(azurerm_cosmosdb_sql_role_assignment.func_cosmos_db) :
      grant.scope != azurerm_cosmosdb_account.hcw.id
    ])
    error_message = "No Cosmos DB role assignment for the Function App's identity may be scoped to the whole account (#1469 narrowed it to `<account id>/dbs/<database>`)."
  }

  assert {
    condition     = keys(azurerm_cosmosdb_sql_role_assignment.func_cosmos_db) == ["hcw"]
    error_message = "Cosmos DB per-database role assignments must cover exactly the databases infra/ declares (today: hcw). A second database is a new key in local.cosmos_database_grants, and a declared create in scripts/assert-expected-plan.mjs."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_role_assignment.func_cosmos_db["hcw"].scope == "${azurerm_cosmosdb_account.hcw.id}/dbs/${azurerm_cosmosdb_sql_database.hcw.name}"
    error_message = "Cosmos DB per-database role assignment for hcw must be scoped to the hcw database (`<account id>/dbs/hcw`), not the account."
  }

  assert {
    condition = alltrue([
      for grant in values(azurerm_cosmosdb_sql_role_assignment.func_cosmos_db) :
      can(regex("00000000-0000-0000-0000-000000000002$", grant.role_definition_id))
    ])
    error_message = "Every Cosmos DB per-database role assignment must be the built-in Data Contributor role."
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

# 5. gsc_entra_app_id_uri (#1612): Google's pool provider compares the
# token's audience with it exactly, so a wrong shape is refused at plan time
# rather than at the first sign-in.
run "gsc_entra_app_id_uri_accepts_an_api_uri" {
  command = plan

  variables {
    gsc_entra_app_id_uri = "api://00000000-0000-0000-0000-000000000001"
  }
}

run "gsc_entra_app_id_uri_refuses_a_trailing_slash" {
  command = plan

  variables {
    gsc_entra_app_id_uri = "api://00000000-0000-0000-0000-000000000001/"
  }

  expect_failures = [var.gsc_entra_app_id_uri]
}

run "gsc_entra_app_id_uri_refuses_another_scheme" {
  command = plan

  variables {
    gsc_entra_app_id_uri = "https://example.com/app"
  }

  expect_failures = [var.gsc_entra_app_id_uri]
}

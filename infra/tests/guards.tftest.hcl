# Offline contract tests for infra/ security guards (#982).
#
# Asserts plan-level guarantees:
# 1. No keyless AzureWebJobsStorage connection string on the Function App.
# 2. Deploy identity trusts environment-only subjects (SEC-2): since #1617,
#    the reviewed production-backend environment's pair.
#    2b. The frontend deploy identity's production pair and site-scoped
#    role (#1617).
# 3. Cosmos DB built-in data role is granted to the Function App per database, never account-wide (#1469).
# 4. Cosmos DB account enforces virtual network filtering and disables local keys (T-504).
# 5. gsc_entra_app_id_uri is empty or an api:// URI with no trailing slash (#1612).
# 6. Muse's read-only app registration (#1763): absent while its switch is
#    off; when on, built-in Reader on each of the three whole subscriptions
#    and nothing else, and a secret that expires.
# 7. The adopted Web Analytics site (#1923): nothing planned while its two
#    inputs are unset, and a site tag that disagrees with the site Terraform
#    adopted stops the plan rather than being ignored.
# 8. The site's own apex and www (#1929): DNS-only by default, the content
#    read from the Static Web App, www proxied before the apex and never the
#    apex alone.

mock_provider "azurerm" {}
mock_provider "azurerm" {
  alias = "mgmt"
}
mock_provider "azurerm" {
  alias = "conn"
}
mock_provider "azapi" {}
mock_provider "cloudflare" {}
mock_provider "azuread" {}
mock_provider "time" {}

override_data {
  target = data.azurerm_client_config.current
  values = {
    tenant_id       = "00000000-0000-0000-0000-000000000000"
    subscription_id = "00000000-0000-0000-0000-000000000000"
    client_id       = "00000000-0000-0000-0000-000000000000"
    object_id       = "00000000-0000-0000-0000-000000000000"
  }
}

# Muse's app registration (#1763) names the run identity as its owner, and
# azuread checks the id is a UUID even in a mocked plan.
override_data {
  target = data.azuread_client_config.current
  values = {
    tenant_id = "00000000-0000-0000-0000-000000000000"
    client_id = "00000000-0000-0000-0000-000000000000"
    object_id = "00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = azurerm_cosmosdb_account.hcw
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-db/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-hcw"
  }
}

# The site's id, known at plan time, so guard 2b can compare the frontend
# deploy identity's role scope with it (#1617).
override_resource {
  target          = azurerm_static_web_app.hcw
  override_during = plan
  values = {
    id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-web/providers/Microsoft.Web/staticSites/stapp-hcw"
    default_host_name = "example-host-0000.7.azurestaticapps.net"
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

  # 2. Environment-only subjects on the deploy identity (SEC-2). Since the
  # second pull request of #1617 its only pair is the reviewed
  # production-backend environment's; its production pair is deleted, and
  # scripts/oidc-subjects.test.mjs checks that no other credential is on it.
  assert {
    condition = alltrue([
      for credential in [
        azurerm_federated_identity_credential.github_production_backend,
        azurerm_federated_identity_credential.github_production_backend_immutable,
      ] : can(regex(":environment:production-backend$", credential.subject))
    ])
    error_message = "The deploy identity must trust the reviewed production-backend environment's subject only, both forms (SEC-2, #1617)."
  }

  # 2b. #1617: the frontend deploy's own identity on `production`.

  assert {
    condition = alltrue([
      for credential in [
        azurerm_federated_identity_credential.github_frontend_deploy_env_production,
        azurerm_federated_identity_credential.github_frontend_deploy_env_production_immutable,
      ] : can(regex(":environment:production$", credential.subject))
    ])
    error_message = "The frontend deploy identity must trust the production environment's subject only, both forms (#1617)."
  }

  assert {
    condition     = azurerm_role_assignment.github_frontend_deploy_swa_token.scope == azurerm_static_web_app.hcw.id
    error_message = "The frontend deploy identity's one role must be scoped to the one Static Web App, not its resource group (#1617)."
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

# 6. Muse's read-only access (#1763). Off by default: the run identity needs
# an Entra role before the first create, so nothing is planned until the
# owner flips the switch.
run "muse_reader_is_off_by_default" {
  command = plan

  assert {
    condition = (
      length(azuread_application.muse_reader) == 0 &&
      length(azuread_application_password.muse_reader) == 0 &&
      length(azurerm_role_assignment.muse_reader_app) == 0 &&
      length(azurerm_role_assignment.muse_reader_mgmt) == 0 &&
      length(azurerm_role_assignment.muse_reader_conn) == 0
    )
    error_message = "Muse's app registration must not be planned until muse_reader_enabled is true (#1763)."
  }
}

run "muse_reader_reads_every_subscription_and_writes_nothing" {
  command = plan

  variables {
    muse_reader_enabled = true
    subscription_app    = "00000000-0000-0000-0000-00000000000a"
    subscription_mgmt   = "00000000-0000-0000-0000-00000000000b"
    subscription_conn   = "00000000-0000-0000-0000-00000000000c"
  }

  assert {
    condition = alltrue([
      for grant in [
        azurerm_role_assignment.muse_reader_app[0],
        azurerm_role_assignment.muse_reader_mgmt[0],
        azurerm_role_assignment.muse_reader_conn[0],
      ] : grant.role_definition_name == "Reader"
    ])
    error_message = "Muse's grants must be the built-in Reader role and nothing wider (#1763)."
  }

  assert {
    condition = (
      azurerm_role_assignment.muse_reader_app[0].scope == "/subscriptions/00000000-0000-0000-0000-00000000000a" &&
      azurerm_role_assignment.muse_reader_mgmt[0].scope == "/subscriptions/00000000-0000-0000-0000-00000000000b" &&
      azurerm_role_assignment.muse_reader_conn[0].scope == "/subscriptions/00000000-0000-0000-0000-00000000000c"
    )
    error_message = "Muse must read the application, management and connectivity subscriptions, each as a whole; the github_reader gap (no Management read) must not come back (#1763)."
  }

  assert {
    condition     = azuread_application.muse_reader[0].sign_in_audience == "AzureADMyOrg"
    error_message = "Muse's app registration must be single-tenant (#1763)."
  }
}

# 7. The adopted Web Analytics site (#1923). The tags are made-up 32-hex
# values. The override stands in for the site Terraform adopted: its
# site_tag is what the import read, or, after the first apply, what state
# holds while the import block is skipped.
run "web_analytics_site_is_not_managed_by_default" {
  command = plan

  assert {
    condition     = length(cloudflare_web_analytics_site.hcw) == 0
    error_message = "Nothing of Web Analytics may be planned until cloudflare_account_id and cloudflare_web_analytics_site_tag are both set (#1923)."
  }
}

run "web_analytics_site_tag_matches_the_adopted_site" {
  command = plan

  variables {
    cloudflare_account_id             = "0123456789abcdef0123456789abcdef"
    cloudflare_web_analytics_site_tag = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  override_resource {
    target          = cloudflare_web_analytics_site.hcw
    override_during = plan
    values = {
      site_tag = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }

  assert {
    condition     = cloudflare_web_analytics_site.hcw[0].site_tag == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    error_message = "The adopted site must be planned with the tag the variable names (#1923)."
  }
}

run "web_analytics_site_tag_that_differs_stops_the_plan" {
  command = plan

  variables {
    cloudflare_account_id             = "0123456789abcdef0123456789abcdef"
    cloudflare_web_analytics_site_tag = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }

  override_resource {
    target          = cloudflare_web_analytics_site.hcw
    override_during = plan
    values = {
      site_tag = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }

  expect_failures = [cloudflare_web_analytics_site.hcw]
}

# 8. The site's own apex and www (#1929). "none" is how the records were made
# by hand: DNS-only, www at ttl 60, the apex at ttl 1 (automatic).
run "site_records_stay_dns_only_by_default" {
  command = plan

  assert {
    condition     = !cloudflare_dns_record.site_apex.proxied && !cloudflare_dns_record.site_www.proxied
    error_message = "With site_proxied_hosts at its default, neither the apex nor www may be proxied: merging the change must not change the site (#1929)."
  }

  assert {
    condition     = cloudflare_dns_record.site_apex.ttl == 1 && cloudflare_dns_record.site_www.ttl == 60
    error_message = "DNS-only, the records keep the TTLs they were made with: 1 (automatic) on the apex, 60 on www (#1929)."
  }

  assert {
    condition = alltrue([
      for record in [cloudflare_dns_record.site_apex, cloudflare_dns_record.site_www] :
      record.type == "CNAME" && record.content == "example-host-0000.7.azurestaticapps.net"
    ])
    error_message = "Both records are CNAMEs to the Static Web App's own default host name, read from the resource (#1929)."
  }

  assert {
    condition     = cloudflare_dns_record.site_apex.name == "hybridcloudworks.com" && cloudflare_dns_record.site_www.name == "www.hybridcloudworks.com"
    error_message = "The two records are the zone's apex and www (#1929)."
  }
}

run "site_records_proxy_www_first" {
  command = plan

  variables {
    site_proxied_hosts = "www"
  }

  assert {
    condition     = cloudflare_dns_record.site_www.proxied && cloudflare_dns_record.site_www.ttl == 1
    error_message = "\"www\" proxies www, with ttl 1, the only value a proxied record takes (#1929)."
  }

  assert {
    condition     = !cloudflare_dns_record.site_apex.proxied
    error_message = "\"www\" leaves the apex DNS-only until www has been checked (#1929)."
  }
}

run "site_records_proxy_both" {
  command = plan

  variables {
    site_proxied_hosts = "both"
  }

  assert {
    condition     = cloudflare_dns_record.site_www.proxied && cloudflare_dns_record.site_apex.proxied
    error_message = "\"both\" proxies www and the apex (#1929)."
  }

  assert {
    condition     = cloudflare_dns_record.site_www.ttl == 1 && cloudflare_dns_record.site_apex.ttl == 1
    error_message = "Proxied records take ttl 1 (#1929)."
  }
}

run "site_records_refuse_the_apex_alone" {
  command = plan

  variables {
    site_proxied_hosts = "apex"
  }

  expect_failures = [var.site_proxied_hosts]
}

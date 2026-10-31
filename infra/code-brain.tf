# =============================================================================
# code-brain.tf — the Code Conductor brain's own Cosmos database (#1457,
# docs/decisions/0036-code-conductor-brain.md).
#
# A second private notes workspace, for engineering notes, kept apart from the
# creator Second Brain. It gets a NEW database inside the EXISTING Cosmos
# account (cosmos.tf), not new containers in the creator's `hcw` database and
# not a second account:
#
#   - a separate database means no creator code can name its container by
#     accident, the export and restore treat it as its own unit, and dropping
#     it one day touches nothing of the creator's;
#   - the same account keeps the existing firewall, backup policy
#     (Continuous30Days point-in-time restore), local-auth-off and serverless
#     billing, with nothing new to secure. On serverless an empty database
#     costs nothing.
#
# The names come from cosmos-code-brain-containers.json, which the Functions
# tests and the restore script read too.
#
# RUNTIME ACCESS. No new identity and no new role assignment. The Function App
# reaches Cosmos through azurerm_cosmosdb_sql_role_assignment.func_cosmos in
# cosmos.tf, which is the built-in Data Contributor at ACCOUNT scope, so it
# already covers this database. Adding a database-scope assignment for the
# same identity would grant nothing new. Narrowing func_cosmos itself to
# per-database scopes is possible (Cosmos accepts /dbs/<name> scopes) but
# replaces the assignment the whole site runs on, so it is left as its own
# reviewed change (ADR 0036, "Alternatives considered"). Inside the app, the
# workspace's store reaches only code_brain_records in this database
# (functions/src/lib/code-brain/store.js).
#
# DISABLED BY DEFAULT. Creating the database switches nothing on. The routes
# answer 404 until code_brain_enabled and its owner, tenant and desktop client
# are set (code-brain-variables.tf). The app setting CODE_BRAIN_COSMOS_DATABASE
# is set in the same apply that creates the database, and that is what adds
# code_brain_records to the out-of-account export, so backups include it
# before the workspace is ever switched on.
# =============================================================================

locals {
  code_brain_spec       = jsondecode(file("${path.module}/cosmos-code-brain-containers.json"))
  code_brain_containers = { for c in local.code_brain_spec.containers : c.name => c }
}

resource "azurerm_cosmosdb_sql_database" "code_brain" {
  name                = local.code_brain_spec.database
  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name

  lifecycle {
    # Authored notes, recoverable from nowhere else once they exist. Same
    # two-step as the creator database: removing this guard is its own
    # reviewed pull request (T-708).
    prevent_destroy = true

    precondition {
      condition     = local.code_brain_spec.database != var.cosmos_database_name
      error_message = "The Code Conductor brain must have its own database, not the creator site's (cosmos_database_name)."
    }
  }
}

resource "azurerm_cosmosdb_sql_container" "code_brain" {
  for_each = local.code_brain_containers

  name                = each.value.name
  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name
  database_name       = azurerm_cosmosdb_sql_database.code_brain.name
  # One logical partition per owner: every save is one transactional batch in
  # that partition (record, revision, event, receipt and sequence counter).
  partition_key_paths = [each.value.partition_key_path]
  default_ttl         = each.value.default_ttl

  indexing_policy {
    indexing_mode = "consistent"
    included_path {
      path = "/*"
    }
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = each.value.partition_key_path == "/ownerId"
      error_message = "Code Conductor brain containers are partitioned on /ownerId: the save transaction and owner isolation depend on it."
    }
  }
}

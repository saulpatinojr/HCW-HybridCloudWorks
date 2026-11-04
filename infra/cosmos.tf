# =============================================================================
# cosmos.tf — the Cosmos account, its database, every container, and the
# data-plane role assignments the Function App reads through.
#
# Split out of main.tf on 2026-08-29 (T-754). Terraform reads every .tf file in
# this directory as ONE module: same namespace, same state, same plan. Nothing
# moved between states and no resource address changed — an empty plan is the
# proof, and `functions/test/terraform-source.js` is why the text-reading guards
# did not need to care.
# =============================================================================

# =============================================================================
# Cosmos DB Account — Serverless capacity mode, NoSQL (Core/SQL) API
#
# Serverless: pay-per-RU, no provisioned throughput.
# Ideal for variable/low traffic pre-launch workloads.
# Consistency: Session (default, matches Firestore's per-client consistency).
# Single-region: centralus, the same region as the rest of the estate.
# =============================================================================
resource "azurerm_cosmosdb_account" "hcw" {
  #checkov:skip=CKV_AZURE_101:Public network access stays enabled because Disabled also refuses the subnet virtual_network_rule; the firewall admits only that subnet and operator IPs. Owner 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_100:Microsoft-managed keys, owner decision 2026-09-14, ADR 0031; CMK is one-way on an existing account. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_140:Local auth is disabled; var.cosmos_local_auth_disabled defaults to true and checkov cannot evaluate the negation. docs/security/scanner-triage.md#checkov
  name = var.cosmos_db_account_name
  # Kept as its own variable rather than folded into azure_location: where a
  # Cosmos account MAY be created is governed by two APIs that disagree, and
  # both must be re-checked for any future region (see var.cosmos_location).
  # It resolves to the same region as everything else today — this account was
  # the reason the estate moved to centralus rather than the exception to it.
  location            = var.cosmos_location
  resource_group_name = azurerm_resource_group.app["db"].name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  # Serverless is NOT only a cost choice here — it is what makes the
  # container-per-collection shape below viable. Read this before changing it.
  #
  # Converting serverless -> provisioned throughput is IRREVERSIBLE, and the
  # documented conversion formula is `RU/s = number of partitions * 5000`. At
  # 66 containers that lands ~330,000 RU/s of manual throughput at once, and
  # even after scaling every container down by hand the floor is 400 RU/s each.
  # A consolidated design (a handful of containers with a type discriminator)
  # would floor roughly an order of magnitude lower.
  #
  # Serverless is also single-region for life: regions cannot be added after
  # account creation, and there is no autoscale.
  #
  # So three irreversible decisions are load-bearing on each other: serverless
  # capacity mode, one container per Firestore collection, and the per-container
  # partition keys. On serverless, empty and idle containers cost nothing, so
  # 66 containers is genuinely free today and keeps the per-container indexing
  # policies and the container/query contract used by the current website.
  #
  # Trigger condition: if multi-region, autoscale, or provisioned throughput is
  # ever required, container consolidation happens in the SAME project, before
  # the capacity-mode change — not after it.
  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  # zone_redundant is EXPLICIT, not left to the provider default, because the
  # default put this account in the availability-zone pool and South Central US
  # had no AZ capacity to give: creation failed with ServiceUnavailable and a
  # message about "zonal redundant (Availability Zones) accounts" — a capacity
  # message, not a configuration error, and one that would recur unpredictably.
  #
  # False is also the correct setting on its own merits here. The account is
  # serverless and single-region by deliberate design (see the capacity note
  # above), and zone redundancy costs more while protecting against a failure
  # mode a single-region account has already accepted.
  geo_location {
    location          = var.cosmos_location
    failover_priority = 0
    # centralus does support availability zones, so this is a choice rather
    # than a constraint: a serverless, single-region account has already
    # accepted the failure mode zone redundancy protects against, and zones
    # cost more.
    zone_redundant = false
  }

  # T-504: the service firewall ADR-001/ADR-0008 traded Private Link away for.
  # Data-plane access is allowed from exactly:
  #   - the Functions integration subnet (the app's runtime path — requires
  #     the Microsoft.AzureCosmosDB service endpoint on that subnet);
  #   - Azure datacenter IPs when cosmos_allow_azure_datacenter_ips is true.
  #     FALSE since 2026-08-30 (T-718). The documented "0.0.0.0" sentinel
  #     admitted every Azure tenant at the network layer, and exactly one
  #     workload held it open: publish-content-manifest.yml querying Cosmos from
  #     a GitHub-hosted runner. That query now runs in the Function App, which
  #     arrives over the virtual_network_rule below, so CI holds no Cosmos
  #     data-plane role at all and the sentinel had nothing left to serve.
  #     docs/decisions/0025-cosmos-firewall-datacenter-sentinel.md records the options and
  #     why this one won;
  #   - any operator IPs in cosmos_admin_ip_rules (smoke tier 2), empty in
  #     steady state.
  # Management-plane (ARM) operations — Terraform itself — are not gated by
  # this firewall.
  is_virtual_network_filter_enabled = true

  virtual_network_rule {
    id = azurerm_subnet.functions_integration.id
  }

  ip_range_filter = toset(concat(
    var.cosmos_allow_azure_datacenter_ips ? ["0.0.0.0"] : [],
    var.cosmos_admin_ip_rules,
  ))

  # T-504: keys off. The app is managed-identity-only (AAD data plane), the
  # operational tooling uses DefaultAzureCredential, and the old rotation
  # question was about a key that may once have existed — disabling local auth
  # is the durable answer to it. Set the variable false only if plan review surfaces a key
  # consumer nobody remembered.
  # local_authentication_enabled replaced the deprecated
  # local_authentication_disabled and inverts its polarity, hence the negation.
  # The variable keeps the "disabled" sense deliberately: it reads as the
  # security posture being asserted, and renaming it belongs to T-507.
  local_authentication_enabled = !var.cosmos_local_auth_disabled

  # Databases, containers and throughput change through Resource Manager only,
  # never through an account key. With local auth off above this changes no
  # live behaviour; it keeps the lock if local auth is ever switched back on
  # for a key consumer, which then gets data access but no schema writes.
  # Free, in-place, reversible. docs/security/scanner-triage.md (CKV_AZURE_132).
  access_key_metadata_writes_enabled = false

  # Continuous backup — point-in-time restore instead of the periodic default.
  # One-way conversion (continuous cannot go back to periodic).
  #
  # Continuous30Days since 2026-08-28 (T-707). The 7-day tier is free, and that
  # was the whole reason it was chosen; the problem is that this platform runs
  # cleanup timers which delete and rewrite documents, so corruption is
  # discovered slowly and a 7-day window can close before anyone notices. The
  # 30-day tier is billed at $0.20/GB/month × regions — cents at this data size
  # (roughly 70k small documents), which buys four times the window.
  #
  # What this still does NOT buy, and what T-707 keeps open: an out-of-account
  # copy. Microsoft's own words — "the backups aren't automatically
  # geo-disaster resistant" — the backup lives with the account, so account
  # deletion or a Central US failure takes it too. Serverless is single-region
  # for life and the conversion is irreversible, so that gap is closed by
  # exporting out of the account, not by a setting here. Tracked with the
  # recovery objectives in issue #231.
  backup {
    type = "Continuous"
    tier = "Continuous30Days"
  }

  # This account holds production website data. A plan that wants to
  # replace it must fail until a human removes this guard in a reviewed PR.
  #
  # Lifted once, for the centralus rebuild on 2026-08-19, and restored the same
  # day once the rebuild applied. That window was safe only because
  # The original rebuild window occurred before production data was populated.
  # It will not be safe again: this guard is the
  # difference between a typo and a data-loss incident.
  lifecycle {
    prevent_destroy = true
  }

  tags = local.tags
}

# Cosmos DB SQL Database
resource "azurerm_cosmosdb_sql_database" "hcw" {
  # Deliberately NOT renamed to the CAF convention. This is a data-plane
  # identifier, not an Azure resource name: functions/src/lib/cosmos-client.js,
  # scripts/lib/cli.mjs and scripts/apply-computed-sortdate.mjs all default to
  # the literal "hcw" when COSMOS_DATABASE is unset; all current clients share
  # that value. Renaming it would leave those paths connecting to a database
  # to a database that does not exist, and the failure would look like a
  # permissions problem.
  #
  # It is its own variable rather than borrowing project_name so that the
  # coupling is explicit and changing it is a deliberate act coordinated with
  # those files. The scratch account (scratch.tf) uses the same name so a
  # rehearsal exercises exactly the database id production will.
  name                = var.cosmos_database_name
  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name

  # prevent_destroy on the ACCOUNT does not protect its children: a database or
  # container destroy plans and applies cleanly underneath it. This database
  # holds every production document, so dropping it is a two-step that starts
  # with removing this guard in a reviewed PR — the same shape the account
  # already imposes (T-708).
  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Cosmos DB Containers
#
# The container list is GENERATED from scripts/lib/migration-manifest.mjs, the
# collection contract used by Terraform and operational tooling. Regenerate with:
#
#     node scripts/generate-cosmos-container-spec.mjs
#
# Do not add containers here by hand — add the collection to the manifest and
# regenerate, or Terraform and the application contract drift apart.
#
# Partition keys come from the manifest: 70 on /id and five exceptions — four
# flattened subcollections keyed by their parent (content_versions on
# /contentId, image_prompts_sets on /pageId, image_prompt_sets_prompts on
# /setName, listen_and_learn_episodes on /setId) and admin_config on a
# constant /configScope so the ContentForge save stays one TransactionalBatch.
#
# /id is right for the rest because the Site-Main query load does not group by
# anything — one of ~40 content query sites filters on a provider — and the
# previous "natural" keys were wrong on their own merits: /contentId was written
# as the empty string on every document, /status on lab_jobs is mutable and a
# partition key value cannot be changed in place, and /agentId on lab_agents is
# identical to /id by construction.
#
# The subcollection exceptions are a CORRECTNESS matter, not a tuning one. Each
# assigns document ids that are unique only within their parent (a set name, a
# prompt name, an exam-area slug), so flattening them into one container under
# /id would silently overwrite documents on upsert.
#
# Full evidence, with file:line citations, in the manifest header.
#
# A partition key path is IMMUTABLE. Changing one on a container that already
# holds data means destroying the container and re-importing.
#
# THAT WINDOW IS CLOSED. This block used to read "every container here is empty
# as of 2026-08-20 — the decision window is open now and closes on the first
# import"; the import happened, and production holds roughly 70k documents
# (measured 2026-08-24). A partition-key change in cosmos-containers.json is
# now a data-destroying plan, which is why the resource carries
# prevent_destroy (T-708): the guard has to come off deliberately, in its own
# reviewed PR, before any such change can apply.
# -----------------------------------------------------------------------------

locals {
  # The applied tag map (T-752). var.tags carries the org-stable keys; the
  # environment is derived from var.environment so a deployment of this root
  # into a non-prod environment cannot tag every resource `prod` unless the
  # operator remembers to override the whole map. Value-identical today
  # (var.environment is "prod"), so this lands as a no-op plan.
  tags = merge(var.tags, { environment = var.environment })
}

locals {
  cosmos_container_spec = jsondecode(file("${path.module}/cosmos-containers.json"))
  cosmos_containers     = { for c in local.cosmos_container_spec.containers : c.name => c }
}

resource "azurerm_cosmosdb_sql_container" "hcw" {
  for_each = local.cosmos_containers

  name                = each.value.name
  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name
  database_name       = azurerm_cosmosdb_sql_database.hcw.name
  partition_key_paths = [each.value.partition_key_path]

  # null = retain forever. Set on the rate-limit counters and caches, which are
  # worthless after their window and would otherwise be retained and indexed
  # indefinitely. Unlike partition_key_paths this is mutable after creation.
  default_ttl = each.value.default_ttl

  indexing_policy {
    indexing_mode = "consistent"

    dynamic "included_path" {
      for_each = each.value.included_paths
      content {
        path = included_path.value
      }
    }

    dynamic "excluded_path" {
      for_each = each.value.excluded_paths
      content {
        path = excluded_path.value
      }
    }

    # Transcribed from Site-Main's firestore.indexes.json. Cosmos REQUIRES a
    # composite index for an ORDER BY over two or more properties — without one
    # the query fails rather than running slowly.
    dynamic "composite_index" {
      for_each = each.value.composite_indexes
      content {
        dynamic "index" {
          for_each = composite_index.value
          content {
            path  = index.value.path
            order = index.value.order
          }
        }
      }
    }
  }

  # Applies to every instance of the for_each. These containers are generated
  # from cosmos-containers.json and partition keys are immutable, so a
  # regenerated spec that renames a container or changes a key produces a
  # destroy-and-create — on roughly 70k production documents. The guard turns
  # that from a plan someone has to read carefully into a plan that fails
  # (T-708). Dropping a container deliberately means removing this first.
  #
  # Lifted once, 2026-09-05, to drop `ai_insights` (#340: its reader was
  # retired in #339, T-765, and nothing ever wrote it). The plan showed the
  # one intended destroy plus the workspace's permanent azapi baseline, the
  # owner approved it, and #341 restored the guard in the apply that
  # followed. That is the procedure for the next deliberate drop too: lift
  # in its own PR, read the plan for exactly one destroy, restore in the
  # next.
  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Computed properties, inside the apply (#816)
# -----------------------------------------------------------------------------
# azurerm_cosmosdb_sql_container has no computed_properties argument (azurerm
# 5.7.0), so an apply that updates `content` or `blogs` through it PUTs a
# definition without them, and the public content list, which orders by
# cp_sortDate once PUBLIC_LIST_SQL_ORDER is "1", breaks until the property is
# back. Until #816 a workflow put it back every six hours
# (heal-computed-properties.yml): a wound the next tick closed, open for up
# to six hours after any such apply.
#
# Now the apply that could wipe the property restores it. Each update
# resource carries exactly the definitions in cosmos-containers.json
# (generated from scripts/lib/cosmos-sort-date.mjs). replace_triggered_by
# re-runs it after any change to its container in the same apply: azapi reads
# the container azurerm just wrote, merges these in, and PUTs it back.
# Otherwise it plans nothing, because Cosmos stores the query exactly as
# written.
#
# The postcondition turns "the property is missing" into a failed plan or
# apply rather than a silent repair. A wipe made outside Terraform shows
# on the next plan as a refreshed output without the property, and the plan
# stops there. It is not a new permanent diff: these are conditional
# replacements, listed as such in scripts/assert-expected-plan.mjs.
locals {
  cosmos_computed_properties = {
    for name, container in local.cosmos_containers :
    name => container.computedProperties
    if length(try(container.computedProperties, [])) > 0
  }
}

resource "azapi_update_resource" "cosmos_computed_properties" {
  for_each = local.cosmos_computed_properties

  # The version the healer's ARM PUT used from 2026-08-20 until #816 retired it.
  type        = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15"
  resource_id = azurerm_cosmosdb_sql_container.hcw[each.key].id

  body = {
    properties = {
      resource = {
        id                 = each.key
        computedProperties = each.value
      }
    }
  }

  response_export_values = ["properties.resource.computedProperties"]

  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_sql_container.hcw[each.key]]

    postcondition {
      condition = alltrue([
        for wanted in each.value : anytrue([
          for got in try(self.output.properties.resource.computedProperties, []) :
          got.name == wanted.name && got.query == wanted.query
        ])
      ])
      error_message = "Container ${each.key} does not carry the computed properties infra/cosmos-containers.json defines for it. The public content list orders by cp_sortDate, so this is a production break, not drift to wave through. Re-run the apply; if it persists, compare the container's computedProperties in the portal with scripts/lib/cosmos-sort-date.mjs."
    }
  }
}

# NOTE: there is deliberately NO `moved` block from
# azurerm_linux_function_app.hcw. A moved block requires the two addresses to be
# the same resource TYPE, and these are different types. If the old resource is
# ever in state it must be removed with `terraform state rm` before applying —
# but it cannot be, because that configuration could never have applied against
# an FC1 plan in the first place.

# ---------------------------------------------------------------------------
# RBAC — Function App managed identity data-plane roles (no static keys)
# ---------------------------------------------------------------------------

# Cosmos DB data-plane access is NOT Azure RBAC. "Cosmos DB Built-in Data
# Contributor" lives in the account's own sqlRoleDefinitions namespace, not in
# Microsoft.Authorization/roleDefinitions, so `azurerm_role_assignment` cannot
# resolve it by name — the apply fails with "role definition not found", and
# even if it resolved it would not grant data-plane access.
#
# functions/src/lib/cosmos-client.js authenticates with DefaultAzureCredential
# and no key, so without this assignment every Cosmos operation returns 403.
#
# Nothing masks that any more. COSMOS_CONNECTION_STRING used to sit in app
# settings carrying the primary key, which kept the change-feed trigger binding
# working while every SDK call failed — so a broken role assignment would have
# looked like a partially working app. Both are gone (T-315): this
# assignment is now the only thing standing between the app and a uniform 403,
# which is the failure mode you want, because it is unambiguous.
#
# 00000000-0000-0000-0000-000000000002 is the built-in Data Contributor role.
#
# `name` is deliberately omitted — the provider generates a GUID and keeps it
# stable in state. Hardcoding one is ForceNew, occupies an address we do not
# own, and invites the copy-paste failure when a second identity (the VPS
# agent) needs an assignment: ARM treats a PUT on an existing assignment name
# as a replace, so a duplicated name silently REMOVES the Function App's
# access rather than erroring.
#
# TWO GRANTS DURING THE NARROWING (#1469). Cosmos can grant a data-plane role
# for one database instead of the whole account (scope `<account id>/dbs/<db>`,
# https://learn.microsoft.com/azure/cosmos-db/how-to-connect-role-based-access-control#grant-data-plane-role-based-access).
# The move from the account grant to a grant per database happens in two
# applies so that the app never has a moment with no grant at all:
#
#   Step 1 (this file today): `func_cosmos_db` adds the database-scoped
#     grant(s) beside `func_cosmos`. The plan is one create per database
#     in local.cosmos_database_grants (one today) and nothing else; both
#     grants cover `hcw` until Step 2.
#   Step 2 (a later pull request, after the owner has seen the site, the
#     change-feed functions and the nightly export run on the narrower
#     grant): delete the `func_cosmos` block below and declare the delete in
#     scripts/assert-expected-plan.mjs. The address of `func_cosmos` is kept
#     exactly as it is until then, on purpose: a `count` or `moved` on the one
#     grant the site runs on would make that grant's address change, which
#     scripts/assert-expected-plan.mjs reports as UNEXPECTED, and a wrong
#     move is a destroy-and-create, the very gap this is avoiding.
#
# What the narrower scope still covers, per Microsoft's data-plane security
# reference (https://learn.microsoft.com/azure/cosmos-db/reference-data-plane-security#required-metadata):
# `readMetadata` at database scope allows reading the database, listing its
# containers and every container-level action beneath it, so the SDK's
# start-up metadata reads, the six change-feed functions (monitored
# containers and the `leases` container are all in `hcw`), and the nightly
# export (every exported container is in `hcw`) all stay inside the grant.
# The only thing account scope adds is listing the databases of the account,
# which functions/src/lib/cosmos-client.js never does: it opens
# COSMOS_DATABASE by name.
#
# The account-wide grant. Step 2 of #1469 removes this block.
resource "azurerm_cosmosdb_sql_role_assignment" "func_cosmos" {
  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name
  role_definition_id  = "${azurerm_cosmosdb_account.hcw.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
  scope               = azurerm_cosmosdb_account.hcw.id
}

# The databases the Function App's identity is granted, one grant each. Keyed
# by a literal so the resource address (`func_cosmos_db["hcw"]`) is readable
# in a plan and in scripts/assert-expected-plan.mjs; the value is the database
# resource's name so Terraform creates the database before its grant. A second
# database is one more line here, and nothing else (#1469). `hcw_code_brain`
# is deliberately absent: it was removed with #1480 and the owner's apply of
# 2026-10-31, so there is no database for a grant to point at.
locals {
  cosmos_database_grants = {
    hcw = azurerm_cosmosdb_sql_database.hcw.name
  }
}

# The database-scoped grant(s). Same role, same identity, narrower scope.
# `scope` is ForceNew on this resource (azurerm 5.12.0), so a database rename
# here is a replace of the grant, not an update: do it as its own two-step.
resource "azurerm_cosmosdb_sql_role_assignment" "func_cosmos_db" {
  for_each = local.cosmos_database_grants

  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name
  role_definition_id  = "${azurerm_cosmosdb_account.hcw.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
  scope               = "${azurerm_cosmosdb_account.hcw.id}/dbs/${each.value}"
}

# Change feed lease container — explicit so it has a controlled partition key
# and is tracked in state (not auto-created by the SDK at runtime).
#
# The lease store for the six change-feed functions (T-324), each under its own
# prefix (`<functionName>-`). `createLeaseContainerIfNotExists = false` in the
# bindings: the container is Terraform's, never the SDK's.
resource "azurerm_cosmosdb_sql_container" "leases" {
  name                = "leases"
  resource_group_name = azurerm_resource_group.app["db"].name
  account_name        = azurerm_cosmosdb_account.hcw.name
  database_name       = azurerm_cosmosdb_sql_database.hcw.name
  partition_key_paths = ["/id"]

  indexing_policy {
    indexing_mode = "consistent"
    included_path { path = "/*" }
  }

  # Lower stakes than the data containers — these are continuation tokens, not
  # documents, and resetting the feed by dropping them is a legitimate (if
  # disruptive) operation: every change-feed function would reprocess from the
  # start, which the rising-edge claims make mostly idempotent. The guard is
  # here for the accidental case, not to declare the container permanent; it
  # comes off in a reviewed PR when a reset is what you actually want (T-708).
  lifecycle {
    prevent_destroy = true
  }
}

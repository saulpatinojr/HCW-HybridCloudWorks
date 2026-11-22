# =============================================================================
# muse-reader.tf — read-only Azure access for Muse (Koda's runtime) (#1763)
#
# WHAT THIS IS
#
# Muse runs Koda, the owner's content agent (ADR 0037). When an alert fires,
# Koda has so far worked from the alert email alone. This file gives Muse an
# identity of its own that can READ the whole estate: query Application
# Insights and the Log Analytics workspaces, list alert rules, read costs and
# resource health. It can change nothing. ADR 0042 records the decision; the
# runbook docs/runbooks/muse-azure-reader.md says what it can read and how to
# rotate and revoke its secret.
#
# WHY AN APP REGISTRATION AND A CLIENT SECRET, NOT A MANAGED IDENTITY
#
# Every other non-human identity in this configuration is a user-assigned
# managed identity with federated credentials (oidc.tf), so no secret is
# stored anywhere. Muse runs outside Azure and outside GitHub Actions and does
# not present an OIDC token Entra can trust, so it needs a stored credential.
# The owner asked for an Entra app registration with a client secret (#1763).
#
# WHY IT IS BEHIND A SWITCH
#
# Until this file, infra/ had no azuread provider on purpose: the HCP
# Terraform run identity (id-plat-terraform-prod-cus-01) is an Azure RBAC
# principal with no Entra directory role (oidc.tf's header, lab-hybrid.tf's
# onboarding note). Creating an app registration needs one. So nothing here
# is in the plan until var.muse_reader_enabled is true, which the owner sets
# in the workspace after giving the run identity the Entra role
# "Application Developer" (create app registrations it then owns, and
# nothing else). The runbook has the one command.
#
# WHY READER ON EACH WHOLE SUBSCRIPTION
#
# The owner's request: full read everywhere, not App Insights only, and not
# the github_reader shape, which could not read the Management subscription
# at all (see github_alert_reader in oidc.tf). The built-in Reader role holds
# `*/read` and no data action. That covers workspace and Application Insights
# log queries (Microsoft.OperationalInsights/workspaces/query/read is a read
# action), alert rules, Resource Health and Cost Management's views. It does
# NOT reach Key Vault secret values, storage blobs, Cosmos documents, storage
# account keys or Function App settings values: each of those is a data
# action or a `/list/action`, which Reader does not hold.
#
# These are the only role assignments in infra/ at whole-subscription scope.
# scripts/terraform-identity-grants.test.mjs allows exactly these three,
# Reader only, and refuses any other.
#
# WHERE THE SECRET IS
#
# In Terraform state only (HCP Terraform, workspace hcw-azure), and in the
# sensitive output muse_reader_client_secret. Never in this repository, a
# pull request, an issue or a log. The owner reads it with
# `terraform output -raw` straight into the clipboard and pastes it into
# Muse's own vault; the runbook has the line.
# =============================================================================

locals {
  # 180 days, the estate's rule for a hand-renewed credential
  # (HAND_ROTATION_DAYS in functions/src/lib/credentials/register.js, the
  # owner's decision of 2026-10-09). Microsoft recommends a client secret
  # live less than 12 months:
  # https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials
  muse_reader_secret_days = 180

  # How long a secret outlives its rotation date (see time_static below).
  muse_reader_secret_grace_days = 30

  muse_reader_name = "sp-muse-reader-plat-${var.environment}-${var.region_abbreviation}-${var.instance}"
}

# The run identity's own object id and the tenant, read from its token; no
# Graph call. Used for the owner list (an Application Developer can change
# only the apps it owns) and for the tenant output.
data "azuread_client_config" "current" {
  count = var.muse_reader_enabled ? 1 : 0
}

resource "azuread_application" "muse_reader" {
  count = var.muse_reader_enabled ? 1 : 0

  display_name     = local.muse_reader_name
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azuread_client_config.current[0].object_id]
  notes            = "Muse (Koda) read-only access to the HCW Azure estate: Reader on every subscription. Managed by Terraform, infra/muse-reader.tf (#1763). Runbook: docs/runbooks/muse-azure-reader.md."
}

resource "azuread_service_principal" "muse_reader" {
  count = var.muse_reader_enabled ? 1 : 0

  client_id = azuread_application.muse_reader[0].client_id
  owners    = [data.azuread_client_config.current[0].object_id]
}

# The secret's start date. It changes only when the owner raises
# var.muse_reader_secret_generation, so the secret is replaced only on a run
# the owner chose, never by an unrelated merge's apply. (A time_rotating here
# would drop out of state after 180 days and make the next estate-wide apply,
# whoever started it, delete the secret Muse is using.)
resource "time_static" "muse_reader_secret" {
  count = var.muse_reader_enabled ? 1 : 0

  triggers = {
    generation = tostring(var.muse_reader_secret_generation)
  }
}

# The secret works for 180 + 30 days. The credential register's reminder is
# due at day 180 and asks for a rotation (raise the generation, apply, copy
# the new value to Muse); the 30 days are the slack before Muse is locked
# out. A rotation deletes the old secret in the same apply.
resource "azuread_application_password" "muse_reader" {
  count = var.muse_reader_enabled ? 1 : 0

  application_id = azuread_application.muse_reader[0].id
  display_name   = "muse-reader-${var.muse_reader_secret_generation}"
  end_date       = timeadd(time_static.muse_reader_secret[0].rfc3339, "${(local.muse_reader_secret_days + local.muse_reader_secret_grace_days) * 24}h")

  rotate_when_changed = {
    generation = time_static.muse_reader_secret[0].id
  }
}

# Reader on each whole subscription, one block per subscription so each goes
# through that subscription's provider, as everything else here does.
# principal_type is explicit because the principal is created in the same
# apply: without it ARM looks the id up in Entra first and can miss one that
# has not replicated yet (as for arc_onboarding).
resource "azurerm_role_assignment" "muse_reader_app" {
  count = var.muse_reader_enabled ? 1 : 0

  scope                = "/subscriptions/${var.subscription_app}"
  role_definition_name = "Reader"
  principal_id         = azuread_service_principal.muse_reader[0].object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "muse_reader_mgmt" {
  count    = var.muse_reader_enabled ? 1 : 0
  provider = azurerm.mgmt

  scope                = "/subscriptions/${var.subscription_mgmt}"
  role_definition_name = "Reader"
  principal_id         = azuread_service_principal.muse_reader[0].object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "muse_reader_conn" {
  count    = var.muse_reader_enabled ? 1 : 0
  provider = azurerm.conn

  scope                = "/subscriptions/${var.subscription_conn}"
  role_definition_name = "Reader"
  principal_id         = azuread_service_principal.muse_reader[0].object_id
  principal_type       = "ServicePrincipal"
}

# The client id and tenant id are identifiers, not secrets: they say who Muse
# signs in as, and only the secret proves it. Null while the switch is off.
output "muse_reader_client_id" {
  description = "Client (application) id of the Muse read-only app registration; null until muse_reader_enabled"
  value       = var.muse_reader_enabled ? azuread_application.muse_reader[0].client_id : null
}

output "muse_reader_tenant_id" {
  description = "Entra tenant the Muse read-only app registration signs in to; null until muse_reader_enabled"
  value       = var.muse_reader_enabled ? data.azuread_client_config.current[0].tenant_id : null
}

# The one secret this configuration outputs on purpose (outputs.tf's header
# names it). Sensitive, so HCP Terraform and the CLI hide it unless asked by
# name with -raw or -json.
output "muse_reader_client_secret" {
  description = "Client secret for Muse's read-only app registration. Read once with `terraform output -raw muse_reader_client_secret` into Muse's vault; never print it."
  value       = var.muse_reader_enabled ? azuread_application_password.muse_reader[0].value : null
  sensitive   = true
}

output "muse_reader_secret_expires" {
  description = "When the current Muse secret stops working (RFC 3339); rotate before it by raising muse_reader_secret_generation"
  value       = var.muse_reader_enabled ? azuread_application_password.muse_reader[0].end_date : null
}

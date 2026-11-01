# =============================================================================
# budget.tf — the subscription budgets. Staying inside budget is a standing
# requirement on every deployment, not a gate that completes.
#
# Split out of main.tf on 2026-08-29 (T-754). Terraform reads every .tf file in
# this directory as ONE module: same namespace, same state, same plan. Nothing
# moved between states and no resource address changed — an empty plan is the
# proof, and `functions/test/terraform-source.js` is why the text-reading guards
# did not need to care.
# =============================================================================

# =============================================================================
# Budget Alert (replaces GCP billing export + budget alert)
# =============================================================================
# Scoped to the SUBSCRIPTION, not a resource group. It was resource-group
# scoped while the workload was one group; splitting into six by service
# category would have left the budget watching whichever one it was pinned to
# and silently ignoring the other five — a budget that under-reports is worse
# than none, because it reads as reassurance. The application subscription is
# now the boundary that means "this workload", so that is what it watches.
#
# contact_groups crosses a subscription boundary: the budget lives in App, the
# action group in Management. This said the ARM API "doubtfully" supported that
# until 2026-08-24; the doubt is half resolved and the half that remains is the
# half that matters. This budget applied, so ARM ACCEPTS the reference. Whether
# a notification is ever DELIVERED through it is still unobserved, and this
# resource cannot tell anyone: contact_emails below is an independent path, so
# the mail arrives either way and an inert action group looks identical to a
# working one from here.
#
# That indifference is exactly what the alert rules in observability.tf do not
# have — they can only route through an action group — so the delivery test
# belongs there, and the note in that file's Alert rules header says how.
# The first of the month this plan runs in, in UTC, unless
# var.budget_start_date pins a date (#820). Until #820 the variable's default
# was a literal, 2026-08-01, that had to be moved by hand before any apply that
# CREATES a budget: a fresh subscription, a rebuild, or a forced replacement.
# From September on, that apply would have failed at the end of the graph, for
# a reason unrelated to the change being applied. plantimestamp() is fixed for
# the whole plan, and the budgets ignore the attribute once they exist, so a
# stale literal and a monthly diff are both gone.
locals {
  budget_start_date = coalesce(
    var.budget_start_date,
    formatdate("YYYY-MM-01'T00:00:00Z'", plantimestamp()),
  )
}

resource "azurerm_consumption_budget_subscription" "hcw" {
  name            = "${var.workload_name}-monthly-budget"
  subscription_id = "/subscriptions/${var.subscription_app}"
  amount          = var.budget_amount_usd
  time_grain      = "Monthly"

  # Azure rejects a monthly budget whose start date is before the current
  # month (400: "Start date for monthly time grain should not be prior to
  # current month"), so this is not a free-form "when we started" field. It
  # is local.budget_start_date: the first of the month the plan runs in,
  # unless the variable pins one (#820).
  time_period {
    start_date = local.budget_start_date
  }

  # The start date matters only on create. Ignoring it afterwards keeps an
  # existing budget from planning a replacement every month, which a date
  # taken from the plan's clock would otherwise do.
  lifecycle {
    ignore_changes = [time_period[0].start_date]
  }

  # T-505: the approved threshold ladder (50/75/90/100 actual + forecast),
  # routed through the ops action group as well as direct email. Five
  # notifications is the budget API's maximum.
  dynamic "notification" {
    for_each = [50, 75, 90, 100]
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThanOrEqualTo"
      threshold_type = "Actual"
      contact_emails = [var.budget_alert_email]
      contact_groups = [azurerm_monitor_action_group.ops.id]
    }
  }

  # Forecasted overrun fires before the money is spent — the alert that
  # actually leaves time to act.
  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_emails = [var.budget_alert_email]
    contact_groups = [azurerm_monitor_action_group.ops.id]
  }
}

# The second budget, because the first one is scoped to a subscription that
# does not contain the platform's most variable cost.
#
# The workload subscription is where almost everything lives, and almost
# everything there is serverless and near-free at this traffic. The one line
# that scales with load rather than with inventory is Log Analytics ingestion —
# and the workspace bills in Platform Management, which had no budget at all.
# So the thing worth watching was the thing nothing watched, and the estate
# would have looked in-budget right up to a surprise.
#
# `provider = azurerm.mgmt` for the same reason the workspace and the action
# group carry it: subscription_id below names the scope, but the provider
# decides which subscription the ARM call goes to, and without the alias this
# is written into the application subscription — where the name would collide
# with nothing and simply watch the wrong thing.
#
# Deliberately NOT scoped to the resource group. A subscription budget catches
# a cost that appears somewhere nobody expected, which is the case a budget is
# for; a resource-group budget silently ignores everything outside it.
#
# Same threshold ladder as the workload budget, and the same action group, so
# the two read identically in the inbox and neither needs its own runbook.
resource "azurerm_consumption_budget_subscription" "platform_mgmt" {
  provider = azurerm.mgmt

  name            = "plat-mgmt-monthly-budget"
  subscription_id = "/subscriptions/${var.subscription_mgmt}"
  amount          = var.budget_amount_mgmt_usd
  time_grain      = "Monthly"

  time_period {
    start_date = local.budget_start_date
  }

  lifecycle {
    ignore_changes = [time_period[0].start_date]
  }

  dynamic "notification" {
    for_each = [50, 75, 90, 100]
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

# =============================================================================
# The Cost page reads what these budgets read (ADR 0039)
# =============================================================================
# The admin Cost page (functions/src/lib/cost/azure.js) shows each budget's
# current and forecast spend and the month's cost by service, read with the
# Function App's own managed identity. That identity needs the built-in Cost
# Management Reader role (every read under Microsoft.Consumption and
# Microsoft.CostManagement, nothing that changes anything) on the application
# and Platform Management subscriptions.
#
# THAT GRANT IS NOT DECLARED HERE, ON PURPOSE. It sits at subscription scope,
# and since SEC-1 step two the Terraform identity creates no role assignment
# above a declared resource group: its RBAC Administrator condition refuses
# only Owner, Contributor and the Key Vault officer roles, so a subscription
# grant from this module would be a widening the condition does not stop
# (scripts/terraform-identity-grants.test.mjs holds that). The owner makes the
# two assignments once, by hand, as for the custom reader roles in
# infra/roles/: the commands are in docs/runbooks/cost.md. Until they exist the
# page says the Azure figures cannot be read and names the missing role.

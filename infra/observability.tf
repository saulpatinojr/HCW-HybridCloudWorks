# =============================================================================
# observability.tf — the plan's operational alarm fabric (T-505, closed —
# CHANGELOG.md)
#
# Action group, diagnostic settings, and the alert rules that route through it.
#
# The rules were held back until they could land with the evidence that
# motivated their thresholds. That evidence arrived on 2026-08-24, from a
# readiness review that found ZERO alert rules of any kind in either
# subscription — `az monitor metrics alert list`, `scheduledQueryRules`,
# `webtests` and `activity-log alert list` all returned empty — while the
# workspace those rules would have read from was simultaneously OverQuota. So
# the platform was both unmonitored and silently dropping the telemetry that
# would have shown it. Both halves are fixed here.
#
# Ingestion from every diagnostic setting here lands in the Log Analytics
# workspace, which carries a 0.25 GB/day cap (main.tf). The cap is the cost
# ceiling for this whole file. It is no longer a ceiling anyone has to
# remember: `logs_daily_cap` below fires at 80% of whatever the cap is set to,
# derived from the workspace resource so the two cannot drift.
#
# THRESHOLD HONESTY. Every threshold in this file is a first estimate, not an
# incident-derived number — there has never been an alert here to be wrong.
# Each one says what it assumes. Tune them against the first week of real
# firing rather than leaving an estimate in place because it is written down.
# =============================================================================

# One ops action group; the budget and future alert rules all route here so
# changing who gets paged is one edit, not five.
resource "azurerm_monitor_action_group" "ops" {
  # Follows its resource group into the Management subscription — without the
  # alias the ARM call goes to the application subscription and fails with
  # ResourceGroupNotFound.
  provider = azurerm.mgmt

  name                = "ag-plat-${var.environment}-${var.region_abbreviation}-${var.instance}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  short_name          = "hcw-ops"

  email_receiver {
    name                    = "ops-email"
    email_address           = var.budget_alert_email
    use_common_alert_schema = true
  }

  # Second channel (T-709, closed 2026-08-30). Without it every alert in the
  # estate had exactly one delivery path, and one receiver is a single point of
  # silence for the whole alerting fabric. Both receivers have been observed
  # delivering: a CLI test notification reached ops-email and then ops-sms on
  # 2026-08-30 (CHANGELOG.md, "Observe an alert actually being delivered").
  #
  # dynamic, not conditional count: an empty ops_sms_receiver produces no block
  # at all, so the action group is byte-identical to what exists today and the
  # variable can be set later without a resource replacement.
  dynamic "sms_receiver" {
    for_each = var.ops_sms_receiver.phone_number == "" ? [] : [var.ops_sms_receiver]
    content {
      name         = "ops-sms"
      country_code = sms_receiver.value.country_code
      phone_number = sms_receiver.value.phone_number
    }
  }

  tags = local.tags
}

# Key Vault — who touched the vault. AuditEvent is the category the plan
# names; it is low-volume and high-value.
resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "diag-kv-to-logs"
  target_resource_id         = azurerm_key_vault.hcw.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

# Cosmos — ControlPlaneRequests ONLY, down from the four categories the
# approved plan named. The other three were pruned on 2026-08-24 because they
# were the reason the workspace stopped ingesting anything at all.
#
# The workspace was found in dataIngestionStatus OverQuota against a 0.25
# GB/day cap. Three days of `Usage` show where the volume goes:
#
#   AppTraces                      0.284 GB
#   CDBDataPlaneRequests           0.268 GB
#   CDBPartitionKeyRUConsumption   0.076 GB
#   AppRequests                    0.002 GB
#   AppExceptions                  0.002 GB
#
# READ THOSE AS A FLOOR, NOT A MEASUREMENT. They were sampled while the cap was
# already tripping, so every one of them is what survived the cap rather than
# what the source produced, and the shortfall is not distributed evenly — the
# cap stops collection mid-day, so a high-rate table loses proportionally more
# than a low-rate one. The list is also partial: it excludes AzureMetrics and
# the StorageRead/StorageWrite/StorageDelete categories the content_blob
# setting below ships, both of which land in the same workspace. An independent
# reading of the same period put the real figures roughly 20% away from these.
#
# What the numbers are good enough to establish is the ORDERING, which is the
# whole basis of the change: two Cosmos data-plane categories dominate, and the
# two tables an incident is actually read from are a rounding error that was
# being dropped anyway. Removing DataPlaneRequests, PartitionKeyRUConsumption
# and QueryRuntimeStatistics is therefore a large reduction — it is NOT a
# reduction to a number anyone can state in advance.
#
# CONFIRM AFTER APPLY, do not assume. Once ingestion has run uncapped for a
# full day, re-run the daily-cap usage query (the one in the logs_daily_cap
# rule below reports the same figure) and check the result against the cap. If
# it is not comfortably under, the next lever is AppTraces via host.json
# logLevel — see the sampling note on azurerm_application_insights.hcw in
# main.tf — and not another diagnostic category.
#
# WHAT THIS COSTS, stated plainly rather than buried: DataPlaneRequests was the
# per-request audit record of who read what. Losing it means a data-access
# question can no longer be answered from logs. The trade was made because a
# capped workspace answers no questions at all, and because the firewall
# (main.tf) already restricts callers to the Functions subnet and named
# operator windows. If the audit trail becomes a requirement, the answer is a
# dedicated table with a longer cap or an ingestion-time transformation that
# keeps only writes — not switching this category back on under a 0.25 GB cap.
#
# ControlPlaneRequests stays: it records firewall, key and configuration
# changes to the account, it is near-zero volume, and it is the category that
# would show an unexpected change to the account's security posture.
resource "azurerm_monitor_diagnostic_setting" "cosmos" {
  name                           = "diag-cosmos-to-logs"
  target_resource_id             = azurerm_cosmosdb_account.hcw.id
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.hcw.id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "ControlPlaneRequests"
  }

  # DataPlaneRequests enabled with ingestion-time table transformation below
  # (PLAT-8, #968). By filtering to PII containers only, data access auditing is
  # preserved for personal data records without blowing past the workspace cap.
  enabled_log {
    category = "DataPlaneRequests"
  }
}

# Ingestion-time transformation for Cosmos DB data-plane requests (PLAT-8, #968).
# Ingests only operations on PII containers ('ambassador'), dropping the
# high-volume telemetry from non-sensitive collections that previously exhausted the daily cap.
resource "azapi_update_resource" "cosmos_data_plane_table" {
  type        = "Microsoft.OperationalInsights/workspaces/tables@2022-10-01"
  resource_id = "${azurerm_log_analytics_workspace.hcw.id}/tables/CDBDataPlaneRequests"

  body = {
    properties = {
      plan                 = "Analytics"
      retentionInDays      = var.logs_retention_in_days
      totalRetentionInDays = var.logs_retention_in_days
      transformKql         = "source | where CollectionName in ('ambassador') or ContainerName in ('ambassador')"
    }
  }

  depends_on = [
    azurerm_monitor_diagnostic_setting.cosmos,
  ]
}

# Content storage, blob service — read/write/delete against the media the
# Function App serves publicly. Logged at the blob sub-resource because the
# account level only exposes metrics.
resource "azurerm_monitor_diagnostic_setting" "content_blob" {
  name                       = "diag-content-blob-to-logs"
  target_resource_id         = "${azurerm_storage_account.hcw.id}/blobServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id

  enabled_log {
    category = "StorageRead"
  }

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }

  enabled_metric {
    category = "Transaction"
  }
}

# Content storage, queue service — read/write/delete, the categories checkov
# CKV_AZURE_33 asks for. Measured 2026-09-14 at zero queue transactions a day on
# this account (the job queues live on the host account below), so this costs
# nothing today and records whatever starts using it.
resource "azurerm_monitor_diagnostic_setting" "content_queue" {
  name                       = "diag-content-queue-to-logs"
  target_resource_id         = "${azurerm_storage_account.hcw.id}/queueServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id

  enabled_log {
    category = "StorageRead"
  }

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }
}

# Functions host storage, queue service — all three categories. The job queues
# and the host's own queue polling. Measured 2026-09-14: about 8,700
# transactions a day (8,500 of them GetQueueMetadata), roughly 10 MB/day at the
# 1.08 KB average StorageBlobLogs row this workspace already holds.
resource "azurerm_monitor_diagnostic_setting" "functions_queue" {
  name                       = "diag-func-queue-to-logs"
  target_resource_id         = "${azurerm_storage_account.functions.id}/queueServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id

  enabled_log {
    category = "StorageRead"
  }

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }
}

# Functions host storage, blob service — writes and deletes, NOT reads.
#
# Measured over one day on 2026-09-14 (Transactions by ApiName): GetBlob
# 409,304, GetBlobProperties 139,323, ListContainers 24,966 — about 573,000
# reads, all the host's own OAuth traffic — against about 20,000 writes and
# deletes (RenewBlobLease 14,792, CreateContainer 2,856, PutBlob 877, lease
# acquire/release 1,260). At 1.08 KB a row, reads alone would be ~0.6 GB/day
# against a 0.25 GB/day workspace cap that ingested 0.107 GB/day that week. The
# cap would trip daily, and a tripped cap stops the log alert rules
# (function_http_5xx, function_response_time) along with everything else.
#
# Writes and deletes are the security-relevant half on this account: a new
# release package, a container created or removed, a lease taken. About
# 22 MB/day, which with the queue setting above leaves ingestion near 56% of
# the cap, under the 80% logs_daily_cap alert. ADR 0031 records the trade; the
# read logs need their own destination (an archive account) or a larger cap,
# not this workspace.
resource "azurerm_monitor_diagnostic_setting" "functions_blob" {
  name                       = "diag-func-blob-to-logs"
  target_resource_id         = "${azurerm_storage_account.functions.id}/blobServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.hcw.id

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }
}

# There is no Azure OpenAI diagnostic setting, because there is no Azure
# OpenAI account: model calls go to external provider APIs (see the app
# settings in main.tf). Their request logs live with the provider, not here.

# =============================================================================
# Alert rules
#
# All of them route to azurerm_monitor_action_group.ops above, for the reason
# that action group exists: changing who gets paged is one edit, not eight.
#
# CROSS-SUBSCRIPTION ACTION GROUP, AND EXACTLY WHAT IS PROVEN ABOUT IT. The
# action group lives in the Management subscription; every rule below that
# watches a workload resource has to be created in the APPLICATION
# subscription, because an Azure Monitor alert rule sits in the same
# subscription as the resource it scopes. So every one of these references
# crosses a subscription boundary.
#
# The rules here have no second path. azurerm_monitor_metric_alert and
# azurerm_monitor_scheduled_query_rules_alert_v2 can only route through an
# action group — there is no per-rule email field to fall back to. So if the
# reference were accepted and silently inert, this file would produce alert
# rules that exist, make `az monitor metrics alert list` non-empty, and page
# nobody: strictly WORSE than the visible emptiness this file was written
# against, because it looks fixed. That is why delivery had to be seen, not
# inferred from an accepted apply.
#
# It has been seen, on both halves of the path:
#
#   - The hop. alert-app-exceptions-prod-cus, a rule in the application
#     subscription, fired at 23:06 UTC on 2026-08-25 and its mail arrived
#     every five to ten minutes until it was made stateful (CHANGELOG.md,
#     "The alert rules re-notified every five minutes").
#   - The receivers. A CLI test notification
#     (`az monitor action-group test-notifications create`) reached ops-email
#     and then ops-sms on 2026-08-30 (CHANGELOG.md, "Observe an alert actually
#     being delivered"). The portal's "Test action group" button reported
#     Unknown and delivered nothing the same day; use the CLI.
#
# The budget was never evidence either way, because it also carries
# contact_emails as an independent path. Re-prove delivery the same way after
# any change to this action group: docs/runbooks/alerting-and-support.md,
# "Delivery is proven, on both channels", has the commands.
#
# WHERE THEY LIVE. Every application-subscription rule is in the `web` resource
# group, next to Application Insights, rather than beside the resource it
# watches. "What pages us" is then one list in one place instead of a rule
# hiding in each service's group.
#
# METRIC ALERTS OVER LOG ALERTS, where there is a choice. A log alert reads the
# Log Analytics workspace, so it goes silent exactly when the workspace stops
# ingesting — which is the failure this file was rewritten to fix. Platform
# metrics are not ingested into the workspace, are not billed by the GB, and
# keep evaluating through an OverQuota window. Only the two conditions with no
# metric equivalent (application exceptions, workspace capacity) are log alerts.
# =============================================================================

# ---------------------------------------------------------------------------
# Identities for the two log alert rules
# ---------------------------------------------------------------------------
#
# A scheduled query rule with no identity runs as whoever last edited it.
# Microsoft: "If you don't use a managed identity, the alert rule will inherit
# the permissions of the last user or service principal who edited it, based on
# their permissions at the time of that edit." Here that would be the HCP
# Terraform run principal, frozen at apply time, recorded nowhere in this
# configuration and invisible in the portal.
#
# That is a bad property for any rule and an actively dangerous one for
# logs_daily_cap, whose entire job is that the workspace cap cannot trip
# quietly again. A rule running on borrowed, unrecorded permissions fails
# SILENTLY when those permissions lapse — and the thing it was watching for is
# itself silent. Two silences on top of each other is how the original
# OverQuota went unnoticed.
#
# TWO IDENTITIES, NOT ONE, and that is not symmetry for its own sake. The rules
# sit in different subscriptions, and Microsoft's managed identity FAQ is
# explicit: "If you need to use a managed identity in a different resource
# group or subscription, you would need to create a new user-assigned managed
# identity and assign the necessary permissions to it." Attaching one identity
# across the boundary is not a supported shape, and this apply cannot be
# rehearsed. Separating them also draws a real line: the platform capacity
# alert's identity cannot read application telemetry, and the application
# alert's identity cannot read anything in Management beyond the workspace.
#
# USER-ASSIGNED, NOT SYSTEM-ASSIGNED, because of ordering. Microsoft describes
# system-assigned as "This identity has no permissions... AFTER you create the
# rule, you must assign permissions", and user-assigned as "BEFORE you create
# the alert rule, you create an identity and assign it appropriate permissions".
# Only the second can be expressed as one deterministic apply. It also avoids a
# documented trap: managed identity tokens are cached per resource URI for
# around 24 hours and "it can take several hours for changes to a managed
# identity's permissions to take effect" — so granting a role after the
# identity has already been refused once is not reliably a quick fix.
#
# The depends_on on each rule is what actually enforces the ordering. Without
# it Terraform sees the rule depend on the IDENTITY (through identity_ids) and
# not on the role assignment, and is free to create the rule first — which
# throws away the only reason to prefer user-assigned. Role assignment
# propagation is still eventually consistent, so a first apply can occasionally
# fail query validation on a role that has not landed yet; re-applying is the
# fix, and it converges rather than needing repair.

resource "azurerm_user_assigned_identity" "alerts_mgmt" {
  provider = azurerm.mgmt

  name                = "id-plat-alerts-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.platform_mgmt.location
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "alerts_app" {
  name                = "id-${var.workload_name}-alerts-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  tags                = local.tags
}

# LOG ANALYTICS READER RATHER THAN READER OR MONITORING READER, and the
# difference is a credential rather than a preference. All three carry `*/read`
# and so all three satisfy the documented requirement, which is a "reader role
# for all workspaces that the query accesses". Only Log Analytics Reader
# carries `notActions: Microsoft.OperationalInsights/workspaces/sharedKeys/read`.
# On a Log Analytics workspace those shared keys are the INGESTION keys: a
# principal holding them can write arbitrary data into this workspace, which
# means forging or drowning the very telemetry these rules read. Reader and
# Monitoring Reader both hand that to an alert rule that needs to run a query.
#
# The alias on the two workspace grants is belt and braces. A role assignment
# addresses its scope by absolute resource ID, so in principle the subscription
# is already in the scope and the provider's own never enters the call — but
# every other Management-subscription write in this file carries the alias, and
# a reader should not have to know how the provider parses a scope in order to
# know which subscription a GRANT lands in. It costs nothing if it is redundant
# and it is the difference between an apply and a support ticket if it is not.
resource "azurerm_role_assignment" "alerts_mgmt_workspace" {
  provider = azurerm.mgmt

  scope                = azurerm_log_analytics_workspace.hcw.id
  role_definition_name = "Log Analytics Reader"
  principal_id         = azurerm_user_assigned_identity.alerts_mgmt.principal_id
}

# The application rule needs the workspace too, not just the component. The
# component is workspace-based: AppExceptions rows physically live in the
# Management-subscription workspace, and the documented requirement covers
# every workspace a query reaches "even if those workspaces are in different
# subscriptions".
resource "azurerm_role_assignment" "alerts_app_workspace" {
  provider = azurerm.mgmt

  scope                = azurerm_log_analytics_workspace.hcw.id
  role_definition_name = "Log Analytics Reader"
  principal_id         = azurerm_user_assigned_identity.alerts_app.principal_id
}

# And on the component itself, which is the rule's scope. Monitoring Reader
# here rather than Log Analytics Reader: on a microsoft.insights/components
# scope the two are functionally identical — the workspace-specific actions in
# Log Analytics Reader have nothing to act on and its sharedKeys notAction
# excludes nothing — so the tie is broken by which one names the job.
resource "azurerm_role_assignment" "alerts_app_component" {
  scope                = azurerm_application_insights.hcw.id
  role_definition_name = "Monitoring Reader"
  principal_id         = azurerm_user_assigned_identity.alerts_app.principal_id
}

# ---------------------------------------------------------------------------
# Function App — the API is returning errors
# ---------------------------------------------------------------------------
#
# Http5xx counts responses the PLATFORM saw as 5xx, which includes the ones the
# app never got to answer: a host that failed to start, a cold start that timed
# out, a worker that died mid-request. That is deliberately wider than
# AppExceptions below, and the two are not redundant — a 500 with no exception
# is the host, an exception with no 500 is a handler that caught and degraded.
#
# THRESHOLD ASSUMPTION: more than 5 server errors in 15 minutes. This app
# scales to zero and a cold start can fail a request, so one or two in a window
# is noise. Nothing has fired yet to calibrate this; if the first week is
# quiet, lower it.
# A LOG rule, not a metric alert. Flex Consumption does not publish HTTP
# metrics at all: `az monitor metrics list-definitions` on this app returns
# exactly nine names, all execution and memory counters, and Http5xx is not
# among them. Http5xx and HttpResponseTime belong to App Service and Elastic
# Premium plans. ARM rejects the metric alert outright -- "Couldn't find a
# metric named Http5xx" -- which is how this was found, on the first apply
# (2026-08-25), after four reviews had all assumed the metric existed.
#
# The cost of the switch is real and worth stating: a log rule stops evaluating
# when the workspace hits its daily cap, so this alert is silent in exactly the
# condition alert-logs-capacity exists to catch. There is no metric alternative
# on this plan, so that capacity alert is now load-bearing rather than a
# nice-to-have.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "function_http_5xx" {
  name                = "alert-func-http5xx-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "Function App returned more than 5 HTTP 5xx responses in 15 minutes."
  severity            = 1

  evaluation_frequency = "PT5M"
  # PT15M: more than 5 server errors in any 15 minutes, as the description
  # says. Evaluated every 5 minutes, so a burst is seen within 5 minutes of
  # its sixth error. A handful of isolated 500s spread across an hour stays
  # below it, which is the point of a threshold on a count rather than on a
  # single error.
  #
  # This read PT30M from #250 (2026-08-28) until #816. That change carried
  # T-745's reasoning about the availability probe (six probe results per 30
  # minutes, firing below 3) onto this rule, which counts requests and has no
  # expected-result arithmetic at all. Doubling the window at the same
  # threshold made the rule twice as sensitive as its description, and the
  # probe got its own PT30M on 2026-09-01 (edge_probe_availability below).
  window_duration = "PT15M"

  # Stateful for the reason set out on alert-app-exceptions below: stateless is
  # the azurerm default and re-notifies every evaluation. Same frequency, same
  # threshold, same detection — one mail per incident instead of one every five
  # minutes until it clears.
  auto_mitigation_enabled = true

  criteria {
    # Classic schema, because the scope is the component. toint() because
    # resultCode is a string here and a lexical compare would match "50" too.
    query                   = "requests | where toint(resultCode) >= 500"
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 5

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Function App — the API is slow
# ---------------------------------------------------------------------------
#
# HttpResponseTime, not AverageResponseTime: the latter is marked deprecated in
# the Microsoft.Web/sites metric reference and measures the same thing.
#
# THRESHOLD ASSUMPTION: mean response above 5 seconds sustained over 30
# minutes. The window is wider than the 5xx rule on purpose. Traffic here is
# low enough that a single cold start — seconds, on a plan with no always-ready
# instances by design (see the scale block in main.tf) — can dominate a short
# window's mean. Thirty minutes is long enough that one cold start cannot fire
# it and short enough to catch a genuinely degraded dependency.
# A log rule for the same reason as the 5xx rule above: HttpResponseTime is an
# App Service metric and Flex Consumption does not publish it.
#
# P95 rather than the mean the metric alert used. The original comment worried
# that one cold start could dominate a short window's mean on a plan with no
# always-ready instances -- with a percentile that concern mostly goes away,
# and a P95 over 30 minutes describes what users actually experienced rather
# than an average one outlier can drag.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "function_response_time" {
  name                = "alert-func-latency-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "Function App P95 response time above 5 seconds over 30 minutes."
  severity            = 2

  evaluation_frequency = "PT5M"
  window_duration      = "PT30M"

  # Stateful, as on the two rules above. It matters most here: the window is six
  # times the frequency, so a stateless version re-notifies for a full half hour
  # after latency has already recovered.
  auto_mitigation_enabled = true

  criteria {
    # duration is milliseconds in the classic schema; 5000 is the 5 seconds the
    # metric alert expressed in its own units.
    query                   = "requests | summarize P95DurationMs = percentile(duration, 95)"
    time_aggregation_method = "Average"
    metric_measure_column   = "P95DurationMs"
    operator                = "GreaterThan"
    threshold               = 5000

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Function App — the export window degrades the API (ADR 0019's revisit trigger)
# ---------------------------------------------------------------------------
#
# ADR 0019 ratified one Function App for the API and the schedulers and named
# the trigger to revisit it: "a scheduler workload measurably degrades API
# latency". Until PLAT-10 (#970) nothing measured that. The heaviest scheduler
# is the nightly Cosmos export (03:00 UTC, ADR 0028 §5), so this rule compares
# the API's P95 inside that window with its P95 across the rest of the same
# day, once a day, and fires when the window is slow both in absolute terms
# and against the day: P95 above 1 s, above twice the rest-of-day P95, over
# at least 20 requests, so one cold start cannot fire it and a quiet night
# says nothing.
#
# A RULE, NOT THE WEEKLY READOUT #970 ASKED FOR, on purpose. A readout from
# GitHub needs an identity that can query the workspace from outside Azure,
# and the owner declined exactly that shape for the GitHub identities on
# 2026-10-11 (oidc.tf, github_alert_reader: "query is a read action"). This
# rule runs as alerts_app, which already reads this component, and its mail
# carries the measurement in the alert's dimensions: both P95s and both
# request counts. A fire is the ADR's trigger met; the split returns
# worker-first, as the ADR says. Severity 3, the lowest in this file: the
# mail is the readout, and the rule fires at most once a day.
#
# `requests` and `duration` (milliseconds), the classic schema, because the
# scope is the component, as for alert-func-latency above. Only rows with a
# `url`: the Functions host writes the request URL for HTTP-triggered
# invocations and leaves it empty for timer and queue work, and the question
# is what the API's callers saw, not how long the export itself ran. The
# query anchors itself to the previous whole UTC day (Azure schedules a daily
# evaluation as an interval, not a clock time, so a trailing day could split
# one export window across two nights); the two-day lookback is what lets it.
# The dimensions are strings because dimension values are; the numbers are
# rounded first so the mail reads as milliseconds.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "export_window_latency" {
  name                = "alert-export-window-latency-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "The nightly Cosmos export window (03:00 to 03:45 UTC) degraded the API on the previous UTC day: its HTTP P95 was above 1 s and above twice the rest of the day's, over at least 20 requests. ADR 0019's revisit trigger, met; the split returns worker-first. The dimensions carry both P95s (ms) and both request counts."
  severity            = 3

  evaluation_frequency = "P1D"
  # Two days, so that whatever time of day the daily evaluation lands the
  # query can take the previous whole UTC day and find all of it.
  window_duration = "P2D"

  # Stateless: automatic mitigation is supported only up to a 12-hour
  # frequency. At one evaluation a day, stateless means at most one mail per
  # day the condition holds, which is the cadence wanted anyway.
  auto_mitigation_enabled = false

  criteria {
    query                   = <<-KQL
      requests
      | where timestamp >= startofday(now(), -1) and timestamp < startofday(now())
      | where isnotempty(url)
      | extend inWindow = hourofday(timestamp) == 3 and datetime_part("minute", timestamp) < 45
      | summarize windowP95 = percentile(iff(inWindow, duration, double(null)), 95),
                  windowRequests = countif(inWindow),
                  restP95 = percentile(iff(inWindow, double(null), duration), 95),
                  restRequests = countif(not(inWindow))
      | where windowRequests >= 20 and windowP95 > 1000 and windowP95 > 2 * restP95
      | project windowP95 = tostring(round(windowP95)), windowRequests = tostring(windowRequests), restP95 = tostring(round(restP95)), restRequests = tostring(restRequests)
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    dimension {
      name     = "windowP95"
      operator = "Include"
      values   = ["*"]
    }

    dimension {
      name     = "windowRequests"
      operator = "Include"
      values   = ["*"]
    }

    dimension {
      name     = "restP95"
      operator = "Include"
      values   = ["*"]
    }

    dimension {
      name     = "restRequests"
      operator = "Include"
      values   = ["*"]
    }

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Cosmos — the account is throttling
# ---------------------------------------------------------------------------
#
# THIS IS A METRIC ALERT AND NOT THE SCHEDULED QUERY RULE THE REVIEW ASKED FOR,
# and the reason is in the diagnostic setting above. A KQL rule for 429s would
# have to read CDBDataPlaneRequests, which is the category that was just
# removed for consuming a third of the daily cap. Restoring it to feed a
# throttling alert would re-create the OverQuota condition the alert exists to
# help with. The platform metric carries the same signal, costs no ingestion,
# and — unlike any log alert — keeps evaluating while the workspace is capped.
#
# TotalRequests split on StatusCode is the documented way to see 429s; there is
# no dedicated throttled-request metric on this account type. `Count` is the
# metric's own aggregation type, not a choice.
#
# THRESHOLD ASSUMPTION: more than 10 throttled requests in 15 minutes. The
# Cosmos SDK retries a 429 transparently, so a handful is invisible to callers
# and normal. Ten in a window means retries are no longer absorbing it. This
# account is serverless — there is no provisioned RU dial to turn up, so a
# firing alert points at the query or the partition key, not at throughput.
resource "azurerm_monitor_metric_alert" "cosmos_throttled" {
  name                = "alert-cosmos-throttle-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  scopes              = [azurerm_cosmosdb_account.hcw.id]
  description         = "Cosmos returned more than 10 HTTP 429 (throttled) responses in 15 minutes."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.DocumentDB/databaseAccounts"
    metric_name      = "TotalRequests"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 10

    dimension {
      name     = "StatusCode"
      operator = "Include"
      values   = ["429"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Application — handlers are throwing
# ---------------------------------------------------------------------------
#
# Scoped to the Application Insights component rather than the workspace, so
# the rule reads only this application's telemetry even after a second workload
# starts shipping to the same workspace.
#
# AppExceptions is 0.3% of the daily cap. It is also, with AppRequests, the
# table an incident is read from — which is exactly why the Cosmos categories
# were pruned above instead of this one, and why ingestion sampling was NOT
# turned on. See the sampling note on azurerm_application_insights.hcw in
# main.tf: it would apply to precisely these two tables and to nothing else.
#
# THRESHOLD ASSUMPTION: more than 5 exceptions in 15 minutes. Unhandled
# exceptions here are supposed to be rare, but one failing timer can emit
# several per run, so a bare "greater than zero" would page on a known-broken
# integration forever.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "app_exceptions" {
  name                = "alert-app-exceptions-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "More than 5 application exceptions in 15 minutes."
  severity            = 1

  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"

  # STATEFUL, and this attribute is the whole reason the mail volume dropped.
  # At the azurerm default (false) a log rule is STATELESS: it fires on every
  # evaluation whose condition is met, so at PT5M Azure sends a fresh Sev1 mail
  # every five to ten minutes for as long as exceptions keep arriving — and
  # because the window is three times the frequency, the same burst is counted
  # by three consecutive evaluations, so the mail continues for fifteen minutes
  # after the last exception. `alert-app-exceptions-prod-cus` did exactly that
  # on 2026-08-25, the first night these rules were live, which is how the
  # default was found to be the wrong one.
  #
  # Stateful means one alert per condition: it fires once, stays fired, and
  # resolves when the condition has not been met for three evaluation periods
  # (fifteen minutes here), sending one Resolved mail. The rule still evaluates
  # every five minutes against the same threshold — DETECTION IS UNCHANGED and
  # nothing is suppressed; only the repeats go. That is why this was the change
  # made without evidence: it costs no coverage. The levers that do cost
  # coverage — a filter on the query below, a higher threshold, a severity that
  # is not 1 — need a week of real firing to set, not a guess.
  #
  # Mutually exclusive with mute_actions_after_alert_duration. Since
  # 2026-10-16 that is left only to alert-lab-unit-failed, whose condition is
  # an event and not a state (ADR 0022 decision 6).
  auto_mitigation_enabled = true

  criteria {
    # No summarize and no metric_measure_column: the measure is table rows, so
    # the aggregation is Count and the query has to return the rows themselves.
    # `exceptions`, not `AppExceptions`. The scope below is the Application
    # Insights COMPONENT, and a component resolves the classic schema
    # (requests/exceptions/traces). `App*` names are the workspace schema and
    # are only resolvable when the rule scopes the workspace itself, which is
    # what alert-logs-capacity does. Getting this wrong is not a warning: ARM
    # rejects the create with "Failed to resolve table expression named
    # 'AppExceptions'", which is exactly how it was found (2026-08-25).
    query                   = "exceptions"
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 5

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  # Permissions before the rule, which is the entire reason this identity is
  # user-assigned. identity_ids alone orders the rule after the IDENTITY, not
  # after its grants.
  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Telegram — the owner's channel refused a message
# ---------------------------------------------------------------------------
#
# Every owner-facing notification in this app goes through one notifier
# (functions/src/lib/notify.js) and the notifier is best-effort by design: a
# refused delivery is a log line and the caller carries on. That was right for
# the callers and wrong for the owner. On 2026-10-06 the owner's Telegram
# account had the bot blocked, Telegram answered 403 to every send for the
# rest of the day — the lab-agent-offline message among them — and the only
# record was `[notify] Telegram API error 403` in traces, which nobody reads.
# A channel that fails silently is not a channel.
#
# This rule turns that log line into a page through the action group, which
# is SMS and mail, not Telegram, so it reaches the owner when Telegram does
# not. One refused send in an hour is enough: the notifier is never asked to
# send unless something already happened, so a refusal is never noise. Same
# component scope and identity as alert-app-exceptions above, for the same
# reasons.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "telegram_delivery" {
  name                = "alert-telegram-delivery-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "Telegram refused or failed a notification to the owner in the last hour. Check that the bot is not blocked and the chat id is current."
  severity            = 2

  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  # Stateful, as alert-app-exceptions: one page per incident. It stays fired
  # while any refusal sits inside the trailing hour, and then for Azure's own
  # resolution period on top — the condition unmet for three consecutive
  # evaluations, at this frequency forty-five minutes — so the Resolved mail
  # arrives roughly an hour and three quarters after the last refusal, not
  # after one hour. A refusal inside that interval joins the open incident
  # rather than paging again, which is the trade a stateful rule makes
  # (review of #914).
  auto_mitigation_enabled = true

  criteria {
    # The two lines notify.js writes when a send does not go: Telegram's own
    # refusal (a status code) and a thrown error (network, timeout). Classic
    # schema, because the scope is the component (see the note on the rule
    # above). Count, so the query returns the rows themselves.
    query                   = "traces | where message startswith \"[notify] Telegram API error\" or message startswith \"[notify] notifyTelegram failed\""
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Log Analytics — ingestion is approaching the daily cap
# ---------------------------------------------------------------------------
#
# THE POINT OF THIS RULE IS THAT THE CAP CANNOT TRIP QUIETLY AGAIN. The
# workspace was found OverQuota — dropping every table, including the ones
# every other rule in this file reads — with nothing anywhere saying so.
# Microsoft's guidance for the daily cap is an alert on
# `_LogOperation ... OverQuota`, but that fires once collection has ALREADY
# stopped. This one fires at 80% of the cap, while there is still headroom to
# prune a category or raise the ceiling deliberately.
#
# It can fire from inside a capped workspace, which no other log alert here
# can: the daily cap stops collection of BILLABLE tables, and `Usage` is not
# billable. That is also why the query filters IsBillable — unbillable rows do
# not count against the cap and must not count here either.
#
# THE RESET HOUR IS NOT THE DAY BOUNDARY. Azure assigns each workspace its own
# cap reset hour and it cannot be configured; this one resets at 08:00 UTC
# (quotaNextResetTime on the live workspace, read 2026-08-24). Summing from
# midnight would under-count for eight hours after every reset and over-count
# before it, so the window starts at the most recent reset instead:
# startofday(now() - 8h) + 8h is the last 08:00 UTC that has passed.
#
# No attribute on azurerm_log_analytics_workspace exposes the reset hour, so
# the 8 is a literal. If the workspace is ever recreated Azure may assign a
# different hour — check `az monitor log-analytics workspace show --query
# quotaNextResetTime` and correct it here.
#
# The threshold is DERIVED from the workspace's own cap so the two cannot
# drift. It reads the RESOURCE attribute, not the variable behind it, so
# raising logs_daily_quota_gb in the workspace moves this with it and no edit
# here is needed — which is what makes the T-719 measurement a variable change
# rather than a code change. It is also why that variable refuses -1: an
# unlimited workspace would put a negative number on the line below.
#
# Stateful since 2026-10-16 (ADR 0022 decision 6). Ingestion only goes up
# between resets, so once it is past 80% it stays past until the 08:00 UTC
# reset. Stateless, an hourly evaluation would mail every hour until then, so
# this muted for six hours. That still mailed up to four times a day, and it
# left an alert open for every hour over: twelve were open on 2026-10-16. The
# reasoning behind the mute was that there is nothing for auto-resolution to
# resolve, and that was wrong. The reset clears the condition, because
# WindowStart moves and the sum starts again. Stateful, a day over 80% is one
# alert, and it resolves two clear evaluations after the reset.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "logs_daily_cap" {
  provider = azurerm.mgmt

  name                = "alert-logs-capacity-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "Log Analytics billable ingestion has passed 80% of the daily cap since the last reset."
  severity            = 2

  evaluation_frequency = "PT1H"
  window_duration      = "P1D"

  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      let DailyCapResetHour = 8h;
      let WindowStart = startofday(now() - DailyCapResetHour) + DailyCapResetHour;
      Usage
      | where IsBillable
      | where StartTime >= WindowStart
      | summarize IngestedGb = sum(Quantity) / 1000.0
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "IngestedGb"
    operator                = "GreaterThan"
    threshold               = azurerm_log_analytics_workspace.hcw.daily_quota_gb * 0.8

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

# ---------------------------------------------------------------------------
# Availability — is the API answering at all, from outside Azure
# ---------------------------------------------------------------------------
#
# Every other rule in this file watches a resource that is up enough to emit
# telemetry. This is the only one that can tell the difference between "the API
# is healthy" and "nothing is reaching the API", because it asks from the
# outside, over the same Cloudflare path a browser uses.
#
# CREATED DISABLED, AND THAT IS NOT AN OVERSIGHT. Two independent reasons:
#
#   1. Bot Fight Mode. deploy-functions.yml carries the measurement: a
#      GitHub-hosted runner asking this host for /api/health is served
#      Cloudflare's "Just a moment..." interstitial and a 403, and that
#      challenge does not run on the Ruleset Engine — a WAF skip rule was
#      built, applied and confirmed INERT against it. Availability-test agents
#      are datacenter clients of exactly the same shape. Arming this before
#      that is settled most likely produces a rule that fires continuously and
#      is muted by whoever receives it, which is worse than no alert at all.
#   2. Standard tests bill PER EXECUTION, and the free URL ping test retires
#      2026-09-30. At the defaults below — 5 locations every 15 minutes — that
#      is 5 x 96 x 30 = 14,400 executions a month. Against a platform whose
#      entire current Azure spend is about USD 3.23 a month, that is not a
#      rounding error and it should be spent knowingly.
#
# TO ARM IT: give the availability agents a path through Cloudflare — the
# supported pattern is Microsoft's custom-header identifier below plus a
# Cloudflare rule that admits it, or the ApplicationInsightsAvailability
# service tag — confirm one execution succeeds, then set
# availability_test_enabled = true in the workspace. That one variable arms the
# test and creates the alert together: the alert is gated on the same variable,
# so that an inventory of alert rules cannot show a reachability alert that
# nothing can fire.
#
# The X-Customer-InstanceId header is Microsoft's documented way to prove a
# request came from THIS test rather than from anyone else sharing the
# availability service's IP addresses. It is set now so the Cloudflare rule has
# something to match on when someone writes it; it authenticates nothing on its
# own.
resource "azurerm_application_insights_standard_web_test" "api_health" {
  name                    = "webtest-api-health-${var.environment}-${var.region_abbreviation}"
  resource_group_name     = azurerm_resource_group.app["web"].name
  location                = azurerm_resource_group.app["web"].location
  application_insights_id = azurerm_application_insights.hcw.id
  description             = "GET /api/health through Cloudflare, from outside Azure."

  enabled       = var.availability_test_enabled
  frequency     = var.availability_test_frequency_seconds
  geo_locations = var.availability_test_geo_locations

  # About 80% of availability-test failures disappear on retry, so a failure is
  # only reported after three consecutive attempts fail at the same location.
  # This is what stops one dropped packet from paging.
  retry_enabled = true
  timeout       = 30

  request {
    url       = "https://api-azure.${var.domain}/api/health"
    http_verb = "GET"

    # The health endpoint returns JSON, not a page. Parsing dependent requests
    # would make the test stricter than the thing it is testing.
    parse_dependent_requests_enabled = false
    follow_redirects_enabled         = true

    header {
      name  = "X-Customer-InstanceId"
      value = "ApplicationInsightsAvailability:hcw-api-health"
    }
  }

  validation_rules {
    expected_status_code = 200

    # The certificate is Cloudflare's, and its expiry is not something this
    # configuration manages or can fix. A test that fails on a certificate
    # nobody here can renew reports someone else's problem as this API's
    # outage.
    ssl_check_enabled = false
  }

  tags = local.tags
}

# The alert on the test above.
#
# How many locations have to fail is DERIVED from how many there are, using
# Microsoft's stated relationship (locations - 2) — 3 of the 5 default
# locations. That is what distinguishes "the site is down" from "one agent's
# region has a network problem"; a lower number turns regional internet weather
# into a page. A floor of 2 keeps that true if someone trims the location list
# to save per-execution cost, where the formula alone would arrive at 1.
#
# Deriving it also means the location list and the vote cannot drift apart. A
# hardcoded 3 next to a shortened list is an alert that silently needs every
# location to fail.
#
# `scopes` names BOTH the web test and the component. That is not redundancy
# with the criteria block: Azure rejects an availability alert scoped to only
# one of the two.
#
# The window has to span at least two test cycles or the vote cannot be
# reached — at the default 900-second frequency a location reports roughly
# every 15 minutes, so a 15-minute window would count some locations zero times
# and the alert would simply never fire. Derived from the frequency variable
# for the same reason as the count above.
#
# Gated on the same variable as the web test it watches. Created unconditionally
# it would sit enabled against a disabled test, so `az monitor metrics alert list`
# would report six rules when only five can fire — and the inert one is
# reachability, the only signal that survives the app being completely down. An
# inventory that overstates coverage is worse than one rule fewer.
resource "azurerm_monitor_metric_alert" "api_availability" {
  count               = var.availability_test_enabled ? 1 : 0
  name                = "alert-api-availability-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  scopes              = [azurerm_application_insights_standard_web_test.api_health.id, azurerm_application_insights.hcw.id]
  description         = "GET /api/health failed from ${max(2, length(var.availability_test_geo_locations) - 2)} or more of ${length(var.availability_test_geo_locations)} availability test locations."
  severity            = 1
  frequency           = "PT5M"
  window_size         = var.availability_test_frequency_seconds <= 300 ? "PT15M" : "PT30M"

  application_insights_web_test_location_availability_criteria {
    web_test_id           = azurerm_application_insights_standard_web_test.api_health.id
    component_id          = azurerm_application_insights.hcw.id
    failed_location_count = max(2, length(var.availability_test_geo_locations) - 2)
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Availability, the path that works on this Cloudflare plan (ADR 0024)
# ---------------------------------------------------------------------------
#
# The standard web test above is the design; this is the one that can run.
# Bot Fight Mode 403s every datacenter client asking /api/health — Azure's
# availability agents included — and does not run on the Ruleset Engine, so no
# WAF rule exempts them (the block comment above carries the measurement). The
# alternative is edge/availability-probe: a Cloudflare Worker on a 5-minute
# cron, deployed by the owner with wrangler, whose subrequest to its own zone
# is the one external-shaped client Bot Fight Mode does not challenge. It
# reports every attempt to Application Insights as an availability result
# named edge-api-health — wrangler.toml's PROBE_NAME, which the query below
# must match verbatim.
#
# THE RULE COUNTS SUCCESSES AND FIRES ON TOO FEW, rather than counting
# failures. Counting failures has a blind spot exactly where it matters: a
# dead Worker, a disabled cron, or an unreachable ingestion endpoint produce
# no failure rows at all, and a failure-counting rule reads that silence as
# health. Counting successes makes "the probe stopped running" and "the API
# stopped answering" the same incident, which they are from a visitor's seat.
# The probe writes 6 results per 30-minute window; below 3 is an incident, so
# ingestion lag plus one dropped cron run is tolerated (T-745).
#
# THE WINDOW IS THE HALF OF THAT PAIR THAT GOT LEFT BEHIND, and it is recorded
# here because the rule read as fixed for four days while being worse than
# before. T-745 moved the threshold from 2 to 3 and rewrote every comment,
# `description` and wrangler.toml note to describe a 30-minute window — and
# left `window_duration` at PT15M. Three rows per window against a threshold of
# 3 tolerates NOTHING: one row landing a minute late is a Sev 1 on a healthy
# site, where the pre-T-745 shape (PT15M, threshold 2) at least tolerated one.
# Half a fix inverted the finding it closed. Corrected 2026-09-01, before the
# variable below was ever armed.
#
# A log rule, not a metric alert on availabilityResults/availabilityPercentage,
# for the same blind-spot reason: that metric goes silent when the probe dies,
# and a metric alert on a silent metric does not fire.
#
# Gated on its own variable rather than availability_test_enabled: the two
# paths arm independently, and arming THIS one first (or instead) is the
# expected order — it costs nothing per execution. The gate also has the same
# duty as every other in this file: created before the probe writes rows, the
# rule fires immediately and permanently, so the variable's description makes
# the observed success row the precondition for flipping it.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "edge_probe_availability" {
  count               = var.availability_probe_alert_enabled ? 1 : 0
  name                = "alert-api-reachability-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "Fewer than 3 of the expected 6 edge-probe successes for GET /api/health in 30 minutes — the API is unreachable over the Cloudflare path, or the probe itself is down. Either way nobody outside can confirm the site is up."
  severity            = 1

  evaluation_frequency = "PT5M"

  # PT30M, not PT15M, and it must stay paired with `threshold` below: at the
  # Worker's */5 cadence this window expects 6 rows and the threshold tolerates
  # 3 missing. Narrow it to PT15M and the same threshold expects 3 and tolerates
  # none. edge/availability-probe/wrangler.toml carries the same warning from
  # the cron's side — "change one and you must change the other" — and that is
  # exactly what went wrong here once already.
  window_duration = "PT30M"

  # Stateful like every other rule here (#226): reachability incidents are
  # exactly the kind that run long, and one mail per incident is the design.
  auto_mitigation_enabled = true

  criteria {
    # Classic schema, component scope, like the rules above. success == 1 in
    # availabilityResults; the name filter keeps a future second probe from
    # voting in this rule's window.
    query                   = "availabilityResults | where name == \"edge-api-health\" | where success == 1"
    time_aggregation_method = "Count"
    operator                = "LessThan"
    # 6 expected in a 30-minute window at a 5-minute cadence; below 3 is an
    # incident (T-745).
    threshold = 3

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Cosmos export — the missing-run alerts (ADR 0028 §5, #231)
# ---------------------------------------------------------------------------
#
# The exporter behind FEATURE_FLAG_COSMOS_EXPORT (functionapp.tf) runs at
# 03:00 UTC every day: a full read of every exported container on Sunday, the
# change feed since the previous run on the other six.
#
# "03:00 UTC" IS LOAD-BEARING IN THIS FILE AND WAS ONCE UNTRUE. The schedule
# is the bare NCRONTAB hour `0 0 3 * * *`, which means whatever the app clock
# means. Until 2026-09-07 that clock was WEBSITE_TIME_ZONE = America/Chicago,
# so the exporter actually ran at 08:00 UTC in summer and 09:00 in winter
# while every sentence here — and the daily rule's DESCRIPTION, which is what
# arrives in the alert mail — said 03:00 UTC. An operator reading that at
# 05:00 UTC would have gone looking for a run that was not due for another
# three hours (#416). The owner's answer was that all times in this app are
# UTC: the setting is gone, the app clock is the platform default, and these
# sentences became true rather than being rewritten. The guard against the
# setting coming back is
# functions/src/functions/timer-schedules-utc.test.js.
#
# A run that completes emits one Application Insights custom event named
# cosmosExportCompleted with customDimensions.mode set to "full" or "delta"
# — nothing else about the run is in the event, and nothing in these queries
# wants more. Success is silent and only absence pages, for the reason the
# edge-probe rule above gives: a dead timer, a flag left off, a poisoned queue
# and a failed write all produce NO rows, and a rule that counted failures
# reads every one of them as health.
#
# TWO DAYS IS AS FAR BACK AS A LOG ALERT CAN LOOK, and both rules are shaped
# by that. Azure caps a log search alert's query time range at two days —
# the window and the override alike — and says so plainly: "even if the query
# contains an ago command with a time range of longer than two days, the
# two-day maximum time range is applied". "No full in eight days" therefore
# cannot be written as an eight-day lookback. What can be written:
#
#   alert-cosmos-export-daily asks, once a day, whether ANY run completed in
#   the last two days. Any run, not delta alone as the ADR's shorthand has it:
#   Sunday's run is a full, so the gap between Saturday's delta and Monday's
#   is 48 hours — exactly the window — and an evaluation landing in the
#   minutes between those two completions would page about a healthy week.
#   Counting both modes makes the widest healthy gap 24 hours against 48.
#
#   alert-cosmos-export-full asks, on Mondays only, whether a full completed
#   in the last two days. A window that ends anywhere on Monday contains the
#   whole of Sunday, so a full that ran on schedule is inside it whatever
#   hour Azure evaluates at; on the other six days the query returns 0 and
#   the rule is quiet. The ADR's eight days of tolerance becomes "the Sunday
#   just gone" — stricter, and the reading the cap permits.
#
# STATELESS, unlike every other rule in this file, and not by choice. Azure
# does not allow auto-mitigation on a rule evaluated less often than every
# twelve hours ("Stateful alert rules can be configured with a frequency of
# up to 12 hours"), and these evaluate daily because what they watch happens
# daily. Each description states the consequence: the daily rule mails once
# a day until a run completes, the Monday rule once per missed Sunday.
# Neither resolves itself, and neither should — a late run is not the
# incident, a stale copy is, and it stays stale until the next good run.
#
# GATED ON cosmos_export_enabled, the variable that also sets the app flag,
# so the rules cannot exist while the exporter is off — the "created before
# the first row, fires on the first evaluation" trap the probe rule above
# describes. One variable closes most of it; the variable's description in
# variables.tf names the residue (the first evaluation may precede the first
# 03:00 UTC run, and a flag that arrives on a Sunday after 03:00 has no full
# for Monday to find).
#
# customEvents, not AppEvents: the scope is the component, which resolves the
# classic schema, exactly as the exceptions rule explains. customDimensions
# is a dynamic column, hence the tostring() before comparing.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "cosmos_export_daily_missing" {
  count               = var.cosmos_export_enabled ? 1 : 0
  name                = "alert-cosmos-export-daily-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "No Cosmos export run (full or delta) completed in the last 2 days — the 03:00 UTC exporter is not finishing and the out-of-account copy is going stale. Stateless: mails once a day until a run completes. ADR 0028."
  severity            = 2

  evaluation_frequency = "P1D"
  window_duration      = "P2D"

  # Stateful is refused above a 12-hour frequency; see the block comment.
  auto_mitigation_enabled = false

  criteria {
    query                   = "customEvents | where name == \"cosmosExportCompleted\" | where tostring(customDimensions.mode) in (\"full\", \"delta\")"
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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "cosmos_export_full_missing" {
  count               = var.cosmos_export_enabled ? 1 : 0
  name                = "alert-cosmos-export-full-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "No full Cosmos export completed on Sunday, checked each Monday over the trailing 2 days. Deltas since the last full keep accumulating and deletes stay unreconciled until the next full lands. Stateless: one mail per missed Sunday. ADR 0028."
  severity            = 2

  evaluation_frequency = "P1D"
  window_duration      = "P2D"

  auto_mitigation_enabled = false

  criteria {
    # A measured column rather than a row count, because the condition has a
    # day-of-week term the count form cannot express: the rule must be TRUE
    # only on a Monday with no full in the window, and FALSE — not merely
    # empty — on the other six days. `summarize count()` with no `by` returns
    # one row of 0 on empty input, so the measure is always exactly one value.
    # dayofweek() is a timespan from Sunday; 1d is Monday.
    #
    # THE COLUMN IS NOT CALLED `missing`, AND CANNOT BE. `missing` is a
    # reserved word in KQL, so `project missing = …` does not parse and Azure
    # rejects the whole rule at create time with
    #
    #   Query could not be parsed at 'missing' on line [5,11].
    #   A recognition error occurred in the query.
    #
    # naming the token and the position rather than saying the word is
    # reserved, which is the expensive kind of error message: line 5 column 11
    # is exactly where the column name starts, so it reads as a problem with
    # the expression that follows.
    #
    # It cost a partial apply on 2026-09-08. Terraform created
    # azurerm_monitor_scheduled_query_rules_alert_v2.cosmos_export_daily_missing
    # — `alert-cosmos-export-daily-prod-cus` as it exists in Azure today, the
    # `-${var.environment}-${var.region_abbreviation}` suffix resolved — and
    # set FEATURE_FLAG_COSMOS_EXPORT = "true", then failed on this resource,
    # leaving the exporter armed with only one of its two alerts. That is the
    # half-state the `count` gate on a single variable exists to prevent.
    #
    # Confirmed by isolation against the live component, not by reading docs:
    # `project gap = iff(fulls == 0, 1, 0)` parses, `project missing = fulls`
    # does not, and `extend missing = …` fails identically — so it is the name
    # and not the pipeline, the operator or the expression. Any non-reserved
    # name works; if this is ever renamed again, `metric_measure_column` below
    # must move with it, because the two are matched by string.
    query                   = <<-KQL
      customEvents
      | where name == "cosmosExportCompleted"
      | where tostring(customDimensions.mode) == "full"
      | summarize fulls = count()
      | project missing_full = iff(dayofweek(now()) == 1d and fulls == 0, 1, 0)
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "missing_full"
    operator                = "GreaterThan"
    threshold               = 0

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# =============================================================================
# PLAT-4 (#964): silence, the poison queue, the bandwidth ceiling, and the
# security conditions nothing paged on
# =============================================================================
#
# The estate assessment of 2026-10-06 found the rules above watching errors
# and latency while four kinds of failure stayed silent: a timer that stopped
# running, a job the queue gave up on, the Static Web App's monthly bandwidth
# running out, and every security-relevant change: role assignments, vault
# configuration, vault data writes, failed vault calls. Every rule below reads
# data the estate ALREADY collects (the diagnostic settings above, the
# Application Insights component, the Activity Log), so none of them adds a
# byte of ingestion against the 0.25 GB/day cap.
#
# Two shapes, chosen per condition for cost:
#
#   - Activity Log alerts for Azure Resource Manager writes. They are free
#     ("collection and alerting on the Activity log" carries no charge,
#     Microsoft's Azure Monitor cost page) and need no export: the Activity
#     Log is evaluated where it already is. Exporting it to the workspace
#     would add ingestion and a paid log rule for the same signal.
#   - Log search alerts for what only a log carries: data-plane vault calls,
#     queue writes, timer invocations, the agent-health trace. Each is a paid
#     rule (USD 0.50 a month at a 15-minute frequency, Azure Retail Prices
#     API, read 2026-10-10), which is why none runs more often than every 15
#     minutes.
#
# Workspace-scoped rules follow logs_daily_cap and the lab rules: Management
# provider, resource group and identity. Component-scoped rules follow the
# Telegram rule: application resource group, component scope, classic schema,
# alerts_app identity. Every one routes to the one action group, and every
# one is created ENABLED, which is why each has a way to make it fire once in
# docs/runbooks/alerting-and-support.md ("The PLAT-4 rules").

locals {
  # The schedule of every timer the Function App registers, as a period and a
  # moment the schedule is known to fire (an "anchor"), from which
  # alert-timer-overdue's query computes the last time each timer was due
  # ("HOW DUE IS COMPUTED", below). NCRONTAB beside each, read from the code;
  # all are UTC (#416).
  #
  # The set must equal the `timer` list in functions/function-inventory.json,
  # and each pair must match its NCRONTAB in functions/src/functions/:
  # functions/src/functions/timer-alert-schedules.test.js (`npm test` in
  # functions/) fails, naming the timer, when a
  # timer is added, removed or rescheduled without this map. 2026-01-01 was a
  # Thursday, so the weekly anchors are 2026-01-02 (Friday), 2026-01-04
  # (Sunday) and 2026-01-05 (Monday); the test checks each weekday too.
  timer_schedules = {
    buildWeeklyNewsletter       = { period = "7d", anchor = "2026-01-05 13:00" }  # 0 0 13 * * 1
    checkAgentHealth            = { period = "5m", anchor = "2026-01-01 00:00" }  # 0 */5 * * * *
    checkLiveLinks              = { period = "7d", anchor = "2026-01-05 06:00" }  # 0 0 6 * * 1
    cleanupRejectedContent      = { period = "1d", anchor = "2026-01-01 04:00" }  # 0 0 4 * * *
    cleanupSoftDeletedContent   = { period = "4h", anchor = "2026-01-01 00:00" }  # 0 0 */4 * * *
    cleanupTempStorage          = { period = "1d", anchor = "2026-01-01 00:00" }  # 0 0 0 * * *
    cleanupUnusedCertImages     = { period = "1d", anchor = "2026-01-01 05:00" }  # 0 0 5 * * *
    cosmosExportScheduler       = { period = "1d", anchor = "2026-01-01 03:00" }  # 0 0 3 * * *
    fetchBlogListings           = { period = "6h", anchor = "2026-01-01 00:15" }  # 0 15 */6 * * *
    fetchPodcastFeeds           = { period = "2h", anchor = "2026-01-01 00:30" }  # 0 30 */2 * * *
    forgeScheduled              = { period = "1d", anchor = "2026-01-01 03:30" }  # 0 30 3 * * *
    generateReviewerDigest      = { period = "1d", anchor = "2026-01-01 07:00" }  # 0 0 7 * * *
    healthPulse                 = { period = "5m", anchor = "2026-01-01 00:02" }  # 0 2-59/5 * * * *
    labCanary                   = { period = "1h", anchor = "2026-01-01 00:20" }  # 0 20 */1 * * *
    labsWeeklyRollup            = { period = "1d", anchor = "2026-01-01 23:55" }  # 0 55 23 * * *
    monitorPublishingPipeline   = { period = "6h", anchor = "2026-01-01 00:00" }  # 0 0 */6 * * *
    platformJobSweeper          = { period = "15m", anchor = "2026-01-01 00:00" } # 0 */15 * * * *
    probeAiProviders            = { period = "7d", anchor = "2026-01-05 06:15" }  # 0 15 6 * * 1
    publishScheduledContent     = { period = "15m", anchor = "2026-01-01 00:00" } # 0 */15 * * * *
    reVerifyCertifications      = { period = "7d", anchor = "2026-01-04 00:00" }  # 0 0 0 * * 0
    refreshPlaudToken           = { period = "12h", anchor = "2026-01-01 00:00" } # 0 0 */12 * * *
    refreshToolServiceCache     = { period = "1d", anchor = "2026-01-01 02:00" }  # 0 0 2 * * *
    scrapeSkillsHubRss          = { period = "7d", anchor = "2026-01-02 09:00" }  # 0 0 9 * * 5
    sendReminders               = { period = "1d", anchor = "2026-01-01 13:00" }  # 0 0 13 * * *
    syncRssFeeds                = { period = "2h", anchor = "2026-01-01 00:00" }  # 0 0 */2 * * *
    syncSocialCalendarScheduled = { period = "5m", anchor = "2026-01-01 00:00" }  # 0 */5 * * * *
  }

  # The map as KQL datatable rows, one per line.
  timer_schedule_rows = join(",\n", [
    for name, s in local.timer_schedules : "  \"${name}\", ${s.period}, datetime(${s.anchor})"
  ])

  # 100 GB a month is the Static Web Apps bandwidth included on every plan,
  # and on Free there is no overage to buy ("Overage bandwidth: Unavailable",
  # Microsoft's Static Web Apps quotas page). Decimal gigabytes.
  static_web_app_monthly_bandwidth_bytes = 100 * 1000 * 1000 * 1000

  # The rule fires on a DAY that, repeated for thirty days, would use 80% of
  # that. A metric alert cannot look back further than one day, and BytesSent
  # cannot be exported to the workspace (its DS Export is "No"), so a month's
  # running total is not something any Azure rule can read. A daily burn rate
  # is the furthest-reaching signal there is: it pages on the first heavy day,
  # weeks before the allowance runs out, instead of on the day it does.
  static_web_app_daily_bandwidth_alert_bytes = floor(local.static_web_app_monthly_bandwidth_bytes * 0.8 / 30)

  # The vaults the Key Vault rules read, as the lower-case _ResourceId the
  # AzureDiagnostics rows carry (the platform lower-cases it; see the lab
  # rules' note in lab-hybrid.tf). Both vaults ship AuditEvent here: the
  # site's through azurerm_monitor_diagnostic_setting.key_vault above, the
  # lab's through azurerm_monitor_diagnostic_setting.lab_hybrid_key_vault.
  key_vault_resource_ids = join(", ", [
    for id in [azurerm_key_vault.hcw.id, azurerm_key_vault.lab_hybrid.id] : "\"${lower(id)}\""
  ])
}

# ---------------------------------------------------------------------------
# Timers — one that should have run has no successful run
# ---------------------------------------------------------------------------
#
# Before this, one timer in twenty-five had a silence alert (the Cosmos
# exporter's two, above) and the other twenty-four could stop for a week
# unnoticed. The registration monitor catches a timer that is not REGISTERED;
# nothing caught one that is registered and not running, or running and
# failing every time.
#
# ONE RULE, ONE TIME SERIES PER TIMER. The query returns a row for each timer
# that was due and has no successful invocation since, and `timer` is the
# dimension, so each overdue timer is its own alert naming itself, opens once
# and resolves once.
#
# HOW "DUE" IS COMPUTED. For each timer, lastDue is the last scheduled time at
# least `grace` ago: anchor + period * tolong((now() - grace - anchor) / period),
# the anchor moved forward by the whole periods that fit before now() - grace.
# tolong() truncates, and every anchor is in the past, so the quotient is
# positive and truncating it rounds down to the last due time. A success
# (requests, the function's own row, success true) at or after that time
# means it ran. The grace is 45 minutes: the 30-minute non-HTTP timeout on
# Flex Consumption, plus ingestion delay, because a request row is written
# when the invocation ENDS. A disarmed timer still runs and returns early
# (schedulers.js), and that run succeeds, so the rule watches whether the
# host is running the timer at all, not whether its flag is on.
#
# NOT bin_at(). Kusto requires bin_at()'s bin size and fixed point to be
# query constants, and here both are per-row columns of the datatable, so
# from the rule's creation on 2026-10-10 every evaluation failed with SEM0040
# ("bin_at(): failed to cast argument 2 to scalar constant",
# https://learn.microsoft.com/kusto/query/bin-at-function) and the rule never
# fired. Azure accepted it at create, and nothing ran the KQL before that;
# scripts/kql-alert-columns.test.mjs now refuses a per-row value there, and
# verify-alert-state.yml reads every log rule's Resource Health (#964).
#
# THE 2-DAY CEILING, AGAIN. A log alert cannot read more than two days, so a
# weekly timer can only be judged for the day after it was due; outside that
# day its row is filtered out and it is neither healthy nor overdue. That is
# the reading the cap permits, the same one alert-cosmos-export-full takes.
#
# ONE ALERT, NOT TWENTY-FIVE, WHEN THE CAUSE IS SHARED. More than five timers
# overdue at once is one fault (the host stopped running timers, as on
# 2026-08-21, or the request rows stopped matching the names below), so the
# query collapses them into a single series named "more than five timers at
# once". `take 1`, not a summarize: a summarize with no `by` returns a row
# even from empty input, which would hold that series open forever.
#
# SILENT WHEN NOTHING AT ALL ARRIVES. If the component has received no
# request row in 30 minutes (and three timers run every five), the cause is
# not one timer: the workspace is capped, or the app is down. Without the
# `Ingesting` guard that would open one alert per timer, twenty-five mails
# and twenty-five texts for one fault. alert-logs-capacity and
# alert-api-reachability own those two, and the reachability rule fires on
# both, so this rule stays quiet rather than repeating them.
#
# A timer merged but not yet deployed is due and has never succeeded, so it
# pages from the first apply after its merge until the code deploy lands.
# That is true (the host is not running it) and closes with the deploy.
#
# `requests`, not AppRequests: the scope is the component, which resolves the
# classic schema (see alert-app-exceptions). Host.Results stays at
# Information in host.json precisely so these rows exist (T-514, T-719).
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "timer_overdue" {
  name                = "alert-timer-overdue-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "A Function App timer that was due has no successful run since. The alert names the timer. The host is not running it, or every run is failing; AppExceptions for that function says which. PLAT-4."
  severity            = 2

  evaluation_frequency = "PT15M"
  window_duration      = "P2D"

  # Stateful: each timer's alert opens once and resolves on the first good run
  # (two clean evaluations, half an hour, at this frequency).
  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      let Grace = 45m;
      let Now = now();
      let Expected = datatable(timer: string, period: timespan, anchor: datetime) [
      ${local.timer_schedule_rows}
      ];
      let Ingesting = toscalar(requests | where timestamp > Now - 30m | count) > 0;
      let LastSuccess = requests
        | where tostring(success) =~ "true"
        | extend timer = replace_string(name, "Functions.", "")
        | summarize lastSuccess = max(timestamp) by timer;
      let Overdue = Expected
        | where Ingesting
        | extend lastDue = anchor + period * tolong((Now - Grace - anchor) / period)
        | where lastDue > Now - 1d
        | join kind=leftouter LastSuccess on timer
        | where isnull(lastSuccess) or lastSuccess < lastDue - 1m;
      let Many = toscalar(Overdue | count) > 5;
      union
        (Overdue | where not(Many) | project timer),
        (Overdue | where Many | take 1 | project timer = "more than five timers at once")
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    dimension {
      name     = "timer"
      operator = "Include"
      values   = ["*"]
    }

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Lab — an agent has been offline long enough to tell the owner
# ---------------------------------------------------------------------------
#
# checkAgentHealth decides when a lab agent's outage is worth the owner's
# attention: offline for OFFLINE_NOTIFY_AFTER_MS (five minutes), once per
# outage, whether the agent went quiet or announced its own shutdown
# (lib/timers/agent-health.js, #1009). That decision, not the raw mark, is
# what this reads. The mark after 90 seconds of silence also fires on the
# nightly 04:30 reboot, which is back in under a minute; the decision does
# not, which is the reason #1009 moved the owner's message behind it.
#
# The decision writes one of three Warning traces, all past host.json's
# Warning floor and all content-free:
#
#   [checkAgentHealth] offline message sent for <n> agent(s)
#   [checkAgentHealth] offline message for <n> agent(s) not sent (<reason>)…
#   [checkAgentHealth] owner notification failed: <error>
#
# Any of them pages through the action group, so an offline agent reaches the
# owner by mail and SMS, and most of all when Telegram is the thing that is
# broken (the second and third lines; alert-telegram-delivery covers the
# refusal itself). The host-level view is alert-lab-heartbeat in
# lab-hybrid.tf: the host can be up with the agent down, which is the case
# this one catches. CHECK_AGENT_HEALTH must be armed for any of it.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_agent_offline" {
  name                = "alert-lab-agent-offline-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  scopes              = [azurerm_application_insights.hcw.id]
  description         = "A lab agent has been offline for five minutes or more: checkAgentHealth decided to tell the owner (sent or not). Public lab jobs wait until it heartbeats again. Check hcw-labs-agent on the lab host. PLAT-4."
  severity            = 2

  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"

  auto_mitigation_enabled = true

  criteria {
    query                   = "traces | where message startswith \"[checkAgentHealth] offline message\" or message startswith \"[checkAgentHealth] owner notification failed\""
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

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
    identity_ids = [azurerm_user_assigned_identity.alerts_app.id]
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.alerts_app_workspace,
    azurerm_role_assignment.alerts_app_component,
  ]
}

# ---------------------------------------------------------------------------
# Jobs — a message landed in the poison queue
# ---------------------------------------------------------------------------
#
# platformJobWorker reads `platform-jobs` on the Functions host account; a
# message the host cannot hand to it five times is moved to
# `platform-jobs-poison` (jobs-worker.js) and nothing reads it again. lib/jobs.js
# makes that rare by never throwing for a job-level failure, so a poisoned
# message is a crash the job record does not show.
#
# ARRIVALS, NOT DEPTH. Queue depth is an account-wide metric with no queue
# dimension, so it cannot single out the poison queue. Every arrival is a
# PutMessage to it, which the functions_queue diagnostic setting above
# already ships to StorageQueueLogs (StorageWrite). AccountName rather than
# _ResourceId, because the storage table carries the account by name and the
# queue in the URI, and both are exact. Successful puts only: a message that
# landed is the incident, and a refused put (no such queue, no role) is
# not a job the host gave up on.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "jobs_poison" {
  provider = azurerm.mgmt

  name                = "alert-jobs-poison-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "A message landed in the platform-jobs-poison queue: the host failed to hand a job to platformJobWorker five times. Read the poisoned message and AppExceptions for platformJobWorker. PLAT-4."
  severity            = 2

  evaluation_frequency = "PT15M"
  # An hour, so a row that is ingested late is still inside some window.
  window_duration = "PT1H"

  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      StorageQueueLogs
      | where AccountName == "${azurerm_storage_account.functions.name}"
      | where OperationName == "PutMessage"
      | where ObjectKey contains "/platform-jobs-poison" or Uri contains "/platform-jobs-poison/"
      | where toint(StatusCode) between (200 .. 299)
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

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

# ---------------------------------------------------------------------------
# Static Web App — a day heavy enough to exhaust the month's bandwidth
# ---------------------------------------------------------------------------
#
# The site is on the Free plan (frontend.tf, owner decision #341). Free
# includes 100 GB of bandwidth a month and sells no more, so past it the
# site stops serving. BytesSent ("Data Out") is the platform metric for it.
# A metric alert, not a log rule: no ingestion, keeps evaluating through a
# capped workspace, and the first ten metric time series are free (Azure
# Retail Prices API, "Alerts Metric Monitored", read 2026-10-10).
resource "azurerm_monitor_metric_alert" "swa_bandwidth" {
  name                = "alert-swa-bandwidth-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  scopes              = [azurerm_static_web_app.hcw.id]
  description         = "The Static Web App sent more than 80% of a thirtieth of the Free plan's 100 GB monthly bandwidth in the last 24 hours. Thirty such days use 80% of the month; past 100 GB Free stops serving. PLAT-4."
  severity            = 2
  frequency           = "PT1H"
  window_size         = "P1D"

  criteria {
    metric_namespace = "Microsoft.Web/staticSites"
    metric_name      = "BytesSent"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = local.static_web_app_daily_bandwidth_alert_bytes
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Key Vault — calls that did not succeed
# ---------------------------------------------------------------------------
#
# Both vaults' AuditEvent rows, every request that answered 400 or above.
# Two kinds are excluded by name because they are routine, not because they
# are quiet:
#
#   - Authentication 401. Every Key Vault client's first request carries no
#     token and is answered with a 401 challenge; Microsoft's own failure
#     query excludes exactly this pair (Monitor Azure Key Vault, "Are there
#     any failures?").
#   - SecretGet 404. The platform resolves every @Microsoft.KeyVault
#     reference, and the references left unseeded on purpose
#     (scripts/check-unresolved-secrets.mjs, EXPECTED_UNRESOLVED) answer 404
#     each time it does.
#
# What is left is a 403 (an RBAC refusal or the vault firewall), a 429, a
# 5xx, or a 404 on something other than a secret read: each one either a
# misconfiguration or someone reaching for what they may not have.
#
# THRESHOLD ASSUMPTION: more than zero in an hour. The baseline has never
# been measured; the runbook gives the query that measures it. If it is not
# zero, exclude the named operation, as the two above are, rather than raise
# the count.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "key_vault_errors" {
  provider = azurerm.mgmt

  name                = "alert-kv-errors-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "A Key Vault request (site or lab vault) answered 400 or above, other than the 401 authentication challenge and a 404 on an unseeded secret: an RBAC or firewall refusal, throttling, or a service error. PLAT-4."
  severity            = 2

  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      AzureDiagnostics
      | where ResourceProvider == "MICROSOFT.KEYVAULT"
      | where tolower(_ResourceId) in (${local.key_vault_resource_ids})
      | where httpStatusCode_d >= 400
      | where not(OperationName == "Authentication" and httpStatusCode_d == 401)
      | where not(OperationName == "SecretGet" and httpStatusCode_d == 404)
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

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

# ---------------------------------------------------------------------------
# Key Vault — a secret or key written through the data plane by anyone but
# the Function App
# ---------------------------------------------------------------------------
#
# A secret written through the data plane (the Admin → API Keys page, the
# MCP token refresh, the break-glass script) never touches Resource Manager,
# so no Activity Log alert can see it; only AuditEvent can. The Function
# App's own identity writes secrets routinely and by design (the 2026-08-29
# vault-write decision), so its writes are excluded by object id. Any other
# caller writing, deleting, purging or restoring a secret or key in either
# vault pages: a human seeding by script, or anything else. Whatever the
# result: a refused attempt by an unexpected caller is as worth knowing as a
# write that went through, and the result is in the row for whoever reads it.
#
# The caller's object id is one of two columns depending on the token's
# claims; column_ifexists keeps the query valid if either has never been
# ingested into this workspace.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "key_vault_data_writes" {
  provider = azurerm.mgmt

  name                = "alert-kv-data-write-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = azurerm_resource_group.platform_mgmt.location
  scopes              = [azurerm_log_analytics_workspace.hcw.id]
  description         = "An identity other than the Function App's wrote, deleted, purged, restored or backed up a secret or key in the site or lab vault through the data plane, or tried to. PLAT-4."
  severity            = 1

  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  auto_mitigation_enabled = true

  criteria {
    query                   = <<-KQL
      AzureDiagnostics
      | where ResourceProvider == "MICROSOFT.KEYVAULT"
      | where tolower(_ResourceId) in (${local.key_vault_resource_ids})
      | where OperationName in ("SecretSet", "SecretUpdate", "SecretDelete", "SecretPurge", "SecretRestore", "SecretRecover", "SecretBackup", "KeyCreate", "KeyImport", "KeyUpdate", "KeyDelete", "KeyPurge", "KeyRestore", "KeyRecover", "KeyBackup", "KeyRotate", "KeyRotationPolicySet")
      | extend CallerObjectId = tolower(coalesce(tostring(column_ifexists("identity_claim_oid_g", "")), tostring(column_ifexists("identity_claim_http_schemas_microsoft_com_identity_claims_objectidentifier_g", ""))))
      | where CallerObjectId != "${lower(azurerm_function_app_flex_consumption.hcw.identity[0].principal_id)}"
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

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

# ---------------------------------------------------------------------------
# Activity Log — vault configuration, role assignments and role definitions
# ---------------------------------------------------------------------------
#
# Free, and no export: an Activity Log alert is evaluated on the Activity Log
# itself. The alternative the assessment named, a diagnostic setting sending
# the Activity Log to the workspace plus a log rule, costs a paid rule and
# ingestion for the same Resource Manager events.
#
# Succeeded and Failed only. A write logs Started and then one of those, so
# without the filter every change would page twice; a Failed write is kept
# because a refused attempt to grant a role is as worth knowing as a granted
# one.
#
# An Activity Log alert watches the subscription it is in, so role
# assignments need one rule per subscription that holds a grant this estate
# depends on: the application subscription, and Management, where the
# workspace and the alert identities' grants live.
#
# One resource type per rule, which is Azure's constraint, not a preference. A
# rule in the Administrative category scoped to a whole subscription must
# carry at least one more single-value condition. azurerm sends a list
# attribute (`resource_types`, `statuses`) as an any-of group, and an any-of
# group does not count: the first apply refused a rule watching both types
# with UnsupportedCondition, "must have at least one additional filtering
# condition" (2026-10-10). `resource_type` is one `equals`, the shape
# Microsoft's Administrative sample uses, so role assignments and role
# definitions are a rule each, in each subscription.
#
# Every HCP Terraform apply that creates or deletes a role assignment fires
# the role-assignment rule for that subscription. That is intended: it is the
# second witness an apply does what its plan said, and the one place an
# assignment made OUTSIDE an apply shows up. No apply writes a role
# definition: infra/ declares none, reading its custom roles as data sources,
# and the owner creates and updates them by hand. So the role-definition
# rules fire only on a hand change, which is why they exist: a change to a
# custom role's actions widens every assignment of it without one assignment
# being written.

# Vault configuration: what Resource Manager writes on either vault or beneath
# it. That covers the network ACL and every other vault property, a delete,
# keys and secrets written through Resource Manager, role assignments and locks
# scoped to a vault, its tags, and its diagnostic settings. Scopes are resource
# ids used as prefixes.
#
# THE PROVIDER LIST IS WHAT STOPS THIS RULE FIRING ON ITSELF (#1216). An
# alert's state change is logged against its target, as
# `<vault id>/providers/Microsoft.AlertsManagement/alerts/<id>`, which is
# beneath the vault and matched the bare prefix. So closing one of this rule's
# alerts, in the portal or through the API, opened another and paged again:
# the 2026-10-16 cleanup closed three and three new ones fired at 01:37Z.
# Activity Log conditions have no "not equals", so the providers that make
# real vault changes are listed and Microsoft.AlertsManagement is not:
# KeyVault (the vault, its keys, secrets and private endpoints),
# Authorization (role assignments and locks), Resources (tags, which
# Invoke-AlertFireTest.ps1 -Test kv-config-write writes) and Insights
# (diagnostic settings, so turning off the vault's audit log still pages).
resource "azurerm_monitor_activity_log_alert" "key_vault_config_writes" {
  name                = "alert-kv-config-write-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = "global"
  scopes              = [azurerm_key_vault.hcw.id, azurerm_key_vault.lab_hybrid.id]
  description         = "Azure Resource Manager wrote to the site or lab Key Vault: its network ACL or properties, a key or secret through ARM, a delete, or a role assignment on it. Expected only from an HCP Terraform apply. PLAT-4."

  criteria {
    category = "Administrative"
    statuses = ["Succeeded", "Failed"]
    resource_providers = [
      "Microsoft.KeyVault",
      "Microsoft.Authorization",
      "Microsoft.Resources",
      "Microsoft.Insights",
    ]
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

resource "azurerm_monitor_activity_log_alert" "rbac_assignment_writes_app" {
  name                = "alert-rbac-assignment-app-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = "global"
  scopes              = ["/subscriptions/${var.subscription_app}"]
  description         = "A role assignment was created or deleted in the application subscription, or an attempt failed. Expected from an HCP Terraform apply that grants or removes a role; anything else is not. PLAT-4."

  criteria {
    category      = "Administrative"
    resource_type = "Microsoft.Authorization/roleAssignments"
    statuses      = ["Succeeded", "Failed"]
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

resource "azurerm_monitor_activity_log_alert" "rbac_definition_writes_app" {
  name                = "alert-rbac-definition-app-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = "global"
  scopes              = ["/subscriptions/${var.subscription_app}"]
  description         = "A role definition was created, changed or deleted in the application subscription, or an attempt failed. No apply writes one; expected only when the owner changes a custom role by hand. PLAT-4."

  criteria {
    category      = "Administrative"
    resource_type = "Microsoft.Authorization/roleDefinitions"
    statuses      = ["Succeeded", "Failed"]
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

resource "azurerm_monitor_activity_log_alert" "rbac_assignment_writes_mgmt" {
  provider = azurerm.mgmt

  name                = "alert-rbac-assignment-mgmt-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = "global"
  scopes              = ["/subscriptions/${var.subscription_mgmt}"]
  description         = "A role assignment was created or deleted in the Management subscription, or an attempt failed. Expected from an HCP Terraform apply that grants or removes a role; anything else is not. PLAT-4."

  criteria {
    category      = "Administrative"
    resource_type = "Microsoft.Authorization/roleAssignments"
    statuses      = ["Succeeded", "Failed"]
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

resource "azurerm_monitor_activity_log_alert" "rbac_definition_writes_mgmt" {
  provider = azurerm.mgmt

  name                = "alert-rbac-definition-mgmt-${var.environment}-${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.platform_mgmt.name
  location            = "global"
  scopes              = ["/subscriptions/${var.subscription_mgmt}"]
  description         = "A role definition was created, changed or deleted in the Management subscription, or an attempt failed. No apply writes one; expected only when the owner changes a custom role by hand. PLAT-4."

  criteria {
    category      = "Administrative"
    resource_type = "Microsoft.Authorization/roleDefinitions"
    statuses      = ["Succeeded", "Failed"]
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

# =============================================================================
# functionapp.tf — the service plan, the Function App itself (including its
# app settings and the timer flag locals), and the azapi resources that patch
# what the azurerm provider cannot express.
#
# Split out of main.tf on 2026-08-29 (T-754). Terraform reads every .tf file in
# this directory as ONE module: same namespace, same state, same plan. Nothing
# moved between states and no resource address changed — an empty plan is the
# proof, and `functions/test/terraform-source.js` is why the text-reading guards
# did not need to care.
# =============================================================================

resource "azurerm_service_plan" "hcw" {
  #checkov:skip=CKV_AZURE_212:FC1 has no worker_count; failover instances mean always-ready instances, declined by the owner 2026-09-14 (ADR 0031) against the USD 150 budget. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_225:Zone redundancy on Flex forces at least two always-ready instances; declined by the owner 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  name                = "asp-${var.workload_name}-${var.environment}-${var.region_abbreviation}-${var.instance}"
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  os_type             = "Linux"
  sku_name            = "FC1" # Flex Consumption — VNet integration, scales to zero
  tags                = local.tags
}

# =============================================================================
# Function App — Flex Consumption
#
# This MUST be azurerm_function_app_flex_consumption, not
# azurerm_linux_function_app. Flex is configured through
# properties.functionAppConfig (runtime, deployment storage, scaleAndConcurrency)
# and azurerm_linux_function_app does not emit that block, so pairing it with an
# FC1 plan fails at apply with:
#
#   Site.FunctionAppConfig is invalid. The FunctionAppConfig section was not
#   specified in the request, which is required for Flex Consumption sites.
#
# `terraform validate` does NOT catch this — it checks schema, not provider/API
# compatibility — so the previous config validated cleanly while being
# undeployable.
#
# Deliberately absent, all unsupported on Flex:
#   - site_config.application_stack.node_version  (maps to LinuxFxVersion)
#   - WEBSITE_RUN_FROM_PACKAGE                    (Flex uses the deployment container)
#   - FUNCTIONS_WORKER_RUNTIME                    (replaced by runtime_name)
#   - the platform `cors` block                   (see DECISION 7 below)
# =============================================================================
# ---------------------------------------------------------------------------
# Timer feature flags — generated, so cutover flips a variable, not this file.
# ---------------------------------------------------------------------------
#
# The catalogue is the authority on which timers exist. It must match the
# `timer(name, FLAG, ...)` registrations in
# functions/src/functions/schedulers.js plus platformJobSweeper in
# jobs-sweeper.js, refreshToolServiceCache in cloud-tools-jobs.js,
# labsWeeklyRollup in labs-jobs.js, ambassadorAudienceMonthly in
# ambassador-audience.js and sweepVisitorSessions in visitor-session-sweep.js —
# route-inventory.test.js asserts the timer set, so a timer added there
# without a flag here ships disarmed and one removed there leaves a dead
# setting behind.
locals {
  # Flag suffix => the function it arms. The comment is the whole point of the
  # map: `SYNC_SOCIAL_CALENDAR` tells an operator nothing about what turning it
  # on will start writing.
  timer_catalogue = {
    PUBLISH_SCHEDULED_CONTENT    = "publishScheduledContent — publishes content whose scheduledPublishDate is due"
    SYNC_RSS_FEEDS               = "syncRssFeeds — RSS ingest, every 2 hours"
    FORGE_SCHEDULED              = "forgeScheduled — daily 03:30 UTC content forge run"
    MONITOR_PUBLISHING_PIPELINE  = "monitorPublishingPipeline — publishing watchdog, every 6 hours"
    GENERATE_REVIEWER_DIGEST     = "generateReviewerDigest — daily 07:00 UTC reviewer digest e-mail"
    CHECK_LIVE_LINKS             = "checkLiveLinks — weekly Monday 06:00 UTC link check"
    BUILD_WEEKLY_NEWSLETTER      = "buildWeeklyNewsletter — weekly Monday 13:00 UTC, builds the newsletter issue into Drafts and pings Telegram. Never sends (#504)"
    CLEANUP_REJECTED_CONTENT     = "cleanupRejectedContent — daily 04:00 UTC, deletes rejected documents"
    CLEANUP_SOFT_DELETED_CONTENT = "cleanupSoftDeletedContent — every 4 hours, purges soft-deleted documents (dry-run unless CONTENT_HARD_DELETE; a mark with no recorded origin is never deleted)"
    REVERIFY_CERTIFICATIONS      = "reVerifyCertifications — weekly Sunday 00:00 UTC certification re-verify"
    SCRAPE_SKILLS_HUB_RSS        = "scrapeSkillsHubRss — weekly Friday 09:00 UTC Skills Hub scrape"
    REFRESH_PLAUD_TOKEN          = "refreshPlaudToken — Plaud OAuth token refresh, every 12 hours"
    CHECK_AGENT_HEALTH           = "checkAgentHealth — VPS agent heartbeat check, every 5 minutes"
    FETCH_PODCAST_FEEDS          = "fetchPodcastFeeds — podcast ingest, every 2 hours"
    FETCH_BLOG_LISTINGS          = "fetchBlogListings — Firecrawl blog listings, every 6 hours"
    # D12: the live writer of social_posts. Turning this on before the cutover
    # delta import means importing over rows this timer is actively rewriting.
    SYNC_SOCIAL_CALENDAR = "syncSocialCalendarScheduled — Publer calendar sync, every 5 minutes. NOT before the delta import"
    # T-302: both stay dry-run until their matching *_DELETE setting is true.
    CLEANUP_TEMP_STORAGE       = "cleanupTempStorage — daily 00:00 UTC, deletes temp blobs (dry-run unless TEMP_STORAGE_CLEANUP_DELETE)"
    CLEANUP_UNUSED_CERT_IMAGES = "cleanupUnusedCertImages — daily 05:00 UTC, deletes unused cert images (dry-run unless CERT_IMAGE_CLEANUP_DELETE)"
    PLATFORM_JOB_SWEEPER       = "platformJobSweeper — re-enqueues jobs left queued by a failed output binding (T-322)"
    # #613: enqueues the refresh-tool-pricing job; the worker reads three
    # public price lists and rewrites tool_service_cache. Azure needs no key;
    # AWS and GCP rows fall back to baseline or go absent until their Key
    # Vault secrets are seeded.
    REFRESH_TOOL_SERVICE_CACHE = "refreshToolServiceCache — daily 02:00 UTC, enqueues the pricing cache refresh job"
    # #665: folds the labs minute-caches and the day's lab_jobs into one
    # labs:day:<date> document the newsletter's "Lab this week" section reads.
    # Point reads and one grouped count; never calls Azure or Coder.
    LABS_WEEKLY_ROLLUP = "labsWeeklyRollup — daily 23:55 UTC, writes the day's labs rollup document for the newsletter"
    # #701: the AI Engine's Test on a timer, so NVIDIA's speed as the backup
    # provider is re-measured weekly. Writes ai_providers status and ai_usage
    # rows only; a fraction of a cent a week across the paid providers.
    PROBE_AI_PROVIDERS = "probeAiProviders — weekly Monday 06:15 UTC, runs the AI Engine Test against every AI provider with a key and records the latency on its card"
    # Owner request 2026-10-06: the reminders sheet under Platform Settings,
    # said on Telegram ahead of each date, on the day, and weekly while
    # overdue until marked done. Reads one admin_config document and writes
    # its stamps back; nothing else.
    SEND_REMINDERS = "sendReminders — daily 13:00 UTC, says each due reminder from Platform Settings → Reminders on Telegram"
    # #1010: the Health Hub's pulse. Builds the ops snapshot and reads the lab
    # agents, AI providers and MCP servers, then writes one admin_config
    # result document per probe and its own heartbeat. No third-party call.
    # Until it is armed the hub says the pulse has never reported.
    HEALTH_PULSE = "healthPulse — every 5 minutes at 2 past, records the Health Hub's server-side checks and the pulse heartbeat"
    # #1009: one real lab job an hour, end to end. Writes one lab_jobs
    # document, waits up to 150 s for the agent to run it, deletes it, and
    # writes admin_config/lab_canary; also reads the labs status once through
    # its minute cache. A job on the owner's host every hour, so it stays off
    # until the owner adds LAB_CANARY.
    LAB_CANARY = "labCanary — hourly at 20 past, runs one shell-echo lab job end to end for the Health Hub and deletes it"
    # #1302: the monthly audience figure. Reads the previous month's page-view
    # totals from Cloudflare Web Analytics with CLOUDFLARE_ANALYTICS_TOKEN and
    # records one number per month; nothing is shown to visitors. Runs daily
    # and writes only when the previous month is not yet recorded, so a
    # failed first-of-the-month run is caught up the next day and
    # alert-timer-overdue in observability.tf can watch it as a 1d period
    # (a day-of-month NCRONTAB has no fixed period for that rule to compute).
    AMBASSADOR_AUDIENCE_MONTHLY = "ambassadorAudienceMonthly — daily 06:45 UTC, records the previous month's audience figure from Cloudflare Web Analytics once per month (ambassador-audience.js)"
    # #1403 item 1: the visitor lab session sweep on its own clock. Ends the
    # sessions past their hour and retries the Coder clean-ups Coder has not
    # confirmed; claims a session before it calls Coder, so a second run, or
    # the in-request sweep, cannot double-call. Reads and writes lab_jobs and
    # calls Coder's delete and lookup endpoints; it never creates a session or
    # a Coder user, and it runs whatever LABS_VISITOR_SESSIONS_ENABLED says.
    # Stays off until the owner adds SWEEP_VISITOR_SESSIONS to enabled_timers.
    SWEEP_VISITOR_SESSIONS = "sweepVisitorSessions — every 2 minutes, ends visitor lab sessions past their hour and retries Coder clean-ups Coder has not confirmed (visitor-session-sweep.js); never creates a session"
  }

  timer_flags = {
    for suffix, _description in local.timer_catalogue :
    "FEATURE_FLAG_${suffix}" => contains(var.enabled_timers, suffix) ? "true" : "false"
  }
}

resource "azurerm_function_app_flex_consumption" "hcw" {
  name                = var.function_app_name
  location            = azurerm_resource_group.app["web"].location
  resource_group_name = azurerm_resource_group.app["web"].name
  service_plan_id     = azurerm_service_plan.hcw.id

  storage_container_type      = "blobContainer"
  storage_container_endpoint  = "${azurerm_storage_account.functions.primary_blob_endpoint}${azurerm_storage_container.function_releases.name}"
  storage_authentication_type = "SystemAssignedIdentity" # no static storage key

  # Node.js 24: the newest line Flex Consumption supports (22 and 24 are GA;
  # 26 is not offered), held there by scripts/version-floors.json and its test.
  # An in-place update: runtime_version is not ForceNew in azurerm 5.6.0, and
  # the provider's Update writes functionAppConfig.runtime.version (#715).
  runtime_name    = "node"
  runtime_version = "24"

  virtual_network_subnet_id = azurerm_subnet.functions_integration.id

  # DECISION 6 — bearer tokens must not traverse plaintext, and the origin has
  # to be unreachable except through Cloudflare before CF-Connecting-IP means
  # anything. functions/src/lib/auth/client-identity.js fails closed in
  # production until CF_ORIGIN_SECRET is set, precisely so rate limiting cannot
  # silently degrade to trusting a spoofable header.
  https_only = true


  # ---------------------------------------------------------------------------
  # Scale — every one of these was a silent platform default before.
  # ---------------------------------------------------------------------------

  # 2048 MB, down from the 4 GiB the Firebase functions declared. That pin
  # existed solely to survive JSON.parse of a 458 MiB AWS offer document; the
  # Price List Query API returns ~1 KB, and the full eight-service sweep across
  # all three providers now runs in 18.8 MB. Instance memory on Flex is
  # per-APP, not per-function, so this applies to every function here.
  instance_memory_in_mb = 2048

  # Bounded deliberately. getToolComparisonData is public and unauthenticated,
  # so an unbounded default turns a traffic spike into unbounded GB-seconds.
  maximum_instance_count = 20

  # Always-ready is deliberately NOT configured, which means zero — the default.
  # It is the single largest cost line available on this plan: one always-ready
  # 2048 MB instance is roughly $20/month whether or not anything executes,
  # against a USD 150 ceiling for the whole platform. Enabling zone redundancy
  # later forces a minimum of two, so revisit both together and only after
  # cold-start latency on getToolComparisonData has actually been measured.

  site_config {
    application_insights_connection_string = azurerm_application_insights.hcw.connection_string
    application_insights_key               = azurerm_application_insights.hcw.instrumentation_key

    # The platform default is HTTP/1.1 only, which the live app was still on.
    # There is no compatibility question to weigh: HTTP/2 is negotiated over
    # TLS by ALPN, so a client that does not speak it is served 1.1 exactly as
    # before, and this app is https_only. Cloudflare already terminates HTTP/2
    # for browsers; this is about the leg BEHIND it and about any client
    # reaching the origin hostname directly.
    http2_enabled = true

    # DECISION 7 — CORS is handled in code
    # (functions/src/lib/auth/cors.js) for real requests, and HERE for
    # preflights, because the platform gives no choice about the second.
    #
    # The original decision removed this block entirely on the reasoning that two
    # allowlists drift and the in-code one is better: it 403s a disallowed origin
    # instead of silently omitting the header, and it can express any localhost
    # port rather than the two that used to be hardcoded. All of that still holds
    # for actual requests.
    #
    # It was wrong about preflights, and the site proved it on 2026-08-23. The
    # admin portal could authenticate and then every API call failed with
    # "Failed to fetch" — a browser-side CORS rejection with no server-side trace.
    #
    # The Functions host answers a GENUINE preflight itself: OPTIONS carrying both
    # `Origin` and `Access-Control-Request-Method`. With no origins configured
    # here it answers 204 with no Access-Control-* headers at all, which every
    # browser rejects. Measured against production:
    #
    #   OPTIONS + Origin + Access-Control-Request-Method  -> 204, no headers
    #   OPTIONS + Origin, no Access-Control-Request-Method -> reaches the app,
    #                                                        204 WITH headers
    #   GET + disallowed Origin                            -> 403 from the app
    #
    # The middle line is the proof: the in-code preflight is correct and simply
    # never runs for the only kind of preflight a browser sends. Removing this
    # block did not return preflight handling to the application; it left the
    # platform answering preflights with nothing.
    #
    # So the platform gets exactly the origins it needs to answer a preflight,
    # and nothing else changes: the in-code allowlist still decides actual
    # requests, still 403s, still owns localhost. Drift between the two is
    # contained by `cors_platform_origins.test.js`, which reads this file and
    # fails if it stops matching PRODUCTION_ORIGINS + PREVIEW_ORIGINS.
    #
    # support_credentials stays FALSE. This is a bearer-token API, not a cookie
    # API, and true would additionally make the platform intercept far more than
    # preflights.
    # Two ways to break that guard, both tried for T-750 and reverted: replacing
    # a literal with "https://${var.domain}" or the SWA's default_host_name
    # (the test compares strings, and an interpolation is not one), and putting
    # a comment between `cors {` and `allowed_origins` (its block regex stops
    # matching, so the guard passes while checking nothing). The asymmetry with
    # the storage account's CORS block, which does derive from var.domain, is
    # justified rather than an oversight: only this list is guarded by text.
    cors {
      allowed_origins = concat(
        ["https://hybridcloudworks.com", "https://www.hybridcloudworks.com"],
        ["https://calm-ground-0d0e6a010.7.azurestaticapps.net"],
        var.cors_extra_origins,
      )
      support_credentials = false
    }

    # -------------------------------------------------------------------------
    # The Azure half of the origin lock (DECISION 6). Off by default — see
    # var.functions_origin_lock_enabled for what turning it on breaks, and why
    # the ranges are a literal list rather than an http data source.
    #
    # These blocks live INSIDE this site_config rather than in a conditional
    # one of their own: the resource takes a single site_config, so a second
    # block is a configuration error that only surfaces when the flag is
    # turned on — a plan-time failure hiding behind a false default.
    #
    # The Deny is last by construction. App Service evaluates ip_restriction
    # entries by priority and applies an implicit "allow all" only when the
    # list is EMPTY, so this is either absent entirely (open, today) or ends in
    # an explicit Deny. There is no half-written state that quietly allows
    # everything.
    # -------------------------------------------------------------------------
    dynamic "ip_restriction" {
      for_each = var.functions_origin_lock_enabled ? var.cloudflare_ip_ranges : []
      content {
        action     = "Allow"
        ip_address = ip_restriction.value
        name       = "cloudflare-${replace(replace(ip_restriction.value, ".", "-"), "/", "-")}"
        priority   = 100 + index(var.cloudflare_ip_ranges, ip_restriction.value)
      }
    }

    dynamic "ip_restriction" {
      for_each = var.functions_origin_lock_enabled ? [1] : []
      content {
        action      = "Deny"
        ip_address  = "0.0.0.0/0"
        name        = "deny-all-non-cloudflare"
        priority    = 65000
        description = "Everything that did not match a Cloudflare range above"
      }
    }

    # The rule above is NOT sufficient on its own, and assuming it was is the
    # kind of mistake that leaves a lock looking closed while it is open.
    #
    # `0.0.0.0/0` is an IPv4 CIDR and matches no IPv6 source, so an IPv6 request
    # matches no rule at all and falls through to the unmatched-request action.
    # That action defaults to ALLOW — verified on the live app, which reported
    # `ipSecurityRestrictionsDefaultAction: Allow` while every IPv4 request was
    # correctly refused with 403.
    #
    # No AAAA record is published for the origin today and a direct IPv6 attempt
    # failed to connect, so this was not demonstrably exploitable — but the
    # posture depends on that remaining true, which is not a property this
    # configuration controls. Deny is the supported way to say what the
    # `0.0.0.0/0` rule was trying to say.
    ip_restriction_default_action = var.functions_origin_lock_enabled ? "Deny" : "Allow"

    # SCM (Kudu) reachability, closed by a per-run window rather than a standing
    # rule — see T-520, raised as S2 in the 2026-08-24 Go-Live review.
    #
    # The Flex Consumption deploy runs THROUGH Kudu ("Will use Kudu
    # https://<scmsite>/api/publish to deploy since Flex consumption plan is
    # detected") and GitHub-hosted runners have no stable egress IPs, so a
    # standing Deny breaks every deploy. That is why this was Allow, and why
    # simply changing the literal was never the fix.
    #
    # deploy-functions.yml now opens a window instead: it adds the runner's IP
    # as an SCM allow rule before the deploy and removes it in an always-run
    # step that asserts the posture it found is the posture it left. That makes
    # Deny survivable, so the posture becomes a variable.
    #
    # True by default since 2026-10-14 (PLAT-10, #970), on two observations:
    # the window was merged and proven under Deny on 2026-08-25 (deploy run
    # 32902534458, the day the workspace set the variable true), and the SCM
    # default action read Deny on 2026-10-14 (#981). The interval between is
    # not a recorded fact; monitor-functions-registered.yml and the deploy's
    # SCM window steps are what read it. A fresh workspace that lacks the window
    # steps sets it false first, because the first deploy after a premature
    # Deny is the one that cannot get in to fix it.
    #
    # This closes the REACHABILITY half. The credential half is already closed
    # below: basic authentication is off on both SCM and FTP, so anything
    # reaching the endpoint must present an Entra token. This app deploys with
    # OIDC and a federated identity and has never used a publish profile.
    scm_ip_restriction_default_action = var.functions_scm_lock_enabled ? "Deny" : "Allow"
  }

  # Kudu and FTP username/password publishing, off. Anyone reaching the SCM
  # endpoint now has to present an Entra token rather than a static credential,
  # so the publicly-reachable SCM site stops being an authentication surface
  # even while it stays publicly reachable.
  webdeploy_publish_basic_authentication_enabled = false

  app_settings = merge({
    # ---------------------------------------------------------------------------
    # The Functions HOST's own storage — timers, singleton locks, SyncTriggers.
    #
    # This is NOT the same thing as storage_authentication_type above. That
    # argument governs how the platform fetches the deployment PACKAGE; this
    # governs how the running host reaches storage for its own state. Setting
    # the first and assuming it covered the second is what broke the first
    # deploy (2026-08-20): the app deployed successfully, reported 80 functions,
    # and then served the App Service 404 page for every route.
    #
    # The evidence, from Application Insights:
    #
    #   [exception] Server failed to authenticate the request. Make sure the
    #               value of Authorization header is formed correctly including
    #               the signature.
    #   [trace]     SyncTriggers operation failed.
    #   [trace]     Process reporting unhealthy: Unhealthy
    #
    # An AzureWebJobsStorage connection string was present with an EMPTY
    # AccountKey — shared-key auth with no key, so every storage call failed the
    # signature check, SyncTriggers never completed, and the host never became
    # healthy enough to route a request. Nothing in this configuration wrote
    # that setting; it arrived with the deploy.
    #
    # `__accountName` is the identity-based form: the host constructs the blob,
    # queue and table endpoints from the account name and authenticates with its
    # own managed identity, which already holds Storage Blob Data Owner here.
    #
    # Declaring it here does NOT stop the keyless `AzureWebJobsStorage` string
    # from coming back, and the culprit is THIS PROVIDER, not the deploy —
    # corrected 2026-08-21 from the activity log, which is the only place the
    # two are distinguishable. `azurerm_function_app_flex_consumption` re-injects
    # it on every apply whatever `storage_authentication_type` says, and it does
    # not surface in plan: hashicorp/terraform-provider-azurerm#29149, open,
    # reproducing on the 5.1.0 pinned in .terraform.lock.hcl. Evidence: the
    # 20:02Z deploy deleted the setting, Terraform's 20:31Z apply was the only
    # `sites/config` write after it, and the setting was present again.
    #
    # It is stripped inside this same apply by the azapi read-then-update pair
    # below the resource — so the setting does not survive an apply that
    # completes, and nothing downstream has to remember to clean up. An apply
    # that fails between the write and the strip can leave it behind; no
    # ordering prevents that, and the PLAT-2 note above the pair says exactly
    # when it happens and what detects it. deploy-functions.yml asserts it is
    # absent and FAILS if it is not, rather than deleting it: a repair there
    # would hide a regression in the strip. T-511.
    #
    # The failure mode is worth remembering: a keyless connection string does
    # not fail at deploy, and does not fail as "storage". It fails as a 404 on
    # every route, which reads as a routing or build problem.
    # ---------------------------------------------------------------------------
    "AzureWebJobsStorage__accountName" = azurerm_storage_account.functions.name

    # Cosmos DB — endpoint only; runtime auth uses managed identity via DefaultAzureCredential
    "COSMOS_ENDPOINT" = azurerm_cosmosdb_account.hcw.endpoint
    "COSMOS_DATABASE" = azurerm_cosmosdb_sql_database.hcw.name
    # COSMOS_CONNECTION_STRING is deliberately absent (T-315): it carried
    # the account PRIMARY KEY for two empty change-feed handlers. The six
    # current change-feed functions use the IDENTITY-BASED binding —
    # the app's managed identity already holds Cosmos Data Contributor at account
    # scope (func_cosmos), which covers the `leases` container too.
    # See https://learn.microsoft.com/azure/azure-functions/functions-bindings-cosmosdb-v2
    "COSMOS_CONNECTION__accountEndpoint" = azurerm_cosmosdb_account.hcw.endpoint
    "COSMOS_CONNECTION__credential"      = "managedidentity"

    "STORAGE_ACCOUNT_NAME"   = azurerm_storage_account.hcw.name
    "STORAGE_BLOB_ENDPOINT"  = azurerm_storage_account.hcw.primary_blob_endpoint
    "STORAGE_QUEUE_ENDPOINT" = azurerm_storage_account.hcw.primary_queue_endpoint

    # KEY_VAULT_URI was removed earlier on 2026-08-29, when GCP pricing stopped
    # needing a runtime vault client, and is back for a different caller with a
    # different direction of travel: the API-keys page WRITES secrets, through a
    # set-only role that cannot read them. The rule that removed it stands —
    # nothing reads a secret through this address, and a value that could be a
    # Key Vault reference must be one.
    #
    # Not a secret. It is the address references RESOLVE against, and it is in
    # the repository, in this file, on the line below.
    "KEY_VAULT_URI" = azurerm_key_vault.hcw.vault_uri

    # The app's own ARM id, for the config-references refresh call. Composed
    # from parts rather than read off the resource, because a resource cannot
    # reference its own attributes from inside its own arguments.
    "FUNCTION_APP_RESOURCE_ID" = "/subscriptions/${var.subscription_app}/resourceGroups/${azurerm_resource_group.app["web"].name}/providers/Microsoft.Web/sites/${var.function_app_name}"

    "ENTRA_TENANT_ID" = var.entra_tenant_id
    # The API's OWN audience, not the SPA's client id. verify-token.js refuses to
    # start without it — an unset audience makes jsonwebtoken SKIP the audience
    # check entirely rather than fail, which accepts any token in the tenant.
    "ENTRA_API_AUDIENCE"    = var.entra_api_audience
    "BRAIN_ENABLED"         = tostring(var.brain_enabled)
    "BRAIN_AI_ENABLED"      = tostring(var.brain_ai_enabled)
    "BRAIN_OWNER_OID"       = var.brain_owner_oid
    "BRAIN_OWNER_TENANT_ID" = var.brain_owner_tenant_id
    "BRAIN_SYNC_CLIENT_ID"  = var.brain_sync_client_id
    # The Code Conductor brain (#1457, code-brain.tf). Separate switches from
    # the creator brain's above. The database name is read off the resource,
    # so the setting appears in the apply that creates the database, which is
    # also what adds code_brain_records to the out-of-account export.
    "CODE_BRAIN_ENABLED"         = tostring(var.code_brain_enabled)
    "CODE_BRAIN_OWNER_OID"       = var.code_brain_owner_oid
    "CODE_BRAIN_OWNER_TENANT_ID" = var.code_brain_owner_tenant_id
    "CODE_BRAIN_SYNC_CLIENT_ID"  = var.code_brain_sync_client_id
    "CODE_BRAIN_COSMOS_DATABASE" = azurerm_cosmosdb_sql_database.code_brain.name

    # AWS pricing — Key Vault references, so process.env reads stay identical to
    # the Firebase defineSecret originals. Key Vault secret names cannot contain
    # underscores. Scope the IAM policy to pricing:GetProducts only.
    "AWS_ACCESS_KEY_ID"     = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/AWS-ACCESS-KEY-ID)"
    "AWS_SECRET_ACCESS_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/AWS-SECRET-ACCESS-KEY)"

    # GCP pricing. The Cloud Billing Catalog API serves the public price list
    # and Google documents it as API-key authenticated, so this is a single
    # string like every other credential here. It replaced a service-account
    # JSON — a ~2.3 KB multi-line blob that could not be an app setting and so
    # needed a runtime vault client, an OAuth library and a signed-JWT exchange,
    # all to read prices that are public.
    "GCP_BILLING_API_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/GCP-BILLING-API-KEY)"

    # DECISION 6 — proves a request arrived through Cloudflare rather than
    # directly at the origin. Without it client-identity.js refuses to derive a
    # rate-limit key in production.
    "CF_ORIGIN_SECRET" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CF-ORIGIN-SECRET)"
    "CLIENT_IP_SALT"   = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CLIENT-IP-SALT)"

    # The monthly audience read (#1302). A SECOND Cloudflare token, not the
    # workspace's: cloudflare_api_token writes DNS and account settings, and
    # the app has no business holding it. This one carries Account → Account
    # Analytics → Read on the HybridCloudWorks account and nothing else, so a
    # leak reads page-view totals and changes nothing. The owner seeds it
    # through the API-keys page like every other vendor credential; until
    # then the reference resolves to nothing and the timer records nothing.
    "CLOUDFLARE_ANALYTICS_TOKEN" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CLOUDFLARE-ANALYTICS-TOKEN)"

    # The Web Analytics site the read is scoped to, taken STRAIGHT FROM THE
    # RESOURCE in frontend.tf and never typed by the owner: a copied site tag
    # drifts the day the site is recreated, and the resource knows its own
    # tag. Not a secret (it is the site's identifier in the API path; the
    # token above is the credential). Empty, not absent, while
    # cloudflare_account_id is unset and the site does not exist, so the timer
    # reads "" as "not configured" rather than a missing setting as a deploy
    # fault. Unknown until the first apply creates the site, which
    # tfc-plan-check reports as an unknown app_settings difference once; it
    # cannot be declared and is read by hand on that run.
    "CF_WEB_ANALYTICS_SITE_TAG" = var.cloudflare_account_id == null ? "" : cloudflare_web_analytics_site.hcw[0].site_tag

    # The account the site belongs to, the same value the workspace variable
    # carries, because the read is account-scoped: Cloudflare's
    # rumPageloadEventsAdaptiveGroups dataset hangs off
    # viewer.accounts(filter: {accountTag}), and an unfiltered accounts query
    # is documented to fail for a token that can reach any account outside
    # the scope. An identifier, not a secret: it is in every API path for the
    # account and opens nothing on its own, so it is a plain setting and not a
    # Key Vault reference. Empty, not absent, while cloudflare_account_id is
    # unset, which the timer reads as "not configured" (one log line, nothing
    # written) rather than as a missing setting.
    "CF_ACCOUNT_ID" = var.cloudflare_account_id == null ? "" : var.cloudflare_account_id

    # -------------------------------------------------------------------------
    # Runtime Key Vault bindings.
    #
    # Site-Main's functions/ declares 18 defineSecret bindings; before this block
    # exactly two of them (the AWS pair above) existed here. The other sixteen
    # had nowhere to land, which is a failure that deploys green: a handler
    # reaching for an unbound secret dies on first invocation in production, and
    # no test reproduces it because no test binds secrets.
    #
    # Names follow the established pattern — the app setting keeps the
    # underscored name so `process.env.X` reads port unchanged, and the Key Vault
    # secret uses hyphens because Key Vault names cannot contain underscores.
    #
    # These resolve to empty until the vault is seeded (Required-Inputs §4.6). Optional
    # integrations remain disabled until their owner-approved credentials exist.
    # -------------------------------------------------------------------------

    # AI generation — content drafting, scoring and image pipelines.
    #
    # Every model call goes to an EXTERNAL provider API with a key from Key
    # Vault. There is deliberately no AZURE_OPENAI_ENDPOINT and no Azure
    # OpenAI account behind it: the platform-hosted path was removed once the
    # decision landed that both text and image generation use the providers'
    # own APIs. Re-adding an Azure OpenAI account would be a second, unused
    # route to the same capability — and in this region it could not be used
    # regardless, since the subscription holds zero model quota.
    #
    # GEMINI_API_KEY reaches Gemini through the PUBLIC Generative Language API,
    # not Vertex. Vertex authenticates with Application Default Credentials — a
    # GCP identity this Function App cannot hold — so it was dropped from the
    # router at the port. The model ids are the same either way.
    #
    # It is listed first because it is first in preference order as of
    # 2026-08-23 (owner decision; see DEFAULT_PROVIDER_ORDER in
    # functions/src/lib/ai/ai-config.js). An unseeded secret resolves to the
    # literal @Microsoft.KeyVault(...) string, which readKey() treats as no key
    # at all — so until GEMINI-API-KEY is seeded the router simply moves on to
    # OpenAI. Adding this reference does not switch anything on by itself.
    #
    # NVIDIA_API_KEY (#701) is the NVIDIA API Catalog: a free trial tier at
    # ~40 requests a minute. The router places it per feature — the backup
    # for owner-triggered content since 2026-09-29 (#812), never for the
    # anonymous public explain route — and paces itself under the limit.
    # Unseeded, it is the same literal reference readKey() treats as no key,
    # so it too switches nothing on.
    "GEMINI_API_KEY"    = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/GEMINI-API-KEY)"
    "ANTHROPIC_API_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/ANTHROPIC-API-KEY)"
    "OPENAI_API_KEY"    = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/OPENAI-API-KEY)"
    "NVIDIA_API_KEY"    = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/NVIDIA-API-KEY)"
    # FOUNDRY_ENDPOINT (#849) is not a secret: the account's OpenAI v1 host,
    # reached with the app's identity (foundry.tf). Its presence is what makes
    # the `foundry` provider available to the router, the way a key does for
    # the others.
    "FOUNDRY_ENDPOINT" = "https://${azurerm_cognitive_account.foundry.custom_subdomain_name}.openai.azure.com"

    # Replicate image spend (2026-10-05). Replicate bills on its own account,
    # where no Azure budget sees it, so these two are what make it visible
    # and bounded: the per-image price every usage row carries
    # (google/imagen-4-fast was $0.02 per output image on replicate.com that
    # day; change it with the model) and the monthly budget the generators
    # refuse to exceed, in dollars of priced rows. CONTENTFORGE_IMAGE_MONTHLY_MAX
    # (default 200 images) is the ceiling that holds even when the price is
    # unset. There is NO Replicate-side spend limit: the owner declined one on
    # 2026-10-05 (the balance there is small), so this guard is the only stop.
    "CONTENTFORGE_IMAGE_COST_USD"           = "0.02"
    "CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD" = "10"
    "REPLICATE_API_KEY"                     = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/REPLICATE-API-KEY)"

    # Listen & Learn audio.
    #
    # Gemini TTS needs no key of its own: it reads GEMINI_API_KEY, declared
    # above for the text models, so that path is switched on by a secret that
    # is already seeded and costs no new service, resource or credential.
    #
    # LISTEN_AND_LEARN_TTS_PROVIDER pins it. Owner rule 2026-09-09 (ADR 0029
    # §2b): Listen & Learn audio is Gemini TTS, generated on demand and stored
    # as MP3, with Azure AI Speech as the GA fallback; ElevenLabs is ONLY the
    # podcast voice and is never used for Listen & Learn. The switch in
    # listen-and-learn/speech/index.js enforces the rule per product, and this
    # pin states it in the estate: the setting may name only "gemini" or
    # "azure" (naming "elevenlabs" fails every run with a sentence quoting the
    # rule), a pinned provider that is not configured fails rather than falls
    # through, and the value is deliberately Terraform-managed rather than set
    # by hand so a portal edit is drift the next plan shows. Not a secret: a
    # provider name.
    "LISTEN_AND_LEARN_TTS_PROVIDER" = "gemini"

    # AZURE_SPEECH_* is the fallback and is expected to stay unresolved.
    # Every Gemini TTS model is a *preview* model, and preview endpoints get
    # retired; a GA second path is what makes that a config change rather
    # than an outage. An unseeded reference arrives as the literal
    # @Microsoft.KeyVault(...) string, which readSetting() treats as no key at
    # all — so the provider simply is not offered, and declaring it here
    # switches nothing on and provisions nothing. Using it means creating a
    # Cognitive Services resource, which is a spend decision for the owner.
    "AZURE_SPEECH_KEY"    = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/AZURE-SPEECH-KEY)"
    "AZURE_SPEECH_REGION" = var.speech_region

    # ELEVENLABS_API_KEY is the PODCAST voice — article and Plaud transcripts
    # to Podbean — and only that: the owner approved a paid ElevenLabs plan on
    # 2026-09-08 (ADR 0029 §2a, #436) and scoped it on 2026-09-09 (§2b). About
    # USD 0.10 per 1,000 characters. The reference is versionless like every
    # other one here, and App Service caches a versionless reference for the
    # life of the process: a re-minted key needs an app restart to take
    # effect. Until the secret is seeded the reference on the next line
    # resolves to its own literal @Microsoft.KeyVault(...) string and the
    # podcast saves transcript-only drafts naming this setting — it never
    # falls back to Gemini, and declaring it here switches nothing on.
    "ELEVENLABS_API_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/ELEVENLABS-API-KEY)"

    # Ingestion and enrichment.
    "FIRECRAWL_API_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/FIRECRAWL-API-KEY)"
    "LINKIE_API_KEY"    = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/LINKIE-API-KEY)"
    "YOUTUBE_API_KEY"   = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/YOUTUBE-API-KEY)"

    # Social scheduling (Publer). The WORKSPACE_ID is an identifier rather than
    # a credential, but it travels with its key and is pointless to split across
    # two storage mechanisms.
    "PUBLER_API_KEY"      = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PUBLER-API-KEY)"
    "PUBLER_WORKSPACE_ID" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PUBLER-WORKSPACE-ID)"

    # Newsletter list and sending (ADR 0030), replacing Klaviyo. A Full access
    # key: contacts and broadcasts need it, and a sending-access key cannot.
    # Seed RESEND-API-KEY on the API-keys page BEFORE this reference is applied,
    # so monitor-unresolved-secrets.yml never sees it unresolved.
    "RESEND_API_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/RESEND-API-KEY)"

    # Whether an approval may send (variables.tf). "false" until an owner sets
    # newsletter_sending_enabled, so approving refuses before Resend is called.
    "NEWSLETTER_SENDING_ENABLED" = var.newsletter_sending_enabled ? "true" : "false"

    # Podcast publishing to Podbean (#437, ADR 0029 §1b, §1c — the show moved
    # there on 2026-10-13). Both values come from a developer app created at
    # https://developers.podbean.com/: the client ID is an identifier and the
    # client secret the credential, and lib/podcast/podbean.js exchanges the
    # pair for an access token (client credentials, POST /v1/oauth/token) on
    # each run. The Integrations page checks them with GET /v1/podcast. They
    # travel together like the Publer workspace id and key. Unseeded,
    # readKey() sees the unresolved reference as "not configured" and
    # approving an episode leaves it on the manual upload path rather than
    # failing.
    "PODBEAN_CLIENT_ID"     = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PODBEAN-CLIENT-ID)"
    "PODBEAN_CLIENT_SECRET" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PODBEAN-CLIENT-SECRET)"

    # StreamYard On-Air webinar integration (lib/streamyard/onair.js). Issued in
    # StreamYard under Team settings -> Integrations -> Zapier -> Generate API key.
    # Authenticates inbound webinar registrant and attendance webhooks and signs
    # outbound registration forwards. Listed in EXPECTED_UNRESOLVED in
    # scripts/check-unresolved-secrets.mjs until seeded on the Integrations Keys tab.
    "STREAMYARD_API_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/STREAMYARD-API-KEY)"

    # Qlty (#569): read-only access to this repository's open findings and
    # metrics for the Health Hub's Code and Security tab
    # (lib/code-quality/qlty-summary.js). A personal access token from
    # https://qlty.sh/user/settings/tokens. Seed QLTY-API-TOKEN on the
    # Integrations Keys tab BEFORE this reference is applied, so
    # monitor-unresolved-secrets.yml never sees it unresolved. Unseeded,
    # readKey() treats the reference as "not configured" and the tab says so.
    "QLTY_API_TOKEN" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/QLTY-API-TOKEN)"

    # Plaud Embedded Transcription API (#442): the direction the Plaud MCP
    # lacks — transcribing audio the owner uploads. A DIFFERENT credential from
    # the MCP OAuth token pair, which lives on the mcp_servers/plaud document
    # and never in the vault; both are needed, one per direction. The pair is
    # issued in the Plaud Embedded portal (docs.plaud.ai/plaud-embedded) and
    # sent as the X-Client-Id / X-Client-Api-Key headers
    # (functions/src/lib/podcast/plaud-embedded.js). Unseeded, readKey() sees
    # the unresolved references as "not configured" and the upload route
    # answers 503 with a sentence naming them, before any audio is stored.
    "PLAUD_EMBEDDED_CLIENT_ID" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PLAUD-EMBEDDED-CLIENT-ID)"
    "PLAUD_EMBEDDED_API_KEY"   = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PLAUD-EMBEDDED-API-KEY)"

    # The origin the media route is reachable on from the internet — the API's
    # own Cloudflare-fronted hostname, not the storage account (closed by
    # network rule) and not the SPA's. The transcription job hands Plaud
    # `${PUBLIC_API_ORIGIN}/api/public/media/podcast/uploads/<uuid>.<ext>` as
    # the file to fetch; without this there is no URL a third party can read.
    # Not a secret: a hostname derived from var.domain.
    "PUBLIC_API_ORIGIN" = "https://api-azure.${var.domain}"

    # Telegram notifications.
    "TELEGRAM_BOT_TOKEN" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/TELEGRAM-BOT-TOKEN)"
    "TELEGRAM_CHAT_ID"   = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/TELEGRAM-CHAT-ID)"

    # Staging-preview link signing (T-606). Until the secret is seeded via the
    # vault procedure, readKey() sees the unresolved reference as unconfigured
    # and the preview route answers 404 — the loop arms itself when seeded.
    "PREVIEW_SIGNING_SECRET" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/PREVIEW-SIGNING-SECRET)"

    # Hybrid Lab — Coder status proxy (ADR 0032 decision 4, #680). The public
    # labs page shows Coder's templates and running-workspace count through
    # lib/labs/coder-status.js, a server-side read with a read-only token, so
    # the browser never calls Coder and the SPA's connect-src stays closed.
    # CODER_URL is an address rather than a credential and is a vault reference
    # anyway: the pair is then seeded through the one procedure and
    # monitor-unresolved-secrets.yml watches both. Until they resolve, the
    # route answers { configured: false } and the card reads "not yet
    # provisioned". CODER-URL is seeded as soon as this applies: its value
    # is known. CODER-STATUS-TOKEN cannot be: Coder issues it, so it exists
    # only after Coder runs on the lab host (#661) and the owner creates it
    # (#682). Until then it is listed in EXPECTED_UNRESOLVED in
    # scripts/check-unresolved-secrets.mjs, reported every run but not as a
    # failure; remove it from that list in the PR after it is seeded.
    "CODER_URL"          = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CODER-URL)"
    "CODER_STATUS_TOKEN" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CODER-STATUS-TOKEN)"
    # Community edition's concurrency cap, the denominator on the card. Not a
    # secret. The code defaults to 5 when this is unset or unparseable.
    "CODER_MAX_WORKSPACES" = "5"

    # Hybrid Lab — the visitor session broker (#1016, ADR 0032 amendment of
    # 2026-10-17, #1403). This is the Coder token that lib/labs/visitor-session.js
    # creates and deletes visitors' Coder users and workspaces with, and that the
    # sweepVisitorSessions timer deletes with. It is NOT the status token above:
    # that one can only read, and the code does not fall back to it, because a
    # broker built on a read-only token would be refused on every create and
    # every delete. A vault reference like every other credential here, so the
    # value never enters Terraform or its state; a human seeds it on the
    # Integrations Keys tab (or `az keyvault secret set`) once the owner has
    # minted it in Coder.
    #
    # Applying this without the secret is safe and is meant to be done first,
    # for the order TURNSTILE_SECRET_KEY below describes: this run, the
    # functions deploy, then the seed. Until the secret exists the reference
    # arrives as the literal @Microsoft.KeyVault(...) text, which
    # resolvedSetting() in lib/auth/client-identity.js reads as "not set", so
    # readBrokerConfig() returns null and the sweep logs one Warning ("Coder
    # is not set up") and calls nothing. The visitor routes check the
    # LABS_VISITOR_SESSIONS_ENABLED switch and Turnstile first (the switch is
    # not declared here yet, so they answer "closed"), and only then answer
    # VISITOR_NOT_CONFIGURED. It is listed in EXPECTED_UNRESOLVED in
    # scripts/check-unresolved-secrets.mjs meanwhile, reported every run but
    # not as a failure. Remove it from that list in the PR after it is seeded.
    "CODER_BROKER_TOKEN" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CODER-BROKER-TOKEN)"

    # Tool add-ons (ADR 0035 decision 4). The address of each AddOn the
    # status proxy (lib/addons/status.js) reads `/api/health` from, so the
    # pane at /tools/<id> opens only when the AddOn answers. A plain setting,
    # not a Key Vault reference: the value is public (it is in the site's
    # CSP frame-src and is the frame's src), no credential travels with it,
    # so there is no vault seeding and no unresolved-reference monitor for
    # it. Unset it to close the pane: the proxy then answers
    # { configured: false } and the page shows its one sentence.
    #
    # Cloud Crawler's is set before its catalogue row is `available` (#1357),
    # so the status read can be checked once the lab host runs its container.
    # Nothing is framed meanwhile: the origin joins frame-src with the row,
    # and a `coming` row renders its explainer whatever the proxy answers.
    "ADDON_MIGRATION_URL"          = "https://migration.lab.hybridcloudworks.com"
    "ADDON_NETWORK_ASSESSMENT_URL" = "https://network-assessment.lab.hybridcloudworks.com"
    "ADDON_CLOUD_ASSESSMENT_URL"   = "https://cloud-assessment.lab.hybridcloudworks.com"
    "ADDON_CLOUD_CRAWLER_URL"      = "https://cloud-crawler.lab.hybridcloudworks.com"

    # Hybrid Lab — the Landing Zone Builder's public "Validate on the lab"
    # (ADR 0032 decision 6, revised 2026-09-28: open, locked to the site's
    # pane by its origin and a Cloudflare Turnstile token). The switch is
    # labs_public_submission_enabled (variables.tf); lib/labs/public-submit.js
    # takes nothing unless it is exactly "true".
    "LABS_PUBLIC_SUBMISSION_ENABLED" = var.labs_public_submission_enabled ? "true" : "false"
    # The widget's secret key, which lib/labs/public-lock.js sends to
    # Cloudflare's siteverify and nowhere else. A vault reference, never a
    # Terraform value: the widget is created in the Cloudflare dashboard, not
    # here, because cloudflare_turnstile_widget would hold this secret in
    # state (frontend.tf says why, beside the Cloudflare resources).
    #
    # It cannot be seeded before this applies, unlike RESEND or QLTY above:
    # the Integrations Keys tab offers only secrets the DEPLOYED catalogue
    # lists, and deploy-functions.yml refuses to start while this run is
    # unfinished and fails if the live settings lack a reference declared
    # here. So the order is this run, the functions deploy, then the seed,
    # and in between the reference is unresolved on purpose: it is listed in
    # EXPECTED_UNRESOLVED in scripts/check-unresolved-secrets.mjs, reported
    # every run but not as a failure. Remove it from that list in the PR
    # after it is seeded. Unseeded, resolvedSetting() in
    # lib/auth/client-identity.js reads the unresolved reference as unset: the
    # builder's button says the browser check is not configured and the lab
    # takes nothing.
    "TURNSTILE_SECRET_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/TURNSTILE-SECRET-KEY)"

    "NODE_ENV" = "production"

    # Timer clock: UTC, and there is deliberately NO app setting here.
    #
    # Owner decision 2026-09-07 (#416): all times in this app are UTC. Every
    # NCRONTAB hour in functions/src/functions/ is therefore a UTC hour, and
    # the six places that already claimed "03:00 UTC" for the Cosmos exporter
    # became true rather than wrong.
    #
    # WEBSITE_TIME_ZONE = "America/Chicago" used to sit on this line, so that
    # the 7 of Site-Main's 16 schedules declared in Central could be ported
    # verbatim. It was removed rather than re-set to "UTC" for two reasons.
    # UTC is already the platform default — "The default time zone used with
    # the CRON expressions is Coordinated Universal Time (UTC)" — so the
    # setting would buy nothing. And Microsoft documents it as UNSUPPORTED on
    # the plan this app runs on: "WEBSITE_TIME_ZONE and TZ aren't currently
    # supported when running on Linux in a Flex Consumption or Consumption
    # plan. In this case, the setting WEBSITE_TIME_ZONE or TZ can create
    # SSL-related issues and cause metrics to stop working for your app."
    # (learn.microsoft.com/azure/azure-functions/functions-bindings-timer,
    # "NCRONTAB time zones", retrieved 2026-09-07; the support table lists
    # Linux Premium and Dedicated only.) Setting it to "UTC" would keep an
    # unsupported setting on an unsupported plan in exchange for nothing.
    #
    # Nothing in functions/src formats a local time for a human: every date it
    # derives comes from toISOString() or a getUTC* method, so the app clock
    # reaches NCRONTAB and the host's own log stamps and nothing else.
    #
    # timer-schedules-utc.test.js is the guard — it fails if this setting (or
    # TZ) returns, and it pins each clock-dependent schedule to the UTC time
    # it is meant to mean.

    # T-206, last step. With "1" the public content list asks Cosmos for the
    # NEWEST N documents (ORDER BY c.cp_sortDate DESC) instead of an arbitrary
    # N that is then sorted in memory. cp_sortDate is a computed property the
    # apply writes onto `content` and `blogs` and fails without
    # (azapi_update_resource.cosmos_computed_properties in cosmos.tf, #816) —
    # present on both since 2026-08-21 — and it is defined on every document
    # ("" when no date alias exists), which is what makes ORDER BY safe.
    # Precondition before flipping: `apply-computed-sortdate.mjs --inspect`
    # clean (every date alias ISO-sortable). Flip back to "0" if the list
    # ever comes back empty or mis-ordered; the in-memory sort still runs.
    "PUBLIC_LIST_SQL_ORDER" = "1"

    # Feature flags.
    #
    # One per timer. They previously shared FEATURE_FLAG_SCHEDULERS, so enabling
    # the scheduled publisher would also have armed cleanupTempStorage, which
    # was then an unimplemented stub that would delete blobs (T-302). It is
    # implemented now, in functions/src/lib/timers/temp-storage.js.
    #
    # FEATURE_FLAG_SCHEDULERS is a master kill switch only: "false" holds every
    # timer off regardless of the individual flags, and any other value defers
    # to them (schedulers.js: `masterDisabled = FEATURE_FLAG_SCHEDULERS ===
    # 'false'`, checked before the per-timer flag).
    #
    # IT WAS A HARDCODED "false" HERE UNTIL 2026-08-24, which quietly cancelled
    # the design the next twenty lines describe. `enabled_timers` is a workspace
    # variable so that arming a timer is a variable edit, but the master switch
    # sat above it as a literal — so adding a timer to `enabled_timers` produced
    # a green apply, a changed app setting, and a timer that still returned
    # "disabled — skipping" on every tick. All 18 were permanent no-ops and
    # nothing said so. A cutover step cannot be verified by the thing it
    # configures if that thing is a constant.
    #
    # var.schedulers_master_enabled defaults to false, so this line writes the
    # same "false" it wrote before until an owner decides otherwise. What
    # changed is that the decision is now reachable.
    "FEATURE_FLAG_SCHEDULERS" = var.schedulers_master_enabled ? "true" : "false"

    # One flag per timer (functions/src/functions/schedulers.js, Migration-Plan
    # §4.2). All implemented; each is turned on ONE AT A TIME at cutover after
    # being observed firing at the intended local time (§6 step 7).
    #
    # These are generated from `local.timer_flags` rather than written out here,
    # so turning a timer on is a WORKSPACE VARIABLE edit — add its name to
    # `enabled_timers` — and not a code change. Twenty timers turned on one at
    # a time would otherwise be twenty pull requests during a cutover window,
    # which is how a "one at a time, watch each one" procedure quietly becomes
    # "turn them all on and see what breaks".
    #
    # The name in `enabled_timers` is the flag suffix, e.g. SYNC_RSS_FEEDS. An
    # unrecognised name fails the plan (see the validation on the variable)
    # rather than silently arming nothing, because a typo here is indisting-
    # uishable from a timer that does not fire.
    }, local.timer_flags, {
    # The three that delete stay DRY-RUN even when their flag is on, until
    # the matching *_DELETE setting is "true" (T-302). Deliberately NOT
    # part of enabled_timers: arming the timer and arming the deletion are two
    # decisions, and conflating them is how a dry run becomes a data loss.
    # CONTENT_HARD_DELETE is the content reaper's pin (T-518 Wave 3a): the
    # only one of the three that deletes documents rather than blobs. Flipped
    # 2026-09-05 (#343) after two dry-run firings were read at zero across
    # the board — nothing soft-deleted for longer than the 7-day grace window
    # existed, so the first armed run deletes nothing. A mark with no recorded
    # origin is refused in both modes (#334); the owner's planted test page is
    # the live witness for the classification, due a week after its mark.
    "TEMP_STORAGE_CLEANUP_DELETE" = "false"
    "CERT_IMAGE_CLEANUP_DELETE"   = "false"
    "CONTENT_HARD_DELETE"         = "true"

    # The Cosmos out-of-account exporter (ADR 0028, #231): a 03:00 UTC timer
    # that fans one queue message per exported container onto the platform
    # jobs worker, writing gzip-NDJSON to the cosmos-export container in
    # storage.tf. Its own variable rather than a name in enabled_timers,
    # because that variable also creates the two missing-run alert rules in
    # observability.tf: the exporter and the alert on its absence are one
    # decision, armed and disarmed together (the variable's comment says why).
    # "true"/"false" like every FEATURE_FLAG_* above, and not "1"/"0":
    # schedulers.js and jobs-sweeper.js both compare against the literal
    # string "true", so any other spelling is a flag that reads as on in
    # Terraform and off in the app — the hardcoded-"false" failure of
    # 2026-08-24 in a new coat.
    "FEATURE_FLAG_COSMOS_EXPORT" = var.cosmos_export_enabled ? "true" : "false"

    # Extra browser origins allowed to call the API, comma-separated, on top of
    # the production allowlist compiled into lib/auth/cors.js
    # (hybridcloudworks.com and www). Needed for §6 step 2: the site runs on the
    # Static Web App's own *.azurestaticapps.net hostname before DNS moves, and
    # that origin is not in the compiled list — so without this every API call
    # from the parallel-running site fails CORS, which looks like a broken API.
    # NOT "CORS_ALLOWED_ORIGINS" — that name collides with the read-only CORS
    # environment variables App Service injects from siteConfig.cors, so the
    # worker receives an empty array's serialisation (`[]`) no matter what is
    # written here. Proven on 2026-08-22 by three independent writers, T-513.
    "EXTRA_ALLOWED_ORIGINS" = join(",", var.cors_extra_origins)

    # T-513 sentinel — which writer's configuration generation is this worker
    # actually running? ARM answers "the last one written". Only the worker can
    # answer "the one I consumed", and on 2026-08-22 those disagreed: a fresh
    # worker held the literal string `[]` for CORS_ALLOWED_ORIGINS while ARM
    # held the real value.
    #
    # Two dimensions, because one cannot separate the two writes that happen in
    # a single apply — azurerm writes this whole map, then the azapi pair below
    # reads the result back and writes it again minus AzureWebJobsStorage. Both
    # carry the same generation. The WRITER marker is the only thing that says
    # which of the two a process consumed, and the azapi write deliberately
    # overrides it to `azapi-strip`.
    #
    # NOT timestamp(): that would change on every plan, propose a diff forever
    # and restart the host each apply. The generation must be an immutable
    # identifier supplied by whatever performed the deployment.
    # Guard gate 2 — the admins/{oid} registry (lib/admin-identity.js).
    # Gate 1 is the Entra `Admin` App Role; a token carrying it and no registry
    # record is still a 403, which is the point: directory membership alone does
    # not grant access to this application.
    #
    # This allowlist is consulted ONLY when the registry holds zero active
    # admins — bootstrapCurrentUserAdmin checks that first and requires
    # super_admin for every later call. So it is a first-admin escape hatch, not
    # a standing grant, and FINDING-06 forbids an allow-any form of it.
    #
    # BOTH forms are set deliberately. The owner is a B2B guest whose UPN
    # (spatino_hybridcloudworks.com#EXT#@...onmicrosoft.com) is not their mail
    # address, and which of the two an Entra token carries in `email` /
    # `preferred_username` is not worth guessing — the object id is unambiguous
    # and the email costs nothing as a second chance.
    "CMS_BOOTSTRAP_ALLOWED_UIDS"   = join(",", var.bootstrap_admin_oids)
    "CMS_BOOTSTRAP_ALLOWED_EMAILS" = join(",", var.bootstrap_admin_emails)

    "RUNTIME_CONFIG_GENERATION" = var.config_generation

    # THIS KEY MAKES EVERY PLAN SHOW A DIFF, AND THAT IS EXPECTED.
    #
    # azapi_update_resource below rewrites it to "azapi-strip" in the same
    # apply, so the live value is never what this line declares. Every
    # subsequent plan therefore reports:
    #
    #   ~ "RUNTIME_CONFIG_WRITER" = "azapi-strip" -> "azurerm"
    #   Plan: 3 to add, 1 to change, 3 to destroy
    #
    # — the change being this key, and the 3/3 being the three azapi resources
    # replaced by their `replace_triggered_by`: the settings read, the settings
    # strip, and the FTP basic-auth policy below them. (It was 2/2 until
    # 2026-08-24, when the FTP policy was added.) A plan reporting exactly that
    # and nothing else means NO DRIFT.
    #
    # DO NOT APPROVE THAT BY EYE (T-724). "And nothing else" is the entire
    # content of the claim, and it is the part a human reading a summary line
    # cannot check: three destroys look like three destroys whichever three
    # they are, and since T-708 the Cosmos containers are exactly the kind of
    # resource that could be among them. Run the assertion instead —
    #
    #     terraform show -json tfplan > plan.json
    #     node scripts/assert-expected-plan.mjs plan.json
    #
    # — which compares the change set against the three azapi ADDRESSES and
    # this one attribute, and fails on anything else, including a second
    # setting changing on this same resource. It also fails when an expected
    # change STOPS appearing, because a strip that is not running is how
    # AzureWebJobsStorage comes back (T-511).
    #
    # It runs in CI as `tfc-plan-check.yml`, on the `TFC_TOKEN` secret, and
    # `--commit` (T-724, #298) picks the run HCP Terraform planned for a given
    # commit. It is dispatch-only by design: the decision it gates comes after
    # the merge, when a queued plan is waiting to be confirmed, so it is
    # dispatched then, with the merge commit. A speculative plan on a pull
    # request gates nothing. That workflow's header has the full reasoning.
    #
    # ON EVERY azurerm MINOR UPGRADE, re-test issue #29149. If it has closed,
    # delete the azapi pair, T-511 and scripts/assert-expected-plan.mjs
    # together (the azapi provider stays: lab-hybrid.tf uses it too, #726),
    # and confirm with the
    # post-apply check in deploy-functions.yml — which is what fails if the
    # strip stops working.
    #
    # It is noise, it is permanent, and the
    # only thing worse than the noise is silencing it wrongly.
    #
    # Do NOT "fix" it with ignore_changes on this key. That would make azurerm
    # carry the live "azapi-strip" into its own write, so a worker that
    # consumed the FIRST write and missed the strip would report "azapi-strip"
    # too — which is the one thing this marker exists to make impossible. The
    # strip is what keeps AzureWebJobsStorage from breaking SyncTriggers, and
    # three production incidents were diagnosed by exactly this distinction.
    #
    # The drift is structural: two writers manage one settings map, and telling
    # them apart requires them to disagree. It cannot be removed without
    # removing the signal. It goes away on its own when
    # hashicorp/terraform-provider-azurerm#29149 closes and both azapi
    # resources are deleted — see the T-511 block below.
    "RUNTIME_CONFIG_WRITER" = "azurerm"
  })

  identity {
    type = "SystemAssigned"
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Strip the `AzureWebJobsStorage` azurerm re-injects — T-511.
# ---------------------------------------------------------------------------
#
# `azurerm_function_app_flex_consumption` writes an `AzureWebJobsStorage`
# connection string with an EMPTY AccountKey on every apply, whatever
# `storage_authentication_type` says, and never shows it in plan
# (hashicorp/terraform-provider-azurerm#29149, open since March 2025). The host
# prefers that string over the identity-based `AzureWebJobsStorage__accountName`
# below, attempts shared-key auth with no key, and fails every storage call on
# the signature — which does NOT present as storage. It presents as SyncTriggers
# not registering new functions, and as "The listener for function 'Functions.X'
# was unable to start" on every timer and queue trigger. Three incidents:
# 2026-08-20 (every route 404), 2026-08-21 (83 deployed / 80 registered), and
# 2026-08-21 again (timer listeners down through the 104-function deploy).
#
# The widely-cited `"AzureWebJobsStorage" = ""` workaround is NOT used here: it
# worked until early May 2026 and then stopped, confirmed by three separate
# reporters on the issue. An empty value is also indistinguishable from a
# misconfiguration to anyone reading this file later.
#
# So the setting is removed inside the same apply that creates it. `list` reads
# the settings azurerm has just written; `update` writes them back without that
# one key. `replace_triggered_by` on the whole function app is deliberate rather
# than on `.app_settings` alone — the provider decides when it re-injects, this
# configuration does not, and a narrower trigger is a guess about behaviour that
# is already known to change without notice. If the function app did not change,
# azurerm wrote no config and there is nothing to strip.
#
# This is why azapi is a dependency (providers.tf). It is a thin ARM passthrough:
# it writes the body it is given and nothing else, which is exactly the property
# azurerm lacks here.
#
# WHEN #29149 CLOSES, delete both resources and T-511 — and confirm with the
# post-apply check in deploy-functions.yml, which is what fails if this stops
# working. Keep the azapi provider: lab-hybrid.tf creates the lab Vault's seal
# key with it (#726).
#
# WHAT THE ORDER GUARANTEES, AND WHAT NO ORDER CAN (PLAT-2, #962).
#
# Terraform runs a node only when every node it depends on finished without
# error. A node whose dependency failed is skipped ("upstream dependencies
# failed"), and every node that does not depend on the failure still runs: an
# error does not stop the walk (internal/dag/walk.go in hashicorp/terraform,
# read 2026-10-09). Nothing a configuration can declare runs after a
# dependency that failed; the one vertex type that does, dag.AlwaysRunVertex,
# is Terraform's own policy evaluation.
#
# The pair below depends on the Function App and on nothing else outside
# itself, so:
#
#   - An error in any OTHER resource cannot strand the strip. If that resource
#     is not one the Function App depends on, the list and the strip still run
#     after azurerm's write. If it is, the Function App is skipped as well and
#     azurerm writes nothing that needs stripping. The Cloudflare record that
#     errored on 2026-10-06 (frontend.tf) is the first kind.
#   - An error ON the path can: the Function App's own update failing after
#     azurerm's settings write has reached ARM, the list or the strip failing,
#     the azapi provider failing, or the run being cancelled between them. So
#     can a `-target` that names the Function App and not the pair, and that
#     apply is green. No ordering closes this, because the strip has to run
#     after the write and Terraform runs nothing after a node that failed.
#
# So the order below is already the strongest Terraform offers, and what
# remains is detection and convergence:
#
#   - The pair has no depends_on and references only the Function App and the
#     list. Every resource added to its ancestry is one more failure that can
#     strand it, so scripts/webjobs-strip-ancestry.test.mjs fails if it gains
#     one.
#   - A stranded host carries the strip's signature inverted: AzureWebJobsStorage
#     present, or RUNTIME_CONFIG_WRITER other than azapi-strip.
#     deploy-functions.yml fails on either before it syncs triggers, and
#     monitor-functions-registered.yml reports both on its timer.
#   - Re-applying converges. Both are replaced through replace_triggered_by,
#     and Terraform destroys the old instances before the Function App update
#     they depend on (DestroyEdgeTransformer, internal/terraform/
#     transform_destroy_edge.go). A skipped create therefore leaves the list
#     or the strip absent from state, and one whose own call failed may leave
#     it tainted, so the next plan creates or replaces it whether or not the
#     Function App still shows a change. That plan is not the permanent diff,
#     so tfc-plan-check.yml reports it; it is the repair, and the owner's read
#     after it is docs/runbooks/deployment-runbook.md, section 4 step 1.

# SECRETS-IN-STATE: THIS EXPORT IS THE WHOLE LIVE SETTINGS MAP (T-723).
#
# `response_export_values = ["properties"]` is not a projection of what the HCL
# above declares — it is everything ARM currently holds on the app, written into
# Terraform state unredacted and from there into HCP Terraform's plan JSON. The
# IaC standard says secret values never transit state.
#
# It is safe because of exactly one property, and the property is not local to
# this resource: **every secret-shaped app setting is a
# `@Microsoft.KeyVault(SecretUri=…)` reference**, so what lands in state is a
# pointer rather than a credential. The first setting written with a literal
# value — here, or out of band by a human on the live app — makes a credential
# round-trip through state on every apply, with no plan diff worth noticing and
# no error.
#
# `functions/src/functions/app-settings-secrets.test.js` asserts that invariant
# by reading this file as text, so it fails in CI rather than being rediscovered
# from a state file. It cannot see an out-of-band write; nothing here can, which
# is why Required-Inputs §4.5 says settings are Terraform-managed and editing one
# by hand is how drift starts.
#
# The narrower export that would remove the problem does not exist: the strip
# below has to rewrite the complete map, because ARM's appsettings PUT replaces
# rather than merges — sending a subset would delete every setting not sent.
resource "azapi_resource_action" "function_app_settings" {
  type        = "Microsoft.Web/sites@2024-04-01"
  resource_id = azurerm_function_app_flex_consumption.hcw.id
  action      = "config/appsettings/list"
  method      = "POST"

  response_export_values = ["properties"]

  lifecycle {
    replace_triggered_by = [azurerm_function_app_flex_consumption.hcw]
  }
}

resource "azapi_update_resource" "function_app_settings_without_webjobs_storage" {
  type        = "Microsoft.Web/sites/config@2024-04-01"
  resource_id = "${azurerm_function_app_flex_consumption.hcw.id}/config/appsettings"

  body = {
    # The WRITER marker is overridden here and the generation deliberately is
    # not. Both writes belong to the same apply and therefore the same
    # generation; what differs is which of them a worker actually consumed
    # (T-513). A worker reporting `azurerm` has the first write and missed this
    # one; `azapi-strip` has this one. Without the marker the two are
    # indistinguishable, because ARM shows only the final state either way.
    #
    # Each value passes through tostring() (#837). App-settings values are
    # strings and ARM's appsettings PUT takes a string map, so this changes
    # nothing today. What it buys: a value that ever comes back from the list
    # call as an object or a list stops this apply with an error naming the
    # conversion, rather than being written back in whatever shape azapi
    # decoded it. It was held back while T-513 was open, because it could have
    # hidden the fault under investigation. T-513 closed as a name collision
    # (CORS_* against a variable App Service injects), not a value problem
    # (CHANGELOG.md).
    properties = merge(
      {
        for key, value in azapi_resource_action.function_app_settings.output.properties :
        key => tostring(value) if key != "AzureWebJobsStorage"
      },
      { "RUNTIME_CONFIG_WRITER" = "azapi-strip" }
    )
  }

  lifecycle {
    replace_triggered_by = [azapi_resource_action.function_app_settings]
  }
}

# ---------------------------------------------------------------------------
# FTP basic publishing credentials, off.
# ---------------------------------------------------------------------------
#
# `webdeploy_publish_basic_authentication_enabled = false` above closes the SCM
# half of publishing credentials. It reads like it closed both, and it did not:
# Azure keeps two independent `basicPublishingCredentialsPolicies` child
# resources, `scm` and `ftp`, and the azurerm argument writes only the first.
# On the live app that left `scm.allow = false` next to `ftp.allow = true` —
# a username/password publishing surface still open on a production app that
# has never used a publish profile and deploys with OIDC.
#
# There is no azurerm argument for the FTP half on this resource type.
# `azurerm_linux_function_app` has `ftp_publish_basic_authentication_enabled`;
# `azurerm_function_app_flex_consumption` does not expose it in 5.1.0 —
# confirmed against the installed provider's own schema, whose only publishing
# argument is the webdeploy one. So this is the same shape as the strip above:
# azapi writes the one property azurerm cannot reach, and nothing else.
#
# `replace_triggered_by` on the whole function app for the same reason the pair
# above carries it. The FTP policy is a CHILD of the site: replace the site and
# the child comes back at its default, which is `allow: true`. Without this the
# lock would come off silently on the one event that recreates the app, and the
# only way to notice would be to go and look. This costs one more add/destroy
# pair in every plan (see the RUNTIME_CONFIG_WRITER note above, which counts
# them) and buys a setting that cannot quietly revert.
#
# THE WAY BACK IS NOT DELETING THIS RESOURCE. Every other control in this
# configuration reverts by changing a value and applying; this one does not,
# because destroying an azapi_update_resource performs no API call — it drops
# the resource from state and leaves the property exactly as it last wrote it.
# So removing this block leaves FTP basic auth OFF permanently and silently.
# That is the desirable direction and it is still a surprise if nobody says so.
# To actually restore FTP publishing, set `allow = true` here and apply, or
# write the property directly with `az resource update` against the same
# basicPublishingCredentialsPolicies/ftp child — then remove the block.
resource "azapi_update_resource" "function_app_ftp_basic_auth" {
  type        = "Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01"
  resource_id = "${azurerm_function_app_flex_consumption.hcw.id}/basicPublishingCredentialsPolicies/ftp"

  # Ordered after the app-settings strip rather than left to the graph. Both
  # write children of the same site and both are replaced on every apply via
  # replace_triggered_by, so without an edge their relative order is incidental.
  # The strip is the one that matters: until it completes the site is carrying a
  # keyless AzureWebJobsStorage, which is the state three recorded incidents came
  # from. Finish that first, then harden FTP.
  depends_on = [azapi_update_resource.function_app_settings_without_webjobs_storage]

  body = {
    properties = {
      allow = false
    }
  }

  lifecycle {
    replace_triggered_by = [azurerm_function_app_flex_consumption.hcw]
  }
}

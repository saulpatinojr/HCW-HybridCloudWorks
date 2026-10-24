# =============================================================================
# frontend.tf — Static Web App, its custom hostname binding, and the
# Cloudflare records and origin-secret ruleset that front the API.
#
# Split out of main.tf on 2026-08-29 (T-754). Terraform reads every .tf file in
# this directory as ONE module: same namespace, same state, same plan. Nothing
# moved between states and no resource address changed — an empty plan is the
# proof, and `functions/test/terraform-source.js` is why the text-reading guards
# did not need to care.
# =============================================================================

# `sampling_percentage` is DELIBERATELY NOT SET, and the reason is not
# oversight — it was proposed as the fix for the OverQuota workspace on
# 2026-08-24 and it is the wrong instrument here. Recorded so it is not
# proposed again.
#
# That argument configures INGESTION sampling, which Microsoft documents as
# operating "only when no other sampling is in effect: if the SDK samples your
# telemetry, ingestion sampling is disabled". Azure Functions enables ADAPTIVE
# sampling by default and functions/host.json enables it explicitly, with
# `excludedTypes: "Request"`. The consequence is exact and backwards:
#
#   - AppTraces, the table that is ~38% of the daily cap, IS sampled by the
#     host, so ingestion sampling does not touch it. Setting this would not
#     reduce the volume that caused the problem.
#   - Requests are EXCLUDED from host sampling, so they are the telemetry
#     ingestion sampling would actually discard. AppRequests and AppExceptions
#     are 0.3% of the cap each and are the two tables an incident is read from
#     — and observability.tf now runs an alert rule that counts AppExceptions
#     rows, which Microsoft's own guidance says sampling degrades ("alerts can
#     only trigger upon sampled data").
#
# So the setting would cost the alerting that landed in the same change and
# save nothing. The ingestion problem is fixed where the volume actually is:
# the Cosmos categories in observability.tf. The size of that reduction is
# stated there as a floor rather than a measurement — the figures behind it were
# sampled while the workspace was already capped, so they understate the true
# volume — and it has to be confirmed after a full uncapped day. Repeating a
# precise before/after number here would put two different claims in two files.
#
# If more headroom is ever needed, the levers in order are: host.json
# `logLevel` (Information-level host traces are what AppTraces mostly is),
# host.json `maxTelemetryItemsPerSecond` on the adaptive sampler, and then a
# workspace ingestion-time transformation — which is what Microsoft's daily-cap
# guidance recommends over a cap in the first place. All three are deterministic
# about WHAT they drop. This one is not.

# =============================================================================
# Azure Static Web App (frontend hosting)
#
# Free tier since 2026-09-05 (owner decision, #341). Everything this estate
# uses is in Free: custom domains with managed SSL (2 per app — the apex and
# www are exactly 2), global distribution, SPA routing (navigationFallback in
# staticwebapp.config.json), 3 preview environments, 100 GB bandwidth a month
# included, and a 250 MB app limit against a build of about 117 MB. The
# comment that used to sit here listed those as Standard-only; checked
# against Microsoft's plan comparison on 2026-09-02, none of them is.
#
# What Standard bought and this estate did not use: the 99.95% SLA, bandwidth
# overage at USD 0.20/GB (Free has none: past 100 GB the site stops serving),
# networking.allowedIpRanges, bring-your-own-Functions linking, custom auth
# registrations, private endpoints. About USD 9 a month, the workload's one
# fixed line.
#
# Nothing caches in front of that 100 GB. This comment used to say Cloudflare
# caching made an overage unlikely. It does not: the apex and www are DNS-only
# records that resolve straight to the Static Web App (both A records read
# 64.236.125.137 and www is a CNAME to the azurestaticapps.net host, read
# 2026-10-15; PLAT-10, #970), so every byte the site serves counts against the
# plan. What watches the pace is alert-swa-bandwidth in observability.tf
# (#1052): BytesSent over the trailing 24 hours past 80% of a thirtieth of the
# month, hourly, which pages while there is still month left to act in.
#
# Microsoft documents moving between Free and Standard in either direction,
# so this is a two-way door: a third custom domain or a bandwidth overage is
# the signal to move back, and it is these two lines plus an apply.
# =============================================================================
resource "azurerm_static_web_app" "hcw" {
  name = "stapp-${var.workload_name}-${var.environment}-${var.region_abbreviation}-${var.instance}"
  # Still a separate variable from azure_location even though the two now hold
  # the same value: Static Web Apps is offered in five regions only, and the
  # validation on static_web_app_location catches a bad region at plan time
  # instead of at apply time. This resource used to be the estate's odd one
  # out — running in centralus while named for southcentralus — and the move
  # to a single region is what retired that exception.
  location            = var.static_web_app_location
  resource_group_name = azurerm_resource_group.app["web"].name
  sku_tier            = "Free"
  sku_size            = "Free"
  tags                = local.tags

  lifecycle {
    # These two are written by the deploy, not by Terraform.
    #
    # `Azure/static-web-apps-deploy` stamps the repository it published from
    # onto the resource. Terraform has never set them, so it reads them as
    # drift and plans to null them — which would win until the next frontend
    # deploy stamped them back, and then plan again. An apply that always
    # shows a change and a deploy that always undoes it is a loop, not a
    # convergence, and it makes "0 changed" stop meaning anything.
    #
    # They are metadata: the deployment uses a token, and nothing about
    # serving the site reads these. The right answer is that the pipeline owns
    # the field, so Terraform stops claiming it. First seen 2026-08-23, on the
    # first plan after the §6 step 1 frontend deploy.
    ignore_changes = [repository_url, repository_branch]
  }
}

# =============================================================================
# Cloudflare DNS — Azure Static Web App custom domain
#
# The existing root Terraform manages VPS subdomains (api, auth, argocd, etc.).
# This module adds the Azure-specific records used by the website and API.
# =============================================================================

# Azure SWA custom domain validation TXT record
# REMOVED 2026-08-23: cloudflare_record.azure_swa_txt_validation
#
# It published the Static Web App's default hostname as a TXT value at the apex
# and was described, here and in the runbook, as the domain-ownership proof. It
# was neither. Azure validates a root domain against a TOKEN it generates when
# the validation starts — a value like `_6sod2vwest3f9qq3jascfmqk4g5c9jt` — and
# it never looks at a hostname in a TXT record. The record was inert from the
# day it was written.
#
# It cost real time on 2026-08-23: the runbook said binding "does not wait on
# DNS moving" because this record existed, so `az staticwebapp hostname set` was
# run for both hostnames and both failed. www needed an actual CNAME; the apex
# needed `--validation-method dns-txt-token` and the generated token.
#
# It is not replaced by a managed record. The token is minted per validation and
# is not knowable at plan time, so pinning one in Terraform would be state that
# drifts the moment Azure reissues it. The procedure is in the runbook, step 3b:
# start the validation, read the token with `az staticwebapp hostname show`, add
# it as a TXT record, and Azure completes on its own.
#
# The `asuid.` convention some Azure docs describe belongs to App Service and
# Front Door, NOT to Static Web Apps. This estate does use it — correctly — for
# the Function App: `cloudflare_record.azure_functions_domain_verification`
# publishes `asuid.api-azure` holding `custom_domain_verification_id`, which is
# exactly how App Service proves domain ownership. Carrying that pattern across
# to the Static Web App is the mistake this comment exists to prevent; SWA
# validates a root domain with a generated token instead.

# Azure Functions subdomain for the API origin.
#
# `name` IS THE FULL RECORD NAME under provider v5, where v4 took the relative
# label "api-azure". The v5 schema documents it as "DNS record name (or @ for
# the zone apex)" and its own example passes a whole hostname. Leaving the bare
# label here would have Cloudflare read it as a name to append the zone to.
#
# `ttl = 1` still means automatic, which is the only value a proxied record
# accepts. v5 makes ttl Required rather than Optional; it was already set here.
resource "cloudflare_dns_record" "azure_functions" {
  zone_id = var.cloudflare_zone_id
  name    = "api-azure.${var.domain}"
  content = "${var.function_app_name}.azurewebsites.net"
  type    = "CNAME"
  proxied = true
  ttl     = 1
  comment = "Azure Functions API endpoint"

  # include_shadow_metadata is a request query parameter the provider surfaces
  # as an attribute with a static default since 5.26.0; left alone it plans
  # null -> false on every existing record and the forced PUT fails
  # "inconsistent result after apply: .modified_on" (cloudflare/
  # terraform-provider-cloudflare #7387, #7396; seen here 2026-10-06 on 5.27.0).
  # Ignoring it is the provider's documented workaround and changes nothing
  # about the record. Drop it when a release removes the default.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

# Documentation site on GitHub Pages (issue #360): docs.<domain> is a CNAME to
# the repository owner's Pages host, saulpatinojr.github.io since the
# repository moved to a personal account on 2026-10-07 (it named the former
# organisation's host until then; both resolve to GitHub's Pages addresses, so
# the change is invisible to visitors, and GitHub's custom-domain check expects
# the owner's own host). DNS-only rather than proxied, deliberately:
# GitHub issues and renews the certificate for a Pages custom domain by
# checking the CNAME resolves to *.github.io, and a proxied record answers
# with Cloudflare's addresses instead, which leaves the domain stuck at
# "certificate pending". The apex stays with the Static Web App; Pages cannot
# share it. `ttl` is a real value because `1` (automatic) is only accepted on
# proxied records.
#
# Order of operations: apply this, then set the custom domain on the Pages
# site (Settings → Pages), then enforce HTTPS once the certificate is issued.
# The CNAME resolving before the site knows the domain is harmless — GitHub
# returns 404 for an unknown host.
resource "cloudflare_dns_record" "docs_pages" {
  zone_id = var.cloudflare_zone_id
  name    = "docs.${var.domain}"
  content = "saulpatinojr.github.io"
  type    = "CNAME"
  proxied = false
  ttl     = 300
  comment = "GitHub Pages documentation site"

  # include_shadow_metadata is a request query parameter the provider surfaces
  # as an attribute with a static default since 5.26.0; left alone it plans
  # null -> false on every existing record and the forced PUT fails
  # "inconsistent result after apply: .modified_on" (cloudflare/
  # terraform-provider-cloudflare #7387, #7396; seen here 2026-10-06 on 5.27.0).
  # Ignoring it is the provider's documented workaround and changes nothing
  # about the record. Drop it when a release removes the default.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

# podcast.hybridcloudworks.com: the show's Podbean website on the owner's
# domain (2026-10-13, when Hybrid Cloud Insights moved from RSS.com to
# Podbean). pbcdn2.podbean.com is the target Podbean's "Use a domain I own"
# page names.
#
# A SUBDOMAIN, NEVER www OR THE APEX. Both are the site, on the Static Web App
# and created by hand (docs/runbooks/edge-dns-verification.md). Podbean's page
# prefills `www`, and a CNAME there would hand the site to the podcast host;
# Cloudflare refused it only because the www record already exists.
#
# DNS-only, for the reason docs_pages is: Podbean provisions the certificate
# for a custom domain itself and needs the name to resolve to its own host,
# and a proxied record answers with Cloudflare's addresses instead. The zone's
# CAA records already admit letsencrypt.org and the other common issuers.
#
# Order of operations: apply this, then enter podcast.hybridcloudworks.com
# under Podbean's Distribution -> Podcast Website -> Website URL -> "Use a
# domain I own" and save. The site reads the show's feed, not this website,
# so admin_config/podcast_feeds does not depend on this record.
resource "cloudflare_dns_record" "podcast_podbean" {
  zone_id = var.cloudflare_zone_id
  name    = "podcast.${var.domain}"
  content = "pbcdn2.podbean.com"
  type    = "CNAME"
  proxied = false
  ttl     = 300
  comment = "Podbean podcast website (Hybrid Cloud Insights)"

  # Same provider workaround as docs_pages above.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

# go.hybridcloudworks.com: the Linkie link-in-bio page on the owner's domain
# (2026-10-24). Linkie serves any hostname that CNAMEs to app.linkie.bio and
# proves ownership with a TXT record; both are what its Domain settings page
# lists after the name is saved there (read 2026-10-24, and its help article
# "How to connect a custom domain").
#
# A SUBDOMAIN, NEVER www OR THE APEX. That page lists the main-domain template
# for any name, including `@` and `www` CNAMEs to app.linkie.bio. For a
# subdomain Linkie's own article says to add only the CNAME named for the
# subdomain and the TXT. The apex and www are the site, on the Static Web App
# (docs/runbooks/edge-dns-verification.md): a CNAME there would hand it to
# Linkie, the same trap the podcast record above names.
#
# DNS-only, as the article says ("if your DNS provider has a proxy option, set
# it to DNS only"): Linkie issues the certificate for the name itself and
# needs it to resolve to app.linkie.bio, and a proxied record answers with
# Cloudflare's addresses instead.
#
# The TXT is named _cf-custom-hostname.go and its value is a UUID Linkie
# generated for this hostname on 2026-10-24. It is an ownership token in public
# DNS, not a secret; if Linkie reissues one (after the domain is removed and
# added again), the new value replaces this one.
#
# Order of operations: the name was entered under Linkie's Settings -> Domain
# first (status Failed until these records exist), because that is what shows
# the TXT value. Apply this, then wait for the status to read Live; DNS can
# take up to 48 hours.
resource "cloudflare_dns_record" "linkie_go" {
  zone_id = var.cloudflare_zone_id
  name    = "go.${var.domain}"
  content = "app.linkie.bio"
  type    = "CNAME"
  proxied = false
  ttl     = 300
  comment = "Linkie link-in-bio page (custom subdomain)"

  # Same provider workaround as docs_pages above.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

resource "cloudflare_dns_record" "linkie_go_verification" {
  zone_id = var.cloudflare_zone_id
  name    = "_cf-custom-hostname.go.${var.domain}"
  content = "dfee1d68-95f7-4a8f-9c0e-7ebe61112472"
  type    = "TXT"
  ttl     = 300
  comment = "Linkie custom-domain ownership proof for go"

  # Same provider workaround as docs_pages above.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

# The rename is a change of resource ADDRESS, so without these Terraform would
# destroy and recreate both records — and these two are the API's hostname and
# the ownership proof Azure reads at bind time. A destroy/create on them is a
# production DNS outage, not a refactor.
#
# The provider ships MoveState handlers for dns_record, so state transforms
# during the move rather than needing `terraform state mv` by hand.
moved {
  from = cloudflare_record.azure_functions
  to   = cloudflare_dns_record.azure_functions
}

moved {
  from = cloudflare_record.azure_functions_domain_verification
  to   = cloudflare_dns_record.azure_functions_domain_verification
}

# =============================================================================
# Cloudflare Turnstile widget — deliberately NOT managed here
#
# The public "Validate on the lab" (ADR 0032 decision 6, revised 2026-09-28)
# needs a Turnstile widget for hybridcloudworks.com in Managed mode. The
# pinned provider has `cloudflare_turnstile_widget` (5.25.0 in
# .terraform.lock.hcl), and it is not used, for three reasons in order:
#
#   1. Its `secret` is a read-only attribute, so managing the widget writes
#      the secret key into HCP Terraform state on every refresh. Secret
#      values never transit state (docs/standards/variables-and-secrets.md);
#      this configuration holds no secret value anywhere, and that is the
#      property worth keeping.
#   2. It needs `account_id` and an account-level Turnstile permission.
#      cloudflare_api_token is scoped to this zone (DNS, Transform Rules and
#      Rulesets:Read); widening the one production-DNS credential to account
#      scope for a resource created once is the wrong trade. (#1302 added
#      Account Settings:Write to that token for the Web Analytics site at
#      the end of this file, which holds no secret; reason 1 is what keeps
#      the widget out, and it is unchanged.)
#   3. The widget is created once and then left alone. The dashboard is one
#      form, and its site key is public.
#
# So the owner creates it at https://dash.cloudflare.com/?to=/:account/turnstile
# (name `hcw-lab-validate`, hostname `hybridcloudworks.com`, which covers www,
# Managed mode, no pre-clearance). The site key becomes the repository
# variable VITE_TURNSTILE_SITE_KEY, which deploy-azure-frontend.yml builds
# in; the secret key goes to Key Vault as TURNSTILE-SECRET-KEY through the
# API-keys page, read by the TURNSTILE_SECRET_KEY reference in
# functionapp.tf. functions/src/lib/labs/public-lock.test.js fails if a
# cloudflare_turnstile_widget resource appears in this directory.
# =============================================================================

# =============================================================================
# Origin lock, Cloudflare half (DECISION 6)
#
# Stamps x-hcw-origin-secret onto every request Cloudflare proxies to the
# origin. functions/src/lib/auth/client-identity.js compares it against the
# CF-ORIGIN-SECRET it reads from Key Vault and, in production, throws when it
# does not match rather than trusting a spoofable CF-Connecting-IP.
#
# Phase is http_request_late_transform, not http_request_transform: the late
# phase runs AFTER any customer transform rules and after Cloudflare's own
# managed headers, so nothing downstream can strip or overwrite the header
# before it reaches the origin.
#
# Created only when a secret is supplied. An empty string means "the lock is
# not configured yet", and creating a rule that stamps an empty header would
# make viaCloudflare() compare "" to "" and pass for everyone — the exact
# silent degradation this design exists to prevent.
# =============================================================================
# =============================================================================
# Custom hostname binding — what makes the proxied hostname reach the app
#
# App Service routes by HTTP Host header. Cloudflare proxies api-azure.<domain>
# to the origin but forwards the ORIGINAL Host, so App Service receives
# `Host: api-azure.<domain>`, finds no site bound to that name, and returns its
# own "404 Web Site not found" page — before the Functions host is consulted at
# all. Every route 404s, and the page talks about custom domains rather than
# routing, which sends you to host.json and the route prefix instead.
#
# Two ways to fix it, and the first is not available here:
#
#   1. Rewrite the Host at the edge, with a Cloudflare Origin Rule. Rejected:
#      the API answers `not entitled to use the HostHeader override` — it is a
#      plan entitlement, not a permission, so no token change reaches it.
#
#   2. Bind the hostname on the Azure side, which is this.
#
# NO CERTIFICATE IS BOUND, deliberately. An App Service Managed Certificate is
# issued only when the hostname resolves to the app, and behind a proxied
# Cloudflare record it resolves to Cloudflare — so managed issuance cannot
# succeed without un-proxying, which would disable the origin lock. It is also
# not needed: Cloudflare connects to the origin at its azurewebsites.net name
# and receives the platform's own wildcard certificate, so the TLS leg is
# already valid. Only the HTTP Host needed fixing.
#
# Verification is the asuid TXT record below rather than a CNAME check, because
# a CNAME check follows DNS to Cloudflare and fails for the same reason.
# =============================================================================
# Full name under v5, same as the CNAME above.
resource "cloudflare_dns_record" "azure_functions_domain_verification" {
  zone_id = var.cloudflare_zone_id
  name    = "asuid.api-azure.${var.domain}"
  content = azurerm_function_app_flex_consumption.hcw.custom_domain_verification_id
  type    = "TXT"
  ttl     = 300
  comment = "Azure custom-domain ownership proof for the Functions origin"

  # include_shadow_metadata is a request query parameter the provider surfaces
  # as an attribute with a static default since 5.26.0; left alone it plans
  # null -> false on every existing record and the forced PUT fails
  # "inconsistent result after apply: .modified_on" (cloudflare/
  # terraform-provider-cloudflare #7387, #7396; seen here 2026-10-06 on 5.27.0).
  # Ignoring it is the provider's documented workaround and changes nothing
  # about the record. Drop it when a release removes the default.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

resource "azurerm_app_service_custom_hostname_binding" "api" {
  hostname            = "api-azure.${var.domain}"
  app_service_name    = azurerm_function_app_flex_consumption.hcw.name
  resource_group_name = azurerm_resource_group.app["web"].name

  # Azure reads the TXT record at bind time, so it has to exist first. The
  # dependency is not inferable from the arguments above.
  depends_on = [cloudflare_dns_record.azure_functions_domain_verification]
}

resource "cloudflare_ruleset" "origin_secret" {
  count = var.cloudflare_origin_secret == "" ? 0 : 1

  zone_id = var.cloudflare_zone_id
  name    = "Origin secret for the Azure Functions origin"
  kind    = "zone"
  phase   = "http_request_late_transform"

  # v5 SHAPE, and all three levels changed. `rules` is a list ATTRIBUTE rather
  # than repeated blocks; `action_parameters` is an attribute; and `headers` is
  # a MAP KEYED BY HEADER NAME, so the v4 `name = "x-hcw-origin-secret"` field
  # becomes the map key and disappears from the object.
  rules = [
    {
      action      = "rewrite"
      description = "Stamp x-hcw-origin-secret on requests proxied to the Functions origin"
      enabled     = true
      # Scoped to the Functions hostname rather than the whole zone: the Static
      # Web App shares this zone and has no use for the header, and a secret is
      # safest where it is not sent to things that do not need it.
      expression = "(http.host eq \"api-azure.${var.domain}\")"

      action_parameters = {
        headers = {
          "x-hcw-origin-secret" = {
            operation = "set"
            value     = var.cloudflare_origin_secret
          }
        }
      }
    }
  ]
}

# =============================================================================
# Cloudflare Web Analytics — the monthly audience figure (#1302)
#
# Owner decision 2026-10-20: the site must be able to state a monthly audience
# figure, for the Docker Captain Thought Leader track and the Microsoft MVP
# metrics. Nothing from this resource is shown to visitors. The beacon reports
# page views to Cloudflare; the ambassadorAudienceMonthly timer reads the
# month's totals back through the Cloudflare API (functionapp.tf, the
# CLOUDFLARE_ANALYTICS_TOKEN reference) and records one number.
#
# `host` AND THE SNIPPET, NOT AUTOMATIC INJECTION. Automatic injection
# rewrites HTML as it passes through the proxy, so it only works on an
# orange-clouded hostname. The apex and www are DNS-only (gray-clouded)
# records that resolve straight to the Static Web App — the "Nothing caches
# in front of that 100 GB" note above — and the only proxied hostname in
# this zone is the API origin, which serves JSON. So `auto_install = false`,
# written out rather than left unset: the schema has no default for it, the
# API echoes the value back on every read, and an attribute that is null in
# the configuration against false in state would plan `false -> null` on
# every run, which tfc-plan-check would report as UNEXPECTED on every main
# plan. The beacon is served by the page itself: the frontend builds the
# snippet in from `site_token`, which is the reason that value is an output
# below rather than a dashboard copy.
#
# `lite = true` asks Cloudflare not to measure visitors in the EU. Cloudflare
# documents it for the proxy-injected snippet ("the JavaScript snippet will
# not be injected for visitors from the EU"), and whether it applies to a
# hand-placed one is unverified until the owner confirms the option on the
# site's Manage page in the Web Analytics dashboard. The figure this exists
# for is a count, not a profile, and a count that leaves EU visitors out is
# still a count; the alternative is a consent prompt on a site that has none.
#
# NOT MARKED SENSITIVE, ON PURPOSE. `site_token` is the value the beacon
# carries in every page it is loaded from (`data-cf-beacon='{"token": "…"}'`
# in the snippet), so anyone with a browser reads it; `site_tag` is the
# site's identifier in the API path. Neither grants anything: the Cloudflare
# API authenticates with an API token, and these are not one. Marking them
# sensitive would hide a public value from the plan and the Outputs tab and
# protect nothing — the no-key-outputs rule in outputs.tf is about
# credentials, and this is not one.
#
# COUNTED ON THE ACCOUNT ID. This is the one account-level resource in the
# configuration, and cloudflare_account_id is null until the owner sets it
# (variables.tf says why it is not required). With count 0 the outputs read
# null and CF_WEB_ANALYTICS_SITE_TAG is written empty, which the timer reads
# as "not configured" and skips. The same guard shape as
# cloudflare_ruleset.origin_secret above: a value that is not there yet is
# an absent resource, never a resource created wrong.
#
# THE TOKEN NEEDS Account → Account Settings → Write for the create (the
# permission Cloudflare's API reference lists for POST
# /accounts/{account_id}/rum/site_info). The permission paragraph beside
# cloudflare_origin_secret in variables.tf carries the full list.
#
# `enabled` is left unset: the schema says it can be used only when
# auto_install is true, and it is false.
# =============================================================================
resource "cloudflare_web_analytics_site" "hcw" {
  count = var.cloudflare_account_id == null ? 0 : 1

  account_id   = var.cloudflare_account_id
  host         = var.domain
  auto_install = false
  lite         = true
}

# =============================================================================
# storage.tf — both storage accounts (content and the Functions host), their
# containers, the lifecycle policy, and the identity-based role assignments
# that replace account keys.
#
# Split out of main.tf on 2026-08-29 (T-754). Terraform reads every .tf file in
# this directory as ONE module: same namespace, same state, same plan. Nothing
# moved between states and no resource address changed — an empty plan is the
# proof, and `functions/test/terraform-source.js` is why the text-reading guards
# did not need to care.
# =============================================================================

# The eleven `moved` blocks that used to follow — carrying the hand-declared
# containers into the for_each map, seven of them with a partition-key change
# — were removed on 2026-08-20. The centralus rebuild of 2026-08-19 recreated
# every container from the spec while all of them were empty, so the moves and
# the key changes both happened through that rebuild; `terraform state list`
# shows only the for_each form. The rebuild and state transition are complete;
# future address or partition-key changes still require an explicit reviewed
# plan.

# =============================================================================
# Azure Storage Account (content and media)
#
# Hot tier for frequently accessed blog covers, cert badges, AI images.
#
# RA-GRS since 2026-08-28 (T-706). It was LRS, and ADR 0018 accepted that
# explicitly "while the Firebase source retains the authoritative copy", with
# a revisit trigger of "when Firebase decommission removes the second copy".
# ADR 0023 removed it: every blob written since the 2026-08-21 cutover — CMS
# uploads, generated Listen & Learn audio, AI covers — existed in exactly one
# copy in one region. Versioning and soft delete (below) protect against
# overwrite and deletion, not against loss of the account or the region.
#
# RA-GRS rather than ZRS, for two reasons. The risk being closed is account and
# regional loss, which zone redundancy does not cover — ZRS keeps three copies
# inside one region. And LRS→ZRS is not expressible here at all: Azure requires
# a customer-initiated *conversion* (`az storage account migration start`),
# while LRS→GRS/RA-GRS is an ordinary settings update Terraform performs in
# place. The RA prefix buys read access to the secondary without a failover,
# which is what makes it useful for recovering one lost blob rather than only
# for a disaster.
#
# Cost: geo-redundancy roughly doubles the per-GB rate and adds a one-time
# egress charge for the initial sync. Against Cost-Analysis.md's figures —
# where storage is a minor line next to telemetry — that is cheap insurance
# for the only copy of every image the site serves.
# =============================================================================
# Resource logs for blob and queue read/write/delete go to Log Analytics
# through azurerm_monitor_diagnostic_setting.content_blob and .content_queue;
# trivy reads only classic queue_properties logging. Infrastructure
# encryption is creation-only; the owner kept this account 2026-09-14 (ADR
# 0031). Both ignores stay directly above the resource: trivy applies only a
# contiguous run of ignore lines. docs/security/scanner-triage.md#trivy
#trivy:ignore:AVD-AZU-0057
#trivy:ignore:AVD-AZU-0061
resource "azurerm_storage_account" "hcw" {
  #checkov:skip=CKV_AZURE_33:Queue read/write/delete resource logs go to Log Analytics via azurerm_monitor_diagnostic_setting.content_queue; checkov reads only classic queue_properties.logging. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_59:Public network access stays enabled because Disabled also refuses the subnet service-endpoint rule the app uses; network_rules default Deny. Owner 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_33:No private endpoints, owner decision 2026-09-14 (ADR 0031); service firewall with default Deny instead. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys, owner decision 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  name                     = var.storage_account_name
  resource_group_name      = azurerm_resource_group.app["stor"].name
  location                 = azurerm_resource_group.app["stor"].location
  account_tier             = "Standard"
  account_replication_type = "RAGRS"
  account_kind             = "StorageV2"
  access_tier              = "Hot"
  min_tls_version          = "TLS1_2"
  # Master override, not a default. With this false, a container declared
  # `container_access_type = "blob"` still answers 409 to an anonymous reader —
  # containers CANNOT opt in above it. Combined with the Deny network rule
  # below, nothing in this account is reachable from the internet, by design.
  # Public media is served through the Function App's identity at
  # `GET /api/public/media/{container}/{*path}` (functions/src/lib/public-media.js).
  allow_nested_items_to_be_public = false

  # Account keys off. Nothing here reads one: the Function App uses its managed
  # identity, and azurerm_storage_container below takes storage_account_id,
  # which is the Resource Manager API rather than the shared-key data plane.
  # Leaving it on kept two standing credentials alive that no code path used —
  # and a key that is never used is a key nobody notices leaking.
  # var.storage_shared_access_key_enabled is the one-edit rollback.
  shared_access_key_enabled = var.storage_shared_access_key_enabled

  blob_properties {
    # Versioning, because this account holds the ONLY copy of the site's media
    # and the CMS overwrites blobs in place. delete_retention_policy below
    # recovers a DELETED blob; it does nothing for an overwritten one, so
    # replacing a cover image with the wrong file was, until now, permanent and
    # silent. With versioning the previous content becomes a non-current
    # version and is recoverable for as long as the lifecycle rule keeps it.
    #
    # PITR (`restore_policy`) is deliberately NOT enabled with it. It requires
    # change_feed_enabled, which is a second continuous cost, and it buys
    # account-wide rollback to a point in time — a bigger tool than the failure
    # this account actually has, which is one blob overwritten by hand.
    # Versioning answers that one exactly.
    #
    # The cost of versioning is bounded by the expire-noncurrent-versions rule
    # in azurerm_storage_management_policy.cleanup below. Without that rule an
    # account whose write pattern is "overwrite in place" grows forever.
    versioning_enabled = true

    cors_rule {
      allowed_headers = ["*"]
      allowed_methods = ["GET", "HEAD", "OPTIONS"]
      # EXACT origins only. Azure Storage CORS accepts a literal "*" or fully
      # qualified origins — it does not accept partial wildcards, so the
      # previous `https://*.<domain>` and `http://localhost:*` were rejected
      # with "The value for one of the XML nodes is not in the correct
      # format", an error that names neither the field nor the value.
      #
      # No localhost origin (PLAT-10, #970). `http://localhost:5173` (Vite's
      # default port) sat here from the first apply and served nothing: CORS
      # governs what a browser script may read, not who may reach the
      # account, and the firewall below admits the Functions subnet and the
      # AzureServices bypass only, so no browser reaches this account at all;
      # public media is served through the app. The frontend also never
      # fetches from this account by script (read 2026-10-15: no fetch() to
      # the storage host anywhere under frontend/src). An unused entry is
      # removed; a local run sees the same content with or without it.
      allowed_origins = [
        "https://${var.domain}",
        "https://www.${var.domain}",
      ]
      exposed_headers    = ["Content-Length", "Content-Type"]
      max_age_in_seconds = 3600
    }

    delete_retention_policy {
      days = 7
    }

    # A deleted CONTAINER used to take its blobs with it irrecoverably, even
    # with blob soft delete on above — the two policies are separate and the
    # container is the bigger blast radius of the two. Seven days to match.
    container_delete_retention_policy {
      days = 7
    }
  }

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    virtual_network_subnet_ids = [azurerm_subnet.functions_integration.id]
  }

  # Holds production website media. Same guard rationale as the Cosmos
  # account: replacement must be an explicit, reviewed decision.
  #
  # Lifted for the centralus rebuild on 2026-08-19 and restored the same day.
  # The account was empty then; it will not be next time.
  lifecycle {
    prevent_destroy = true
  }

  tags = local.tags
}

# Blob containers — every one private, because the account override above means
# every one IS private regardless of what is written here. Declaring three of
# them "blob" described an access model that did not exist and could not be
# reached, and it is the kind of drift that gets read as an audit finding.
#
# The three media containers are served anonymously through the Function App at
# `GET /api/public/media/{container}/{*path}`; the allowlist that decides which
# ones lives in functions/src/lib/blob-paths.js (PUBLIC_MEDIA_CONTAINERS) and
# must be kept in step with the comments here.
resource "azurerm_storage_container" "blogs" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "blogs"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # blog cover images, served via the media route
}

resource "azurerm_storage_container" "covers" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "covers"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # content cover images, served via the media route
}

resource "azurerm_storage_container" "certifications" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "certifications"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # certification badges, served via the media route
}

resource "azurerm_storage_container" "speakerevents" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "speakerevents"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # private: event assets served via API
}

resource "azurerm_storage_container" "content" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "content"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # private: raw content assets, not public
}

# Listen & Learn episode audio, written by the generate-listen-and-learn job and
# streamed through the media route once an editor approves the episode. Private
# like every other container here: PUBLIC_MEDIA_CONTAINERS in blob-paths.js is
# what makes it reachable anonymously, and the account denies anonymous reads
# outright regardless.
resource "azurerm_storage_container" "listenandlearn" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "listenandlearn"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # episode MP3s, served via the media route
}

# Podcast transcript audio (#435), written by the generate-podcast-transcript
# job at article/{slug}.mp3 and streamed through the same media route. Its own
# container rather than a prefix in listenandlearn, because the Cosmos side is
# its own container too (podcast_transcripts, in cosmos-containers.json): Listen
# & Learn is the Learn section's product and the podcast is another. Same
# settings as listenandlearn; PUBLIC_MEDIA_CONTAINERS in blob-paths.js already
# names it, so it is reachable through the route the moment this applies.
resource "azurerm_storage_container" "podcast" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "podcast"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # transcript MP3s, served via the media route
}

# Cosmos out-of-account export (ADR 0028, #231). The Function App's exporter
# writes here: one prefix per run (`full/<date>/`, `delta/<date>/`) of
# gzip-compressed NDJSON block blobs at the Cool tier, plus `state/` for the
# change-feed continuation tokens. Private like every container above, and it
# must never join PUBLIC_MEDIA_CONTAINERS in blob-paths.js — it holds a copy
# of every authored and configuration document in the Cosmos account.
#
# On THIS account rather than a new one, on purpose. It is already RA-GRS
# with versioning and soft delete, already Deny by default at the network,
# and the Function App identity already holds Storage Blob Data Contributor
# on it (azurerm_role_assignment.func_blob below) — so the copy lands in a
# different resource, in a different resource group, replicated to the
# paired region, with no new identity and no new credential. That covers
# account loss and region loss of Cosmos, the two failures continuous backup
# does not survive. A separate subscription is the ADR's recorded revisit
# path, not this.
#
# Created disarmed: nothing writes here until cosmos_export_enabled is true
# (variables.tf). The apply that adds this adds an empty container and the
# expire-cosmos-export lifecycle rule below, and changes nothing that runs.
resource "azurerm_storage_container" "cosmos_export" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "cosmos-export"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # Cosmos export runs and change-feed state; never served
}

# Dedicated container for Cosmos export change-feed continuation tokens (PLAT-8, #968).
# Kept separate from cosmos-export so that azurerm_storage_container_immutability_policy
# on cosmos-export can enforce strict WORM retention on backup runs without blocking
# daily in-place continuation token overwrites.
resource "azurerm_storage_container" "cosmos_export_state" {
  #checkov:skip=CKV2_AZURE_21:Blob read logging is on for this account via azurerm_monitor_diagnostic_setting.content_blob (StorageRead). docs/security/scanner-triage.md#checkov
  name                  = "cosmos-export-state"
  storage_account_id    = azurerm_storage_account.hcw.id
  container_access_type = "private" # Cosmos export change-feed continuation tokens; mutable state, never served
}

# Time-based immutability policy for Cosmos DB out-of-account backup exports (PLAT-8, #968).
# Enforces WORM retention for 35 days matching the expire-cosmos-export lifecycle rule
# so that blobs under full/ and delta/ cannot be deleted or overwritten by the application
# managed identity or non-admin roles.
resource "azurerm_storage_container_immutability_policy" "cosmos_export" {
  storage_container_resource_manager_id = azurerm_storage_container.cosmos_export.id
  immutability_period_in_days           = 35
  locked                                = var.cosmos_export_immutability_locked
  protected_append_writes_all_enabled   = false
  protected_append_writes_enabled       = false

  lifecycle {
    prevent_destroy = true
  }
}

# Storage lifecycle management for generated and uploaded website media.
#
# KNOWN INERT as written. Azure matches `prefix_match` against
# `<container>/<blob>`, so "articles/" would match a container named
# `articles` — which does not exist, and is not created on purpose.
# `articles/` prefix is reserved for generated images on a 90-day lifecycle
# that RSS and blog-listing jobs may regenerate. When a scraper writes images
# here, this rule must name the real path (for example, "content/articles/")
# before it does anything. The decision stays next to the rule.
resource "azurerm_storage_management_policy" "cleanup" {
  storage_account_id = azurerm_storage_account.hcw.id

  rule {
    name    = "cleanup-old-scraped-images"
    enabled = true

    filters {
      prefix_match = ["articles/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 90
      }
    }
  }

  # The bound on versioning_enabled above, and it is not optional.
  #
  # This account's write pattern is overwrite-in-place from the CMS. Versioning
  # turns every one of those overwrites into a retained non-current version, so
  # without an expiry the account grows monotonically with editing activity and
  # never with content — a cost line that only ever goes up, on a platform with
  # a USD 150 ceiling.
  #
  # 30 days is chosen against the failure it exists for: someone replaces the
  # wrong image and finds out when they next look at the page. That is a
  # days-to-weeks discovery, not a months one. NO prefix_match, unlike the rule
  # above — this applies to every container, because the mistake can happen in
  # any of them.
  rule {
    name    = "expire-noncurrent-versions"
    enabled = true

    filters {
      blob_types = ["blockBlob"]
    }

    actions {
      version {
        delete_after_days_since_creation = 30
      }
    }
  }

  # Retention for the Cosmos export (ADR 0028 §4, #231): base blobs under
  # cosmos-export/ are deleted 35 days after creation. The exporter writes a
  # full every Sunday and a delta on the other six days, so 35 days holds
  # five weekly fulls and the deltas between them — about 12 GB at the
  # measured 2.39 GB account size, under fifty cents a month at the Cool
  # tier. Longer buys nothing a restore needs: a restore is the latest full
  # plus its deltas, and the account's own Continuous30Days backup already
  # covers the point-in-time case inside the account.
  #
  # days_since_creation, not days_since_modification as the articles/ rule
  # uses: an export blob is written once and never touched again, so its
  # creation is its run date and the retention counts from the run.
  #
  # Unlike the articles/ rule, these prefixes name a container that exists.
  # Azure matches prefix_match against `<container>/<blob>`, so both resolve
  # inside azurerm_storage_container.cosmos_export and nowhere else on the
  # account. The two run prefixes, NOT the whole container the ADR names:
  # `state/` holds the change-feed continuation tokens, which the exporter
  # overwrites in place every delta, and whether an in-place overwrite resets
  # the creation time this condition reads is not documented — a token
  # expired after 35 idle days would turn the next delta into a silent full
  # or a failure, so `state/` is simply never under this rule.
  #
  # The expire-noncurrent-versions rule above applies here as well — an
  # overwritten marker or token keeps its previous version 30 days, bounded
  # like every other container.
  rule {
    name    = "expire-cosmos-export"
    enabled = true

    filters {
      prefix_match = ["cosmos-export/full/", "cosmos-export/delta/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 35
      }
    }
  }

  # Backstop for recording uploads (#442). The Recording Hub's upload flow
  # writes audio to podcast/uploads/<uuid>.<ext> so the Plaud Embedded
  # Transcription API can fetch it through the public media route — an
  # unguessable but UNAUTHENTICATED URL. The transcribe-recording-upload job
  # deletes the blob itself as soon as the transcription reaches a terminal
  # state (functions/src/lib/podcast/recording-upload.js); this rule is for
  # the blob that outlives the job — a timed-out poll, a worker that died
  # mid-run, a queue message that was never delivered — so no upload stays
  # reachable indefinitely. Seven days: Plaud retains the transcription for
  # seven days by default, so after that there is nothing the audio could
  # still be re-read for. days_since_creation, like the export rule above:
  # an upload is written once with overwrite:false and never touched again.
  #
  # Only `uploads/` inside the podcast container. The generated episode audio
  # beside it (article/, plaud/, recording/) is the product and is not
  # expired here.
  rule {
    name    = "expire-recording-uploads"
    enabled = true

    filters {
      prefix_match = ["podcast/uploads/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 7
      }
    }
  }
}


# Queue logs and blob write/delete logs go to Log Analytics through the
# functions_queue and functions_blob diagnostic settings; trivy reads only
# classic queue_properties logging. Infrastructure encryption is creation-only;
# the owner kept this account 2026-09-14 (ADR 0031). docs/security/scanner-triage.md#trivy
#trivy:ignore:AVD-AZU-0057
#trivy:ignore:AVD-AZU-0061
resource "azurerm_storage_account" "functions" {
  #checkov:skip=CKV_AZURE_33:Queue read/write/delete resource logs go to Log Analytics via azurerm_monitor_diagnostic_setting.functions_queue; checkov reads only classic queue_properties.logging. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys, owner decision 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV2_AZURE_33:ADR 0008 keeps Function host storage public-endpoint by accepted decision (default Deny network rules). docs/security/scanner-triage.md#checkov
  #checkov:skip=CKV_AZURE_59:ADR 0008, as above; the deploy firewall window needs the public endpoint with default Deny. docs/security/scanner-triage.md#checkov
  name                = var.functions_storage_account_name
  resource_group_name = azurerm_resource_group.app["web"].name
  location            = azurerm_resource_group.app["web"].location
  account_tier        = "Standard"
  # GRS since 2026-09-14, owner decision. It was LRS on the reasoning that a
  # redeploy rebuilds host state — true of the release package, not of what
  # the host keeps here between deploys: timer schedule status, singleton and
  # listener leases, and the durable queue messages of jobs in flight. LRS
  # loses those with the region; GRS keeps a copy in the paired region.
  # LRS->GRS is an in-place settings update (no replacement, so
  # prevent_destroy below is not in play). Plain GRS, not RA-GRS: nothing reads
  # host state from the secondary. The account holds a few MB, so roughly
  # doubling the per-GB rate is cents a month.
  account_replication_type = "GRS"
  min_tls_version          = "TLS1_2"
  tags                     = local.tags

  # No container here is anonymous (function-releases is private), so the
  # account-level override costs nothing and matches the content account
  # above. The provider default is true. In-place and reversible.
  # docs/security/scanner-triage.md (checkov CKV2_AZURE_47 / CKV_AZURE_190).
  allow_nested_items_to_be_public = false

  # Account keys off — the credential half of the same posture the network
  # rules below take. All three access paths listed there are Entra-based
  # already: the host authenticates with its managed identity
  # (storage_authentication_type = "SystemAssignedIdentity" on the function
  # app), and the workflow uploads with the deploy identity's token inside its
  # firewall window. Nothing presents a key, so nothing breaks by removing the
  # ability to. var.storage_shared_access_key_enabled is the one-edit rollback,
  # and its description says what a key-auth failure looks like — which is not
  # like a storage failure.
  shared_access_key_enabled = var.storage_shared_access_key_enabled

  # Soft delete on the deployment packages and the host's own state. The
  # content account has had this since it was created; this one did not, so a
  # mistaken delete here — the release container, or a host-state blob — was
  # unrecoverable and takes the API down until a redeploy. Same 7 days, because
  # there is no reason for the two accounts to differ and every reason for an
  # operator not to have to remember which is which.
  blob_properties {
    delete_retention_policy {
      days = 7
    }

    container_delete_retention_policy {
      days = 7
    }
  }

  # T-503: the last publicly-open storage surface, closed. Three access paths
  # survive default Deny, each deliberate:
  #   1. Runtime and platform package-pull — the Flex app is VNet-integrated
  #      (virtual_network_subnet_id) with identity-based storage auth, so
  #      host-state and deployment reads arrive from the integration subnet;
  #      the subnet rule + Microsoft.Storage service endpoint admit them.
  #      This is the documented supported shape for network-restricted
  #      deployment storage on Flex Consumption.
  #   2. Workflow package upload — GitHub-hosted runners have public dynamic
  #      IPs, so deploy-functions.yml opens a per-run firewall window (adds
  #      the runner IP, uploads, removes it; see that workflow), authorized
  #      by the deploy identity's Storage Account Contributor grant scoped to
  #      exactly this account (oidc.tf).
  #   3. Operator windows — functions_storage_admin_ip_rules, same
  #      populate/apply/work/empty pattern as the Key Vault and Cosmos vars.
  #
  # Rollback: if the app stops cold-starting after apply (the failure mode is
  # a deploy that "succeeds" against stale state — verify with a deploy AND a
  # cold-start invocation), set functions_storage_network_default_action =
  # "Allow" and re-apply; that restores the pre-T-503 posture in one step.
  network_rules {
    default_action             = var.functions_storage_network_default_action
    bypass                     = ["AzureServices"]
    virtual_network_subnet_ids = [azurerm_subnet.functions_integration.id]
    ip_rules                   = var.functions_storage_admin_ip_rules
  }

  # Function host state and release packages live here; replacing it takes the
  # API down until a redeploy. Guarded like the other stateful accounts.
  #
  # Lifted for the centralus rebuild on 2026-08-19 and restored the same day.
  # The cost of replacement was a redeploy rather than an outage only because
  # Migration-Plan §6 cutover had not run.
  lifecycle {
    prevent_destroy = true
  }
}

# Deployment container for Flex Consumption.
#
# Flex does not use WEBSITE_RUN_FROM_PACKAGE; the platform pulls the deployment
# package from a blob container named in functionAppConfig.deployment. Nothing
# else in this file provided one — the containers above are CONTENT containers
# on the other storage account.
resource "azurerm_storage_container" "function_releases" {
  #checkov:skip=CKV2_AZURE_21:Host blob writes and deletes are logged (functions_blob); reads are excluded because the host makes ~550k a day, ~0.6 GB of logs against a 0.25 GB/day cap. Measured 2026-09-14, ADR 0031. docs/security/scanner-triage.md#checkov
  name                  = "function-releases"
  storage_account_id    = azurerm_storage_account.functions.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "func_blob" {
  scope                = azurerm_storage_account.hcw.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

resource "azurerm_role_assignment" "func_queue" {
  scope                = azurerm_storage_account.hcw.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

# Required to mint user-delegation SAS tokens (blob-storage.js generateSasUrl).
# Storage Blob Data Contributor cannot call getUserDelegationKey; without this
# the failure is a 403 at signing time, which reads as a bug rather than as a
# missing role. Narrower than it looks: it grants only the delegation key, and
# the resulting SAS can never exceed the identity's own data-plane permissions.
resource "azurerm_role_assignment" "func_blob_delegator" {
  scope                = azurerm_storage_account.hcw.id
  role_definition_name = "Storage Blob Delegator"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

# Host storage access for Flex Consumption managed-identity mode
resource "azurerm_role_assignment" "func_host_storage" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

# Queue and Table on the same account, because identity-based
# AzureWebJobsStorage is not a blob-only contract.
#
# Blob alone is the intuitive grant and it is not enough. The host's own health
# probe reports:
#
#   "azure.functions.webjobs.storage": { "status": "Unhealthy",
#     "description": "Unable to access AzureWebJobsStorage",
#     "errorCode": "AuthenticationFailed" }
#
# while web_host.lifecycle and script_host.lifecycle both report Healthy — so
# the app serves HTTP perfectly and only the storage-backed machinery is down.
# That is the trap: HTTP routes answer 200, every smoke test passes, and timer
# triggers, singleton locks and SyncTriggers silently do not run. A scheduled
# function that never fires produces no error anywhere.
#
# Found 2026-08-20, after removing a keyless AzureWebJobsStorage connection
# string in favour of AzureWebJobsStorage__accountName. The connection string
# had been failing first, which masked the missing roles behind a different
# error with the same symptom.
resource "azurerm_role_assignment" "func_host_storage_queue" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

resource "azurerm_role_assignment" "func_host_storage_table" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_function_app_flex_consumption.hcw.identity[0].principal_id
}

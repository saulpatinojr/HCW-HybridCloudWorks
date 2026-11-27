# =============================================================================
# providers.tf — Azure provider requirements
# Backend (HCP Terraform Cloud) is declared in backend.tf
# =============================================================================
terraform {
  # Upper-bounded (T-725). ">= 1.5" silently admits a future Terraform 2.x,
  # whose breaking changes would arrive as a surprise on whichever runner
  # upgraded first. The standard asks for pinned versions; this pins the major.
  # The floor is 1.7 since #1923: the Web Analytics import block in
  # frontend.tf takes `for_each` (1.7) and an expression for its id (1.6).
  # HCP Terraform and CI already run later 1.x releases.
  required_version = "~> 1.7"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.0"
    }
    # azapi does two things azurerm cannot. The first is stripping the
    # `AzureWebJobsStorage` connection string that azurerm re-injects on every
    # apply (T-511, hashicorp/terraform-provider-azurerm#29149): the
    # read-then-strip pair at the end of functionapp.tf. It is a thin ARM
    # passthrough — it writes the body it is given and nothing else, which is
    # the property azurerm lacks there. The second is the lab host's Vault
    # seal key and the read of the Arc machine it is granted to (#726,
    # lab-hybrid.tf): azurerm creates keys only through the Key Vault data
    # plane, which would need the run identity to hold a data-plane role, and
    # has no way to read a resource that may not exist without failing the
    # plan.
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
    # Cloudflare remains for DNS management.
    #
    # v5 since 2026-08-29. The v4 note this replaces said the rename of
    # cloudflare_record to cloudflare_dns_record was "an upgrade ADR, tracked
    # separately"; the upgrade is done and the moved blocks in frontend.tf are
    # what carry state across it.
    #
    # Provider v5 is generated from the Cloudflare API schema rather than
    # hand-written, which is why the change is not a rename alone — see the
    # three v4/v5 differences recorded above each resource in frontend.tf and
    # the api_base_url note in outputs.tf.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
    # azuread and time arrived with Muse's read-only app registration
    # (muse-reader.tf, #1763): the first Entra object infra/ creates. Both
    # are HashiCorp's own providers. Nothing uses them until
    # var.muse_reader_enabled is true.
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }
}

# There is no credential in this block on purpose, and its absence is the
# configuration — not an omission to be "fixed" by adding client_id/secret.
#
# Runs execute in HCP Terraform with dynamic provider credentials. When the
# workspace has TFC_AZURE_PROVIDER_AUTH=true and TFC_AZURE_RUN_CLIENT_ID set,
# HCP Terraform mints a short-lived OIDC token per run phase and exports
# ARM_CLIENT_ID, ARM_OIDC_TOKEN and ARM_USE_OIDC into the run environment; the
# azurerm provider picks those up with no HCL. ARM_TENANT_ID is a plain
# workspace environment variable alongside them.
#
# The identity behind TFC_AZURE_RUN_CLIENT_ID is created ONCE, outside this
# configuration, by scripts/bootstrap-terraform-oidc.ps1 — Terraform cannot
# create the credential Terraform authenticates with. See the Bootstrap section
# of the Deployment Runbook. The GitHub Actions identity in oidc.tf is a
# different handshake and is managed here.
# One provider per subscription. The default (unaliased) provider is the
# APPLICATION subscription because the overwhelming majority of resources are
# the workload; only the handful that belong to a platform landing zone carry
# an explicit `provider = azurerm.<alias>`. That way the common case cannot be
# got wrong by forgetting an argument.
#
# subscription_id is set in HCL on every provider, so it does not depend on
# ARM_SUBSCRIPTION_ID. That variable remains the provider's fallback and is
# what HCP Terraform's dynamic credentials export, but it no longer decides
# where anything lands — an explicit value here always wins.
#
# azurerm 5.0 changed resource-provider registration from `legacy` (roughly 60
# providers registered at startup) to `none`. On a subscription nobody has
# deployed to, that surfaces at apply time as MissingSubscriptionRegistration,
# which does not say what to do about it. The registration list is therefore
# explicit — and a variable, so it can be emptied in one place when ALZ
# absorption moves registration to central governance.
provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id                 = var.subscription_app
  resource_provider_registrations = "none"
  resource_providers_to_register  = var.azure_resource_providers
}

provider "azurerm" {
  alias = "mgmt"
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id                 = var.subscription_mgmt
  resource_provider_registrations = "none"
  resource_providers_to_register  = var.azure_resource_providers
}

provider "azurerm" {
  alias = "conn"
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id                 = var.subscription_conn
  resource_provider_registrations = "none"
  resource_providers_to_register  = var.azure_resource_providers
}

# There is deliberately no `ident` alias. The Identity landing zone is empty —
# HCWSite authenticates against Entra ID, and app registrations are tenant
# objects rather than subscription resources — so an alias for it would be a
# declaration with nothing to declare. tflint flags exactly that
# (terraform_unused_declarations), and it is right to: an unused alias also
# forces subscription_ident to be supplied for no benefit, which is one more
# value that must be correct before a plan can run and one more chance to get
# it wrong.
#
# Add it, and its variable, in the same change that adds the first Identity
# resource. That is a five-line addition, not a refactor.

# Same dynamic credentials as azurerm above — azapi reads ARM_CLIENT_ID,
# ARM_OIDC_TOKEN and ARM_USE_OIDC from the run environment with no HCL. The
# subscription is pinned in HCL for the same reason it is on every azurerm
# block: an explicit value cannot be got wrong by a missing environment
# variable, and everything this provider touches, the function app and the
# lab's seal key and Arc machine, is in the application subscription.
provider "azapi" {
  subscription_id = var.subscription_app
}

# Same dynamic credentials as azurerm: HCP Terraform's Azure dynamic
# provider credentials cover the Entra ID provider too, from the same
# workspace variables and the same ARM_* environment, with no HCL
# (https://developer.hashicorp.com/terraform/cloud-docs/workspaces/dynamic-provider-credentials/azure-configuration).
# The tenant comes from ARM_TENANT_ID. What the run identity may DO in Entra
# is decided by its directory role, not here: see muse-reader.tf.
provider "azuread" {}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

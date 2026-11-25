# A payload shaped like the Landing Zone Builder's output: registry sources
# with version constraints, exactly as a learner would download and as the
# `terraform-validate` job receives it. smoke.sh hands this directory to
# hcw-terraform-validate with no network; the script rewrites each module
# below to its vendored copy under /opt/avm and the init must then succeed.
# Nothing here is changed by that: the rewrite happens on the tmpfs copy.
#
# One block per module the builder emits, each called once, and each
# constraint satisfied by the version the builder pins:
# scripts/lab-image-avm-vendoring.test.mjs holds this file to that, because
# smoke.sh expects exactly one rewrite per builder module. The constraints
# differ on purpose, to exercise the operators hcw-terraform-validate
# evaluates; the spoke's is `>= 0.15.0` so that both vendored versions of
# avm-res-network-virtualnetwork (the one the connectivity module calls,
# AVM_CHILD_MODULES in lab-image/versions.env, and the builder's pin) satisfy
# it and the highest must be chosen.
# The connectivity block is pinned exactly, to the version the image vendors
# (#1868). It was a window, `>= 0.18.0, < 0.19.0`: offline that meant the
# vendored 0.18.1, online the newest 0.18.x, and 0.18.2 made `location` a
# required input that 0.18.1 does not accept. So no single block validates
# on both, and online and offline must resolve the same release.
# scripts/lab-smoke-payload-pins.test.mjs holds it to that.
# update-avm-versions.yml moves each block with its module's pin, keeping
# its operator: the alz and connectivity blocks' exact pins (the builder's
# own) always, and the management block's `~>` once a release has left it
# (#1658; `nextSmokeConstraint` in frontend/scripts/avm-versions-edits.mjs).
# When it moves a pin past a release that made an input required, it adds
# that input here too (AVM_REQUIRED_INPUTS in
# frontend/src/lib/landingZone/avmVersions.js, which the builder reads as
# well). The spoke's `>= 0.15.0` cannot be outgrown. sandbox-check.mjs
# validates the builder's real default build as well.
terraform {
  # Same rule as the Landing Zone packs (frontend/src/lib/landingZone/terraformVersion.js).
  required_version = ">= 1.12, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.4"
    }
    alz = {
      source  = "azure/alz"
      version = "~> 0.21"
    }
  }
}

provider "azurerm" {
  features {}
}

module "management" {
  source  = "Azure/avm-ptn-alz-management/azurerm"
  version = "~> 0.9"

  location                = "centralus"
  resource_group_name     = "rg-alz-management"
  automation_account_name = "aa-alz-management"
}

module "alz" {
  source  = "Azure/avm-ptn-alz/azurerm"
  version = "0.22.0"

  architecture_name  = "alz"
  location           = "centralus"
  parent_resource_id = "root"
}

module "connectivity" {
  source  = "Azure/avm-ptn-alz-connectivity-hub-and-spoke-vnet/azurerm"
  version = "0.18.1"
}

module "spoke" {
  source  = "Azure/avm-res-network-virtualnetwork/azurerm"
  version = ">= 0.15.0"

  location  = "centralus"
  parent_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-alz-spoke"
}

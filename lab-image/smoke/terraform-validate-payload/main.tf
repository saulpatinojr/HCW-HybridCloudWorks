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
# avm-res-network-virtualnetwork (0.15.0, a child of the connectivity
# module, and the builder's pin) satisfy it and the highest must be chosen.
# The alz block's exact pin is the builder's own, and update-avm-versions.yml
# moves it with the pin (the other three are constraints a bump may outgrow,
# which the static test says). sandbox-check.mjs validates the builder's
# real default build as well.
terraform {
  required_version = ">= 1.12"

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
  version = ">= 0.17.0, < 0.18.0"
}

module "spoke" {
  source  = "Azure/avm-res-network-virtualnetwork/azurerm"
  version = ">= 0.15.0"

  location  = "centralus"
  parent_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-alz-spoke"
}

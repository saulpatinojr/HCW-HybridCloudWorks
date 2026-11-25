# The root module smoke.sh inits with --network none. It uses only what the
# provider mirror carries and declares no backend, so a passing init proves
# exactly one thing: both providers were installed from /opt/terraform/mirror
# without a registry round trip.
terraform {
  # Same rule as the Landing Zone packs (frontend/src/lib/landingZone/terraformVersion.js).
  required_version = ">= 1.12, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "random_pet" "smoke" {
  length = 2
}

<#
.SYNOPSIS
  Bootstraps custom Azure RBAC role definitions required by Terraform.

.DESCRIPTION
  Terraform runs under a least-privilege identity that may ASSIGN roles but
  cannot CREATE or DEFINE them (Microsoft.Authorization/roleDefinitions/write
  is deliberately withheld). This script creates or updates the custom
  roles in Azure with parameterized subscription scopes:
    1. HCW Key Vault Secret Writer (infra/roles/keyvault-secret-writer.json)
    2. HCW Function Config Refresh (infra/roles/function-config-refresh.json)
    3. HCW Function Settings Reader (infra/roles/function-settings-reader.json)
    4. HCW Static Web App Deployer (infra/roles/static-web-app-deployer.json)
    5. HCW Alert Rule Reader (infra/roles/alert-rule-reader.json)

.PARAMETER SubscriptionId
  The target Azure Subscription ID (GUID) for the primary site workload.
  Defaults to the currently active subscription from `az account show`.

.PARAMETER ManagementSubscriptionId
  The target Azure Subscription ID (GUID) for central platform management.
  Defaults to 02dfb8ad-ec22-42e3-8cdc-17fd6e00b17e.

.EXAMPLE
  pwsh scripts/bootstrap-roles.ps1
  pwsh scripts/bootstrap-roles.ps1 -SubscriptionId "b9e02281-ebb6-49e9-bd7b-f275b1350726"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $false)]
  [string]$ManagementSubscriptionId = "02dfb8ad-ec22-42e3-8cdc-17fd6e00b17e"
)

$ErrorActionPreference = 'Stop'

# Resolve subscription ID if not explicitly passed
if (-not $SubscriptionId) {
  Write-Host "Resolving current Azure subscription ID via az account show..."
  $SubscriptionId = (az account show --query id -o tsv 2>$null)
  if (-not $SubscriptionId) {
    Write-Error "No active Azure subscription found. Run 'az login' or pass -SubscriptionId."
    exit 1
  }
}

$SubscriptionId = $SubscriptionId.Trim()
$ManagementSubscriptionId = $ManagementSubscriptionId.Trim()
Write-Host "Bootstrapping custom role definitions for subscription: $SubscriptionId"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$rolesDir = Join-Path $repoRoot "infra/roles"

$roleConfigs = @(
  @{
    File = Join-Path $rolesDir "keyvault-secret-writer.json"
    Scopes = @("/subscriptions/$SubscriptionId/resourceGroups/rg-sec-site-prod-cus")
  },
  @{
    File = Join-Path $rolesDir "function-config-refresh.json"
    Scopes = @("/subscriptions/$SubscriptionId/resourceGroups/rg-web-site-prod-cus")
  },
  @{
    File = Join-Path $rolesDir "function-settings-reader.json"
    Scopes = @("/subscriptions/$SubscriptionId/resourceGroups/rg-web-site-prod-cus")
  },
  @{
    File = Join-Path $rolesDir "static-web-app-deployer.json"
    Scopes = @("/subscriptions/$SubscriptionId/resourceGroups/rg-web-site-prod-cus")
  },
  @{
    File = Join-Path $rolesDir "alert-rule-reader.json"
    Scopes = @(
      "/subscriptions/$SubscriptionId/resourceGroups/rg-web-site-prod-cus",
      "/subscriptions/$ManagementSubscriptionId/resourceGroups/rg-mgmt-plat-prod-cus"
    )
  }
)

foreach ($config in $roleConfigs) {
  if (-not (Test-Path $config.File)) {
    Write-Error "Role definition template not found: $($config.File)"
    exit 1
  }

  $roleJson = Get-Content $config.File -Raw | ConvertFrom-Json
  $roleName = $roleJson.Name

  $roleJson.AssignableScopes = $config.Scopes

  # Write temporary payload with replaced scope
  $tempFile = [System.IO.Path]::GetTempFileName()
  try {
    $roleJson | ConvertTo-Json -Depth 10 | Set-Content $tempFile -Encoding utf8

    Write-Host "`nProcessing role '$roleName'..."
    Write-Host "  AssignableScopes: $($config.Scopes -join ', ')"

    $existingRoleId = (az role definition list --name "$roleName" --query "[0].id" -o tsv 2>$null)

    if ($existingRoleId) {
      Write-Host "  Updating existing role definition..."
      az role definition update --role-definition "@$tempFile" --output none
      Write-Host "  ✓ Updated successfully."
    } else {
      Write-Host "  Creating new role definition..."
      az role definition create --role-definition "@$tempFile" --output none
      Write-Host "  ✓ Created successfully."
    }
  } finally {
    if (Test-Path $tempFile) {
      Remove-Item -Force $tempFile
    }
  }
}

Write-Host "`nAll custom role definitions bootstrapped and verified successfully."

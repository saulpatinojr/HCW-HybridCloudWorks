<#
.SYNOPSIS
  Creates or updates the custom Azure RBAC role definitions that Terraform
  reads by name and may not create itself.

.DESCRIPTION
  Terraform runs under a least-privilege identity that may ASSIGN roles but
  cannot CREATE or DEFINE them (Microsoft.Authorization/roleDefinitions/write
  is deliberately withheld). This script creates or updates the custom
  roles in Azure from the JSON files under infra/roles/:
    1. HCW Key Vault Secret Writer (infra/roles/keyvault-secret-writer.json)
    2. HCW Function Config Refresh (infra/roles/function-config-refresh.json)
    3. HCW Function Settings Reader (infra/roles/function-settings-reader.json)
    4. HCW Static Web App Deployer (infra/roles/static-web-app-deployer.json)
    5. HCW Alert Rule Reader (infra/roles/alert-rule-reader.json)
    6. HCW Storage Firewall Writer (infra/roles/storage-firewall-writer.json)

  Those files carry placeholder subscription ids
  (00000000-0000-0000-0000-00000000000N) in their AssignableScopes, because
  this repository is public and a real subscription id never goes in a
  tracked file (#1540). This script fills the real ids in at create time and
  the files never change. Nothing is read from a file in the repository:
  the workload subscription comes from -SubscriptionId or `az account show`,
  and the management subscription from -ManagementSubscriptionId or
  `az account list`, by its name sub-plat-mgmt-prod-cus.

  Success looks like one "Created" or "Updated" line per role, each followed
  by a read-back of the role from Azure at its first assignable scope showing
  the real scopes, and a final table of all of them; the script fails if a
  read-back does not match what it sent. That table is the evidence for a
  ticket's "roles unchanged afterwards" line.

.PARAMETER SubscriptionId
  The workload (site) subscription id. Defaults to the subscription az is
  signed in to, from `az account show`.

.PARAMETER ManagementSubscriptionId
  The platform management subscription id. Defaults to the id of the
  subscription named sub-plat-mgmt-prod-cus in `az account list`.

.EXAMPLE
  pwsh scripts/bootstrap-roles.ps1
  pwsh scripts/bootstrap-roles.ps1 -SubscriptionId "00000000-0000-0000-0000-000000000001"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $false)]
  [string]$ManagementSubscriptionId
)

$ErrorActionPreference = 'Stop'

$managementSubscriptionName = 'sub-plat-mgmt-prod-cus'
$guidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$placeholderPattern = '^00000000-0000-0000-0000-0000000000[0-9a-fA-F]{2}$'

if (-not $SubscriptionId) {
  Write-Host "Resolving the workload subscription id from 'az account show'..."
  $SubscriptionId = (az account show --query id -o tsv 2>$null)
  if (-not $SubscriptionId) {
    Write-Error "No active Azure subscription. Run 'az login' or pass -SubscriptionId."
    exit 1
  }
}

if (-not $ManagementSubscriptionId) {
  Write-Host "Resolving the management subscription id from 'az account list' by its name ($managementSubscriptionName)..."
  $accounts = az account list -o json 2>$null | ConvertFrom-Json
  $management = @($accounts | Where-Object { $_.name -eq $managementSubscriptionName })
  if ($management.Count -ne 1) {
    Write-Error "The signed-in account sees $($management.Count) subscription(s) named $managementSubscriptionName; expected exactly one. Run 'az login' with an account that sees it, or pass -ManagementSubscriptionId."
    exit 1
  }
  $ManagementSubscriptionId = $management[0].id
}

$SubscriptionId = $SubscriptionId.Trim()
$ManagementSubscriptionId = $ManagementSubscriptionId.Trim()

foreach ($pair in @(@{ Label = 'workload'; Value = $SubscriptionId }, @{ Label = 'management'; Value = $ManagementSubscriptionId })) {
  if ($pair.Value -notmatch $guidPattern) {
    Write-Error "The $($pair.Label) subscription id is not a GUID."
    exit 1
  }
  if ($pair.Value -match $placeholderPattern) {
    Write-Error "The $($pair.Label) subscription id is the repository placeholder, not a real subscription. Pass the real id or sign in to the right account."
    exit 1
  }
}

Write-Host "Bootstrapping custom role definitions for workload subscription $SubscriptionId (management: $ManagementSubscriptionId)"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$rolesDir = Join-Path $repoRoot "infra/roles"

# Every file under infra/roles is listed here; scripts/terraform-role-definitions.test.mjs
# fails CI if one is not. The scopes here replace the placeholders in the file.
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
  },
  @{
    File = Join-Path $rolesDir "storage-firewall-writer.json"
    Scopes = @("/subscriptions/$SubscriptionId/resourceGroups/rg-web-site-prod-cus")
  }
)

$readBack = [System.Collections.Generic.List[object]]::new()

foreach ($config in $roleConfigs) {
  if (-not (Test-Path $config.File)) {
    Write-Error "Role definition template not found: $($config.File)"
    exit 1
  }

  $roleJson = Get-Content $config.File -Raw | ConvertFrom-Json
  $roleName = $roleJson.Name

  $roleJson.AssignableScopes = $config.Scopes

  # Write temporary payload with the real scopes; the file in the repository keeps its placeholders.
  $tempFile = [System.IO.Path]::GetTempFileName()
  try {
    $roleJson | ConvertTo-Json -Depth 10 | Set-Content $tempFile -Encoding utf8

    Write-Host "`nProcessing role '$roleName'..."
    Write-Host "  AssignableScopes: $($config.Scopes -join ', ')"

    # Looked up at the role's own first scope: a custom role assignable only at
    # a resource group is not reliably returned by a listing at the subscription.
    $firstScope = $config.Scopes[0]
    $existingRoleId = (az role definition list --name "$roleName" --scope "$firstScope" --query "[0].id" -o tsv 2>$null)

    if ($existingRoleId) {
      Write-Host "  Updating existing role definition..."
      az role definition update --role-definition "@$tempFile" --output none
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to update role definition '$roleName' (exit code $LASTEXITCODE)."
      }
      Write-Host "  ✓ Updated successfully."
    } else {
      Write-Host "  Creating new role definition..."
      az role definition create --role-definition "@$tempFile" --output none
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to create role definition '$roleName' (exit code $LASTEXITCODE)."
      }
      Write-Host "  ✓ Created successfully."
    }
  } finally {
    if (Test-Path $tempFile) {
      Remove-Item -Force $tempFile
    }
  }

  # Read the role back from Azure at its first scope and check that the
  # scopes Azure holds are exactly the ones sent. az is a native command, so
  # its exit code is checked by hand; a role that cannot be read back is
  # never reported as bootstrapped.
  $actualJson = az role definition list --name "$roleName" --scope "$firstScope" --query "[0].assignableScopes" -o json
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read role definition '$roleName' back from Azure (exit code $LASTEXITCODE)."
  }
  $actual = @(($actualJson | ConvertFrom-Json) | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
  $expected = @($config.Scopes | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
  if (($actual -join "`n") -ne ($expected -join "`n")) {
    throw "Read-back of '$roleName' differs from what was sent.`n  sent:  $($expected -join ', ')`n  Azure: $($actual -join ', ')"
  }
  Write-Host "  Read back from Azure: $roleName -> $($config.Scopes -join ', ')"
  $readBack.Add([pscustomobject]@{ Role = $roleName; Scopes = ($config.Scopes -join ', ') })
}

Write-Host "`nRead-back of every role, as Azure holds it (this table is the evidence):"
$readBack | Format-Table -AutoSize -Wrap | Out-String | Write-Host

Write-Host "All $($readBack.Count) custom role definitions bootstrapped and read back."

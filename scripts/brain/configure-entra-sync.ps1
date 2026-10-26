<#
.SYNOPSIS
Review or apply the dedicated, delegated-only Obsidian sync registration.
.DESCRIPTION
Read-only by default. -Apply adds brain_sync to the existing API and creates
or verifies a separate public desktop client. Existing admin scopes, roles,
clients and permission assignments are preserved. Run only after local checks.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$ApiAppId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$OwnerOid,
    [string]$DisplayName = 'HCW Second Brain Obsidian',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Graph {
    param([string]$Method, [string]$Url, $Body)
    # An explicit scope uses the token just refreshed by device-code login.
    # Send REST through PowerShell: az.cmd can misparse alternate-key URLs
    # containing parentheses on Windows. Tokens stay in this process, never
    # shell arguments, files, or output.
    $tokenResponse = & az account get-access-token --tenant $TenantId.ToString() --scope 'https://graph.microsoft.com/.default' -o json
    if ($LASTEXITCODE -ne 0) { throw 'Refresh the Microsoft Graph sign-in before continuing.' }
    $token = $tokenResponse | ConvertFrom-Json
    $request = @{
        Method = $Method
        Uri = "https://graph.microsoft.com/v1.0/$Url"
        Headers = @{ Authorization = "Bearer $($token.accessToken)" }
    }
    if ($null -ne $Body) {
        $request.ContentType = 'application/json'
        $request.Body = $Body | ConvertTo-Json -Depth 30
    }
    Invoke-RestMethod @request
}

$account = & az account show -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $account.tenantId -ne $TenantId.ToString()) { throw 'Sign in to the API tenant before running this script.' }
$api = Invoke-Graph GET "applications(appId='$ApiAppId')" $null
$resourceSp = Invoke-Graph GET "servicePrincipals(appId='$ApiAppId')" $null
$assignments = Invoke-Graph GET "users/$OwnerOid/appRoleAssignments" $null
$adminRole = @($api.appRoles | Where-Object { $_.value -eq 'Admin' -and $_.isEnabled })
if ($adminRole.Count -ne 1 -or -not @($assignments.value | Where-Object { $_.resourceId -eq $resourceSp.id -and $_.appRoleId -eq $adminRole[0].id })) { throw 'The owner must already hold the API Admin role. This script does not promote users.' }
$scopes = @($api.api.oauth2PermissionScopes)
$scope = @($scopes | Where-Object value -eq 'brain_sync')
if ($scope.Count -gt 1) { throw 'Duplicate brain_sync scopes require investigation.' }
if ($scope.Count -eq 0) {
    $scope = @([pscustomobject]@{ id = [guid]::NewGuid().ToString(); value = 'brain_sync'; type = 'Admin'; isEnabled = $true; adminConsentDisplayName = 'Synchronize the owner Second Brain'; adminConsentDescription = 'Read creator references and synchronize private notes for the configured HCW owner only.' })
    $scopes += $scope
}
if (-not $scope[0].isEnabled) { throw 'brain_sync exists but is disabled. Resolve its status explicitly.' }
$escapedName = $DisplayName.Replace("'", "''")
$encodedFilter = [uri]::EscapeDataString("displayName eq '$escapedName'")
$clients = Invoke-Graph GET "applications?`$filter=$encodedFilter" $null
if (@($clients.value).Count -gt 1) { throw 'Multiple desktop registrations match; do not guess which one to alter.' }
$client = @($clients.value) | Select-Object -First 1
$manifest = @{
    displayName = $DisplayName; signInAudience = 'AzureADMyOrg'; isFallbackPublicClient = $true
    requiredResourceAccess = @(@{ resourceAppId = $ApiAppId.ToString(); resourceAccess = @(@{ id = $scope[0].id; type = 'Scope' }) })
}
if ($client) {
    $permissions = @($client.requiredResourceAccess)
    if (@($client.passwordCredentials).Count -or @($client.keyCredentials).Count -or -not $client.isFallbackPublicClient -or $permissions.Count -ne 1 -or $permissions[0].resourceAppId -ne $ApiAppId.ToString() -or @($permissions[0].resourceAccess).Count -ne 1 -or $permissions[0].resourceAccess[0].id -ne $scope[0].id) { throw 'Existing client is not dedicated to brain_sync. Refusing to broaden or repurpose it.' }
}
Write-Host 'Review: preserve the API; expose brain_sync; authorize a separate public desktop client for that scope only.'
if (-not $Apply) {
    $manifest | ConvertTo-Json -Depth 12
    Write-Host 'No changes made. Re-run with -Apply after reviewing this plan.'
    return
}
$scopeSettings = @{}
$api.api.psobject.Properties | ForEach-Object { $scopeSettings[$_.Name] = $_.Value }
$scopeSettings.oauth2PermissionScopes = $scopes
Invoke-Graph PATCH "applications/$($api.id)" @{ api = $scopeSettings } | Out-Null
if (-not $client) { $client = Invoke-Graph POST 'applications' $manifest }
$principalFilter = [uri]::EscapeDataString("appId eq '$($client.appId)'")
$principals = Invoke-Graph GET "servicePrincipals?`$filter=$principalFilter" $null
if (@($principals.value).Count -eq 0) { Invoke-Graph POST 'servicePrincipals' @{ appId = $client.appId } | Out-Null }
$preauthorized = @($api.api.preAuthorizedApplications | Where-Object appId -ne $client.appId)
$preauthorized += @{ appId = $client.appId; delegatedPermissionIds = @($scope[0].id) }
$apiSettings = @{}
$api.api.psobject.Properties | ForEach-Object { $apiSettings[$_.Name] = $_.Value }
$apiSettings.oauth2PermissionScopes = $scopes
$apiSettings.preAuthorizedApplications = $preauthorized
Invoke-Graph PATCH "applications/$($api.id)" @{ api = $apiSettings } | Out-Null
Write-Host "Desktop client created/verified: $($client.appId)"
Write-Host 'Set brain_sync_client_id to that client ID; configure owner/tenant variables and enable the feature only after the runbook checks.'

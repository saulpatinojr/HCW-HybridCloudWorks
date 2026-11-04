<#
.SYNOPSIS
    Entra, part 1 of 2 — the API registration, and who may reach it.

.DESCRIPTION
    This is the RESOURCE half: the app registration the API validates tokens
    against, and the `Admin` app-role assignment that is guard gate 1. The
    CLIENT half — the SPA that signs users in — is 02-entra-spa-client.ps1.

    Split out of the former 01-entra-spa.ps1 by #522. That script did both jobs
    against one registration; see the "WHY THERE ARE TWO" note in
    02-entra-spa-client.ps1 for what changed and why.

    What this script assumes already exists, and asserts rather than creates:

        app registration  HCWSite API  (its client id is looked up, below)
        identifier URI    api://<the API's client id>
        exposed scope     access_as_admin
        app roles         Admin, LabAgent (both enabled)
        token version     requestedAccessTokenVersion = 2

    If any is missing the tenant is not in the state this was written against,
    and guessing at the difference is worse than stopping.

    THE APP ROLE IS ASSIGNED HERE, NOT ON THE SPA. Roles are defined and
    assigned on the registration of the API being called, and the `roles` claim
    rides in the access token regardless of which client asked for it. Splitting
    the client out (#522) therefore does NOT require re-granting anything.

.PARAMETER AdminUpn
    User principal name to grant the Admin app role. Defaults to the signed-in
    user. This is guard gate 1; gate 2 is the `admins/{oid}` registry, seeded
    separately with CMS_BOOTSTRAP_ALLOWED_UIDS / _EMAILS.

.PARAMETER ApiAppId
    The application (client) id of the HCWSite API registration. Leave it
    out and the script finds it: from the HCW_API_APP_ID environment
    variable when that is set, otherwise from the one registration named
    -ApiDisplayName in the signed-in tenant (scripts/lib/Resolve-EntraApiAppId.ps1).
    It used to be a parameter default here; the repository is public and a
    real application id does not go in a tracked file (#1540).

.PARAMETER ApiDisplayName
    The display name the lookup above searches for. HCWSite API.

.PARAMETER WhatIf
    Print what would change and exit without writing.

.EXAMPLE
    ./01-entra-api.ps1 -WhatIf
    ./01-entra-api.ps1
    ./01-entra-api.ps1 -AdminUpn someone@hybridcloudworks.com

.NOTES
    Requires: az CLI, signed in (`az login`) as someone who can update app
    registrations and assign app roles — Application Administrator, Cloud
    Application Administrator, or Global Administrator.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string] $AdminUpn,
    [string] $ApiAppId,
    [string] $ApiDisplayName = 'HCWSite API'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '../lib/Resolve-EntraApiAppId.ps1')

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

Write-Step 'Preflight'
$account = az account show --query '{user:user.name,tenant:tenantId}' -o json | ConvertFrom-Json
Write-Host "signed in as : $($account.user)"
Write-Host "tenant       : $($account.tenant)"
$ApiAppId = Resolve-EntraApiAppId -ApiAppId $ApiAppId -DisplayName $ApiDisplayName
Write-Host "api client id: $ApiAppId"

$app = az ad app show --id $ApiAppId -o json | ConvertFrom-Json
if (-not $app) { throw "App registration $ApiAppId not found in this tenant." }
Write-Host "app          : $($app.displayName)  (object $($app.id))"

$scopes = @($app.api.oauth2PermissionScopes | ForEach-Object { $_.value })
$roles = @($app.appRoles | Where-Object { $_.isEnabled } | ForEach-Object { $_.value })
if ($scopes -notcontains 'access_as_admin') {
    throw "Expected scope 'access_as_admin' is not exposed. Expose an API -> Add a scope, then re-run."
}
if ($roles -notcontains 'Admin') {
    throw "Expected app role 'Admin' is missing or disabled. Add it under App roles, then re-run."
}
Write-Host "scope        : access_as_admin  [ok]"
Write-Host "app role     : Admin            [ok]"

# The audience the API validates depends on this. With version 2 the token's
# `aud` is the bare client-id GUID, which is what ENTRA_API_AUDIENCE is set to;
# with 1 or null it becomes the api:// URI and every token is rejected. See the
# comment on entra_api_audience in infra/variables.tf.
$tokenVersion = $app.api.requestedAccessTokenVersion
Write-Host "token version: $tokenVersion"
if ($tokenVersion -ne 2) {
    throw "requestedAccessTokenVersion is '$tokenVersion', expected 2. ENTRA_API_AUDIENCE is the bare GUID and only matches v2 tokens; changing one without the other rejects every token."
}

Write-Step 'The API must expose no client platform of its own'
# After #522 the SPA has its own registration. A redirect URI left on the API
# means the resource can still act as a public client, which is the coupling the
# split removed — see 02-entra-spa-client.ps1.
$strayRedirects = @($app.spa.redirectUris) + @($app.web.redirectUris) + @($app.publicClient.redirectUris) |
    Where-Object { $_ }
if ($strayRedirects) {
    Write-Host "redirect URIs still on the API registration:" -ForegroundColor Yellow
    $strayRedirects | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host 'Remove them once the SPA registration is live and verified (#522).' -ForegroundColor Yellow
}
else {
    Write-Host 'none  [ok]' -ForegroundColor Green
}

Write-Step 'Admin app-role assignment (guard gate 1)'
if (-not $AdminUpn) { $AdminUpn = $account.user }
Write-Host "user: $AdminUpn"

# A B2B guest's UPN is not their mail address — spatino@hybridcloudworks.com
# is really spatino_hybridcloudworks.com#EXT#@<tenant>.onmicrosoft.com, and
# `az ad user show --id <mail>` does not resolve it. Try the UPN, then fall
# back to a directory filter on mail/otherMails, which is what actually finds
# a guest.
$user = az ad user show --id $AdminUpn -o json 2>$null | ConvertFrom-Json
if (-not $user) {
    $escaped = $AdminUpn.Replace("'", "''")
    $filter = [uri]::EscapeDataString("mail eq '$escaped' or userPrincipalName eq '$escaped'")
    $found = az rest --method GET `
        --url "https://graph.microsoft.com/v1.0/users?`$filter=$filter&`$select=id,displayName,userPrincipalName,mail" `
        -o json 2>$null | ConvertFrom-Json
    $user = $found.value | Select-Object -First 1
    if ($user) { Write-Host "resolved guest UPN: $($user.userPrincipalName)" }
}
if (-not $user) {
    $hint = 'az ad user list --query "[].{n:displayName,upn:userPrincipalName,mail:mail}" -o table'
    throw "User '$AdminUpn' not found by UPN or mail. List candidates with: $hint"
}

# The role is assigned on the API app's SERVICE PRINCIPAL, not on the app
# registration. Assigning it on the registration is a no-op that looks like it
# worked, which is the usual way this step is got wrong.
$sp = az ad sp show --id $ApiAppId -o json 2>$null | ConvertFrom-Json
if (-not $sp) {
    throw "No service principal for $ApiAppId. Create one with: az ad sp create --id $ApiAppId"
}
$adminRoleId = ($app.appRoles | Where-Object { $_.value -eq 'Admin' }).id

$existing = az rest --method GET `
    --url "https://graph.microsoft.com/v1.0/users/$($user.id)/appRoleAssignments" `
    -o json | ConvertFrom-Json
$already = $existing.value | Where-Object { $_.appRoleId -eq $adminRoleId -and $_.resourceId -eq $sp.id }

if ($already) {
    Write-Host 'already assigned' -ForegroundColor Green
}
elseif ($PSCmdlet.ShouldProcess($AdminUpn, 'assign the Admin app role')) {
    $body = @{ principalId = $user.id; resourceId = $sp.id; appRoleId = $adminRoleId } |
        ConvertTo-Json -Compress
    $tmp = New-TemporaryFile
    try {
        Set-Content -Path $tmp -Value $body -Encoding utf8
        az rest --method POST `
            --url "https://graph.microsoft.com/v1.0/users/$($user.id)/appRoleAssignments" `
            --headers 'Content-Type=application/json' `
            --body "@$tmp" | Out-Null
    }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    Write-Host 'assigned' -ForegroundColor Green
}

Write-Step 'Result'
Write-Host 'Gate 2 is separate and still open: the admins/{oid} registry.' -ForegroundColor Yellow
Write-Host 'Seed it with CMS_BOOTSTRAP_ALLOWED_EMAILS (or _UIDS) on the Function App,'
Write-Host 'then call POST /api/bootstrapCurrentUserAdmin once signed in. Both gates'
Write-Host 'must pass — a token with the Admin role but no registry row is still 403.'
Write-Host ''
Write-Host 'Next: ./02-entra-spa-client.ps1 creates the SPA registration users sign in with.'

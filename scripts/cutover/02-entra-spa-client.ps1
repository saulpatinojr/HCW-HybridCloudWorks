<#
.SYNOPSIS
    Entra, part 2 of 2 — the SPA registration users sign in with.

.DESCRIPTION
    This is the CLIENT half. It creates (or updates) a registration that is a
    public client and nothing else: SPA redirect URIs, and delegated permission
    to the API's `access_as_admin` scope. It exposes no API, defines no app
    roles, and holds no credentials.

    ===========================================================================
    WHY THERE ARE TWO (#522)
    ===========================================================================
    Until 2026-09-12 one registration did both jobs: the former
    01-entra-spa.ps1 added an SPA platform to the API's own registration. Its
    reasoning is worth keeping, because it was sound and somebody will re-derive
    it otherwise:

        ~~It uses a SPA platform on the EXISTING registration rather than a
        second registration — the plan allowed either, and one registration means
        the SPA requests a scope on its own app, which consents automatically
        and removes the single highest-risk mismatch in the system (a SPA client
        id and an API audience that disagree).~~

    Struck through, for two reasons.

    First, the mismatch it was avoiding is now caught before it ships:
    `assertDeployConfig` in frontend/vite.config.js refuses a deploy build whose
    Entra ids are not GUIDs (#516), so a wrong client id fails the build rather
    than reaching production.

    Second, three other places in this repository — ADR 0006,
    `functions/src/lib/auth/verify-token.js` DECISION 3, and
    `infra/variables.tf` — all specified two registrations. The tenant had
    quietly diverged from an accepted decision, and a codebase that describes a
    tenant it does not have is worse than either choice made deliberately.

    Microsoft's own reason is permission inheritance: "if the web API has a
    higher set of permissions, then the client app doesn't inherit them". One
    registration means one service principal, so any credential or Graph
    permission ever added for the API is simultaneously available to a
    browser-delivered public client.

    ===========================================================================
    WHAT DOES NOT CHANGE
    ===========================================================================
    `ENTRA_API_AUDIENCE` and `VITE_ENTRA_API_SCOPE`. The split changes the
    CLIENT, not the resource, so `aud` stays the API's client id. Exactly one
    value changes: the `VITE_ENTRA_CLIENT_ID` repository variable, which this
    script prints at the end. App-role assignments also stay put — they live on
    the API's service principal (see 01-entra-api.ps1).

.PARAMETER ApiAppId
    The application (client) id of the HCWSite API registration the SPA asks
    a scope on. Leave it out and the script finds it: from HCW_API_APP_ID
    when that is set, otherwise from the one registration named
    -ApiDisplayName in the signed-in tenant (scripts/lib/Resolve-EntraApiAppId.ps1).
    A real application id does not go in a tracked file (#1540).

.PARAMETER ApiDisplayName
    The display name the lookup above searches for. HCWSite API.

.PARAMETER Prune
    Replace the SPA redirect URIs with exactly the list below, removing any
    others. Without it the list is unioned, which is the safer default for an
    unattended run but will not remove anything.

.PARAMETER WhatIf
    Print what would change and exit without writing.

.EXAMPLE
    ./02-entra-spa-client.ps1 -WhatIf
    ./02-entra-spa-client.ps1
    ./02-entra-spa-client.ps1 -Prune

.NOTES
    Requires: az CLI, signed in (`az login`) as Application Administrator,
    Cloud Application Administrator, or Global Administrator.

    LOCALHOST IS NOT HERE, AND MUST NOT BE ADDED. See 03-entra-dev-client.ps1.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string] $DisplayName = 'HCWSite SPA',
    [string] $ApiAppId,
    [string] $ApiDisplayName = 'HCWSite API',
    [switch] $Prune,
    # Every origin the admin UI is served from, each ending in the redirect path
    # the SPA actually uses (#520). No trailing slash, no bare origin: MSAL sends
    # `redirectUri` exactly and Entra matches it exactly.
    #
    # The Static Web App hostname is here deliberately and is NOT a leftover.
    # deploy-azure-frontend.yml documents the production break-glass as
    # re-pointing or disabling the custom domain, which lands on that hostname —
    # removing it would take admin sign-in out of the only documented recovery
    # path, discovered during an incident. It is neither a wildcard nor a
    # dangling domain. Remove it when the Static Web App is deleted, or when the
    # escape hatch stops depending on the default hostname.
    [string[]] $RedirectUris = @(
        'https://hybridcloudworks.com/auth/callback',
        'https://www.hybridcloudworks.com/auth/callback',
        'https://calm-ground-0d0e6a010.7.azurestaticapps.net/auth/callback'
    )
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '../lib/Resolve-EntraApiAppId.ps1')

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

# A body written to a temp file rather than passed inline: PowerShell collapses
# a single-element array to a scalar on the way through, and Graph rejects a
# scalar where it wants a list.
function Invoke-GraphPatch {
    param([string] $Url, [hashtable] $Body)
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    Write-Host "PATCH $Url"
    Write-Host "  $json"
    $tmp = New-TemporaryFile
    try {
        Set-Content -Path $tmp -Value $json -Encoding utf8
        az rest --method PATCH --url $Url --headers 'Content-Type=application/json' --body "@$tmp" | Out-Null
    }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

Write-Step 'Preflight'
$account = az account show --query '{user:user.name,tenant:tenantId}' -o json | ConvertFrom-Json
Write-Host "signed in as : $($account.user)"
Write-Host "tenant       : $($account.tenant)"
$ApiAppId = Resolve-EntraApiAppId -ApiAppId $ApiAppId -DisplayName $ApiDisplayName
Write-Host "api client id: $ApiAppId"

$api = az ad app show --id $ApiAppId -o json | ConvertFrom-Json
if (-not $api) { throw "API registration $ApiAppId not found. Run 01-entra-api.ps1 first." }
$scope = $api.api.oauth2PermissionScopes | Where-Object { $_.value -eq 'access_as_admin' }
if (-not $scope) { throw "The API exposes no 'access_as_admin' scope. Run 01-entra-api.ps1 first." }
Write-Host "api          : $($api.displayName)"
Write-Host "scope id     : $($scope.id)"

Write-Step 'SPA registration'
$candidates = @(az ad app list --display-name $DisplayName -o json | ConvertFrom-Json)
# Fail rather than guess. Display names are not unique in a directory, so
# -First 1 would patch whichever registration Graph happened to return first —
# silently, and with writes. An operator who is shown two can disambiguate; a
# script that quietly picks one cannot be corrected after the fact.
#
# `$candidates`, not `$matches`: the latter is a PowerShell automatic variable
# that `-match` overwrites, and a name collision there fails in a way nobody
# reads the script for.
if ($candidates.Count -gt 1) {
    Write-Host 'More than one registration matches that display name:' -ForegroundColor Red
    $candidates | ForEach-Object { Write-Host "  $($_.appId)  $($_.displayName)" }
    throw "Ambiguous -DisplayName '$DisplayName'. Rename the duplicates, or pass an exact -DisplayName."
}
$spa = $candidates | Select-Object -First 1
if ($spa) {
    Write-Host "found existing: $($spa.appId)"
}
elseif ($PSCmdlet.ShouldProcess($DisplayName, 'create the SPA app registration')) {
    # AzureADMyOrg explicitly: some az versions default to
    # AzureADandPersonalMicrosoftAccount, which publishes a sign-in page to every
    # Microsoft account on earth. The API would still reject those tokens, but
    # there is no reason to offer the attempt.
    $spa = az ad app create --display-name $DisplayName --sign-in-audience AzureADMyOrg -o json | ConvertFrom-Json
    Write-Host "created: $($spa.appId)"
}
else {
    Write-Host 'would create the registration; nothing further to do in -WhatIf'
    return
}
if ($spa.signInAudience -ne 'AzureADMyOrg') {
    throw "signInAudience is '$($spa.signInAudience)', expected AzureADMyOrg."
}

Write-Step 'Redirect URIs'
$current = @($spa.spa.redirectUris)
Write-Host "current: $(if ($current) { $current -join ', ' } else { '(none)' })"
Write-Host "desired: $($RedirectUris -join ', ')"

$target = if ($Prune) { @($RedirectUris) } else { @($current + $RedirectUris | Select-Object -Unique) }
$adding = @($target | Where-Object { $current -notcontains $_ })
$removing = @($current | Where-Object { $target -notcontains $_ })

if ($adding) { Write-Host "adding  : $($adding -join ', ')" -ForegroundColor Green }
# Removals are printed as loudly as additions, which the unioning predecessor
# could not do at all — it is how localhost survived on a production
# registration unnoticed (#521).
if ($removing) { Write-Host "removing: $($removing -join ', ')" -ForegroundColor Yellow }
if (-not $adding -and -not $removing) { Write-Host 'nothing to change' -ForegroundColor Green }
elseif (-not $Prune -and $removing) {
    Write-Host 'Run with -Prune to apply the removals.' -ForegroundColor Yellow
}

if (($adding -or ($Prune -and $removing)) -and
    $PSCmdlet.ShouldProcess($DisplayName, "set SPA redirect URIs: $($target -join ', ')")) {
    Invoke-GraphPatch -Url "https://graph.microsoft.com/v1.0/applications/$($spa.id)" `
        -Body @{ spa = @{ redirectUris = [string[]]$target } }
}

Write-Step 'Delegated permission to the API'
if ($PSCmdlet.ShouldProcess($DisplayName, "request $($api.displayName)/access_as_admin")) {
    Invoke-GraphPatch -Url "https://graph.microsoft.com/v1.0/applications/$($spa.id)" -Body @{
        requiredResourceAccess = [object[]]@(
            @{
                resourceAppId  = $ApiAppId
                resourceAccess = [object[]]@(@{ id = $scope.id; type = 'Scope' })
            }
        )
    }

    az ad sp create --id $spa.appId -o none 2>$null
    az ad app permission admin-consent --id $spa.appId | Out-Null

    # The exit code above does not prove the grant exists, and a missing grant
    # means every admin sign-in fails at the consent screen after the frontend
    # switches over. Verify rather than assume.
    $spaSp = az ad sp show --id $spa.appId -o json | ConvertFrom-Json
    $apiSp = az ad sp show --id $ApiAppId -o json | ConvertFrom-Json
    $grants = az rest --method GET `
        --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($spaSp.id)/oauth2PermissionGrants" `
        -o json | ConvertFrom-Json
    $grant = $grants.value | Where-Object { $_.resourceId -eq $apiSp.id -and $_.scope -match 'access_as_admin' }
    if ($grant) {
        Write-Host "consent: $($grant.consentType), scope '$($grant.scope)'  [ok]" -ForegroundColor Green
    }
    else {
        throw "No admin consent grant for access_as_admin on $($spa.appId). Sign-in will fail at the consent screen; grant it in the portal before switching VITE_ENTRA_CLIENT_ID."
    }
}

Write-Step 'Result'
Write-Host ''
Write-Host "  VITE_ENTRA_CLIENT_ID = $($spa.appId)" -ForegroundColor Green
Write-Host ''
Write-Host 'That is the ONLY value that changes. ENTRA_API_AUDIENCE and'
Write-Host 'VITE_ENTRA_API_SCOPE stay as they are — the split changes the client,'
Write-Host 'not the resource, so `aud` is still the API app id.'
Write-Host ''
Write-Host 'Set the repository variable, run the frontend deploy, and verify on'
Write-Host 'Admin -> Health: `azp` should now differ from `aud`.'
Write-Host ''
Write-Host 'Roll back by setting VITE_ENTRA_CLIENT_ID back to the API app id and'
Write-Host 're-running the deploy. No code change, so no revert commit — which is'
Write-Host 'why that value lives in a repository variable.'

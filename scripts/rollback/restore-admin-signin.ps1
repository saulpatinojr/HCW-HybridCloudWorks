<#
.SYNOPSIS
    Break-glass: put the API registration back into a state that can complete a
    sign-in, and print the client id to roll the frontend back to.

.DESCRIPTION
    Step 1 of docs/runbooks/admin-signin-rollback.md. Run this, then dispatch
    the frontend deploy with the client id it prints.

    ===========================================================================
    WHY THIS IS A SCRIPT AND NOT A LINE IN THE RUNBOOK
    ===========================================================================
    Two rules meet here and appear to conflict. The redaction gate
    (`scripts/docs/check_redaction.py`) rejects any real GUID in a tracked
    file: the repository is public, so a real tenant or application id in
    any file is published. The working agreement rejects any placeholder in
    a line meant to be pasted, because a pasted `<your-id>` has cost this
    project real time.

    A rollback runbook full of `00000000-…` placeholders satisfies the first
    and fails the operator. A script that looks the values up satisfies
    both: the runbook says "run this", and the script reads the tenant from
    `az account show` and the API's client id from the one registration
    named HCWSite API (scripts/lib/Resolve-EntraApiAppId.ps1). Until #1540
    both ids were parameter defaults here, on the reasoning that `scripts/`
    was not scanned; the gate reads the whole tree now, and the defaults
    went with the reasoning.

    ===========================================================================
    WHY IT IS NOT A WORKFLOW
    ===========================================================================
    Because it cannot be. The GitHub deploy identity is a user-assigned managed
    identity holding Azure RBAC and no Entra directory rights, which
    `infra/oidc.tf` explains at length — Azure Owner does not grant the ability
    to write an app registration. Granting CI Application Administrator so that
    a rollback is one click would hand every future workflow run the ability to
    rewrite app registrations, permanently, to save one command during an
    incident that may never happen.

    So this step needs a human with directory permission. The parts that CAN be
    automated are: `deploy-azure-frontend.yml` takes an
    `entra_client_id_override` input, so no repository-variable write is needed
    either.

.PARAMETER TenantId
    The tenant the rollback must run in. Leave it out and the script takes
    HCW_TENANT_ID when that is set; otherwise it goes by the signed-in
    tenant, which it prints, and the API lookup below is the check that it
    is the right one (no other tenant has an HCWSite API registration).

.PARAMETER ApiAppId
    The application (client) id of the HCWSite API registration. Leave it
    out and the script finds it: from HCW_API_APP_ID when that is set,
    otherwise from the one registration named -ApiDisplayName in the
    signed-in tenant (scripts/lib/Resolve-EntraApiAppId.ps1).

.PARAMETER ApiDisplayName
    The display name the lookup above searches for. HCWSite API.

.PARAMETER WhatIf
    Print what would change and exit without writing.

.EXAMPLE
    ./restore-admin-signin.ps1 -WhatIf
    ./restore-admin-signin.ps1

.NOTES
    Requires: az CLI, signed in as Application Administrator, Cloud Application
    Administrator, or Global Administrator.

    This is a rollback, not a fix. Reopen the split issue afterwards, or go
    forward again — the runbook says what each looks like.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string] $TenantId = $env:HCW_TENANT_ID,
    # The API registration, which before the #522 split also served as the SPA
    # client. Rolling back means pointing the frontend at it again, which only
    # works while it has redirect URIs — restored below.
    [string] $ApiAppId,
    [string] $ApiDisplayName = 'HCWSite API',
    [string[]] $RedirectUris = @(
        'https://hybridcloudworks.com/auth/callback',
        'https://www.hybridcloudworks.com/auth/callback',
        'https://calm-ground-0d0e6a010.7.azurestaticapps.net/auth/callback'
    )
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '../lib/Resolve-EntraApiAppId.ps1')

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

Write-Step 'Preflight'
$account = az account show --query '{user:user.name,tenant:tenantId}' -o json | ConvertFrom-Json
if (-not $account) { throw 'az is not signed in. Run: az login --allow-no-subscriptions' }
Write-Host "signed in as : $($account.user)"
Write-Host "tenant       : $($account.tenant)"
if ($TenantId -and $account.tenant -ne $TenantId) {
    throw "Signed in to tenant $($account.tenant), expected $TenantId. Run: az login --tenant $TenantId --allow-no-subscriptions"
}
# Without -TenantId this lookup is the tenant check: it stops when the
# signed-in tenant has no registration of that name.
$ApiAppId = Resolve-EntraApiAppId -ApiAppId $ApiAppId -DisplayName $ApiDisplayName
Write-Host "api client id: $ApiAppId"

$api = az ad app show --id $ApiAppId -o json | ConvertFrom-Json
if (-not $api) { throw "App registration $ApiAppId not found in this tenant." }
Write-Host "app          : $($api.displayName)"

$current = @($api.spa.redirectUris)
Write-Host "current URIs : $(if ($current) { $current -join ', ' } else { '(none)' })"

Write-Step 'Restore the redirect URIs'
# A union, not a replace. This runs during an incident, and quietly deleting a
# URI somebody added by hand five minutes ago to work around the same incident
# would be the wrong kind of tidy.
$target = @($current + $RedirectUris | Select-Object -Unique)
$adding = @($target | Where-Object { $current -notcontains $_ })

if (-not $adding) {
    Write-Host 'already present — nothing to restore' -ForegroundColor Green
}
elseif ($PSCmdlet.ShouldProcess($api.displayName, "add redirect URIs: $($adding -join ', ')")) {
    $body = @{ spa = @{ redirectUris = [string[]]$target } } | ConvertTo-Json -Depth 6 -Compress
    Write-Host "  $body"
    $tmp = New-TemporaryFile
    try {
        Set-Content -Path $tmp -Value $body -Encoding utf8
        az rest --method PATCH `
            --url "https://graph.microsoft.com/v1.0/applications/$($api.id)" `
            --headers 'Content-Type=application/json' --body "@$tmp" | Out-Null
    }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    Write-Host "added: $($adding -join ', ')" -ForegroundColor Green
}

Write-Step 'Verify'
# Read it back rather than trusting the PATCH. A rollback that reports success
# and did nothing is worse than one that fails, because the next step looks
# like the broken thing.
$after = az ad app show --id $ApiAppId -o json | ConvertFrom-Json
$now = @($after.spa.redirectUris)
$missing = @($RedirectUris | Where-Object { $now -notcontains $_ })
$now | ForEach-Object { Write-Host "  $_" }
if ($missing) {
    throw "Still missing: $($missing -join ', '). The frontend deploy below would fail at the redirect; fix this first."
}
Write-Host 'all three present  [ok]' -ForegroundColor Green

Write-Step 'Next'
Write-Host ''
Write-Host '  Dispatch: Actions -> Deploy Frontend -> Run workflow' -ForegroundColor Green
Write-Host "  Set entra_client_id_override to: $ApiAppId" -ForegroundColor Green
Write-Host ''
Write-Host 'The override applies to that build only — the next deploy reads the'
Write-Host 'VITE_ENTRA_CLIENT_ID repository variable again. Set the variable too'
Write-Host 'if the rollback is meant to stick.'
Write-Host ''
Write-Host 'Afterwards, Admin -> Health: `azp` will equal `aud`, and the "azp'
Write-Host 'differs from aud" verdict will read FAIL. On a rolled-back'
Write-Host 'configuration that is correct, not a new problem.'

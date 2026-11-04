<#
.SYNOPSIS
    Finds the client id of the HCWSite API app registration without a copy
    of it in the repository.

.DESCRIPTION
    Dot-sourced by the Entra scripts under scripts/cutover/ and
    scripts/rollback/. Until #1540 each of them carried the API's real
    application (client) id as a parameter default, so an operator could run
    them with no arguments. The repository is public, and its rule is that a
    real tenant, subscription or application id never goes in a tracked
    file, so the default went and this lookup took its place.

    Resolve-EntraApiAppId takes the id from the first of these that is set:

      1. -ApiAppId, passed by the operator;
      2. the HCW_API_APP_ID environment variable;
      3. the one app registration in the signed-in tenant whose display name
         is exactly -DisplayName (HCWSite API), read with az ad app list.

    It stops, rather than guessing, when no registration has that name or
    more than one does. Display names are not unique in a directory, and a
    script that quietly picked one would write to it.

    Register-LabAgent.ps1 has its own copy of this logic (Resolve-LabApiAppId)
    because its tests load its functions from its syntax tree and it goes
    through its own mockable az seam.
#>

function Resolve-EntraApiAppId {
    [OutputType([string])]
    param(
        [AllowEmptyString()] [string] $ApiAppId,
        [string] $DisplayName = 'HCWSite API'
    )

    $guidPattern = '\A[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\z'

    $source = '-ApiAppId'
    if ([string]::IsNullOrWhiteSpace($ApiAppId)) {
        $ApiAppId = [string]$env:HCW_API_APP_ID
        $source = 'HCW_API_APP_ID'
    }
    if (-not [string]::IsNullOrWhiteSpace($ApiAppId)) {
        if ($ApiAppId -notmatch $guidPattern) {
            throw "$source is '$ApiAppId', which is not an application (client) id (eight, four, four, four and twelve hex digits)."
        }
        return $ApiAppId.ToLowerInvariant()
    }

    # az ad app list filters on the display name; the exact comparison below
    # is what keeps a registration named 'HCWSite API (old)' from being taken
    # for the real one if the CLI ever matches on a prefix.
    $json = az ad app list --display-name $DisplayName -o json
    if ($LASTEXITCODE -ne 0) {
        throw "az ad app list exited $LASTEXITCODE while looking for the app registration '$DisplayName'. Sign in first (az login), then run this again."
    }
    $found = @($json | ConvertFrom-Json | Where-Object { $_.displayName -ceq $DisplayName })
    if ($found.Count -eq 1) {
        $id = [string]$found[0].appId
        if ($id -notmatch $guidPattern) {
            throw "az returned '$id' as the client id of '$DisplayName', which is not an application (client) id."
        }
        return $id.ToLowerInvariant()
    }
    if ($found.Count -eq 0) {
        throw "No app registration named '$DisplayName' in the signed-in tenant. Pass -ApiAppId with its application (client) id (Entra admin center: App registrations, $DisplayName, Overview), or set HCW_API_APP_ID to it."
    }
    $ids = ($found | ForEach-Object { $_.appId }) -join ', '
    throw "More than one app registration is named '$DisplayName' ($ids). Pass -ApiAppId with the right one, or rename the others."
}

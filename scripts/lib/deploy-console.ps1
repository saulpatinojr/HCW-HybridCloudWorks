#requires -Version 7.0
<#
  deploy-console.ps1 — shared console, prompting and Azure-discovery helpers
  for the three deployment scripts. Dot-source it:

      . (Join-Path $PSScriptRoot 'lib/deploy-console.ps1')

  WHY THESE SCRIPTS PROMPT RATHER THAN TAKE FLAGS

  Every value these scripts need is a GUID, and GUIDs passed as flags go wrong
  in three ways that all look like something else later:

    - they land in shell history, alongside the occasional token;
    - one transposed character produces an authentication failure that reads
      like a permissions problem;
    - the operator has to know which of four similar subscription IDs goes in
      which slot, from a terminal that cannot show them the list.

  So the model is: DISCOVER what Azure already knows, PICK from a numbered
  list when there is a genuine choice, PROMPT only for what cannot be found,
  then show everything resolved and ask for ONE confirmation before writing.

  Parameters remain on each script, but every one is optional. Supplying one
  skips its discovery step, which is what makes the scripts usable from CI
  without turning the interactive path into an afterthought.
#>

# Deliberately no Set-StrictMode here. Dot-sourcing runs in the CALLER's
# scope, so setting it would silently change the semantics of every script
# that loads this file — including making an empty `(... | ConvertFrom-Json).name`
# throw rather than yield nothing. A shared helper must not do that to its
# callers; scripts that want strict mode set it themselves.

# ---------------------------------------------------------------------------
# Output. Four shapes, so a long run stays scannable: what is fine, what
# changed, what the operator has to act on, and everything else.
# ---------------------------------------------------------------------------
function Write-Step { param($Message) Write-Host "`n=== $Message" -ForegroundColor Cyan }
function Write-Ok { param($Message) Write-Host "  [ok]     $Message" -ForegroundColor Green }
function Write-Act { param($Message) Write-Host "  [write]  $Message" -ForegroundColor Yellow }
function Write-Info { param($Message) Write-Host "  $Message" -ForegroundColor DarkGray }
function Write-Warn { param($Message) Write-Host "  [warn]   $Message" -ForegroundColor Yellow }

function Stop-WithGuidance {
  param([string] $Problem, [string[]] $Fix)
  Write-Host "`n  [stop] $Problem" -ForegroundColor Red
  foreach ($line in $Fix) { Write-Host "         $line" -ForegroundColor Red }
  exit 1
}

# A prompt with no console reads EOF forever. Fail with the flag list instead
# of hanging, so a CI run says what it needed rather than timing out.
function Assert-Interactive {
  param([string] $Needed, [string[]] $NonInteractiveFix)
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) { return }
  Stop-WithGuidance "Cannot prompt for $Needed — this session has no interactive console." (
    @('Supply it as a parameter instead:') + $NonInteractiveFix
  )
}

# ---------------------------------------------------------------------------
# Prompting
# ---------------------------------------------------------------------------

# A numbered picker. Returns the chosen item from $Options (the objects, not
# the labels), or auto-returns when there is exactly one candidate and
# -AutoSelectSingle is set — the common case once the naming convention has
# narrowed four subscriptions to one.
function Select-Option {
  param(
    [Parameter(Mandatory)][string] $Title,
    [Parameter(Mandatory)][object[]] $Options,
    [Parameter(Mandatory)][scriptblock] $Label,
    [switch] $AutoSelectSingle,
    [string] $AutoSelectNote = 'only candidate'
  )

  if ($Options.Count -eq 0) { return $null }
  if ($Options.Count -eq 1 -and $AutoSelectSingle) {
    Write-Ok "$Title`: $(& $Label $Options[0])  ($AutoSelectNote)"
    return $Options[0]
  }

  Assert-Interactive -Needed $Title -NonInteractiveFix @('see the script help: Get-Help <script> -Full')

  Write-Host "`n  $Title" -ForegroundColor White
  for ($i = 0; $i -lt $Options.Count; $i++) {
    Write-Host ("    {0,2}. {1}" -f ($i + 1), (& $Label $Options[$i]))
  }

  while ($true) {
    $answer = Read-Host '  Number'
    if ($answer -match '^\d+$') {
      $index = [int]$answer - 1
      if ($index -ge 0 -and $index -lt $Options.Count) { return $Options[$index] }
    }
    Write-Host "  Enter a number between 1 and $($Options.Count)." -ForegroundColor Red
  }
}

# Multi-select over the same shape. Enter alone accepts the pre-selected set,
# which is how "all three deployment targets" stays a single keypress.
function Select-OptionSet {
  param(
    [Parameter(Mandatory)][string] $Title,
    [Parameter(Mandatory)][object[]] $Options,
    [Parameter(Mandatory)][scriptblock] $Label,
    [object[]] $Preselected = @()
  )

  # A preselection derived from the naming convention is a real answer, not a
  # guess, so a session with no console takes it rather than failing. An
  # operator with a console still gets to adjust it; callers put a final
  # confirmation after this either way.
  if ($Preselected.Count -gt 0 -and (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected)) {
    Write-Ok "$Title (no console — taking the $($Preselected.Count) matched by the naming convention):"
    foreach ($item in $Preselected) { Write-Info "  $(& $Label $item)" }
    return $Preselected
  }

  Assert-Interactive -Needed $Title -NonInteractiveFix @('see the script help: Get-Help <script> -Full')

  Write-Host "`n  $Title" -ForegroundColor White
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $mark = if ($Options[$i] -in $Preselected) { '*' } else { ' ' }
    Write-Host ("   {0} {1,2}. {2}" -f $mark, ($i + 1), (& $Label $Options[$i]))
  }
  if ($Preselected.Count -gt 0) {
    Write-Info "* = preselected. Enter to accept, or type numbers separated by commas."
  } else {
    Write-Info 'Type numbers separated by commas.'
  }

  while ($true) {
    $answer = (Read-Host '  Numbers').Trim()
    if ($answer -eq '' -and $Preselected.Count -gt 0) { return $Preselected }
    $parts = $answer -split '[,\s]+' | Where-Object { $_ -ne '' }
    if ($parts.Count -gt 0 -and ($parts | ForEach-Object { $_ -match '^\d+$' }) -notcontains $false) {
      $chosen = @()
      $valid = $true
      foreach ($part in $parts) {
        $index = [int]$part - 1
        if ($index -lt 0 -or $index -ge $Options.Count) { $valid = $false; break }
        $chosen += $Options[$index]
      }
      if ($valid -and $chosen.Count -gt 0) { return ($chosen | Select-Object -Unique) }
    }
    Write-Host "  Enter numbers between 1 and $($Options.Count), separated by commas." -ForegroundColor Red
  }
}

# Free-text with an optional default and validation. The paste path, for the
# values nothing can discover.
function Read-Value {
  param(
    [Parameter(Mandatory)][string] $Prompt,
    [string] $Default,
    [scriptblock] $Validate,
    [string] $ValidationMessage = 'That value is not in the expected format.',
    [string[]] $Hint
  )

  Assert-Interactive -Needed $Prompt -NonInteractiveFix @('see the script help: Get-Help <script> -Full')

  foreach ($line in $Hint) { Write-Info $line }
  $suffix = if ($Default) { " [$Default]" } else { '' }

  while ($true) {
    $answer = (Read-Host "  $Prompt$suffix").Trim()
    if ($answer -eq '' -and $Default) { $answer = $Default }
    if ($answer -eq '') { Write-Host '  A value is required.' -ForegroundColor Red; continue }
    if (-not $Validate -or (& $Validate $answer)) { return $answer }
    Write-Host "  $ValidationMessage" -ForegroundColor Red
  }
}

function Read-SecretValue {
  param([Parameter(Mandatory)][string] $Prompt, [string[]] $Hint)
  Assert-Interactive -Needed $Prompt -NonInteractiveFix @('see the script help: Get-Help <script> -Full')
  foreach ($line in $Hint) { Write-Info $line }
  while ($true) {
    $secure = Read-Host "  $Prompt" -AsSecureString
    if ($secure.Length -gt 0) { return $secure }
    Write-Host '  A value is required.' -ForegroundColor Red
  }
}

# One confirmation covering everything resolved, rather than a prompt per
# value. This is the screen where a wrong subscription gets caught, so it
# prints what will be written and to where.
function Confirm-Plan {
  param(
    [Parameter(Mandatory)][string] $Title,
    # IDictionary, not hashtable: callers pass [ordered] so the rows read in a
    # deliberate order rather than alphabetically.
    [Parameter(Mandatory)][System.Collections.IDictionary] $Values,
    [string[]] $Order,
    [switch] $Force
  )

  Write-Step $Title
  $keys = if ($Order) { $Order } else { $Values.Keys | Sort-Object }
  $width = ($keys | Measure-Object -Property Length -Maximum).Maximum
  foreach ($key in $keys) {
    Write-Host ("    {0,-$width}  {1}" -f $key, $Values[$key]) -ForegroundColor White
  }

  if ($Force) { return $true }

  # A gate that cannot ask must REFUSE, not assent (T-702). This used to
  # return $true when stdin was redirected, which made every confirmation in
  # this library decorative under `pwsh -File … < /dev/null`, in a CI step, or
  # behind any wrapper that pipes input — including the one in front of
  # tenant-root elevation. `-Force` is the deliberate way to proceed
  # unattended, and it has to be typed on the command line.
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
    Write-Host ''
    Write-Host '  Refusing to continue: no interactive console to confirm on.' -ForegroundColor Red
    Write-Host '  Re-run in a terminal, or pass -Force to proceed unattended.' -ForegroundColor Red
    return $false
  }

  $answer = (Read-Host "`n  Proceed? [Y/n]").Trim()
  return ($answer -eq '' -or $answer -match '^[Yy]')
}

function Test-Guid {
  param([string] $Value)
  return [guid]::TryParse($Value, [ref]([guid]::Empty))
}

# ---------------------------------------------------------------------------
# HCP Terraform
# ---------------------------------------------------------------------------

# Where `terraform login` stores its token. This is PLATFORM-SPECIFIC and the
# difference is not cosmetic: on Windows Terraform writes to
# %APPDATA%\terraform.d\, NOT ~/.terraform.d\. Checking only the Unix path
# meant a Windows operator who had just run `terraform login` was still asked
# to paste a token — and pasting the wrong one produces a 401 that reads as an
# expired credential rather than "we looked in the wrong file".
function Get-TfcCredentialPath {
  $candidates = @()
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'terraform.d/credentials.tfrc.json') }
  $candidates += (Join-Path $HOME '.terraform.d/credentials.tfrc.json')
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  return $null
}

# The token `terraform login` stored, as plaintext, or $null. Callers convert
# to SecureString; this returns the raw value because that is what the file
# holds and what the API needs.
function Get-StoredTfcToken {
  $path = Get-TfcCredentialPath
  if (-not $path) { return $null }
  try {
    $token = (Get-Content $path -Raw | ConvertFrom-Json).credentials.'app.terraform.io'.token
    if ($token) { return [pscustomobject]@{ Token = $token; Path = $path } }
  } catch {
    Write-Info "Could not parse $path."
  }
  return $null
}

function Invoke-TfcApi {
  param(
    [Parameter(Mandatory)][string] $Path,
    [string] $Method = 'GET',
    [hashtable] $Body,
    [Parameter(Mandatory)][securestring] $Token,
    [switch] $AllowFailure
  )
  $arguments = @{
    Method = $Method
    Uri    = "https://app.terraform.io/api/v2$Path"
    # The JSON:API media type is not optional — HCP Terraform rejects
    # application/json with a 415 that does not explain itself.
    Headers        = @{ 'Content-Type' = 'application/vnd.api+json' }
    Authentication = 'Bearer'
    Token          = $Token
  }
  if ($Body) { $arguments.Body = ($Body | ConvertTo-Json -Depth 10) }
  try { return Invoke-RestMethod @arguments } catch {
    if ($AllowFailure) { return $null }
    throw
  }
}

# infra/backend.tf is the source of truth for which organization and workspace
# this configuration belongs to — it is what `terraform` itself obeys. Parsing
# it, rather than keeping a second copy in script defaults, is what stops the
# two drifting apart. They had: the backend named an organization that did not
# exist and a workspace that had never been created, while the scripts happily
# defaulted to the same wrong pair.
function Get-BackendConfig {
  param([Parameter(Mandatory)][string] $BackendPath)

  if (-not (Test-Path $BackendPath)) { return $null }
  $text = Get-Content $BackendPath -Raw

  $organization = [regex]::Match($text, '(?m)^\s*organization\s*=\s*"([^"]+)"').Groups[1].Value
  # `name` inside the workspaces block. Matched after the block opens so a
  # `name` elsewhere in the file cannot be picked up by accident.
  $workspace = [regex]::Match($text, '(?s)workspaces\s*\{.*?name\s*=\s*"([^"]+)"').Groups[1].Value

  if (-not $organization -or -not $workspace) { return $null }
  return [pscustomobject]@{ Organization = $organization; Workspace = $workspace; Path = $BackendPath }
}

function Format-TfcWorkspace {
  param($Workspace)
  $count = $Workspace.attributes.'resource-count'
  $vcs = $Workspace.attributes.'vcs-repo-identifier'
  $notes = @()
  if ($count -gt 0) { $notes += "$count resources" } else { $notes += 'empty' }
  if ($vcs) { $notes += "VCS: $vcs" }
  return "$($Workspace.attributes.name)  ($($notes -join ', '))"
}

# Resolve the workspace infra/backend.tf names, creating it when it does not
# exist. Returns the workspace object, or $null if the caller declined.
#
# The safety rail here is the point. A workspace that already holds resources
# belonging to a DIFFERENT configuration is the most expensive mistake
# available at this step: pointing this configuration at it makes the first
# plan propose destroying everything in it. So an existing non-empty workspace
# is reported with its resource count and VCS repository and requires an
# explicit confirmation, rather than being adopted silently.
function Resolve-TfcWorkspace {
  param(
    [Parameter(Mandatory)][string] $Organization,
    [Parameter(Mandatory)][string] $WorkspaceName,
    [Parameter(Mandatory)][securestring] $Token,
    [string] $TerraformVersion,
    [string] $ProjectName,
    [switch] $WhatIfMode
  )

  $organizations = @((Invoke-TfcApi -Path '/organizations' -Token $Token -AllowFailure).data)
  if ($organizations.Count -eq 0) {
    Stop-WithGuidance 'This token can see no HCP Terraform organizations.' @(
      'The token may be expired, or scoped to nothing.',
      'Create a new one: https://app.terraform.io/app/settings/tokens'
    )
  }
  if ($organizations.id -notcontains $Organization) {
    Stop-WithGuidance "Organization '$Organization' is not visible to this token." @(
      "infra/backend.tf names it, so either the backend is wrong or the token is.",
      "Visible: $($organizations.id -join ', ')",
      'Fix backend.tf to name a real organization, then re-run.'
    )
  }

  $existing = Invoke-TfcApi -Path "/organizations/$Organization/workspaces/$WorkspaceName" -Token $Token -AllowFailure
  if ($existing) {
    $count = $existing.data.attributes.'resource-count'
    if ($count -gt 0) {
      Write-Warn "$Organization/$WorkspaceName already holds $count resources."
      $vcs = $existing.data.attributes.'vcs-repo-identifier'
      if ($vcs) { Write-Info "It is VCS-connected to $vcs." }
      Write-Info 'If those resources belong to a different configuration, the first'
      Write-Info 'plan from here will propose DESTROYING them. Only continue if this'
      Write-Info 'workspace is genuinely the state for infra/ in this repository.'
      if (-not $WhatIfMode -and -not (Confirm-Plan -Title 'Use this existing workspace?' -Values ([ordered]@{
              Workspace = "$Organization/$WorkspaceName"
              Resources = $count
              VCS       = if ($vcs) { $vcs } else { '(none)' }
            }))) {
        return $null
      }
    }
    return $existing.data
  }

  # Not found — create it, choosing a project first, because the project name
  # becomes a segment of the OIDC subject the federated credentials must match.
  Write-Warn "Workspace '$WorkspaceName' does not exist in organization '$Organization'."
  Write-Info 'This is the workspace the configuration runs in, so nothing can'
  Write-Info 'plan or apply until it exists.'

  $projects = @((Invoke-TfcApi -Path "/organizations/$Organization/projects" -Token $Token -AllowFailure).data)
  if ($projects.Count -eq 0) {
    Stop-WithGuidance "No project available in organization '$Organization'." @(
      'Create one in the HCP Terraform UI, then re-run.'
    )
  }

  $project = $null
  if ($ProjectName) {
    $project = $projects | Where-Object { $_.attributes.name -eq $ProjectName } | Select-Object -First 1
    if (-not $project) {
      Stop-WithGuidance "No project named '$ProjectName' in organization '$Organization'." @(
        "Available: $(($projects | ForEach-Object { $_.attributes.name }) -join ', ')"
      )
    }
    Write-Ok "Project: $ProjectName (from -Project)"
  } else {
    Write-Info 'The project name becomes a segment of the OIDC subject the'
    Write-Info 'federated credentials must match, so choose deliberately.'
    $project = Select-Option -Title 'Which project should it live in?' -Options $projects `
      -Label { param($p) $p.attributes.name } -AutoSelectSingle -AutoSelectNote 'only project'
  }
  if (-not $project) { return $null }

  $attributes = @{
    name             = $WorkspaceName
    description      = 'Azure platform for HCWSite (infra/). Created by scripts/set-tfc-variables.ps1.'
    'execution-mode' = 'remote'
    'auto-apply'     = $false
  }
  if ($TerraformVersion) { $attributes['terraform-version'] = $TerraformVersion }

  $label = "$Organization/$WorkspaceName in project '$($project.attributes.name)'"
  if ($WhatIfMode) {
    Write-Act "would create workspace  $label"
    return $null
  }
  if (-not (Confirm-Plan -Title 'Create this workspace?' -Values ([ordered]@{
          Organization = $Organization
          Workspace    = $WorkspaceName
          Project      = $project.attributes.name
          'Auto-apply' = 'off'
        }))) {
    return $null
  }

  $created = Invoke-TfcApi -Path "/organizations/$Organization/workspaces" -Method POST -Token $Token -Body @{
    data = @{
      type          = 'workspaces'
      attributes    = $attributes
      relationships = @{ project = @{ data = @{ type = 'projects'; id = $project.id } } }
    }
  }
  Write-Act "created workspace  $label"
  return $created.data
}

# ---------------------------------------------------------------------------
# Azure
# ---------------------------------------------------------------------------

# az writes progress and warnings to stderr, which PowerShell 7 promotes to a
# terminating error under $ErrorActionPreference = 'Stop'. Judge success by
# exit code instead.
function Invoke-Az {
  param([Parameter(Mandatory)][string[]] $Arguments, [switch] $AllowFailure)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & az @Arguments 2>&1 } finally { $ErrorActionPreference = $previous }
  $script:LastAzFailed = $false
  if ($LASTEXITCODE -ne 0) {
    # `$null` means BOTH "the call failed" and "the call returned nothing",
    # which is fine for a caller that only wants a best-effort write — and
    # wrong for one that reads a result back to prove something is gone.
    # Callers that need the distinction test Test-LastAzFailed (T-703).
    $script:LastAzFailed = $true
    if ($AllowFailure) { return $null }
    throw "az $($Arguments -join ' ') failed:`n$output"
  }
  $text = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { return $text | ConvertFrom-Json } catch { return $text }
}

# True when the most recent Invoke-Az exited non-zero. Only meaningful
# immediately after an -AllowFailure call, where the $null return is
# ambiguous: a read-back that proves a privilege was removed must treat an
# unreadable result as failure, never as "nothing found" (T-703).
function Test-LastAzFailed {
  return [bool] $script:LastAzFailed
}

function Test-AzInstalled {
  if (Get-Command az -ErrorAction SilentlyContinue) { return $true }
  return $false
}

# Every subscription this sign-in can see, enabled only. Cached per session:
# the scripts ask for it repeatedly while resolving four different slots.
function Get-AzSubscriptionList {
  param([switch] $Refresh)
  if ($script:AzSubscriptionCache -and -not $Refresh) { return $script:AzSubscriptionCache }
  $all = Invoke-Az @('account', 'list', '--all', '-o', 'json') -AllowFailure
  if (-not $all) { return @() }
  $script:AzSubscriptionCache = @($all | Where-Object { $_.state -eq 'Enabled' } | Sort-Object name)
  return $script:AzSubscriptionCache
}

function Format-Subscription {
  param($Subscription)
  return "$($Subscription.name)  [$($Subscription.id)]"
}

# The name alone, for a script that must not show subscription ids (#1610).
function Format-SubscriptionName {
  param($Subscription)
  return "$($Subscription.name)"
}

# ---------------------------------------------------------------------------
# Entra — the API app registration behind entra_api_audience
# ---------------------------------------------------------------------------
# Graph is called directly rather than through `az ad app`, because the pieces
# this registration needs (an exposed scope, app roles, v2 access tokens) are
# nested JSON that the CLI's --set syntax mangles on Windows.
function Get-GraphToken {
  $token = Invoke-Az @('account', 'get-access-token', '--resource', 'https://graph.microsoft.com', '-o', 'json') -AllowFailure
  if (-not $token) { return $null }
  return $token.accessToken
}

function Invoke-Graph {
  param(
    [Parameter(Mandatory)][string] $Path,
    [string] $Method = 'GET',
    [hashtable] $Body,
    [Parameter(Mandatory)][string] $AccessToken,
    [switch] $AllowFailure
  )
  $arguments = @{
    Method  = $Method
    Uri     = "https://graph.microsoft.com/v1.0$Path"
    Headers = @{ Authorization = "Bearer $AccessToken"; 'Content-Type' = 'application/json' }
  }
  if ($Body) { $arguments.Body = ($Body | ConvertTo-Json -Depth 20) }
  try { return Invoke-RestMethod @arguments } catch {
    if ($AllowFailure) { return $null }
    throw
  }
}

# Create the API app registration the Functions host validates tokens against.
#
# DECISION 3 (infra/variables.tf) requires this to be a SEPARATE registration
# from the SPA: with one registration, an ID token minted for the browser
# carries aud = <client-id>, indistinguishable from an access token for the
# API, so a token the browser was never meant to send would be accepted.
#
# Created with, because a second manual pass over the same object is how these
# end up half-configured:
#   - identifierUris = api://<appId>, which IS entra_api_audience;
#   - requestedAccessTokenVersion 2, so tokens carry the v2 claims MSAL issues;
#   - the access_as_admin delegated scope the SPA requests (REVIEW 4.5 step 1);
#   - the Admin and LabAgent app roles — deliberately disjoint guards, one for
#     admin users and one for lab agent hosts (REVIEW 4.5 step 4, CHECKLIST 2b);
#   - a service principal, without which no role can be assigned to anyone.
function New-EntraApiRegistration {
  param(
    [Parameter(Mandatory)][string] $DisplayName,
    [Parameter(Mandatory)][string] $AccessToken
  )

  $scopeId = [guid]::NewGuid().ToString()
  $application = Invoke-Graph -Path '/applications' -Method POST -AccessToken $AccessToken -Body @{
    displayName    = $DisplayName
    signInAudience = 'AzureADMyOrg'
    api            = @{
      requestedAccessTokenVersion = 2
      oauth2PermissionScopes      = @(
        @{
          id                      = $scopeId
          value                   = 'access_as_admin'
          type                    = 'User'
          isEnabled               = $true
          adminConsentDisplayName = 'Access the HCWSite API as an admin'
          adminConsentDescription = 'Allows the signed-in admin to call the HCWSite API on their behalf.'
          userConsentDisplayName  = 'Access the HCWSite API'
          userConsentDescription  = 'Allows the app to call the HCWSite API on your behalf.'
        }
      )
    }
    appRoles       = @(
      @{
        id                 = [guid]::NewGuid().ToString()
        value              = 'Admin'
        displayName        = 'Admin'
        description        = 'Gate 1 of the admin guard. Gate 2 is the admins/{oid} registry.'
        allowedMemberTypes = @('User')
        isEnabled          = $true
      }
      @{
        id                 = [guid]::NewGuid().ToString()
        value              = 'LabAgent'
        displayName        = 'LabAgent'
        description        = 'Gate 1 of the agent guard. Deliberately disjoint from Admin.'
        allowedMemberTypes = @('Application')
        isEnabled          = $true
      }
    )
  }

  # identifierUris cannot be set at creation: it embeds the appId, which the
  # directory only assigns once the object exists.
  $audience = "api://$($application.appId)"
  Invoke-Graph -Path "/applications/$($application.id)" -Method PATCH -AccessToken $AccessToken -Body @{
    identifierUris = @($audience)
  } | Out-Null

  # Entra replicates the new application asynchronously; creating the service
  # principal immediately can 404 on an appId the directory has not caught up
  # with yet.
  Start-Sleep -Seconds 10
  Invoke-Graph -Path '/servicePrincipals' -Method POST -AccessToken $AccessToken -Body @{
    appId = $application.appId
  } -AllowFailure | Out-Null

  return [pscustomobject]@{
    AppId    = $application.appId
    ObjectId = $application.id
    Audience = $audience
    Scope    = "$audience/access_as_admin"
  }
}

# Resolve one subscription slot: filter by the naming convention, auto-select
# an unambiguous match, fall back to a picker over everything otherwise. The
# pattern is a hint, never a requirement — a tenant that has not adopted the
# convention still gets a working picker.
function Select-Subscription {
  param(
    [Parameter(Mandatory)][string] $Purpose,
    [string] $Pattern,
    [object[]] $Subscriptions,
    # Show names only, never ids.
    [switch] $NamesOnly
  )

  if (-not $Subscriptions) { $Subscriptions = Get-AzSubscriptionList }
  if ($Subscriptions.Count -eq 0) { return $null }
  $label = if ($NamesOnly) { ${function:Format-SubscriptionName} } else { ${function:Format-Subscription} }

  $candidates = if ($Pattern) { @($Subscriptions | Where-Object { $_.name -like $Pattern }) } else { @() }
  if ($candidates.Count -eq 1) {
    return (Select-Option -Title $Purpose -Options $candidates -Label $label `
        -AutoSelectSingle -AutoSelectNote "matched $Pattern")
  }

  $options = if ($candidates.Count -gt 1) { $candidates } else { $Subscriptions }
  return (Select-Option -Title $Purpose -Options $options -Label $label)
}

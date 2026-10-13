#requires -Version 7.0
<#
.SYNOPSIS
  Sets every GitHub-side variable and secret the deploy workflows need,
  idempotently — the GitHub counterpart to set-tfc-variables.ps1.

.DESCRIPTION
  The GitHub values arrive in two waves, and the script handles both:

    Wave 1 - known BEFORE the first terraform apply: tenant and application
             subscription. These two are inputs TO Terraform, not products of
             it, which is the test for belonging in this wave.
    Wave 2 - everything that is a Terraform output, read from the workspace's
             applied state via the HCP Terraform API (the same token
             set-tfc-variables.ps1 resolves): CLIENT_ID (client_id),
             READER_CLIENT_ID (reader_client_id),
             ALERT_READER_CLIENT_ID (alert_reader_client_id),
             MANIFEST_WINDOW_CLIENT_ID (manifest_window_client_id),
             COPILOT_REVIEW_CLIENT_ID (copilot_review_client_id),
             APP_HOSTNAME (function_hostname), FUNCTIONS_URL (api_base_url),
             FUNCTION_APP_NAME, RESOURCE_GROUP (web_resource_group),
             FUNCTIONS_STORAGE_ACCOUNT, STORAGE_ACCOUNT,
             STORAGE_RESOURCE_GROUP, and COSMOS_ENDPOINT (a variable — it is a
             public URL).
             RESOURCE_GROUP and FUNCTIONS_STORAGE_ACCOUNT
             are deliberately NOT wave-1 parameters even though their values
             are predictable from infra/ defaults: a hardcoded copy drifts
             silently when the code changes, an output cannot — and their
             only consumer (deploy-functions.yml) cannot run before the
             first apply anyway. "Re-run this script after any apply that
             changes outputs" is the entire wave-2 runbook.

  Before the first apply, wave 2 is reported as pending rather than failing:
  a workspace with no state is the expected starting condition, not an error.

  Deliberately NOT set here:

    AZURE_STATIC_WEB_APPS_API_TOKEN - the Variables-And-Secrets standard rules
             this a placement error as a stored secret: correct handling is
             fetching it at deploy time (az staticwebapp secrets list) after
             azure/login, storing nothing.
     COSMOS_KEY - must stay unset (T-504); provisioning it would switch
             clients onto a key path the account rejects.
    VITE_ENTRA_* - Entra app-registration values, produced by the manual
             registration step, not derivable from any state this script can
             reach.
     DOCKERHUB_* and the GitHub App - not used; all workflows run on
             GitHub-hosted runners.

  Idempotent: gh variable/secret set are upserts. Variable values are printed
  (they are public identifiers); secret values never are.

.PARAMETER Repository
  GitHub repository, owner/name. Default: saulpatinojr/HCW-HybridCloudWorks.

.PARAMETER Organization
  HCP Terraform organization, for the wave-2 state read. Read from
  infra/backend.tf when omitted.

.PARAMETER Workspace
  HCP Terraform workspace holding the state to read. Read from
  infra/backend.tf when omitted, so this cannot target a different workspace
  than Terraform writes to.

.PARAMETER TfcToken
  HCP Terraform API token as a SecureString, for reading state outputs. Omit
  it and the script reads $env:TFE_TOKEN, then the credentials file
  `terraform login` writes (%APPDATA%\terraform.d\ on Windows,
  ~/.terraform.d/ elsewhere), and skips wave 2 with a notice if neither exists.

.PARAMETER TenantId
  Entra tenant GUID. Becomes the TENANT_ID repository variable.

.PARAMETER SubscriptionApp
  Application landing zone subscription GUID (sub-app-site-prod-cus).
  Becomes SUBSCRIPTION_ID — the subscription azure/login targets, which is
  where the Function App lives.

.PARAMETER WhatIf
  Report what would be set without writing anything.

.EXAMPLE
  # Before the first apply — wave 1 lands, wave 2 reports pending.
  ./scripts/set-github-variables.ps1 `
      -TenantId 00000000-0000-0000-0000-000000000000 `
      -SubscriptionApp 00000000-0000-0000-0000-000000000000

.EXAMPLE
  # No arguments. The tenant and application subscription are read from the
  # Azure CLI sign-in; anything ambiguous is offered as a numbered list.
  ./scripts/set-github-variables.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $Repository = 'saulpatinojr/HCW-HybridCloudWorks',
  # Read from infra/backend.tf when omitted — one place names the workspace,
  # so the wave-2 state read cannot target a different one than Terraform uses.
  [string] $Organization,
  [string] $Workspace,
  [securestring] $TfcToken,

  # Optional. Omit them and they are discovered from the Azure CLI sign-in —
  # see lib/deploy-console.ps1 for why nothing here is a required flag.
  [string] $TenantId,
  [string] $SubscriptionApp
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/deploy-console.ps1')

# gh writes progress to stderr, which PowerShell 7 escalates under 'Stop'.
# Judge success by exit code, same pattern as Invoke-Az in the bootstrap.
function Invoke-Gh {
  param([Parameter(Mandatory)][string[]] $Arguments, [string] $StdIn, [switch] $AllowFailure)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($PSBoundParameters.ContainsKey('StdIn')) {
      $output = $StdIn | & gh @Arguments 2>&1
    } else {
      $output = & gh @Arguments 2>&1
    }
  } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) {
    if ($AllowFailure) { return $null }
    throw "gh $($Arguments -join ' ') failed:`n$output"
  }
  return ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
}

# Same resolution ladder as set-tfc-variables.ps1, with one difference: a
# missing token is not fatal here. Wave 1 needs no TFC access at all, so the
# script degrades to wave-1-only rather than stopping.
#
# ConvertTo-SecureString -AsPlainText is flagged by PSScriptAnalyzer as
# exposing secure information. It does not here: both sources are ALREADY
# plaintext — an environment variable and a file terraform login wrote in the
# clear. Converting adds protection downstream; refusing to read the stored
# token would push operators to paste it on a command line instead, which is
# strictly worse. Same accepted trade-off as set-tfc-variables.ps1.
function Resolve-TfcToken {
  param([securestring] $Supplied)
  if ($Supplied) { Write-Info 'TFC token: -TfcToken parameter'; return $Supplied }
  if ($env:TFE_TOKEN) {
    Write-Info 'TFC token: $env:TFE_TOKEN'
    return (ConvertTo-SecureString $env:TFE_TOKEN -AsPlainText -Force)
  }
  $stored = Get-StoredTfcToken
  if ($stored) {
    Write-Info "TFC token: $($stored.Path) (written by ``terraform login``)"
    return (ConvertTo-SecureString $stored.Token -AsPlainText -Force)
  }
  return $null
}

function Invoke-Tfc {
  param([Parameter(Mandatory)][string] $Path)
  return Invoke-RestMethod -Method GET -Uri "https://app.terraform.io/api/v2$Path" `
    -Headers @{ 'Content-Type' = 'application/vnd.api+json' } `
    -Authentication Bearer -Token $script:tfcToken
}

# ===========================================================================
# 1. Preflight
# ===========================================================================
Write-Step 'Preflight'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Stop-WithGuidance 'The GitHub CLI (gh) is not installed.' @(
    'Install it: https://cli.github.com', 'Then re-run this script.'
  )
}
Invoke-Gh @('auth', 'status') | Out-Null
Write-Ok 'gh authenticated'

Invoke-Gh @('repo', 'view', $Repository, '--json', 'nameWithOwner') | Out-Null
Write-Ok "Repository: $Repository"

# ForEach-Object rather than .name: the repository legitimately has no secrets
# at all today, and an empty result must read as "none" rather than throwing.
$existingVariables = @(Invoke-Gh @('variable', 'list', '-R', $Repository, '--json', 'name') |
    ConvertFrom-Json | ForEach-Object { $_.name })
$existingSecrets = @(Invoke-Gh @('secret', 'list', '-R', $Repository, '--json', 'name') |
    ConvertFrom-Json | ForEach-Object { $_.name })

# ===========================================================================
# 1b. Discover the two wave-1 values
# ===========================================================================
# Both come from the Azure CLI sign-in. Neither is prompted for as a GUID
# unless Azure cannot supply it, because a hand-typed subscription id is the
# defect this script exists to stop repeating.
if (-not $TenantId -or -not $SubscriptionApp) {
  Write-Step 'Discovering the tenant and application subscription'

  if (-not (Test-AzInstalled)) {
    Stop-WithGuidance 'The Azure CLI (az) is not installed, and no values were supplied.' @(
      'Either install it (https://learn.microsoft.com/cli/azure/install-azure-cli)',
      'and sign in, or pass -TenantId and -SubscriptionApp explicitly.'
    )
  }

  $account = Invoke-Az @('account', 'show', '-o', 'json') -AllowFailure
  if (-not $account) {
    Stop-WithGuidance 'Not signed in to Azure.' @(
      'Run: az login', 'Then re-run this script.'
    )
  }

  if (-not $TenantId) {
    $TenantId = $account.tenantId
    Write-Ok "Tenant: $TenantId  (from the current sign-in)"
  }

  if (-not $SubscriptionApp) {
    $subscriptions = Get-AzSubscriptionList
    if ($subscriptions.Count -eq 0) {
      Stop-WithGuidance 'The sign-in can see no enabled subscriptions.' @(
        'Check with: az account list --all -o table'
      )
    }
    # The application landing zone: where the Function App lives, and so the
    # subscription azure/login must target. NOT a platform subscription.
    $chosen = Select-Subscription -Purpose 'Application landing zone (SUBSCRIPTION_ID)' -Pattern 'sub-app-*' `
      -Subscriptions $subscriptions
    $SubscriptionApp = $chosen.id
  }
}

function Set-RepoVariable {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][string] $Value)
  $verb = if ($existingVariables -contains $Name) { 'update' } else { 'create' }
  if ($PSCmdlet.ShouldProcess("variable $Name = $Value", "$verb repository variable")) {
    Invoke-Gh @('variable', 'set', $Name, '-R', $Repository, '--body', $Value) | Out-Null
    Write-Act "$verb  $Name = $Value"
  } else {
    Write-Act "would $verb  $Name = $Value"
  }
}

# ===========================================================================
# 2. Wave 1 — known before the first apply
# ===========================================================================
$proceed = Confirm-Plan -Title 'About to write these repository variables' -Force:$WhatIfPreference -Order @(
  'Repository', 'TENANT_ID', 'SUBSCRIPTION_ID'
) -Values @{
  'Repository'      = $Repository
  'TENANT_ID'       = $TenantId
  'SUBSCRIPTION_ID' = $SubscriptionApp
}
if (-not $proceed) { Write-Info 'Cancelled — nothing was written.'; exit 0 }

Write-Step 'Wave 1: values known before the first apply'

Set-RepoVariable -Name 'TENANT_ID' -Value $TenantId
Set-RepoVariable -Name 'SUBSCRIPTION_ID' -Value $SubscriptionApp

# ===========================================================================
# 3. Wave 2 — Terraform outputs, via the workspace's current state
# ===========================================================================
Write-Step 'Wave 2: values from the Terraform outputs'

$script:tfcToken = Resolve-TfcToken -Supplied $TfcToken
$outputs = $null

if (-not $script:tfcToken) {
  Write-Info 'No HCP Terraform token found (TFE_TOKEN, credentials.tfrc.json).'
  Write-Info 'Skipping the state read — run `terraform login` and re-run this'
  Write-Info 'script after the first apply to seed CLIENT_ID, APP_HOSTNAME,'
  Write-Info 'FUNCTIONS_URL, FUNCTION_APP_NAME, RESOURCE_GROUP,'
  Write-Info 'FUNCTIONS_STORAGE_ACCOUNT, STORAGE_ACCOUNT, STORAGE_RESOURCE_GROUP,'
  Write-Info 'COSMOS_ENDPOINT.'
} else {
  if (-not $Organization -or -not $Workspace) {
    $backend = Get-BackendConfig -BackendPath (Join-Path $PSScriptRoot '../infra/backend.tf')
    if ($backend) {
      if (-not $Organization) { $Organization = $backend.Organization }
      if (-not $Workspace) { $Workspace = $backend.Workspace }
      Write-Info "From infra/backend.tf: $Organization/$Workspace"
    }
  }
  try {
    $workspaceId = (Invoke-Tfc "/organizations/$Organization/workspaces/$Workspace").data.id
    $state = Invoke-Tfc "/workspaces/$workspaceId/current-state-version?include=outputs"
    $outputs = @{}
    foreach ($item in $state.included) {
      if ($item.type -eq 'state-version-outputs') {
        $outputs[$item.attributes.name] = $item.attributes.value
      }
    }
    Write-Ok "State read: $($outputs.Count) outputs"
  } catch {
    # A workspace with no state yet returns 404 here. That is the expected
    # pre-first-apply condition, not a failure.
    Write-Info 'No state found in the workspace — expected before the first apply.'
    Write-Info 'Re-run this script after `terraform apply` succeeds; wave 2 will'
    Write-Info 'then find the outputs. Nothing to fix now.'
  }
}

if ($outputs) {
  $waveTwo = @(
    @{ output = 'client_id'; kind = 'variable'; name = 'CLIENT_ID'; transform = { param($v) $v } }
    # T-728: the read-only identity. monitor-functions-registered and
    # monitor-unresolved-secrets are gated on this variable being non-empty
    # and SKIP until it is set, so a missing READER_CLIENT_ID presents as
    # workflows quietly not running rather than as a failure. Seed it in the
    # same pass as CLIENT_ID. The two below are gated the same way.
    @{ output = 'reader_client_id'; kind = 'variable'; name = 'READER_CLIENT_ID'; transform = { param($v) $v } }
    # #1053: verify-alert-state's identity, alert rules and action groups only.
    @{ output = 'alert_reader_client_id'; kind = 'variable'; name = 'ALERT_READER_CLIENT_ID'; transform = { param($v) $v } }
    # #1098: publish-content-manifest's origin window, config write on the one
    # site and nothing else.
    @{ output = 'manifest_window_client_id'; kind = 'variable'; name = 'MANIFEST_WINDOW_CLIENT_ID'; transform = { param($v) $v } }
    # The identity Copilot code review signs in as (copilot-setup-steps.yml).
    # Reader on the four workload groups and nothing else; the login fails
    # closed while this is unset, so seed it in the same pass as the apply.
    @{ output = 'copilot_review_client_id'; kind = 'variable'; name = 'COPILOT_REVIEW_CLIENT_ID'; transform = { param($v) $v } }
    @{ output = 'function_hostname'; kind = 'variable'; name = 'APP_HOSTNAME'; transform = { param($v) $v } }
    # api_base_url, NOT function_hostname. This was built from the
    # azurewebsites.net origin until 2026-08-20, which stopped working the
    # moment functions_origin_lock_enabled came on: the origin refuses every
    # address that is not a Cloudflare range, so the browser and this
    # repository's own smoke test would both have taken a 403 that names
    # nothing. api_base_url is the proxied Cloudflare host and already carries
    # the /api prefix.
    #
    # The route prefix is load-bearing either way: a base without /api 404s
    # uniformly (VITE_AZURE_FUNCTIONS_URL, Required-Inputs §4.2).
    @{ output = 'api_base_url'; kind = 'variable'; name = 'FUNCTIONS_URL'; transform = { param($v) $v } }
    # The bare app name the deploy action targets. Hardcoded in the workflow
    # until 2026-08-20, where it went stale across a rename and would have
    # failed the first deploy with "app not found".
    @{ output = 'function_app_name'; kind = 'variable'; name = 'FUNCTION_APP_NAME'; transform = { param($v) $v } }
    @{ output = 'web_resource_group'; kind = 'variable'; name = 'RESOURCE_GROUP'; transform = { param($v) $v } }
    @{ output = 'functions_storage_account'; kind = 'variable'; name = 'FUNCTIONS_STORAGE_ACCOUNT'; transform = { param($v) $v } }
    # A VARIABLE, not a secret, as of 2026-08-20. It was seeded as a secret
    # until then, which was wrong twice over: the value is a public endpoint
    # URL and a non-sensitive Terraform output, and a secret cannot be read
    # back — so nobody could confirm which account a workflow was pointed at.
    # The old secret of the same name is removed below so the workflows'
    # `vars.COSMOS_ENDPOINT` reference cannot silently shadow it.
    @{ output = 'cosmos_endpoint'; kind = 'variable'; name = 'COSMOS_ENDPOINT'; transform = { param($v) $v } }
    # The Cosmos account's group, for the healer's ARM write (cp_sortDate is a
    # control-plane attribute; infra/oidc.tf). Pairs with COSMOS_ENDPOINT the
    # way STORAGE_RESOURCE_GROUP pairs with STORAGE_ACCOUNT.
    @{ output = 'cosmos_resource_group'; kind = 'variable'; name = 'COSMOS_RESOURCE_GROUP'; transform = { param($v) $v } }
    # The content storage account and its group. Distinct from
    # FUNCTIONS_STORAGE_ACCOUNT / RESOURCE_GROUP, which name the Functions host
    # account deploy-functions.yml opens a window on.
    @{ output = 'storage_account'; kind = 'variable'; name = 'STORAGE_ACCOUNT'; transform = { param($v) $v } }
    @{ output = 'storage_resource_group'; kind = 'variable'; name = 'STORAGE_RESOURCE_GROUP'; transform = { param($v) $v } }
  )
  foreach ($entry in $waveTwo) {
    $raw = $outputs[$entry.output]
    if ($null -eq $raw -or $raw -eq '') {
      Write-Info "Output '$($entry.output)' not present in state — $($entry.name) left unchanged."
      continue
    }
    $value = & $entry.transform $raw
    Set-RepoVariable -Name $entry.name -Value $value
  }

  # COSMOS_ENDPOINT was seeded as a SECRET until 2026-08-20 (see the wave-2
  # comment above). Remove the stale copy so `vars.COSMOS_ENDPOINT` is the
  # only spelling and nobody later "fixes" a workflow back to `secrets.`.
  if ($existingSecrets -contains 'COSMOS_ENDPOINT') {
    if ($PSCmdlet.ShouldProcess('secret COSMOS_ENDPOINT', 'delete the misplaced repository secret')) {
      Invoke-Gh @('secret', 'delete', 'COSMOS_ENDPOINT', '-R', $Repository) | Out-Null
      Write-Act 'delete  COSMOS_ENDPOINT secret (it is a variable now)'
    } else {
      Write-Act 'would delete  COSMOS_ENDPOINT secret (it is a variable now)'
    }
  }
}

# ===========================================================================
# 4. What this script deliberately leaves alone
# ===========================================================================
Write-Step 'Not set by this script'
Write-Info 'AZURE_STATIC_WEB_APPS_API_TOKEN - fetch at deploy time after azure/login'
Write-Info '                (az staticwebapp secrets list); storing it is the'
Write-Info '                placement error Variables-And-Secrets documents.'
Write-Info 'COSMOS_KEY    - must stay unset (Required-Inputs §4.3); both Cosmos accounts are keyless'
Write-Info '                and scripts/lib/cli.mjs refuses to start if it is set.'
Write-Info 'VITE_ENTRA_*  - from the manual Entra app registrations.'
Write-Info 'DOCKERHUB_*   - not used; all workflows run on GitHub-hosted runners.'

if ($WhatIfPreference) {
  Write-Host "`n  Dry run — nothing was written.`n" -ForegroundColor Green
} else {
  Write-Host "`n  Done.`n" -ForegroundColor Green
}

exit 0

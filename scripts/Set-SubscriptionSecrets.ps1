#requires -Version 7.0
<#
.SYNOPSIS
  Copies the subscription ids into repository SECRETS, so the public Actions
  logs show them as *** (#1610). Never prints a value.

.DESCRIPTION
  This repository is public, so its Actions logs are public. GitHub prints the
  values a step is given, and masks a value as *** only when it came from a
  secret. So the two subscription ids the workflows read, SUBSCRIPTION_ID
  (the Application subscription) and SUBSCRIPTION_MGMT_ID (the Management
  subscription), are kept as repository secrets, and every workflow reads
  secrets.SUBSCRIPTION_ID / secrets.SUBSCRIPTION_MGMT_ID.

  By default, for each name in -Names, the script reads the repository
  VARIABLE of that name with `gh variable get` and writes a repository SECRET
  of the same name with `gh secret set`. Use it while the variables still
  exist.

  With -FromPrompt it reads each value from a hidden prompt instead
  (Read-Host -AsSecureString), so it still works once the variables have been
  deleted: copy the id from the Azure portal's Subscriptions page and paste it
  at the prompt.

  The value is held in memory only as long as it takes to hand it to gh, and
  is never written to the screen, a file or the log. It is given to gh with
  --body, so it is on gh's command line on this computer for that moment.

  Exits 1 when a variable is missing or empty, when a prompt is left empty,
  or when a gh call fails; the message names the secret, never the value.

  Needs the GitHub CLI signed in as someone who can manage the repository's
  secrets (`gh auth status`).

.PARAMETER Repo
  The repository, owner/name. Default: saulpatinojr/HCW-HybridCloudWorks.

.PARAMETER Names
  The names to copy. Default: SUBSCRIPTION_ID and SUBSCRIPTION_MGMT_ID.

.PARAMETER FromPrompt
  Read each value from a hidden prompt instead of from the variable.

.EXAMPLE
  # Copy both variables into secrets of the same names.
  ./scripts/Set-SubscriptionSecrets.ps1

.EXAMPLE
  # See what would be done, without writing anything.
  ./scripts/Set-SubscriptionSecrets.ps1 -WhatIf

.EXAMPLE
  # After the variables are deleted: type the Management id at a hidden prompt.
  ./scripts/Set-SubscriptionSecrets.ps1 -Names SUBSCRIPTION_MGMT_ID -FromPrompt
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $Repo = 'saulpatinojr/HCW-HybridCloudWorks',
  [string[]] $Names = @('SUBSCRIPTION_ID', 'SUBSCRIPTION_MGMT_ID'),
  [switch] $FromPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The repository variable's value, trimmed, or '' when gh cannot read it
# (missing variable, no access). gh's own error text names the variable, not
# its value, so it is let through.
function Get-RepoVariableValue {
  param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][string] $Repository)
  $value = & gh variable get $Name -R $Repository
  if ($LASTEXITCODE -ne 0 -or $null -eq $value) { return '' }
  return ([string]::Join("`n", @($value))).Trim()
}

# A value typed at a hidden prompt, converted in memory, trimmed.
function Read-HiddenValue {
  param([Parameter(Mandatory)][string] $Name)
  $secure = Read-Host -AsSecureString -Prompt "Value for the $Name secret (hidden)"
  try {
    $plain = ConvertFrom-SecureString -SecureString $secure -AsPlainText
    if ($null -eq $plain) { return '' }
    return $plain.Trim()
  } finally {
    $secure.Dispose()
  }
}

# Writes one repository secret. Returns $true when gh succeeded.
function Set-RepoSecretValue {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][string] $Repository,
    [Parameter(Mandatory)][string] $Value
  )
  & gh secret set $Name -R $Repository --body $Value | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# The whole job, for each name: read the value, write the secret, forget the
# value. Emits one result per name it acted on: Name, Set ($true/$false) and
# Reason (empty when set). A value is never part of a result.
function Copy-SubscriptionSecret {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param(
    [Parameter(Mandatory)][string] $Repository,
    [Parameter(Mandatory)][string[]] $SecretNames,
    [switch] $Prompt
  )
  foreach ($n in $SecretNames) {
    $source = if ($Prompt) { 'the hidden prompt' } else { "the $n variable" }
    if (-not $PSCmdlet.ShouldProcess("secret $n in $Repository", "set from $source")) {
      continue
    }
    $v = if ($Prompt) { Read-HiddenValue -Name $n } else { Get-RepoVariableValue -Name $n -Repository $Repository }
    try {
      if (-not $v) {
        $why = if ($Prompt) { 'the prompt was left empty' } else { "the repository variable $n is missing or empty" }
        [pscustomobject]@{ Name = $n; Set = $false; Reason = $why }
      } elseif (Set-RepoSecretValue -Name $n -Repository $Repository -Value $v) {
        [pscustomobject]@{ Name = $n; Set = $true; Reason = '' }
      } else {
        [pscustomobject]@{ Name = $n; Set = $false; Reason = 'gh could not set it (its error is above)' }
      }
    } finally {
      $v = $null
    }
  }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error 'The GitHub CLI (gh) is not installed: https://cli.github.com/' -ErrorAction Continue
  exit 1
}
$results = @(Copy-SubscriptionSecret -Repository $Repo -SecretNames $Names -Prompt:$FromPrompt)
foreach ($result in $results) {
  if ($result.Set) {
    Write-Output "Set the repository secret $($result.Name) (value not shown)."
  } else {
    Write-Warning "Did not set the repository secret $($result.Name): $($result.Reason)."
  }
}
$failed = @($results | Where-Object { -not $_.Set }).Count
if ($failed -gt 0) {
  Write-Error "$failed of $($results.Count) secret(s) were not set." -ErrorAction Continue
  exit 1
}

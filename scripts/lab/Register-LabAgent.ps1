#Requires -Version 7.2
<#
.SYNOPSIS
    The lab agent's go-live in one run: its Entra identity, its four vault
    values on the host, and the bootstrap.sh run that starts it.

.DESCRIPTION
    Run it as the owner, from a desktop that reaches the lab host as hcw-lab
    (scripts/lab/Connect-Lab.ps1), with az signed in to the tenant. It:

      1. checks that az is signed in to -TenantDomain, and stops with the
         az login line when it is not;
      2. reads the agent's public certificate from the host over ssh into a
         temporary file. The private key beside it never leaves the host:
         the host only says whether the two match;
      3. finds or creates the agent's app registration and service principal
         (-DisplayName), appends the certificate to the registration unless it
         is already there, never replacing another credential, and assigns
         the one grant the API checks: the LabAgent app role on the API's
         service principal (functions/src/lib/auth/require-agent.js, gate 1).
         For an application permission that assignment is the admin consent;
      4. has the owner register the agent on the site, which writes the
         lab_agents/{agentId} document the API's second gate reads
         (POST cms/labs/agents, #740): it prints the Agents tab's address and
         the two values to paste into Register agent, the agent id and the
         service principal's object id, and waits for Enter. It skips this
         when the agent is already heartbeating and this run did not create
         its service principal, because then the document is there and binds
         it. The script cannot make that call itself: the route needs an
         admin's delegated token (scp access_as_admin), which the site's
         sign-in issues, and no owner script here acquires one
         (Get-LabRegistrationPrompt says why az cannot either);
      5. writes vault_labs_agent_api_base, vault_labs_agent_tenant_id,
         vault_labs_agent_client_id and vault_labs_agent_api_scope into
         /etc/hcw/ansible/vault.yml on the host, creating the file when it
         does not exist. The merge runs on the host as root: it decrypts to a
         root-only temporary file, replaces only those four keys, checks that
         every other key is unchanged, re-encrypts with the existing password
         file, and shreds the temporary files. It prints key names, never a
         value read from the file;
      6. runs bootstrap.sh when the vault changed or the agent is not running,
         or restarts the agent when only Entra or the registration changed,
         then reads `systemctl is-active hcw-labs-agent` and the agent's last
         journal lines and says what they mean.

    A second run changes nothing and says so. Under -WhatIf nothing changes:
    the Entra steps say what they would do, the registration step prints what
    it would ask for without waiting, the vault merge runs in check mode on
    the host, and bootstrap.sh does not run. No secret is involved: the
    certificate is public, the four vault values are identifiers, and the
    vault password stays on the host.

    The procedure around it is docs/runbooks/labs-host.md, "The lab agent's
    go-live".

.PARAMETER TenantDomain
    The Entra tenant az must be signed in to.

.PARAMETER ApiAppId
    The client id of the API app registration (HCWSite API), whose LabAgent
    app role the agent is assigned and whose api:// identifier is the scope.
    Leave it out and the script finds it: from the HCW_API_APP_ID
    environment variable when that is set, otherwise from the one
    registration named -ApiDisplayName in the tenant (Resolve-LabApiAppId).
    It used to be a parameter default, the same one
    scripts/cutover/01-entra-api.ps1 carried; the repository is public and a
    real application id does not go in a tracked file (#1540).

.PARAMETER ApiDisplayName
    The display name the lookup above searches for. HCWSite API.

.PARAMETER ApiBase
    LABS_AGENT_API_BASE: the Functions API base, including /api, as the host
    reaches it. The Cloudflare hostname, because the Function App's origin
    lock (functions_origin_lock_enabled, infra/functionapp.tf) refuses every
    address outside Cloudflare's ranges, and the lab host is outside them.

.PARAMETER DisplayName
    The agent's app registration and service principal. One per agent host.

.PARAMETER HostAlias
    The ssh name of the lab host, as scripts/lab/Connect-Lab.ps1 writes it.

.PARAMETER NextCertificate
    Certificate rotation (lab-host/README.md, "Rotating the agent
    certificate"): upload /etc/hcw/labs-agent.next.crt instead, then stop and
    print the swap line. The vault and bootstrap.sh are not touched.

.PARAMETER ForceBootstrap
    Run bootstrap.sh even when nothing changed and the agent is running.

.EXAMPLE
    ./scripts/lab/Register-LabAgent.ps1

.EXAMPLE
    ./scripts/lab/Register-LabAgent.ps1 -WhatIf

.EXAMPLE
    ./scripts/lab/Register-LabAgent.ps1 -NextCertificate
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('\A[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\z')]
    [string] $TenantDomain = 'saulpatinojrhotmail.onmicrosoft.com',

    [ValidatePattern('\A[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\z')]
    [string] $ApiAppId,

    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9 ()._-]{0,118}[A-Za-z0-9)]\z')]
    [string] $ApiDisplayName = 'HCWSite API',

    [ValidatePattern('\Ahttps://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/api\z')]
    [string] $ApiBase = 'https://api-azure.hybridcloudworks.com/api',

    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9-]{0,118}[A-Za-z0-9]\z')]
    [string] $DisplayName = 'sp-labs-agent-lab-hybrid-prod-cus-01',

    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9.-]{0,62}\z')]
    [string] $HostAlias = 'hcw-lab',

    [switch] $NextCertificate,

    [switch] $ForceBootstrap
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native exit codes are read explicitly below: az and ssh report failure by
# exit code, and `systemctl is-active` exits 3 for a stopped unit.
$PSNativeCommandUseErrorActionPreference = $false

# -----------------------------------------------------------------------------
# Functions. Everything above the "Main" line is a definition only, so the
# Pester tests can load these from the file's syntax tree without running the
# script: no az call, no ssh, nothing on the host.
# -----------------------------------------------------------------------------

function Test-LabGuid {
    <#
    .SYNOPSIS
        True for a GUID in its 8-4-4-4-12 form, and nothing else. \A and \z,
        because $ also matches before a trailing newline.
    #>
    [OutputType([bool])]
    param([AllowEmptyString()] [string] $Value)

    return $Value -match '\A[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\z'
}

function Test-LabApiBase {
    <#
    .SYNOPSIS
        True for an https URL of a bare host name ending in /api: what
        LABS_AGENT_API_BASE holds, and safe inside single quotes in bash.
    #>
    [OutputType([bool])]
    param([AllowEmptyString()] [string] $Value)

    return $Value -match '\Ahttps://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/api\z'
}

function Test-LabAgentId {
    <#
    .SYNOPSIS
        True for an agent id the way labs_agent_id and the certificate's CN
        spell it: lower-case letters, digits and hyphens.
    #>
    [OutputType([bool])]
    param([AllowEmptyString()] [string] $Value)

    return $Value -cmatch '\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z'
}

function Get-LabApiScope {
    <#
    .SYNOPSIS
        LABS_AGENT_API_SCOPE for an API client id: api://<id>/.default. The
        client-credentials grant asks for .default; the token's audience is
        then the API's client id, which is ENTRA_API_AUDIENCE, because the
        API registration issues v2 tokens.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $ApiAppId)

    if (-not (Test-LabGuid -Value $ApiAppId)) {
        throw "'$ApiAppId' is not a client id."
    }
    return 'api://' + $ApiAppId.ToLowerInvariant() + '/.default'
}

function Get-LabJobTypes {
    <#
    .SYNOPSIS
        The job types the agent is registered for: every type the server
        allowlists and the agent has a recipe for, which is what Register
        agent ticks by default and what the owner is asked to leave ticked.
        Kept in step with LAB_JOB_TYPES (functions/src/lib/labs.js) and
        CAPABILITIES (vps-agent/lib/capabilities.js) by
        scripts/lab-job-types.test.mjs.
    #>
    [OutputType([string[]])]
    param()

    return [string[]]@('shell-echo', 'terraform-validate', 'ansible-check', 'helm-template', 'kubeconform')
}

function Get-LabTenantIdFromIssuer {
    <#
    .SYNOPSIS
        The tenant id in a v2 OpenID issuer
        (https://login.microsoftonline.com/<tenant id>/v2.0), or $null.
    #>
    [OutputType([string])]
    param([AllowEmptyString()] [string] $Issuer)

    if ($Issuer -match '\Ahttps://login\.microsoftonline\.com/([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})/v2\.0/?\z') {
        return $Matches[1].ToLowerInvariant()
    }
    return $null
}

function Get-LabProperty {
    <#
    .SYNOPSIS
        A property of an object parsed from az's JSON, or $null when the
        object or the property is absent. Strict mode throws on a missing
        property, and az omits some keys rather than writing null.
    #>
    param(
        [AllowNull()] $Object,
        [Parameter(Mandatory)] [string] $Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-LabList {
    <#
    .SYNOPSIS
        A list-valued property as an array, empty when it is absent or null.
        Returned with the unary comma so that an empty or one-item list stays
        an array for the caller.
    #>
    param(
        [AllowNull()] $Object,
        [Parameter(Mandatory)] [string] $Name
    )

    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($item in @(Get-LabProperty -Object $Object -Name $Name)) {
        if ($null -ne $item) {
            $items.Add($item)
        }
    }
    return , $items.ToArray()
}

function ConvertFrom-LabCertificateOutput {
    <#
    .SYNOPSIS
        Splits what the certificate read printed into the one PEM certificate,
        whether the host's private key matches it, and the SHA-1 fingerprint
        of a pending next certificate, if one exists.

    .DESCRIPTION
        Refuses anything that is not exactly one certificate, and refuses
        outright, without repeating it, any text that holds private key
        material: that would mean the wrong file was read, and nothing is to
        be written or uploaded from it.
    #>
    [OutputType([pscustomobject])]
    param([AllowEmptyCollection()] [AllowNull()] [string[]] $Lines)

    $text = (@($Lines) -join "`n")
    if ($text -match 'PRIVATE KEY') {
        throw 'The host returned private key material where the public certificate was expected. Nothing was written or uploaded.'
    }
    $begins = [regex]::Matches($text, '-----BEGIN CERTIFICATE-----').Count
    $ends = [regex]::Matches($text, '-----END CERTIFICATE-----').Count
    if ($begins -ne 1 -or $ends -ne 1) {
        throw "Expected exactly one certificate from the host and found $begins."
    }
    $pem = [regex]::Match($text, '-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]*?-----END CERTIFICATE-----').Value
    if (-not $pem) {
        throw 'The certificate the host returned is not PEM text.'
    }

    $keyMatches = 'unknown'
    $next = $null
    foreach ($line in @($Lines)) {
        if ($line -match '\AHCW KEY-MATCH (\S+)\s*\z') {
            $keyMatches = $Matches[1]
        }
        elseif ($line -match '\AHCW NEXT-FINGERPRINT (?:SHA1 Fingerprint=)?([0-9A-Fa-f:]+)\s*\z') {
            $next = ($Matches[1] -replace ':', '').ToUpperInvariant()
        }
    }
    return [pscustomobject]@{
        Pem             = ($pem -replace "`r`n", "`n")
        KeyMatches      = $keyMatches
        NextThumbprint  = $next
    }
}

function Get-LabCertificateInfo {
    <#
    .SYNOPSIS
        Thumbprint (SHA-1, upper-case hex, which is what Entra records as the
        credential's customKeyIdentifier), validity and common name of a PEM
        certificate.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string] $Pem)

    $match = [regex]::Match($Pem, '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----')
    if (-not $match.Success) {
        throw 'The text is not a PEM certificate.'
    }
    $bytes = [Convert]::FromBase64String(($match.Groups[1].Value -replace '\s', ''))
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
    try {
        return [pscustomobject]@{
            Thumbprint   = $certificate.Thumbprint.ToUpperInvariant()
            NotBeforeUtc = $certificate.NotBefore.ToUniversalTime()
            NotAfterUtc  = $certificate.NotAfter.ToUniversalTime()
            Subject      = $certificate.Subject
            CommonName   = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        }
    }
    finally {
        $certificate.Dispose()
    }
}

function ConvertTo-LabThumbprint {
    <#
    .SYNOPSIS
        A key credential's customKeyIdentifier as upper-case hex, or $null.

    .DESCRIPTION
        Graph types the field as binary, and what az hands back for a
        certificate has been seen in more than one spelling, so all three are
        read: the 40 hex digits of the thumbprint, the base64 of its 20 bytes,
        and the base64 of the 40 hex digits as text.
    #>
    [OutputType([string])]
    param([AllowNull()] [AllowEmptyString()] [string] $CustomKeyIdentifier)

    if ([string]::IsNullOrWhiteSpace($CustomKeyIdentifier)) {
        return $null
    }
    $value = $CustomKeyIdentifier.Trim()
    if ($value -match '\A[0-9A-Fa-f]{40}\z') {
        return $value.ToUpperInvariant()
    }
    try {
        $bytes = [Convert]::FromBase64String($value)
    }
    catch {
        return $null
    }
    if ($bytes.Length -eq 20) {
        return ([System.BitConverter]::ToString($bytes) -replace '-', '')
    }
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    if ($text -match '\A[0-9A-Fa-f]{40}\z') {
        return $text.ToUpperInvariant()
    }
    return $null
}

function Test-LabKeyCredentialPresent {
    <#
    .SYNOPSIS
        True when one of the registration's key credentials is the
        certificate with this thumbprint.
    #>
    [OutputType([bool])]
    param(
        [AllowNull()] [AllowEmptyCollection()] [object[]] $RegisteredKeys,
        [Parameter(Mandatory)] [string] $Thumbprint
    )

    $wanted = $Thumbprint.ToUpperInvariant()
    foreach ($credential in @($RegisteredKeys)) {
        if ($null -eq $credential) {
            continue
        }
        $identifier = ConvertTo-LabThumbprint -CustomKeyIdentifier ([string](Get-LabProperty -Object $credential -Name 'customKeyIdentifier'))
        if ($identifier -and $identifier -ceq $wanted) {
            return $true
        }
    }
    return $false
}

function Get-LabKeyCredentialEndDate {
    <#
    .SYNOPSIS
        --end-date for the upload: one second before the certificate expires.

    .DESCRIPTION
        Without --end-date, az ends a certificate credential one year from
        now, and the agent would stop authenticating a year before the
        730-day certificate expires and before the play's expiry warning
        (labs_agent_certificate_warn_days) fires. One second before expiry
        is what az itself chooses when the date asked for is later than the
        certificate allows.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [datetime] $NotAfterUtc)

    return $NotAfterUtc.ToUniversalTime().AddSeconds(-1).ToString("yyyy-MM-dd'T'HH:mm:ss'+00:00'", [cultureinfo]::InvariantCulture)
}

function Get-LabCredentialResetArguments {
    <#
    .SYNOPSIS
        The az arguments that add the certificate to the registration.

    .DESCRIPTION
        --append is the load-bearing flag. Without it `az ad app credential
        reset` deletes every existing password and certificate on the
        registration first, which during a rotation is the certificate the
        agent is still using. --cert with a file keeps az from generating a
        password, so nothing it returns is a secret, and -o none prints
        nothing anyway.
    #>
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string] $AppId,
        [Parameter(Mandatory)] [string] $CertificateFile,
        [Parameter(Mandatory)] [string] $EndDate,
        [Parameter(Mandatory)] [string] $KeyDisplayName
    )

    return [string[]]@(
        'ad', 'app', 'credential', 'reset',
        '--id', $AppId,
        '--cert', ('@' + $CertificateFile),
        '--append',
        '--end-date', $EndDate,
        '--display-name', $KeyDisplayName,
        '-o', 'none'
    )
}

function Get-LabRegistrationPrompt {
    <#
    .SYNOPSIS
        The lines that ask the owner to register the agent on the site: the
        Agents tab's address, the two values to paste into Register agent,
        and what success looks like there.

    .DESCRIPTION
        Register agent calls POST cms/labs/agents
        (functions/src/lib/labs/agent-registry.js), which writes the
        lab_agents/{agentId} document gate 2 of the agent guard reads: the
        agent id, its service principal's object id (the oid claim of its
        app-only token), active, and the job types it may claim. The object
        id is printed in lower case, as the token carries it; the API stores
        it that way whatever is pasted.

        This script does not call the route itself. It needs an admin's
        delegated token with the access_as_admin scope, which the site's own
        sign-in issues. No owner script in this repository acquires one, and
        az cannot without a consent nothing here grants: the API registration
        (New-EntraApiRegistration, scripts/lib/deploy-console.ps1)
        pre-authorizes no client, so Azure CLI would first have to be
        consented to access_as_admin. So the one step is a paste in the
        browser, and the run waits for it.
    #>
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string] $Url,
        [Parameter(Mandatory)] [string] $AgentId,
        [Parameter(Mandatory)] [string] $ObjectId,
        [Parameter(Mandatory)] [string[]] $JobTypes
    )

    if (-not (Test-LabAgentId -Value $AgentId)) {
        throw "'$AgentId' is not an agent id."
    }
    if (-not (Test-LabGuid -Value $ObjectId)) {
        throw "'$ObjectId' is not an object id."
    }
    return [string[]]@(
        "Registry: the API admits the agent only once lab_agents/$AgentId binds it to this service principal. Register it on the site: in a browser signed in as an admin, open",
        '',
        "  $Url",
        '',
        'and under Register agent paste:',
        '',
        "  Agent id:   $AgentId",
        "  Object id:  $($ObjectId.ToLowerInvariant())",
        '',
        "Leave every job type ticked ($($JobTypes -join ', ')) and press Register agent. Success is a toast reading ""Agent registered"" (or ""Already registered"") and a $AgentId card on that page. If the card says Deactivated, press Activate on it."
    )
}

function Test-LabRegistrationNeeded {
    <#
    .SYNOPSIS
        False only when the registration is already proven: the agent is
        heartbeating, which passes gate 2, and its service principal is the
        one it was registered with because this run did not create it.
    #>
    [OutputType([bool])]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $VerdictState,
        [switch] $ServicePrincipalCreated
    )

    return -not ($VerdictState -eq 'Healthy' -and -not $ServicePrincipalCreated)
}

function Read-LabEnter {
    <#
    .SYNOPSIS
        Waits for Enter. The seam the tests mock.
    #>
    param([Parameter(Mandatory)] [string] $Prompt)

    return Read-Host -Prompt $Prompt
}

function Wait-LabRegistration {
    <#
    .SYNOPSIS
        Prints the registration lines and waits for Enter before the run
        goes on to the vault and bootstrap.sh.
    #>
    param([Parameter(Mandatory)] [AllowEmptyString()] [string[]] $Lines)

    foreach ($line in $Lines) {
        Write-Host $line
    }
    Write-Host ''
    $null = Read-LabEnter -Prompt 'Press Enter once the page shows the agent registered'
}

function Get-LabVaultValues {
    <#
    .SYNOPSIS
        The four vault keys and their values, in the order they are written,
        each checked against the only shape it may have.
    #>
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)] [string] $ApiBase,
        [Parameter(Mandatory)] [string] $TenantId,
        [Parameter(Mandatory)] [string] $ClientId,
        [Parameter(Mandatory)] [string] $ApiScope
    )

    if (-not (Test-LabApiBase -Value $ApiBase)) {
        throw "'$ApiBase' is not an https API base ending in /api."
    }
    foreach ($pair in @(@('tenant id', $TenantId), @('client id', $ClientId))) {
        if (-not (Test-LabGuid -Value $pair[1])) {
            throw "The $($pair[0]) '$($pair[1])' is not a GUID."
        }
    }
    if ($ApiScope -notmatch '\Aapi://[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}/\.default\z') {
        throw "'$ApiScope' is not an api://<client id>/.default scope."
    }
    return [ordered]@{
        vault_labs_agent_api_base  = $ApiBase
        vault_labs_agent_tenant_id = $TenantId.ToLowerInvariant()
        vault_labs_agent_client_id = $ClientId.ToLowerInvariant()
        vault_labs_agent_api_scope = $ApiScope
    }
}

function Get-LabRemoteCommand {
    <#
    .SYNOPSIS
        One ssh command line that runs BashScript as root on the host.

    .DESCRIPTION
        The script travels as base64, so the command line holds only
        [A-Za-z0-9+/=], which neither PowerShell's argument passing, ssh, nor
        the remote login shell can reinterpret. bash reads it from the pipe,
        so every command inside that could read standard input is given
        /dev/null instead.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $BashScript)

    $normalized = $BashScript -replace "`r`n", "`n"
    $encoded = [Convert]::ToBase64String([System.Text.UTF8Encoding]::new($false).GetBytes($normalized))
    return "echo $encoded | base64 -d | sudo bash -s"
}

function Assert-LabShellValue {
    <#
    .SYNOPSIS
        Throws unless Value can sit between single quotes in bash and mean
        itself: no quote, backslash, dollar, backtick, space or newline.
    #>
    param(
        [Parameter(Mandatory)] [string] $Name,
        [AllowEmptyString()] [string] $Value
    )

    if ($Value -notmatch '\A[A-Za-z0-9._:/@%+=,-]*\z') {
        throw "$Name holds a character that is not safe in the host script: '$Value'."
    }
}

function Get-LabCertificateReadScript {
    <#
    .SYNOPSIS
        The bash that prints the public certificate, whether the private key
        beside it matches it, and the fingerprint of a pending next
        certificate. The private key is read only by openssl, on the host.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $CertificatePath,
        [Parameter(Mandatory)] [string] $KeyPath,
        [AllowEmptyString()] [string] $NextCertificatePath = ''
    )

    Assert-LabShellValue -Name 'CertificatePath' -Value $CertificatePath
    Assert-LabShellValue -Name 'KeyPath' -Value $KeyPath
    Assert-LabShellValue -Name 'NextCertificatePath' -Value $NextCertificatePath

    $template = @'
set -u
crt='@@HCW_CERTIFICATE@@'
pem='@@HCW_KEY@@'
next='@@HCW_NEXT@@'
if [ ! -f "$crt" ]; then
  echo "HCW ERROR no-certificate $crt does not exist on this host; bootstrap.sh generates it (lab-host/README.md, The agent identity)"
  exit 3
fi
if grep -q 'PRIVATE KEY' "$crt" < /dev/null; then
  echo "HCW ERROR not-public $crt holds private key material; nothing was read"
  exit 3
fi
cat -- "$crt" < /dev/null
public_crt="$(openssl x509 -in "$crt" -noout -pubkey < /dev/null 2> /dev/null)" || public_crt=''
if [ ! -f "$pem" ]; then
  echo 'HCW KEY-MATCH missing'
else
  public_key="$(openssl pkey -in "$pem" -pubout < /dev/null 2> /dev/null)" || public_key=''
  if [ -n "$public_crt" ] && [ "$public_crt" = "$public_key" ]; then
    echo 'HCW KEY-MATCH yes'
  else
    echo 'HCW KEY-MATCH no'
  fi
fi
if [ -n "$next" ] && [ -f "$next" ]; then
  fingerprint="$(openssl x509 -in "$next" -noout -fingerprint -sha1 < /dev/null 2> /dev/null)" || fingerprint=''
  [ -z "$fingerprint" ] || echo "HCW NEXT-FINGERPRINT $fingerprint"
fi
exit 0
'@
    $text = $template.Replace('@@HCW_CERTIFICATE@@', $CertificatePath)
    $text = $text.Replace('@@HCW_KEY@@', $KeyPath)
    $text = $text.Replace('@@HCW_NEXT@@', $NextCertificatePath)
    return ($text -replace "`r`n", "`n")
}

function Get-LabVaultScript {
    <#
    .SYNOPSIS
        The bash, run as root on the host, that probes the API from the host
        and merges the four keys into the Ansible vault.

    .DESCRIPTION
        What it prints is only ever these lines, and none carries a value
        read from the vault:

          HCW PROBE <status> <content type>   the host's POST to agent/heartbeat
          HCW PROBE-MITIGATED <value>         Cloudflare's cf-mitigated header
          HCW VAULT <state> added=.. updated=.. unchanged=..
          HCW ERROR <code> <message>

        <state> is created, updated, unchanged, would-be-created or
        would-be-updated (the last two in check mode, which writes nothing).

        The merge: decrypt vault.yml (when it exists) to a root-only
        temporary directory, on tmpfs when /dev/shm is there; in Python,
        drop the four keys this script owns (with any indented continuation
        lines) and append them, then parse the result and refuse it unless
        the four keys hold exactly the new values and every other key equals
        what it was; encrypt with the existing password file, decrypt that
        again and compare, and only then replace vault.yml, by rename. When
        nothing would change, nothing is written, so a re-run leaves the
        ciphertext byte for byte as it was. The temporary files are shredded
        on every exit.

        Python is the ansible-core environment's own, found beside
        ansible-vault, because it has PyYAML; -Python overrides it for tests.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Values,
        [ValidateSet('apply', 'check')] [string] $Mode = 'apply',
        [Parameter(Mandatory)] [string] $ProbeUrl,
        [string] $VaultDirectory = '/etc/hcw/ansible',
        [string] $AnsibleVault = '/usr/local/bin/ansible-vault',
        [AllowEmptyString()] [string] $Python = ''
    )

    $keys = @('vault_labs_agent_api_base', 'vault_labs_agent_tenant_id', 'vault_labs_agent_client_id', 'vault_labs_agent_api_scope')
    foreach ($key in $keys) {
        if (-not $Values.Contains($key)) {
            throw "Values has no $key."
        }
        Assert-LabShellValue -Name $key -Value ([string]$Values[$key])
    }
    Assert-LabShellValue -Name 'ProbeUrl' -Value $ProbeUrl
    Assert-LabShellValue -Name 'VaultDirectory' -Value $VaultDirectory
    Assert-LabShellValue -Name 'AnsibleVault' -Value $AnsibleVault
    Assert-LabShellValue -Name 'Python' -Value $Python

    $template = @'
set -euo pipefail
umask 077
cd /
mode='@@HCW_MODE@@'
dir='@@HCW_VAULT_DIR@@'
av='@@HCW_ANSIBLE_VAULT@@'
py='@@HCW_PYTHON@@'
probe_url='@@HCW_PROBE_URL@@'
vault="$dir/vault.yml"
password="$dir/vault-password"
say() { printf 'HCW %s\n' "$*"; }
fail() { say "ERROR $1 $2"; exit 3; }

headers="$(mktemp)"
probe="$(curl -sS -o /dev/null -D "$headers" -w '%{http_code} %{content_type}' --max-time 20 -X POST -H 'Content-Type: application/json' --data '{}' "$probe_url" < /dev/null 2> /dev/null)" || true
say "PROBE ${probe:-000}"
mitigated="$(grep -i '^cf-mitigated:' "$headers" | head -n 1 | cut -d: -f2- | tr -d ' \r\n')" || mitigated=''
[ -z "$mitigated" ] || say "PROBE-MITIGATED $mitigated"
rm -f "$headers"

[ -x "$av" ] || fail no-ansible-vault "$av is missing; bootstrap.sh installs it (lab-host/README.md, First run)"
if [ -z "$py" ]; then
  py="$(dirname "$(readlink -f "$av")")/python"
fi
command -v "$py" > /dev/null 2>&1 || fail no-python "$py is missing; it is the ansible-core environment's interpreter, which bootstrap.sh installs"
"$py" -c 'import yaml' < /dev/null > /dev/null 2>&1 || fail no-yaml "$py cannot import yaml"
[ -f "$password" ] || fail no-password "$password does not exist; create it first (lab-host/README.md, The vault)"

work="$(mktemp -d /dev/shm/hcw-vault.XXXXXX 2> /dev/null || mktemp -d)"
cleanup() {
  find "$work" -type f -exec shred -u {} + 2> /dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if [ -f "$vault" ]; then
  existed=1
  "$av" decrypt --vault-password-file "$password" --output "$work/current.yml" "$vault" < /dev/null > "$work/vault.log" 2>&1 \
    || fail decrypt "ansible-vault could not decrypt $vault with $password; nothing was changed"
else
  existed=0
  : > "$work/current.yml"
fi

cat > "$work/merge.py" <<'PY'
import os
import re
import sys

import yaml

KEYS = (
    'vault_labs_agent_api_base',
    'vault_labs_agent_tenant_id',
    'vault_labs_agent_client_id',
    'vault_labs_agent_api_scope',
)
MARK = '# vault_labs_agent_*: written by scripts/lab/Register-LabAgent.ps1'


class Loader(yaml.SafeLoader):
    pass


def tagged(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return ('!' + suffix, loader.construct_scalar(node))
    if isinstance(node, yaml.SequenceNode):
        return ('!' + suffix, repr(loader.construct_sequence(node, deep=True)))
    return ('!' + suffix, repr(loader.construct_mapping(node, deep=True)))


Loader.add_multi_constructor('!', tagged)


def fail(code, message):
    print('HCW ERROR %s %s' % (code, message))
    sys.exit(3)


def load(text, what):
    try:
        data = yaml.load(text, Loader=Loader) if text.strip() else {}
    except yaml.YAMLError:
        fail('not-yaml', '%s does not parse as YAML; nothing was changed' % what)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        fail('not-a-mapping', '%s is not a mapping of keys; nothing was changed' % what)
    return data


def quote(value):
    return "'" + value.replace("'", "''") + "'"


def main(source, target):
    want = {key: os.environ['HCW_' + key.upper()] for key in KEYS}
    with open(source, 'rb') as handle:
        raw = handle.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        fail('not-utf8', 'the vault is not UTF-8 text; nothing was changed')
    before = load(text, 'the vault')
    added = [key for key in KEYS if key not in before]
    updated = [key for key in KEYS if key in before and before[key] != want[key]]
    same = [key for key in KEYS if key in before and before[key] == want[key]]
    if not added and not updated:
        print('HCW MERGE unchanged added= updated= unchanged=%s' % ','.join(same))
        return
    owned = re.compile(r'^(?:%s)\s*:' % '|'.join(KEYS))
    kept = []
    dropping = False
    for line in text.splitlines(keepends=True):
        bare = line.rstrip('\r\n')
        if owned.match(bare):
            dropping = True
            continue
        if dropping and bare[:1] in (' ', '\t'):
            continue
        dropping = False
        if bare == MARK:
            continue
        kept.append(line)
    body = ''.join(kept)
    if body and not body.endswith('\n'):
        body += '\n'
    block = [MARK] + ['%s: %s' % (key, quote(want[key])) for key in KEYS]
    result = body + '\n'.join(block) + '\n'
    after = load(result, 'the merged vault')
    for key in KEYS:
        if after.get(key) != want[key]:
            fail('verify', 'the merged vault would not hold %s as intended; nothing was changed' % key)
    kept_before = {key: value for key, value in before.items() if key not in KEYS}
    kept_after = {key: value for key, value in after.items() if key not in KEYS}
    if kept_before != kept_after:
        fail('verify', 'the merge would change a key this script does not own; nothing was changed')
    with open(target, 'wb') as handle:
        handle.write(result.encode('utf-8'))
    print('HCW MERGE changed added=%s updated=%s unchanged=%s' % (','.join(added), ','.join(updated), ','.join(same)))


main(sys.argv[1], sys.argv[2])
PY

HCW_VAULT_LABS_AGENT_API_BASE='@@HCW_API_BASE@@' \
HCW_VAULT_LABS_AGENT_TENANT_ID='@@HCW_TENANT_ID@@' \
HCW_VAULT_LABS_AGENT_CLIENT_ID='@@HCW_CLIENT_ID@@' \
HCW_VAULT_LABS_AGENT_API_SCOPE='@@HCW_API_SCOPE@@' \
  "$py" "$work/merge.py" "$work/current.yml" "$work/next.yml" < /dev/null > "$work/merge.out" 2> "$work/merge.err" \
  || { grep '^HCW ERROR ' "$work/merge.out" || say "ERROR merge the merge stopped unexpectedly; nothing was changed"; exit 3; }
merge_line="$(grep '^HCW MERGE ' "$work/merge.out" | tail -n 1)" || merge_line=''
[ -n "$merge_line" ] || fail merge "the merge printed no result; nothing was changed"
state="$(printf '%s' "$merge_line" | cut -d ' ' -f 3)"
detail="$(printf '%s' "$merge_line" | cut -d ' ' -f 4-)"

if [ "$state" = unchanged ]; then
  say "VAULT unchanged $detail"
  exit 0
fi
if [ "$existed" = 1 ]; then verb=updated; else verb=created; fi
if [ "$mode" = check ]; then
  say "VAULT would-be-$verb $detail"
  exit 0
fi
"$av" encrypt --vault-password-file "$password" --output "$work/next.enc" "$work/next.yml" < /dev/null > "$work/vault.log" 2>&1 \
  || fail encrypt "ansible-vault could not encrypt the merged vault; nothing was changed"
"$av" decrypt --vault-password-file "$password" --output "$work/check.yml" "$work/next.enc" < /dev/null > "$work/vault.log" 2>&1 \
  || fail verify "the re-encrypted vault does not decrypt; nothing was changed"
cmp -s "$work/check.yml" "$work/next.yml" || fail verify "the re-encrypted vault does not decrypt to the merge; nothing was changed"
install -m 0600 "$work/next.enc" "$dir/.vault.yml.next"
mv -f "$dir/.vault.yml.next" "$vault"
say "VAULT $verb $detail"
'@
    $tokens = [ordered]@{
        '@@HCW_MODE@@'          = $Mode
        '@@HCW_VAULT_DIR@@'     = $VaultDirectory
        '@@HCW_ANSIBLE_VAULT@@' = $AnsibleVault
        '@@HCW_PYTHON@@'        = $Python
        '@@HCW_PROBE_URL@@'     = $ProbeUrl
        '@@HCW_API_BASE@@'      = [string]$Values['vault_labs_agent_api_base']
        '@@HCW_TENANT_ID@@'     = [string]$Values['vault_labs_agent_tenant_id']
        '@@HCW_CLIENT_ID@@'     = [string]$Values['vault_labs_agent_client_id']
        '@@HCW_API_SCOPE@@'     = [string]$Values['vault_labs_agent_api_scope']
    }
    $text = $template
    foreach ($token in $tokens.Keys) {
        $text = $text.Replace([string]$token, [string]$tokens[$token])
    }
    $text = $text -replace "`r`n", "`n"
    if ($text.Contains('@@HCW_')) {
        throw 'A placeholder in the host script was not filled in.'
    }
    return $text
}

function Get-LabAgentStatusScript {
    <#
    .SYNOPSIS
        The bash that prints the unit's state and its last journal lines,
        each prefixed so they can be told from anything else ssh prints.
    #>
    [OutputType([string])]
    param()

    return @'
set -u
state="$(systemctl is-active hcw-labs-agent < /dev/null 2> /dev/null)" || true
printf 'HCW ACTIVE %s\n' "${state:-unknown}"
journalctl -u hcw-labs-agent -n 40 --no-pager -o short-iso < /dev/null 2>&1 | sed 's/^/HCW LOG /'
exit 0
'@ -replace "`r`n", "`n"
}

function ConvertFrom-LabVaultOutput {
    <#
    .SYNOPSIS
        Reads the HCW lines the vault script printed.
    #>
    [OutputType([pscustomobject])]
    param([AllowEmptyCollection()] [AllowNull()] [string[]] $Lines)

    $result = [ordered]@{
        ProbeStatus      = $null
        ProbeContentType = ''
        ProbeMitigated   = ''
        VaultState       = $null
        Added            = [string[]]@()
        Updated          = [string[]]@()
        Unchanged        = [string[]]@()
        ErrorCode        = $null
        ErrorMessage     = $null
    }
    foreach ($line in @($Lines)) {
        if ($null -eq $line) {
            continue
        }
        if ($line -match '\AHCW PROBE (\d{3})(?: (.*))?\z') {
            $result.ProbeStatus = $Matches[1]
            $result.ProbeContentType = ([string]$Matches[2]).Trim()
        }
        elseif ($line -match '\AHCW PROBE-MITIGATED (\S+)') {
            $result.ProbeMitigated = $Matches[1]
        }
        elseif ($line -match '\AHCW VAULT (\S+)(.*)\z') {
            $result.VaultState = $Matches[1]
            $rest = $Matches[2]
            $fields = [ordered]@{ added = 'Added'; updated = 'Updated'; unchanged = 'Unchanged' }
            foreach ($field in $fields.Keys) {
                if ($rest -match ('(?:\A|\s)' + $field + '=(\S*)')) {
                    $result[$fields[$field]] = [string[]]@($Matches[1] -split ',' | Where-Object { $_ })
                }
            }
        }
        elseif ($line -match '\AHCW ERROR (\S+) ?(.*)\z') {
            $result.ErrorCode = $Matches[1]
            $result.ErrorMessage = $Matches[2]
        }
    }
    return [pscustomobject]@{
        ProbeStatus      = $result.ProbeStatus
        ProbeContentType = $result.ProbeContentType
        ProbeMitigated   = $result.ProbeMitigated
        VaultState       = $result.VaultState
        Added            = [string[]]$result.Added
        Updated          = [string[]]$result.Updated
        Unchanged        = [string[]]$result.Unchanged
        ErrorCode        = $result.ErrorCode
        ErrorMessage     = $result.ErrorMessage
    }
}

function ConvertFrom-LabStatusOutput {
    <#
    .SYNOPSIS
        The unit's state and its journal lines from what the status script
        printed.
    #>
    [OutputType([pscustomobject])]
    param([AllowEmptyCollection()] [AllowNull()] [string[]] $Lines)

    $active = 'unknown'
    $journal = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @($Lines)) {
        if ($null -eq $line) {
            continue
        }
        if ($line -match '\AHCW ACTIVE (\S+)') {
            $active = $Matches[1]
        }
        elseif ($line.StartsWith('HCW LOG ', [System.StringComparison]::Ordinal)) {
            $journal.Add($line.Substring(8))
        }
    }
    return [pscustomobject]@{ Active = $active; Journal = [string[]]$journal.ToArray() }
}

function Read-LabAgentStatus {
    <#
    .SYNOPSIS
        The agent unit's state and journal, read on the host.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string] $HostAlias)

    $run = Invoke-LabSsh -HostAlias $HostAlias -Command (Get-LabRemoteCommand -BashScript (Get-LabAgentStatusScript))
    if ($run.ExitCode -ne 0) {
        throw "Reading hcw-labs-agent's state on $HostAlias failed (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
    }
    return ConvertFrom-LabStatusOutput -Lines $run.Lines
}

function Get-LabProbeVerdict {
    <#
    .SYNOPSIS
        What the host's unauthenticated POST to agent/heartbeat says about
        the path the agent will take.

    .DESCRIPTION
        Without a token the API answers 401 with its own JSON body, so that
        answer proves the host reaches the route through Cloudflare and the
        origin lock. A Cloudflare challenge answers 403 with an HTML page
        and, usually, a cf-mitigated header: that is Cloudflare refusing the
        host, which the agent would report only as "HTTP 403".
    #>
    [OutputType([pscustomobject])]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $Status,
        [AllowNull()] [AllowEmptyString()] [string] $ContentType,
        [AllowNull()] [AllowEmptyString()] [string] $Mitigated
    )

    if ($Mitigated) {
        return [pscustomobject]@{ State = 'Challenged'; Message = "Cloudflare answered with a challenge (cf-mitigated: $Mitigated), not the API. The agent cannot reach the API from this host until the zone admits it; see docs/runbooks/labs-host.md, ""The lab agent's go-live""." }
    }
    switch -Regex ($Status) {
        '\A401\z' {
            if ($ContentType -match 'json') {
                return [pscustomobject]@{ State = 'Reachable'; Message = 'The API answered 401 without a token, as it should: the host reaches agent/heartbeat through Cloudflare.' }
            }
            return [pscustomobject]@{ State = 'Unexpected'; Message = "401 with $ContentType, not the API's JSON." }
        }
        '\A403\z' {
            if ($ContentType -match 'html') {
                return [pscustomobject]@{ State = 'Challenged'; Message = "Cloudflare answered 403 with an HTML page, not the API: most likely Bot Fight Mode, which challenges clients on hosting networks. The agent cannot reach the API from this host until the zone admits it; see docs/runbooks/labs-host.md, ""The lab agent's go-live""." }
            }
            return [pscustomobject]@{ State = 'Unexpected'; Message = "403 with $ContentType." }
        }
        '\A000\z' {
            return [pscustomobject]@{ State = 'Unreachable'; Message = 'No HTTP answer at all: DNS, TLS or the network between the host and Cloudflare.' }
        }
        '\A404\z' {
            return [pscustomobject]@{ State = 'NoRoute'; Message = 'The API answered 404: the Function App is up but its functions are not registered (docs/runbooks/alerting-and-support.md, "The failure with no alert").' }
        }
        '\A5\d\d\z' {
            return [pscustomobject]@{ State = 'ApiError'; Message = "The API answered $Status." }
        }
    }
    return [pscustomobject]@{ State = 'Unexpected'; Message = "Status $Status with $ContentType." }
}

function Get-LabAgentVerdict {
    <#
    .SYNOPSIS
        What the unit state and the journal say about the agent.

    .DESCRIPTION
        A heartbeat that works logs nothing (vps-agent/index.js logs only
        failures), so a running agent with no "failed:" line since its last
        "starting against" line is heartbeating. Only the lines after that
        start line are read, so an old failure before a restart is not
        reported as current. The API's error text is what separates the
        causes: "Agent access required" is either gate of the agent guard,
        "Authentication required" is a token the API rejected, and a bare
        "HTTP 403" has no API body at all, so something in front of the API
        answered.
    #>
    [OutputType([pscustomobject])]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $Active,
        [AllowEmptyCollection()] [AllowNull()] [string[]] $Journal
    )

    $lines = @(@($Journal) | Where-Object { $_ })
    $start = -1
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -match 'agent v\S* starting against ') {
            $start = $i
            break
        }
    }
    $since = if ($start -ge 0) { @($lines[$start..($lines.Count - 1)]) } else { $lines }
    $failures = @($since | Where-Object { $_ -match '(?:heartbeat|claim) failed: |Missing required configuration|Fatal agent error' })
    $last = if ($failures.Count -gt 0) { $failures[$failures.Count - 1] } else { '' }

    if ($Active -ne 'active') {
        if ($last -match 'Missing required configuration') {
            return [pscustomobject]@{ State = 'Config'; Message = "hcw-labs-agent is $Active and says: $last" }
        }
        $why = if ($last) { " Its last failure: $last" } else { '' }
        return [pscustomobject]@{ State = 'Stopped'; Message = "hcw-labs-agent is $Active. bootstrap.sh starts it only once all four vault_labs_agent_* keys exist; the play's ""Say why the agent is not running yet"" task says which are missing.$why" }
    }
    if (-not $last) {
        return [pscustomobject]@{ State = 'Healthy'; Message = 'hcw-labs-agent is active and has logged no failure since it started: it is heartbeating.' }
    }
    if ($last -match 'Agent access required') {
        return [pscustomobject]@{ State = 'Registry'; Message = 'The API refuses the agent with "Agent access required". Its token is accepted, so this is the agent guard: the LabAgent grant (step 3) or the lab_agents registry document (step 4).' }
    }
    if ($last -match 'Authentication required') {
        return [pscustomobject]@{ State = 'Token'; Message = 'The API rejected the token itself ("Authentication required"): its audience or tenant is not what ENTRA_API_AUDIENCE and ENTRA_TENANT_ID expect.' }
    }
    if ($last -match 'failed with HTTP 403') {
        return [pscustomobject]@{ State = 'Edge'; Message = 'HTTP 403 with no API error in the body: Cloudflare or the origin lock answered, not the API.' }
    }
    if ($last -match 'failed with HTTP 404') {
        return [pscustomobject]@{ State = 'NoRoute'; Message = 'HTTP 404: the Function App answered but agent/heartbeat is not registered.' }
    }
    if ($last -match 'failed with HTTP 5\d\d') {
        return [pscustomobject]@{ State = 'ApiError'; Message = "The API failed: $last" }
    }
    if ($last -match '(AADSTS\d+)') {
        return [pscustomobject]@{ State = 'Credential'; Message = "Entra refused the agent's certificate sign-in ($($Matches[1])). A registration or certificate added in this run can take a few minutes to reach every Entra region." }
    }
    if ($last -match 'fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|aborted') {
        return [pscustomobject]@{ State = 'Network'; Message = "The host could not reach the API: $last" }
    }
    if ($last -match 'Missing required configuration') {
        return [pscustomobject]@{ State = 'Config'; Message = $last }
    }
    return [pscustomobject]@{ State = 'Unknown'; Message = $last }
}

function Invoke-LabAz {
    <#
    .SYNOPSIS
        Runs az and returns its exit code, standard output and standard error
        separately. The seam the tests mock.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string[]] $Arguments)

    $stdout = [System.Collections.Generic.List[string]]::new()
    $stderr = [System.Collections.Generic.List[string]]::new()
    & az @Arguments 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $stderr.Add($_.ToString())
        }
        else {
            $stdout.Add([string]$_)
        }
    }
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Stdout   = ($stdout -join "`n")
        Stderr   = ($stderr -join "`n")
    }
}

function Invoke-LabAzJson {
    <#
    .SYNOPSIS
        Runs az, retrying while Entra has not caught up with an object this
        run created, and writes the parsed JSON to the pipeline (a JSON list
        as its items, so an empty list writes nothing).

    .DESCRIPTION
        Entra replicates a new application asynchronously, so the service
        principal, the credential and the role assignment that follow it can
        briefly be told the application or principal does not exist.
        RetryPattern names those answers. AcceptPattern names an answer that
        means the change is already there, which is success for an
        idempotent step.
    #>
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $What,
        [ValidateRange(1, 20)] [int] $Attempts = 1,
        [int] $DelaySeconds = 10,
        [string] $RetryPattern = '',
        [string] $AcceptPattern = ''
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $result = Invoke-LabAz -Arguments $Arguments
        if ($result.ExitCode -eq 0) {
            if (-not [string]::IsNullOrWhiteSpace($result.Stdout)) {
                $result.Stdout | ConvertFrom-Json
            }
            return
        }
        if ($AcceptPattern -and $result.Stderr -match $AcceptPattern) {
            return
        }
        if ($attempt -lt $Attempts -and $RetryPattern -and $result.Stderr -match $RetryPattern) {
            Write-Host "  $What`: Entra has not caught up yet; trying again in $DelaySeconds seconds ($attempt of $Attempts)."
            Start-Sleep -Seconds $DelaySeconds
            continue
        }
        $detail = (@($result.Stderr -split "`n" | Where-Object { $_.Trim() }) | Select-Object -First 4) -join ' '
        throw "$What failed: az exited $($result.ExitCode). $detail"
    }
}

function Invoke-LabSsh {
    <#
    .SYNOPSIS
        Runs one command on the host and returns its exit code and output
        lines; with -Stream the lines are also shown as they arrive. The
        seam the tests mock.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $HostAlias,
        [Parameter(Mandatory)] [string] $Command,
        [switch] $Stream
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    & ssh -o ConnectTimeout=20 $HostAlias $Command 2>&1 | ForEach-Object {
        $line = [string]$_
        $lines.Add($line)
        if ($Stream) {
            Write-Host $line
        }
    }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = [string[]]$lines.ToArray() }
}

function Resolve-LabApiAppId {
    <#
    .SYNOPSIS
        The API registration's client id, without a copy of it in the
        repository: -ApiAppId as given, else HCW_API_APP_ID, else the one
        registration in the tenant whose display name is exactly
        -DisplayName. Stops rather than guessing when none or several match.
        scripts/lib/Resolve-EntraApiAppId.ps1 is the same logic for the
        cutover and rollback scripts (#1540).
    #>
    [OutputType([string])]
    param(
        [AllowEmptyString()] [string] $ApiAppId,
        [string] $DisplayName = 'HCWSite API'
    )

    if (-not [string]::IsNullOrWhiteSpace($ApiAppId)) {
        return $ApiAppId.ToLowerInvariant()
    }
    $fromEnvironment = [string]$env:HCW_API_APP_ID
    if (-not [string]::IsNullOrWhiteSpace($fromEnvironment)) {
        if (-not (Test-LabGuid -Value $fromEnvironment)) {
            throw "HCW_API_APP_ID is '$fromEnvironment', which is not a client id."
        }
        return $fromEnvironment.ToLowerInvariant()
    }
    $apps = @(Invoke-LabAzJson -Arguments @('ad', 'app', 'list', '--display-name', $DisplayName, '-o', 'json') -What "Finding the app registration $DisplayName")
    # az filters on the name; the exact comparison keeps a registration named
    # 'HCWSite API (old)' from being taken for the real one.
    $matching = @($apps | Where-Object { [string](Get-LabProperty -Object $_ -Name 'displayName') -ceq $DisplayName })
    if ($matching.Count -eq 1) {
        $id = [string](Get-LabProperty -Object $matching[0] -Name 'appId')
        if (-not (Test-LabGuid -Value $id)) {
            throw "az returned '$id' as the client id of $DisplayName, which is not a client id."
        }
        return $id.ToLowerInvariant()
    }
    if ($matching.Count -eq 0) {
        throw "No app registration named '$DisplayName' in this tenant. Pass -ApiAppId with its application (client) id (Entra admin center: App registrations, $DisplayName, Overview), or set HCW_API_APP_ID to it."
    }
    $ids = @($matching | ForEach-Object { [string](Get-LabProperty -Object $_ -Name 'appId') }) -join ', '
    throw "More than one app registration is named '$DisplayName' ($ids). Pass -ApiAppId with the right one, or rename the others."
}

function Get-LabApiApplication {
    <#
    .SYNOPSIS
        Reads the API registration and checks the three things the agent's
        token depends on, stopping rather than guessing when one is not as
        scripts/lib/deploy-console.ps1 (New-EntraApiRegistration) creates it:
        an enabled LabAgent app role for applications, v2 tokens (so the
        audience is the bare client id ENTRA_API_AUDIENCE holds), and the
        api://<client id> identifier the scope names.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string] $ApiAppId)

    $app = Invoke-LabAzJson -Arguments @('ad', 'app', 'show', '--id', $ApiAppId, '-o', 'json') -What "Reading the API app registration $ApiAppId"
    if ($null -eq $app) {
        throw "No app registration $ApiAppId in this tenant."
    }
    $role = $null
    foreach ($candidate in (Get-LabList -Object $app -Name 'appRoles')) {
        if ([string](Get-LabProperty -Object $candidate -Name 'value') -ceq 'LabAgent') {
            $role = $candidate
        }
    }
    if ($null -eq $role) {
        throw "The API registration $ApiAppId has no LabAgent app role. It defines it at creation (scripts/lib/deploy-console.ps1); add it under App roles, then run this again."
    }
    if ((Get-LabProperty -Object $role -Name 'isEnabled') -ne $true) {
        throw "The LabAgent app role on $ApiAppId is disabled. Enable it under App roles, then run this again."
    }
    if ((Get-LabList -Object $role -Name 'allowedMemberTypes') -notcontains 'Application') {
        throw "The LabAgent app role on $ApiAppId does not allow applications, so no service principal can hold it."
    }
    $version = Get-LabProperty -Object (Get-LabProperty -Object $app -Name 'api') -Name 'requestedAccessTokenVersion'
    if ($version -ne 2) {
        throw "The API registration issues v$version tokens, not v2. ENTRA_API_AUDIENCE is the bare client id, which only a v2 token carries; see scripts/cutover/01-entra-api.ps1."
    }
    $identifier = 'api://' + $ApiAppId.ToLowerInvariant()
    if ((Get-LabList -Object $app -Name 'identifierUris') -notcontains $identifier) {
        throw "The API registration does not expose $identifier, which the agent's scope names."
    }
    $sp = Invoke-LabAzJson -Arguments @('ad', 'sp', 'show', '--id', $ApiAppId, '-o', 'json') -What "Reading the API's service principal"
    $spId = [string](Get-LabProperty -Object $sp -Name 'id')
    if (-not (Test-LabGuid -Value $spId)) {
        throw "The API registration $ApiAppId has no service principal, and no role can be assigned without one."
    }
    return [pscustomobject]@{
        DisplayName        = [string](Get-LabProperty -Object $app -Name 'displayName')
        AppRoleId          = [string](Get-LabProperty -Object $role -Name 'id')
        ServicePrincipalId = $spId
        Scope              = (Get-LabApiScope -ApiAppId $ApiAppId)
    }
}

function Confirm-LabAgentApplication {
    <#
    .SYNOPSIS
        Finds the agent's app registration by display name, or creates it
        (single tenant, no credential), then does the same for its service
        principal. More than one registration of that name is a stop: which
        one the agent should be is not a guess to make.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string] $DisplayName)

    $replication = '(?i)does not exist|not found|can''t find|cannot find|NoSuchObject|ResourceNotFound'
    $apps = @(Invoke-LabAzJson -Arguments @('ad', 'app', 'list', '--display-name', $DisplayName, '-o', 'json') -What "Looking up the app registration $DisplayName")
    if ($apps.Count -gt 1) {
        $ids = ($apps | ForEach-Object { [string](Get-LabProperty -Object $_ -Name 'appId') }) -join ', '
        throw "$($apps.Count) app registrations are named $DisplayName ($ids). Delete the ones the agent does not use, then run this again."
    }

    $appCreated = $false
    if ($apps.Count -eq 1) {
        $app = $apps[0]
    }
    elseif ($PSCmdlet.ShouldProcess($DisplayName, 'Create the app registration')) {
        $app = Invoke-LabAzJson -Arguments @('ad', 'app', 'create', '--display-name', $DisplayName, '--sign-in-audience', 'AzureADMyOrg', '-o', 'json') -What "Creating the app registration $DisplayName"
        $appCreated = $true
    }
    else {
        return [pscustomobject]@{
            AppId = $null; ObjectId = $null; ServicePrincipalId = $null
            RegisteredKeys = [object[]]@(); PasswordCredentialCount = 0
            AppCreated = $false; ServicePrincipalCreated = $false
        }
    }

    $appId = [string](Get-LabProperty -Object $app -Name 'appId')
    if (-not (Test-LabGuid -Value $appId)) {
        throw "az returned no appId for $DisplayName."
    }
    $sps = @(Invoke-LabAzJson -Arguments @('ad', 'sp', 'list', '--filter', "appId eq '$appId'", '-o', 'json') -What "Looking up the service principal of $DisplayName" -Attempts 6 -RetryPattern $replication)
    $spCreated = $false
    $spId = $null
    if ($sps.Count -ge 1) {
        $spId = [string](Get-LabProperty -Object $sps[0] -Name 'id')
    }
    elseif ($PSCmdlet.ShouldProcess($DisplayName, 'Create the service principal')) {
        $sp = Invoke-LabAzJson -Arguments @('ad', 'sp', 'create', '--id', $appId, '-o', 'json') -What "Creating the service principal of $DisplayName" -Attempts 6 -RetryPattern $replication
        $spId = [string](Get-LabProperty -Object $sp -Name 'id')
        $spCreated = $true
    }

    return [pscustomobject]@{
        AppId                   = $appId
        ObjectId                = [string](Get-LabProperty -Object $app -Name 'id')
        ServicePrincipalId      = $spId
        RegisteredKeys          = (Get-LabList -Object $app -Name 'keyCredentials')
        PasswordCredentialCount = (Get-LabList -Object $app -Name 'passwordCredentials').Count
        AppCreated              = $appCreated
        ServicePrincipalCreated = $spCreated
    }
}

function Confirm-LabAgentCertificate {
    <#
    .SYNOPSIS
        Appends the certificate to the registration unless a key credential
        with its thumbprint is already there. Returns what it did and the
        registration's other certificates, which it never touches.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $AppId,
        [AllowNull()] [AllowEmptyCollection()] [object[]] $RegisteredKeys,
        [Parameter(Mandatory)] [pscustomobject] $Certificate,
        [Parameter(Mandatory)] [string] $CertificateFile,
        [Parameter(Mandatory)] [string] $KeyDisplayName
    )

    $others = [System.Collections.Generic.List[pscustomobject]]::new()
    foreach ($credential in @($RegisteredKeys)) {
        if ($null -eq $credential) {
            continue
        }
        $thumbprint = ConvertTo-LabThumbprint -CustomKeyIdentifier ([string](Get-LabProperty -Object $credential -Name 'customKeyIdentifier'))
        if ($thumbprint -ceq $Certificate.Thumbprint) {
            continue
        }
        $others.Add([pscustomobject]@{
                KeyId       = [string](Get-LabProperty -Object $credential -Name 'keyId')
                Thumbprint  = $thumbprint
                EndDateTime = [string](Get-LabProperty -Object $credential -Name 'endDateTime')
            })
    }

    $action = 'Unchanged'
    if (-not (Test-LabKeyCredentialPresent -RegisteredKeys $RegisteredKeys -Thumbprint $Certificate.Thumbprint)) {
        if ($PSCmdlet.ShouldProcess($AppId, "Append the certificate $($Certificate.Thumbprint)")) {
            $arguments = Get-LabCredentialResetArguments -AppId $AppId -CertificateFile $CertificateFile -EndDate (Get-LabKeyCredentialEndDate -NotAfterUtc $Certificate.NotAfterUtc) -KeyDisplayName $KeyDisplayName
            $null = Invoke-LabAzJson -Arguments $arguments -What 'Uploading the certificate' -Attempts 6 -RetryPattern '(?i)does not exist|not found|can''t find|cannot find|NoSuchObject|ResourceNotFound'
            $action = 'Appended'
        }
        else {
            $action = 'WouldAppend'
        }
    }
    return [pscustomobject]@{ Action = $action; Others = [pscustomobject[]]$others.ToArray() }
}

function Confirm-LabAgentAppRole {
    <#
    .SYNOPSIS
        Assigns the LabAgent app role on the API's service principal to the
        agent's service principal, unless it already holds it. Reports any
        other app role the agent holds, and removes none.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $ServicePrincipalId,
        [Parameter(Mandatory)] [string] $ApiServicePrincipalId,
        [Parameter(Mandatory)] [string] $AppRoleId,
        [string] $BodyDirectory = [System.IO.Path]::GetTempPath()
    )

    $replication = '(?i)does not exist|not found|can''t find|cannot find|NoSuchObject|ResourceNotFound'
    $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$ServicePrincipalId/appRoleAssignments"
    $existing = Invoke-LabAzJson -Arguments @('rest', '--method', 'GET', '--url', $url, '-o', 'json') -What "Reading the agent's app role assignments" -Attempts 6 -RetryPattern $replication

    $present = $false
    $extra = [System.Collections.Generic.List[string]]::new()
    foreach ($assignment in (Get-LabList -Object $existing -Name 'value')) {
        $roleId = [string](Get-LabProperty -Object $assignment -Name 'appRoleId')
        $resourceId = [string](Get-LabProperty -Object $assignment -Name 'resourceId')
        if ($roleId -eq $AppRoleId -and $resourceId -eq $ApiServicePrincipalId) {
            $present = $true
        }
        else {
            $extra.Add(([string](Get-LabProperty -Object $assignment -Name 'resourceDisplayName')) + ' role ' + $roleId)
        }
    }

    $action = 'Unchanged'
    if (-not $present) {
        if ($PSCmdlet.ShouldProcess($ServicePrincipalId, 'Assign the LabAgent app role')) {
            $body = [ordered]@{ principalId = $ServicePrincipalId; resourceId = $ApiServicePrincipalId; appRoleId = $AppRoleId } | ConvertTo-Json -Compress
            $bodyFile = Join-Path $BodyDirectory ('hcw-lab-agent-role-' + [guid]::NewGuid().ToString('n') + '.json')
            [System.IO.File]::WriteAllText($bodyFile, $body, [System.Text.UTF8Encoding]::new($false))
            try {
                $null = Invoke-LabAzJson -Arguments @('rest', '--method', 'POST', '--url', $url, '--headers', 'Content-Type=application/json', '--body', ('@' + $bodyFile), '-o', 'none') -What 'Assigning the LabAgent app role' -Attempts 6 -RetryPattern $replication -AcceptPattern '(?i)already exists'
            }
            finally {
                Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
            }
            $action = 'Assigned'
        }
        else {
            $action = 'WouldAssign'
        }
    }
    return [pscustomobject]@{ Action = $action; Extra = [string[]]$extra.ToArray() }
}

function Stop-LabRun {
    <#
    .SYNOPSIS
        Says why the run stops and, when there is one, the one line to run
        before running this again. Exits 1.
    #>
    param(
        [Parameter(Mandatory)] [string] $Message,
        [string] $Command
    )

    Write-Host ''
    Write-Host $Message
    if ($Command) {
        Write-Host 'Run this in PowerShell, then run this script again:'
        Write-Host ''
        Write-Host "  $Command"
    }
    exit 1
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

$bootstrapCommand = 'sudo /opt/hcw-src/lab-host/bootstrap.sh'
$labsUrl = 'https://hybridcloudworks.com/admin/labs?tab=agents'
$loginLine = "az login --tenant $TenantDomain"
$changes = [System.Collections.Generic.List[string]]::new()

foreach ($tool in 'az', 'ssh') {
    if (-not (Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue)) {
        $hint = if ($tool -eq 'az') {
            ' Install the Azure CLI: winget install --exact --id Microsoft.AzureCLI'
        }
        else {
            ' Install the OpenSSH client from PowerShell opened with Run as administrator: Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
        }
        throw "$tool is not on PATH.$hint"
    }
}

# 1. az, signed in to the tenant.
$account = Invoke-LabAz -Arguments @('account', 'show', '-o', 'json')
if ($account.ExitCode -ne 0) {
    Stop-LabRun -Message 'az is not signed in.' -Command $loginLine
}
$accountInfo = $account.Stdout | ConvertFrom-Json
$tenantId = ([string](Get-LabProperty -Object $accountInfo -Name 'tenantId')).ToLowerInvariant()
$defaultDomain = [string](Get-LabProperty -Object $accountInfo -Name 'tenantDefaultDomain')
if ($defaultDomain -ne $TenantDomain) {
    # The default domain can be a custom one; the tenant's own discovery
    # document names its id whatever the default is.
    $discovery = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$TenantDomain/v2.0/.well-known/openid-configuration"
    $expectedTenant = Get-LabTenantIdFromIssuer -Issuer ([string](Get-LabProperty -Object $discovery -Name 'issuer'))
    if (-not $expectedTenant -or $expectedTenant -ne $tenantId) {
        Stop-LabRun -Message "az is signed in to tenant $tenantId, not $TenantDomain." -Command $loginLine
    }
}
if (-not (Test-LabGuid -Value $tenantId)) {
    Stop-LabRun -Message 'az account show returned no tenant id.' -Command $loginLine
}
$signedInAs = [string](Get-LabProperty -Object (Get-LabProperty -Object $accountInfo -Name 'user') -Name 'name')
Write-Host "az: signed in as $signedInAs to $TenantDomain ($tenantId)."

# 2. The certificate, read on the host.
$certificateName = if ($NextCertificate) { 'labs-agent.next' } else { 'labs-agent' }
$remoteCertificate = "/etc/hcw/$certificateName.crt"
$readScript = Get-LabCertificateReadScript -CertificatePath $remoteCertificate -KeyPath "/etc/hcw/$certificateName.pem" -NextCertificatePath $(if ($NextCertificate) { '' } else { '/etc/hcw/labs-agent.next.crt' })
$read = Invoke-LabSsh -HostAlias $HostAlias -Command (Get-LabRemoteCommand -BashScript $readScript)
if ($read.ExitCode -eq 255) {
    throw "ssh could not reach $HostAlias. Set this desktop up with scripts/lab/Connect-Lab.ps1 (docs/runbooks/labs-host.md, ""Connect from a desktop""), check that ssh $HostAlias hostname prints the host's name, then run this again."
}
if ($read.ExitCode -ne 0) {
    $hostError = ConvertFrom-LabVaultOutput -Lines $read.Lines
    $reason = if ($hostError.ErrorMessage) { $hostError.ErrorMessage } else { ($read.Lines | Select-Object -Last 3) -join ' ' }
    throw "Reading $remoteCertificate on $HostAlias failed (exit $($read.ExitCode)): $reason"
}
$certificateOutput = ConvertFrom-LabCertificateOutput -Lines $read.Lines
switch ($certificateOutput.KeyMatches) {
    'yes' { }
    'missing' { throw "/etc/hcw/$certificateName.pem does not exist on $HostAlias, so $remoteCertificate belongs to no key the agent holds. Nothing was uploaded." }
    default { throw "$remoteCertificate on $HostAlias does not match the private key in /etc/hcw/$certificateName.pem. Uploading it would register a certificate the agent cannot sign with; nothing was uploaded. lab-host/README.md, ""Rotating the agent certificate"", is how the pair is replaced." }
}
$certificate = Get-LabCertificateInfo -Pem $certificateOutput.Pem
$agentId = $certificate.CommonName
if (-not (Test-LabAgentId -Value $agentId)) {
    throw "The certificate's subject is '$($certificate.Subject)'; its CN should be the agent id (labs_agent_id), such as vps-hostinger-01."
}
$now = [datetime]::UtcNow
if ($certificate.NotAfterUtc -le $now) {
    throw "$remoteCertificate expired on $($certificate.NotAfterUtc.ToString('u')). Rotate it first: lab-host/README.md, ""Rotating the agent certificate""."
}
Write-Host "Certificate: $remoteCertificate on $HostAlias, CN=$agentId, thumbprint $($certificate.Thumbprint), valid until $($certificate.NotAfterUtc.ToString('yyyy-MM-dd')). The private key on the host matches it."
if (($certificate.NotAfterUtc - $now).TotalDays -lt 60) {
    Write-Host '  It expires within 60 days: rotate it soon (lab-host/README.md, "Rotating the agent certificate").'
}

$certificateFile = Join-Path ([System.IO.Path]::GetTempPath()) ("hcw-$certificateName-" + [guid]::NewGuid().ToString('n') + '.crt')
[System.IO.File]::WriteAllText($certificateFile, $certificateOutput.Pem + "`n", [System.Text.UTF8Encoding]::new($false))

# 3. Entra: the registration, its certificate, and the one grant.
try {
    $ApiAppId = Resolve-LabApiAppId -ApiAppId $ApiAppId -DisplayName $ApiDisplayName
    $api = Get-LabApiApplication -ApiAppId $ApiAppId
    Write-Host "Entra: the API is $($api.DisplayName) ($ApiAppId); the agent's scope is $($api.Scope)."

    $agent = Confirm-LabAgentApplication -DisplayName $DisplayName
    if ($null -eq $agent.AppId) {
        Write-Host "Entra: would create the app registration and service principal $DisplayName."
    }
    else {
        $state = if ($agent.AppCreated) { 'created' } else { 'found' }
        Write-Host "Entra: $state the app registration $DisplayName (client id $($agent.AppId))."
        if ($agent.AppCreated) {
            $changes.Add("created the app registration $DisplayName")
        }
        if ($agent.ServicePrincipalId) {
            $state = if ($agent.ServicePrincipalCreated) { 'created' } else { 'found' }
            Write-Host "Entra: $state its service principal (object id $($agent.ServicePrincipalId))."
            if ($agent.ServicePrincipalCreated) {
                $changes.Add('created its service principal')
            }
        }
        else {
            Write-Host 'Entra: would create its service principal.'
        }
        if ($agent.PasswordCredentialCount -gt 0) {
            Write-Host "  The registration also holds $($agent.PasswordCredentialCount) client secret(s). The agent signs in with its certificate only; delete them in the portal under Certificates & secrets unless something else uses them."
        }
    }

    if ($NextCertificate -and $null -eq $agent.AppId) {
        throw "-NextCertificate adds a certificate to an existing registration, and $DisplayName does not exist yet. Run this without -NextCertificate first."
    }

    $certificateResult = $null
    if ($agent.AppId) {
        $keyDisplayName = "$agentId $certificateName.crt"
        $certificateResult = Confirm-LabAgentCertificate -AppId $agent.AppId -RegisteredKeys $agent.RegisteredKeys -Certificate $certificate -CertificateFile $certificateFile -KeyDisplayName $keyDisplayName
        switch ($certificateResult.Action) {
            'Unchanged' { Write-Host "Entra: the certificate $($certificate.Thumbprint) is already on the registration." }
            'Appended' {
                Write-Host "Entra: appended the certificate $($certificate.Thumbprint), valid until $($certificate.NotAfterUtc.ToString('yyyy-MM-dd')); every other credential was left as it was."
                $changes.Add("uploaded the certificate $($certificate.Thumbprint)")
            }
            'WouldAppend' { Write-Host "Entra: would append the certificate $($certificate.Thumbprint)." }
        }
    }
    else {
        Write-Host "Entra: would upload the certificate $($certificate.Thumbprint)."
    }

    $roleResult = $null
    if ($agent.ServicePrincipalId) {
        $roleResult = Confirm-LabAgentAppRole -ServicePrincipalId $agent.ServicePrincipalId -ApiServicePrincipalId $api.ServicePrincipalId -AppRoleId $api.AppRoleId
        switch ($roleResult.Action) {
            'Unchanged' { Write-Host "Entra: the service principal already holds LabAgent on $($api.DisplayName)." }
            'Assigned' {
                Write-Host "Entra: assigned LabAgent on $($api.DisplayName) to the service principal (admin consent for that one application permission)."
                $changes.Add('assigned the LabAgent app role')
            }
            'WouldAssign' { Write-Host "Entra: would assign LabAgent on $($api.DisplayName) to the service principal." }
        }
        foreach ($item in $roleResult.Extra) {
            Write-Host "  It also holds $item, which the agent does not need. Remove it under Enterprise applications, $DisplayName, Permissions, unless something else uses it."
        }
    }
    else {
        Write-Host "Entra: would assign LabAgent on $($api.DisplayName) to the new service principal."
    }
}
finally {
    Remove-Item -LiteralPath $certificateFile -Force -ErrorAction SilentlyContinue
}
$entraChanged = $changes.Count -gt 0

if ($NextCertificate) {
    Write-Host ''
    if ($WhatIfPreference) {
        Write-Host 'WhatIf: nothing was changed.'
        exit 0
    }
    Write-Host 'The next certificate is registered. Swap it in on the host, PowerShell:'
    Write-Host ''
    Write-Host "  ssh $HostAlias ""sudo sh -c 'mv /etc/hcw/labs-agent.next.pem /etc/hcw/labs-agent.pem && mv /etc/hcw/labs-agent.next.crt /etc/hcw/labs-agent.crt && chown root:hcw-labs-agent /etc/hcw/labs-agent.pem && chmod 0640 /etc/hcw/labs-agent.pem && chmod 0644 /etc/hcw/labs-agent.crt && systemctl restart hcw-labs-agent'"""
    Write-Host ''
    Write-Host "Success is the agent Online again at $labsUrl within a minute. Then run this script once more without -NextCertificate: it confirms the agent and prints the line that removes the old certificate."
    exit 0
}

# 4. The registry document gate 2 reads, written by Register agent on the site.
# The agent's state is read here rather than in step 6 so that a healthy agent
# is not made to wait for a registration it already has; nothing between here
# and step 6 changes the unit.
$registrationPrompt = $null
$registrationAsked = $false
$status = $null
if ($agent.ServicePrincipalId) {
    $registrationPrompt = Get-LabRegistrationPrompt -Url $labsUrl -AgentId $agentId -ObjectId $agent.ServicePrincipalId -JobTypes (Get-LabJobTypes)
    if ($WhatIfPreference) {
        Write-Host 'Registry: would ask you to register the agent on the site and wait for Enter:'
        foreach ($line in $registrationPrompt) {
            Write-Host "  $line"
        }
    }
    else {
        $status = Read-LabAgentStatus -HostAlias $HostAlias
        $before = Get-LabAgentVerdict -Active $status.Active -Journal $status.Journal
        if (Test-LabRegistrationNeeded -VerdictState $before.State -ServicePrincipalCreated:$agent.ServicePrincipalCreated) {
            Write-Host ''
            Wait-LabRegistration -Lines $registrationPrompt
            $registrationAsked = $true
        }
        else {
            Write-Host "Registry: hcw-labs-agent is heartbeating with this service principal, so lab_agents/$agentId is registered and binds it; nothing to register."
        }
    }
}
else {
    Write-Host "Registry: lab_agents/$agentId binds the new service principal's object id, known once it exists; a run without -WhatIf asks you to register it at $labsUrl."
}

# 5. The vault on the host.
$vaultChanged = $false
$probe = $null
if ($agent.AppId) {
    $values = Get-LabVaultValues -ApiBase $ApiBase -TenantId $tenantId -ClientId $agent.AppId -ApiScope $api.Scope
    foreach ($key in $values.Keys) {
        Write-Host "Vault: $key = $($values[$key])"
    }
    $mode = if ($WhatIfPreference) { 'check' } else { 'apply' }
    $vaultScript = Get-LabVaultScript -Values $values -Mode $mode -ProbeUrl "$ApiBase/agent/heartbeat"
    $vaultRun = Invoke-LabSsh -HostAlias $HostAlias -Command (Get-LabRemoteCommand -BashScript $vaultScript)
    $vaultOutput = ConvertFrom-LabVaultOutput -Lines $vaultRun.Lines
    if ($vaultOutput.ProbeStatus) {
        $probe = Get-LabProbeVerdict -Status $vaultOutput.ProbeStatus -ContentType $vaultOutput.ProbeContentType -Mitigated $vaultOutput.ProbeMitigated
        Write-Host "Probe: from $HostAlias, POST $ApiBase/agent/heartbeat without a token answered $($vaultOutput.ProbeStatus) $($vaultOutput.ProbeContentType). $($probe.Message)"
    }
    if ($vaultRun.ExitCode -ne 0 -or -not $vaultOutput.VaultState) {
        $reason = if ($vaultOutput.ErrorMessage) { $vaultOutput.ErrorMessage } else { "exit $($vaultRun.ExitCode): " + (($vaultRun.Lines | Select-Object -Last 3) -join ' ') }
        throw "The vault on $HostAlias was not changed: $reason"
    }
    $summary = @()
    foreach ($field in 'Added', 'Updated', 'Unchanged') {
        $names = [string[]]$vaultOutput.$field
        if ($names.Count -gt 0) {
            $summary += $field.ToLowerInvariant() + ' ' + ($names -join ', ')
        }
    }
    $summaryText = if ($summary.Count -gt 0) { ' (' + ($summary -join '; ') + ')' } else { '' }
    switch ($vaultOutput.VaultState) {
        'unchanged' { Write-Host "Vault: /etc/hcw/ansible/vault.yml already holds the four values; not rewritten$summaryText." }
        'created' {
            Write-Host "Vault: created /etc/hcw/ansible/vault.yml with the four keys$summaryText. It now exists, so add the other keys with ansible-vault edit, not create (lab-host/README.md, ""The vault"")."
            $changes.Add('created the vault with the four agent keys')
            $vaultChanged = $true
        }
        'updated' {
            Write-Host "Vault: merged the four keys into /etc/hcw/ansible/vault.yml$summaryText; every other key is as it was."
            $changes.Add('wrote the four agent keys into the vault')
            $vaultChanged = $true
        }
        default { Write-Host "Vault: $($vaultOutput.VaultState -replace '-', ' ')$summaryText; nothing was written." }
    }
}
else {
    Write-Host 'Vault: would write the four vault_labs_agent_* keys once the registration exists (its client id is one of them).'
}

# 6. bootstrap.sh, and what the agent says.
Write-Host ''
if ($WhatIfPreference) {
    Write-Host "Agent: would run $bootstrapCommand on $HostAlias when the vault changes or the agent is not running, then read hcw-labs-agent's state and journal."
    Write-Host ''
    Write-Host 'WhatIf: nothing was changed.'
    exit 0
}

if ($null -eq $status) {
    $status = Read-LabAgentStatus -HostAlias $HostAlias
}
$acted = $false
if ($vaultChanged -or $ForceBootstrap -or $status.Active -ne 'active') {
    $why = if ($vaultChanged) { 'the vault changed' } elseif ($ForceBootstrap) { '-ForceBootstrap' } else { "hcw-labs-agent is $($status.Active)" }
    Write-Host "Agent: running $bootstrapCommand on $HostAlias, because $why. Its output follows."
    Write-Host ''
    $bootstrap = Invoke-LabSsh -HostAlias $HostAlias -Command $bootstrapCommand -Stream
    Write-Host ''
    if ($bootstrap.ExitCode -ne 0) {
        throw "bootstrap.sh exited $($bootstrap.ExitCode). The PLAY RECAP above names the task that failed; fix that and run this script again."
    }
    $changes.Add('ran bootstrap.sh')
    $acted = $true
}
elseif ($entraChanged -or $registrationAsked) {
    # A running agent keeps the token it already has for up to an hour, and
    # a token issued before the grant carries no LabAgent role. After a
    # registration the token is fine, but a heartbeat that now works logs
    # nothing, so without a restart the journal's last line would still be
    # the refusal from before it and the verdict below would repeat it.
    $why = if ($entraChanged) { 'what this run changed in Entra' } else { 'the registration it now has' }
    Write-Host "Agent: restarting hcw-labs-agent so it signs in again with $why."
    $restart = Invoke-LabSsh -HostAlias $HostAlias -Command 'sudo systemctl restart hcw-labs-agent'
    if ($restart.ExitCode -ne 0) {
        throw "Restarting hcw-labs-agent failed (exit $($restart.ExitCode)): $(($restart.Lines | Select-Object -Last 3) -join ' ')"
    }
    $changes.Add('restarted hcw-labs-agent')
    $acted = $true
}
else {
    Write-Host 'Agent: nothing changed and hcw-labs-agent is running, so bootstrap.sh was not run (-ForceBootstrap runs it anyway).'
}

if ($acted) {
    # The first heartbeat is sent at start; a failure is logged within a few
    # seconds, a timeout within twenty.
    Write-Host 'Agent: giving it 30 seconds to send its first heartbeat.'
    Start-Sleep -Seconds 30
    $status = Read-LabAgentStatus -HostAlias $HostAlias
}
$verdict = Get-LabAgentVerdict -Active $status.Active -Journal $status.Journal
Write-Host "Agent: systemctl is-active hcw-labs-agent says $($status.Active). Its last journal lines:"
foreach ($line in @($status.Journal | Select-Object -Last 12)) {
    Write-Host "  $line"
}
Write-Host ''
Write-Host "Agent: $($verdict.Message)"

$restartLine = "ssh $HostAlias sudo systemctl restart hcw-labs-agent"
switch ($verdict.State) {
    'Healthy' {
        Write-Host "  The registry document is there and binds this credential: a heartbeat passes both gates of the agent guard."
        if ($certificateResult -and $certificateResult.Others.Count -gt 0) {
            $removable = @($certificateResult.Others | Where-Object { -not $certificateOutput.NextThumbprint -or $_.Thumbprint -ne $certificateOutput.NextThumbprint })
            foreach ($other in $removable) {
                Write-Host "  The registration still holds another certificate ($($other.Thumbprint), until $($other.EndDateTime)). The agent signs in with $($certificate.Thumbprint), so once the site shows it Online, remove the other one, PowerShell:"
                Write-Host "    az ad app credential delete --id $($agent.AppId) --key-id $($other.KeyId) --cert"
            }
        }
    }
    'Registry' {
        Write-Host "  Step 3 left the LabAgent grant in place, so it is gate 2: lab_agents/$agentId is missing, deactivated, or bound to another object id. Open $labsUrl and look at the $agentId card:"
        Write-Host "    no card: register it under Register agent, agent id $agentId, object id $($agent.ServicePrincipalId.ToLowerInvariant());"
        Write-Host '    a card marked Deactivated: press Activate on it;'
        Write-Host "    a card for another object id: register it again with the object id above, which rebinds it."
        Write-Host '  Then restart the agent so the journal starts clean, PowerShell:'
        Write-Host "    $restartLine"
        if ($roleResult -and $roleResult.Action -eq 'Assigned') {
            Write-Host "  If the card is there, active and bound to that object id, the grant this run made may not have reached the agent's token yet: wait two minutes before the restart."
        }
    }
    'Credential' {
        Write-Host '  Wait two minutes, then restart the agent and run this script again, PowerShell:'
        Write-Host "    $restartLine"
    }
    'Edge' {
        Write-Host '  The probe line above says which. The agent cannot reach the API from this host until that path admits it; docs/runbooks/labs-host.md, "The lab agent''s go-live", has the options.'
    }
}

Write-Host ''
if ($changes.Count -eq 0) {
    Write-Host 'No changes: the identity, the vault and the agent were already set up.'
}
else {
    Write-Host ('Changed: ' + ($changes -join '; ') + '.')
}
Write-Host ''
Write-Host 'Success looks like:'
Write-Host '  Agent: hcw-labs-agent is active and has logged no failure since it started.'
Write-Host "  Site:  $labsUrl lists $agentId as Online (the page polls; a heartbeat lands every 30 seconds)."
if ($verdict.State -ne 'Healthy') {
    exit 2
}

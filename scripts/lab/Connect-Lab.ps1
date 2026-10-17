#Requires -Version 7
<#
.SYNOPSIS
    Sets up this desktop to reach the lab host over SSH and VS Code Remote-SSH.

.DESCRIPTION
    Run it once on every desktop that should reach the lab host. It:

      1. creates a per-machine ed25519 key at -KeyPath, only if none exists;
      2. writes exactly one `Host hcw-lab` block into ~/.ssh/config, replacing
         an older one, leaving every other line as it was, and saving a
         timestamped backup of the file before it writes;
      3. on Windows, starts the ssh-agent service if it is installed and
         stopped, then loads the key into the agent;
      4. prints the public key, the line that pins it in
         lab-host/ansible/group_vars/all.yml, and how to use it before then.

    A second run changes nothing and says so. The private key is never read,
    printed or sent anywhere by this script: ssh-keygen writes it, ssh-add
    loads it, and the only key file this script opens is the .pub beside it.

    The procedure around it, including the hPanel step for a first key, is
    docs/runbooks/labs-host.md, "Connect from a desktop".

.PARAMETER HostName
    What `hcw-lab` resolves to. Defaults to the LAB_SSH_HOST variable of
    saulpatinojr/HCW-HybridCloudWorks when gh is installed, signed in and
    the variable is set; otherwise lab.hybridcloudworks.com. That record exists
    only after the hcw-lab Terraform apply, so until then set the variable (or
    pass this) to the server's IPv4 address.

.PARAMETER User
    hcwadmin, the login the hardening role creates, or root for the window
    between an OS install and the first bootstrap.sh run. That run turns root
    login off, so run this again without -User once it has finished.

.PARAMETER KeyPath
    The private key. Defaults to ~/.ssh/hcw-lab_ed25519; the public key is the
    same path with .pub added.

.PARAMETER Connect
    Open an SSH session to hcw-lab once setup is done.

.PARAMETER Code
    Open /opt/hcw-src on the host in VS Code through Remote-SSH once setup is
    done. Needs the ms-vscode-remote.remote-ssh extension and `code` on PATH.

.EXAMPLE
    ./scripts/lab/Connect-Lab.ps1 -Code

.EXAMPLE
    ./scripts/lab/Connect-Lab.ps1 -User root -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $HostName,

    [ValidateSet('hcwadmin', 'root')]
    [string] $User = 'hcwadmin',

    [string] $KeyPath = (Join-Path $HOME '.ssh' 'hcw-lab_ed25519'),

    [switch] $Connect,

    [switch] $Code
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native exit codes are read explicitly below. `ssh-add -l` exits 1 for an
# empty agent and 2 for no agent, and neither is a failure of this script.
$PSNativeCommandUseErrorActionPreference = $false

# -----------------------------------------------------------------------------
# Functions. Everything above the "Main" line is a definition only, so the
# Pester tests can load these from the file's syntax tree without running the
# script.
# -----------------------------------------------------------------------------

function Test-LabHostName {
    <#
    .SYNOPSIS
        True when Name is a DNS name or an IPv4 address that is safe to write
        as a HostName line: letters, digits, dots and hyphens, starting and
        ending with a letter or digit. \A and \z rather than ^ and $, because
        $ also matches before a trailing newline, and a newline is exactly
        what must not reach ssh_config.
    #>
    [OutputType([bool])]
    param([string] $Name)

    if ([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 253) {
        return $false
    }
    return ($Name -match '\A[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\z') -and ($Name -notmatch '\.\.')
}

function Get-LabSshHostBlock {
    <#
    .SYNOPSIS
        The lines of the `Host <Alias>` block this script owns, in order.
        IdentityFile is written with forward slashes, which Windows OpenSSH
        and VS Code both accept, and quoted only when it contains whitespace.
    #>
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string] $Alias,
        [Parameter(Mandatory)] [string] $HostName,
        [Parameter(Mandatory)] [string] $User,
        [Parameter(Mandatory)] [string] $IdentityFile
    )

    $identity = $IdentityFile -replace '\\', '/'
    if ($identity -match '\s') {
        $identity = '"' + $identity + '"'
    }
    return [string[]]@(
        "Host $Alias",
        '    # Written by scripts/lab/Connect-Lab.ps1. Run it again to change this block.',
        "    HostName $HostName",
        "    User $User",
        "    IdentityFile $identity",
        '    IdentitiesOnly yes',
        '    ServerAliveInterval 30'
    )
}

function Merge-LabSshHostBlock {
    <#
    .SYNOPSIS
        Returns ssh_config text with exactly one `Host <Alias>` block, equal to
        Block. Pure: it reads and writes no file.

    .DESCRIPTION
        A block is a line `Host <Alias>` (that one pattern alone, so neither
        `Host hcw-lab-old` nor `Host hcw-lab other` is ours) through its last
        option line before the next Host or Match line. Blank and comment
        lines after that last option are left in place, because they usually
        introduce the next block.

        Present: the first block is replaced where it stands and any later
        duplicates are removed. Absent: the block goes before the first Host
        or Match line (and before the comment lines directly above it), so the
        global options at the top of the file stay global and a later
        `Host *` cannot override it; ssh keeps the first value it reads. With
        no Host or Match line at all, it is appended.

        Every other line is kept, and the file's own newline style is kept.
        When the file already holds exactly this block, Content comes back as
        the input, byte for byte, with Action 'Unchanged'.
    #>
    [OutputType([pscustomobject])]
    param(
        [AllowEmptyString()] [string] $Content = '',
        [Parameter(Mandatory)] [string] $Alias,
        [Parameter(Mandatory)] [string[]] $Block
    )

    $newLine = if ($Content.Contains("`r`n")) { "`r`n" } else { "`n" }
    # A trailing newline splits into a final empty element, which the join at
    # the end turns back into that newline. Assigned in two steps on purpose:
    # an `if` expression unrolls an empty array to $null and hands a
    # non-empty one back as object[], which List[string]::new() rejects.
    $original = [string[]]@()
    if ($Content.Length -gt 0) {
        $original = [string[]]($Content -split '\r?\n')
    }
    $hostLine = '^\s*Host(?:\s*=\s*|\s+)' + [regex]::Escape($Alias) + '\s*$'
    $stanza = '^\s*(?:Host|Match)(?:\s*=|\s)'

    $ranges = [System.Collections.Generic.List[int[]]]::new()
    for ($i = 0; $i -lt $original.Count; $i++) {
        if ($original[$i] -notmatch $hostLine) {
            continue
        }
        $last = $i
        $j = $i + 1
        while ($j -lt $original.Count -and $original[$j] -notmatch $stanza) {
            $trimmed = $original[$j].Trim()
            if ($trimmed.Length -gt 0 -and -not $trimmed.StartsWith('#')) {
                $last = $j
            }
            $j++
        }
        $ranges.Add([int[]]@($i, $last))
        $i = $j - 1
    }

    $result = [System.Collections.Generic.List[string]]::new()
    if ($ranges.Count -eq 0) {
        $action = 'Inserted'
        $first = -1
        for ($i = 0; $i -lt $original.Count; $i++) {
            if ($original[$i] -match $stanza) {
                $first = $i
                break
            }
        }
        if ($first -ge 0) {
            while ($first -gt 0 -and $original[$first - 1].TrimStart().StartsWith('#')) {
                $first--
            }
            for ($i = 0; $i -lt $first; $i++) {
                $result.Add($original[$i])
            }
            if ($first -gt 0 -and $original[$first - 1].Trim().Length -gt 0) {
                $result.Add('')
            }
            $result.AddRange($Block)
            $result.Add('')
            for ($i = $first; $i -lt $original.Count; $i++) {
                $result.Add($original[$i])
            }
        }
        else {
            $body = [System.Collections.Generic.List[string]]::new([string[]]$original)
            if ($body.Count -gt 0 -and $body[$body.Count - 1] -eq '') {
                $body.RemoveAt($body.Count - 1)
            }
            $result.AddRange($body)
            if ($result.Count -gt 0 -and $result[$result.Count - 1].Trim().Length -gt 0) {
                $result.Add('')
            }
            $result.AddRange($Block)
            $result.Add('')
        }
    }
    else {
        $action = 'Replaced'
        $next = 0
        for ($r = 0; $r -lt $ranges.Count; $r++) {
            for ($i = $next; $i -lt $ranges[$r][0]; $i++) {
                $result.Add($original[$i])
            }
            if ($r -eq 0) {
                $result.AddRange($Block)
            }
            $next = $ranges[$r][1] + 1
        }
        for ($i = $next; $i -lt $original.Count; $i++) {
            $result.Add($original[$i])
        }
    }

    if (($result -join "`n") -ceq ($original -join "`n")) {
        return [pscustomobject]@{ Action = 'Unchanged'; Content = $Content; DuplicatesRemoved = 0 }
    }
    return [pscustomobject]@{
        Action            = $action
        Content           = ($result -join $newLine)
        DuplicatesRemoved = [Math]::Max(0, $ranges.Count - 1)
    }
}

function New-LabSshDirectory {
    <#
    .SYNOPSIS
        Creates the directory if it is missing; mode 700 outside Windows,
        which ssh expects of ~/.ssh.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [string] $Path)

    if (Test-Path -LiteralPath $Path -PathType Container) {
        return
    }
    if ($PSCmdlet.ShouldProcess($Path, 'Create directory')) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        if (-not $IsWindows) {
            & chmod 700 $Path
        }
    }
}

function Update-LabSshConfig {
    <#
    .SYNOPSIS
        Applies Merge-LabSshHostBlock to the file at Path. Writes only when
        the text changes, and copies the old file to Path.bak-<timestamp>
        first. Returns what it did.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Alias,
        [Parameter(Mandatory)] [string[]] $Block,
        [datetime] $Now = (Get-Date)
    )

    $exists = Test-Path -LiteralPath $Path -PathType Leaf
    $current = if ($exists) { [System.IO.File]::ReadAllText($Path) } else { '' }
    $merge = Merge-LabSshHostBlock -Content $current -Alias $Alias -Block $Block

    $backup = $null
    $written = $false
    $verb = if ($merge.Action -eq 'Inserted') { 'Insert' } else { 'Replace' }
    if ($merge.Action -ne 'Unchanged' -and $PSCmdlet.ShouldProcess($Path, ($verb + ' the Host ' + $Alias + ' block'))) {
        New-LabSshDirectory -Path (Split-Path -Parent $Path)
        if ($exists) {
            $backup = $Path + '.bak-' + $Now.ToString('yyyyMMdd-HHmmss', [cultureinfo]::InvariantCulture)
            Copy-Item -LiteralPath $Path -Destination $backup
        }
        [System.IO.File]::WriteAllText($Path, $merge.Content, [System.Text.UTF8Encoding]::new($false))
        $written = $true
    }
    return [pscustomobject]@{
        Action            = $merge.Action
        Written           = $written
        Backup            = $backup
        DuplicatesRemoved = $merge.DuplicatesRemoved
    }
}

function Resolve-LabHostName {
    <#
    .SYNOPSIS
        The repository variable when gh can read it, otherwise Default, with
        the reason. Read-only: it runs `gh auth status` and
        `gh variable get` and nothing else.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $Repository,
        [Parameter(Mandatory)] [string] $Variable,
        [Parameter(Mandatory)] [string] $Default
    )

    if (-not (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ HostName = $Default; Source = 'the default; gh is not installed' }
    }
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ HostName = $Default; Source = 'the default; gh is not signed in (gh auth login)' }
    }
    $value = (& gh variable get $Variable -R $Repository 2> $null) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
        return [pscustomobject]@{ HostName = $Default; Source = "the default; $Variable is not set on $Repository" }
    }
    return [pscustomobject]@{ HostName = $value.Trim(); Source = "the $Variable variable on $Repository" }
}

function Get-LabKeyFingerprint {
    <#
    .SYNOPSIS
        The SHA256 fingerprint of a public key file, as ssh-add -l prints it,
        or $null.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $PublicKeyPath)

    $line = (& ssh-keygen -l -f $PublicKeyPath 2> $null) -join ' '
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($line)) {
        return $null
    }
    return (-split $line)[1]
}

function Get-LabAuthorizeCommand {
    <#
    .SYNOPSIS
        The one PowerShell line that authorizes PublicKey from a machine that
        already reaches the host.

    .DESCRIPTION
        It appends the key to the login user's authorized_keys, which takes
        effect at once and lasts until the next bootstrap.sh run: the
        hardening role writes hcwadmin's authorized_keys from
        hardening_admin_authorized_keys in lab-host/ansible/group_vars/all.yml
        alone, and keeps root's empty (#953). So the key lasts only once its
        line is in that list (Get-LabGroupVarsKeyLine). Nothing is written for
        root. grep -qxF makes the line safe to repeat. The key comment is kept
        only when it is plain text, so the single quotes around it cannot be
        broken out of.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $PublicKey,
        [Parameter(Mandatory)] [string] $Alias
    )

    $fields = @(-split $PublicKey)
    $key = ($fields | Select-Object -First 2) -join ' '
    $comment = ($fields | Select-Object -Skip 2) -join ' '
    if ($comment -match '\A[A-Za-z0-9 ._@-]+\z') {
        $key = $key + ' ' + $comment
    }
    $remote = "grep -qxF '`$k' ~/.ssh/authorized_keys || echo '`$k' >> ~/.ssh/authorized_keys"
    return "`$k = '$key'; ssh $Alias `"$remote`""
}

function Get-LabGroupVarsKeyLine {
    <#
    .SYNOPSIS
        The line that pins PublicKey under hardening_admin_authorized_keys in
        lab-host/ansible/group_vars/all.yml.

    .DESCRIPTION
        A YAML list item holding the key's type and key and no comment, which
        is how the list holds keys (owner decision 2026-10-16, #953). The
        hardening role writes hcwadmin's authorized_keys from that list alone
        on every bootstrap.sh run, so this line is what makes a key last.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $PublicKey)

    $fields = @(-split $PublicKey)
    return '  - ' + (($fields | Select-Object -First 2) -join ' ')
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

$alias = 'hcw-lab'
$repository = 'saulpatinojr/HCW-HybridCloudWorks'
$variable = 'LAB_SSH_HOST'
$remoteFolder = '/opt/hcw-src'
$changes = [System.Collections.Generic.List[string]]::new()

foreach ($tool in 'ssh', 'ssh-keygen', 'ssh-add') {
    if (-not (Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue)) {
        $hint = if ($IsWindows) {
            ' Install the OpenSSH client from PowerShell opened with Run as administrator: Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
        }
        else {
            ' Install the OpenSSH client with the system package manager.'
        }
        throw "$tool is not on PATH.$hint"
    }
}

if (-not $PSBoundParameters.ContainsKey('HostName')) {
    $resolved = Resolve-LabHostName -Repository $repository -Variable $variable -Default 'lab.hybridcloudworks.com'
    $HostName = $resolved.HostName
    Write-Host "Host name: $HostName, from $($resolved.Source)."
}
else {
    Write-Host "Host name: $HostName, from -HostName."
}
if (-not (Test-LabHostName -Name $HostName)) {
    throw "'$HostName' is not a host name or IPv4 address. Letters, digits, dots and hyphens only."
}

$KeyPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($KeyPath)
if ($KeyPath.EndsWith('.pub', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "-KeyPath names the private key; drop the .pub from '$KeyPath'."
}
$publicKeyPath = $KeyPath + '.pub'

# 1. The key.
if (Test-Path -LiteralPath $KeyPath -PathType Leaf) {
    Write-Host "Key: $KeyPath already exists; left as it is."
    if (-not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
        throw "The public half, $publicKeyPath, is missing. ssh-keygen can rebuild it from the private key (it asks for the passphrase): ssh-keygen -y -f `"$KeyPath`" > `"$publicKeyPath`""
    }
}
else {
    $machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [System.Environment]::MachineName }
    Write-Host "Key: creating $KeyPath for this machine."
    Write-Host '  ssh-keygen asks for a passphrase twice (enter it, then confirm it). A passphrase protects the key if this machine is lost, and ssh-agent remembers it after one entry; Enter twice means none.'
    if ($PSCmdlet.ShouldProcess($KeyPath, 'Create an ed25519 key with ssh-keygen')) {
        New-LabSshDirectory -Path (Split-Path -Parent $KeyPath)
        & ssh-keygen -t ed25519 -f $KeyPath -C "$machine hcw-lab"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
            throw "ssh-keygen exited $LASTEXITCODE and $publicKeyPath does not exist. Nothing else was changed."
        }
        $changes.Add("created the key $KeyPath")
    }
}

# 2. The Host block.
$configPath = Join-Path $HOME '.ssh' 'config'
$block = Get-LabSshHostBlock -Alias $alias -HostName $HostName -User $User -IdentityFile $KeyPath
$update = Update-LabSshConfig -Path $configPath -Alias $alias -Block $block
if ($update.Action -eq 'Unchanged') {
    Write-Host "SSH config: the Host $alias block in $configPath is already current."
}
elseif ($update.Written) {
    $what = $update.Action.ToLowerInvariant() + " the Host $alias block in $configPath"
    if ($update.DuplicatesRemoved -gt 0) {
        $what += " and removed $($update.DuplicatesRemoved) duplicate block(s)"
    }
    Write-Host ('SSH config: ' + $what + '.')
    if ($update.Backup) {
        Write-Host "  The previous file is saved as $($update.Backup)."
    }
    $changes.Add($what)
}

# 3. The agent. Without it, every connection asks for the key's passphrase;
# nothing else depends on it.
$agentReady = $true
if ($IsWindows) {
    $service = Get-Service -Name ssh-agent -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        Write-Host 'ssh-agent: there is no ssh-agent service on this machine; skipping the agent.'
        $agentReady = $false
    }
    elseif ($service.Status -eq 'Running') {
        Write-Host 'ssh-agent: the Windows service is running.'
    }
    elseif ($service.StartType -eq 'Disabled') {
        Write-Host 'ssh-agent: the Windows service is installed but disabled, which is how Windows ships it. To use it, run this once in PowerShell opened with Run as administrator, then run this script again:'
        Write-Host '  Set-Service -Name ssh-agent -StartupType Automatic; Start-Service -Name ssh-agent'
        $agentReady = $false
    }
    elseif ($PSCmdlet.ShouldProcess('ssh-agent', 'Start the Windows service')) {
        try {
            Start-Service -Name ssh-agent
            Write-Host 'ssh-agent: started the Windows service.'
            $changes.Add('started the ssh-agent service')
        }
        catch {
            Write-Host "ssh-agent: could not start the service: $($_.Exception.Message)"
            Write-Host '  Run this once in PowerShell opened with Run as administrator, then run this script again:'
            Write-Host '  Set-Service -Name ssh-agent -StartupType Automatic; Start-Service -Name ssh-agent'
            $agentReady = $false
        }
    }
    else {
        $agentReady = $false
    }
}

if ($agentReady -and (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
    $fingerprint = Get-LabKeyFingerprint -PublicKeyPath $publicKeyPath
    $loaded = @(& ssh-add -l 2> $null)
    $listExit = $LASTEXITCODE
    if ($listExit -gt 1) {
        Write-Host 'ssh-agent: no agent is reachable from this shell; skipping. Each connection will ask for the passphrase.'
    }
    elseif ($fingerprint -and ($loaded -match [regex]::Escape($fingerprint))) {
        Write-Host 'ssh-agent: the key is already loaded.'
    }
    elseif ($PSCmdlet.ShouldProcess($KeyPath, 'Load into ssh-agent with ssh-add')) {
        & ssh-add $KeyPath
        if ($LASTEXITCODE -eq 0) {
            $changes.Add('loaded the key into ssh-agent')
        }
        else {
            Write-Host "ssh-agent: ssh-add exited $LASTEXITCODE; the key is not loaded. Each connection will ask for the passphrase."
        }
    }
}

# 4. The public key and how to authorize it.
Write-Host ''
if (Test-Path -LiteralPath $publicKeyPath -PathType Leaf) {
    $publicKey = ([System.IO.File]::ReadAllText($publicKeyPath)).Trim()
    Write-Host "Public key ($publicKeyPath; safe to share, the private key stays on this machine):"
    Write-Host ''
    Write-Host $publicKey
    Write-Host ''
    Write-Host 'Authorize it on the host. The keys that may log in are the list hardening_admin_authorized_keys in'
    Write-Host 'lab-host/ansible/group_vars/all.yml; every bootstrap.sh run writes hcwadmin''s keys from it alone.'
    Write-Host 'So a key lasts once this line is in that list, merged, and bootstrap.sh has run:'
    Write-Host ''
    Write-Host (Get-LabGroupVarsKeyLine -PublicKey $publicKey)
    Write-Host ''
    Write-Host '  The first key for a reinstalled server: open https://hpanel.hostinger.com/vps, choose Manage on the'
    Write-Host '  server, then Settings, SSH keys, Add SSH key, and paste the public key above. bootstrap.sh refuses'
    Write-Host '  to run unless that key is also in the list.'
    Write-Host ''
    Write-Host '  To use this machine before then, while another machine already reaches the host: run this there,'
    Write-Host '  in PowerShell. It adds the key for hcwadmin until the next bootstrap.sh run:'
    Write-Host ''
    Write-Host ('  ' + (Get-LabAuthorizeCommand -PublicKey $publicKey -Alias $alias))
    Write-Host ''
    Write-Host "Then, here: ssh $alias hostname"
    Write-Host '  Success prints the server''s host name. The first connection asks you to accept the host key.'
}
else {
    Write-Host "Public key: $publicKeyPath does not exist yet (-WhatIf), so there is nothing to print."
}
if ($User -eq 'root') {
    Write-Host ''
    Write-Host 'User is root: right for the window before the first bootstrap.sh run. That run turns root login off; run this script again without -User afterwards.'
}

Write-Host ''
if ($WhatIfPreference) {
    Write-Host 'WhatIf: nothing was changed.'
}
elseif ($changes.Count -eq 0) {
    Write-Host "No changes: this machine was already set up for $alias."
}
else {
    Write-Host ('Changed: ' + ($changes -join '; ') + '.')
}

# 5. Optional: open VS Code, then a shell. Code returns at once, so both work
# together.
if ($Code) {
    if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
        Write-Host 'VS Code: `code` is not on PATH. In VS Code, run "Shell Command: Install ''code'' command in PATH" from the Command Palette (macOS), or reinstall with the PATH option (Windows).'
    }
    elseif ($PSCmdlet.ShouldProcess("$alias`:$remoteFolder", 'Open in VS Code Remote-SSH')) {
        & code --remote "ssh-remote+$alias" $remoteFolder
    }
}
if ($Connect -and $PSCmdlet.ShouldProcess($alias, 'Open an SSH session')) {
    & ssh $alias
}

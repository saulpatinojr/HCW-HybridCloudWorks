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

    With -Arc the block reaches the host through Azure Arc SSH instead of
    port 22 (#953): see -Arc. Without it the block connects directly, which
    stays the fallback until port 22 closes.

    The procedure around it, including the hPanel step for a first key, is
    docs/runbooks/labs-host.md, "Connect from a desktop".

.PARAMETER HostName
    What `hcw-lab` resolves to. Defaults to the LAB_SSH_HOST variable of
    saulpatinojr/HCW-HybridCloudWorks when gh is installed, signed in and
    the variable is set; otherwise lab.hybridcloudworks.com. That record exists
    only after the hcw-lab Terraform apply, so until then set the variable (or
    pass this) to the server's IPv4 address. With -Arc this is the name the
    host's key is checked under (HostKeyAlias), so the key a direct
    connection already accepted is the one an Arc connection must present.

.PARAMETER User
    hcwadmin, the login the hardening role creates, or root for the window
    between an OS install and the first bootstrap.sh run. That run turns root
    login off, so run this again without -User once it has finished. -Arc
    takes hcwadmin only.

.PARAMETER Arc
    Reach the host through Azure Arc SSH (docs/runbooks/labs-host.md, "Connect
    through Azure Arc"). Before it changes anything it checks, read-only,
    that az is installed and signed in, that the az ssh extension is
    installed (`az extension add --name ssh` when it is not), and that the
    Arc machine's SSH service configuration exists, which the hcw-azure apply
    creates. It then writes ~/.ssh/hcw-lab-arc-proxy.ps1, a helper Windows
    PowerShell 5.1 can run, and asks Azure once for relay credentials through
    it, which also downloads the az ssh extension's proxy. Only when that
    works does it replace the Host block, with a ProxyCommand that runs the
    helper. The helper asks `az ssh config` for FRESH relay credentials on
    every connection (they last an hour at most), in a private temporary
    folder it deletes, and hands ssh's own standard input and output to the
    extension's proxy, so `ssh hcw-lab`, piped commands, `ssh -t`, `ssh -L`
    and VS Code Remote-SSH work as they do directly, from PowerShell and Git
    Bash alike. Run without -Arc to put the direct block back.

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

.EXAMPLE
    ./scripts/lab/Connect-Lab.ps1 -Arc
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $HostName,

    [ValidateSet('hcwadmin', 'root')]
    [string] $User = 'hcwadmin',

    [string] $KeyPath = (Join-Path $HOME '.ssh' 'hcw-lab_ed25519'),

    [switch] $Connect,

    [switch] $Code,

    [switch] $Arc
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

    .DESCRIPTION
        With ProxyCommand (-Arc), HostName is the Arc machine's name, which
        ssh only hands to known_hosts, and HostKeyAlias is the direct host
        name, so the host key a direct connection already accepted is the
        one checked through Arc too. ProxyCommand is written last and as
        given; Get-LabArcProxyCommand builds it.
    #>
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string] $Alias,
        [Parameter(Mandatory)] [string] $HostName,
        [Parameter(Mandatory)] [string] $User,
        [Parameter(Mandatory)] [string] $IdentityFile,
        [string] $ProxyCommand,
        [string] $HostKeyAlias
    )

    $identity = $IdentityFile -replace '\\', '/'
    if ($identity -match '\s') {
        $identity = '"' + $identity + '"'
    }
    if (-not $ProxyCommand) {
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
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("Host $Alias")
    $lines.Add('    # Written by scripts/lab/Connect-Lab.ps1 -Arc: through Azure Arc SSH. Run it again to change this block, or without -Arc for the direct path.')
    $lines.Add("    HostName $HostName")
    if ($HostKeyAlias) {
        $lines.Add("    HostKeyAlias $HostKeyAlias")
    }
    $lines.Add("    User $User")
    $lines.Add("    IdentityFile $identity")
    $lines.Add('    IdentitiesOnly yes')
    $lines.Add('    ServerAliveInterval 30')
    $lines.Add("    ProxyCommand $ProxyCommand")
    return [string[]]$lines.ToArray()
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
# Azure Arc SSH (#953). The functions from ConvertTo-LabArcArgument through
# Invoke-LabArcProxy are also the ProxyCommand helper: Get-LabArcProxyScript
# copies their text into ~/.ssh/hcw-lab-arc-proxy.ps1, which ssh runs with
# Windows PowerShell 5.1 on Windows. So they use nothing PowerShell 7 added,
# reach nothing else in this file, and stay ASCII (5.1 reads a file without a
# byte order mark as the ANSI code page). Above all they write NOTHING to
# standard output: in the helper, standard output is ssh's connection.
# -----------------------------------------------------------------------------

function ConvertTo-LabArcArgument {
    <#
    .SYNOPSIS
        One argument for a Windows command line: as it is when it holds no
        space, else in double quotes. A quote cannot be passed at all; no
        value this helper builds holds one.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Value)

    if ($Value.Contains('"')) {
        throw "A double quote cannot be passed in an argument here: $Value"
    }
    if ($Value.Length -gt 0 -and $Value -notmatch '\s') {
        return $Value
    }
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}

function Get-LabArcAzArguments {
    <#
    .SYNOPSIS
        The `az ssh config` arguments that write a config for the Arc machine
        into ConfigPath, with relay credentials in a folder beside it. Every
        value is passed, the subscription included, so nothing depends on
        az's default subscription, which other windows share.
    #>
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string] $ResourceGroup,
        [Parameter(Mandatory)] [string] $MachineName,
        [Parameter(Mandatory)] [string] $Subscription,
        [Parameter(Mandatory)] [string] $LocalUser,
        [Parameter(Mandatory)] [int] $Port,
        [Parameter(Mandatory)] [string] $ConfigPath
    )

    return [string[]]@(
        'ssh', 'config',
        '--resource-group', $ResourceGroup,
        '--name', $MachineName,
        '--resource-type', 'Microsoft.HybridCompute/machines',
        '--local-user', $LocalUser,
        '--port', [string]$Port,
        '--file', $ConfigPath,
        '--subscription', $Subscription,
        '--only-show-errors'
    )
}

function Get-LabArcAzHint {
    <#
    .SYNOPSIS
        What to do about a failed az call, from what az wrote to standard
        error: the one command that usually fixes it, or az's own first lines.
    #>
    [OutputType([string])]
    param([AllowEmptyString()] [AllowNull()] [string] $Stderr)

    $text = [string]$Stderr
    if ($text -match "az login|az account|AADSTS|refresh token|expired") {
        return 'az is not signed in, or its sign-in expired. Run: az login'
    }
    if ($text -match "extension" -and $text -match "\bssh\b") {
        return 'The az ssh extension is missing. Run: az extension add --name ssh'
    }
    $first = @($text -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 3) -join ' '
    if (-not $first) {
        $first = 'az wrote nothing to say why.'
    }
    return $first
}

function Get-LabArcProxyLine {
    <#
    .SYNOPSIS
        The program and the rest of the first ProxyCommand line in an ssh
        config, as `az ssh config` writes it for an Arc machine:
        `"<proxy>" -r "<relay info>" -p <port>`. The rest is kept as written,
        a Windows command-line tail, and passed to the proxy unchanged. $null
        when there is no such line.
    #>
    [OutputType([pscustomobject])]
    param([AllowEmptyString()] [string] $ConfigText)

    foreach ($line in ($ConfigText -split '\r?\n')) {
        if ($line -match '^\s*ProxyCommand\s+(\S.*?)\s*$') {
            $command = $Matches[1]
            if ($command -match '^"([^"]+)"\s*(.*)$') {
                return [pscustomobject]@{ Path = $Matches[1]; Arguments = $Matches[2] }
            }
            if ($command -match '^(\S+)\s*(.*)$') {
                return [pscustomobject]@{ Path = $Matches[1]; Arguments = $Matches[2] }
            }
        }
    }
    return $null
}

function Remove-LabArcStaleState {
    <#
    .SYNOPSIS
        Deletes this helper's run folders under Root last written more than
        MaxAgeMinutes ago. A folder holds relay credentials, which last an
        hour at most, and is deleted when its connection ends; this catches
        the folders of connections ssh ended by killing the helper.
    #>
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter(Mandatory)] [datetime] $Now,
        [int] $MaxAgeMinutes = 90
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return
    }
    $cutoff = $Now.ToUniversalTime().AddMinutes(-$MaxAgeMinutes)
    foreach ($folder in @(Get-ChildItem -LiteralPath $Root -Directory -Filter 'run-*' -ErrorAction SilentlyContinue)) {
        if ($folder.LastWriteTimeUtc -lt $cutoff) {
            Remove-Item -LiteralPath $folder.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-LabArcMessage {
    <#
    .SYNOPSIS
        One line to standard error, which ssh shows; never standard output,
        which is the connection. The seam the tests mock.
    #>
    param([Parameter(Mandatory)] [string] $Message)

    [Console]::Error.WriteLine('hcw-lab (Arc): ' + $Message)
}

function Resolve-LabArcAz {
    <#
    .SYNOPSIS
        The full path of az, or $null. az.cmd first: on Windows the CLI's
        folder also holds `az`, a shell script for Git Bash, which Windows
        cannot start. The seam the tests mock.
    #>
    [OutputType([string])]
    param()

    foreach ($name in @('az.cmd', 'az')) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) {
            return $command.Path
        }
    }
    return $null
}

function Invoke-LabArcAz {
    <#
    .SYNOPSIS
        Runs az with its standard input closed and both outputs captured, and
        returns the exit code and the two texts. Closed input means a prompt
        fails rather than reading ssh's connection, and captured output means
        nothing az prints reaches it. The seam the tests mock.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $AzPath,
        [Parameter(Mandatory)] [string[]] $Arguments
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $AzPath
    $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-LabArcArgument -Value $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.Result; Stderr = $stderr.Result }
}

function Start-LabArcProxyProcess {
    <#
    .SYNOPSIS
        Starts the extension's proxy on THIS process's standard input, output
        and error, which in the helper are ssh's ProxyCommand pipes, waits for
        it and returns its exit code. Nothing is redirected, and the proxy is
        not started through PowerShell's own native-command handling, so the
        connection's bytes pass between ssh and the proxy without this
        process reading or re-encoding them. The seam the tests mock.
    #>
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [AllowEmptyString()] [string] $Arguments = ''
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Path
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    return $process.ExitCode
}

function Invoke-LabArcProxy {
    <#
    .SYNOPSIS
        The ProxyCommand: fresh relay credentials from `az ssh config`, then
        the extension's proxy on ssh's pipes. Returns an exit code, 0 when
        the proxy ended cleanly; every message goes to standard error.

    .DESCRIPTION
        Each connection gets its own run folder under StateRoot, in the
        user's temporary folder, and az writes the config and the relay
        credentials (an access key for this machine's endpoint, an hour at
        most) into it. The folder is deleted when the proxy exits, and
        folders older than 90 minutes are deleted at every start, for
        connections ssh ended by killing this process.

        With -Check it stops once the credentials are issued and the proxy is
        on disk, and says so: Connect-Lab.ps1 -Arc runs that once before it
        changes the Host block, which also downloads the proxy.
    #>
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [string] $ResourceGroup,
        [Parameter(Mandatory)] [string] $MachineName,
        [Parameter(Mandatory)] [string] $Subscription,
        [Parameter(Mandatory)] [string] $LocalUser,
        [int] $Port = 22,
        [switch] $Check,
        [string] $StateRoot = ''
    )

    if (-not $StateRoot) {
        $StateRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'hcw-lab-arc'
    }
    Remove-LabArcStaleState -Root $StateRoot -Now (Get-Date)
    $az = Resolve-LabArcAz
    if (-not $az) {
        Write-LabArcMessage -Message 'az is not on PATH, and Arc SSH needs it. Install the Azure CLI (winget install --exact --id Microsoft.AzureCLI), or reach the host directly: run scripts/lab/Connect-Lab.ps1 without -Arc.'
        return 1
    }
    $run = Join-Path $StateRoot ('run-' + [guid]::NewGuid().ToString('n'))
    $null = New-Item -ItemType Directory -Path $run -Force
    try {
        $config = Join-Path $run 'config'
        $arguments = Get-LabArcAzArguments -ResourceGroup $ResourceGroup -MachineName $MachineName -Subscription $Subscription -LocalUser $LocalUser -Port $Port -ConfigPath $config
        $result = Invoke-LabArcAz -AzPath $az -Arguments $arguments
        if ($result.ExitCode -ne 0) {
            Write-LabArcMessage -Message ("az ssh config failed (exit " + $result.ExitCode + "): " + (Get-LabArcAzHint -Stderr $result.Stderr))
            return 1
        }
        if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
            Write-LabArcMessage -Message 'az ssh config succeeded but wrote no config file, so there is no relay to connect through.'
            return 1
        }
        $proxy = Get-LabArcProxyLine -ConfigText ([System.IO.File]::ReadAllText($config))
        if ($null -eq $proxy) {
            Write-LabArcMessage -Message ("az ssh config wrote no ProxyCommand for " + $MachineName + ". Is it an Arc machine in " + $ResourceGroup + "?")
            return 1
        }
        if (-not (Test-Path -LiteralPath $proxy.Path -PathType Leaf)) {
            Write-LabArcMessage -Message ("The relay proxy az named is not on disk: " + $proxy.Path)
            return 1
        }
        if ($Check) {
            Write-LabArcMessage -Message ("relay credentials issued for " + $MachineName + "; proxy " + $proxy.Path + ".")
            return 0
        }
        return (Start-LabArcProxyProcess -Path $proxy.Path -Arguments $proxy.Arguments)
    }
    finally {
        Remove-Item -LiteralPath $run -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-LabArcProxyScript {
    <#
    .SYNOPSIS
        The text of ~/.ssh/hcw-lab-arc-proxy.ps1: the relay functions above,
        copied from their definitions, and a call to Invoke-LabArcProxy with
        the parameters the ProxyCommand passes. Refuses a non-ASCII result.
    #>
    [OutputType([string])]
    param()

    $names = @(
        'ConvertTo-LabArcArgument',
        'Get-LabArcAzArguments',
        'Get-LabArcAzHint',
        'Get-LabArcProxyLine',
        'Remove-LabArcStaleState',
        'Write-LabArcMessage',
        'Resolve-LabArcAz',
        'Invoke-LabArcAz',
        'Start-LabArcProxyProcess',
        'Invoke-LabArcProxy'
    )
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('# hcw-lab-arc-proxy.ps1: the ProxyCommand of Host hcw-lab in ~/.ssh/config, for')
    $lines.Add('# Azure Arc SSH (#953). Written by scripts/lab/Connect-Lab.ps1 -Arc from its own')
    $lines.Add('# functions; run that again to rewrite this file rather than editing it.')
    $lines.Add('# ssh runs it with Windows PowerShell 5.1 on Windows. Standard output is the')
    $lines.Add('# connection itself, so it writes nothing there; messages go to standard error.')
    $lines.Add('param(')
    $lines.Add('    [Parameter(Mandatory)] [string] $ResourceGroup,')
    $lines.Add('    [Parameter(Mandatory)] [string] $MachineName,')
    $lines.Add('    [Parameter(Mandatory)] [string] $Subscription,')
    $lines.Add('    [Parameter(Mandatory)] [string] $LocalUser,')
    $lines.Add('    [int] $Port = 22')
    $lines.Add(')')
    $lines.Add('Set-StrictMode -Version 2.0')
    $lines.Add('$ErrorActionPreference = ''Stop''')
    $lines.Add('$ProgressPreference = ''SilentlyContinue''')
    foreach ($name in $names) {
        $body = (Get-Command -Name $name -CommandType Function).ScriptBlock.ToString()
        $lines.Add('function ' + $name + ' {' + $body + '}')
    }
    $lines.Add('try {')
    $lines.Add('    $code = Invoke-LabArcProxy -ResourceGroup $ResourceGroup -MachineName $MachineName -Subscription $Subscription -LocalUser $LocalUser -Port $Port')
    $lines.Add('}')
    $lines.Add('catch {')
    $lines.Add('    [Console]::Error.WriteLine(''hcw-lab (Arc): '' + $_.Exception.Message)')
    $lines.Add('    $code = 1')
    $lines.Add('}')
    $lines.Add('exit $code')
    $text = ($lines -join "`n") + "`n"
    if ($text -match '[^\x00-\x7F]') {
        throw 'The Arc proxy helper would carry a non-ASCII character, which Windows PowerShell 5.1 misreads in a file without a byte order mark.'
    }
    return $text
}

function Get-LabArcProxyCommand {
    <#
    .SYNOPSIS
        The ProxyCommand line for Arc mode: the helper, run by ShellPath
        (Windows PowerShell 5.1 on Windows), with the machine to reach.

    .DESCRIPTION
        Written so that both ssh clients a Windows desktop has run it the
        same way: Windows OpenSSH starts the line as a command line, and Git
        Bash's ssh hands it to sh -c, where a double-quoted Windows path
        keeps its backslashes. A path holding a double quote, a dollar sign
        or a backtick is refused, because sh would read it; a percent sign
        is doubled, because ssh expands %-tokens in ProxyCommand. The four
        names are refused unless plain.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $ShellPath,
        [Parameter(Mandatory)] [string] $HelperPath,
        [Parameter(Mandatory)] [string] $ResourceGroup,
        [Parameter(Mandatory)] [string] $MachineName,
        [Parameter(Mandatory)] [string] $Subscription,
        [Parameter(Mandatory)] [string] $User,
        [int] $Port = 22
    )

    foreach ($name in @($ResourceGroup, $MachineName, $Subscription, $User)) {
        if ($name -notmatch '\A[A-Za-z0-9._-]+\z') {
            throw "'$name' cannot go into a ProxyCommand: letters, digits, dots, hyphens and underscores only."
        }
    }
    foreach ($path in @($ShellPath, $HelperPath)) {
        if ($path -match '["$`\r\n]') {
            throw "'$path' cannot go into a ProxyCommand: it holds a double quote, a dollar sign, a backtick or a line break."
        }
    }
    $shell = '"' + ($ShellPath -replace '%', '%%') + '"'
    $helper = '"' + ($HelperPath -replace '%', '%%') + '"'
    return "$shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -ResourceGroup $ResourceGroup -MachineName $MachineName -Subscription $Subscription -LocalUser $User -Port $Port"
}

function Test-LabArcPrerequisites {
    <#
    .SYNOPSIS
        Whether this desktop and Azure are ready for Arc mode, read-only: the
        az ssh extension is installed, az is signed in and sees the
        subscription, and the Arc machine's SSH service configuration exists
        on port 22. Returns the first problem and the one command that fixes
        it, if there is one.

    .DESCRIPTION
        The service configuration is read rather than left to the extension
        because the extension creates a missing one itself, outside
        Terraform, and the hcw-azure apply that declares it
        (infra/lab-hybrid.tf) would then fail on a resource that already
        exists.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $AzPath,
        [Parameter(Mandatory)] [string] $Subscription,
        [Parameter(Mandatory)] [string] $ResourceGroup,
        [Parameter(Mandatory)] [string] $MachineName
    )

    $extension = Invoke-LabArcAz -AzPath $AzPath -Arguments @('extension', 'show', '--name', 'ssh', '-o', 'none', '--only-show-errors')
    if ($extension.ExitCode -ne 0) {
        return [pscustomobject]@{ Ready = $false; Problem = 'The az ssh extension is not installed on this desktop, and Arc SSH runs through it.'; Command = 'az extension add --name ssh' }
    }
    $account = Invoke-LabArcAz -AzPath $AzPath -Arguments @('account', 'show', '--subscription', $Subscription, '--query', 'id', '-o', 'tsv', '--only-show-errors')
    $subscriptionId = ([string]$account.Stdout).Trim()
    if ($account.ExitCode -ne 0 -or $subscriptionId -notmatch '\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z') {
        return [pscustomobject]@{ Ready = $false; Problem = "az is not signed in, or this account cannot see $Subscription."; Command = 'az login' }
    }
    $url = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.HybridCompute/machines/$MachineName/providers/Microsoft.HybridConnectivity/endpoints/default/serviceConfigurations/SSH?api-version=2024-12-01"
    $read = Invoke-LabArcAz -AzPath $AzPath -Arguments @('rest', '--method', 'get', '--url', $url, '-o', 'json', '--only-show-errors')
    if ($read.ExitCode -ne 0) {
        if ([string]$read.Stderr -match 'NotFound|\b404\b') {
            return [pscustomobject]@{ Ready = $false; Problem = "$MachineName has no SSH service configuration yet. The hcw-azure run after #953 creates it (infra/lab-hybrid.tf); confirm that run first. Connecting before it would let the az ssh extension create one outside Terraform, and that run would then fail."; Command = $null }
        }
        return [pscustomobject]@{ Ready = $false; Problem = 'Reading the SSH service configuration failed: ' + (Get-LabArcAzHint -Stderr $read.Stderr); Command = $null }
    }
    $port = $null
    try {
        $port = (($read.Stdout | ConvertFrom-Json).properties).port
    }
    catch {
        $port = $null
    }
    if ([string]$port -ne '22') {
        return [pscustomobject]@{ Ready = $false; Problem = "The SSH service configuration on $MachineName names port '$port', not 22, so the relay would not reach sshd."; Command = $null }
    }
    return [pscustomobject]@{ Ready = $true; Problem = $null; Command = $null }
}

function Update-LabArcHelper {
    <#
    .SYNOPSIS
        Writes the helper to Path when its text differs, as ASCII with LF
        line endings. Returns 'Written', 'Unchanged', or 'Skipped' under
        -WhatIf.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Content
    )

    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and ([System.IO.File]::ReadAllText($Path) -ceq $Content)) {
        return 'Unchanged'
    }
    if (-not $PSCmdlet.ShouldProcess($Path, 'Write the Arc SSH ProxyCommand helper')) {
        return 'Skipped'
    }
    New-LabSshDirectory -Path (Split-Path -Parent $Path)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.ASCIIEncoding]::new())
    return 'Written'
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

$alias = 'hcw-lab'
$repository = 'saulpatinojr/HCW-HybridCloudWorks'
$variable = 'LAB_SSH_HOST'
$remoteFolder = '/opt/hcw-src'
$changes = [System.Collections.Generic.List[string]]::new()
# Arc mode's target, as infra/lab-hybrid.tf and lab-host/ansible/group_vars
# name it (arc_resource_group, arc_resource_name); scripts/lab-host-arc-ssh.test.mjs
# holds the three together.
$arcResourceGroup = 'rg-lab-hybrid-prod-cus'
$arcMachineName = 'arcs-lab-hybrid-prod-cus-01'
$arcSubscription = 'sub-app-site-prod-cus'
$arcHelperPath = Join-Path $HOME '.ssh' 'hcw-lab-arc-proxy.ps1'

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

# Arc mode's reads, before anything changes: a desktop or an estate that is
# not ready is told what to run, and keeps the block it has.
$azPath = $null
if ($Arc) {
    if ($User -ne 'hcwadmin') {
        throw '-Arc logs in as hcwadmin, the only login sshd accepts once bootstrap.sh has run; drop -User.'
    }
    $azPath = Resolve-LabArcAz
    if (-not $azPath) {
        throw 'az is not on PATH, and -Arc needs the Azure CLI. Install it in PowerShell with: winget install --exact --id Microsoft.AzureCLI. Then sign in with az login and run this again. Nothing was changed.'
    }
    $ready = Test-LabArcPrerequisites -AzPath $azPath -Subscription $arcSubscription -ResourceGroup $arcResourceGroup -MachineName $arcMachineName
    if (-not $ready.Ready) {
        $fix = if ($ready.Command) { " Run this in PowerShell, then run this script again: $($ready.Command)" } else { '' }
        throw "Arc SSH is not ready: $($ready.Problem)$fix Nothing was changed; the direct path still works."
    }
    Write-Host "Arc: the az ssh extension is installed, az is signed in, and $arcMachineName has its SSH service configuration on port 22."
    Write-Host "Host key: checked under $HostName, the name a direct connection used, so the key accepted there is the one Arc must present."
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

# 2. The Host block. In Arc mode, first the helper the ProxyCommand runs, and
# one relay check through it: only a desktop that has been seen to get relay
# credentials loses its direct block.
$configPath = Join-Path $HOME '.ssh' 'config'
if ($Arc) {
    $helper = Update-LabArcHelper -Path $arcHelperPath -Content (Get-LabArcProxyScript)
    if ($helper -eq 'Written') {
        Write-Host "Arc helper: wrote $arcHelperPath."
        $changes.Add("wrote the Arc helper $arcHelperPath")
    }
    elseif ($helper -eq 'Unchanged') {
        Write-Host "Arc helper: $arcHelperPath is already current."
    }
    if ($WhatIfPreference) {
        Write-Host 'Arc relay check: skipped under -WhatIf. A real run asks Azure once for relay credentials, as every connection will, and downloads the az ssh proxy on the first run.'
    }
    else {
        Write-Host 'Arc relay check: asking Azure for relay credentials once, as every connection will. The first run also downloads the az ssh proxy.'
        $checked = Invoke-LabArcProxy -ResourceGroup $arcResourceGroup -MachineName $arcMachineName -Subscription $arcSubscription -LocalUser $User -Port 22 -Check
        if ($checked -ne 0) {
            throw 'The Arc relay check failed, for the reason above. The Host block was not changed, so the direct path still works. Fix that and run this again.'
        }
    }
    $arcShell = if ($IsWindows) { Join-Path $env:SystemRoot 'System32' 'WindowsPowerShell' 'v1.0' 'powershell.exe' } else { (Get-Process -Id $PID).Path }
    if (-not (Test-Path -LiteralPath $arcShell -PathType Leaf)) {
        $arcShell = (Get-Process -Id $PID).Path
    }
    $proxyCommand = Get-LabArcProxyCommand -ShellPath $arcShell -HelperPath $arcHelperPath -ResourceGroup $arcResourceGroup -MachineName $arcMachineName -Subscription $arcSubscription -User $User -Port 22
    $block = Get-LabSshHostBlock -Alias $alias -HostName $arcMachineName -User $User -IdentityFile $KeyPath -ProxyCommand $proxyCommand -HostKeyAlias $HostName
}
else {
    $block = Get-LabSshHostBlock -Alias $alias -HostName $HostName -User $User -IdentityFile $KeyPath
}
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
    if ($Arc) {
        Write-Host '  Success prints the server''s host name, after a few seconds while az fetches relay credentials, which it does on every connection. It asks to accept the host key only if no direct connection accepted it under that name first.'
        Write-Host '  If it fails, the lines starting "hcw-lab (Arc):" say why. Without -Arc, this script puts the direct block back.'
    }
    else {
        Write-Host '  Success prints the server''s host name. The first connection asks you to accept the host key.'
    }
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

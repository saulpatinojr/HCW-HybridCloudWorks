<#
    Pester 5 tests for Connect-Lab.ps1's ssh_config rewrite and its Azure Arc
    SSH mode (#953).

    The functions are loaded from the script's syntax tree rather than by
    running or dot-sourcing it, so nothing in the script's main body runs:
    no gh call, no ssh-keygen, no az call, no write under the real ~/.ssh.
    Every file this touches is under Pester's $TestDrive.

    The Arc helper, the file ssh runs as the ProxyCommand, is tested twice:
    its functions against mocked seams, and the generated file itself, run
    the way ssh runs it, against a stand-in az and a stand-in proxy that
    echoes the connection back, so the test sees whether bytes written to the
    helper's standard input come back on its standard output untouched. On
    Windows it runs under Windows PowerShell 5.1 as well, which is what the
    ProxyCommand names there.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester scripts/lab -Output Detailed"
#>

BeforeDiscovery {
    $helperShells = @(@{ Name = 'pwsh'; Shell = (Get-Process -Id $PID).Path })
    if ($IsWindows) {
        $windowsPowerShell = Join-Path $env:SystemRoot 'System32' 'WindowsPowerShell' 'v1.0' 'powershell.exe'
        if (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) {
            $helperShells += @{ Name = 'Windows PowerShell 5.1'; Shell = $windowsPowerShell }
        }
    }
}

BeforeAll {
    $scriptPath = Join-Path $PSScriptRoot 'Connect-Lab.ps1'
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $null, [ref] $parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw "Connect-Lab.ps1 does not parse: $($parseErrors[0].Message)"
    }
    $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }

    $block = Get-LabSshHostBlock -Alias 'hcw-lab' -HostName 'lab.hybridcloudworks.com' -User 'hcwadmin' -IdentityFile 'C:\Users\someone\.ssh\hcw-lab_ed25519'
    $newBlock = Get-LabSshHostBlock -Alias 'hcw-lab' -HostName '203.0.113.10' -User 'root' -IdentityFile 'C:\Users\someone\.ssh\hcw-lab_ed25519'

    function Join-Lines {
        param([string[]] $Lines, [string] $NewLine = "`n")
        return ($Lines -join $NewLine)
    }
}

Describe 'Get-LabSshHostBlock' {
    It 'writes the five options under Host hcw-lab, in order' {
        (Join-Lines $block) | Should -BeExactly (Join-Lines @(
                'Host hcw-lab',
                '    # Written by scripts/lab/Connect-Lab.ps1. Run it again to change this block.',
                '    HostName lab.hybridcloudworks.com',
                '    User hcwadmin',
                '    IdentityFile C:/Users/someone/.ssh/hcw-lab_ed25519',
                '    IdentitiesOnly yes',
                '    ServerAliveInterval 30'
            ))
    }

    It 'quotes an IdentityFile that contains a space' {
        $lines = Get-LabSshHostBlock -Alias 'hcw-lab' -HostName 'h' -User 'hcwadmin' -IdentityFile 'C:\Users\Some One\.ssh\k'
        $lines[4] | Should -Be '    IdentityFile "C:/Users/Some One/.ssh/k"'
    }
}

Describe 'Merge-LabSshHostBlock' {
    It 'inserts the block into an empty file, ending with a newline' {
        $merge = Merge-LabSshHostBlock -Content '' -Alias 'hcw-lab' -Block $block
        $merge.Action | Should -Be 'Inserted'
        $merge.Content | Should -BeExactly ((Join-Lines $block) + "`n")
    }

    It 'inserts before the first Host line and its comment, keeping the global preamble global' {
        $content = Join-Lines @(
            'AddKeysToAgent yes',
            '',
            '# work',
            'Host work',
            '    HostName work.example.com',
            ''
        )
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Action | Should -Be 'Inserted'
        $merge.Content | Should -BeExactly (Join-Lines (@('AddKeysToAgent yes', '') + $block + @('', '# work', 'Host work', '    HostName work.example.com', '')))
    }

    It 'inserts ahead of Host * so the catch-all cannot override it' {
        $content = Join-Lines @('Host *', '    User somebody', '')
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $lines = $merge.Content -split "`n"
        [array]::IndexOf($lines, 'Host hcw-lab') | Should -BeLessThan ([array]::IndexOf($lines, 'Host *'))
    }

    It 'appends to a file that has options but no Host line' {
        $content = Join-Lines @('ServerAliveCountMax 3', '')
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Content | Should -BeExactly (Join-Lines (@('ServerAliveCountMax 3', '') + $block + @('')))
    }

    It 'replaces an existing block in place and leaves every other host untouched' {
        $before = @(
            '# personal',
            'Host github.com',
            '    IdentityFile ~/.ssh/id_github',
            '',
            'Host hcw-lab',
            '    # an old note',
            '    HostName 198.51.100.7',
            '    User root',
            '',
            '# the next one is work',
            'Host work',
            '    HostName work.example.com',
            '    User me',
            ''
        )
        $merge = Merge-LabSshHostBlock -Content (Join-Lines $before) -Alias 'hcw-lab' -Block $newBlock
        $merge.Action | Should -Be 'Replaced'
        $merge.DuplicatesRemoved | Should -Be 0
        $expected = $before[0..3] + $newBlock + $before[8..13]
        $merge.Content | Should -BeExactly (Join-Lines $expected)
    }

    It 'is idempotent: a second merge of its own output changes nothing, byte for byte' {
        $content = Join-Lines @('Host work', '    HostName work.example.com', '')
        $first = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $second = Merge-LabSshHostBlock -Content $first.Content -Alias 'hcw-lab' -Block $block
        $second.Action | Should -Be 'Unchanged'
        $second.Content | Should -BeExactly $first.Content
    }

    It 'returns the input unchanged when the block is current, even without a final newline' {
        $content = Join-Lines (@('Host work', '    HostName work.example.com', '') + $block)
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Action | Should -Be 'Unchanged'
        $merge.Content | Should -BeExactly $content
    }

    It 'keeps CRLF line endings' {
        $content = Join-Lines @('Host work', '    HostName work.example.com', '') -NewLine "`r`n"
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Content | Should -BeExactly (Join-Lines ($block + @('') + @('Host work', '    HostName work.example.com', '')) -NewLine "`r`n")
        ($merge.Content -replace "`r`n", '') | Should -Not -Match "`n"
    }

    It 'leaves exactly one block when the file had two' {
        $content = Join-Lines @('Host hcw-lab', '    User root', '', 'Host work', '    User me', '', 'Host hcw-lab', '    User other', '')
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Action | Should -Be 'Replaced'
        $merge.DuplicatesRemoved | Should -Be 1
        @($merge.Content -split "`n" | Where-Object { $_ -match '^\s*Host\s+hcw-lab\s*$' }).Count | Should -Be 1
        $merge.Content | Should -BeExactly (Join-Lines ($block + @('', 'Host work', '    User me', '', '')))
    }

    It 'does not claim a block for a longer alias or a multi-pattern Host line' {
        $content = Join-Lines @('Host hcw-lab-old', '    User a', '', 'Host hcw-lab other', '    User b', '')
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Action | Should -Be 'Inserted'
        $merge.Content | Should -BeExactly (Join-Lines ($block + @('') + @('Host hcw-lab-old', '    User a', '', 'Host hcw-lab other', '    User b', '')))
    }

    It 'recognises Host=hcw-lab and a lower-case keyword as its block' {
        $content = Join-Lines @('host=hcw-lab', '    User root', '')
        $merge = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $block
        $merge.Action | Should -Be 'Replaced'
        $merge.Content | Should -BeExactly (Join-Lines ($block + @('')))
    }
}

Describe 'Update-LabSshConfig' {
    BeforeEach {
        $config = Join-Path $TestDrive ([guid]::NewGuid().ToString('n')) 'config'
    }

    It 'creates the file and its directory when neither exists, with no backup' {
        $result = Update-LabSshConfig -Path $config -Alias 'hcw-lab' -Block $block
        $result.Action | Should -Be 'Inserted'
        $result.Written | Should -BeTrue
        $result.Backup | Should -BeNullOrEmpty
        [System.IO.File]::ReadAllText($config) | Should -BeExactly ((Join-Lines $block) + "`n")
    }

    It 'backs the old file up before replacing the block, and writes no BOM' {
        $original = Join-Lines @('Host work', '    User me', '', 'Host hcw-lab', '    User root', '')
        New-Item -ItemType Directory -Path (Split-Path -Parent $config) -Force | Out-Null
        [System.IO.File]::WriteAllText($config, $original)
        $now = [datetime]::new(2026, 9, 25, 14, 30, 5)

        $result = Update-LabSshConfig -Path $config -Alias 'hcw-lab' -Block $block -Now $now

        $result.Action | Should -Be 'Replaced'
        $result.Backup | Should -Be ($config + '.bak-20260925-143005')
        [System.IO.File]::ReadAllText($result.Backup) | Should -BeExactly $original
        [System.IO.File]::ReadAllText($config) | Should -BeExactly (Join-Lines (@('Host work', '    User me', '') + $block + @('')))
        $bytes = [System.IO.File]::ReadAllBytes($config)
        $bytes[0] | Should -Not -Be 0xEF
    }

    It 'is idempotent on disk: a second run writes nothing and makes no backup' {
        $null = Update-LabSshConfig -Path $config -Alias 'hcw-lab' -Block $block
        $written = [System.IO.File]::GetLastWriteTimeUtc($config)
        $second = Update-LabSshConfig -Path $config -Alias 'hcw-lab' -Block $block
        $second.Action | Should -Be 'Unchanged'
        $second.Written | Should -BeFalse
        $second.Backup | Should -BeNullOrEmpty
        [System.IO.File]::GetLastWriteTimeUtc($config) | Should -Be $written
        @(Get-ChildItem -LiteralPath (Split-Path -Parent $config) -Filter 'config.bak-*').Count | Should -Be 0
    }

    It 'changes nothing under -WhatIf' {
        $original = Join-Lines @('Host work', '    User me', '')
        New-Item -ItemType Directory -Path (Split-Path -Parent $config) -Force | Out-Null
        [System.IO.File]::WriteAllText($config, $original)
        $result = Update-LabSshConfig -Path $config -Alias 'hcw-lab' -Block $block -WhatIf
        $result.Action | Should -Be 'Inserted'
        $result.Written | Should -BeFalse
        [System.IO.File]::ReadAllText($config) | Should -BeExactly $original
        @(Get-ChildItem -LiteralPath (Split-Path -Parent $config) -Filter 'config.bak-*').Count | Should -Be 0
    }
}

Describe 'Test-LabHostName' {
    It 'accepts <Name>' -ForEach @(
        @{ Name = 'lab.hybridcloudworks.com' },
        @{ Name = 'srv1.hstgr.cloud' },
        @{ Name = '203.0.113.10' }
    ) {
        Test-LabHostName -Name $Name | Should -BeTrue
    }

    It 'rejects <Label>' -ForEach @(
        @{ Label = 'an empty name'; Name = '' },
        @{ Label = 'a space'; Name = 'lab host' },
        @{ Label = 'a trailing newline'; Name = "lab.hybridcloudworks.com`n" },
        @{ Label = 'an embedded option line'; Name = "lab`nProxyCommand calc" },
        @{ Label = 'a leading dash'; Name = '-oProxyCommand=calc' },
        @{ Label = 'a user@ prefix'; Name = 'root@lab.hybridcloudworks.com' },
        @{ Label = 'an empty label'; Name = 'lab..hybridcloudworks.com' }
    ) {
        Test-LabHostName -Name $Name | Should -BeFalse
    }
}

Describe 'Get-LabAuthorizeCommand' {
    It 'writes one PowerShell line that appends the key for the login user only' {
        $line = Get-LabAuthorizeCommand -PublicKey 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample DESKTOP-1 hcw-lab' -Alias 'hcw-lab'
        $line | Should -BeExactly ('$k = ''ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample DESKTOP-1 hcw-lab''; ssh hcw-lab "grep -qxF ''$k'' ~/.ssh/authorized_keys || echo ''$k'' >> ~/.ssh/authorized_keys"')
    }

    It 'never writes root''s authorized_keys, which the playbook keeps empty' {
        $line = Get-LabAuthorizeCommand -PublicKey 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample DESKTOP-1 hcw-lab' -Alias 'hcw-lab'
        $line | Should -Not -Match '/root/'
        $line | Should -Not -Match 'sudo'
    }

    It 'drops a comment that could break out of the single quotes' {
        $line = Get-LabAuthorizeCommand -PublicKey "ssh-ed25519 AAAAC3Example it's-mine" -Alias 'hcw-lab'
        $line | Should -Match "^\`$k = 'ssh-ed25519 AAAAC3Example'; "
    }
}

Describe 'Get-LabGroupVarsKeyLine' {
    It 'writes the group_vars list item with the type and key and no comment' {
        Get-LabGroupVarsKeyLine -PublicKey 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample DESKTOP-1 hcw-lab' |
            Should -BeExactly '  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'
    }

    It 'gives the line group_vars pins for the owner''s workstation key' {
        $groupVars = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..' '..' 'lab-host' 'ansible' 'group_vars' 'all.yml')
        $pinned = [regex]::Match($groupVars, '(?m)^hardening_admin_authorized_keys:\r?\n(?:  #[^\r\n]*\r?\n)*(  - [^\r\n]+)').Groups[1].Value
        $pinned | Should -Not -BeNullOrEmpty
        Get-LabGroupVarsKeyLine -PublicKey ($pinned.Substring(4) + ' DESKTOP-1 hcw-lab') | Should -BeExactly $pinned
    }
}

Describe 'Arc mode: the Host block and its ProxyCommand' {
    BeforeAll {
        $proxyCommand = Get-LabArcProxyCommand -ShellPath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -HelperPath 'C:\Users\someone\.ssh\hcw-lab-arc-proxy.ps1' -ResourceGroup 'rg-lab-hybrid-prod-cus' -MachineName 'arcs-lab-hybrid-prod-cus-01' -Subscription 'sub-app-site-prod-cus' -User 'hcwadmin'
    }

    It 'runs the helper under the named shell with the machine to reach, in the shape az ssh config writes' {
        $proxyCommand | Should -BeExactly '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\someone\.ssh\hcw-lab-arc-proxy.ps1" -ResourceGroup rg-lab-hybrid-prod-cus -MachineName arcs-lab-hybrid-prod-cus-01 -Subscription sub-app-site-prod-cus -LocalUser hcwadmin -Port 22'
    }

    It 'writes the Arc block: the machine as HostName, the direct name as HostKeyAlias, the ProxyCommand last' {
        $lines = Get-LabSshHostBlock -Alias 'hcw-lab' -HostName 'arcs-lab-hybrid-prod-cus-01' -User 'hcwadmin' -IdentityFile 'C:\Users\someone\.ssh\hcw-lab_ed25519' -ProxyCommand $proxyCommand -HostKeyAlias 'lab.hybridcloudworks.com'
        (Join-Lines $lines) | Should -BeExactly (Join-Lines @(
                'Host hcw-lab',
                '    # Written by scripts/lab/Connect-Lab.ps1 -Arc: through Azure Arc SSH. Run it again to change this block, or without -Arc for the direct path.',
                '    HostName arcs-lab-hybrid-prod-cus-01',
                '    HostKeyAlias lab.hybridcloudworks.com',
                '    User hcwadmin',
                '    IdentityFile C:/Users/someone/.ssh/hcw-lab_ed25519',
                '    IdentitiesOnly yes',
                '    ServerAliveInterval 30',
                "    ProxyCommand $proxyCommand"
            ))
    }

    It 'replaces a direct block with the Arc block, and the direct block replaces it back' {
        $arcBlock = Get-LabSshHostBlock -Alias 'hcw-lab' -HostName 'arcs-lab-hybrid-prod-cus-01' -User 'hcwadmin' -IdentityFile 'C:\Users\someone\.ssh\hcw-lab_ed25519' -ProxyCommand $proxyCommand -HostKeyAlias 'lab.hybridcloudworks.com'
        $content = Join-Lines (@('Host work', '    User me', '') + $block + @(''))
        $toArc = Merge-LabSshHostBlock -Content $content -Alias 'hcw-lab' -Block $arcBlock
        $toArc.Action | Should -Be 'Replaced'
        $toArc.Content | Should -BeExactly (Join-Lines (@('Host work', '    User me', '') + $arcBlock + @('')))
        $back = Merge-LabSshHostBlock -Content $toArc.Content -Alias 'hcw-lab' -Block $block
        $back.Content | Should -BeExactly $content
    }

    It 'doubles a percent sign, which ssh would expand, and refuses <Label>' -ForEach @(
        @{ Label = 'a name with a space'; Rg = 'rg lab'; Shell = 'C:\pw.exe' },
        @{ Label = 'a name with a semicolon'; Rg = 'rg;calc'; Shell = 'C:\pw.exe' },
        @{ Label = 'a path with a dollar sign, which sh expands'; Rg = 'rg'; Shell = 'C:\Users\a$b\pw.exe' },
        @{ Label = 'a path with a double quote'; Rg = 'rg'; Shell = 'C:\Users\a"b\pw.exe' }
    ) {
        { Get-LabArcProxyCommand -ShellPath $Shell -HelperPath 'C:\h.ps1' -ResourceGroup $Rg -MachineName 'm' -Subscription 's' -User 'hcwadmin' } | Should -Throw '*cannot go into a ProxyCommand*'
        (Get-LabArcProxyCommand -ShellPath 'C:\100%\pw.exe' -HelperPath 'C:\h.ps1' -ResourceGroup 'rg' -MachineName 'm' -Subscription 's' -User 'hcwadmin') | Should -BeLike '"C:\100%%\pw.exe" *'
    }
}

Describe 'Arc mode: the helper''s pure functions' {
    It 'asks az ssh config for the Arc machine with every value named, the subscription included' {
        (Get-LabArcAzArguments -ResourceGroup 'rg-lab-hybrid-prod-cus' -MachineName 'arcs-lab-hybrid-prod-cus-01' -Subscription 'sub-app-site-prod-cus' -LocalUser 'hcwadmin' -Port 22 -ConfigPath 'C:\t\run-1\config') -join ' ' |
            Should -BeExactly 'ssh config --resource-group rg-lab-hybrid-prod-cus --name arcs-lab-hybrid-prod-cus-01 --resource-type Microsoft.HybridCompute/machines --local-user hcwadmin --port 22 --file C:\t\run-1\config --subscription sub-app-site-prod-cus --only-show-errors'
    }

    It 'reads the ProxyCommand az ssh config writes: <Label>' -ForEach @(
        @{ Label = 'a quoted Windows path'; Text = "Host rg-vm-hcwadmin`r`n`tHostName vm`r`n`tProxyCommand ""C:\Users\Some One\.clientsshproxy\sshProxy_windows_amd64_1_3_026973.exe"" -r ""C:\T\run-1\az_ssh_config\rg-vm\rg-vm-relay_info"" -p 22`r`n"; Path = 'C:\Users\Some One\.clientsshproxy\sshProxy_windows_amd64_1_3_026973.exe'; Arguments = '-r "C:\T\run-1\az_ssh_config\rg-vm\rg-vm-relay_info" -p 22' },
        @{ Label = 'an unquoted path'; Text = "Host x`n    ProxyCommand /home/u/.clientsshproxy/sshProxy_linux_amd64_1_3 -r ""/tmp/r"" -p 22`n"; Path = '/home/u/.clientsshproxy/sshProxy_linux_amd64_1_3'; Arguments = '-r "/tmp/r" -p 22' }
    ) {
        $line = Get-LabArcProxyLine -ConfigText $Text
        $line.Path | Should -BeExactly $Path
        $line.Arguments | Should -BeExactly $Arguments
    }

    It 'finds nothing in a config without a ProxyCommand' {
        Get-LabArcProxyLine -ConfigText "Host x`n    HostName y`n" | Should -BeNullOrEmpty
    }

    It 'quotes an argument only when it holds a space, and never passes a double quote' {
        ConvertTo-LabArcArgument -Value 'Microsoft.HybridCompute/machines' | Should -BeExactly 'Microsoft.HybridCompute/machines'
        ConvertTo-LabArcArgument -Value 'C:\Users\Some One\AppData\Local\Temp\hcw-lab-arc\run-1\config' | Should -BeExactly '"C:\Users\Some One\AppData\Local\Temp\hcw-lab-arc\run-1\config"'
        ConvertTo-LabArcArgument -Value 'C:\Some Dir\' | Should -BeExactly '"C:\Some Dir\\"'
        ConvertTo-LabArcArgument -Value '' | Should -BeExactly '""'
        { ConvertTo-LabArcArgument -Value 'a"b' } | Should -Throw '*double quote*'
    }

    It 'turns az''s refusal into the command that fixes it: <Label>' -ForEach @(
        @{ Label = 'signed out'; Stderr = "ERROR: Please run 'az login' to setup account."; Expected = '*Run: az login' },
        @{ Label = 'the extension missing'; Stderr = 'ERROR: The command requires the extension ssh. Unable to prompt for extension install confirmation as no tty available.'; Expected = '*Run: az extension add --name ssh' },
        @{ Label = 'anything else'; Stderr = "ERROR: (ResourceNotFound) The Resource was not found.`nmore"; Expected = 'ERROR: (ResourceNotFound) The Resource was not found. more' },
        @{ Label = 'nothing at all'; Stderr = ''; Expected = 'az wrote nothing to say why.' }
    ) {
        Get-LabArcAzHint -Stderr $Stderr | Should -BeLike $Expected
    }

    It 'deletes run folders older than an hour, the credentials'' lifetime, keeps newer ones and anything else, and counts them' {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        $now = [datetime]::new(2026, 10, 16, 12, 0, 0, [System.DateTimeKind]::Utc)
        foreach ($name in 'run-old', 'run-new', 'other-old') {
            New-Item -ItemType Directory -Path (Join-Path $root $name) -Force | Out-Null
        }
        [System.IO.Directory]::SetLastWriteTimeUtc((Join-Path $root 'run-old'), $now.AddMinutes(-61))
        [System.IO.Directory]::SetLastWriteTimeUtc((Join-Path $root 'run-new'), $now.AddMinutes(-30))
        [System.IO.Directory]::SetLastWriteTimeUtc((Join-Path $root 'other-old'), $now.AddDays(-1))
        Remove-LabArcStaleState -Root $root -Now $now | Should -Be 1
        @(Get-ChildItem -LiteralPath $root -Directory | ForEach-Object Name | Sort-Object) | Should -Be @('other-old', 'run-new')
        Remove-LabArcStaleState -Root (Join-Path $root 'absent') -Now $now | Should -Be 0
    }

    It 'splits the relay file out of the proxy''s arguments: <Label>' -ForEach @(
        @{ Label = 'quoted, first'; Arguments = '-r "C:\Users\Some One\AppData\Local\hcw-lab-arc\run-1\az_ssh_config\rg-vm\rg-vm-relay_info" -p 22'; RelayPath = 'C:\Users\Some One\AppData\Local\hcw-lab-arc\run-1\az_ssh_config\rg-vm\rg-vm-relay_info'; Rest = '-p 22' },
        @{ Label = 'unquoted'; Arguments = '-r /home/u/.ssh/hcw-lab-arc/run-1/r -p 22'; RelayPath = '/home/u/.ssh/hcw-lab-arc/run-1/r'; Rest = '-p 22' },
        @{ Label = 'after the port'; Arguments = '-p 22 -r "a b"'; RelayPath = 'a b'; Rest = '-p 22' }
    ) {
        $split = Split-LabArcRelayArgument -Arguments $Arguments
        $split.RelayPath | Should -BeExactly $RelayPath
        $split.Arguments | Should -BeExactly $Rest
    }

    It 'leaves arguments with no relay file as they are' {
        $split = Split-LabArcRelayArgument -Arguments '-p 22 --other "x y"'
        $split.RelayPath | Should -BeNullOrEmpty
        $split.Arguments | Should -BeExactly '-p 22 --other "x y"'
    }

    It 'keeps the state under LOCALAPPDATA on Windows and under ~/.ssh elsewhere, never in the temporary folder' {
        $root = Get-LabArcStateRoot
        if ($env:LOCALAPPDATA) {
            $root | Should -Be (Join-Path $env:LOCALAPPDATA 'hcw-lab-arc')
        }
        else {
            $root | Should -Be (Join-Path (Join-Path $HOME '.ssh') 'hcw-lab-arc')
        }
        $root | Should -Not -BeLike ([System.IO.Path]::GetTempPath() + '*')
    }

    It 'creates the state folder private to this user' {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        Mock Write-LabArcMessage { throw "unexpected message: $Message" }
        Initialize-LabArcStateRoot -Path $root
        Test-Path -LiteralPath $root -PathType Container | Should -BeTrue
        if ($IsWindows) {
            $acl = Get-Acl -LiteralPath $root
            $acl.AreAccessRulesProtected | Should -BeTrue
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique) | Should -Be @($me.Value)
        }
        else {
            (Get-Item -LiteralPath $root).UnixMode | Should -Be 'drwx------'
        }
        { Initialize-LabArcStateRoot -Path $root } | Should -Not -Throw
    }
}

Describe 'Arc mode: Invoke-LabArcProxy, the ProxyCommand, against mocked seams' {
    BeforeEach {
        $script:messages = [System.Collections.Generic.List[string]]::new()
        $script:configFiles = [System.Collections.Generic.List[string]]::new()
        $state = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        $script:proxyFile = Join-Path $TestDrive 'sshProxy_test'
        [System.IO.File]::WriteAllText($script:proxyFile, 'stand-in')
        Mock Write-LabArcMessage { $script:messages.Add($Message) }
        Mock Resolve-LabArcAz { 'az-stand-in' }
        Mock Start-LabArcProxyProcess {
            # What is on disk at the moment the connection starts.
            $script:runFoldersAtStart = @(Get-ChildItem -LiteralPath $script:state -Directory -Filter 'run-*').Count
            7
        }
        Mock Invoke-LabArcAz {
            $file = $Arguments[[array]::IndexOf($Arguments, '--file') + 1]
            $script:configFiles.Add($file)
            $relay = Join-Path (Split-Path -Parent $file) 'rg-vm-relay_info'
            [System.IO.File]::WriteAllText($relay, "c3RhbmQtaW4=`n")
            [System.IO.File]::WriteAllText($file, "Host rg-vm-hcwadmin`n`tProxyCommand ""$($script:proxyFile)"" -r ""$relay"" -p 22`n")
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        $script:state = $state
        $script:runFoldersAtStart = -1
        $call = @{ ResourceGroup = 'rg-lab-hybrid-prod-cus'; MachineName = 'arcs-lab-hybrid-prod-cus-01'; Subscription = 'sub-app-site-prod-cus'; LocalUser = 'hcwadmin'; StateRoot = $state }
    }

    It 'gets fresh credentials, deletes them from disk, then hands ssh''s pipes to the proxy with the credentials in its environment' {
        Invoke-LabArcProxy @call | Should -Be 7
        Should -Invoke Invoke-LabArcAz -Times 1 -Exactly -ParameterFilter { $AzPath -eq 'az-stand-in' -and ($Arguments -join ' ') -match '^ssh config --resource-group rg-lab-hybrid-prod-cus .* --subscription sub-app-site-prod-cus --only-show-errors$' }
        Should -Invoke Start-LabArcProxyProcess -Times 1 -Exactly -ParameterFilter { $Path -eq $script:proxyFile -and $Arguments -eq '-p 22' -and $RelayInfo -eq 'c3RhbmQtaW4=' }
        $script:runFoldersAtStart | Should -Be 0 -Because 'the relay credentials leave the disk before the connection starts'
        @(Get-ChildItem -LiteralPath $state -Directory).Count | Should -Be 0
        $script:messages.Count | Should -Be 0
    }

    It 'passes the arguments as written, and keeps the folder until the proxy exits, if az ever names no relay file' {
        Mock Invoke-LabArcAz {
            $file = $Arguments[[array]::IndexOf($Arguments, '--file') + 1]
            [System.IO.File]::WriteAllText($file, "Host rg-vm-hcwadmin`n`tProxyCommand ""$($script:proxyFile)"" -p 22`n")
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        Invoke-LabArcProxy @call | Should -Be 7
        Should -Invoke Start-LabArcProxyProcess -Times 1 -Exactly -ParameterFilter { $Arguments -eq '-p 22' -and -not $RelayInfo }
        $script:runFoldersAtStart | Should -Be 1
        @(Get-ChildItem -LiteralPath $state -Directory).Count | Should -Be 0
    }

    It 'stops when az names a relay file it did not write' {
        Mock Invoke-LabArcAz {
            $file = $Arguments[[array]::IndexOf($Arguments, '--file') + 1]
            [System.IO.File]::WriteAllText($file, "Host rg-vm-hcwadmin`n`tProxyCommand ""$($script:proxyFile)"" -r ""$file-absent"" -p 22`n")
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        Invoke-LabArcProxy @call | Should -Be 1
        $script:messages[0] | Should -Match '^az ssh config named relay information it did not write'
        Should -Invoke Start-LabArcProxyProcess -Times 0 -Exactly
    }

    It 'sweeps a run folder older than an hour, which a killed helper left, at its next start' {
        $stale = Join-Path $state 'run-0123456789abcdef0123456789abcdef'
        $recent = Join-Path $state 'run-fedcba9876543210fedcba9876543210'
        New-Item -ItemType Directory -Path $stale, $recent -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $stale 'relay_info'), 'old')
        [System.IO.Directory]::SetLastWriteTimeUtc($stale, [datetime]::UtcNow.AddMinutes(-61))
        [System.IO.Directory]::SetLastWriteTimeUtc($recent, [datetime]::UtcNow.AddMinutes(-10))
        $null = Invoke-LabArcProxy @call
        Test-Path -LiteralPath $stale | Should -BeFalse
        Test-Path -LiteralPath $recent | Should -BeTrue
    }

    It 'asks for credentials on every call, each in a run folder of its own under the state root' {
        $null = Invoke-LabArcProxy @call
        $null = Invoke-LabArcProxy @call
        Should -Invoke Invoke-LabArcAz -Times 2 -Exactly
        $script:configFiles.Count | Should -Be 2
        $script:configFiles[0] | Should -Not -Be $script:configFiles[1]
        foreach ($file in $script:configFiles) {
            (Split-Path -Parent (Split-Path -Parent $file)) | Should -Be $state
            (Split-Path -Leaf (Split-Path -Parent $file)) | Should -Match '^run-[0-9a-f]{32}$'
        }
    }

    It 'with -Check stops before the proxy and says the credentials were issued' {
        Invoke-LabArcProxy @call -Check | Should -Be 0
        Should -Invoke Start-LabArcProxyProcess -Times 0 -Exactly
        $script:messages[0] | Should -Match '^relay credentials issued for arcs-lab-hybrid-prod-cus-01; proxy '
    }

    It 'stops with az''s reason, and the fix, when az ssh config fails' {
        Mock Invoke-LabArcAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: Please run 'az login' to setup account." } }
        Invoke-LabArcProxy @call | Should -Be 1
        Should -Invoke Start-LabArcProxyProcess -Times 0 -Exactly
        $script:messages[0] | Should -BeExactly 'az ssh config failed (exit 1): az is not signed in, or its sign-in expired. Run: az login'
        @(Get-ChildItem -LiteralPath $state -Directory).Count | Should -Be 0
    }

    It 'stops when az is not installed, naming the direct fallback' {
        Mock Resolve-LabArcAz { $null }
        Invoke-LabArcProxy @call | Should -Be 1
        Should -Invoke Invoke-LabArcAz -Times 0 -Exactly
        $script:messages[0] | Should -Match 'az is not on PATH.*without -Arc'
    }

    It 'stops when the config names no ProxyCommand, or a proxy that is not on disk' {
        Mock Invoke-LabArcAz {
            $file = $Arguments[[array]::IndexOf($Arguments, '--file') + 1]
            [System.IO.File]::WriteAllText($file, "Host x`n`tHostName y`n")
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        Invoke-LabArcProxy @call | Should -Be 1
        $script:messages[0] | Should -Match '^az ssh config wrote no ProxyCommand'
        Mock Invoke-LabArcAz {
            $file = $Arguments[[array]::IndexOf($Arguments, '--file') + 1]
            [System.IO.File]::WriteAllText($file, "Host x`n`tProxyCommand ""$(Join-Path $TestDrive 'absent-proxy')"" -p 22`n")
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        Invoke-LabArcProxy @call | Should -Be 1
        $script:messages[1] | Should -Match '^The relay proxy az named is not on disk'
        Should -Invoke Start-LabArcProxyProcess -Times 0 -Exactly
    }
}

Describe 'Arc mode: Test-LabArcPrerequisites, read-only' {
    BeforeEach {
        $script:azAnswers = [ordered]@{
            '^extension show --name ssh ' = [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
            '^account show --subscription sub-app-site-prod-cus --query id ' = [pscustomobject]@{ ExitCode = 0; Stdout = "aaaaaaaa-1111-4222-8333-444444444444`n"; Stderr = '' }
            '^rest --method get --url https://management\.azure\.com/subscriptions/aaaaaaaa-1111-4222-8333-444444444444/resourceGroups/rg-lab-hybrid-prod-cus/providers/Microsoft\.HybridCompute/machines/arcs-lab-hybrid-prod-cus-01/providers/Microsoft\.HybridConnectivity/endpoints/default/serviceConfigurations/SSH\?api-version=2024-12-01 ' = [pscustomobject]@{ ExitCode = 0; Stdout = '{"name":"SSH","properties":{"serviceName":"SSH","port":22,"provisioningState":"Succeeded"}}'; Stderr = '' }
        }
        Mock Invoke-LabArcAz {
            $line = $Arguments -join ' '
            foreach ($pattern in $script:azAnswers.Keys) {
                if ($line -match $pattern) {
                    return $script:azAnswers[$pattern]
                }
            }
            throw "unexpected az call: $line"
        }
        $call = @{ AzPath = 'az'; Subscription = 'sub-app-site-prod-cus'; ResourceGroup = 'rg-lab-hybrid-prod-cus'; MachineName = 'arcs-lab-hybrid-prod-cus-01' }
    }

    It 'is ready when the extension, the sign-in and the port-22 service configuration are all there' {
        $result = Test-LabArcPrerequisites @call
        $result.Ready | Should -BeTrue
        Should -Invoke Invoke-LabArcAz -Times 3 -Exactly
    }

    It 'names az extension add --name ssh when the extension is missing' {
        $script:azAnswers['^extension show --name ssh '] = [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: The extension ssh is not installed." }
        $result = Test-LabArcPrerequisites @call
        $result.Ready | Should -BeFalse
        $result.Command | Should -BeExactly 'az extension add --name ssh'
    }

    It 'names az login when az is signed out' {
        $script:azAnswers['^account show --subscription sub-app-site-prod-cus --query id '] = [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: Please run 'az login' to setup account." }
        $result = Test-LabArcPrerequisites @call
        $result.Command | Should -BeExactly 'az login'
    }

    It 'refuses before the apply, so the extension never creates the service configuration outside Terraform' {
        $key = @($script:azAnswers.Keys)[2]
        $script:azAnswers[$key] = [pscustomobject]@{ ExitCode = 3; Stdout = ''; Stderr = '(ResourceNotFound) The Resource ... was not found. Code: ResourceNotFound' }
        $result = Test-LabArcPrerequisites @call
        $result.Ready | Should -BeFalse
        $result.Problem | Should -Match 'hcw-azure run after #953 creates it'
        $result.Command | Should -BeNullOrEmpty
    }

    It 'refuses a service configuration on any port but 22' {
        $key = @($script:azAnswers.Keys)[2]
        $script:azAnswers[$key] = [pscustomobject]@{ ExitCode = 0; Stdout = '{"properties":{"serviceName":"SSH","port":2222}}'; Stderr = '' }
        (Test-LabArcPrerequisites @call).Problem | Should -Match "names port '2222', not 22"
    }
}

Describe 'Arc mode: the helper file' {
    BeforeAll {
        $helperText = Get-LabArcProxyScript
        $tokens = $null
        $helperErrors = $null
        $helperAst = [System.Management.Automation.Language.Parser]::ParseInput($helperText, [ref] $tokens, [ref] $helperErrors)
    }

    It 'parses, and is ASCII with LF line endings' {
        @($helperErrors).Count | Should -Be 0
        $helperText | Should -Not -Match '[^\x00-\x7F]'
        $helperText | Should -Not -Match "`r"
    }

    It 'defines every function Invoke-LabArcProxy reaches, and runs it with the ProxyCommand''s parameters' {
        $defined = @($helperAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object Name | Sort-Object)
        $defined | Should -Be @('ConvertTo-LabArcArgument', 'Get-LabArcAzArguments', 'Get-LabArcAzHint', 'Get-LabArcProxyLine', 'Get-LabArcStateRoot', 'Initialize-LabArcStateRoot', 'Invoke-LabArcAz', 'Invoke-LabArcProxy', 'Remove-LabArcStaleState', 'Resolve-LabArcAz', 'Split-LabArcRelayArgument', 'Start-LabArcProxyProcess', 'Write-LabArcMessage')
        @($helperAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) | Should -Be @('ResourceGroup', 'MachineName', 'Subscription', 'LocalUser', 'Port')
        $helperText | Should -Match '(?m)^exit \$code$'
    }

    It 'uses no syntax and no variable that Windows PowerShell 5.1 lacks' {
        $newer = @('AndAnd', 'OrOr', 'QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'QuestionMark')
        @($tokens | Where-Object { $newer -contains [string]$_.Kind }) | Should -BeNullOrEmpty
        $helperText | Should -Not -Match '\$Is(Windows|Linux|MacOS)\b'
        $helperText | Should -Not -Match '\$PSStyle\b'
    }

    It 'writes nothing to standard output on any path: no Write-Host, Write-Output or Out-Host' {
        $helperText | Should -Not -Match '\b(Write-Host|Write-Output|Out-Host|Write-Information)\b'
    }
}

Describe 'Arc mode: the helper file, run as ssh runs it' {
    BeforeAll {
        $pwsh = (Get-Process -Id $PID).Path
        $root = Join-Path $TestDrive 'arc-run'
        $bin = Join-Path $root 'bin'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        $helper = Join-Path $root 'hcw-lab-arc-proxy.ps1'
        [System.IO.File]::WriteAllText($helper, (Get-LabArcProxyScript), [System.Text.ASCIIEncoding]::new())
        $helperArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$helper"" -ResourceGroup rg-lab-hybrid-prod-cus -MachineName arcs-lab-hybrid-prod-cus-01 -Subscription sub-app-site-prod-cus -LocalUser hcwadmin -Port 22"

        $fakeAz = @'
# Stand-in for `az ssh config`: logs its arguments, then writes a relay file
# and a config whose ProxyCommand is the stand-in proxy, as the extension
# does, and prints on both outputs, neither of which may reach the connection.
$argv = @($args | ForEach-Object { [string]$_ })
Add-Content -LiteralPath (Join-Path $env:FAKE_DIR 'az.log') -Value ($argv -join ' ')
if ($env:FAKE_AZ_FAIL) {
    [Console]::Error.WriteLine("ERROR: Please run 'az login' to setup account.")
    exit 1
}
$file = $argv[[array]::IndexOf($argv, '--file') + 1]
$folder = Join-Path (Split-Path -Parent $file) 'az_ssh_config'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$relay = Join-Path $folder 'rg-vm-relay_info'
[System.IO.File]::WriteAllText($relay, 'c3RhbmQtaW4=')
[System.IO.File]::WriteAllText($file, "Host rg-vm-hcwadmin`n`tHostName vm`n`tUser hcwadmin`n`tProxyCommand ""$($env:FAKE_PROXY)"" -r ""$relay"" -p 22`n")
[Console]::Error.WriteLine('Generated relay information is valid until tomorrow.')
[Console]::Out.WriteLine('az stdout, which must not reach the connection')
exit 0
'@
        [System.IO.File]::WriteAllText((Join-Path $bin 'fake-az.ps1'), ($fakeAz -replace "`r`n", "`n"))
        if ($IsWindows) {
            # The proxy stand-in refuses unless the credentials came in its
            # environment and no run folder is left on disk, marks that it
            # started, and then copies its standard input to its standard
            # output as bytes, which is the whole job of the real one.
            $fakeProxy = @'
if ($args -contains '-r') {
    [Console]::Error.WriteLine("relay file passed, not the environment: $args")
    exit 3
}
if ($env:SSHPROXY_RELAY_INFO -ne 'c3RhbmQtaW4=') {
    [Console]::Error.WriteLine('no relay information in the environment')
    exit 3
}
if (@(Get-ChildItem -LiteralPath $env:FAKE_STATE -Directory -Filter 'run-*' -ErrorAction SilentlyContinue).Count -gt 0) {
    [Console]::Error.WriteLine('a run folder is still on disk')
    exit 4
}
[System.IO.File]::WriteAllText((Join-Path $env:FAKE_DIR 'proxy-started'), '')
$in = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()
$in.CopyTo($out)
$out.Flush()
exit 0
'@
            [System.IO.File]::WriteAllText((Join-Path $bin 'fake-proxy.ps1'), ($fakeProxy -replace "`r`n", "`n"))
            [System.IO.File]::WriteAllText((Join-Path $bin 'az.cmd'), "@echo off`r`n""$pwsh"" -NoProfile -NonInteractive -File ""%~dp0fake-az.ps1"" %*`r`nexit /b %ERRORLEVEL%`r`n")
            $proxyPath = Join-Path $bin 'proxy.cmd'
            [System.IO.File]::WriteAllText($proxyPath, "@echo off`r`n""$pwsh"" -NoProfile -NonInteractive -File ""%~dp0fake-proxy.ps1"" %*`r`nexit /b %ERRORLEVEL%`r`n")
        }
        else {
            [System.IO.File]::WriteAllText((Join-Path $bin 'az'), "#!/usr/bin/env bash`nexec '$pwsh' -NoProfile -NonInteractive -File ""`$(dirname ""`$0"")/fake-az.ps1"" ""`$@""`n")
            $proxyPath = Join-Path $bin 'proxy'
            $fakeProxy = @'
#!/usr/bin/env bash
for argument in "$@"; do
  if [ "$argument" = -r ]; then echo "relay file passed, not the environment: $*" >&2; exit 3; fi
done
if [ "$SSHPROXY_RELAY_INFO" != c3RhbmQtaW4= ]; then echo 'no relay information in the environment' >&2; exit 3; fi
for folder in "$FAKE_STATE"/run-*; do
  if [ -e "$folder" ]; then echo "a run folder is still on disk: $folder" >&2; exit 4; fi
done
: > "$FAKE_DIR/proxy-started"
exec cat
'@
            [System.IO.File]::WriteAllText($proxyPath, ($fakeProxy -replace "`r`n", "`n"))
            & chmod +x (Join-Path $bin 'az') $proxyPath
        }

        # A desktop of its own for each case: PATH with the stand-ins first,
        # and the state root moved under the case's folder, through
        # LOCALAPPDATA on Windows and HOME elsewhere, as Get-LabArcStateRoot
        # reads them.
        function New-HelperContext {
            $dir = Join-Path $root ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $dir | Out-Null
            $environment = [ordered]@{
                PATH       = $bin + [System.IO.Path]::PathSeparator + $env:PATH
                FAKE_DIR   = $dir
                FAKE_PROXY = $proxyPath
            }
            if ($IsWindows) {
                $environment['LOCALAPPDATA'] = Join-Path $dir 'local'
                $state = Join-Path $environment['LOCALAPPDATA'] 'hcw-lab-arc'
            }
            else {
                $environment['HOME'] = Join-Path $dir 'home'
                $state = Join-Path $environment['HOME'] '.ssh' 'hcw-lab-arc'
            }
            $environment['FAKE_STATE'] = $state
            return [pscustomobject]@{ Dir = $dir; State = $state; Environment = $environment }
        }

        function Invoke-Helper {
            param(
                [Parameter(Mandatory)] [string] $Shell,
                [pscustomobject] $Context = (New-HelperContext),
                [string] $InputText = 'ping',
                [switch] $AzFails
            )
            $errorFile = Join-Path $Context.Dir ([guid]::NewGuid().ToString('n') + '.stderr')
            $names = @($Context.Environment.Keys) + @('FAKE_AZ_FAIL')
            $saved = @{}
            foreach ($name in $names) {
                $saved[$name] = [System.Environment]::GetEnvironmentVariable($name)
            }
            try {
                foreach ($name in $Context.Environment.Keys) {
                    [System.Environment]::SetEnvironmentVariable($name, $Context.Environment[$name])
                }
                if ($AzFails) {
                    [System.Environment]::SetEnvironmentVariable('FAKE_AZ_FAIL', '1')
                }
                $stdout = @($InputText | & $Shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -ResourceGroup rg-lab-hybrid-prod-cus -MachineName arcs-lab-hybrid-prod-cus-01 -Subscription sub-app-site-prod-cus -LocalUser hcwadmin -Port 22 2> $errorFile)
                $code = $LASTEXITCODE
            }
            finally {
                foreach ($name in $names) {
                    [System.Environment]::SetEnvironmentVariable($name, $saved[$name])
                }
            }
            $azLog = Join-Path $Context.Dir 'az.log'
            return [pscustomobject]@{
                ExitCode = $code
                Stdout   = ($stdout -join "`n")
                Stderr   = $(if (Test-Path -LiteralPath $errorFile) { [System.IO.File]::ReadAllText($errorFile) } else { '' })
                AzLog    = $(if (Test-Path -LiteralPath $azLog) { [System.IO.File]::ReadAllText($azLog) } else { '' })
                Runs     = @(Get-ChildItem -LiteralPath $Context.State -Directory -Filter 'run-*' -ErrorAction SilentlyContinue).Count
            }
        }
    }

    It 'under <Name>, carries the connection both ways untouched, prints nothing of az''s on it, and leaves no credentials behind' -ForEach $helperShells {
        $context = New-HelperContext
        $run = Invoke-Helper -Shell $Shell -Context $context -InputText 'SSH-2.0-OpenSSH_10.2 ping'
        $run.ExitCode | Should -Be 0 -Because $run.Stderr
        $run.Stdout | Should -BeExactly 'SSH-2.0-OpenSSH_10.2 ping'
        $run.AzLog | Should -Match '^ssh config --resource-group rg-lab-hybrid-prod-cus --name arcs-lab-hybrid-prod-cus-01 --resource-type Microsoft.HybridCompute/machines --local-user hcwadmin --port 22 --file \S+ --subscription sub-app-site-prod-cus --only-show-errors'
        $run.AzLog | Should -Match ([regex]::Escape((Join-Path $context.State 'run-')))
        $run.Runs | Should -Be 0
    }

    It 'under <Name>, fails with the fix on standard error and nothing on standard output when az is signed out' -ForEach $helperShells {
        $run = Invoke-Helper -Shell $Shell -AzFails
        $run.ExitCode | Should -Be 1
        $run.Stdout | Should -BeNullOrEmpty
        $run.Stderr | Should -Match 'hcw-lab \(Arc\): az ssh config failed \(exit 1\): .*Run: az login'
        $run.Runs | Should -Be 0
    }

    It 'under <Name>, keeps no credentials on disk mid-stream, leaves none when killed as ssh kills it, and sweeps an expired folder at the next start' -ForEach $helperShells {
        $context = New-HelperContext
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $Shell
        $start.Arguments = $helperArguments
        $start.UseShellExecute = $false
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        foreach ($name in $context.Environment.Keys) {
            $start.EnvironmentVariables[$name] = $context.Environment[$name]
        }
        $process = [System.Diagnostics.Process]::Start($start)
        $null = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        try {
            # The proxy marks when it has started and is copying the stream;
            # standard input stays open, so it keeps running, mid-stream.
            $marker = Join-Path $context.Dir 'proxy-started'
            $deadline = [datetime]::UtcNow.AddSeconds(90)
            while (-not (Test-Path -LiteralPath $marker) -and -not $process.HasExited -and [datetime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 200
            }
            Test-Path -LiteralPath $marker | Should -BeTrue -Because "the proxy should be running; the helper said: $(if ($process.HasExited) { $stderr.Result })"
            @(Get-ChildItem -LiteralPath $context.State -Directory -Filter 'run-*').Count | Should -Be 0 -Because 'the credentials are in the proxy''s environment, not on disk, while the connection runs'

            # What Windows OpenSSH does to a ProxyCommand when the session
            # ends: kill it, so no cleanup in the helper runs.
            $process.Kill()
            $process.WaitForExit()
        }
        finally {
            # The orphaned proxy reads end-of-input and ends too.
            $process.StandardInput.Close()
        }
        @(Get-ChildItem -LiteralPath $context.State -Directory -Filter 'run-*').Count | Should -Be 0

        # A helper killed while az was still writing would leave its folder.
        # One past the credentials' hour goes at the next start; a newer one
        # stays.
        $expired = Join-Path $context.State ('run-' + [guid]::NewGuid().ToString('n'))
        $recent = Join-Path $context.State ('run-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $expired, $recent | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $expired 'rg-vm-relay_info'), 'expired')
        [System.IO.Directory]::SetLastWriteTimeUtc($expired, [datetime]::UtcNow.AddMinutes(-61))
        # The sweep runs before az does; az refusing keeps this start short,
        # and keeps the stand-in proxy, which refuses to run beside any run
        # folder, out of it.
        $next = Invoke-Helper -Shell $Shell -Context $context -AzFails
        $next.ExitCode | Should -Be 1
        Test-Path -LiteralPath $expired | Should -BeFalse
        Test-Path -LiteralPath $recent | Should -BeTrue
    }
}

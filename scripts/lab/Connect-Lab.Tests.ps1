<#
    Pester 5 tests for Connect-Lab.ps1's ssh_config rewrite.

    The functions are loaded from the script's syntax tree rather than by
    running or dot-sourcing it, so nothing in the script's main body runs:
    no gh call, no ssh-keygen, no write under the real ~/.ssh. Every file this
    touches is under Pester's $TestDrive.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester scripts/lab -Output Detailed"
#>

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

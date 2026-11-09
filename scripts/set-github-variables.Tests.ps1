<#
    Pester 5 tests for the parts of set-github-variables.ps1 that must never
    show a subscription id (#1610), a tenant id or a client id (#1618): the
    error a failed gh call raises, the line it prints when it writes a
    secret, and the subscription picker it uses from lib/deploy-console.ps1.

    The functions are loaded from each script's syntax tree, so neither main
    body runs: no gh or az call, no prompt. The one gh call made runs a
    stand-in gh program from Pester's TestDrive, on Linux and macOS only.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester scripts/set-github-variables.Tests.ps1 -Output Detailed"
#>

BeforeAll {
    function Import-ScriptFunction {
        param([string] $Path, [string[]] $Names)
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $null, [ref] $parseErrors)
        if ($parseErrors -and $parseErrors.Count -gt 0) {
            throw "$Path does not parse: $($parseErrors[0].Message)"
        }
        $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) |
            Where-Object { -not $Names -or $Names -contains $_.Name } |
            ForEach-Object { $_.Extent.Text }
    }

    foreach ($text in (Import-ScriptFunction -Path (Join-Path $PSScriptRoot 'set-github-variables.ps1') -Names 'Format-GhArguments', 'Invoke-Gh')) {
        . ([scriptblock]::Create($text))
    }
    foreach ($text in (Import-ScriptFunction -Path (Join-Path $PSScriptRoot 'lib/deploy-console.ps1'))) {
        . ([scriptblock]::Create($text))
    }

    $script:sample = '00000000-0000-0000-0000-000000000001'
}

Describe 'Format-GhArguments' {
    It 'replaces the value after --body with ***' {
        Format-GhArguments @('secret', 'set', 'SUBSCRIPTION_ID', '-R', 'o/r', '--body', $script:sample) |
            Should -Be 'secret set SUBSCRIPTION_ID -R o/r --body ***'
    }

    It 'leaves arguments without --body as they are' {
        Format-GhArguments @('variable', 'set', 'TENANT_ID', '-R', 'o/r') | Should -Be 'variable set TENANT_ID -R o/r'
    }

    It 'keeps a trailing --body with nothing after it' {
        Format-GhArguments @('secret', 'set', 'X', '--body') | Should -Be 'secret set X --body'
    }
}

Describe 'Invoke-Gh, when gh fails to set a secret' -Skip:($IsWindows) {
    BeforeAll {
        $bin = Join-Path $TestDrive 'bin'
        New-Item -ItemType Directory -Path $bin | Out-Null
        Set-Content -LiteralPath (Join-Path $bin 'gh') -NoNewline -Value (@(
                '#!/bin/sh',
                "echo 'HTTP 422: failed to set secret' >&2",
                'exit 1',
                ''
            ) -join "`n")
        chmod +x (Join-Path $bin 'gh')
    }

    It 'throws an error that names the call with the value as ***' {
        $previous = $env:PATH
        $message = $null
        try {
            $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$previous"
            Invoke-Gh @('secret', 'set', 'SUBSCRIPTION_ID', '-R', 'o/r', '--body', $script:sample)
        } catch {
            $message = $_.Exception.Message + "`n" + ($_ | Out-String)
        } finally {
            $env:PATH = $previous
        }
        $message | Should -Not -BeNullOrEmpty
        $message | Should -Match 'gh secret set SUBSCRIPTION_ID -R o/r --body \*\*\* failed'
        $message | Should -Match 'HTTP 422'
        $message | Should -Not -Match '00000000-0000-0000-0000-'
    }
}

Describe 'Set-RepoSecret, for the tenant id and the client ids (#1618)' {
    BeforeAll {
        foreach ($text in (Import-ScriptFunction -Path (Join-Path $PSScriptRoot 'set-github-variables.ps1') -Names 'Set-RepoSecret')) {
            . ([scriptblock]::Create($text))
        }
    }

    BeforeEach {
        $script:Repository = 'o/r'
        $script:existingSecrets = @('TENANT_ID')
        $script:ghCalls = [System.Collections.Generic.List[string]]::new()
        $script:shown = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-Gh { $script:ghCalls.Add(($Arguments -join ' ')) }
        Mock Write-Host { $script:shown.Add([string]$Object) }
    }

    It 'writes each one as a secret and shows only its name' {
        $n = 10
        foreach ($name in 'TENANT_ID', 'CLIENT_ID', 'READER_CLIENT_ID', 'MANIFEST_WINDOW_CLIENT_ID', 'COPILOT_REVIEW_CLIENT_ID', 'ARC_RUN_CLIENT_ID', 'ALERT_READER_CLIENT_ID') {
            Set-RepoSecret -Name $name -Value ('00000000-0000-0000-0000-0000000000{0}' -f $n) -Confirm:$false
            $n++
        }
        $script:ghCalls.Count | Should -Be 7
        $script:ghCalls | Should -Contain 'secret set TENANT_ID -R o/r --body 00000000-0000-0000-0000-000000000010'
        @($script:ghCalls | Where-Object { $_ -like 'variable *' }).Count | Should -Be 0
        ($script:shown -join "`n") | Should -Match 'update  TENANT_ID \(secret; value not shown\)'
        ($script:shown -join "`n") | Should -Match 'create  ALERT_READER_CLIENT_ID \(secret; value not shown\)'
        ($script:shown -join "`n") | Should -Not -Match '00000000-0000-0000-0000-'
    }
}

Describe 'Select-Subscription -NamesOnly' {
    BeforeEach {
        $script:shown = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:shown.Add([string]$Object) }
        $script:subscriptions = @(
            [pscustomobject]@{ name = 'sub-app-site-prod-cus'; id = '00000000-0000-0000-0000-000000000001'; state = 'Enabled' },
            [pscustomobject]@{ name = 'sub-plat-mgmt-prod-cus'; id = '00000000-0000-0000-0000-000000000002'; state = 'Enabled' }
        )
    }

    It 'confirms the one match by name, without its id' {
        $chosen = Select-Subscription -Purpose 'Application landing zone (SUBSCRIPTION_ID)' -Pattern 'sub-app-*' -Subscriptions $script:subscriptions -NamesOnly
        $chosen.name | Should -Be 'sub-app-site-prod-cus'
        ($script:shown -join "`n") | Should -Match 'sub-app-site-prod-cus'
        ($script:shown -join "`n") | Should -Not -Match '00000000-0000-0000-0000-'
    }

    It 'lists the choices by name, without ids, when nothing matches the pattern' {
        Mock Assert-Interactive { }
        Mock Read-Host { '2' }
        $chosen = Select-Subscription -Purpose 'Application landing zone (SUBSCRIPTION_ID)' -Pattern 'sub-none-*' -Subscriptions $script:subscriptions -NamesOnly
        $chosen.name | Should -Be 'sub-plat-mgmt-prod-cus'
        ($script:shown -join "`n") | Should -Match 'sub-plat-mgmt-prod-cus'
        ($script:shown -join "`n") | Should -Not -Match '00000000-0000-0000-0000-'
    }

    It 'still shows ids for the scripts that do not ask for names only' {
        $null = Select-Subscription -Purpose 'Application landing zone (subscription_app)' -Pattern 'sub-app-*' -Subscriptions $script:subscriptions
        ($script:shown -join "`n") | Should -Match '\[00000000-0000-0000-0000-000000000001\]'
    }
}

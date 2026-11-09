<#
    Pester 5 tests for Set-SubscriptionSecrets.ps1 (#1610).

    The script copies the subscription ids into repository secrets, and its
    one promise is that it never shows a value. So these tests check what it
    hands to gh, what it reports, and that the value appears in neither its
    results nor, in the whole-script run, anything it prints.

    The functions are loaded from the script's syntax tree, so its main body
    does not run in those tests. `gh` is a stand-in function recording each
    call (a function wins over the gh program by PowerShell's command order).
    The whole-script runs put a stand-in gh program first on PATH, on Linux
    and macOS only.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester scripts/Set-SubscriptionSecrets.Tests.ps1 -Output Detailed"
#>

BeforeAll {
    $scriptPath = Join-Path $PSScriptRoot 'Set-SubscriptionSecrets.ps1'
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $null, [ref] $parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw "Set-SubscriptionSecrets.ps1 does not parse: $($parseErrors[0].Message)"
    }
    $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }

    $script:sample = '00000000-0000-0000-0000-000000000001'

    # The stand-in gh. Variables come from $script:vars; a name not in it is
    # "not found". Setting a secret fails when $script:failSet is true.
    function gh {
        $script:calls.Add(($args -join ' '))
        if ($args[0] -eq 'variable' -and $args[1] -eq 'get') {
            if ($script:vars.ContainsKey($args[2])) {
                $global:LASTEXITCODE = 0
                return "$($script:vars[$args[2]])`n"
            }
            $global:LASTEXITCODE = 1
            return
        }
        if ($args[0] -eq 'secret' -and $args[1] -eq 'set') {
            $global:LASTEXITCODE = if ($script:failSet) { 1 } else { 0 }
            return
        }
        $global:LASTEXITCODE = 9
    }
}

BeforeEach {
    $script:calls = [System.Collections.Generic.List[string]]::new()
    $script:vars = @{ SUBSCRIPTION_ID = $script:sample; SUBSCRIPTION_MGMT_ID = '00000000-0000-0000-0000-000000000002' }
    $script:failSet = $false
}

Describe 'Copy-SubscriptionSecret, from the variables' {
    It 'reads each variable and sets a secret of the same name, with the value trimmed' {
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID', 'SUBSCRIPTION_MGMT_ID' -Confirm:$false)
        $results.Count | Should -Be 2
        $results | ForEach-Object { $_.Set | Should -BeTrue }
        $script:calls | Should -Be @(
            'variable get SUBSCRIPTION_ID -R o/r',
            "secret set SUBSCRIPTION_ID -R o/r --body $($script:sample)",
            'variable get SUBSCRIPTION_MGMT_ID -R o/r',
            'secret set SUBSCRIPTION_MGMT_ID -R o/r --body 00000000-0000-0000-0000-000000000002'
        )
    }

    It 'never puts a value in what it returns' {
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID' -Confirm:$false)
        ($results | ConvertTo-Json -Compress) | Should -Not -Match '00000000-0000-0000-0000-'
    }

    It 'reports a missing variable as not set, and sets nothing for it' {
        $script:vars.Remove('SUBSCRIPTION_MGMT_ID')
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID', 'SUBSCRIPTION_MGMT_ID' -Confirm:$false)
        $results[0].Set | Should -BeTrue
        $results[1].Set | Should -BeFalse
        $results[1].Reason | Should -Match 'SUBSCRIPTION_MGMT_ID is missing or empty'
        $script:calls | Should -Not -Contain 'secret set SUBSCRIPTION_MGMT_ID -R o/r --body '
        @($script:calls | Where-Object { $_ -like 'secret set SUBSCRIPTION_MGMT_ID*' }).Count | Should -Be 0
    }

    It 'treats a blank variable as missing' {
        $script:vars['SUBSCRIPTION_ID'] = "   "
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID' -Confirm:$false)
        $results[0].Set | Should -BeFalse
        @($script:calls | Where-Object { $_ -like 'secret set*' }).Count | Should -Be 0
    }

    It 'reports a failed gh secret set as not set' {
        $script:failSet = $true
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID' -Confirm:$false)
        $results[0].Set | Should -BeFalse
        $results[0].Reason | Should -Match 'gh could not set it'
    }

    It 'with -WhatIf, calls gh for nothing' {
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID', 'SUBSCRIPTION_MGMT_ID' -WhatIf)
        $results.Count | Should -Be 0
        $script:calls.Count | Should -Be 0
    }
}

Describe 'Copy-SubscriptionSecret, from the hidden prompt' {
    It 'reads the value with Read-Host -AsSecureString and never asks gh for the variable' {
        Mock Read-Host { ConvertTo-SecureString "  $($script:sample)  " -AsPlainText -Force } -ParameterFilter { $AsSecureString }
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID' -Prompt -Confirm:$false)
        $results[0].Set | Should -BeTrue
        Should -Invoke Read-Host -Times 1 -Exactly
        $script:calls | Should -Be @("secret set SUBSCRIPTION_ID -R o/r --body $($script:sample)")
    }

    It 'reports an empty prompt as not set' {
        Mock Read-Host { [System.Security.SecureString]::new() } -ParameterFilter { $AsSecureString }
        $results = @(Copy-SubscriptionSecret -Repository 'o/r' -SecretNames 'SUBSCRIPTION_ID' -Prompt -Confirm:$false)
        $results[0].Set | Should -BeFalse
        $results[0].Reason | Should -Be 'the prompt was left empty'
        $script:calls.Count | Should -Be 0
    }
}

Describe 'the whole script, against a stand-in gh program' -Skip:($IsWindows) {
    BeforeAll {
        $bin = Join-Path $TestDrive 'bin'
        New-Item -ItemType Directory -Path $bin | Out-Null
        $log = Join-Path $TestDrive 'gh-calls.txt'
        # Prints the value for SUBSCRIPTION_ID only; MISSING is not found.
        Set-Content -LiteralPath (Join-Path $bin 'gh') -NoNewline -Value (@(
                '#!/bin/sh',
                "echo `"`$*`" >> '$log'",
                'case "$1 $2 $3" in',
                "  'variable get SUBSCRIPTION_ID') echo '$($script:sample)'; exit 0 ;;",
                "  'variable get '*) echo 'variable not found' >&2; exit 1 ;;",
                "  'secret set '*) exit 0 ;;",
                'esac',
                'exit 9',
                ''
            ) -join "`n")
        chmod +x (Join-Path $bin 'gh')
        $pwsh = (Get-Process -Id $PID).Path

        # -Command rather than -File, so that -Names a,b arrives as an array.
        function Invoke-Whole {
            param([string] $Arguments)
            if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log }
            $previous = $env:PATH
            try {
                $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$previous"
                $out = & $pwsh -NoProfile -Command "& '$scriptPath' $Arguments; exit `$LASTEXITCODE" 2>&1 | Out-String
                [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out; Calls = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log) } else { @() } }
            } finally {
                $env:PATH = $previous
            }
        }
    }

    It 'sets the secret, exits 0 and never prints the value' {
        $r = Invoke-Whole '-Repo o/r -Names SUBSCRIPTION_ID'
        $r.Code | Should -Be 0
        $r.Out | Should -Match 'Set the repository secret SUBSCRIPTION_ID \(value not shown\)'
        $r.Out | Should -Not -Match '00000000-0000-0000-0000-'
        $r.Calls | Should -Contain "secret set SUBSCRIPTION_ID -R o/r --body $($script:sample)"
    }

    It 'exits 1 and names the variable when one is missing, still setting the others' {
        $r = Invoke-Whole '-Repo o/r -Names SUBSCRIPTION_ID,MISSING'
        $r.Code | Should -Be 1
        $r.Out | Should -Match 'Did not set the repository secret MISSING'
        $r.Out | Should -Match '1 of 2 secret\(s\) were not set'
        $r.Out | Should -Not -Match '00000000-0000-0000-0000-'
        @($r.Calls | Where-Object { $_ -like 'secret set*' }).Count | Should -Be 1
    }

    It 'with -WhatIf, calls gh for nothing and exits 0' {
        $r = Invoke-Whole '-Repo o/r -WhatIf'
        $r.Code | Should -Be 0
        $r.Calls.Count | Should -Be 0
        $r.Out | Should -Match 'What if'
    }
}

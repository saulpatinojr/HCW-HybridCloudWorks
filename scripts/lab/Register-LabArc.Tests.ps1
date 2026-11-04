<#
    Pester 5 tests for Register-LabArc.ps1.

    The functions are loaded from the script's syntax tree rather than by
    running or dot-sourcing it, so nothing in the script's main body runs: no
    az call, no ssh, nothing on a host. The Entra and Azure steps are tested
    against a mocked Invoke-LabAz, the seam every az call goes through, and
    the host steps against mocked Invoke-LabSsh and Invoke-LabSshInput.

    On Linux, when bash is there (CI), three more groups run for real: the
    host scripts under bash against a stand-in ansible-vault and azcmagent in
    Pester's $TestDrive (these also need a python3 with PyYAML); the bytes
    Invoke-LabSshInput writes, read back by a stand-in ssh; and the whole
    script, with and without -WhatIf, against stand-in az and ssh
    executables that answer its reads from fixtures and refuse every write.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester scripts/lab -Output Detailed"
#>

BeforeDiscovery {
    $hasBash = $IsLinux -and [bool](Get-Command bash -CommandType Application -ErrorAction SilentlyContinue)
    $canRunHostScript = $false
    if ($hasBash -and (Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue)) {
        & python3 -c 'import yaml' 2> $null
        $canRunHostScript = ($LASTEXITCODE -eq 0)
    }
    $canRunFakes = $hasBash -and [bool](Get-Command base64 -CommandType Application -ErrorAction SilentlyContinue)
}

BeforeAll {
    $scriptPath = Join-Path $PSScriptRoot 'Register-LabArc.ps1'
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $null, [ref] $parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw "Register-LabArc.ps1 does not parse: $($parseErrors[0].Message)"
    }
    $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }

    $target = Get-LabArcTarget
    $tenantId = '11111111-2222-4333-8444-555555555555'
    $subscriptionId = 'aaaaaaaa-1111-4222-8333-444444444444'
    $appId = 'bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9'
    $spId = '99999999-5b4a-4938-8271-605f4e3d2c1b'
    $tfId = '22222222-90ab-4cde-8f01-23456789abcd'
    $keyA = 'cccccccc-0000-4000-8000-000000000001'
    $keyB = 'cccccccc-0000-4000-8000-000000000002'
    $groupId = "/subscriptions/$subscriptionId/resourceGroups/rg-lab-hybrid-prod-cus"
    $now = [datetime]::new(2026, 9, 28, 12, 0, 0, [System.DateTimeKind]::Utc)
    # Deliberately not shaped like an Entra client secret, and low in entropy,
    # so no secret scanner mistakes a test fixture for a credential.
    $fakeValue = 'FAKE-VALUE-FAKE-VALUE-FAKE-0001'

    function New-Credential {
        param([string] $KeyId, [datetime] $End, [string] $Hint = 'FAK')
        return [pscustomobject]@{ keyId = $KeyId; displayName = 'Register-LabArc.ps1 azcmagent connect'; endDateTime = $End.ToString('o'); hint = $Hint }
    }

    function New-HostState {
        param(
            [string] $Agent = 'NotInstalled - - -',
            [string] $Helper = 'yes',
            [string] $Fact = 'absent',
            [string] $AppDetail = $appId,
            [string] $TenantDetail = $tenantId,
            [string] $SubscriptionDetail = $subscriptionId,
            [string] $SecretState = 'set',
            [string] $SecretDetail = 'hint-match',
            [string] $Vault = 'present'
        )
        return ConvertFrom-LabArcHostState -Lines @(
            "HCW AGENT $Agent",
            "HCW HELPER $Helper",
            'HCW BOOTSTRAP yes',
            "HCW FACT $Fact",
            "HCW KEY vault_arc_service_principal_id set $AppDetail",
            "HCW KEY vault_arc_service_principal_secret $SecretState $SecretDetail",
            "HCW KEY vault_arc_tenant_id set $TenantDetail",
            "HCW KEY vault_arc_subscription_id set $SubscriptionDetail",
            "HCW VAULT $Vault"
        )
    }

    function Get-DecodedScript {
        param([string] $Command)
        if ($Command -notmatch '\Aecho ([A-Za-z0-9+/=]+) \| base64 -d \| sudo -n bash -s\z') {
            return $null
        }
        return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1]))
    }
}

Describe 'Get-LabArcTarget and Get-LabArcVaultKeys agree with the files they mirror' {
    It 'names the group, machine and region group_vars/all.yml gives the arc role' {
        $vars = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'lab-host/ansible/group_vars/all.yml')
        $vars | Should -Match "(?m)^arc_resource_group: $([regex]::Escape($target.ResourceGroup))$"
        $vars | Should -Match "(?m)^arc_resource_name: $([regex]::Escape($target.MachineName))$"
        $vars | Should -Match "(?m)^arc_location: $([regex]::Escape($target.Location))$"
    }

    It 'names the fact arc_enabled reads' {
        $vars = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'lab-host/ansible/group_vars/all.yml')
        $factName = [System.IO.Path]::GetFileNameWithoutExtension($target.Fact)
        $target.Fact | Should -BeLike '/etc/ansible/facts.d/*.fact'
        $vars | Should -Match ("(?m)^arc_enabled: .*\['ansible_local'\]\['" + [regex]::Escape($factName) + "'\]\['enabled'\]")
    }

    It 'names the role, the rule and the policy assignment infra/lab-hybrid.tf creates' {
        $terraform = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'infra/lab-hybrid.tf')
        $terraform | Should -Match ([regex]::Escape("role_definition_name = ""$($target.OnboardingRole)"""))
        $terraform | Should -Match ([regex]::Escape("name                 = ""$($target.PolicyAssignmentName)"""))
        $terraform | Should -Match ([regex]::Escape('name                = "dcr-lab-hybrid-${var.environment}-${var.region_abbreviation}"'))
        $target.RuleName | Should -Be 'dcr-lab-hybrid-prod-cus'
    }

    It 'lists exactly the four vault keys the arc role reads' {
        $defaults = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'lab-host/ansible/roles/arc/defaults/main.yml')
        $read = @([regex]::Matches($defaults, 'vault_arc_[a-z_]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
        (@(Get-LabArcVaultKeys | Sort-Object) -join ',') | Should -BeExactly ($read -join ',')
    }
}

Describe 'Test-LabGuid and Get-LabTenantIdFromIssuer' {
    It 'accepts a GUID and refuses <Label>' -ForEach @(
        @{ Label = 'an empty string'; Value = '' },
        @{ Label = 'a trailing newline'; Value = "bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9`n" },
        @{ Label = 'braces'; Value = '{bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9}' }
    ) {
        Test-LabGuid -Value $appId | Should -BeTrue
        Test-LabGuid -Value $Value | Should -BeFalse
    }

    It 'reads the tenant id out of a v2 issuer and nothing else' {
        Get-LabTenantIdFromIssuer -Issuer "https://login.microsoftonline.com/$tenantId/v2.0" | Should -BeExactly $tenantId
        Get-LabTenantIdFromIssuer -Issuer "https://sts.windows.net/$tenantId/" | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-LabArcUtc' {
    It 'reads <Label> as UTC' -ForEach @(
        @{ Label = 'an ISO string ending in Z'; Value = '2026-09-29T11:00:00Z' },
        @{ Label = 'an ISO string with an offset'; Value = '2026-09-29T13:00:00+02:00' },
        @{ Label = 'a UTC DateTime, as ConvertFrom-Json makes one'; Value = [datetime]::new(2026, 9, 29, 11, 0, 0, [System.DateTimeKind]::Utc) }
    ) {
        $result = ConvertTo-LabArcUtc -Value $Value
        $result | Should -Be ([datetime]::new(2026, 9, 29, 11, 0, 0, [System.DateTimeKind]::Utc))
        $result.Kind | Should -Be ([System.DateTimeKind]::Utc)
    }

    It 'returns nothing for <Label>' -ForEach @(
        @{ Label = 'null'; Value = $null },
        @{ Label = 'text that is not a date'; Value = 'soon' }
    ) {
        ConvertTo-LabArcUtc -Value $Value | Should -BeNullOrEmpty
    }
}

Describe 'Get-LabArcSecretEndDate and Get-LabArcSecretResetArguments' {
    It 'ends the secret Hours from now, in UTC, in the form az documents' {
        Get-LabArcSecretEndDate -NowUtc $now -Hours 24 | Should -BeExactly '2026-09-29T12:00:00+00:00'
    }

    It 'converts a local time before adding the hours' {
        $local = $now.ToLocalTime()
        Get-LabArcSecretEndDate -NowUtc $local -Hours 1 | Should -BeExactly '2026-09-28T13:00:00+00:00'
    }

    It 'appends, sets the end date only, and prints only the password' {
        $arguments = Get-LabArcSecretResetArguments -AppId $appId -EndDate '2026-09-29T12:00:00+00:00' -KeyDisplayName 'Register-LabArc.ps1 azcmagent connect'
        ($arguments[0..3] -join ' ') | Should -BeExactly 'ad app credential reset'
        $arguments | Should -Contain '--append'
        $arguments | Should -Not -Contain '--years'
        $arguments | Should -Not -Contain '--cert'
        $arguments | Should -Not -Contain '--create-cert'
        $arguments[[array]::IndexOf($arguments, '--id') + 1] | Should -BeExactly $appId
        $arguments[[array]::IndexOf($arguments, '--end-date') + 1] | Should -BeExactly '2026-09-29T12:00:00+00:00'
        $arguments[[array]::IndexOf($arguments, '--query') + 1] | Should -BeExactly 'password'
        $arguments[[array]::IndexOf($arguments, '-o') + 1] | Should -BeExactly 'tsv'
    }
}

Describe 'Test-LabArcSecretShape and Test-LabArcHint' {
    It 'accepts a printable value and refuses <Label>' -ForEach @(
        @{ Label = 'an empty string'; Value = '' },
        @{ Label = 'a short value'; Value = 'abc' },
        @{ Label = 'a space'; Value = 'FAKE VALUE FAKE VALUE FAKE' },
        @{ Label = 'a trailing carriage return'; Value = "FAKE-VALUE-FAKE-VALUE-FAKE`r" }
    ) {
        Test-LabArcSecretShape -Value $fakeValue | Should -BeTrue
        Test-LabArcSecretShape -Value $Value | Should -BeFalse
    }

    It 'accepts a hint of up to three plain characters and refuses <Label>' -ForEach @(
        @{ Label = 'a quote'; Value = "a'b" },
        @{ Label = 'four characters'; Value = 'abcd' },
        @{ Label = 'a dollar'; Value = 'a$b' },
        @{ Label = 'nothing'; Value = '' }
    ) {
        Test-LabArcHint -Value 'x8~' | Should -BeTrue
        Test-LabArcHint -Value $Value | Should -BeFalse
    }
}

Describe 'Get-LabArcSecretPlan' {
    It 'keeps the one live secret the vault holds, and lists expired ones for deletion' {
        $live = New-Credential -KeyId $keyA -End $now.AddHours(20)
        $old = New-Credential -KeyId $keyB -End $now.AddHours(-2)
        $plan = Get-LabArcSecretPlan -Registered @($live, $old) -HostState (New-HostState) -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -NowUtc $now -LifetimeHours 24
        $plan.Action | Should -Be 'Reuse'
        $plan.Keep.keyId | Should -Be $keyA
        @($plan.Remove).Count | Should -Be 1
        $plan.Remove[0].keyId | Should -Be $keyB
    }

    It 'mints, deleting every secret on the registration first, when <Label>' -ForEach @(
        @{ Label = 'there is none'; Hours = @(); State = @{} ; Reason = '*no client secret*' },
        @{ Label = 'the only one expires within the hour'; Hours = @(0.5); State = @{}; Reason = '*expire within*' },
        @{ Label = 'two are live'; Hours = @(20, 10); State = @{}; Reason = '*2 live client secrets*' },
        @{ Label = 'the live one lasts a year, so this script did not make it'; Hours = @(8760); State = @{}; Reason = '*longer than 24 hours*' },
        @{ Label = 'the vault holds another application id'; Hours = @(20); State = @{ AppDetail = '99999999-5b4a-4938-8271-605f4e3d2c1b' }; Reason = "*vault_arc_service_principal_id is not this onboarding's*" },
        @{ Label = 'the vault holds another tenant'; Hours = @(20); State = @{ TenantDetail = 'not-a-guid' }; Reason = "*vault_arc_tenant_id is not*" },
        @{ Label = 'the vault has no secret'; Hours = @(20); State = @{ SecretState = 'absent'; SecretDetail = '-' }; Reason = '*secret is absent*' },
        @{ Label = 'the vault holds a different secret'; Hours = @(20); State = @{ SecretDetail = 'hint-mismatch' }; Reason = "*not the registration's live one*" },
        @{ Label = 'the vault could not be matched against a hint'; Hours = @(20); State = @{ SecretDetail = '-' }; Reason = "*not the registration's live one*" }
    ) {
        $registered = @()
        $i = 0
        foreach ($h in $Hours) {
            $i++
            $registered += New-Credential -KeyId ("cccccccc-0000-4000-8000-00000000000$i") -End $now.AddHours($h)
        }
        $plan = Get-LabArcSecretPlan -Registered $registered -HostState (New-HostState @State) -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -NowUtc $now -LifetimeHours 24
        $plan.Action | Should -Be 'Mint'
        $plan.Reason | Should -BeLike $Reason
        @($plan.Remove).Count | Should -Be $Hours.Count
    }

    It 'compares the identifiers whatever their case' {
        $plan = Get-LabArcSecretPlan -Registered @(New-Credential -KeyId $keyA -End $now.AddHours(20)) -HostState (New-HostState) -AppId $appId.ToUpperInvariant() -TenantId $tenantId.ToUpperInvariant() -SubscriptionId $subscriptionId -NowUtc $now -LifetimeHours 24
        $plan.Action | Should -Be 'Reuse'
    }
}

Describe 'Get-LabArcCandidateHint' {
    It 'returns the hint of the one live secret' {
        Get-LabArcCandidateHint -Registered @(New-Credential -KeyId $keyA -End $now.AddHours(20) -Hint 'x8~') -NowUtc $now | Should -BeExactly 'x8~'
    }

    It 'returns nothing for <Label>' -ForEach @(
        @{ Label = 'no secret'; Hints = @(); Hours = @() },
        @{ Label = 'two live secrets'; Hints = @('abc', 'def'); Hours = @(20, 10) },
        @{ Label = 'an expired one'; Hints = @('abc'); Hours = @(-1) },
        @{ Label = 'a hint that is not plain'; Hints = @("a'b"); Hours = @(20) }
    ) {
        $registered = @()
        for ($i = 0; $i -lt $Hints.Count; $i++) {
            $registered += New-Credential -KeyId ("cccccccc-0000-4000-8000-00000000000$i") -End $now.AddHours($Hours[$i]) -Hint $Hints[$i]
        }
        Get-LabArcCandidateHint -Registered $registered -NowUtc $now | Should -BeExactly ''
    }
}

Describe 'ConvertFrom-LabArcHostState, ConvertFrom-LabArcRemovalOutput and Get-LabArcHostSummary' {
    It 'reads every line of a report, ignoring anything else ssh prints' {
        $state = ConvertFrom-LabArcHostState -Lines @(
            'sudo: unable to resolve host srv1',
            'HCW AGENT Connected arcs-lab-hybrid-prod-cus-01 rg-lab-hybrid-prod-cus 1.68.03532.1399',
            'HCW HELPER yes',
            'HCW BOOTSTRAP yes',
            'HCW FACT enabled',
            "HCW KEY vault_arc_tenant_id set $tenantId",
            'HCW KEY vault_arc_service_principal_secret absent -',
            'HCW VAULT present'
        )
        $state.AgentStatus | Should -Be 'Connected'
        $state.ResourceName | Should -Be 'arcs-lab-hybrid-prod-cus-01'
        $state.ResourceGroup | Should -Be 'rg-lab-hybrid-prod-cus'
        $state.AgentVersion | Should -Be '1.68.03532.1399'
        $state.Helper | Should -BeTrue
        $state.Bootstrap | Should -BeTrue
        $state.Fact | Should -Be 'enabled'
        $state.Vault | Should -Be 'present'
        $state.VaultKeys['vault_arc_tenant_id'].Detail | Should -Be $tenantId
        $state.VaultKeys['vault_arc_service_principal_secret'].State | Should -Be 'absent'
        $state.VaultKeys['vault_arc_subscription_id'].State | Should -Be 'unknown'
    }

    It 'reads a missing vault as four absent keys' {
        $state = ConvertFrom-LabArcHostState -Lines @('HCW AGENT NotInstalled - - -', 'HCW HELPER no', 'HCW FACT absent', 'HCW VAULT missing')
        $state.AgentStatus | Should -Be 'NotInstalled'
        $state.ResourceName | Should -BeNullOrEmpty
        $state.Helper | Should -BeFalse
        foreach ($key in Get-LabArcVaultKeys) {
            $state.VaultKeys[$key].State | Should -Be 'absent'
        }
    }

    It 'reads a removal result and an error' {
        $done = ConvertFrom-LabArcRemovalOutput -Lines @('HCW REMOVE removed removed=vault_arc_tenant_id,vault_arc_service_principal_secret absent=vault_arc_subscription_id')
        $done.State | Should -Be 'removed'
        ($done.Removed -join ',') | Should -BeExactly 'vault_arc_tenant_id,vault_arc_service_principal_secret'
        ($done.Absent -join ',') | Should -BeExactly 'vault_arc_subscription_id'
        $failed = ConvertFrom-LabArcRemovalOutput -Lines @('HCW ERROR no-password /etc/hcw/ansible/vault-password does not exist')
        $failed.State | Should -BeNullOrEmpty
        $failed.ErrorCode | Should -Be 'no-password'
    }

    It 'sums the host up in one line' {
        $line = Get-LabArcHostSummary -State (New-HostState) -HostAlias 'hcw-lab'
        $line | Should -BeLike 'Host: on hcw-lab azcmagent is not installed; the arc fact is not set; the vault helper is there; the vault holds *'
        (Get-LabArcHostSummary -State (New-HostState -Agent 'Connected arcs-lab-hybrid-prod-cus-01 rg-lab-hybrid-prod-cus 1.0') -HostAlias 'hcw-lab') | Should -BeLike '*Connected as arcs-lab-hybrid-prod-cus-01 in rg-lab-hybrid-prod-cus*'
    }
}

Describe 'Get-LabArcHostScript, Get-LabArcFactScript and Get-LabArcRemoteCommand' {
    It 'fills every placeholder in <Mode> mode and is LF only' -ForEach @(
        @{ Mode = 'report' },
        @{ Mode = 'check' },
        @{ Mode = 'remove' }
    ) {
        $text = Get-LabArcHostScript -Mode $Mode -Target $target
        $text | Should -Not -Match '@@HCW_'
        $text | Should -Not -Match "`r"
        $text | Should -Match "(?m)^mode='$Mode'$"
        $text | Should -Match "(?m)^helper='/usr/local/sbin/hcw-vault-set'$"
        $text | Should -Match "(?m)^fact='/etc/ansible/facts.d/hcw_arc.fact'$"
        $text | Should -Match "(?m)^hint=''$"
    }

    It 'carries the hint, and refuses one that could break out of its quotes' {
        (Get-LabArcHostScript -Target $target -Hint 'x8~') | Should -Match "(?m)^hint='x8~'$"
        { Get-LabArcHostScript -Target $target -Hint "a'b" } | Should -Throw '*not safe*'
    }

    It 'refuses a target path that could break out of its quotes' {
        $bad = $target.PSObject.Copy()
        $bad.Fact = "/etc/x'; reboot; '"
        { Get-LabArcHostScript -Target $bad } | Should -Throw '*not safe*'
        { Get-LabArcFactScript -Target $bad } | Should -Throw '*not safe*'
    }

    It 'writes the fact as JSON with enabled true, 0644, by rename' {
        $text = Get-LabArcFactScript -Target $target -State enabled
        $text | Should -Match "(?m)^want='enabled'$"
        $text | Should -Match ([regex]::Escape('content=''{"enabled": true, "set_by": "scripts/lab/Register-LabArc.ps1"}'''))
        $text | Should -Match 'chmod 0644'
        $text | Should -Match 'mv -f -- "\$fact.next" "\$fact"'
        (Get-LabArcFactScript -Target $target -State absent) | Should -Match "(?m)^want='absent'$"
    }

    It 'sends a script as base64 with LF line endings, to bash as root without prompting' {
        $command = Get-LabArcRemoteCommand -BashScript "echo one`r`necho two`n"
        $command | Should -Match '\Aecho [A-Za-z0-9+/=]+ \| base64 -d \| sudo -n bash -s\z'
        Get-DecodedScript -Command $command | Should -BeExactly "echo one`necho two`n"
    }
}

Describe 'Get-LabArcExpectedPlan and Get-LabArcTerraformLines' {
    It 'adds <Add> to the permanent diff for grant <Grant> and policy <Policy>' -ForEach @(
        @{ Grant = $true; Policy = $true; Add = 5 },
        @{ Grant = $true; Policy = $false; Add = 4 },
        @{ Grant = $false; Policy = $true; Add = 4 },
        @{ Grant = $false; Policy = $false; Add = 3 }
    ) {
        Get-LabArcExpectedPlan -NeedGrant:$Grant -NeedPolicy:$Policy | Should -BeExactly "Plan: $Add to add, 1 to change, 3 to destroy"
    }

    It 'names the address, the object id in lower case, HCL off, the plan and the next command' {
        $lines = Get-LabArcTerraformLines -ObjectId $spId.ToUpperInvariant() -NeedGrant -NeedPolicy -Target $target -NextCommand 'pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1 -Connect'
        $text = $lines -join "`n"
        $lines | Should -Contain '  https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables'
        $lines | Should -Contain "  Key: arc_onboarding_principal_id   Value: $spId   HCL: off"
        $lines | Should -Contain '  Key: lab_hybrid_policy_enabled     Value: true   HCL: on'
        $lines | Should -Contain '  Plan: 5 to add, 1 to change, 3 to destroy'
        $lines | Should -Contain '  pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1 -Connect'
        $text | Should -Match 'Terraform variable \(not Environment variable\)'
        $text | Should -Match 'Sensitive left unticked'
        $text | Should -Match ([regex]::Escape('azurerm_role_assignment.arc_onboarding[0] will be created'))
        $text | Should -Match ([regex]::Escape('azurerm_resource_group_policy_assignment.lab_hybrid_linux_baseline[0] will be created'))
    }

    It 'leaves the policy variable out when it is not needed' {
        $text = (Get-LabArcTerraformLines -ObjectId $spId -NeedGrant -Target $target -NextCommand 'x') -join "`n"
        $text | Should -Not -Match 'lab_hybrid_policy_enabled'
        $text | Should -Match 'Plan: 4 to add'
    }

    It 'leaves no placeholder in what the owner pastes' {
        $text = (Get-LabArcTerraformLines -ObjectId $spId -NeedGrant -NeedPolicy -Target $target -NextCommand 'x') -join "`n"
        $text | Should -Not -MatchExactly '<[a-z -]+>|THE[A-Z_]{3,}'
    }

    It 'refuses an object id that is not a GUID when the grant is needed' {
        { Get-LabArcTerraformLines -ObjectId 'not-a-guid' -NeedGrant -Target $target -NextCommand 'x' } | Should -Throw
    }
}

Describe 'Get-LabArcResourcePaths and Get-LabArcReadbackLines' {
    It 'builds the four ids and their addresses with pinned API versions' {
        $paths = Get-LabArcResourcePaths -SubscriptionId $subscriptionId -Target $target
        $paths.MachineId | Should -BeExactly "$groupId/providers/Microsoft.HybridCompute/machines/arcs-lab-hybrid-prod-cus-01"
        $paths.ExtensionId | Should -BeExactly "$($paths.MachineId)/extensions/AzureMonitorLinuxAgent"
        $paths.RuleId | Should -BeExactly "$groupId/providers/Microsoft.Insights/dataCollectionRules/dcr-lab-hybrid-prod-cus"
        $paths.AssociationId | Should -BeExactly "$($paths.MachineId)/providers/Microsoft.Insights/dataCollectionRuleAssociations/dcra-lab-hybrid-prod-cus"
        $paths.MachineUrl | Should -BeExactly "https://management.azure.com$($paths.MachineId)?api-version=2025-01-13"
        $paths.AssociationUrl | Should -BeExactly "https://management.azure.com$($paths.AssociationId)?api-version=2022-06-01"
    }

    It 'prints read-backs with every name written in and no bracketed --query' {
        $text = (Get-LabArcReadbackLines -Target $target -SubscriptionName 'sub-app-site-prod-cus') -join "`n"
        $text | Should -Match ([regex]::Escape('az connectedmachine list -g rg-lab-hybrid-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json | Select-Object name, status, agentVersion, osName'))
        $text | Should -Not -Match '--query'
        $text | Should -Not -MatchExactly '<[a-z -]+>|THE[A-Z_]{3,}'
    }
}

Describe 'Resolve-LabArcSubscription and Get-LabArcResourceGroup' {
    BeforeEach {
        Mock Write-Host { }
    }

    It 'picks the subscription by name in the signed-in tenant' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = "[{""name"":""sub-app-site-prod-cus"",""id"":""$($subscriptionId.ToUpperInvariant())"",""tenantId"":""$tenantId""},{""name"":""sub-app-site-prod-cus"",""id"":""$keyA"",""tenantId"":""$keyB""},{""name"":""sub-plat-mgmt-prod-cus"",""id"":""$keyB"",""tenantId"":""$tenantId""}]" } }
        Resolve-LabArcSubscription -Name 'sub-app-site-prod-cus' -TenantId $tenantId | Should -BeExactly $subscriptionId
    }

    It 'stops when <Label>' -ForEach @(
        @{ Label = 'there is none of that name'; Json = '[]'; Expected = '*no subscription named*' },
        @{ Label = 'there are two'; Json = '[{"name":"sub-app-site-prod-cus","id":"cccccccc-0000-4000-8000-000000000001","tenantId":"11111111-2222-4333-8444-555555555555"},{"name":"sub-app-site-prod-cus","id":"cccccccc-0000-4000-8000-000000000002","tenantId":"11111111-2222-4333-8444-555555555555"}]'; Expected = '*2 subscriptions*' }
    ) {
        $script:json = $Json
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = $script:json } }
        { Resolve-LabArcSubscription -Name 'sub-app-site-prod-cus' -TenantId $tenantId } | Should -Throw $Expected
    }

    It 'returns nothing for a group that does not exist' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 3; Stdout = ''; Stderr = "ERROR: (ResourceGroupNotFound) Resource group 'rg-lab-hybrid-prod-cus' could not be found." } }
        Get-LabArcResourceGroup -SubscriptionId $subscriptionId -Name 'rg-lab-hybrid-prod-cus' | Should -BeNullOrEmpty
    }
}

Describe 'Confirm-LabArcApplication' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        Mock Invoke-LabAz { throw "unexpected az call: $($Arguments -join ' ')" }
    }

    It 'reuses the one registration of exactly that name and its service principal' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } {
            [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = "[{""appId"":""$keyA"",""displayName"":""sp-arc-onboarding-lab-hybrid-prod-cus-old""},{""appId"":""$appId"",""displayName"":""sp-arc-onboarding-lab-hybrid-prod-cus""}]" }
        }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = "[{""id"":""$spId""}]" } }
        $app = Confirm-LabArcApplication -DisplayName 'sp-arc-onboarding-lab-hybrid-prod-cus'
        $app.AppId | Should -BeExactly $appId
        $app.ServicePrincipalId | Should -BeExactly $spId
        $app.AppCreated | Should -BeFalse
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'create' }
    }

    It 'creates a single-tenant registration with no credential, and its service principal' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = '[]' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app create' } { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = "{""appId"":""$appId""}" } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = '[]' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp create' } { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = "{""id"":""$spId""}" } }
        $app = Confirm-LabArcApplication -DisplayName 'sp-arc-onboarding-lab-hybrid-prod-cus'
        $app.AppCreated | Should -BeTrue
        $app.ServicePrincipalCreated | Should -BeTrue
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app create' -and $Arguments -contains 'AzureADMyOrg' }
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'credential' -or $Arguments -contains 'role' }
    }

    It 'creates nothing with -NoCreate or under -WhatIf' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } { [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = '[]' } }
        (Confirm-LabArcApplication -DisplayName 'sp-arc-onboarding-lab-hybrid-prod-cus' -NoCreate).AppId | Should -BeNullOrEmpty
        (Confirm-LabArcApplication -DisplayName 'sp-arc-onboarding-lab-hybrid-prod-cus' -WhatIf).AppId | Should -BeNullOrEmpty
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'create' }
    }

    It 'stops when two registrations have the name' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } {
            [pscustomobject]@{ ExitCode = 0; Stderr = ''; Stdout = '[{"appId":"a1","displayName":"sp-arc-onboarding-lab-hybrid-prod-cus"},{"appId":"a2","displayName":"sp-arc-onboarding-lab-hybrid-prod-cus"}]' }
        }
        { Confirm-LabArcApplication -DisplayName 'sp-arc-onboarding-lab-hybrid-prod-cus' } | Should -Throw '*2 app registrations*'
    }
}

Describe 'Remove-LabArcPasswordCredentials' {
    BeforeEach {
        Mock Write-Host { }
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' } }
    }

    It 'deletes each secret by its key id' {
        $count = Remove-LabArcPasswordCredentials -AppId $appId -Registered @((New-Credential -KeyId $keyA -End $now), (New-Credential -KeyId $keyB -End $now), $null)
        $count | Should -Be 2
        foreach ($key in $keyA, $keyB) {
            Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq "ad app credential delete --id $appId --key-id $key -o none" }
        }
    }

    It 'deletes nothing under -WhatIf' {
        Remove-LabArcPasswordCredentials -AppId $appId -Registered @(New-Credential -KeyId $keyA -End $now) -WhatIf | Should -Be 0
        Should -Invoke Invoke-LabAz -Times 0 -Exactly
    }

    It 'takes a secret that is already gone as deleted' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: No password credential found with key id $keyA" } }
        { Remove-LabArcPasswordCredentials -AppId $appId -Registered @(New-Credential -KeyId $keyA -End $now) } | Should -Not -Throw
    }
}

Describe 'Confirm-LabArcCredentialsGone' {
    # Driven through the real Invoke-LabAzJson and Get-LabArcPasswordCredentials,
    # with only the az seam mocked. The 2026-09-28 bug lived in how the list
    # came back from Get-LabArcPasswordCredentials (return , ...), which a mock
    # of that function would have hidden, as the earlier tests did.
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        $script:listings = [System.Collections.Generic.Queue[string]]::new()
        Mock Invoke-LabAz {
            if (($Arguments -join ' ') -like 'ad app credential list*') {
                $next = if ($script:listings.Count -gt 1) { $script:listings.Dequeue() } else { $script:listings.Peek() }
                return [pscustomobject]@{ ExitCode = 0; Stdout = $next; Stderr = '' }
            }
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        $oneSecret = "[{`"keyId`":`"$keyA`",`"displayName`":`"hcw-arc-onboarding`",`"endDateTime`":`"2026-09-30T00:00:00Z`"}]"
    }

    It 'counts an empty registration as none, first time, with no deletion or wait' {
        $script:listings.Enqueue('[]')
        Confirm-LabArcCredentialsGone -AppId $appId | Should -Be 0
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { ($Arguments -join ' ') -like 'ad app credential delete*' }
        Should -Invoke Start-Sleep -Times 0 -Exactly
    }

    It 'is not fooled by the list coming back as one object (the 2026-09-28 bug)' {
        $script:listings.Enqueue('[]')
        $listed = Get-LabArcPasswordCredentials -AppId $appId
        @($listed | Where-Object { $null -ne $_ }).Count | Should -Be 0
        # The old check wrapped the call itself, which is one element long
        # whatever the registration holds.
        @(Get-LabArcPasswordCredentials -AppId $appId).Count | Should -Be 1
    }

    It 'deletes a secret a lagging read still lists, and believes the next empty read' {
        $script:listings.Enqueue($oneSecret)
        $script:listings.Enqueue('[]')
        Confirm-LabArcCredentialsGone -AppId $appId -DelaySeconds 0 | Should -Be 0
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq "ad app credential delete --id $appId --key-id $keyA -o none" }
    }

    It 'reports what is still listed after the last attempt' {
        $script:listings.Enqueue($oneSecret)
        Confirm-LabArcCredentialsGone -AppId $appId -Attempts 3 -DelaySeconds 0 | Should -Be 1
        Should -Invoke Invoke-LabAz -Times 2 -Exactly -ParameterFilter { ($Arguments -join ' ') -like 'ad app credential delete*' }
    }
}

Describe 'New-LabArcSecret and Set-LabArcVaultValue' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
    }

    It 'returns the value az prints, trimmed, and shows none of it' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stdout = "$fakeValue`n"; Stderr = '' } }
        New-LabArcSecret -AppId $appId -EndDate '2026-09-29T12:00:00+00:00' -KeyDisplayName 'n' | Should -BeExactly $fakeValue
        Should -Invoke Write-Host -Times 0 -Exactly
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { $Arguments -contains '--append' -and $Arguments -contains 'password' }
    }

    It 'refuses a value that is not secret-shaped without repeating it' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stdout = 'short'; Stderr = '' } }
        $message = $null
        try {
            $null = New-LabArcSecret -AppId $appId -EndDate 'x' -KeyDisplayName 'n'
        }
        catch {
            $message = $_.Exception.Message
        }
        $message | Should -BeLike '*not shown*'
        $message | Should -Not -BeLike '*short*'
    }

    It 'stops with az''s own words when the reset fails' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: Insufficient privileges to complete the operation.' } }
        { New-LabArcSecret -AppId $appId -EndDate 'x' -KeyDisplayName 'n' } | Should -Throw '*Insufficient privileges*'
    }

    It 'sends the value on standard input to hcw-vault-set, never on the command line' {
        Mock Invoke-LabSshInput { [pscustomobject]@{ ExitCode = 0; Lines = @() } }
        Set-LabArcVaultValue -HostAlias 'hcw-lab' -Target $target -Key 'vault_arc_service_principal_secret' -Value $fakeValue
        Should -Invoke Invoke-LabSshInput -Times 1 -Exactly -ParameterFilter {
            $HostAlias -eq 'hcw-lab' -and $Command -ceq 'sudo -n /usr/local/sbin/hcw-vault-set vault_arc_service_principal_secret' -and $InputText -ceq $fakeValue
        }
    }

    It 'refuses a key that is not one of the four' {
        Mock Invoke-LabSshInput { throw 'no call expected' }
        { Set-LabArcVaultValue -HostAlias 'hcw-lab' -Target $target -Key 'vault_coder_postgres_password' -Value 'x' } | Should -Throw '*not one of the four*'
    }

    It 'repeats a failing helper''s words, with the value taken out' {
        Mock Invoke-LabSshInput { [pscustomobject]@{ ExitCode = 2; Lines = @("hcw-vault-set: refused $fakeValue") } }
        $message = $null
        try {
            Set-LabArcVaultValue -HostAlias 'hcw-lab' -Target $target -Key 'vault_arc_service_principal_secret' -Value $fakeValue
        }
        catch {
            $message = $_.Exception.Message
        }
        $message | Should -BeLike '*exited 2*refused*value not shown*'
        $message | Should -Not -Match $fakeValue
    }
}

Describe 'Publish-LabArcSecret' {
    BeforeEach {
        $script:shown = [System.Collections.Generic.List[string]]::new()
        $script:order = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $script:shown.Add([string]$Object) }
        Mock Start-Sleep { }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential delete' } {
            $script:order.Add('delete ' + $Arguments[[array]::IndexOf($Arguments, '--key-id') + 1])
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential reset' } {
            $script:order.Add('reset')
            [pscustomobject]@{ ExitCode = 0; Stdout = $fakeValue; Stderr = '' }
        }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential list' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = "[{""keyId"":""$keyB""}]"; Stderr = '' }
        }
        Mock Invoke-LabSshInput {
            $script:order.Add('vault ' + ($Command -split ' ')[-1])
            [pscustomobject]@{ ExitCode = 0; Lines = @() }
        }
    }

    It 'deletes the old secrets, writes the identifiers, mints, then pipes the secret, showing it nowhere' {
        $result = Publish-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -Remove @(New-Credential -KeyId $keyA -End $now) -EndDate '2026-09-29T12:00:00+00:00'
        $result | Should -Be 'Minted'
        ($script:order -join '|') | Should -BeExactly "delete $keyA|vault vault_arc_tenant_id|vault vault_arc_subscription_id|vault vault_arc_service_principal_id|reset|vault vault_arc_service_principal_secret"
        Should -Invoke Invoke-LabSshInput -Times 1 -Exactly -ParameterFilter { $InputText -ceq $fakeValue }
        Should -Invoke Invoke-LabSshInput -Times 1 -Exactly -ParameterFilter { $InputText -ceq $appId }
        ($script:shown -join "`n") | Should -Not -Match $fakeValue
    }

    It 'deletes the new secret from Entra again when the vault write fails, and does not repeat the secret' {
        Mock Invoke-LabSshInput -ParameterFilter { $Command -like '*vault_arc_service_principal_secret' } { [pscustomobject]@{ ExitCode = 1; Lines = @('sudo: a password is required') } }
        $message = $null
        try {
            $null = Publish-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -Remove @() -EndDate 'x'
        }
        catch {
            $message = $_.Exception.Message
        }
        $message | Should -BeLike '*deleted from Entra again*a password is required*'
        $message | Should -Not -Match $fakeValue
        ($script:order -join '|') | Should -BeLike "*reset|delete $keyB"
        ($script:shown -join "`n") | Should -Not -Match $fakeValue
    }

    It 'mints and writes nothing under -WhatIf' {
        Publish-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -Remove @(New-Credential -KeyId $keyA -End $now) -EndDate 'x' -WhatIf | Should -Be 'WouldMint'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly
        Should -Invoke Invoke-LabSshInput -Times 0 -Exactly
    }
}

Describe 'Confirm-LabArcSecret' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        Mock Invoke-LabAz { throw "unexpected az call: $($Arguments -join ' ')" }
        Mock Invoke-LabSshInput { throw 'unexpected vault write' }
    }

    It 'keeps a secret the vault already holds, deleting only expired ones' {
        $script:listed = "[{""keyId"":""$keyA"",""endDateTime"":""$($now.AddHours(20).ToString('o'))"",""hint"":""FAK""},{""keyId"":""$keyB"",""endDateTime"":""$($now.AddHours(-1).ToString('o'))"",""hint"":""old""}]"
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential list' } { [pscustomobject]@{ ExitCode = 0; Stdout = $script:listed; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential delete' } { [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' } }
        Mock Read-LabArcHostState { New-HostState }
        $result = Confirm-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -HostState (New-HostState -SecretDetail '-') -NowUtc $now -LifetimeHours 24
        $result.Action | Should -Be 'Kept'
        $result.Removed | Should -Be 1
        Should -Invoke Read-LabArcHostState -Times 1 -Exactly -ParameterFilter { $Hint -eq 'FAK' }
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { $Arguments -contains 'delete' -and $Arguments -contains $keyB }
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'reset' }
    }

    It 'mints when there is none, and checks the vault reads back as written' {
        $script:listed = '[]'
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential list' } { [pscustomobject]@{ ExitCode = 0; Stdout = $script:listed; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential reset' } {
            $script:listed = "[{""keyId"":""$keyA"",""endDateTime"":""$($now.AddHours(24).ToString('o'))"",""hint"":""FAK""}]"
            [pscustomobject]@{ ExitCode = 0; Stdout = $fakeValue; Stderr = '' }
        }
        Mock Invoke-LabSshInput { [pscustomobject]@{ ExitCode = 0; Lines = @() } }
        Mock Read-LabArcHostState { New-HostState }
        $result = Confirm-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -HostState (New-HostState -SecretState 'absent' -SecretDetail '-') -NowUtc $now -LifetimeHours 24
        $result.Action | Should -Be 'Minted'
        Should -Invoke Invoke-LabSshInput -Times 4 -Exactly
        Should -Invoke Read-LabArcHostState -Times 1 -Exactly -ParameterFilter { $Hint -eq 'FAK' }
    }

    It 'deletes the new secret again when the vault does not read back as written' {
        $script:listed = '[]'
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential list' } { [pscustomobject]@{ ExitCode = 0; Stdout = $script:listed; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential reset' } {
            $script:listed = "[{""keyId"":""$keyA"",""endDateTime"":""$($now.AddHours(24).ToString('o'))"",""hint"":""FAK""}]"
            [pscustomobject]@{ ExitCode = 0; Stdout = $fakeValue; Stderr = '' }
        }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential delete' } { [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' } }
        Mock Invoke-LabSshInput { [pscustomobject]@{ ExitCode = 0; Lines = @() } }
        Mock Read-LabArcHostState { New-HostState -SecretDetail 'hint-mismatch' }
        { Confirm-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -HostState (New-HostState -SecretState 'absent' -SecretDetail '-') -NowUtc $now -LifetimeHours 24 } |
            Should -Throw '*not the one minted*deleted from Entra again*'
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { $Arguments -contains 'delete' -and $Arguments -contains $keyA }
    }

    It 'stops before minting when the vault helper is missing' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..3] -join ' ') -eq 'ad app credential list' } { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        { Confirm-LabArcSecret -HostAlias 'hcw-lab' -Target $target -AppId $appId -TenantId $tenantId -SubscriptionId $subscriptionId -HostState (New-HostState -Helper 'no' -SecretState 'absent') -NowUtc $now -LifetimeHours 24 } |
            Should -Throw '*hcw-vault-set is not on hcw-lab*nothing was minted*'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'reset' }
    }
}

Describe 'Test-LabArcRoleAssignment, Confirm-LabArcPolicyWriter and Get-LabArcPolicyAssignment' {
    BeforeAll {
        $assignments = @"
[{"principalId":"$spId","scope":"$groupId","roleDefinitionName":"Azure Connected Machine Onboarding","roleDefinitionId":"/subscriptions/$subscriptionId/providers/Microsoft.Authorization/roleDefinitions/b64e21ea-ac4e-4cdf-9dc9-5b892992bee7"},
 {"principalId":"$keyA","scope":"$groupId","roleDefinitionName":"Reader","roleDefinitionId":"x"},
 {"principalId":"$tfId","scope":"/subscriptions/$subscriptionId","roleDefinitionName":"Resource Policy Contributor","roleDefinitionId":"y"}]
"@
    }

    BeforeEach {
        Mock Write-Host { }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'role assignment list' } { [pscustomobject]@{ ExitCode = 0; Stdout = $assignments; Stderr = '' } }
    }

    It 'finds the onboarding grant by <Label>' -ForEach @(
        @{ Label = 'role name'; RoleName = 'Azure Connected Machine Onboarding'; RoleId = '' },
        @{ Label = 'role definition id'; RoleName = 'renamed'; RoleId = 'b64e21ea-ac4e-4cdf-9dc9-5b892992bee7' }
    ) {
        Test-LabArcRoleAssignment -Scope $groupId -PrincipalId $spId.ToUpperInvariant() -RoleName $RoleName -RoleId $RoleId | Should -BeTrue
    }

    It 'does not count <Label>' -ForEach @(
        @{ Label = 'another principal'; Principal = '99999999-0000-4938-8271-605f4e3d2c1b'; Role = 'Azure Connected Machine Onboarding' },
        @{ Label = 'a grant at another scope'; Principal = '22222222-90ab-4cde-8f01-23456789abcd'; Role = 'Resource Policy Contributor' },
        @{ Label = 'another role'; Principal = 'cccccccc-0000-4000-8000-000000000001'; Role = 'Contributor' }
    ) {
        Test-LabArcRoleAssignment -Scope $groupId -PrincipalId $Principal -RoleName $Role | Should -BeFalse
    }

    It 'grants the run identity Resource Policy Contributor on the group only, once' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } { [pscustomobject]@{ ExitCode = 0; Stdout = "[{""id"":""$tfId"",""displayName"":""id-plat-terraform-prod-cus-01""}]"; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'role assignment create' } { [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' } }
        $result = Confirm-LabArcPolicyWriter -Scope $groupId -IdentityName 'id-plat-terraform-prod-cus-01' -RoleName 'Resource Policy Contributor'
        $result.Action | Should -Be 'Granted'
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter {
            ($Arguments -join ' ') -eq "role assignment create --assignee-object-id $tfId --assignee-principal-type ServicePrincipal --role Resource Policy Contributor --scope $groupId -o none"
        }
    }

    It 'changes nothing when the grant is there, and grants nothing under -WhatIf' {
        $script:withGrant = $assignments.Replace('"scope":"/subscriptions/' + $subscriptionId + '"', '"scope":"' + $groupId + '"')
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'role assignment list' } { [pscustomobject]@{ ExitCode = 0; Stdout = $script:withGrant; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } { [pscustomobject]@{ ExitCode = 0; Stdout = "[{""id"":""$tfId"",""displayName"":""id-plat-terraform-prod-cus-01""}]"; Stderr = '' } }
        (Confirm-LabArcPolicyWriter -Scope $groupId -IdentityName 'id-plat-terraform-prod-cus-01' -RoleName 'Resource Policy Contributor').Action | Should -Be 'Unchanged'
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'role assignment list' } { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        (Confirm-LabArcPolicyWriter -Scope $groupId -IdentityName 'id-plat-terraform-prod-cus-01' -RoleName 'Resource Policy Contributor' -WhatIf).Action | Should -Be 'WouldGrant'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'create' }
    }

    It 'grants nothing when the run identity is not found by its exact name' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } { [pscustomobject]@{ ExitCode = 0; Stdout = "[{""id"":""$tfId"",""displayName"":""id-plat-terraform-prod-cus-012""}]"; Stderr = '' } }
        (Confirm-LabArcPolicyWriter -Scope $groupId -IdentityName 'id-plat-terraform-prod-cus-01' -RoleName 'Resource Policy Contributor').Action | Should -Be 'NotFound'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'create' }
    }

    It 'finds the policy assignment by name' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'policy assignment list' } { [pscustomobject]@{ ExitCode = 0; Stdout = '[{"name":"some-inherited-one"},{"name":"audit-linux-baseline-lab-hybrid"}]'; Stderr = '' } }
        (Get-LabArcPolicyAssignment -Scope $groupId -Name 'audit-linux-baseline-lab-hybrid').name | Should -Be 'audit-linux-baseline-lab-hybrid'
        Get-LabArcPolicyAssignment -Scope $groupId -Name 'not-there' | Should -BeNullOrEmpty
    }
}

Describe 'Confirm-LabArcMonitorAgent and Confirm-LabArcRuleAssociation' {
    BeforeAll {
        $paths = Get-LabArcResourcePaths -SubscriptionId $subscriptionId -Target $target
    }

    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        $script:putBody = $null
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'put' } {
            $script:putBody = [System.IO.File]::ReadAllText($Arguments[[array]::IndexOf($Arguments, '--body') + 1].Substring(1))
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
    }

    It 'leaves an extension that has succeeded alone' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'get' } { [pscustomobject]@{ ExitCode = 0; Stdout = '{"properties":{"provisioningState":"Succeeded"}}'; Stderr = '' } }
        $result = Confirm-LabArcMonitorAgent -Paths $paths -Target $target -BodyDirectory $TestDrive
        $result.Action | Should -Be 'Unchanged'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'put' }
    }

    It 'installs the agent with automatic upgrade on, waits for Succeeded, and removes the body file' {
        $script:gets = 0
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'get' } {
            $script:gets++
            switch ($script:gets) {
                1 { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: Not Found({"error":{"code":"ResourceNotFound"}})' } }
                2 { [pscustomobject]@{ ExitCode = 0; Stdout = '{"properties":{"provisioningState":"Creating"}}'; Stderr = '' } }
                default { [pscustomobject]@{ ExitCode = 0; Stdout = '{"properties":{"provisioningState":"Succeeded"}}'; Stderr = '' } }
            }
        }
        $result = Confirm-LabArcMonitorAgent -Paths $paths -Target $target -BodyDirectory $TestDrive
        $result.Action | Should -Be 'Installed'
        $result.State | Should -Be 'Succeeded'
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { $Arguments -contains 'put' -and $Arguments -contains $paths.ExtensionUrl }
        $body = $script:putBody | ConvertFrom-Json
        $body.location | Should -Be 'centralus'
        $body.properties.publisher | Should -Be 'Microsoft.Azure.Monitor'
        $body.properties.type | Should -Be 'AzureMonitorLinuxAgent'
        $body.properties.enableAutomaticUpgrade | Should -BeTrue
        @(Get-ChildItem -LiteralPath $TestDrive -Filter 'hcw-lab-arc-*').Count | Should -Be 0
    }

    It 'installs nothing under -WhatIf' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'get' } { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: Not Found' } }
        (Confirm-LabArcMonitorAgent -Paths $paths -Target $target -BodyDirectory $TestDrive -WhatIf).Action | Should -Be 'WouldInstall'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'put' }
    }

    It 'associates the rule when there is no association' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'get' } { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: Not Found' } }
        Confirm-LabArcRuleAssociation -Paths $paths -Target $target -BodyDirectory $TestDrive | Should -Be 'Associated'
        ($script:putBody | ConvertFrom-Json).properties.dataCollectionRuleId | Should -BeExactly $paths.RuleId
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { $Arguments -contains 'put' -and $Arguments -contains $paths.AssociationUrl }
    }

    It 'calls an association <State> when it names <Label>, and never replaces it' -ForEach @(
        @{ Label = 'this rule'; State = 'Unchanged'; Same = $true },
        @{ Label = 'another rule'; State = 'Different'; Same = $false }
    ) {
        $script:rule = if ($Same) { $paths.RuleId } else { '/subscriptions/x/resourceGroups/y/providers/Microsoft.Insights/dataCollectionRules/other' }
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'get' } { [pscustomobject]@{ ExitCode = 0; Stdout = (@{ properties = @{ dataCollectionRuleId = $script:rule } } | ConvertTo-Json); Stderr = '' } }
        Confirm-LabArcRuleAssociation -Paths $paths -Target $target -BodyDirectory $TestDrive | Should -Be $State
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'put' }
    }

    It 'associates nothing under -WhatIf' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'get' } { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: Not Found' } }
        Confirm-LabArcRuleAssociation -Paths $paths -Target $target -BodyDirectory $TestDrive -WhatIf | Should -Be 'WouldAssociate'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'put' }
    }
}

Describe 'The host steps' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
    }

    It 'reads the host state, and says how to set ssh up when it cannot connect' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 0; Lines = @('HCW AGENT Disconnected - - 1.68.03532.1399', 'HCW HELPER yes', 'HCW VAULT missing') } }
        (Read-LabArcHostState -HostAlias 'hcw-lab' -Target $target).AgentStatus | Should -Be 'Disconnected'
        Should -Invoke Invoke-LabSsh -Times 1 -Exactly -ParameterFilter { (Get-DecodedScript -Command $Command) -match "(?m)^mode='report'$" }
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 255; Lines = @('ssh: connect to host hcw-lab port 22: Connection timed out') } }
        { Read-LabArcHostState -HostAlias 'hcw-lab' -Target $target } | Should -Throw '*Connect-Lab.ps1*'
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 1; Lines = @('sudo: a password is required') } }
        { Read-LabArcHostState -HostAlias 'hcw-lab' -Target $target } | Should -Throw '*a password is required*'
    }

    It 'waits until azcmagent reports Connected' {
        $script:reads = 0
        Mock Invoke-LabSsh {
            $script:reads++
            $status = if ($script:reads -lt 3) { 'Disconnected - -' } else { 'Connected arcs-lab-hybrid-prod-cus-01 rg-lab-hybrid-prod-cus' }
            [pscustomobject]@{ ExitCode = 0; Lines = @("HCW AGENT $status 1.68.03532.1399") }
        }
        (Wait-LabArcConnected -HostAlias 'hcw-lab' -Target $target -Attempts 6 -DelaySeconds 1).AgentStatus | Should -Be 'Connected'
        $script:reads | Should -Be 3
    }

    It 'writes the fact, and writes nothing under -WhatIf' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 0; Lines = @('HCW FACT written') } }
        Set-LabArcFact -HostAlias 'hcw-lab' -Target $target -State enabled | Should -Be 'written'
        Should -Invoke Invoke-LabSsh -Times 1 -Exactly -ParameterFilter { (Get-DecodedScript -Command $Command) -match "(?m)^want='enabled'$" }
        Set-LabArcFact -HostAlias 'hcw-lab' -Target $target -State absent -WhatIf | Should -Be 'would-remove'
        Should -Invoke Invoke-LabSsh -Times 1 -Exactly
    }

    It 'stops when the fact cannot be written' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 1; Lines = @('mkdir: cannot create directory') } }
        { Set-LabArcFact -HostAlias 'hcw-lab' -Target $target } | Should -Throw '*cannot create directory*'
    }

    It 'removes the vault keys, or runs in check mode under -WhatIf' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 0; Lines = @('HCW REMOVE removed removed=vault_arc_service_principal_id absent=') } }
        (Remove-LabArcVaultKeys -HostAlias 'hcw-lab' -Target $target).State | Should -Be 'removed'
        Should -Invoke Invoke-LabSsh -Times 1 -Exactly -ParameterFilter { (Get-DecodedScript -Command $Command) -match "(?m)^mode='remove'$" }
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 0; Lines = @('HCW REMOVE would-remove removed=vault_arc_service_principal_id absent=') } }
        (Remove-LabArcVaultKeys -HostAlias 'hcw-lab' -Target $target -WhatIf).State | Should -Be 'would-remove'
        Should -Invoke Invoke-LabSsh -Times 1 -Exactly -ParameterFilter { (Get-DecodedScript -Command $Command) -match "(?m)^mode='check'$" }
    }

    It 'stops with the host''s reason when the removal fails' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 3; Lines = @('HCW ERROR verify the rewrite would change a key this script does not own; nothing was changed') } }
        { Remove-LabArcVaultKeys -HostAlias 'hcw-lab' -Target $target } | Should -Throw '*not changed: the rewrite would change a key*'
    }
}

Describe 'Invoke-LabSshInput, against a stand-in ssh' -Skip:(-not $canRunFakes) {
    It 'writes the value and one line feed to standard input, no carriage return, nothing on the command line' {
        $bin = Join-Path $TestDrive 'ssh-bin'
        New-Item -ItemType Directory -Path $bin | Out-Null
        $captured = Join-Path $TestDrive 'stdin.bin'
        $arguments = Join-Path $TestDrive 'argv.txt'
        $fake = "#!/usr/bin/env bash`nprintf '%s\n' ""`$@"" > '$arguments'`ncat > '$captured'`necho done`n"
        [System.IO.File]::WriteAllText((Join-Path $bin 'ssh'), $fake)
        & chmod +x (Join-Path $bin 'ssh')
        $path = $env:PATH
        try {
            $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$path"
            $run = Invoke-LabSshInput -HostAlias 'hcw-lab' -Command 'sudo -n /usr/local/sbin/hcw-vault-set vault_arc_service_principal_secret' -InputText $fakeValue
        }
        finally {
            $env:PATH = $path
        }
        $run.ExitCode | Should -Be 0
        $run.Lines | Should -Contain 'done'
        [System.IO.File]::ReadAllBytes($captured) | Should -Be ([System.Text.Encoding]::ASCII.GetBytes("$fakeValue`n"))
        (Get-Content -Raw -LiteralPath $arguments) | Should -Not -Match $fakeValue
    }
}

Describe 'the host script, run by bash against stand-ins' -Skip:(-not $canRunHostScript) {
    BeforeAll {
        $fakeVault = Join-Path $TestDrive 'ansible-vault'
        $fakeText = @'
#!/usr/bin/env bash
# Stand-in for ansible-vault: the vault header, then base64.
cmd=$1; shift
pw=; out=; in=
while [ $# -gt 0 ]; do
  case "$1" in
    --vault-password-file) pw=$2; shift 2 ;;
    --output) out=$2; shift 2 ;;
    *) in=$1; shift ;;
  esac
done
[ -f "$pw" ] || { echo "ERROR! password file missing" >&2; exit 1; }
case "$cmd" in
  encrypt) { printf '%s\n' '$ANSIBLE_VAULT;1.1;AES256'; base64 -w0 < "$in"; printf '\n'; } > "$out" ;;
  decrypt) head -n 1 "$in" | grep -q '^\$ANSIBLE_VAULT' || { echo "ERROR! input is not vault encrypted data" >&2; exit 1; }
           tail -n +2 "$in" | base64 -d > "$out" ;;
  *) exit 2 ;;
esac
'@
        [System.IO.File]::WriteAllText($fakeVault, ($fakeText -replace "`r`n", "`n"))
        & chmod +x $fakeVault

        $other = 'OTHER-KEY-VALUE-THAT-STAYS-0001'

        function New-HostDirectory {
            param([switch] $WithPassword, [string] $AgentJson = '', [switch] $WithHelper)
            $directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $directory | Out-Null
            if ($WithPassword) {
                [System.IO.File]::WriteAllText((Join-Path $directory 'vault-password'), "test-password`n")
            }
            if ($AgentJson) {
                $agent = Join-Path $directory 'azcmagent'
                [System.IO.File]::WriteAllText($agent, "#!/usr/bin/env bash`ncat <<'JSON'`n$AgentJson`nJSON`n")
                & chmod +x $agent
            }
            if ($WithHelper) {
                $helper = Join-Path $directory 'hcw-vault-set'
                [System.IO.File]::WriteAllText($helper, "#!/usr/bin/env bash`nexit 0`n")
                & chmod +x $helper
            }
            return $directory
        }

        function Get-HostTarget {
            param([string] $Directory)
            $copy = $target.PSObject.Copy()
            $copy.VaultDirectory = $Directory
            $copy.AnsibleVault = $fakeVault
            $copy.Agent = Join-Path $Directory 'azcmagent'
            $copy.Helper = Join-Path $Directory 'hcw-vault-set'
            $copy.Fact = Join-Path $Directory 'facts.d/hcw_arc.fact'
            $copy.Bootstrap = Join-Path $Directory 'bootstrap.sh'
            return $copy
        }

        function Protect-TestVault {
            param([string] $Directory, [string] $Plain)
            $plainFile = Join-Path $TestDrive ([guid]::NewGuid().ToString('n') + '.yml')
            [System.IO.File]::WriteAllText($plainFile, $Plain)
            & $fakeVault encrypt --vault-password-file (Join-Path $Directory 'vault-password') --output (Join-Path $Directory 'vault.yml') $plainFile
        }

        function Unprotect-TestVault {
            param([string] $Directory)
            $plainFile = Join-Path $TestDrive ([guid]::NewGuid().ToString('n') + '.yml')
            & $fakeVault decrypt --vault-password-file (Join-Path $Directory 'vault-password') --output $plainFile (Join-Path $Directory 'vault.yml')
            return [System.IO.File]::ReadAllText($plainFile)
        }

        function Invoke-TestScript {
            param([string] $Text)
            $file = Join-Path $TestDrive ([guid]::NewGuid().ToString('n') + '.sh')
            [System.IO.File]::WriteAllText($file, $Text)
            # As the host runs it: the script on bash's standard input.
            $lines = @(& bash -c "bash -s < '$file'" 2>&1 | ForEach-Object { [string]$_ })
            return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines }
        }

        function Get-ArcVault {
            param([string] $Secret = $fakeValue)
            return "---`n# Caddy`nvault_cloudflare_api_token: $other`nvault_arc_tenant_id: '$($tenantId.ToUpperInvariant())'`nvault_arc_subscription_id: $subscriptionId`nvault_arc_service_principal_id: $appId`nvault_arc_service_principal_secret: '$Secret'`nvault_coder_multi: |`n  line one`n  line two`n"
        }
    }

    It 'reports a Connected agent, the helper, the fact and the four keys, and never the secret' {
        $directory = New-HostDirectory -WithPassword -WithHelper -AgentJson '{"status": "Connected", "resourceName": "arcs-lab-hybrid-prod-cus-01", "resourceGroup": "rg-lab-hybrid-prod-cus", "agentVersion": "1.68.03532.1399", "tenantId": "x"}'
        $hostTarget = Get-HostTarget -Directory $directory
        New-Item -ItemType Directory -Path (Split-Path $hostTarget.Fact) | Out-Null
        [System.IO.File]::WriteAllText($hostTarget.Fact, '{"enabled": true}')
        Protect-TestVault -Directory $directory -Plain (Get-ArcVault)
        $run = Invoke-TestScript -Text (Get-LabArcHostScript -Mode report -Target $hostTarget -Python 'python3' -Hint 'FAK')
        $run.ExitCode | Should -Be 0
        $state = ConvertFrom-LabArcHostState -Lines $run.Lines
        $state.AgentStatus | Should -Be 'Connected'
        $state.ResourceName | Should -Be 'arcs-lab-hybrid-prod-cus-01'
        $state.Helper | Should -BeTrue
        $state.Bootstrap | Should -BeFalse
        $state.Fact | Should -Be 'enabled'
        $state.Vault | Should -Be 'present'
        $state.VaultKeys['vault_arc_tenant_id'].Detail | Should -BeExactly $tenantId
        $state.VaultKeys['vault_arc_service_principal_id'].Detail | Should -BeExactly $appId
        $state.VaultKeys['vault_arc_service_principal_secret'].Detail | Should -Be 'hint-match'
        ($run.Lines -join "`n") | Should -Not -Match $fakeValue
        ($run.Lines -join "`n") | Should -Not -Match $other
    }

    It 'reports a hint that does not match, a fact that is not true, and no agent' {
        $directory = New-HostDirectory -WithPassword
        $hostTarget = Get-HostTarget -Directory $directory
        New-Item -ItemType Directory -Path (Split-Path $hostTarget.Fact) | Out-Null
        [System.IO.File]::WriteAllText($hostTarget.Fact, '{"enabled": "yes"}')
        Protect-TestVault -Directory $directory -Plain (Get-ArcVault)
        $state = ConvertFrom-LabArcHostState -Lines (Invoke-TestScript -Text (Get-LabArcHostScript -Mode report -Target $hostTarget -Python 'python3' -Hint 'zzz')).Lines
        $state.AgentStatus | Should -Be 'NotInstalled'
        $state.Helper | Should -BeFalse
        $state.Fact | Should -Be 'disabled'
        $state.VaultKeys['vault_arc_service_principal_secret'].Detail | Should -Be 'hint-mismatch'
    }

    It 'reports a missing vault, and a vault it cannot decrypt, without failing' {
        $directory = New-HostDirectory
        (ConvertFrom-LabArcHostState -Lines (Invoke-TestScript -Text (Get-LabArcHostScript -Mode report -Target (Get-HostTarget -Directory $directory) -Python 'python3')).Lines).Vault | Should -Be 'missing'
        $broken = New-HostDirectory -WithPassword
        [System.IO.File]::WriteAllText((Join-Path $broken 'vault.yml'), "not a vault`n")
        $run = Invoke-TestScript -Text (Get-LabArcHostScript -Mode report -Target (Get-HostTarget -Directory $broken) -Python 'python3')
        $run.ExitCode | Should -Be 0
        (ConvertFrom-LabArcHostState -Lines $run.Lines).Vault | Should -Be 'undecryptable'
    }

    It 'removes the four keys, keeps every other line as it was, and never prints a value' {
        $directory = New-HostDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain (Get-ArcVault)
        $run = Invoke-TestScript -Text (Get-LabArcHostScript -Mode remove -Target (Get-HostTarget -Directory $directory) -Python 'python3')
        $run.ExitCode | Should -Be 0
        $result = ConvertFrom-LabArcRemovalOutput -Lines $run.Lines
        $result.State | Should -Be 'removed'
        $result.Removed.Count | Should -Be 4
        ($run.Lines -join "`n") | Should -Not -Match $fakeValue
        (Unprotect-TestVault -Directory $directory) | Should -BeExactly "---`n# Caddy`nvault_cloudflare_api_token: $other`nvault_coder_multi: |`n  line one`n  line two`n"
    }

    It 'changes nothing, byte for byte, when the keys are already gone' {
        $directory = New-HostDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain "vault_cloudflare_api_token: $other`n"
        $before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml')))
        $result = ConvertFrom-LabArcRemovalOutput -Lines (Invoke-TestScript -Text (Get-LabArcHostScript -Mode remove -Target (Get-HostTarget -Directory $directory) -Python 'python3')).Lines
        $result.State | Should -Be 'unchanged'
        $result.Absent.Count | Should -Be 4
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml'))) | Should -BeExactly $before
    }

    It 'writes nothing in check mode' {
        $directory = New-HostDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain (Get-ArcVault)
        $before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml')))
        (ConvertFrom-LabArcRemovalOutput -Lines (Invoke-TestScript -Text (Get-LabArcHostScript -Mode check -Target (Get-HostTarget -Directory $directory) -Python 'python3')).Lines).State | Should -Be 'would-remove'
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml'))) | Should -BeExactly $before
    }

    It 'leaves a mapping behind when the Arc keys were the only ones, because bootstrap.sh passes the vault with -e' {
        $directory = New-HostDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain "vault_arc_tenant_id: $tenantId`n"
        $null = Invoke-TestScript -Text (Get-LabArcHostScript -Mode remove -Target (Get-HostTarget -Directory $directory) -Python 'python3')
        (Unprotect-TestVault -Directory $directory) | Should -BeExactly "{}`n"
    }

    It 'stops, changing nothing, when the vault cannot be read in remove mode' {
        $directory = New-HostDirectory
        [System.IO.File]::WriteAllText((Join-Path $directory 'vault.yml'), "anything`n")
        $run = Invoke-TestScript -Text (Get-LabArcHostScript -Mode remove -Target (Get-HostTarget -Directory $directory) -Python 'python3')
        $run.ExitCode | Should -Be 3
        (ConvertFrom-LabArcRemovalOutput -Lines $run.Lines).ErrorCode | Should -Be 'no-password'
    }

    It 'leaves no temporary directory behind' {
        $directory = New-HostDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain (Get-ArcVault)
        $null = Invoke-TestScript -Text (Get-LabArcHostScript -Mode remove -Target (Get-HostTarget -Directory $directory) -Python 'python3')
        @(Get-ChildItem -LiteralPath '/dev/shm' -Filter 'hcw-arc.*' -ErrorAction SilentlyContinue).Count | Should -Be 0
    }

    It 'writes the fact as a JSON file Ansible reads, then leaves it, then removes it' {
        $directory = New-HostDirectory
        $hostTarget = Get-HostTarget -Directory $directory
        (Invoke-TestScript -Text (Get-LabArcFactScript -Target $hostTarget -State enabled)).Lines | Should -Contain 'HCW FACT written'
        $fact = Get-Content -Raw -LiteralPath $hostTarget.Fact | ConvertFrom-Json
        $fact.enabled | Should -BeTrue
        (& stat -c '%a' $hostTarget.Fact) | Should -Be '644'
        (Invoke-TestScript -Text (Get-LabArcFactScript -Target $hostTarget -State enabled)).Lines | Should -Contain 'HCW FACT unchanged'
        (Invoke-TestScript -Text (Get-LabArcFactScript -Target $hostTarget -State absent)).Lines | Should -Contain 'HCW FACT removed'
        Test-Path -LiteralPath $hostTarget.Fact | Should -BeFalse
        (Invoke-TestScript -Text (Get-LabArcFactScript -Target $hostTarget -State absent)).Lines | Should -Contain 'HCW FACT unchanged'
    }
}

Describe 'the whole script, against stand-in az and ssh that refuse every write' -Skip:(-not $canRunFakes) {
    BeforeAll {
        $pwsh = (Get-Process -Id $PID).Path
        $bin = Join-Path $TestDrive 'bin'
        New-Item -ItemType Directory -Path $bin | Out-Null
        $fakeAz = @'
#!/usr/bin/env bash
# Stand-in for az: answers the reads Register-LabArc.ps1 makes from fixture
# files in $FAKE_DIR and refuses every write.
printf '%s\n' "$*" >> "$FAKE_DIR/az.log"
fixture() {
  if [ -f "$FAKE_DIR/$1.json" ]; then cat "$FAKE_DIR/$1.json"; exit 0; fi
  echo "ERROR: Not Found({\"error\":{\"code\":\"ResourceNotFound\"}})" >&2
  exit 1
}
case "$*" in
  "account show -o json")
    [ -f "$FAKE_DIR/account.json" ] || { echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; }
    fixture account ;;
  "account list --all -o json") fixture subscriptions ;;
  "group show "*) fixture group ;;
  "ad app list "*) fixture apps ;;
  "ad sp list --filter "*) fixture sps ;;
  "ad sp list --display-name "*) fixture tfsps ;;
  "ad app credential list "*) fixture credentials ;;
  "role assignment list "*) fixture assignments ;;
  "policy assignment list "*) fixture policies ;;
  "rest --method get --url "*"/extensions/"*) fixture extension ;;
  "rest --method get --url "*"/dataCollectionRuleAssociations/"*) fixture association ;;
  "rest --method get --url "*"/dataCollectionRules/"*) fixture rule ;;
  "rest --method get --url "*"/machines/"*) fixture machine ;;
esac
echo "az $*" >> "$FAKE_DIR/writes.log"
echo "ERROR: the stand-in az refuses: $*" >&2
exit 99
'@
        $fakeSsh = @'
#!/usr/bin/env bash
# Stand-in for ssh: the last argument is the remote command. Answers the
# report and the check-mode removal; refuses everything else.
cmd="${!#}"
printf '%s\n' "$cmd" >> "$FAKE_DIR/ssh.log"
case "$cmd" in
  "echo "*" | base64 -d | sudo -n bash -s")
    b64="${cmd#echo }"; b64="${b64%% |*}"
    script="$(printf '%s' "$b64" | base64 -d)"
    case "$script" in
      *"mode='report'"*) cat "$FAKE_DIR/host.txt"; exit 0 ;;
      *"mode='check'"*) echo 'HCW REMOVE would-remove removed=vault_arc_service_principal_id absent='; exit 0 ;;
    esac ;;
esac
echo "ssh $cmd" >> "$FAKE_DIR/writes.log"
echo "the stand-in ssh refuses" >&2
exit 99
'@
        [System.IO.File]::WriteAllText((Join-Path $bin 'az'), ($fakeAz -replace "`r`n", "`n"))
        [System.IO.File]::WriteAllText((Join-Path $bin 'ssh'), ($fakeSsh -replace "`r`n", "`n"))
        & chmod +x (Join-Path $bin 'az') (Join-Path $bin 'ssh')

        function New-Fixtures {
            param(
                [switch] $App,
                [switch] $Grant,
                [switch] $PolicyWriter,
                [switch] $Policy,
                [switch] $LiveSecret,
                [string] $Agent = 'NotInstalled - - -',
                [switch] $SignedOut
            )
            $directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $directory | Out-Null
            $write = { param($Name, $Text) [System.IO.File]::WriteAllText((Join-Path $directory $Name), $Text) }
            if (-not $SignedOut) {
                & $write 'account.json' "{""tenantId"":""$tenantId"",""tenantDefaultDomain"":""saulpatinojrhotmail.onmicrosoft.com"",""user"":{""name"":""owner@example.test""}}"
            }
            & $write 'subscriptions.json' "[{""name"":""sub-app-site-prod-cus"",""id"":""$subscriptionId"",""tenantId"":""$tenantId""}]"
            & $write 'group.json' "{""id"":""$groupId"",""name"":""rg-lab-hybrid-prod-cus""}"
            & $write 'apps.json' $(if ($App) { "[{""appId"":""$appId"",""displayName"":""sp-arc-onboarding-lab-hybrid-prod-cus""}]" } else { '[]' })
            & $write 'sps.json' $(if ($App) { "[{""id"":""$spId""}]" } else { '[]' })
            & $write 'tfsps.json' "[{""id"":""$tfId"",""displayName"":""id-plat-terraform-prod-cus-01""}]"
            $end = [datetime]::UtcNow.AddHours(20).ToString('yyyy-MM-ddTHH:mm:ssZ')
            & $write 'credentials.json' $(if ($LiveSecret) { "[{""keyId"":""$keyA"",""endDateTime"":""$end"",""hint"":""FAK""}]" } else { '[]' })
            $assignments = [System.Collections.Generic.List[string]]::new()
            if ($Grant) {
                $assignments.Add("{""principalId"":""$spId"",""scope"":""$groupId"",""roleDefinitionName"":""Azure Connected Machine Onboarding"",""roleDefinitionId"":""x""}")
            }
            if ($PolicyWriter) {
                $assignments.Add("{""principalId"":""$tfId"",""scope"":""$groupId"",""roleDefinitionName"":""Resource Policy Contributor"",""roleDefinitionId"":""y""}")
            }
            & $write 'assignments.json' ('[' + ($assignments -join ',') + ']')
            & $write 'policies.json' $(if ($Policy) { '[{"name":"audit-linux-baseline-lab-hybrid"}]' } else { '[]' })
            $secretLine = if ($LiveSecret) { 'set hint-match' } else { 'absent -' }
            & $write 'host.txt' ((@(
                        "HCW AGENT $Agent",
                        'HCW HELPER yes',
                        'HCW BOOTSTRAP yes',
                        'HCW FACT absent',
                        "HCW KEY vault_arc_service_principal_id $(if ($LiveSecret) { "set $appId" } else { 'absent -' })",
                        "HCW KEY vault_arc_service_principal_secret $secretLine",
                        "HCW KEY vault_arc_tenant_id $(if ($LiveSecret) { "set $tenantId" } else { 'absent -' })",
                        "HCW KEY vault_arc_subscription_id $(if ($LiveSecret) { "set $subscriptionId" } else { 'absent -' })",
                        'HCW VAULT present'
                    ) -join "`n") + "`n")
            return $directory
        }

        function Invoke-WholeScript {
            param([string] $Fixtures, [string[]] $Arguments = @())
            $path = $env:PATH
            $env:FAKE_DIR = $Fixtures
            try {
                $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$path"
                $lines = @(& $pwsh -NoProfile -NonInteractive -File $scriptPath @Arguments 2>&1 | ForEach-Object { [string]$_ })
                $code = $LASTEXITCODE
            }
            finally {
                $env:PATH = $path
                Remove-Item Env:FAKE_DIR -ErrorAction SilentlyContinue
            }
            $writes = Join-Path $Fixtures 'writes.log'
            return [pscustomobject]@{
                ExitCode = $code
                Text     = ($lines -join "`n")
                Writes   = if (Test-Path -LiteralPath $writes) { Get-Content -Raw -LiteralPath $writes } else { '' }
            }
        }
    }

    It 'the first run under -WhatIf on a fresh tenant says what it would do and changes nothing' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures) -Arguments @('-WhatIf')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match 'would create the app registration and service principal sp-arc-onboarding-lab-hybrid-prod-cus'
        $run.Text | Should -Match 'would grant id-plat-terraform-prod-cus-01 Resource Policy Contributor'
        $run.Text | Should -Match 'Secret: would mint one valid for 24 hours'
        $run.Text | Should -Match 'Plan: 5 to add, 1 to change, 3 to destroy'
        $run.Text | Should -Match 'WhatIf: nothing was changed\.'
    }

    It 'a second first run, with everything in place but the hcw-azure apply, changes nothing and says what to set' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -App -PolicyWriter -LiveSecret)
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match "Secret: kept, because the vault holds the registration's live client secret"
        $run.Text | Should -Match ([regex]::Escape("Key: arc_onboarding_principal_id   Value: $spId   HCL: off"))
        $run.Text | Should -Match ([regex]::Escape('Key: lab_hybrid_policy_enabled     Value: true   HCL: on'))
        $run.Text | Should -Match 'Plan: 5 to add, 1 to change, 3 to destroy'
        $run.Text | Should -Match ([regex]::Escape('pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1 -Connect'))
        $run.Text | Should -Match 'No changes:'
        $run.Text | Should -Not -Match 'FAKE-VALUE'
    }

    It 'the first run after the apply says there is nothing to set and names -Connect' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -App -Grant -PolicyWriter -Policy -LiveSecret)
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match 'Nothing to set there'
        $run.Text | Should -Not -Match 'arc_onboarding_principal_id'
    }

    It '-Connect under -WhatIf says it would write the fact and run bootstrap.sh, and changes nothing' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -App -Grant -PolicyWriter -Policy -LiveSecret) -Arguments @('-Connect', '-WhatIf')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match 'holds Azure Connected Machine Onboarding on rg-lab-hybrid-prod-cus, applied by hcw-azure'
        $run.Text | Should -Match 'Host: would write /etc/ansible/facts.d/hcw_arc.fact'
        $run.Text | Should -Match 'Host: would run sudo -n /opt/hcw-src/lab-host/bootstrap.sh'
        $run.Text | Should -Match 'WhatIf: nothing was changed\.'
    }

    It '-Connect under -WhatIf on a Connected host says what it would clean up, and changes nothing' {
        $fixtures = New-Fixtures -App -Grant -PolicyWriter -Policy -LiveSecret -Agent 'Connected arcs-lab-hybrid-prod-cus-01 rg-lab-hybrid-prod-cus 1.68.03532.1399'
        [System.IO.File]::WriteAllText((Join-Path $fixtures 'machine.json'), '{"properties":{"status":"Connected"}}')
        [System.IO.File]::WriteAllText((Join-Path $fixtures 'rule.json'), '{"id":"rule"}')
        $run = Invoke-WholeScript -Fixtures $fixtures -Arguments @('-Connect', '-WhatIf')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match 'Entra: would delete 1 client secret'
        $run.Text | Should -Match 'Vault: would remove vault_arc_service_principal_id'
        $run.Text | Should -Match 'would install the AzureMonitorLinuxAgent extension'
        $run.Text | Should -Match 'would associate dcr-lab-hybrid-prod-cus'
        $run.Text | Should -Match 'WhatIf: nothing was changed\.'
    }

    It '-Connect before the apply stops with the variables to set, and changes nothing' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -App -PolicyWriter -LiveSecret) -Arguments @('-Connect')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'does not hold Azure Connected Machine Onboarding'
        $run.Text | Should -Match ([regex]::Escape("Key: arc_onboarding_principal_id   Value: $spId   HCL: off"))
    }

    It '-Connect before the first run stops and names it' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures) -Arguments @('-Connect')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'there is no sp-arc-onboarding-lab-hybrid-prod-cus yet'
        $run.Text | Should -Match ([regex]::Escape('pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1'))
    }

    It 'stops with the az login line when az is not signed in' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -SignedOut)
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'az is not signed in'
        $run.Text | Should -Match ([regex]::Escape('az login --tenant saulpatinojrhotmail.onmicrosoft.com'))
    }
}

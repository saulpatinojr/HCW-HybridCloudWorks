<#
    Pester 5 tests for Invoke-AlertFireTest.ps1.

    The functions are loaded from the script's syntax tree rather than by
    running or dot-sourcing it, so nothing in the script's main body runs: no
    az call, no ssh, nothing in Azure. Every test is run against a mocked
    Invoke-AlertAz, the seam every az call goes through, which answers reads
    from fixtures and logs every call, so a test can say which commands ran
    and in what order. ssh, gh, the public-address read and the Key Vault
    request have seams of their own, mocked the same way.

    The last group runs the whole script, with and without -WhatIf, against a
    stand-in az in Pester's $TestDrive that answers the script's reads and
    refuses every write: a PowerShell script behind a launcher (az.cmd on
    Windows, a bash wrapper elsewhere), so it runs on a desktop and in CI.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester -Path scripts/alerts -Output Detailed"
#>

BeforeDiscovery {
    # -ForEach data is built during discovery, before BeforeAll runs, so the
    # rule table is read from the script's syntax tree here as well.
    $discoveryAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Invoke-AlertFireTest.ps1'), [ref] $null, [ref] $null)
    $catalogFunction = $discoveryAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-AlertRuleCatalog' }, $false)
    . ([scriptblock]::Create($catalogFunction.Extent.Text))
    $catalogCases = @((Get-AlertRuleCatalog).Values | ForEach-Object { @{ Short = $_.Short; Entry = $_ } })
}

BeforeAll {
    $scriptPath = Join-Path $PSScriptRoot 'Invoke-AlertFireTest.ps1'
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $null, [ref] $parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw "Invoke-AlertFireTest.ps1 does not parse: $($parseErrors[0].Message)"
    }
    $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }

    $appSub = 'aaaaaaaa-1111-4222-8333-444444444444'
    $mgmtSub = 'bbbbbbbb-1111-4222-8333-444444444444'
    $me = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b'
    $start = [datetime]::new(2026, 10, 10, 12, 0, 0, [System.DateTimeKind]::Utc)
    $mgmtGroupId = "/subscriptions/$mgmtSub/resourceGroups/rg-mgmt-plat-prod-cus"
    $webGroupId = "/subscriptions/$appSub/resourceGroups/rg-web-site-prod-cus"
    $kvId = "/subscriptions/$appSub/resourceGroups/rg-sec-site-prod-cus/providers/Microsoft.KeyVault/vaults/kv-site-prod-cus-01"
    $saId = "/subscriptions/$appSub/resourceGroups/rg-web-site-prod-cus/providers/Microsoft.Storage/storageAccounts/stsitefuncprodcus01"
    $swaRuleId = "/subscriptions/$appSub/resourceGroups/rg-web-site-prod-cus/providers/Microsoft.Insights/metricAlerts/alert-swa-bandwidth-prod-cus"
    # Deliberately not shaped like any real credential, so no secret scanner
    # mistakes a fixture for one.
    $fakeSecret = 'FAKE-VALUE-FAKE-VALUE-FAKE-0001'

    function New-TestContext {
        param([Parameter(Mandatory)] [string] $Test, [string] $Directory)
        if (-not $Directory) {
            $Directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $Directory | Out-Null
        }
        $rules = [ordered]@{}
        foreach ($entry in (Get-AlertRuleCatalog).Values) {
            $sub = if ($entry.Subscription -eq 'sub-plat-mgmt-prod-cus') { $mgmtSub } else { $appSub }
            $rules[$entry.Short] = [pscustomobject]@{
                Short          = $entry.Short
                Name           = $entry.Name
                Id             = "/subscriptions/$sub/resourceGroups/$($entry.Group)/providers/$($entry.Type)/$($entry.Name)"
                SubscriptionId = $sub
            }
        }
        return New-AlertContext -Test $Test -RecordDirectory $Directory -Rules $rules -RecoverCommand "pwsh -NoProfile -File Invoke-AlertFireTest.ps1 -Recover -Test $Test"
    }

    function New-Answer {
        param([string] $Match, $Stdout = '', [int] $ExitCode = 0, [string] $Stderr = '')
        $text = if ($Stdout -is [string]) { $Stdout } else { $Stdout | ConvertTo-Json -Depth 20 -Compress }
        return [pscustomobject]@{ Match = $Match; Answer = [pscustomobject]@{ ExitCode = $ExitCode; Stdout = $text; Stderr = $Stderr } }
    }

    function Get-Settings {
        param([string] $HealthPulse = '', [string] $AgentHealth = 'true', [switch] $Broken)
        $rows = [System.Collections.Generic.List[object]]::new()
        $rows.Add(@{ name = 'RUNTIME_CONFIG_WRITER'; value = $(if ($Broken) { 'azurerm' } else { 'azapi-strip' }) })
        $rows.Add(@{ name = 'SOME_PROVIDER_KEY'; value = $fakeSecret })
        $rows.Add(@{ name = 'FEATURE_FLAG_CHECK_AGENT_HEALTH'; value = $AgentHealth })
        if ($HealthPulse) {
            $rows.Add(@{ name = 'AzureWebJobs.healthPulse.Disabled'; value = $HealthPulse })
        }
        return ConvertTo-Json -InputObject $rows.ToArray() -Depth 5 -Compress
    }

    function Get-SwaArm {
        param([long] $Threshold = 2666666666)
        return "{""id"":""$swaRuleId"",""name"":""alert-swa-bandwidth-prod-cus"",""properties"":{""criteria"":{""odata.type"":""Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria"",""allOf"":[{""name"":""BytesSent"",""threshold"":$Threshold}]}}}"
    }

    # Reads that satisfy every stop condition. A test puts its own answers in
    # front; the first pattern that matches answers.
    function Get-BaseAnswers {
        return @(
            (New-Answer -Match '^keyvault show ' -Stdout "{""id"":""$kvId"",""tags"":{""environment"":""prod""}}"),
            (New-Answer -Match '^ad signed-in-user show' -Stdout "{""id"":""$me""}"),
            (New-Answer -Match '^group show -n rg-mgmt-plat-prod-cus ' -Stdout "{""id"":""$mgmtGroupId""}"),
            (New-Answer -Match '^group show -n rg-web-site-prod-cus ' -Stdout "{""id"":""$webGroupId""}"),
            (New-Answer -Match '^role assignment list ' -Stdout '[]'),
            (New-Answer -Match '^role definition list ' -Stdout '[]'),
            (New-Answer -Match '^storage account show ' -Stdout "{""id"":""$saId"",""networkRuleSet"":{""defaultAction"":""Deny"",""ipRules"":[]}}"),
            (New-Answer -Match '^functionapp config appsettings list ' -Stdout (Get-Settings)),
            (New-Answer -Match '^monitor metrics alert show ' -Stdout "{""id"":""$swaRuleId"",""criteria"":{""allOf"":[{""threshold"":2666666666.0}]}}"),
            (New-Answer -Match '^rest --method get --url https://management\.azure\.com/subscriptions/[^ ]+/metricAlerts/' -Stdout (Get-SwaArm)),
            (New-Answer -Match '^rest --method get --url https://management\.azure\.com/subscriptions/[^ ]+/providers/Microsoft\.AlertsManagement/alerts' -Stdout '{"value":[]}')
        )
    }

    $readPattern = '^(account show|ad signed-in-user show|group show|keyvault show|resource show|role assignment list|role definition list|functionapp config appsettings list|storage account show|monitor metrics alert show|rest --method get) '

    function Get-AzWrites {
        return @($script:azLog | Where-Object { $_ -notmatch $readPattern })
    }

    function Get-HostText {
        return ($script:hostLines -join "`n")
    }
}

Describe 'The rule table agrees with the Terraform and the runbook' {
    BeforeAll {
        $terraform = (Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'infra/observability.tf')) + "`n" + (Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'infra/lab-hybrid.tf'))
        $runbook = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'docs/runbooks/alerting-and-support.md')
        $fireRecord = [regex]::Match($runbook, '(?ms)^### Fire record\s*$(.*?)^### ').Groups[1].Value
        $types = @{
            azurerm_monitor_scheduled_query_rules_alert_v2 = 'Microsoft.Insights/scheduledQueryRules'
            azurerm_monitor_metric_alert                   = 'Microsoft.Insights/metricAlerts'
            azurerm_monitor_activity_log_alert             = 'Microsoft.Insights/activityLogAlerts'
        }
        $blocks = @{}
        foreach ($match in [regex]::Matches($terraform, '(?ms)^resource "(azurerm_monitor_[a-z0-9_]+)" "[^"]+" \{(.*?)^\}')) {
            if ($match.Groups[2].Value -match 'name\s+=\s+"(alert-[a-z0-9-]+)-\$\{var\.environment\}-\$\{var\.region_abbreviation\}"') {
                $blocks[$Matches[1]] = [pscustomobject]@{ Type = $match.Groups[1].Value; Body = $match.Groups[2].Value }
            }
        }
    }

    It 'declares <Short> as the catalogue says: kind, subscription and group' -ForEach $catalogCases {
        $blocks.ContainsKey($Short) | Should -BeTrue -Because "$Short should be declared in infra/"
        $block = $blocks[$Short]
        $types[$block.Type] | Should -Be $Entry.Type
        $mgmt = $block.Body -match 'provider\s+=\s+azurerm\.mgmt'
        $Entry.Subscription | Should -Be $(if ($mgmt) { 'sub-plat-mgmt-prod-cus' } else { 'sub-app-site-prod-cus' })
        $group = if ($block.Body -match 'resource_group_name\s+=\s+azurerm_resource_group\.platform_mgmt\.name') { 'rg-mgmt-plat-prod-cus' } elseif ($block.Body -match 'resource_group_name\s+=\s+azurerm_resource_group\.app\["web"\]\.name') { 'rg-web-site-prod-cus' } else { 'unknown' }
        $Entry.Group | Should -Be $group
        $Entry.Name | Should -BeExactly "$Short-prod-cus"
    }

    It 'has a row in the runbook''s Fire record for <Short>' -ForEach $catalogCases {
        $fireRecord | Should -Match ('(?m)^\| `' + [regex]::Escape($Short) + '` \| ')
    }

    It 'offers the ten tests, in the order the caller asked for, each with a definition whose rules are in the table' {
        $parameter = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Test' }
        $set = $parameter.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateSet' }
        $values = @($set.PositionalArguments | ForEach-Object { $_.Value })
        ($values -join ',') | Should -BeExactly 'kv-config-write,rbac-assignment,rbac-definition,kv-errors-and-data-write,lab-vault-unwrap,lab-ssh-burst,jobs-poison,lab-agent-offline,swa-bandwidth,timer-overdue'
        $catalog = Get-AlertRuleCatalog
        $covered = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($value in $values) {
            $definition = Get-AlertTestDefinition -Test $value
            foreach ($short in @($definition.Required) + @($definition.Optional)) {
                $catalog.Contains($short) | Should -BeTrue -Because "$value waits for $short"
            }
            foreach ($short in $definition.Required) {
                $null = $covered.Add($short)
            }
        }
        $covered.Count | Should -Be $catalog.Count -Because 'every rule is some test''s requirement'
    }
}

Describe 'Select-AlertFiredInstance and Get-AlertVerdict, the fired-alert parser' {
    BeforeAll {
        $rule = (New-TestContext -Test 'kv-config-write').Rules['alert-kv-config-write']
        function Get-Response {
            param([object[]] $Alerts)
            $value = foreach ($alert in $Alerts) {
                @{
                    id         = "$($rule.Id)/providers/Microsoft.AlertsManagement/alerts/$([guid]::NewGuid())"
                    properties = @{
                        essentials = @{
                            alertRule        = $(if ($alert.Contains('Rule')) { $alert.Rule } else { $rule.Id })
                            startDateTime    = $alert.Start
                            monitorCondition = $(if ($alert.Contains('Condition')) { $alert.Condition } else { 'Fired' })
                        }
                        context    = $(if ($alert.Contains('Context')) { $alert.Context } else { $null })
                    }
                }
            }
            # Through JSON, as az hands it over, so the dates arrive as
            # ConvertFrom-Json makes them.
            return (ConvertTo-Json -InputObject @{ value = @($value) } -Depth 20 | ConvertFrom-Json)
        }
    }

    It 'does not count an alert that started before the test, and says it is still open' {
        $state = Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T11:58:00Z' })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name
        $state.Fired | Should -BeFalse
        $state.StillFiringSinceUtc | Should -Be ([datetime]::new(2026, 10, 10, 11, 58, 0, [System.DateTimeKind]::Utc))
        $verdict = Get-AlertVerdict -Rule $rule.Short -Name $rule.Name -State $state -Minutes 20
        $verdict.Status | Should -Be 'FAIL'
        $verdict.Line | Should -BeLike 'FAIL alert-kv-config-write-prod-cus: no alert within 20 minutes (an alert of this rule that started at 2026-10-10T11:58:00Z*'
        $verdict.Row | Should -BeNullOrEmpty
    }

    It 'does not count an alert that started at the same instant as the test' {
        (Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T12:00:00Z' })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name).Fired | Should -BeFalse
    }

    It 'counts an alert that started after the test, and reports when' {
        $state = Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T12:03:04Z' })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name
        $state.Fired | Should -BeTrue
        $state.FiredAtUtc | Should -Be ([datetime]::new(2026, 10, 10, 12, 3, 4, [System.DateTimeKind]::Utc))
        $verdict = Get-AlertVerdict -Rule $rule.Short -Name $rule.Name -State $state -Minutes 20
        $verdict.Status | Should -Be 'PASS'
        $verdict.Line | Should -BeExactly 'PASS alert-kv-config-write-prod-cus fired at 2026-10-10T12:03:04Z'
        $verdict.Row | Should -BeExactly '| `alert-kv-config-write` | 2026-10-10 | fired at 12:03Z by Invoke-AlertFireTest.ps1 |'
    }

    It 'takes the earliest of several new alerts and counts them' {
        $state = Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T12:09:00Z' }, @{ Start = '2026-10-10T12:04:00Z' }, @{ Start = '2026-10-10T11:00:00Z' })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name
        $state.Count | Should -Be 2
        $state.FiredAtUtc | Should -Be ([datetime]::new(2026, 10, 10, 12, 4, 0, [System.DateTimeKind]::Utc))
        (Get-AlertVerdict -Rule $rule.Short -Name $rule.Name -State $state -Minutes 20).Line | Should -BeLike '*(2 alerts since the test started)'
    }

    It 'reads a start time written with an offset' {
        $state = Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T07:05:00-05:00' })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name
        $state.FiredAtUtc | Should -Be ([datetime]::new(2026, 10, 10, 12, 5, 0, [System.DateTimeKind]::Utc))
    }

    It 'calls an empty list FAIL' {
        $state = Select-AlertFiredInstance -Response ('{"value":[]}' | ConvertFrom-Json) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name
        $state.Fired | Should -BeFalse
        $state.Count | Should -Be 0
        $verdict = Get-AlertVerdict -Rule $rule.Short -Name $rule.Name -State $state -Minutes 20
        $verdict.Status | Should -Be 'FAIL'
        $verdict.Line | Should -BeExactly 'FAIL alert-kv-config-write-prod-cus: no alert within 20 minutes'
    }

    It 'calls no answer at all FAIL' {
        (Select-AlertFiredInstance -Response $null -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name).Fired | Should -BeFalse
        (Get-AlertVerdict -Rule $rule.Short -Name $rule.Name -State $null -Minutes 20).Status | Should -Be 'FAIL'
    }

    It 'does not take another rule''s alert for this one' {
        $other = $rule.Id -replace 'alert-kv-config-write-prod-cus$', 'alert-kv-config-write-prod-cus-old'
        (Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T12:03:00Z'; Rule = $other })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name).Fired | Should -BeFalse
    }

    It 'recognises the rule by <Label>' -ForEach @(
        @{ Label = 'its name'; Form = 'name' },
        @{ Label = 'its id in lower case'; Form = 'lower' }
    ) {
        $named = if ($Form -eq 'name') { $rule.Name } else { $rule.Id.ToLowerInvariant() }
        (Select-AlertFiredInstance -Response (Get-Response @(@{ Start = '2026-10-10T12:03:00Z'; Rule = $named })) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name).Fired | Should -BeTrue
    }

    It 'with a context to match, counts only the alert whose context names it' {
        $other = @{ Start = '2026-10-10T12:30:00Z'; Context = @{ condition = @{ allOf = @(@{ dimensions = @(@{ name = 'timer'; value = 'syncSocialCalendarScheduled' }) }) } } }
        $mine = @{ Start = '2026-10-10T12:50:00Z'; Context = @{ condition = @{ allOf = @(@{ dimensions = @(@{ name = 'timer'; value = 'healthPulse' }) }) } } }
        (Select-AlertFiredInstance -Response (Get-Response @($other)) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name -ContextMatch 'healthPulse').Fired | Should -BeFalse
        $state = Select-AlertFiredInstance -Response (Get-Response @($other, $mine)) -SinceUtc $start -RuleId $rule.Id -RuleName $rule.Name -ContextMatch 'healthPulse'
        $state.Fired | Should -BeTrue
        $state.FiredAtUtc | Should -Be ([datetime]::new(2026, 10, 10, 12, 50, 0, [System.DateTimeKind]::Utc))
    }

    It 'reports a rule the test does not require as ALSO, and it never fails the run' {
        $context = New-TestContext -Test 'jobs-poison'
        $context.Results.Add((Get-AlertVerdict -Rule 'alert-rbac-assignment-app' -Name 'alert-rbac-assignment-app-prod-cus' -State $null -Minutes 45 -Required $false))
        $context.Results[0].Line | Should -BeExactly 'ALSO alert-rbac-assignment-app-prod-cus: no alert within 45 minutes (not required by this test)'
        Get-AlertExitCode -Context $context | Should -Be 0
        $context.Results.Add((Get-AlertVerdict -Rule 'alert-jobs-poison' -Name 'alert-jobs-poison-prod-cus' -State $null -Minutes 45))
        Get-AlertExitCode -Context $context | Should -Be 2
    }
}

Describe 'Get-AlertQueryArguments' {
    It 'asks for one rule''s alerts of the last hour, with no & in any argument' {
        $id = "/subscriptions/$mgmtSub/resourceGroups/rg-mgmt-plat-prod-cus/providers/Microsoft.Insights/activityLogAlerts/alert-rbac-assignment-mgmt-prod-cus"
        $arguments = Get-AlertQueryArguments -SubscriptionId $mgmtSub -RuleId $id
        ($arguments[0..2] -join ' ') | Should -BeExactly 'rest --method get'
        $arguments[[array]::IndexOf($arguments, '--url') + 1] | Should -BeExactly "https://management.azure.com/subscriptions/$mgmtSub/providers/Microsoft.AlertsManagement/alerts?api-version=2019-03-01"
        $arguments | Should -Contain "alertRule=$id"
        $arguments | Should -Contain 'timeRange=1h'
        $arguments | Should -Contain 'pageCount=250'
        $arguments | Should -Not -Contain 'includeContext=true'
        @($arguments | Where-Object { $_.Contains('&') }).Count | Should -Be 0
    }

    It 'asks for the context, 25 at a time, when the context has to be read' {
        $arguments = Get-AlertQueryArguments -SubscriptionId $appSub -RuleId 'x' -IncludeContext
        $arguments | Should -Contain 'includeContext=true'
        $arguments | Should -Contain 'pageCount=25'
    }
}

Describe 'Wait-AlertFired, the polling' {
    BeforeEach {
        $script:hostLines = [System.Collections.Generic.List[string]]::new()
        $script:azLog = [System.Collections.Generic.List[string]]::new()
        $script:clock = $start.AddMinutes(1)
        $script:polls = 0
        Mock Write-Host { $script:hostLines.Add([string]$Object) }
        Mock Get-AlertUtcNow { $script:clock }
        Mock Wait-AlertSeconds { $script:clock = $script:clock.AddSeconds($Seconds) }
        $context = New-TestContext -Test 'kv-config-write'
        $context.StartUtc = $start
        $script:ruleId = $context.Rules['alert-kv-config-write'].Id
    }

    It 'polls until an alert that started after the test appears, then passes' {
        Mock Invoke-AlertAz {
            $script:azLog.Add($Arguments -join ' ')
            $script:polls++
            if ($script:polls -lt 3) {
                return [pscustomobject]@{ ExitCode = 0; Stdout = '{"value":[]}'; Stderr = '' }
            }
            return [pscustomobject]@{ ExitCode = 0; Stdout = "{""value"":[{""properties"":{""essentials"":{""alertRule"":""$($script:ruleId)"",""startDateTime"":""2026-10-10T12:02:30Z"",""monitorCondition"":""Fired""}}}]}"; Stderr = '' }
        }
        Wait-AlertFired -Context $context -Required @('alert-kv-config-write') -TimeoutMinutes 20
        $script:polls | Should -Be 3
        $context.Results.Count | Should -Be 1
        $context.Results[0].Status | Should -Be 'PASS'
        $context.Results[0].Line | Should -BeExactly 'PASS alert-kv-config-write-prod-cus fired at 2026-10-10T12:02:30Z'
        Should -Invoke Wait-AlertSeconds -Times 2 -Exactly
    }

    It 'never passes on an alert from before the test, and fails at the limit' {
        Mock Invoke-AlertAz {
            $script:polls++
            [pscustomobject]@{ ExitCode = 0; Stdout = "{""value"":[{""properties"":{""essentials"":{""alertRule"":""$($script:ruleId)"",""startDateTime"":""2026-10-10T11:59:59Z"",""monitorCondition"":""Fired""}}}]}"; Stderr = '' }
        }
        Wait-AlertFired -Context $context -Required @('alert-kv-config-write') -TimeoutMinutes 20
        $context.Results[0].Status | Should -Be 'FAIL'
        $context.Results[0].Line | Should -BeLike 'FAIL alert-kv-config-write-prod-cus: no alert within 20 minutes (*still Fired*'
        # The limit counts from the first poll, a minute after the start here.
        $script:clock | Should -BeGreaterOrEqual $start.AddMinutes(21)
        Get-AlertExitCode -Context $context | Should -Be 2
    }

    It 'treats a failed read as no answer yet, and names it if the limit passes' {
        Mock Invoke-AlertAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: (AuthorizationFailed) no read on alerts' } }
        Wait-AlertFired -Context $context -Required @('alert-kv-config-write') -TimeoutMinutes 5
        $context.Results[0].Status | Should -Be 'FAIL'
        $context.Results[0].Line | Should -BeLike '*the last read of the alerts failed: az exited 1. ERROR: (AuthorizationFailed) no read on alerts*'
    }

    It 'counts the limit from -TimeoutMinutes when the run sets one' {
        $context.TimeoutMinutes = 3
        Mock Invoke-AlertAz { [pscustomobject]@{ ExitCode = 0; Stdout = '{"value":[]}'; Stderr = '' } }
        Wait-AlertFired -Context $context -Required @('alert-kv-config-write') -TimeoutMinutes 20
        $context.Results[0].Line | Should -BeExactly 'FAIL alert-kv-config-write-prod-cus: no alert within 3 minutes'
    }

    It 'reads nothing and waits for nothing under -WhatIf' {
        Mock Invoke-AlertAz { throw 'no az call under -WhatIf' }
        Wait-AlertFired -Context $context -Required @('alert-kv-config-write') -Optional @('alert-kv-errors') -TimeoutMinutes 20 -WhatIf
        (@(@($context.Results | ForEach-Object { $_.Status })) -join "`n") | Should -BeExactly (@('WHATIF', 'WHATIF') -join "`n")
        Should -Invoke Invoke-AlertAz -Times 0 -Exactly
        Should -Invoke Wait-AlertSeconds -Times 0 -Exactly
    }
}

Describe 'Format-AlertCommand and Get-AlertRecoverCommand' {
    It 'quotes what PowerShell would otherwise read differently, and only that' {
        Format-AlertCommand -Tool 'az' -Arguments @('tag', 'update', '--tags', 'plat4FireTest20261010120000=1', '-o', 'none') | Should -BeExactly 'az tag update --tags plat4FireTest20261010120000=1 -o none'
        Format-AlertCommand -Tool 'az' -Arguments @('--role', 'Storage Queue Data Contributor', '--body', '@C:\Users\x\plat4-swa-test.json') | Should -BeExactly "az --role 'Storage Queue Data Contributor' --body '@C:\Users\x\plat4-swa-test.json'"
        Format-AlertArgument -Value "it's" | Should -BeExactly "'it''s'"
        Format-AlertArgument -Value 'a,b' | Should -BeExactly "'a,b'"
    }

    It 'names -RecordDirectory only when it is not the default, and quotes a path with a space' {
        Get-AlertRecoverCommand -ScriptPath '/repo/scripts/alerts/Invoke-AlertFireTest.ps1' -Test 'rbac-assignment' -RecordDirectory '/home/owner' -DefaultDirectory '/home/owner' | Should -BeExactly 'pwsh -NoProfile -File /repo/scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test rbac-assignment'
        Get-AlertRecoverCommand -ScriptPath 'C:\My Repo\Invoke-AlertFireTest.ps1' -Test 'swa-bandwidth' -RecordDirectory 'D:\records' -DefaultDirectory 'C:\Users\owner' | Should -BeExactly "pwsh -NoProfile -File 'C:\My Repo\Invoke-AlertFireTest.ps1' -Recover -Test swa-bandwidth -RecordDirectory D:\records"
    }
}

Describe 'Write-AlertRecord, the lock' {
    BeforeEach {
        Mock Write-Host { }
        $context = New-TestContext -Test 'rbac-assignment'
        $path = Join-Path $context.RecordDirectory 'plat4-rbac-test.json'
    }

    It 'writes the record as JSON when there is none' {
        Write-AlertRecord -Context $context -Path $path -Record @{ ra = '/subscriptions/x/roleAssignments/1' } -NoClobber
        (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json).ra | Should -BeExactly '/subscriptions/x/roleAssignments/1'
    }

    It 'refuses to replace an existing record, and leaves it as it was' {
        [System.IO.File]::WriteAllText($path, '{"ra":"the earlier run''s"}')
        { Write-AlertRecord -Context $context -Path $path -Record @{ ra = 'this run''s' } -NoClobber } | Should -Throw '*already exists, so a run is unfinished*'
        [System.IO.File]::ReadAllText($path) | Should -BeExactly '{"ra":"the earlier run''s"}'
    }

    It 'writes nothing under -WhatIf' {
        Write-AlertRecord -Context $context -Path $path -Record @{ ra = 'x' } -NoClobber -WhatIf
        Test-Path -LiteralPath $path | Should -BeFalse
    }
}

Describe 'Assert-AlertSignedIn and Resolve-AlertRule' {
    It 'stops with the az login line when az is not signed in' {
        Mock Invoke-AlertAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: Please run 'az login' to setup account." } }
        $caught = $null
        try { $null = Assert-AlertSignedIn -Estate (Get-AlertEstate) } catch { $caught = $_.Exception }
        $caught.Message | Should -Be 'az is not signed in.'
        $caught.Data['AlertCommand'] | Should -BeExactly 'az login --tenant saulpatinojrhotmail.onmicrosoft.com'
    }

    It 'stops with the az account set line on another default subscription' {
        Mock Invoke-AlertAz { [pscustomobject]@{ ExitCode = 0; Stdout = '{"name":"sub-plat-mgmt-prod-cus","user":{"name":"owner@example.test"}}'; Stderr = '' } }
        $caught = $null
        try { $null = Assert-AlertSignedIn -Estate (Get-AlertEstate) } catch { $caught = $_.Exception }
        $caught.Message | Should -BeLike "*default subscription is 'sub-plat-mgmt-prod-cus'*"
        $caught.Data['AlertCommand'] | Should -BeExactly 'az account set --subscription sub-app-site-prod-cus'
    }

    It 'stops before anything changes when a rule is not there' {
        Mock Invoke-AlertAz { [pscustomobject]@{ ExitCode = 3; Stdout = ''; Stderr = "ERROR: (ResourceNotFound) The Resource 'Microsoft.Insights/activityLogAlerts/alert-kv-config-write-prod-cus' was not found." } }
        { Resolve-AlertRule -Entry (Get-AlertRuleCatalog)['alert-kv-config-write'] } | Should -Throw '*alert-kv-config-write-prod-cus was not found in rg-web-site-prod-cus (sub-app-site-prod-cus)*'
    }

    It 'returns the rule''s id and its subscription id' {
        Mock Invoke-AlertAz { [pscustomobject]@{ ExitCode = 0; Stdout = "{""id"":""/subscriptions/$mgmtSub/resourceGroups/rg-mgmt-plat-prod-cus/providers/Microsoft.Insights/scheduledQueryRules/alert-jobs-poison-prod-cus""}"; Stderr = '' } }
        $rule = Resolve-AlertRule -Entry (Get-AlertRuleCatalog)['alert-jobs-poison']
        $rule.SubscriptionId | Should -BeExactly $mgmtSub
        $rule.Name | Should -BeExactly 'alert-jobs-poison-prod-cus'
        Should -Invoke Invoke-AlertAz -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq 'resource show --name alert-jobs-poison-prod-cus --resource-group rg-mgmt-plat-prod-cus --resource-type Microsoft.Insights/scheduledQueryRules --subscription sub-plat-mgmt-prod-cus -o json' }
    }
}

Describe 'The tests themselves' {
    BeforeEach {
        $script:hostLines = [System.Collections.Generic.List[string]]::new()
        $script:azLog = [System.Collections.Generic.List[string]]::new()
        $script:sshLog = [System.Collections.Generic.List[string]]::new()
        $script:azAnswers = Get-BaseAnswers
        $script:sshAnswers = @{
            'systemctl is-active hcw-labs-agent'                                         = [pscustomobject]@{ ExitCode = 0; Lines = [string[]]@('active') }
            'sudo systemctl stop hcw-labs-agent'                                         = [pscustomobject]@{ ExitCode = 0; Lines = [string[]]@() }
            'sudo systemctl start hcw-labs-agent; systemctl is-active hcw-labs-agent' = [pscustomobject]@{ ExitCode = 0; Lines = [string[]]@('active') }
        }
        Mock Write-Host { $script:hostLines.Add([string]$Object) }
        Mock Wait-AlertSeconds { }
        Mock Get-AlertUtcNow { $start }
        Mock Invoke-AlertAz {
            $line = $Arguments -join ' '
            $script:azLog.Add($line)
            foreach ($answer in $script:azAnswers) {
                if ($line -match $answer.Match) {
                    return $answer.Answer
                }
            }
            return [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        Mock Invoke-AlertSsh {
            $script:sshLog.Add($Command)
            if ($script:sshAnswers.ContainsKey($Command)) {
                return $script:sshAnswers[$Command]
            }
            return [pscustomobject]@{ ExitCode = 0; Lines = [string[]]@() }
        }
        Mock Invoke-AlertGh { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        Mock Get-AlertPublicAddress { '203.0.113.7' }
        Mock Get-AlertVaultToken { $fakeSecret }
        Mock Invoke-AlertVaultWrap { 403 }
    }

    Context 'under -WhatIf' {
        It '<Test> runs only reads, writes no file and prints the changes it would make' -ForEach @(
            @{ Test = 'kv-config-write' },
            @{ Test = 'rbac-assignment' },
            @{ Test = 'rbac-definition' },
            @{ Test = 'kv-errors-and-data-write' },
            @{ Test = 'lab-vault-unwrap' },
            @{ Test = 'lab-ssh-burst' },
            @{ Test = 'jobs-poison' },
            @{ Test = 'lab-agent-offline' },
            @{ Test = 'swa-bandwidth' },
            @{ Test = 'timer-overdue' }
        ) {
            $context = New-TestContext -Test $Test
            Invoke-AlertTestRun -Context $context -WhatIf
            Get-AzWrites | Should -BeNullOrEmpty
            @($script:sshLog | Where-Object { $_ -ne 'systemctl is-active hcw-labs-agent' }) | Should -BeNullOrEmpty
            Should -Invoke Get-AlertVaultToken -Times 0 -Exactly
            Should -Invoke Invoke-AlertVaultWrap -Times 0 -Exactly
            Should -Invoke Wait-AlertSeconds -Times 0 -Exactly
            @(Get-ChildItem -LiteralPath $context.RecordDirectory).Count | Should -Be 0
            $context.Results.Count | Should -BeGreaterThan 0
            @($context.Results | Where-Object { $_.Status -ne 'WHATIF' }) | Should -BeNullOrEmpty
            $context.Problems.Count | Should -Be 0
        }
    }

    Context 'stop conditions' {
        It 'rbac-assignment refuses when its record exists, changing nothing' {
            $context = New-TestContext -Test 'rbac-assignment'
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-rbac-test.json'), '{"ra":"x"}')
            { Invoke-AlertTestRbacAssignment -Context $context } | Should -Throw '*plat4-rbac-test.json exists, so an earlier run did not finish*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'rbac-assignment skips a half where you already hold an assignment, and runs the other' {
            $script:azAnswers = @(New-Answer -Match "^role assignment list --assignee $me --scope $([regex]::Escape($mgmtGroupId)) " -Stdout '[{"roleDefinitionName":"Owner"}]') + (Get-BaseAnswers)
            Mock Wait-AlertFired { }
            $context = New-TestContext -Test 'rbac-assignment'
            Invoke-AlertTestRbacAssignment -Context $context
            $context.Results[0].Status | Should -Be 'SKIPPED'
            $context.Results[0].Row | Should -BeExactly '| `alert-rbac-assignment-mgmt` | not yet | skipped on 2026-10-10 by Invoke-AlertFireTest.ps1: this account already holds a direct assignment at rg-mgmt-plat-prod-cus (Owner) |'
            $writes = @(Get-AzWrites)
            @($writes | Where-Object { $_ -like 'role assignment create *' }).Count | Should -Be 1
            @($writes | Where-Object { $_ -like "role assignment create * --scope $webGroupId -o none" }).Count | Should -Be 1
            Should -Invoke Wait-AlertFired -Times 1 -Exactly -ParameterFilter { ($Required -join ',') -eq 'alert-rbac-assignment-app' }
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-rbac-test.json') | Should -BeFalse
        }

        It 'rbac-definition refuses when its record exists' {
            $context = New-TestContext -Test 'rbac-definition'
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-roledef-test.json'), '{}')
            { Invoke-AlertTestRbacDefinition -Context $context } | Should -Throw '*plat4-roledef-test.json exists*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'rbac-definition refuses when a fire-test role is left behind, and names the line that deletes it' {
            $script:azAnswers = @(New-Answer -Match '^role definition list ' -Stdout '[{"roleName":"plat4-fire-test-11111111-2222-4333-8444-555555555555","id":"x"},{"roleName":"Lab Reader","id":"y"}]') + (Get-BaseAnswers)
            $context = New-TestContext -Test 'rbac-definition'
            $caught = $null
            try { Invoke-AlertTestRbacDefinition -Context $context } catch { $caught = $_.Exception }
            $caught.Message | Should -BeLike '*left behind is still defined at rg-mgmt-plat-prod-cus (plat4-fire-test-11111111-2222-4333-8444-555555555555)*'
            $caught.Data['AlertCommand'] | Should -BeExactly "az role definition delete --name plat4-fire-test-11111111-2222-4333-8444-555555555555 --scope $mgmtGroupId"
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'jobs-poison refuses while a deploy-functions.yml run is in progress' {
            Mock Invoke-AlertGh { [pscustomobject]@{ ExitCode = 0; Stdout = '[{"databaseId":1,"url":"https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1"}]'; Stderr = '' } }
            { Invoke-AlertTestJobsPoison -Context (New-TestContext -Test 'jobs-poison') } | Should -Throw '*deploy-functions.yml run is in progress*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'jobs-poison refuses when gh cannot tell whether it runs alone' {
            Mock Invoke-AlertGh { [pscustomobject]@{ ExitCode = 4; Stdout = ''; Stderr = 'To get started with GitHub CLI, please run:  gh auth login' } }
            { Invoke-AlertTestJobsPoison -Context (New-TestContext -Test 'jobs-poison') } | Should -Throw '*gh could not list the deploy-functions.yml runs*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'jobs-poison refuses when its record exists' {
            $context = New-TestContext -Test 'jobs-poison'
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-poison-test.json'), '{}')
            { Invoke-AlertTestJobsPoison -Context $context } | Should -Throw '*plat4-poison-test.json exists*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'jobs-poison skips, changing nothing, when you already hold an assignment on the account' {
            $script:azAnswers = @(New-Answer -Match '^role assignment list ' -Stdout '[{"roleDefinitionName":"Storage Blob Data Reader"}]') + (Get-BaseAnswers)
            $context = New-TestContext -Test 'jobs-poison'
            Invoke-AlertTestJobsPoison -Context $context
            $context.Results[0].Status | Should -Be 'SKIPPED'
            $context.Results[0].Rule | Should -Be 'alert-jobs-poison'
            Get-AzWrites | Should -BeNullOrEmpty
            @(Get-ChildItem -LiteralPath $context.RecordDirectory).Count | Should -Be 0
        }

        It 'jobs-poison refuses while the firewall is already open' {
            $script:azAnswers = @(New-Answer -Match '^storage account show ' -Stdout "{""id"":""$saId"",""networkRuleSet"":{""ipRules"":[{""ipAddressOrRange"":""198.51.100.4"",""action"":""Allow""}]}}") + (Get-BaseAnswers)
            { Invoke-AlertTestJobsPoison -Context (New-TestContext -Test 'jobs-poison') } | Should -Throw '*already open to 198.51.100.4*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'jobs-poison refuses an address that is not IPv4' {
            Mock Get-AlertPublicAddress { '2001:db8::7' }
            { Invoke-AlertTestJobsPoison -Context (New-TestContext -Test 'jobs-poison') } | Should -Throw '*not an IPv4 address*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'lab-agent-offline refuses when the health timer is not armed' {
            $script:azAnswers = @(New-Answer -Match '^functionapp config appsettings list ' -Stdout (Get-Settings -AgentHealth 'false')) + (Get-BaseAnswers)
            { Invoke-AlertTestLabAgentOffline -Context (New-TestContext -Test 'lab-agent-offline') } | Should -Throw '*FEATURE_FLAG_CHECK_AGENT_HEALTH is false, not true*'
            $script:sshLog.Count | Should -Be 0
        }

        It 'lab-agent-offline refuses when the agent is already down' {
            $script:sshAnswers['systemctl is-active hcw-labs-agent'] = [pscustomobject]@{ ExitCode = 3; Lines = [string[]]@('inactive') }
            { Invoke-AlertTestLabAgentOffline -Context (New-TestContext -Test 'lab-agent-offline') } | Should -Throw "*hcw-labs-agent is 'inactive', not active*"
            (@(@($script:sshLog)) -join "`n") | Should -BeExactly (@('systemctl is-active hcw-labs-agent') -join "`n")
        }

        It 'lab-agent-offline refuses when ssh cannot reach the host' {
            $script:sshAnswers['systemctl is-active hcw-labs-agent'] = [pscustomobject]@{ ExitCode = 255; Lines = [string[]]@('ssh: connect to host hcw-lab port 22: Connection timed out') }
            { Invoke-AlertTestLabAgentOffline -Context (New-TestContext -Test 'lab-agent-offline') } | Should -Throw '*ssh could not reach hcw-lab*'
        }

        It 'swa-bandwidth refuses when its record exists' {
            $context = New-TestContext -Test 'swa-bandwidth'
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-swa-test.json'), '{}')
            { Invoke-AlertTestSwaBandwidth -Context $context } | Should -Throw '*plat4-swa-test.json exists*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'swa-bandwidth refuses, saving nothing, when the threshold is not Terraform''s' {
            $script:azAnswers = @(New-Answer -Match '^rest --method get --url https://management\.azure\.com/subscriptions/[^ ]+/metricAlerts/' -Stdout (Get-SwaArm -Threshold 1)) + (Get-BaseAnswers)
            $context = New-TestContext -Test 'swa-bandwidth'
            { Invoke-AlertTestSwaBandwidth -Context $context } | Should -Throw "*threshold reads '1', not 2666666666*"
            Get-AzWrites | Should -BeNullOrEmpty
            @(Get-ChildItem -LiteralPath $context.RecordDirectory).Count | Should -Be 0
        }

        It 'timer-overdue refuses when its record exists' {
            $context = New-TestContext -Test 'timer-overdue'
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-timer-test.json'), '{}')
            { Invoke-AlertTestTimerOverdue -Context $context } | Should -Throw '*plat4-timer-test.json exists*'
            Get-AzWrites | Should -BeNullOrEmpty
        }

        It 'timer-overdue refuses when the timer is already off' {
            $script:azAnswers = @(New-Answer -Match '^functionapp config appsettings list ' -Stdout (Get-Settings -HealthPulse 'true')) + (Get-BaseAnswers)
            $context = New-TestContext -Test 'timer-overdue'
            { Invoke-AlertTestTimerOverdue -Context $context } | Should -Throw '*already true, so the timer is already off*'
            Get-AzWrites | Should -BeNullOrEmpty
            @(Get-ChildItem -LiteralPath $context.RecordDirectory).Count | Should -Be 0
        }
    }

    Context 'the put-back runs when the action fails' {
        It 'kv-config-write takes the tag off when adding it fails' {
            $script:azAnswers = @(New-Answer -Match '^tag update .* --operation Merge ' -ExitCode 1 -Stderr 'ERROR: (AuthorizationFailed) no write on the vault') + (Get-BaseAnswers)
            $context = New-TestContext -Test 'kv-config-write'
            { Invoke-AlertTestKvConfigWrite -Context $context } | Should -Throw '*Add the test tag to the site vault failed*'
            $writes = @(Get-AzWrites)
            $writes.Count | Should -Be 2
            $writes[0] -match "^tag update --resource-id $([regex]::Escape($kvId)) --operation Merge --tags (plat4FireTest\d{14})=1 -o none$" | Should -BeTrue -Because $writes[0]
            $key = $Matches[1]
            $writes[1] | Should -BeExactly "tag update --resource-id $kvId --operation Delete --tags $key=1 -o none"
            $context.Problems.Count | Should -Be 0
        }

        It 'rbac-assignment deletes by the recorded id when the grant fails, and removes the record once the list is empty' {
            $script:azAnswers = @(New-Answer -Match '^role assignment create ' -ExitCode 1 -Stderr 'ERROR: (AuthorizationFailed) cannot write role assignments') + (Get-BaseAnswers)
            $context = New-TestContext -Test 'rbac-assignment'
            { Invoke-AlertTestRbacAssignment -Context $context } | Should -Throw '*Grant this account Reader on rg-mgmt-plat-prod-cus failed*'
            $writes = @(Get-AzWrites)
            $writes[0] -match '^role assignment create --name ([0-9a-f-]{36}) ' | Should -BeTrue -Because $writes[0]
            $name = $Matches[1]
            $writes[1] | Should -BeExactly "role assignment delete --ids $mgmtGroupId/providers/Microsoft.Authorization/roleAssignments/$name"
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-rbac-test.json') | Should -BeFalse
            $context.Problems.Count | Should -Be 0
        }

        It 'rbac-assignment keeps the record, and exits 3, when the list still shows the assignment' {
            $script:azAnswers = @(New-Answer -Match '^role assignment list ' -Stdout '[{"roleDefinitionName":"Reader"}]') + (Get-BaseAnswers)
            # The stop condition reads the same list, so let the first read be empty.
            $script:listReads = 0
            Mock Invoke-AlertAz -ParameterFilter { ($Arguments -join ' ') -like 'role assignment list *' } {
                $script:azLog.Add($Arguments -join ' ')
                $script:listReads++
                $body = if ($script:listReads -eq 1) { '[]' } else { '[{"roleDefinitionName":"Reader"}]' }
                [pscustomobject]@{ ExitCode = 0; Stdout = $body; Stderr = '' }
            }
            Mock Wait-AlertFired { }
            $context = New-TestContext -Test 'rbac-assignment'
            Invoke-AlertTestRbacAssignment -Context $context
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-rbac-test.json') | Should -BeTrue
            $context.Problems.Count | Should -Be 1
            $context.Problems[0] | Should -BeLike '*still list 1 row(s) (Reader) after the delete*'
            Get-AlertExitCode -Context $context | Should -Be 3
            @(Get-AzWrites | Where-Object { $_ -like 'role assignment create *' }).Count | Should -Be 1 -Because 'the second half does not run while the first is not put back'
        }

        It 'rbac-definition deletes by the recorded name when the create fails, and removes both files' {
            $script:azAnswers = @(New-Answer -Match '^role definition create ' -ExitCode 1 -Stderr 'ERROR: (AuthorizationFailed) cannot write role definitions') + (Get-BaseAnswers)
            $context = New-TestContext -Test 'rbac-definition'
            { Invoke-AlertTestRbacDefinition -Context $context } | Should -Throw '*Create the throwaway role*failed*'
            $writes = @(Get-AzWrites)
            $writes[0] -match '^role definition create --role-definition @(.+[\\/](plat4-fire-test-[0-9a-f-]{36})\.json) -o none$' | Should -BeTrue -Because $writes[0]
            $file = $Matches[1]
            $name = $Matches[2]
            $writes[1] | Should -BeExactly "role definition delete --name $name --scope $mgmtGroupId"
            Test-Path -LiteralPath $file | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-roledef-test.json') | Should -BeFalse
        }

        It 'jobs-poison removes the firewall entry and the role it recorded when the put fails' {
            $script:azAnswers = @(New-Answer -Match '^storage message put ' -ExitCode 1 -Stderr 'ERROR: something unrelated to the role') + (Get-BaseAnswers)
            $context = New-TestContext -Test 'jobs-poison'
            { Invoke-AlertTestJobsPoison -Context $context } | Should -Throw '*Put a message that expires on its own after 15 minutes failed*'
            $writes = @(Get-AzWrites)
            $writes[0] -match '^role assignment create --name ([0-9a-f-]{36}) --assignee-object-id 9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b --assignee-principal-type User --role Storage Queue Data Contributor --scope ' | Should -BeTrue -Because $writes[0]
            $name = $Matches[1]
            $writes | Should -Contain 'storage account network-rule add --account-name stsitefuncprodcus01 -g rg-web-site-prod-cus --ip-address 203.0.113.7 -o none'
            $writes | Should -Contain 'storage account network-rule remove --account-name stsitefuncprodcus01 -g rg-web-site-prod-cus --ip-address 203.0.113.7 -o none'
            $writes | Should -Contain "role assignment delete --ids $saId/providers/Microsoft.Authorization/roleAssignments/$name"
            Should -Invoke Wait-AlertSeconds -ParameterFilter { $Seconds -eq 300 } -Times 1 -Exactly
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-poison-test.json') | Should -BeFalse
        }

        It 'jobs-poison waits and repeats while the role has not taken effect' {
            $script:puts = 0
            Mock Invoke-AlertAz -ParameterFilter { ($Arguments -join ' ') -like 'storage message put *' } {
                $script:azLog.Add($Arguments -join ' ')
                $script:puts++
                if ($script:puts -lt 3) {
                    return [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: This request is not authorized to perform this operation using this permission. ErrorCode:AuthorizationPermissionMismatch' }
                }
                [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
            }
            Mock Wait-AlertFired { }
            $context = New-TestContext -Test 'jobs-poison'
            Invoke-AlertTestJobsPoison -Context $context
            $script:puts | Should -Be 3
            Should -Invoke Wait-AlertSeconds -ParameterFilter { $Seconds -eq 60 } -Times 2 -Exactly
            Should -Invoke Wait-AlertFired -Times 1 -Exactly -ParameterFilter { ($Required -join ',') -eq 'alert-jobs-poison' -and ($Optional -join ',') -eq 'alert-rbac-assignment-app' }
        }

        It 'lab-agent-offline starts the agent again when the wait is interrupted' {
            Mock Wait-AlertSeconds { throw 'interrupted' }
            $context = New-TestContext -Test 'lab-agent-offline'
            { Invoke-AlertTestLabAgentOffline -Context $context } | Should -Throw 'interrupted'
            (@(@($script:sshLog)) -join "`n") | Should -BeExactly (@('systemctl is-active hcw-labs-agent', 'sudo systemctl stop hcw-labs-agent', 'sudo systemctl start hcw-labs-agent; systemctl is-active hcw-labs-agent') -join "`n")
            $context.Problems.Count | Should -Be 0
        }

        It 'lab-agent-offline reports an agent that does not come back' {
            $script:sshAnswers['sudo systemctl start hcw-labs-agent; systemctl is-active hcw-labs-agent'] = [pscustomobject]@{ ExitCode = 3; Lines = [string[]]@('failed') }
            Mock Wait-AlertFired { }
            $context = New-TestContext -Test 'lab-agent-offline'
            Invoke-AlertTestLabAgentOffline -Context $context
            $context.Problems[0] | Should -BeLike "*the last line reads 'failed'*"
            $context.Problems[0] | Should -BeLike "*ssh hcw-lab 'sudo systemctl start hcw-labs-agent; systemctl is-active hcw-labs-agent'*"
        }

        It 'swa-bandwidth puts the saved original back when the wait is interrupted' {
            Mock Wait-AlertFired { throw 'interrupted' }
            $context = New-TestContext -Test 'swa-bandwidth'
            $record = Join-Path $context.RecordDirectory 'plat4-swa-test.json'
            { Invoke-AlertTestSwaBandwidth -Context $context } | Should -Throw 'interrupted'
            $writes = @(Get-AzWrites)
            $writes.Count | Should -Be 2
            $writes[0] | Should -Match "^rest --method put --url https://management\.azure\.com$([regex]::Escape($swaRuleId))\?api-version=2018-03-01 --body @(.+plat4-swa-[0-9a-f-]{36}\.json) -o none$"
            $writes[1] | Should -BeExactly "rest --method put --url https://management.azure.com$swaRuleId`?api-version=2018-03-01 --body @$record -o none"
            Test-Path -LiteralPath $record | Should -BeFalse
            $context.Problems.Count | Should -Be 0
        }

        It 'swa-bandwidth lowers the threshold to one byte in the working copy' {
            $script:workingCopy = $null
            Mock Invoke-AlertAz -ParameterFilter { ($Arguments -join ' ') -match '^rest --method put .*plat4-swa-[0-9a-f]{8}-' } {
                $script:azLog.Add($Arguments -join ' ')
                $script:workingCopy = [System.IO.File]::ReadAllText($Arguments[[array]::IndexOf($Arguments, '--body') + 1].Substring(1))
                [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
            }
            Mock Wait-AlertFired { }
            Invoke-AlertTestSwaBandwidth -Context (New-TestContext -Test 'swa-bandwidth')
            ($script:workingCopy | ConvertFrom-Json).properties.criteria.allOf[0].threshold | Should -Be 1
        }

        It 'timer-overdue deletes the setting it added when the wait is interrupted, and removes the record' {
            Mock Wait-AlertFired { throw 'interrupted' }
            $context = New-TestContext -Test 'timer-overdue'
            { Invoke-AlertTestTimerOverdue -Context $context } | Should -Throw 'interrupted'
            (@(Get-AzWrites) -join "`n") | Should -BeExactly (@(
                    'functionapp config appsettings set -n func-site-prod-cus-01 -g rg-web-site-prod-cus --settings AzureWebJobs.healthPulse.Disabled=true -o none',
                    'functionapp config appsettings delete -n func-site-prod-cus-01 -g rg-web-site-prod-cus --setting-names AzureWebJobs.healthPulse.Disabled -o none'
                ) -join "`n")
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-timer-test.json') | Should -BeFalse
            $context.Problems.Count | Should -Be 0
        }

        It 'timer-overdue puts a prior value back exactly' {
            $script:azAnswers = @(New-Answer -Match '^functionapp config appsettings list ' -Stdout (Get-Settings -HealthPulse 'false')) + (Get-BaseAnswers)
            Mock Wait-AlertFired { throw 'interrupted' }
            $context = New-TestContext -Test 'timer-overdue'
            { Invoke-AlertTestTimerOverdue -Context $context } | Should -Throw 'interrupted'
            @(Get-AzWrites)[1] | Should -BeExactly 'functionapp config appsettings set -n func-site-prod-cus-01 -g rg-web-site-prod-cus --settings AzureWebJobs.healthPulse.Disabled=false -o none'
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-timer-test.json') | Should -BeFalse
        }

        It 'timer-overdue waits for an alert that names healthPulse' {
            Mock Wait-AlertFired { }
            Invoke-AlertTestTimerOverdue -Context (New-TestContext -Test 'timer-overdue')
            Should -Invoke Wait-AlertFired -Times 1 -Exactly -ParameterFilter { $ContextMatch['alert-timer-overdue'] -eq 'healthPulse' -and $TimeoutMinutes -eq 90 }
        }

        It 'timer-overdue reports a broken strip after the put-back' {
            $script:azAnswers = @(New-Answer -Match '^functionapp config appsettings list ' -Stdout (Get-Settings -Broken)) + (Get-BaseAnswers)
            Mock Wait-AlertFired { }
            $context = New-TestContext -Test 'timer-overdue'
            Invoke-AlertTestTimerOverdue -Context $context
            $context.Problems.Count | Should -Be 1
            $context.Problems[0] | Should -BeLike '*RUNTIME_CONFIG_WRITER is azurerm*Do not delete the setting by hand.*'
        }
    }

    Context 'secrets stay out of the output' {
        # Write-Host is mocked into hostLines, so Get-HostText covers it; every
        # other stream (output, error, warning, verbose, debug, information) is
        # merged with *>&1 and checked as well, with verbose and debug turned
        # on so a Write-Verbose or Write-Debug that carried a value would show.
        It 'lab-vault-unwrap sends the token and never prints it on any stream' {
            Mock Wait-AlertFired { }
            $streams = Invoke-AlertTestLabVaultUnwrap -Context (New-TestContext -Test 'lab-vault-unwrap') -Verbose -Debug *>&1 | Out-String
            Should -Invoke Invoke-AlertVaultWrap -Times 1 -Exactly -ParameterFilter { $Token -eq $fakeSecret -and $Uri -eq 'https://kv-labhybrid-prod-cus-01.vault.azure.net/keys/vault-seal/wrapkey?api-version=7.4' }
            $streams | Should -Not -Match $fakeSecret
            Get-HostText | Should -Not -Match $fakeSecret
            Get-HostText | Should -Match 'Refused with 403'
            Should -Invoke Wait-AlertFired -Times 1 -Exactly -ParameterFilter { ($Required -join ',') -eq 'alert-lab-vault-unwrap' -and ($Optional -join ',') -eq 'alert-kv-errors' }
        }

        It 'timer-overdue and lab-agent-offline read the app settings and print none of their values on any stream' {
            Mock Wait-AlertFired { }
            $streams = & {
                Invoke-AlertTestTimerOverdue -Context (New-TestContext -Test 'timer-overdue') -Verbose -Debug
                Invoke-AlertTestLabAgentOffline -Context (New-TestContext -Test 'lab-agent-offline') -Verbose -Debug
            } *>&1 | Out-String
            $streams | Should -Not -Match $fakeSecret
            Get-HostText | Should -Not -Match $fakeSecret
        }

        It 'a value on a stream other than Write-Host would fail these checks' {
            # Guards the guard: the merged capture does see a non-host stream.
            $streams = & { Write-Warning "leak $fakeSecret"; Write-Verbose "leak $fakeSecret" -Verbose } *>&1 | Out-String
            $streams | Should -Match $fakeSecret
        }
    }

    Context 'the other tests' {
        It 'kv-errors-and-data-write asks for one refused write and waits for both rules' {
            $script:azAnswers = @(New-Answer -Match '^keyvault secret set-attributes ' -ExitCode 1 -Stderr 'ERROR: (Forbidden) Client address is not authorized and caller is not a trusted service.') + (Get-BaseAnswers)
            Mock Wait-AlertFired { }
            Invoke-AlertTestKvErrorsAndDataWrite -Context (New-TestContext -Test 'kv-errors-and-data-write')
            @(Get-AzWrites) | Should -HaveCount 1
            @(Get-AzWrites)[0] | Should -Match '^keyvault secret set-attributes --vault-name kv-site-prod-cus-01 --name plat4-fire-test-\d{14} --enabled false$'
            Get-HostText | Should -Match 'Refused with Forbidden'
            Should -Invoke Wait-AlertFired -Times 1 -Exactly -ParameterFilter { ($Required -join ',') -eq 'alert-kv-errors,alert-kv-data-write' }
        }

        It 'lab-ssh-burst writes the lines with logger and stops when ssh cannot reach the host' {
            $command = 'for i in {1..1000}; do logger -p auth.info -t sshd "Invalid user plat4firetest from 192.0.2.10 port 22"; done'
            $script:sshAnswers[$command] = [pscustomobject]@{ ExitCode = 255; Lines = [string[]]@('ssh: Could not resolve hostname hcw-lab') }
            { Invoke-AlertTestLabSshBurst -Context (New-TestContext -Test 'lab-ssh-burst') } | Should -Throw '*ssh could not reach hcw-lab*'
            (@(@($script:sshLog)) -join "`n") | Should -BeExactly (@($command) -join "`n")
        }

        It 'rbac-assignment, end to end: both halves, each recorded, granted, deleted and confirmed' {
            Mock Wait-AlertFired { }
            $context = New-TestContext -Test 'rbac-assignment'
            Invoke-AlertTestRbacAssignment -Context $context
            $writes = @(Get-AzWrites)
            $writes.Count | Should -Be 4
            $writes[0] | Should -BeLike "role assignment create * --role Reader --scope $mgmtGroupId -o none"
            $writes[1] | Should -BeLike "role assignment delete --ids $mgmtGroupId/providers/Microsoft.Authorization/roleAssignments/*"
            $writes[2] | Should -BeLike "role assignment create * --role Reader --scope $webGroupId -o none"
            $writes[3] | Should -BeLike "role assignment delete --ids $webGroupId/providers/Microsoft.Authorization/roleAssignments/*"
            Should -Invoke Wait-AlertFired -Times 1 -Exactly -ParameterFilter { ($Required -join ',') -eq 'alert-rbac-assignment-mgmt,alert-rbac-assignment-app' }
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-rbac-test.json') | Should -BeFalse
            $context.StartUtc | Should -Be $start
        }

        # The Test-Path stop catches a record left by a finished-badly run; the
        # -NoClobber write is what catches one that appears between the two,
        # which is the runbook's reason for making the record the lock.
        It 'rbac-assignment and rbac-definition write their record with -NoClobber, the runbook''s lock' {
            $script:writes = [System.Collections.Generic.List[string]]::new()
            Mock Write-AlertRecord { $script:writes.Add("$([System.IO.Path]::GetFileName($Path)) $([bool]$NoClobber)") }
            Mock Wait-AlertFired { }
            Invoke-AlertTestRbacAssignment -Context (New-TestContext -Test 'rbac-assignment')
            $script:azAnswers = @(New-Answer -Match '^role definition create ' -ExitCode 1 -Stderr 'ERROR: refused') + (Get-BaseAnswers)
            { Invoke-AlertTestRbacDefinition -Context (New-TestContext -Test 'rbac-definition') } | Should -Throw
            ($script:writes -join ',') | Should -BeExactly 'plat4-rbac-test.json True,plat4-rbac-test.json True,plat4-roledef-test.json True'
        }
    }

    Context 'the recoveries' {
        It 'rbac-assignment deletes by the recorded id and removes the record once the list is empty' {
            $context = New-TestContext -Test 'rbac-assignment'
            $ra = "$webGroupId/providers/Microsoft.Authorization/roleAssignments/11111111-2222-4333-8444-555555555555"
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-rbac-test.json'), "{""ra"":""$ra""}")
            $script:azAnswers = @(New-Answer -Match '^role assignment delete ' -ExitCode 1 -Stderr 'ERROR: The role assignment does not exist.') + (Get-BaseAnswers)
            Invoke-AlertTestRun -Context $context -Recover
            (@(Get-AzWrites) -join "`n") | Should -BeExactly (@("role assignment delete --ids $ra") -join "`n")
            $script:azLog | Should -Contain "role assignment list --assignee $me --scope $webGroupId -o json"
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-rbac-test.json') | Should -BeFalse
        }

        It 'jobs-poison removes the recorded address even when this machine''s has changed' {
            $context = New-TestContext -Test 'jobs-poison'
            $ra = "$saId/providers/Microsoft.Authorization/roleAssignments/11111111-2222-4333-8444-555555555555"
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-poison-test.json'), "{""ip"":""198.51.100.9"",""ra"":""$ra""}")
            Invoke-AlertTestRun -Context $context -Recover
            (@(Get-AzWrites) -join "`n") | Should -BeExactly (@(
                    'storage account network-rule remove --account-name stsitefuncprodcus01 -g rg-web-site-prod-cus --ip-address 198.51.100.9 -o none',
                    "role assignment delete --ids $ra"
                ) -join "`n")
            Should -Invoke Get-AlertPublicAddress -Times 0 -Exactly
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-poison-test.json') | Should -BeFalse
        }

        It 'timer-overdue restores the recorded value and keeps the record when the read does not match' {
            $context = New-TestContext -Test 'timer-overdue'
            [System.IO.File]::WriteAllText((Join-Path $context.RecordDirectory 'plat4-timer-test.json'), '{"present":true,"value":"false"}')
            Invoke-AlertTestRun -Context $context -Recover
            (@(Get-AzWrites) -join "`n") | Should -BeExactly (@('functionapp config appsettings set -n func-site-prod-cus-01 -g rg-web-site-prod-cus --settings AzureWebJobs.healthPulse.Disabled=false -o none') -join "`n")
            Test-Path -LiteralPath (Join-Path $context.RecordDirectory 'plat4-timer-test.json') | Should -BeTrue
            $context.Problems[0] | Should -BeLike "AzureWebJobs.healthPulse.Disabled reads no row, and the record says 'false'*"
        }

        It 'swa-bandwidth puts the saved original back and removes it once the threshold matches' {
            $context = New-TestContext -Test 'swa-bandwidth'
            $record = Join-Path $context.RecordDirectory 'plat4-swa-test.json'
            [System.IO.File]::WriteAllText($record, (Get-SwaArm))
            Invoke-AlertTestRun -Context $context -Recover
            (@(Get-AzWrites) -join "`n") | Should -BeExactly (@("rest --method put --url https://management.azure.com$swaRuleId`?api-version=2018-03-01 --body @$record -o none") -join "`n")
            Test-Path -LiteralPath $record | Should -BeFalse
        }

        It 'kv-config-write takes off a tag a cut-off run left' {
            $script:azAnswers = @(New-Answer -Match '^keyvault show ' -Stdout "{""id"":""$kvId"",""tags"":{""plat4FireTest20261010120000"":""1"",""environment"":""prod""}}") + (Get-BaseAnswers)
            $script:vaultReads = 0
            Mock Invoke-AlertAz -ParameterFilter { ($Arguments -join ' ') -like 'keyvault show *' } {
                $script:azLog.Add($Arguments -join ' ')
                $script:vaultReads++
                $tags = if ($script:vaultReads -eq 1) { '{"plat4FireTest20261010120000":"1","environment":"prod"}' } else { '{"environment":"prod"}' }
                [pscustomobject]@{ ExitCode = 0; Stdout = "{""id"":""$kvId"",""tags"":$tags}"; Stderr = '' }
            }
            $context = New-TestContext -Test 'kv-config-write'
            Invoke-AlertTestRun -Context $context -Recover
            (@(Get-AzWrites) -join "`n") | Should -BeExactly (@("tag update --resource-id $kvId --operation Delete --tags plat4FireTest20261010120000=1 -o none") -join "`n")
            $context.Problems.Count | Should -Be 0
        }

        It '<Test> has nothing to recover and changes nothing' -ForEach @(
            @{ Test = 'kv-errors-and-data-write' },
            @{ Test = 'lab-vault-unwrap' },
            @{ Test = 'lab-ssh-burst' },
            @{ Test = 'rbac-definition' },
            @{ Test = 'swa-bandwidth' }
        ) {
            Invoke-AlertTestRun -Context (New-TestContext -Test $Test) -Recover
            Get-AzWrites | Should -BeNullOrEmpty
            Get-HostText | Should -Match 'Nothing to recover'
        }
    }
}

Describe 'the whole script, against a stand-in az that refuses every write' {
    BeforeAll {
        $pwsh = (Get-Process -Id $PID).Path
        $bin = Join-Path $TestDrive 'bin'
        New-Item -ItemType Directory -Path $bin | Out-Null
        $fake = @'
# Stand-in for az: answers the reads Invoke-AlertFireTest.ps1 makes from the
# fixtures in $env:FAKE_DIR and refuses every write, logging both.
$argv = @($args | ForEach-Object { [string]$_ })
$line = $argv -join ' '
$dir = $env:FAKE_DIR
Add-Content -LiteralPath (Join-Path $dir 'az.log') -Value $line
function Get-Value([string] $Name) {
    $index = [array]::IndexOf($argv, $Name)
    if ($index -ge 0 -and $index + 1 -lt $argv.Count) { return $argv[$index + 1] }
    return ''
}
function Get-Subscription([string] $Name) {
    if ($Name -eq 'sub-plat-mgmt-prod-cus') { return 'bbbbbbbb-1111-4222-8333-444444444444' }
    return 'aaaaaaaa-1111-4222-8333-444444444444'
}
function Write-Answer([string] $Text) { [Console]::Out.Write($Text); exit 0 }
switch -Regex ($line) {
    '^account show' {
        $file = Join-Path $dir 'account.json'
        if (-not (Test-Path -LiteralPath $file)) { [Console]::Error.WriteLine("ERROR: Please run 'az login' to setup account."); exit 1 }
        Write-Answer (Get-Content -Raw -LiteralPath $file)
    }
    '^resource show ' {
        $name = Get-Value '--name'
        $missing = Join-Path $dir 'missing.txt'
        if ((Test-Path -LiteralPath $missing) -and ((Get-Content -LiteralPath $missing) -contains $name)) {
            [Console]::Error.WriteLine("ERROR: (ResourceNotFound) The Resource '$name' was not found."); exit 3
        }
        Write-Answer ("{""id"":""/subscriptions/$(Get-Subscription (Get-Value '--subscription'))/resourceGroups/$(Get-Value '--resource-group')/providers/$(Get-Value '--resource-type')/$name""}")
    }
    '^keyvault show ' { Write-Answer '{"id":"/subscriptions/aaaaaaaa-1111-4222-8333-444444444444/resourceGroups/rg-sec-site-prod-cus/providers/Microsoft.KeyVault/vaults/kv-site-prod-cus-01","tags":{}}' }
    '^ad signed-in-user show' { Write-Answer '{"id":"9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b"}' }
    '^group show ' { Write-Answer ("{""id"":""/subscriptions/$(Get-Subscription (Get-Value '--subscription'))/resourceGroups/$(Get-Value '-n')""}") }
    '^role assignment list ' { Write-Answer '[]' }
    '^role definition list ' { Write-Answer '[]' }
}
Add-Content -LiteralPath (Join-Path $dir 'writes.log') -Value "az $line"
[Console]::Error.WriteLine("ERROR: the stand-in az refuses: $line")
exit 99
'@
        [System.IO.File]::WriteAllText((Join-Path $bin 'fake-az.ps1'), ($fake -replace "`r`n", "`n"))
        if ($IsWindows) {
            $launcher = "@echo off`r`n""$pwsh"" -NoProfile -NonInteractive -File ""%~dp0fake-az.ps1"" %*`r`nexit /b %ERRORLEVEL%`r`n"
            [System.IO.File]::WriteAllText((Join-Path $bin 'az.cmd'), $launcher)
        }
        else {
            $launcher = "#!/usr/bin/env bash`nexec '$pwsh' -NoProfile -NonInteractive -File ""`$(dirname ""`$0"")/fake-az.ps1"" ""`$@""`n"
            [System.IO.File]::WriteAllText((Join-Path $bin 'az'), $launcher)
            & chmod +x (Join-Path $bin 'az')
        }

        function New-Fixtures {
            param([string] $Subscription = 'sub-app-site-prod-cus', [switch] $SignedOut, [string[]] $Missing = @())
            $directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path (Join-Path $directory 'records') -Force | Out-Null
            if (-not $SignedOut) {
                [System.IO.File]::WriteAllText((Join-Path $directory 'account.json'), "{""name"":""$Subscription"",""user"":{""name"":""owner@example.test""}}")
            }
            if ($Missing.Count -gt 0) {
                [System.IO.File]::WriteAllText((Join-Path $directory 'missing.txt'), ($Missing -join "`n"))
            }
            return $directory
        }

        function Invoke-WholeScript {
            param([string] $Fixtures, [string[]] $Arguments = @())
            $path = $env:PATH
            $env:FAKE_DIR = $Fixtures
            try {
                $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$path"
                $lines = @(& $pwsh -NoProfile -NonInteractive -File $scriptPath @Arguments -RecordDirectory (Join-Path $Fixtures 'records') 2>&1 | ForEach-Object { [string]$_ })
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

    It 'kv-config-write under -WhatIf prints the two tag writes, changes nothing and exits 0' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures) -Arguments @('-Test', 'kv-config-write', '-WhatIf')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match 'Rules: alert-kv-config-write-prod-cus, all found\.'
        $run.Text | Should -Match 'What if: Add the test tag to the site vault: az tag update --resource-id /subscriptions/aaaaaaaa-1111-4222-8333-444444444444/resourceGroups/rg-sec-site-prod-cus/providers/Microsoft\.KeyVault/vaults/kv-site-prod-cus-01 --operation Merge --tags plat4FireTest\d{14}=1 -o none'
        $run.Text | Should -Match 'What if: Take the test tag off the site vault: az tag update .* --operation Delete --tags plat4FireTest\d{14}=1 -o none'
        $run.Text | Should -Match 'WHATIF alert-kv-config-write-prod-cus: would poll'
        $run.Text | Should -Match 'WhatIf: nothing was changed\.'
    }

    It 'rbac-assignment under -WhatIf refuses on an unfinished run''s record, leaves it, and exits 1' {
        $fixtures = New-Fixtures
        $record = Join-Path $fixtures 'records/plat4-rbac-test.json'
        [System.IO.File]::WriteAllText($record, '{"ra":"left by an earlier run"}')
        $run = Invoke-WholeScript -Fixtures $fixtures -Arguments @('-Test', 'rbac-assignment', '-WhatIf')
        $run.Writes | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 1 -Because $run.Text
        $run.Text | Should -Match 'an earlier run did not finish'
        $run.Text | Should -Match ([regex]::Escape('-Recover -Test rbac-assignment -RecordDirectory'))
        [System.IO.File]::ReadAllText($record) | Should -BeExactly '{"ra":"left by an earlier run"}'
    }

    It 'stops with the az login line when az is not signed in' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -SignedOut) -Arguments @('-Test', 'kv-config-write')
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'az is not signed in\.'
        $run.Text | Should -Match ([regex]::Escape('az login --tenant saulpatinojrhotmail.onmicrosoft.com'))
        $run.Writes | Should -BeNullOrEmpty
    }

    It 'stops with the az account set line on another default subscription' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -Subscription 'sub-plat-mgmt-prod-cus') -Arguments @('-Test', 'kv-config-write')
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match ([regex]::Escape('az account set --subscription sub-app-site-prod-cus'))
        $run.Writes | Should -BeNullOrEmpty
    }

    It 'stops before anything changes when a rule the test waits for is not there' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures -Missing @('alert-kv-config-write-prod-cus')) -Arguments @('-Test', 'kv-config-write')
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'the rule alert-kv-config-write-prod-cus was not found in rg-web-site-prod-cus'
        $run.Writes | Should -BeNullOrEmpty
    }

    It '-Recover with no record says there is nothing to recover and exits 0' {
        $run = Invoke-WholeScript -Fixtures (New-Fixtures) -Arguments @('-Test', 'rbac-assignment', '-Recover')
        $run.ExitCode | Should -Be 0 -Because $run.Text
        $run.Text | Should -Match 'Nothing to recover: there is no .*plat4-rbac-test\.json\.'
        $run.Writes | Should -BeNullOrEmpty
    }
}

#Requires -Version 7.2
<#
.SYNOPSIS
    Runs one PLAT-4 alert fire test (#964) the way the alerting runbook
    describes it, puts everything back, and proves the alert fired by reading
    Azure Monitor's fired alerts instead of an inbox.

.DESCRIPTION
    docs/runbooks/alerting-and-support.md, "Making each one fire once", is the
    reference this implements. Each -Test is one of its blocks, with the same
    stop conditions, the same record files in your home folder, the same order
    and the same clean-up. Run it as the owner, signed in with az login, with
    az's default subscription set to sub-app-site-prod-cus: the runbook's
    commands name the application subscription's resources without
    --subscription, so the script checks that default rather than assuming it.

    Every test:

      1. checks that az is signed in and on sub-app-site-prod-cus, and looks
         up the id of every rule it will wait for, so a rule the apply has not
         created stops the run before anything changes;
      2. runs the runbook's stop conditions and refuses, changing nothing,
         when one fails. A record file left by an unfinished run is always a
         stop: run -Recover for that test first;
      3. writes its record before the change the record describes (with
         Out-File -NoClobber where the runbook makes the record the lock),
         makes the change, and puts it back in a finally block, so a failure
         or Ctrl+C part-way still restores. The record is removed only once
         the runbook's own read shows nothing left; otherwise it is kept for
         -Recover and the run exits 3;
      4. polls Azure Monitor's fired alerts (Alerts - Get All, filtered to the
         rule) once a minute, until each rule has an alert instance that
         started after the test's own start, or the test's time limit passes.
         It prints "PASS <rule> fired at <time>" or "FAIL <rule>: no alert
         within <n> minutes", and never PASS without that instance;
      5. prints a Fire record row per rule, ready to paste into the runbook.

    timer-overdue and swa-bandwidth hold their change for about an hour,
    lab-agent-offline stops the agent for a quarter of an hour, and the two
    LAB-2 tests that change the host (#981) hold their change until the alert
    fires: lab-heartbeat keeps the Azure Monitor Agent stopped for up to 55
    minutes, and lab-disk keeps its file for up to 80; each waits in the
    script. Nothing is printed that could be a secret: app settings are
    read into memory and only the setting a test needs is named, and the Key
    Vault token lab-vault-unwrap sends stays in a variable.

    Under -WhatIf every read runs (the stop conditions and the rule look-ups,
    so a refusal shows up there too) and every change is printed as the one
    line it would run, instead of running.

    Exit codes: 0 every rule fired, or -WhatIf, or a recovery that verified;
    1 a stop condition or an error stopped the run; 2 a rule did not fire in
    time; 3 something was not put back, and its record is kept for -Recover.

.PARAMETER Test
    The runbook block to run. kv-config-write, rbac-assignment,
    rbac-definition, lab-unit-failed, kv-errors-and-data-write,
    lab-vault-unwrap, lab-ssh-burst and lab-ssh-login finish in under an
    hour; jobs-poison, lab-agent-offline and lab-heartbeat in about an hour;
    swa-bandwidth, lab-disk and timer-overdue in up to an hour and a half.

.PARAMETER Recover
    Do the runbook's recovery for -Test from its record file, then confirm it
    with the runbook's stop-condition read. For a test that changes nothing
    (kv-errors-and-data-write, lab-vault-unwrap, lab-ssh-burst,
    lab-ssh-login, lab-unit-failed) there is nothing to recover, and it says
    so. lab-heartbeat's recovery starts the Azure Monitor Agent again, and
    lab-disk's removes its file; neither keeps a record file, because the
    host itself is the record.

.PARAMETER TimeoutMinutes
    How long to wait for the alerts once the test's change is made, instead
    of the test's own limit (20 to 90 minutes, each a margin over the
    runbook's "within about").

.PARAMETER HostAlias
    The ssh name of the lab host, as scripts/lab/Connect-Lab.ps1 writes it.

.PARAMETER RecordDirectory
    Where the record files are. The runbook keeps them in your home folder,
    and so does this by default; another folder is for the tests.

.EXAMPLE
    ./scripts/alerts/Invoke-AlertFireTest.ps1 -Test kv-config-write

.EXAMPLE
    ./scripts/alerts/Invoke-AlertFireTest.ps1 -Test rbac-assignment -WhatIf

.EXAMPLE
    ./scripts/alerts/Invoke-AlertFireTest.ps1 -Test timer-overdue -Recover
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('kv-config-write', 'rbac-assignment', 'rbac-definition', 'lab-unit-failed', 'kv-errors-and-data-write', 'lab-vault-unwrap', 'lab-ssh-burst', 'lab-ssh-login', 'jobs-poison', 'lab-agent-offline', 'lab-heartbeat', 'swa-bandwidth', 'lab-disk', 'timer-overdue')]
    [string] $Test,

    [switch] $Recover,

    [ValidateRange(0, 240)]
    [int] $TimeoutMinutes = 0,

    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9.-]{0,62}\z')]
    [string] $HostAlias = 'hcw-lab',

    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container }, ErrorMessage = 'RecordDirectory must be an existing folder: {0}')]
    [string] $RecordDirectory = $HOME
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native exit codes are read explicitly below: az, ssh and gh report failure
# by exit code, and `systemctl is-active` exits 3 for a stopped unit.
$PSNativeCommandUseErrorActionPreference = $false

# -----------------------------------------------------------------------------
# Functions. Everything above the "Main" line is a definition only, so the
# Pester tests can load these from the file's syntax tree without running the
# script: no az call, no ssh, nothing in Azure.
# -----------------------------------------------------------------------------

function Get-AlertEstate {
    <#
    .SYNOPSIS
        The names every test uses, as infra/variables.tf and the runbook spell
        them. One place, so a test cannot drift from another.
    #>
    [OutputType([pscustomobject])]
    param()

    return [pscustomobject]@{
        TenantDomain     = 'saulpatinojrhotmail.onmicrosoft.com'
        AppSubscription  = 'sub-app-site-prod-cus'
        MgmtSubscription = 'sub-plat-mgmt-prod-cus'
        WebGroup         = 'rg-web-site-prod-cus'
        MgmtGroup        = 'rg-mgmt-plat-prod-cus'
        SecurityGroup    = 'rg-sec-site-prod-cus'
        FunctionApp      = 'func-site-prod-cus-01'
        SiteVault        = 'kv-site-prod-cus-01'
        LabVault         = 'kv-labhybrid-prod-cus-01'
        FunctionsStorage = 'stsitefuncprodcus01'
        Repository       = 'saulpatinojr/HCW-HybridCloudWorks'
        # local.static_web_app_daily_bandwidth_alert_bytes, infra/observability.tf:
        # 80% of a thirtieth of the Free plan's 100 GB month.
        SwaThreshold     = [long]2666666666
        LabsUrl          = 'https://hybridcloudworks.com/admin/labs?tab=agents'
    }
}

function Get-AlertRuleCatalog {
    <#
    .SYNOPSIS
        The rules these tests prove, PLAT-4's thirteen, #953's login rule and
        LAB-2's three lab-host rules (#981): where each lives and what kind it
        is. Declared in infra/observability.tf and infra/lab-hybrid.tf; the
        tests hold this table to those files.
    #>
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param()

    $app = 'sub-app-site-prod-cus'
    $mgmt = 'sub-plat-mgmt-prod-cus'
    $web = 'rg-web-site-prod-cus'
    $plat = 'rg-mgmt-plat-prod-cus'
    $log = 'Microsoft.Insights/scheduledQueryRules'
    $metric = 'Microsoft.Insights/metricAlerts'
    $activity = 'Microsoft.Insights/activityLogAlerts'
    $rows = @(
        @('alert-timer-overdue', $app, $web, $log),
        @('alert-lab-agent-offline', $app, $web, $log),
        @('alert-jobs-poison', $mgmt, $plat, $log),
        @('alert-swa-bandwidth', $app, $web, $metric),
        @('alert-kv-errors', $mgmt, $plat, $log),
        @('alert-kv-data-write', $mgmt, $plat, $log),
        @('alert-kv-config-write', $app, $web, $activity),
        @('alert-rbac-assignment-app', $app, $web, $activity),
        @('alert-rbac-assignment-mgmt', $mgmt, $plat, $activity),
        @('alert-rbac-definition-app', $app, $web, $activity),
        @('alert-rbac-definition-mgmt', $mgmt, $plat, $activity),
        @('alert-lab-vault-unwrap', $mgmt, $plat, $log),
        @('alert-lab-ssh-burst', $mgmt, $plat, $log),
        @('alert-lab-ssh-login', $mgmt, $plat, $log),
        @('alert-lab-heartbeat', $mgmt, $plat, $log),
        @('alert-lab-disk', $mgmt, $plat, $log),
        @('alert-lab-unit-failed', $mgmt, $plat, $log)
    )
    $catalog = [ordered]@{}
    foreach ($row in $rows) {
        $catalog[$row[0]] = [pscustomobject]@{
            Short        = $row[0]
            Name         = $row[0] + '-prod-cus'
            Subscription = $row[1]
            Group        = $row[2]
            Type         = $row[3]
        }
    }
    return $catalog
}

function Get-AlertTestDefinition {
    <#
    .SYNOPSIS
        What a test waits for and how long, from its last change. The limits
        are a margin over the runbook's "within about": ten minutes becomes
        20, thirty becomes 45 (30 after lab-agent-offline's quarter hour,
        since the runbook counts from the stop), and the two hour-long tests
        get the evaluation and delivery after it. The three LAB-2 tests
        (#981) are sized from their rules in infra/lab-hybrid.tf:
        lab-unit-failed's rule evaluates every 15 minutes, so a quarter of an
        hour plus Syslog's ingestion becomes 35; lab-heartbeat's needs an
        empty 30-minute window at a quarter-hour evaluation, so 45 becomes 55;
        lab-disk's evaluates hourly, so an hour plus one 60-second Perf sample
        and its ingestion becomes 80.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string] $Test)

    $none = [string[]]@()
    switch ($Test) {
        'kv-config-write' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-kv-config-write'); Optional = $none; TimeoutMinutes = 20; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Adds a tag named for this moment to kv-site-prod-cus-01 and takes it off: a Resource Manager write on the vault that touches nothing else.'
                Success = 'alert-kv-config-write-prod-cus within about ten minutes, one alert per write. Activity Log alerts are stateless, so no Resolved mail follows.' }
        }
        'rbac-assignment' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-rbac-assignment-mgmt', 'alert-rbac-assignment-app'); Optional = $none; TimeoutMinutes = 20; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Grants this account Reader on rg-mgmt-plat-prod-cus, then on rg-web-site-prod-cus, and takes each back by the id it recorded first.'
                Success = 'alert-rbac-assignment-mgmt-prod-cus and alert-rbac-assignment-app-prod-cus within about ten minutes, and no assignment of yours left at either group.' }
        }
        'rbac-definition' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-rbac-definition-mgmt', 'alert-rbac-definition-app'); Optional = $none; TimeoutMinutes = 20; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Creates a throwaway custom role (read resource groups, assignable at one group, never assigned) in each subscription and deletes it by the name it recorded first.'
                Success = 'alert-rbac-definition-mgmt-prod-cus and alert-rbac-definition-app-prod-cus within about ten minutes, and no plat4-fire-test-* role left at either group.' }
        }
        'lab-unit-failed' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-unit-failed'); Optional = $none; TimeoutMinutes = 35; Tools = [string[]]@('az', 'ssh'); RecoverTools = [string[]]@('az')
                Summary = 'Writes one line to the lab host''s syslog with logger, under the hcw-unit-failed tag and at daemon.err exactly as the hcw-unit-failed@ notifier writes its own, naming a unit called for this test and this moment that does not exist. No unit fails, nothing is stopped, and there is nothing to put back: the rule is stateless and the line leaves its hour-long window on its own.'
                Success = 'alert-lab-unit-failed-prod-cus within about 20 minutes (a 15-minute evaluation plus Syslog''s ingestion), its mail naming the hcw-fire-test unit. No Resolved mail follows, and for six hours after it the rule''s actions are muted, so a real failure in that time opens an alert but sends no mail.' }
        }
        'kv-errors-and-data-write' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-kv-errors', 'alert-kv-data-write'); Optional = $none; TimeoutMinutes = 45; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Asks kv-site-prod-cus-01 to update the attributes of a secret that does not exist; the refusal is the test, and nothing changes.'
                Success = 'alert-kv-errors-prod-cus and alert-kv-data-write-prod-cus within about 30 minutes.' }
        }
        'lab-vault-unwrap' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-vault-unwrap'); Optional = [string[]]@('alert-kv-errors'); TimeoutMinutes = 45; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Asks the lab vault''s seal key to wrap a test value from this machine, which holds no role on the key, so Key Vault refuses it and logs this address.'
                Success = 'alert-lab-vault-unwrap-prod-cus within about 30 minutes, with alert-kv-errors-prod-cus beside it for the same refusal unless one is already open.' }
        }
        'lab-ssh-burst' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-ssh-burst'); Optional = $none; TimeoutMinutes = 45; Tools = [string[]]@('az', 'ssh'); RecoverTools = [string[]]@('az')
                Summary = 'Writes a thousand failed-login lines to the lab host''s auth log under sshd''s name with logger, from a documentation address. fail2ban bans nothing and no login is attempted.'
                Success = 'alert-lab-ssh-burst-prod-cus within about 30 minutes. It resolves on its own once the burst leaves the 15-minute window.' }
        }
        'lab-ssh-login' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-ssh-login'); Optional = $none; TimeoutMinutes = 45; Tools = [string[]]@('az', 'ssh'); RecoverTools = [string[]]@('az')
                Summary = 'Writes one accepted-login line to the lab host''s auth log under sshd''s name with logger, for a user that does not exist, from a documentation address, with a fingerprint no key has. No login happens and nothing on the host changes.'
                Success = 'alert-lab-ssh-login-prod-cus within about 30 minutes. It is stateless, so no Resolved mail follows, and now and then a second alert for the same line follows a quarter of an hour later.' }
        }
        'jobs-poison' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-jobs-poison'); Optional = [string[]]@('alert-rbac-assignment-app'); TimeoutMinutes = 45; Tools = [string[]]@('az', 'gh'); RecoverTools = [string[]]@('az')
                Summary = 'Takes a temporary queue data role and a temporary firewall entry on stsitefuncprodcus01, puts one message that expires in 15 minutes into platform-jobs-poison, and undoes both by what it recorded.'
                Success = 'alert-jobs-poison-prod-cus within about 30 minutes, and neither the role nor the firewall entry left behind. The role''s create and delete also fire alert-rbac-assignment-app-prod-cus.' }
        }
        'lab-agent-offline' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-agent-offline'); Optional = $none; TimeoutMinutes = 30; Tools = [string[]]@('az', 'ssh'); RecoverTools = [string[]]@('az', 'ssh')
                Summary = 'Stops the labs agent on the lab host for a quarter of an hour and starts it again. Public lab submissions are closed meanwhile.'
                Success = 'alert-lab-agent-offline-prod-cus within about 30 minutes of the stop, Telegram''s "offline" and "back online" messages, and hcw-labs-agent active again.' }
        }
        'lab-heartbeat' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-heartbeat'); Optional = $none; TimeoutMinutes = 55; Tools = [string[]]@('az', 'ssh'); RecoverTools = [string[]]@('az', 'ssh')
                Summary = 'Stops azuremonitoragent, the Azure Monitor Agent unit on the lab host, until the alert fires, and starts it again. The Arc agent (himdsd) is not touched, so the host stays Connected. While the agent is stopped the host ships nothing to Log Analytics: no Heartbeat, and no Perf or Syslog rows either, so the lab-disk, unit-failed and ssh rules see nothing from the host for that window.'
                Success = 'alert-lab-heartbeat-prod-cus within about 45 minutes of the stop (the 30-minute window must be empty at a quarter-hour evaluation), and azuremonitoragent active again. The alert is stateful and resolves on its own once heartbeats resume.' }
        }
        'swa-bandwidth' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-swa-bandwidth'); Optional = $none; TimeoutMinutes = 75; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Saves the rule''s definition exactly as ARM returns it, lowers the threshold to one byte until the alert fires (an hourly evaluation), and puts the saved definition back.'
                Success = 'alert-swa-bandwidth-prod-cus at the next hourly evaluation, and the threshold reading 2666666666 again.' }
        }
        'lab-disk' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-lab-disk'); Optional = $none; TimeoutMinutes = 80; Tools = [string[]]@('az', 'ssh'); RecoverTools = [string[]]@('az', 'ssh')
                Summary = 'Reads df on the lab host, refuses if the root filesystem is already past 80% used or if 87% would leave less than 10 GiB free, then allocates one file at /var/tmp/hcw-fire-test-disk.img, sized on the host from df at that moment and rounded down to a MiB, so that usage reads 87%. The file stays until the alert fires and is removed after. The lab DCR samples % Used Space every 60 seconds, so the sample lands within a minute; the rule evaluates hourly, which sets the wait.'
                Success = 'alert-lab-disk-prod-cus at the first hourly evaluation after the sample lands, so within about 65 minutes, and df reading as it did before. The alert is stateful and resolves two clear evaluations after the file is gone.' }
        }
        'timer-overdue' {
            return [pscustomobject]@{ Test = $Test; Required = [string[]]@('alert-timer-overdue'); Optional = $none; TimeoutMinutes = 90; Tools = [string[]]@('az'); RecoverTools = [string[]]@('az')
                Summary = 'Disables the healthPulse timer, which only refreshes the Health Hub, until the alert names it (45 minutes of grace, then a 15-minute evaluation), then puts the setting back exactly as recorded. Each write restarts the app once.'
                Success = 'alert-timer-overdue-prod-cus naming healthPulse within about 75 minutes, the setting as it was, and the strip intact. The Resolved mail follows the first good run.' }
        }
    }
    throw "No fire test is named '$Test'."
}

function Get-AlertProperty {
    <#
    .SYNOPSIS
        A property of an object parsed from JSON, or $null when the object or
        the property is absent. Strict mode throws on a missing property, and
        az omits some keys rather than writing null.
    #>
    param(
        [AllowNull()] $Object,
        [Parameter(Mandatory)] [string] $Name
    )

    if ($null -eq $Object) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-AlertList {
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
    foreach ($item in @(Get-AlertProperty -Object $Object -Name $Name)) {
        if ($null -ne $item) {
            $items.Add($item)
        }
    }
    return , $items.ToArray()
}

function ConvertTo-AlertUtc {
    <#
    .SYNOPSIS
        A time from the alerts API as UTC, or $null. ConvertFrom-Json turns
        ISO 8601 strings into DateTime values whose Kind depends on the
        PowerShell version, so a DateTime, a DateTimeOffset and a string are
        all read, and an unmarked time is taken as UTC, which is what Azure
        writes.
    #>
    [OutputType([datetime])]
    param([AllowNull()] $Value)

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [datetimeoffset]) {
        return $Value.UtcDateTime
    }
    if ($Value -is [datetime]) {
        if ($Value.Kind -eq [System.DateTimeKind]::Unspecified) {
            return [datetime]::SpecifyKind($Value, [System.DateTimeKind]::Utc)
        }
        return $Value.ToUniversalTime()
    }
    $parsed = [datetimeoffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal
    if ([datetimeoffset]::TryParse([string]$Value, [cultureinfo]::InvariantCulture, $styles, [ref] $parsed)) {
        return $parsed.UtcDateTime
    }
    return $null
}

function Format-AlertTime {
    <#
    .SYNOPSIS
        A UTC time as yyyy-MM-ddTHH:mm:ssZ.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [datetime] $Utc)

    return $Utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [cultureinfo]::InvariantCulture)
}

function Format-AlertArgument {
    <#
    .SYNOPSIS
        One argument as PowerShell reads it back: bare when it holds only
        characters PowerShell passes through unchanged, otherwise in single
        quotes. An argument starting with @ is quoted, because bare it is a
        splat.
    #>
    [OutputType([string])]
    param([AllowEmptyString()] [string] $Value)

    if ($Value -match '\A[A-Za-z0-9_./:=+\\-]+\z') {
        return $Value
    }
    return "'" + $Value.Replace("'", "''") + "'"
}

function Format-AlertCommand {
    <#
    .SYNOPSIS
        A command as the one line that would run it in PowerShell.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Tool,
        [AllowEmptyCollection()] [string[]] $Arguments = @()
    )

    $parts = [System.Collections.Generic.List[string]]::new()
    $parts.Add($Tool)
    foreach ($argument in $Arguments) {
        $parts.Add((Format-AlertArgument -Value $argument))
    }
    return ($parts -join ' ')
}

function New-AlertStop {
    <#
    .SYNOPSIS
        The exception a stop condition throws: the reason, and the one line to
        run before running the script again, when there is one. Main prints
        both and exits 1.
    #>
    param(
        [Parameter(Mandatory)] [string] $Message,
        [string] $Command = ''
    )

    $exception = [System.InvalidOperationException]::new($Message)
    $exception.Data['AlertStop'] = $true
    if ($Command) {
        $exception.Data['AlertCommand'] = $Command
    }
    return $exception
}

function New-AlertContext {
    <#
    .SYNOPSIS
        What one run carries between its steps: the resolved rules, the start
        time alerts are measured from, the results, and anything not put back.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $Test,
        [Parameter(Mandatory)] [string] $RecordDirectory,
        [string] $HostAlias = 'hcw-lab',
        [int] $TimeoutMinutes = 0,
        [System.Collections.IDictionary] $Rules = @{},
        [string] $RecoverCommand = ''
    )

    return [pscustomobject]@{
        Test            = $Test
        RecordDirectory = $RecordDirectory
        HostAlias       = $HostAlias
        TimeoutMinutes  = $TimeoutMinutes
        Rules           = $Rules
        RecoverCommand  = $RecoverCommand
        StartUtc        = $null
        Results         = [System.Collections.Generic.List[pscustomobject]]::new()
        Problems        = [System.Collections.Generic.List[string]]::new()
    }
}

function Add-AlertProblem {
    <#
    .SYNOPSIS
        Records something that was not put back, with the line that does it.
        Any problem makes the run exit 3.
    #>
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $Message,
        [string] $Command = ''
    )

    $text = $Message
    if ($Command) {
        $text += [Environment]::NewLine + '    PowerShell: ' + $Command
    }
    $Context.Problems.Add($text)
    Write-Host "NOT PUT BACK: $Message"
    if ($Command) {
        Write-Host "  PowerShell: $Command"
    }
}

function Add-AlertSkip {
    <#
    .SYNOPSIS
        Records a half the runbook says to skip, so the fire record notes it.
    #>
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $Rule,
        [Parameter(Mandatory)] [string] $Reason
    )

    $line = "SKIP $Rule-prod-cus: $Reason"
    $row = '| `{0}` | not yet | skipped on {1} by Invoke-AlertFireTest.ps1: {2} |' -f $Rule, (Get-AlertUtcNow).ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture), $Reason
    $Context.Results.Add([pscustomobject]@{ Rule = $Rule; Status = 'SKIPPED'; Required = $true; FiredAtUtc = $null; Line = $line; Row = $row })
    Write-Host $line
}

function Get-AlertUtcNow {
    <#
    .SYNOPSIS
        The time now, in UTC. The seam the tests mock.
    #>
    [OutputType([datetime])]
    param()

    return [datetime]::UtcNow
}

function Wait-AlertSeconds {
    <#
    .SYNOPSIS
        Waits. The seam the tests mock.
    #>
    param([Parameter(Mandatory)] [int] $Seconds)

    Start-Sleep -Seconds $Seconds
}

function Invoke-AlertAz {
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

function Invoke-AlertGh {
    <#
    .SYNOPSIS
        Runs gh, as Invoke-AlertAz runs az. The seam the tests mock.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string[]] $Arguments)

    $stdout = [System.Collections.Generic.List[string]]::new()
    $stderr = [System.Collections.Generic.List[string]]::new()
    & gh @Arguments 2>&1 | ForEach-Object {
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

function Invoke-AlertSsh {
    <#
    .SYNOPSIS
        Runs one command on the lab host and returns its exit code and output
        lines. The seam the tests mock.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $HostAlias,
        [Parameter(Mandatory)] [string] $Command
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    & ssh -o ConnectTimeout=20 $HostAlias $Command 2>&1 | ForEach-Object { $lines.Add([string]$_) }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = [string[]]$lines.ToArray() }
}

function Get-AlertPublicAddress {
    <#
    .SYNOPSIS
        This machine's public address, as the runbook reads it. The seam the
        tests mock.
    #>
    [OutputType([string])]
    param()

    return [string](Invoke-RestMethod -Uri 'https://api.ipify.org')
}

function Get-AlertAzFailure {
    <#
    .SYNOPSIS
        The first lines of what az wrote to standard error, for a message.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [pscustomobject] $Result)

    return ((@([string]$Result.Stderr -split "`n" | Where-Object { $_.Trim() }) | Select-Object -First 4) -join ' ')
}

function Invoke-AlertAzJson {
    <#
    .SYNOPSIS
        Runs a read and writes the parsed JSON to the pipeline (a JSON list as
        its items, so an empty list writes nothing). Stops with az's own words
        when it fails. Nothing it reads is printed.
    #>
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $What
    )

    $result = Invoke-AlertAz -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        throw "$What failed: az exited $($result.ExitCode). $(Get-AlertAzFailure -Result $result)"
    }
    if (-not [string]::IsNullOrWhiteSpace($result.Stdout)) {
        $result.Stdout | ConvertFrom-Json
    }
}

function Invoke-AlertAzChange {
    <#
    .SYNOPSIS
        Runs one az command that changes something, or under -WhatIf prints
        the one line it would run. Every change in this script goes through
        here or Invoke-AlertSshChange.

    .DESCRIPTION
        Stops with az's own words when the command fails, unless -NoThrow (the
        put-back steps, where the read that follows decides) or the error
        matches AcceptPattern.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $What,
        [string] $AcceptPattern = '',
        [switch] $NoThrow
    )

    $line = Format-AlertCommand -Tool 'az' -Arguments $Arguments
    if (-not $PSCmdlet.ShouldProcess("$What`: $line", "$What`?", 'Invoke-AlertFireTest')) {
        return [pscustomobject]@{ Ran = $false; ExitCode = 0; Stdout = ''; Stderr = ''; Accepted = $false }
    }
    Write-Host "  > $line"
    $result = Invoke-AlertAz -Arguments $Arguments
    $accepted = ($result.ExitCode -ne 0) -and [bool]$AcceptPattern -and ($result.Stderr -match $AcceptPattern)
    if ($result.ExitCode -ne 0 -and -not $accepted -and -not $NoThrow) {
        throw "$What failed: az exited $($result.ExitCode). $(Get-AlertAzFailure -Result $result)"
    }
    return [pscustomobject]@{ Ran = $true; ExitCode = $result.ExitCode; Stdout = $result.Stdout; Stderr = $result.Stderr; Accepted = [bool]$accepted }
}

function Invoke-AlertSshChange {
    <#
    .SYNOPSIS
        Runs one command on the lab host that changes something, or under
        -WhatIf prints the one line it would run.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $HostAlias,
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $What
    )

    $line = 'ssh ' + $HostAlias + ' ' + (Format-AlertArgument -Value $Command)
    if (-not $PSCmdlet.ShouldProcess("$What`: $line", "$What`?", 'Invoke-AlertFireTest')) {
        return [pscustomobject]@{ Ran = $false; ExitCode = 0; Lines = [string[]]@() }
    }
    Write-Host "  > $line"
    $run = Invoke-AlertSsh -HostAlias $HostAlias -Command $Command
    return [pscustomobject]@{ Ran = $true; ExitCode = $run.ExitCode; Lines = [string[]]$run.Lines }
}

function Get-AlertLastLine {
    <#
    .SYNOPSIS
        The last non-blank line of a command's output, trimmed.
    #>
    [OutputType([string])]
    param([AllowEmptyCollection()] [AllowNull()] [string[]] $Lines)

    $kept = @(@($Lines) | Where-Object { $_ -and $_.Trim() })
    if ($kept.Count -eq 0) {
        return ''
    }
    return $kept[$kept.Count - 1].Trim()
}

function Assert-AlertSshReached {
    <#
    .SYNOPSIS
        Stops when ssh itself failed (exit 255), which says nothing about the
        host and everything about the path to it.
    #>
    param(
        [Parameter(Mandatory)] [int] $ExitCode,
        [Parameter(Mandatory)] [string] $HostAlias
    )

    if ($ExitCode -eq 255) {
        throw (New-AlertStop -Message "ssh could not reach $HostAlias. Set this desktop up with scripts/lab/Connect-Lab.ps1 (docs/runbooks/labs-host.md, ""Connect from a desktop""), check that this prints the host's name, then run this again." -Command "ssh $HostAlias hostname")
    }
}

function Get-AlertRecordPath {
    <#
    .SYNOPSIS
        Where a test's record lives: the runbook's file name in the record
        directory, which is your home folder unless -RecordDirectory says
        otherwise.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $Name
    )

    return (Join-Path $Context.RecordDirectory $Name)
}

function Assert-AlertNoRecord {
    <#
    .SYNOPSIS
        The first stop condition of every test that keeps a record: no record
        may exist, because one that does is an unfinished run's.
    #>
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $Path
    )

    if (Test-Path -LiteralPath $Path) {
        throw (New-AlertStop -Message "Stop: $Path exists, so an earlier run did not finish. Do its recovery first; this run changed nothing." -Command $Context.RecoverCommand)
    }
    Write-Host "Stop condition: no record at $Path."
}

function Write-AlertRecord {
    <#
    .SYNOPSIS
        Writes a test's record before the change it describes, as the runbook
        does: Out-File -NoClobber where the record is the lock (the two role
        tests), so a second run's write fails rather than overwriting the
        first's; Set-Content where the runbook uses it after its Test-Path
        stop.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Record,
        [switch] $NoClobber
    )

    $json = $Record | ConvertTo-Json
    if (-not $PSCmdlet.ShouldProcess("Write the record $Path`: $($Record | ConvertTo-Json -Compress)", 'Write the record?', 'Invoke-AlertFireTest')) {
        return
    }
    try {
        if ($NoClobber) {
            $json | Out-File -LiteralPath $Path -NoClobber
        }
        else {
            $json | Set-Content -LiteralPath $Path
        }
    }
    catch {
        if ($NoClobber -and (Test-Path -LiteralPath $Path)) {
            throw (New-AlertStop -Message "Stop: the record $Path already exists, so a run is unfinished; the write that is this test's lock refused to replace it. Nothing was changed." -Command $Context.RecoverCommand)
        }
        throw
    }
    Write-Host "Record: wrote $Path."
}

function Read-AlertRecord {
    <#
    .SYNOPSIS
        A record file, parsed.
    #>
    param([Parameter(Mandatory)] [string] $Path)

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Remove-AlertFile {
    <#
    .SYNOPSIS
        Removes a record or a working file, under ShouldProcess.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $What,
        [switch] $IfPresent
    )

    if ($IfPresent -and -not (Test-Path -LiteralPath $Path)) {
        return
    }
    if ($PSCmdlet.ShouldProcess("$What`: Remove-Item -LiteralPath $(Format-AlertArgument -Value $Path)", "$What`?", 'Invoke-AlertFireTest')) {
        Remove-Item -LiteralPath $Path
        Write-Host "Removed $Path."
    }
}

function Get-AlertRecoverCommand {
    <#
    .SYNOPSIS
        The one line that runs this script's recovery for a test, with the
        script's own path, so it pastes from any directory.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $ScriptPath,
        [Parameter(Mandatory)] [string] $Test,
        [Parameter(Mandatory)] [string] $RecordDirectory,
        [Parameter(Mandatory)] [string] $DefaultDirectory
    )

    $line = 'pwsh -NoProfile -File ' + (Format-AlertArgument -Value $ScriptPath) + ' -Recover -Test ' + $Test
    if ($RecordDirectory.TrimEnd('\', '/') -ne $DefaultDirectory.TrimEnd('\', '/')) {
        $line += ' -RecordDirectory ' + (Format-AlertArgument -Value $RecordDirectory)
    }
    return $line
}

# --- Proof: Azure Monitor's fired alerts --------------------------------------

function Get-AlertsApiVersion {
    <#
    .SYNOPSIS
        The Alerts Management API version the proof reads.

    .DESCRIPTION
        Alerts - Get All, https://learn.microsoft.com/en-us/rest/api/alerts-management/alerts/alerts/get-all
        (read 2026-10-10): GET {scope}/providers/Microsoft.AlertsManagement/alerts
        with the scope a subscription; the filters used here are alertRule
        ("Filter by specific alert rule"), timeRange (1h, 1d, 7d or 30d),
        includeContext and pageCount (1 to 250, at most 25 with context); the
        answer is value[].properties.essentials, whose alertRule is "ARM id or
        name of the rule" depending on the monitor service, startDateTime is
        the "Creation time (ISO-8601 format) of alert instance", and
        monitorCondition is Fired or Resolved. That page documents 2019-03-01,
        so that is the version used: the 2019-05-05-preview version takes the
        same filters (the legacy .NET SDK's GetAll) but has no reference page
        of its own to hold this to.
    #>
    [OutputType([string])]
    param()

    return '2019-03-01'
}

function Get-AlertQueryArguments {
    <#
    .SYNOPSIS
        The az rest arguments that list one rule's alerts of the last hour in
        its subscription.

    .DESCRIPTION
        The filters go in --url-parameters, not in the URL. On Windows az is
        az.cmd, and cmd.exe splits an unquoted argument at '&', so a URL
        holding two query parameters would reach az cut short. az rest
        encodes each KEY=VALUE pair itself, the rule id's slashes included.
    #>
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string] $SubscriptionId,
        [Parameter(Mandatory)] [string] $RuleId,
        [switch] $IncludeContext
    )

    $url = "https://management.azure.com/subscriptions/$SubscriptionId/providers/Microsoft.AlertsManagement/alerts?api-version=$(Get-AlertsApiVersion)"
    $parameters = [System.Collections.Generic.List[string]]::new()
    $parameters.Add("alertRule=$RuleId")
    $parameters.Add('timeRange=1h')
    if ($IncludeContext) {
        $parameters.Add('includeContext=true')
        $parameters.Add('pageCount=25')
    }
    else {
        $parameters.Add('pageCount=250')
    }
    return [string[]](@('rest', '--method', 'get', '--url', $url, '--url-parameters') + $parameters.ToArray() + @('-o', 'json'))
}

function Test-AlertRuleMatch {
    <#
    .SYNOPSIS
        True when an alert's essentials.alertRule names this rule, as its ARM
        id or as its name. The filter asked for already; this does not trust
        it.
    #>
    [OutputType([bool])]
    param(
        [AllowEmptyString()] [AllowNull()] [string] $AlertRule,
        [Parameter(Mandatory)] [string] $RuleId,
        [Parameter(Mandatory)] [string] $RuleName
    )

    if ([string]::IsNullOrWhiteSpace($AlertRule)) {
        return $false
    }
    $value = $AlertRule.Trim()
    if ($value -ieq $RuleId -or $value -ieq $RuleName) {
        return $true
    }
    return $value.EndsWith('/' + $RuleName, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-AlertDimensionValue {
    <#
    .SYNOPSIS
        The dimension values of a fired log search alert: every value in
        condition.allOf[].dimensions[] of its context.

    .DESCRIPTION
        Alerts - Get All with includeContext=true nests the common alert
        schema's alertContext one level down: properties.context.context
        .condition.allOf[], read from live alerts on 2026-10-15. An older
        payload carried condition at properties.context itself, so that level
        is read when the nested one has no condition.

        Values only, never the rest of the entry. Each allOf[] entry also
        carries searchQuery, the rule's whole query, and alert-timer-overdue's
        names all 26 timers in its datatable; a match on the serialized
        context therefore read any timer's alert as healthPulse's (#964).
    #>
    [OutputType([string[]])]
    param([AllowNull()] $AlertContext)

    $condition = Get-AlertProperty -Object (Get-AlertProperty -Object $AlertContext -Name 'context') -Name 'condition'
    if ($null -eq $condition) {
        $condition = Get-AlertProperty -Object $AlertContext -Name 'condition'
    }
    $values = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in (Get-AlertList -Object $condition -Name 'allOf')) {
        foreach ($dimension in (Get-AlertList -Object $entry -Name 'dimensions')) {
            $value = Get-AlertProperty -Object $dimension -Name 'value'
            if ($null -ne $value) {
                $values.Add([string]$value)
            }
        }
    }
    return , $values.ToArray()
}

function Select-AlertFiredInstance {
    <#
    .SYNOPSIS
        Reads one Alerts - Get All answer: the earliest instance of this rule
        that started after SinceUtc, and how many there were.

    .DESCRIPTION
        Only an instance whose startDateTime is strictly after the test's
        start counts. An earlier one is not this test's, however recent; if
        one of those is still Fired, a stateful rule cannot open another until
        it resolves, and StillFiringSinceUtc says so for the FAIL line. With
        ContextMatch (timer-overdue: healthPulse), one of the instance's
        dimension values must equal it (Get-AlertDimensionValue), so another
        timer's alert is not taken for this one.
    #>
    [OutputType([pscustomobject])]
    param(
        [AllowNull()] $Response,
        [Parameter(Mandatory)] [datetime] $SinceUtc,
        [Parameter(Mandatory)] [string] $RuleId,
        [Parameter(Mandatory)] [string] $RuleName,
        [AllowEmptyString()] [string] $ContextMatch = ''
    )

    $since = ConvertTo-AlertUtc -Value $SinceUtc
    $first = $null
    $count = 0
    $stillFiring = $null
    foreach ($alert in (Get-AlertList -Object $Response -Name 'value')) {
        $properties = Get-AlertProperty -Object $alert -Name 'properties'
        $essentials = Get-AlertProperty -Object $properties -Name 'essentials'
        if (-not (Test-AlertRuleMatch -AlertRule ([string](Get-AlertProperty -Object $essentials -Name 'alertRule')) -RuleId $RuleId -RuleName $RuleName)) {
            continue
        }
        $start = ConvertTo-AlertUtc -Value (Get-AlertProperty -Object $essentials -Name 'startDateTime')
        if ($null -eq $start) {
            continue
        }
        if ($start -le $since) {
            if ([string](Get-AlertProperty -Object $essentials -Name 'monitorCondition') -eq 'Fired' -and ($null -eq $stillFiring -or $start -gt $stillFiring)) {
                $stillFiring = $start
            }
            continue
        }
        if ($ContextMatch) {
            $dimensions = Get-AlertDimensionValue -AlertContext (Get-AlertProperty -Object $properties -Name 'context')
            if (-not ($dimensions -icontains $ContextMatch)) {
                continue
            }
        }
        $count++
        if ($null -eq $first -or $start -lt $first) {
            $first = $start
        }
    }
    return [pscustomobject]@{
        Fired               = ($null -ne $first)
        FiredAtUtc          = $first
        Count               = $count
        StillFiringSinceUtc = $stillFiring
    }
}

function Format-AlertFireRecordRow {
    <#
    .SYNOPSIS
        The Fire record row for a rule that fired, as the runbook's table
        spells it (the rule without its -prod-cus suffix).
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Rule,
        [Parameter(Mandatory)] [datetime] $FiredAtUtc
    )

    $utc = ConvertTo-AlertUtc -Value $FiredAtUtc
    return ('| `{0}` | {1} | fired at {2}Z by Invoke-AlertFireTest.ps1 |' -f $Rule, $utc.ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture), $utc.ToString('HH:mm', [cultureinfo]::InvariantCulture))
}

function Get-AlertVerdict {
    <#
    .SYNOPSIS
        The result for one rule from what the polling saw: PASS only with an
        instance that started after the test did, FAIL otherwise. A rule the
        test does not require reads ALSO either way and never fails the run.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [string] $Rule,
        [Parameter(Mandatory)] [string] $Name,
        [AllowNull()] $State,
        [Parameter(Mandatory)] [int] $Minutes,
        [bool] $Required = $true,
        [AllowEmptyString()] [string] $Hint = '',
        [AllowEmptyString()] [string] $LastError = ''
    )

    if ($null -ne $State -and $State.Fired) {
        $line = "PASS $Name fired at $(Format-AlertTime -Utc $State.FiredAtUtc)"
        if ($State.Count -gt 1) {
            $line += " ($($State.Count) alerts since the test started)"
        }
        if (-not $Required) {
            $line = 'ALSO ' + $line.Substring(5) + ' (not required by this test)'
        }
        return [pscustomobject]@{ Rule = $Rule; Status = 'PASS'; Required = $Required; FiredAtUtc = $State.FiredAtUtc; Line = $line; Row = (Format-AlertFireRecordRow -Rule $Rule -FiredAtUtc $State.FiredAtUtc) }
    }
    $line = "FAIL $Name`: no alert within $Minutes minutes"
    $notes = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $State -and $null -ne $State.StillFiringSinceUtc) {
        $notes.Add("an alert of this rule that started at $(Format-AlertTime -Utc $State.StillFiringSinceUtc), before the test, is still Fired, and a stateful rule opens no new one until it resolves")
    }
    if ($LastError) {
        $notes.Add("the last read of the alerts failed: $LastError")
    }
    if ($Hint) {
        $notes.Add($Hint)
    }
    if ($notes.Count -gt 0) {
        $line += ' (' + ($notes -join '; ') + ')'
    }
    if (-not $Required) {
        $line = 'ALSO ' + $Name + ": no alert within $Minutes minutes (not required by this test)"
    }
    return [pscustomobject]@{ Rule = $Rule; Status = 'FAIL'; Required = $Required; FiredAtUtc = $null; Line = $line; Row = $null }
}

function Get-AlertFiredState {
    <#
    .SYNOPSIS
        Asks Azure Monitor for one rule's alerts of the last hour and reads
        the answer. A failed read is not a verdict: it comes back as Error,
        and the polling asks again.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Rule,
        [Parameter(Mandatory)] [datetime] $SinceUtc,
        [AllowEmptyString()] [string] $ContextMatch = ''
    )

    $arguments = Get-AlertQueryArguments -SubscriptionId $Rule.SubscriptionId -RuleId $Rule.Id -IncludeContext:([bool]$ContextMatch)
    $result = Invoke-AlertAz -Arguments $arguments
    if ($result.ExitCode -ne 0) {
        return [pscustomobject]@{ Fired = $false; FiredAtUtc = $null; Count = 0; StillFiringSinceUtc = $null; Error = "az exited $($result.ExitCode). $(Get-AlertAzFailure -Result $result)" }
    }
    $response = $null
    if (-not [string]::IsNullOrWhiteSpace($result.Stdout)) {
        $response = $result.Stdout | ConvertFrom-Json
    }
    $state = Select-AlertFiredInstance -Response $response -SinceUtc $SinceUtc -RuleId $Rule.Id -RuleName $Rule.Name -ContextMatch $ContextMatch
    return [pscustomobject]@{ Fired = $state.Fired; FiredAtUtc = $state.FiredAtUtc; Count = $state.Count; StillFiringSinceUtc = $state.StillFiringSinceUtc; Error = '' }
}

function Wait-AlertFired {
    <#
    .SYNOPSIS
        Polls Azure Monitor once a minute until every rule has an alert that
        started after the test did, or the time limit passes, and records a
        PASS or FAIL line for each.

    .DESCRIPTION
        Only an alert that started after the test's own start
        (Context.StartUtc) counts. The limit counts from when the polling
        starts, after the test's last change, so a test with two halves gives
        the second half the whole limit too, and a rule is read once more at
        or after it before it is called FAIL.
        Optional rules (a second rule the runbook says the same action also
        fires) are read the same way and reported as ALSO lines; they never
        fail the run. Under -WhatIf nothing is read and nothing waits.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string[]] $Required,
        [AllowEmptyCollection()] [string[]] $Optional = @(),
        [Parameter(Mandatory)] [int] $TimeoutMinutes,
        [System.Collections.IDictionary] $ContextMatch = @{},
        [System.Collections.IDictionary] $Hints = @{},
        [int] $PollSeconds = 60
    )

    $minutes = if ($Context.TimeoutMinutes -gt 0) { $Context.TimeoutMinutes } else { $TimeoutMinutes }
    $pending = [System.Collections.Generic.List[pscustomobject]]::new()
    $wanted = [System.Collections.Generic.List[pscustomobject]]::new()
    foreach ($short in $Required) {
        $wanted.Add([pscustomobject]@{ Short = [string]$short; Required = $true })
    }
    foreach ($short in $Optional) {
        $wanted.Add([pscustomobject]@{ Short = [string]$short; Required = $false })
    }
    foreach ($item in $wanted) {
        if (-not $Context.Rules.Contains($item.Short)) {
            throw "The rule $($item.Short) was not looked up before the test; this is a defect in the script."
        }
        $pending.Add([pscustomobject]@{
                Short     = $item.Short
                Rule      = $Context.Rules[$item.Short]
                Required  = $item.Required
                Match     = [string](Get-AlertProperty -Object $ContextMatch -Name $item.Short)
                Hint      = [string](Get-AlertProperty -Object $Hints -Name $item.Short)
                LastError = ''
            })
    }

    if ($WhatIfPreference) {
        foreach ($spec in $pending) {
            $line = "WHATIF $($spec.Rule.Name): would poll Azure Monitor's fired alerts once a minute for up to $minutes minutes"
            $Context.Results.Add([pscustomobject]@{ Rule = $spec.Short; Status = 'WHATIF'; Required = $spec.Required; FiredAtUtc = $null; Line = $line; Row = $null })
            Write-Host $line
        }
        return
    }
    if ($null -eq $Context.StartUtc) {
        throw 'The test has no start time to measure alerts from; this is a defect in the script.'
    }

    $since = ConvertTo-AlertUtc -Value $Context.StartUtc
    $pollStart = Get-AlertUtcNow
    $deadline = $pollStart.AddMinutes($minutes)
    Write-Host ''
    Write-Host "Proof: reading Azure Monitor's fired alerts once a minute for $(@($pending | ForEach-Object { $_.Rule.Name }) -join ', '), until $(Format-AlertTime -Utc $deadline). Only an alert that started after $(Format-AlertTime -Utc $since) counts."
    $nextNote = $pollStart.AddMinutes(5)
    while ($pending.Count -gt 0) {
        foreach ($spec in @($pending)) {
            $state = Get-AlertFiredState -Rule $spec.Rule -SinceUtc $since -ContextMatch $spec.Match
            if ($state.Error) {
                if ($spec.LastError -ne $state.Error) {
                    Write-Host "  Reading the alerts for $($spec.Rule.Name) failed; asking again next minute. $($state.Error)"
                }
                $spec.LastError = $state.Error
            }
            else {
                $spec.LastError = ''
            }
            $timedOut = (Get-AlertUtcNow) -ge $deadline
            if ($state.Fired -or $timedOut) {
                $verdict = Get-AlertVerdict -Rule $spec.Short -Name $spec.Rule.Name -State $state -Minutes $minutes -Required $spec.Required -Hint $spec.Hint -LastError $spec.LastError
                $Context.Results.Add($verdict)
                Write-Host $verdict.Line
                $null = $pending.Remove($spec)
            }
        }
        if ($pending.Count -gt 0) {
            $now = Get-AlertUtcNow
            if ($now -ge $nextNote) {
                Write-Host "  Still waiting for $(@($pending | ForEach-Object { $_.Rule.Name }) -join ', ') ($([int]($now - $pollStart).TotalMinutes) of $minutes minutes)."
                $nextNote = $now.AddMinutes(5)
            }
            Wait-AlertSeconds -Seconds $PollSeconds
        }
    }
}

# --- Look-ups shared by the tests --------------------------------------------

function Assert-AlertSignedIn {
    <#
    .SYNOPSIS
        Stops unless az is signed in with sub-app-site-prod-cus as its default
        subscription, and returns who it is signed in as.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [pscustomobject] $Estate)

    $account = Invoke-AlertAz -Arguments @('account', 'show', '-o', 'json')
    if ($account.ExitCode -ne 0) {
        throw (New-AlertStop -Message 'az is not signed in.' -Command "az login --tenant $($Estate.TenantDomain)")
    }
    $info = $account.Stdout | ConvertFrom-Json
    $name = [string](Get-AlertProperty -Object $info -Name 'name')
    if ($name -ne $Estate.AppSubscription) {
        throw (New-AlertStop -Message "az's default subscription is '$name', not $($Estate.AppSubscription). The runbook's commands name the application subscription's resources without --subscription, so they need it as the default." -Command "az account set --subscription $($Estate.AppSubscription)")
    }
    return [string](Get-AlertProperty -Object (Get-AlertProperty -Object $info -Name 'user') -Name 'name')
}

function Get-AlertSubscriptionId {
    <#
    .SYNOPSIS
        The subscription id at the front of a resource id, or $null.
    #>
    [OutputType([string])]
    param([AllowEmptyString()] [string] $ResourceId)

    if ($ResourceId -match '\A/subscriptions/([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})/') {
        return $Matches[1].ToLowerInvariant()
    }
    return $null
}

function Resolve-AlertRule {
    <#
    .SYNOPSIS
        Looks a rule up by name in its group and subscription and returns its
        id and subscription id, which the proof filters on. A rule that is not
        there stops the run before anything changes.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [pscustomobject] $Entry)

    $result = Invoke-AlertAz -Arguments @('resource', 'show', '--name', $Entry.Name, '--resource-group', $Entry.Group, '--resource-type', $Entry.Type, '--subscription', $Entry.Subscription, '-o', 'json')
    if ($result.ExitCode -ne 0) {
        throw (New-AlertStop -Message "Stop: the rule $($Entry.Name) was not found in $($Entry.Group) ($($Entry.Subscription)): $(Get-AlertAzFailure -Result $result) The PLAT-4 apply creates it; until it has, there is nothing to fire. Nothing was changed.")
    }
    $id = [string](Get-AlertProperty -Object ($result.Stdout | ConvertFrom-Json) -Name 'id')
    $subscriptionId = Get-AlertSubscriptionId -ResourceId $id
    if (-not $subscriptionId) {
        throw "az returned no usable id for the rule $($Entry.Name): '$id'."
    }
    return [pscustomobject]@{ Short = $Entry.Short; Name = $Entry.Name; Id = $id; SubscriptionId = $subscriptionId }
}

function Get-AlertSignedInUserId {
    <#
    .SYNOPSIS
        The signed-in account's object id ($me in the runbook).
    #>
    [OutputType([string])]
    param()

    $user = Invoke-AlertAzJson -Arguments @('ad', 'signed-in-user', 'show', '-o', 'json') -What 'Reading the signed-in account'
    $id = [string](Get-AlertProperty -Object $user -Name 'id')
    if (-not $id) {
        throw 'az ad signed-in-user show returned no id.'
    }
    return $id
}

function Get-AlertGroupId {
    <#
    .SYNOPSIS
        A resource group's id, looked up with its subscription named, so the
        default subscription does not matter.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Subscription
    )

    $group = Invoke-AlertAzJson -Arguments @('group', 'show', '-n', $Name, '--subscription', $Subscription, '-o', 'json') -What "Reading $Name"
    $id = [string](Get-AlertProperty -Object $group -Name 'id')
    if (-not $id) {
        throw "az returned no id for $Name."
    }
    return $id
}

function Get-AlertRoleAssignments {
    <#
    .SYNOPSIS
        Your role assignments at one scope: the runbook's stop-condition list.
    #>
    param(
        [Parameter(Mandatory)] [string] $Me,
        [Parameter(Mandatory)] [string] $Scope
    )

    @(Invoke-AlertAzJson -Arguments @('role', 'assignment', 'list', '--assignee', $Me, '--scope', $Scope, '-o', 'json') -What "Listing your role assignments at $Scope")
}

function Get-AlertFireTestRoles {
    <#
    .SYNOPSIS
        The custom roles at a scope named plat4-fire-test-*: the runbook's
        stop-condition list for the role-definition test.
    #>
    param([Parameter(Mandatory)] [string] $Scope)

    @(Invoke-AlertAzJson -Arguments @('role', 'definition', 'list', '--custom-role-only', 'true', '--scope', $Scope, '-o', 'json') -What "Listing custom roles at $Scope") |
        Where-Object { [string](Get-AlertProperty -Object $_ -Name 'roleName') -like 'plat4-fire-test-*' }
}

function Get-AlertAppSettings {
    <#
    .SYNOPSIS
        The Function App's settings, parsed. Several are secrets, so nothing
        here is ever printed; callers pick out the one setting they need.
    #>
    param()

    $estate = Get-AlertEstate
    @(Invoke-AlertAzJson -Arguments @('functionapp', 'config', 'appsettings', 'list', '-n', $estate.FunctionApp, '-g', $estate.WebGroup, '-o', 'json') -What "Reading $($estate.FunctionApp)'s app settings")
}

function Select-AlertSetting {
    <#
    .SYNOPSIS
        The rows of one named setting.
    #>
    param(
        [AllowEmptyCollection()] [AllowNull()] [object[]] $Settings,
        [Parameter(Mandatory)] [string] $Name
    )

    @(@($Settings) | Where-Object { $null -ne $_ -and [string](Get-AlertProperty -Object $_ -Name 'name') -eq $Name })
}

function Wait-AlertCondition {
    <#
    .SYNOPSIS
        Runs a read until it says done or the attempts run out, and returns
        its last answer as an array, nulls dropped. For lists that a delete
        takes a few seconds to empty, and a new role that takes a minute to
        be listed. Done gets the same array.
    #>
    param(
        [Parameter(Mandatory)] [scriptblock] $Read,
        [Parameter(Mandatory)] [scriptblock] $Done,
        [int] $Attempts = 4,
        [int] $DelaySeconds = 15
    )

    $answer = [object[]]@()
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $answer = [object[]]@(& $Read | Where-Object { $null -ne $_ })
        if (& $Done $answer) {
            return , $answer
        }
        if ($attempt -lt $Attempts) {
            Wait-AlertSeconds -Seconds $DelaySeconds
        }
    }
    return , $answer
}

# --- kv-config-write -----------------------------------------------------------

function Restore-AlertVaultTag {
    <#
    .SYNOPSIS
        Takes the test's tag keys off the site vault, then reads the vault's
        tags to confirm they are gone.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $VaultId,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Tags
    )

    $estate = Get-AlertEstate
    foreach ($key in @($Tags.Keys)) {
        $delete = Invoke-AlertAzChange -Arguments @('tag', 'update', '--resource-id', $VaultId, '--operation', 'Delete', '--tags', "$key=$($Tags[$key])", '-o', 'none') -What 'Take the test tag off the site vault' -NoThrow
        if ($delete.Ran -and $delete.ExitCode -ne 0) {
            Write-Host "  az answered: $(Get-AlertAzFailure -Result $delete)"
        }
    }
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would then read $($estate.SiteVault)'s tags to confirm the test's are gone."
        return
    }
    try {
        $vault = Invoke-AlertAzJson -Arguments @('keyvault', 'show', '-n', $estate.SiteVault, '-g', $estate.SecurityGroup, '-o', 'json') -What "Reading $($estate.SiteVault)"
        $left = [System.Collections.Generic.List[string]]::new()
        $tagObject = Get-AlertProperty -Object $vault -Name 'tags'
        if ($null -ne $tagObject) {
            foreach ($property in $tagObject.PSObject.Properties) {
                if ($Tags.Contains($property.Name)) {
                    $left.Add($property.Name)
                }
            }
        }
    }
    catch {
        Add-AlertProblem -Context $Context -Message "Could not confirm the test's tag is off $($estate.SiteVault): $($_.Exception.Message)" -Command $Context.RecoverCommand
        return
    }
    if ($left.Count -eq 0) {
        Write-Host "Put back: $($estate.SiteVault) carries no tag of this test's."
    }
    else {
        Add-AlertProblem -Context $Context -Message "$($estate.SiteVault) still carries the tag $($left -join ', ')." -Command $Context.RecoverCommand
    }
}

function Invoke-AlertTestKvConfigWrite {
    <#
    .SYNOPSIS
        alert-kv-config-write: add a tag to the site vault and take it off.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $vault = Invoke-AlertAzJson -Arguments @('keyvault', 'show', '-n', $estate.SiteVault, '-g', $estate.SecurityGroup, '-o', 'json') -What "Reading $($estate.SiteVault)"
    $kv = [string](Get-AlertProperty -Object $vault -Name 'id')
    if (-not $kv) {
        throw "az returned no id for $($estate.SiteVault)."
    }
    $tk = 'plat4FireTest' + (Get-Date -Format 'yyyyMMddHHmmss')
    Write-Host "Tag: $tk=1 on $($estate.SiteVault), named for this moment so it cannot be one the vault already has."

    $Context.StartUtc = Get-AlertUtcNow
    try {
        $null = Invoke-AlertAzChange -Arguments @('tag', 'update', '--resource-id', $kv, '--operation', 'Merge', '--tags', "$tk=1", '-o', 'none') -What 'Add the test tag to the site vault'
    }
    finally {
        Restore-AlertVaultTag -Context $Context -VaultId $kv -Tags @{ $tk = '1' }
    }
    Wait-AlertFired -Context $Context -Required @('alert-kv-config-write') -TimeoutMinutes (Get-AlertTestDefinition -Test 'kv-config-write').TimeoutMinutes
}

function Invoke-AlertRecoverKvConfigWrite {
    <#
    .SYNOPSIS
        The runbook keeps no record for this test, because its key is named
        for the moment. A run cut off between its two writes leaves that one
        tag, so this takes off any plat4FireTest* tag the vault carries, with
        the test's own delete.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $vault = Invoke-AlertAzJson -Arguments @('keyvault', 'show', '-n', $estate.SiteVault, '-g', $estate.SecurityGroup, '-o', 'json') -What "Reading $($estate.SiteVault)"
    $kv = [string](Get-AlertProperty -Object $vault -Name 'id')
    $tags = @{}
    $tagObject = Get-AlertProperty -Object $vault -Name 'tags'
    if ($null -ne $tagObject) {
        foreach ($property in $tagObject.PSObject.Properties) {
            if ($property.Name -like 'plat4FireTest*') {
                $tags[$property.Name] = [string]$property.Value
            }
        }
    }
    if ($tags.Count -eq 0) {
        Write-Host "Nothing to recover: $($estate.SiteVault) carries no plat4FireTest tag."
        return
    }
    Restore-AlertVaultTag -Context $Context -VaultId $kv -Tags $tags
}

# --- rbac-assignment ------------------------------------------------------------

function Get-AlertRoleHalves {
    <#
    .SYNOPSIS
        The two halves of the role tests, Management first, as the runbook
        orders them.
    #>
    param([Parameter(Mandatory)] [string] $Kind)

    $estate = Get-AlertEstate
    return @(
        [pscustomobject]@{ Rule = "alert-rbac-$Kind-mgmt"; Group = $estate.MgmtGroup; Subscription = $estate.MgmtSubscription },
        [pscustomobject]@{ Rule = "alert-rbac-$Kind-app"; Group = $estate.WebGroup; Subscription = $estate.AppSubscription }
    )
}

function Restore-AlertRoleAssignment {
    <#
    .SYNOPSIS
        Deletes the test's role assignment by its recorded id, lists your
        assignments at that scope again, and removes the record only once
        the list is empty.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $RecordPath,
        [Parameter(Mandatory)] [string] $AssignmentId,
        [Parameter(Mandatory)] [string] $Me,
        [Parameter(Mandatory)] [string] $Scope
    )

    $delete = Invoke-AlertAzChange -Arguments @('role', 'assignment', 'delete', '--ids', $AssignmentId) -What 'Delete the test role assignment by its recorded id' -NoThrow
    if ($delete.Ran -and $delete.ExitCode -ne 0) {
        Write-Host "  az answered: $(Get-AlertAzFailure -Result $delete) An answer that the assignment does not exist means the run stopped before creating it; the list below decides."
    }
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would then list your assignments at $Scope and remove $RecordPath once that list is empty."
        return
    }
    try {
        $left = Wait-AlertCondition -Read { Get-AlertRoleAssignments -Me $Me -Scope $Scope } -Done { param($rows) @($rows).Count -eq 0 }
    }
    catch {
        Add-AlertProblem -Context $Context -Message "Could not list your assignments at $Scope to confirm the delete: $($_.Exception.Message) $RecordPath is kept." -Command $Context.RecoverCommand
        return
    }
    if (@($left).Count -eq 0) {
        Write-Host "Put back: no assignment of yours at $Scope."
        Remove-AlertFile -Path $RecordPath -What 'Remove the record' -IfPresent
    }
    else {
        $roles = (@($left | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'roleDefinitionName') }) -join ', ')
        Add-AlertProblem -Context $Context -Message "Your assignments at $Scope still list $(@($left).Count) row(s) ($roles) after the delete, so it did not take. $RecordPath is kept: it is what the recovery works from." -Command $Context.RecoverCommand
    }
}

function Invoke-AlertTestRbacAssignment {
    <#
    .SYNOPSIS
        alert-rbac-assignment-mgmt and -app: grant this account Reader on one
        group in each subscription and take it back, one half at a time.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $me = Get-AlertSignedInUserId
    $rf = Get-AlertRecordPath -Context $Context -Name 'plat4-rbac-test.json'
    $fired = [System.Collections.Generic.List[string]]::new()
    foreach ($half in (Get-AlertRoleHalves -Kind 'assignment')) {
        if ($Context.Problems.Count -gt 0) {
            Write-Host "The previous half was not put back, so $($half.Rule) is not run."
            break
        }
        Write-Host ''
        Write-Host "Half: $($half.Rule), Reader on $($half.Group) in $($half.Subscription)."
        $scope = Get-AlertGroupId -Name $half.Group -Subscription $half.Subscription
        Assert-AlertNoRecord -Context $Context -Path $rf
        $existing = @(Get-AlertRoleAssignments -Me $me -Scope $scope)
        if ($existing.Count -gt 0) {
            $roles = (@($existing | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'roleDefinitionName') }) -join ', ')
            Add-AlertSkip -Context $Context -Rule $half.Rule -Reason "this account already holds a direct assignment at $($half.Group) ($roles)"
            continue
        }
        Write-Host "Stop condition: no assignment of yours at $($half.Group)."

        $rn = [guid]::NewGuid().ToString()
        $rid = "$scope/providers/Microsoft.Authorization/roleAssignments/$rn"
        if ($null -eq $Context.StartUtc) {
            $Context.StartUtc = Get-AlertUtcNow
        }
        Write-AlertRecord -Context $Context -Path $rf -Record @{ ra = $rid } -NoClobber
        try {
            $null = Invoke-AlertAzChange -Arguments @('role', 'assignment', 'create', '--name', $rn, '--assignee-object-id', $me, '--assignee-principal-type', 'User', '--role', 'Reader', '--scope', $scope, '-o', 'none') -What "Grant this account Reader on $($half.Group)"
            $fired.Add($half.Rule)
        }
        finally {
            Restore-AlertRoleAssignment -Context $Context -RecordPath $rf -AssignmentId $rid -Me $me -Scope $scope
        }
    }
    if ($fired.Count -gt 0) {
        Wait-AlertFired -Context $Context -Required $fired.ToArray() -TimeoutMinutes (Get-AlertTestDefinition -Test 'rbac-assignment').TimeoutMinutes
    }
}

function Invoke-AlertRecoverRbacAssignment {
    <#
    .SYNOPSIS
        The runbook's recovery: delete by the recorded id, list again, and
        remove the record only once the list is empty.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $rf = Get-AlertRecordPath -Context $Context -Name 'plat4-rbac-test.json'
    if (-not (Test-Path -LiteralPath $rf)) {
        Write-Host "Nothing to recover: there is no $rf."
        return
    }
    $ra = [string](Get-AlertProperty -Object (Read-AlertRecord -Path $rf) -Name 'ra')
    if ($ra -notmatch '\A(/subscriptions/[^/]+/resourceGroups/[^/]+)/providers/Microsoft\.Authorization/roleAssignments/[0-9a-fA-F-]{36}\z') {
        throw (New-AlertStop -Message "Stop: $rf does not hold a role assignment id this test writes ('$ra'). Read it and recover by hand; nothing was changed.")
    }
    $scope = $Matches[1]
    $me = Get-AlertSignedInUserId
    Restore-AlertRoleAssignment -Context $Context -RecordPath $rf -AssignmentId $ra -Me $me -Scope $scope
}

# --- rbac-definition ------------------------------------------------------------

function Write-AlertRoleFile {
    <#
    .SYNOPSIS
        The throwaway role's definition, written to a temporary file as the
        runbook writes it: read resource groups and nothing else, assignable
        at one group.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Scope
    )

    if ($PSCmdlet.ShouldProcess("Write the role definition to $Path", 'Write the role file?', 'Invoke-AlertFireTest')) {
        @{ Name = $Name; IsCustom = $true; Description = 'PLAT-4 fire test. Delete on sight.'; Actions = @('Microsoft.Resources/subscriptions/resourceGroups/read'); NotActions = @(); AssignableScopes = @($Scope) } | ConvertTo-Json | Set-Content -LiteralPath $Path
    }
}

function Restore-AlertRoleDefinition {
    <#
    .SYNOPSIS
        Deletes the throwaway role by its recorded name, lists the fire-test
        roles at that scope again, deletes again while one is listed, and
        removes the two files only once the list is empty.

    .DESCRIPTION
        A new custom role can take a minute to be listed, and a delete before
        then answers that it does not exist. So when this run created the
        role, the list is read until the role appears before it is deleted,
        as the runbook does; a role that never appears is a role whose delete
        cannot be confirmed, and its record is kept.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $RecordPath,
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Scope,
        [Parameter(Mandatory)] [string] $RoleFile,
        [switch] $Created
    )

    $deleteArguments = @('role', 'definition', 'delete', '--name', $Name, '--scope', $Scope)
    if ($WhatIfPreference) {
        $null = Invoke-AlertAzChange -Arguments $deleteArguments -What 'Delete the throwaway role by its recorded name' -NoThrow
        Write-Host "WhatIf: would then list the plat4-fire-test-* roles at $Scope, delete again while one is listed, and remove $RoleFile and $RecordPath once the list is empty."
        return
    }
    try {
        $listed = $true
        if ($Created) {
            Write-Host "Waiting for $Name to be listed at $Scope before deleting it (a new custom role can take a minute)."
            $rows = Wait-AlertCondition -Read { Get-AlertFireTestRoles -Scope $Scope } -Done { param($found) @($found | Where-Object { [string](Get-AlertProperty -Object $_ -Name 'roleName') -eq $Name }).Count -gt 0 } -Attempts 20 -DelaySeconds 15
            $listed = @($rows | Where-Object { [string](Get-AlertProperty -Object $_ -Name 'roleName') -eq $Name }).Count -gt 0
            if ($listed) {
                Write-Host "Listed: $Name."
            }
        }
        $left = @()
        for ($attempt = 1; $attempt -le 4; $attempt++) {
            $delete = Invoke-AlertAzChange -Arguments $deleteArguments -What 'Delete the throwaway role by its recorded name' -NoThrow
            if ($delete.Ran -and $delete.ExitCode -ne 0) {
                Write-Host "  az answered: $(Get-AlertAzFailure -Result $delete) An answer that the role does not exist means the run stopped before creating it, or the role is not listed yet; the list below decides."
            }
            $left = Wait-AlertCondition -Read { Get-AlertFireTestRoles -Scope $Scope } -Done { param($found) @($found).Count -eq 0 } -Attempts 4 -DelaySeconds 15
            if (@($left).Count -eq 0) {
                break
            }
        }
    }
    catch {
        Add-AlertProblem -Context $Context -Message "Could not confirm the throwaway role $Name is gone from $Scope`: $($_.Exception.Message) $RecordPath is kept." -Command $Context.RecoverCommand
        return
    }
    if (@($left).Count -gt 0) {
        $names = (@($left | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'roleName') }) -join ', ')
        Add-AlertProblem -Context $Context -Message "The fire-test roles at $Scope still list $names after the delete. $RecordPath and $RoleFile are kept." -Command $Context.RecoverCommand
        return
    }
    if (-not $listed) {
        Add-AlertProblem -Context $Context -Message "$Name was created but was not listed at $Scope within five minutes, so an empty list does not yet prove it is gone. $RecordPath is kept; run the recovery once the role has had time to appear." -Command $Context.RecoverCommand
        return
    }
    Write-Host "Put back: no plat4-fire-test-* role at $Scope."
    Remove-AlertFile -Path $RoleFile -What 'Remove the temporary role file' -IfPresent
    Remove-AlertFile -Path $RecordPath -What 'Remove the record' -IfPresent
}

function Invoke-AlertTestRbacDefinition {
    <#
    .SYNOPSIS
        alert-rbac-definition-mgmt and -app: create a throwaway custom role in
        each subscription and delete it, one half at a time.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $df = Get-AlertRecordPath -Context $Context -Name 'plat4-roledef-test.json'
    $fired = [System.Collections.Generic.List[string]]::new()
    foreach ($half in (Get-AlertRoleHalves -Kind 'definition')) {
        if ($Context.Problems.Count -gt 0) {
            Write-Host "The previous half was not put back, so $($half.Rule) is not run."
            break
        }
        Write-Host ''
        Write-Host "Half: $($half.Rule), a throwaway role at $($half.Group) in $($half.Subscription)."
        $scope = Get-AlertGroupId -Name $half.Group -Subscription $half.Subscription
        Assert-AlertNoRecord -Context $Context -Path $df
        $leftover = @(Get-AlertFireTestRoles -Scope $scope)
        if ($leftover.Count -gt 0) {
            $first = [string](Get-AlertProperty -Object $leftover[0] -Name 'roleName')
            throw (New-AlertStop -Message "Stop: a fire-test role an earlier run left behind is still defined at $($half.Group) ($(@($leftover | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'roleName') }) -join ', ')). Delete it first; this run changed nothing." -Command "az role definition delete --name $first --scope $scope")
        }
        Write-Host "Stop condition: no plat4-fire-test-* role at $($half.Group)."

        $dn = 'plat4-fire-test-' + [guid]::NewGuid().ToString()
        if ($null -eq $Context.StartUtc) {
            $Context.StartUtc = Get-AlertUtcNow
        }
        Write-AlertRecord -Context $Context -Path $df -Record @{ name = $dn; scope = $scope } -NoClobber
        $dj = Join-Path ([System.IO.Path]::GetTempPath()) ($dn + '.json')
        $created = $false
        try {
            Write-AlertRoleFile -Path $dj -Name $dn -Scope $scope
            $create = Invoke-AlertAzChange -Arguments @('role', 'definition', 'create', '--role-definition', "@$dj", '-o', 'none') -What "Create the throwaway role $dn at $($half.Group)"
            $created = $create.Ran
            $fired.Add($half.Rule)
        }
        finally {
            Restore-AlertRoleDefinition -Context $Context -RecordPath $df -Name $dn -Scope $scope -RoleFile $dj -Created:$created
        }
    }
    if ($fired.Count -gt 0) {
        Wait-AlertFired -Context $Context -Required $fired.ToArray() -TimeoutMinutes (Get-AlertTestDefinition -Test 'rbac-definition').TimeoutMinutes
    }
}

function Invoke-AlertRecoverRbacDefinition {
    <#
    .SYNOPSIS
        The runbook's recovery: delete by the recorded name and scope, list
        again, delete again while a row is listed, and remove the temporary
        role file and the record only once the list is empty.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $df = Get-AlertRecordPath -Context $Context -Name 'plat4-roledef-test.json'
    if (-not (Test-Path -LiteralPath $df) ) {
        Write-Host "Nothing to recover: there is no $df."
        return
    }
    $record = Read-AlertRecord -Path $df
    $name = [string](Get-AlertProperty -Object $record -Name 'name')
    $scope = [string](Get-AlertProperty -Object $record -Name 'scope')
    if ($name -notmatch '\Aplat4-fire-test-[0-9a-fA-F-]{36}\z' -or $scope -notmatch '\A/subscriptions/[^/]+/resourceGroups/[^/]+\z') {
        throw (New-AlertStop -Message "Stop: $df does not hold the name and scope this test writes. Read it and recover by hand; nothing was changed.")
    }
    $dj = Join-Path ([System.IO.Path]::GetTempPath()) ($name + '.json')
    Restore-AlertRoleDefinition -Context $Context -RecordPath $df -Name $name -Scope $scope -RoleFile $dj
}

# --- kv-errors-and-data-write -------------------------------------------------

function Get-AlertRefusalNote {
    <#
    .SYNOPSIS
        What the refused write's answer means. Refused is the expected result.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Result,
        [Parameter(Mandatory)] [string] $SecretName
    )

    if ($Result.ExitCode -eq 0) {
        return "The vault accepted the write, which it should not have: no secret named $SecretName should exist. Look at kv-site-prod-cus-01's secrets."
    }
    if ($Result.Stderr -match 'Forbidden') {
        return 'Refused with Forbidden, the expected result (the firewall or the missing data role).'
    }
    if ($Result.Stderr -match 'SecretNotFound') {
        return 'Refused with SecretNotFound, the expected result.'
    }
    return "Refused with something else: $(Get-AlertAzFailure -Result $Result) If that answer never reached the vault, no row was logged and neither rule can fire."
}

function Invoke-AlertTestKvErrorsAndDataWrite {
    <#
    .SYNOPSIS
        alert-kv-errors and alert-kv-data-write: one refused write fires both.
        It names a secret for this moment, so it cannot be an existing one,
        and even a write that got through would change nothing.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $sn = 'plat4-fire-test-' + (Get-Date -Format 'yyyyMMddHHmmss')
    $Context.StartUtc = Get-AlertUtcNow
    $run = Invoke-AlertAzChange -Arguments @('keyvault', 'secret', 'set-attributes', '--vault-name', $estate.SiteVault, '--name', $sn, '--enabled', 'false') -What 'Ask the site vault for a write it refuses' -NoThrow
    if ($run.Ran) {
        Write-Host (Get-AlertRefusalNote -Result $run -SecretName $sn)
    }
    $hint = 'if only alert-kv-errors arrived, the refused row did not carry the operation name; the Key Vault query in "Before the apply", narrowed to the last hour, shows what it did carry'
    Wait-AlertFired -Context $Context -Required @('alert-kv-errors', 'alert-kv-data-write') -TimeoutMinutes (Get-AlertTestDefinition -Test 'kv-errors-and-data-write').TimeoutMinutes -Hints @{ 'alert-kv-data-write' = $hint }
}

# --- lab-vault-unwrap -----------------------------------------------------------

function Get-AlertVaultToken {
    <#
    .SYNOPSIS
        An access token for Key Vault, as the runbook gets it. It is a secret:
        it goes into a variable and from there into one request header,
        never to the screen. The seam the tests mock.
    #>
    [OutputType([string])]
    param()

    $result = Invoke-AlertAz -Arguments @('account', 'get-access-token', '--resource', 'https://vault.azure.net', '-o', 'json')
    if ($result.ExitCode -ne 0) {
        throw "Getting a token for https://vault.azure.net failed: az exited $($result.ExitCode). $(Get-AlertAzFailure -Result $result)"
    }
    $token = [string](Get-AlertProperty -Object ($result.Stdout | ConvertFrom-Json) -Name 'accessToken')
    if (-not $token) {
        throw 'az account get-access-token returned no token.'
    }
    return $token
}

function Invoke-AlertVaultWrap {
    <#
    .SYNOPSIS
        Asks the seal key to wrap the test value and returns the HTTP status.
        A refusal is the expected answer, so it is returned, not thrown. The
        seam the tests mock.
    #>
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [string] $Token
    )

    try {
        $null = Invoke-RestMethod -Method Post -Uri $Uri -Headers @{ Authorization = "Bearer $Token" } -ContentType 'application/json' -Body '{"alg":"RSA-OAEP-256","value":"cGxhdDQtZmlyZS10ZXN0"}'
        return 200
    }
    catch {
        $response = Get-AlertProperty -Object $_.Exception -Name 'Response'
        $status = Get-AlertProperty -Object $response -Name 'StatusCode'
        if ($null -ne $status) {
            return [int]$status
        }
        throw "The wrap request did not get an answer from Key Vault: $($_.Exception.Message)"
    }
}

function Invoke-AlertTestLabVaultUnwrap {
    <#
    .SYNOPSIS
        alert-lab-vault-unwrap: ask the seal key to wrap a test value from
        this machine. It wraps and never unwraps, so nothing about Vault
        changes either way.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $uri = "https://$($estate.LabVault).vault.azure.net/keys/vault-seal/wrapkey?api-version=7.4"
    $lines = "`$t = (az account get-access-token --resource https://vault.azure.net -o json | ConvertFrom-Json).accessToken, then Invoke-RestMethod -Method Post -Uri '$uri' -Headers @{ Authorization = ""Bearer `$t"" } -ContentType 'application/json' -Body '{""alg"":""RSA-OAEP-256"",""value"":""cGxhdDQtZmlyZS10ZXN0""}'"
    $Context.StartUtc = Get-AlertUtcNow
    if ($PSCmdlet.ShouldProcess("Ask the seal key to wrap a test value from this machine: $lines", 'Ask the seal key?', 'Invoke-AlertFireTest')) {
        Write-Host "  > POST $uri (with a Key Vault token for this account, which is not printed)"
        $token = Get-AlertVaultToken
        try {
            $status = Invoke-AlertVaultWrap -Uri $uri -Token $token
        }
        finally {
            $token = $null
        }
        if ($status -eq 403) {
            Write-Host 'Refused with 403, the expected result: the refusal is logged with this machine''s address.'
        }
        else {
            Write-Host "Key Vault answered $status, not the expected 403. The call is still logged with this machine's address, so the rule can still fire."
        }
    }
    Wait-AlertFired -Context $Context -Required @('alert-lab-vault-unwrap') -Optional @('alert-kv-errors') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-vault-unwrap').TimeoutMinutes
}

# --- lab-ssh-burst ------------------------------------------------------------

function Invoke-AlertTestLabSshBurst {
    <#
    .SYNOPSIS
        alert-lab-ssh-burst: a thousand failed-login lines under sshd's name,
        written by logger, so fail2ban bans nothing and no login is tried.
        Each line carries its own port number: the host's rsyslog runs with
        $RepeatedMsgReduction on, which folds identical consecutive lines into
        one "message repeated N times" line, and the 2026-10-15 run of this
        test with one fixed port reached the workspace as two Syslog rows
        (#964). A thousand distinct lines reach it as a thousand.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $command = 'for i in {1..1000}; do logger -p auth.info -t sshd "Invalid user plat4firetest from 192.0.2.10 port $((20000 + i))"; done'
    $Context.StartUtc = Get-AlertUtcNow
    $run = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command $command -What 'Write a thousand failed-login lines to the lab host''s auth log'
    if ($run.Ran) {
        Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $Context.HostAlias
        if ($run.ExitCode -ne 0) {
            throw "Writing the lines on $($Context.HostAlias) failed (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
        }
        Write-Host 'Written: a thousand lines.'
    }
    Wait-AlertFired -Context $Context -Required @('alert-lab-ssh-burst') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-ssh-burst').TimeoutMinutes
}

# --- lab-ssh-login ------------------------------------------------------------

function Invoke-AlertTestLabSshLogin {
    <#
    .SYNOPSIS
        alert-lab-ssh-login (#953): one accepted-login line under sshd's
        name, written by logger, so no login happens. It has the shape of
        OpenSSH's own line, which the rule parses, and both its user and its
        key are outside the expected pair, so the rule pages on it whatever
        lab_ssh_loopback_only says. The address is a documentation one.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $command = 'logger -p auth.info -t sshd "Accepted publickey for firetest from 192.0.2.10 port 1 ssh2: ED25519 SHA256:firetest"'
    $Context.StartUtc = Get-AlertUtcNow
    $run = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command $command -What 'Write one accepted-login line to the lab host''s auth log'
    if ($run.Ran) {
        Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $Context.HostAlias
        if ($run.ExitCode -ne 0) {
            throw "Writing the line on $($Context.HostAlias) failed (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
        }
        Write-Host 'Written: one line.'
    }
    Wait-AlertFired -Context $Context -Required @('alert-lab-ssh-login') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-ssh-login').TimeoutMinutes
}

# --- lab-unit-failed ----------------------------------------------------------

function Get-AlertUnitFailedLines {
    <#
    .SYNOPSIS
        The hcw-unit-failed lines in the lab host's journal from the last
        hour, the rule's window: the stop-condition read. A read, so it runs
        under -WhatIf too. -q keeps journalctl's own "-- No entries --" out,
        so every line returned is a notifier line.
    #>
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [string] $HostAlias)

    $run = Invoke-AlertSsh -HostAlias $HostAlias -Command 'sudo journalctl -t hcw-unit-failed --since -1h --no-pager -q -o cat'
    Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $HostAlias
    if ($run.ExitCode -ne 0) {
        throw "Reading the hcw-unit-failed lines on $HostAlias failed (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
    }
    # No unary comma: callers wrap this in @(), which would otherwise read an
    # empty answer as one item holding an empty array.
    return [string[]]@(@($run.Lines) | Where-Object { $_ -and $_.Trim() })
}

function Get-AlertUnitFailedUnit {
    <#
    .SYNOPSIS
        The unit the test's line names: hcw-fire-test-<stamp>.service, a unit
        that does not exist, named for the moment so the mail reads as this
        test's and the Fire record can quote it.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [datetime] $Utc)

    return 'hcw-fire-test-' + (ConvertTo-AlertUtc -Value $Utc).ToString("yyyyMMdd'T'HHmmss'Z'", [cultureinfo]::InvariantCulture) + '.service'
}

function Invoke-AlertTestLabUnitFailed {
    <#
    .SYNOPSIS
        alert-lab-unit-failed (#981, LAB-2): one line under the notifier's
        tag, written by logger exactly as hcw-unit-failed@.service writes its
        own (lab-host/ansible/roles/hardening/templates/hcw-unit-failed@
        .service.j2: logger -t hcw-unit-failed -p daemon.err "unit %i entered
        the failed state on %H"), naming a unit that does not exist. The
        daemon facility at err is within what the lab DCR ships, so the line
        reaches Syslog with ProcessName hcw-unit-failed, which is all the
        rule reads. No unit fails and nothing on the host changes.

    .DESCRIPTION
        The stop condition is that the hour's window holds no notifier line
        already: the rule is stateless and fires at every evaluation while
        one is in the window, so an alert that opened after the test started
        could be that line's rather than this one's, and a real failure is
        the thing to look at first. There is no put-back: the line leaves the
        window on its own, and the rule's six-hour mute follows the alert
        whether the line was staged or real.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $existing = @(Get-AlertUnitFailedLines -HostAlias $Context.HostAlias)
    if ($existing.Count -gt 0) {
        throw (New-AlertStop -Message "Stop: the lab host's journal already holds $($existing.Count) hcw-unit-failed line(s) from the last hour ($($existing[0])), so the rule's window is not empty: a unit failed, or an earlier run of this test is still in the window. An alert that opens now could be that line's. Look at the unit first; nothing was changed." -Command "ssh $($Context.HostAlias) 'systemctl --failed --no-pager; sudo journalctl -t hcw-unit-failed --since -2h --no-pager'")
    }
    Write-Host 'Stop condition: no hcw-unit-failed line in the last hour on the lab host.'

    $Context.StartUtc = Get-AlertUtcNow
    $unit = Get-AlertUnitFailedUnit -Utc $Context.StartUtc
    $command = 'logger -t hcw-unit-failed -p daemon.err "unit ' + $unit + ' entered the failed state on $(hostname)"'
    Write-Host "Line: the notifier's own shape, naming $unit, a unit that does not exist."
    $run = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command $command -What 'Write one hcw-unit-failed line to the lab host''s syslog'
    if ($run.Ran) {
        Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $Context.HostAlias
        if ($run.ExitCode -ne 0) {
            throw "Writing the line on $($Context.HostAlias) failed (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
        }
        Write-Host 'Written: one line. Nothing to put back: the rule is stateless, and the line leaves its hour-long window on its own.'
    }
    Wait-AlertFired -Context $Context -Required @('alert-lab-unit-failed') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-unit-failed').TimeoutMinutes -Hints @{ 'alert-lab-unit-failed' = 'the rule evaluates every 15 minutes over the last hour; the line must reach Syslog with ProcessName hcw-unit-failed, which the lab DCR ships for the daemon facility at Warning and above' }
}

# --- jobs-poison --------------------------------------------------------------

function Get-AlertDeployRuns {
    <#
    .SYNOPSIS
        The deploy-functions.yml runs in progress, which open and close the
        same firewall as this test. The runbook's line prints nothing when
        there are none; --json reads the same list without depending on how
        gh words an empty one.
    #>
    param()

    $estate = Get-AlertEstate
    $result = Invoke-AlertGh -Arguments @('run', 'list', '-R', $estate.Repository, '-w', 'deploy-functions.yml', '-s', 'in_progress', '--json', 'databaseId,url')
    if ($result.ExitCode -ne 0) {
        throw (New-AlertStop -Message "Stop: gh could not list the deploy-functions.yml runs, so the test cannot check it runs alone: $(Get-AlertAzFailure -Result $result) Nothing was changed." -Command 'gh auth status')
    }
    if ([string]::IsNullOrWhiteSpace($result.Stdout)) {
        return
    }
    $result.Stdout | ConvertFrom-Json
}

function Get-AlertStorageState {
    <#
    .SYNOPSIS
        The Functions host account's id and firewall address rules.
    #>
    [OutputType([pscustomobject])]
    param()

    $estate = Get-AlertEstate
    $account = Invoke-AlertAzJson -Arguments @('storage', 'account', 'show', '-n', $estate.FunctionsStorage, '-g', $estate.WebGroup, '-o', 'json') -What "Reading $($estate.FunctionsStorage)"
    $rules = Get-AlertList -Object (Get-AlertProperty -Object $account -Name 'networkRuleSet') -Name 'ipRules'
    $addresses = [string[]]@($rules | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'ipAddressOrRange') })
    return [pscustomobject]@{ Id = [string](Get-AlertProperty -Object $account -Name 'id'); IpRules = $addresses }
}

function Invoke-AlertDataPlaneChange {
    <#
    .SYNOPSIS
        A queue write with the runbook's retry: AuthorizationPermissionMismatch
        or AuthorizationFailure means the role or the firewall entry has not
        taken effect yet, so wait and repeat.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $What,
        [int] $Attempts = 10,
        [int] $DelaySeconds = 60
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $run = Invoke-AlertAzChange -Arguments $Arguments -What $What -NoThrow
        if (-not $run.Ran -or $run.ExitCode -eq 0) {
            return
        }
        if ($attempt -lt $Attempts -and $run.Stderr -match 'AuthorizationPermissionMismatch|AuthorizationFailure') {
            Write-Host "  The role or the firewall entry has not taken effect yet; trying again in $DelaySeconds seconds ($attempt of $Attempts)."
            Wait-AlertSeconds -Seconds $DelaySeconds
            continue
        }
        throw "$What failed: az exited $($run.ExitCode). $(Get-AlertAzFailure -Result $run)"
    }
}

function Restore-AlertPoisonAccess {
    <#
    .SYNOPSIS
        Removes the firewall entry and the role assignment the test recorded,
        whether or not the put worked, then reads both stop conditions again
        and removes the record only once both are empty.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $RecordPath,
        [Parameter(Mandatory)] [string] $Ip,
        [Parameter(Mandatory)] [string] $AssignmentId,
        [Parameter(Mandatory)] [string] $Me,
        [Parameter(Mandatory)] [string] $AccountId
    )

    $estate = Get-AlertEstate
    $rule = Invoke-AlertAzChange -Arguments @('storage', 'account', 'network-rule', 'remove', '--account-name', $estate.FunctionsStorage, '-g', $estate.WebGroup, '--ip-address', $Ip, '-o', 'none') -What 'Remove the recorded firewall entry' -NoThrow
    if ($rule.Ran -and $rule.ExitCode -ne 0) {
        Write-Host "  az answered: $(Get-AlertAzFailure -Result $rule) The read below decides."
    }
    $delete = Invoke-AlertAzChange -Arguments @('role', 'assignment', 'delete', '--ids', $AssignmentId) -What 'Delete the recorded role assignment' -NoThrow
    if ($delete.Ran -and $delete.ExitCode -ne 0) {
        Write-Host "  az answered: $(Get-AlertAzFailure -Result $delete) An answer that the assignment does not exist means the run stopped before creating it; the read below decides."
    }
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would then list your assignments on $($estate.FunctionsStorage) and its firewall address rules, and remove $RecordPath once both are empty."
        return
    }
    try {
        $state = Wait-AlertCondition -Read {
            [pscustomobject]@{
                Assignments = @(Get-AlertRoleAssignments -Me $Me -Scope $AccountId)
                IpRules     = @((Get-AlertStorageState).IpRules)
            }
        } -Done { param($answer) @($answer)[0].Assignments.Count -eq 0 -and @($answer)[0].IpRules.Count -eq 0 }
        $state = @($state)[0]
    }
    catch {
        Add-AlertProblem -Context $Context -Message "Could not read the account's assignments and firewall to confirm the clean-up: $($_.Exception.Message) $RecordPath is kept." -Command $Context.RecoverCommand
        return
    }
    if ($state.Assignments.Count -eq 0 -and $state.IpRules.Count -eq 0) {
        Write-Host "Put back: no assignment of yours on $($estate.FunctionsStorage), and no address in its firewall."
        Remove-AlertFile -Path $RecordPath -What 'Remove the record' -IfPresent
        return
    }
    $what = [System.Collections.Generic.List[string]]::new()
    if ($state.Assignments.Count -gt 0) {
        $what.Add("$($state.Assignments.Count) assignment(s) of yours")
    }
    if ($state.IpRules.Count -gt 0) {
        $what.Add("the firewall address(es) $($state.IpRules -join ', ')")
    }
    Add-AlertProblem -Context $Context -Message "$($estate.FunctionsStorage) still shows $($what -join ' and '). $RecordPath is kept: it is what the recovery works from." -Command $Context.RecoverCommand
}

function Invoke-AlertTestJobsPoison {
    <#
    .SYNOPSIS
        alert-jobs-poison: one short-lived message in the poison queue,
        through a temporary role and a temporary firewall entry that the test
        records before it makes them and undoes by that record.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $runs = @(Get-AlertDeployRuns)
    if ($runs.Count -gt 0) {
        throw (New-AlertStop -Message "Stop: a deploy-functions.yml run is in progress ($(@($runs | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'url') }) -join ', ')). It opens and closes the same firewall, so wait for it to finish; nothing was changed.")
    }
    Write-Host 'Alone: no deploy-functions.yml run is in progress. Run no other fire test from this page meanwhile.'

    $storage = Get-AlertStorageState
    $sa = $storage.Id
    if (-not $sa) {
        throw "az returned no id for $($estate.FunctionsStorage)."
    }
    $me = Get-AlertSignedInUserId
    $ip = Get-AlertPublicAddress
    if ($ip -notmatch '\A(?:\d{1,3}\.){3}\d{1,3}\z') {
        throw (New-AlertStop -Message "Stop: api.ipify.org answered '$ip', which is not an IPv4 address the storage firewall takes. Nothing was changed.")
    }
    Write-Host "Address: this machine is $ip."
    $sf = Get-AlertRecordPath -Context $Context -Name 'plat4-poison-test.json'

    Assert-AlertNoRecord -Context $Context -Path $sf
    $existing = @(Get-AlertRoleAssignments -Me $me -Scope $sa)
    if ($existing.Count -gt 0) {
        $roles = (@($existing | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'roleDefinitionName') }) -join ', ')
        Add-AlertSkip -Context $Context -Rule 'alert-jobs-poison' -Reason "this account already holds an assignment on $($estate.FunctionsStorage) ($roles), which the test would share a scope with"
        return
    }
    Write-Host "Stop condition: no assignment of yours on $($estate.FunctionsStorage)."
    if ($storage.IpRules.Count -gt 0) {
        throw (New-AlertStop -Message "Stop: $($estate.FunctionsStorage)'s firewall is already open to $($storage.IpRules -join ', '). Wait until it lists no address, then run this again; nothing was changed.")
    }
    Write-Host "Stop condition: no address in $($estate.FunctionsStorage)'s firewall."

    $ran = [guid]::NewGuid().ToString()
    $ra = "$sa/providers/Microsoft.Authorization/roleAssignments/$ran"
    $Context.StartUtc = Get-AlertUtcNow
    Write-AlertRecord -Context $Context -Path $sf -Record @{ ip = $ip; ra = $ra }
    try {
        $null = Invoke-AlertAzChange -Arguments @('role', 'assignment', 'create', '--name', $ran, '--assignee-object-id', $me, '--assignee-principal-type', 'User', '--role', 'Storage Queue Data Contributor', '--scope', $sa, '-o', 'none') -What 'Take a temporary queue data role on the account'
        $null = Invoke-AlertAzChange -Arguments @('storage', 'account', 'network-rule', 'add', '--account-name', $estate.FunctionsStorage, '-g', $estate.WebGroup, '--ip-address', $ip, '-o', 'none') -What 'Open the account''s firewall to this machine'
        if ($WhatIfPreference) {
            Write-Host 'WhatIf: would wait five minutes for the role and the firewall entry to take effect.'
        }
        else {
            Write-Host "Waiting five minutes for the role and the firewall entry to take effect (until $(Format-AlertTime -Utc (Get-AlertUtcNow).AddMinutes(5)))."
            Wait-AlertSeconds -Seconds 300
        }
        Invoke-AlertDataPlaneChange -Arguments @('storage', 'queue', 'create', '--name', 'platform-jobs-poison', '--account-name', $estate.FunctionsStorage, '--auth-mode', 'login', '-o', 'none') -What 'Create the poison queue if the host never has (a no-op if it exists)'
        Invoke-AlertDataPlaneChange -Arguments @('storage', 'message', 'put', '--queue-name', 'platform-jobs-poison', '--account-name', $estate.FunctionsStorage, '--auth-mode', 'login', '--content', 'plat4-fire-test', '--time-to-live', '900', '-o', 'none') -What 'Put a message that expires on its own after 15 minutes'
    }
    finally {
        Restore-AlertPoisonAccess -Context $Context -RecordPath $sf -Ip $ip -AssignmentId $ra -Me $me -AccountId $sa
    }
    Wait-AlertFired -Context $Context -Required @('alert-jobs-poison') -Optional @('alert-rbac-assignment-app') -TimeoutMinutes (Get-AlertTestDefinition -Test 'jobs-poison').TimeoutMinutes
}

function Invoke-AlertRecoverJobsPoison {
    <#
    .SYNOPSIS
        The runbook's recovery: remove the recorded address (even if this
        machine's has changed since) and the recorded assignment, read both
        stop conditions again, and remove the record once both are empty.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $sf = Get-AlertRecordPath -Context $Context -Name 'plat4-poison-test.json'
    if (-not (Test-Path -LiteralPath $sf)) {
        Write-Host "Nothing to recover: there is no $sf."
        return
    }
    $record = Read-AlertRecord -Path $sf
    $ip = [string](Get-AlertProperty -Object $record -Name 'ip')
    $ra = [string](Get-AlertProperty -Object $record -Name 'ra')
    $storage = Get-AlertStorageState
    if ($ip -notmatch '\A(?:\d{1,3}\.){3}\d{1,3}\z' -or -not $ra.StartsWith($storage.Id + '/providers/Microsoft.Authorization/roleAssignments/', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw (New-AlertStop -Message "Stop: $sf does not hold the address and assignment id this test writes. Read it and recover by hand; nothing was changed.")
    }
    $me = Get-AlertSignedInUserId
    Restore-AlertPoisonAccess -Context $Context -RecordPath $sf -Ip $ip -AssignmentId $ra -Me $me -AccountId $storage.Id
}

# --- lab-agent-offline --------------------------------------------------------

function Get-AlertAgentState {
    <#
    .SYNOPSIS
        What `systemctl is-active hcw-labs-agent` prints on the host. A read,
        so it runs under -WhatIf too.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $HostAlias)

    $run = Invoke-AlertSsh -HostAlias $HostAlias -Command 'systemctl is-active hcw-labs-agent'
    Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $HostAlias
    return (Get-AlertLastLine -Lines $run.Lines)
}

function Restore-AlertLabAgent {
    <#
    .SYNOPSIS
        Starts the labs agent again; success is the last line reading active.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $command = 'sudo systemctl start hcw-labs-agent; systemctl is-active hcw-labs-agent'
    $line = "ssh $($Context.HostAlias) " + (Format-AlertArgument -Value $command)
    $run = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command $command -What 'Start the labs agent again'
    if (-not $run.Ran) {
        return
    }
    $last = Get-AlertLastLine -Lines $run.Lines
    if ($last -eq 'active') {
        Write-Host 'Put back: hcw-labs-agent is active.'
    }
    else {
        Add-AlertProblem -Context $Context -Message "hcw-labs-agent did not come back: the last line reads '$last' (ssh exited $($run.ExitCode)). Public lab submissions stay closed until it does." -Command $line
    }
}

function Invoke-AlertTestLabAgentOffline {
    <#
    .SYNOPSIS
        alert-lab-agent-offline: stop the labs agent for a quarter of an hour
        and start it again.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $flag = @(Select-AlertSetting -Settings (Get-AlertAppSettings) -Name 'FEATURE_FLAG_CHECK_AGENT_HEALTH')
    $value = if ($flag.Count -gt 0) { [string](Get-AlertProperty -Object $flag[0] -Name 'value') } else { '(not set)' }
    if ($value -ne 'true') {
        throw (New-AlertStop -Message "Stop: FEATURE_FLAG_CHECK_AGENT_HEALTH is $value, not true, so checkAgentHealth, the timer that decides, is not armed and the alert cannot fire. Arm CHECK_AGENT_HEALTH first; nothing was changed.")
    }
    Write-Host 'Armed: FEATURE_FLAG_CHECK_AGENT_HEALTH is true.'
    $state = Get-AlertAgentState -HostAlias $Context.HostAlias
    if ($state -ne 'active') {
        throw (New-AlertStop -Message "Stop: hcw-labs-agent is '$state', not active, so the agent is already down. Do not run the test; find out why instead. Nothing was changed." -Command "ssh $($Context.HostAlias) 'systemctl status hcw-labs-agent --no-pager'")
    }
    Write-Host 'Stop condition: hcw-labs-agent is active.'
    Write-Host "Public lab submissions are closed while the agent is stopped. Run this when $($estate.LabsUrl) shows it idle."

    $Context.StartUtc = Get-AlertUtcNow
    try {
        $stop = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command 'sudo systemctl stop hcw-labs-agent' -What 'Stop the labs agent'
        if ($stop.Ran) {
            Assert-AlertSshReached -ExitCode $stop.ExitCode -HostAlias $Context.HostAlias
            if ($stop.ExitCode -ne 0) {
                throw "Stopping hcw-labs-agent failed (exit $($stop.ExitCode)): $((@($stop.Lines) | Select-Object -Last 3) -join ' ')"
            }
        }
        if ($WhatIfPreference) {
            Write-Host 'WhatIf: would wait fifteen minutes before starting it again.'
        }
        else {
            Write-Host "Waiting fifteen minutes, until $(Format-AlertTime -Utc (Get-AlertUtcNow).AddMinutes(15)); Telegram's ""offline"" message arrives in five to ten. Ctrl+C starts the agent again."
            Wait-AlertSeconds -Seconds 900
        }
    }
    finally {
        Restore-AlertLabAgent -Context $Context
    }
    Wait-AlertFired -Context $Context -Required @('alert-lab-agent-offline') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-agent-offline').TimeoutMinutes
}

# --- lab-heartbeat ------------------------------------------------------------

function Get-AlertMonitorAgentState {
    <#
    .SYNOPSIS
        What `systemctl is-active azuremonitoragent` prints on the host: the
        Azure Monitor Agent's unit, installed by the Arc extension
        Microsoft.Azure.Monitor/AzureMonitorLinuxAgent (lab-host/ansible/
        roles/arc, arc_extensions_allowlist). It is the unit that writes the
        Heartbeat rows; the Arc agent itself (himdsd) does not. A read, so it
        runs under -WhatIf too.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $HostAlias)

    $run = Invoke-AlertSsh -HostAlias $HostAlias -Command 'systemctl is-active azuremonitoragent'
    Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $HostAlias
    return (Get-AlertLastLine -Lines $run.Lines)
}

function Get-AlertRunningLabJobs {
    <#
    .SYNOPSIS
        The lab job containers running on the host, by the name the labs
        agent gives them (labjob-<12 hex>, lab-host/ansible/roles/labs_agent).
        A read, so it runs under -WhatIf too.
    #>
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [string] $HostAlias)

    $run = Invoke-AlertSsh -HostAlias $HostAlias -Command 'sudo docker ps --filter name=labjob- --format {{.Names}}'
    Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $HostAlias
    if ($run.ExitCode -ne 0) {
        throw "Listing the lab job containers on $HostAlias failed (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
    }
    # No unary comma, for the same reason as Get-AlertUnitFailedLines.
    return [string[]]@(@($run.Lines) | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
}

function Restore-AlertMonitorAgent {
    <#
    .SYNOPSIS
        Starts the Azure Monitor Agent again; success is the last line
        reading active. Anything else is a problem that names the exact line
        to run by hand, because until it is active the host ships no
        Heartbeat, Perf or Syslog rows at all.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $command = 'sudo systemctl start azuremonitoragent; systemctl is-active azuremonitoragent'
    $line = "ssh $($Context.HostAlias) " + (Format-AlertArgument -Value $command)
    $run = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command $command -What 'Start the Azure Monitor Agent again'
    if (-not $run.Ran) {
        return
    }
    $last = Get-AlertLastLine -Lines $run.Lines
    if ($last -eq 'active') {
        Write-Host 'Put back: azuremonitoragent is active. Heartbeat, Perf and Syslog rows resume from here, and the alert resolves on its own.'
    }
    else {
        Add-AlertProblem -Context $Context -Message "azuremonitoragent did not come back: the last line reads '$last' (ssh exited $($run.ExitCode)). The lab host ships no Heartbeat, Perf or Syslog rows until it does, and alert-lab-heartbeat-prod-cus stays open." -Command $line
    }
}

function Invoke-AlertTestLabHeartbeat {
    <#
    .SYNOPSIS
        alert-lab-heartbeat (#981, LAB-2): stop the Azure Monitor Agent until
        the rule sees an empty 30-minute window, then start it again. Only
        azuremonitoragent is stopped: himdsd and the rest of the Arc agent
        keep running, so the machine stays Connected and Arc SSH keeps
        working, which is the path this script uses to put it back.

    .DESCRIPTION
        Three stop conditions, all reads: ssh reaches the host (anything else
        says nothing about the agent); no lab job container is running, since
        nothing the host logs in the next hour reaches Log Analytics; and the
        agent is active now, because a stopped agent means the alert is
        either already open or about to be, and the thing to do is find out
        why. The wait runs inside the try, as swa-bandwidth's does, so the
        agent is started again in the finally whether the alert came, the
        limit passed, a step failed, or Ctrl+C.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $jobs = @(Get-AlertRunningLabJobs -HostAlias $Context.HostAlias)
    if ($jobs.Count -gt 0) {
        throw (New-AlertStop -Message "Stop: $($jobs.Count) lab job container(s) running on the lab host ($($jobs -join ', ')). Nothing the host logs while the agent is stopped reaches Log Analytics, so run this when $($estate.LabsUrl) shows the agent idle; nothing was changed.")
    }
    Write-Host 'Stop condition: no lab job container is running on the lab host.'
    $state = Get-AlertMonitorAgentState -HostAlias $Context.HostAlias
    if ($state -ne 'active') {
        throw (New-AlertStop -Message "Stop: azuremonitoragent is '$state', not active, so the host is already shipping nothing and the alert is open or about to be. Do not run the test; find out why instead. Nothing was changed." -Command "ssh $($Context.HostAlias) 'systemctl status azuremonitoragent himdsd --no-pager'")
    }
    Write-Host 'Stop condition: azuremonitoragent is active.'
    Write-Host 'While it is stopped the host ships no Heartbeat, Perf or Syslog rows, so no lab-host rule can see anything from it; himdsd and Arc SSH are not touched.'

    $Context.StartUtc = Get-AlertUtcNow
    try {
        $stop = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command 'sudo systemctl stop azuremonitoragent' -What 'Stop the Azure Monitor Agent'
        if ($stop.Ran) {
            Assert-AlertSshReached -ExitCode $stop.ExitCode -HostAlias $Context.HostAlias
            if ($stop.ExitCode -ne 0) {
                throw "Stopping azuremonitoragent failed (exit $($stop.ExitCode)): $((@($stop.Lines) | Select-Object -Last 3) -join ' ')"
            }
            Write-Host "Stopped at $(Format-AlertTime -Utc $Context.StartUtc). The 30-minute window is empty from $(Format-AlertTime -Utc $Context.StartUtc.AddMinutes(30)); the next quarter-hour evaluation after that opens the alert. Ctrl+C starts the agent again."
        }
        Wait-AlertFired -Context $Context -Required @('alert-lab-heartbeat') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-heartbeat').TimeoutMinutes -Hints @{ 'alert-lab-heartbeat' = 'the rule counts Heartbeat rows in the last 30 minutes every 15 minutes, so the alert comes 30 to 45 minutes after the stop plus delivery; an agent that was restarted meanwhile, by anything, refills the window' }
    }
    finally {
        Restore-AlertMonitorAgent -Context $Context
    }
}

# --- swa-bandwidth --------------------------------------------------------------

function Get-AlertSwaRuleUrl {
    <#
    .SYNOPSIS
        The rule's ARM URL, as the runbook builds it.
    #>
    [OutputType([string])]
    param()

    $estate = Get-AlertEstate
    $rule = Invoke-AlertAzJson -Arguments @('monitor', 'metrics', 'alert', 'show', '-n', 'alert-swa-bandwidth-prod-cus', '-g', $estate.WebGroup, '-o', 'json') -What 'Reading alert-swa-bandwidth-prod-cus'
    $id = [string](Get-AlertProperty -Object $rule -Name 'id')
    if (-not $id) {
        throw 'az returned no id for alert-swa-bandwidth-prod-cus.'
    }
    return 'https://management.azure.com' + $id + '?api-version=2018-03-01'
}

function Get-AlertSwaThreshold {
    <#
    .SYNOPSIS
        The threshold in a metric alert's criteria: properties.criteria in an
        ARM answer, criteria at the top in az's.
    #>
    param([AllowNull()] $Rule)

    $criteria = Get-AlertProperty -Object $Rule -Name 'criteria'
    if ($null -eq $criteria) {
        $criteria = Get-AlertProperty -Object (Get-AlertProperty -Object $Rule -Name 'properties') -Name 'criteria'
    }
    $allOf = Get-AlertList -Object $criteria -Name 'allOf'
    if ($allOf.Count -eq 0) {
        return $null
    }
    return (Get-AlertProperty -Object $allOf[0] -Name 'threshold')
}

function Restore-AlertSwaRule {
    <#
    .SYNOPSIS
        Puts the saved rule definition back, reads the threshold, and removes
        the saved original (and the working copy) only once it matches.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $RecordPath,
        [Parameter(Mandatory)] [string] $Url,
        [Parameter(Mandatory)] [decimal] $Threshold,
        [AllowEmptyString()] [string] $WorkingCopy = ''
    )

    $estate = Get-AlertEstate
    $put = Invoke-AlertAzChange -Arguments @('rest', '--method', 'put', '--url', $Url, '--body', "@$RecordPath", '-o', 'none') -What 'Put the saved rule definition back' -NoThrow
    if ($put.Ran -and $put.ExitCode -ne 0) {
        Write-Host "  az answered: $(Get-AlertAzFailure -Result $put)"
    }
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would then read the rule's threshold and remove $RecordPath once it reads $Threshold."
        return
    }
    try {
        $rule = Invoke-AlertAzJson -Arguments @('monitor', 'metrics', 'alert', 'show', '-n', 'alert-swa-bandwidth-prod-cus', '-g', $estate.WebGroup, '-o', 'json') -What 'Reading alert-swa-bandwidth-prod-cus'
        $now = Get-AlertSwaThreshold -Rule $rule
    }
    catch {
        Add-AlertProblem -Context $Context -Message "Could not read the rule's threshold to confirm the restore: $($_.Exception.Message) $RecordPath is kept." -Command $Context.RecoverCommand
        return
    }
    if ($null -ne $now -and [decimal]$now -eq $Threshold) {
        Write-Host "Put back: the threshold reads $now."
        Remove-AlertFile -Path $RecordPath -What 'Remove the saved original' -IfPresent
        if ($WorkingCopy) {
            Remove-AlertFile -Path $WorkingCopy -What 'Remove the working copy' -IfPresent
        }
    }
    else {
        Add-AlertProblem -Context $Context -Message "The rule's threshold reads $now, not $Threshold. $RecordPath, the saved original, is kept." -Command $Context.RecoverCommand
    }
}

function Invoke-AlertTestSwaBandwidth {
    <#
    .SYNOPSIS
        alert-swa-bandwidth: lower the threshold to one byte until the alert
        fires and put the saved definition back.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $u = Get-AlertSwaRuleUrl
    $bf = Get-AlertRecordPath -Context $Context -Name 'plat4-swa-test.json'
    $f = Join-Path ([System.IO.Path]::GetTempPath()) ('plat4-swa-' + [guid]::NewGuid().ToString() + '.json')
    Assert-AlertNoRecord -Context $Context -Path $bf

    $get = Invoke-AlertAz -Arguments @('rest', '--method', 'get', '--url', $u, '-o', 'json')
    if ($get.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($get.Stdout)) {
        throw "Reading the rule's definition failed: az exited $($get.ExitCode). $(Get-AlertAzFailure -Result $get) Nothing was saved or changed."
    }
    $a = $get.Stdout | ConvertFrom-Json
    $original = Get-AlertSwaThreshold -Rule $a
    if ($null -eq $original -or [decimal]$original -ne [decimal]$estate.SwaThreshold) {
        throw (New-AlertStop -Message "Stop: the rule's threshold reads '$original', not $($estate.SwaThreshold), so it is not the definition Terraform keeps, and restoring it would put that value back. Find out why (an HCP Terraform plan shows the drift) first; nothing was saved or changed.")
    }
    Write-Host "Stop condition: the threshold reads $original, as Terraform sets it."

    $Context.StartUtc = Get-AlertUtcNow
    if ($PSCmdlet.ShouldProcess("Save the rule's definition, exactly as ARM returns it, to $bf", 'Save the original?', 'Invoke-AlertFireTest')) {
        $get.Stdout | Set-Content -LiteralPath $bf
        Write-Host "Record: saved the original to $bf."
    }
    try {
        $a.properties.criteria.allOf[0].threshold = 1
        if ($PSCmdlet.ShouldProcess("Write the working copy with a threshold of 1 to $f", 'Write the working copy?', 'Invoke-AlertFireTest')) {
            [System.IO.File]::WriteAllText($f, ($a | ConvertTo-Json -Depth 20))
        }
        $null = Invoke-AlertAzChange -Arguments @('rest', '--method', 'put', '--url', $u, '--body', "@$f", '-o', 'none') -What 'Lower the threshold to one byte'
        Wait-AlertFired -Context $Context -Required @('alert-swa-bandwidth') -TimeoutMinutes (Get-AlertTestDefinition -Test 'swa-bandwidth').TimeoutMinutes -Hints @{ 'alert-swa-bandwidth' = 'the rule needs the site to have served something in the last day' }
    }
    finally {
        Restore-AlertSwaRule -Context $Context -RecordPath $bf -Url $u -Threshold ([decimal]$original) -WorkingCopy $f
    }
}

function Invoke-AlertRecoverSwaBandwidth {
    <#
    .SYNOPSIS
        The runbook's recovery: put the saved original back, read the
        threshold, and remove the saved original once it matches.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $bf = Get-AlertRecordPath -Context $Context -Name 'plat4-swa-test.json'
    if (-not (Test-Path -LiteralPath $bf)) {
        Write-Host "Nothing to recover: there is no $bf."
        return
    }
    $saved = Get-AlertSwaThreshold -Rule (Read-AlertRecord -Path $bf)
    if ($null -eq $saved) {
        throw (New-AlertStop -Message "Stop: $bf does not hold a metric alert definition with a threshold. Read it and recover by hand; nothing was changed.")
    }
    $u = Get-AlertSwaRuleUrl
    Restore-AlertSwaRule -Context $Context -RecordPath $bf -Url $u -Threshold ([decimal]$saved)
}

# --- lab-disk -----------------------------------------------------------------

function Get-AlertDiskFilePath {
    <#
    .SYNOPSIS
        The one file the lab-disk test allocates on the host. /var/tmp, not
        /tmp: /tmp may be a tmpfs or cleared at boot, and the file must sit
        on the root filesystem the rule reads.
    #>
    [OutputType([string])]
    param()

    return '/var/tmp/hcw-fire-test-disk.img'
}

function Format-AlertGiB {
    <#
    .SYNOPSIS
        A byte count as GiB with one decimal, for the messages.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)] [long] $Bytes)

    return [string]::Format([cultureinfo]::InvariantCulture, '{0:N1} GiB', ($Bytes / 1073741824.0))
}

function ConvertFrom-AlertDfLine {
    <#
    .SYNOPSIS
        The size, used and available bytes from the output of
        `df -B1 --output=size,used,avail /`: the one line holding three
        numbers and nothing else, or $null when there is none.
    #>
    [OutputType([pscustomobject])]
    param([AllowEmptyCollection()] [AllowNull()] [string[]] $Lines)

    foreach ($line in @($Lines)) {
        if ($line -match '\A\s*(\d+)\s+(\d+)\s+(\d+)\s*\z') {
            return [pscustomobject]@{ Size = [long]$Matches[1]; Used = [long]$Matches[2]; Avail = [long]$Matches[3] }
        }
    }
    return $null
}

function Get-AlertDiskState {
    <#
    .SYNOPSIS
        df for the root filesystem on the host, in bytes, and whether the
        test's file is already there: the stop-condition read. A read, so it
        runs under -WhatIf too.
    #>
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [string] $HostAlias)

    $file = Get-AlertDiskFilePath
    $run = Invoke-AlertSsh -HostAlias $HostAlias -Command "df -B1 --output=size,used,avail /; test -e $file && echo present || echo absent"
    Assert-AlertSshReached -ExitCode $run.ExitCode -HostAlias $HostAlias
    $df = ConvertFrom-AlertDfLine -Lines $run.Lines
    if ($null -eq $df) {
        throw "df on $HostAlias printed no size, used and avail row (exit $($run.ExitCode)): $((@($run.Lines) | Select-Object -Last 3) -join ' ')"
    }
    return [pscustomobject]@{ Size = $df.Size; Used = $df.Used; Avail = $df.Avail; FilePresent = (@($run.Lines | ForEach-Object { [string]$_ }) -contains 'present') }
}

function Get-AlertDiskPlan {
    <#
    .SYNOPSIS
        What one df row means for the test: usage now as the rule measures
        it, the bytes that take it to 87%, what would be free after, and the
        reason to stop when there is one. Pure, so the tests can feed it rows.

    .DESCRIPTION
        Usage is used / (used + available), df's own Use%, which is what the
        Azure Monitor Agent reports as "% Used Space": the root's reserved
        blocks are outside both. The allocation is rounded down to a MiB. The
        stops: usage already past 80%; 87% leaving less than 10 GiB free; or
        the usage it would land at above 90%, which the first two make
        unreachable from a consistent df row and is kept as the guard it is.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [long] $Size,
        [Parameter(Mandatory)] [long] $Used,
        [Parameter(Mandatory)] [long] $Avail
    )

    $mib = [long]1048576
    $gib = [long]1073741824
    $total = $Used + $Avail
    if ($Size -le 0 -or $total -le 0) {
        throw "df printed a size of $Size and used plus available of $total, which cannot be the root filesystem."
    }
    $usedPct = [double]$Used * 100 / $total
    $target = [long][math]::Floor(87.0 * $total / 100)
    $add = [long][math]::Floor(($target - $Used) / [double]$mib) * $mib
    $freeAfter = $Avail - $add
    $afterPct = [double]($Used + $add) * 100 / $total
    $stop = ''
    if ($usedPct -gt 80) {
        $stop = "the root filesystem is already $([math]::Round($usedPct, 1))% used ($(Format-AlertGiB -Bytes $Used) of $(Format-AlertGiB -Bytes $total)), past the 80% this test starts from; the rule's own threshold is 85%, so look at what is filling it instead"
    }
    elseif ($freeAfter -lt 10 * $gib -or $add -le 0) {
        $stop = "taking the root filesystem to 87% would leave $(Format-AlertGiB -Bytes $freeAfter) free, less than the 10 GiB this test keeps for the host"
    }
    elseif ($afterPct -gt 90) {
        $stop = "the allocation would land the root filesystem at $([math]::Round($afterPct, 1))% used, above the 90% this test allows"
    }
    return [pscustomobject]@{ UsedPct = $usedPct; AddBytes = $add; FreeAfter = $freeAfter; AfterPct = $afterPct; Total = $total; Stop = $stop }
}

function Get-AlertDiskStageCommand {
    <#
    .SYNOPSIS
        The one bash line that allocates the file on the host. It reads df
        again at that moment and computes the same plan the stop condition
        did (87% of used plus available, rounded down to a MiB), refuses with
        exit 4 if the numbers have moved past the same limits, and prints df
        after, so the landing is read from the host rather than assumed.
    #>
    [OutputType([string])]
    param()

    $file = Get-AlertDiskFilePath
    return 'set -e; set -- $(df -B1 --output=size,used,avail / | tail -n 1); used=$2; avail=$3; total=$((used+avail)); add=$(( (87*total/100 - used) / 1048576 * 1048576 )); if [ $((used*100/total)) -gt 80 ] || [ $add -le 0 ] || [ $((avail-add)) -lt 10737418240 ]; then echo "refused: df moved past a stop condition (used=$used avail=$avail add=$add)"; exit 4; fi; sudo fallocate -l $add ' + $file + '; echo "allocated $add bytes"; df -B1 --output=size,used,avail /'
}

function Restore-AlertDiskFile {
    <#
    .SYNOPSIS
        Removes the test's file, reads whether it is gone and df after, and
        names the exact line to run by hand when the remove did not confirm.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $file = Get-AlertDiskFilePath
    $command = "sudo rm -f $file; test -e $file && echo present || echo absent; df -B1 --output=size,used,avail /"
    $line = "ssh $($Context.HostAlias) 'sudo rm -f $file'"
    $run = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command $command -What 'Remove the test file from the lab host'
    if (-not $run.Ran) {
        return
    }
    $lines = @($run.Lines | ForEach-Object { [string]$_ })
    if ($run.ExitCode -eq 255 -or -not ($lines -contains 'absent')) {
        Add-AlertProblem -Context $Context -Message "$file may still be on the lab host: the remove did not confirm it gone (ssh exited $($run.ExitCode); last line '$(Get-AlertLastLine -Lines $run.Lines)'). The root filesystem stays filled until it is removed." -Command $line
        return
    }
    $df = ConvertFrom-AlertDfLine -Lines $run.Lines
    if ($null -ne $df) {
        $pct = [math]::Round([double]$df.Used * 100 / ($df.Used + $df.Avail), 1)
        Write-Host "Put back: no $file on the lab host; the root filesystem reads $pct% used, $(Format-AlertGiB -Bytes $df.Avail) free."
    }
    else {
        Write-Host "Put back: no $file on the lab host."
    }
}

function Invoke-AlertTestLabDisk {
    <#
    .SYNOPSIS
        alert-lab-disk (#981, LAB-2): allocate one file on the lab host's
        root filesystem so that it reads 87% used, past the rule's 85%, hold
        it until the alert fires, and remove it.

    .DESCRIPTION
        The stop conditions are reads: the file is not already there (an
        earlier run did not finish; its recovery removes it), and
        Get-AlertDiskPlan finds nothing to refuse in df. The host recomputes
        the size from df at the moment it allocates and refuses if the
        numbers have moved; the landing is read from df after, and above 90%
        the file is removed and the run stops. The wait runs inside the try,
        as swa-bandwidth's does, so the file is removed in the finally
        whether the alert came, the limit passed, a step failed, or Ctrl+C.
        The lab DCR (infra/lab-hybrid.tf, performance_counter) samples
        "% Used Space" every 60 seconds, so the sample lands within a minute;
        the rule evaluates hourly over the hour's maximum, which is the wait.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $file = Get-AlertDiskFilePath
    $disk = Get-AlertDiskState -HostAlias $Context.HostAlias
    if ($disk.FilePresent) {
        throw (New-AlertStop -Message "Stop: $file is already on the lab host, so an earlier run did not finish. Do its recovery first; this run changed nothing." -Command $Context.RecoverCommand)
    }
    Write-Host "Stop condition: no $file on the lab host."
    $plan = Get-AlertDiskPlan -Size $disk.Size -Used $disk.Used -Avail $disk.Avail
    if ($plan.Stop) {
        throw (New-AlertStop -Message "Stop: $($plan.Stop). Nothing was changed." -Command "ssh $($Context.HostAlias) 'df -h /; sudo docker system df; sudo ls -l /var/backups/coder'")
    }
    Write-Host "Stop condition: the root filesystem reads $([math]::Round($plan.UsedPct, 1))% used ($(Format-AlertGiB -Bytes $disk.Used) of $(Format-AlertGiB -Bytes $plan.Total)); 87% is $(Format-AlertGiB -Bytes $plan.AddBytes) more, leaving $(Format-AlertGiB -Bytes $plan.FreeAfter) free. The host recomputes this from df as it allocates, rounded down to a MiB, and refuses if the numbers have moved past these limits."

    $Context.StartUtc = Get-AlertUtcNow
    try {
        $stage = Invoke-AlertSshChange -HostAlias $Context.HostAlias -Command (Get-AlertDiskStageCommand) -What 'Allocate the test file so that the root filesystem reads 87% used'
        if ($stage.Ran) {
            Assert-AlertSshReached -ExitCode $stage.ExitCode -HostAlias $Context.HostAlias
            if ($stage.ExitCode -eq 4) {
                throw "The lab host refused to allocate: $(Get-AlertLastLine -Lines $stage.Lines). df moved between the read and the write; nothing was allocated."
            }
            if ($stage.ExitCode -ne 0) {
                throw "Allocating $file on $($Context.HostAlias) failed (exit $($stage.ExitCode)): $((@($stage.Lines) | Select-Object -Last 3) -join ' ')"
            }
            $landed = ConvertFrom-AlertDfLine -Lines $stage.Lines
            if ($null -eq $landed) {
                throw "The lab host allocated the file but printed no df row after it, so the landing cannot be read; the file is removed."
            }
            $landedPct = [double]$landed.Used * 100 / ($landed.Used + $landed.Avail)
            if ($landedPct -gt 90) {
                throw "The root filesystem reads $([math]::Round($landedPct, 1))% used after the allocation, above the 90% this test allows; the file is removed."
            }
            Write-Host "Allocated: the root filesystem reads $([math]::Round($landedPct, 1))% used, $(Format-AlertGiB -Bytes $landed.Avail) free. The lab DCR samples it within a minute; the rule's next hourly evaluation opens the alert. Ctrl+C removes the file."
        }
        Wait-AlertFired -Context $Context -Required @('alert-lab-disk') -TimeoutMinutes (Get-AlertTestDefinition -Test 'lab-disk').TimeoutMinutes -Hints @{ 'alert-lab-disk' = 'the rule evaluates hourly over the last hour''s maximum % Used Space, which the lab DCR samples every 60 seconds, so the alert comes at the first evaluation after the sample lands' }
    }
    finally {
        Restore-AlertDiskFile -Context $Context
    }
}

# --- timer-overdue ------------------------------------------------------------

function Restore-AlertTimerSetting {
    <#
    .SYNOPSIS
        Puts the timer setting back from the record (its prior value, or no
        setting at all), reads it to confirm, removes the record only then,
        and checks the strip's two reads.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [string] $RecordPath,
        [Parameter(Mandatory)] [bool] $Present,
        [AllowNull()] [AllowEmptyString()] [string] $Value
    )

    $estate = Get-AlertEstate
    $setting = 'AzureWebJobs.healthPulse.Disabled'
    if ($Present) {
        $run = Invoke-AlertAzChange -Arguments @('functionapp', 'config', 'appsettings', 'set', '-n', $estate.FunctionApp, '-g', $estate.WebGroup, '--settings', ($setting + '=' + $Value), '-o', 'none') -What 'Put the timer setting back to its recorded value' -NoThrow
    }
    else {
        $run = Invoke-AlertAzChange -Arguments @('functionapp', 'config', 'appsettings', 'delete', '-n', $estate.FunctionApp, '-g', $estate.WebGroup, '--setting-names', $setting, '-o', 'none') -What 'Delete the timer setting, which was not there before the test' -NoThrow
    }
    if ($run.Ran -and $run.ExitCode -ne 0) {
        Write-Host "  az answered: $(Get-AlertAzFailure -Result $run)"
    }
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would then read $setting, remove $RecordPath once it matches the record, and check the strip's two reads."
        return
    }
    try {
        $settings = @(Get-AlertAppSettings)
    }
    catch {
        Add-AlertProblem -Context $Context -Message "Could not read the app settings to confirm the restore: $($_.Exception.Message) $RecordPath is kept." -Command $Context.RecoverCommand
        return
    }
    $rows = @(Select-AlertSetting -Settings $settings -Name $setting)
    $matched = if ($Present) { $rows.Count -eq 1 -and [string](Get-AlertProperty -Object $rows[0] -Name 'value') -ceq [string]$Value } else { $rows.Count -eq 0 }
    if ($matched) {
        $as = if ($Present) { "reads '$Value' again" } else { 'is gone again' }
        Write-Host "Put back: $setting $as, as recorded."
        Remove-AlertFile -Path $RecordPath -What 'Remove the record' -IfPresent
    }
    else {
        $now = if ($rows.Count -eq 0) { 'no row' } else { "'" + (@($rows | ForEach-Object { [string](Get-AlertProperty -Object $_ -Name 'value') }) -join "', '") + "'" }
        $wanted = if ($Present) { "'$Value'" } else { 'no row' }
        Add-AlertProblem -Context $Context -Message "$setting reads $now, and the record says $wanted. $RecordPath is kept." -Command $Context.RecoverCommand
    }

    $writer = @(Select-AlertSetting -Settings $settings -Name 'RUNTIME_CONFIG_WRITER')
    $storage = @(Select-AlertSetting -Settings $settings -Name 'AzureWebJobsStorage').Count
    $writerValue = if ($writer.Count -eq 1) { [string](Get-AlertProperty -Object $writer[0] -Name 'value') } else { "$($writer.Count) rows" }
    if ($writer.Count -eq 1 -and $writerValue -eq 'azapi-strip' -and $storage -eq 0) {
        Write-Host 'Strip: intact (RUNTIME_CONFIG_WRITER reads azapi-strip, and no AzureWebJobsStorage row).'
    }
    else {
        Add-AlertProblem -Context $Context -Message "The strip's reads are not healthy: RUNTIME_CONFIG_WRITER is $writerValue (azapi-strip expected) and the AzureWebJobsStorage count is $storage (0 expected). docs/runbooks/alerting-and-support.md, ""The failure with no alert"": the repair is to re-apply infra/ so the strip runs again. Do not delete the setting by hand."
    }
}

function Invoke-AlertTestTimerOverdue {
    <#
    .SYNOPSIS
        alert-timer-overdue: disable the harmless healthPulse timer until the
        alert names it, then put the setting back exactly as recorded.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $estate = Get-AlertEstate
    $setting = 'AzureWebJobs.healthPulse.Disabled'
    $hf = Get-AlertRecordPath -Context $Context -Name 'plat4-timer-test.json'
    Assert-AlertNoRecord -Context $Context -Path $hf
    $rows = @(Select-AlertSetting -Settings (Get-AlertAppSettings) -Name $setting)
    $prior = if ($rows.Count -gt 0) { $rows[0] } else { $null }
    $priorValue = [string](Get-AlertProperty -Object $prior -Name 'value')
    if ($null -ne $prior -and $priorValue -eq 'true') {
        throw (New-AlertStop -Message "Stop: $setting is already true, so the timer is already off and the test would change nothing.")
    }
    $present = $null -ne $prior
    $shown = if ($present) { "'$priorValue'" } else { 'not set' }
    Write-Host "Stop condition: $setting is $shown, not true."

    $Context.StartUtc = Get-AlertUtcNow
    Write-AlertRecord -Context $Context -Path $hf -Record @{ present = $present; value = $(if ($present) { $priorValue } else { $null }) }
    try {
        $null = Invoke-AlertAzChange -Arguments @('functionapp', 'config', 'appsettings', 'set', '-n', $estate.FunctionApp, '-g', $estate.WebGroup, '--settings', "$setting=true", '-o', 'none') -What 'Disable the healthPulse timer (restarts the app once)'
        Wait-AlertFired -Context $Context -Required @('alert-timer-overdue') -TimeoutMinutes (Get-AlertTestDefinition -Test 'timer-overdue').TimeoutMinutes -ContextMatch @{ 'alert-timer-overdue' = 'healthPulse' } -Hints @{ 'alert-timer-overdue' = 'only an alert whose timer dimension is healthPulse counts' }
    }
    finally {
        Restore-AlertTimerSetting -Context $Context -RecordPath $hf -Present $present -Value $(if ($present) { $priorValue } else { $null })
    }
}

function Invoke-AlertRecoverTimerOverdue {
    <#
    .SYNOPSIS
        The runbook's recovery: restore from the record, confirm with the
        read, and only then remove the record.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [pscustomobject] $Context)

    $hf = Get-AlertRecordPath -Context $Context -Name 'plat4-timer-test.json'
    if (-not (Test-Path -LiteralPath $hf)) {
        Write-Host "Nothing to recover: there is no $hf."
        return
    }
    $h = Read-AlertRecord -Path $hf
    $present = Get-AlertProperty -Object $h -Name 'present'
    if ($present -isnot [bool]) {
        throw (New-AlertStop -Message "Stop: $hf does not hold the present and value this test writes. Read it and recover by hand; nothing was changed.")
    }
    $value = Get-AlertProperty -Object $h -Name 'value'
    Restore-AlertTimerSetting -Context $Context -RecordPath $hf -Present $present -Value $(if ($null -eq $value) { $null } else { [string]$value })
}

# --- Dispatch and summary -------------------------------------------------------

function Invoke-AlertTestRun {
    <#
    .SYNOPSIS
        Runs the named test, or its recovery.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [switch] $Recover
    )

    if ($Recover) {
        switch ($Context.Test) {
            'kv-config-write' { Invoke-AlertRecoverKvConfigWrite -Context $Context }
            'rbac-assignment' { Invoke-AlertRecoverRbacAssignment -Context $Context }
            'rbac-definition' { Invoke-AlertRecoverRbacDefinition -Context $Context }
            'jobs-poison' { Invoke-AlertRecoverJobsPoison -Context $Context }
            'lab-agent-offline' { Restore-AlertLabAgent -Context $Context }
            'lab-heartbeat' { Restore-AlertMonitorAgent -Context $Context }
            'swa-bandwidth' { Invoke-AlertRecoverSwaBandwidth -Context $Context }
            'lab-disk' { Restore-AlertDiskFile -Context $Context }
            'timer-overdue' { Invoke-AlertRecoverTimerOverdue -Context $Context }
            default { Write-Host "Nothing to recover: $($Context.Test) changes nothing, so the runbook gives it no recovery." }
        }
        return
    }
    switch ($Context.Test) {
        'kv-config-write' { Invoke-AlertTestKvConfigWrite -Context $Context }
        'rbac-assignment' { Invoke-AlertTestRbacAssignment -Context $Context }
        'rbac-definition' { Invoke-AlertTestRbacDefinition -Context $Context }
        'lab-unit-failed' { Invoke-AlertTestLabUnitFailed -Context $Context }
        'kv-errors-and-data-write' { Invoke-AlertTestKvErrorsAndDataWrite -Context $Context }
        'lab-vault-unwrap' { Invoke-AlertTestLabVaultUnwrap -Context $Context }
        'lab-ssh-burst' { Invoke-AlertTestLabSshBurst -Context $Context }
        'lab-ssh-login' { Invoke-AlertTestLabSshLogin -Context $Context }
        'jobs-poison' { Invoke-AlertTestJobsPoison -Context $Context }
        'lab-agent-offline' { Invoke-AlertTestLabAgentOffline -Context $Context }
        'lab-heartbeat' { Invoke-AlertTestLabHeartbeat -Context $Context }
        'swa-bandwidth' { Invoke-AlertTestSwaBandwidth -Context $Context }
        'lab-disk' { Invoke-AlertTestLabDisk -Context $Context }
        'timer-overdue' { Invoke-AlertTestTimerOverdue -Context $Context }
        default { throw "No fire test is named '$($Context.Test)'." }
    }
}

function Get-AlertExitCode {
    <#
    .SYNOPSIS
        The run's exit code: 3 when something was not put back, else the
        stop's 1, else 2 when a required rule did not fire, else 0.
    #>
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [int] $StopCode = 0
    )

    if ($Context.Problems.Count -gt 0) {
        return 3
    }
    if ($StopCode -ne 0) {
        return $StopCode
    }
    if (@($Context.Results | Where-Object { $_.Required -and $_.Status -eq 'FAIL' }).Count -gt 0) {
        return 2
    }
    return 0
}

function Write-AlertSummary {
    <#
    .SYNOPSIS
        The results again, the Fire record rows to paste, and anything left
        for the owner.
    #>
    param(
        [Parameter(Mandatory)] [pscustomobject] $Context,
        [Parameter(Mandatory)] [pscustomobject] $Definition,
        [switch] $Recover
    )

    if ($Context.Results.Count -gt 0) {
        Write-Host ''
        Write-Host 'Results:'
        foreach ($result in $Context.Results) {
            Write-Host "  $($result.Line)"
        }
        $rows = @($Context.Results | Where-Object { $_.Row } | ForEach-Object { $_.Row })
        if ($rows.Count -gt 0) {
            Write-Host ''
            Write-Host 'Fire record rows for docs/runbooks/alerting-and-support.md, "Fire record" (each replaces its rule''s row):'
            Write-Host ''
            foreach ($row in $rows) {
                Write-Host $row
            }
        }
    }
    if ($Context.Problems.Count -gt 0) {
        Write-Host ''
        Write-Host 'Not put back. Each record named above is kept; do these before any other fire test:'
        foreach ($problem in $Context.Problems) {
            Write-Host "  $problem"
        }
    }
    if (-not $Recover -and -not $WhatIfPreference -and $null -ne $Context.StartUtc) {
        Write-Host ''
        Write-Host "Success looks like: $($Definition.Success) Here, that is a PASS line for each rule, no NOT PUT BACK line, and exit code 0."
    }
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

$estate = Get-AlertEstate
$definition = Get-AlertTestDefinition -Test $Test
$tools = if ($Recover) { $definition.RecoverTools } else { $definition.Tools }
foreach ($tool in $tools) {
    if (-not (Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue)) {
        $hint = switch ($tool) {
            'az' { ' Install the Azure CLI: winget install --exact --id Microsoft.AzureCLI' }
            'gh' { ' Install the GitHub CLI: winget install --exact --id GitHub.cli' }
            default { ' Install the OpenSSH client from PowerShell opened with Run as administrator: Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0' }
        }
        throw "$tool is not on PATH.$hint"
    }
}

$recoverCommand = Get-AlertRecoverCommand -ScriptPath $PSCommandPath -Test $Test -RecordDirectory $RecordDirectory -DefaultDirectory $HOME
$context = New-AlertContext -Test $Test -RecordDirectory $RecordDirectory -HostAlias $HostAlias -TimeoutMinutes $TimeoutMinutes -RecoverCommand $recoverCommand
$stopCode = 0
try {
    $signedInAs = Assert-AlertSignedIn -Estate $estate
    Write-Host "az: signed in as $signedInAs, on $($estate.AppSubscription)."
    $verb = if ($Recover) { 'Recovery for the fire test' } else { 'Fire test' }
    Write-Host "$verb $Test (docs/runbooks/alerting-and-support.md, ""Making each one fire once"")."
    if (-not $Recover) {
        Write-Host $definition.Summary
        $catalog = Get-AlertRuleCatalog
        $resolved = [ordered]@{}
        foreach ($short in @($definition.Required) + @($definition.Optional)) {
            $resolved[$short] = Resolve-AlertRule -Entry $catalog[$short]
        }
        $context.Rules = $resolved
        Write-Host "Rules: $(@($resolved.Values | ForEach-Object { $_.Name }) -join ', '), all found."
    }
    Write-Host ''
    Invoke-AlertTestRun -Context $context -Recover:$Recover
}
catch {
    $stopCode = 1
    $exception = $_.Exception
    Write-Host ''
    Write-Host $exception.Message
    if ($exception.Data.Contains('AlertStop') -and $exception.Data.Contains('AlertCommand')) {
        Write-Host 'Run this in PowerShell, then run this script again:'
        Write-Host ''
        Write-Host "  $($exception.Data['AlertCommand'])"
    }
}
Write-AlertSummary -Context $context -Definition $definition -Recover:$Recover
if ($WhatIfPreference -and $stopCode -eq 0 -and $context.Problems.Count -eq 0) {
    Write-Host ''
    Write-Host 'WhatIf: nothing was changed.'
}
exit (Get-AlertExitCode -Context $context -StopCode $stopCode)

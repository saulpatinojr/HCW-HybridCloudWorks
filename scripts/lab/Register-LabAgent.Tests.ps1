<#
    Pester 5 tests for Register-LabAgent.ps1.

    The functions are loaded from the script's syntax tree rather than by
    running or dot-sourcing it, so nothing in the script's main body runs: no
    az call, no ssh, nothing on a host. The Entra steps are tested against a
    mocked Invoke-LabAz, the seam every az call goes through, and the host
    scripts are tested as text. On Linux, when bash and a python3 with PyYAML
    are there (CI), the vault merge also runs for real under bash, against a
    stand-in ansible-vault in Pester's $TestDrive.

    From the repository root:
        pwsh -NoProfile -Command "Invoke-Pester scripts/lab -Output Detailed"
#>

BeforeDiscovery {
    $canRunHostScript = $false
    if ($IsLinux -and (Get-Command bash -CommandType Application -ErrorAction SilentlyContinue) -and (Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue)) {
        & python3 -c 'import yaml' 2> $null
        $canRunHostScript = ($LASTEXITCODE -eq 0)
    }
}

BeforeAll {
    $scriptPath = Join-Path $PSScriptRoot 'Register-LabAgent.ps1'
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $null, [ref] $parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw "Register-LabAgent.ps1 does not parse: $($parseErrors[0].Message)"
    }
    $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }

    function New-TestCertificate {
        param([string] $CommonName = 'vps-hostinger-01')

        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        try {
            $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
                "CN=$CommonName", $rsa,
                [System.Security.Cryptography.HashAlgorithmName]::SHA256,
                [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
            $notBefore = [datetimeoffset]::new(2026, 9, 26, 12, 0, 0, [timespan]::Zero)
            $certificate = $request.CreateSelfSigned($notBefore, $notBefore.AddDays(730))
            try {
                $body = [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks) -replace "`r`n", "`n"
                return [pscustomobject]@{
                    Pem         = "-----BEGIN CERTIFICATE-----`n$body`n-----END CERTIFICATE-----"
                    Thumbprint  = $certificate.Thumbprint.ToUpperInvariant()
                    NotAfterUtc = $certificate.NotAfter.ToUniversalTime()
                }
            }
            finally {
                $certificate.Dispose()
            }
        }
        finally {
            $rsa.Dispose()
        }
    }

    $fixture = New-TestCertificate
    $other = New-TestCertificate
    $apiAppId = 'cccccccc-0000-4000-8000-000000000a91'
    $agentAppId = 'bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9'
    $agentSpId = '99999999-5b4a-4938-8271-605f4e3d2c1b'
    $apiSpId = '22222222-90ab-4cde-8f01-23456789abcd'
    $labAgentRoleId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
}

Describe 'Test-LabGuid, Test-LabApiBase and Test-LabAgentId' {
    It 'accepts a GUID and refuses <Label>' -ForEach @(
        @{ Label = 'an empty string'; Value = '' },
        @{ Label = 'a GUID with a trailing newline'; Value = "cccccccc-0000-4000-8000-000000000a91`n" },
        @{ Label = 'a GUID in braces'; Value = '{cccccccc-0000-4000-8000-000000000a91}' },
        @{ Label = 'a quote'; Value = "cccccccc-0000-4000-8000-000000000a91'" }
    ) {
        Test-LabGuid -Value 'cccccccc-0000-4000-8000-000000000a91' | Should -BeTrue
        Test-LabGuid -Value $Value | Should -BeFalse
    }

    It 'accepts the Cloudflare API base and refuses <Label>' -ForEach @(
        @{ Label = 'plain http'; Value = 'http://api-azure.hybridcloudworks.com/api' },
        @{ Label = 'a trailing slash'; Value = 'https://api-azure.hybridcloudworks.com/api/' },
        @{ Label = 'no /api'; Value = 'https://api-azure.hybridcloudworks.com' },
        @{ Label = 'a quote'; Value = "https://api-azure.hybridcloudworks.com/api';reboot;'" },
        @{ Label = 'a newline'; Value = "https://api-azure.hybridcloudworks.com/api`n" }
    ) {
        Test-LabApiBase -Value 'https://api-azure.hybridcloudworks.com/api' | Should -BeTrue
        Test-LabApiBase -Value $Value | Should -BeFalse
    }

    It 'accepts vps-hostinger-01 as an agent id and refuses <Label>' -ForEach @(
        @{ Label = 'upper case'; Value = 'VPS-hostinger-01' },
        @{ Label = 'a space'; Value = 'vps hostinger' },
        @{ Label = 'a leading hyphen'; Value = '-vps' },
        @{ Label = 'a slash'; Value = 'vps/01' }
    ) {
        Test-LabAgentId -Value 'vps-hostinger-01' | Should -BeTrue
        Test-LabAgentId -Value $Value | Should -BeFalse
    }
}

Describe 'Get-LabApiScope and Get-LabTenantIdFromIssuer' {
    It 'names the API by its api:// identifier with .default' {
        Get-LabApiScope -ApiAppId 'CCCCCCCC-0000-4000-8000-000000000A91' | Should -BeExactly 'api://cccccccc-0000-4000-8000-000000000a91/.default'
    }

    It 'reads the tenant id out of a v2 issuer' {
        Get-LabTenantIdFromIssuer -Issuer 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0' | Should -BeExactly '11111111-2222-3333-4444-555555555555'
    }

    It 'returns nothing for an issuer of another shape' {
        Get-LabTenantIdFromIssuer -Issuer 'https://sts.windows.net/11111111-2222-3333-4444-555555555555/' | Should -BeNullOrEmpty
    }
}

Describe 'Get-LabJobTypes' {
    It 'lists the five job types, once each' {
        $types = Get-LabJobTypes
        $types.Count | Should -Be 5
        @($types | Select-Object -Unique).Count | Should -Be 5
        $types | Should -Contain 'shell-echo'
    }
}

Describe 'ConvertFrom-LabCertificateOutput' {
    It 'returns the one certificate and the key check' {
        $lines = @($fixture.Pem -split "`n") + @('HCW KEY-MATCH yes')
        $result = ConvertFrom-LabCertificateOutput -Lines $lines
        $result.Pem | Should -BeExactly $fixture.Pem
        $result.KeyMatches | Should -Be 'yes'
        $result.NextThumbprint | Should -BeNullOrEmpty
    }

    It 'reads the fingerprint of a pending next certificate, as OpenSSL 3 prints it' {
        $lines = @($fixture.Pem -split "`n") + @('HCW KEY-MATCH yes', 'HCW NEXT-FINGERPRINT sha1 Fingerprint=42:24:4C:5D:36:47:04:57:21:61:FF:1C:47:2E:1B:98:FE:D5:E9:4A')
        (ConvertFrom-LabCertificateOutput -Lines $lines).NextThumbprint | Should -BeExactly '42244C5D364704572161FF1C472E1B98FED5E94A'
    }

    It 'refuses private key material, and does not repeat it' {
        $secret = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'
        $lines = @('-----BEGIN PRIVATE KEY-----', $secret, '-----END PRIVATE KEY-----') + @($fixture.Pem -split "`n")
        $message = $null
        try {
            $null = ConvertFrom-LabCertificateOutput -Lines $lines
        }
        catch {
            $message = $_.Exception.Message
        }
        $message | Should -BeLike '*private key material*'
        $message | Should -Not -BeLike "*$secret*"
    }

    It 'refuses <Label>' -ForEach @(
        @{ Label = 'no certificate'; Count = 0 },
        @{ Label = 'two certificates'; Count = 2 }
    ) {
        $lines = @()
        for ($i = 0; $i -lt $Count; $i++) {
            $lines += @($fixture.Pem -split "`n")
        }
        { ConvertFrom-LabCertificateOutput -Lines $lines } | Should -Throw "*found $Count*"
    }

    It 'reports a key that does not match' {
        $lines = @($fixture.Pem -split "`n") + @('HCW KEY-MATCH no')
        (ConvertFrom-LabCertificateOutput -Lines $lines).KeyMatches | Should -Be 'no'
    }
}

Describe 'Get-LabCertificateInfo' {
    It 'reads the thumbprint, the expiry in UTC and the common name' {
        $info = Get-LabCertificateInfo -Pem $fixture.Pem
        $info.Thumbprint | Should -BeExactly $fixture.Thumbprint
        $info.NotAfterUtc | Should -Be $fixture.NotAfterUtc
        $info.NotAfterUtc.Kind | Should -Be ([System.DateTimeKind]::Utc)
        $info.CommonName | Should -BeExactly 'vps-hostinger-01'
    }

    It 'refuses text that is not a certificate' {
        { Get-LabCertificateInfo -Pem 'not a certificate' } | Should -Throw '*not a PEM certificate*'
    }
}

Describe 'ConvertTo-LabThumbprint and Test-LabKeyCredentialPresent' {
    It 'reads the thumbprint as <Label>' -ForEach @(
        @{ Label = 'upper-case hex'; Form = 'hex' },
        @{ Label = 'lower-case hex'; Form = 'lower' },
        @{ Label = 'the base64 of its bytes'; Form = 'bytes' },
        @{ Label = 'the base64 of its hex text'; Form = 'text' }
    ) {
        $thumbprint = $fixture.Thumbprint
        $value = switch ($Form) {
            'hex' { $thumbprint }
            'lower' { $thumbprint.ToLowerInvariant() }
            'bytes' { [Convert]::ToBase64String([Convert]::FromHexString($thumbprint)) }
            'text' { [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($thumbprint)) }
        }
        ConvertTo-LabThumbprint -CustomKeyIdentifier $value | Should -BeExactly $thumbprint
    }

    It 'returns nothing for <Label>' -ForEach @(
        @{ Label = 'an empty identifier'; Value = '' },
        @{ Label = 'text that is not base64'; Value = 'not base64!' },
        @{ Label = 'base64 of something else'; Value = 'aGVsbG8=' }
    ) {
        ConvertTo-LabThumbprint -CustomKeyIdentifier $Value | Should -BeNullOrEmpty
    }

    It 'finds the certificate among the registration''s keys' {
        $keys = @(
            [pscustomobject]@{ keyId = 'k1'; customKeyIdentifier = [Convert]::ToBase64String([Convert]::FromHexString($other.Thumbprint)) },
            [pscustomobject]@{ keyId = 'k2'; customKeyIdentifier = $fixture.Thumbprint }
        )
        Test-LabKeyCredentialPresent -RegisteredKeys $keys -Thumbprint $fixture.Thumbprint | Should -BeTrue
    }

    It 'does not find it among <Label>' -ForEach @(
        @{ Label = 'no keys'; Keys = @() },
        @{ Label = 'null'; Keys = $null },
        @{ Label = 'a key without an identifier'; Keys = @([pscustomobject]@{ keyId = 'k1' }) }
    ) {
        Test-LabKeyCredentialPresent -RegisteredKeys $Keys -Thumbprint $fixture.Thumbprint | Should -BeFalse
    }

    It 'does not mistake another certificate for it' {
        $keys = @([pscustomobject]@{ keyId = 'k1'; customKeyIdentifier = $other.Thumbprint })
        Test-LabKeyCredentialPresent -RegisteredKeys $keys -Thumbprint $fixture.Thumbprint | Should -BeFalse
    }
}

Describe 'Get-LabKeyCredentialEndDate and Get-LabCredentialResetArguments' {
    It 'ends the credential one second before the certificate, in UTC' {
        Get-LabKeyCredentialEndDate -NotAfterUtc ([datetime]::new(2028, 9, 25, 12, 0, 0, [System.DateTimeKind]::Utc)) | Should -BeExactly '2028-09-25T11:59:59+00:00'
    }

    It 'always appends, always passes the certificate file, and prints nothing' {
        $arguments = Get-LabCredentialResetArguments -AppId $agentAppId -CertificateFile '/tmp/x.crt' -EndDate '2028-09-25T11:59:59+00:00' -KeyDisplayName 'vps-hostinger-01 labs-agent.crt'
        ($arguments[0..3] -join ' ') | Should -BeExactly 'ad app credential reset'
        $arguments | Should -Contain '--append'
        $arguments[[array]::IndexOf($arguments, '--cert') + 1] | Should -BeExactly '@/tmp/x.crt'
        $arguments[[array]::IndexOf($arguments, '--id') + 1] | Should -BeExactly $agentAppId
        $arguments[[array]::IndexOf($arguments, '--end-date') + 1] | Should -BeExactly '2028-09-25T11:59:59+00:00'
        $arguments | Should -Not -Contain '--create-cert'
        ($arguments[-2..-1] -join ' ') | Should -BeExactly '-o none'
    }
}

Describe 'Get-LabRegistrationPrompt' {
    BeforeAll {
        $labsUrl = 'https://hybridcloudworks.com/admin/labs?tab=agents'
    }

    It 'names the page and the two values to paste, the object id in lower case' {
        $lines = Get-LabRegistrationPrompt -Url $labsUrl -AgentId 'vps-hostinger-01' -ObjectId $agentSpId.ToUpperInvariant() -JobTypes (Get-LabJobTypes)
        $text = $lines -join "`n"
        $lines | Should -Contain "  $labsUrl"
        $lines | Should -Contain '  Agent id:   vps-hostinger-01'
        $lines | Should -Contain "  Object id:  $agentSpId"
        $text | Should -Match 'Register agent'
        $text | Should -Match 'Agent registered'
    }

    It 'asks for every job type to stay ticked' {
        $text = (Get-LabRegistrationPrompt -Url $labsUrl -AgentId 'vps-hostinger-01' -ObjectId $agentSpId -JobTypes (Get-LabJobTypes)) -join "`n"
        foreach ($type in Get-LabJobTypes) {
            $text | Should -Match ([regex]::Escape($type))
        }
    }

    It 'leaves no placeholder in what the owner pastes' {
        $text = (Get-LabRegistrationPrompt -Url $labsUrl -AgentId 'vps-hostinger-01' -ObjectId $agentSpId -JobTypes (Get-LabJobTypes)) -join "`n"
        $text | Should -Not -Match '<[a-z -]+>|THE[A-Z_]{3,}'
    }

    It 'refuses <Label>' -ForEach @(
        @{ Label = 'an agent id that is not the CN shape'; AgentId = 'VPS-01'; ObjectId = '99999999-5b4a-4938-8271-605f4e3d2c1b' },
        @{ Label = 'an object id that is not a GUID'; AgentId = 'vps-hostinger-01'; ObjectId = 'not-a-guid' }
    ) {
        { Get-LabRegistrationPrompt -Url $labsUrl -AgentId $AgentId -ObjectId $ObjectId -JobTypes (Get-LabJobTypes) } | Should -Throw
    }
}

Describe 'Test-LabRegistrationNeeded' {
    It 'skips the registration only for a heartbeating agent whose service principal this run did not create' {
        Test-LabRegistrationNeeded -VerdictState 'Healthy' | Should -BeFalse
    }

    It 'asks when <Label>' -ForEach @(
        @{ Label = 'the service principal is new, so no document can bind it yet'; State = 'Healthy'; Created = $true },
        @{ Label = 'the agent guard refuses the agent'; State = 'Registry'; Created = $false },
        @{ Label = 'the agent is not running, as before the first go-live'; State = 'Stopped'; Created = $false },
        @{ Label = 'the state is unknown'; State = ''; Created = $false }
    ) {
        Test-LabRegistrationNeeded -VerdictState $State -ServicePrincipalCreated:$Created | Should -BeTrue
    }
}

Describe 'Wait-LabRegistration' {
    It 'prints every line, then waits for Enter once' {
        Mock Write-Host { }
        Mock Read-LabEnter { '' }
        Wait-LabRegistration -Lines @('first line', 'second line')
        Should -Invoke Write-Host -ParameterFilter { $Object -eq 'first line' } -Exactly 1
        Should -Invoke Write-Host -ParameterFilter { $Object -eq 'second line' } -Exactly 1
        Should -Invoke Read-LabEnter -Exactly 1
    }

    # The owner's first live run (2026-09-27) stopped here with "Cannot bind
    # argument to parameter 'Lines' because it is an empty string": the real
    # prompt has blank lines, and a Mandatory [string[]] refuses '' unless
    # [AllowEmptyString()] says otherwise.
    It 'takes the real registration prompt, blank lines and all' {
        Mock Write-Host { }
        Mock Read-LabEnter { '' }
        $prompt = Get-LabRegistrationPrompt -Url 'https://hybridcloudworks.com/admin/labs?tab=agents' -AgentId 'vps-hostinger-01' -ObjectId $agentSpId -JobTypes (Get-LabJobTypes)
        @($prompt) | Should -Contain ''
        { Wait-LabRegistration -Lines $prompt } | Should -Not -Throw
        Should -Invoke Read-LabEnter -Exactly 1
    }

    It 'prints every line of a prompt with a blank line in it' {
        Mock Write-Host { }
        Mock Read-LabEnter { '' }
        Wait-LabRegistration -Lines @('first line', '', 'third line')
        # Three prompt lines, then the function's own spacer before the pause.
        Should -Invoke Write-Host -Exactly 4 -Scope It
        Should -Invoke Write-Host -ParameterFilter { $Object -eq 'third line' } -Exactly 1 -Scope It
        Should -Invoke Read-LabEnter -Exactly 1 -Scope It
    }
}

Describe 'Get-LabVaultValues' {
    It 'returns the four keys in order, identifiers in lower case' {
        $values = Get-LabVaultValues -ApiBase 'https://api-azure.hybridcloudworks.com/api' -TenantId '11111111-2222-3333-4444-55555555555A' -ClientId $agentAppId -ApiScope 'api://cccccccc-0000-4000-8000-000000000a91/.default'
        (@($values.Keys) -join ',') | Should -BeExactly 'vault_labs_agent_api_base,vault_labs_agent_tenant_id,vault_labs_agent_client_id,vault_labs_agent_api_scope'
        $values['vault_labs_agent_tenant_id'] | Should -BeExactly '11111111-2222-3333-4444-55555555555a'
    }

    It 'refuses <Label>' -ForEach @(
        @{ Label = 'the azurewebsites host without /api'; Base = 'https://func-site-prod-cus-01.azurewebsites.net'; Tenant = '11111111-2222-3333-4444-555555555555'; Scope = 'api://cccccccc-0000-4000-8000-000000000a91/.default' },
        @{ Label = 'a tenant that is not a GUID'; Base = 'https://api-azure.hybridcloudworks.com/api'; Tenant = 'saulpatinojrhotmail.onmicrosoft.com'; Scope = 'api://cccccccc-0000-4000-8000-000000000a91/.default' },
        @{ Label = 'a scope without .default'; Base = 'https://api-azure.hybridcloudworks.com/api'; Tenant = '11111111-2222-3333-4444-555555555555'; Scope = 'api://cccccccc-0000-4000-8000-000000000a91/access_as_admin' }
    ) {
        { Get-LabVaultValues -ApiBase $Base -TenantId $Tenant -ClientId $agentAppId -ApiScope $Scope } | Should -Throw
    }
}

Describe 'Get-LabVaultScript' {
    BeforeAll {
        $values = Get-LabVaultValues -ApiBase 'https://api-azure.hybridcloudworks.com/api' -TenantId '11111111-2222-3333-4444-555555555555' -ClientId $agentAppId -ApiScope 'api://cccccccc-0000-4000-8000-000000000a91/.default'
    }

    It 'fills every placeholder, quotes each value, and is LF only' {
        $text = Get-LabVaultScript -Values $values -ProbeUrl 'https://api-azure.hybridcloudworks.com/api/agent/heartbeat'
        $text | Should -Not -Match '@@HCW_'
        $text | Should -Not -Match "`r"
        $text | Should -Match "(?m)^mode='apply'$"
        $text | Should -Match "(?m)^dir='/etc/hcw/ansible'$"
        $text | Should -Match "(?m)^py=''$"
        $text | Should -Match ([regex]::Escape("HCW_VAULT_LABS_AGENT_CLIENT_ID='$agentAppId'"))
        $text | Should -Match ([regex]::Escape("HCW_VAULT_LABS_AGENT_API_BASE='https://api-azure.hybridcloudworks.com/api'"))
    }

    It 'writes nothing in check mode' {
        $text = Get-LabVaultScript -Values $values -Mode check -ProbeUrl 'https://api-azure.hybridcloudworks.com/api/agent/heartbeat'
        $text | Should -Match "(?m)^mode='check'$"
    }

    It 'refuses a value that could break out of its quotes' {
        $bad = [ordered]@{}
        foreach ($key in $values.Keys) {
            $bad[$key] = $values[$key]
        }
        $bad['vault_labs_agent_api_base'] = "https://x/api'; reboot; '"
        { Get-LabVaultScript -Values $bad -ProbeUrl 'https://x/api/agent/heartbeat' } | Should -Throw '*not safe*'
    }

    It 'refuses values without all four keys' {
        { Get-LabVaultScript -Values ([ordered]@{ vault_labs_agent_api_base = 'https://x/api' }) -ProbeUrl 'https://x/api/agent/heartbeat' } | Should -Throw '*has no vault_labs_agent_tenant_id*'
    }
}

Describe 'Get-LabCertificateReadScript and Get-LabAgentStatusScript' {
    It 'reads the certificate and checks it against the key without printing the key' {
        $text = Get-LabCertificateReadScript -CertificatePath '/etc/hcw/labs-agent.crt' -KeyPath '/etc/hcw/labs-agent.pem' -NextCertificatePath '/etc/hcw/labs-agent.next.crt'
        $text | Should -Not -Match '@@HCW_'
        $text | Should -Match "(?m)^crt='/etc/hcw/labs-agent.crt'$"
        $text | Should -Match "(?m)^next='/etc/hcw/labs-agent.next.crt'$"
        $text | Should -Not -Match 'cat -- "\$pem"'
        $text | Should -Match 'openssl pkey -in "\$pem" -pubout'
    }

    It 'prefixes the unit state and every journal line' {
        $text = Get-LabAgentStatusScript
        $text | Should -Match 'systemctl is-active hcw-labs-agent'
        $text | Should -Match "sed 's/\^/HCW LOG /'"
    }
}

Describe 'Get-LabRemoteCommand' {
    It 'sends the script as base64 with LF line endings, to bash as root' {
        $command = Get-LabRemoteCommand -BashScript "echo one`r`necho two`n"
        $command | Should -Match '\Aecho [A-Za-z0-9+/=]+ \| base64 -d \| sudo bash -s\z'
        $encoded = ($command -split ' ')[1]
        [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | Should -BeExactly "echo one`necho two`n"
    }
}

Describe 'ConvertFrom-LabVaultOutput and ConvertFrom-LabStatusOutput' {
    It 'reads the probe and the vault result, ignoring anything else' {
        $result = ConvertFrom-LabVaultOutput -Lines @(
            'sudo: unable to resolve host srv1',
            'HCW PROBE 401 application/json',
            'HCW VAULT updated added=vault_labs_agent_api_base,vault_labs_agent_tenant_id updated= unchanged=vault_labs_agent_client_id'
        )
        $result.ProbeStatus | Should -Be '401'
        $result.ProbeContentType | Should -Be 'application/json'
        $result.ProbeMitigated | Should -Be ''
        $result.VaultState | Should -Be 'updated'
        ($result.Added -join ',') | Should -BeExactly 'vault_labs_agent_api_base,vault_labs_agent_tenant_id'
        $result.Updated.Count | Should -Be 0
        ($result.Unchanged -join ',') | Should -BeExactly 'vault_labs_agent_client_id'
        $result.ErrorCode | Should -BeNullOrEmpty
    }

    It 'reads a challenge and an error' {
        $result = ConvertFrom-LabVaultOutput -Lines @(
            'HCW PROBE 403 text/html; charset=UTF-8',
            'HCW PROBE-MITIGATED challenge',
            'HCW ERROR no-password /etc/hcw/ansible/vault-password does not exist; create it first (lab-host/README.md, The vault)'
        )
        $result.ProbeContentType | Should -Be 'text/html; charset=UTF-8'
        $result.ProbeMitigated | Should -Be 'challenge'
        $result.ErrorCode | Should -Be 'no-password'
        $result.ErrorMessage | Should -BeLike '/etc/hcw/ansible/vault-password does not exist*'
        $result.VaultState | Should -BeNullOrEmpty
    }

    It 'reads a probe that got no answer' {
        (ConvertFrom-LabVaultOutput -Lines @('HCW PROBE 000 ')).ProbeStatus | Should -Be '000'
    }

    It 'reads the unit state and strips the journal prefix' {
        $status = ConvertFrom-LabStatusOutput -Lines @('HCW ACTIVE active', 'HCW LOG line one', 'HCW LOG line two', 'noise')
        $status.Active | Should -Be 'active'
        ($status.Journal -join '|') | Should -BeExactly 'line one|line two'
    }
}

Describe 'Get-LabProbeVerdict' {
    It 'calls <Status> <ContentType> <Mitigated> <State>' -ForEach @(
        @{ Status = '401'; ContentType = 'application/json'; Mitigated = ''; State = 'Reachable' },
        @{ Status = '403'; ContentType = 'text/html; charset=UTF-8'; Mitigated = 'challenge'; State = 'Challenged' },
        @{ Status = '403'; ContentType = 'text/html'; Mitigated = ''; State = 'Challenged' },
        @{ Status = '000'; ContentType = ''; Mitigated = ''; State = 'Unreachable' },
        @{ Status = '404'; ContentType = 'application/json'; Mitigated = ''; State = 'NoRoute' },
        @{ Status = '502'; ContentType = 'text/html'; Mitigated = ''; State = 'ApiError' },
        @{ Status = '401'; ContentType = 'text/html'; Mitigated = ''; State = 'Unexpected' },
        @{ Status = '200'; ContentType = 'application/json'; Mitigated = ''; State = 'Unexpected' }
    ) {
        (Get-LabProbeVerdict -Status $Status -ContentType $ContentType -Mitigated $Mitigated).State | Should -Be $State
    }
}

Describe 'Get-LabAgentVerdict' {
    BeforeAll {
        $start = '2026-09-27T10:00:00+0000 srv1 node[1234]: 2026-09-27T10:00:00.000Z [vps-hostinger-01] agent v1.0.0 starting against https://api-azure.hybridcloudworks.com/api'
        $recipes = '2026-09-27T10:00:00+0000 srv1 node[1234]: 2026-09-27T10:00:00.001Z [vps-hostinger-01] capabilities are assigned server-side; local recipes: shell-echo'
        function Get-FailureLine {
            param([string] $Message)
            return "2026-09-27T10:00:01+0000 srv1 node[1234]: 2026-09-27T10:00:01.000Z [vps-hostinger-01] heartbeat failed: $Message"
        }
    }

    It 'calls a running agent with no failure since its start Healthy' {
        (Get-LabAgentVerdict -Active 'active' -Journal @($start, $recipes)).State | Should -Be 'Healthy'
    }

    It 'calls <Message> <State>' -ForEach @(
        @{ Message = 'Agent access required'; State = 'Registry' },
        @{ Message = 'Authentication required'; State = 'Token' },
        @{ Message = 'agent/heartbeat failed with HTTP 403'; State = 'Edge' },
        @{ Message = 'agent/heartbeat failed with HTTP 404'; State = 'NoRoute' },
        @{ Message = 'agent/heartbeat failed with HTTP 502'; State = 'ApiError' },
        @{ Message = 'ClientCertificateCredential authentication failed: AADSTS700027: The certificate with identifier used to sign the client assertion is not registered on application.'; State = 'Credential' },
        @{ Message = 'fetch failed'; State = 'Network' },
        @{ Message = 'This operation was aborted'; State = 'Network' },
        @{ Message = 'something nobody expected'; State = 'Unknown' }
    ) {
        (Get-LabAgentVerdict -Active 'active' -Journal @($start, $recipes, (Get-FailureLine -Message $Message))).State | Should -Be $State
    }

    It 'ignores a failure from before the last restart' {
        $journal = @($start, (Get-FailureLine -Message 'Agent access required'), $start, $recipes)
        (Get-LabAgentVerdict -Active 'active' -Journal $journal).State | Should -Be 'Healthy'
    }

    It 'reads the whole window when the start line has scrolled out of it' {
        $journal = @('2026-09-27T11:00:00+0000 srv1 node[1234]: job 1 -> succeeded (exit 0)')
        (Get-LabAgentVerdict -Active 'active' -Journal $journal).State | Should -Be 'Healthy'
    }

    It 'calls an agent that is not running Stopped, or Config when it says why' {
        (Get-LabAgentVerdict -Active 'inactive' -Journal @()).State | Should -Be 'Stopped'
        (Get-LabAgentVerdict -Active 'failed' -Journal @('Missing required configuration: LABS_AGENT_API_BASE')).State | Should -Be 'Config'
    }
}

Describe 'Invoke-LabAzJson' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
    }

    It 'writes nothing for an empty JSON list' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        @(Invoke-LabAzJson -Arguments @('ad', 'app', 'list') -What 'Listing').Count | Should -Be 0
    }

    It 'writes the items of a JSON list' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stdout = '[{"a":1},{"a":2}]'; Stderr = '' } }
        @(Invoke-LabAzJson -Arguments @('ad', 'app', 'list') -What 'Listing').Count | Should -Be 2
    }

    It 'retries while Entra catches up, then returns the answer' {
        $script:azCalls = 0
        Mock Invoke-LabAz {
            $script:azCalls++
            if ($script:azCalls -lt 3) {
                return [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: Resource '0b1c' does not exist or one of its queried reference-property objects are not present." }
            }
            return [pscustomobject]@{ ExitCode = 0; Stdout = '{"id":"x"}'; Stderr = '' }
        }
        (Invoke-LabAzJson -Arguments @('ad', 'sp', 'create') -What 'Creating' -Attempts 6 -RetryPattern 'does not exist').id | Should -Be 'x'
        Should -Invoke Invoke-LabAz -Times 3 -Exactly
        Should -Invoke Start-Sleep -Times 2 -Exactly
    }

    It 'stops with az''s own words on any other failure' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = "ERROR: Insufficient privileges to complete the operation." } }
        { Invoke-LabAzJson -Arguments @('ad', 'app', 'create') -What 'Creating the app registration' -Attempts 6 -RetryPattern 'does not exist' } | Should -Throw '*Creating the app registration failed: az exited 1. ERROR: Insufficient privileges*'
        Should -Invoke Invoke-LabAz -Times 1 -Exactly
    }

    It 'treats an answer that says the change is already there as success' {
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'Bad Request({"error":{"message":"Permission being assigned already exists on the object"}})' } }
        { Invoke-LabAzJson -Arguments @('rest') -What 'Assigning' -AcceptPattern '(?i)already exists' } | Should -Not -Throw
    }
}

Describe 'Get-LabApiApplication' {
    BeforeAll {
        function Get-ApiJson {
            param([string] $Members = '["Application"]', [int] $Version = 2, [string] $RoleValue = 'LabAgent', [string] $Enabled = 'true')
            return @"
{"displayName":"HCWSite API","appId":"$apiAppId","identifierUris":["api://$apiAppId"],
 "api":{"requestedAccessTokenVersion":$Version},
 "appRoles":[{"id":"11111111-0000-4000-8000-000000000001","value":"Admin","allowedMemberTypes":["User"],"isEnabled":true},
             {"id":"$labAgentRoleId","value":"$RoleValue","allowedMemberTypes":$Members,"isEnabled":$Enabled}]}
"@
        }
    }

    BeforeEach {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp show' } { [pscustomobject]@{ ExitCode = 0; Stdout = "{""id"":""$apiSpId""}"; Stderr = '' } }
    }

    It 'returns the LabAgent role, the API''s service principal and the scope' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app show' } { [pscustomobject]@{ ExitCode = 0; Stdout = (Get-ApiJson); Stderr = '' } }
        $api = Get-LabApiApplication -ApiAppId $apiAppId
        $api.AppRoleId | Should -BeExactly $labAgentRoleId
        $api.ServicePrincipalId | Should -BeExactly $apiSpId
        $api.Scope | Should -BeExactly "api://$apiAppId/.default"
        $api.DisplayName | Should -Be 'HCWSite API'
    }

    It 'stops when <Label>' -ForEach @(
        @{ Label = 'there is no LabAgent role'; Overrides = @{ RoleValue = 'SomethingElse' }; Expected = '*no LabAgent app role*' },
        @{ Label = 'LabAgent is for users only'; Overrides = @{ Members = '["User"]' }; Expected = '*does not allow applications*' },
        @{ Label = 'LabAgent is disabled'; Overrides = @{ Enabled = 'false' }; Expected = '*is disabled*' },
        @{ Label = 'the API issues v1 tokens'; Overrides = @{ Version = 1 }; Expected = '*v1 tokens*' }
    ) {
        $script:apiJson = Get-ApiJson @Overrides
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app show' } { [pscustomobject]@{ ExitCode = 0; Stdout = $script:apiJson; Stderr = '' } }
        { Get-LabApiApplication -ApiAppId $apiAppId } | Should -Throw $Expected
    }
}

# The API's client id used to be a parameter default; the repository is public
# and a real application id does not go in a tracked file (#1540), so the
# script finds it. Each source is tried in order, and a name that is only a
# prefix match is not the registration.
Describe 'Resolve-LabApiAppId' {
    BeforeEach {
        Mock Write-Host { }
        Mock Invoke-LabAz { throw "unexpected az call: $($Arguments -join ' ')" }
        $script:savedApiAppId = $env:HCW_API_APP_ID
        $env:HCW_API_APP_ID = $null
    }

    AfterEach {
        $env:HCW_API_APP_ID = $script:savedApiAppId
    }

    It 'takes -ApiAppId as given, lower-cased, and asks az nothing' {
        Resolve-LabApiAppId -ApiAppId $apiAppId.ToUpperInvariant() | Should -BeExactly $apiAppId
        Should -Invoke Invoke-LabAz -Times 0 -Exactly
    }

    It 'takes HCW_API_APP_ID next, and refuses one that is not a client id' {
        $env:HCW_API_APP_ID = $apiAppId.ToUpperInvariant()
        Resolve-LabApiAppId -ApiAppId '' | Should -BeExactly $apiAppId
        Should -Invoke Invoke-LabAz -Times 0 -Exactly
        $env:HCW_API_APP_ID = 'not-a-guid'
        { Resolve-LabApiAppId -ApiAppId '' } | Should -Throw '*HCW_API_APP_ID*not a client id*'
    }

    It 'otherwise finds the one registration named exactly HCWSite API' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = "[{""appId"":""$($apiAppId.ToUpperInvariant())"",""displayName"":""HCWSite API""},{""appId"":""$agentAppId"",""displayName"":""HCWSite API (old)""}]"; Stderr = '' }
        }
        Resolve-LabApiAppId -ApiAppId '' | Should -BeExactly $apiAppId
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { ($Arguments -join ' ') -eq 'ad app list --display-name HCWSite API -o json' }
    }

    It 'stops when <Label>' -ForEach @(
        @{ Label = 'no registration has the name'; Json = '[]'; Expected = '*No app registration named*HCW_API_APP_ID*' },
        @{ Label = 'only a prefix match exists'; Json = '[{"appId":"bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9","displayName":"HCWSite API (old)"}]'; Expected = '*No app registration named*' },
        @{ Label = 'two registrations have the name'; Json = '[{"appId":"bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9","displayName":"HCWSite API"},{"appId":"bbbbbbbb-4f50-4617-8293-a4b5c6d7e800","displayName":"HCWSite API"}]'; Expected = '*More than one app registration*bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9, bbbbbbbb-4f50-4617-8293-a4b5c6d7e800*' },
        @{ Label = 'az returns something that is not a client id'; Json = '[{"appId":"nope","displayName":"HCWSite API"}]'; Expected = '*not a client id*' }
    ) {
        $script:listJson = $Json
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } { [pscustomobject]@{ ExitCode = 0; Stdout = $script:listJson; Stderr = '' } }
        { Resolve-LabApiAppId -ApiAppId '' } | Should -Throw $Expected
    }

    It 'passes on az''s own failure' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'ERROR: Please run ''az login'' to setup account.' } }
        { Resolve-LabApiAppId -ApiAppId '' } | Should -Throw '*Finding the app registration HCWSite API failed: az exited 1*az login*'
    }
}

Describe 'Confirm-LabAgentApplication' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        Mock Invoke-LabAz { throw "unexpected az call: $($Arguments -join ' ')" }
    }

    It 'reuses the one registration of that name and its service principal, creating nothing' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = "[{""appId"":""$agentAppId"",""id"":""o1"",""keyCredentials"":[{""keyId"":""k1"",""customKeyIdentifier"":""$($fixture.Thumbprint)""}],""passwordCredentials"":[]}]"; Stderr = '' }
        }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = "[{""id"":""$agentSpId""}]"; Stderr = '' }
        }
        $result = Confirm-LabAgentApplication -DisplayName 'sp-labs-agent-lab-hybrid-prod-cus-01'
        $result.AppId | Should -BeExactly $agentAppId
        $result.ServicePrincipalId | Should -BeExactly $agentSpId
        $result.AppCreated | Should -BeFalse
        $result.ServicePrincipalCreated | Should -BeFalse
        @($result.RegisteredKeys).Count | Should -Be 1
        $result.PasswordCredentialCount | Should -Be 0
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'create' }
    }

    It 'creates a single-tenant registration and its service principal when there is none' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app create' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = "{""appId"":""$agentAppId"",""id"":""o1"",""keyCredentials"":[],""passwordCredentials"":[]}"; Stderr = '' }
        }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp list' } { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp create' } { [pscustomobject]@{ ExitCode = 0; Stdout = "{""id"":""$agentSpId""}"; Stderr = '' } }
        $result = Confirm-LabAgentApplication -DisplayName 'sp-labs-agent-lab-hybrid-prod-cus-01'
        $result.AppCreated | Should -BeTrue
        $result.ServicePrincipalCreated | Should -BeTrue
        $result.ServicePrincipalId | Should -BeExactly $agentSpId
        @($result.RegisteredKeys).Count | Should -Be 0
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app create' -and $Arguments -contains 'AzureADMyOrg' -and $Arguments -contains 'sp-labs-agent-lab-hybrid-prod-cus-01' }
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad sp create' -and $Arguments -contains $agentAppId }
    }

    It 'stops when two registrations have the name' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = '[{"appId":"a1"},{"appId":"a2"}]'; Stderr = '' }
        }
        { Confirm-LabAgentApplication -DisplayName 'sp-labs-agent-lab-hybrid-prod-cus-01' } | Should -Throw '*2 app registrations are named*'
    }

    It 'creates nothing under -WhatIf' {
        Mock Invoke-LabAz -ParameterFilter { ($Arguments[0..2] -join ' ') -eq 'ad app list' } { [pscustomobject]@{ ExitCode = 0; Stdout = '[]'; Stderr = '' } }
        $result = Confirm-LabAgentApplication -DisplayName 'sp-labs-agent-lab-hybrid-prod-cus-01' -WhatIf
        $result.AppId | Should -BeNullOrEmpty
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'create' }
    }
}

Describe 'Confirm-LabAgentCertificate' {
    BeforeAll {
        $info = Get-LabCertificateInfo -Pem $fixture.Pem
    }

    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        Mock Invoke-LabAz { [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = 'WARNING: The output includes credentials that you must protect.' } }
    }

    It 'changes nothing when the certificate is already registered, and lists the others' {
        $keys = @(
            [pscustomobject]@{ keyId = 'k-old'; customKeyIdentifier = $other.Thumbprint; endDateTime = '2027-01-01T00:00:00Z' },
            [pscustomobject]@{ keyId = 'k-new'; customKeyIdentifier = $fixture.Thumbprint; endDateTime = '2028-09-25T11:59:59Z' }
        )
        $result = Confirm-LabAgentCertificate -AppId $agentAppId -RegisteredKeys $keys -Certificate $info -CertificateFile '/tmp/x.crt' -KeyDisplayName 'n'
        $result.Action | Should -Be 'Unchanged'
        @($result.Others).Count | Should -Be 1
        $result.Others[0].KeyId | Should -Be 'k-old'
        $result.Others[0].Thumbprint | Should -BeExactly $other.Thumbprint
        Should -Invoke Invoke-LabAz -Times 0 -Exactly
    }

    It 'appends it, never replacing, when it is not registered' {
        $keys = @([pscustomobject]@{ keyId = 'k-old'; customKeyIdentifier = $other.Thumbprint; endDateTime = '2027-01-01T00:00:00Z' })
        $result = Confirm-LabAgentCertificate -AppId $agentAppId -RegisteredKeys $keys -Certificate $info -CertificateFile '/tmp/x.crt' -KeyDisplayName 'n'
        $result.Action | Should -Be 'Appended'
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter {
            ($Arguments[0..3] -join ' ') -eq 'ad app credential reset' -and $Arguments -contains '--append' -and $Arguments -contains '@/tmp/x.crt'
        }
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -notcontains '--append' }
    }

    It 'uploads nothing under -WhatIf' {
        $result = Confirm-LabAgentCertificate -AppId $agentAppId -RegisteredKeys @() -Certificate $info -CertificateFile '/tmp/x.crt' -KeyDisplayName 'n' -WhatIf
        $result.Action | Should -Be 'WouldAppend'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly
    }
}

Describe 'Confirm-LabAgentAppRole' {
    BeforeEach {
        Mock Write-Host { }
        Mock Start-Sleep { }
        Mock Invoke-LabAz { throw "unexpected az call: $($Arguments -join ' ')" }
        $script:postedBody = $null
    }

    It 'changes nothing when the role is held, and reports any other' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'GET' } {
            [pscustomobject]@{ ExitCode = 0; Stdout = "{""value"":[{""appRoleId"":""$labAgentRoleId"",""resourceId"":""$apiSpId"",""resourceDisplayName"":""HCWSite API""},{""appRoleId"":""r-other"",""resourceId"":""x"",""resourceDisplayName"":""Microsoft Graph""}]}"; Stderr = '' }
        }
        $result = Confirm-LabAgentAppRole -ServicePrincipalId $agentSpId -ApiServicePrincipalId $apiSpId -AppRoleId $labAgentRoleId -BodyDirectory $TestDrive
        $result.Action | Should -Be 'Unchanged'
        ($result.Extra -join '|') | Should -BeExactly 'Microsoft Graph role r-other'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'POST' }
    }

    It 'assigns it on the API''s service principal when it is not held, and removes the body file' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'GET' } { [pscustomobject]@{ ExitCode = 0; Stdout = '{"value":[]}'; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'POST' } {
            $script:postedBody = [System.IO.File]::ReadAllText($Arguments[[array]::IndexOf($Arguments, '--body') + 1].Substring(1))
            [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
        }
        $result = Confirm-LabAgentAppRole -ServicePrincipalId $agentSpId -ApiServicePrincipalId $apiSpId -AppRoleId $labAgentRoleId -BodyDirectory $TestDrive
        $result.Action | Should -Be 'Assigned'
        Should -Invoke Invoke-LabAz -Times 1 -Exactly -ParameterFilter {
            $Arguments -contains 'POST' -and $Arguments -contains "https://graph.microsoft.com/v1.0/servicePrincipals/$agentSpId/appRoleAssignments"
        }
        $body = $script:postedBody | ConvertFrom-Json
        $body.principalId | Should -BeExactly $agentSpId
        $body.resourceId | Should -BeExactly $apiSpId
        $body.appRoleId | Should -BeExactly $labAgentRoleId
        @(Get-ChildItem -LiteralPath $TestDrive -Filter 'hcw-lab-agent-role-*').Count | Should -Be 0
    }

    It 'takes "already exists" as done' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'GET' } { [pscustomobject]@{ ExitCode = 0; Stdout = '{"value":[]}'; Stderr = '' } }
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'POST' } { [pscustomobject]@{ ExitCode = 1; Stdout = ''; Stderr = 'Permission being assigned already exists on the object' } }
        (Confirm-LabAgentAppRole -ServicePrincipalId $agentSpId -ApiServicePrincipalId $apiSpId -AppRoleId $labAgentRoleId -BodyDirectory $TestDrive).Action | Should -Be 'Assigned'
    }

    It 'assigns nothing under -WhatIf' {
        Mock Invoke-LabAz -ParameterFilter { $Arguments -contains 'GET' } { [pscustomobject]@{ ExitCode = 0; Stdout = '{"value":[]}'; Stderr = '' } }
        (Confirm-LabAgentAppRole -ServicePrincipalId $agentSpId -ApiServicePrincipalId $apiSpId -AppRoleId $labAgentRoleId -BodyDirectory $TestDrive -WhatIf).Action | Should -Be 'WouldAssign'
        Should -Invoke Invoke-LabAz -Times 0 -Exactly -ParameterFilter { $Arguments -contains 'POST' }
    }
}

Describe 'Read-LabAgentStatus' {
    It 'stops when the host cannot be read' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 255; Lines = @('ssh: connect to host hcw-lab port 22: Connection timed out') } }
        { Read-LabAgentStatus -HostAlias 'hcw-lab' } | Should -Throw '*exit 255*'
    }

    It 'returns the state and journal' {
        Mock Invoke-LabSsh { [pscustomobject]@{ ExitCode = 0; Lines = @('HCW ACTIVE active', 'HCW LOG started') } }
        $status = Read-LabAgentStatus -HostAlias 'hcw-lab'
        $status.Active | Should -Be 'active'
        ($status.Journal -join '|') | Should -BeExactly 'started'
    }
}

Describe 'the vault merge, run by bash against a stand-in ansible-vault' -Skip:(-not $canRunHostScript) {
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

        $secret = 'SECRET-TOKEN-VALUE-0123456789'
        $clientA = 'bbbbbbbb-4f50-4617-8293-a4b5c6d7e8f9'
        $clientB = 'bbbbbbbb-4f50-4617-8293-a4b5c6d7e800'

        function New-VaultDirectory {
            param([switch] $WithPassword)
            $directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
            New-Item -ItemType Directory -Path $directory | Out-Null
            if ($WithPassword) {
                [System.IO.File]::WriteAllText((Join-Path $directory 'vault-password'), "test-password`n")
            }
            return $directory
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

        function Invoke-VaultScript {
            param([string] $Directory, [string] $ClientId, [string] $Mode = 'apply')
            $values = Get-LabVaultValues -ApiBase 'https://api-azure.hybridcloudworks.com/api' -TenantId '11111111-2222-3333-4444-555555555555' -ClientId $ClientId -ApiScope 'api://cccccccc-0000-4000-8000-000000000a91/.default'
            $text = Get-LabVaultScript -Values $values -Mode $Mode -ProbeUrl 'http://127.0.0.1:9/api/agent/heartbeat' -VaultDirectory $Directory -AnsibleVault $fakeVault -Python 'python3'
            $file = Join-Path $TestDrive ([guid]::NewGuid().ToString('n') + '.sh')
            [System.IO.File]::WriteAllText($file, $text)
            # As the host runs it: the script on bash's standard input.
            $lines = @(& bash -c "bash -s < '$file'" 2>&1 | ForEach-Object { [string]$_ })
            return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines; Parsed = (ConvertFrom-LabVaultOutput -Lines $lines) }
        }
    }

    It 'creates vault.yml with only the four keys when there is none' {
        $directory = New-VaultDirectory -WithPassword
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $run.ExitCode | Should -Be 0
        $run.Parsed.ProbeStatus | Should -Be '000'
        $run.Parsed.VaultState | Should -Be 'created'
        $run.Parsed.Added.Count | Should -Be 4
        $plain = Unprotect-TestVault -Directory $directory
        $plain | Should -Match "(?m)^vault_labs_agent_client_id: '$clientA'$"
        $plain | Should -Match "(?m)^vault_labs_agent_api_base: 'https://api-azure.hybridcloudworks.com/api'$"
        @($plain -split "`n" | Where-Object { $_ -match '^vault_' }).Count | Should -Be 4
    }

    It 'merges into an existing vault, leaves every other key as it was, and never prints it' {
        $directory = New-VaultDirectory -WithPassword
        $original = "---`n# Caddy`nvault_cloudflare_api_token: $secret`nvault_coder_multi: |`n  line one`n  line two`n"
        Protect-TestVault -Directory $directory -Plain $original
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $run.ExitCode | Should -Be 0
        $run.Parsed.VaultState | Should -Be 'updated'
        ($run.Lines -join "`n") | Should -Not -Match $secret
        $plain = Unprotect-TestVault -Directory $directory
        $plain.StartsWith($original, [System.StringComparison]::Ordinal) | Should -BeTrue
        $plain | Should -Match "(?m)^vault_labs_agent_tenant_id: '11111111-2222-3333-4444-555555555555'$"
    }

    It 'changes nothing, byte for byte, when the values are already there' {
        $directory = New-VaultDirectory -WithPassword
        $null = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml')))
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $run.Parsed.VaultState | Should -Be 'unchanged'
        $run.Parsed.Unchanged.Count | Should -Be 4
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml'))) | Should -BeExactly $before
    }

    It 'replaces only the key whose value changed' {
        $directory = New-VaultDirectory -WithPassword
        $null = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientB
        $run.Parsed.VaultState | Should -Be 'updated'
        ($run.Parsed.Updated -join ',') | Should -BeExactly 'vault_labs_agent_client_id'
        $run.Parsed.Unchanged.Count | Should -Be 3
        (Unprotect-TestVault -Directory $directory) | Should -Match "(?m)^vault_labs_agent_client_id: '$clientB'$"
    }

    It 'writes nothing in check mode' {
        $directory = New-VaultDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain "vault_cloudflare_api_token: $secret`n"
        $before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml')))
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientA -Mode check
        $run.Parsed.VaultState | Should -Be 'would-be-updated'
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml'))) | Should -BeExactly $before
    }

    It 'stops, creating nothing, when the password file is missing' {
        $directory = New-VaultDirectory
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $run.ExitCode | Should -Be 3
        $run.Parsed.ErrorCode | Should -Be 'no-password'
        Test-Path -LiteralPath (Join-Path $directory 'vault.yml') | Should -BeFalse
    }

    It 'stops, changing nothing and printing nothing from it, when the vault is not YAML' {
        $directory = New-VaultDirectory -WithPassword
        Protect-TestVault -Directory $directory -Plain "vault_cloudflare_api_token: [unclosed $secret`n"
        $before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml')))
        $run = Invoke-VaultScript -Directory $directory -ClientId $clientA
        $run.ExitCode | Should -Be 3
        $run.Parsed.ErrorCode | Should -Be 'not-yaml'
        ($run.Lines -join "`n") | Should -Not -Match $secret
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $directory 'vault.yml'))) | Should -BeExactly $before
    }

    It 'leaves no temporary directory behind' {
        $directory = New-VaultDirectory -WithPassword
        $null = Invoke-VaultScript -Directory $directory -ClientId $clientA
        @(Get-ChildItem -LiteralPath '/dev/shm' -Filter 'hcw-vault.*' -ErrorAction SilentlyContinue).Count | Should -Be 0
    }
}

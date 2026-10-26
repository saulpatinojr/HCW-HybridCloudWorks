param([Parameter(Mandatory)][ValidateSet('Protect', 'Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    [Console]::InputEncoding = New-Object Text.UTF8Encoding $false
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
    $value = [Console]::In.ReadToEnd()
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Mode -eq 'Protect') {
        $bytes = [Text.Encoding]::UTF8.GetBytes($value)
        [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)))
    }
    else {
        $bytes = [Convert]::FromBase64String($value)
        [Console]::Out.Write([Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)))
    }
}
catch { exit 1 }

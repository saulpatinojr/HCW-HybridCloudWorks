<#
.SYNOPSIS
    Cutover step 3d — point the Telegram bot at Azure (T-512).

.DESCRIPTION
    Migration-Plan §6 step 6. The URL and its secret token are registered with
    TELEGRAM, not in code, so deploying the receiver changes nothing on its own
    — the bot keeps POSTing at the Cloud Functions URL until `setWebhook` is
    re-run. That is the half of this step that gets forgotten, and nothing
    breaks until GCP is decommissioned, at which point the bot goes quiet with
    no error anywhere in Azure.

    The receiver now exists here: POST /api/telegram/webhook, implemented in
    functions/src/functions/telegram-http.js. It is anonymous because Telegram
    cannot send a bearer token, and guarded instead by:

      1. X-Telegram-Bot-Api-Secret-Token, which Telegram echoes back from
         whatever is registered below, compared in constant time against
         sha256(TELEGRAM_BOT_TOKEN).
      2. The sending chat id, which must equal TELEGRAM_CHAT_ID.

    The secret is DERIVED from the bot token rather than stored separately —
    one secret to rotate, and no way for the two to drift apart. This script
    computes it the same way the running code does, so there is nothing to keep
    in sync by hand.

.PARAMETER Mode
    Set     - register the Azure webhook URL (default)
    Show    - print current webhook info from Telegram, change nothing
    Delete  - unregister entirely (the "retire the bot" option)

.PARAMETER BotToken
    The bot token. Omitted, the script reads it from Key Vault, which needs a
    firewall window — pass it directly if you have it to hand.

.PARAMETER WebhookSecret
    Optional independent webhook secret (SEC-6). If omitted, falls back to
    TELEGRAM-WEBHOOK-SECRET in Key Vault if present, or derives sha256(BotToken).

.EXAMPLE
    ./04-telegram-webhook.ps1 -Mode Show
    ./04-telegram-webhook.ps1
    ./04-telegram-webhook.ps1 -Mode Delete

.NOTES
    Run this AFTER the receiver is deployed. Registering a webhook that 404s
    makes Telegram retry and back off, and the bot looks broken for a while
    after you fix it.

    Requires: PowerShell 7. Key Vault access only when -BotToken is omitted.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidateSet('Set', 'Show', 'Delete')]
    [string] $Mode = 'Set',
    [string] $BotToken,
    [string] $WebhookSecret,
    [string] $ApiBase = 'https://api-azure.hybridcloudworks.com/api',
    [string] $VaultName = 'kv-site-prod-cus-01',
    # Addressing the vault by name ALONE makes az search the subscription, and
    # that search reports "The Vault 'kv-site-prod-cus-01' not found within
    # subscription" on failure — which reads as "the vault does not exist" and
    # sends you looking for a deleted resource. Observed 2026-08-28 with the
    # CLI on the correct subscription and `az keyvault list` finding the vault
    # fine. Name plus resource group is an unambiguous ARM address with no
    # search step.
    [string] $ResourceGroup = 'rg-sec-site-prod-cus'
)

$ErrorActionPreference = 'Stop'
function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

$ruleAdded = $false
$myIp = $null
try {
    if (-not $BotToken) {
        Write-Step 'Read the bot token from Key Vault'
        $myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 15).ip
        # Guarded, like the window in 06-seed-secret.ps1. Without this,
        # -WhatIf still mutated the production vault's network ACL and pulled
        # the bot token out of it — a dry run that writes is not a dry run
        # (T-704).
        if ($PSCmdlet.ShouldProcess($VaultName, "allow $myIp temporarily and read TELEGRAM-BOT-TOKEN")) {
            Write-Host "opening a firewall window for $myIp"
            az keyvault network-rule add --resource-group $ResourceGroup --name $VaultName --ip-address "$myIp/32" --output none
            $ruleAdded = $true
            Start-Sleep -Seconds 20
            $BotToken = az keyvault secret show --vault-name $VaultName --name 'TELEGRAM-BOT-TOKEN' `
                --query 'value' -o tsv
            if (-not $WebhookSecret) {
                $WebhookSecret = az keyvault secret show --vault-name $VaultName --name 'TELEGRAM-WEBHOOK-SECRET' `
                    --query 'value' -o tsv 2>$null
            }
        }
        else {
            Write-Host 'skipped: no vault window opened and no token read.' -ForegroundColor Yellow
            Write-Host 'Re-run without -WhatIf, or pass -BotToken to preview the rest.' -ForegroundColor Yellow
            return
        }
    }
    if ([string]::IsNullOrWhiteSpace($BotToken)) { throw 'No bot token available.' }
    Write-Host "bot token: $($BotToken.Length) characters (value not printed)"

    # Secret resolution (SEC-6): prefers explicit $WebhookSecret, otherwise derives sha256(BotToken).
    if (-not [string]::IsNullOrWhiteSpace($WebhookSecret)) {
        $secret = $WebhookSecret
        Write-Host "independent webhook secret configured (SEC-6, value not printed)"
    }
    else {
        # Same derivation as expectedWebhookSecret() in lib/telegram/bot.js.
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $secret = ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($BotToken)) |
            ForEach-Object { $_.ToString('x2') }) -join ''
        $sha.Dispose()
        Write-Host "derived secret: $($secret.Substring(0,8))... (sha256 of the token)"
    }

    $api = "https://api.telegram.org/bot$BotToken"

    Write-Step 'Current webhook'
    $info = Invoke-RestMethod -Uri "$api/getWebhookInfo" -TimeoutSec 20
    if ($info.result.url) {
        Write-Host "url               : $($info.result.url)"
        Write-Host "pending updates   : $($info.result.pending_update_count)"
        if ($info.result.last_error_message) {
            Write-Host "last error        : $($info.result.last_error_message)" -ForegroundColor Yellow
            Write-Host "last error at     : $([datetimeoffset]::FromUnixTimeSeconds($info.result.last_error_date).ToString('u'))"
        }
    }
    else { Write-Host 'no webhook registered' }

    if ($Mode -eq 'Show') { return }

    if ($Mode -eq 'Delete') {
        Write-Step 'Unregister'
        if ($PSCmdlet.ShouldProcess('Telegram bot', 'deleteWebhook — inbound commands stop working')) {
            $r = Invoke-RestMethod -Uri "$api/deleteWebhook?drop_pending_updates=true" -TimeoutSec 20
            if (-not $r.ok) { throw "deleteWebhook failed: $($r.description)" }
            Write-Host 'webhook deleted; outbound alerts are unaffected' -ForegroundColor Green
        }
        return
    }

    $target = "$ApiBase/telegram/webhook"

    Write-Step 'Preflight the receiver'
    # A webhook pointed at a 404 makes Telegram retry and back off, so the bot
    # stays broken for a while after the real fix. Check first: an unauthorized
    # POST must answer 401, which proves the route exists AND that the secret
    # gate is actually running.
    try {
        $probe = Invoke-WebRequest -Uri $target -Method POST -Body '{}' `
            -ContentType 'application/json' -SkipHttpErrorCheck -TimeoutSec 25
        Write-Host "POST $target -> $($probe.StatusCode)"
        if ($probe.StatusCode -eq 404) {
            throw 'The receiver is not deployed (404). Deploy functions first, then re-run.'
        }
        if ($probe.StatusCode -ne 401) {
            Write-Warning "Expected 401 from an unauthenticated POST, got $($probe.StatusCode). Continuing, but check the route."
        }
        else { Write-Host 'secret gate is live (401 without a valid token)' -ForegroundColor Green }
    }
    catch [System.Net.Http.HttpRequestException] {
        throw "Could not reach $target — $($_.Exception.Message)"
    }

    Write-Step 'Register'
    if ($PSCmdlet.ShouldProcess('Telegram bot', "setWebhook -> $target")) {
        $body = @{
            url                  = $target
            secret_token         = $secret
            allowed_updates      = @('message')
            drop_pending_updates = $true
        } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri "$api/setWebhook" -Method POST -Body $body `
            -ContentType 'application/json' -TimeoutSec 20
        if (-not $r.ok) { throw "setWebhook failed: $($r.description)" }
        Write-Host "registered: $target" -ForegroundColor Green
    }

    # Nothing was registered under -WhatIf, so verifying the registration
    # would assert against state the run deliberately did not create and
    # always throw — a dry run that ends red teaches nothing (T-704).
    if ($WhatIfPreference) {
        Write-Step 'Verify (skipped under -WhatIf)'
        Write-Host "would verify that getWebhookInfo reports url = $target"
        Write-Host 'would verify that the secret gate rejects a POST carrying no token'
        return
    }

    Write-Step 'Verify'
    Start-Sleep -Seconds 3
    $after = (Invoke-RestMethod -Uri "$api/getWebhookInfo" -TimeoutSec 20).result
    Write-Host "url             : $($after.url)"
    Write-Host "pending updates : $($after.pending_update_count)"
    if ($after.url -ne $target) { throw "Webhook URL is '$($after.url)', expected '$target'." }

    # Telegram never returns secret_token from getWebhookInfo, so the old
    # `has_custom_certificate -or $secret` line printed "set" unconditionally
    # ($secret is always non-empty here) and verified nothing —
    # has_custom_certificate is about self-signed certs, not the secret. The
    # only real check is behavioural: the receiver must reject a POST that
    # does not carry the token, and accept one that does.
    Write-Step 'Verify the secret gate end to end'
    $unauth = Invoke-WebRequest -Uri $target -Method POST -Body '{}' `
        -ContentType 'application/json' -SkipHttpErrorCheck -TimeoutSec 20
    if ($unauth.StatusCode -ne 401) {
        throw "Receiver answered $($unauth.StatusCode) to a POST with no secret; expected 401."
    }
    Write-Host 'without secret  : 401 (rejected, as it must be)' -ForegroundColor Green

    $authed = Invoke-WebRequest -Uri $target -Method POST -Body '{}' `
        -ContentType 'application/json' -SkipHttpErrorCheck -TimeoutSec 20 `
        -Headers @{ 'X-Telegram-Bot-Api-Secret-Token' = $secret }
    if ($authed.StatusCode -ne 200) {
        throw "Receiver answered $($authed.StatusCode) to a POST carrying the derived secret; expected 200. The deployed token and the vault token disagree."
    }
    Write-Host 'with secret     : 200 (accepted — vault token matches the deployed one)' -ForegroundColor Green

    Write-Host ''
    Write-Host 'Now send /help to the bot. If nothing comes back, check:' -ForegroundColor Yellow
    Write-Host '  - your chat id matches TELEGRAM_CHAT_ID (an unauthorized chat is ignored SILENTLY, by design)'
    Write-Host '  - App Insights traces for "[telegram]"'
    Write-Host '  - ./04-telegram-webhook.ps1 -Mode Show, for last_error_message from Telegram'
}
finally {
    if ($ruleAdded) {
        Write-Step 'Close the firewall window'
        az keyvault network-rule remove --resource-group $ResourceGroup --name $VaultName --ip-address "$myIp/32" --output none
        Write-Host 'rule removed' -ForegroundColor Green
    }
}

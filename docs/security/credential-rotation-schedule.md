# Credential rotation schedule

**What this is:** the formal rotation schedule and operating procedures for all external API keys, service credentials, identity tokens, and infrastructure secrets utilized by the HybridCloudWorks estate (`infra/functionapp.tf:397-638`, Key Vault, and platform components).

**Doctrine:** Credentials should be rotated on a predictable schedule to bound the exposure window of undetected leaks. High-privilege access keys are rotated every 90 days; integration keys every 180 to 365 days; and ephemeral tokens on demand or automatically.

---

## 1. Master rotation schedule table

| Credential Name | Service / Provider | Storage Location | Rotation Cadence | Rotation Procedure & Command | Service Impact |
| --- | --- | --- | --- | --- | --- |
| **`AWS-ACCESS-KEY-ID`** / **`AWS-SECRET-ACCESS-KEY`** | AWS Pricing API (`pricing:GetProducts`) | Key Vault | 90 days | Mint new IAM access key pair in AWS Console -> update Key Vault -> restart Function App. Delete old IAM key after 24h. | Function App restart |
| **`GCP-BILLING-API-KEY`** | Google Cloud Billing Catalog API | Key Vault | 180 days | Generate new API key in Google Cloud Console -> update Key Vault -> restart Function App. Delete old key after 24h. | Function App restart |
| **`CF-ORIGIN-SECRET`** | Cloudflare Origin Shielding | Key Vault | 90 days | Generate 32-byte hex secret -> update Key Vault -> update Cloudflare Transform Rule -> restart Function App. | Function App restart |
| **`CLIENT-IP-SALT`** | Anonymous Rate-Limit Hasher | Key Vault | 90 days | Generate 32-byte random hex string -> update Key Vault -> restart Function App. *Note:* resets rolling IP rate-limit windows. | Function App restart |
| **`GEMINI-API-KEY`** | Google AI (Gemini Text & TTS) | Key Vault | 180 days | Create new API key in Google AI Studio -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`ANTHROPIC-API-KEY`** | Anthropic Claude API | Key Vault | 180 days | Create new API key in Anthropic Console -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`OPENAI-API-KEY`** | OpenAI API | Key Vault | 180 days | Create new API key in OpenAI Platform -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`NVIDIA-API-KEY`** | NVIDIA API Catalog | Key Vault | 180 days | Mint new key in NVIDIA build catalog -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`REPLICATE-API-KEY`** | Replicate Image Models | Key Vault | 180 days | Create new API token in Replicate account -> update Key Vault -> restart Function App. Delete old token. | Function App restart |
| **`AZURE-SPEECH-KEY`** | Azure Cognitive Services | Key Vault | 365 days | Regenerate Key 2 in Azure Portal -> update Key Vault -> restart Function App -> regenerate Key 1. | Zero downtime |
| **`ELEVENLABS-API-KEY`** | ElevenLabs Voice Synthesis | Key Vault | 180 days | Generate new API key in ElevenLabs profile -> update Key Vault -> restart Function App. Delete old key. | Function App restart |
| **`FIRECRAWL-API-KEY`** | Firecrawl Ingestion Service | Key Vault | 180 days | Generate new API key in Firecrawl dashboard -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`LINKIE-API-KEY`** | Linkie Enrichment API | Key Vault | 180 days | Generate new API key at [app.linkie.bio/playground](https://app.linkie.bio/playground) (avatar, Account Settings, API Keys, Generate new key) with exactly these permissions: **Linkie pages** Read Only, **Automated posts** Read & Write (the key screen labels it **Posts**, seen 2026-10-24), **Analytics** Read Only (the Linkie Hub lists pages, changes posts and reads traffic; it never writes to a page; a key made with only the old `profiles` scopes gets 403 "Insufficient scope") -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`YOUTUBE-API-KEY`** | YouTube Data API v3 | Key Vault | 365 days | Generate API key in Google Cloud Console -> update Key Vault -> restart Function App. Revoke old key. | Function App restart |
| **`PUBLER-API-KEY`** | Publer Social Scheduler | Key Vault | 180 days | Generate new API key in Publer Settings -> update Key Vault -> restart Function App. Delete old key. | Function App restart |
| **`RESEND-API-KEY`** | Resend Mailing List & Email | Key Vault | 90 days | Generate new API key in Resend dashboard with Full Access -> update Key Vault -> restart Function App. Delete old key. | Function App restart |
| **`PODBEAN-CLIENT-SECRET`** | Podbean Developer App | Key Vault | 180 days | Reset client secret in Podbean Developer Portal -> update Key Vault -> restart Function App. | Function App restart |
| **`STREAMYARD-API-KEY`** | StreamYard On-Air Webinars | Key Vault | 180 days | Generate new API key in StreamYard Integrations -> update Key Vault -> restart Function App. | Function App restart |
| **`QLTY-API-TOKEN`** | Qlty Code Quality Platform | Key Vault | 90 days | Mint new Personal Access Token in Qlty settings -> update Key Vault -> restart Function App. Revoke old token. | Function App restart |
| **`PLAUD-EMBEDDED-API-KEY`** | Plaud Audio Transcription | Key Vault | 180 days | Generate client secret in Plaud Embedded Portal -> update Key Vault -> restart Function App. | Function App restart |
| **`TELEGRAM-BOT-TOKEN`** | Telegram Alerts Bot | Key Vault | 365 days | Re-issue token via `@BotFather` -> update Key Vault -> restart Function App. | Function App restart |
| **`TELEGRAM-WEBHOOK-SECRET`** | Telegram Inbound Webhook (SEC-6) | Key Vault / Env | 90 days | Generate random string -> update Key Vault / env -> re-register via `scripts/cutover/04-telegram-webhook.ps1 -WebhookSecret`. | Zero downtime |
| **`PREVIEW-SIGNING-SECRET`** | Staging Preview HMAC Signer | Key Vault | 90 days | Generate 32-byte hex string -> update Key Vault -> restart Function App. | Function App restart |
| **`CODER-STATUS-TOKEN`** | Hybrid Lab Coder Status Proxy | Key Vault | 90 days | Issue read-only status token in Coder CLI (`coder tokens create`) -> update Key Vault -> restart Function App. | Function App restart |
| **`CODER-BROKER-TOKEN`** | Hybrid Lab visitor session broker and its clean-up timer (#1403) | Key Vault | Not decided yet: the token's user, permissions and lifetime are the owner's choice ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 4) | Mint a new token in Coder -> update Key Vault (Integrations → Keys) -> restart Function App if the page says the value is not live yet. Delete the old token in Coder only after the new value is live (the page's light is green), because a worker still holding the old value is refused once it is gone. | Function App restart; until it is picked up, visitor sessions and the timer keep using the old token |
| **Koda agent key** (`hcwk_…`, the Agent Content API, ADR 0037) | Koda, the owner's content agent in the Muse service | Cosmos `admin_config/agent_content_key:koda`, as a SHA-256 hash only; the plaintext lives in Muse's secure connector field | 180 days, and at once if Muse's handling of it is in doubt | On the AI Engine's Koda tab (<https://hybridcloudworks.com/admin/ai-engine?tab=koda>) press **Rotate key**, paste the new key into Muse's secure field, let Muse call `status` again; steps in [the runbook](../runbooks/agent-content-api.md#3-rotate-the-key). No vault, no app setting, no restart. | Zero downtime for the site; Koda gets `401` from the rotation until Muse holds the new key |
| **SWA Deployment Token** | Azure Static Web Apps | ARM / JIT OIDC (Fallback Secret) | 90 days | Minted JIT via federated OIDC (T-727). Fallback token rotated on 90-day cadence via `az staticwebapp secrets reset-api-key`. | Zero downtime |
| **Cloudflare DNS Token** | Cloudflare DNS API | TFC / GitHub Secrets | 180 days | Re-create scoped custom API token in Cloudflare -> update Terraform Cloud / GitHub repository secrets. | Zero downtime |
| **GitHub App Private Key** | Manifest & Copilot Review Apps | Key Vault / GitHub Secrets | 365 days | Generate new private key PEM in GitHub App settings -> update Key Vault / secrets -> delete old key after 7 days. | Zero downtime |
| **`/etc/hcw/labs-agent.pem`** | Lab Host Heartbeat TLS Client | Lab Host Disk | 365 days | Issue new TLS client cert signed by CA -> deploy to `/etc/hcw/labs-agent.pem` -> restart `hcw-agent`. | Zero downtime |
| **`/etc/vault.d/tls/vault.crt`** | Lab Host Vault TLS Certificate | Lab Host Disk | 365 days | Re-issue TLS cert via certbot/Let's Encrypt or internal CA -> reload Vault (`systemctl reload vault`). | Zero downtime |

---

## 2. Standard rotation procedure (Key Vault reference)

Because Azure Functions caches versionless `@Microsoft.KeyVault(...)` app settings for the lifetime of the process, use this standard sequence:

```bash
# 1. Update the secret in Key Vault
az keyvault secret set \
  --vault-name "kv-hcw-prod-cus" \
  --name "<SECRET-NAME>" \
  --value "<NEW-VALUE>"

# 2. Restart the Function App to invalidate process cache
az functionapp restart \
  --resource-group "rg-hcw-prod-web-cus" \
  --name "func-hcw-prod-cus"

# 3. Verify resolution
node scripts/check-unresolved-secrets.mjs
```

---

## 3. Auditing and compliance checks

- **Weekly automation:** `.github/workflows/monitor-unresolved-secrets.yml` runs daily and verifies all Key Vault references resolve without failure.
- **Credential Age Verification:** Quarterly review of Key Vault secret metadata (`created` and `updated` timestamps) to ensure no credential exceeds its scheduled rotation cadence.

---

## 4. State readers and infrastructure access boundaries (SEC-6)

### A. Terraform state readers
Terraform state is stored exclusively in HCP Terraform (`hcw/hcw-azure` and `hcw/hcw-lab`). The state disclosure boundary is restricted to:
1. **Workload Owner**: Interactive access via HCP Terraform user authentication (MFA-enforced).
2. **GitHub Actions CI/CD (`TFC_TOKEN`)**: Scoped to plan verification (`tfc-plan-check.yml`), deploy concurrency checks (`deploy-functions.yml`), and deploy drift monitoring (`monitor-deploy-drift.yml`).
3. **No External Storage Readers**: State is not backed by Azure Blob Storage or Amazon S3; no standing storage keys or data-plane reader identities exist for state inspection.

### B. Deny-by-default on storage and Key Vault
All data and secrets backends enforce strict deny-by-default:
- **Key Vault (`kv-site-prod-cus-01`)**: `network_acls.default_action = "Deny"`, admitting only the Functions integration subnet. Zero standing IP rules exist outside controlled maintenance windows.
- **Storage Accounts (`stsiteprodcus01`, `stsitefuncprodcus01`)**: `network_rules.default_action = "Deny"`, admitting only AzureServices and designated VNet subnets.
- **Verification**: `scripts/check-storage-keyvault-deny.mjs` verifies Key Vault and storage network postures and asserts 0 standing broad role grants (Owner, Contributor, or subscription-wide Reader).


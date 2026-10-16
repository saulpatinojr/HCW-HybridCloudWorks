# Incident playbook — Credential compromise

**What this is for:** an estate secret, API key, Entra admin credential, or operator token is suspected or confirmed leaked.

**Objective:** isolate compromised sessions within minutes, revoke affected tokens, rotate secrets in dependency order, restart affected services to clear runtime caches, and verify integrity.

---

## 1. Immediate containment: invalidate admin sessions

If an administrator's account or credential is compromised, act immediately before rotating downstream keys.

### A. Revoke Entra ID user refresh tokens
Revoking refresh tokens invalidates existing Azure AD / Entra ID sessions across all browsers and devices:

```bash
# Using Azure CLI signed in with Privileged Role Administrator or User Administrator
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/users/<ADMIN_USER_OID>/revokeSignInSessions"
```

PowerShell equivalent:
```powershell
Revoke-MgUserSignInSession -UserId "<ADMIN_USER_OID>"
```

### B. Deactivate administrator in HCW registry
Deactivate the administrator in Cosmos DB to immediately reject cached and incoming bearer tokens:

```bash
# Call the admin lifecycle endpoint with super_admin bearer token
curl -X POST "https://api-azure.hybridcloudworks.com/api/cms/admins/<ADMIN_USER_OID>" \
  -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"role": "deactivated", "active": false}'
```

*Effect:* The route records an audit entry in `admin_audit_logs` via `recordMutationAudit`, invalidates `guard.clearCache()`, and rejects all subsequent API requests with HTTP 403 Forbidden.

---

## 2. Rotation order and priority

Rotate secrets in dependency order to prevent cascade failures or lockout:

| Priority | Tier | Secrets | Rationale |
| --- | --- | --- | --- |
| **Tier 1** | Identity & Access | Entra Client Secrets, SWA Deployment Token, GitHub App Private Keys | Controls platform infrastructure and automated deployments. |
| **Tier 2** | Edge & Origin | `CF-ORIGIN-SECRET`, `CLIENT-IP-SALT`, Cloudflare DNS Token | Protects origin shielding and rate-limiting entropy. |
| **Tier 3** | Core Data & Messaging | `AWS-SECRET-ACCESS-KEY`, `GCP-BILLING-API-KEY`, `RESEND-API-KEY` | Essential data feeds and public transactional messaging. |
| **Tier 4** | Third-Party APIs | `GEMINI-API-KEY`, `ANTHROPIC-API-KEY`, `OPENAI-API-KEY`, `NVIDIA-API-KEY`, `REPLICATE-API-KEY`, `ELEVENLABS-API-KEY`, `PODBEAN-CLIENT-SECRET`, `STREAMYARD-API-KEY`, `QLTY-API-TOKEN`, `PLAUD-EMBEDDED-API-KEY` | External service integration keys. |
| **Tier 5** | Lab & Automation | `CODER-STATUS-TOKEN`, Coder OAuth Secret, `/etc/hcw/labs-agent.pem`, `TELEGRAM-BOT-TOKEN`, `PREVIEW-SIGNING-SECRET` | Internal tooling, status polling, and alerts. |

---

## 3. Secret rotation commands

### A. Key Vault secrets (Function App bindings)
For any secret referenced by `infra/functionapp.tf`:

1. Update the secret value in Azure Key Vault:
   ```bash
   az keyvault secret set \
     --vault-name "kv-hcw-prod-cus" \
     --name "<SECRET-NAME>" \
     --value "<NEW_SECRET_VALUE>"
   ```

2. **Restart the Function App:** Azure Functions caches versionless Key Vault references in process memory for the lifetime of the process. A restart forces immediate pickup:
   ```bash
   az functionapp restart \
     --resource-group "rg-hcw-prod-web-cus" \
     --name "func-hcw-prod-cus"
   ```

### B. Static Web Apps deployment token
If the SWA deployment credential in GitHub Secrets is compromised:

1. Reset the API key in Azure:
   ```bash
   az staticwebapp secrets reset-api-key \
     --resource-group "rg-hcw-prod-web-cus" \
     --name "swa-hcw-prod-cus"
   ```

2. Update GitHub Actions secret `AZURE_STATIC_WEB_APPS_API_TOKEN` via `gh`:
   ```bash
   gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN \
     --repo saulpatinojr/HCW-HybridCloudWorks \
     --body "<NEW_SWA_TOKEN>"
   ```

### C. Cloudflare Origin Secret (`CF-ORIGIN-SECRET`)
1. Set the new secret in Key Vault:
   ```bash
   az keyvault secret set --vault-name kv-hcw-prod-cus --name "CF-ORIGIN-SECRET" --value "<STRONG_RANDOM_SECRET>"
   ```
2. Restart the Function App:
   ```bash
   az functionapp restart --resource-group rg-hcw-prod-web-cus --name func-hcw-prod-cus
   ```
3. Update the matching custom header `X-Origin-Secret` in Cloudflare Transform Rules for `api-azure.hybridcloudworks.com`.

---

## 4. Post-rotation verification

1. **Verify secret resolution:**
   Run the unresolved secrets check:
   ```bash
   node scripts/check-unresolved-secrets.mjs
   ```
   Ensure no unresolved `@Microsoft.KeyVault(...)` placeholders remain.

2. **Verify public API health:**
   ```bash
   curl -sSf "https://api-azure.hybridcloudworks.com/api/health" | jq .
   ```

3. **Audit unauthorized access window:**
   Query `admin_audit_logs` in Cosmos DB for actions performed between estimated compromise time and revocation:
   ```sql
   SELECT * FROM c WHERE c.timestamp >= "2026-10-16T00:00:00Z" ORDER BY c.timestamp DESC
   ```

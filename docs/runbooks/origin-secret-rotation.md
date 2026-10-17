# Origin secret rotation — `CF-ORIGIN-SECRET`

Zero-downtime rotation procedure for the shared origin authentication secret.

!!! warning "Coordinated 3-way lock"
    Rotating `CF-ORIGIN-SECRET` requires synchronized changes across three distinct planes:
    
    1. **Azure Key Vault**: Secret `CF-ORIGIN-SECRET` in `kv-site-prod-cus-01`.
    2. **HCP Terraform**: Sensitive workspace variable `cloudflare_origin_secret` in workspace `hcw-azure`.
    3. **Cloudflare Transform Rules**: Zone ruleset `cloudflare_ruleset.origin_secret` stamping HTTP header `x-hcw-origin-secret`.
    
    A mismatch between the header sent by Cloudflare and the secret resolved by Azure Functions causes **every anonymous request and public submission to fail with HTTP 403 Forbidden** (`unverified origin`). Follow this runbook in exact sequence.

---

## 1. Architectural context

To protect the Azure Functions backend (`func-site-prod-cus-01`) from direct internet scraping and bypass attacks, the backend enforces an origin lock:

- **Network-level restriction**: Azure App Service access restrictions limit traffic to Cloudflare IP ranges (`functions_origin_lock_enabled = true`).
- **Edge transform rule**: Cloudflare Edge intercepts requests to `api-azure.hybridcloudworks.com` and rewrites request headers using an HTTP request late transform rule (`infra/frontend.tf`), stamping `x-hcw-origin-secret` with the value of `var.cloudflare_origin_secret`.
- **Application-level verification**: The Function App resolves `process.env.CF_ORIGIN_SECRET` from Key Vault via `@Microsoft.KeyVault(SecretUri=...secrets/CF-ORIGIN-SECRET)`. Every incoming request evaluated by `functions/src/lib/auth/client-identity.js` checks:

```javascript
const viaCloudflare = (request) => {
  if (!originSecret) return false;
  return request?.headers?.get?.('x-hcw-origin-secret') === originSecret;
};
```

Because Azure App Service caches resolved Key Vault secret references for up to 24 hours, updating Key Vault alone does not update runtime memory immediately without an explicit restart or ARM configuration touch.

---

## 2. Pre-flight verification

Before beginning rotation, ensure the environment is stable:

1. **Verify current edge health**:
   ```bash
   curl -fsS -i "https://api-azure.hybridcloudworks.com/api/public/addons/migration/status"
   ```
   Ensure it returns HTTP 200 with JSON payload `{ configured: ... }`.

2. **Verify no in-flight Terraform runs**:
   Ensure workspace `hcw-azure` on HCP Terraform is in state `idle` (no planning or applying runs).

3. **Verify no in-flight GitHub Actions deploys**:
   Check [Actions](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions) to ensure neither `deploy-functions.yml` nor `deploy-azure-frontend.yml` is executing.

---

## 3. Step-by-step rotation procedure

### Step 1: Generate new high-entropy secret
Generate a cryptographically secure 256-bit hexadecimal secret:

```bash
openssl rand -hex 32
```

Save this value to the owner's password manager (Bitwarden) as the staged new value for `CF-ORIGIN-SECRET`. **Never commit, log, or transmit this value over insecure channels.**

### Step 2: Update Azure Key Vault
Write the new secret value into Key Vault `kv-site-prod-cus-01`:

#### Option A: Azure CLI
```powershell
az keyvault secret set --vault-name "kv-site-prod-cus-01" --name "CF-ORIGIN-SECRET" --value "<NEW_SECRET_VALUE>"
```

#### Option B: Admin UI
Navigate to `https://hybridcloudworks.com/admin/integrations?tab=keys`, locate **Cloudflare origin secret**, paste the new secret, and save.

### Step 3: Refresh Function App runtime reference
App Service must evict the cached secret and resolve the latest version from Key Vault. Restart the Function App to make the new secret active in runtime memory immediately:

```powershell
az functionapp restart --name "func-site-prod-cus-01" --resource-group "rg-web-site-prod-cus"
```

!!! warning "Planned service interruption window"
    Because the Azure Functions runtime immediately resolves the new secret upon restart while Cloudflare continues stamping the previous secret until the Terraform apply completes, there is an unavoidable brief service interruption window (typically 30–90 seconds) during which anonymous public requests will receive HTTP 403 Forbidden (`unverified origin`). Execute Steps 4 and 5 immediately to minimize the window.

### Step 4: Update HCP Terraform workspace variable
1. Log in to [HCP Terraform](https://app.terraform.io/) and navigate to organization `hcw`, workspace `hcw-azure`.
2. Go to **Variables** &rarr; **Workspace variables**.
3. Locate `cloudflare_origin_secret` (Category: Terraform, Sensitive: `true`).
4. Click **Edit**, enter `<NEW_SECRET_VALUE>`, and click **Save variable**.

### Step 5: Plan and apply Terraform configuration
1. In workspace `hcw-azure`, click **New run** &rarr; **Start run** (Reason: `Rotate cloudflare_origin_secret`).
2. Review the speculative plan:
   - Expected change: Exactly **1 change** on `cloudflare_ruleset.origin_secret`.
   - Verify no unintended resource replacements.
3. Click **Confirm & apply**.
4. Cloudflare's global edge network will propagate the updated header rewrite rule within seconds.

---

## 4. Post-rotation verification

Perform end-to-end verification across edge and origin:

1. **Verify public endpoint via Cloudflare**:
   ```bash
   curl -fsS -i "https://api-azure.hybridcloudworks.com/api/public/addons/migration/status"
   ```
   Must return `200 OK`.

2. **Verify direct origin rejection (bypassing Cloudflare)**:
   Verify that traffic attempting to reach the Function App directly without passing through Cloudflare is rejected by App Service access restrictions:
   ```bash
   curl -i "https://func-site-prod-cus-01.azurewebsites.net/api/public/addons/migration/status"
   ```
   Must return `403 Forbidden` (`Ip Forbidden`). Note that Cloudflare's transform rule overwrites `x-hcw-origin-secret` on all proxied traffic through `api-azure.hybridcloudworks.com`.

3. **Check Application Insights live metrics**:
   Query recent traces in Log Analytics `log-plat-prod-cus-01`:
   ```kql
   AppTraces
   | where TimeGenerated > ago(15m)
   | where Message has "unverified origin"
   ```
   The result must be 0 records post-rotation.

4. **Update secret escrow record**:
   Confirm the old secret value is marked as rotated and archived in the owner's Bitwarden vault.

---

## 5. Rollback procedure

If Cloudflare rule application fails or the Function App cannot resolve the new secret:

1. Retrieve the `<PREVIOUS_SECRET_VALUE>` from Bitwarden history.
2. Re-set Key Vault:
   ```powershell
   az keyvault secret set --vault-name "kv-site-prod-cus-01" --name "CF-ORIGIN-SECRET" --value "<PREVIOUS_SECRET_VALUE>"
   ```
3. Restart Function App:
   ```powershell
   az functionapp restart --name "func-site-prod-cus-01" --resource-group "rg-web-site-prod-cus"
   ```
4. Revert `cloudflare_origin_secret` in HCP Terraform workspace `hcw-azure` to `<PREVIOUS_SECRET_VALUE>` and apply.
5. Re-run verification curl in §4.

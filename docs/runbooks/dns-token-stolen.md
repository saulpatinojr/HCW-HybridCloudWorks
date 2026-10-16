# Incident playbook — DNS token stolen

**What this is for:** the Cloudflare API token (`CLOUDFLARE_API_TOKEN` used for edge DNS verification and Terraform Cloud infrastructure runs) is compromised, leaked, or exposed in an un-sanitized log.

**Impact:** an attacker possessing the token could redirect traffic for `hybridcloudworks.com`, point records to malicious servers, bypass Cloudflare WAF, or issue unauthorized origin certificates.

---

## 1. Immediate containment (Revocation)

Revoke the token immediately in the Cloudflare dashboard:

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Go to **My Profile** -> **API Tokens**.
3. Locate the token used for HCW (e.g. `HCW DNS Verification & Terraform`).
4. Click the three dots menu -> **Revoke**.
5. Confirm revocation. The token becomes inactive globally within 30 seconds.

---

## 2. Audit DNS and zone modifications

Determine whether any unauthorized alterations occurred prior to token revocation:

1. In Cloudflare, navigate to **Account Home** -> **Audit Log**.
2. Filter the events for the past 72 hours:
   - Filter by Action: `dns_record_create`, `dns_record_update`, `dns_record_delete`, `zone_setting_change`, `page_rule_create`, `custom_ssl_create`.
   - Filter by Token: identify calls authenticated by the compromised token.
3. Check active DNS records:
   Verify that all live DNS entries match `infra/cloudflare.tf`:
   - `hybridcloudworks.com` -> SWA alias / apex
   - `www.hybridcloudworks.com` -> SWA alias
   - `api-azure.hybridcloudworks.com` -> `func-hcw-prod-cus.azurewebsites.net`
   - `lab.hybridcloudworks.com` -> Lab host IPv4
4. If unauthorized records were created or modified:
   - Delete rogue records immediately via the Cloudflare dashboard.
   - Purge Cloudflare edge cache completely (Caching -> Configuration -> Purge Everything).

---

## 3. Issue replacement token with least privilege

Issue a replacement token strictly restricted to needed permissions:

1. In Cloudflare Dashboard -> **API Tokens** -> **Create Token**.
2. Select **Create Custom Token**:
   - **Token Name:** `hcw-dns-automation-2026`
   - **Permissions:**
     - `Zone` -> `DNS` -> `Edit`
     - `Zone` -> `Zone` -> `Read`
   - **Zone Resources:**
     - `Include` -> `Specific zone` -> `hybridcloudworks.com`
   - **Client IP Address Filtering (Recommended):**
     - Restrict to known Terraform Cloud runner IP blocks or operator CIDRs if static.
   - **TTL:**
     - Set an expiration date (e.g. 180 days).
3. Generate and copy the new token.

---

## 4. Update secrets in the estate

1. **Update Terraform Cloud:**
   - In Terraform Cloud -> Workspace `hcw` -> **Variables**.
   - Update `CLOUDFLARE_API_TOKEN` (marked Sensitive).

2. **Update Key Vault (if applicable):**
   ```bash
   az keyvault secret set \
     --vault-name "kv-hcw-prod-cus" \
     --name "CLOUDFLARE-API-TOKEN" \
     --value "<NEW_CLOUDFLARE_TOKEN>"
   ```

3. **Update GitHub Actions repository secret (if used in workflows):**
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN \
     --repo saulpatinojr/HCW-HybridCloudWorks \
     --body "<NEW_CLOUDFLARE_TOKEN>"
   ```

---

## 5. Post-rotation verification

Run the automated edge and DNS verification suite:

```powershell
./scripts/edge/Verify-EdgeDns.ps1 -Domain "hybridcloudworks.com"
```

Verify that:
- Global DNS resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9) resolve apex and subdomains to expected Cloudflare proxy IPs.
- Origin certificates and proxy status are intact.
- HTTP to HTTPS redirection and TLS 1.3 negotiation pass.

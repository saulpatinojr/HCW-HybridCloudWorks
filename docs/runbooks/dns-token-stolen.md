# Incident playbook — DNS token stolen

**What this is for:** the Cloudflare API token Terraform uses (`hcp-terraform-cloudflare-dns` in the Cloudflare dashboard, held as the variable `cloudflare_api_token` in the HCP Terraform workspace `hcw-azure`) is compromised, leaked, or exposed in an un-sanitized log. The lab host's Caddy token and the site's Cloudflare admin token (`CLOUDFLARE-ADMIN-TOKEN`, used by Claude Network Guy) are separate tokens, not covered here.

**Impact:** an attacker possessing the token could redirect traffic for `hybridcloudworks.com`, point records to malicious servers, bypass Cloudflare WAF, or issue unauthorized origin certificates.

---

## 1. Immediate containment (Revocation)

Revoke the token immediately in the Cloudflare dashboard:

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Go to **My Profile** -> **API Tokens**.
3. Locate `hcp-terraform-cloudflare-dns`. Leave the lab host's Caddy token and the site's Cloudflare admin token alone; they are different tokens.
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
   Verify that all live DNS entries match the `cloudflare_dns_record` resources in `infra/frontend.tf`, `infra/functionapp.tf` and `infra-lab/dns.tf`:
   - `hybridcloudworks.com` -> SWA alias / apex
   - `www.hybridcloudworks.com` -> SWA alias
   - `api-azure.hybridcloudworks.com` -> `func-site-prod-cus-01.azurewebsites.net`
   - `lab.hybridcloudworks.com` -> Lab host IPv4
4. If unauthorized records were created or modified:
   - Delete rogue records immediately via the Cloudflare dashboard.
   - Purge Cloudflare edge cache completely (Caching -> Configuration -> Purge Everything).

---

## 3. Issue replacement token with least privilege

Issue a replacement token strictly restricted to needed permissions:

1. In Cloudflare Dashboard -> **API Tokens** -> **Create Token**.
2. Select **Create Custom Token**:
   - **Token Name:** `hcp-terraform-cloudflare-dns` (the name `infra/variables.tf`
     and `docs/standards/required-inputs.md` use for this token)
   - **Permissions** (the same list as `cloudflare_api_token` in
     `infra/variables.tf`; a token with less fails the apply on the
     resource that needs the missing permission):
     - `Zone` -> `DNS` -> `Edit`
     - `Zone` -> `Zone` -> `Read`
     - `Zone` -> `Transform Rules` -> `Edit` (the origin secret rule)
     - `Account` -> `Account Rulesets` -> `Read`
     - `Account` -> `Account Settings` -> `Edit` (the Web Analytics site;
       the dashboard's `Edit` is the permission the API reference and
       `infra/variables.tf` call `Write`)
   - **Zone Resources:**
     - `Include` -> `Specific zone` -> `hybridcloudworks.com`
   - **Account Resources** (needed because two permissions above are
     Account permissions; without it the token cannot manage the Web
     Analytics site):
     - `Include` -> the account that owns `hybridcloudworks.com`
   - **Client IP Address Filtering (Recommended):**
     - Restrict to known Terraform Cloud runner IP blocks or operator CIDRs if static.
   - **TTL:**
     - Set an expiration date (e.g. 180 days).
3. Generate and copy the new token.

---

## 4. Update secrets in the estate

The token lives in one place only: the sensitive Terraform variable
`cloudflare_api_token` in the HCP Terraform workspace `hcw-azure`. It is not
in Key Vault and not a GitHub Actions secret (the credential register,
`functions/src/lib/credentials/register.js`, row
`tfc-azure-cloudflare-api-token`, records it as stored in that workspace;
`functions/src/lib/secret-catalog.js` has no Key Vault entry for it).

1. Open [hcw-azure → Variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables).
2. Edit `cloudflare_api_token`, paste the new token into the value field
   (it stays marked **Sensitive**), and save. Do not paste it anywhere else,
   chat included.
3. Check that the old token shows as revoked on the Cloudflare **API Tokens**
   page (section 1 revoked it). If it is still active, go back to section 1.

The roll script (`scripts/roll-cloudflare-tokens.mjs`), used for routine
renewal, does not fit here: it rolls an existing token, and step 1 has
already revoked this one. Use the new token from section 3.

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

# Incident playbook — DNS token stolen

**What this is for:** the Cloudflare API token Terraform uses for the site is compromised, leaked, or exposed in an un-sanitized log. That token is the **account-owned** token **`hcw`** (it belongs to the Cloudflare account rather than to a person, and lives under **Manage account → Account API tokens**), held as the sensitive variable `cloudflare_api_token` in the HCP Terraform workspace `hcw-azure`. The lab host's Caddy token, the `hcw-lab` workspace's token (`hcp-terraform-cloudflare-dns`, see [Which token is which](#which-token-is-which)) and the site's Cloudflare admin token (`CLOUDFLARE-ADMIN-TOKEN`, used by Claude Network Guy) are separate tokens, not covered here.

**Impact:** an attacker possessing the token could redirect traffic for `hybridcloudworks.com`, point records to malicious servers, or change the origin secret rule that tells the API a request came through Cloudflare.

---

## Which token is which

Cloudflare has two kinds of API token
([Cloudflare: account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)):

- a **user token** belongs to one person's profile and is listed under **My Profile → API Tokens**;
- an **account-owned token** belongs to the account and is listed under **Manage account → Account API tokens** (some Cloudflare pages call this page **Manage account → API Tokens**; it is the one under **Manage account**, not under **My Profile**).

They are renewed ("rolled") through different API routes, so the kind matters
to the renewal script as well as to where you look in the dashboard.

| HCP Terraform workspace | Token (dashboard name) | Kind | How sure |
| --- | --- | --- | --- |
| `hcw-azure` (the site, `infra/`) | `hcw` | account-owned | **Observed** 2026-11-27 ([#1927](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1927)): its "last used" time matched `hcw-azure` runs to the second several times, and adding a permission to it is what turned the [#1926](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1926) trial plan green. The daily DNS audit also sees this workspace's DNS edits as an account-owned token ([edge DNS verification runbook](edge-dns-verification.md), the `hcp-terraform` entry). |
| `hcw-lab` (the lab, `infra-lab/`) | `hcp-terraform-cloudflare-dns` | user | **Observed** 2026-11-28 ([#1927](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1927)): the owner ran the check below, and both plan-only `hcw-lab` runs moved only this token's **Last used** time into the run's window; every other token, on both tokens pages, was last used more than an hour earlier, or before the run started. Until 2026-11-27 this repository wrongly named it as `hcw-azure`'s token. |

**To confirm the lab's token** (owner, about ten minutes, nothing changes). A matching time from some earlier run is not proof, because another use of the token could fall in the same minute. So the check causes two uses of its own and watches which token moves each time:

1. Make sure nothing else is using Cloudflare: no run in progress on <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs> or <https://app.terraform.io/app/hcw/workspaces/hcw-lab/runs>.
2. Open <https://dash.cloudflare.com/profile/api-tokens/> (**My Profile → API Tokens**) and write down **Last used** for every token listed there, including `hcp-terraform-cloudflare-dns`, the token believed to be `hcw-lab`'s.
3. On the `hcw-lab` run list, start a plan-only run (**New run → Plan only**, which changes nothing) and wait for it to finish. Note the time the plan started and the time it finished.
4. Reload the API tokens page. `hcp-terraform-cloudflare-dns` passes this round as the `hcw-lab` token only if its **Last used** moved to a time between the plan's start and finish, and no other token on the page moved into that window.
5. Repeat steps 2 to 4 once more. If both rounds pass, it is the `hcw-lab` token: say so on [#1927](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1927), and a session changes `tokenNameConfirmed` to `true` for the `lab` target in `functions/src/lib/credentials/cloudflare-roll.js`. If either round does not pass, it is not confirmed: say what you saw on #1927, and change nothing on the token (do not trim it) until a session has looked.

Never open the workspace variable's value; its description, if it has one, is enough.

The same check works for `hcw-azure` and `hcw`, on **Manage account → Account API tokens**. Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>.

---

## 1. Immediate containment (Revocation)

Revoke the token immediately in the Cloudflare dashboard:

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com) and pick the account that owns `hybridcloudworks.com`.
2. Go to **Manage account** -> **Account API tokens**. (Not **My Profile** -> **API Tokens**: `hcw` is account-owned, so it is not listed there.) Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>.
3. Locate `hcw`. Leave the lab host's Caddy token, `hcp-terraform-cloudflare-dns` (the `hcw-lab` workspace's) and the site's Cloudflare admin token alone; they are different tokens.
4. Click the three dots menu -> **Delete** (the dashboard may call it **Revoke**).
5. Confirm. Every `hcw-azure` plan and apply now fails at sign-in until section 4 is done; nothing already in place changes.

---

## 2. Audit DNS and zone modifications

Determine whether any unauthorized alterations occurred prior to token revocation:

1. In Cloudflare, navigate to **Account Home** -> **Audit Log**. Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>.
2. Filter the events for the past 72 hours:
   - Filter by Action: `dns_record_create`, `dns_record_update`, `dns_record_delete`, `zone_setting_change`, `page_rule_create`, `custom_ssl_create`.
   - Filter by Token: identify calls authenticated by the compromised token.
3. Check active DNS records:
   Compare every live DNS entry with the record table in
   [`edge-dns-verification.md`](edge-dns-verification.md), which lists each
   site record and where it is declared, and the lab records with
   `infra-lab/dns.tf`. Three kinds:
   - **Made by Terraform:** the `cloudflare_dns_record` resources in
     `infra/frontend.tf`, which since
     [#1929](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1929)
     include the apex `hybridcloudworks.com` and `www` (`site_apex`,
     `site_www`, pointing at the Static Web App) as well as `api-azure`,
     `docs`, `notes` and the ownership TXT records; the table lists them.
   - **Lab records, made by Terraform in `infra-lab/dns.tf`:** the `lab`
     records and the two `_acme-challenge` delegation CNAMEs. The table does
     not list these, so compare them with that file directly.
   - **Made by hand, not in Terraform:** the apex TXT record that proves
     ownership to Azure and the other records the table marks as kept by
     hand. Check them against the table, not against the Terraform files.
4. If unauthorized records were created or modified:
   - Delete rogue records immediately via the Cloudflare dashboard.
   - Purge Cloudflare edge cache completely (Caching -> Configuration -> Purge Everything).

---

## 3. Issue replacement token with least privilege

Make the replacement as an account-owned token again, so it keeps working
whoever signs in to Cloudflare, and give it only what `infra/` uses
(the list and its reasons are in [The permissions `hcw` needs](#the-permissions-hcw-needs)):

1. In Cloudflare Dashboard -> **Manage account** -> **Account API tokens** -> **Create Token**. Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>.
2. Select **Create Custom Token**:
   - **Token Name:** `hcw` (the name `functions/src/lib/credentials/cloudflare-roll.js`,
     the credential register and `scripts/lib/dns-audit-settings.mjs` use
     for this token; a test fails if they disagree)
   - **Permissions:**
     - `Zone` -> `Zone` -> `Read`
     - `Zone` -> `DNS` -> `Edit`
     - `Zone` -> `Transform Rules` -> `Edit` (the origin secret rule)
     - `Account` -> `Account Settings` -> `Read` (the Web Analytics site's
       read, #1923; without it even a plan fails with
       "Authentication error (10000)", seen 2026-11-27)
     - `Account` -> `Account Settings` -> `Edit` (the Web Analytics site's
       update, #1923; the dashboard's `Edit` is the permission the API
       reference calls `Write`)
   - **Zone Resources:**
     - `Include` -> `Specific zone` -> `hybridcloudworks.com`
   - **Client IP Address Filtering:** leave empty. HCP Terraform's runners
     have no fixed addresses, so a filter would break every run.
   - **TTL:** leave it without an end date, or set one more than 180 days
     out. The credential register reminds the owner to roll this token
     every 180 days (row `tfc-azure-cloudflare-api-token`); nothing
     reminds anyone of a Cloudflare end date, so an earlier one would
     break `hcw-azure` before the reminder comes.
3. Generate and copy the new token. Paste it only into the field in section 4.

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
3. Check that the old token is gone from **Manage account** -> **Account API
   tokens** (section 1 deleted it). Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>. If it is still listed, go back to section 1.
4. If the new token has a new id, update `CLOUDFLARE_AZURE_TOKEN_ID` wherever
   you keep it for the roll script (below). The id is not a secret; it is
   shown on the token's page.

The roll script (`scripts/roll-cloudflare-tokens.mjs`), used for routine
renewal, does not fit here: it rolls an existing token, and step 1 has
already deleted this one. Use the new token from section 3.

---

## 5. Post-rotation verification

1. Start a plan-only run in `hcw-azure`: open
   <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>, choose
   **New run**, pick **Plan only**, and start it. A plan only reads; nothing is
   changed and there is nothing to confirm.
2. When the plan has finished, run the plan check from `main`:
   <https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/tfc-plan-check.yml>
   → **Run workflow** (a session can do this for you). **Worked:** the run is
   green and its summary says the plan is expected. **Failed with "could not
   be read" or an authentication error:** the token is wrong or missing a
   permission; compare it with section 3.
3. Run the edge and DNS verification suite:

```powershell
./scripts/edge/Verify-EdgeDns.ps1 -Domain "hybridcloudworks.com"
```

Verify that:
- Global DNS resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9) resolve apex and subdomains to expected Cloudflare proxy IPs.
- Origin certificates and proxy status are intact.
- HTTP to HTTPS redirection and TLS 1.3 negotiation pass.

---

## Routine renewal (no incident)

`scripts/roll-cloudflare-tokens.mjs` rolls a token in place (Cloudflare
issues a new value with the same permissions and retires the old one at
once) and writes the new value straight back to the workspace variable.
**Nothing runs it on a schedule:** a person runs it when the credential
register's reminder comes (every 180 days, on the
[Credentials tab](https://hybridcloudworks.com/admin/integrations?tab=credentials)),
because a scheduled roll would need a stored secret that can roll tokens,
and that is the owner's decision
([#1927](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1927)).
**Run it once at a time.** Two runs for the same target at once can each
roll the token, and the slower write can then put the value the other run
already retired back into the store; the script has no lock, because only
the owner runs it, by hand. If a run stops part-way, read what it printed
before starting another.
Since [#1927](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1927)
it knows both kinds of token:

| Target | Kind | Cloudflare route | Permission the roll token needs |
| --- | --- | --- | --- |
| `azure` (`hcw`) | account-owned | `PUT /accounts/{account_id}/tokens/{token_id}/value` ([Roll Token, account](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/value/methods/update/)) | Account API Tokens Write |
| `lab`, `caddy` | user | `PUT /user/tokens/{token_id}/value` ([Roll Token, user](https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/value/methods/update/)) | API Tokens Write |

For the `azure` target the script also needs `CLOUDFLARE_ACCOUNT_ID` (the
account id, an identifier and not a secret; the same value as the repository
variable of that name) and checks it before it rolls anything, so a missing
id can never leave the workspace with a retired token. If the general roll
token (`CLOUDFLARE_ROLL_TOKEN`) cannot roll account-owned tokens, give one
that can in `CLOUDFLARE_ACCOUNT_ROLL_TOKEN`. `--dry-run` shows the route each
target would take without calling anything.

Before it rolls anything, the script also checks that the credentials
the write will use are allowed to write each store. For an HCP Terraform
workspace it looks the workspace up with `TFC_TOKEN`, lists its
variables, and requires HCP Terraform to say the token may change them
(`can-update-variable` in the
[Show workspace](https://developer.hashicorp.com/terraform/cloud-docs/api-docs/workspaces)
answer). For the `caddy` target it asks `sudo -n -l` whether
`/usr/local/sbin/hcw-vault-set` may run without a password. If any check
says no, it stops with nothing rolled, and the old values keep working.
These checks prove permission, not that the write itself will succeed:
a network failure can still come between the roll and the write, which
is what the next paragraph is for.

**If it says it rolled a token but failed to write it.** The roll cannot
be undone: the old value has stopped working, and `hcw-azure` plans fail
at sign-in until the variable holds the new one. Roll the token again by
hand and store that value yourself:

1. Open <https://dash.cloudflare.com>, pick the account that owns
   `hybridcloudworks.com`, and go to **Manage account** -> **Account API
   tokens**. Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>.
2. Beside `hcw`, choose **Roll** from the three dots menu, confirm, and
   copy the new value Cloudflare shows once.
3. Open <https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables>,
   edit `cloudflare_api_token`, paste the value (it stays **Sensitive**),
   and save. Paste it nowhere else.
4. Check it with steps 1 and 2 of section 5.

For the `lab` target the same steps use **My Profile → API Tokens**
(<https://dash.cloudflare.com/profile/api-tokens/>) and
<https://app.terraform.io/app/hcw/workspaces/hcw-lab/variables>.

For the `caddy` target (the lab host's certificate token, a user token),
as its credential register row says: roll the token on
<https://dash.cloudflare.com/profile/api-tokens/> and copy the new value;
set `vault_cloudflare_api_token` on the host with this PowerShell line,
which sends the value on standard input and never on the command line
(the same pattern as the `hcw-vault-set` line in `lab-host/README.md`,
"The vault"):

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_cloudflare_api_token"
```

then re-run `bootstrap.sh` on the host, as `lab-host/README.md` describes,
so Caddy reads the new value. **Worked:** the line prints no error, and
the next certificate renewal on the lab host succeeds.

---

## The permissions `hcw` needs

What `infra/` asks Cloudflare to do, and the permission each needs. The
endpoints' accepted permissions are from Cloudflare's API schema, read
2026-11-27.

| Permission | Why | Where in `infra/` |
| --- | --- | --- |
| Zone → Zone → Read | reading the zone that every record and the rule belong to (they name it by `zone_id`); a read only | `zone_id = var.cloudflare_zone_id`, e.g. `infra/frontend.tf:196`, `:564` |
| Zone → DNS → Edit | the DNS records | `cloudflare_dns_record` at `infra/frontend.tf:195` (`site_apex`), `:212` (`site_www`), `:238` (`azure_functions`), `:276` (`docs_pages`), `:316` (`podcast_podbean`), `:361` (`linkie_go`), `:376` (`linkie_go_verification`), `:418` (`notes_obsidian_publish`), `:531` (`azure_functions_domain_verification`) |
| Zone → Transform Rules → Edit | the origin secret rule, a zone ruleset in phase `http_request_late_transform` | `cloudflare_ruleset.origin_secret`, `infra/frontend.tf:561` (phase at `:567`) |
| Account → Account Settings → Read | reading the Web Analytics site (import and every plan) | `cloudflare_web_analytics_site.hcw`, `infra/frontend.tf:763`, its import at `:757` |
| Account → Account Settings → Edit | updating the Web Analytics site | the same resource |

**Not needed, though earlier docs named it:** Account → Account Rulesets →
Read. Cloudflare's schema accepts Transform Rules Write on its own for every
zone ruleset call the provider makes (read, create, update, delete), and
`hcw` does not carry Account Rulesets Read today (read 2026-11-27) while `hcw-azure` plans read
the rule cleanly. Add it only if a ruleset change one day fails with
"Authentication error (10000)".

**On `hcw` today but unused** (read 2026-11-27): Zone → WAF → Edit and
Zone → Origin → Edit on the zone, and Account → Resource Sharing → Read on
the account. Nothing in `infra/` uses a WAF rule, an origin rule or resource
sharing; the API rate limit, the one WAF-type rule the site has, moved to
the Cloudflare admin page in
[#1908](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1908).

### Owner steps: trim `hcw` to that list

Nothing here deletes data or costs money, and every step can be undone by
adding the permission back.

1. Open <https://dash.cloudflare.com> and pick the account that owns
   `hybridcloudworks.com`.
2. Go to **Manage account** -> **Account API tokens**, find `hcw`, and choose
   **Edit** from the three dots menu beside it. Cloudflare publishes no direct link to this page; start from <https://dash.cloudflare.com>.
3. In the **zone** permission rows, remove **WAF** (Edit) and **Origin**
   (Edit). Leave **Zone** (Read), **DNS** (Edit) and **Transform Rules**
   (Edit), and leave the zone resource as `hybridcloudworks.com`.
4. In the **account** permission rows, remove **Resource Sharing** (Read).
   Leave **Account Settings** (Read) and **Account Settings** (Edit).
5. Choose **Continue to summary**, check that the summary lists exactly the
   five permissions in the table above, then **Update token**. The token's
   value does not change, so nothing in HCP Terraform needs updating.
6. Prove nothing broke: steps 1 and 2 of section 5 (a plan-only run in
   `hcw-azure`, then the plan check). **Worked:** the plan check is green and
   says the plan is expected. A plan exercises the reads (records, the rule,
   the Web Analytics site); the three Edit permissions kept above are the
   ones the next real apply uses, and none of them was touched.
   **If the plan fails with "Authentication error (10000)":** add back the
   permission you removed last, run the plan again, and say on
   [#1927](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1927)
   which one it was.

### Owner steps: put `hcp-terraform-cloudflare-dns` back to the `hcw-lab` token's two permissions

On 2026-11-27, when it was wrongly believed to be `hcw-azure`'s token,
`hcp-terraform-cloudflare-dns` was given Transform Rules, Account Settings
and Account Rulesets permissions. It was confirmed as the `hcw-lab` token on
2026-11-28 ([Which token is which](#which-token-is-which)), so put it back to what
`infra-lab/dns.tf` needs, which is DNS records and nothing else
(`infra-lab/variables.tf`, the `cloudflare_api_token` description):

1. Open <https://dash.cloudflare.com/profile/api-tokens/> (**My Profile** ->
   **API Tokens**; it is a user token), and choose **Edit** beside
   `hcp-terraform-cloudflare-dns`, the `hcw-lab` token.
2. Keep exactly two permissions: **Zone → Zone → Read** and **Zone → DNS →
   Edit**, with the zone resource **Specific zone → `hybridcloudworks.com`**.
   Remove **Transform Rules**, both **Account Settings** rows and **Account
   Rulesets**, and remove the account resource if one is left with nothing
   to grant.
3. Continue to the summary, check it lists only those two permissions on
   that one zone, then **Update token**.
4. Prove it: start a plan-only run in `hcw-lab` at
   <https://app.terraform.io/app/hcw/workspaces/hcw-lab/runs> (**New run →
   Plan only**). **Worked:** the plan finishes with no errors and no changes
   to the `cloudflare_dns_record` resources. **If it fails with an
   authentication error:** the token was not the lab's after all, or the lab
   needs more; add the permissions back and say so on #1927.

If it turns out **not** to be the lab's token, leave it alone and ask on
#1927: a token nobody uses should be deleted rather than trimmed, and that is
the owner's call.

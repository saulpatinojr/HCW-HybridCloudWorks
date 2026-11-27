# Proxying the site's own names through Cloudflare

> **Status: prepared, nothing switched.** Ticket
> [#1929](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1929).
> The two records are in Terraform with the switch at `"none"`, so they stay
> exactly as they were made: DNS-only (the grey cloud), answering straight
> from Azure.

**Scope:** putting `hybridcloudworks.com` (the apex, the bare name) and
`www.hybridcloudworks.com` behind Cloudflare's proxy (the orange cloud), the
order to do it in, the check after each step, and how to go back.

**Why at all:** Cloudflare Web Analytics can only count the site's own pages
when Cloudflare proxies them (#1929 has the history), and the proxy also puts
the pages behind the zone's firewall and DDoS protection. It costs nothing on
the Free plan.

**Authority:** the switch is a Terraform workspace variable, so changing it is
the owner's (a workspace edit and a confirmed run). The zone settings in
Part 2 are owner-only settings on the
[Cloudflare admin page](https://hybridcloudworks.com/admin/cloudflare)
([Cloudflare admin runbook](cloudflare-admin.md)).

## What the switch is

The two records are `cloudflare_dns_record.site_apex` and
`cloudflare_dns_record.site_www` in
[`infra/frontend.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/frontend.tf).
Both are CNAMEs (a record that says "this name is another name") to the
Static Web App's own default host name. One workspace variable decides which
of them Cloudflare proxies:

| `site_proxied_hosts` | `www` | apex |
| --- | --- | --- |
| `"none"` (the default) | DNS-only, TTL 60 seconds | DNS-only, TTL automatic |
| `"www"` | proxied | DNS-only |
| `"both"` | proxied | proxied |

There is no value for the apex alone, on purpose: `www` goes first. A proxied
record always has TTL automatic (Cloudflare's rule, and Terraform sets it).
Both records carry `prevent_destroy`, so a plan that would delete either one
stops instead.

## How every run in this runbook is checked

The plan check (`tfc-plan-check`, a workflow that reads the plan HCP
Terraform is holding and compares it with a list of expected changes) only
passes a change that is **declared** in `scripts/assert-expected-plan.mjs`
on `main`. It reads that list from `main`, not from the run's commit, so the
declaration has to be merged before the run is checked.

**Before each switch step**, a session prepares a small pull request that
declares exactly that step's change (the table below), and merges it. The
owner changes the variable only after that pull request has merged.

**Both directions are declared together.** The pull request for a forward
step also declares going back from it, so a rollback checks clean from the
first moment. For `www` that means the first two rows of the table: both
are on `main` from the pull request that declared step 1, and both stay
there until `www` is settled, so a run in either direction reads as
DECLARED. They are removed in the pull request that declares step 4 (the
apex), or when `www` goes back to `none` for good.

The declarations for one row share a `step` name in
`scripts/assert-expected-plan.mjs`, so they count only together: a plan
that carries part of a row (`www` proxied with its `ttl` still `60`, say)
reads UNEXPECTED and names the part that is missing. The `modified_on` line
alone never counts as a row, because any change to the record leaves it
unknown; a change outside the table (a new comment on `www`, say) is named
on its own as UNEXPECTED.

| Step | Variable change | What the pull request declares (and nothing else) |
| --- | --- | --- |
| Part 3, step 1 | `none` to `www` | `cloudflare_dns_record.site_www`: `proxied` `false` -> `true`, `ttl` `60` -> `1`, `modified_on` known after apply. Step `#1929 step 1`, **declared, with the next row, in the pull request that closes this row; see the CHANGELOG.** |
| Part 3, step 2 (test) and any rollback of `www` | `www` to `none` | `cloudflare_dns_record.site_www`: `proxied` `true` -> `false`, `ttl` `1` -> `60`, `modified_on` known after apply. Step `#1929 step 1 back`, **declared in the same pull request as step 1**. |
| Part 3, step 2 (back on) | `none` to `www` | the step 1 row, still on `main` (both `www` rows stay until `www` is settled) |
| Part 3, step 4 | `www` to `both` | `cloudflare_dns_record.site_apex`: `proxied` `false` -> `true`, `modified_on` known after apply. The same pull request declares the next row and removes the two `www` rows. |
| Any rollback of the apex | `both` to `www` | `cloudflare_dns_record.site_apex`: `proxied` `true` -> `false`, `modified_on` known after apply |

Then, for every run:

1. Set the variable at
   <https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables> (a
   plain Terraform variable named `site_proxied_hosts`, not sensitive, HCL
   off) and save it.
2. Start a run at <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>
   (**New run**, plan and apply). Wait until it stops at **Needs Confirmation**.
   Do not confirm yet.
3. Open
   <https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/tfc-plan-check.yml>,
   select **Run workflow**, leave the branch at `main` and both boxes empty
   (it then reads the workspace's latest run), and select **Run workflow**.
4. Open the run when it finishes and read its summary. **A pass** is a green
   run whose summary starts **Expected.** ("The plan carries only the known
   permanent diff, plus any change declared ... Safe to confirm.") and lists
   each change of this step as `DECLARED`. **UNEXPECTED** means the plan holds
   something not in the table: do not confirm, and give the run link to a
   session. **Could not read the plan** says nothing about the plan: run it
   again, and if it repeats, give the link to a session.
5. Confirm the run in HCP Terraform (**Confirm & Apply**).

**In an emergency rollback** where the going-back declarations are somehow
not on `main` yet, do not wait for a pull request: read the plan in HCP
Terraform yourself, check it holds only the row for that rollback above, and
confirm it. The plan check will say UNEXPECTED for that run, which is
expected; a session adds the declaration afterwards.

## Part 1. Bring the two records under Terraform (done 2026-11-27)

This happened once and is finished. The pull request for #1929 step 2 added
the two records with the switch at `"none"`, together with two pieces needed
only for that first run: a lookup that found each hand-made record by name
(so no record id was ever written in the repository), and an import block
for each (an instruction that tells Terraform to take over a record that
already exists instead of making a new one). The plan check declared exactly
what that run would do: for each record, the import, the `comment` going
from empty to a sentence naming the switch, and two timestamps Cloudflare
sets when the comment is written.

The owner applied that run on 2026-11-27. Cloudflare shows both records
carrying their new comments since about 19:21 UTC, still DNS-only, the apex
at TTL 1 (automatic) and `www` at TTL 60. So both records are in Terraform's
state (its record of what it manages), and
[#1937](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1937)
then removed the lookup, the import blocks and the plan check's eight
declarations. Without the lookup, a record changed or deleted by hand no
longer stops every plan in the workspace: the next plan simply shows the
record being put back as `infra/frontend.tf` describes it, and the plan check
reports that as unexpected for someone to read.

## Part 2. Before the switch (each is harmless while the names are DNS-only)

1. **The live pages carry no hand-placed beacon.** The beacon is the small
   Web Analytics script. Once proxied, Cloudflare adds its own, so a
   hand-placed one would count every view twice. Ask the Static Web App
   directly (its default name bypasses Cloudflare):

    ```powershell
    $h = (Invoke-WebRequest -Uri 'https://calm-ground-0d0e6a010.7.azurestaticapps.net/' -UseBasicParsing).Content; [pscustomobject]@{ HandPlacedBeacon = ($h -match 'beacon\.min\.js') }
    ```

    **Success:** `HandPlacedBeacon` is `False`. On 2026-11-27 it was `True`:
    the `CF_WEB_ANALYTICS_TOKEN` variable was deleted after the last frontend
    deploy. If it reads `True`, run the
    [frontend deploy](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-azure-frontend.yml)
    from `main` (**Run workflow**) and check again once it is green. Never set
    `CF_WEB_ANALYTICS_TOKEN` again.

2. **One configuration rule for the two names**, on the
   [Cloudflare admin page](https://hybridcloudworks.com/admin/cloudflare)
   (Rules, phase `http_config_settings`), signed in as super admin. A
   configuration rule changes settings only for the requests it matches, and
   only on proxied names
   ([Configuration Rules](https://developers.cloudflare.com/rules/configuration-rules/)),
   so it does nothing until the switch.
    - When: `(http.host in {"hybridcloudworks.com" "www.hybridcloudworks.com"})`
    - SSL: **Strict**. Cloudflare then checks the Static Web App's
      certificate on the leg between Cloudflare and Azure
      ([Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)).
      The zone itself stays **Full**, because `notes` (Obsidian Publish) asks
      for Full and the edge check of `notes` in
      [Edge and DNS verification](edge-dns-verification.md) explains why it
      is not moved.
    - Email Obfuscation: **off**, and Automatic HTTPS Rewrites: **off**. Both
      rewrite the page's HTML on the way through; the pages are prerendered
      React, and a rewritten page no longer matches what the browser builds
      from it. Email Obfuscation also needs a looser script policy than the
      site has
      ([CSPs with Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/)).

    **How to add it.**

    1. On the admin page, open **Rules**, then the phase
       `http_config_settings`, then **Edit these rules**.
    2. The editor takes a JSON list: the whole list of rules in that phase.
       The phase holds no rules today (Cloudflare answered "not found" for
       it on 2026-11-27), so replace everything in the box with exactly
       this, then **Replace the rules**:

        ```json
        [
          {
            "description": "Site apex and www: strict origin check, no HTML rewriting (#1929)",
            "expression": "(http.host in {\"hybridcloudworks.com\" \"www.hybridcloudworks.com\"})",
            "action": "set_config",
            "action_parameters": {
              "ssl": "strict",
              "email_obfuscation": false,
              "automatic_https_rewrites": false
            },
            "enabled": true
          }
        ]
        ```

       The `\"` inside `expression` is how JSON writes a quotation mark
       inside text; Cloudflare stores it as
       `(http.host in {"hybridcloudworks.com" "www.hybridcloudworks.com"})`.
       The field names are Cloudflare's configuration rule settings
       ([Configuration Rules settings](https://developers.cloudflare.com/rules/configuration-rules/settings/)).
    3. **Success:** the phase shows one rule with that description, and
       Cloudflare has given it an `id`. If the phase already holds rules
       (someone added one since), keep them in the list and add this one
       at the end, instead of replacing them.

3. **Three zone settings**, owner only, on the same page (Settings) or in the
   Cloudflare dashboard. Each applies at once to the names already proxied
   (`api-azure`, the API, and `notes`), and to the site only after the switch:
    - **Minimum TLS Version: 1.2**
      ([Minimum TLS Version](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)).
      A client that only speaks TLS 1.0 or 1.1 is refused; no current browser
      is one.
    - **Always Use HTTPS: on**
      ([Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)).
      The site already redirects `http://` itself; this moves the redirect to
      Cloudflare.
    - **Browser Cache TTL: Respect Existing Headers**
      ([Edge and Browser Cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/)).
      Today it is 4 hours, which would make browsers keep files such as
      `/theme-init.js` for 4 hours after a deploy instead of the 30 seconds
      the site asks for.

    Leave Cloudflare's HSTS setting **off**: the site already sends its own
    `Strict-Transport-Security` header and Cloudflare passes it through.
    Leave HTML caching at Cloudflare's default, which does not cache HTML
    ([Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)).

4. **The origin certificate check is running.** Azure renews the Static Web
   App's own certificates for the two names, and Microsoft only promises
   that while the names "resolve to the static web app over public internet"
   ([Custom domains with Azure Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/custom-domain)),
   which proxied names do not. Under Strict, an expired one would show
   visitors Cloudflare error 526. The current ones run to **2027-02-23**.

    The scheduled check
    [Check SWA certificates](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/check-swa-certificates.yml)
    ([`check-swa-certificates.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/check-swa-certificates.yml))
    does this read every day at 05:35 UTC. It asks Azure directly (the Static
    Web App's default name, so Cloudflare is not in the way) for the
    certificate of each name, and writes the name, issuer and days left in
    the run's summary. It uses the same certificate checks a browser makes,
    and the run fails when either certificate:

    - ends in 30 days or less, or has already ended;
    - does not cover its name (a name mismatch);
    - has a chain that does not lead to a trusted certificate authority;
    - is not valid yet; or
    - could not be read at all (no connection after three tries).

    On a failure a run of `main` opens one issue titled "Static Web App
    certificate needs attention: hybridcloudworks.com or www" (labelled
    `Platform` and `owner-gated`), naming the step under "Going back" below.
    It comments again only when something changes, and closes the issue by
    itself once both are good again. **Before the switch,** open the
    workflow's page and check its latest run is green.

    The same check by hand runs the workflow's own checker, so it judges
    exactly what the daily run judges. Run it in PowerShell from the
    repository's root folder, on `main`, with Node.js installed. It uses the
    `STATIC_WEB_APP_DEFAULT_HOSTNAME` repository variable when that is set,
    and the checker's built-in host otherwise:

    ```powershell
    $h = gh variable get STATIC_WEB_APP_DEFAULT_HOSTNAME --repo saulpatinojr/HCW-HybridCloudWorks 2>$null; if ($h) { node scripts/check-swa-certificates.mjs --host $h } else { node scripts/check-swa-certificates.mjs }; "exit $LASTEXITCODE"
    ```

    **Success:** two lines, `hybridcloudworks.com: good, ...` and
    `www.hybridcloudworks.com: good, ...`, each with its issuer, its end date
    and more than 30 days left, then `exit 0`. A line saying **NEEDS
    ACTION** (`exit 1`) gives the reason in brackets; follow "Going back"
    below. **COULD NOT READ** (`exit 2`) means no connection was made; try
    again, and if it repeats, check the host. If Node says it cannot find
    the module, you are not in the repository's root folder or not on
    `main`: `Test-Path scripts/check-swa-certificates.mjs` must say `True`.

## Part 3. The switch, `www` first

### Step 1: proxy `www`

Once the step 1 declarations have merged, follow "How every run in this
runbook is checked" with `site_proxied_hosts` set to `www`. **The plan should
show** one change on `cloudflare_dns_record.site_www`: `proxied` from `false`
to `true` and `ttl` from `60` to `1` (and its `modified_on` known after
apply). Nothing on the apex.

Wait five minutes after the apply, then:

1. **`www` resolves to Cloudflare.**

    ```powershell
    'www.hybridcloudworks.com','hybridcloudworks.com' | ForEach-Object { Resolve-DnsName -Name $_ -Server 1.1.1.1 } | Select-Object Name, Type, IPAddress, NameHost
    ```

    **Success:** `www` gives `A` (and `AAAA`) addresses inside Cloudflare's
    ranges, such as `104.16.0.0/13` and `172.64.0.0/13`, and no CNAME to
    `azurestaticapps.net`. The apex is unchanged.

2. **The pages come through Cloudflare unchanged, with one beacon.**

    ```powershell
    'https://www.hybridcloudworks.com/','https://www.hybridcloudworks.com/azure' | ForEach-Object { $r = Invoke-WebRequest -Uri $_ -UseBasicParsing; [pscustomobject]@{ Url = $_; Status = $r.StatusCode; Server = ($r.Headers['Server'] -join ','); CfRay = ($r.Headers['CF-RAY'] -join ','); CacheControl = ($r.Headers['Cache-Control'] -join ','); Beacons = ([regex]::Matches($r.Content, 'beacon\.min\.js')).Count } } | Format-List
    ```

    **Success:** `Status` 200, `Server` `cloudflare`, a `CfRay` value,
    `CacheControl` exactly what the site sends (`no-cache, no-store,
    must-revalidate, max-age=0` on `/`, `public, must-revalidate, max-age=30`
    on `/azure`, in any order), and `Beacons` 1. A 526 means the Strict rule
    could not check the Static Web App's certificate: run the Part 2 step 4
    check, and roll back if it is expired. `Beacons` 2 means the hand-placed
    beacon is back: Part 2 step 1.

3. **Visitors see Cloudflare's certificate.**

    ```powershell
    $t = New-Object Net.Sockets.TcpClient('www.hybridcloudworks.com', 443); $s = New-Object Net.Security.SslStream($t.GetStream(), $false, { $true }); $s.AuthenticateAsClient('www.hybridcloudworks.com'); $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($s.RemoteCertificate); $t.Close(); [pscustomobject]@{ Subject = $c.Subject; Issuer = $c.Issuer; NotAfter = $c.NotAfter } | Format-List
    ```

    **Success:** the issuer is Google Trust Services or Let's Encrypt (the
    zone's Universal certificate). DigiCert means the answer still came from
    Azure: wait for the five minutes, then check step 1 again.

4. **In a browser**, open <https://www.hybridcloudworks.com/admin>, sign in,
   and open a page or two. Open the browser's developer console (F12). Sign-in
   must work. Write down any `Refused to execute inline script` line on the
   ticket: Cloudflare's Bot Fight Mode adds a small inline script that the
   site's content policy blocks
   ([JavaScript Detections and CSP](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp)),
   and whether that matters is still to be seen. Any other new error is a
   reason to roll back.

5. **Azure still has both names Ready.**

    ```powershell
    az staticwebapp hostname list -n stapp-site-prod-cus-01 -g rg-web-site-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json | Select-Object domainName, status
    ```

    **Success:** both `Ready`.

6. **The visit is counted.** Within a few minutes the page views from steps
   2 and 4 show for `www.hybridcloudworks.com` in Web Analytics,
   <https://dash.cloudflare.com/?to=/:account/web-analytics> (pick the
   `hybridcloudworks.com` site). The monthly audience read counts only the
   apex and `www`; before it is armed, a session reads one window grouped by
   host and confirms Cloudflare reports exactly those two names (#1929,
   step 5).

### Step 2: test going back, on `www`

Once the going-back declarations for `www` are on `main`, follow "How every
run in this runbook is checked" with `site_proxied_hosts` set to `none`. Wait
five minutes and run check 1: `www` is a CNAME to `azurestaticapps.net`
again, and check 2 shows no `Server: cloudflare`. Then do the same with
`www` again and repeat checks 1 and 2. This proves the rollback before it is
ever needed.

### Step 3: leave `www` proxied through one real deploy

Keep `www` proxied until at least one frontend deploy has gone out. Right
after it turns green, load <https://www.hybridcloudworks.com/> in a normal
(not private) window that had the site open before: the new page arrives
without a hard refresh, and check 2's `CacheControl` is unchanged.

### Step 4: proxy the apex

Once the step 4 declarations have merged, follow "How every run in this
runbook is checked" with `site_proxied_hosts` set to `both`. **The plan
should show** one change on `cloudflare_dns_record.site_apex`: `proxied` from
`false` to `true` (its `ttl` is already 1, and its `modified_on` is known
after apply). Then run checks 1 to 6 with
`https://hybridcloudworks.com/` in place of the `www` addresses.

## Going back

At any point: set `site_proxied_hosts` one step back (`both` to `www`, `www`
to `none`) and follow "How every run in this runbook is checked"; the
going-back declarations are already on `main` (see that section, including
what to do in an emergency if they are not). Resolvers may keep a proxied answer
for up to five minutes, because proxied records always have a five-minute
TTL ([TTL](https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/)).
The Part 2 changes do not need undoing: the configuration rule does nothing
to DNS-only names, and the zone settings are improvements for the names
already proxied.

**If the Static Web App's certificate is near its end** (the Part 2 step 4
check, or the issue the daily
[Check SWA certificates](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/check-swa-certificates.yml)
run opens, at 14 days left or less): set `site_proxied_hosts` to `none`, wait
until the check shows a new end date, then set it back. The daily run closes
its issue once both certificates are good again. If the first renewal in
early 2027 happens while proxied, write that here and this paragraph can go.

## Related

- [Edge and DNS verification](edge-dns-verification.md): the four checks
  after any change at the edge.
- [Cloudflare admin and Claude Network Guy](cloudflare-admin.md): the page
  the zone settings and the configuration rule are changed on.
- The design, with every source: the body of
  [#1929](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1929).

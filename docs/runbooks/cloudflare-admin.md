# Cloudflare admin and Claude Network Guy

> **Status: built, waiting for the token.** Owner request of 2026-11-26,
> ticket [#1905](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1905);
> the decision record is
> [ADR 0047](../decisions/0047-cloudflare-admin-and-network-agent.md). Until
> the Cloudflare admin token is pasted on the Keys tab, the Cloudflare page
> says **not configured** and calls nothing.

**Scope:** how to set Claude Code up with Cloudflare's tools, how to make the
token the site uses to read and change Cloudflare, how to give Claude Network
Guy its key and its switches, what is refused and why, and what each error
means.

**Authority:** reading the Cloudflare page needs the portal's **editor** role.
Every change (a setting, a purge, a DNS record, a rule) needs **super_admin**.
An agent key can change only what its own switches allow, and nothing can be
deleted from the site.

## What it is

Cloudflare sits in front of the whole site. It holds the domain's DNS records
(the names, such as `api-azure` or `docs`, that tell a browser which server to
go to), the zone's settings (HTTPS, security level, caching and so on), and
rules that run on each request.

There are two ways to change Cloudflare by asking Claude, and they are set up
separately:

| | Claude Code with Cloudflare's plugin | Claude Network Guy |
| --- | --- | --- |
| What it is | Cloudflare's own skills and connection (its MCP server), loaded by Claude Code on your computer | An agent key the site holds, like Koda's and Claude Publisher's |
| Signs in with | Your own Cloudflare account, through a browser | Its agent key, then the site's own Cloudflare token |
| Can change | Anything your Cloudflare account can | Only what its switches allow, never the site's own address or what Terraform manages, never a delete |
| Recorded in | Cloudflare's audit log | Cloudflare's audit log **and** the site's audit log, with a Telegram message to you |

## Part 1. Claude Code on your computer

The repository's shared Claude Code settings (`.claude/settings.json`) load
Cloudflare's official plugin, following Cloudflare's
[agent setup instructions](https://developers.cloudflare.com/agent-setup/prompt.md).
The plugin's connection signs in through a browser, which a cloud session
cannot open, so this part is done once on your own computer.

1. In PowerShell, in your copy of this repository, bring it up to date once
   the pull request has merged:

   ```powershell
   git checkout main; git pull
   ```

   You should see `.claude/settings.json` among the changed files.
2. Start Claude Code in the same folder:

   ```powershell
   claude
   ```

   It asks whether to trust the `cloudflare` marketplace and install the
   `cloudflare` plugin. Say yes. If it does not ask, run `/plugin` inside
   Claude Code and install **cloudflare** from the **cloudflare**
   marketplace.
3. Inside Claude Code, type `/mcp`, choose **cloudflare**, then
   **Authenticate**. A browser opens on Cloudflare's sign-in page; sign in
   and press **Allow**. Back in Claude Code the server shows as connected.
   If the browser does not open, copy the address Claude Code prints into
   your browser.
4. Check it: ask Claude Code "list my Cloudflare zones". It should name
   `hybridcloudworks.com`.

Claude Code's own page on this is
[Connect Claude Code to tools via MCP](https://docs.anthropic.com/en/docs/claude-code/mcp).

## Part 2. The token the site uses

The site reads and changes Cloudflare with its own API token: an
**account-owned token** (Cloudflare's kind meant for a service rather than a
person,
[Cloudflare's page](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)),
limited to the one zone. It is separate from Terraform's token, the lab's
token and the two audit and analytics tokens, so each can be revoked alone.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open
   **Manage account**, then **Account API tokens**, then **Create Token**,
   then **Create Custom Token**. No direct link to that page was found in
   Cloudflare's documentation, so these are the clicks from the dashboard's
   home; the steps are on
   [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
2. Fill in the form:
   - **Token name:** `hcw-site-admin`
   - **Permissions**, all with **Zone** on the left. Cloudflare's dashboard
     names the change level **Edit** on some pages and **Write** on others;
     pick whichever the form shows
     ([permission list](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)):

     | Permission | Level | What it opens on the Cloudflare page |
     | --- | --- | --- |
     | Zone | Read | The zone's name and status (needed for everything) |
     | Zone Settings | Edit | The Settings tab |
     | DNS | Edit | The DNS tab |
     | Cache Purge | Purge | The Cache tab |
     | Transform Rules | Edit | Rules: header and URL rewrites |
     | Single Redirect | Edit | Rules: redirects |
     | Cache Rules | Edit | Rules: cache rules |
     | Config Rules | Edit | Rules: configuration rules |
     | Zone WAF | Edit | Rules: custom security rules |
     | Analytics | Read | The zone's traffic figures |

     Leave out any you do not want the site to be able to change: the page
     shows which parts the token cannot read, and the rest keeps working.
   - **Zone Resources:** **Include**, **Specific zone**,
     `hybridcloudworks.com`.
   - **Client IP Address Filtering:** leave empty. The Function App's
     outgoing addresses are not fixed, so a filter would block it.
   - **TTL** (the token's expiry): end date **one year from today**. The
     site reminds you before then.
3. Press **Continue to summary**, then **Create Token**. The token is shown
   **once**. Copy it. Do not paste it into chat, an issue or a file.
4. Open [Integrations → Keys](https://hybridcloudworks.com/admin/integrations?tab=keys),
   find **Cloudflare admin token**, paste the value and save.
5. Open the **Cloudflare** card on
   [Integrations → Services](https://hybridcloudworks.com/admin/integrations?tab=services&group=platform)
   and press **Test** on its admin token box. A good answer names the zone
   and says it is active. "Cloudflare refused the token" means the value or
   its zone is wrong; make the token again.
6. On [Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials),
   find `CLOUDFLARE-ADMIN-TOKEN` and record today's date, so the reminder
   counts from it.
7. On [Cost → Services](https://hybridcloudworks.com/admin/cost?tab=services),
   check there is a **Cloudflare** row with your plan (Free), and add it if
   not.

The Function App also needs the zone's id in its `CF_ZONE_ID` setting. That
comes from the `cloudflare_zone_id` variable Terraform already has, and is set
by the next `hcw-azure` apply after this change merges. Until then the page
says **not configured** even with the token pasted.

## Part 3. Claude Network Guy's key

1. Open the **Claude Network Guy** tab on the
   [Agents page](https://hybridcloudworks.com/admin/agents?tab=claude-network).
   It says **No key yet**.
2. Press **Generate key**. The key is shown **once**. Copy it.
3. Give it to the Claude that will act as Network Guy, in a secure field,
   never in chat. For a Claude Code cloud session, the safest place is an
   environment of its own whose network secret for `api-azure.hybridcloudworks.com`
   is this key, so that only sessions started in that environment act as
   Network Guy. Claude Code's page on this is
   [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).
4. On the same tab, the switch **Cloudflare: read** is already on. Turn on
   only the changes you want it to make:
   - **Cloudflare: change zone settings and purge the cache**
   - **Cloudflare: add and edit DNS records**
   - **Cloudflare: edit rules**
5. Check it: a session holding the key calls
   `GET https://api-azure.hybridcloudworks.com/api/cms/cloudflare/status`.
   A good answer has `"configured": true` and the zone's name.

Each change it makes writes an audit row and sends you a Telegram message
such as "Claude Network Guy changed the Cloudflare zone setting
always_use_https". Rotating and revoking work as for any agent key (the
[Agent Content API runbook](agent-content-api.md), parts 3 and 5, on the
Agents page's tab).

## What is refused, and why

| Refused | Why | Change it in |
| --- | --- | --- |
| The apex (`hybridcloudworks.com`) and `www` | They are the site itself, on the Static Web App; a wrong value takes the site down | The Cloudflare dashboard, by hand, with care |
| The DNS records Terraform manages (`api-azure`, `docs`, `podcast`, `go`, `_cf-custom-hostname.go`, `notes`, `asuid.api-azure`) | An apply would put them back, and some are what Azure checks to keep the custom domain | [`infra/frontend.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/frontend.tf) |
| The lab's records | The lab's own Terraform and its certificate setup own them | [`infra-lab/dns.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra-lab/dns.tf) |
| Any `_acme-challenge` name | Certificate checks write these for a few minutes | Nothing to change by hand |
| The `http_request_late_transform` rule phase | It holds the origin rule; a mistake there refuses every visitor's API call | `infra/frontend.tf`, and the [origin secret rotation runbook](origin-secret-rotation.md) |
| The `http_ratelimit` rule phase | It holds the API rate limit rule ([#1904](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1904)) | `infra/frontend.tf` |
| Any delete | No agent key deletes anything (ADR 0038), and the page offers none | The Cloudflare dashboard |

The full list is in
[`functions/src/lib/cloudflare/protected.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/cloudflare/protected.js),
and a test fails if Terraform gains a record the list does not have.

A DNS change made through the site is reported by the daily DNS audit
(`cloudflare-dns-audit.yml`) as unexpected and opens an issue, because the
audit does not know this token. That is deliberate for now (ADR 0047): close
the issue once you have checked the change was yours or Network Guy's.

## When something is wrong

| You see | It means | Do this |
| --- | --- | --- |
| **Not configured** on the Cloudflare page | The token or the zone id is missing | Part 2, steps 4 and the `CF_ZONE_ID` note |
| A part of the page says the token cannot read it | The token lacks that permission | Edit the token in Cloudflare and add it (Part 2, step 2) |
| "Cloudflare refused the token" | The token is wrong, expired or revoked | Make a new one (Part 2) and paste it |
| "That name is protected" or "That rule phase is managed by Terraform" | The table above | Change it where the table says |
| 403 "This key may not call that route" for Network Guy | The switch for that kind of change is off | Turn it on (Part 3, step 4) |
| 429 "Too many requests" | The key's limit of 120 calls a minute | Wait a minute |

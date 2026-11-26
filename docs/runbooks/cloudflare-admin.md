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

The plugin is pinned to one reviewed commit of Cloudflare's repository (the
`ref` in `.claude/settings.json`), so a change Cloudflare publishes reaches
sessions only through a pull request that moves the pin. A pin of this kind
needs Claude Code 2.1.324 or later; `claude --version` shows yours, and
`claude update` brings it up to date
([marketplace sources](https://code.claude.com/docs/en/plugins/marketplace-reference.md)).

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
     | Config Rules | Edit | Rules: configuration rules |
     | Zone WAF | Edit | Rules: custom security rules and rate limiting (the API rate limit) |

     Nothing else is needed: the page does not read traffic figures, and
     cache rules are not a phase it changes, so leave **Analytics** and
     **Cache Rules** off the token.

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
says **not configured** even with the token pasted, and says that the zone id
is what is missing. There is nothing to paste for it: it is never entered on
the Keys tab.

When you read that run's plan, the plan check (`tfc-plan-check.yml`, which
you start by hand) lists one line as unexpected on purpose:
`app_settings.CF_ZONE_ID`, going from nothing to the zone's id. Its value is
not written into the public repository, so the check cannot know it in
advance. It is right when it equals the zone id the DNS records in the same
plan already use. The new Key Vault reference `CLOUDFLARE_ADMIN_TOKEN` is
declared and passes.

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
such as "Claude Network Guy changed the Cloudflare zone setting brotli".
Every change gets a message of its own: two changes a minute apart are two
messages, not one. The audit row for a setting keeps its old and new value;
the row for a DNS record keeps its type, its name and whether it was
proxied and for how long (its TTL) before and after, but never what it
points to. Rotating and revoking work as for any agent key (the
[Agent Content API runbook](agent-content-api.md), parts 3 and 5, on the
Agents page's tab).

Two kinds of change send you a warning (a yellow Telegram message headed
"Check this Cloudflare change") whoever made it, you or an agent key:

- **The change was made but its audit row could not be written.** The
  change is real in Cloudflare; only the audit log is missing it. The page
  also shows a warning instead of the usual "Saved", and the route's answer
  says `audited: false`. Check the change on the Cloudflare page, and look in
  the function app's log for `[cloudflare] audit row failed` around that time.
- **A DNS edit came back with a protected name.** Cloudflare's DNS edit has
  no "only if nothing changed" option, so if someone renamed the record onto
  a protected name (such as `www`) between the page reading it and saving
  your change, the change still lands. It is recorded, the answer says
  `protectedAfterWrite: true`, and the record should be checked in the
  Cloudflare dashboard.

## Part 4. Making the API rate limit rule

The API rate limit is one rule that stops a single address from sending a
flood of requests to the site's API. It used to be planned as Terraform code
([#1904](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1904)),
but that was never applied, and on 2026-11-26 you asked for it to be made
and looked after on the Cloudflare page and by Claude Network Guy instead
([#1903](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1903);
[#1908](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1908)
takes it out of Terraform). It lives in the `http_ratelimit` rule phase,
which is one of the six phases the page can change.

**The rule's values** are the ones #1904 chose:

| Setting | Value | In plain words |
| --- | --- | --- |
| Phase | `http_ratelimit` | Cloudflare's rate limiting rules |
| Expression | `(lower(http.request.uri.path) contains "/api/")` | Every request whose path has `/api/` in it |
| Requests per period | `200` | More than 200 requests... |
| Period | `10` seconds | ...in 10 seconds... |
| Counted by | `cf.colo.id` and `ip.src` | ...from one address, counted at each Cloudflare data centre ([`cf.colo.id` is required](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/)) |
| Mitigation timeout | `10` seconds | The address stays blocked for 10 seconds |
| Action | `block` | Further requests are refused |

The site's token needs **Zone WAF Edit** for this phase, which Part 2 already
lists ([Cloudflare's page on rate limiting rules](https://developers.cloudflare.com/terraform/additional-configurations/rate-limiting-rules/)
names Zone WAF Write as the permission). Cloudflare's Free plan includes one
rate limiting rule, so if the phase already holds one, change that rule
(keep its `id`) rather than adding a second.

**The easy way: ask Claude Network Guy.** Turn on **Cloudflare: edit rules**
on its tab of the
[Agents page](https://hybridcloudworks.com/admin/agents?tab=claude-network)
(Part 3, step 4), and ask it to make the rule with the values above. When it
is done you get a Telegram message such as "Claude Network Guy replaced the
Cloudflare rules in the http_ratelimit phase (1 rule(s))." Turn the switch
off again afterwards if nothing else needs it.

**Or make it yourself on the page:**

1. Open the Rules tab of the
   [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=rules),
   signed in as yourself.
2. In **What can be changed here**, press **Open** beside `http_ratelimit`.
   You should see the phase with no rules yet (or the one rule it holds).
   If the page says the token cannot read rules, add Zone WAF Edit to the
   token (Part 2, step 2) and try again.
3. Press **Edit these rules**, and replace what is in the box with this
   (keep the `id` of any rule that is already there):

   ```json
   [
     {
       "description": "Block an address sending more than 200 requests in 10 seconds to the API (counted per Cloudflare data centre)",
       "expression": "(lower(http.request.uri.path) contains \"/api/\")",
       "action": "block",
       "enabled": true,
       "ratelimit": {
         "characteristics": ["cf.colo.id", "ip.src"],
         "period": 10,
         "requests_per_period": 200,
         "mitigation_timeout": 10
       }
     }
   ]
   ```

4. Press **Replace the rules**, then **Replace the rules** again in the box
   that asks you to confirm. You should see the phase again with the one
   rule in it, now with an `id` Cloudflare gave it. If you see "This phase
   changed since you opened it", close the phase, open it again and repeat
   from step 3.

Changing the limit later works the same way: edit the numbers and keep the
rule's `id`. Network Guy may change the rule but never remove it. If you
remove it yourself, the page asks you to type `http_ratelimit` first,
because without it one address can send the API as many requests as it
likes.

## What is refused, and why

The server refuses each of these before it changes anything in Cloudflare,
whoever asks. Three rows apply to an agent key only, and say so.

| Refused | Why | Change it in |
| --- | --- | --- |
| The apex (`hybridcloudworks.com`) and `www` | They are the site itself, on the Static Web App; a wrong value takes the site down | The Cloudflare dashboard, by hand, with care |
| The DNS records Terraform manages (`api-azure`, `docs`, `podcast`, `go`, `_cf-custom-hostname.go`, `notes`, `asuid.api-azure`) | An apply would put them back, and some are what Azure checks to keep the custom domain | [`infra/frontend.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/frontend.tf) |
| The lab's records, and every name under `*.lab` and `*.coder.lab` | The lab's own Terraform and its certificate setup own them | [`infra-lab/dns.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra-lab/dns.tf) |
| Any `_acme-challenge` name | Certificate checks write these for a few minutes | Nothing to change by hand |
| A wildcard over any name above (`*.www`, `*.api-azure`), and `*` for the whole zone | A wildcard answers for names nobody listed, so it could stand in for a protected name | The Cloudflare dashboard |
| A DNS edit to a record that is not A, AAAA, CNAME, MX or TXT (an NS or CAA record, say) | The page adds and edits only those five types | The Cloudflare dashboard |
| A badly formed DNS name: a leading, trailing or double dot, `@` anywhere but on its own, `*` anywhere but as the whole first part | The name that is checked must be the name that is sent | Correct the name |
| The `http_request_late_transform` rule phase | It holds the origin rule; a mistake there refuses every visitor's API call | `infra/frontend.tf`, and the [origin secret rotation runbook](origin-secret-rotation.md) |
| Every other rule phase except six (origin rules, cache rules, cloud connector, snippets, managed rules, DDoS and any phase Cloudflare adds later) | "This kind of rule can send or store the site's traffic elsewhere, so it is changed in the Cloudflare dashboard." Only redirects, URL rewrites, response headers, configuration rules, custom security rules and rate limiting rules can be replaced from the page (the API rate limit moved here from Terraform on 2026-11-26, Part 4) | The Cloudflare dashboard |
| A custom security rule whose action is `skip` | It would let matching requests past the other security checks | The Cloudflare dashboard |
| An empty list of rules | It would delete every rule in the phase, and deleting is done in the dashboard | The Cloudflare dashboard |
| Agent key only: a list of rules that leaves out a rule the phase has now | An agent key may add rules and change existing ones, but every current rule's id must still be in its list. "An agent key may add or change rules but not remove one. Removing a rule is done by the owner on the Cloudflare page." | The Rules tab of the [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=rules), signed in as yourself (it asks you to type the phase's name before a custom security rule or a rate limiting rule is removed) |
| A replacement of a phase that changed since it was read | It would quietly undo the newer change. The page sends the version it read; reload and make the change again | Reload the phase on the page |
| A rule that still holds a hidden value | The page never reads a secret-looking header value (a name with secret, token, auth or key in it), so it cannot send the real one back | The Cloudflare dashboard |
| Agent key only: SSL mode, minimum TLS version, Always Use HTTPS, HSTS (`security_header`) and the certificate Cloudflare shows the site (`tls_client_auth`) | A wrong value breaks or weakens HTTPS for every visitor | The Settings tab of the [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=settings), signed in as yourself |
| Any change, when the zone id points at another zone | The protected list names this zone's records, so it would protect nothing elsewhere | `CF_ZONE_ID`, which Terraform sets on the function app |
| Any delete | No agent key deletes anything (ADR 0038), and the page offers none. When you (not an agent key) replace a phase's rules, the ones left out of the new list are removed | The Cloudflare dashboard |

What the page shows is limited too. The rules of a phase that cannot be
changed here are shown without what they carry (only each rule's id,
description, expression, action and whether it is on), so the origin secret
in the `http_request_late_transform` rule never leaves the server. In the
six phases that can be changed, a header value whose name has secret,
token, auth or key in it is shown as
`[hidden: change this value in the Cloudflare dashboard]`.

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
| **Not configured** on the Cloudflare page | The token or the zone id is missing; the page says which | The token: paste it on Integrations → Keys (Part 2, step 4). The zone id (`CF_ZONE_ID`): nothing to paste, Terraform sets it on the next `hcw-azure` apply (the `CF_ZONE_ID` note in Part 2) |
| "An agent key may add or change rules but not remove one" | Network Guy sent a list of rules that left one out | Remove the rule yourself on the [Rules tab](https://hybridcloudworks.com/admin/cloudflare?tab=rules), if it should go |
| "Check this Cloudflare change" on Telegram | A change landed but its audit row failed, or a DNS edit came back with a protected name | See the two warnings under Part 3 |
| A part of the page says the token cannot read it | The token lacks that permission | Edit the token in Cloudflare and add it (Part 2, step 2) |
| "Cloudflare refused the token" | The token is wrong, expired or revoked | Make a new one (Part 2) and paste it |
| "That name is protected", "That rule phase may not be changed from here" or "That record is read-only here" | The table above | Change it where the table says |
| "An agent key may not change ssl" (or another owner-only setting) | Only you change that one | Change it yourself on the [Settings tab](https://hybridcloudworks.com/admin/cloudflare?tab=settings) |
| "This phase changed since you opened it" | Someone changed the phase after you opened it | Close the phase, open it again and make your change again |
| "The zone this site is set to (CF_ZONE_ID) is not hybridcloudworks.com" | The zone id points at another zone | Check `CF_ZONE_ID` in Terraform; nothing was changed |
| The DNS tab says the list stops at the limit | The zone holds more than 5,000 records | Find the rest in the Cloudflare dashboard |
| 403 "This key may not call that route" for Network Guy | The switch for that kind of change is off | Turn it on (Part 3, step 4) |
| 429 "Too many requests" | The key's limit of 120 calls a minute | Wait a minute |

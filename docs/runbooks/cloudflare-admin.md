# Cloudflare admin and Claude Network Guy

> **Status: built, waiting for the token.** Owner request of 2026-11-26,
> ticket [#1905](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1905);
> the decision record is
> [ADR 0047](../decisions/0047-cloudflare-admin-and-network-agent.md). Until
> the Cloudflare admin token is pasted on the Keys tab, the Cloudflare page
> says **not configured** and calls nothing.

**Scope:** how to set Claude Code up with Cloudflare's tools, how to make the
token the site uses to read and change Cloudflare, how to give Claude Network
Guy its key and its switches, how to work on the lab zone, what is refused
and why, and what each error means.

**Authority:** reading the Cloudflare page needs the portal's **editor** role.
Every change (a setting, a purge, a DNS record, a rule) needs **super_admin**.
An agent key can change only what its own switches allow, and nothing can be
deleted from the site.

## What it is

Cloudflare sits in front of the whole site. It holds the domain's DNS records
(the names, such as `api-azure` or `docs`, that tell a browser which server to
go to), the zone's settings (HTTPS, security level, caching and so on), and
rules that run on each request.

The page and Claude Network Guy look after **two zones** (a zone is
Cloudflare's word for one domain and everything under it), and no other:

| Zone | What it is for |
| --- | --- |
| `hybridcloudworks.com` | The site's own zone: the website, its API, the documentation, the podcast, the link page, the notes and the lab host's addresses |
| `hybridcloudinsights.com` | The lab zone: the lab host's web server (Caddy) writes the short-lived certificate checks for the lab's certificates here, and nothing else lives in it ([lab host README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/README.md), "The Cloudflare runtime token and its scope"; [#948](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/948)) |

The lab zone was added on 2026-11-26
([#1911](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1911)),
because the lab is part of the site. Part 5 says how to work on it.

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
limited to the two zones above. One token covers both, so there is one value
to paste and one to replace each year. It is separate from Terraform's token,
the lab's Caddy token and the two audit and analytics tokens, so each can be
revoked alone.

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
   - **Zone Resources:** two rows, both **Include**, **Specific zone**: one
     for `hybridcloudworks.com` and one for `hybridcloudinsights.com` (press
     **Add more** for the second row). Nothing else: the site refuses any
     other zone anyway, but a token that cannot reach one cannot be misused
     there.

     **An accepted trade-off.** Cloudflare applies the token's permission
     list to every zone under Zone Resources, so the lab zone gets the same
     permissions as the site's zone: settings, DNS, rules and cache purge,
     although the lab zone rarely needs more than DNS. That is accepted so
     there is one token and one yearly replacement, not two. What narrows
     the lab zone is the site's own code: it refuses the lab zone's apex,
     its `lab` names (where the lab's certificate checks live), every name
     starting with an underscore (`_`) and every wildcard there, whoever
     asks (the
     table under "What is refused, and why").
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
   and press **Test** on its admin token box. A good answer names the site's
   zone and says it is active. "Cloudflare refused the token" means the value
   or its zone is wrong; make the token again. The Test reads the site's zone
   only; to check the lab zone, open the
   [Cloudflare page in the lab zone](https://hybridcloudworks.com/admin/cloudflare?zone=hybridcloudinsights.com)
   and look at its Overview: it names the zone and says it is active. If it
   says instead "The admin token cannot reach the zone
   hybridcloudinsights.com", the token is missing the lab zone (the next
   paragraph).
6. On [Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials),
   find `CLOUDFLARE-ADMIN-TOKEN` and record today's date, so the reminder
   counts from it.
7. On [Cost → Services](https://hybridcloudworks.com/admin/cost?tab=services),
   check there is a **Cloudflare** row with your plan (Free), and add it if
   not.

**If the token was made before the lab zone was added** (with only
`hybridcloudworks.com`), you do not need a new token: edit the one you have.
In the Cloudflare dashboard, **Manage account** → **Account API tokens**, open
the menu (**⋯**) on the `hcw-site-admin` row, choose **Edit**, add the
`hybridcloudinsights.com` row under **Zone Resources** as in step 2, then
**Continue to summary** and **Update token**. Cloudflare keeps the same value,
so there is nothing to paste again. The steps are on Cloudflare's
[Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
page. Check it the way step 5 says.

The Function App also needs the site zone's id in its `CF_ZONE_ID` setting. That
comes from the `cloudflare_zone_id` variable Terraform already has, and is set
by the next `hcw-azure` apply after this change merges. Until then the page
says **not configured** even with the token pasted, and says that the zone id
is what is missing. There is nothing to paste for it: it is never entered on
the Keys tab. The lab zone needs no setting of its own: the site looks its id
up by name with the same token the first time it is used, and keeps it until
the function app restarts.

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
   A good answer has `"configured": true` and the zone's name. The same
   switches cover the lab zone; Part 5 says how a call names it.

Each change it makes writes an audit row and sends you a Telegram message
such as "Claude Network Guy changed the Cloudflare zone setting brotli. Zone:
hybridcloudworks.com." The message's title and its last sentence name the
zone, and so does the audit row (`details.zone`).
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
names Zone WAF Write as the permission). The rule cannot be made until that
token has been made and pasted (Part 2). Cloudflare's Free plan includes
exactly one rate limiting rule, with a 10-second period and a 10-second
block
([Cloudflare's availability table](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)),
so if the phase already holds one, change that rule (keep its `id`) rather
than adding a second.

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
   If instead you see "Cloudflare refused the token for this (HTTP 403). It
   may be wrong, expired, or missing the permission for this kind of change;
   check it on Integrations → Keys." (sometimes with a Cloudflare error code
   in brackets after the 403), the token is most likely missing Zone WAF
   Edit: add it to the token (Part 2, step 2) and open the phase again.
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
rule's `id`. Network Guy may change the rule, but it may not remove it,
switch it off (`"enabled": false`) or give it a custom response; those are
refused before anything changes.

**Removing the rule is done in the Cloudflare dashboard, not here.** On the
Free plan the phase holds exactly one rule, and the page refuses an empty
list (it would delete every rule in the phase), so neither you nor Network
Guy can remove it from the page. To remove it, delete it in the Cloudflare
dashboard on the security rules page: Cloudflare's
[guide to rate limiting rules in the dashboard](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)
calls it **Security rules** (in the older dashboard, **Security** → **WAF**
→ **Rate limiting rules**). Without the rule, one address can send the API
as many requests as it likes. On a paid plan with several rate limiting
rules, removing one of them from the page asks you to type `http_ratelimit`
first.

**The Health page warns when the rule is missing or off**
([#1909](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1909)).
Because the rule lives only in Cloudflare and not in Terraform, nothing else
would notice it going. The **Cloudflare API rate limit** card on the Checks
tab of the [Health page](https://hybridcloudworks.com/admin/health?tab=checks),
and the line under "What the token can read" on the Cloudflare page's
[Overview](https://hybridcloudworks.com/admin/cloudflare?tab=overview), read
the `http_ratelimit` phase (it changes nothing) and say the same thing:

- **Healthy** (green): at least one rule is switched on, and it says how many.
- **Degraded** (amber): "No API rate limit rule is on." The phase has no
  rule, or every rule in it is switched off. Make the rule, or switch it back
  on, with the steps above.
- **Unknown** (not checked): the Cloudflare page is not set up yet (the token
  or the zone id is missing, Part 2), so nothing was asked.
- **Critical or Offline** (red): the read itself failed. The card shows
  Cloudflare's or the site's sentence; see
  [When something is wrong](#when-something-is-wrong) below.

The check runs when the Health page or the Cloudflare page is opened (and
with **Test all**). A rule whose action is only `log` (a paid-plan option)
does not count as on, since it limits nothing. Someone with only the viewer
role sees **Unknown** ("needs the editor role"), not red.

### The daily check

Once it is switched on, a timer in the site's back end does the same check
by itself every day at 12:40 UTC (06:40 Central in winter, 07:40 in summer)
([#1918](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1918)).
A timer here is a job the Function App (the site's back end) runs on a
clock; its code is `functions/src/lib/timers/cloudflare-rate-limit.js` and
its name is `checkCloudflareRateLimit`. Each day it:

1. Reads the `http_ratelimit` phase of the site's zone with the admin token
   from Part 2. It only reads; it changes nothing in Cloudflare. It judges
   the answer with the same rule as the card (the server's
   `functions/src/lib/cloudflare/rate-limit.js`, which a test holds equal to
   the browser's copy).
2. Writes the answer onto the **Cloudflare API rate limit** card on the
   [Health page](https://hybridcloudworks.com/admin/health?tab=checks). The
   card then says "by the scheduled check" and, as for every card, since when
   the colour has held. The daily answer counts as current for 26 hours, so
   the card turns grey (stale) only if a day's run is missed.
3. Sends one Telegram message when the answer turns amber (no rule on) or red
   (Cloudflare refused the token or did not answer) from anything else, and
   one more when it is green again. While nothing changes it says nothing,
   so a rule left off sends one message, not one a day. "Not checked"
   (the token or zone id is not set) never sends a message.

What it remembers about the last message is kept in one small document,
`cloudflare_rate_limit_watch`, in the `admin_config` container; pressing
**Test** on the Health page does not change it, so a Test never makes the
timer repeat itself. If a message could not be sent, nothing is recorded and
the next day's run tries again.

**Switching it on.** Like every timer in the Function App, it is off until
its name is added to `enabled_timers` (the list of switched-on timers in the
HCP Terraform workspace `hcw-azure`). Do this once the pull request that
added it has been merged and the Terraform run that merge started has been
confirmed:

1. Open the [workspace's runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs).
   The run for the merge should show as **Applied**. Its plan adds
   `FEATURE_FLAG_CHECK_CLOUDFLARE_RATE_LIMIT` as `"false"` and one row
   (`checkCloudflareRateLimit`) to the `alert-timer-overdue` query; both are
   `DECLARED` in the plan check. If it is still waiting, read its plan and
   confirm it first. Confirming applies the change to Azure.
2. Open the [workspace's variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
   and check that `schedulers_master_enabled` is `true`. If it is `false`,
   stop: turning it on lets every timer in `enabled_timers` run, which is a
   separate decision.
3. In the same place, edit `enabled_timers` (HCL) to add
   `"CHECK_CLOUDFLARE_RATE_LIMIT"` to the list, and save. A misspelt name is
   refused by the plan with "enabled_timers accepts only flag suffixes".
4. Back on the [runs page](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs),
   start a run (**+ New run**) and read the plan. You should see one change
   for this timer: `FEATURE_FLAG_CHECK_CLOUDFLARE_RATE_LIMIT` from `"false"`
   to `"true"`, marked `DECLARED` by the plan check. Anything the plan check
   calls UNEXPECTED needs reading before you confirm. If the flag appears
   from nothing straight to `"true"`, the run from step 1 had not applied:
   discard this one and do step 1 first.
5. Confirm the run. The next day after 12:40 UTC, the card on the
   [Health page](https://hybridcloudworks.com/admin/health?tab=checks)
   should say "by the scheduled check". If it still says "an admin" or "Not
   tested yet", the timer has not run: check that step 4's run applied.

**Switching it off.** Remove `"CHECK_CLOUDFLARE_RATE_LIMIT"` from
`enabled_timers` in the
[workspace's variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
and start a run. The plan check lists the one flag line (`"true"` to
`"false"`) as UNEXPECTED, because only switching on is declared; when that
is the only change, confirm it. The card goes back to showing only what a
Test finds.

## Part 5. Working on the lab zone

**On the page.** Open the
[Cloudflare page](https://hybridcloudworks.com/admin/cloudflare). Above the
tabs, the **Zone** list starts on `hybridcloudworks.com`. Choose
`hybridcloudinsights.com`, and every tab (Overview, Settings, DNS, Rules,
Cache) shows and changes the lab zone only. The page's address gains
`?zone=hybridcloudinsights.com`, so a link to it opens the lab zone
directly, for example the
[lab zone's DNS records](https://hybridcloudworks.com/admin/cloudflare?tab=dns&zone=hybridcloudinsights.com).
Choose `hybridcloudworks.com` again to go back. What you should see: the
Overview names the lab zone and says it is active on the Free plan. Under
**What is locked, and why** it lists the zone's own address
(`hybridcloudinsights.com`), `lab.hybridcloudinsights.com` and
`*.lab.hybridcloudinsights.com` (everything under `lab`), the `_…` line
(every name starting with an underscore) and a line saying that in this
zone every wildcard is locked; under **Rule phases Terraform manages** it
says there are none in this zone. Between certificate renewals the DNS tab
says the zone has no records yet; that is normal.

**For Claude Network Guy, or any call to the API.** Every route under
`/api/cms/cloudflare/` takes `?zone=` with a zone's name, for example
`GET https://api-azure.hybridcloudworks.com/api/cms/cloudflare/dns?zone=hybridcloudinsights.com`.
A call without it acts on `hybridcloudworks.com`, as before. Any other value
is refused with 400 `CLOUDFLARE_UNMANAGED_ZONE` before Cloudflare is called,
and so is an empty or repeated `zone`. Network Guy's four switches are the
same for both zones: there is no separate lab switch.

**What is different in the lab zone.** The lab zone is where the lab's
certificates are proved (the DNS-01 check Caddy answers), so more of it is
locked than its emptiness suggests: its apex (`hybridcloudinsights.com`
itself, for every record type), `lab` and every name under it (the
certificate check `_acme-challenge.lab` lives there), every name with a
part starting with an underscore (`_acme-challenge`, and verification or
mail-policy names such as `_dmarc`, `s1._domainkey` or a provider's
`_…-verification` record),
and every wildcard. `www` and other names are open,
because nothing uses them. The rule phases, the owner-only settings and
every limit on an agent key are the same as in the site's zone. A name that
ends with the other zone (`x.hybridcloudworks.com` sent with the lab zone
picked) is refused with a sentence telling you to pick that zone.

## What is refused, and why

The server refuses each of these before it changes anything in Cloudflare,
whoever asks. Four rows apply to an agent key only, and say so. Every row
applies in both zones unless it names one.

| Refused | Why | Change it in |
| --- | --- | --- |
| Any zone but `hybridcloudworks.com` and `hybridcloudinsights.com` (a `zone` value that is unknown, empty or given twice) | The site looks after those two zones only, whatever else the token can reach | The Cloudflare dashboard |
| The apex (`hybridcloudworks.com`) and `www` | They are the site itself, on the Static Web App; a wrong value takes the site down | The Cloudflare dashboard, by hand, with care |
| The lab zone's apex (`hybridcloudinsights.com`), for every record type | Nothing lives there, and a record there (an MX or TXT, say) could receive mail for the domain or pass a check that the domain is ours | The Cloudflare dashboard, by hand |
| In the lab zone, `lab` and every name under it (`x.lab`, `_acme-challenge.lab`) | The site zone's `_acme-challenge.lab` names point at `_acme-challenge.lab.hybridcloudinsights.com`, where Caddy proves the lab's certificates; a record nearby could take its place | Nothing to change by hand |
| The DNS records Terraform manages (`api-azure`, `docs`, `podcast`, `go`, `_cf-custom-hostname.go`, `notes`, `asuid.api-azure`) | An apply would put them back, and some are what Azure checks to keep the custom domain | [`infra/frontend.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/frontend.tf) |
| The lab's records, and every name under `*.lab` and `*.coder.lab` | The lab's own Terraform and its certificate setup own them | [`infra-lab/dns.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra-lab/dns.tf) |
| Any `_acme-challenge` name in `hybridcloudworks.com` | Certificate checks write these for a few minutes | Nothing to change by hand |
| In the lab zone `hybridcloudinsights.com`, any name with a part starting with an underscore (`_acme-challenge`, `_dmarc`, `_atproto`, `s1._domainkey` and the like) | The only such names there are the certificate checks the lab host's Caddy writes for a few minutes at each renewal ([lab host README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/README.md), "The Cloudflare runtime token and its scope"), and outside services prove the domain is ours or set its mail policy with such names | The Cloudflare dashboard, by hand (Caddy's own names need nothing) |
| In `hybridcloudworks.com`: every wildcard (`*`, `*.www`, `*.blog`, `*.anything`) | A wildcard answers for names nobody listed: `*.foo` would answer the certificate check `_acme-challenge.foo` and could pass it for someone else, so every wildcard could stand in for a protected name | The Cloudflare dashboard |
| In the lab zone: every wildcard (`*`, `*.lab`, `*.anything`) | Between Caddy's renewals a wildcard could answer the lab's certificate check and pass it for someone else | The Cloudflare dashboard |
| A name that ends with the other managed zone (`x.hybridcloudworks.com` with the lab zone picked, and the other way round) | It would be made inside the wrong zone under a confusing name | Pick that zone and add it there |
| A DNS edit to a record that is not A, AAAA, CNAME, MX or TXT (an NS or CAA record, say) | The page adds and edits only those five types | The Cloudflare dashboard |
| A badly formed DNS name: a leading, trailing or double dot, `@` anywhere but on its own, `*` anywhere but as the whole first part | The name that is checked must be the name that is sent | Correct the name |
| The `http_request_late_transform` rule phase | It holds the origin rule; a mistake there refuses every visitor's API call | `infra/frontend.tf`, and the [origin secret rotation runbook](origin-secret-rotation.md) |
| Every other rule phase except six (origin rules, cache rules, cloud connector, snippets, managed rules, DDoS and any phase Cloudflare adds later) | "This kind of rule can send or store the site's traffic elsewhere, so it is changed in the Cloudflare dashboard." Only redirects, URL rewrites, response headers, configuration rules, custom security rules and rate limiting rules can be replaced from the page (the API rate limit moved here from Terraform on 2026-11-26, Part 4) | The Cloudflare dashboard |
| A custom security rule whose action is `skip` | It would let matching requests past the other security checks | The Cloudflare dashboard |
| An empty list of rules | It would delete every rule in the phase, and deleting is done in the dashboard | The Cloudflare dashboard |
| Agent key only: a list of rules that leaves out a rule the phase has now | An agent key may add rules and change existing ones, but every current rule's id must still be in its list. "An agent key may add or change rules but not remove one. Removing a rule is done by the owner on the Cloudflare page." | The Rules tab of the [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=rules), signed in as yourself (it asks you to type the phase's name before a custom security rule or a rate limiting rule is removed; the last rule of a phase cannot be removed here, because an empty list is refused, so on the Free plan the one rate limiting rule is deleted in the Cloudflare dashboard, Part 4) |
| Agent key only: switching a custom security or rate limiting rule off, or adding one that starts switched off | A rule switched off is a rule removed in effect. "An agent key may not switch a security or rate limiting rule off, or add one that starts switched off: a rule switched off is removed in effect. Switching a rule off is done by the owner on the Cloudflare page." | The Rules tab of the [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=rules), signed in as yourself |
| Agent key only: a custom response (`action_parameters.response`) on a custom security or rate limiting rule | It sets what a blocked caller is shown; only a paid plan offers it, so it is closed ahead of time | The Rules tab of the [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=rules), signed in as yourself |
| A replacement of a phase that changed since it was read | It would quietly undo the newer change. The page sends the version it read; reload and make the change again | Reload the phase on the page |
| A rule that still holds a hidden value | The page never reads a secret-looking header value (a name with secret, token, auth or key in it), so it cannot send the real one back | The Cloudflare dashboard |
| Agent key only: SSL mode, minimum TLS version, Always Use HTTPS, HSTS (`security_header`) and the certificate Cloudflare shows the site (`tls_client_auth`) | A wrong value breaks or weakens HTTPS for every visitor | The Settings tab of the [Cloudflare page](https://hybridcloudworks.com/admin/cloudflare?tab=settings), signed in as yourself |
| Any change, when the zone id points at another zone | Each zone's protected list names that zone's records, so it would protect nothing elsewhere | For the site's zone, `CF_ZONE_ID`, which Terraform sets on the function app. For the lab zone, nothing: the looked-up id is forgotten and looked up again on the next request |
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

A DNS change made through the site in `hybridcloudworks.com` is reported by
the daily DNS audit (`cloudflare-dns-audit.yml`) as unexpected and opens an
issue, because the audit does not know this token. That is deliberate for now
(ADR 0047): close the issue once you have checked the change was yours or
Network Guy's.

**A DNS change in the lab zone is not reported by that audit at all.** The
audit reads only the site's zone
([`scripts/lib/dns-audit-entries.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/lib/dns-audit-entries.mjs),
`isProductionZone`), and Caddy writes and removes records in the lab zone at
every renewal, so watching it would need its own allowlist. For the lab zone
the record of a change is the site's audit log and the Telegram message each
change sends (and Cloudflare's own audit log).

## When something is wrong

| You see | It means | Do this |
| --- | --- | --- |
| **Not configured** on the Cloudflare page | The token or the zone id is missing; the page says which | The token: paste it on Integrations → Keys (Part 2, step 4). The zone id (`CF_ZONE_ID`): nothing to paste, Terraform sets it on the next `hcw-azure` apply (the `CF_ZONE_ID` note in Part 2) |
| "An agent key may add or change rules but not remove one" | Network Guy sent a list of rules that left one out | Remove the rule yourself on the [Rules tab](https://hybridcloudworks.com/admin/cloudflare?tab=rules), if it should go |
| "An agent key may not switch a security or rate limiting rule off" or "An agent key may not set a custom response" | Network Guy tried to switch a custom security or rate limiting rule off, add one switched off, or set a custom response | Do it yourself on the [Rules tab](https://hybridcloudworks.com/admin/cloudflare?tab=rules), if it should happen |
| "Check this Cloudflare change" on Telegram | A change landed but its audit row failed, or a DNS edit came back with a protected name | See the two warnings under Part 3 |
| A part of the page says the token cannot read it | The token lacks that permission | Edit the token in Cloudflare and add it (Part 2, step 2) |
| "Cloudflare refused the token" | The token is wrong, expired or revoked | Make a new one (Part 2) and paste it |
| "That name is protected", "That rule phase may not be changed from here" or "That record is read-only here" | The table above | Change it where the table says |
| "An agent key may not change ssl" (or another owner-only setting) | Only you change that one | Change it yourself on the [Settings tab](https://hybridcloudworks.com/admin/cloudflare?tab=settings) |
| "No API rate limit rule is on" on the Health page or the Cloudflare page's Overview, or the Telegram message "Cloudflare API rate limit is off" from the daily check | The `http_ratelimit` phase has no rule, or its rule is switched off, so one address can send the API as many requests as it likes | Make the rule, or set `"enabled": true` on it again, on the [Rules tab](https://hybridcloudworks.com/admin/cloudflare?tab=rules) (Part 4) |
| "This phase changed since you opened it" | Someone changed the phase after you opened it | Close the phase, open it again and make your change again |
| "The zone this site is set to (CF_ZONE_ID) is not hybridcloudworks.com" | The zone id points at another zone | Check `CF_ZONE_ID` in Terraform; nothing was changed |
| "The admin token cannot reach the zone hybridcloudinsights.com" | The token's Zone Resources do not include the lab zone, or Cloudflare lists the zone as not active | Add it to the token (the paragraph after Part 2, step 7), and check the zone is **Active** in the dashboard; nothing was changed |
| "The zone looked up for hybridcloudinsights.com answered with another name" | Cloudflare answered for another zone under the id the site had kept | Try again: the id is looked up afresh; nothing was changed |
| 400 "zone must be hybridcloudworks.com or hybridcloudinsights.com" | A call named another zone, or named it empty or twice | Name one of the two (Part 5) |
| On the page: "The server does not manage hybridcloudinsights.com yet" | The site's API is a version from before the lab zone; it answered for the site's zone | Wait a few minutes for the newer API to be deployed, then pick the lab zone again |
| The DNS tab says the list stops at the limit | The zone holds more than 5,000 records | Find the rest in the Cloudflare dashboard |
| 403 "This key may not call that route" for Network Guy | The switch for that kind of change is off | Turn it on (Part 3, step 4) |
| The Telegram message "Cloudflare API rate limit could not be checked" | The daily check (Part 4) could not read the phase: Cloudflare refused the admin token, or did not answer. The message and the Health card carry the sentence | Check the token on Integrations → Keys (Part 2) and press **Test** on the card on the [Health page](https://hybridcloudworks.com/admin/health?tab=checks). A message "is on again" follows on the first day the rule reads as on |
| 429 "Too many requests" | Either the agent key's limit of 120 calls a minute, or Cloudflare's own rate limit on the API (Part 4): more than 200 requests in 10 seconds from one address to `/api/`, lifted after 10 seconds. The Cloudflare page calls the API too, so the limit can catch your own page | Wait a minute (the Cloudflare limit lifts after 10 seconds). If your own page keeps being limited, change the rule in the Cloudflare dashboard, because the page that would change it is the one being limited |

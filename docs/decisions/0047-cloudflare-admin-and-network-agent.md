# ADR 0047: Cloudflare administration from the admin portal, and Claude Network Guy

**Status:** Accepted; amended 2026-11-26 (the API rate limit moved from Terraform to the Cloudflare page); amended 2026-11-26 (#1911: the lab zone is managed too, with the lab's certificate names, its apex and every wildcard there refused); amended 2026-11-27 (#1931: an agent key cannot set an owner-only setting through a rule); amended 2026-11-27 (#1933: an agent key's redirects go to https:// only, it keeps URL rewrites as they are, and six more TLS settings are the owner's)
**Decision date:** 2026-11-26
**Owners:** Site owner (workload and architecture)

## Context

Every visitor reaches the site through Cloudflare, which holds the site's
domain (its DNS zone, the list of names such as `api-azure` and `docs` that
point visitors to the right server), its security and caching settings, and
the rules that run in front of the site. Until now those settings were
changed in two ways only:

- **Terraform** (the tool that builds the estate from files in `infra/`)
  owns a few things: seven DNS records, the origin rule that stamps the
  secret header the Functions app checks (`cloudflare_ruleset.origin_secret`),
  the Web Analytics site, and, with
  [#1904](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1904),
  the API rate limit rule.
- **The Cloudflare dashboard**, by hand, for everything else.

> **Amended 2026-11-26: the rate limit moved from Terraform to the Cloudflare
> page, owner request via
> [#1903](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1903).**
> The rate limit rule #1904 added was never applied, and
> [#1908](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1908)
> takes it out of Terraform. Terraform now owns the seven DNS records, the
> origin rule and the Web Analytics site; the rate limit is made and changed
> on the Cloudflare page or by Claude Network Guy. See the amendment at the
> end of the Decision section.

On 2026-11-26 the owner asked
([#1905](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1905))
to be able to see and change the zone's settings from the admin portal, and
to change them by asking an agent: a third agent key beside Koda's and
Claude's, named **Claude Network Guy**, with a page that explains each agent.
The owner also asked for Claude Code to be set up with Cloudflare's own
tooling, following Cloudflare's
[agent setup instructions](https://developers.cloudflare.com/agent-setup/prompt.md).

Agent keys so far could never write to another system: ADR 0038 kept
settings writes, secrets and every delete out of an agent key's reach. This
decision widens that for one system, Cloudflare, in a narrow way.

## Purpose and decision drivers

- **Security:** an agent key is a long-lived secret held outside the site.
  Whatever it can change, a thief with it can change. Each kind of change
  is therefore its own switch, off until the owner turns it on, and nothing
  that would take the site down is in reach.
- **Reliability:** a change made by hand to something Terraform owns is
  put back on the next apply, and a wrong origin rule refuses every
  visitor's API call. Those things must stay Terraform's.
- **Operational excellence:** one place to look (the portal) and one record
  of who changed what (the audit log, and a Telegram message when an agent
  made the change).
- **Cost:** Cloudflare's API is free on the Free plan; nothing here adds a
  bill.

## Decision

1. **Claude Code loads Cloudflare's official plugin** for every session on
   this repository, through `.claude/settings.json`
   (`extraKnownMarketplaces` with `cloudflare/skills`, and
   `enabledPlugins` `cloudflare@cloudflare`), pinned to one reviewed
   commit through the marketplace's `ref`, as the repository pins its
   workflow actions. It brings Cloudflare's
   guidance skills and its remote MCP server (`https://mcp.cloudflare.com/mcp`),
   which signs in with the owner's Cloudflare account through a browser the
   first time it is used, so it works on the owner's computer and not in a
   cloud session. Nothing in that connection is stored in this repository.
2. **The site talks to Cloudflare with its own token.** A new account-owned
   Cloudflare API token
   ([account-owned tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)),
   limited to the one zone, with a one-year expiry, stored as the Key Vault
   secret `CLOUDFLARE-ADMIN-TOKEN` and pasted by the owner on
   Integrations → Keys. It is separate from Terraform's token, the lab's
   Caddy token, the analytics token and the DNS audit token, so each can be
   revoked without touching the others. The zone is named by the plain app
   setting `CF_ZONE_ID`, from the Terraform variable that already holds it.
   *(Amended 2026-11-26 (#1911): the token's Zone Resources name the lab
   zone too, and the lab zone's id is looked up by name; see the second
   amendment below.)*
3. **New admin routes under `/api/cms/cloudflare/`** read the zone (status,
   every setting, DNS records, rule sets) for an `editor`, and change it
   for a `super_admin`: one zone setting at a time, a cache purge, a DNS
   record added or edited, or the rules of one rule phase replaced. There is
   no delete route at all.
4. **Some things are refused, whoever asks, and rules are an allow-list.**
   The lists live in one file, `functions/src/lib/cloudflare/protected.js`,
   and a test fails when a Terraform record or phase is missing from it.
   - **DNS:** the apex and `www` (the site itself), every DNS record
     Terraform manages in `infra/` and `infra-lab/`, any `_acme-challenge`
     name (certificate checks), a wildcard over any of those, and `*` for
     the whole zone. A name is checked strictly (no empty part, `@` only on
     its own, `*` only as the whole first part) and the full name that was
     checked is the one sent to Cloudflare. Only A, AAAA, CNAME, MX and TXT
     records are added or edited, judged by the record's current type.
   - **Rules:** only five phases may be replaced *(six since the
     2026-11-26 amendment below added the rate limit, `http_ratelimit`)*:
     redirects
     (`http_request_dynamic_redirect`), URL rewrites
     (`http_request_transform`), response headers
     (`http_response_headers_transform`), configuration rules
     (`http_config_settings`) and custom security rules
     (`http_request_firewall_custom`). Every other phase is read-only: the
     two Terraform writes (`http_request_late_transform`, the origin rule,
     and `http_ratelimit`, the rate limit) with their own reasons, and every
     other phase, including any Cloudflare adds later, because that kind of
     rule can send or store the site's traffic elsewhere (an origin rule, a
     snippet, a cloud connector). *(Amended 2026-11-26: `http_ratelimit` is
     now a sixth editable phase and `http_request_late_transform` the only
     Terraform write; see the amendment below.)* An empty list is refused (it would delete
     every rule), a custom security rule may not `skip`, and a replacement
     must carry the version it read, and is refused if the phase changed since. Cloudflare's rule set update takes no condition, so a write that lands in the moment between that check and this write is caught afterwards: the saved version is then more than one past the checked one, and the owner is warned (#1910).
     An agent key may add rules and change existing ones but never remove
     one: its new list must keep the id of every rule the phase has now,
     or it is refused with 403 `CLOUDFLARE_OWNER_ONLY`. Removing a rule is
     the owner's, on the Cloudflare page, after typing a confirmation.
     A read-only phase's rules are answered without what they carry, and a
     secret-looking header value in an editable phase is hidden, so the
     origin secret never leaves the server.
   - **Owner-only settings:** an agent key may not change the SSL mode, the
     minimum TLS version, Always Use HTTPS, HSTS (`security_header`) or the
     certificate Cloudflare shows the site (`tls_client_auth`); a
     `super_admin` person may. *(Amended 2026-11-27 (#1931): nor set one
     through a rule, such as a configuration rule's `ssl`; see the third
     amendment below. Amended 2026-11-27 (#1933): nor TLS 1.3, the cipher
     list, automatic SSL mode, 0-RTT, SHA-1 certificates or TLS 1.2 only;
     an agent key only adds https:// redirects after the ones there are,
     and keeps URL rewrites as they are; see the fourth amendment below.)*
   - **The zone:** every change first reads the zone and is refused unless
     it is `hybridcloudworks.com`, so the list is never applied to another
     zone. *(Amended 2026-11-26 (#1911): unless it is the zone the request
     names, one of the two managed zones; see the second amendment below.)*

   The refusal names where the thing is changed instead.
5. **Claude Network Guy is a third agent key** (`claude-network`), with its
   own record, switches, audit rows and per-minute limit like the others.
   Four new switches belong to the shared list: **Cloudflare: read**,
   **change zone settings and purge the cache**, **add and edit DNS
   records**, and **edit rules**. Its key starts with only the read switch
   on. Koda's key, which used to start with every switch on, now starts with
   the list of the nine switches that existed before, so the Cloudflare
   switches stay off for Koda and for Claude Publisher until the owner turns
   one on.
6. **Every change is recorded.** Each successful write is an
   `admin_audit_logs` row (`action: cloudflare_change`) with the setting's
   value before and after, or the DNS record's type, name, proxied flag and
   TTL before and after (never what it points to). A change made by an
   agent key also sends the owner a Telegram message under a source of its
   own, so the 15-minute cooldown never swallows one. A change whose audit
   row could not be written is never silent: the owner gets a Telegram
   warning for it whoever made it, and the route's answer says
   `audited: false`. A DNS edit whose saved record comes back under a
   protected name (Cloudflare's DNS edit cannot be made conditional, so a
   rename between our read and our write is caught only afterwards) is
   recorded too, warned about the same way, and answered with
   `protectedAfterWrite: true`.
7. **The agents get their own page.** An **Agents** page in the Platform
   group explains what an agent key is and has one tab per key; the key
   tabs move there from the AI Engine page, and the old links still land on
   the right tab. Claude's key is shown as **Claude Publisher**; its id stays
   `claude`, so its record, its audit rows and the drafts it wrote keep their
   names.

### Amendment 2026-11-26: the API rate limit is the Cloudflare page's

Amended 2026-11-26: the rate limit moved from Terraform to the Cloudflare
page, owner request via
[#1903](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1903).
The owner wants Claude Network Guy to make Cloudflare changes like this one,
so nobody has to sign in to the Cloudflare dashboard by hand.
[#1908](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1908)
removes `cloudflare_ruleset.api_rate_limit` from `infra/frontend.tf` (it was
never applied, so nothing is destroyed), and this change follows it:

- **`http_ratelimit` moves from `PROTECTED_PHASES` to `EDITABLE_PHASES`** in
  `functions/src/lib/cloudflare/protected.js` and its browser mirror, as
  "Rate limiting: limit how many requests one address can make, for example
  to the API." Six phases are now editable, and `http_request_late_transform`
  (the origin rule) is the only phase Terraform writes.
- **Every guard in point 4 applies to it unchanged:** no empty list, an
  agent key may add and change rules but never remove one, the version
  check, the zone check, secret-looking header values hidden, and an audit
  row and phone message for each change.
- **Two more limits for an agent key, in the custom security rules and the
  rate limiting rules** (`GUARDED_PHASES` in
  `functions/src/lib/cloudflare/rules-guards.js`), each refused with 403
  `CLOUDFLARE_OWNER_ONLY` before anything is written: it may not switch a
  rule off, or add one that starts switched off, because a rule switched
  off is a rule removed in effect; and it may not set a custom response
  (`action_parameters.response`, the body Cloudflare sends a blocked
  caller), which only a paid plan offers and is closed ahead of time. A
  person signed in as `super_admin` may still do both.
- **Removing the rule is done in the Cloudflare dashboard.** The Free plan
  has exactly one rate limiting rule
  ([Cloudflare's availability table](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)),
  and the page refuses an empty list, so neither the page nor an agent key
  can remove it; the owner deletes it on the Cloudflare dashboard's security
  rules page. The page still asks for the phase name to be typed before a
  person removes one of several rate limiting rules, as it does for a
  custom security rule; that only matters on a paid plan, and the code is
  kept for it.
- **The sync test is tightened.** `protected.test.js` now holds that the
  protected phases are exactly the ones `infra/` and `infra-lab/` write, so
  a phase Terraform gives up is not left locked and one it takes on is
  never left editable. It also counts the `cloudflare_ruleset` blocks
  against the plain `phase = "..."` lines, so a phase written as a variable
  cannot slip past it.
- **The rule itself** is the one #1904 chose: phase `http_ratelimit`,
  expression `(lower(http.request.uri.path) contains "/api/")`, 200 requests
  per 10 seconds counted by `cf.colo.id` and `ip.src`, blocked for 10
  seconds. The steps are in the
  [Cloudflare admin runbook](../runbooks/cloudflare-admin.md#part-4-making-the-api-rate-limit-rule).
  The token's permission list in Part 2 of that runbook includes Zone WAF
  Edit, the permission
  [Cloudflare lists for a zone rate limiting rule](https://developers.cloudflare.com/terraform/additional-configurations/rate-limiting-rules/).
  The token has not been made yet, so the rule cannot be made until it is
  pasted on Integrations → Keys.

**What this adds to the accepted risks.** With the rules switch on, a stolen
Network Guy key could loosen the rate limit on the Free plan in three ways: a
much higher count, an expression that matches nothing, or a challenge in
place of a block. It cannot remove the rule, and switching it off is now
refused. It could also make the rule harsher, the opposite risk: an
expression matching every path (`/`) with a limit of 1 request would
throttle every visitor to the zone's proxied hosts, such as `api-azure` and
`notes`, including the owner's own calls from the Cloudflare page, so the change would then have to be undone
in the Cloudflare dashboard. Each change reaches the owner's phone. The rule
is no longer recorded in `infra/`, so it is not put back by an apply; the
audit log is the record, as for zone settings. Where the consequences below
say "five editable phases", read six (the bullets say six since #1933). Revisit these limits when the zone
moves to a paid plan, which adds more rate limiting rules and more ways to
change them.

### Amendment 2026-11-26 (#1911): the lab zone is managed too

Amended 2026-11-26 (#1911): the owner asked that the lab zone
`hybridcloudinsights.com` be managed from the admin portal the same way as
the site's zone, "as the lab is an integral part of the site"
([#1911](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1911)).
The lab zone exists so the lab host's Caddy (the web server that gets the
lab's certificates) writes its short-lived `_acme-challenge` proof records in
a zone of its own, never in the site's
([#948](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/948),
[ADR 0032](0032-learner-labs-platform.md)). Read on 2026-11-26: Free plan,
active, no DNS records and no zone rule sets between renewals; no Terraform
resource manages a record in it.

- **The zones are a fixed list in code,** `MANAGED_ZONES` in
  `functions/src/lib/cloudflare/protected.js` (which still imports nothing,
  so the browser mirrors its names): `hybridcloudworks.com`, first, and
  `hybridcloudinsights.com`, each with its role in a sentence and its own
  protected names, prefixes and Terraform phases. A zone not on the list is
  refused, whatever the token can reach.
- **Every route takes an optional `zone` query parameter,** a zone's name in
  any letter case. Left out, it is `hybridcloudworks.com`, so every call
  written before this keeps working. An unknown, empty or repeated value is
  refused with 400 `CLOUDFLARE_UNMANAGED_ZONE` before Cloudflare is called.
  The site's zone is still reached by `CF_ZONE_ID`; the lab zone's id is
  looked up by name with the same token (`GET /zones?name=`): exactly one
  active zone of exactly that name, kept for the function instance's life.
  A lookup that finds none, several, or one that is not active is refused
  with 502 `CLOUDFLARE_ZONE_UNREACHABLE` and a sentence telling the owner to
  add the zone to the token; a failed lookup is never kept, and a kept id is
  forgotten as soon as Cloudflare answers 403 or 404 for a call under it.
- **A name that belongs to the other zone is refused** (400): a DNS name
  sent for one zone that is the other managed zone's apex or ends with it
  (such as `x.hybridcloudworks.com` sent for the lab zone) would be made
  inside the wrong zone under a confusing name, so the caller is told to
  pick that zone.
- **The zone check names the requested zone.** Before every write the zone
  is read and must be the one the request names (409
  `CLOUDFLARE_WRONG_ZONE` otherwise); a looked-up id that answered with
  another name is forgotten, so the next request looks it up again.
- **What is refused in each zone** (corrected after the independent
  security review of the change, the same day):

  | Refused | `hybridcloudworks.com` | `hybridcloudinsights.com` (lab) |
  | --- | --- | --- |
  | The apex, for every record type | Yes (the site itself) | Yes: nothing lives there, and a record there (an MX or TXT) could receive mail for the domain or pass a check that the domain is ours |
  | `www` | Yes (the site itself) | No: nothing uses it |
  | Any name starting `_acme-challenge` | Yes | Yes |
  | Any other name with a part starting `_` (`_dmarc`, `s1._domainkey`, `_atproto`, a provider's verification record) | No: the site's zone may need them | Yes: nothing but Caddy's certificate checks lives there, and outside services prove the domain is ours or set its mail policy with such names, so they are changed in the Cloudflare dashboard (the reason names Caddy and the lab host README) |
  | The records Terraform manages | Yes (`infra/`, `infra-lab/`) | None exist there |
  | `lab` and every name under it | Yes: `lab` and `*.lab` are listed (the lab host's records, `infra-lab/dns.tf`) | Yes: the subtree of the DNS-01 target `_acme-challenge.lab.hybridcloudinsights.com`, derived from `lab_acme_challenge_target` in `infra-lab/variables.tf` (`LAB_SUBTREE`) |
  | Wildcards | Every wildcard (a `*.x` answers `_acme-challenge.x`, a protected name) | Every wildcard |

  The lab zone refuses every wildcard because Cloudflare answers a query
  with a wildcard when no exact record exists: between Caddy's renewals a
  `*.lab` CNAME or TXT would answer
  `_acme-challenge.lab.hybridcloudinsights.com`, the name the site zone's
  `_acme-challenge.lab` and `_acme-challenge.coder.lab` CNAMEs point at, and
  so could pass the DNS-01 check for the lab's own hostnames. The same
  reasoning tightens the site zone: a wildcard is refused whenever a
  protected name lies under it, not only when its base is protected, and
  since `*.x` answers `_acme-challenge.x`, a protected name in every part of
  the zone, every wildcard in the site zone is refused too (#1913 review). No
  phase is Terraform's in the lab zone, so `http_request_late_transform` is
  read-only for the plain reason rather than the origin rule's. The
  allow-list of phases, the owner-only settings and every agent-key guard
  (no remove, no switching a guarded rule off, no custom response, no empty
  list, the freshness check) apply unchanged.
- **One token covers both zones.** The owner adds the lab zone to the
  token's Zone Resources (the runbook's Part 2); there is no new secret, so
  the Keys tab, the register row and the reminder stay one each.
- **The same four switches cover both zones.** No new `POLICY` row or
  section: the agent guard matches the route's path, and the query string is
  not part of it, so `?zone=` is neither blocked nor a way around a switch.
- **The record names the zone:** the audit row's `details.zone`, and the
  Telegram message's title and last sentence ("Zone: …").
- **The page has a zone picker** above the tabs, kept in the address as
  `?zone=` (`LINK_PARAMS.zone`, left out for the site's zone). Every tab acts
  on the picked zone only and is drawn afresh when it changes. If the server
  answers for another zone (an API from before this change, during a
  deployment), the tabs are replaced by a note rather than let a change land
  in the wrong zone.

**What this adds to the accepted risks.** The lab zone serves no visitor,
but it is not harmless: it is the DNS-01 authority for the lab's
certificates (`*.lab.hybridcloudworks.com` and `*.coder.lab.hybridcloudworks.com`).
Whoever can make the right record there can get a certificate for those
names. That is why its apex, its `lab` subtree, every `_acme-challenge`
name and every wildcard are refused there, for a person and an agent key
alike. What a stolen Network Guy key with every switch on can still do in
the lab zone is add or edit A, AAAA, CNAME, MX and TXT records under other
names (`www`, say), change its zone settings, purge its cache and replace
its editable rule phases, which affect only names under
`hybridcloudinsights.com`. Each change reaches the owner's phone, naming the
zone. The token's Cloudflare permissions are the same for both zones (a
dashboard token's permission list applies to every zone it names), so the
code's refusals above, not the token, are what narrow the lab zone. **The daily DNS audit does
not watch the lab zone** (`scripts/lib/dns-audit-entries.mjs` keeps only the
site's zone, and Caddy writes and removes records there at every renewal),
so for the lab zone the record of a change is the site's audit log, the
Telegram message and Cloudflare's own audit log, unlike the consequence
below for the site's zone. Revisit if the lab zone ever serves visitors.

### Amendment 2026-11-27 (#1931): an owner-only setting cannot be set through a rule

Amended 2026-11-27, from
[#1931](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1931).
A read of the code found a way round the owner-only settings in item 4. An
agent key with the rules switch could write a **configuration rule** (the
`http_config_settings` phase), and a configuration rule can set the SSL
mode for the requests it matches. A **response header rule** (the
`http_response_headers_transform` phase) can set or remove the
`Strict-Transport-Security` header, which is HSTS (`security_header`). Both
phases are on the allow-list, so the settings route refused what the rules
route allowed.

- **One list says which rule fields stand in for an owner-only setting.**
  `RULE_SETTING_PARAMETERS` in `functions/src/lib/cloudflare/protected.js`
  maps each phase's fields to the setting they change. For configuration
  rules it lists every field on
  [Cloudflare's configuration rules settings page](https://developers.cloudflare.com/rules/configuration-rules/settings/)
  (read 2026-11-27, 15 fields). Only `ssl` is an owner-only setting. The
  page has no field for the minimum TLS version, Always Use HTTPS, HSTS or
  the certificate Cloudflare shows the site, and the other fields change
  settings an agent key may already change for the whole zone. The list is
  closed: a configuration rule field not on it is refused to an agent key,
  so a setting Cloudflare adds later starts closed. The other editable
  phases (redirects, URL rewrites, custom security rules and rate limiting
  rules) have no field that sets a zone setting.
- **What an agent key may not do.** It may not add a rule that sets one of
  those fields, change what such a rule matches or sets, switch it off,
  take the setting out of it, or move it past another such rule (when two
  match a request, the later one's value is used). Each is refused with
  403 `CLOUDFLARE_OWNER_ONLY`, writing nothing. The message names the key
  and the setting, and the settings route's refusal now names the key too.
  A rule like that which the owner made may come back unchanged, so the
  agent key can still change the phase's other rules (it may not leave a
  rule out). It may also change the rest of such a rule (its description,
  or a field that is not owner-only).
- **The owner is unchanged.** A `super_admin` person may set any of these
  in a rule, as on the settings route.
- **Field names are checked as Cloudflare writes them.** The checks read
  `action_parameters`, `headers` and `response` by their exact names, so a
  rule whose own field names, or those directly under `action_parameters`,
  are not lower-case letters, digits and underscores (`Action_Parameters`,
  `Headers`, `SSL`) is refused with 400 for everyone before anything is
  sent. Header names may still be in any case.
- **What the list does not catch.** It covers setting fields, not values.
  A redirect to an `http://` address still sends that visitor to a page
  without encryption. A URL rewrite can still change the path that an
  owner's path-matching rule sees, though a rule that matches on the host
  name is not affected. Both remain open to an agent key with the rules
  switch. The independent review for #1931 raised them as follow-ups;
  closing them is a separate decision. *(Amended 2026-11-27 (#1933): both
  are closed for an agent key; see the next amendment.)*

### Amendment 2026-11-27 (#1933): redirects, URL rewrites and six more TLS settings

Amended 2026-11-27, from
[#1933](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1933).
After #1931, the independent review found three more ways an agent key
with the rules or settings switch could weaken HTTPS or get round an owner
rule. Each matters more once the site's own names are proxied
([#1929](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1929)).
A second independent review of this change found two more ways round the
redirect limits, closed here as well.

- **One list says what an agent key may not do in each phase.**
  `AGENT_PHASE_LIMITS` in `functions/src/lib/cloudflare/agent-phase-limits.js`
  names each phase's limits:
  - no switching a rule off (custom security rules, the rate limit and
    now redirects);
  - no custom response (custom security rules and the rate limit);
  - new rules only after the current ones (redirects);
  - https:// targets only (redirects);
  - keep as is (URL rewrites).
- **An agent key only adds redirects, after the ones there are.** The
  first redirect that matches a request is the one used: a redirect ends
  the request, so later ones never run
  ([actions](https://developers.cloudflare.com/ruleset-engine/rules-language/actions/)).
  So an agent key could turn off one of the owner's redirects without
  switching it off. It could change what the redirect matches, or put a
  new redirect before it. That includes an http-to-https redirect, the
  per-request form of Always Use HTTPS. This page does not know who made
  a rule, so every redirect the phase holds now is treated as the
  owner's. They must come back first, exactly as they are and in the same
  order, and new redirects go after them; only a description may change.
  The issue asked that an agent key not switch off "a redirect the owner
  made"; this is the only way to meet that without a record of who made
  each rule. It means the agent key cannot change a redirect it made
  earlier either. The owner changes it, or removes it so the agent key
  can add it again.
- **A new redirect from an agent key goes to an https:// address on the
  site's own zones.** A redirect to `http://` sends that visitor to a page
  without encryption, which is what Always Use HTTPS (`always_use_https`)
  exists to stop. A redirect to another site lets anyone send visitors
  there through the site's own address (an open redirect). So the target
  must be on one of the managed zones, `hybridcloudworks.com` or
  `hybridcloudinsights.com`, or one of their subdomains, the same rule
  the cache purge already uses. A new redirect from an agent key is
  refused unless:
  - a fixed target (`target_url.value`) is an `https://` address on one of
    those names, with no user name before the host (`https://zone@elsewhere`
    goes to elsewhere), no port and no backslash;
  - a target worked out per request (`target_url.expression`) starts with a
    string, on its own or as the first part of `concat(`, that holds
    `https://` and a host on one of those names. The result of `concat`
    starts with its first part, so the scheme and host are fixed by text
    the check can read. The host must be followed by a slash, or end a
    string that is the whole address. Inside `concat(` it may also end the
    string just before a part that always starts with a slash
    (`http.request.uri.path`, `http.request.uri` or their `raw.` forms).
    Otherwise the next part could carry the host on, as in
    `concat("https://hybridcloudworks.com", ".elsewhere.com")`. Anything
    else is refused to an agent key, because its result can be the
    request's own `http://` address or another site: `wildcard_replace`, a
    field such as `http.host` for the host, or a string with an escape in
    it. This keeps the common "send www to the bare name" redirect,
    `concat("https://hybridcloudworks.com", http.request.uri.path)`, open
    to the agent key.
  - the rule's parameters hold only what
    [Cloudflare documents for a redirect](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/settings/)
    (`from_value` with `target_url`, `status_code` and
    `preserve_query_string`), and its action is `redirect`.
- **A rule list may not hold one id twice.** It is refused with 400 for
  everyone, because the checks above compare each rule with the one of the
  same id the phase holds now.
- **An agent key keeps the URL rewrite phase as it is.** A URL rewrite
  (`http_request_transform`) runs before the configuration rules, the
  custom security rules, the rate limit, cache rules and Cloudflare's own
  managed rules
  ([phases list](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/)),
  and each of them then sees the rewritten path and query. Telling which
  rewrites would change what an owner's rule matches would mean running
  Cloudflare's rules language here, and Cloudflare's managed rules read
  the path too, so an exact check is not possible. The safest rule that
  works is that an agent key must send the phase's rules back exactly as
  they are: it may not add, change, switch on or off, or move a rewrite.
  It may still change a rule's description. **This takes URL rewrites away
  from Claude Network Guy.** If the owner would rather keep them with the
  agent and accept that a rewrite can change what a path-matching rule
  sees, the `keepAsIs` entry is removed from the list; that is the
  owner's decision.
- **Six more settings are owner-only.** Each id was checked on
  Cloudflare's own pages on 2026-11-27:
  - `tls_1_3`: turning it off weakens HTTPS, and its `zrt` value allows
    replayed early requests;
  - `ciphers`: which encryption methods are allowed;
  - `ssl_automatic_mode`: whether Cloudflare picks the SSL mode;
  - `0rtt`: requests that can be replayed;
  - `sha1_support`: certificates signed with SHA-1, a broken method;
  - `tls_1_2_only`: an older switch that overlaps the minimum TLS version.

  The settings route stays a list of what is refused rather than of what
  is allowed, for two reasons. An allow-list would take away settings the
  owner has already given Network Guy, and every allowed id would need
  checking first. "Owner-only" here means the settings that decide how an
  https:// connection is encrypted, and those can be listed. Four
  settings nearby stay open on purpose:
  - `automatic_https_rewrites` rewrites links inside pages;
  - `opportunistic_encryption` offers encryption to http:// visitors,
    whom Always Use HTTPS already sends to https://;
  - `ssl_recommender` only enrols the zone in emailed recommendations;
  - `replace_insecure_js` swaps script links to known unsafe services for
    copies on cdnjs
    ([Cloudflare's page](https://developers.cloudflare.com/waf/tools/replace-insecure-js-libraries/)).

  Revisit if Cloudflare adds a setting in this family. Whether the
  security level, Browser Integrity Check or the WAF should be owner-only
  is a separate decision for the owner, not made here.
- **Refusals name the key.** The new refusals, and the refusal of a rule
  switched off, begin with the key's name, for example "Claude Network
  Guy (an agent key) may not switch a redirect off".
- **The owner is unchanged.** A `super_admin` person may do all of it.

## Consequences and accepted risks

- **A stolen Network Guy key with every switch on could change zone
  settings, add or edit DNS records and add or change rules in the six
  editable phases,** within the token's own Cloudflare permissions. It
  could not delete a record or a ruleset, remove a rule, touch the site's own address,
  Terraform's records or phases, the owner-only settings (on the settings
  route or through a rule, since #1931) or any other phase, or reach
  anything outside the zone. The owner limits this by
  turning on only the switches a task needs, by the token's own permission
  list, and by the Telegram message each change sends.
- **The rules switch can still redirect or reconfigure requests to the
  API host.** The six editable phases apply to every host in the zone,
  `api-azure.hybridcloudworks.com` included: a redirect can send the API's
  callers elsewhere (from an agent key, only a new redirect to an https://
  address on the site's own zones, placed after the existing ones, since
  #1933), a URL rewrite can change which route a request reaches (the
  owner's alone since #1933), a response header rule can change what the browser is told,
  and a configuration rule can turn off a setting (such as the security
  level) for matching requests, though not an owner-only one (#1931). None of them can read or change the origin
  secret header, which is set in the read-only late-transform phase. This
  is accepted because those are the rules the owner asked the agent to
  manage; it is why the rules switch starts off and each change reaches
  the owner's phone. Narrowing it further (refusing any rule whose
  expression names the API host) is the next step if it is ever needed.
- **When the owner replaces a phase, the rules left out are removed.**
  There is no delete route, and an empty list is refused, but a shorter
  list from a person is still a removal; the page asks for the phase's
  name to be typed before a custom security rule is removed, and the audit
  row records the count. An agent key's shorter list is refused: every
  rule the phase has now must keep its id in the new list. An agent key
  can still change a kept rule into one that matches nothing, which is
  why each of its changes reaches the owner's phone.
- **The DNS audit will call a Network Guy DNS change unexpected** (in the
  site's zone; the audit does not read the lab zone, see the second
  amendment).
  `cloudflare-dns-audit.yml` opens an issue for any DNS change made by
  something it does not know, and this token is not on its list. That is
  left as it is on purpose for now: a DNS change by an agent is rare, and an
  issue is a useful second notice. If it becomes noise, the audit can learn
  the token's name.
- **Zone settings are not in Terraform,** so a setting changed here is not
  reverted by an apply; it is also not recorded in `infra/`. The audit log
  is the record.
- Agent keys now span two jobs (content and network), so the page that
  manages them is no longer only an AI Engine matter; hence the Agents page.

## Alternatives considered

- **Only the Cloudflare MCP server in Claude Code.** It already lets Claude
  change any setting with the owner's own sign-in, and it is part of this
  decision. On its own it leaves nothing in the portal, no audit row in the
  site, and works only while the owner's computer is signed in.
- **Reuse Terraform's Cloudflare token.** It lives in HCP Terraform, has
  more power than the site needs, and copying it into Key Vault would put
  it in a second, more exposed place.
- **A generic pass-through to any Cloudflare API path.** Simplest to build,
  but it could not tell a setting from a delete or protect Terraform's
  records, and every new kind of change would be open to the agent at once.
- **Put Cloudflare under the Platform switch.** That switch is read-only by
  design (ADR 0038) and is on for Koda; Cloudflare changes need their own.

## Validation and revisit triggers

- Validated by the functions tests for the routes, the protected list and
  the switches, and by the Services card's **Test** and the Health page
  once the token is pasted.
- Revisit when Terraform starts managing zone settings, when a Cloudflare
  plan with more features is bought, when the DNS audit's issues for this
  token become noise, or if a Network Guy change ever needs undoing by hand.
- Added 2026-11-26 with the amendment: revisit when the zone moves to a paid
  plan, because the rate limiting guards above assume the Free plan's one
  rule.

## Related decisions and references

- [ADR 0037](0037-agent-content-api.md) Agent Content API (Koda), and
  [ADR 0038](0038-koda-admin-access.md) Koda's admin access, which this
  widens for Cloudflare only.
- [Cloudflare admin runbook](../runbooks/cloudflare-admin.md): making the
  token and turning the switches on.
- [Agent Content API runbook](../runbooks/agent-content-api.md), part 9:
  Claude Network Guy's key.
- Cloudflare:
  [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/),
  [create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
  [API reference](https://developers.cloudflare.com/api/).

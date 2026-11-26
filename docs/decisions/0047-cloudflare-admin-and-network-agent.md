# ADR 0047: Cloudflare administration from the admin portal, and Claude Network Guy

**Status:** Accepted
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
3. **New admin routes under `/api/cms/cloudflare/`** read the zone (status,
   every setting, DNS records, rule sets) for an `editor`, and change it
   for a `super_admin`: one zone setting at a time, a cache purge, a DNS
   record added or edited, or the rules of one rule phase replaced. There is
   no delete route at all.
4. **Some things are refused, whoever asks:** the apex and `www` (the site
   itself), every DNS record Terraform manages in `infra/` and `infra-lab/`,
   any `_acme-challenge` name (certificate checks), and the rule phases
   Terraform manages (`http_request_late_transform`, the origin rule, and
   `http_ratelimit`, the rate limit). The list lives in one file,
   `functions/src/lib/cloudflare/protected.js`, and a test fails when a
   Terraform record or phase is missing from it. The refusal names the file
   that manages the thing, so the change is made there.
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
   `admin_audit_logs` row (`action: cloudflare_change`), and a change made
   by an agent key also sends the owner a Telegram message.
7. **The agents get their own page.** An **Agents** page in the Platform
   group explains what an agent key is and has one tab per key; the key
   tabs move there from the AI Engine page, and the old links still land on
   the right tab. Claude's key is shown as **Claude Publisher**; its id stays
   `claude`, so its record, its audit rows and the drafts it wrote keep their
   names.

## Consequences and accepted risks

- **A stolen Network Guy key with every switch on could change zone
  settings, add or edit DNS records and replace rules,** within the token's
  own Cloudflare permissions. It could not delete, touch the site's own
  address or Terraform's things, or reach anything outside the zone. The
  owner limits this by turning on only the switches a task needs, by the
  token's own permission list, and by the Telegram message each change
  sends.
- **The DNS audit will call a Network Guy DNS change unexpected.**
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

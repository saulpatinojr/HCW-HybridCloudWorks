/** The fixed names the DNS audit works with (zone, environment variables, HCP Terraform workspace), and the actors Cloudflare itself uses (cloudflare-dns-audit.mjs). */

export const API_BASE = 'https://api.cloudflare.com/client/v4';
/** The production zone, by name. The zone id, when given, is matched too. */
export const ZONE_NAME = 'hybridcloudworks.com';
/**
 * The name of the hcw-azure workspace's token, as the dashboard shows it: the
 * account-owned token `hcw` (#1927; it was `hcp-terraform-cloudflare-dns`
 * here until then, a user token that is most likely hcw-lab's). The
 * credential tests hold it to CLOUDFLARE_TARGETS.azure.tokenName.
 */
export const HCP_TERRAFORM_TOKEN_NAME = 'hcw';
export const ACME_CHALLENGE_PREFIX = '_acme-challenge.';
/** The lab's names: Caddy answers challenges for `lab` and `*.coder.lab` only. */
export const LAB_SUFFIX = '.lab.hybridcloudworks.com';
/** 26 hours: a daily run overlaps the previous one by two, so no minute is unread across a late start. */
export const DEFAULT_WINDOW_HOURS = 26;
/** Cloudflare's maximum page; one small account's day is a fraction of one page. */
export const PAGE_LIMIT = 1000;
/** More than this is not "a quiet zone"; the run fails and says to narrow the window. */
export const MAX_PAGES = 20;
/** The workflow's issue title starts with this; the date follows. */
export const ISSUE_TITLE_PREFIX = 'Cloudflare DNS audit: unexpected record change';
/** How the hidden line that ends a report with an UNEXPECTED change starts (#1681). */
export const FINDINGS_MARKER = '<!-- cloudflare-dns-audit findings:';

/** Environment variable names, and what each is for. */
export const ENV = {
  /** The audit-read token: Account → Account Settings → Read on the one account. A repository secret. */
  token: 'CLOUDFLARE_AUDIT_LOG_TOKEN',
  /** The Cloudflare account id. An identifier, so a repository variable. */
  accountId: 'CLOUDFLARE_ACCOUNT_ID',
  /** The production zone id (optional): matched beside ZONE_NAME, for an entry whose zone name is absent. */
  zoneId: 'CLOUDFLARE_ZONE_ID',
  /** The owner's dashboard sign-in (optional): the owner-dashboard allowlist entry is inactive without it. */
  ownerEmail: 'CLOUDFLARE_DNS_AUDIT_OWNER_EMAIL',
  /** The Caddy runtime token's name, as the API Tokens page shows it (optional): matched when the log carries `actor.token_name`, which the first live run showed it does not for this account's tokens. */
  caddyTokenName: 'CLOUDFLARE_CADDY_TOKEN_NAME',
  /** The lab host's public address, the one the Caddy token's client-IP filter allows (optional): the identity the log does carry for that token. The caddy-acme entry is inactive without this or the name. */
  caddyHostIp: 'CLOUDFLARE_CADDY_HOST_IP',
  /** The HCP Terraform API token the repository already holds (read-only here): the hcp-terraform entry is inactive without it, because a Terraform-looking edit is EXPECTED only while an apply of the workspace was in progress. */
  tfcToken: 'TFC_TOKEN',
};

/** HCP Terraform: the organisation and workspace whose applies own the zone's Terraform-managed records. */
export const TFC_API = 'https://app.terraform.io/api/v2';
export const TFC_ORGANIZATION = 'hcw';
export const TFC_WORKSPACE = 'hcw-azure';
/** An apply's window, padded: the provider's first write can land a little before `applying-at` is stamped, and the last a little after the apply ended. */
export const APPLY_LEAD_MS = 2 * 60 * 1000;
export const APPLY_TAIL_MS = 5 * 60 * 1000;
/** The stamps that end an apply, in the order one of them is set: an apply that errored or was cancelled still wrote until then. */
export const APPLY_END_STAMPS = ['applied-at', 'errored-at', 'canceled-at', 'force-canceled-at'];
/** Pages of 100 runs (every status; plan-only runs carry no `applying-at` and are skipped) read back from the newest; the window is days, not years. */
export const MAX_RUN_PAGES = 10;

/**
 * What the audit log carried for the HCP Terraform workspace's edits on the
 * first live run (2026-10-18, #948): `actor.context` `api_token`, no
 * `token_name` or `token_id`, and this user agent. The provider's agent is
 * the identity the log gives, so it is the one the allowlist binds to.
 */
export const TERRAFORM_USER_AGENT_PREFIX = 'terraform-provider-cloudflare/';

/**
 * When the lab host stopped holding a token that can write the production
 * zone: bootstrap.sh at 0d00bc89 rotated `/etc/caddy/env` to the lab-zone
 * token and restarted Caddy at 2026-10-18T20:52:52Z (#948, #1279); the
 * production-zone token was revoked later that evening. A challenge TXT in
 * the production zone from the host's address before this instant was the
 * interim ADR 0032 recorded; one at or after it has no credential that could
 * legitimately have made it, so the `caddy-acme` entry refuses it.
 */
export const CADDY_PRODUCTION_ZONE_ACCESS_ENDED = '2026-10-18T20:53:00Z';
/**
 * The name Cloudflare writes its own certificate-validation TXT records to:
 * `_acme-challenge.` on the zone apex, which validates the apex and the
 * wildcard the universal certificate covers. Exactly this name: a challenge
 * for `www` or any other host is not Cloudflare's renewal and stays UNEXPECTED.
 */
export const CLOUDFLARE_DCV_CHALLENGE_NAME = `${ACME_CHALLENGE_PREFIX}${ZONE_NAME}`;

/**
 * Cloudflare acting on its own, as the audit log carries it (read on
 * 2026-10-26, 10-27 and 10-30, #1421): an actor whose ONLY field is
 * `type: system`, with no context, id, e-mail, address or token fields, and a
 * request with no method and no user agent. Cloudflare's audit-log reference
 * defines `system` as "changes made automatically by Cloudflare systems,
 * without direct user input"; an API token, stolen or not, is authenticated
 * and arrives as `account` or `user` with `context: api_token`, so this shape
 * is not one a token can produce.
 */
export function isCloudflareSystemActor(change) {
  return Object.entries(SYSTEM_ACTOR_SHAPE).every(([field, value]) => change[field] === value);
}

/** Every field of a change as Cloudflare acting on its own leaves it: `type: system` and nothing else. */
const SYSTEM_ACTOR_SHAPE = Object.freeze({
  actorType: 'system',
  actorFields: 'type',
  actorContext: '',
  actorId: '',
  actorEmail: '',
  actorIp: '',
  tokenName: '',
  tokenId: '',
  method: '',
  userAgent: '',
});
/** A read the script cannot evaluate past: exit 1. */
export class AuditReadError extends Error {}

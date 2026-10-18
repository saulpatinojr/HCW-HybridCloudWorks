#!/usr/bin/env node
/**
 * cloudflare-dns-audit.mjs — did anything edit a DNS record in the production
 * zone that was not supposed to? (estate review 2026-10-06, LAB-1; #948)
 *
 * The lab host's Caddy holds a Cloudflare token with DNS edit on
 * `hybridcloudworks.com`, because the DNS-01 challenge for the lab's wildcard
 * certificate is answered in that zone until a dedicated lab zone exists (ADR
 * 0032). The token is zone-scoped, pinned to the host's address and dated,
 * and still the only record of what it did is Cloudflare's own audit log:
 * neither the HCP Terraform plan nor the deploy-drift monitor reads the zone,
 * and Cloudflare has no notification type for audit-log or DNS-record events
 * on any plan (read 2026-10-18; the owner's decision on #948 is this poller).
 *
 * Once a day, cloudflare-dns-audit.yml runs this over the account audit log
 * (Audit Logs v2, `GET /accounts/{account_id}/logs/audit`), keeps the
 * create, update and delete events on DNS records in the production zone,
 * and judges each against ALLOWLIST below. Anything the allowlist does not
 * name is UNEXPECTED, and the workflow turns that into an issue.
 *
 * Exit codes, and they are the contract the workflow reads:
 *
 *   0  the window was read in full and every DNS-record change is expected,
 *      or there was none;
 *   2  at least one change is UNEXPECTED (the report names it);
 *   1  the log could not be read: no token, no account id, a non-200, a
 *      body that is not Cloudflare's `success: true` envelope, more pages
 *      than MAX_PAGES, or arguments that do not parse. Never 0 on a failed
 *      read: an empty answer with a non-200 is a failure, not "no edits".
 *
 * Content-free by construction: the token is read from the environment and
 * never printed; of each record only its type and name reach the report,
 * never its content; actor e-mail addresses are masked (`s***@example.com`).
 * The audit log entry id is printed in full, so the owner can open the exact
 * entry in the dashboard.
 *
 * Usage: node scripts/cloudflare-dns-audit.mjs [--since <RFC3339|YYYY-MM-DD>] [--before <RFC3339|YYYY-MM-DD>]
 *          [--hours <n>] [--report <file>]
 *
 * Environment: CLOUDFLARE_AUDIT_LOG_TOKEN (secret; Account Settings Read on the
 * one account), CLOUDFLARE_ACCOUNT_ID, and optionally CLOUDFLARE_ZONE_ID,
 * CLOUDFLARE_DNS_AUDIT_OWNER_EMAIL, CLOUDFLARE_CADDY_HOST_IP,
 * CLOUDFLARE_CADDY_TOKEN_NAME and TFC_TOKEN (secret); ENV below says what each
 * one does.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API_BASE = 'https://api.cloudflare.com/client/v4';
/** The production zone, by name. The zone id, when given, is matched too. */
export const ZONE_NAME = 'hybridcloudworks.com';
/** The name of the HCP Terraform workspace's token, as the dashboard shows it. */
export const HCP_TERRAFORM_TOKEN_NAME = 'hcp-terraform-cloudflare-dns';
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
/** An apply's window, padded: the provider's first write can land a little before `applying-at` is stamped, and the last a little after `applied-at`. */
export const APPLY_LEAD_MS = 2 * 60 * 1000;
export const APPLY_TAIL_MS = 5 * 60 * 1000;
/** Pages of 100 applied runs read back from the newest; the window is days, not years. */
export const MAX_RUN_PAGES = 10;

/**
 * What the audit log carried for the HCP Terraform workspace's edits on the
 * first live run (2026-10-18, #948): `actor.context` `api_token`, no
 * `token_name` or `token_id`, and this user agent. The provider's agent is
 * the identity the log gives, so it is the one the allowlist binds to.
 */
export const TERRAFORM_USER_AGENT_PREFIX = 'terraform-provider-cloudflare/';

/** An API-token request whose user agent is the Cloudflare Terraform provider. */
function isTerraformProviderRequest(change) {
  return change.actorContext === 'api_token' && change.userAgent.startsWith(TERRAFORM_USER_AGENT_PREFIX);
}

/** The request came from the lab host: the only place the Caddy token works, by its client-IP filter. */
function isFromCaddyHost(change, settings) {
  return settings.caddyHostIp !== '' && change.actorIp === settings.caddyHostIp;
}

/**
 * Was an apply of the workspace in progress when the change was made? The
 * windows come from HCP Terraform's own run record (`fetchTerraformApplies`);
 * null means they could not be read, and nothing matches.
 */
export function withinApply(time, applyWindows) {
  if (!Array.isArray(applyWindows)) return false;
  const t = Date.parse(time);
  if (Number.isNaN(t)) return false;
  return applyWindows.some((w) => t >= w.start - APPLY_LEAD_MS && t <= w.end + APPLY_TAIL_MS);
}

/** The Caddy token, by the name the log would carry or by the address the token's IP filter pins it to. */
function isCaddyToken(change, settings) {
  if (change.actorContext !== 'api_token') return false;
  if (settings.caddyTokenName !== '' && change.tokenName === settings.caddyTokenName) return true;
  return isFromCaddyHost(change, settings);
}

/**
 * THE ALLOWLIST. A change is EXPECTED when one entry matches it and
 * UNEXPECTED otherwise, so an entry that is too narrow costs an issue to
 * read, never a missed edit. Each entry says why it exists; extending the
 * list means adding an entry with its reason here, in a reviewed pull
 * request, never widening one in place.
 *
 * `active(settings)` says whether the entry can match at all with the
 * settings in hand; the report lists the inactive ones and why, so a quiet
 * run is never mistaken for a complete allowlist.
 */
export const ALLOWLIST = [
  {
    id: 'hcp-terraform',
    reason:
      `The \`${HCP_TERRAFORM_TOKEN_NAME}\` API token is the HCP Terraform workspace's: every record it ` +
      'creates, updates or deletes is a plan the owner confirmed in the HCP Terraform UI, and the ' +
      'plan check holds those records to the declared diff. The audit log carries no token name or id ' +
      'for it (read on the first live run, 2026-10-18), and a user agent is a header anyone can send, ' +
      'so the identity is a correlation with the apply itself: an account-owned API token ' +
      '(`actor.type` `account`, `actor.context` `api_token`) whose request came from the Cloudflare ' +
      `Terraform provider (user agent \`${TERRAFORM_USER_AGENT_PREFIX}…\`), not from the lab host (whose ` +
      "address belongs to the Caddy token's entry), WHILE an apply of the " +
      `\`${TFC_ORGANIZATION}/${TFC_WORKSPACE}\` workspace was in progress by HCP Terraform's own run ` +
      `record, read with \`${ENV.tfcToken}\`. The token name is matched too, should the log ever carry it.`,
    active: (settings) => Array.isArray(settings.applyWindows),
    matches: (change, settings) =>
      (change.tokenName !== '' && change.tokenName === HCP_TERRAFORM_TOKEN_NAME) ||
      (change.actorType === 'account' &&
        isTerraformProviderRequest(change) &&
        !isFromCaddyHost(change, settings) &&
        withinApply(change.time, settings.applyWindows)),
  },
  {
    id: 'terraform-owner-token',
    reason:
      "The owner's own `terraform` runs from the workstation, authenticated with a user-owned API token " +
      '(`actor.type` `user`, `actor.context` `api_token`, the owner\'s e-mail, the provider\'s user agent): ' +
      'the 2026-10-06 00:26Z edits on the first live run were these. The HCP Terraform workspace is the ' +
      'normal path, so these stay visible in the report under their own entry rather than folded into ' +
      "`hcp-terraform`; a reader who sees many of them asks why applies are leaving the workspace. " +
      `Identified by the e-mail in \`${ENV.ownerEmail}\` and the provider's user agent.`,
    active: (settings) => settings.ownerEmail !== '',
    matches: (change, settings) =>
      settings.ownerEmail !== '' &&
      change.actorType === 'user' &&
      change.actorEmail.toLowerCase() === settings.ownerEmail.toLowerCase() &&
      isTerraformProviderRequest(change) &&
      !isFromCaddyHost(change, settings),
  },
  {
    id: 'caddy-acme',
    reason:
      "The lab host's Caddy renews the lab wildcard by DNS-01, which is a TXT record under " +
      `\`${ACME_CHALLENGE_PREFIX}\` for a lab name (\`_acme-challenge.lab.hybridcloudworks.com\` or ` +
      '`_acme-challenge.coder.lab.hybridcloudworks.com`), created and then deleted minutes later. ' +
      'That is ALL this token may do: an A, CNAME or MX record from it, or a challenge TXT for a ' +
      'name outside the lab (`_acme-challenge.www…`, which would be a certificate for the site), ' +
      "is the finding this poller exists for. Identified by the lab host's address in " +
      `\`${ENV.caddyHostIp}\` (the token's client-IP filter allows that address alone, so any API-token ` +
      `request from it is this token), or by the token name in \`${ENV.caddyTokenName}\` should the log carry it.`,
    active: (settings) => settings.caddyTokenName !== '' || settings.caddyHostIp !== '',
    matches: (change, settings) =>
      isCaddyToken(change, settings) &&
      change.recordType === 'TXT' &&
      isLabAcmeChallenge(change.recordName),
  },
  {
    id: 'owner-dashboard',
    reason:
      "The owner's own edits in the Cloudflare dashboard (the apex and `www` records are hand-made " +
      'by design; docs/runbooks/edge-dns-verification.md). A dashboard session signed in as the ' +
      `owner, by the e-mail in \`${ENV.ownerEmail}\`; the owner's API tokens are \`terraform-owner-token\` ` +
      'when the provider made the request, and nothing otherwise.',
    active: (settings) => settings.ownerEmail !== '',
    matches: (change, settings) =>
      settings.ownerEmail !== '' &&
      change.actorContext === 'dash' &&
      change.actorType === 'user' &&
      change.actorEmail.toLowerCase() === settings.ownerEmail.toLowerCase(),
  },
];

/** A read the script cannot evaluate past: exit 1. */
export class AuditReadError extends Error {}

/** `_acme-challenge.<lab name>`: the prefix, and a name under the lab subtree. */
export function isLabAcmeChallenge(name) {
  const lower = String(name ?? '').toLowerCase().replace(/\.$/, '');
  return lower.startsWith(ACME_CHALLENGE_PREFIX) && lower.endsWith(LAB_SUFFIX);
}

/** `alice@example.com` -> `a***@example.com`; anything without an `@` is returned as is. */
export function maskEmail(email) {
  const text = String(email ?? '');
  const at = text.indexOf('@');
  if (at < 1) return text;
  return `${text[0]}***${text.slice(at)}`;
}

const str = (value) => (typeof value === 'string' ? value : '');
const lower = (value) => str(value).toLowerCase();

/** create | update | delete | view | '' from the entry's action type, else from the HTTP method. */
export function actionType(entry) {
  const type = lower(entry?.action?.type);
  if (type) return type;
  const method = str(entry?.raw?.method).toUpperCase();
  if (method === 'POST') return 'create';
  if (method === 'PUT' || method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';
  if (method === 'GET') return 'view';
  return '';
}

/**
 * Is this entry about a DNS record? The resource's product or type says so
 * (`dns` / `dns_record`); the request URI (`/zones/<id>/dns_records…`) is the
 * fallback for an entry whose resource block is thin.
 */
export function isDnsRecordEntry(entry) {
  const product = lower(entry?.resource?.product);
  const type = lower(entry?.resource?.type);
  const uri = lower(entry?.raw?.uri);
  if (/dns_?record/.test(type)) return true;
  if (product === 'dns' && (type === '' || /record/.test(type))) return true;
  return /\/zones\/[^/]+\/dns_records(\/|\?|$)/.test(uri);
}

/** Is this entry on the production zone: by id when one is known, by name always. */
export function isProductionZone(entry, zoneId = '') {
  const id = str(entry?.zone?.id);
  const name = lower(entry?.zone?.name).replace(/\.$/, '');
  if (zoneId && id === zoneId) return true;
  if (name === ZONE_NAME) return true;
  if (zoneId && str(entry?.raw?.uri).includes(`/zones/${zoneId}/`)) return true;
  return false;
}

/**
 * The record's type and name, from wherever the entry carries them: the
 * response body, its `result`, the request body, or a `value` block. A delete
 * usually carries neither, which `normalise` fills from a sibling entry on the
 * same resource id.
 */
export function recordFields(entry) {
  const resource = entry?.resource ?? {};
  const candidates = [resource.response, resource.response?.result, resource.request, resource.value, resource.metadata];
  let name = '';
  let type = '';
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    if (!name && typeof c.name === 'string') name = c.name;
    if (!type && typeof c.type === 'string') type = c.type;
    if (name && type) break;
  }
  return { name: name.replace(/\.$/, ''), type: type.toUpperCase() };
}

/**
 * One DNS-record change, flattened to what the allowlist and the report
 * need. `siblings` are the other entries of the same read, for a delete that
 * names its resource id and nothing else.
 */
export function normalise(entry, siblings = []) {
  const actor = entry?.actor ?? {};
  const fields = recordFields(entry);
  let nameSource = 'entry';
  const resourceId = str(entry?.resource?.id);
  if ((!fields.name || !fields.type) && resourceId) {
    const sibling = siblings.find((s) => s !== entry && str(s?.resource?.id) === resourceId && recordFields(s).name);
    if (sibling) {
      const from = recordFields(sibling);
      fields.name = fields.name || from.name;
      fields.type = fields.type || from.type;
      nameSource = 'sibling';
    }
  }
  return {
    id: str(entry?.id),
    time: str(entry?.action?.time),
    actionType: actionType(entry),
    result: lower(entry?.action?.result) || 'unknown',
    actorType: lower(actor.type),
    actorContext: lower(actor.context),
    actorEmail: str(actor.email),
    actorId: str(actor.id),
    actorIp: str(actor.ip_address),
    tokenName: str(actor.token_name),
    tokenId: str(actor.token_id),
    // The shape of the actor as Cloudflare sent it (field names only, never
    // values) and the request's user agent: what the report prints for an
    // UNEXPECTED change, so an allowlist entry can be bound to what the audit
    // log really carries for that actor rather than to what the docs promise.
    actorFields: Object.keys(actor)
      .filter((k) => str(actor[k]) !== '')
      .sort()
      .join(','),
    userAgent: str(entry?.raw?.user_agent),
    method: str(entry?.raw?.method).toUpperCase(),
    zoneId: str(entry?.zone?.id),
    zoneName: str(entry?.zone?.name),
    resourceId,
    recordType: fields.type || 'unknown',
    recordName: fields.name || 'unknown',
    nameSource: fields.name ? nameSource : 'none',
  };
}

/** The create/update/delete entries on DNS records in the production zone, oldest first. */
export function dnsRecordChanges(entries, settings = {}) {
  const zoneId = str(settings.zoneId);
  const kept = entries.filter((e) => {
    const type = actionType(e);
    return (type === 'create' || type === 'update' || type === 'delete') && isDnsRecordEntry(e) && isProductionZone(e, zoneId);
  });
  return kept.map((e) => normalise(e, entries)).sort((a, b) => a.time.localeCompare(b.time));
}

/** EXPECTED with the entry that allowed it, or UNEXPECTED. */
export function classify(change, settings) {
  for (const entry of ALLOWLIST) {
    if (entry.matches(change, settings)) return { verdict: 'EXPECTED', rule: entry.id };
  }
  return { verdict: 'UNEXPECTED', rule: null };
}

/** Settings from the environment; the token stays out of this object. */
export function settingsFrom(env) {
  return {
    accountId: str(env[ENV.accountId]).trim(),
    zoneId: str(env[ENV.zoneId]).trim(),
    ownerEmail: str(env[ENV.ownerEmail]).trim(),
    caddyTokenName: str(env[ENV.caddyTokenName]).trim(),
    caddyHostIp: str(env[ENV.caddyHostIp]).trim(),
    // Filled by main from HCP Terraform; null until then, so nothing matches by accident.
    applyWindows: null,
  };
}

/** The list URL for one page. `since`/`before` are RFC3339 strings. */
export function auditLogUrl({ accountId, since, before, cursor }) {
  const url = new URL(`${API_BASE}/accounts/${encodeURIComponent(accountId)}/logs/audit`);
  url.searchParams.set('since', since);
  url.searchParams.set('before', before);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('direction', 'asc');
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

/** The `errors[].message` lines of a Cloudflare envelope, or nothing; never the body itself. */
function envelopeErrors(doc) {
  if (!doc || !Array.isArray(doc.errors)) return '';
  const messages = doc.errors.map((e) => str(e?.message)).filter(Boolean);
  return messages.length ? ` (${messages.join('; ')})` : '';
}

/**
 * Read the whole window, following `result_info.cursor`. Returns
 * `{ entries, pages }` or throws AuditReadError with a content-free reason.
 */
export async function fetchAuditLog({ accountId, since, before, token, fetchImpl = fetch }) {
  const entries = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = auditLogUrl({ accountId, since, before, cursor });
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AuditReadError(`page ${page}: the request failed (${error?.message ?? error})`);
    }
    const text = await response.text();
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    if (!response.ok) {
      throw new AuditReadError(`page ${page}: HTTP ${response.status}${envelopeErrors(doc)}`);
    }
    if (!doc || doc.success !== true || !Array.isArray(doc.result)) {
      throw new AuditReadError(`page ${page}: the answer is not the \`success: true\` envelope with a \`result\` array${envelopeErrors(doc)}`);
    }
    entries.push(...doc.result);
    const next = str(doc.result_info?.cursor);
    if (!next || doc.result.length === 0) return { entries, pages: page };
    if (seen.has(next)) throw new AuditReadError(`page ${page}: the cursor repeated; refusing to loop`);
    seen.add(next);
    cursor = next;
  }
  throw new AuditReadError(`more than ${MAX_PAGES} pages of ${PAGE_LIMIT} in the window; narrow it with --since and --before`);
}

/** One JSON:API GET against HCP Terraform; every failure is an AuditReadError, because an unread run record cannot clear a change. */
async function tfcGet(path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${TFC_API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.api+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AuditReadError(`HCP Terraform ${path}: the request failed (${error?.message ?? error})`);
  }
  const text = await response.text();
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = null;
  }
  if (!response.ok) throw new AuditReadError(`HCP Terraform ${path}: HTTP ${response.status}`);
  if (!doc || typeof doc !== 'object') throw new AuditReadError(`HCP Terraform ${path}: the answer is not JSON`);
  return doc;
}

/**
 * The applies of the workspace that touch the window: `[{ runId, start, end }]`
 * with epoch milliseconds, from HCP Terraform's own run record. `start` is
 * when the apply began (`applying-at`, else when the run was created) and
 * `end` when it finished (`applied-at`). Read newest first and stopped once a
 * page lies wholly before the window.
 */
export async function fetchTerraformApplies({ token, since, before, fetchImpl = fetch }) {
  const ws = await tfcGet(`/organizations/${TFC_ORGANIZATION}/workspaces/${TFC_WORKSPACE}`, token, fetchImpl);
  const workspaceId = str(ws?.data?.id);
  if (!workspaceId) throw new AuditReadError(`HCP Terraform returned no id for workspace ${TFC_ORGANIZATION}/${TFC_WORKSPACE}`);
  const sinceMs = Date.parse(since) - APPLY_TAIL_MS;
  const beforeMs = Date.parse(before) + APPLY_LEAD_MS;
  const windows = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const doc = await tfcGet(`/workspaces/${workspaceId}/runs?filter%5Bstatus%5D=applied&page%5Bsize%5D=100&page%5Bnumber%5D=${page}`, token, fetchImpl);
    if (!Array.isArray(doc.data)) throw new AuditReadError('HCP Terraform returned a runs payload without a `data` array');
    let oldestOnPage = Number.POSITIVE_INFINITY;
    for (const run of doc.data) {
      const a = run?.attributes ?? {};
      const stamps = a['status-timestamps'] ?? {};
      if (a.status !== 'applied') continue;
      const end = Date.parse(str(stamps['applied-at']));
      const start = Date.parse(str(stamps['applying-at']) || str(a['created-at']));
      if (Number.isNaN(end) || Number.isNaN(start)) continue;
      oldestOnPage = Math.min(oldestOnPage, start);
      if (end >= sinceMs && start <= beforeMs) windows.push({ runId: str(run.id), start, end });
    }
    const nextPage = doc.meta?.pagination?.['next-page'];
    if (doc.data.length === 0 || nextPage === null || nextPage === undefined || oldestOnPage < sinceMs) return windows;
  }
  throw new AuditReadError(`more than ${MAX_RUN_PAGES} pages of applied runs in the window; narrow it with --since and --before`);
}

/** RFC3339 at second precision, UTC. */
export const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `YYYY-MM-DD` or RFC3339 -> ms, or null. */
export function parseWhen(text) {
  const t = String(text ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(t)) return null;
  const ms = Date.parse(t.length === 10 ? `${t}T00:00:00Z` : t);
  return Number.isNaN(ms) ? null : ms;
}

function usage() {
  return [
    'Usage: node scripts/cloudflare-dns-audit.mjs [--since <RFC3339|YYYY-MM-DD>] [--before <RFC3339|YYYY-MM-DD>]',
    '         [--hours <n>] [--report <file>]',
    '',
    `Reads the Cloudflare account audit log for the window (default: the last ${DEFAULT_WINDOW_HOURS} hours),`,
    `keeps the DNS-record changes on ${ZONE_NAME}, and judges each against the allowlist at the top`,
    'of the script. Exit 0 when every change is expected or there is none, 2 when one is not,',
    '1 when the log could not be read.',
    '',
    `Environment: ${ENV.token} (secret), ${ENV.accountId}; optional ${ENV.zoneId},`,
    `${ENV.ownerEmail}, ${ENV.caddyHostIp}, ${ENV.caddyTokenName}, ${ENV.tfcToken} (secret; without it`,
    'the hcp-terraform entry is inactive).',
  ].join('\n');
}

const FLAGS = {
  '--since': (o, v) => ({ ...o, since: v }),
  '--before': (o, v) => ({ ...o, before: v }),
  '--hours': (o, v) => ({ ...o, hours: v }),
  '--report': (o, v) => ({ ...o, report: v }),
};

export function parseArgs(argv) {
  let options = { since: null, before: null, hours: String(DEFAULT_WINDOW_HOURS), report: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    const set = FLAGS[flag];
    if (!set) throw new AuditReadError(`Unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new AuditReadError(`${flag} needs a value`);
    options = set(options, value);
    i += 1;
  }
  const hours = Number(options.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new AuditReadError('--hours must be a positive number');
  options.hours = hours;
  return options;
}

/** The window as RFC3339 strings, from the flags and the clock. */
export function resolveWindow(options, now = Date.now()) {
  const beforeMs = options.before === null ? now : parseWhen(options.before);
  if (beforeMs === null) throw new AuditReadError(`--before "${options.before}" is not a YYYY-MM-DD date or RFC3339 timestamp`);
  const sinceMs = options.since === null ? beforeMs - options.hours * 3_600_000 : parseWhen(options.since);
  if (sinceMs === null) throw new AuditReadError(`--since "${options.since}" is not a YYYY-MM-DD date or RFC3339 timestamp`);
  if (sinceMs >= beforeMs) throw new AuditReadError('--since must be before --before');
  return { since: iso(sinceMs), before: iso(beforeMs), hours: Math.round(((beforeMs - sinceMs) / 3_600_000) * 10) / 10 };
}

/** The actor cell: a token by name, a dashboard user by masked e-mail, anything else by type and id. */
export function describeActor(change) {
  // Every part the actor chose (a token name, an e-mail, an id, an address)
  // goes through `cell` here, so the cell itself is placed in the table as is.
  const from = change.actorIp ? ` from ${cell(change.actorIp)}` : '';
  if (change.tokenName || change.tokenId) {
    const id = change.tokenId ? ` (${cell(change.tokenId.slice(0, 8))}…)` : '';
    return `token \`${cell(change.tokenName || 'unnamed')}\`${id}${from}`;
  }
  if (change.actorContext === 'dash') return `dashboard ${cell(change.actorType || 'user')} ${cell(maskEmail(change.actorEmail) || change.actorId)}${from}`;
  const who = cell(maskEmail(change.actorEmail) || change.actorId || 'unknown');
  const how = cell([change.actorType, change.actorContext].filter(Boolean).join('/') || 'unknown');
  return `${how} ${who}${from}`;
}

// A Markdown table cell or code span: backslashes first, so a value ending in
// one cannot turn the escaped pipe back into a column break; then pipes; then
// newlines; and a backtick becomes a plain apostrophe, so a value the report
// wraps in a code span (an id, a record name, a user agent — text the actor
// chose) cannot close the span and inject Markdown into the summary or issue.
const cell = (text) =>
  String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'");

/** The Markdown the workflow writes to the job summary and, on exit 2, the issue. */
export function renderReport({ window, entries, pages, judged, settings }) {
  const unexpected = judged.filter((j) => j.verdict === 'UNEXPECTED');
  const lines = [
    `## Cloudflare DNS audit: \`${ZONE_NAME}\``,
    '',
    `Window ${window.since} to ${window.before} (${window.hours} h). Read ${entries} audit log ${entries === 1 ? 'entry' : 'entries'} over ${pages} page${pages === 1 ? '' : 's'}; ${judged.length} DNS-record ${judged.length === 1 ? 'change' : 'changes'} on the zone, **${unexpected.length} unexpected**.`,
    '',
    unexpected.length === 0
      ? judged.length === 0
        ? 'No DNS record in the zone was created, updated or deleted in the window.'
        : 'Every change matches an allowlist entry.'
      : `**${unexpected.length} change${unexpected.length === 1 ? '' : 's'} matched no allowlist entry.** Open each entry in the dashboard (https://dash.cloudflare.com/?to=/:account/audit-log, search the entry id) and read what was written; docs/runbooks/edge-dns-verification.md, "The daily DNS audit", says what to do next.`,
    '',
    '**Allowlist:** ' +
      ALLOWLIST.map((e) => {
        const active = e.active(settings);
        if (active && e.id === 'hcp-terraform') {
          const n = settings.applyWindows.length;
          return `\`${e.id}\` active (${n} ${n === 1 ? 'apply' : 'applies'} of \`${TFC_ORGANIZATION}/${TFC_WORKSPACE}\` in the window)`;
        }
        if (active) return `\`${e.id}\` active`;
        const needs = e.id === 'caddy-acme' ? `${ENV.caddyHostIp} and ${ENV.caddyTokenName}` : e.id === 'hcp-terraform' ? ENV.tfcToken : ENV.ownerEmail;
        return `\`${e.id}\` inactive (\`${needs}\` unset; its edits read UNEXPECTED)`;
      }).join(', ') +
      '.',
    '',
  ];
  if (judged.length > 0) {
    lines.push('| Time (UTC) | Actor | Action | Type | Name | Verdict | Entry |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const j of judged) {
      const action = j.result === 'success' ? j.actionType : `${j.actionType} (${j.result})`;
      const name = j.nameSource === 'sibling' ? `${j.recordName} (from the paired entry)` : j.recordName;
      const verdict = j.verdict === 'EXPECTED' ? `EXPECTED (\`${j.rule}\`)` : '**UNEXPECTED**';
      lines.push(`| ${cell(j.time)} | ${describeActor(j)} | ${cell(action)} | ${cell(j.recordType)} | \`${cell(name)}\` | ${verdict} | \`${cell(j.id || '-')}\` |`);
    }
    lines.push('');
  }
  if (unexpected.length > 0) {
    // What the audit log carries for each unexpected actor, so the next
    // allowlist entry is written to the real record (field names, request
    // method, user agent) and not to a guess. Names of fields, never values.
    lines.push('**Shape of the unexpected entries** (actor field names as sent, request method, user agent):', '');
    for (const j of unexpected) {
      const ua = j.userAgent ? `\`${cell(j.userAgent.slice(0, 60))}${j.userAgent.length > 60 ? '…' : ''}\`` : 'none';
      lines.push(`- \`${cell(j.id || '-')}\`: actor fields \`{${cell(j.actorFields) || 'none'}}\`; ${j.method ? `\`${cell(j.method)}\`` : 'no method'}; user agent ${ua}`);
    }
    lines.push('');
  }
  lines.push('Record contents are not read into this report by design; the dashboard entry has them.', '');
  return lines.join('\n');
}

/** Exit 1 with the reason, in the report too when one was asked for. */
function cannotRead(options, log, message) {
  log(`::error::Cloudflare DNS audit did not run: ${message}`);
  if (options?.report) {
    writeFileSync(options.report, `## Cloudflare DNS audit: \`${ZONE_NAME}\`\n\n**The audit log was not read:** ${message}\n\nNothing was evaluated; a quiet run is not this.\n`);
  }
  return 1;
}

/**
 * The command. `io` is injected for the tests: the environment, a fetch, the
 * clock, and where lines go.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => process.stdout.write(`${line}\n`));
  const now = io.now ?? Date.now();

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(`${error.message}\n${usage()}`);
    return 1;
  }
  if (options.help) {
    log(usage());
    return 0;
  }

  const token = str(env[ENV.token]).trim();
  const settings = settingsFrom(env);
  if (!token) return cannotRead(options, log, `${ENV.token} is not set (a repository secret; docs/runbooks/edge-dns-verification.md, "The daily DNS audit")`);
  if (!settings.accountId) return cannotRead(options, log, `${ENV.accountId} is not set (a repository variable)`);

  let window;
  try {
    window = resolveWindow(options, now);
  } catch (error) {
    return cannotRead(options, log, error.message);
  }

  let read;
  try {
    read = await fetchAuditLog({ accountId: settings.accountId, since: window.since, before: window.before, token, fetchImpl: io.fetch });
  } catch (error) {
    return cannotRead(options, log, error instanceof AuditReadError ? error.message : `unexpected failure: ${error?.message ?? error}`);
  }

  // The applies that can clear a Terraform-looking change. Unset token: the
  // entry stays inactive and such changes read UNEXPECTED; a token that cannot
  // read the run record is a read failure, not a quiet green.
  const tfcToken = str(env[ENV.tfcToken]).trim();
  if (tfcToken) {
    try {
      settings.applyWindows = await fetchTerraformApplies({ token: tfcToken, since: window.since, before: window.before, fetchImpl: io.fetch });
    } catch (error) {
      return cannotRead(options, log, error instanceof AuditReadError ? error.message : `unexpected failure: ${error?.message ?? error}`);
    }
  }

  const changes = dnsRecordChanges(read.entries, settings);
  const judged = changes.map((c) => ({ ...c, ...classify(c, settings) }));
  const report = renderReport({ window, entries: read.entries.length, pages: read.pages, judged, settings });
  if (options.report) writeFileSync(options.report, report);
  log(report);

  const unexpected = judged.filter((j) => j.verdict === 'UNEXPECTED').length;
  return unexpected > 0 ? 2 : 0;
}

// pathToFileURL rather than a hand-built file:// string: a Windows path does
// not round-trip through the latter (entrypoint-guards.test.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`::error::${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  );
}

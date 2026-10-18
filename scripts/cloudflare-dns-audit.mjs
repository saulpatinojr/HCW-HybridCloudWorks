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
 * CLOUDFLARE_DNS_AUDIT_OWNER_EMAIL and CLOUDFLARE_CADDY_TOKEN_NAME; ENV below
 * says what each one does.
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
  /** The Caddy runtime token's name, as the API Tokens page shows it (optional): the caddy-acme entry is inactive without it. */
  caddyTokenName: 'CLOUDFLARE_CADDY_TOKEN_NAME',
};

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
      'plan check holds those records to the declared diff. Identified by the token name the audit ' +
      'record carries (`actor.token_name`), the field the dashboard shows and the owner can read back.',
    active: () => true,
    matches: (change) => change.tokenName !== '' && change.tokenName === HCP_TERRAFORM_TOKEN_NAME,
  },
  {
    id: 'caddy-acme',
    reason:
      "The lab host's Caddy renews the lab wildcard by DNS-01, which is a TXT record under " +
      `\`${ACME_CHALLENGE_PREFIX}\` for a lab name (\`_acme-challenge.lab.hybridcloudworks.com\` or ` +
      '`_acme-challenge.coder.lab.hybridcloudworks.com`), created and then deleted minutes later. ' +
      'That is ALL this token may do: an A, CNAME or MX record from it, or a challenge TXT for a ' +
      'name outside the lab (`_acme-challenge.www…`, which would be a certificate for the site), ' +
      `is the finding this poller exists for. Identified by the token name in \`${ENV.caddyTokenName}\`.`,
    active: (settings) => settings.caddyTokenName !== '',
    matches: (change, settings) =>
      settings.caddyTokenName !== '' &&
      change.tokenName === settings.caddyTokenName &&
      change.recordType === 'TXT' &&
      isLabAcmeChallenge(change.recordName),
  },
  {
    id: 'owner-dashboard',
    reason:
      "The owner's own edits in the Cloudflare dashboard (the apex and `www` records are hand-made " +
      'by design; docs/runbooks/edge-dns-verification.md). A dashboard session signed in as the ' +
      `owner, by the e-mail in \`${ENV.ownerEmail}\`; the owner's API tokens are not this entry.`,
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
    `${ENV.ownerEmail}, ${ENV.caddyTokenName}.`,
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
  const from = change.actorIp ? ` from ${change.actorIp}` : '';
  if (change.tokenName || change.tokenId) {
    const id = change.tokenId ? ` (${change.tokenId.slice(0, 8)}…)` : '';
    return `token \`${change.tokenName || 'unnamed'}\`${id}${from}`;
  }
  if (change.actorContext === 'dash') return `dashboard ${change.actorType || 'user'} ${maskEmail(change.actorEmail) || change.actorId}${from}`;
  const who = maskEmail(change.actorEmail) || change.actorId || 'unknown';
  const how = [change.actorType, change.actorContext].filter(Boolean).join('/') || 'unknown';
  return `${how} ${who}${from}`;
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

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
        if (active) return `\`${e.id}\` active`;
        const needs = e.id === 'caddy-acme' ? ENV.caddyTokenName : ENV.ownerEmail;
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
      lines.push(`| ${cell(j.time)} | ${cell(describeActor(j))} | ${cell(action)} | ${cell(j.recordType)} | \`${cell(name)}\` | ${verdict} | \`${cell(j.id || '-')}\` |`);
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

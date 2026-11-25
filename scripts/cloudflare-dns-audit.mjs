#!/usr/bin/env node
/**
 * cloudflare-dns-audit.mjs — did anything edit a DNS record in the production
 * zone that was not supposed to? (estate review 2026-10-06, LAB-1; #948)
 *
 * Until 2026-10-18 the lab host's Caddy held a Cloudflare token with DNS
 * edit on `hybridcloudworks.com`, because the DNS-01 challenge for the lab's
 * wildcard certificate was answered in that zone until a dedicated lab zone
 * existed (ADR 0032). That evening the `_acme-challenge` names were delegated
 * into the lab zone `hybridcloudinsights.com`, the runtime token re-issued on
 * that zone alone, and the production-zone token revoked (#948, #1279). The
 * only record of what any token did to the production zone is Cloudflare's
 * own audit log: neither the HCP Terraform plan nor the deploy-drift monitor
 * reads the zone, and Cloudflare has no notification type for audit-log or
 * DNS-record events on any plan (read 2026-10-18; the owner's decision on
 * #948 is this poller, and it keeps watching the production zone after the
 * cut-over). The caddy-acme allowlist entry below is dated: it matches a
 * challenge TXT from the lab host only up to the minute the host switched
 * tokens (CADDY_PRODUCTION_ZONE_ACCESS_ENDED); after that no credential on
 * the host can write the production zone, so a later match is UNEXPECTED.
 *
 * Once a day, cloudflare-dns-audit.yml runs this over the account audit log
 * (Audit Logs v2, `GET /accounts/{account_id}/logs/audit`), keeps the
 * create, update and delete events on DNS records in the production zone,
 * and judges each against ALLOWLIST below. Anything the allowlist does not
 * name is UNEXPECTED, and the workflow turns that into an issue. Cloudflare's
 * own certificate renewal writes challenge TXT records into the zone too
 * (the cloudflare-dcv entry, since #1421), so a quiet run also covers those.
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
 * CLOUDFLARE_CADDY_TOKEN_NAME and TFC_TOKEN (secret); ENV (in lib/dns-audit-settings.mjs) says what each
 * one does.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ACME_CHALLENGE_PREFIX, APPLY_LEAD_MS, APPLY_TAIL_MS, AuditReadError, CADDY_PRODUCTION_ZONE_ACCESS_ENDED, CLOUDFLARE_DCV_CHALLENGE_NAME, ENV, HCP_TERRAFORM_TOKEN_NAME, isCloudflareSystemActor, LAB_SUFFIX, TERRAFORM_USER_AGENT_PREFIX, TFC_ORGANIZATION, TFC_WORKSPACE, ZONE_NAME } from './lib/dns-audit-settings.mjs';
import { dnsRecordChanges, str } from './lib/dns-audit-entries.mjs';
import { fetchAuditLog } from './lib/dns-audit-cloudflare.mjs';
import { fetchTerraformApplies } from './lib/dns-audit-terraform.mjs';
import { parseArgs, usage } from './lib/dns-audit-args.mjs';
import { cannotRead, changeTable, findingsLine, unexpectedShapes, verdictSentence } from './lib/dns-audit-report.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { API_BASE, ZONE_NAME, HCP_TERRAFORM_TOKEN_NAME, ACME_CHALLENGE_PREFIX, LAB_SUFFIX, DEFAULT_WINDOW_HOURS, PAGE_LIMIT, MAX_PAGES, ISSUE_TITLE_PREFIX, FINDINGS_MARKER, ENV, TFC_API, TFC_ORGANIZATION, TFC_WORKSPACE, APPLY_LEAD_MS, APPLY_TAIL_MS, APPLY_END_STAMPS, MAX_RUN_PAGES, TERRAFORM_USER_AGENT_PREFIX, CADDY_PRODUCTION_ZONE_ACCESS_ENDED, CLOUDFLARE_DCV_CHALLENGE_NAME, isCloudflareSystemActor, AuditReadError } from './lib/dns-audit-settings.mjs';
export { maskEmail, actionType, isDnsRecordEntry, isProductionZone, recordFields, normalise, dnsRecordChanges } from './lib/dns-audit-entries.mjs';
export { auditLogUrl, fetchAuditLog } from './lib/dns-audit-cloudflare.mjs';
export { fetchTerraformApplies } from './lib/dns-audit-terraform.mjs';
export { parseArgs } from './lib/dns-audit-args.mjs';
export { describeActor, findingsLine } from './lib/dns-audit-report.mjs';

/** Before the lab host switched tokens; an unparseable time is not before anything. */
export function beforeCaddyCutOver(time) {
  const t = Date.parse(time);
  return !Number.isNaN(t) && t < Date.parse(CADDY_PRODUCTION_ZONE_ACCESS_ENDED);
}

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

/** Whether a change was made as the owner, by the e-mail in the settings; never when that is not set. */
function isOwner(change, settings) {
  return settings.ownerEmail !== '' && change.actorEmail.toLowerCase() === settings.ownerEmail.toLowerCase();
}

/** Whether a change came from the Terraform provider with an account-owned token, off the lab host, during an apply. */
function isWorkspaceApply(change, settings) {
  return (
    change.actorType === 'account' &&
    isTerraformProviderRequest(change) &&
    !isFromCaddyHost(change, settings) &&
    withinApply(change.time, settings.applyWindows)
  );
}

/** The two things Cloudflare's own certificate validation does to its TXT record. */
const DCV_ACTIONS = new Set(['create', 'delete']);

/** The apex challenge name and nothing else, case- and trailing-dot-insensitively. */
export function isCloudflareDcvChallenge(name) {
  return String(name ?? '').toLowerCase().replace(/\.$/, '') === CLOUDFLARE_DCV_CHALLENGE_NAME;
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
      (change.tokenName !== '' && change.tokenName === HCP_TERRAFORM_TOKEN_NAME) || isWorkspaceApply(change, settings),
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
      change.actorType === 'user' &&
      isOwner(change, settings) &&
      isTerraformProviderRequest(change) &&
      !isFromCaddyHost(change, settings),
  },
  {
    id: 'caddy-acme',
    reason:
      `Until ${CADDY_PRODUCTION_ZONE_ACCESS_ENDED} the lab host's Caddy renewed the lab wildcard by DNS-01 ` +
      `in this zone, which is a TXT record under \`${ACME_CHALLENGE_PREFIX}\` for a lab name ` +
      '(`_acme-challenge.lab.hybridcloudworks.com` or `_acme-challenge.coder.lab.hybridcloudworks.com`), ' +
      'created and then deleted minutes later; that was ALL its token could do, and an A, CNAME or MX ' +
      'record from it, or a challenge TXT for a name outside the lab (`_acme-challenge.www…`, which ' +
      'would be a certificate for the site), is the finding this poller exists for. Since that instant ' +
      'the challenge names are delegated into the lab zone and the host holds no token for this zone ' +
      '(the production-zone token is revoked), so a matching change dated at or after it is UNEXPECTED ' +
      "too. Identified by the lab host's address in " +
      `\`${ENV.caddyHostIp}\` (the token's client-IP filter allowed that address alone, so any API-token ` +
      `request from it was this token), or by the token name in \`${ENV.caddyTokenName}\` should the log carry it.`,
    active: (settings) => settings.caddyTokenName !== '' || settings.caddyHostIp !== '',
    matches: (change, settings) =>
      isCaddyToken(change, settings) &&
      change.recordType === 'TXT' &&
      isLabAcmeChallenge(change.recordName) &&
      beforeCaddyCutOver(change.time),
  },
  {
    id: 'owner-dashboard',
    reason:
      "The owner's own edits in the Cloudflare dashboard (the apex and `www` records are hand-made " +
      'by design; docs/runbooks/edge-dns-verification.md). A dashboard session signed in as the ' +
      `owner, by the e-mail in \`${ENV.ownerEmail}\`; the owner's API tokens are \`terraform-owner-token\` ` +
      'when the provider made the request, and nothing otherwise.',
    active: (settings) => settings.ownerEmail !== '',
    matches: (change, settings) => change.actorContext === 'dash' && change.actorType === 'user' && isOwner(change, settings),
  },
  {
    id: 'cloudflare-dcv',
    reason:
      "Cloudflare's own certificate validation. The zone is a full setup (Cloudflare runs its " +
      'nameservers), and for such a zone Cloudflare "handles DCV automatically on your behalf using a ' +
      'TXT record" (developers.cloudflare.com/ssl/edge-certificates/changing-dcv-method/, read ' +
      '2026-11-02): when the universal certificate renews, which starts 30 days before it expires ' +
      '(developers.cloudflare.com/ssl/reference/certificate-validity-periods/), Cloudflare creates one ' +
      `or two TXT records at \`${CLOUDFLARE_DCV_CHALLENGE_NAME}\` (the \`_acme-challenge.<domain>\` name of ` +
      'developers.cloudflare.com/ssl/edge-certificates/changing-dcv-method/methods/txt/) and deletes them ' +
      'minutes later. The first live renewal was 2026-10-26 (#1421): 12 entries, each a create or a ' +
      'delete of that TXT, by an actor carrying `type: system` and nothing else, with no request ' +
      "method and no user agent. Cloudflare's audit-log reference defines `system` as changes made " +
      'automatically by Cloudflare systems, so the entry is bound to that shape exactly: a `TXT` ' +
      'named `_acme-challenge.<apex>`, created or deleted (never updated) by a bare `system` actor. ' +
      "A token cannot imitate it: a token's request is authenticated and lands in the log as " +
      '`account` or `user` with `context: api_token`. A challenge TXT for any other name, or a ' +
      '`system` actor on any other record, stays UNEXPECTED. Needs no setting.',
    active: () => true,
    matches: (change) =>
      isCloudflareSystemActor(change) &&
      DCV_ACTIONS.has(change.actionType) &&
      change.recordType === 'TXT' &&
      isCloudflareDcvChallenge(change.recordName),
  },
];

/** `_acme-challenge.<lab name>`: the prefix, and a name under the lab subtree. */
export function isLabAcmeChallenge(name) {
  const lower = String(name ?? '').toLowerCase().replace(/\.$/, '');
  return lower.startsWith(ACME_CHALLENGE_PREFIX) && lower.endsWith(LAB_SUFFIX);
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

/** RFC3339 at second precision, UTC. */
export const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `YYYY-MM-DD` or RFC3339 -> ms, or null. */
export function parseWhen(text) {
  const t = String(text ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(t)) return null;
  const ms = Date.parse(t.length === 10 ? `${t}T00:00:00Z` : t);
  return Number.isNaN(ms) ? null : ms;
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

/** The Markdown the workflow writes to the job summary and, on exit 2, the issue. */
export function renderReport({ window, entries, pages, judged, settings }) {
  const unexpected = judged.filter((j) => j.verdict === 'UNEXPECTED');
  const lines = [
    `## Cloudflare DNS audit: \`${ZONE_NAME}\``,
    '',
    `Window ${window.since} to ${window.before} (${window.hours} h). Read ${entries} audit log ${entries === 1 ? 'entry' : 'entries'} over ${pages} page${pages === 1 ? '' : 's'}; ${judged.length} DNS-record ${judged.length === 1 ? 'change' : 'changes'} on the zone, **${unexpected.length} unexpected**.`,
    '',
    verdictSentence(judged, unexpected),
    '',
    `**Allowlist:** ${ALLOWLIST.map((e) => allowlistState(e, settings)).join(', ')}.`,
    '',
  ];
  if (judged.length > 0) lines.push(...changeTable(judged));
  if (unexpected.length > 0) lines.push(...unexpectedShapes(unexpected));
  lines.push('Record contents are not read into this report by design; the dashboard entry has them.', '');
  const findings = findingsLine(judged);
  if (findings) lines.push(findings, '');
  return lines.join('\n');
}

/** The settings each allowlist entry needs, named when it is inactive. */
const ENTRY_NEEDS = {
  'caddy-acme': `${ENV.caddyHostIp} and ${ENV.caddyTokenName}`,
  'hcp-terraform': ENV.tfcToken,
};

/** One allowlist entry as the report lists it: active (with the applies in the window, for HCP Terraform) or inactive and why. */
function allowlistState(e, settings) {
  const active = e.active(settings);
  if (active && e.id === 'hcp-terraform') {
    const n = settings.applyWindows.length;
    return `\`${e.id}\` active (${n} ${n === 1 ? 'apply' : 'applies'} of \`${TFC_ORGANIZATION}/${TFC_WORKSPACE}\` in the window)`;
  }
  if (active) return `\`${e.id}\` active`;
  const needs = ENTRY_NEEDS[e.id] ?? ENV.ownerEmail;
  return `\`${e.id}\` inactive (\`${needs}\` unset; its edits read UNEXPECTED)`;
}

/** A read the audit stops on; `main` reports it through cannotRead. */
class NotRead extends Error {}

/** The answer of `work()`, or NotRead with the message a read failure is reported by. */
async function readOrStop(work) {
  try {
    return await work();
  } catch (error) {
    throw new NotRead(error instanceof AuditReadError ? error.message : `unexpected failure: ${error?.message ?? error}`);
  }
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

  try {
    return await audit({ options, env, io, now, log });
  } catch (error) {
    if (error instanceof NotRead) return cannotRead(options, log, error.message);
    throw error;
  }
}

/** Read the window, judge each change, write the report: 0 all expected, 2 something unexpected. */
export async function audit({ options, env, io, now, log }) {
  const token = str(env[ENV.token]).trim();
  const settings = settingsFrom(env);
  if (!token) throw new NotRead(`${ENV.token} is not set (a repository secret; docs/runbooks/edge-dns-verification.md, "The daily DNS audit")`);
  if (!settings.accountId) throw new NotRead(`${ENV.accountId} is not set (a repository variable)`);

  let window;
  try {
    window = resolveWindow(options, now);
  } catch (error) {
    throw new NotRead(error.message);
  }

  const read = await readOrStop(() =>
    fetchAuditLog({ accountId: settings.accountId, since: window.since, before: window.before, token, fetchImpl: io.fetch })
  );

  // The applies that can clear a Terraform-looking change. Unset token: the
  // entry stays inactive and such changes read UNEXPECTED; a token that cannot
  // read the run record is a read failure, not a quiet green.
  const tfcToken = str(env[ENV.tfcToken]).trim();
  if (tfcToken) {
    settings.applyWindows = await readOrStop(() =>
      fetchTerraformApplies({ token: tfcToken, since: window.since, before: window.before, fetchImpl: io.fetch })
    );
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

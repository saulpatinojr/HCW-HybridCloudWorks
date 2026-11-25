/** The pieces of the DNS audit's Markdown report: actors, the change table and the findings line (cloudflare-dns-audit.mjs). */
import { FINDINGS_MARKER, isCloudflareSystemActor, ZONE_NAME } from './dns-audit-settings.mjs';
import { maskEmail } from './dns-audit-entries.mjs';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** The actor cell: a token by name, a dashboard user by masked e-mail, Cloudflare itself by name, anything else by type and id. */
export function describeActor(change) {
  // Every part the actor chose (a token name, an e-mail, an id, an address)
  // goes through `cell` here, so the cell itself is placed in the table as is.
  const from = change.actorIp ? ` from ${cell(change.actorIp)}` : '';
  if (isCloudflareSystemActor(change)) return 'Cloudflare (system, no token)';
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

/**
 * The hidden last line of a report with an UNEXPECTED change (#1681): one
 * SHA-256 per unexpected change, of its audit-log entry id, sorted and
 * space-separated. The workflow comments on the open issue only when one of
 * these is in none of the reports the workflow already posted there. Two
 * daily windows overlap by two hours, so one edit can be read by two runs,
 * alone or beside edits the earlier run also saw; without this it would be
 * reported twice. An entry with no id stands in as its time, action, type and
 * name. Hashed, not listed, because a record name is text the actor chose and
 * could close the HTML comment. Empty when nothing is UNEXPECTED.
 */
export function findingsLine(judged) {
  const keys = judged
    .filter((j) => j.verdict === 'UNEXPECTED')
    .map((j) => j.id || [j.time, j.actionType, j.recordType, j.recordName].join('|'));
  if (keys.length === 0) return '';
  const hashes = [...new Set(keys.map((k) => createHash('sha256').update(k).digest('hex')))].sort();
  return `${FINDINGS_MARKER} ${hashes.join(' ')} -->`;
}
/** The report's verdict in one sentence: no change, all allowed, or how many matched nothing and what to do. */
export function verdictSentence(judged, unexpected) {
  if (unexpected.length > 0) {
    return `**${unexpected.length} change${unexpected.length === 1 ? '' : 's'} matched no allowlist entry.** Open each entry in the dashboard (https://dash.cloudflare.com/?to=/:account/audit-log, search the entry id) and read what was written; docs/runbooks/edge-dns-verification.md, "The daily DNS audit", says what to do next.`;
  }
  return judged.length === 0
    ? 'No DNS record in the zone was created, updated or deleted in the window.'
    : 'Every change matches an allowlist entry.';
}
/** The table of changes, one row each, and the blank line after it. */
export function changeTable(judged) {
  const lines = ['| Time (UTC) | Actor | Action | Type | Name | Verdict | Entry |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const j of judged) {
    const action = j.result === 'success' ? j.actionType : `${j.actionType} (${j.result})`;
    const name = j.nameSource === 'sibling' ? `${j.recordName} (from the paired entry)` : j.recordName;
    const verdict = j.verdict === 'EXPECTED' ? `EXPECTED (\`${j.rule}\`)` : '**UNEXPECTED**';
    lines.push(`| ${cell(j.time)} | ${describeActor(j)} | ${cell(action)} | ${cell(j.recordType)} | \`${cell(name)}\` | ${verdict} | \`${cell(j.id || '-')}\` |`);
  }
  lines.push('');
  return lines;
}

/**
 * What the audit log carries for each unexpected actor, so the next
 * allowlist entry is written to the real record (field names, request
 * method, user agent) and not to a guess. Names of fields, never values.
 */
export function unexpectedShapes(unexpected) {
  const lines = ['**Shape of the unexpected entries** (actor field names as sent, request method, user agent):', ''];
  for (const j of unexpected) {
    const ua = j.userAgent ? `\`${cell(j.userAgent.slice(0, 60))}${j.userAgent.length > 60 ? '…' : ''}\`` : 'none';
    lines.push(`- \`${cell(j.id || '-')}\`: actor fields \`{${cell(j.actorFields) || 'none'}}\`; ${j.method ? `\`${cell(j.method)}\`` : 'no method'}; user agent ${ua}`);
  }
  lines.push('');
  return lines;
}

/** Exit 1 with the reason, in the report too when one was asked for. */
export function cannotRead(options, log, message) {
  log(`::error::Cloudflare DNS audit did not run: ${message}`);
  if (options?.report) {
    writeFileSync(options.report, `## Cloudflare DNS audit: \`${ZONE_NAME}\`\n\n**The audit log was not read:** ${message}\n\nNothing was evaluated; a quiet run is not this.\n`);
  }
  return 1;
}

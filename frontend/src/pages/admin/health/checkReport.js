/**
 * The Markdown report the Health page's "Copy report" button gives: the
 * identity checks and the Labs probes, by name and verdict only. Moved out of
 * probes.jsx (by way of identityVerdicts.js) when that file grew too long;
 * probes.jsx re-exports `buildReport`.
 */
import { SYSTEM_STATUS } from '@/lib/status';
import {
  evaluateIdentity,
  evaluateLabsProbe,
  evaluateUnauthenticatedProbe,
  LABS_PROBE_JOB,
  verdictStatus,
} from './identityVerdicts';

const mark = (value) => SYSTEM_STATUS[verdictStatus(value)].label;

/** Values as a comma-separated list, or "(none)". */
export const list = (values) => (values && values.length ? values.join(', ') : '(none)');

/** The identity half of the report. */
function identityReportLines({
  identityPending,
  token,
  tokenError,
  expectations,
  expectationsError,
  admin,
  adminHttp,
  adminError,
}) {
  const lines = ['### Identity — token claims and admin registry', ''];
  // Before the first run has settled there is nothing to report, and saying
  // "could not be read" here would be false — the check has not happened yet.
  if (identityPending) {
    lines.push('- Identity checks: STILL RUNNING — this report is not final', '');
    return lines;
  }
  if (token) {
    lines.push(`- Claims present (names only): ${list(token.claimNames)}`);
    lines.push(`- \`aud\`: ${token.aud ?? '(absent)'}`);
    lines.push(`- \`aud\` equals the API's ENTRA_API_AUDIENCE: ${mark(token.audienceMatches)}`);
    lines.push(`- \`roles\`: ${list(token.roleNames)}`);
    lines.push(
      `- App Role \`${expectations?.adminAppRole ?? 'Admin'}\` present in \`roles\`: ${mark(token.hasAdminRole)}`
    );
    lines.push(
      `- Delegated scope \`${expectations?.requiredScope ?? 'access_as_admin'}\` present in \`scp\`: ${mark(token.hasRequiredScope)}`
    );
    lines.push(`- \`tid\` equals the API's ENTRA_TENANT_ID: ${mark(token.tenantMatches)}`);
    lines.push(
      `- \`ver\` is ${expectations?.requiredTokenVersion ?? '2.0'}: ${mark(token.versionMatches)}`
    );
    // `azp` names the client that asked for the token, not the person.
    lines.push(`- \`azp\`: ${token.azp ?? '(absent)'}`);
    lines.push(
      `- \`azp\` differs from \`aud\` (SPA and API are separate registrations): ${mark(token.clientIsSeparateFromApi)}`
    );
    lines.push(`- \`exp\`: ${token.expiresLabel}`);
  } else {
    lines.push(`- Token: could not be read (${tokenError || 'no token'})`);
  }
  if (expectationsError) lines.push(`- getAuthExpectations: ${expectationsError}`);
  if (admin) {
    lines.push(`- getCurrentAdminStatus: HTTP ${adminHttp ?? '?'}, isAdmin ${admin.isAdmin}`);
    lines.push(`- Registry role: ${admin.role ?? '(none)'}; active: ${admin.active}`);
    lines.push(`- Registry permissions: ${list(admin.permissions)}`);
    lines.push(`- Registry uid equals token oid: ${mark(admin.uidMatchesToken)}`);
  } else {
    lines.push(`- getCurrentAdminStatus: ${adminError || 'not called'}`);
  }
  const verdict = evaluateIdentity(token, admin);
  lines.push(`- Result: ${mark(verdict.pass)} (${verdict.reason})`, '');
  return lines;
}

/** The Labs half of the report. */
function labsReportLines({ labs, unauth }) {
  const lines = ['### Labs no-op probe', ''];
  if (labs) {
    const e = labs.enqueue || {};
    const outcome = e.error
      ? ` — ${e.error}`
      : `, status ${e.status ?? '?'}, jobId ${e.jobId ?? '?'}`;
    lines.push(
      `- enqueueLabJob (authenticated, ${LABS_PROBE_JOB.type}): HTTP ${e.httpStatus ?? '?'}${outcome}`
    );
    if (labs.read) {
      const read = labs.read.found
        ? `found, status ${labs.read.status}`
        : labs.read.error || 'not found';
      lines.push(`- getLabJob: ${read}`);
    }
    if (labs.cancel) {
      const cancel =
        labs.cancel.error || `HTTP ${labs.cancel.httpStatus}, status ${labs.cancel.status}`;
      lines.push(`- cancelLabJob: ${cancel}`);
    }
    if (labs.final) {
      let finalState = labs.final.status;
      if (labs.final.error) finalState = `read failed (${labs.final.error}) — state unknown`;
      else if (!finalState) finalState = 'unknown — the closing read returned no status';
      lines.push(`- lab_jobs/${e.jobId ?? '?'} final status: ${finalState}`);
    }
  }
  const labsVerdict = evaluateLabsProbe(labs);
  lines.push(`- Authenticated no-op path: ${mark(labsVerdict.pass)} (${labsVerdict.reason})`);
  const unauthVerdict = evaluateUnauthenticatedProbe(unauth);
  lines.push(
    `- enqueueLabJob with no Authorization header: ${mark(unauthVerdict.pass)} (${unauthVerdict.reason})`
  );
  lines.push('');
  return lines;
}

/**
 * The Markdown the operator copies. Names, booleans, statuses and identifiers
 * only — the same summary the page renders, nothing more.
 *
 * It deliberately names no ticket. It used to head its two halves `### #355`
 * and `### #356`; both closed on 2026-09-07 by this page's first run, so the
 * headings addressed a destination that no longer exists and invited anyone
 * running it since to file evidence against finished work.
 */
export function buildReport({ generatedAt, labs, unauth, ...identity }) {
  return [
    `## Admin diagnostics — ${generatedAt}`,
    '',
    ...identityReportLines(identity),
    ...labsReportLines({ labs, unauth }),
  ].join('\n');
}

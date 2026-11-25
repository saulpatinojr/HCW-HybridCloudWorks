#!/usr/bin/env node
/**
 * Fetch the latest HCP Terraform plan and assert it carries ONLY the known
 * permanent diff.
 *
 * ## Why this exists
 *
 * `assert-expected-plan.mjs` has been the check since T-724, and it is good.
 * What nobody had automated was getting a plan INTO a file to feed it — four
 * chained HCP Terraform API calls — so it was run by hand or not at all.
 *
 * ## Why Node and not PowerShell
 *
 * This replaced `scripts/cutover/07-check-plan.ps1`, which lived for about an
 * hour on 2026-08-29. The cutover scripts are PowerShell because they drive the
 * Azure CLI from an operator's Windows desktop. This one only feeds a Node
 * script, and its endgame is T-724's remaining half: running inside
 * `iac-validate.yml`, on an Ubuntu runner. A `.ps1` bound for a Linux runner is
 * the wrong language, and it also failed the simpler test of being runnable
 * from the bash prompt the owner was actually sitting at.
 *
 * Calling `checkPlan` directly rather than shelling out removes three problems
 * the PowerShell version had to handle: no temp file (so the plan's sensitive
 * variable values and state copies never touch disk), no deletion path to get
 * wrong, and no native exit-code trap — the checker exits 1 to mean "unexpected
 * plan", which PowerShell 7.4+ turns into a thrown error under
 * `$ErrorActionPreference = 'Stop'`.
 *
 * ## Usage
 *
 *     TFC_TOKEN=... node scripts/check-tfc-plan.mjs
 *     TFC_TOKEN=... node scripts/check-tfc-plan.mjs --run run-AbCdEf1234567890
 *
 * The token must be a HCP Terraform **user** or **team** token with admin
 * access to the workspace:
 *
 *     https://app.terraform.io/app/settings/tokens
 *
 * Two token failures, kept apart because they read very differently:
 *
 *   - **403, observed.** An invalid or revoked token is refused here. Confirmed
 *     by running this against a junk token, not assumed.
 *   - **404, documented.** HashiCorp's `/plans` reference says `json-output`
 *     "cannot be accessed with organization tokens" and needs admin-level
 *     workspace access. An under-privileged token gets 404 rather than 403,
 *     which reads like a missing plan rather than a permissions problem. Not
 *     reproduced here — no organization token to hand — so it is handled from
 *     the documentation and labelled as such.
 *
 * Exit codes match `assert-expected-plan.mjs`: 0 expected, 1 unexpected,
 * 2 could not be read.
 */

import { pathToFileURL } from 'node:url';

import { EXPECTED, checkPlan, declarationLines } from './assert-expected-plan.mjs';
import { AWAITING_DECISION, describeRunWindow, FINISHED, normaliseRunId, selectRunForCommit } from './lib/tfc-run-select.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { AWAITING_DECISION, FINISHED, normaliseRunId, indexIncluded, ingressCommitFor, selectRunForCommit, describeRunWindow } from './lib/tfc-run-select.mjs';

export const API = 'https://app.terraform.io/api/v2';
const ORGANIZATION = 'hcw';
const WORKSPACE = 'hcw-azure';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function tfc(token, path, { raw = false } = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' },
    // `json-output` answers 307 to a short-lived archivist URL; fetch follows
    // redirects by default, which is what we want.
  });

  // 401 and 403 both mean "the token is the problem", and HCP Terraform picks
  // between them by case rather than by convention: an invalid or revoked token
  // answers 403 here, which was confirmed by running this against a junk token
  // rather than assumed. Handling only 401 would have left the common case
  // falling through to a bare status code.
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `HCP Terraform refused the token (${response.status}) on ${path}. It is invalid, revoked, ` +
        `or has no access to ${ORGANIZATION}/${WORKSPACE}. Mint a user token at ` +
        'https://app.terraform.io/app/settings/tokens'
    );
  }
  if (response.status === 404) {
    // Two causes, and the message used to assert only the second. On
    // 2026-08-30 an operator passed a run id without its `run-` prefix and was
    // told the TOKEN lacked admin access — which would have sent them
    // regenerating a token that was fine. The permissions cause is real and
    // subtle enough to be worth explaining, but it is not the FIRST thing to
    // suspect when the caller supplied an identifier.
    throw new Error(
      `404 on ${path}.\n\n` +
        'Most likely the identifier is wrong — check it character for character against the ' +
        'HCP Terraform URL, including its `run-` prefix.\n\n' +
        `Failing that, the token may lack ADMIN access to ${ORGANIZATION}/${WORKSPACE}: this ` +
        'endpoint answers 404 rather than 403 for an under-privileged token, and an ' +
        'organization token always lands here. Use a user or team token from ' +
        'https://app.terraform.io/app/settings/tokens'
    );
  }
  if (!response.ok) {
    throw new Error(`HCP Terraform returned ${response.status} on ${path}`);
  }
  // Parsed here rather than with response.json(), whose error quotes the text
  // around the fault. On json-output that text is the plan, secrets included,
  // and this output is a public job summary (#719).
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HCP Terraform returned a body that is not JSON on ${path}`);
  }
  return raw ? body : body.data;
}

async function main() {
  const token = process.env.TFC_TOKEN ?? arg('token');
  if (!token) {
    console.error(
      'No token. Set TFC_TOKEN, or pass --token, using a USER or TEAM token from\n' +
        'https://app.terraform.io/app/settings/tokens — an organization token cannot read\n' +
        'json-output and fails with 404, which reads like a missing plan.'
    );
    return 2;
  }

  const run = await resolveRun(token);
  if (!run) return 2;
  describeRun(run);
  return checkRunPlan(token, run);
}

/** The run to check: --run, the run for --commit, or the workspace's latest. Null, after saying why, when there is none. */
async function resolveRun(token) {
  const runId = normaliseRunId(arg('run'));
  const commit = (arg('commit') ?? '').trim();

  if (runId && commit) {
    console.error('Pass --run or --commit, not both: they select the same thing two ways.');
    return null;
  }
  if (runId) return tfc(token, `/runs/${runId}`);
  if (commit) return runForCommit(token, commit);
  const workspace = await tfc(token, `/organizations/${ORGANIZATION}/workspaces/${WORKSPACE}`);
  const runs = await tfc(token, `/workspaces/${workspace.id}/runs?page%5Bsize%5D=1`);
  if (!runs?.length) throw new Error(`No runs found in ${ORGANIZATION}/${WORKSPACE}.`);
  return runs[0];
}

/** The run HCP Terraform planned for a commit, or null after describing the window it looked in. */
async function runForCommit(token, commit) {
  const workspace = await tfc(token, `/organizations/${ORGANIZATION}/workspaces/${WORKSPACE}`);
  // 50 rather than 1: the commit's run is not necessarily the newest, and
  // this window has to span whatever else ran alongside it.
  const payload = await tfc(
    token,
    `/workspaces/${workspace.id}/runs?page%5Bsize%5D=50&include=configuration_version.ingress_attributes`,
    { raw: true }
  );
  const run = selectRunForCommit(payload, commit);
  if (run) return run;
  // NOT 0. "I found no run for this commit" is not "the plan is boring",
  // and answering the second question when asked the first is how a check
  // goes green without checking anything.
  const seen = describeRunWindow(payload);
  console.error(`\nNo run for commit ${commit}.`);
  console.error(
    `\nThe window held ${seen.count} run(s), ${seen.withCommit} of them carrying a commit ` +
      `sha; newest created ${seen.newest ?? 'unknown'}.`
  );
  console.error(
    '\nIf the newest run predates the commit, HCP Terraform has not planned it yet — a ' +
      'speculative plan lags the push. If runs are recent but few or none carry a commit ' +
      'sha, the plan for this commit is not in the listing this tool reads and selecting ' +
      `by commit cannot work here. Check https://app.terraform.io/app/${ORGANIZATION}/workspaces/${WORKSPACE}/runs`
  );
  return null;
}

/** The run's id, status, message and date, and whether it is a plan awaiting a decision. */
function describeRun(run) {
  console.log(`run     : ${run.id}`);
  console.log(`status  : ${run.attributes.status}`);
  // First line only: a later line would start at column 0 of the log, where
  // it could read as a workflow command or close the summary's code fence.
  console.log(`message : ${String(run.attributes.message ?? '').split(/\r?\n/)[0]}`);
  console.log(`created : ${run.attributes['created-at']}`);

  // The question this tool is dispatched to answer is "is the plan I am about
  // to confirm boring?". Without --run it resolves the workspace's LATEST run,
  // which is whatever ran last — and on 2026-08-30 that was an apply from
  // seventeen hours earlier. It reported UNEXPECTED, correctly, about history,
  // in the same voice it would use for a plan awaiting a decision.
  //
  // The status line above was already printed and was already easy to miss, so
  // the distinction is stated rather than left to be inferred. It is
  // deliberately NOT an error — reading an applied run is a legitimate thing to
  // do, and refusing would remove the only way to ask "what did we actually
  // apply?".
  const status = run.attributes.status;
  const awaiting = AWAITING_DECISION.has(status);

  // A stable, machine-readable line for the workflow, which decides whether an
  // UNEXPECTED verdict should turn the job red. It should not, on a run nobody
  // is being asked to confirm: this tool exists to gate a decision, and when
  // there is no decision to gate, red is a claim it has not earned. A red that
  // means nothing is how a check stops being read.
  console.log(`awaiting-decision: ${awaiting ? 'yes' : 'no'}`);

  if (!awaiting) {
    console.log('');
    console.log(`NOTE: this run is ${status} — not a plan awaiting your decision.`);
    console.log(
      FINISHED.has(status)
        ? '      It already finished, so the verdict below describes history.'
        : '      It is still running, so the verdict below is not final.'
    );
    console.log('      Pass --run <id> to check a specific run.');
  }
}

/** Read the run's plan and judge it: 0 boring, 1 something unexpected, 2 no plan or a malformed one. */
async function checkRunPlan(token, run) {
  const planId = run.relationships?.plan?.data?.id;
  if (!planId) {
    console.error(`\nRun ${run.id} has no plan yet (status ${run.attributes.status}).`);
    return 2;
  }

  const plan = await tfc(token, `/plans/${planId}`);
  const a = plan.attributes;
  console.log(
    `\nsummary : ${a['resource-additions']} to add, ${a['resource-changes']} to change, ` +
      `${a['resource-destructions']} to destroy`
  );
  // Said out loud because the summary is the thing people approve on, and it
  // cannot answer the question. The azapi read-then-strip pair working around
  // azurerm#29149 means every plan reports a diff; three DIFFERENT replacements
  // would produce the same three numbers as the expected ones.
  console.log('          (the counts are not the check — the addresses are)');

  const json = await tfc(token, `/plans/${planId}/json-output`, { raw: true });

  let result;
  try {
    result = checkPlan(json);
  } catch (error) {
    console.error(`\nmalformed plan: ${error.message}`);
    return 2;
  }

  // Declared changes (#719) are listed on both paths: what a pull request said
  // to expect is part of the verdict, and a declaration the plan no longer
  // contains is a prompt to delete it, not a failure.
  return result.ok ? reportExpected(result) : reportUnexpected(result);
}

function reportExpected(result) {
  console.log(
    result.declared.length === 0
      ? '\nOK — the plan carries the known permanent diff and nothing else:'
      : '\nOK — the plan carries the known permanent diff, its declared changes, and nothing else:'
  );
  for (const address of EXPECTED.replaced) console.log(`     replace  ${address}`);
  for (const { address, attribute } of EXPECTED.updated) {
    console.log(`     update   ${address} (${attribute})`);
  }
  for (const line of declarationLines(result)) console.log(line);
  return 0;
}

function reportUnexpected(result) {
  console.error('');
  for (const line of declarationLines(result)) console.error(line);
  for (const line of result.unexpected) console.error(`UNEXPECTED  ${line}`);
  for (const address of result.missing) {
    console.error(
      `MISSING     ${address}: expected to be replaced every apply. If #29149 has closed, ` +
        'remove the azapi pair and assert-expected-plan.mjs together.'
    );
  }
  console.error('\nDo not approve this plan on the shape of the summary line. Read each change.');
  return 1;
}

// Guarded so the module can be IMPORTED without running. Unguarded, importing
// it to read an export fired main(), which reached for the network and then
// called process.exit — inside a test runner that traps process.exit and
// reports an unhandled rejection. Surfaced by check-tfc-plan.test.mjs on
// 2026-08-30, the first time anything imported this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n${error.message}`);
      process.exit(2);
    });
}

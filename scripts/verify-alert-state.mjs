#!/usr/bin/env node
/**
 * Compare every alert rule `infra/` declares with the rules Azure holds, and
 * fail naming each one that is missing, disabled or not wired to its action
 * group (PLAT-4, #964). `.github/workflows/verify-alert-state.yml` runs this
 * weekly as `github_alert_reader` (#1053).
 *
 * ## What it reads, and from where
 *
 * The expected inventory comes from the repository: `lib/alert-declarations.mjs`
 * reads every `.tf` file as one module and resolves each rule's Azure name,
 * resource group, subscription and action group. Nothing here lists a rule by
 * name, so a rule added to `infra/` is checked from the commit that adds it.
 *
 * The live inventory comes from Azure Resource Manager: one token from
 * `az account get-access-token`, then plain GETs, per resource group the
 * declarations name, of the three alert rule types, and a GET of each action
 * group. The subscription IDs are not in the configuration (the variables are
 * sensitive); each subscription's display name is, and `GET /subscriptions`
 * maps one to the other. The workflow also names the two ids outright in
 * ALERT_SUBSCRIPTION_IDS (see knownSubscriptionIds), which fills in any
 * subscription the list leaves out, so the reads never depend on what a
 * resource-group-scoped role makes that list show. A subscription named in
 * neither is reported as not visible.
 *
 * Each live log search rule's Resource Health is read too (#964), one GET of
 * `{rule}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`.
 * alert-timer-overdue was live, enabled and wired from 2026-10-10, so this
 * check read it OK every week, while Kusto refused its query at every
 * evaluation (SEM0040) and its Resource Health read `Unavailable / Semantic
 * error`. A rule that cannot evaluate pages nobody, and its health is the
 * only place Azure says so.
 *
 * ## What it decides
 *
 *   OK              present, enabled, wired to the declared action group, and
 *                   auto-resolution as declared.
 *   MISSING         declared, not live. When `assert-expected-plan.mjs`
 *                   declares the rule's create, the line says it is waiting
 *                   for an apply rather than gone, which is the opposite
 *                   repair.
 *   DISABLED        live with `enabled: false`.
 *   NOT WIRED       live, but its actions do not name the declared group.
 *   DRIFT           `autoMitigate` differs from the declaration (the one
 *                   attribute that decides whether a firing rule mails once
 *                   or every evaluation, ADR 0022 decision 6, and the reason
 *                   this workflow was first written), or the rule is live
 *                   while GATES records its gate as off.
 *   UNHEALTHY       a log search rule whose Resource Health is Unavailable
 *                   or Degraded: Azure reports it cannot evaluate, and the
 *                   Detail names Azure's title (`Semantic error`, ...). Not
 *                   for a rule evaluated less often than every 15 minutes
 *                   whose title gives no reason: Microsoft documents no
 *                   health for those, and Unknown is not a finding either.
 *   HEALTH UNREADABLE  the rule was read but its Resource Health was not (a
 *                   refusal, the provider not registered in the
 *                   subscription, or an answer with no state this knows).
 *                   Its ability to evaluate is unknown, never called OK.
 *   NOT AUTHORIZED  the identity may not read the group. Never collapsed
 *                   into MISSING: one means the alert fabric is gone, the
 *                   other that this check's own grant is.
 *   UNREADABLE      the same refusal, in a subscription UNREADABLE records
 *                   as not yet readable. Reported every run, and as a
 *                   workflow warning; its state is unknown. Not a failure.
 *   GATED OFF       a `count`-gated rule whose gate GATES records as off,
 *                   and absent. Not a failure.
 *
 * Every one of those but OK, UNREADABLE and GATED OFF fails the run. A live rule that no
 * declaration names is listed and does not fail it: it pages, so it is worth
 * seeing, and deleting it is a decision rather than a repair.
 *
 * The action group is read too. It must exist, be enabled and have at least
 * one receiver whose status is Enabled. Receiver NAMES and statuses are
 * printed; the address and number ARM returns beside them are not, because
 * this report is published on a public repository.
 *
 * ## Usage
 *
 *     node scripts/verify-alert-state.mjs                 # live check, needs az login
 *     node scripts/verify-alert-state.mjs --list          # the declared inventory, no Azure
 *     node scripts/verify-alert-state.mjs --summary FILE  # also append the report to FILE
 *
 * Exit 0 when every expected rule is OK, 1 when any is not, 2 when the check
 * could not run at all (no token, an unreadable configuration). Exit 2 is never
 * reported as health.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseArgs } from './lib/cli.mjs';
import { declaredAlertRules, environmentSuffix } from './lib/alert-declarations.mjs';
import { redact } from './lib/plan-report.mjs';
import { terraformSource } from './terraform-source.mjs';
import { azAccessToken, knownSubscriptionIds } from './lib/alert-state-arm.mjs';
import { readLive } from './lib/alert-state-live.mjs';
import { actionGroupProblems, compare, staleUnreadable, undeclared } from './lib/alert-state-compare.mjs';
import { coverageOf, renderInventory, renderReport, runFails, unreadableWarnings } from './lib/alert-state-report.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { ARM, API_VERSIONS, GATES, UNREADABLE, pendingCreates, expectation } from './lib/alert-state-expected.mjs';
export { classifyError, armGet, normaliseRule, azAccessToken, knownSubscriptionIds } from './lib/alert-state-arm.mjs';
export { readLive, readHealth, summariseActionGroup } from './lib/alert-state-live.mjs';
export { durationMinutes, HEALTH_MAX_FREQUENCY_MINUTES, healthVerdict } from './lib/alert-state-health.mjs';
export { FAILING, readFailureLabel, liveProblems, wiredTo, compare, staleUnreadable, undeclared, actionGroupProblems } from './lib/alert-state-compare.mjs';
export { tableCell, unreadCounts, verdictLine, renderReport, runFails, coverageOf, unreadableWarnings, renderInventory } from './lib/alert-state-report.mjs';

// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/verify-alert-state.mjs [--list] [--summary <file>]

  (no flags)        read the live rules through ARM (needs az login) and compare
  --list            print the rules infra/ declares and exit; no Azure call
  --summary <file>  also append the report to <file> (the job summary in CI)

exit 0  every expected rule is live, enabled and wired
exit 1  at least one finding, named in the report
exit 2  the check could not run`;

/** The check could not run: the lines to print, before exit 2. */
class CannotRun extends Error {
  constructor(lines) {
    super(lines[0]);
    this.lines = lines;
  }
}

/** `work()`'s answer, or CannotRun with the lines `describe(err)` gives when it throws. */
function attempt(work, describe) {
  try {
    return work();
  } catch (err) {
    throw new CannotRun(describe(err));
  }
}

/** The command line: --list, --help, or the live comparison. Resolves to the exit code. */
async function main(argv) {
  try {
    return await runCommand(argv);
  } catch (err) {
    if (!(err instanceof CannotRun)) throw err;
    for (const line of err.lines) console.error(line);
    return 2;
  }
}

async function runCommand(argv) {
  const args = attempt(
    () => parseArgs(argv, { flags: ['list', 'help'], options: ['summary'] }),
    (err) => [err.message, USAGE]
  );
  if (args.flags.help) {
    console.log(USAGE);
    return 0;
  }

  const { rules, suffix } = attempt(
    () => {
      const source = terraformSource();
      return { rules: declaredAlertRules(source), suffix: environmentSuffix(source) };
    },
    (err) => [`Could not read the declared alert rules from infra/: ${err.message}`]
  );

  if (args.flags.list) {
    process.stdout.write(renderInventory(rules, suffix));
    return 0;
  }

  const token = attempt(
    () => azAccessToken(),
    (err) => [`No ARM token from az, so nothing was read: ${redact(String(err?.message ?? err)).slice(0, 300)}`]
  );
  const knownIds = attempt(
    () => knownSubscriptionIds(process.env.ALERT_SUBSCRIPTION_IDS),
    (err) => [err.message]
  );
  return compareLive(rules, { token, knownIds, summary: args.options.summary });
}

/** Read the live rules, compare, write the report and outputs, and give the exit code: 1 on any finding. */
async function compareLive(rules, { token, knownIds, summary }) {
  const live = await readLive(rules, { token, knownIds });
  const verdicts = compare(rules, live);
  const groups = actionGroupProblems(rules, live);
  const extra = undeclared(rules, live);
  // The UNREADABLE records describe the workflow's identity, so only its own
  // run can find one stale (review of #1051).
  const asWorkflow = process.env.GITHUB_ACTIONS === 'true';
  const stale = asWorkflow ? staleUnreadable(rules, live) : [];
  const when = new Date().toISOString().replace(/:\d\d\.\d+Z$/, ' UTC').replace('T', ' ');
  const report = renderReport({ rules, verdicts, extra, groups, when, subscriptionsRead: live.subscriptionsRead, stale });

  // Both destinations, as before: the summary for a person on a phone, stdout
  // for the logs API, which does not expose the summary.
  process.stdout.write(report);
  if (summary) appendFileSync(summary, report);
  if (asWorkflow) {
    for (const line of unreadableWarnings(verdicts, groups)) console.log(line);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `coverage=${coverageOf(verdicts, groups)}\n`);

  return runFails(verdicts, groups, live.subscriptionsRead, stale) ? 1 : 0;
}

// pathToFileURL, not a `file://` template: see entrypoint-guards.test.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

#!/usr/bin/env node
/**
 * Assert that a Terraform plan contains ONLY the known permanent diff (T-724).
 *
 * ## Why this exists
 *
 * `infra/main.tf` carries a read-then-strip pair that works around
 * hashicorp/terraform-provider-azurerm#29149, and its cost is that a clean plan
 * no longer exists. Every plan reports:
 *
 *     ~ "RUNTIME_CONFIG_WRITER" = "azapi-strip" -> "azurerm"
 *     Plan: 3 to add, 1 to change, 3 to destroy
 *
 * and a comment in `main.tf` says that a plan reporting exactly that "and
 * nothing else means NO DRIFT".
 *
 * ADR 0018's convergence proof was an EMPTY plan. Operators are now trained to
 * approve a specific non-empty shape by pattern-matching it, and the thing
 * pattern-matching misses is real drift sitting inside or beside the expected
 * trio — three destroys look like three destroys. T-708 is what makes the
 * consequence data loss rather than inconvenience: `prevent_destroy` now covers
 * the Cosmos containers, but a regenerated spec still produces a
 * destroy-and-create plan, and its only gate is a human reading carefully.
 *
 * So the assertion moves out of a comment and into a program.
 *
 * ## Every attribute, not only app_settings (#719)
 *
 * Until #719 an update to the Function App was compared on `app_settings`
 * alone. #718 moved `runtime_version` from "22" to "24" and this reported the
 * plan as expected without reading that attribute, and a stray change to
 * `instance_memory_in_mb`, `https_only`, `virtual_network_subnet_id` or the
 * storage settings would have passed the same way.
 *
 * Every update in the plan is now compared `before` against `after`, leaf by
 * leaf, and each difference is named by its path:
 *
 *     runtime_version
 *     site_config[0].cors[0].allowed_origins[2]
 *     app_settings.RUNTIME_CONFIG_WRITER
 *     app_settings["AzureWebJobs.syncContent.Disabled"]
 *
 * On an update, two kinds of difference are tolerated and nothing else. The
 * first is the `EXPECTED.updated` app setting, whatever its values, which is
 * the T-724 allow-list unchanged. The second is a change declared in
 * `DECLARED` below, with exactly the declared values. Every other difference
 * is UNEXPECTED, printed as `address: update path: before -> after`.
 *
 * THE REPORT IS PUBLIC, AND THE PLAN IS NOT. This repository is public, and
 * `tfc-plan-check.yml` writes the verdict to a job summary anyone can read.
 * `terraform show -json` carries sensitive values in plaintext in `before`,
 * `after` and `variables`, flagged only by `before_sensitive`,
 * `after_sensitive` and the variable's `sensitive` (checked against Terraform
 * 1.15.8 on 2026-09-27). So values are printed by the rules in
 * `lib/plan-report.mjs`, not as Terraform's own renderer prints them behind
 * workspace access. In short: sensitive values print as `(sensitive)`, unknown
 * ones as `(known after apply)`, `app_settings` values as `(set)`, any string
 * the plan marks sensitive anywhere is replaced wherever else it appears, and
 * GUIDs and email addresses are masked. `runtime_version: "22" -> "24"` still
 * reads in full. Before #719 this printed only app-setting names.
 *
 * An update missing any of those markers is not guessed at: the check exits
 * 2. So does a change with no action list. An action it does not recognise,
 * such as `["forget"]`, and an import or a move, are UNEXPECTED even when the
 * action is a no-op.
 *
 * ## Declaring an intended change
 *
 * The pull request that makes a change declares it by adding an entry to
 * `DECLARED`, in this file, in the same diff:
 *
 *     {
 *       address: 'azurerm_function_app_flex_consumption.hcw',
 *       path: 'runtime_version',
 *       before: '22',
 *       after: '24',
 *       reason: '#718: Node.js 24 on Flex Consumption',
 *     }
 *
 * A new or removed resource is declared by its action instead, since there
 * are no values to compare: `{ address, action: 'create', reason }` (or
 * `'delete'`), with the address exact, for_each key included (#816).
 *
 * `path` is written as this script prints it. The entry matches that address,
 * that path and exactly those two values, so a reviewer reads the expectation
 * beside the change it permits. Once the change has applied, the entry matches
 * nothing, and a later drift of the same attribute is caught again rather than
 * waved through by a stale line. A declaration the plan does not contain is
 * printed as a NOTE, not a failure. Usually its change has applied, and the
 * note is the prompt to delete the entry.
 *
 * A sensitive or unknown difference cannot be declared. Matching one would
 * mean writing its value here, so such an entry never matches, and the plan
 * waits for a person to read it.
 *
 * `tfc-plan-check.yml` reads the declarations on the ref it was dispatched
 * from (normally `main`), not those at the commit the run was planned for.
 *
 * ## Usage
 *
 *     terraform show -json tfplan > plan.json
 *     node scripts/assert-expected-plan.mjs plan.json
 *
 * Exit 0 when the change set is exactly the expected diff (or empty). Exit 1
 * with the unexpected changes named, and exit 2 on a malformed plan — those are
 * distinguished because "the plan is not what I think it is" and "I could not
 * read the plan" call for different responses, and collapsing them is how a
 * broken checker gets read as a clean estate.
 *
 * ## Where it runs
 *
 * `.github/workflows/tfc-plan-check.yml` runs this, through
 * `check-tfc-plan.mjs`, against a plan HCP Terraform is holding for
 * confirmation. It is dispatched rather than triggered, and that workflow's
 * header says why. Run by hand against a saved plan, it is the same check.
 * (This section said "not wired into CI" until #719; `tfc-plan-check.yml`
 * had wired it since #284.)
 *
 * ## When #29149 closes
 *
 * Delete this file with the azapi pair. `EXPECTED` going empty is the signal
 * that the workaround is gone: at that point the correct assertion is simply
 * "the plan is empty", which this already handles.
 */

import { readFileSync } from 'node:fs';

import { actionsOf, classify, sideEffects } from './lib/plan-actions.mjs';
import { declarationLines, findDeclaredAction, matchesDeclaration } from './lib/plan-declarations.mjs';
import { attributeChanges, formatPath } from './lib/plan-diff.mjs';
import { describeDifference, secretsOf } from './lib/plan-report.mjs';

// What a change does is read in lib/plan-actions.mjs, what differs in
// lib/plan-diff.mjs, and how it is printed in lib/plan-report.mjs; this file
// keeps the policy. Re-exported so callers and tests have one module to import.
export { classify } from './lib/plan-actions.mjs';
export { declarationLines, describeDeclaration } from './lib/plan-declarations.mjs';
export { attributeChanges, formatPath } from './lib/plan-diff.mjs';
export { describeDifference, redact, secretsOf } from './lib/plan-report.mjs';

/**
 * The permanent diff, by resource address.
 *
 * `replaced` are the three azapi resources their own `replace_triggered_by`
 * recreates on every apply. `updated` is the one attribute the strip rewrites.
 *
 * Addresses, not counts. A near-miss count reads as close enough while meaning
 * something entirely different happened — the same reasoning ADR 0023 gives
 * for approving the teardown against addresses rather than "92 destroyed".
 */
export const EXPECTED = {
  replaced: [
    'azapi_resource_action.function_app_settings',
    'azapi_update_resource.function_app_settings_without_webjobs_storage',
    'azapi_update_resource.function_app_ftp_basic_auth',
  ],
  updated: [
    {
      address: 'azurerm_function_app_flex_consumption.hcw',
      attribute: 'RUNTIME_CONFIG_WRITER',
    },
  ],
};

/**
 * azapi update resources replaced only when the resource they correct
 * changes, not on every apply (#816).
 *
 * `azapi_update_resource.cosmos_computed_properties` writes cp_sortDate back
 * onto `content` and `blogs` whenever azurerm updates one of them, because
 * azurerm's PUT drops it. Its replacement is therefore never drift on its
 * own: the container update that triggers it is, and that is still checked
 * like any other update. It is tolerated per instance (`["content"]`,
 * `["blogs"]`) and never reported missing, since most plans do not contain it.
 */
export const CONDITIONAL_REPLACED = ['azapi_update_resource.cosmos_computed_properties'];

/** `type.name["key"]` -> `type.name`, the address a for_each instance belongs to. */
const baseAddress = (address) => address.replace(/\[[^\]]*\]$/, '');

/**
 * alert-timer-overdue's query as Terraform renders it (infra/observability.tf,
 * PLAT-4): a fixed head and tail around one datatable row per entry of
 * `local.timer_schedules`, in key order. A timer added to the app changes the
 * rows, and with them the rule's `criteria[0].query`, which an update can
 * only declare by its exact values. Both strings below were checked against
 * `terraform console` (1.16.5) on 2026-10-10, and assert-expected-plan.test.mjs
 * holds the `after` rows to the map in the tree.
 */
const OVERDUE_QUERY_HEAD =
  'let Grace = 45m;\nlet Now = now();\nlet Expected = datatable(timer: string, period: timespan, anchor: datetime) [\n';
const OVERDUE_QUERY_TAIL = [
  '',
  '];',
  'let Ingesting = toscalar(requests | where timestamp > Now - 30m | count) > 0;',
  'let LastSuccess = requests',
  '  | where tostring(success) =~ "true"',
  '  | extend timer = replace_string(name, "Functions.", "")',
  '  | summarize lastSuccess = max(timestamp) by timer;',
  'let Overdue = Expected',
  '  | where Ingesting',
  '  | extend lastDue = bin_at(Now - Grace, period, anchor)',
  '  | where lastDue > Now - 1d',
  '  | join kind=leftouter LastSuccess on timer',
  '  | where isnull(lastSuccess) or lastSuccess < lastDue - 1m;',
  'let Many = toscalar(Overdue | count) > 5;',
  'union',
  '  (Overdue | where not(Many) | project timer),',
  '  (Overdue | where Many | take 1 | project timer = "more than five timers at once")',
  '',
].join('\n');

/** The query for these `[name, period, anchor]` rows, as Terraform writes it. */
export function overdueQuery(rows) {
  const lines = [...rows]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, period, anchor]) => `  "${name}", ${period}, datetime(${anchor})`);
  return `${OVERDUE_QUERY_HEAD}${lines.join(',\n')}${OVERDUE_QUERY_TAIL}`;
}

/** `local.timer_schedules` as PLAT-4 (#1052) created it, before #1009's labCanary. */
const PLAT4_TIMER_SCHEDULES = [
  ['buildWeeklyNewsletter', '7d', '2026-01-05 13:00'],
  ['checkAgentHealth', '5m', '2026-01-01 00:00'],
  ['checkLiveLinks', '7d', '2026-01-05 06:00'],
  ['cleanupRejectedContent', '1d', '2026-01-01 04:00'],
  ['cleanupSoftDeletedContent', '4h', '2026-01-01 00:00'],
  ['cleanupTempStorage', '1d', '2026-01-01 00:00'],
  ['cleanupUnusedCertImages', '1d', '2026-01-01 05:00'],
  ['cosmosExportScheduler', '1d', '2026-01-01 03:00'],
  ['fetchBlogListings', '6h', '2026-01-01 00:15'],
  ['fetchPodcastFeeds', '2h', '2026-01-01 00:30'],
  ['forgeScheduled', '1d', '2026-01-01 03:30'],
  ['generateReviewerDigest', '1d', '2026-01-01 07:00'],
  ['healthPulse', '5m', '2026-01-01 00:02'],
  ['labsWeeklyRollup', '1d', '2026-01-01 23:55'],
  ['monitorPublishingPipeline', '6h', '2026-01-01 00:00'],
  ['platformJobSweeper', '15m', '2026-01-01 00:00'],
  ['probeAiProviders', '7d', '2026-01-05 06:15'],
  ['publishScheduledContent', '15m', '2026-01-01 00:00'],
  ['reVerifyCertifications', '7d', '2026-01-04 00:00'],
  ['refreshPlaudToken', '12h', '2026-01-01 00:00'],
  ['refreshToolServiceCache', '1d', '2026-01-01 02:00'],
  ['scrapeSkillsHubRss', '7d', '2026-01-02 09:00'],
  ['sendReminders', '1d', '2026-01-01 13:00'],
  ['syncRssFeeds', '2h', '2026-01-01 00:00'],
  ['syncSocialCalendarScheduled', '5m', '2026-01-01 00:00'],
];

/**
 * Intended one-off changes, each declared by the pull request that makes it
 * (#719).
 *
 * Empty is the normal state. An entry is `{ address, path, before, after,
 * reason }` and matches only those exact values. Delete it once its change
 * has applied. "Declaring an intended change" in the header has the rest.
 */
export const DECLARED = [
  // The weekly AI provider probe's timer flag (#701): the key applied disarmed
  // ('false', present in state since the 2026-10-06 runs); adding
  // PROBE_AI_PROVIDERS to enabled_timers arms it. Everything else declared
  // on 2026-10-06 (LAB-2 rules and their _ResourceId predicates, SEC-2
  // deletes, ADR 0032 decision 6 keys, SEND_REMINDERS, #816) applied in
  // runs ScVFg7p4/JgUsqrst/8M1puNBH that day and was deleted here, as the
  // header asks.
  {
    address: 'azurerm_function_app_flex_consumption.hcw',
    path: 'app_settings.FEATURE_FLAG_PROBE_AI_PROVIDERS',
    before: 'false',
    after: 'true',
    reason: '#701: PROBE_AI_PROVIDERS added to enabled_timers, arming the weekly probe',
  },
  // #1009: the lab canary's timer. Its flag arrives disarmed ('false'), and
  // alert-timer-overdue starts watching it. When PLAT-4's create has not
  // applied yet, that rule is created with the row already in it and the
  // query update below is a NOTE; once it has, the update is this exact one.
  {
    address: 'azurerm_function_app_flex_consumption.hcw',
    path: 'app_settings.FEATURE_FLAG_LAB_CANARY',
    before: undefined,
    after: 'false',
    reason: '#1009: the lab canary timer, disarmed until LAB_CANARY is added to enabled_timers',
  },
  // The owner's run that arms it, after the one above (docs/runbooks/labs-host.md,
  // "Arming the canary").
  {
    address: 'azurerm_function_app_flex_consumption.hcw',
    path: 'app_settings.FEATURE_FLAG_LAB_CANARY',
    before: 'false',
    after: 'true',
    reason: '#1009: LAB_CANARY added to enabled_timers, arming the hourly lab canary',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue',
    path: 'criteria[0].query',
    before: overdueQuery(PLAT4_TIMER_SCHEDULES),
    after: overdueQuery([...PLAT4_TIMER_SCHEDULES, ['labCanary', '1h', '2026-01-01 00:20']]),
    reason: '#1009: alert-timer-overdue watches labCanary too, one row more in its datatable',
  },
  // 2026-10-06: a refused Telegram delivery pages through the action group,
  // after a blocked bot silenced every owner notification for a day.
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.telegram_delivery',
    action: 'create',
    reason: 'Telegram refused or failed a send; the owner hears by SMS and mail instead of nobody',
  },
  // PLAT-4 (#964): the alert conditions the estate assessment found nothing
  // paging on. Eleven new rules, no other change: they read data already
  // collected, so no diagnostic setting, grant or identity moves with them.
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue',
    action: 'create',
    reason: 'PLAT-4: a timer that was due has no successful run since, one alert per timer',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.lab_agent_offline',
    action: 'create',
    reason: 'PLAT-4: a lab agent offline five minutes or more; pages by mail and SMS, not only Telegram',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.jobs_poison',
    action: 'create',
    reason: 'PLAT-4: a message landed in platform-jobs-poison',
  },
  {
    address: 'azurerm_monitor_metric_alert.swa_bandwidth',
    action: 'create',
    reason: 'PLAT-4: a day of Static Web App bandwidth on pace to use 80% of the Free plan month',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.key_vault_errors',
    action: 'create',
    reason: 'PLAT-4: a Key Vault request answered 400 or above, past the routine 401 challenge and unseeded 404s',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.key_vault_data_writes',
    action: 'create',
    reason: 'PLAT-4: a secret or key written through the data plane by anyone but the Function App',
  },
  {
    address: 'azurerm_monitor_activity_log_alert.key_vault_config_writes',
    action: 'create',
    reason: 'PLAT-4: Resource Manager wrote to either vault (ACL, properties, ARM key or secret writes)',
  },
  {
    address: 'azurerm_monitor_activity_log_alert.rbac_assignment_writes_app',
    action: 'create',
    reason: 'PLAT-4: a role assignment changed in the application subscription',
  },
  {
    address: 'azurerm_monitor_activity_log_alert.rbac_definition_writes_app',
    action: 'create',
    reason: 'PLAT-4: a role definition changed in the application subscription',
  },
  {
    address: 'azurerm_monitor_activity_log_alert.rbac_assignment_writes_mgmt',
    action: 'create',
    reason: 'PLAT-4: a role assignment changed in the Management subscription',
  },
  {
    address: 'azurerm_monitor_activity_log_alert.rbac_definition_writes_mgmt',
    action: 'create',
    reason: 'PLAT-4: a role definition changed in the Management subscription',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.lab_hybrid_vault_unwrap',
    action: 'create',
    reason: 'PLAT-4: the lab seal key wrapped or unwrapped from an address the host has not heartbeated from',
  },
  {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.lab_hybrid_ssh_burst',
    action: 'create',
    reason: 'PLAT-4: failed SSH logins on the lab host at four times the day\'s quarter-hour average',
  },
  // #1029: the Perplexity key's reference goes; nothing read it.
  // #1043 added the migration AddOn's address for its status proxy. A plain
  // value, not a secret; #1043 did not declare it, so run-tsRi4e3Te4vxe5nX
  // read UNEXPECTED. (#1029's Perplexity removal applied in
  // run-uB4PpGgfDgZ9ZiWz and was deleted here, as the header asks.)
  {
    address: 'azurerm_function_app_flex_consumption.hcw',
    path: 'app_settings.ADDON_MIGRATION_URL',
    before: undefined,
    after: 'https://migration.lab.hybridcloudworks.com',
    reason: '#1043: the migration AddOn status proxy reads its address',
  },
  // The docs site's CNAME follows the repository to its owner's account.
  {
    address: 'cloudflare_dns_record.docs_pages',
    path: 'content',
    before: 'hybridcloudworks.github.io',
    after: 'saulpatinojr.github.io',
    reason: 'docs CNAME to the repository owner\'s Pages host after the 2026-10-07 move',
  },
];

/** The keys an update must carry for its values to be printed safely. */
const MARKERS = ['before', 'after', 'after_unknown', 'before_sensitive', 'after_sensitive'];

/** address -> the paths an update there may change, whatever the values. */
function toleratedPaths() {
  const tolerated = new Map();
  for (const { address, attribute } of EXPECTED.updated) {
    if (!tolerated.has(address)) tolerated.set(address, new Set());
    tolerated.get(address).add(formatPath(['app_settings', attribute]));
  }
  return tolerated;
}

/**
 * The UNEXPECTED lines for one update (#719): every difference that is
 * neither tolerated nor declared.
 */
function checkUpdate(change, { tolerated, declared, matched, secrets }) {
  const address = change.address;
  const absent = MARKERS.filter((key) => !Object.hasOwn(change.change, key));
  if (absent.length > 0) {
    // Without the markers there is no telling which values are secret, and
    // the report is published. So it stops rather than guessing.
    throw new Error(`${address}: update has no ${absent.join(', ')}, so its values cannot be printed safely`);
  }
  const differences = attributeChanges(change.change);
  if (differences.length === 0) {
    // Terraform plans an update, and nothing this checker can see differs.
    // That is not evidence of a harmless change, so it is not passed.
    return [
      `${address}: update, but no attribute differs between before and after. Read this change in the plan.`,
    ];
  }
  const lines = [];
  for (const difference of differences) {
    if (tolerated.get(address)?.has(difference.path)) continue;
    const declaration = declared.find((d) => matchesDeclaration(d, address, difference));
    if (declaration) matched.add(declaration);
    else lines.push(`${address}: update ${difference.path}: ${describeDifference(difference, secrets)}`);
  }
  return lines;
}

/** Whether a replacement is one of the expected or conditional azapi ones. */
function isToleratedReplacement(address, expectedReplaced) {
  return expectedReplaced.has(address) || CONDITIONAL_REPLACED.includes(baseAddress(address));
}

/**
 * The UNEXPECTED lines for one change that is not a no-op: none for a
 * tolerated replacement or a declared create or delete, the update's own
 * differences for an update, and the action itself otherwise.
 */
function checkChange(change, action, context) {
  const { address } = change;
  if (action === 'replace' && isToleratedReplacement(address, context.expectedReplaced)) return [];

  // Every attribute of an update, not only app_settings (#719). Anything
  // changing beyond the one known app setting and what a pull request has
  // declared is exactly the drift that hides beside the trio, so it is named
  // rather than waved through on the address alone.
  if (action === 'update') return checkUpdate(change, context);

  // A create or a delete can be declared too (#816), by address and action
  // alone. There are no values to match, so the address is exact.
  const declaration = findDeclaredAction(context.declared, address, action);
  if (declaration) {
    context.matched.add(declaration);
    return [];
  }
  return [`${address}: ${action}`];
}

/**
 * Compare a parsed plan against EXPECTED and DECLARED.
 *
 * `declared` defaults to `DECLARED` and is a parameter so the tests can supply
 * their own.
 *
 * @param {object} plan `terraform show -json` output
 * @returns {{ok: boolean, unexpected: string[], missing: string[],
 *            declared: object[], unused: object[]}}
 *   `declared` lists the declarations this plan matched. `unused` lists those
 *   it did not, which the caller reports without failing.
 */
export function checkPlan(plan, { declared = DECLARED } = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('plan is not an object');
  }
  // `resource_changes` is absent from a genuinely empty plan, which is valid.
  const changes = plan.resource_changes ?? [];
  if (!Array.isArray(changes)) {
    throw new Error('plan.resource_changes is not an array');
  }

  const expectedReplaced = new Set(EXPECTED.replaced);
  const matched = new Set();
  const context = {
    expectedReplaced,
    tolerated: toleratedPaths(),
    declared,
    matched,
    secrets: secretsOf(plan),
  };

  const unexpected = [];
  const seen = new Set();

  for (const change of changes) {
    const actions = actionsOf(change);
    const action = classify(actions);
    for (const note of sideEffects(change, actions)) unexpected.push(`${change.address}: ${note}`);
    if (action === 'no-op') continue;
    seen.add(change.address);
    unexpected.push(...checkChange(change, action, context));
  }

  // An expected change that has STOPPED appearing matters too: it means the
  // workaround is no longer running, and the AzureWebJobsStorage strip is what
  // stands between the app and a connection string it must not have (T-511).
  const missing = [...expectedReplaced].filter((address) => !seen.has(address));

  return {
    ok: unexpected.length === 0 && missing.length === 0,
    unexpected,
    missing,
    declared: declared.filter((d) => matched.has(d)),
    unused: declared.filter((d) => !matched.has(d)),
  };
}

/** The plan in a file, or why there is none. */
function readPlan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { problem: `could not read a plan from ${path}: ${err.message}` };
  }
  try {
    return { plan: JSON.parse(text) };
  } catch {
    // The parser's own message quotes the text around the fault, and a plan
    // holds secrets in plaintext, so it is not printed.
    return { problem: `${path} is not valid JSON, so no plan could be read from it.` };
  }
}

function main(argv) {
  const path = argv[2];
  if (!path) {
    console.error('usage: node scripts/assert-expected-plan.mjs <plan.json>');
    console.error('  produce it with: terraform show -json tfplan > plan.json');
    return 2;
  }

  const { plan, problem } = readPlan(path);
  if (problem) {
    console.error(problem);
    return 2;
  }

  let result;
  try {
    result = checkPlan(plan);
  } catch (err) {
    console.error(`malformed plan: ${err.message}`);
    return 2;
  }

  if (result.ok) {
    console.log(
      result.declared.length === 0
        ? 'plan matches the expected permanent diff and nothing else.'
        : 'plan matches the expected permanent diff and its declared changes, and nothing else.'
    );
    for (const line of declarationLines(result)) console.log(line);
    return 0;
  }

  for (const line of declarationLines(result)) console.error(line);
  for (const line of result.unexpected) {
    console.error(`UNEXPECTED  ${line}`);
  }
  for (const address of result.missing) {
    console.error(
      `MISSING     ${address}: expected to be replaced every apply. If #29149 has closed, ` +
        'remove the azapi pair and this script together.'
    );
  }
  console.error('');
  console.error('Do not approve this plan on the shape of the summary line. Read each change.');
  return 1;
}

// Only run when invoked directly, so the exports above stay importable.
if (process.argv[1] && process.argv[1].endsWith('assert-expected-plan.mjs')) {
  process.exit(main(process.argv));
}

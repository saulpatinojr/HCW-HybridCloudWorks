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
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { DECLARED } from './assert-expected-plan.mjs';
import { parseArgs } from './lib/cli.mjs';
import { declaredAlertRules, environmentSuffix, shortName } from './lib/alert-declarations.mjs';
import { redact } from './lib/plan-report.mjs';
import { terraformSource } from './terraform-source.mjs';

export const ARM = 'https://management.azure.com';

/**
 * api-version per ARM read, each the GA version its REST reference documents.
 * Resource Health's is the one Microsoft's SDKs default to for
 * AvailabilityStatuses_GetByResource; on 2026-10-15 it returned the same
 * `availabilityState`, `title` and `summary` for alert-timer-overdue as
 * 2023-10-01-preview did (`Unavailable`, `Semantic error`).
 */
export const API_VERSIONS = {
  'Microsoft.Insights/scheduledQueryRules': '2021-08-01',
  'Microsoft.Insights/metricAlerts': '2018-03-01',
  'Microsoft.Insights/activityLogAlerts': '2020-10-01',
  actionGroups: '2021-09-01',
  subscriptions: '2022-12-01',
  resourceHealth: '2025-05-01',
};

/**
 * What each `count` gate is set to in the hcw-azure workspace, and the record
 * that says so.
 *
 * The workspace variables are not readable from here, and github_reader holds
 * no HCP Terraform token, so a gated rule's expected state is recorded rather
 * than read. That record can go stale, and the check fails when it does: a
 * rule present while its gate is recorded off is DRIFT, and one absent while
 * recorded on is MISSING. Every gate a declared
 * rule uses must have an entry, which the test suite enforces; an
 * unrecorded gate reports its rule as unknown rather than guessing.
 */
export const GATES = {
  availability_probe_alert_enabled: {
    armed: true,
    record: 'applied 2026-09-01 when T-519 closed (CHANGELOG.md, "T-519 closed: the reachability alert is armed")',
  },
  cosmos_export_enabled: {
    armed: true,
    record: 'exporter armed and its daily alert live since 2026-09-09 (docs/runbooks/cosmos-restore.md)',
  },
  availability_test_enabled: {
    armed: false,
    record: 'off: Bot Fight Mode answers Azure availability agents with a 403; the edge probe is the armed path (ADR 0024)',
  },
};

/**
 * Subscriptions this workflow's identity is known not to be able to read yet,
 * and the record that says so (review of #1051).
 *
 * EMPTY since #1053. The workflow ran as `github_reader`, which held nothing
 * in the Management subscription, where the capacity and lab rules, the
 * Management role-change rules and the action group live, so that
 * subscription was recorded here from PLAT-4 until the owner's decision on
 * 2026-10-11 gave the job an identity of its own, `github_alert_reader`,
 * that reads alert rules and action groups in both resource groups
 * (infra/oidc.tf). The mechanism stays for the next gap of the kind: a
 * monitor that is red every week for a reason everyone already knows gets
 * muted, and `validate-deployed.yml` was deleted on 2026-09-08 after three
 * weeks of exactly that.
 *
 * THIS IS NOT A MUTE, by the same rules as EXPECTED_UNRESOLVED in
 * check-unresolved-secrets.mjs. A rule in a subscription listed here, whose
 * read is refused (403 or the subscription not visible), is reported as
 * UNREADABLE in every run's table and as a workflow warning, and its state is
 * called unknown, never healthy. Any other failure to read it still fails the
 * run. When a read there succeeds, the report says the entry has gone stale,
 * so it is deleted with the grant that made it stale rather than lingering
 * to hide a later refusal: when the workflow's own run can read a recorded
 * subscription, the run FAILS until the entry is deleted (review of #1051).
 * The step also writes `coverage=partial` while any entry applies, for
 * consumers that read outcomes rather than summaries.
 */
export const UNREADABLE = {};

/** The plan checker's declared creates, by address: rules waiting for an apply. */
export function pendingCreates(declared = DECLARED) {
  return new Map(declared.filter((d) => d.action === 'create').map((d) => [d.address, d.reason]));
}

/**
 * Whether a declared rule should be live.
 *
 * @returns {{expected: 'present'|'absent'|'unknown', why: string}}
 */
export function expectation(rule, gates = GATES) {
  if (!rule.gate) return { expected: 'present', why: '' };
  if (rule.gate.expression) return { expected: 'unknown', why: `count = ${rule.gate.expression}` };
  const gate = gates[rule.gate.variable];
  if (!gate) return { expected: 'unknown', why: `gated on var.${rule.gate.variable}, which GATES does not record` };
  return {
    expected: gate.armed ? 'present' : 'absent',
    why: `var.${rule.gate.variable} ${gate.armed ? 'on' : 'off'}: ${gate.record}`,
  };
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

/** Turn an ARM error response into a classified, publishable reason. */
export function classifyError(status, body) {
  const code = body?.error?.code ?? body?.code ?? '';
  const message = body?.error?.message ?? body?.message ?? '';
  const reason = redact(`HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`).slice(0, 300);
  if (status === 401) return { status: 'unauthenticated', reason };
  // A provider the subscription has not registered. Resource Health answers
  // this as 409 AuthError, "Make sure the resource provider has been
  // registered with this subscription" (sub-plat-mgmt-prod-cus, 2026-10-15);
  // ARM's own spelling is the code MissingSubscriptionRegistration. The
  // message counts only in that measured shape: a 403 AuthorizationFailed
  // whose text happens to name registration is still a refusal, and its fix
  // is the role, not the provider.
  if (
    /^MissingSubscriptionRegistration$/i.test(code) ||
    (status === 409 && /^AuthError$/i.test(code) && /resource provider has been registered/i.test(message))
  ) {
    return { status: 'not-registered', reason };
  }
  if (status === 403 || /AuthorizationFailed/i.test(code)) return { status: 'denied', reason };
  if (status === 404 && /ResourceGroupNotFound/i.test(code)) return { status: 'group-not-found', reason };
  if (status === 404) return { status: 'not-found', reason };
  return { status: 'failed', reason };
}

/**
 * GET an ARM URL, following `nextLink` while it stays on the ARM host.
 *
 * The host check is not decoration: the next page is requested with the
 * same bearer token, and a link that pointed anywhere else would hand it
 * over. A link that leaves ARM ends the read as a failure.
 */
export async function armGet(path, { token, fetchImpl = fetch, list = false }) {
  let url = `${ARM}${path}`;
  const rows = [];
  for (let page = 0; url; page += 1) {
    if (page >= 50) return { status: 'failed', reason: 'more than 50 pages; refusing to keep paging' };
    if (!url.startsWith(`${ARM}/`)) return { status: 'failed', reason: 'nextLink left management.azure.com' };
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      return { status: 'failed', reason: redact(`request failed: ${err?.message ?? err}`) };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) return classifyError(res.status, body);
    if (!list) return { status: 'ok', body };
    if (!Array.isArray(body?.value)) return { status: 'failed', reason: 'response carried no value array' };
    rows.push(...body.value);
    url = body.nextLink ?? null;
  }
  return { status: 'ok', rows };
}

/** One live rule, normalised across the three ARM shapes. */
export function normaliseRule(armType, row) {
  const p = row?.properties ?? {};
  let actionGroupIds;
  if (armType === 'Microsoft.Insights/scheduledQueryRules') {
    actionGroupIds = p.actions?.actionGroups ?? [];
  } else if (armType === 'Microsoft.Insights/metricAlerts') {
    actionGroupIds = (p.actions ?? []).map((a) => a.actionGroupId);
  } else {
    actionGroupIds = (p.actions?.actionGroups ?? []).map((a) => a.actionGroupId);
  }
  return {
    name: row?.name ?? '(unnamed)',
    armType,
    enabled: p.enabled,
    autoMitigate: p.autoMitigate,
    actionGroupIds: actionGroupIds.filter((id) => typeof id === 'string'),
    severity: p.severity,
    evaluationFrequency: p.evaluationFrequency,
    windowSize: p.windowSize,
    muteActionsDuration: p.muteActionsDuration,
  };
}

/** A token for ARM from the signed-in az session. Throws when there is none. */
export function azAccessToken(exec = execSync) {
  // A fixed command with no interpolated value, so the shell execSync uses
  // (needed on Windows, where az is az.cmd) has nothing to misread.
  const out = exec('az account get-access-token --resource https://management.azure.com/ -o json --only-show-errors', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const token = JSON.parse(out).accessToken;
  if (!token) throw new Error('az returned no accessToken');
  return token;
}

/**
 * Subscription ids the workflow names outright, as `display-name=guid` pairs
 * separated by commas (ALERT_SUBSCRIPTION_IDS in verify-alert-state.yml).
 *
 * WHY (CodeRabbit on #1053): the ids otherwise come only from
 * `GET /subscriptions`, which lists the subscriptions the caller can see.
 * github_alert_reader holds one custom role at resource-group scope and no
 * subscription-level read, and whether that alone puts a subscription in the
 * list is not something Microsoft documents. Naming the ids means the rule
 * reads never depend on it: a subscription the list leaves out is still read
 * at the groups the identity was granted. Each entry is held to a name and a
 * GUID before it reaches a path; anything else stops the check (exit 2)
 * rather than being skipped.
 *
 * @returns {Map<string, string>} display name -> subscription id
 */
export function knownSubscriptionIds(text) {
  const known = new Map();
  for (const entry of String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9-]+)=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(entry);
    if (!m) throw new Error(`ALERT_SUBSCRIPTION_IDS holds an entry that is not display-name=GUID: ${redact(entry).slice(0, 80)}`);
    known.set(m[1], m[2].toLowerCase());
  }
  return known;
}

/**
 * Read everything the declared rules need: the subscriptions, each
 * (subscription, resource group, rule type) list, and each action group.
 * `knownIds` (knownSubscriptionIds) fills in any subscription the list does
 * not show; one the list does show keeps the id the list gave.
 *
 * A list that could not be read at all stops the check only when nothing is
 * named (CodeRabbit on #1074). With named ids the rule reads go ahead, each
 * judged on its own answer, and `subscriptionsRead` says the ids were named
 * (`namedOnly`) and why the list was not used. A rule whose subscription is
 * named nowhere is still not visible, so it fails as NOT AUTHORIZED.
 */
export async function readLive(rules, { token, fetchImpl = fetch, knownIds = new Map() }) {
  const subs = await armGet(`/subscriptions?api-version=${API_VERSIONS.subscriptions}`, {
    token,
    fetchImpl,
    list: true,
  });
  if (subs.status !== 'ok' && knownIds.size === 0) {
    return { subscriptionsRead: subs, ids: new Map(), lists: new Map(), actionGroups: new Map() };
  }
  const ids = new Map(subs.status === 'ok' ? subs.rows.map((s) => [s.displayName, s.subscriptionId]) : []);
  for (const [name, id] of knownIds) if (!ids.has(name)) ids.set(name, id);
  const subscriptionsRead =
    subs.status === 'ok' ? subs : { status: 'ok', namedOnly: true, listStatus: subs.status, reason: subs.reason };

  const lists = new Map();
  const wanted = new Map();
  for (const rule of rules) {
    wanted.set(listKey(rule.subscription, rule.resourceGroup, rule.armType), rule);
  }
  for (const [key, rule] of wanted) {
    const id = ids.get(rule.subscription);
    if (!id) {
      lists.set(key, {
        status: 'not-visible',
        reason: `${rule.subscription} is not among the subscriptions this identity can see, and ALERT_SUBSCRIPTION_IDS does not name it`,
      });
      continue;
    }
    const path =
      `/subscriptions/${id}/resourceGroups/${rule.resourceGroup}/providers/${rule.armType}` +
      `?api-version=${API_VERSIONS[rule.armType]}`;
    const read = await armGet(path, { token, fetchImpl, list: true });
    if (read.status === 'ok') {
      read.rules = new Map(read.rows.map((row) => normaliseRule(rule.armType, row)).map((r) => [r.name.toLowerCase(), r]));
      delete read.rows;
    }
    lists.set(key, read);
  }

  const actionGroups = new Map();
  for (const group of uniqueActionGroups(rules)) {
    const id = ids.get(group.subscription);
    if (!id) {
      actionGroups.set(group.address, {
        status: 'not-visible',
        reason: `${group.subscription} is not visible to this identity, and ALERT_SUBSCRIPTION_IDS does not name it`,
      });
      continue;
    }
    const path =
      `/subscriptions/${id}/resourceGroups/${group.resourceGroup}/providers/Microsoft.Insights/actionGroups/` +
      `${group.name}?api-version=${API_VERSIONS.actionGroups}`;
    const read = await armGet(path, { token, fetchImpl });
    actionGroups.set(group.address, read.status === 'ok' ? summariseActionGroup(read.body) : read);
  }

  // Resource Health for every log search rule that is live (#964). A rule
  // the lists did not return has nothing to read; its verdict says so.
  const health = new Map();
  for (const rule of rules) {
    if (rule.armType !== 'Microsoft.Insights/scheduledQueryRules') continue;
    const list = lists.get(listKey(rule.subscription, rule.resourceGroup, rule.armType));
    const found = list?.status === 'ok' ? list.rules.get(rule.name.toLowerCase()) : null;
    if (!found) continue;
    health.set(rule.address, await readHealth(ids.get(rule.subscription), rule.resourceGroup, found.name, { token, fetchImpl }));
  }
  return { subscriptionsRead, ids, lists, actionGroups, health };
}

/** One log search rule's Resource Health, or the classified failure to read it. */
export async function readHealth(subscriptionId, resourceGroup, ruleName, { token, fetchImpl = fetch }) {
  const path =
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Insights/scheduledQueryRules/` +
    `${encodeURIComponent(ruleName)}/providers/Microsoft.ResourceHealth/availabilityStatuses/current` +
    `?api-version=${API_VERSIONS.resourceHealth}`;
  const read = await armGet(path, { token, fetchImpl });
  if (read.status !== 'ok') return read;
  const p = read.body?.properties ?? {};
  return { status: 'ok', state: p.availabilityState, title: p.title, summary: p.summary };
}

/** Minutes in an ISO 8601 duration such as PT15M, PT1H or P1D; null when it is not one. */
export function durationMinutes(text) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(text ?? ''));
  if (!m || text === 'P' || text === 'PT') return null;
  const [days, hours, minutes, seconds] = m.slice(1).map((part) => Number(part ?? 0));
  return days * 1440 + hours * 60 + minutes + seconds / 60;
}

/**
 * The longest evaluation frequency Resource Health reports on, in minutes.
 * Microsoft's "Monitor the health of log search alert rules": health is
 * "supported only for rules with a frequency of 15 minutes or lower", and a
 * less frequent rule reads Unknown, or, the same page also says,
 * "Unavailable for unknown reason". Measured on 2026-10-15: both daily Cosmos
 * export rules read `Unknown`.
 */
export const HEALTH_MAX_FREQUENCY_MINUTES = 15;

/**
 * Titles that carry no reason, which a rule beyond that frequency is given:
 * "Unknown", "Unknown reason", "Unavailable for unknown reason", "Degraded
 * due to unknown reason" (the titles that page lists).
 */
const REASONLESS_TITLE = /^(?:\w+\s+(?:for|due to)\s+(?:an\s+)?)?unknown(?:\s+reason)?$/i;

/**
 * What one rule's Resource Health means for its verdict.
 *
 * @returns {{shown: string, problem: [string, string]|null, note: string|null}}
 *   `shown` for the report's Health column; `problem` a failing [state,
 *   text]; `note` a non-failing remark.
 */
export function healthVerdict(health, found, subscription) {
  if (!health || health.status !== 'ok') {
    return { shown: 'unread', problem: ['HEALTH UNREADABLE', healthUnreadReason(health, subscription)], note: null };
  }
  const state = health.state;
  const title = redact(String(health.title ?? '')).slice(0, 120);
  const summary = redact(String(health.summary ?? '')).slice(0, 200);
  const frequency = durationMinutes(found?.evaluationFrequency);
  const reported = frequency === null || frequency <= HEALTH_MAX_FREQUENCY_MINUTES;
  if (state === 'Available') return { shown: 'Available', problem: null, note: null };
  if (state === 'Unknown') {
    const why = reported
      ? `Resource Health: Unknown${title && title !== 'Unknown' ? ` (${title})` : ''}`
      : `Resource Health: Unknown, as Microsoft documents for a rule evaluated less often than every ${HEALTH_MAX_FREQUENCY_MINUTES} minutes`;
    return { shown: 'Unknown', problem: null, note: why };
  }
  if (state === 'Unavailable' || state === 'Degraded') {
    if (!reported && (!title || REASONLESS_TITLE.test(title))) {
      return {
        shown: state,
        problem: null,
        note:
          `Resource Health: ${state}${title ? `, "${title}"` : ''}, which Microsoft documents for a rule evaluated less ` +
          `often than every ${HEALTH_MAX_FREQUENCY_MINUTES} minutes; not a finding`,
      };
    }
    const text = `${title || state} (Resource Health: ${state})${summary ? `. ${summary}` : ''}`;
    return { shown: state, problem: ['UNHEALTHY', text], note: null };
  }
  return {
    shown: 'unread',
    problem: ['HEALTH UNREADABLE', `Resource Health answered with an availabilityState this check does not know: ${redact(String(state)).slice(0, 40)}`],
    note: null,
  };
}

/** Why a rule's Resource Health could not be read, in words the owner can act on. */
function healthUnreadReason(read, subscription) {
  const where = '"Resource Health" in docs/runbooks/alerting-and-support.md';
  const reason = read?.reason ?? 'not read';
  if (read?.status === 'not-registered') {
    return (
      `Resource Health could not be read: the Microsoft.ResourceHealth provider is not registered in ${subscription}, ` +
      `so whether this rule can evaluate is unknown, not healthy. The owner registers it once (${where}). (${reason})`
    );
  }
  if (read?.status === 'denied' || read?.status === 'unauthenticated') {
    return (
      'Resource Health could not be read: this identity may not read it. HCW Alert Rule Reader carries ' +
      `Microsoft.ResourceHealth/availabilityStatuses/read once the owner updates the role (${where}). (${reason})`
    );
  }
  return `Resource Health could not be read, so whether this rule can evaluate is unknown. (${reason})`;
}

/** The key one (subscription, resource group, rule type) list is held under; groups compare case-insensitively. */
const listKey = (subscription, group, armType) => `${subscription}|${group.toLowerCase()}|${armType}`;

/** Every action group the rules name, once each. */
function uniqueActionGroups(rules) {
  const byAddress = new Map();
  for (const rule of rules) for (const g of rule.actionGroups) byAddress.set(g.address, g);
  return [...byAddress.values()];
}

/** Names and statuses only. The address and phone number are dropped here. */
export function summariseActionGroup(body) {
  const p = body?.properties ?? {};
  const receivers = [
    ...(p.emailReceivers ?? []).map((r) => ({ kind: 'email', name: r.name, status: r.status })),
    ...(p.smsReceivers ?? []).map((r) => ({ kind: 'sms', name: r.name, status: r.status })),
  ];
  return { status: 'ok', enabled: p.enabled !== false, receivers };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** Rule states that fail the run. UNREADABLE, GATED OFF, ABSENT and OK do not. */
export const FAILING = new Set([
  'MISSING',
  'DISABLED',
  'NOT WIRED',
  'DRIFT',
  'UNHEALTHY',
  'HEALTH UNREADABLE',
  'NOT AUTHORIZED',
  'READ FAILED',
]);

/** Action-group states that fail the run. */
const FAILING_GROUP = new Set(['BROKEN', 'NOT AUTHORIZED', 'READ FAILED']);

/** States meaning the rule or group, or a rule's health, was never read, whatever the reason. */
const NOT_READ = new Set(['UNREADABLE', 'NOT AUTHORIZED', 'READ FAILED', 'HEALTH UNREADABLE']);

/** Read statuses that mean "this identity may not look", as opposed to an error. */
const REFUSED = new Set(['denied', 'not-visible']);

/**
 * The state a failed read gives everything behind it: UNREADABLE when the
 * subscription is recorded in `unreadable` and the read was refused,
 * NOT AUTHORIZED for any other refusal (and for a 401), READ FAILED otherwise.
 */
export function readFailureLabel(read, subscription, unreadable = UNREADABLE) {
  if (REFUSED.has(read.status) && subscription in unreadable) return 'UNREADABLE';
  return REFUSED.has(read.status) || read.status === 'unauthenticated' ? 'NOT AUTHORIZED' : 'READ FAILED';
}

/** A verdict for a rule whose resource group could not be read. */
function unreadVerdict(base, read, unreadable) {
  const state = readFailureLabel(read, base.rule.subscription, unreadable);
  if (state === 'UNREADABLE') {
    return { ...base, state, notes: [...base.notes, `${unreadable[base.rule.subscription].record} (${read.reason})`] };
  }
  return { ...base, state, problems: [read.reason] };
}

/** A verdict for a rule its resource group does not hold. */
function absentVerdict(base, pending) {
  if (base.expect.expected === 'absent') return { ...base, state: 'GATED OFF' };
  if (base.expect.expected === 'unknown') return { ...base, state: 'ABSENT', notes: [...base.notes, 'gate state unknown'] };
  const waiting = pending.get(base.rule.address);
  const problems = waiting
    ? [`create declared in scripts/assert-expected-plan.mjs and waiting for an apply: ${waiting}`]
    : ['not in Azure'];
  return { ...base, state: 'MISSING', problems };
}

/** Every [state, text] problem with a rule that is live. */
export function liveProblems(rule, found, expect, ids) {
  const problems = [];
  if (expect.expected === 'absent') {
    // Terraform's count is 0 for an off gate, so a live rule means the gate is
    // on after all or the rule was made by hand: either way, not as recorded.
    problems.push(['DRIFT', `live although GATES records var.${rule.gate.variable} as off; correct the record`]);
  }
  if (found.enabled === false && rule.enabled !== false) problems.push(['DISABLED', 'enabled is false']);
  for (const group of rule.actionGroups) {
    if (!wiredTo(found, group, ids)) problems.push(['NOT WIRED', `actions do not name ${group.name} in ${group.resourceGroup}`]);
  }
  if (rule.actionGroups.length === 0) problems.push(['NOT WIRED', 'no action group is declared']);
  if (rule.autoMitigate !== null && typeof found.autoMitigate === 'boolean' && found.autoMitigate !== rule.autoMitigate) {
    problems.push(['DRIFT', `autoMitigate is ${found.autoMitigate}, declared ${rule.autoMitigate}`]);
  }
  return problems;
}

/** Whether a live rule's actions name the declared action group. */
export function wiredTo(live, group, ids) {
  const suffix = `/resourcegroups/${group.resourceGroup}/providers/microsoft.insights/actiongroups/${group.name}`.toLowerCase();
  const id = ids.get(group.subscription);
  return live.actionGroupIds.some((raw) => {
    const candidate = raw.toLowerCase();
    if (!candidate.endsWith(suffix)) return false;
    return !id || candidate === `/subscriptions/${id}${suffix}`.toLowerCase();
  });
}

/** The verdict for one declared rule. */
function judgeRule(rule, live, { gates, pending, unreadable }) {
  const expect = expectation(rule, gates);
  const read = live.lists.get(listKey(rule.subscription, rule.resourceGroup, rule.armType)) ?? {
    status: 'failed',
    reason: 'not read',
  };
  const base = { rule, expect, live: null, problems: [], notes: expect.why ? [expect.why] : [] };
  if (read.status !== 'ok') return unreadVerdict(base, read, unreadable);
  const found = read.rules.get(rule.name.toLowerCase()) ?? null;
  if (!found) return absentVerdict(base, pending);
  const problems = liveProblems(rule, found, expect, live.ids);
  const notes = [...base.notes];
  let health;
  if (rule.armType === 'Microsoft.Insights/scheduledQueryRules') {
    // A map with no entry for a live rule means the read never happened,
    // which is unread, not healthy.
    const verdict = healthVerdict(live.health?.get(rule.address), found, rule.subscription);
    health = verdict.shown;
    if (verdict.problem) problems.push(verdict.problem);
    if (verdict.note) notes.push(verdict.note);
  }
  const judged = { ...base, live: found, health, notes };
  if (problems.length === 0) return { ...judged, state: 'OK' };
  return { ...judged, state: problems[0][0], problems: problems.map(([, text]) => text) };
}

/** One verdict per declared rule. */
export function compare(rules, live, { gates = GATES, pending = pendingCreates(), unreadable = UNREADABLE } = {}) {
  return rules.map((rule) => judgeRule(rule, live, { gates, pending, unreadable }));
}

/**
 * UNREADABLE entries a read has contradicted: a subscription recorded as
 * unreadable in which some list came back. Only meaningful for the identity
 * the entry is about, so main() asks only when it runs as the workflow: an
 * operator's own login can read Management, and would otherwise be told to
 * delete an entry that is still true for github_reader.
 */
export function staleUnreadable(rules, live, unreadable = UNREADABLE) {
  const readOk = new Set(
    rules
      .filter((r) => live.lists.get(listKey(r.subscription, r.resourceGroup, r.armType))?.status === 'ok')
      .map((r) => r.subscription)
  );
  return Object.keys(unreadable).filter((subscription) => readOk.has(subscription));
}

/** Live rules in the groups read that no declaration names. */
export function undeclared(rules, live) {
  const declared = new Set(rules.map((r) => `${listKey(r.subscription, r.resourceGroup, r.armType)}|${r.name.toLowerCase()}`));
  const out = [];
  for (const [key, read] of live.lists) {
    if (read.status !== 'ok') continue;
    for (const [name, rule] of read.rules) {
      if (!declared.has(`${key}|${name}`)) out.push({ key, rule });
    }
  }
  return out;
}

/** Problems with the action groups themselves. */
export function actionGroupProblems(rules, live, unreadable = UNREADABLE) {
  return uniqueActionGroups(rules).map((group) => {
    const read = live.actionGroups.get(group.address) ?? { status: 'failed', reason: 'not read' };
    if (read.status !== 'ok') {
      const state = readFailureLabel(read, group.subscription, unreadable);
      const detail = state === 'UNREADABLE' ? `${unreadable[group.subscription].record} (${read.reason})` : read.reason;
      return { group, state, problems: [detail], read };
    }
    const problems = [];
    if (!read.enabled) problems.push('the action group is disabled');
    if (!read.receivers.some((r) => r.status === 'Enabled')) problems.push('no receiver has status Enabled');
    return { group, state: problems.length ? 'BROKEN' : 'OK', problems, read };
  });
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Text made safe for one cell of a Markdown table (code scanning, #1051).
 *
 * A pipe ends the cell, so it is escaped as `\|`; and because that escape is
 * a backslash, a backslash already in the text is escaped first, or `\|` in
 * an ARM error message would arrive as an escaped backslash and a bare pipe.
 * Line breaks end the row, so they become spaces.
 */
export function tableCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A value shown in code style, or a dash for nothing. */
const cell = (value) => (value === undefined || value === null || value === '' ? '—' : `\`${tableCell(value)}\``);

/** How many rules and action groups the run could not read, as recorded. */
export function unreadCounts(verdicts, groups) {
  return {
    rules: verdicts.filter((v) => v.state === 'UNREADABLE').length,
    groups: groups.filter((g) => g.state === 'UNREADABLE').length,
  };
}

/**
 * The closing lines: what the states mean, then the verdict in one sentence,
 * always last (review of #1051: the runbook's success test reads the last
 * line, and a notice printed after the verdict made a healthy run read as
 * unclear).
 */
function summaryLines(verdicts, groups, stale) {
  const failing =
    verdicts.filter((v) => FAILING.has(v.state)).length +
    groups.filter((g) => FAILING_GROUP.has(g.state)).length +
    stale.length;
  const unread = unreadCounts(verdicts, groups);
  const lines = [];
  if (verdicts.some((v) => v.state === 'NOT AUTHORIZED') || groups.some((g) => g.state === 'NOT AUTHORIZED')) {
    lines.push(
      '',
      '`NOT AUTHORIZED` means this identity could not read that resource group, so the state of the rules in it ' +
        'is unknown; it is not the same finding as `MISSING`. The Detail column says why, and `infra/oidc.tf` ' +
        'holds the grants of `github_reader`, the identity this workflow signs in as.'
    );
  }
  if (verdicts.some((v) => v.state === 'UNHEALTHY')) {
    lines.push(
      '',
      '`UNHEALTHY` means Azure Monitor reports the rule cannot evaluate: its Resource Health is Unavailable or ' +
        'Degraded, with Azure\'s title first in the Detail column. A rule in that state pages nobody, whatever it is ' +
        'meant to catch, however live and wired it is. `Semantic error` and `Syntax error` mean the query itself; run ' +
        'it under the rule\'s scope → **Logs** to see the error.'
    );
  }
  if (verdicts.some((v) => v.state === 'HEALTH UNREADABLE')) {
    lines.push(
      '',
      '`HEALTH UNREADABLE` means the rule was read and its Resource Health was not, so whether it can evaluate is ' +
        '**unknown**, never healthy. The Detail column says why; the one-time owner steps (registering ' +
        '`Microsoft.ResourceHealth`, updating *HCW Alert Rule Reader*) are under "Resource Health" in ' +
        '`docs/runbooks/alerting-and-support.md`.'
    );
  }
  for (const subscription of stale) {
    lines.push(
      '',
      `**STALE RECORD: \`${subscription}\` is readable by this workflow now**, so its \`UNREADABLE\` entry in ` +
        '`scripts/verify-alert-state.mjs` no longer describes it. This fails the run until the entry is deleted, ' +
        'so the exception cannot outlive the gap it recorded and quietly excuse a later refusal.'
    );
  }
  lines.push('', verdictLine(failing, unread, verdicts.filter((v) => v.state === 'ABSENT').length));
  return lines;
}

/**
 * The verdict sentence. "Every expected rule" only when nothing is unknown:
 * an UNREADABLE rule or group, and an ABSENT rule whose gate GATES does not
 * record, are each named instead (review of #1051), because "not a finding"
 * and "known to be fine" are different results.
 */
export function verdictLine(failing, unread, absent) {
  if (failing > 0) return `**${failing} finding(s).** Each is named in the State column or the paragraphs above.`;
  if (unread.rules + unread.groups + absent === 0) {
    return '**Every expected rule is live, enabled and wired to its action group.**';
  }
  const unknown = [];
  if (unread.rules + unread.groups > 0) {
    unknown.push(
      `${unread.rules} rule(s) and ${unread.groups} action group(s) are in a subscription it cannot read yet, ` +
        'recorded in `UNREADABLE`'
    );
  }
  if (absent > 0) {
    unknown.push(`${absent} rule(s) are absent behind a \`count\` gate \`GATES\` does not record, so whether they should exist is unknown`);
  }
  return `**Every rule this identity can read and judge is live, enabled and wired.** ${unknown.join('; ')}: their state is **unknown**, not healthy.`;
}

/** The job-summary report: one row per rule, one per action group, then the verdict. */
export function renderReport({ rules, verdicts, extra, groups, when, subscriptionsRead, stale = [] }) {
  const lines = ['## Alert rule state', ''];
  const where = new Set(rules.map((r) => `\`${r.resourceGroup}\` (${r.subscription})`));
  lines.push(
    `Read ${when}. ${rules.length} rules are declared in \`infra/\`, across ${[...where].join(' and ')}. ` +
      'The list is derived from the configuration on every run, so a rule added there is checked here from the commit that adds it.',
    ''
  );
  if (subscriptionsRead && subscriptionsRead.status !== 'ok') {
    lines.push(`**The subscription list could not be read** (${subscriptionsRead.reason}), so nothing below is known.`, '');
  } else if (subscriptionsRead?.namedOnly) {
    lines.push(
      `The subscription list could not be read (${subscriptionsRead.reason}). The subscriptions were taken from ` +
        '`ALERT_SUBSCRIPTION_IDS`, and each rule below is judged on its own read.',
      ''
    );
  }
  lines.push('| Rule | Resource group | State | Enabled | autoMitigate | Every | Window | Sev | Health | Detail |');
  lines.push('| --- | --- | --- | :---: | :---: | --- | --- | :---: | --- | --- |');
  for (const v of verdicts) {
    const l = v.live ?? {};
    const detail = tableCell([...v.problems, ...v.notes].join('; '));
    lines.push(
      `| \`${v.rule.name}\` | \`${v.rule.resourceGroup}\` | **${v.state}** | ${cell(l.enabled)} | ${cell(l.autoMitigate)} | ` +
        `${cell(l.evaluationFrequency)} | ${cell(l.windowSize)} | ${cell(l.severity)} | ${cell(v.health)} | ${detail || ''} |`
    );
  }
  lines.push('', '### Action groups', '', '| Action group | Resource group | State | Receivers | Detail |', '| --- | --- | --- | --- | --- |');
  for (const g of groups) {
    const receivers = g.read?.receivers?.map((r) => `${r.kind} \`${tableCell(r.name)}\` ${tableCell(r.status)}`).join(', ') ?? '—';
    lines.push(`| \`${g.group.name}\` | \`${g.group.resourceGroup}\` | **${g.state}** | ${receivers} | ${tableCell(g.problems.join('; '))} |`);
  }
  if (extra.length > 0) {
    lines.push('', '### Live rules no declaration names', '');
    lines.push('These page if they fire, and nothing in `infra/` manages them. Not a failure; delete or declare them.', '');
    for (const { rule } of extra) lines.push(`- \`${rule.name}\` (${rule.armType}, enabled ${rule.enabled})`);
  }
  lines.push(...summaryLines(verdicts, groups, stale));
  return `${lines.join('\n')}\n`;
}

/**
 * Whether a run with these verdicts fails. UNREADABLE and gated-off rules do
 * not; a stale UNREADABLE entry does, so it is deleted with the grant.
 */
export function runFails(verdicts, groups, subscriptionsRead, stale = []) {
  if (subscriptionsRead?.status !== 'ok') return true;
  if (stale.length > 0) return true;
  return verdicts.some((v) => FAILING.has(v.state)) || groups.some((g) => FAILING_GROUP.has(g.state));
}

/**
 * The `coverage` step output for automated consumers: `complete` when every
 * declared rule and action group was read, `partial` when any was not
 * (UNREADABLE, NOT AUTHORIZED or READ FAILED).
 * A green run with partial coverage is not the same result as a green run
 * with complete coverage, and a reader of the run's outcome alone cannot tell.
 */
export function coverageOf(verdicts, groups) {
  // Any rule or group not actually read is partial coverage, recorded or not
  // (review of #1051): a failing run that read half the estate must not say
  // `complete` to a consumer that reads only this output.
  const unread = (state) => NOT_READ.has(state);
  return verdicts.some((v) => unread(v.state)) || groups.some((g) => unread(g.state)) ? 'partial' : 'complete';
}

/**
 * GitHub Actions warning annotations, one per subscription recorded as
 * unreadable, so a green run still shows the gap on its summary page.
 */
export function unreadableWarnings(verdicts, groups, unreadable = UNREADABLE) {
  const bySubscription = new Map();
  for (const v of verdicts.filter((x) => x.state === 'UNREADABLE')) {
    bySubscription.set(v.rule.subscription, (bySubscription.get(v.rule.subscription) ?? 0) + 1);
  }
  for (const g of groups.filter((x) => x.state === 'UNREADABLE')) {
    if (!bySubscription.has(g.group.subscription)) bySubscription.set(g.group.subscription, 0);
  }
  return [...bySubscription].map(
    ([subscription, count]) =>
      `::warning title=Alert rules not readable::${count} declared rule(s) in ${subscription} were not read: ` +
      `${unreadable[subscription]?.record ?? 'not recorded'}. Their state is unknown.`
  );
}

/** The declared inventory as a table, for --list. */
export function renderInventory(rules, suffix) {
  const lines = ['| Rule | Kind | Resource group | Subscription | Gate | Action group |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of rules) {
    const gate = r.gate ? (r.gate.variable ? `var.${r.gate.variable}` : r.gate.expression) : '';
    lines.push(
      `| \`${shortName(r, suffix)}\` | ${r.kind} | \`${r.resourceGroup}\` | \`${r.subscription}\` | ${gate} | ` +
        `${r.actionGroups.map((g) => `\`${g.name}\``).join(', ')} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/verify-alert-state.mjs [--list] [--summary <file>]

  (no flags)        read the live rules through ARM (needs az login) and compare
  --list            print the rules infra/ declares and exit; no Azure call
  --summary <file>  also append the report to <file> (the job summary in CI)

exit 0  every expected rule is live, enabled and wired
exit 1  at least one finding, named in the report
exit 2  the check could not run`;

/** The command line: --list, --help, or the live comparison. Resolves to the exit code. */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { flags: ['list', 'help'], options: ['summary'] });
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (args.flags.help) {
    console.log(USAGE);
    return 0;
  }

  let rules;
  let suffix;
  try {
    const source = terraformSource();
    rules = declaredAlertRules(source);
    suffix = environmentSuffix(source);
  } catch (err) {
    console.error(`Could not read the declared alert rules from infra/: ${err.message}`);
    return 2;
  }

  if (args.flags.list) {
    process.stdout.write(renderInventory(rules, suffix));
    return 0;
  }

  let token;
  try {
    token = azAccessToken();
  } catch (err) {
    console.error(`No ARM token from az, so nothing was read: ${redact(String(err?.message ?? err)).slice(0, 300)}`);
    return 2;
  }

  let knownIds;
  try {
    knownIds = knownSubscriptionIds(process.env.ALERT_SUBSCRIPTION_IDS);
  } catch (err) {
    console.error(err.message);
    return 2;
  }

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
  if (args.options.summary) appendFileSync(args.options.summary, report);
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

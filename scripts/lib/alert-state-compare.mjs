/** Comparing the declared alert rules with what is live, rule by rule (verify-alert-state.mjs). */
import { expectation, GATES, pendingCreates, UNREADABLE } from './alert-state-expected.mjs';
import { listKey, uniqueActionGroups } from './alert-state-live.mjs';
import { healthVerdict } from './alert-state-health.mjs';

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
export const FAILING_GROUP = new Set(['BROKEN', 'NOT AUTHORIZED', 'READ FAILED']);

/** States meaning the rule or group, or a rule's health, was never read, whatever the reason. */
export const NOT_READ = new Set(['UNREADABLE', 'NOT AUTHORIZED', 'READ FAILED', 'HEALTH UNREADABLE']);

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

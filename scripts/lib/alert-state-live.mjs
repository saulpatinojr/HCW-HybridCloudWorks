/** Reading every live alert rule, action group and Resource Health state the declared rules need (verify-alert-state.mjs). */
import { API_VERSIONS } from './alert-state-expected.mjs';
import { armGet, normaliseRule } from './alert-state-arm.mjs';

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

  const read = { ids, token, fetchImpl };
  const lists = await readRuleLists(rules, read);
  const actionGroups = await readActionGroups(rules, read);
  const health = await readRulesHealth(rules, lists, read);
  return { subscriptionsRead, ids, lists, actionGroups, health };
}

/** Each (subscription, resource group, rule type) list the rules live in, with its rules by lower-case name. */
async function readRuleLists(rules, { ids, token, fetchImpl }) {
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
  return lists;
}

/** Each action group the rules name, summarised, by its Terraform address. */
async function readActionGroups(rules, { ids, token, fetchImpl }) {
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
  return actionGroups;
}

/**
 * Resource Health for every log search rule that is live (#964). A rule
 * the lists did not return has nothing to read; its verdict says so.
 */
async function readRulesHealth(rules, lists, { ids, token, fetchImpl }) {
  const health = new Map();
  for (const rule of rules) {
    if (rule.armType !== 'Microsoft.Insights/scheduledQueryRules') continue;
    const list = lists.get(listKey(rule.subscription, rule.resourceGroup, rule.armType));
    const found = list?.status === 'ok' ? list.rules.get(rule.name.toLowerCase()) : null;
    if (!found) continue;
    health.set(rule.address, await readHealth(ids.get(rule.subscription), rule.resourceGroup, found.name, { token, fetchImpl }));
  }
  return health;
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
/** The key one (subscription, resource group, rule type) list is held under; groups compare case-insensitively. */
export const listKey = (subscription, group, armType) => `${subscription}|${group.toLowerCase()}|${armType}`;

/** Every action group the rules name, once each. */
export function uniqueActionGroups(rules) {
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

/**
 * Every alert rule `infra/` declares, with the Azure name, resource group,
 * subscription and action group each one resolves to (PLAT-4, #964).
 *
 * WHY THIS IS DERIVED, NOT LISTED. verify-alert-state.yml checked three
 * hard-coded rule names from 2026-08-26 until PLAT-4, while the module grew to
 * fourteen: the reachability and export rules, the Telegram rule and the three
 * lab rules in another subscription were never read back at all. A list beside
 * the configuration drifts the day a rule is added; a list read OUT of the
 * configuration cannot. So the expected inventory is computed from the `.tf`
 * text on every run, and anything this cannot resolve is an error, because an
 * unresolvable rule would otherwise drop out of the inventory silently, which
 * is the failure this file exists to end.
 *
 * WHAT "RESOLVE" MEANS HERE, and no more:
 *
 *   - `name`: a quoted template whose interpolations are `var.<name>` with a
 *     string default in the module. That is how every rule is named.
 *   - `resource_group_name`: `azurerm_resource_group.<name>[...].name`, read
 *     through that group's own `name` with `each.key` bound, or a literal.
 *   - the subscription: the rule's `provider` alias, through that provider's
 *     `subscription_id = var.<x>` to the `(sub-…)` that variable's
 *     description ends with. The variables are sensitive, so the subscription
 *     ID is never in the configuration; its display name is, and the live
 *     check finds the ID from that.
 *   - the action groups: every `azurerm_monitor_action_group.<name>.id` named
 *     in the rule's `action` blocks, resolved the same way.
 *   - the gate: `count = var.<x> ? 1 : 0`. Any other `count` is reported as an
 *     unrecognised gate by its text rather than guessed at.
 *
 * A rule whose resource group is in one subscription while its provider points
 * at another is refused here: ARM would refuse it at apply with
 * ResourceGroupNotFound, which is how the action group's alias comment in
 * observability.tf came to be written.
 */
import { parseBody } from './hcl-blocks.mjs';
import { evaluateTemplate } from './alert-values.mjs';
import { actionGroupAddresses, booleanOf, gateOf, resolveActionGroup, resolveResourceGroup, subscriptionOf, subscriptionsByAlias, variableResolver } from './alert-targets.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { evaluateTemplate } from './alert-values.mjs';
export { gateOf } from './alert-targets.mjs';

/**
 * The alert resource types this verifier can read back, and how.
 *
 * `armType` is the provider path the live check lists; `autoMitigate` names the
 * Terraform attribute behind the live `properties.autoMitigate` and the
 * provider's default for it (azurerm 5.8 schema; Microsoft's REST default for
 * scheduled query rules is true, azurerm's is false, and azurerm's is the one
 * that applies to a rule declared without it). Activity Log alerts have no
 * auto-resolution.
 */
export const ALERT_TYPES = {
  azurerm_monitor_scheduled_query_rules_alert_v2: {
    kind: 'log',
    armType: 'Microsoft.Insights/scheduledQueryRules',
    autoMitigate: { attribute: 'auto_mitigation_enabled', default: false },
  },
  azurerm_monitor_metric_alert: {
    kind: 'metric',
    armType: 'Microsoft.Insights/metricAlerts',
    autoMitigate: { attribute: 'auto_mitigate', default: true },
  },
  azurerm_monitor_activity_log_alert: {
    kind: 'activity-log',
    armType: 'Microsoft.Insights/activityLogAlerts',
    autoMitigate: null,
  },
};

/**
 * A resource type that looks like an alert rule. Anything matching this and
 * absent from ALERT_TYPES stops the check: a smart detector or a legacy
 * scheduled query rule added later must be taught to the verifier, not left
 * out of its inventory. Alert processing rules are excluded because they are
 * not rules that fire; they route or suppress the ones that do.
 */
const LOOKS_LIKE_ALERT = /^azurerm_monitor_(?!alert_processing_rule_)\w*alert\w*$/;

/** The module's top-level blocks, grouped by kind. */
export function moduleBlocks(source) {
  const root = parseBody(source);
  if (root.attributes.size > 0) {
    throw new Error(`top-level attributes in the module: ${[...root.attributes.keys()].join(', ')}`);
  }
  const resources = new Map();
  const variables = new Map();
  const providers = [];
  for (const block of root.blocks) {
    if (block.type === 'resource') {
      const [type, name] = block.labels;
      resources.set(`${type}.${name}`, { type, name, ...parseBody(block.body) });
    } else if (block.type === 'variable') {
      variables.set(block.labels[0], parseBody(block.body));
    } else if (block.type === 'provider') {
      providers.push({ name: block.labels[0], ...parseBody(block.body) });
    }
  }
  return { resources, variables, providers };
}

/**
 * The declared alert rules, sorted by subscription, resource group and name.
 *
 * @param {string} source the module text, from terraformSource()
 */
export function declaredAlertRules(source) {
  const blocks = moduleBlocks(source);
  const context = { ...blocks, subscriptions: subscriptionsByAlias(blocks) };
  const rules = [];
  for (const [address, resource] of blocks.resources) {
    const spec = ALERT_TYPES[resource.type];
    if (!spec) {
      if (LOOKS_LIKE_ALERT.test(resource.type)) {
        throw new Error(
          `${address}: ${resource.type} is an alert rule type the verifier cannot read back. ` +
            'Add it to ALERT_TYPES in scripts/lib/alert-declarations.mjs and to the live read.'
        );
      }
      continue;
    }
    const name = evaluateTemplate(resource.attributes.get('name'), variableResolver(context.variables));
    const resourceGroup = resolveResourceGroup(resource.attributes.get('resource_group_name'), context);
    const subscription = subscriptionOf(resource, context.subscriptions);
    if (resourceGroup.subscription && resourceGroup.subscription !== subscription) {
      throw new Error(
        `${address}: its provider targets ${subscription} but its resource group is in ` +
          `${resourceGroup.subscription}; ARM would answer ResourceGroupNotFound`
      );
    }
    const actionGroups = [...new Set(actionGroupAddresses(resource))].map((a) => resolveActionGroup(a, context));
    rules.push({
      address,
      type: resource.type,
      kind: spec.kind,
      armType: spec.armType,
      name,
      resourceGroup: resourceGroup.name,
      subscription,
      gate: gateOf(resource.attributes),
      enabled: booleanOf(resource.attributes.get('enabled'), true),
      autoMitigate: spec.autoMitigate
        ? booleanOf(resource.attributes.get(spec.autoMitigate.attribute), spec.autoMitigate.default)
        : null,
      actionGroups,
    });
  }
  return rules.sort(
    (a, b) =>
      a.subscription.localeCompare(b.subscription) ||
      a.resourceGroup.localeCompare(b.resourceGroup) ||
      a.name.localeCompare(b.name)
  );
}

/**
 * The name an operator table uses for a rule: the Azure name without the
 * `-<environment>-<region>` suffix every rule carries (`alert-app-exceptions`
 * for `alert-app-exceptions-prod-cus`).
 */
export function shortName(rule, suffix) {
  return suffix && rule.name.endsWith(suffix) ? rule.name.slice(0, -suffix.length) : rule.name;
}

/** `-<environment>-<region_abbreviation>` from the module's variable defaults. */
export function environmentSuffix(source) {
  const { variables } = moduleBlocks(source);
  const resolve = variableResolver(variables);
  return `-${resolve('var.environment')}-${resolve('var.region_abbreviation')}`;
}

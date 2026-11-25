/** Which subscription, resource group, gate and action groups an alert rule names, worked out from infra/ (alert-declarations.mjs). */
import { evaluateTemplate, quoted } from './alert-values.mjs';

const ACTION_GROUP_TYPE = 'azurerm_monitor_action_group';
const RESOURCE_GROUP_TYPE = 'azurerm_resource_group';
/** `var.x` -> x's string default, or an error naming what was not resolvable. */
export function variableResolver(variables) {
  return (reference) => {
    const m = /^var\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
    if (!m) throw new Error(`cannot resolve \${${reference}}: only var.<name> is read`);
    const variable = variables.get(m[1]);
    if (!variable) throw new Error(`var.${m[1]} is not declared`);
    const value = quoted(variable.attributes.get('default'));
    if (value === null) throw new Error(`var.${m[1]} has no string default`);
    return value;
  };
}

/** provider alias ('' for the default) -> the `sub-…` display name it targets. */
export function subscriptionsByAlias({ providers, variables }) {
  const out = new Map();
  for (const provider of providers.filter((p) => p.name === 'azurerm')) {
    const alias = quoted(provider.attributes.get('alias')) ?? '';
    const ref = /^var\.([A-Za-z_]\w*)$/.exec(provider.attributes.get('subscription_id') ?? '');
    if (!ref) throw new Error(`provider azurerm${alias ? `.${alias}` : ''} has no var.<x> subscription_id`);
    const description = quoted(variables.get(ref[1])?.attributes.get('description')) ?? '';
    const named = /\((sub-[a-z0-9-]+)\)\s*$/.exec(description);
    if (!named) {
      throw new Error(`var.${ref[1]}'s description does not end with the subscription's (sub-…) name`);
    }
    out.set(alias, named[1]);
  }
  return out;
}

/** The subscription a resource's `provider` attribute sends it to. */
export function subscriptionOf(resource, subscriptions) {
  const expr = resource.attributes.get('provider');
  const alias = expr ? /^azurerm\.([A-Za-z_]\w*)$/.exec(expr)?.[1] : '';
  if (alias === undefined) throw new Error(`${resource.type}.${resource.name}: unreadable provider ${expr}`);
  const subscription = subscriptions.get(alias);
  if (!subscription) throw new Error(`${resource.type}.${resource.name}: no azurerm provider aliased '${alias}'`);
  return subscription;
}

/** A resource group reference, or literal, -> { name, subscription }. */
export function resolveResourceGroup(expr, context) {
  const literal = quoted(expr);
  if (literal !== null && !literal.includes('${')) return { name: literal, subscription: null };
  const m = /^azurerm_resource_group\.([A-Za-z_][\w-]*)(?:\["([^"]+)"\])?\.name$/.exec(expr ?? '');
  if (!m) throw new Error(`cannot resolve resource_group_name = ${expr}`);
  const group = context.resources.get(`${RESOURCE_GROUP_TYPE}.${m[1]}`);
  if (!group) throw new Error(`${RESOURCE_GROUP_TYPE}.${m[1]} is not declared`);
  const vars = variableResolver(context.variables);
  const name = evaluateTemplate(group.attributes.get('name'), (reference) => {
    if (reference === 'each.key') {
      if (m[2] === undefined) throw new Error(`${RESOURCE_GROUP_TYPE}.${m[1]} uses each.key; index it`);
      return m[2];
    }
    return vars(reference);
  });
  return { name, subscription: subscriptionOf(group, context.subscriptions) };
}

/** `count = var.x ? 1 : 0` -> 'x'; no count -> null; anything else -> its text. */
export function gateOf(attributes) {
  const count = attributes.get('count');
  if (count === undefined) return null;
  const m = /^var\.([A-Za-z_]\w*)\s*\?\s*1\s*:\s*0$/.exec(count);
  return m ? { variable: m[1] } : { expression: count };
}

/** `true` / `false` literal -> boolean; absent -> the default; else null (unknown). */
export function booleanOf(expr, fallback) {
  if (expr === undefined) return fallback;
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  return null;
}

/** Every action group address named in a rule's `action` blocks. */
export function actionGroupAddresses(resource) {
  const pattern = new RegExp(`\\b${ACTION_GROUP_TYPE}\\.([A-Za-z_][\\w-]*)\\.id\\b`, 'g');
  return resource.blocks
    .filter((block) => block.type === 'action')
    .flatMap((block) => [...block.body.matchAll(pattern)].map((m) => `${ACTION_GROUP_TYPE}.${m[1]}`));
}

/** An action group address -> { address, name, resourceGroup, subscription }. */
export function resolveActionGroup(address, context) {
  const group = context.resources.get(address);
  if (!group) throw new Error(`${address} is not declared`);
  const name = evaluateTemplate(group.attributes.get('name'), variableResolver(context.variables));
  const resourceGroup = resolveResourceGroup(group.attributes.get('resource_group_name'), context);
  const subscription = subscriptionOf(group, context.subscriptions);
  if (resourceGroup.subscription && resourceGroup.subscription !== subscription) {
    throw new Error(`${address}: its provider targets ${subscription}, its resource group ${resourceGroup.subscription}`);
  }
  return { address, name, resourceGroup: resourceGroup.name, subscription };
}

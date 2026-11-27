/**
 * cloudflare/rule-shape.js — small helpers the rule guards share for
 * comparing one rule with another (#1931, #1933). Nothing here refuses or
 * logs anything.
 */

/** Whether a rule is switched on: Cloudflare reads a rule with no `enabled` as on. */
export const isOn = (rule) => rule?.enabled === undefined || rule?.enabled === true;

/** Whether a value is an object that is not a list. */
export const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A value as text with every object's keys in order, so two equal rules give the same text whatever order their fields came in. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * What a rule does, as text: what it matches, whether it is on, its action
 * and its parameters. Its id, description and Cloudflare's stamps do not
 * count, so a rule sent back with only those changed does the same thing.
 */
export const behaviourOf = (rule) =>
  canonical({ expression: rule?.expression ?? null, on: isOn(rule), action: rule?.action ?? null, parameters: rule?.action_parameters ?? null });

/** The rules of a phase's current rule set, by id (rules without an id are left out). */
export function rulesById(current) {
  const rules = Array.isArray(current?.rules) ? current.rules : [];
  return new Map(rules.filter((rule) => typeof rule?.id === 'string' && rule.id).map((rule) => [rule.id, rule]));
}

/** Whether a rule sent comes back doing exactly what the phase's rule of the same id does now. */
export function unchangedFrom(held, rule) {
  const was = typeof rule?.id === 'string' ? held.get(rule.id) : undefined;
  return Boolean(was) && behaviourOf(was) === behaviourOf(rule);
}

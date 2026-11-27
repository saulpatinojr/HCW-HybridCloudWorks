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
 * The rule fields that do not change what a rule does: its id (compared on
 * its own), its description, and the fields Cloudflare sets itself and
 * marks read-only, `version`, `last_updated` and `categories`
 * (https://developers.cloudflare.com/ruleset-engine/rulesets-api/json-object/,
 * read 2026-11-27).
 */
export const NOT_BEHAVIOUR = Object.freeze(['id', 'description', 'version', 'last_updated', 'categories']);

/**
 * What a rule does, as text: every field of the rule except NOT_BEHAVIOUR
 * (#1936 review), with `enabled` read as Cloudflare reads it (no `enabled`
 * is on). So a rule sent back with a changed `ref`, `logging`, `ratelimit`
 * or any other field does something else, and one sent back with only its
 * description or Cloudflare's own fields changed does the same thing.
 */
export function behaviourOf(rule) {
  const fields = rule && typeof rule === 'object' && !Array.isArray(rule) ? Object.entries(rule) : [];
  const kept = Object.fromEntries(fields.filter(([key]) => !NOT_BEHAVIOUR.includes(key)));
  return canonical({ ...kept, enabled: isOn(rule) });
}

/** The rules of a phase's current rule set, by id (rules without an id are left out). */
export function rulesById(current) {
  const rules = Array.isArray(current?.rules) ? current.rules : [];
  return new Map(rules.filter((rule) => typeof rule?.id === 'string' && rule.id).map((rule) => [rule.id, rule]));
}

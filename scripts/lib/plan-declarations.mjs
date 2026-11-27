/**
 * How a `DECLARED` entry in assert-expected-plan.mjs matches a plan, and how
 * it is printed.
 *
 * The policy (which changes are expected, which are declared) stays in
 * assert-expected-plan.mjs; this is the mechanics, split out alongside
 * plan-actions, plan-diff and plan-report when #816 added declarations by
 * action.
 *
 * Two shapes:
 *   `{ address, path, before, after, reason }`  one attribute of an update,
 *                                               with exactly those values (#719)
 *   `{ address, action, reason }`               a create, a delete or an
 *                                               import, by exact address,
 *                                               for_each key included (#816,
 *                                               #1923); there are no values
 *
 * An import is declared on its own, apart from whatever the same resource
 * change does: an import that also updates the resource needs the import
 * declared AND each attribute it changes, just as any other update does. The
 * import's id is never part of a declaration or the report, because it holds
 * the owner's identifiers.
 *
 * Two kinds of value cannot be written in this public file, so an update's
 * `after` may name one of them instead of a value (#1923):
 *   `KNOWN_AFTER_APPLY`  a value the provider works out during the apply.
 *                        It matches only a difference the plan marks unknown
 *                        and not sensitive, and `before` is not compared: it
 *                        is the provider's own value, read from the far end.
 *   `OWNER_VALUE`        a value the owner sets in the workspace. It matches
 *                        only a known, non-sensitive, non-empty string that
 *                        differs from `before`, and `before` is compared
 *                        exactly, as for any update.
 * Neither prints a value: the report names the stand-in, not what it stands
 * for. A sensitive difference still never matches anything.
 */
import { isDeepStrictEqual } from 'node:util';

import { render } from './plan-report.mjs';

/** One `DECLARED` entry, for the report. */
export function describeDeclaration({ address, action, path, before, after, reason }) {
  const change = action ? action : `${path}: ${describeValues(before, after)}`;
  return `${address} ${change}${reason ? ` (${reason})` : ''}`;
}

/** A provider-computed value, which the plan shows as unknown (#1923). */
export const KNOWN_AFTER_APPLY = Symbol('known after apply');

/** A value the owner sets in the workspace and this file never holds (#1923). */
export const OWNER_VALUE = Symbol('owner value');

/** The two values of an update declaration, as the report prints them. */
function describeValues(before, after) {
  if (after === KNOWN_AFTER_APPLY) return '(known after apply)';
  const right = after === OWNER_VALUE ? "(the owner's value, not printed)" : render(after);
  return `${render(before)} -> ${right}`;
}

/**
 * The report lines about declarations, shared by both entry points. DECLARED
 * names what the plan matched; NOTE names what it did not. Neither fails the
 * check: a declaration the plan lacks has usually applied already.
 */
export function declarationLines({ declared = [], unused = [] }) {
  return [
    ...declared.map((d) => `DECLARED    ${describeDeclaration(d)}`),
    ...unused.map(
      (d) =>
        `NOTE        declared, not in this plan: ${describeDeclaration(d)}. Once it has ` +
        'applied, delete it from DECLARED in scripts/assert-expected-plan.mjs.'
    ),
  ];
}

/** A declared value: exactly these values, and both known. */
function matchesValues(declaration, difference) {
  if (difference.unknown) return false;
  const sameBefore = isDeepStrictEqual(declaration.before, difference.before);
  return sameBefore && isDeepStrictEqual(declaration.after, difference.after);
}

/** `KNOWN_AFTER_APPLY`: unknown in the plan, whatever the provider held before. */
function matchesComputed(_declaration, difference) {
  return difference.unknown === true;
}

/** `OWNER_VALUE`: from exactly `before` to some other, non-empty string. */
function matchesOwnerValue(declaration, difference) {
  const { before, after, unknown } = difference;
  if (unknown || !isDeepStrictEqual(declaration.before, before)) return false;
  return typeof after === 'string' && after !== '' && after !== before;
}

const MATCHERS = new Map([
  [KNOWN_AFTER_APPLY, matchesComputed],
  [OWNER_VALUE, matchesOwnerValue],
]);

/**
 * Whether one declaration covers one difference in an update. A sensitive
 * difference never matches, and an unknown one matches only
 * `KNOWN_AFTER_APPLY`: declaring either value would mean writing it in a
 * public file.
 */
export function matchesDeclaration(declaration, address, difference) {
  if (difference.sensitive) return false;
  if (declaration?.address !== address || declaration.path !== difference.path) return false;
  const matches = MATCHERS.get(declaration.after) ?? matchesValues;
  return matches(declaration, difference);
}

/** The actions a `{ address, action, reason }` declaration may name. */
export const DECLARABLE_ACTIONS = Object.freeze(['create', 'delete', 'import']);

/** The declaration for a create, delete or import at exactly this address, if any. */
export function findDeclaredAction(declared, address, action) {
  if (!DECLARABLE_ACTIONS.includes(action)) return undefined;
  return declared.find((d) => d.action === action && d.address === address);
}

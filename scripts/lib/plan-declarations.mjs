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
 *
 * Either shape may also carry `step`, a short name shared by every
 * declaration of one run's change (#1929). Declarations of one step stand or
 * fall together: see `incompleteSteps` below.
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

/**
 * Whether a matched declaration shows that its step is in the plan. A
 * computed value (`KNOWN_AFTER_APPLY`) does not: it matches any unknown value
 * at its path, such as the `modified_on` that every change to a record
 * leaves unknown, so it says nothing about which change the plan holds. Only
 * a declared value, or a declared create, delete or import, does.
 */
const opensStep = (declaration) => declaration.after !== KNOWN_AFTER_APPLY;

/**
 * Whether a declaration covers its difference only while its step is in the
 * plan: a computed value that belongs to a step (#1929). Such an entry
 * matches any unknown value at its path, so on its own it would wave through
 * a lone unknown `modified_on`. A computed value without a step covers its
 * difference whatever else the plan holds, as before steps existed.
 */
export const coversOnlyInItsStep = (declaration) =>
  Boolean(declaration.step) && declaration.after === KNOWN_AFTER_APPLY;

/** The steps this plan holds: those with at least one matched declaration that opens a step. */
export function presentSteps(declared, matched) {
  return new Set(declared.filter((d) => d.step && matched.has(d) && opensStep(d)).map((d) => d.step));
}

/**
 * Declarations that name the same `step` stand or fall together (#1929). A
 * step is one run's whole change, such as proxying www, which moves proxied
 * and ttl together. A step is in the plan when one of its declared values
 * (not a computed one) matched. A plan that holds a step but not all of its
 * changes is not that step, so each declaration of it the plan lacks is
 * returned, to be named as unexpected. A step that is not in the plan is
 * not returned: it has usually applied, or is the other direction of a
 * switch, and each of its declarations prints as a NOTE like any other.
 *
 * @param {object[]} declared every declaration
 * @param {Set<object>} matched the declarations that covered a difference in this plan
 * @returns {object[]} the declarations of steps in the plan that it lacks
 */
export function incompleteSteps(declared, matched) {
  const present = presentSteps(declared, matched);
  return declared.filter((d) => d.step && present.has(d.step) && !matched.has(d));
}

/**
 * The declarations this plan is credited with, for the DECLARED lines. A
 * computed declaration of a step that is not in the plan covered its
 * difference but is not credited: with a forward and a going-back step on
 * the same record, both steps' `modified_on` cover the one unknown value,
 * and only the step the plan holds is reported.
 */
export function creditedDeclarations(declared, matched) {
  const present = presentSteps(declared, matched);
  return declared.filter((d) => matched.has(d) && (!d.step || present.has(d.step)));
}

/**
 * Whether one difference in an update is covered, crediting in `matched`
 * every declaration that covers it, not only the first (#1929): a forward
 * and a going-back step on one record both cover its unknown modified_on,
 * and which of them the plan holds is settled by their declared values in
 * `settleSteps`. A difference covered only by computed values of steps is
 * held in `pending` with its report `line` until then, and counts as
 * covered here. Returns false for a difference no declaration covers,
 * which the caller names.
 */
export function coverDifference({ declared, matched, pending }, address, difference, line) {
  const covering = declared.filter((d) => matchesDeclaration(d, address, difference));
  for (const declaration of covering) matched.add(declaration);
  if (covering.length > 0 && covering.every(coversOnlyInItsStep)) pending.push({ line, covering });
  return covering.length > 0;
}

/**
 * What the steps add to a plan's report, once every change has been read
 * (#1929). A step is in the plan only when one of its declared values
 * matched; a computed value alone (modified_on) never opens one.
 *   `unexpected`  each held difference none of whose steps is in the plan
 *                 (named as it would be with nothing declared), then each
 *                 declaration a step in the plan lacks;
 *   `credited`    the declarations the plan is credited with;
 *   `unused`      the rest, which print as NOTEs.
 */
export function settleSteps(declared, matched, pending) {
  const present = presentSteps(declared, matched);
  const held = pending.filter(({ covering }) => !covering.some((d) => present.has(d.step)));
  const incomplete = incompleteSteps(declared, matched);
  const credited = creditedDeclarations(declared, matched);
  return {
    unexpected: [...held.map(({ line }) => line), ...incomplete.map(describeIncomplete)],
    credited,
    unused: declared.filter((d) => !credited.includes(d) && !incomplete.includes(d)),
  };
}

/** How a declaration missing from a step the plan holds is named. */
export function describeIncomplete(declaration) {
  return (
    `${describeDeclaration(declaration)}: not in this plan, although other changes of ` +
    `step "${declaration.step}" are. A step's declarations apply together.`
  );
}

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
 */
import { isDeepStrictEqual } from 'node:util';

import { render } from './plan-report.mjs';

/** One `DECLARED` entry, for the report. */
export function describeDeclaration({ address, action, path, before, after, reason }) {
  const change = action ? action : `${path}: ${render(before)} -> ${render(after)}`;
  return `${address} ${change}${reason ? ` (${reason})` : ''}`;
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

/**
 * Whether one declaration covers one difference in an update. A sensitive or
 * unknown difference never matches: declaring it would mean writing its value
 * in a public file.
 */
export function matchesDeclaration(declaration, address, difference) {
  if (difference.sensitive || difference.unknown) return false;
  if (declaration?.address !== address || declaration.path !== difference.path) return false;
  const sameBefore = isDeepStrictEqual(declaration.before, difference.before);
  return sameBefore && isDeepStrictEqual(declaration.after, difference.after);
}

/** The actions a `{ address, action, reason }` declaration may name. */
export const DECLARABLE_ACTIONS = Object.freeze(['create', 'delete', 'import']);

/** The declaration for a create, delete or import at exactly this address, if any. */
export function findDeclaredAction(declared, address, action) {
  if (!DECLARABLE_ACTIONS.includes(action)) return undefined;
  return declared.find((d) => d.action === action && d.address === address);
}

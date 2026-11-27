/**
 * What one `terraform show -json` resource change does, read from its action
 * list and the fields beside it (#719). Pure; no I/O.
 * scripts/assert-expected-plan.mjs re-exports all of it.
 */

import { isDeepStrictEqual } from 'node:util';

/** The side-effect note an import gets, which a declaration can match (#1923). */
export const IMPORT_NOTE = 'import';

/** The action lists that mean nothing happens to the resource. */
const QUIET_ACTIONS = [['no-op'], ['read']];

/** Terraform's action lists, normalised to a single word. */
export function classify(actions = []) {
  const set = new Set(actions);
  if (set.has('create') && set.has('delete')) return 'replace';
  if (set.has('create')) return 'create';
  if (set.has('delete')) return 'delete';
  if (set.has('update')) return 'update';
  return 'no-op';
}

/**
 * One resource change's action list. A missing list means the plan is not
 * the shape this reads (exit 2), not that nothing happens.
 */
export function actionsOf(change) {
  const actions = change?.change?.actions;
  if (!Array.isArray(actions)) {
    throw new Error(`${change?.address ?? 'a resource change'} has no change.actions list`);
  }
  return actions;
}

/**
 * What a change does that its action word does not say. `classify` reads
 * anything it does not recognise as a no-op, so `["forget"]` (a `removed`
 * block) used to pass silently. So did an import or a move, which a no-op
 * action does not rule out.
 */
export function sideEffects(change, actions) {
  const notes = [];
  const recognised =
    classify(actions) !== 'no-op' || QUIET_ACTIONS.some((quiet) => isDeepStrictEqual(quiet, actions));
  if (!recognised) notes.push(`actions ${JSON.stringify(actions)}, which this checker does not recognise`);
  if (change.change.importing) notes.push(IMPORT_NOTE);
  if (change.previous_address) notes.push(`moved from ${change.previous_address}`);
  return notes;
}

/**
 * archive-classification-reasons.js — the three decisions and the reasons
 * the yearly archive's rules use (archive-classification.js). Kept in a file
 * of their own so the rule files beside it can all use them without loading
 * each other.
 */

/** @typedef {'archive'|'archive-changed'|'leave-out'} ArchiveDecision */

export const DECISIONS = Object.freeze({
  archive: 'archive',
  changed: 'archive-changed',
  leaveOut: 'leave-out',
});

/**
 * Why a container, or one record, is left out. The words are the ones the
 * report and the manifest print; none of them names a record.
 */
export const REASONS = Object.freeze({
  promise: 'promise', // someone was told it would be deleted, or agreed to less than keeping it for good
  secret: 'secret', // a password, token, key or a hash of one
  accessList: 'access-list', // who may sign in; not content
  derived: 'derived', // a job, a publish or a script in Git rebuilds it
  workingState: 'working-state', // jobs, counters, leases, caches: nothing later
  unclassified: 'unclassified', // the owner has not said yet (ADR 0046, "owner to say"), or this file does not name the container at all
  unlisted: 'unlisted', // an admin_config or admin_settings document id, or a kind of record, this file does not name
  orphan: 'orphan', // a version whose content item is not in the backup
});

/** A sorted, frozen copy of a list. */
export const freeze = (list) => Object.freeze([...list].sort());

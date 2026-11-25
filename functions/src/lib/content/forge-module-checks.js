/**
 * forge-module-checks.js — the semantic checks the forge's module repair
 * (forge-module-repair.js) runs on a JSON module's payload. Nothing here
 * does I/O.
 */
import { MAX_STAT_BOARD_STATS } from '../cms/content-modules.js';
import { listOf, trimmed } from './forge-module-unwrap.js';

/**
 * Why validateModules would reject a JSON module's parsed payload, by type:
 * the words to add to the repair note, or null when the payload is
 * semantically sound. Mirrors the per-type checks in content-modules.js
 * validateModules — keep the two in lockstep.
 */
const SEMANTIC_ISSUES = {
  pull_quote: (parsed) => (trimmed(parsed.text) ? null : 'with no text'),
  stat_board(parsed) {
    const stats = listOf(parsed.stats);
    if (stats.length < 2 || stats.length > MAX_STAT_BOARD_STATS) {
      return `with ${stats.length} stats (needs 2-${MAX_STAT_BOARD_STATS})`;
    }
    const incomplete = stats.some((stat) => !String(stat?.value ?? '').trim() || !trimmed(stat?.label));
    return incomplete ? 'with a stat missing value or label' : null;
  },
  comparison(parsed) {
    const columns = listOf(parsed.columns);
    const rows = listOf(parsed.rows);
    if (columns.length < 2 || !rows.length) return 'without at least 2 columns and 1 row';
    const mismatched = rows.some((row) => !Array.isArray(row) || row.length !== columns.length);
    return mismatched ? 'with a row that does not match its columns' : null;
  },
  timeline(parsed) {
    const steps = listOf(parsed.steps);
    if (steps.length < 2) return 'with fewer than 2 steps';
    return steps.some((step) => !trimmed(step?.title)) ? 'with an untitled step' : null;
  },
  callout: (parsed) => (!trimmed(parsed.title) || !trimmed(parsed.body) ? 'missing title or body' : null),
};

export function jsonModuleSemanticIssue(type, parsed) {
  return Object.hasOwn(SEMANTIC_ISSUES, type) ? SEMANTIC_ISSUES[type](parsed) : null;
}

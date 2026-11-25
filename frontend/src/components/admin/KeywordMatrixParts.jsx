import React from 'react';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';

// Pieces of KeywordMatrixPanel: the live tester, the two tables' shared
// frame and row buttons, and the plain helpers behind them.

function matchesAny(patterns, text) {
  return patterns.some((p) => p && text.includes(p.toLowerCase()));
}

/**
 * What the matrix would do to `testInput`: the canonical tags it collapses
 * to (each once) and the augmentations whose keywords appear in it.
 */
export function testKeywordMatrix(testInput, synonyms, augmentations) {
  const text = testInput.toLowerCase();
  if (!text) return { canonical: [], augmentations: [] };
  const matchedCanonical = synonyms
    .filter((s) => matchesAny(s.patterns, text))
    .map((s) => s.canonical);
  return {
    canonical: Array.from(new Set(matchedCanonical)),
    augmentations: augmentations.filter((a) => matchesAny(a.patterns, text)),
  };
}

/** The modal's title and the toast's name for a pending delete, so both say the same thing. */
export function deleteCopy(pending) {
  return pending.kind === 'synonym'
    ? { title: `Delete synonym group "${pending.item.canonical}"?`, name: pending.item.canonical }
    : { title: `Delete augmentation "${pending.item.label}"?`, name: pending.item.label };
}

export function LiveTester({ testInput, setTestInput, testResult }) {
  return (
    <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50">
      <p className="text-sm font-semibold mb-2">Live test</p>
      <textarea
        value={testInput}
        onChange={(e) => setTestInput(e.target.value)}
        placeholder="Paste an article title, summary, or comma-separated tags here to see what the matrix would do."
        className="w-full h-20 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
      />
      {testInput && (
        <div className="mt-3 space-y-2 text-xs">
          <div>
            <span className="font-mono text-slate-500">canonical →</span>{' '}
            {testResult.canonical.length > 0 ? (
              testResult.canonical.map((c) => (
                <span
                  key={c}
                  className="inline-block px-2 py-0.5 mr-1 rounded-full bg-slate-200 dark:bg-slate-700"
                >
                  {c}
                </span>
              ))
            ) : (
              <span className="text-slate-400">(none)</span>
            )}
          </div>
          <div>
            <span className="font-mono text-slate-500">augmentations →</span>
            {testResult.augmentations.length > 0 ? (
              <ul className="mt-1 space-y-1 ml-4 list-disc">
                {testResult.augmentations.map((a) => (
                  <li key={a.id}>
                    <span className="font-semibold">{a.label}:</span> {a.directive}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-slate-400"> (none)</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A matrix table: its header cells, a note when it is empty, and its rows. */
export function MatrixTable({ headers, colSpan, emptyText, isEmpty, children }) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 dark:bg-slate-800/60 text-xs uppercase">
          <tr>{headers}</tr>
        </thead>
        <tbody>
          {isEmpty && (
            <tr>
              <td colSpan={colSpan} className="p-3 text-center text-slate-500">
                {emptyText}
              </td>
            </tr>
          )}
          {children}
        </tbody>
      </table>
    </div>
  );
}

/** A table row's Edit and Delete buttons. */
export function RowActions({ onEdit, onDelete, deleteLabel, className }) {
  return (
    <td className={className}>
      <Button size="sm" variant="outline" onClick={onEdit}>
        Edit
      </Button>
      <Button
        size="sm"
        variant="destructive"
        onClick={onDelete}
        className="px-2"
        aria-label={deleteLabel}
      >
        <Trash2 className="h-3 w-3" aria-hidden="true" />
      </Button>
    </td>
  );
}

export const ROW_CLASS =
  'border-t border-slate-200 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/30';

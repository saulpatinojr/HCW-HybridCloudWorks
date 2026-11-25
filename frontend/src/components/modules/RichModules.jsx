import React from 'react';
import { X, Workflow } from 'lucide-react';
import StatBlock from '../shared/StatBlock';
import Eyebrow from '../shared/Eyebrow';
import { getModuleLayoutClass } from './moduleLayout';

// The Phase 4 rich article modules (pull quote, stat board, comparison,
// timeline, callout) and the diagram module. InlineModules.jsx re-exports
// them and renders them through ModuleContainer.

/** Editor-only edit/delete affordance shared by the rich modules below. */
function ModuleActions({ onEdit = null, onDelete = null, className = '' }) {
  if (!onEdit && !onDelete) return null;
  return (
    <div className={`flex gap-1 ${className}`}>
      {onEdit && (
        <button
          type="button"
          aria-label="Edit module"
          onClick={onEdit}
          className="text-xs text-slate-400 hover:text-primary p-1"
        >
          ✎
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          aria-label="Delete module"
          onClick={onDelete}
          className="text-xs text-slate-400 hover:text-red-400 p-1"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * PullQuoteModule - Editorial pull quote in the Bookerly serif with a
 * provider-accent rule. Light/dark aware, unlike the legacy dark-only frames.
 */
export function PullQuoteModule({
  text,
  attribution = '',
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
}) {
  return (
    <div className="my-6 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align, paired)}>
        <figure className="relative pl-5">
          <span
            aria-hidden="true"
            className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-gradient-to-b from-primary to-transparent"
          />
          <ModuleActions onEdit={onEdit} onDelete={onDelete} className="absolute right-0 top-0" />
          <blockquote
            className="text-xl md:text-2xl leading-snug text-slate-900 dark:text-white"
            style={{ fontFamily: 'var(--font-bookerly)' }}
          >
            {'“'}
            {text}
            {'”'}
          </blockquote>
          {attribution && (
            <figcaption className="eyebrow-label mt-3 text-slate-600 dark:text-slate-400">
              {attribution}
            </figcaption>
          )}
        </figure>
      </div>
    </div>
  );
}

/**
 * StatBoardModule - Row of StatBlock glass tiles (2-4). Always full width.
 */
export function StatBoardModule({ stats = [], onEdit = null, onDelete = null }) {
  const statList = (Array.isArray(stats) ? stats : []).filter(Boolean);
  const gridCols = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' };
  return (
    <div className="my-6 w-full transition-all duration-200">
      <ModuleActions onEdit={onEdit} onDelete={onDelete} className="justify-end" />
      <div className={`grid grid-cols-1 gap-3 ${gridCols[statList.length] || 'sm:grid-cols-2'}`}>
        {statList.map((stat, i) => (
          <StatBlock
            key={i}
            value={stat.value}
            label={stat.sublabel ? `${stat.label} · ${stat.sublabel}` : stat.label}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * ComparisonModule - Glass-framed comparison table. Always full width.
 */
export function ComparisonModule({ columns = [], rows = [], onEdit = null, onDelete = null }) {
  const columnList = Array.isArray(columns) ? columns : [];
  const rowList = Array.isArray(rows) ? rows : [];
  return (
    <div className="my-6 w-full transition-all duration-200">
      <ModuleActions onEdit={onEdit} onDelete={onDelete} className="justify-end" />
      <div className="glass rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-white/10">
              {columnList.map((column, i) => (
                <th
                  key={i}
                  className="eyebrow-label px-4 py-3 text-left text-slate-600 dark:text-slate-400"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowList.map((row, rIdx) => (
              <tr
                key={rIdx}
                className="border-b border-slate-100 last:border-0 dark:border-white/5"
              >
                {(Array.isArray(row) ? row : []).map((cell, cIdx) => (
                  <td
                    key={cIdx}
                    className={`px-4 py-3 align-top ${
                      cIdx === 0
                        ? 'font-medium text-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * TimelineModule - Vertical step list with NumberedSection-style zero-padded
 * markers. Always full width.
 */
export function TimelineModule({ steps = [], onEdit = null, onDelete = null }) {
  const stepList = (Array.isArray(steps) ? steps : []).filter(Boolean);
  return (
    <div className="my-6 w-full transition-all duration-200">
      <ModuleActions onEdit={onEdit} onDelete={onDelete} className="justify-end" />
      <ol className="space-y-0">
        {stepList.map((step, i) => (
          <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
            {i < stepList.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute left-[1.05rem] top-8 bottom-0 w-px bg-slate-200 dark:bg-white/10"
              />
            )}
            <span className="section-number shrink-0 text-2xl text-primary dark:text-(--slate-blue)">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="font-medium text-slate-900 dark:text-white">{step.title}</p>
              {step.body && (
                <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {step.body}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * CalloutModule - Eyebrow-labelled glass frame for asides worth a border.
 */
export function CalloutModule({
  eyebrow = '',
  title,
  body,
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
}) {
  return (
    <div className="my-6 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align, paired)}>
        <div className="glass relative rounded-xl border-l-4 border-l-primary p-5">
          <ModuleActions onEdit={onEdit} onDelete={onDelete} className="absolute right-2 top-2" />
          <Eyebrow>{eyebrow || 'Note'}</Eyebrow>
          <p className="mt-2 font-medium text-slate-900 dark:text-white">{title}</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{body}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * DesignModule - Mermaid diagram source. Renders the source in a labelled
 * mono frame; client-side mermaid rendering is backlog. This exists so a
 * design module renders *something* instead of null (the old behavior
 * silently destroyed the diagram on round-trip).
 */
export function DesignModule({ content, onEdit = null, onDelete = null }) {
  return (
    <div className="my-6 w-full transition-all duration-200">
      <div className="glass relative rounded-xl p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Workflow className="h-4 w-4 text-primary" />
            <span className="eyebrow-label text-slate-600 dark:text-slate-400">
              Diagram (Mermaid)
            </span>
          </div>
          <ModuleActions onEdit={onEdit} onDelete={onDelete} />
        </div>
        <pre className="overflow-x-auto rounded-md bg-slate-100 p-3 text-xs leading-relaxed text-slate-800 dark:bg-black/30 dark:text-slate-200">
          <code>{content || ''}</code>
        </pre>
      </div>
    </div>
  );
}

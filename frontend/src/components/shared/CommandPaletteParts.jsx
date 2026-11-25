import React from 'react';
import { cn } from '@/lib/utils';

// The result list and the footer of the search palette (CommandPalette.jsx).

/** The matching results, or a hint when nothing matches. */
export function PaletteResults({ items, activeIndex, onSelect, onHover }) {
  if (items.length === 0) {
    return (
      <div className="py-12 text-center" data-testid="command-palette-empty">
        <span className="material-symbols-outlined text-3xl text-slate-400 mb-2" aria-hidden="true">
          find_in_page
        </span>
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          No matching results found
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Try searching for “FOCUS 1.4”, “Landing Zone”, “Azure”, “Terraform”, or “Labs”.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1 py-1" role="presentation">
      {items.map((item, index) => {
        const isActive = index === activeIndex;
        return (
          <li
            key={item.id}
            id={`result-option-${index}`}
            data-index={index}
            role="option"
            tabIndex={-1}
            aria-selected={isActive}
            onClick={() => onSelect(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(item);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              'flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all border',
              isActive
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white border-slate-300 dark:border-slate-700 shadow-sm'
                : 'border-transparent text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'
            )}
          >
            <div className="flex items-center gap-3 min-w-0 pr-3">
              <div
                className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border transition-colors',
                  isActive
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500'
                )}
                aria-hidden="true"
              >
                <span className="material-symbols-outlined text-lg">{item.icon}</span>
              </div>
              <div className="min-w-0 flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold truncate">{item.title}</span>
                  <span className="text-xs font-mono uppercase px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300/40 dark:border-slate-700/60 shrink-0">
                    {item.category}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {item.subtitle}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {item.badge && (
                <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  {item.badge}
                </span>
              )}
              <span
                className="material-symbols-outlined text-slate-400 text-base"
                aria-hidden="true"
              >
                chevron_right
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Keyboard hints and the number of results. */
export function PaletteFooter({ count }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 font-mono">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700">
            ↑
          </kbd>
          <kbd className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700">
            ↓
          </kbd>
          Navigate
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700">
            ↵
          </kbd>
          Select
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700">
            ESC
          </kbd>
          Close
        </span>
      </div>
      <span className="text-xs">
        {count} {count === 1 ? 'item' : 'items'}
      </span>
    </div>
  );
}

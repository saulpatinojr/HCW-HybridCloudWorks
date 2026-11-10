/**
 * HubTabs — the one tab bar every admin hub uses (#578: the Newsletter Hub
 * standard), so the accessibility contract is written once:
 *
 *   - `role="tablist"` with a label; each tab is `role="tab"` with an `id`,
 *     `aria-selected` and `aria-controls` pointing at the panel;
 *   - the content is one `role="tabpanel"` labelled by the selected tab;
 *   - roving tabindex: only the selected tab is in the Tab order, and
 *     ArrowLeft/ArrowRight (wrapping), Home and End move focus and select.
 *
 * Selection is the caller's (usually `?tab=`), so the bar holds no state.
 *
 * The bar scrolls sideways on a narrow screen. Its vertical overflow is
 * hidden: each tab sits 1px over the bar's bottom border (`-mb-px`), and
 * without `overflow-y-hidden` the browser drew a vertical scrollbar for
 * that 1px beside every tab bar (seen on the Search Console page, #1612).
 */
import React, { useRef } from 'react';

/** The tab index a key moves to, or null for a key the pattern ignores. */
export function nextTabIndex(key, current, count) {
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * @param {object} props
 * @param {ReadonlyArray<{ id: string, label: string }>} props.tabs
 * @param {string} props.active the selected tab id
 * @param {(id: string) => void} props.onSelect
 * @param {string} props.idPrefix unique on the page, e.g. "integrations"
 * @param {string} props.label accessible name of the tab list
 * @param {React.ReactNode} props.children the selected tab's content
 */
export default function HubTabs({ tabs, active, onSelect, idPrefix, label, children }) {
  const tabRefs = useRef([]);
  const tabId = (id) => `${idPrefix}-tab-${id}`;
  const panelId = `${idPrefix}-tabpanel`;

  // Moves from the tab that has focus, not from `active`: a held arrow key
  // fires again before the parent re-renders, and counting from the stale
  // selection would stall focus one step along.
  const onKeyDown = (event, current) => {
    const next = nextTabIndex(event.key, current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border"
      >
        {tabs.map(({ id, label: tabLabel }, index) => {
          const selected = active === id;
          return (
            <button
              key={id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={tabId(id)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onSelect(id)}
              className={`-mb-px whitespace-nowrap rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                selected
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tabLabel}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(active)}>
        {children}
      </div>
    </>
  );
}

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
 * Every tab is always on screen. The bar is one rounded tray that breaks
 * onto more lines when the tabs do not fit, rather than a strip that scrolls
 * sideways and hides the last tabs behind a scrollbar (it did on Platform
 * Settings). The tabs are shared out evenly across those lines
 * (`hubTabRows.js`), and each tab grows to fill its line, so the tray is
 * always flush at both ends. A phone gets the same tray on more lines; a
 * dropdown was ruled out because it hides the other tabs, and some pages put
 * a count beside a label, which a plain dropdown cannot show.
 *
 * The selected tab is the one filled in the page's main ink colour (dark in
 * the light theme, white in the dark one), so it stands out by shape and
 * brightness, not by colour alone. Only colours animate, and not at all for
 * someone who has asked their system for reduced motion.
 */
import React, { useRef } from 'react';
import { splitIntoRows, useBalancedRows } from './hubTabRows';

/** The tab index a key moves to, or null for a key the pattern ignores. */
export function nextTabIndex(key, current, count) {
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// Shared by every tab. `grow basis-0` makes the tabs on a line equal in width
// (a long label still keeps its full width); the outline is
// the keyboard focus ring, offset so it shows even round the filled tab.
const TAB_BASE =
  'inline-flex grow basis-0 items-center justify-center whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const TAB_SELECTED = 'bg-primary text-primary-foreground shadow-sm';
const TAB_IDLE = 'text-muted-foreground hover:bg-background hover:text-foreground';

/** One tab. `labelRef` is the label alone, which the bar measures. */
function HubTab({ tab, selected, tabRef, labelRef, onKeyDown, onSelect, tabId, panelId }) {
  return (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      onKeyDown={onKeyDown}
      onClick={() => onSelect(tab.id)}
      className={`${TAB_BASE} ${selected ? TAB_SELECTED : TAB_IDLE}`}
    >
      <span ref={labelRef}>{tab.label}</span>
    </button>
  );
}

/**
 * @param {object} props
 * @param {ReadonlyArray<{ id: string, label: React.ReactNode }>} props.tabs
 * @param {string} props.active the selected tab id
 * @param {(id: string) => void} props.onSelect
 * @param {string} props.idPrefix unique on the page, e.g. "integrations"
 * @param {string} props.label accessible name of the tab list
 * @param {React.ReactNode} props.children the selected tab's content
 */
export default function HubTabs({ tabs, active, onSelect, idPrefix, label, children }) {
  const listRef = useRef(null);
  const tabRefs = useRef([]);
  const labelRefs = useRef([]);
  const rowStarts = useBalancedRows(listRef, labelRefs, tabs.map((tab) => tab.id).join());
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

  const indexed = tabs.map((tab, index) => ({ tab, index }));
  return (
    <>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        className="flex flex-col gap-1 rounded-xl border border-border bg-muted/60 p-1"
      >
        {splitIntoRows(indexed, rowStarts).map((row) => (
          // A line of tabs; `presentation` keeps it out of the tab structure.
          <div key={row[0].tab.id} role="presentation" className="flex flex-wrap gap-1">
            {row.map(({ tab, index }) => (
              <HubTab
                key={tab.id}
                tab={tab}
                selected={active === tab.id}
                tabRef={(node) => {
                  tabRefs.current[index] = node;
                }}
                labelRef={(node) => {
                  labelRefs.current[index] = node;
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
                onSelect={onSelect}
                tabId={tabId(tab.id)}
                panelId={panelId}
              />
            ))}
          </div>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(active)}>
        {children}
      </div>
    </>
  );
}

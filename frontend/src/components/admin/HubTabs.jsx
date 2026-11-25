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
 * Every tab is always on screen. The bar is one rounded tray laid out as a
 * grid of equal cells, rather than a strip that scrolls sideways and hides
 * the last tabs behind a scrollbar (it did on Platform Settings). The grid
 * fits as many columns as the width allows, so the cells line up in columns
 * on every row and a short last row keeps the same cell width. When there
 * are fewer tabs than columns (`auto-fit`), the cells share the whole width.
 *
 * The smallest cell is a fixed width, not measured from the labels: 11.5rem
 * fits the longest label we have ("Content types & origins") on one line, and
 * on a phone 9rem keeps two columns, even in a card. A label longer than its cell wraps onto
 * a second, centred line rather than being cut off. A dropdown was ruled out
 * on phones because it hides the other tabs, and some pages put a count
 * beside a label, which a plain dropdown cannot show.
 *
 * The selected tab is the one filled in the page's main ink colour (dark in
 * the light theme, white in the dark one), so it stands out by shape and
 * brightness, not by colour alone. Only colours animate, and not at all for
 * someone who has asked their system for reduced motion.
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

// The tray: a grid whose columns are each at least 9rem (11.5rem from the
// `sm` width up) and share out what is left equally.
const LIST =
  'grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-1 rounded-xl border border-border bg-muted/60 p-1 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,11.5rem),1fr))]';

// Shared by every tab. The text is centred and may wrap; the outline is the
// keyboard focus ring, offset so it shows even round the filled tab.
const TAB_BASE =
  'flex min-h-9 items-center justify-center rounded-lg px-3 py-2 text-center text-sm leading-tight font-medium transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const TAB_SELECTED = 'bg-primary text-primary-foreground shadow-sm';
const TAB_IDLE = 'text-muted-foreground hover:bg-background hover:text-foreground';

/** One tab, one cell of the grid. */
function HubTab({ tab, selected, tabRef, onKeyDown, onSelect, tabId, panelId }) {
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
      {tab.label}
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
      <div role="tablist" aria-label={label} className={LIST}>
        {tabs.map((tab, index) => (
          <HubTab
            key={tab.id}
            tab={tab}
            selected={active === tab.id}
            tabRef={(node) => {
              tabRefs.current[index] = node;
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            onSelect={onSelect}
            tabId={tabId(tab.id)}
            panelId={panelId}
          />
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(active)}>
        {children}
      </div>
    </>
  );
}

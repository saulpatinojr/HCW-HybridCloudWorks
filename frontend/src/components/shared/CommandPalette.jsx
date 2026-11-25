import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { filterSearchItems, STATIC_SEARCH_ITEMS } from '@/data/searchIndex';
import { PaletteFooter, PaletteResults } from './CommandPaletteParts';

// Cmd+K on a Mac, Ctrl+K elsewhere.
function isPaletteShortcut(event) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
}

const ARROW_STEPS = { ArrowDown: 1, ArrowUp: -1 };

// +1 or -1 for the up and down arrows, 0 for any other key.
function arrowStep(key) {
  return Object.hasOwn(ARROW_STEPS, key) ? ARROW_STEPS[key] : 0;
}

function scrollActiveIntoView(listEl, activeIndex) {
  const activeEl = listEl?.querySelector(`[data-index="${activeIndex}"]`);
  if (activeEl && typeof activeEl.scrollIntoView === 'function') {
    activeEl.scrollIntoView({ block: 'nearest' });
  }
}

// Escape closes; the arrows move the highlight (wrapping at either end);
// Enter opens the highlighted result.
function handlePaletteKey(
  event,
  { filteredItems, activeIndex, setActiveIndex, handleClose, selectItem }
) {
  if (event.key === 'Escape') {
    event.preventDefault();
    handleClose();
    return;
  }

  const count = filteredItems.length;
  if (count === 0) return;

  const step = arrowStep(event.key);
  if (step) {
    event.preventDefault();
    setActiveIndex((prev) => (prev + step + count) % count);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    selectItem(filteredItems[activeIndex]);
  }
}

// Focus the search box shortly after the palette opens. Returns the cleanup.
function focusSoon(open, inputRef) {
  if (!open) return undefined;
  const timer = setTimeout(() => {
    inputRef.current?.focus();
  }, 50);
  return () => clearTimeout(timer);
}

// Cmd/Ctrl+K toggles the palette anywhere on the page, and other code can
// open it by sending the `hcw:open-command-palette` event.
function usePaletteShortcuts(open, handleClose, handleOpen) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      if (open) {
        handleClose();
      } else {
        handleOpen();
      }
    };

    const handleCustomOpen = () => {
      handleOpen();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('hcw:open-command-palette', handleCustomOpen);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('hcw:open-command-palette', handleCustomOpen);
    };
  }, [open, handleClose, handleOpen]);
}

export default function CommandPalette({ isOpen: propIsOpen, onClose: propOnClose }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const isControlled = typeof propIsOpen === 'boolean';
  const open = isControlled ? propIsOpen : internalOpen;

  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const handleClose = useCallback(() => {
    if (isControlled && propOnClose) {
      propOnClose();
    } else {
      setInternalOpen(false);
    }
    setQuery('');
    setActiveIndex(0);
  }, [isControlled, propOnClose]);

  const handleOpen = useCallback(() => {
    if (!isControlled) {
      setInternalOpen(true);
    }
  }, [isControlled]);

  // Global shortcut listener for Cmd+K and Ctrl+K
  usePaletteShortcuts(open, handleClose, handleOpen);

  // Filter items based on user input
  const filteredItems = useMemo(() => {
    return filterSearchItems(query, STATIC_SEARCH_ITEMS);
  }, [query]);

  // Autofocus input when opened
  useEffect(() => focusSoon(open, inputRef), [open]);

  // Scroll active item into view
  useEffect(() => {
    if (open) scrollActiveIntoView(listRef.current, activeIndex);
  }, [activeIndex, open]);

  // Go to a result and close the palette.
  const selectItem = (item) => {
    if (item) {
      navigate(item.path);
      handleClose();
    }
  };

  // Key navigation inside dialog
  const handleDialogKeyDown = (event) =>
    handlePaletteKey(event, {
      filteredItems,
      activeIndex,
      setActiveIndex,
      handleClose,
      selectItem,
    });

  if (!open) return null;

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command search palette"
      data-testid="command-palette-dialog"
      onKeyDown={handleDialogKeyDown}
      className="fixed inset-0 z-100 flex items-start justify-center pt-[12vh] px-4 animate-in fade-in duration-150"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close search palette"
        data-testid="command-palette-backdrop"
        onClick={handleClose}
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity cursor-default border-none outline-none"
      />

      {/* Palette Card */}
      <div className="relative w-full max-w-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-10 flex flex-col max-h-[75vh] animate-in zoom-in-95 duration-150">
        {/* Search Input Bar */}
        <div className="flex items-center px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 gap-3">
          <span
            className="material-symbols-outlined text-slate-400 text-xl shrink-0"
            aria-hidden="true"
          >
            search
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-results-list"
            aria-label="Search architectures, providers, labs, certifications"
            placeholder="Search blueprints, providers, labs, certs (e.g. FOCUS 1.4, Azure, SAA-C03)..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            className="flex-1 bg-transparent border-none outline-none text-slate-900 dark:text-white placeholder:text-slate-400 text-sm font-medium"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setActiveIndex(0);
              }}
              aria-label="Clear search"
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          ) : (
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-2 py-0.5 text-xs font-mono font-semibold text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md">
              ESC
            </kbd>
          )}
        </div>

        {/* Results List */}
        <div
          id="command-results-list"
          role="listbox"
          ref={listRef}
          className="flex-1 overflow-y-auto p-2 divide-y divide-slate-100 dark:divide-slate-800/40"
        >
          <PaletteResults
            items={filteredItems}
            activeIndex={activeIndex}
            onSelect={selectItem}
            onHover={setActiveIndex}
          />
        </div>

        {/* Footer Navigation Hints */}
        <PaletteFooter count={filteredItems.length} />
      </div>
    </div>
  );
}

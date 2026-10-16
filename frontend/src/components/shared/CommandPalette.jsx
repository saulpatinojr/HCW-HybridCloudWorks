import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '@/lib/utils';
import { filterSearchItems, STATIC_SEARCH_ITEMS } from '@/data/searchIndex';

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
  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) {
          handleClose();
        } else {
          handleOpen();
        }
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

  // Filter items based on user input
  const filteredItems = useMemo(() => {
    return filterSearchItems(query, STATIC_SEARCH_ITEMS);
  }, [query]);

  // Autofocus input when opened
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Scroll active item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  // Key navigation inside dialog
  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
      return;
    }

    if (filteredItems.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % filteredItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = filteredItems[activeIndex];
      if (selected) {
        navigate(selected.path);
        handleClose();
      }
    }
  };

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
          {filteredItems.length === 0 ? (
            <div className="py-12 text-center" data-testid="command-palette-empty">
              <span
                className="material-symbols-outlined text-3xl text-slate-400 mb-2"
                aria-hidden="true"
              >
                find_in_page
              </span>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                No matching results found
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Try searching for “FOCUS 1.4”, “Landing Zone”, “Azure”, “Terraform”, or “Labs”.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1 py-1" role="presentation">
              {filteredItems.map((item, index) => {
                const isActive = index === activeIndex;
                return (
                  <li
                    key={item.id}
                    id={`result-option-${index}`}
                    data-index={index}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isActive}
                    onClick={() => {
                      navigate(item.path);
                      handleClose();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        navigate(item.path);
                        handleClose();
                      }
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
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
          )}
        </div>

        {/* Footer Navigation Hints */}
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
            {filteredItems.length} {filteredItems.length === 1 ? 'item' : 'items'}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The admin command palette (AP-F13, #937).
 *
 * Ctrl-K or Cmd-K anywhere in the admin, or the Search button above the
 * page, opens a dialog that lists every page in the navigation registry
 * (config/adminNav.js) and, under them for two to a hundred typed characters,
 * the content items whose title or summary match — read from the list route's
 * `search` parameter (#1178, lib/api.js listContentItems). Enter opens the
 * highlighted entry: a page goes to its route, a content item to its editor.
 * Twenty-eight pages and no search was the finding; this is one keystroke to
 * any of them.
 *
 * It is a Radix dialog (components/ui/dialog), so it is `role="dialog"`,
 * labelled, focus-trapped and closed by Escape like the phone drawer and the
 * confirm modal. The search box is a combobox over one flat listbox — every
 * child an option, each tagged with its group or "content", rather than
 * heading rows the list role has no place for — and the arrow keys move the
 * highlight while focus stays in the box.
 *
 * The body is mounted only while the dialog is open (Radix unmounts the
 * content when it closes), so every opening starts from an empty box and
 * every page, with nothing to reset. The content search runs once per pause
 * in typing, not per keystroke, and its answer is kept with the query it
 * answered: a slow reply to an earlier query is simply not the answer to the
 * current one. The pause is a prop so a test can shorten it.
 *
 * CUT TO THE ROLE, LIKE THE MENU (AP-F4, #928). The pages listed are the
 * ones `visibleNavFor` gives the signed-in role, the same set the rail and
 * the drawer draw, so the palette is not a way round the menu to a page
 * whose every call the server refuses. The content search reads the list
 * route the Editor page reads and its results open the Editor, so it is
 * asked only for a role the Editor is shown to; below that the box offers
 * the pages alone. A missing role (no AdminRoleProvider, which the guard
 * always supplies in the app) reads as the viewer's, as the menu reads it.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FileText, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  NAV_ITEMS,
  navGroupFor,
  navItemById,
  satisfiesRole,
  visibleNavFor,
} from '@/config/adminNav';
import { useAdminRole } from '@/hooks/useAdminRole';
import { listContentItems } from '@/lib/api';
import { cn } from '@/lib/utils';

/** How many content items one search lists; every page the role is shown is always listed. */
export const CONTENT_SEARCH_LIMIT = 8;

/** Whether `role` may search content here: the Editor page, where a result opens, is shown to it. */
export function canSearchContent(role) {
  return satisfiesRole(role, navItemById('editor')?.minRole);
}

/** The registry pages `role` is shown, flat and in menu order. */
export function pagesFor(role) {
  return visibleNavFor(role).flatMap((group) => group.items);
}
/**
 * The content search is asked only for a trimmed term of
 * CONTENT_SEARCH_MIN_LENGTH to CONTENT_SEARCH_MAX_LENGTH characters. These
 * mirror the list route's own bounds (LIST_SEARCH_MIN_CHARS and
 * LIST_SEARCH_MAX_CHARS in functions/src/lib/cms-content.js, #1184), which
 * answers 400 outside them: a term the API would refuse never becomes a
 * request, and a longer one says so instead of showing the refusal.
 */
export const CONTENT_SEARCH_MIN_LENGTH = 2;
export const CONTENT_SEARCH_MAX_LENGTH = 100;

/** The registry pages whose label, description or group carry every word typed. */
export function filterPages(query, items = NAV_ITEMS) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const haystack =
      `${item.label} ${item.description} ${navGroupFor(item)?.label || ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const contentTitle = (item) => item.Title || item.title || 'Untitled';
const contentHint = (item) =>
  [item['Cloud Provider'] || item.cloudProvider || item.provider, item.contentStatus]
    .filter(Boolean)
    .join(' · ');

/**
 * The content items for `query`, asked for once `debounceMs` after the last
 * change. Returns `{ items, error, pending, tooLong }` for the current query
 * only: the answer is stored with the query it answered, so a stale reply is
 * not mistaken for the current one and nothing needs clearing. `query` is
 * already trimmed, as the list route measures it. With `enabled` false
 * (a role the Editor is not shown to) nothing is ever asked.
 */
function useContentSearch(query, debounceMs, enabled) {
  const [answer, setAnswer] = useState(null);
  const sequence = useRef(0);
  const tooLong = enabled && query.length > CONTENT_SEARCH_MAX_LENGTH;
  const searchable = enabled && query.length >= CONTENT_SEARCH_MIN_LENGTH && !tooLong;

  useEffect(() => {
    if (!searchable) return undefined;
    sequence.current += 1;
    const seq = sequence.current;
    const timer = setTimeout(async () => {
      try {
        const items = await listContentItems({ search: query, limit: CONTENT_SEARCH_LIMIT });
        if (seq === sequence.current) setAnswer({ query, items, error: '' });
      } catch (err) {
        if (seq === sequence.current) {
          setAnswer({ query, items: [], error: err?.message || 'The content search failed.' });
        }
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [searchable, query, debounceMs]);

  const current = searchable && answer?.query === query ? answer : null;
  return {
    searchable,
    tooLong,
    items: current?.items ?? [],
    error: current?.error ?? '',
    pending: searchable && !current,
  };
}

/** Everything inside the dialog, for the signed-in `role`; mounted fresh each time it opens. */
function PaletteBody({ debounceMs, role, onChoose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const trimmed = query.trim();
  const shown = useMemo(() => pagesFor(role), [role]);
  const pages = useMemo(() => filterPages(trimmed, shown), [trimmed, shown]);
  const contentAllowed = canSearchContent(role);
  const search = useContentSearch(trimmed, debounceMs, contentAllowed);

  const options = useMemo(
    () => [
      ...pages.map((page) => ({
        id: `page-${page.id}`,
        icon: page.icon,
        label: page.label,
        hint: page.description,
        tag: navGroupFor(page)?.label || 'Page',
        to: page.to,
      })),
      ...search.items.map((item) => ({
        id: `content-${item.id}`,
        icon: FileText,
        label: contentTitle(item),
        hint: contentHint(item),
        tag: 'Content',
        to: `/admin/editor/${encodeURIComponent(item.id)}`,
      })),
    ],
    [pages, search.items]
  );
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const optionId = (option) => `${listId}-${option.id}`;

  const onInputKeyDown = (event) => {
    if (options.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((activeIndex + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((activeIndex - 1 + options.length) % options.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onChoose(options[activeIndex]);
    }
  };

  let note = '';
  if (search.tooLong) {
    note = `Content search takes up to ${CONTENT_SEARCH_MAX_LENGTH} characters; shorten it to search content.`;
  } else if (search.error) note = search.error;
  else if (search.pending) note = 'Searching content…';
  else if (search.searchable && search.items.length === 0) note = 'No content is titled like that.';
  if (options.length === 0 && !note) note = 'No page matches.';

  return (
    <>
      <DialogTitle className="sr-only">Go to a page or open content</DialogTitle>
      <DialogDescription className="sr-only">
        {contentAllowed
          ? 'Type to filter the admin pages and search content by title.'
          : 'Type to filter the admin pages.'}{' '}
        Use the arrow keys to move, Enter to open, Escape to close.
      </DialogDescription>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={options[activeIndex] ? optionId(options[activeIndex]) : undefined}
          aria-label="Search pages and content"
          placeholder={
            contentAllowed ? 'Go to a page, or search content by title…' : 'Go to a page…'
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Pages and content"
        className="max-h-[60vh] overflow-y-auto p-2"
      >
        {options.map((option, index) => {
          const Icon = option.icon;
          const selected = index === activeIndex;
          return (
            // The keyboard drives the list from the combobox above
            // (aria-activedescendant); the row's own handlers are for the
            // pointer, with Enter kept for a row that somehow holds focus.
            <li
              key={option.id}
              id={optionId(option)}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActive(index)}
              onClick={() => onChoose(option)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onChoose(option);
              }}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm',
                selected ? 'bg-muted text-foreground' : 'text-muted-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{option.label}</span>
                {option.hint && <span className="block truncate text-xs">{option.hint}</span>}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wider">{option.tag}</span>
            </li>
          );
        })}
      </ul>
      {note && (
        <p
          role="status"
          className={cn(
            'border-t border-border px-4 py-2 text-xs',
            search.error ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {note}
        </p>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        ↑ ↓ to move · Enter to open · Esc to close
      </p>
    </>
  );
}

/**
 * The palette's button and its dialog, opened by Ctrl-K or Cmd-K, over the
 * pages the signed-in role is shown (see the header).
 */
export default function CommandPalette({ debounceMs = 250 }) {
  const navigate = useNavigate();
  const role = useAdminRole();
  const [open, setOpen] = useState(false);

  // The shortcut, anywhere in the admin. preventDefault, or the browser
  // answers Ctrl-K with its own address-bar search on top of this.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((was) => !was);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const choose = (option) => {
    if (!option) return;
    setOpen(false);
    navigate(option.to);
  };

  return (
    <>
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search pages and content"
          aria-keyshortcuts="Control+K Meta+K"
          className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Search…</span>
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
            Ctrl K
          </kbd>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[12vh] translate-y-0 gap-0 p-0 sm:max-w-xl">
          <PaletteBody debounceMs={debounceMs} role={role} onChoose={choose} />
        </DialogContent>
      </Dialog>
    </>
  );
}

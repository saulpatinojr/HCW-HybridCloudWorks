/**
 * PageHeader — every admin page opens the same way (ADR 0033 UX requirements):
 *
 *   [icon] Title                                         [actions]
 *   One sentence saying what this page is for and when to use it.
 *   [optional status line]   [optional "What happens here" help]
 *
 * THE TITLE IS THE REGISTRY'S LABEL (AP-F13, #937). The route resolves to its
 * entry in config/adminNav.js and the h1 is that entry's label, so the menu
 * and the heading cannot disagree — seven pages had a title of their own
 * ("Content Queue" under the menu's "Review Queue", "Health Hub" under
 * "Health"). `title` is for a page the registry does not name: a record's own
 * title on /admin/editor/:id, an AddOn pane. PageHeader.test.jsx holds every
 * registry page to passing none. The icon defaults the same way, and the
 * purpose sentence has always been the registry's description, so the sidebar
 * tooltip and the page agree. `help` is a list of short lines shown in a
 * collapsible "How this works" panel for a first-time user; it is closed by
 * default and remembered per page.
 */
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';
import { navItemFor, navGroupFor } from '@/config/adminNav';

function useRemembered(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = window.localStorage?.getItem(key);
      return saved === null ? initial : saved === 'true';
    } catch {
      return initial;
    }
  });
  const set = (next) => {
    setValue(next);
    try {
      window.localStorage?.setItem(key, String(next));
    } catch {
      // remembering is a convenience, never a requirement
    }
  };
  return [value, set];
}

/**
 * What the header shows: the page's own value where it gives one, the
 * registry entry's otherwise, and nothing off a route the registry does not
 * name (an AddOn pane passes everything itself).
 */
function fromRegistry(navItem, own) {
  const group = navItem ? navGroupFor(navItem) : null;
  return {
    title: own.title ?? navItem?.label ?? '',
    Icon: own.icon ?? navItem?.icon,
    purpose: own.description ?? navItem?.description ?? '',
    groupLabel: own.eyebrow ?? group?.label ?? '',
  };
}

/**
 * @param {{
 *   icon?: React.ComponentType<{className?: string}>,
 *   title?: string,
 *   description?: React.ReactNode,
 *   eyebrow?: string,
 *   status?: React.ReactNode,
 *   actions?: React.ReactNode,
 *   help?: Array<string | React.ReactNode>,
 *   helpTitle?: string,
 *   children?: React.ReactNode,
 * }} props
 */
export default function PageHeader({
  icon,
  title: ownTitle,
  description,
  eyebrow,
  status,
  actions,
  help,
  helpTitle = 'How this works',
  children,
}) {
  const { pathname } = useLocation();
  const { title, Icon, purpose, groupLabel } = fromRegistry(navItemFor(pathname), {
    title: ownTitle,
    icon,
    description,
    eyebrow,
  });
  const [helpOpen, setHelpOpen] = useRemembered(`contentforge-help:${pathname}`, false);
  const helpId = `page-help-${pathname.replace(/[^a-z0-9]+/gi, '-')}`;

  // The page's title is the document's title (WCAG 2.4.2; estate review
  // 2026-10-06, AP-F3). No admin page used Helmet, so the tab, the history
  // entry and the route announcer carried whatever the public site set last.
  // AdminLayout sets a registry fallback on every route; this is the page's
  // own, which wins because it commits later.
  useEffect(() => {
    if (title) document.title = `${title} · ContentForge`;
  }, [title]);

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {groupLabel && (
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {groupLabel}
            </p>
          )}
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            {Icon && <Icon className="h-6 w-6 text-primary" aria-hidden="true" />}
            {title}
          </h1>
          {purpose && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{purpose}</p>}
          {status && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">{status}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {Array.isArray(help) && help.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/30">
          <button
            type="button"
            onClick={() => setHelpOpen(!helpOpen)}
            aria-expanded={helpOpen}
            aria-controls={helpId}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {helpOpen ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {helpTitle}
          </button>
          {helpOpen && (
            <ol id={helpId} className="space-y-1 border-t border-border/60 px-4 py-3 text-sm">
              {help.map((line, index) => (
                <li key={index} className="flex gap-2">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {index + 1}.
                  </span>
                  <span className="text-muted-foreground">{line}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {children}
    </header>
  );
}

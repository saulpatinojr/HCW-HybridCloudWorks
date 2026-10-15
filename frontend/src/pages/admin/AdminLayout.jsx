import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, LogOut, Menu } from 'lucide-react';
import { signOutUser } from '@/lib/entraAuth';
import { NAV_GROUPS, navItemFor, roleLabel, visibleNavFor } from '@/config/adminNav';
import { useAdminRole } from '@/hooks/useAdminRole';
import CommandPalette from '@/components/admin/CommandPalette';
import useDashboardCounts from '@/hooks/useDashboardCounts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
// Static, not lazy (AP-F12, #936): a toast fired before a lazy toaster's chunk
// arrived expired unseen. This shell is the only place toasts are shown, and
// leaving it strands none: a toast's clock is the store's (use-toast.js), so
// one on screen when the shell unmounts still expires on time, unseen.
import { Toaster } from '@/components/ui/toaster';

// The menu is the navigation registry (config/adminNav.js, ADR 0033 §3):
// groups, items, routes and the one-line description each item shows on
// hover. Nothing about the menu's content lives in this file; this file is
// the shell — collapse state, the live badges, Back to Site and Sign Out.
//
// Re-exported so the nav-order tests and the dashboard read the same list.
export { NAV_GROUPS };

/** The document title an admin page carries when it sets none of its own. */
export const ADMIN_TITLE_SUFFIX = 'ContentForge';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The collapsed rail's label, shown beside the icon on hover and on focus
 * (estate review 2026-10-06, AP-F2).
 *
 * Collapsed, the rail is icons only, and the label used to live in a `title`
 * attribute: a tooltip that never appears on touch, appears to a keyboard user
 * in no browser, and waits a second for a mouse. This is a visible label
 * instead, carrying the text the link's name starts with.
 *
 * FIXED, NOT ABSOLUTE. The nav list is a vertical scroll container, and a
 * scroll container clips sideways too (`overflow-y: auto` computes
 * `overflow-x` to auto), so a label positioned against the link would be cut
 * off at the rail's 64 px edge. Fixed positioning at the link's own box escapes
 * the clip; nothing between here and the viewport is transformed, so the box
 * is the viewport's. e2e/admin-authenticated.spec.js checks this in a real
 * browser, which jsdom cannot.
 *
 * It sits flush against the link, its gap is padding inside it, and it is the
 * link's own descendant, so moving the pointer onto it keeps it open (WCAG
 * 1.4.13, hoverable). Escape dismisses it without moving focus (dismissible).
 */
function useRailLabel(enabled) {
  const [state, setState] = useState({ hover: false, focus: false, top: 0, left: 0 });
  const show = (key) => (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    setState((s) => ({ ...s, [key]: true, top: box.top + box.height / 2, left: box.right }));
  };
  const hide = (key) => () => setState((s) => ({ ...s, [key]: false }));
  const handlers = enabled
    ? {
        onMouseEnter: show('hover'),
        onMouseLeave: hide('hover'),
        onFocus: show('focus'),
        onBlur: hide('focus'),
        onKeyDown: (event) => {
          if (event.key === 'Escape') setState((s) => ({ ...s, hover: false, focus: false }));
        },
      }
    : {};
  return {
    handlers,
    open: enabled && (state.hover || state.focus),
    top: state.top,
    left: state.left,
  };
}

/**
 * The label itself. `aria-hidden` because the link's name already carries this
 * text (the name starts with it, WCAG 2.5.3); announcing it twice helps nobody.
 */
function RailLabel({ rail, children }) {
  if (!rail.open) return null;
  return (
    <span
      aria-hidden="true"
      data-rail-label=""
      className="fixed z-50 -translate-y-1/2 pl-2"
      style={{ top: rail.top, left: rail.left }}
    >
      <span className="block whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md">
        {children}
      </span>
    </span>
  );
}

function NavItem({
  to,
  icon: Icon,
  label,
  description,
  end,
  badgeKey,
  counts,
  collapsed,
  onNavigate,
}) {
  const count = badgeKey ? (counts?.[badgeKey] ?? 0) : 0;
  const shown = count > 99 ? '99+' : String(count);
  // The description is the tooltip. Collapsed, the label is no longer folded
  // into it: it is shown beside the icon instead (RailLabel), because a title
  // attribute is what a touch or keyboard user never sees (AP-F2).
  const rail = useRailLabel(collapsed);
  // The count is part of the link's name ("Review Queue, 3 waiting"), not a
  // label on a span: a span with no role is not reliably announced (estate
  // review 2026-10-06, AP-F2), and the badge itself is then decoration.
  const name = count > 0 ? `${label}, ${count} waiting` : label;

  return (
    <NavLink
      to={to}
      end={end}
      title={description}
      aria-label={name}
      aria-description={description}
      onClick={onNavigate}
      {...rail.handlers}
      className={({ isActive }) =>
        `group relative flex items-center rounded-lg text-sm font-medium transition-all duration-150 ${
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5'
        } ${
          isActive
            ? 'bg-primary/10 text-primary dark:bg-primary/20'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {count > 0 && (
            <span
              className="ml-auto shrink-0 min-w-5 h-5 rounded-full bg-amber-500 text-white text-xs font-bold flex items-center justify-center px-1.5"
              aria-hidden="true"
            >
              {shown}
            </span>
          )}
        </>
      )}
      {collapsed && count > 0 && (
        <span
          className="absolute -top-1 -right-1 min-w-4 h-4 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center px-0.5"
          aria-hidden="true"
        >
          {shown}
        </span>
      )}
      <RailLabel rail={rail}>{label}</RailLabel>
    </NavLink>
  );
}

/**
 * The groups and their items, as the rail and the drawer both render them.
 * `groups` is the registry already filtered to the signed-in role
 * (visibleNavFor, AP-F4): an item the server would refuse is not drawn.
 */
function NavGroups({ groups, counts, collapsed, onNavigate }) {
  return (
    <>
      {groups.map((group, index) => (
        <div key={group.id} className="space-y-0.5">
          {!collapsed && index > 0 && (
            <p
              className="px-3 pb-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground select-none"
              title={group.description}
            >
              {group.label}
            </p>
          )}
          {collapsed && index > 0 && (
            <div className="h-px bg-border/50 mx-1 mb-2 mt-1" role="separator" />
          )}
          {group.items.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              counts={counts}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </>
  );
}

/** Back to Site and Sign Out, as the rail and the drawer both render them. */
function ShellFooter({ collapsed, onSignOut, onNavigate }) {
  const backRail = useRailLabel(collapsed);
  const signOutRail = useRailLabel(collapsed);
  return (
    <div className="border-t border-border px-2 py-3 space-y-0.5 shrink-0">
      <NavLink
        to="/"
        title="Back to Site"
        aria-label="Back to Site"
        onClick={onNavigate}
        {...backRail.handlers}
        className={`flex items-center rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors ${
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2'
        }`}
      >
        <ArrowLeft className="h-4 w-4 shrink-0" />
        {!collapsed && <span className="text-sm font-medium">Back to Site</span>}
        <RailLabel rail={backRail}>Back to Site</RailLabel>
      </NavLink>
      <button
        onClick={onSignOut}
        title="Sign Out"
        aria-label="Sign Out"
        {...signOutRail.handlers}
        className={`w-full flex items-center rounded-lg text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ${
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2'
        }`}
      >
        <LogOut className="h-4 w-4 shrink-0" />
        {!collapsed && <span className="font-medium">Sign Out</span>}
        <RailLabel rail={signOutRail}>Sign Out</RailLabel>
      </button>
    </div>
  );
}

// ── Main Layout ───────────────────────────────────────────────────────────────

/** The shell every admin route renders inside: the menu, cut to the signed-in role so a page the server would refuse is never offered, the page, and the toasts it fires. */
export default function AdminLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = window.localStorage?.getItem('contentforge-sidebar-collapsed');
    return saved === null ? false : saved === 'true';
  });
  // The phone drawer. Every link in it closes it on click (onNavigate), so
  // a tap on a menu item lands on the page rather than on the menu over it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // One snapshot for every badge, re-read on each route change so a page the
  // user just left (approve, publish, reject) is reflected in the menu.
  const { counts } = useDashboardCounts({ refetchOnNavigate: true });
  // The menu is the registry cut to the role the guard verified (AP-F4,
  // #928): a viewer sees what a viewer can open, and the role itself is
  // printed under the brand so the cut is explained rather than mysterious.
  const role = useAdminRole();
  const groups = useMemo(() => visibleNavFor(role), [role]);

  useEffect(() => {
    try {
      window.localStorage?.setItem('contentforge-sidebar-collapsed', String(isSidebarCollapsed));
    } catch {
      // ignore
    }
  }, [isSidebarCollapsed]);

  // Every admin route has a title (WCAG 2.4.2; estate review 2026-10-06,
  // AP-F3). PageHeader sets the page's own; this is the fallback for a route
  // without one, from the registry's label, so the tab, the history entry and
  // the route announcer (ScrollToTop) never carry the previous page's name.
  useEffect(() => {
    const item = navItemFor(pathname);
    document.title = item ? `${item.label} · ${ADMIN_TITLE_SUFFIX}` : ADMIN_TITLE_SUFFIX;
  }, [pathname]);

  const handleSignOut = async () => {
    try {
      await signOutUser();
      navigate('/');
    } catch (err) {
      console.error('Sign-out error:', err);
    }
  };

  const closeDrawer = () => setDrawerOpen(false);

  // FULL VIEWPORT HEIGHT below, not `calc(100vh-4rem)`. That 4rem was
  // reserving room for the site header — and App.jsx renders it as
  // `{!isAdminRoute && <Header />}`, so on every admin route there is no
  // header to reserve for. The Footer is suppressed the same way.
  //
  // THE SIDEBAR NEVER SCROLLS AWAY (#566). The shell is exactly one viewport
  // tall (`h-dvh overflow-hidden`), so the window has nothing to scroll; the
  // content column `#admin-main` is the scroll container and the aside stays
  // put, with its nav list scrolling on its own when the menu is taller than
  // the screen. `dvh`, not `vh`: on mobile browsers `100vh` is the height with
  // the toolbar hidden, which would push Sign Out under the toolbar.
  //
  // TWO SHELLS, ONE REGISTRY (estate review 2026-10-06, AP-F1). Below `md`
  // the rail is not rendered at all: a 64 px column that cannot be dismissed
  // left a 375 px phone about 263 px for the page, and expanding it to read
  // the labels left 71 px. The phone gets a slim top bar and an off-canvas
  // drawer (a Radix dialog, so focus is trapped and Escape closes it) with
  // every label visible. From `md` up the rail is as it was.
  //
  // `#admin-main` is a div, not a `<main>`: App.jsx already wraps every route
  // in `<main id="main-content">`, and two nested main landmarks is one too
  // many. ScrollToTop resets this container's scroll on route change.
  return (
    <div className="h-dvh overflow-hidden flex flex-col md:flex-row bg-background">
      {/* ── Phone top bar + drawer (below md) ───────────────────────────── */}
      <div className="md:hidden flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-bold tracking-tight leading-5">ContentForge</p>
        </div>
        <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
          </DialogTrigger>
          <DialogContent
            aria-label="ContentForge menu"
            className="left-0 top-0 h-dvh w-72 max-w-[85vw] translate-x-0 translate-y-0 rounded-none border-r p-0 gap-0 flex flex-col data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 sm:rounded-none"
          >
            <div className="border-b border-border px-4 py-3 min-h-14 shrink-0">
              <DialogTitle className="text-sm font-bold tracking-tight leading-5">
                ContentForge
              </DialogTitle>
              <DialogDescription className="text-xs leading-4 text-muted-foreground">
                Influencer CMS
              </DialogDescription>
              {role && (
                <p className="mb-0 text-xs leading-4 text-muted-foreground">
                  Your role: {roleLabel(role)}
                </p>
              )}
            </div>
            <nav
              className="flex-1 min-h-0 overflow-y-auto py-3 px-2 space-y-4"
              aria-label="ContentForge menu"
            >
              <NavGroups
                groups={groups}
                counts={counts}
                collapsed={false}
                onNavigate={closeDrawer}
              />
            </nav>
            <ShellFooter collapsed={false} onSignOut={handleSignOut} onNavigate={closeDrawer} />
          </DialogContent>
        </Dialog>
      </div>

      {/* ── Sidebar (md and up) ─────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex sticky top-0 h-dvh border-r border-border bg-card flex-col shrink-0 transition-all duration-200 ${
          isSidebarCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        {/* Brand header. A minimum height with real padding and line height,
            not a fixed `h-14` with `leading-none`: at 125% and 150% zoom the
            two lines outgrew the box and "ContentForge" was cut at the top. */}
        <div
          className={`flex items-center border-b border-border px-3 py-3 min-h-14 shrink-0 ${
            isSidebarCollapsed ? 'justify-center' : 'justify-between gap-2'
          }`}
        >
          {!isSidebarCollapsed && (
            <div className="min-w-0">
              <p className="text-sm font-bold tracking-tight leading-5">ContentForge</p>
              <p className="text-xs leading-4 text-muted-foreground">Influencer CMS</p>
              {role && (
                <p className="mb-0 text-xs leading-4 text-muted-foreground">
                  Your role: {roleLabel(role)}
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setIsSidebarCollapsed((p) => !p)}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isSidebarCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {/* Nav groups */}
        <nav
          className="flex-1 min-h-0 overflow-y-auto py-3 px-2 space-y-4"
          aria-label="ContentForge"
        >
          <NavGroups groups={groups} counts={counts} collapsed={isSidebarCollapsed} />
        </nav>

        <ShellFooter collapsed={isSidebarCollapsed} onSignOut={handleSignOut} />
      </aside>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      {/* `max-w-5xl`, not `max-w-2xl` (AP-F1): 672 px throttled the dense
          pages (Queue, Published, Integrations) on a laptop; a page that is
          prose narrows itself. Side padding steps down on phones. */}
      <div id="admin-main" className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-4 md:p-6">
          <CommandPalette />
          <Outlet />
        </div>
      </div>
      <Toaster />
    </div>
  );
}

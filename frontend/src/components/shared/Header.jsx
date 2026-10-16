import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { cn } from '@/lib/utils';
import { useProvider } from '@/context/ProviderContext';
import { routes, staticRoutes, parseRoute } from '@/lib/routeFactory';
import { SkipToMainContent } from '@/components/accessibility/SkipToMainContent';
import CommandPalette from '@/components/shared/CommandPalette';

/**
 * Cross-provider Learn links retained as a named export for compatibility and
 * mobile fallback on non-provider pages.
 */
export const LEARN_MENU_ITEMS = Object.freeze([
  { label: 'Learn any cloud', path: staticRoutes.education },
  { label: 'Browser labs', path: staticRoutes.labs },
]);

export const PROVIDER_DISPLAY_NAMES = Object.freeze({
  azure: 'Azure',
  aws: 'AWS',
  gcp: 'Google Cloud',
  vmware: 'VMware',
  github: 'GitHub',
  finops: 'FinOps',
  terraform: 'Terraform',
  docker: 'Docker',
  ansible: 'Ansible',
});

/**
 * Symmetrical 9-slot primary navigation builder.
 *
 * Both the main landing page and every provider hub render exactly 9 columns
 * (`repeat(9, 100px)`) inside `<nav aria-label="Primary">`, followed by the
 * divider, `About` / `Contact`, and `Search... ⌘K`. Switching between the main
 * landing page and any provider—or from one provider to another—keeps every
 * pill in the exact same pixel position; only the theme color and labels change.
 */
export function getPrimaryNavItems(currentProvider) {
  if (!currentProvider) {
    return [
      { label: 'Azure', path: routes.landing('azure') },
      { label: 'AWS', path: routes.landing('aws') },
      { label: 'Google Cloud', path: routes.landing('gcp') },
      { label: 'VMware', path: routes.landing('vmware') },
      { label: 'GitHub', path: routes.landing('github') },
      { label: 'FinOps', path: routes.landing('finops') },
      { label: 'Terraform', path: routes.landing('terraform') },
      { label: 'Docker', path: routes.landing('docker') },
      { label: 'Ansible', path: routes.landing('ansible') },
    ];
  }

  const baseLinks = [
    { label: 'Home', path: staticRoutes.home, exact: true },
    {
      label: PROVIDER_DISPLAY_NAMES[currentProvider] || currentProvider.toUpperCase(),
      path: routes.landing(currentProvider),
      exact: true,
    },
    { label: 'News', path: routes.rss(currentProvider), section: 'news' },
    { label: 'Blogs', path: routes.blog(currentProvider), section: 'blog' },
  ];

  const tailLinks = [
    { label: 'Learn', path: routes.education(currentProvider), section: 'learn' },
    { label: 'Labs', path: routes.labs(currentProvider), section: 'labs' },
  ];

  if (['aws', 'azure', 'gcp', 'vmware'].includes(currentProvider)) {
    return [
      ...baseLinks,
      {
        label: 'Architecture',
        path: routes.architectureDesigns(currentProvider),
        section: 'architecture',
      },
      { label: 'Podcast', path: routes.audioArchitecture(currentProvider), section: 'podcast' },
      { label: 'Frameworks', path: routes.frameworks(currentProvider), section: 'frameworks' },
      ...tailLinks,
    ];
  }

  if (currentProvider === 'finops') {
    return [
      ...baseLinks,
      {
        label: 'Architecture',
        path: routes.architectureDesigns('finops'),
        section: 'architecture',
      },
      { label: 'FOCUS', path: routes.focus('finops'), section: 'focus' },
      { label: 'Frameworks', path: routes.frameworks('finops'), section: 'frameworks' },
      ...tailLinks,
    ];
  }

  if (currentProvider === 'github') {
    return [
      ...baseLinks,
      { label: 'Code', path: routes.code('github'), section: 'code' },
      { label: 'Workflows', path: routes.workflows('github'), section: 'workflows' },
      { label: 'Tools', path: routes.tools('github'), section: 'tools' },
      ...tailLinks,
    ];
  }

  if (currentProvider === 'terraform') {
    return [
      ...baseLinks,
      { label: 'Code', path: routes.code('terraform'), section: 'code' },
      { label: 'Modules', path: routes.modules('terraform'), section: 'modules' },
      { label: 'Tools', path: routes.tools('terraform'), section: 'tools' },
      ...tailLinks,
    ];
  }

  if (currentProvider === 'docker') {
    return [
      ...baseLinks,
      { label: 'Code', path: routes.code('docker'), section: 'code' },
      { label: 'Sandboxes', path: routes.sandboxes('docker'), section: 'sandboxes' },
      { label: 'Tools', path: routes.tools('docker'), section: 'tools' },
      ...tailLinks,
    ];
  }

  if (currentProvider === 'ansible') {
    return [
      ...baseLinks,
      { label: 'Code', path: routes.code('ansible'), section: 'code' },
      { label: 'Podcast', path: routes.audioArchitecture('ansible'), section: 'podcast' },
      { label: 'Tools', path: routes.tools('ansible'), section: 'tools' },
      ...tailLinks,
    ];
  }

  return baseLinks;
}

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isProviderLabsRoute(pathname, provider) {
  return (
    matchesPrefix(pathname, routes.labs(provider)) || matchesPrefix(pathname, `/${provider}/labs`)
  );
}

function isNavItemActive(item, pathname, currentProvider) {
  if (item.exact) return pathname === item.path;
  if (!currentProvider) return matchesPrefix(pathname, item.path);

  const onLabsRoute = isProviderLabsRoute(pathname, currentProvider);
  const sectionMatchers = {
    labs: () => onLabsRoute,
    learn: () => !onLabsRoute && matchesPrefix(pathname, routes.education(currentProvider)),
    news: () =>
      matchesPrefix(pathname, routes.rss(currentProvider)) ||
      matchesPrefix(pathname, `/${currentProvider}/news`),
    architecture: () =>
      matchesPrefix(pathname, routes.architectureDesigns(currentProvider)) ||
      pathname === `/${currentProvider}/architectures`,
    podcast: () =>
      pathname === routes.audioArchitecture(currentProvider) ||
      pathname === routes.audio(currentProvider),
  };

  const matcher = sectionMatchers[item.section];
  return matcher ? matcher() : matchesPrefix(pathname, item.path);
}

export default function Header() {
  const location = useLocation();
  const contextProvider = useProvider();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && mobileMenuOpen) setMobileMenuOpen(false);
    };

    window.addEventListener('scroll', handleScroll);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuOpen]);

  // Parse route info for provider context (handles both ProviderLayout routes
  // and static provider routes like /docker/sandboxes or /terraform/tools).
  const routeInfo = parseRoute(location.pathname);
  const currentProvider = routeInfo?.provider || contextProvider || null;

  const sharedLinks = [
    { label: 'About', path: staticRoutes.about },
    { label: 'Contact', path: staticRoutes.contact },
  ];

  const hubLinks = getPrimaryNavItems(currentProvider);

  return (
    <header
      className={cn(
        'sticky top-0 z-50 border-b border-glass-border h-16 transition-all duration-300',
        scrolled && 'shadow-(--shadow-sm)'
      )}
    >
      <SkipToMainContent href="#main-content" />
      <div className="max-w-[1400px] mx-auto h-full px-4 md:px-8 flex items-center justify-between lg:justify-center">
        {/* Symmetrical Centered Desktop Toolbar */}
        <div className="hidden lg:flex items-center justify-center gap-4">
          <nav
            aria-label="Primary"
            className="grid gap-1.5 items-center"
            style={{
              gridTemplateColumns: 'repeat(9, 100px)',
            }}
          >
            {hubLinks.map((item, index) => {
              const active = isNavItemActive(item, location.pathname, currentProvider);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  style={{ gridColumn: index + 1 }}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'text-[11px] font-semibold uppercase tracking-wide transition-colors px-2.5 py-2 rounded-full border whitespace-nowrap inline-flex items-center justify-center w-full text-center',
                    active
                      ? 'text-(--dark-gray) dark:text-(--light-gray) bg-secondary/15 border-secondary/40 shadow-2xs'
                      : 'text-slate-600 dark:text-slate-400 border-transparent hover:text-(--dark-gray) dark:hover:text-(--light-gray) hover:bg-secondary/15 hover:border-secondary/40'
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Divider - identical position on landing and every provider hub */}
          <div className="h-6 w-px bg-slate-300 dark:bg-slate-800 shrink-0" />

          {/* Secondary Nav (About / Contact) - fixed 2-column grid */}
          <nav
            aria-label="Secondary"
            className="grid gap-1.5 items-center"
            style={{
              gridTemplateColumns: 'repeat(2, 84px)',
            }}
          >
            {sharedLinks.map((item, index) => (
              <Link
                key={item.path}
                to={item.path}
                style={{ gridColumn: index + 1 }}
                aria-current={location.pathname === item.path ? 'page' : undefined}
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-wide transition-colors px-2.5 py-2 rounded-full border whitespace-nowrap inline-flex items-center justify-center w-full text-center',
                  location.pathname === item.path
                    ? 'text-(--dark-gray) dark:text-(--light-gray) bg-secondary/15 border-secondary/40 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 border-transparent hover:text-(--dark-gray) dark:hover:text-(--light-gray) hover:bg-secondary/15 hover:border-secondary/40'
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {/* Divider - identical position before Search */}
          <div className="h-6 w-px bg-slate-300 dark:bg-slate-800 shrink-0" />

          {/* Search Trigger Button (Desktop) */}
          <button
            type="button"
            onClick={() => setCommandPaletteOpen(true)}
            aria-label="Search site (Cmd+K)"
            className="inline-flex items-center justify-between gap-2 w-36 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-800/60 text-slate-500 hover:text-slate-900 dark:hover:text-white transition-all text-xs cursor-pointer hover:border-slate-300 dark:hover:border-slate-700 shrink-0"
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                search
              </span>
              <span className="font-medium">Search...</span>
            </span>
            <kbd className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono rounded bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-400">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Tablet & Mobile Controls (< lg) */}
        <div className="flex lg:hidden items-center justify-between w-full gap-2">
          <Link
            to={staticRoutes.home}
            className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-800"
          >
            HybridCloudWorks
          </Link>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
              aria-label="Search"
              className="text-slate-700 dark:text-slate-300 h-10 w-10 inline-flex items-center justify-center rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors"
            >
              <span className="material-symbols-outlined text-lg">search</span>
            </button>

            <button
              className="text-slate-900 dark:text-white h-11 w-11 inline-flex items-center justify-center rounded-md hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav"
              aria-label="Toggle menu"
            >
              <span className="material-symbols-outlined">
                {mobileMenuOpen ? 'close' : 'menu'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Nav */}
      {mobileMenuOpen && (
        <nav
          id="mobile-nav"
          aria-label="Mobile"
          className="lg:hidden absolute left-0 right-0 top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain bg-background/98 backdrop-blur-xl border-b border-glass-border z-50 px-4 py-4 flex flex-col gap-1 *:shrink-0 shadow-xl"
        >
          {/* Mobile search trigger */}
          <button
            type="button"
            onClick={() => {
              setMobileMenuOpen(false);
              setCommandPaletteOpen(true);
            }}
            className="flex items-center gap-2 h-11 px-4 mb-1 rounded-lg text-sm font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 cursor-pointer"
          >
            <span className="material-symbols-outlined text-base">search</span>
            <span>Search blueprints, labs, certs...</span>
            <kbd className="ml-auto px-1.5 py-0.5 text-[10px] font-mono rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-400">
              ⌘K
            </kbd>
          </button>

          {hubLinks.map((item) => {
            const active = isNavItemActive(item, location.pathname, currentProvider);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center h-11 px-4 rounded-lg text-sm font-bold uppercase tracking-wide',
                  active
                    ? 'bg-slate-200/70 dark:bg-slate-700/60 text-slate-900 dark:text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-white'
                )}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.label}
              </Link>
            );
          })}

          {!currentProvider && (
            <div className="border-t border-slate-300 dark:border-slate-800 mt-2 pt-2">
              {LEARN_MENU_ITEMS.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className="flex items-center h-11 px-4 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white text-sm transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          )}

          <div className="border-t border-slate-300 dark:border-slate-800 mt-2 pt-2">
            {sharedLinks.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className="flex items-center h-11 px-4 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white text-sm transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      )}

      {/* Global Command Palette Search Dialog */}
      <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
    </header>
  );
}

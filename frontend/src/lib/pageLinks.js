/**
 * How the admin Pages link to each other (#1886).
 *
 * A piece of content another Page sent into the Pipeline carries `originRef`
 * ({ page, id, part, label }; functions/src/lib/page-links/origin-ref.js). This
 * file turns one into what the Pipeline pages show: the sending Page's name
 * and icon, read from the nav registry (config/adminNav.js) so they are written
 * once, and the address that opens the record on that Page.
 *
 * ADDING A PAGE. The server's ORIGIN_PAGES (functions/src/lib/page-links/origin-pages.js) says which Pages may send work and
 * how a reference is checked; this file's ORIGIN_RECORD_PATHS says where one
 * opens. pageLinks.test.js imports the server list and fails until both name
 * the same Pages, each with a nav entry. The checklist is in .claude/CLAUDE.md,
 * "How the admin Pages connect".
 */
import { navItemById } from '@/config/adminNav';
import { LINK_PARAMS, isAdminPath } from '@/lib/itemLinks';

const enc = encodeURIComponent;

/**
 * Where a record on each sending Page opens, by nav id. Each builder takes the
 * stored reference and returns an admin path; the Page reads the parameter it
 * names (LINK_PARAMS) and opens that record.
 */
export const ORIGIN_RECORD_PATHS = Object.freeze({
  ambassador: (ref) => `/admin/ambassador?tab=programs&${LINK_PARAMS.program}=${enc(ref.id)}`,
  // No tab: whether a talk is on Upcoming or Past depends on its date, which
  // the Page works out when it opens the talk (useLinkedTalk).
  speaking: (ref) => `/admin/speaking?${LINK_PARAMS.talk}=${enc(ref.id)}`,
  // The editor is a dialog over every tab, so none is named.
  certifications: (ref) => `/admin/certifications?${LINK_PARAMS.certification}=${enc(ref.id)}`,
});

/** The nav ids of the Pages above, for the mirror test. */
export const ORIGIN_RECORD_PAGE_IDS = Object.freeze(Object.keys(ORIGIN_RECORD_PATHS));

/**
 * One stored reference as the chip shows it, or null when there is none or it
 * names a Page this build does not know (an older client reading a newer
 * record): nothing is shown rather than a broken link.
 *
 * @param {{ page?: string, id?: string, part?: string|null, label?: string }|null|undefined} ref
 * @returns {{ pageLabel: string, icon: any, label: string, href: string|null }|null}
 */
export function originLink(ref) {
  if (!ref || typeof ref.page !== 'string' || typeof ref.id !== 'string') return null;
  const nav = navItemById(ref.page);
  if (!nav) return null;
  const build = Object.hasOwn(ORIGIN_RECORD_PATHS, ref.page) ? ORIGIN_RECORD_PATHS[ref.page] : null;
  const href = build ? build(ref) : nav.to;
  return {
    pageLabel: nav.label,
    icon: nav.icon,
    label: String(ref.label || ref.id),
    href: isAdminPath(href) ? href : null,
  };
}

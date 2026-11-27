/**
 * Where an admin item opens (#1013, #1014).
 *
 * The single place that maps a content item's pipeline stage to the page it
 * is worked on, and the names of the deep-link parameters the other admin
 * pages read to focus one item. The stage comes from lib/status.js
 * (`contentStatusInfo`), so a status moves stage in one table and its links
 * follow.
 *
 * The API builds the same links for the Decision Center
 * (functions/src/lib/decision-center/links.js). itemLinks.test.js imports
 * that module and fails when the two disagree for any status, or when a link
 * it builds names a parameter no page reads.
 */
import { ADMIN_ROUTES } from '@/config/admin';
import { contentStatusInfo } from '@/lib/status';

const enc = encodeURIComponent;

/** The review board: every stage but Drafts and the Editor is decided there. */
const reviewPath = (id) => `${ADMIN_ROUTES.REVIEW.replace(':id', enc(id))}?source=content`;

/** Each pipeline stage (lib/status.js CONTENT_STATUS `stage`) and the page that works one item at it. */
export const CONTENT_STAGE_PATHS = Object.freeze({
  drafts: () => '/admin/drafts',
  review: reviewPath,
  editor: (id) => ADMIN_ROUTES.EDITOR.replace(':id', enc(id)),
  publish: reviewPath,
  live: reviewPath,
  off: reviewPath,
});

/** The page that opens one content item (`{ id, contentStatus, Live }`) at its stage. */
export function contentItemHref(item) {
  const { stage } = contentStatusInfo(item);
  const path = Object.hasOwn(CONTENT_STAGE_PATHS, stage) ? CONTENT_STAGE_PATHS[stage] : reviewPath;
  return path(String(item?.id ?? ''));
}

/**
 * The query parameters admin pages read to open or highlight one item, by
 * what they name. Each page reads its parameter through hooks/useLinkedItem.
 *
 *   transcript   Recording Hub → Transcripts
 *   issue        Newsletter Hub → Newsletter, Drafts and Published
 *   alert        Health Hub → Alerts
 *   reminder     Platform Settings → Reminders
 *   chapter      Listen & Learn → Review, with the book's `platform` and `exam`
 *   application  Ambassador Hub → Applications
 *   program      Ambassador Hub → Programs, with the program's details open (#1886)
 *   talk         Speaking → the stored talk's edit form open, on Upcoming or Past (#1886)
 *   certification  Certifications → the certification's editor open (#1886)
 *   zone         Cloudflare → every tab acts on that managed zone (#1911)
 */
export const LINK_PARAMS = Object.freeze({
  transcript: 'transcript',
  issue: 'issue',
  alert: 'alert',
  reminder: 'reminder',
  chapter: 'chapter',
  platform: 'platform',
  exam: 'exam',
  application: 'application',
  program: 'program',
  talk: 'talk',
  certification: 'certification',
  zone: 'zone',
});

/** An address inside the admin, and nothing that could leave it. */
export const isAdminPath = (href) =>
  typeof href === 'string' && /^\/admin(?:[/?#]|$)/.test(href) && !/[\s\\]/.test(href);

/**
 * Where a Decision Center item opens. A content item's link is built here
 * from its status, so it follows lib/status.js; every other kind's is the
 * one the API sent, provided it stays inside the admin.
 */
export function decisionHref(item) {
  if (item?.source?.collection === 'content') {
    return contentItemHref({
      id: item.source.id,
      contentStatus: item.status,
      Live: item.source.Live === true,
    });
  }
  return isAdminPath(item?.href) ? item.href : '/admin';
}

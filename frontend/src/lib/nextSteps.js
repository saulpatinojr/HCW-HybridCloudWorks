/**
 * The next step after a piece goes live (#1886, the third way Pages connect).
 *
 * A piece another admin Page sent into the Pipeline carries `originRef`
 * (lib/pageLinks.js). Once it is live, the Pipeline offers the natural next
 * Page for it: today, the program it was written for, where it is recorded as
 * evidence. The link only opens that Page
 * at the record; the Page does the work itself (one engine per kind of work),
 * so nothing here creates, files or stores anything.
 *
 * ADDING A PAGE. Every Page in the server's ORIGIN_PAGES has an entry here, or
 * is named in NO_NEXT_STEP with the reason; nextSteps.test.js fails
 * otherwise. The link is the same one the "sent from" chip uses
 * (ORIGIN_RECORD_PATHS), so it is written once.
 */
import { originLink } from '@/lib/pageLinks';

/**
 * What each sending Page offers once a piece from it is live, by nav id.
 *
 *   label  the link's words
 *   hint   its tooltip: where it goes and what the owner does there
 */
export const NEXT_STEPS = Object.freeze({
  // Worded for every case: the piece may be filed already, or under another
  // program, and the Pipeline cannot tell which (review of #1886 phase 4).
  ambassador: Object.freeze({
    label: 'Open the program',
    hint: 'Opens the program on Ambassador: record this published piece as evidence there, if it is not recorded yet.',
  }),
});

/**
 * Sending Pages that deliberately offer no next step, with the reason. A step
 * that only opens the record would repeat the "sent from" chip beside it and
 * save the owner nothing (CLAUDE.md: join only where it helps the owner).
 */
export const NO_NEXT_STEP = Object.freeze({
  speaking:
    'Nothing is left to do on the talk once its piece is live; the "sent from" chip already links back to it.',
  certifications:
    'Nothing is left to do on the certification once its piece is live; the "sent from" chip already links back to it.',
});

/** The published statuses the public site admits (functions/src/lib/public-read-rules.js PUBLIC_STATUSES). */
const PUBLIC_STATUSES = new Set([
  'published',
  'published_blog',
  'published_news',
  'published_both',
]);

/**
 * Whether a piece is live: the public site's own rule
 * (functions/src/lib/public-read-rules.js isPublicDocument), which the
 * server's evidence import also uses (import-readers.js isLiveContent), so a
 * piece is live here exactly when a visitor can open it and when it can be
 * recorded as evidence (#1897). `Live` is set, or the older `Status` is
 * "Live", or the status is a published one; a draft never is; and the piece
 * is not deleted. liveRuleMirror.test.js holds the three together.
 */
export function isLivePiece(piece) {
  if (!piece || piece.softDeletedAt || piece.softDeleteExpiresAt) return false;
  if (piece.contentStatus === 'drafting') return false;
  return (
    piece.Live === true ||
    piece.Status === 'Live' ||
    PUBLIC_STATUSES.has(String(piece.contentStatus || ''))
  );
}

/**
 * The next step for one content item, or null when it is not live, no Page
 * sent it, or its Page has no next step or no link in this build.
 *
 * @param {object|null|undefined} item
 * @returns {{ page: string, label: string, hint: string, href: string, pageLabel: string }|null}
 */
export function nextStepFor(item) {
  if (!isLivePiece(item)) return null;
  const ref = item.originRef;
  const step = ref && Object.hasOwn(NEXT_STEPS, ref.page) ? NEXT_STEPS[ref.page] : null;
  const link = step ? originLink(ref) : null;
  if (!link?.href) return null;
  return { page: ref.page, ...step, href: link.href, pageLabel: link.pageLabel };
}

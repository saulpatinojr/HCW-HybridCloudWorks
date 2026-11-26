/**
 * The next step after a piece goes live (#1886, the third way Pages connect).
 *
 * A piece another admin Page sent into the Pipeline carries `originRef`
 * (lib/pageLinks.js). Once it is live, the Pipeline offers the natural next
 * Page for it: the program it was written for, to file it as evidence; the
 * talk or certification it was written about. The link only opens that Page
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
  ambassador: Object.freeze({
    label: 'File as evidence',
    hint: 'Opens the program on Ambassador, where a published piece is recorded as evidence.',
  }),
  speaking: Object.freeze({
    label: 'Back to the talk',
    hint: 'Opens the talk on Speaking, where the pieces written for it are listed.',
  }),
  certifications: Object.freeze({
    label: 'Back to the certification',
    hint: 'Opens the certification, where the pieces written for it are listed.',
  }),
});

/**
 * Sending Pages that deliberately offer no next step, with the reason. Empty
 * today: every Page that sends work has one.
 */
export const NO_NEXT_STEP = Object.freeze({});

/**
 * Whether a piece is live, as the Pipeline's next step reads it. The same
 * test the server applies before a live piece can be filed as evidence
 * (functions/src/lib/ambassador/import-readers.js isLiveContent): `Live` is
 * true, or the older `Status` is "Live", or the status is "published", and
 * the piece is not deleted. One rule, so a link never offers a step the
 * Page at the other end would refuse (liveRuleMirror.test.js holds the two
 * together).
 */
export function isLivePiece(piece) {
  if (!piece || ![undefined, null, '', false].includes(piece.softDeletedAt)) return false;
  return piece.Live === true || piece.Status === 'Live' || piece.contentStatus === 'published';
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

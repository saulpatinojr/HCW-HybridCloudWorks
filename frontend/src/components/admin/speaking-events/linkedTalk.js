/**
 * Opening one talk from a link (#1886): `/admin/speaking?talk=<stored id>`,
 * the address the Pipeline's "sent from" chip uses for a piece started for a
 * talk (lib/pageLinks.js). The Page opens that talk's edit form, where its
 * pieces are listed, on the tab the talk sits on: Upcoming or Past, by date.
 *
 * The id is the stored record's (`speakerevents`), the one a piece names;
 * a Sessionize event with no stored record has nothing to link to.
 */
import { useEffect, useRef } from 'react';
import { isUpcoming } from '@/lib/speakingEvents';

/** The tab a talk on this date is listed on. */
export const tabForDate = (date, now = new Date()) => (isUpcoming(date, now) ? 'upcoming' : 'past');

/**
 * The row a stored talk id names, and where it is listed: a Sessionize event
 * whose stored record has that id, or a manual entry with it. Null when no
 * row has it (deleted, or never stored).
 *
 * @returns {{ kind: 'sessionize'|'manual', row: object, tab: string }|null}
 */
export function findLinkedTalk(rows, id, now = new Date()) {
  if (!id) return null;
  const event = (rows?.mergedEvents || []).find((row) => row._storedDoc?._docId === id);
  if (event) return { kind: 'sessionize', row: event, tab: tabForDate(event.date, now) };
  const manual = (rows?.manualEntries || []).find((row) => row._docId === id);
  if (manual) return { kind: 'manual', row: manual, tab: tabForDate(manual.date, now) };
  return null;
}

/** How each kind of row opens in the shared editor (useEventEditor). */
const OPENERS = {
  sessionize: (editor, row) => editor.openEnrich(row),
  manual: (editor, row) => editor.openEditManual(row),
};

/**
 * Open the linked talk once, when the rows can be listed. A link that names
 * no row opens nothing; the tab the address names stays as it is. Once the
 * editor the link opened closes (Cancel, Save or Delete), `clearLink` drops
 * the parameter, so a reload does not open the talk again.
 *
 * @param {{
 *   talkId: string|null,
 *   listable: boolean,
 *   rows: { mergedEvents: object[], manualEntries: object[] },
 *   editor: { openEnrich: Function, openEditManual: Function },
 *   showTab: (tab: string) => void,
 *   clearLink: () => void,
 * }} input
 */
export default function useLinkedTalk({ talkId, listable, rows, editor, showTab, clearLink }) {
  const handled = useRef(null);
  // 'opening' until the editor shows the linked talk, then 'open' until it closes.
  const linkState = useRef('idle');
  useEffect(() => {
    // Once the parameter is gone the same link may open the talk again.
    if (!talkId) {
      handled.current = null;
      return;
    }
    if (!listable || handled.current === talkId) return;
    handled.current = talkId;
    const found = findLinkedTalk(rows, talkId);
    if (!found) return;
    OPENERS[found.kind](editor, found.row);
    linkState.current = 'opening';
    showTab(found.tab);
  }, [talkId, listable, rows, editor, showTab]);

  const { editingId } = editor;
  useEffect(() => {
    if (linkState.current === 'opening' && editingId) linkState.current = 'open';
    else if (linkState.current === 'open' && !editingId) {
      linkState.current = 'idle';
      clearLink();
    }
  }, [editingId, clearLink]);
}

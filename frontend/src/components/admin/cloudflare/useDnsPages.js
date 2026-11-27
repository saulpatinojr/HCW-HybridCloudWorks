/**
 * The DNS tab's list, a page at a time (#1907). The server answers one page
 * of 100 records per request with the zone's totals, so a zone with
 * thousands of records is never read in one long request.
 *
 * Page 1 is the tab's ordinary read (`useZoneRead`), so a refresh after an
 * add or edit, or a change of zone, starts again from page 1: the pages
 * loaded after it belong to that one answer and are dropped with it. "Load
 * more" asks for the next page and appends it; it does nothing while a page
 * is already on its way. Each page is kept under the mark of the page-1 read
 * and zone it followed, and only pages whose mark matches what is on screen
 * are shown, so one that lands after page 1 was read again (or after a zone
 * switch) never appears.
 */
import { useCallback, useRef, useState } from 'react';

/**
 * What the pages read so far add up to: their records in order (a record
 * that moved between two reads is shown once), whether another page
 * follows, its number, and the zone's total (null when not known).
 */
export function dnsListView(pages) {
  const seen = new Set();
  const records = [];
  for (const record of pages.flatMap((page) => page?.records ?? [])) {
    if (!seen.has(record.id)) records.push(record);
    seen.add(record.id);
  }
  const last = pages[pages.length - 1] ?? {};
  const totalCount = pages[0]?.totalCount;
  return {
    records,
    hasMore: last.hasMore === true,
    nextPage: (Number.isInteger(last.page) ? last.page : pages.length) + 1,
    totalCount: Number.isInteger(totalCount) ? totalCount : null,
  };
}

/** The sentence that says how much of the zone is on screen. */
export function dnsCountText({ records, hasMore, totalCount }) {
  const shown = records.length;
  const noun = (count) => (count === 1 ? 'record' : 'records');
  if (totalCount !== null && totalCount > shown) {
    return `Showing ${shown} of the zone's ${totalCount} ${noun(totalCount)}, 100 at a time.`;
  }
  if (totalCount !== null) return `The zone has ${totalCount} ${noun(totalCount)}.`;
  return hasMore
    ? `Showing ${shown} ${noun(shown)}; more follow.`
    : `Showing ${shown} ${noun(shown)}.`;
}

/** Whether two marks name the same page-1 read of the same zone. */
const sameRead = (a, b) => a.base === b.base && a.zone === b.zone;

/**
 * @param {{ data: object, loadedAt: Date|null }} read the tab's read of page 1;
 *   `loadedAt` is a new Date each time a read lands, so it names that read
 * @param {(zone: string, page: number) => Promise<object>} readPage
 * @param {string} zone the picked zone
 */
export default function useDnsPages(read, readPage, zone) {
  // The page-1 read and zone on screen now. The pages after the first, and a
  // failed page's sentence, carry the mark of the read they followed.
  const mark = { base: read.loadedAt, zone };
  const [more, setMore] = useState({ base: null, zone: null, pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState({ base: null, zone: null, text: '' });
  const inFlight = useRef(false);

  // The guard: pages kept under another read's mark are not shown.
  const view = dnsListView([read.data, ...(sameRead(more, mark) ? more.pages : [])]);

  const loadMore = useCallback(async () => {
    if (inFlight.current || !view.hasMore) return;
    inFlight.current = true;
    const from = { base: read.loadedAt, zone };
    setLoadingMore(true);
    setFailure({ base: null, zone: null, text: '' });
    try {
      const page = await readPage(zone, view.nextPage);
      // Kept under `from`: if page 1 was read again meanwhile, `view` ignores it.
      // Only one page is ever on its way, so this never replaces newer pages.
      setMore((was) => ({ ...from, pages: [...(sameRead(was, from) ? was.pages : []), page] }));
    } catch (err) {
      setFailure({ ...from, text: err?.message || 'The next page could not be read.' });
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [readPage, zone, read.loadedAt, view.hasMore, view.nextPage]);

  const moreError = sameRead(failure, mark) ? failure.text : '';
  return { ...view, loadMore, loadingMore, moreError };
}

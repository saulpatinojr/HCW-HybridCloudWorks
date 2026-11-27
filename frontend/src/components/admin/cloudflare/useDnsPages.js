/**
 * The DNS tab's list, a page at a time (#1907). The server answers one page
 * of 100 records per request with the zone's totals, so a zone with
 * thousands of records is never read in one long request.
 *
 * Page 1 is the tab's ordinary read (`useZoneRead`), so a refresh after an
 * add or edit, or a change of zone, starts again from page 1: the pages
 * loaded after it belong to that one answer and are dropped with it. "Load
 * more" asks for the next page and appends it; it does nothing while a page
 * is already on its way, and an answer that arrives after page 1 was read
 * again (or for another zone) is thrown away.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

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
  // The mark on screen, for an answer that lands later to check against.
  const current = useRef(mark);
  useEffect(() => {
    current.current = { base: read.loadedAt, zone };
  }, [read.loadedAt, zone]);

  const view = dnsListView([read.data, ...(sameRead(more, mark) ? more.pages : [])]);

  const loadMore = useCallback(async () => {
    if (inFlight.current || !view.hasMore) return;
    inFlight.current = true;
    const from = current.current;
    setLoadingMore(true);
    setFailure({ base: null, zone: null, text: '' });
    try {
      const page = await readPage(zone, view.nextPage);
      if (sameRead(current.current, from)) {
        setMore((was) => ({ ...from, pages: [...(sameRead(was, from) ? was.pages : []), page] }));
      }
    } catch (err) {
      setFailure({ ...from, text: err?.message || 'The next page could not be read.' });
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [readPage, zone, view.hasMore, view.nextPage]);

  const moreError = sameRead(failure, mark) ? failure.text : '';
  return { ...view, loadMore, loadingMore, moreError };
}

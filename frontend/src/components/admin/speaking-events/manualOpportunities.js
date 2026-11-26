/**
 * The owner's own speaking ideas, as rows of the "Future Events" tab
 * (owner request 2026-11-25, docs/runbooks/future-events-manual-entries-2026-11-25.md).
 *
 * WHERE THEY COME FROM. Not a new read. The Speaking hub already reads every
 * stored speaker event once (`cms/speakerevents`, useSpeakingData.js) and
 * hands the tab the ones Sessionize does not list (`rows.manualEntries`).
 * This file turns those into rows shaped like the Community Days rows, so
 * the tab's existing rules (days left, clash marks, the calendar, the search
 * box) apply to them unchanged. The Community Days read stays one route
 * (useApplyEvents.js, ADR 0045) and is not touched.
 *
 * WHICH ENTRIES. Only those whose Speaking status is Idea: an event worth
 * proposing to, nothing sent yet. That is the same question the Community
 * Days rows answer. A Proposed entry is left out on purpose: a proposal has
 * been sent, so it is already one of the owner's own talks (applyModel's
 * `ownTalks`), and the clash rule counts it there. Listing it here as well
 * would show it twice and let it clash with itself.
 *
 * NO DOUBLES. An entry with the same name as a Community Days event (listed,
 * or saved and no longer listed) is left out: the directory's row already
 * shows that event, with its notes and estimate. Names are compared the way
 * the rest of the hub compares them (`normalizeName`), the same rule as
 * "you are already speaking here".
 */
import { normalizeName, toInputDate } from '@/lib/speakingEvents';
import { httpUrl, manualRowStatus, safeString } from './eventModel';
import { isDay } from './applyModel';

/** The prefix that keeps a manual row's id apart from a Community Days id. */
export const MANUAL_ID_PREFIX = 'manual-';

const dayOrNull = (value) => {
  const day = toInputDate(value);
  return isDay(day) ? day : null;
};

/** One stored entry as a Future Events row. */
export function manualRow(entry) {
  const docId = entry._docId ?? entry.id;
  const day = dayOrNull(entry.date);
  const end = dayOrNull(entry.endDate);
  return {
    id: `${MANUAL_ID_PREFIX}${docId}`,
    manual: true,
    docId,
    title: entry.eventName || entry.name || 'Untitled event',
    tagline: safeString(entry.topic) || null,
    url: httpUrl(entry.eventUrl),
    website: null,
    startDate: day,
    endDate: end && day && end >= day ? end : day,
    eventType: null,
    place: safeString(entry.location) || '',
    city: null,
    region: null,
    country: null,
    costTiers: [],
    // A stored entry has no separate proposals link; its page is the title's link.
    callUrl: null,
    callCloses: dayOrNull(entry.cfpDeadline),
    cancelled: false,
    postponed: false,
    note: null,
    entryNotes: safeString(entry.description) || '',
  };
}

/** The names the Community Days rows already show, listed or saved. */
function feedNames(events, saved) {
  const names = new Set();
  for (const event of events ?? []) names.add(normalizeName(event.title));
  for (const note of saved ?? []) names.add(normalizeName(note.event?.title));
  names.delete('');
  return names;
}

/**
 * The manual entries that belong on Future Events, as rows.
 *
 * @param {object[]} manualEntries - the hub's `rows.manualEntries`
 * @param {{ events?: object[], saved?: object[] }} feed - the Community Days answer
 * @param {Date} [now]
 */
export function manualOpportunities(manualEntries, { events, saved } = {}, now = new Date()) {
  const taken = feedNames(events, saved);
  return (manualEntries ?? [])
    .filter((entry) => manualRowStatus(entry, now) === 'idea')
    .map(manualRow)
    .filter((row) => !taken.has(normalizeName(row.title)));
}

/**
 * The feed rows with the manual rows slotted in by start day. The feed rows
 * keep the order the server sent (soonest first); each manual row goes in
 * before the first feed row that starts later, and an undated one goes last.
 * With no manual rows the answer is the feed list itself.
 */
export function withManualRows(events, manual) {
  const feed = events ?? [];
  if (!manual || manual.length === 0) return feed;
  const sorted = [...manual].sort((a, b) =>
    (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999')
  );
  const out = [];
  let next = 0;
  for (const event of feed) {
    while (
      next < sorted.length &&
      sorted[next].startDate &&
      isDay(event.startDate) &&
      sorted[next].startDate < event.startDate
    ) {
      out.push(sorted[next]);
      next += 1;
    }
    out.push(event);
  }
  return [...out, ...sorted.slice(next)];
}

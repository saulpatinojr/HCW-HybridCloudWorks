/**
 * The lab-start counter: how many lab sessions the website has started for
 * visitors, kept as plain counts per lab per UTC day and nothing else.
 *
 * WHY IT EXISTS. The owner needs to be able to quote a checkable figure
 * ("N lab sessions were started through the website, with the real count
 * reported") in reports and letters. Until this file there was no count to
 * report. The visitor session records in `lab_jobs` cannot supply one:
 * each is written with a two-hour `ttl` (visitor-session.js
 * VISITOR_DOC_TTL_SECONDS), so Cosmos deletes it about two hours after its last
 * update, long before anyone could add them up. There is no stored history to count from, and this module does not
 * pretend there is: it counts from the day the first start is recorded or the
 * admin card is first read, whichever came first, and `since` says which day
 * that was.
 *
 * WHAT IS COUNTED. One count each time the broker (visitor-session.js
 * startSession) creates a new session: the moment `createDoc('lab_jobs', ...)`
 * succeeds. A repeat request from a client that already has a live session
 * returns that session and is not counted; a page view is not counted; a
 * refused request (closed door, full capacity, daily limit, failed
 * Turnstile check) is not counted. It counts sessions the site created, whether
 * or not the visitor then did anything in them, and any session the owner or a
 * tester starts through the public button. It counts sessions, not people: one
 * person who starts two sessions on one day counts twice, because telling them apart
 * would need an identifier, and the counter keeps none.
 *
 * WHAT IS NOT COUNTED. A member who signs in with GitHub inside the lab pane
 * starts their workspace on Coder itself; the site's server never sees that
 * start, and a count reported by the browser could be made up by anyone, so
 * it is left out rather than guessed. The public "Validate on the lab" button
 * runs a Terraform check, not a lab session, and is not counted either.
 *
 * WHAT IS STORED, AND ONLY THIS. Two shapes in the `system` container (a small
 * configuration container with no expiry, included in the weekly export,
 * export-classification.js), the same place the legacy-blogs read counter
 * keeps its tally (legacy-blogs-telemetry.js):
 *
 *   one document per UTC day   { id: 'lab-starts:YYYY-MM-DD', kind: 'lab-starts-day',
 *                                day, total, byLab: { <lab id>: <count> } }
 *   one marker document        { id: 'lab-starts:meta', kind: 'lab-starts-meta',
 *                                since: 'YYYY-MM-DD' }
 *
 * No IP address, client hash, user id, session id, workspace name, token,
 * query string, user agent or time of day. The day is the finest time the
 * application keeps. (Cosmos puts its own last-modified stamp, `_ts`, on every
 * document it stores; that is the database's, not a field of the counter, and
 * it is the time of the day's latest start, not of any person.) A lab id is an entry in the site's own lab list (a slug such as
 * `terraform-validate-walkthrough`), checked against a strict pattern, so a
 * caller cannot grow the document with text of its own choosing.
 * `applyLabStart` rebuilds every document from that allow-list on each write,
 * so a field that somehow got in is dropped at the next write rather than
 * carried forward, and lab-starts.test.js fails on any key outside it.
 *
 * HOW IT IS WRITTEN. Read the day's document, add one, write it back only if
 * it has not changed since (the ETag compare that `replaceDocIfMatch` gives,
 * as the lab agent's job claim does); the first start of a day creates the
 * document and loses a race with a 409. Both losers read again and retry, a
 * few times. A counter that cannot be written never blocks a visitor: the
 * caller (visitor-session.js) catches, logs the error code only, and carries
 * on, so a store fault means one start is missing from the count, never that a
 * visitor is refused.
 *
 * Pure apart from the three functions that take a `store`.
 */
import { utcDay } from '../cloud-tools/history.js';

/** The container both documents live in (partition key `/id`, no TTL). */
export const LAB_STARTS_CONTAINER = 'system';
export const LAB_STARTS_DAY_KIND = 'lab-starts-day';
export const LAB_STARTS_META_KIND = 'lab-starts-meta';
export const LAB_STARTS_META_ID = 'lab-starts:meta';

/**
 * The only keys a counter document may have (Cosmos adds its own `_`-prefixed
 * system fields, which are not ours). The tests hold the stored documents to
 * exactly these.
 */
export const LAB_STARTS_DAY_KEYS = Object.freeze(['id', 'kind', 'day', 'total', 'byLab']);
export const LAB_STARTS_META_KEYS = Object.freeze(['id', 'kind', 'since']);

/** How many times a write re-reads and tries again after losing a race. */
export const MAX_WRITE_ATTEMPTS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LAB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A lab list this long would be a bug, not a catalogue; the day document stays small. */
const MAX_LABS_PER_DAY = 64;

export const dayDocId = (day) => `lab-starts:${day}`;

export function isLabId(value) {
  return typeof value === 'string' && LAB_ID_PATTERN.test(value);
}

export function isDay(value) {
  return (
    typeof value === 'string' &&
    DAY_PATTERN.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/** The day `delta` days from `day`, both `YYYY-MM-DD`, in UTC. */
export function addDays(day, delta) {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);
}

const isCount = (value) => Number.isSafeInteger(value) && value > 0;

/** The per-lab counts that pass the allow-list, as a fresh object. */
function cleanByLab(byLab) {
  const out = {};
  if (byLab === null || typeof byLab !== 'object' || Array.isArray(byLab)) return out;
  for (const [labId, count] of Object.entries(byLab)) {
    if (isLabId(labId) && isCount(count) && Object.keys(out).length < MAX_LABS_PER_DAY) {
      out[labId] = count;
    }
  }
  return out;
}

/** An own count, else 0; never something inherited from Object.prototype. */
const own = (counts, labId) => (Object.hasOwn(counts, labId) ? counts[labId] : 0);

const sum = (byLab) => Object.values(byLab).reduce((all, count) => all + count, 0);

/**
 * The day document after one more start for `labId`, built field by field:
 * nothing in `existing` is copied except the counts that pass the allow-list
 * and the `_etag` the write needs. `total` is always the sum of `byLab`, so
 * the two cannot drift.
 *
 * @param {object|null} existing - the document as read, or null on the day's first start
 * @param {{ day: string, labId: string }} start
 */
export function applyLabStart(existing, { day, labId }) {
  if (!isDay(day)) throw new Error('applyLabStart: day must be YYYY-MM-DD');
  if (!isLabId(labId)) throw new Error('applyLabStart: labId is not a lab id');
  const byLab = cleanByLab(existing?.kind === LAB_STARTS_DAY_KIND ? existing.byLab : null);
  // Own keys only: a lab id such as `constructor` is on every plain object's
  // prototype and would read as a function, not as 0.
  byLab[labId] = (Object.hasOwn(byLab, labId) ? byLab[labId] : 0) + 1;
  const doc = {
    id: dayDocId(day),
    kind: LAB_STARTS_DAY_KIND,
    day,
    total: sum(byLab),
    byLab,
  };
  if (existing?._etag) doc._etag = existing._etag;
  return doc;
}

const conflict = (error, code) => error?.code === code;

/**
 * Make sure the marker document exists, so `since` names the day counting
 * began. Create-only: an existing marker is never rewritten, so `since`
 * never moves once it is set.
 *
 * @returns {Promise<string>} the `since` day
 */
export async function ensureSince(store, { day }) {
  const existing = await store.readDoc(LAB_STARTS_CONTAINER, LAB_STARTS_META_ID, LAB_STARTS_META_ID);
  if (existing && isDay(existing.since)) return existing.since;
  try {
    await store.createDoc(LAB_STARTS_CONTAINER, {
      id: LAB_STARTS_META_ID,
      kind: LAB_STARTS_META_KIND,
      since: day,
    });
    return day;
  } catch (error) {
    if (!conflict(error, 409)) throw error;
    const winner = await store.readDoc(LAB_STARTS_CONTAINER, LAB_STARTS_META_ID, LAB_STARTS_META_ID);
    return isDay(winner?.since) ? winner.since : day;
  }
}

/**
 * Count one started session.
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {{ labId: string, nowMs?: number }} start
 * @returns {Promise<{ counted: boolean, reason?: string, day?: string }>}
 *   `counted: false` is "not recorded" (a bad lab id, or the race lost five
 *   times); a store fault is thrown for the caller to log.
 */
export async function recordLabStart(store, { labId, nowMs = Date.now() }) {
  if (!isLabId(labId)) return { counted: false, reason: 'invalid-lab-id' };
  const day = utcDay(nowMs);
  const id = dayDocId(day);
  await ensureSince(store, { day });

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const existing = await store.readDoc(LAB_STARTS_CONTAINER, id, id);
    try {
      if (existing) {
        await store.replaceDocIfMatch(LAB_STARTS_CONTAINER, applyLabStart(existing, { day, labId }));
      } else {
        await store.createDoc(LAB_STARTS_CONTAINER, applyLabStart(null, { day, labId }));
      }
      return { counted: true, day };
    } catch (error) {
      // 409: another instance made the day's document first. 412: it changed
      // since this read. Either way read again and add to what is there now.
      if (!conflict(error, 409) && !conflict(error, 412)) throw error;
    }
  }
  return { counted: false, reason: 'contention', day };
}

/** Sum one lab's counts (or all labs') over the days in [from, to]. */
function windowCounts(days, from, to) {
  const perLab = {};
  for (const entry of days) {
    if (entry.day < from || entry.day > to) continue;
    for (const [labId, count] of Object.entries(entry.byLab)) {
      perLab[labId] = (Object.hasOwn(perLab, labId) ? perLab[labId] : 0) + count;
    }
  }
  return { total: sum(perLab), perLab };
}

/**
 * The figures the admin card shows, from the day documents and the marker.
 * `total` is every day ever counted, not only the last 30. A document or count
 * that fails the allow-list (a bad day, a bad lab id, a non-count) is skipped,
 * not trusted.
 *
 * Windows count back from today, today included: `last7` is today and the six
 * days before it, `last30` today and the twenty-nine before it. A day with no
 * document had no starts.
 *
 * @param {object[]} docs - day documents as read
 * @param {{ since: string, today: string }} context
 */
export function summariseLabStarts(docs, { since, today }) {
  const days = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (doc?.kind === LAB_STARTS_DAY_KIND && isDay(doc.day)) {
      days.push({ day: doc.day, byLab: cleanByLab(doc.byLab) });
    }
  }
  const from7 = addDays(today, -6);
  const from30 = addDays(today, -29);
  const windows = {
    today: windowCounts(days, today, today),
    last7: windowCounts(days, from7, today),
    last30: windowCounts(days, from30, today),
    total: windowCounts(days, '0000-01-01', '9999-12-31'),
  };
  const labIds = Object.keys(windows.total.perLab);
  const perLab = labIds
    .map((labId) => ({
      labId,
      today: own(windows.today.perLab, labId),
      last7: own(windows.last7.perLab, labId),
      last30: own(windows.last30.perLab, labId),
      total: windows.total.perLab[labId],
    }))
    .sort((a, b) => b.total - a.total || a.labId.localeCompare(b.labId));
  return {
    since,
    today,
    counts: {
      today: windows.today.total,
      last7: windows.last7.total,
      last30: windows.last30.total,
      total: windows.total.total,
    },
    perLab,
  };
}

/**
 * Read every figure. Creates the marker on the first read when no start has
 * made it yet, so a card opened before any visitor starts a lab already says
 * which day counting began.
 *
 * @param {{ readDoc: Function, createDoc: Function, queryDocs: Function }} store
 * @param {{ nowMs?: number }} [options]
 */
export async function readLabStarts(store, { nowMs = Date.now() } = {}) {
  const today = utcDay(nowMs);
  const since = await ensureSince(store, { day: today });
  const docs = await store.queryDocs(
    LAB_STARTS_CONTAINER,
    'SELECT c.kind, c.day, c.byLab FROM c WHERE c.kind = @kind',
    [{ name: '@kind', value: LAB_STARTS_DAY_KIND }]
  );
  return summariseLabStarts(docs, { since, today });
}

/** An authenticated answer no cache may keep. */
const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/**
 * GET /api/cms/labs/starts, behind the editor role (the Labs hub's own level).
 * The guard answers 401 or 403 and nothing is read for a caller it refuses.
 *
 * @param {{ guard: { requireRole: Function }, store: object, now?: () => number }} deps
 */
export function createLabStartsReadHandler({ guard, store, now = () => Date.now() }) {
  return async function getLabStarts(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    try {
      return privateJson(200, await readLabStarts(store, { nowMs: now() }));
    } catch (error) {
      context?.error?.(`cmsLabsStarts failed (${error?.code ?? 'error'})`);
      return privateJson(500, { error: 'Failed to read the lab start counts' });
    }
  };
}

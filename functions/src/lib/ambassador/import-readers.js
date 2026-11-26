/**
 * Import readers (ADR 0033 §4): how a document in another module becomes an
 * evidence row. One reader per source module — the container to read, the
 * query the import picker lists, and `toEvidence`, the snapshot of what the
 * source said at link time.
 */
import { isHttpUrl, toCalendarDate } from './model.js';
import {
  NEVER_PUBLIC_STATUSES,
  SQL_NOT_SOFT_DELETED,
  SQL_PUBLIC_CLAUSE,
  isPublicDocument,
} from '../public-read-rules.js';

/**
 * isPublicDocument's "never public" statuses, in SQL, so the picker lists no
 * draft the import would refuse. The same shape as public-content-manifest.js
 * SQL_NOT_OFF_SITE: `NOT IS_STRING` first (IN on a missing field is undefined
 * in Cosmos), then `NOT (… IN …)`.
 */
const SQL_NOT_NEVER_PUBLIC =
  '(NOT IS_STRING(c.contentStatus) OR NOT (c.contentStatus IN ' +
  `(${[...NEVER_PUBLIC_STATUSES].map((s) => `"${s}"`).join(', ')})))`;
import { parseCsv } from './csv.js';

export { parseCsv } from './csv.js';

const firstString = (doc, keys) => {
  for (const key of keys) {
    const value = doc?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const firstUrl = (doc, keys) => {
  const value = firstString(doc, keys);
  return isHttpUrl(value) ? value : null;
};

const NO_METRICS = () => ({ reach: null, attendees: null, views: null, credits: null });

/** The live-content predicate public-reads.js uses, so an import offers only what visitors can see. */
const LIVE_CONTENT_QUERY =
  'SELECT TOP 500 c.id, c.title, c.Title, c.publishedAt, c.publishedDate, c.cp_sortDate, c.publishedUrl, c.publicUrl, c.slugPageUrl, c.curatedSubpagePath, c.cloudProvider, c.type FROM c ' +
  // What visitors can open is what can be recorded (#1897): the public
  // site's own clauses, not a copy of them.
  `WHERE ${SQL_PUBLIC_CLAUSE} AND ${SQL_NOT_SOFT_DELETED} AND ${SQL_NOT_NEVER_PUBLIC}`;

/**
 * LIVE_CONTENT_QUERY's test, for one document read by id: the import may
 * file only what the picker could have offered (review of #1890: a request
 * naming an unpublished id was filed as evidence).
 */
export function isLiveContent(doc) {
  // The public site's rule (public-read-rules.js), so a piece can be recorded
  // exactly when a visitor can open it (#1897).
  return isPublicDocument(doc || null);
}

function speakingToEvidence(doc) {
  const title =
    firstString(doc, ['eventName', 'name', 'title', 'Title']) || `Speaking event ${doc.id}`;
  const date = toCalendarDate(doc.date);
  const url = firstUrl(doc, ['eventUrl', 'website', 'presentationUrl']);
  const attendance = Number(doc.attendance);
  return {
    title,
    date,
    url,
    snapshot: { title, date, url },
    metrics: { ...NO_METRICS(), attendees: Number.isFinite(attendance) ? attendance : null },
    technology: topicList(doc.topic),
    description: typeof doc.description === 'string' ? doc.description.slice(0, 8000) : '',
  };
}

function topicList(topic) {
  if (Array.isArray(topic)) return topic;
  return topic ? [String(topic)] : [];
}

function certificationToEvidence(doc) {
  const title = firstString(doc, ['name', 'Name']) || `Certification ${doc.id}`;
  const date = toCalendarDate(doc.issueDate || doc.issue_date);
  const url = firstUrl(doc, ['verifyUrl', 'verify_url']);
  const code = firstString(doc, ['code']);
  return {
    title,
    date,
    url,
    snapshot: { title, date, url },
    metrics: NO_METRICS(),
    technology: [firstString(doc, ['vendor', 'issuer'])].filter(Boolean),
    description: code ? `Exam ${code}` : '',
  };
}

function contentToEvidence(doc) {
  const title = firstString(doc, ['title', 'Title']) || `Article ${doc.id}`;
  const date = toCalendarDate(doc.publishedAt || doc.publishedDate || doc.cp_sortDate);
  const url = firstUrl(doc, ['publishedUrl', 'publicUrl', 'slugPageUrl']) || curatedUrl(doc);
  const type = firstString(doc, ['type']);
  return {
    title,
    date,
    url,
    snapshot: { title, date, url },
    metrics: NO_METRICS(),
    technology: [firstString(doc, ['cloudProvider'])].filter(Boolean),
    description: type ? `Published ${type}` : '',
  };
}

function curatedUrl(doc) {
  if (!doc.curatedSubpagePath) return null;
  return `https://hybridcloudworks.com/${String(doc.curatedSubpagePath).replace(/^\//, '')}`;
}

// ── CSV readers: a file the owner exports, pasted or uploaded ────────────────

/**
 * The most CSV text one import takes, in characters. The API answers 413
 * past it and the import dialog refuses the file or paste before sending;
 * frontend/src/components/admin/ambassador/ambassadorModel.js mirrors it.
 */
export const CSV_IMPORT_MAX_CHARS = 1_000_000;

/** Why a CSV row was not imported, as the import summary counts them. */
export const SKIP_REASONS = Object.freeze({
  classId: 'missing-class-id',
  courseOrDate: 'missing-course-or-date',
});

/** "MTM Class ID" → "mtmclassid", so a header matches however the export spells it. */
const headerKey = (header) =>
  String(header || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** The Metrics That Matter columns the reader uses, by the header keys each may carry. */
const MTM_COLUMNS = {
  classId: ['mtmclassid', 'classid', 'id'],
  course: ['coursename', 'course', 'coursetitle', 'title'],
  method: ['learningmethod', 'deliverymethod', 'method'],
  instructor: ['instructor', 'instructorname', 'trainer'],
  start: ['startdate', 'classstartdate', 'start'],
  end: ['enddate', 'classenddate', 'end'],
  location: ['location', 'city', 'country'],
  attendees: ['attendees', 'students', 'studentcount', 'numberofstudents', 'enrolled', 'learners'],
};

/** Each column's index in the header row, by the first matching key. */
function mtmColumnIndexes(header) {
  const keys = header.map(headerKey);
  return Object.fromEntries(
    Object.entries(MTM_COLUMNS).map(([column, names]) => [
      column,
      names.map((name) => keys.indexOf(name)).find((index) => index >= 0) ?? -1,
    ])
  );
}

/** An ISO day, or a slash date (M/D/YYYY, or D/M/YYYY when the first part cannot be a month). */
export function csvDate(value) {
  const text = String(value || '').trim();
  const iso = toCalendarDate(text);
  if (iso) return iso;
  const match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (!match) return null;
  const [, a, b, year] = match;
  const [month, day] = Number(a) > 12 ? [b, a] : [a, b];
  return toCalendarDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

/**
 * The Metrics That Matter classes-delivered export as evidence seeds: one
 * row per class, titled by the course, dated by the start date, the method,
 * instructor, dates and location in the description, attendees when the
 * export carries a count. `sourceId` is the MTM class id, which keeps the
 * import idempotent; a row without one is skipped (`missing-class-id`)
 * rather than keyed on course and date, which would merge two classes of
 * the same course on the same day. A row without a course name or start
 * date is skipped too (`missing-course-or-date`). `skipped` counts them and
 * `reasons` says why.
 */
export function mctClassesToEvidence(text) {
  const [header, ...lines] = parseCsv(text);
  if (!header) return { items: [], skipped: 0, reasons: {} };
  const at = mtmColumnIndexes(header);
  const items = [];
  const reasons = {};
  let skipped = 0;
  for (const cells of lines) {
    const read = (column) => (at[column] >= 0 ? String(cells[at[column]] ?? '').trim() : '');
    const row = mctRowToEvidence(read);
    if (row.skip) {
      skipped += 1;
      reasons[row.skip] = (reasons[row.skip] || 0) + 1;
    } else {
      items.push(row.item);
    }
  }
  return { items, skipped, reasons };
}

/** One class row, read through `read(column)`: `{ item }`, or `{ skip }` naming why it was left out. */
function mctRowToEvidence(read) {
  const classId = read('classId');
  const title = read('course').slice(0, 300);
  const date = csvDate(read('start'));
  if (!classId) return { skip: SKIP_REASONS.classId };
  if (!title || !date) return { skip: SKIP_REASONS.courseOrDate };
  const end = csvDate(read('end'));
  const attendees = Number(read('attendees'));
  const facts = [
    read('method'),
    read('instructor') && `Instructor ${read('instructor')}`,
    end && end !== date ? `${date} to ${end}` : date,
    read('location'),
  ].filter(Boolean);
  return {
    item: {
      sourceId: `mct-class:${classId}`,
      title,
      date,
      url: null,
      snapshot: { title, date, url: null },
      metrics: {
        ...NO_METRICS(),
        attendees: Number.isFinite(attendees) && attendees > 0 ? attendees : null,
      },
      technology: [],
      description: `MCT class delivered: ${facts.join(' · ')}`.slice(0, 8000),
    },
  };
}

/**
 * Readers for a file the owner exports and pastes into the import dialog;
 * each names the evidence source its rows are stored under and turns the
 * text into seeds with a `sourceId` the import can stay idempotent on.
 */
export const CSV_READERS = Object.freeze({
  'mct-classes': {
    label: 'MCT classes (Metrics That Matter CSV)',
    sourceModule: 'manual',
    toEvidence: mctClassesToEvidence,
  },
});

export const IMPORT_READERS = Object.freeze({
  speaking: {
    container: 'speakerevents',
    listQuery: 'SELECT TOP 500 * FROM c',
    toEvidence: speakingToEvidence,
  },
  certifications: {
    container: 'certifications',
    listQuery: 'SELECT TOP 500 * FROM c',
    toEvidence: certificationToEvidence,
  },
  content: {
    container: 'content',
    listQuery: LIVE_CONTENT_QUERY,
    // A reader whose list is filtered says so here too, so an id sent to the
    // import is held to the same rule as the list (evidence.js importFromSource).
    accepts: isLiveContent,
    toEvidence: contentToEvidence,
  },
});

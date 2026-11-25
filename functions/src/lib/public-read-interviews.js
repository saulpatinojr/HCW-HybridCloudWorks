/**
 * public-read-interviews.js — the interview reads (ADR 0040, D6). Each read takes the store and the
 * request; public-reads.js wires them into createPublicReadHandlers.
 */
import { errorFacts } from './http/error-response.js';
import {
  CONTENT_VISIBILITY_FIELDS,
  FETCH_WINDOW,
  SQL_NOT_SOFT_DELETED,
  SQL_PUBLIC_CLAUSE,
  isPublicDocument,
  json,
  projectFields,
  sqlProjection,
} from './public-read-rules.js';

/**
 * The public interview routes (ADR 0040, D6). An interview is a `content`
 * document of `type: 'interview'`, published through the one status machine,
 * and read live by /azure/interviews and /azure/interviews/<slug>.
 *
 * Two allowlists, pinned by public-reads.allowlist.test.js against the
 * frontend's `normalizeInterview` (the one validator of the interview shape):
 * the list carries what a card shows, the detail what the article renders.
 * Never `consent`, `provenance`, `interview`, `transcription`, the audio path
 * or any draft field: the guest's agreement, the recording and the jobs that
 * made the page are the owner's records, not the page.
 */
export const PUBLIC_INTERVIEW_LIST_FIELDS = Object.freeze([
  'slug',
  'title',
  'subtitle',
  'date',
  'guest',
  'tags',
  'publishedAt',
]);

export const PUBLIC_INTERVIEW_DETAIL_FIELDS = Object.freeze([
  ...PUBLIC_INTERVIEW_LIST_FIELDS,
  'bio',
  'image',
  'qa',
  'related',
  'updatedAt',
]);

/** The address of one interview, as the frontend spells it: lower-case words joined by hyphens. */
const INTERVIEW_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Documents sharing one slug the detail read looks through; the newest public one wins. */
const INTERVIEW_SLUG_CANDIDATES = 5;

/** `type` is matched lower-cased, so a legacy spelling cannot slip a document past the list. */
const INTERVIEW_TYPE_CLAUSE = 'LOWER(c.type) = @type';
const INTERVIEW_TYPE_PARAM = { name: '@type', value: 'interview' };
const INTERVIEW_LIST_PROJECTION = sqlProjection([
  ...PUBLIC_INTERVIEW_LIST_FIELDS,
  ...CONTENT_VISIBILITY_FIELDS,
]);
const INTERVIEW_DETAIL_PROJECTION = sqlProjection([
  ...PUBLIC_INTERVIEW_DETAIL_FIELDS,
  ...CONTENT_VISIBILITY_FIELDS,
]);

/** The one text, or '' — a nested value that is not a string is not carried. */
const textOf = (value) => (typeof value === 'string' ? value : '');
/** `{ title, url }` pairs, and nothing else a link object may carry. */
const linksOf = (list) =>
  Array.isArray(list)
    ? list.filter((l) => l && typeof l === 'object').map((l) => ({ title: textOf(l.title), url: textOf(l.url) }))
    : [];

/**
 * An interview projected to the public shape, nested objects included.
 *
 * `projectFields` copies a top-level value as stored, which is right for a
 * string and wrong for an object the admin writes editorial state into: the
 * Q&A editor keeps `needsReview` and speaker flags on each item, and a key a
 * later writer adds to `guest`, `image` or `related` would otherwise ride
 * along. So the nested shapes are written out here, field by field, exactly
 * as `frontend/src/lib/interviews.js` reads them, and the manifest route
 * uses the same function so the pre-rendered page and the live one agree.
 *
 * @param {object} doc a stored interview, or a projected row of one
 * @param {readonly string[]} fields the allowlist (list or detail)
 */
export function projectInterview(doc, fields) {
  const out = projectFields(doc, fields);
  for (const [field, project] of Object.entries(NESTED_INTERVIEW_FIELDS)) {
    if (out[field] !== undefined) out[field] = project(out[field]);
  }
  return out;
}

const isObjectValue = (value) => Boolean(value) && typeof value === 'object';

/** One Q&A item: the question, the answer, and a pull quote when it has one. */
const qaItem = (item) => ({
  q: textOf(item.q),
  a: textOf(item.a),
  ...(typeof item.pullQuote === 'string' && item.pullQuote ? { pullQuote: item.pullQuote } : {}),
});

/** How each nested interview field is written out, field by field. */
const NESTED_INTERVIEW_FIELDS = Object.freeze({
  guest: (guest) => (isObjectValue(guest) ? { name: textOf(guest.name), role: textOf(guest.role) } : null),
  image: (image) => (isObjectValue(image) ? { src: textOf(image.src), alt: textOf(image.alt) } : null),
  tags: (tags) => (Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : []),
  qa: (qa) => (Array.isArray(qa) ? qa.filter(isObjectValue).map(qaItem) : []),
  related: (value) => {
    const related = isObjectValue(value) ? value : {};
    return { labs: linksOf(related.labs), learn: linksOf(related.learn) };
  },
});

/** Newest interview first by its own date; the same day keeps a steady order by slug. */
const byInterviewDateDesc = (a, b) =>
  String(b.date || '').localeCompare(String(a.date || '')) ||
  String(a.slug || '').localeCompare(String(b.slug || ''));

/**
 * GET /api/public/interviews — every published interview, newest first,
 * projected to PUBLIC_INTERVIEW_LIST_FIELDS in SQL and again in code.
 * The public filter runs in SQL and `isPublicDocument` re-checks every
 * row, as listContent does. Cached five minutes like content, so an
 * unpublish is visible within that.
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function listInterviews(store, request, context) {
  try {
    const query =
      `SELECT TOP ${FETCH_WINDOW} ${INTERVIEW_LIST_PROJECTION} FROM c ` +
      `WHERE ${INTERVIEW_TYPE_CLAUSE} AND ${SQL_PUBLIC_CLAUSE} AND ${SQL_NOT_SOFT_DELETED}`;
    const rows = await store.queryDocs('content', query, [INTERVIEW_TYPE_PARAM]);
    const items = (Array.isArray(rows) ? rows : [])
      .filter(isPublicDocument)
      .filter((doc) => typeof doc.slug === 'string' && INTERVIEW_SLUG.test(doc.slug))
      .sort(byInterviewDateDesc)
      .map((doc) => projectInterview(doc, PUBLIC_INTERVIEW_LIST_FIELDS));
    return json(200, { success: true, items, total: items.length }, 300);
  } catch (error) {
    context.error('publicListInterviews failed:', errorFacts(error));
    return json(500, { error: 'Failed to list interviews' });
  }
}

/**
 * GET /api/public/interviews/{slug} — one published interview by its
 * slug, projected to PUBLIC_INTERVIEW_DETAIL_FIELDS. A slug that is not
 * shaped like one, a document that is not public and a document that
 * does not exist answer the identical 404 (header rule 1).
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function getInterview(store, request, context) {
  try {
    const slug = String(request.params.slug || '').trim();
    if (!slug || slug.length > 200 || !INTERVIEW_SLUG.test(slug)) {
      return json(404, { error: 'Interview not found' });
    }
    // The public clause in SQL too, so a handful of newer drafts sharing
    // the slug cannot fill the window and hide the published one; the
    // JS re-check stays the authority, as everywhere in this file.
    const rows = await store.queryDocs(
      'content',
      `SELECT TOP ${INTERVIEW_SLUG_CANDIDATES} ${INTERVIEW_DETAIL_PROJECTION} FROM c ` +
        `WHERE ${INTERVIEW_TYPE_CLAUSE} AND c.slug = @slug AND ${SQL_PUBLIC_CLAUSE} AND ${SQL_NOT_SOFT_DELETED} ` +
        'ORDER BY c._ts DESC',
      [INTERVIEW_TYPE_PARAM, { name: '@slug', value: slug }]
    );
    const match = (Array.isArray(rows) ? rows : []).find(isPublicDocument);
    if (!match) return json(404, { error: 'Interview not found' });
    return json(
      200,
      { success: true, item: projectInterview(match, PUBLIC_INTERVIEW_DETAIL_FIELDS) },
      300
    );
  } catch (error) {
    context.error('publicGetInterview failed:', errorFacts(error));
    return json(500, { error: 'Failed to get interview' });
  }
}

/**
 * developer-api/cfs.js — the call-for-speakers (CfS) rules of the Developer
 * API (ADR 0042): what a call and a talk proposal may hold, and what each
 * reader is shown. Pure; the handlers are in ./handlers.js.
 *
 * Both live in the `developer_events` container, partitioned on `/eventId`,
 * so one event's call and every proposal sent to it are one logical
 * partition: listing proposals for review is a single-partition query.
 *
 *   call       id `cfs-call:<eventId>`  docType 'cfs-call'
 *   proposal   id `<uuid>`              docType 'cfs-submission'
 *
 * OWNERSHIP. In Phase 1 there is no event record yet (event create is Phase
 * 2), so the call is what ties an event id to an organizer: the key that
 * first opens a call on an id owns it, and every other key is answered 404 on
 * that id, the same answer as an id with no call, so a key cannot tell
 * another organizer's event from an empty id. The ids of the site's own
 * published events are refused (handlers.js setCall), so no key can collect
 * proposals under one of them. What remains, accepted for Phase 1 and written
 * in the runbook: one organizer can take an id another meant to use first.
 * Phase 2 will require the event record to exist and belong to the key.
 *
 * NOTHING HERE PUBLISHES (ADR 0042 decision 6). An open call takes proposals;
 * accepting a proposal records the decision for the organizer and makes
 * nothing public. A proposal's text and the speaker's email are only ever
 * shown to the key that owns the call.
 */
import { DeveloperApiInputError } from './keys.js';

export const CFS_CONTAINER = 'developer_events';

/** Organizer-chosen event ids: lower-case letters, digits and hyphens. */
const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// One `@`, something on each side, a dot in the domain, no spaces. Not RFC
// 5322; a check that a person typed an address, not that it receives mail.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;

export const CALL_LIMITS = Object.freeze({ title: 200, description: 5000 });
export const SUBMISSION_LIMITS = Object.freeze({
  speakerName: 120,
  speakerEmail: 254,
  speakerBio: 2000,
  title: 200,
  abstract: 5000,
  format: 60,
});
/** The largest public proposal body read, in bytes. Bigger is refused before parsing. */
export const MAX_SUBMISSION_BYTES = 16 * 1024;
export const SUBMISSION_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);
export const REVIEW_DECISIONS = Object.freeze(['pending', 'accepted', 'rejected']);
export const MAX_REVIEW_NOTE = 2000;
/**
 * The most proposals one list answer carries, and how many it carries when
 * the caller sends no `limit`. A call with more is read page by page, with
 * the `nextCursor` each answer gives (readListPaging below).
 */
export const MAX_LISTED = 500;
/** The longest `cursor` read. A real one is a few hundred characters. */
export const MAX_CURSOR_CHARS = 4096;

/** Proposals per Cloudflare-verified caller per hour, across every call. */
export const SUBMISSIONS_PER_CLIENT_PER_HOUR = 5;
/** Proposals per call per hour, across every caller. */
export const SUBMISSIONS_PER_CALL_PER_HOUR = 100;

export const callDocId = (eventId) => `cfs-call:${eventId}`;
export const isEventId = (value) => typeof value === 'string' && EVENT_ID_RE.test(value);
export const isSubmissionId = (value) => typeof value === 'string' && UUID_RE.test(value);

const CURSOR_RE = /^[A-Za-z0-9_-]+$/;
// The database's continuation value travels back to it in a request header, and Node refuses a header value
// with a line break or a character outside Latin-1 by throwing. Printable ASCII only keeps that a 400 here.
const TOKEN_RE = /^[\x20-\x7E]+$/;
const BAD_CURSOR = 'cursor is not valid. Send the nextCursor of the previous answer unchanged, with the same status filter.';

/**
 * The `nextCursor` of a list answer: where the next page starts. It wraps the
 * database's own continuation value (the marker Cosmos DB gives back with a
 * page) together with the status filter the list was read with, so a cursor
 * cannot be replayed against a different filter. It holds no proposal data.
 */
export function encodeListCursor({ token, status = null }) {
  if (typeof token !== 'string' || !token) return null;
  return Buffer.from(JSON.stringify({ v: 1, s: status, t: token }), 'utf8').toString('base64url');
}

/** The continuation value inside a cursor, or a 400 sentence for anything this module did not make. */
export function decodeListCursor(value, status = null) {
  if (typeof value !== 'string' || value.length > MAX_CURSOR_CHARS || !CURSOR_RE.test(value)) {
    throw new DeveloperApiInputError(BAD_CURSOR);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new DeveloperApiInputError(BAD_CURSOR);
  }
  if (!isObject(parsed) || parsed.v !== 1 || typeof parsed.t !== 'string' || !TOKEN_RE.test(parsed.t) || (parsed.s ?? null) !== status) {
    throw new DeveloperApiInputError(BAD_CURSOR);
  }
  return parsed.t;
}

/**
 * GET .../submissions?limit=&cursor=: how many proposals this answer may
 * carry (1 to MAX_LISTED, MAX_LISTED when left out) and where it starts.
 *
 * @param {{ get?: (name: string) => string | null }} query
 * @param {string | null} status the status filter already validated
 * @returns {{ limit: number, continuationToken: string | null }}
 */
export function readListPaging(query, status = null) {
  const rawLimit = query?.get?.('limit');
  let limit = MAX_LISTED;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    if (!/^\d{1,4}$/.test(String(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LISTED) {
      throw new DeveloperApiInputError(`limit must be a whole number from 1 to ${MAX_LISTED}.`);
    }
    limit = Number(rawLimit);
  }
  const rawCursor = query?.get?.('cursor');
  const continuationToken =
    rawCursor === undefined || rawCursor === null || rawCursor === '' ? null : decodeListCursor(rawCursor, status);
  return { limit, continuationToken };
}

/** The counter keys in submission_quota, namespaced so they never share a bucket with other routes. */
export const clientQuotaKey = (clientHash) => `developer-cfs:client:${clientHash}`;
export const callQuotaKey = (eventId) => `developer-cfs:call:${eventId}`;

function text(value, name, max, { required = false, multiline = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DeveloperApiInputError(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new DeveloperApiInputError(`${name} must be text.`);
  const cleaned = multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim()
    : value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    if (required) throw new DeveloperApiInputError(`${name} is required.`);
    return null;
  }
  if (cleaned.length > max) throw new DeveloperApiInputError(`${name} must be at most ${max} characters.`);
  return cleaned;
}

/** An ISO date or date-time in the future, as an ISO string, or null. */
function futureInstant(value, name, nowMs) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new DeveloperApiInputError(`${name} must be an ISO date.`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new DeveloperApiInputError(`${name} must be an ISO date.`);
  if (ms <= nowMs) throw new DeveloperApiInputError(`${name} must be in the future.`);
  return new Date(ms).toISOString();
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * POST .../call-for-speakers: `{ action: 'open' | 'close', title?, description?, closesAt? }`.
 * Only these fields are read. On an open, a field that is left out keeps its
 * stored value, and a field sent as null or '' is cleared, so reopening a
 * call does not quietly drop its deadline.
 */
export function validateCallChange(body, nowMs) {
  if (!isObject(body)) throw new DeveloperApiInputError('Send a JSON object with action "open" or "close".');
  if (body.action !== 'open' && body.action !== 'close') {
    throw new DeveloperApiInputError('action must be "open" or "close".');
  }
  if (body.action === 'close') return { action: 'close' };
  const change = { action: 'open' };
  if (Object.hasOwn(body, 'title')) change.title = text(body.title, 'title', CALL_LIMITS.title);
  if (Object.hasOwn(body, 'description')) {
    change.description = text(body.description, 'description', CALL_LIMITS.description, { multiline: true });
  }
  if (Object.hasOwn(body, 'closesAt')) change.closesAt = futureInstant(body.closesAt, 'closesAt', nowMs);
  return change;
}

/** The call document after a change, from the stored one (or none) and the validated change. */
export function composeCall({ eventId, existing, change, user, nowIso }) {
  const base = existing || {
    id: callDocId(eventId),
    eventId,
    docType: 'cfs-call',
    organizerKeyId: user.developerKeyId,
    organizerName: user.name,
    createdAt: nowIso,
    openedAt: null,
    closedAt: null,
    title: null,
    description: null,
    closesAt: null,
  };
  if (change.action === 'close') {
    return { ...base, status: 'closed', closedAt: nowIso, updatedAt: nowIso, updatedBy: user.oid };
  }
  const keep = (field) => (Object.hasOwn(change, field) ? change[field] : (base[field] ?? null));
  const alreadyOpen = base.status === 'open';
  return {
    ...base,
    status: 'open',
    title: keep('title'),
    description: keep('description'),
    closesAt: keep('closesAt'),
    openedAt: alreadyOpen ? base.openedAt : nowIso,
    closedAt: alreadyOpen ? base.closedAt : null,
    updatedAt: nowIso,
    updatedBy: user.oid,
  };
}

/** Does this call belong to this key? A call with no owner belongs to nobody. */
export function ownsCall(call, user) {
  return Boolean(call && call.docType === 'cfs-call' && user?.developerKeyId && call.organizerKeyId === user.developerKeyId);
}

/** Is this call taking proposals right now? */
export function isCallOpen(call, nowMs) {
  if (!call || call.docType !== 'cfs-call' || call.status !== 'open') return false;
  if (!call.closesAt) return true;
  const closes = Date.parse(call.closesAt);
  return Number.isFinite(closes) && nowMs < closes;
}

/**
 * What the organizer is told about their call. `status` is what the organizer
 * set; `acceptingProposals` is whether the public route takes a proposal now,
 * which is false once `closesAt` has passed even while `status` is `open`.
 */
export function presentCall(call, nowMs) {
  return {
    eventId: call.eventId,
    status: call.status,
    acceptingProposals: isCallOpen(call, nowMs),
    title: call.title || null,
    description: call.description || null,
    closesAt: call.closesAt || null,
    openedAt: call.openedAt || null,
    closedAt: call.closedAt || null,
    updatedAt: call.updatedAt || null,
  };
}

/**
 * A speaker's email the way a proposal stores it (trimmed, lower-case), or a
 * 400 sentence. Used when a proposal is stored and when the owner searches
 * for one address's proposals (admin-handlers.js findProposals), so the
 * search looks for exactly what was stored.
 */
export function normalizeSpeakerEmail(value) {
  const speakerEmail = text(value, 'speakerEmail', SUBMISSION_LIMITS.speakerEmail, { required: true });
  if (!EMAIL_RE.test(speakerEmail)) throw new DeveloperApiInputError('speakerEmail must be an email address.');
  return speakerEmail.toLowerCase();
}

/**
 * POST .../call-for-speakers/submissions (public). Only the listed fields are
 * read. `website` is a honeypot: a field a person never sees on a form, so a
 * value there is a bot.
 */
export function validateSubmission(body) {
  if (!isObject(body)) throw new DeveloperApiInputError('Send a JSON object with your talk proposal.');
  if (body.website !== undefined && body.website !== null && body.website !== '') {
    throw new DeveloperApiInputError('The proposal could not be accepted.');
  }
  const speakerEmail = normalizeSpeakerEmail(body.speakerEmail);
  let level = null;
  if (body.level !== undefined && body.level !== null && body.level !== '') {
    if (!SUBMISSION_LEVELS.includes(body.level)) {
      throw new DeveloperApiInputError(`level must be one of: ${SUBMISSION_LEVELS.join(', ')}.`);
    }
    level = body.level;
  }
  return {
    speakerName: text(body.speakerName, 'speakerName', SUBMISSION_LIMITS.speakerName, { required: true }),
    speakerEmail,
    speakerBio: text(body.speakerBio, 'speakerBio', SUBMISSION_LIMITS.speakerBio, { multiline: true }),
    title: text(body.title, 'title', SUBMISSION_LIMITS.title, { required: true }),
    abstract: text(body.abstract, 'abstract', SUBMISSION_LIMITS.abstract, { required: true, multiline: true }),
    format: text(body.format, 'format', SUBMISSION_LIMITS.format),
    level,
  };
}

/** The stored proposal. Always pending when it arrives. */
export function composeSubmission({ eventId, value, id, nowIso }) {
  return {
    id,
    eventId,
    docType: 'cfs-submission',
    ...value,
    status: 'pending',
    submittedAt: nowIso,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
  };
}

/** PUT .../submissions/{submissionId}: `{ decision, note? }`. */
export function validateReview(body) {
  if (!isObject(body)) throw new DeveloperApiInputError('Send a JSON object with a decision.');
  if (!REVIEW_DECISIONS.includes(body.decision)) {
    throw new DeveloperApiInputError(`decision must be one of: ${REVIEW_DECISIONS.join(', ')}.`);
  }
  return { decision: body.decision, note: text(body.note, 'note', MAX_REVIEW_NOTE, { multiline: true }) };
}

/** What the organizer who owns the call is told about one proposal. */
export function presentSubmission(doc) {
  return {
    id: doc.id,
    eventId: doc.eventId,
    status: doc.status,
    speakerName: doc.speakerName || null,
    speakerEmail: doc.speakerEmail || null,
    speakerBio: doc.speakerBio || null,
    title: doc.title || null,
    abstract: doc.abstract || null,
    format: doc.format || null,
    level: doc.level || null,
    submittedAt: doc.submittedAt || null,
    reviewedAt: doc.reviewedAt || null,
    reviewNote: doc.reviewNote || null,
  };
}

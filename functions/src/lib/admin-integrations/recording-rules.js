/**
 * recording-rules.js — what a recording create or patch may carry
 * (RecordingsPage.jsx, the Recording Hub forms). Pure: the handlers are in
 * ./recordings.js, and admin-integrations.js re-exports the public names so
 * callers and tests import what they always did.
 *
 * Each field has one cleaner, `{ value }` or `{ error }`; a cleaner that
 * answers neither accepts the field without writing it. The create and
 * patch lists below run their cleaners in order, so the first bad field is
 * the one reported, and the fields both accept are checked the same way.
 */

/**
 * What `POST cms/recordings` accepts. #1181 (AP-B6) introduced the allowlist
 * and left out four keys the only two callers send on every save, so both
 * Recording Hub forms answered 400 from that deploy on: "route a Plaud
 * recording" (`recording-hub/recordingCards.jsx`: `recordedAt`, `source`,
 * `plaudId`, `status`) and the pasted-transcript form
 * (`recording-hub/uploadForms.jsx`: `source`, `status`). `source` is a real
 * field the hub renders (`recordingView.js` `sourceLabel`). Each is typed
 * below; `status` is accepted only as `new`, the value the server stamps
 * anyway, so the body still cannot choose a recording's state.
 */
export const RECORDING_CREATE_FIELDS = [
  'title',
  'transcript',
  'url',
  'summary',
  'audioUrl',
  'duration',
  'topics',
  'speakers',
  'metadata',
  'source',
  'plaudId',
  'recordedAt',
  'status',
];

/** The two ways an admin puts a recording into the container (`sourceLabel` names both). */
export const RECORDING_CREATE_SOURCES = ['plaud_mcp', 'manual_upload'];

/** A Plaud file id is an opaque short string; anything longer is not one. */
export const RECORDING_PLAUD_ID_MAX = 200;

export const RECORDING_PATCH_FIELDS = [
  'title',
  'transcript',
  'url',
  'summary',
  'audioUrl',
  'duration',
  'topics',
  'speakers',
  'metadata',
  'status',
  'contentId',
];

export const RECORDING_STATUSES = ['new', 'processing', 'routed', 'failed', 'archived'];

const RECORDED_AT_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** Epoch milliseconds as an ISO string, or null when not a finite moment. */
function epochToIso(raw) {
  const when = new Date(raw);
  return Number.isFinite(raw) && !Number.isNaN(when.getTime()) ? when.toISOString() : null;
}

/** Are the date and clock fields of a RECORDED_AT_SHAPE match in range (the day exists in its month)? */
function isRealMoment(match) {
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dateInRange = month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
  return dateInRange && Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59;
}

/**
 * `recordedAt` as an ISO string, or null when it is not a real moment.
 *
 * `new Date()` alone is not a validator: it rolls `2026-02-30` over to
 * 2 March, and it reads a time with no zone in the host's own zone, so the
 * same Plaud timestamp would be stored differently on a workstation and on
 * the Function App. So a string must be an ISO date, optionally with a time
 * and a zone, whose day exists in its month (checked before parsing) and
 * whose clock fields are in range; a time with no zone is read as UTC, the
 * zone every other stamp in this container uses. Epoch milliseconds are
 * accepted as a finite number.
 */
export function normaliseRecordedAt(raw) {
  if (typeof raw === 'number') return epochToIso(raw);
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const match = RECORDED_AT_SHAPE.exec(value);
  if (!match || !isRealMoment(match)) return null;
  const zone = match[7];
  const when = new Date(zone ? value.replace(' ', 'T') : `${value.replace(' ', 'T')}${match[4] ? '' : 'T00:00'}Z`);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

// ── one cleaner per field ────────────────────────────────────────────────────

const HTTP_URL = /^https?:\/\//i;

/** A link that may be cleared with null; anything else must be http(s). */
const httpUrlOrNull = (field) => (raw) => {
  if (raw !== null && !HTTP_URL.test(String(raw).trim())) {
    return { error: `${field} must be http(s) URL` };
  }
  return { value: raw ? String(raw).trim() : null };
};

/** An array of strings. */
const stringList = (field) => (raw) =>
  !Array.isArray(raw) || raw.some((item) => typeof item !== 'string')
    ? { error: `${field} must be an array of strings` }
    : { value: raw };

/** Text that may not be emptied. */
const requiredText = (field) => (raw) => {
  const text = String(raw || '').trim();
  return text ? { value: text } : { error: `${field} cannot be empty` };
};

function cleanDuration(raw) {
  const d = Number(raw);
  if (!Number.isFinite(d) || d < 0) return { error: 'duration must be a non-negative number' };
  return { value: d };
}

function cleanMetadata(raw) {
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    return { error: 'metadata must be an object' };
  }
  return { value: raw };
}

function cleanPlaudId(raw) {
  const plaudId = typeof raw === 'string' ? raw.trim() : '';
  if (!plaudId || plaudId.length > RECORDING_PLAUD_ID_MAX) {
    return { error: `plaudId must be a non-empty string of at most ${RECORDING_PLAUD_ID_MAX} characters` };
  }
  return { value: plaudId };
}

/** Plaud reports start_at / created_at; stored as ISO, like createdAt. A null is left out. */
function cleanRecordedAt(raw) {
  if (raw === null) return {};
  const recordedAt = normaliseRecordedAt(raw);
  if (!recordedAt) {
    return { error: 'recordedAt must be an ISO date string or epoch milliseconds' };
  }
  return { value: recordedAt };
}

/** The fields create and patch both accept, checked the same way, in this order. */
const SHARED_CLEANERS = [
  ['url', httpUrlOrNull('url')],
  ['audioUrl', httpUrlOrNull('audioUrl')],
  ['summary', (raw) => ({ value: String(raw || '').trim() })],
  ['duration', cleanDuration],
  ['topics', stringList('topics')],
  ['speakers', stringList('speakers')],
  ['metadata', cleanMetadata],
];

const CREATE_CLEANERS = [
  ...SHARED_CLEANERS,
  // The body may say `new`, because both forms do; it may not say anything
  // else. The handler stamps `status: 'new'` whatever arrives.
  ['status', (raw) => (raw === 'new' ? {} : { error: "status on create must be 'new'" })],
  [
    'source',
    (raw) =>
      RECORDING_CREATE_SOURCES.includes(raw)
        ? { value: raw }
        : { error: `source must be one of: ${RECORDING_CREATE_SOURCES.join(', ')}` },
  ],
  ['plaudId', cleanPlaudId],
  ['recordedAt', cleanRecordedAt],
];

const PATCH_CLEANERS = [
  [
    'status',
    (raw) =>
      RECORDING_STATUSES.includes(raw)
        ? { value: raw }
        : { error: `status must be one of: ${RECORDING_STATUSES.join(', ')}` },
  ],
  ['contentId', (raw) => ({ value: raw === null ? null : String(raw).trim() })],
  ['title', requiredText('title')],
  ['transcript', requiredText('transcript')],
  ...SHARED_CLEANERS,
];

/**
 * Run `cleaners` over the fields `source` carries, writing each accepted
 * value onto `out`. The first error sentence, or null.
 */
function applyCleaners(source, cleaners, out) {
  for (const [key, clean] of cleaners) {
    if (source[key] === undefined) continue;
    const cleaned = clean(source[key]);
    if (cleaned.error) return cleaned.error;
    if ('value' in cleaned) out[key] = cleaned.value;
  }
  return null;
}

/** The keys of `body` not in `allowed`, as the refusal sentence, or null. */
function unknownFieldsError(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  return unknown.length > 0 ? `Unknown field(s): ${unknown.join(', ')}` : null;
}

/** A create body as `{ doc }`, or `{ error }`. Title and transcript are required. */
export function validateRecordingCreate(body) {
  const unknown = unknownFieldsError(body, RECORDING_CREATE_FIELDS);
  if (unknown) return { error: unknown };
  const title = String(body.title || '').trim();
  const transcript = String(body.transcript || '').trim();
  if (!title || !transcript) {
    return { error: 'title and transcript are required' };
  }
  const doc = { title, transcript };
  const error = applyCleaners(body, CREATE_CLEANERS, doc);
  return error ? { error } : { doc };
}

/** A patch body (its `id` ignored) as `{ updates }`, or `{ error }`. */
export function validateRecordingPatch(body) {
  const { id: _ignored, ...updates } = body;
  const unknown = unknownFieldsError(updates, RECORDING_PATCH_FIELDS);
  if (unknown) return { error: unknown };
  if (Object.keys(updates).length === 0) {
    return { error: 'Body must contain at least one updatable field' };
  }
  const clean = {};
  const error = applyCleaners(updates, PATCH_CLEANERS, clean);
  return error ? { error } : { updates: clean };
}

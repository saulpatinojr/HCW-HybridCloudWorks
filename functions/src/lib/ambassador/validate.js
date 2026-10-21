/**
 * Ambassador validation (ADR 0033 §4): a program, application or evidence
 * body with every field cleaned, or an error sentence.
 *
 * Each kind is a schema — the field names a body may carry, each with the
 * function that cleans its value or refuses it. `validateWith` walks the
 * schema once: unknown keys are refused first, a `required` field is cleaned
 * on a full write even when absent (so "name is required" comes from the
 * field's own rule), and on a partial patch only the fields present are
 * touched. The handlers in ./handlers.js never see a value a rule did not
 * pass.
 */
import { AuthoredError, authoredMessage } from '../http/error-response.js';
import {
  cleanFiles,
  cleanLinks,
  cleanPeriod,
  isBlank,
  isRecord,
  optionalStr,
  str,
  stringList,
  wholeNumber,
} from './fields.js';
import {
  APPLICATION_STATUSES,
  MEMBERSHIP_STATUSES,
  EVIDENCE_SOURCES,
  QUESTION_KINDS,
  SCORING_UNITS,
  UPKEEP_PERIODS,
  VERIFICATION_STATUSES,
  isHttpUrl,
  toCalendarDate,
} from './model.js';

/** A field the API refuses; every sentence is written below (authored, #945). */
class FieldError extends AuthoredError {}

/** Refuse the value being cleaned with the sentence the API answers with. */
const refuse = (message) => {
  throw new FieldError(message);
};

// ── shared cleaners ───────────────────────────────────────────────────────────

/** A rule: `clean(value, { partial })` answers the stored value or refuses. */
const field = (clean, { required = false } = {}) => ({ clean, required });

const bounded = (max) => (value) => str(value, max);
const listOf = (max) => (value) => stringList(value, max);
const flag = (value) => value !== false;

const requiredText = (max, name) => (value) => str(value, max) || refuse(`${name} is required`);

const oneOf = (allowed, name) => (value) =>
  allowed.includes(value) ? value : refuse(`${name} must be one of ${allowed.join(', ')}`);

const optionalUrl = (name) => (value) => {
  const url = optionalStr(value, 2000);
  if (url && !isHttpUrl(url)) refuse(`${name} must be an http(s) URL`);
  return url;
};

/** A calendar day, or null when sent empty. */
const dayOrNull = (value, { key }) => {
  if (value === null || value === '') return null;
  return toCalendarDate(value) || refuse(`${key} must be a YYYY-MM-DD date`);
};

// ── the schema walker ─────────────────────────────────────────────────────────

/**
 * Clean `body` against `schema`. Unknown keys first; then every rule in
 * schema order, so the first refusal is the one the caller reads.
 *
 * @returns {{ value: object } | { error: string }}
 */
function validateWith(schema, body, { partial = false } = {}) {
  const unknown = Object.keys(body).filter((key) => !Object.hasOwn(schema.fields, key));
  if (unknown.length) return { error: `Unknown ${schema.name} field(s): ${unknown.join(', ')}` };
  const out = {};
  try {
    for (const [key, rule] of Object.entries(schema.fields)) {
      const wanted = key in body || (rule.required && !partial);
      if (wanted) out[key] = rule.clean(body[key], { partial, key });
    }
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    return { error: authoredMessage(error, 'A field was refused.') };
  }
  return { value: out };
}

// ── programs ──────────────────────────────────────────────────────────────────

function cleanRequirements(value) {
  if (!Array.isArray(value)) refuse('requirements must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') refuse(`requirements[${index}] must be an object`);
    const label = str(item.label, 200) || refuse(`requirements[${index}].label is required`);
    return {
      id: str(item.id, 80) || `req-${index + 1}`,
      label,
      description: str(item.description, 2000),
      evidenceTypes: stringList(item.evidenceTypes).filter((t) => EVIDENCE_SOURCES.includes(t)),
      minCount: wholeNumber(item.minCount),
      weight: Math.max(0, Number(item.weight) || 0),
    };
  });
}

function cleanWindow(value) {
  const w = isRecord(value) ? value : {};
  return {
    opens: toCalendarDate(w.opens),
    closes: toCalendarDate(w.closes),
    note: str(w.note, 500),
  };
}

function cleanReminders(value) {
  const r = isRecord(value) ? value : {};
  return {
    daysBeforeDeadline: wholeNumber(r.daysBeforeDeadline),
    daysBeforeRenewal: wholeNumber(r.daysBeforeRenewal),
  };
}

function cleanCustomFields(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((f) =>
      isRecord(f)
        ? { id: str(f.id, 80), label: str(f.label, 200), type: str(f.type, 40) || 'text' }
        : null
    )
    .filter((f) => f && f.id && f.label)
    .slice(0, 50);
}

const QUESTION_MAX = 200;

/** A whole number or null when unset; never zero, which would read as "no limit" anyway. */
const limitOrNull = (value) => (isBlank(value) ? null : wholeNumber(value) || null);

/**
 * The program's official application questions, in the form's order. Each
 * needs an id (unique within the program), a prompt and one of the kinds the
 * guided workspace renders; `options` serve choice, scale and links, `rows`
 * the scale grid, `maxChars` a text, `maxItems` links and activities, and
 * `allowOther` lets a choice take a typed value beside its options.
 */
function cleanApplicationQuestions(value) {
  if (!Array.isArray(value)) refuse('applicationQuestions must be an array');
  if (value.length > QUESTION_MAX)
    refuse(`applicationQuestions must hold at most ${QUESTION_MAX} questions`);
  const seen = new Set();
  return value.map((item, index) => {
    if (!isRecord(item)) refuse(`applicationQuestions[${index}] must be an object`);
    const id = str(item.id, 80) || refuse(`applicationQuestions[${index}].id is required`);
    if (seen.has(id)) refuse(`applicationQuestions[${index}].id "${id}" repeats an earlier one`);
    seen.add(id);
    const prompt =
      str(item.prompt, 1000) || refuse(`applicationQuestions[${index}].prompt is required`);
    const kind = QUESTION_KINDS.includes(item.kind)
      ? item.kind
      : refuse(`applicationQuestions[${index}].kind must be one of ${QUESTION_KINDS.join(', ')}`);
    return {
      id,
      section: str(item.section, 200),
      prompt,
      kind,
      maxChars: limitOrNull(item.maxChars),
      options: stringList(item.options, 100),
      allowOther: item.allowOther === true,
      rows: stringList(item.rows, 100),
      maxItems: limitOrNull(item.maxItems),
      hint: str(item.hint, 2000),
      required: item.required === true,
    };
  });
}

/** `{ unit: 'credits', tiers: [{ label, credits }] }`, or null for the usual item counts. */
function cleanScoring(value) {
  if (isBlank(value)) return null;
  if (!isRecord(value)) refuse('scoring must be an object or null');
  const unit = oneOf(SCORING_UNITS, 'scoring.unit')(value.unit);
  const tiers = (Array.isArray(value.tiers) ? value.tiers : [])
    .filter(isRecord)
    .map((tier) => ({ label: str(tier.label, 200), credits: wholeNumber(tier.credits) }))
    .filter((tier) => tier.label)
    .slice(0, 50);
  return { unit, tiers };
}

/**
 * What keeps a membership active: at least `minCount` items of evidence filed
 * under the program in every `period` (a calendar quarter or year), of
 * `evidenceTypes` (none means any source), and the program's own words on
 * where to log them. Null or empty clears it.
 */
function cleanUpkeep(value) {
  if (isBlank(value)) return null;
  if (!isRecord(value)) refuse('upkeep must be an object or null');
  const period = oneOf(UPKEEP_PERIODS, 'upkeep.period')(value.period);
  const minCount = wholeNumber(value.minCount);
  if (minCount < 1) refuse('upkeep.minCount must be at least 1');
  const evidenceTypes = stringList(value.evidenceTypes, 20).filter((type) =>
    EVIDENCE_SOURCES.includes(type)
  );
  return { period, minCount, evidenceTypes, note: str(value.note, 1000) };
}

const PROGRAM = {
  name: 'program',
  fields: {
    name: field(requiredText(200, 'name'), { required: true }),
    provider: field(bounded(200)),
    description: field(bounded(4000)),
    category: field(bounded(100)),
    applicationUrl: field(optionalUrl('applicationUrl')),
    eligibility: field(listOf(50)),
    criteria: field(listOf(50)),
    recommendedActivities: field(listOf(50)),
    evidenceTypes: field(listOf(50)),
    applicationWindow: field(cleanWindow),
    renewalCadence: field(bounded(100)),
    expirationRule: field(bounded(1000)),
    requirements: field(cleanRequirements),
    enabled: field(flag),
    order: field(wholeNumber),
    reminders: field(cleanReminders),
    customFields: field(cleanCustomFields),
    membershipStatus: field(oneOf(MEMBERSHIP_STATUSES, 'membershipStatus')),
    parentProgramId: field(bounded(200)),
    applicationQuestions: field(cleanApplicationQuestions),
    scoring: field(cleanScoring),
    upkeep: field(cleanUpkeep),
    // Where the program wants contributions logged (a shared sheet, a form).
    // The owner's to set: such a link is often private to the program's
    // members, so no seed carries one (programs.js).
    contributionTrackerUrl: field(optionalUrl('contributionTrackerUrl')),
  },
};

/** A program patch with every field cleaned, or an error sentence. */
export function validateProgram(body, options) {
  return validateWith(PROGRAM, body, options);
}

// ── applications ──────────────────────────────────────────────────────────────

const APPLICATION_DATE_FIELDS = [
  'applicationDate',
  'submissionDeadline',
  'decisionDate',
  'startDate',
  'expirationDate',
  'renewalDate',
];

/** A program may ask up to 200 questions; the free list before it held up to 100. Both fit, and more is refused rather than clipped. */
const RESPONSES_MAX = 300;

function cleanResponses(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > RESPONSES_MAX)
    refuse(`responses must hold at most ${RESPONSES_MAX} entries (${value.length} sent)`);
  return value
    .map((r) =>
      isRecord(r) ? { questionId: str(r.questionId, 120), text: str(r.text, 20000) } : null
    )
    .filter((r) => r && r.questionId);
}

function cleanBadgeUrl(value) {
  const url = optionalStr(value, 2000);
  if (url && !isHttpUrl(url) && !url.startsWith('/'))
    refuse('badgeImageUrl must be an http(s) URL or a site path');
  return url;
}

function cleanCustomValues(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([k, v]) => [str(k, 80), str(v, 4000)])
  );
}

const APPLICATION = {
  name: 'application',
  fields: {
    programId: field(requiredText(120, 'programId'), { required: true }),
    title: field(bounded(300)),
    status: field(oneOf(APPLICATION_STATUSES, 'status')),
    // `true` lets a super_admin set any status from Settings, outside the
    // transition table; applications.js checks the role and records it.
    statusOverride: field((value) => value === true),
    statusNote: field(bounded(2000)),
    qualificationPeriod: field(cleanPeriod),
    ...Object.fromEntries(APPLICATION_DATE_FIELDS.map((key) => [key, field(dayOrNull)])),
    notes: field(bounded(20000)),
    reviewerFeedback: field(bounded(20000)),
    responses: field(cleanResponses),
    files: field(cleanFiles),
    images: field(cleanFiles),
    links: field(cleanLinks),
    badgeImageUrl: field(cleanBadgeUrl),
    evidenceIds: field(listOf(500)),
    customValues: field(cleanCustomValues),
    private: field(flag),
  },
};

/** An application patch with every field cleaned, or an error sentence. */
export function validateApplication(body, options) {
  return validateWith(APPLICATION, body, options);
}

// ── evidence ──────────────────────────────────────────────────────────────────

function cleanMetrics(value) {
  const m = isRecord(value) ? value : {};
  const num = (v) => (isBlank(v) || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    reach: num(m.reach),
    attendees: num(m.attendees),
    views: num(m.views),
    credits: num(m.credits),
  };
}

function cleanSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    title: str(value.title, 300),
    date: toCalendarDate(value.date),
    url: isHttpUrl(value.url) ? str(value.url, 2000) : null,
    capturedAt: value.capturedAt ? String(value.capturedAt) : null,
  };
}

/** Required on a full write; a partial patch may clear it. */
function cleanEvidenceDate(value, { partial }) {
  if (isBlank(value)) return partial ? null : refuse('date is required (YYYY-MM-DD)');
  return toCalendarDate(value) || refuse('date must be a YYYY-MM-DD date');
}

const cleanSourceModule = (value) => oneOf(EVIDENCE_SOURCES, 'sourceModule')(value || 'manual');

const EVIDENCE = {
  name: 'evidence',
  fields: {
    title: field(requiredText(300, 'title'), { required: true }),
    description: field(bounded(8000)),
    date: field(cleanEvidenceDate, { required: true }),
    sourceModule: field(cleanSourceModule, { required: true }),
    sourceId: field((value) => optionalStr(value, 300)),
    snapshot: field(cleanSnapshot),
    url: field(optionalUrl('url')),
    files: field(cleanFiles),
    images: field(cleanFiles),
    metrics: field(cleanMetrics),
    technology: field(listOf(50)),
    programIds: field(listOf(50)),
    // The one requirement this row counts toward (readiness.js); null counts
    // toward every requirement whose evidence types include the row's source.
    requirementId: field((value) => optionalStr(value, 100)),
    tags: field(listOf(50)),
    qualificationPeriod: field(cleanPeriod),
    verificationStatus: field(oneOf(VERIFICATION_STATUSES, 'verificationStatus')),
    notes: field(bounded(8000)),
  },
};

/** An evidence patch with every field cleaned, or an error sentence. */
export function validateEvidence(body, options) {
  return validateWith(EVIDENCE, body, options);
}

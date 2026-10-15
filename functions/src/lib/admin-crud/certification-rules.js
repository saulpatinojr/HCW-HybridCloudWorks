/**
 * certification-rules.js — what a certification write may carry (ADR 0033
 * §4, Spotlight slice). Pure: the handlers are in ./certifications.js, and
 * admin-crud.js re-exports the public names so callers and tests are
 * unchanged.
 */
import { isValidBlobPath } from '../blob-paths.js';

const CERT_DATE_FIELDS = ['issueDate', 'expDate', 'renewalDate'];
const CERT_URL_FIELDS = ['verifyUrl', 'learnUrl'];

/**
 * A calendar date as plain `YYYY-MM-DD`, from a day, a timestamp (its
 * leading day) or a Date; null for nothing usable. Dates used to be stored
 * as UTC midnight and shown a day early west of Greenwich (ADR 0033 §1).
 */
export function toCalendarDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  const head = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return null;
  const [y, m, d] = head.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === head ? head : null;
}

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
/** An uploaded badge is stored site-relative (`/api/public/media/…`, blob-paths.js). */
const isImageRef = (value) =>
  isHttpUrl(value) || (typeof value === 'string' && /^\/[^\s]+$/.test(value.trim()));

/** One evidence or related-learning entry as `{ label, url }`, or null for an unusable one. */
function cleanLink(item) {
  if (typeof item === 'string') {
    return isHttpUrl(item) ? { label: item.trim(), url: item.trim() } : null;
  }
  if (!item || typeof item !== 'object' || !isHttpUrl(item.url)) return null;
  const url = String(item.url).trim();
  return {
    label:
      String(item.label || '')
        .trim()
        .slice(0, 200) || url,
    url,
  };
}

function cleanLinkList(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanLink).filter(Boolean).slice(0, max);
}

export const CERTIFICATION_FIELDS = Object.freeze([
  'id',
  'name',
  'Name',
  'issuer',
  'Issuer',
  'issueDate',
  'issue_date',
  'IssueDate',
  'expDate',
  'exp_date',
  'ExpDate',
  'renewalDate',
  'certState',
  'isValid',
  'is_valid',
  'cert_state',
  'code',
  'Code',
  'verifyUrl',
  'verify_url',
  'VerifyUrl',
  'learnUrl',
  'image',
  'Image',
  'badge',
  'Badge',
  'imageUrl',
  'credentialImage',
  'displayOrder',
  'display_order',
  'DisplayOrder',
  'tags',
  'Tags',
  'featured',
  'Featured',
  'display',
  'Display',
  'evidence',
  'relatedLearning',
  'renewalRequirements',
  'status',
  'notes',
]);

/**
 * The certification fields a write may carry, cleaned, or an error
 * sentence (AP-B6). Unknown keys are refused. Every field that has a shape
 * is checked: dates become calendar days and the expiry may not precede the
 * issue date, URLs must be http(s), display_order is a whole number.
 */
export function validateCertification(body, existing = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object' };
  }
  const unknown = Object.keys(body).filter((key) => !CERTIFICATION_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s) for certification: ${unknown.join(', ')}` };
  }
  if (body.display !== undefined && typeof body.display !== 'boolean') {
    return { error: 'display must be a boolean' };
  }
  if (body.featured !== undefined && typeof body.featured !== 'boolean') {
    return { error: 'featured must be a boolean' };
  }
  const out = { ...body };
  delete out.id;
  for (const step of CERT_STEPS) {
    const error = step(out, existing);
    if (error) return { error };
  }
  return { value: out };
}

const isBlank = (value) => value === undefined || value === null || value === '';

/** One date field cleaned in place to a calendar day (null stays null): the error sentence, or null. */
function cleanCertDate(out, key) {
  if (out[key] === null || out[key] === '') {
    out[key] = null;
    return null;
  }
  const day = toCalendarDate(out[key]);
  if (!day) return `${key} must be a YYYY-MM-DD date`;
  out[key] = day;
  return null;
}

/** Does the expiry precede the issue date, reading from `existing` what a partial patch left out? */
function expiryBeforeIssue(out, existing) {
  const issue = 'issueDate' in out ? out.issueDate : toCalendarDate(existing?.issueDate);
  const exp = 'expDate' in out ? out.expDate : toCalendarDate(existing?.expDate);
  return Boolean(issue && exp && exp < issue);
}

/** Each step cleans `out` in place and answers an error sentence, or null. */
function cleanCertDates(out, existing) {
  for (const key of CERT_DATE_FIELDS) {
    const error = key in out ? cleanCertDate(out, key) : null;
    if (error) return error;
  }
  return expiryBeforeIssue(out, existing) ? 'expDate must be on or after issueDate' : null;
}

function cleanCertUrls(out) {
  for (const key of CERT_URL_FIELDS) {
    if (isBlank(out[key])) continue;
    if (!isHttpUrl(out[key])) return `${key} must be an http(s) URL`;
    out[key] = String(out[key]).trim();
  }
  if (isBlank(out.imageUrl)) return null;
  if (!isImageRef(out.imageUrl)) return 'imageUrl must be an http(s) URL or an uploaded media path';
  out.imageUrl = String(out.imageUrl).trim();
  return null;
}

function cleanDisplayOrder(out) {
  const order = 'display_order' in out ? out.display_order : null;
  if (order === null || order === undefined) return null;
  const n = Number(out.display_order);
  if (!Number.isInteger(n) || n < 0) return 'display_order must be a whole number of 0 or more';
  out.display_order = n;
  return null;
}

function cleanCertLists(out) {
  if ('evidence' in out) out.evidence = cleanLinkList(out.evidence);
  if ('relatedLearning' in out) out.relatedLearning = cleanLinkList(out.relatedLearning);
  if ('renewalRequirements' in out && out.renewalRequirements !== null) {
    out.renewalRequirements = String(out.renewalRequirements).trim().slice(0, 4000);
  }
  return null;
}

/** In the order their errors are reported. */
const CERT_STEPS = [cleanCertDates, cleanCertUrls, cleanDisplayOrder, cleanCertLists];

/**
 * A POST body as the certification it creates: `{ value }` or `{ error }`.
 * Name is the page's one required field.
 */
export function checkNewCertification(body) {
  if (!body) return { error: 'Body must be a JSON object' };
  if (!String(body.name || '').trim()) return { error: 'name is required' };
  return validateCertification(body);
}

/** `{docId}/images/…` inside the certifications container — the only shape the editor uploads. */
export function isCertImagePath(path) {
  return isValidBlobPath(path) && /^[^/]+\/images\/[^/]+$/.test(path);
}

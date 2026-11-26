/**
 * The Cloudflare page's DNS form, its pure half (#1905): a record's form,
 * the body it sends, and the lock a name carries. Re-exported from
 * cloudflareView.js.
 */
import { dnsNameLock } from './cloudflareLocks';

// ── DNS ──────────────────────────────────────────────────────────────────────

/** The record types the form offers. Others are listed but changed in the dashboard. */
export const DNS_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);
/** The types Cloudflare can proxy (pass visitors through its network). */
export const PROXIABLE_TYPES = Object.freeze(['A', 'AAAA', 'CNAME']);
/** TTL 1 is Cloudflare's "Automatic"; anything else is seconds, 60 to 86400. */
export const AUTO_TTL = 1;

export function ttlText(ttl) {
  if (ttl === AUTO_TTL || ttl === undefined || ttl === null) return 'Automatic';
  return `${ttl} s`;
}

/** The form's starting values for a new record, or for an existing one. */
export function dnsForm(record = null) {
  return {
    type: record?.type ?? 'A',
    name: record?.name ?? '',
    content: record?.content ?? '',
    ttl: String(record?.ttl ?? AUTO_TTL),
    proxied: record?.proxied === true,
    comment: record?.comment ?? '',
    priority:
      record?.priority === undefined || record?.priority === null ? '' : String(record.priority),
  };
}

/** A form field as trimmed text, whatever it held. */
const field = (form, key) => String(form?.[key] ?? '').trim();

/** A whole number from `low` to `high` written in `text`, or null. */
function wholeNumber(text, low, high) {
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number >= low && number <= high ? number : null;
}

/** The TTL a form says, checked: 1 for Automatic, or 60 to 86400 seconds. */
function formTtl(form) {
  const text = field(form, 'ttl') || String(AUTO_TTL);
  const ttl = text === String(AUTO_TTL) ? AUTO_TTL : wholeNumber(text, 60, 86400);
  if (ttl === null) {
    throw new Error('TTL is 1 for Automatic, or a whole number of seconds from 60 to 86400.');
  }
  return ttl;
}

/** The text fields a record cannot be without, checked, in the order the form shows them. */
function requiredFields(form) {
  const type = field(form, 'type');
  if (!DNS_TYPES.includes(type)) throw new Error(`Choose a type: ${DNS_TYPES.join(', ')}.`);
  const name = field(form, 'name');
  if (!name) throw new Error('Enter the name, for example "lab" or "@" for the zone itself.');
  const content = field(form, 'content');
  if (!content) throw new Error('Enter the content: the address or text the record points to.');
  return { type, name, content };
}

/**
 * The body a form sends, checked: the request body for a new record. Throws
 * a sentence the form shows when something is missing or out of range.
 */
export function dnsRecordBody(form) {
  const body = { ...requiredFields(form), ttl: formTtl(form) };
  if (PROXIABLE_TYPES.includes(body.type)) body.proxied = form?.proxied === true;
  const comment = field(form, 'comment');
  if (comment) body.comment = comment;
  if (body.type === 'MX') {
    body.priority = wholeNumber(field(form, 'priority'), 0, 65535);
    if (body.priority === null) {
      throw new Error('An MX record needs a priority, a whole number from 0 to 65535.');
    }
  }
  return body;
}

/** Whether a record's type can be changed from this page (DNS_TYPES). */
export const editableType = (record) => DNS_TYPES.includes(record?.type);

/**
 * What the add or edit form says right now: the body it would send, or the
 * sentence that stops it (a missing field, or a locked name), and whether
 * an edit changed nothing at all.
 */
export function dnsDialogCheck({ record = null, form, status = null }) {
  let body = null;
  let problem = '';
  try {
    body = record ? dnsRecordPatch(record, form) : dnsRecordBody(form);
  } catch (err) {
    problem = err.message;
  }
  const lock = field(form, 'name') ? dnsNameLock(form.name, { status }) : null;
  if (!problem && lock) problem = `That name is locked. ${lock}`;
  const nothingChanged = Boolean(record && body && Object.keys(body).length === 0);
  return { body, problem, nothingChanged };
}

/**
 * Only what changed between a record and its edited form, so an edit sends
 * the fields the owner touched and nothing else. The type is not changed
 * from here. Throws like dnsRecordBody; an empty object means nothing changed.
 */
export function dnsRecordPatch(record, form) {
  const next = dnsRecordBody({ ...form, type: record.type });
  const patch = {};
  if (next.name !== record.name) patch.name = next.name;
  if (next.content !== record.content) patch.content = next.content;
  if (next.ttl !== record.ttl) patch.ttl = next.ttl;
  if ('proxied' in next && next.proxied !== (record.proxied === true)) patch.proxied = next.proxied;
  if ((next.comment ?? '') !== (record.comment ?? '')) patch.comment = next.comment ?? '';
  if ('priority' in next && next.priority !== record.priority) patch.priority = next.priority;
  return patch;
}

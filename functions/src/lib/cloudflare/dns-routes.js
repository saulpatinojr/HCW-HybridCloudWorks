/**
 * cloudflare/dns-routes.js — the Cloudflare page's DNS routes (#1905): list
 * every record, add one, edit one. There is no delete.
 *
 * A name a caller sends is checked strictly (protected.js checkDnsName: no
 * empty part, `@` only on its own, `*` only as the whole first part) and
 * written in full inside the zone the request names (#1911); that full name
 * is what the zone's protected list is checked against and what is sent to
 * Cloudflare, so the two can never differ.
 *
 * Only A, AAAA, CNAME, MX and TXT records are added or edited here. An edit
 * reads the record first and is refused when its current type is another
 * one, or its current name (or the new one) is protected.
 *
 * The audit row names the record's type and name and its `proxied` and
 * `ttl` before and after. It never holds the content (an address, or text
 * that may prove ownership of something).
 *
 * After an edit, the saved record's name is checked against the protected
 * list once more. Cloudflare's DNS edit cannot be made conditional, so a
 * record someone renamed onto a protected name between our read and our
 * write would otherwise pass unnoticed: the change is still recorded, the
 * owner's phone is told whoever made it, and the answer says
 * `protectedAfterWrite: true`.
 */
import { bad, bodyOf, json, paramOf, protectedRefusal, refuseUnknownFields } from './input.js';
import { recordChange, requireOurZone } from './record.js';
import { checkDnsName, dnsNameProtection, normalizeDnsName, otherManagedZone } from './protected.js';

/** The record types the page may add or edit. Others are read-only here. */
export const DNS_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'MX', 'TXT']);
export const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;

function typeValue(value) {
  const type = String(value ?? '').toUpperCase();
  if (!DNS_TYPES.includes(type)) throw bad(`type must be one of ${DNS_TYPES.join(', ')}.`);
  return type;
}

/**
 * Refuses (400) a name that belongs to the other managed zone (#1911): sent
 * here it would be made inside this zone under a confusing name, so the
 * caller is told to pick that zone instead.
 */
function refuseOtherZone(value, zoneName) {
  const other = otherManagedZone(value, zoneName);
  if (other) throw bad(`name ends with ${other}, which is its own zone: send it with zone=${other} (or pick that zone on the page) to change it there.`);
}

/** The name, checked strictly and written in full inside the zone (the name that is checked is the name that is sent). */
function nameValue(value, zoneName) {
  if (typeof value !== 'string' || !value.trim() || value.length > 253) throw bad('name must be a DNS name of 1 to 253 characters.');
  if (!/^[A-Za-z0-9*_.@-]+$/.test(value.trim())) throw bad('name may hold only letters, digits, dots, hyphens, underscores, @ and *.');
  refuseOtherZone(value, zoneName);
  const checked = checkDnsName(value, zoneName);
  if (checked.problem) throw bad(checked.problem);
  return checked.name;
}

function contentValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw bad('content must be text of 1 to 4096 characters.');
  return value.trim();
}

const isTtl = (value) => Number.isInteger(value) && (value === 1 || (value >= 60 && value <= 86400));
function ttlValue(value) {
  if (!isTtl(value)) throw bad('ttl must be 1 (automatic) or a whole number of seconds from 60 to 86400.');
  return value;
}

function proxiedValue(value) {
  if (typeof value !== 'boolean') throw bad('proxied must be true or false.');
  return value;
}

function commentValue(value) {
  if (typeof value !== 'string' || value.length > 100) throw bad('comment must be text of at most 100 characters.');
  return value;
}

function priorityValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw bad('priority must be a whole number from 0 to 65535.');
  return value;
}

/** Each field a create or an edit may carry: whether a create needs it, and its check. */
const FIELD_RULES = Object.freeze({
  type: { required: true, read: typeValue },
  name: { required: true, read: nameValue },
  content: { required: true, read: contentValue },
  ttl: { required: false, read: ttlValue },
  proxied: { required: false, read: proxiedValue },
  comment: { required: false, read: commentValue },
  priority: { required: false, read: priorityValue },
});

/** The DNS fields a create (`partial: false`) or an edit (`partial: true`) carries, checked one by one. */
export function dnsFields(body, { partial, zoneName }) {
  refuseUnknownFields(body, Object.keys(FIELD_RULES));
  const out = {};
  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    const skip = body[field] === undefined && (partial || !rule.required);
    if (!skip) out[field] = rule.read(body[field], zoneName);
  }
  if (partial && Object.keys(out).length === 0) throw bad('Send at least one field to change.');
  return out;
}

const pickDns = (record, zoneName) => ({
  id: record?.id ?? null,
  type: record?.type ?? null,
  name: record?.name ?? null,
  content: record?.content ?? null,
  proxied: record?.proxied ?? null,
  ttl: record?.ttl ?? null,
  comment: record?.comment ?? null,
  priority: record?.priority ?? null,
  locked: dnsNameProtection(record?.name, zoneName) !== null,
  lockedReason: dnsNameProtection(record?.name, zoneName),
});

/** What the audit row keeps of a record: never its content. */
const routing = (record) => ({ proxied: record?.proxied ?? null, ttl: record?.ttl ?? null });

/** GET cms/cloudflare/dns. Every record, up to the client's page cap; `truncated` when the zone holds more. */
export async function listDns({ client, zone }) {
  const { records, truncated } = await client.listDns();
  return json(200, { ok: true, records: records.map((record) => pickDns(record, zone.name)), truncated });
}

/** Refuses a name protected in the zone (409, with the reason). */
function refuseProtectedName(lead, name, zoneName) {
  const reason = dnsNameProtection(name, zoneName);
  if (reason) throw protectedRefusal(lead, reason);
}

/** POST cms/cloudflare/dns. */
export async function createDns(call) {
  const { request, client, zone } = call;
  const fields = dnsFields(await bodyOf(request), { partial: false, zoneName: zone.name });
  refuseProtectedName('That name is protected', fields.name, zone.name);
  await requireOurZone(client, zone.name);
  const created = await client.createDns(fields);
  const name = created?.name || fields.name;
  const details = { family: 'dns', change: 'create', recordType: fields.type, name, before: null, after: routing(created) };
  const audited = await recordChange(call, details, `added the ${fields.type} record ${name} in Cloudflare.`);
  return json(201, { ok: true, record: pickDns(created, zone.name), audited });
}

/** The record id in the path, checked. */
function recordIdOf(request) {
  const recordId = paramOf(request, 'recordId').toLowerCase();
  if (!RECORD_ID_PATTERN.test(recordId)) throw bad('The record id must be 32 hexadecimal characters.');
  return recordId;
}

/** Refuses an edit to a record of a type this page does not edit, or whose current name is protected. */
function refuseCurrent(current, zoneName) {
  const type = String(current?.type ?? '').toUpperCase();
  if (!DNS_TYPES.includes(type)) {
    const reason = `${type || 'This kind of'} records are changed in the Cloudflare dashboard; this page edits only ${DNS_TYPES.join(', ')} records.`;
    throw protectedRefusal('That record is read-only here', reason);
  }
  refuseProtectedName('That record is protected', current?.name, zoneName);
}

/**
 * Refuses an edit that asks for a different record type. Cloudflare does not
 * change a record's type in place, and the page keeps the type fixed, so a
 * new type means a new record.
 */
function refuseTypeChange(current, changes) {
  if (changes.type === undefined) return;
  if (changes.type !== String(current?.type ?? '').toUpperCase()) {
    throw bad("A record's type cannot be changed. Add a new record of the type you need, and remove the old one in the Cloudflare dashboard.");
  }
}

/** The audit row's details for an edit: type, name (and the old one when renamed), proxied and ttl before and after. */
function editDetails(current, changes, updated, zoneName) {
  const after = { ...current, ...changes, ...updated };
  const renamed = changes.name !== undefined && normalizeDnsName(current?.name, zoneName) !== changes.name;
  return {
    family: 'dns',
    change: 'edit',
    recordType: after.type ?? null,
    name: after.name ?? null,
    ...(renamed ? { previousName: current?.name ?? null } : {}),
    before: routing(current),
    after: routing(updated),
  };
}

/**
 * The sentence for a record that came back from the edit under a protected
 * name, or null. Cloudflare's DNS edit has no "only if unchanged" option, so
 * a record renamed onto a protected name between our read and our write is
 * caught here, after the fact: the change is still recorded, and the owner
 * is told to check it.
 */
function protectedAfterWriteNote(updated, zoneName) {
  const name = updated?.name;
  if (dnsNameProtection(name, zoneName) === null) return null;
  return `The record now carries the protected name ${name}, which this page never edits. Check it in the Cloudflare dashboard.`;
}

/** PATCH cms/cloudflare/dns/{recordId}. */
export async function patchDns(call) {
  const { request, client, context, zone } = call;
  const recordId = recordIdOf(request);
  const changes = dnsFields(await bodyOf(request), { partial: true, zoneName: zone.name });
  if (changes.name !== undefined) refuseProtectedName('That name is protected', changes.name, zone.name);
  await requireOurZone(client, zone.name);
  const current = await client.getDns(recordId);
  refuseCurrent(current, zone.name);
  refuseTypeChange(current, changes);
  const updated = await client.patchDns(recordId, changes);
  const note = protectedAfterWriteNote(updated, zone.name);
  if (note) context?.warn?.('[cloudflare] dns-edit: the saved record carries a protected name');
  const details = { ...editDetails(current, changes, updated, zone.name), ...(note ? { protectedAfterWrite: true } : {}) };
  const audited = await recordChange(call, details, `edited the ${details.recordType} record ${details.name} in Cloudflare.`, note ? [note] : []);
  return json(200, { ok: true, record: pickDns(updated, zone.name), audited, protectedAfterWrite: Boolean(note) });
}

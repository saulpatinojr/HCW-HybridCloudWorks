/** Turning Cloudflare audit log entries into DNS record changes the DNS audit can judge (cloudflare-dns-audit.mjs). */
import { ZONE_NAME } from './dns-audit-settings.mjs';

/** `alice@example.com` -> `a***@example.com`; anything without an `@` is returned as is. */
export function maskEmail(email) {
  const text = String(email ?? '');
  const at = text.indexOf('@');
  if (at < 1) return text;
  return `${text[0]}***${text.slice(at)}`;
}

export const str = (value) => (typeof value === 'string' ? value : '');
export const lower = (value) => str(value).toLowerCase();

/** create | update | delete | view | '' from the entry's action type, else from the HTTP method. */
export function actionType(entry) {
  const type = lower(entry?.action?.type);
  if (type) return type;
  const method = str(entry?.raw?.method).toUpperCase();
  return Object.hasOwn(ACTION_BY_METHOD, method) ? ACTION_BY_METHOD[method] : '';
}

/** The action an HTTP method stands for, when the entry names no action type. */
const ACTION_BY_METHOD = Object.freeze({ POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete', GET: 'view' });

/** The actions that change a record. */
const CHANGING_ACTIONS = new Set(['create', 'update', 'delete']);

/**
 * Is this entry about a DNS record? The resource's product or type says so
 * (`dns` / `dns_record`); the request URI (`/zones/<id>/dns_records…`) is the
 * fallback for an entry whose resource block is thin.
 */
export function isDnsRecordEntry(entry) {
  const product = lower(entry?.resource?.product);
  const type = lower(entry?.resource?.type);
  const uri = lower(entry?.raw?.uri);
  if (/dns_?record/.test(type)) return true;
  if (product === 'dns' && (type === '' || /record/.test(type))) return true;
  return /\/zones\/[^/]+\/dns_records(\/|\?|$)/.test(uri);
}

/** Is this entry on the production zone: by id when one is known, by name always. */
export function isProductionZone(entry, zoneId = '') {
  const id = str(entry?.zone?.id);
  const name = lower(entry?.zone?.name).replace(/\.$/, '');
  if (zoneId && id === zoneId) return true;
  if (name === ZONE_NAME) return true;
  if (zoneId && str(entry?.raw?.uri).includes(`/zones/${zoneId}/`)) return true;
  return false;
}

/**
 * The record's type and name, from wherever the entry carries them: the
 * response body, its `result`, the request body, or a `value` block. A delete
 * usually carries neither, which `normalise` fills from a sibling entry on the
 * same resource id.
 */
export function recordFields(entry) {
  const resource = entry?.resource ?? {};
  const candidates = [resource.response, resource.response?.result, resource.request, resource.value, resource.metadata];
  let name = '';
  let type = '';
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    if (!name && typeof c.name === 'string') name = c.name;
    if (!type && typeof c.type === 'string') type = c.type;
    if (name && type) break;
  }
  return { name: name.replace(/\.$/, ''), type: type.toUpperCase() };
}

/**
 * One DNS-record change, flattened to what the allowlist and the report
 * need. `siblings` are the other entries of the same read, for a delete that
 * names its resource id and nothing else.
 */
export function normalise(entry, siblings = []) {
  const actor = entry?.actor ?? {};
  const fields = recordFields(entry);
  let nameSource = 'entry';
  const resourceId = str(entry?.resource?.id);
  if ((!fields.name || !fields.type) && resourceId) {
    const sibling = siblings.find((s) => s !== entry && str(s?.resource?.id) === resourceId && recordFields(s).name);
    if (sibling) {
      const from = recordFields(sibling);
      fields.name = fields.name || from.name;
      fields.type = fields.type || from.type;
      nameSource = 'sibling';
    }
  }
  return {
    id: str(entry?.id),
    time: str(entry?.action?.time),
    actionType: actionType(entry),
    result: lower(entry?.action?.result) || 'unknown',
    actorType: lower(actor.type),
    actorContext: lower(actor.context),
    actorEmail: str(actor.email),
    actorId: str(actor.id),
    actorIp: str(actor.ip_address),
    tokenName: str(actor.token_name),
    tokenId: str(actor.token_id),
    // The shape of the actor as Cloudflare sent it (field names only, never
    // values) and the request's user agent: what the report prints for an
    // UNEXPECTED change, so an allowlist entry can be bound to what the audit
    // log really carries for that actor rather than to what the docs promise.
    actorFields: Object.keys(actor)
      .filter((k) => str(actor[k]) !== '')
      .sort()
      .join(','),
    userAgent: str(entry?.raw?.user_agent),
    method: str(entry?.raw?.method).toUpperCase(),
    zoneId: str(entry?.zone?.id),
    zoneName: str(entry?.zone?.name),
    resourceId,
    recordType: fields.type || 'unknown',
    recordName: fields.name || 'unknown',
    nameSource: fields.name ? nameSource : 'none',
  };
}

/** The create/update/delete entries on DNS records in the production zone, oldest first. */
export function dnsRecordChanges(entries, settings = {}) {
  const zoneId = str(settings.zoneId);
  const kept = entries.filter((e) => CHANGING_ACTIONS.has(actionType(e)) && isDnsRecordEntry(e) && isProductionZone(e, zoneId));
  return kept.map((e) => normalise(e, entries)).sort((a, b) => a.time.localeCompare(b.time));
}

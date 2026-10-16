/**
 * The register's reads, and its one write (#1026).
 *
 * READS. Every live date the register shows comes from a document another
 * feature already keeps; this module reads each one and hands `status.js`
 * the field maps it needs:
 *
 *   reminders            admin_config/reminders          the sheet: the read's "in the sheet" column, and the sync's base
 *   secret-state         admin_config/secret_state      the Keys tab's lastWriteAt per secret
 *   coder-automation     admin_config/coder_automation  the lab host's Coder token dates
 *   credential-register  admin_config/credential_register  the owner's recorded rotations
 *   mcp:<id>             mcp_servers, PROJECTED          an MCP server's connection
 *
 * THE SHEET IS READ FIRST, the date sources after it. The reminders sync
 * (reminders.js) writes the sheet under the ETag of this read, and that
 * order is what makes its write safe: a rotation recorded after the sheet
 * was read is followed by its own sync, whose write changes the ETag and
 * sends this one round again with the new date.
 *
 * AN MCP SERVER'S RECORD IS NEVER READ WHOLE (review of #1039). The
 * document holds the write-only `oauthToken`, `oauthRefreshToken` and
 * `oauthClientSecret`, and a point read would bring them into this process.
 * MCP_SERVER_QUERY asks Cosmos for the dates and states status.js reads and
 * one boolean, `hasToken`, computed inside Cosmos; no token field is in its
 * SELECT list, and the rows are copied field by field besides.
 *
 * FAIL CLOSED (review of #1039). Each read stands alone: one that fails is
 * named in `unavailable`, and the credentials that depend on it show
 * `unknown` rather than the whole tab failing. A document that is PRESENT
 * but malformed (a `secrets` or `credentials` map that is not a map of
 * records, a sheet whose `reminders` is not a list) is unavailable too, not
 * empty: read as empty, it would have the reminders sync remove every
 * credential row the sheet holds. Only an absent document reads as empty.
 *
 * THE WRITE: admin_config/credential_register.
 *
 *   { id: 'credential_register', configScope: 'admin_config',
 *     docType: 'credential_register',
 *     credentials: { <register id>: { rotatedOn: 'YYYY-MM-DD',
 *                                      recordedAt, recordedBy } } }
 *
 * A date per credential and who recorded it: no value, no name of one beyond
 * the register's own ids, which are in the repository. One credential's
 * record changes at a time, read → change → write-if-unchanged under the
 * document's ETag, retried when another write got there first: the
 * updateSecretRecord pattern (admin-secrets.js), so two rotations recorded in
 * the same moment both land.
 */

import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { parseDateOnly } from '../reminders/calendar.js';
import { REMINDERS_CONFIG_ID } from '../reminders/settings.js';
import { CREDENTIAL_REGISTER } from './register.js';

export const CREDENTIAL_REGISTER_DOC_ID = 'credential_register';
export const CREDENTIAL_REGISTER_DOC_TYPE = 'credential_register';
export const LAB_CERTIFICATES_DOC_ID = 'lab_certificates';
export const SWA_RESET_DOC_ID = 'swa_reset';
const SECRET_STATE_DOC_ID = 'secret_state';
const CODER_AUTOMATION_DOC_ID = 'coder_automation';
const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

/** Read → change → write-if-unchanged attempts on the register document. */
export const RECORD_WRITE_ATTEMPTS = 6;

/** What each source is, in the words the tab uses when one cannot be read. */
export const SOURCE_LABELS = Object.freeze({
  'secret-state': 'Key Vault write dates (admin_config/secret_state)',
  'coder-automation': 'the lab host’s Coder report (admin_config/coder_automation)',
  'credential-register': 'the recorded rotations (admin_config/credential_register)',
  'lab-certificates': 'the lab host’s certificate report (admin_config/lab_certificates)',
  'swa-reset': 'Static Web App reset log (admin_config/swa_reset)',
  reminders: 'the reminders sheet (admin_config/reminders)',
});

/** The mcp_servers ids the register reads, from its own entries. */
export const MCP_SERVER_IDS = Object.freeze([
  ...new Set(CREDENTIAL_REGISTER.map((entry) => entry.source?.mcpServer).filter(Boolean)),
]);

/**
 * The mcp_servers fields status.js reads, projected by Cosmos. `hasToken`
 * is computed there, so the token itself never crosses the wire: IS_STRING
 * is false for an absent token, and `false AND …` is false without the
 * LENGTH. Partition key `/id`, so this is a small cross-partition query over
 * the register's own ids.
 */
export const MCP_SERVER_QUERY =
  'SELECT c.id, c.status, c.lastTokenRefresh, c.oauth.status AS oauthStatus, ' +
  'c.oauth.connectedAt AS oauthConnectedAt, c.oauth.refreshedAt AS oauthRefreshedAt, ' +
  '(IS_STRING(c.oauthToken) AND LENGTH(c.oauthToken) > 0) AS hasToken ' +
  'FROM c WHERE ARRAY_CONTAINS(@ids, c.id)';

/** The projection's fields, and nothing else, as status.js reads them. */
export const MCP_RECORD_FIELDS = Object.freeze([
  'status',
  'lastTokenRefresh',
  'oauthStatus',
  'oauthConnectedAt',
  'oauthRefreshedAt',
  'hasToken',
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = (value) => (typeof value === 'string' && value ? value : null);

/** A source's label, for one that could not be read. */
export function sourceLabel(id) {
  if (Object.hasOwn(SOURCE_LABELS, id)) return SOURCE_LABELS[id];
  return id.startsWith('mcp:') ? `the ${id.slice(4)} MCP server record (mcp_servers)` : id;
}

/** One read as `{ ok, value }`; never throws. */
async function settle(read) {
  try {
    return { ok: true, value: (await read()) ?? null };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * The one date each kind of record is read for, and what it must be when
 * present: the Keys tab writes `lastWriteAt` as an ISO instant, and a
 * recorded rotation `rotatedOn` as a real `YYYY-MM-DD` (review of #1039).
 */
const isInstant = (value) => typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
const ROTATION_DATE = Object.freeze({ field: 'rotatedOn', valid: (value) => parseDateOnly(value) !== null });

/**
 * A document's map of records: `{}` when the document is absent, the map
 * when it is a map of records whose dates are well formed, and null
 * (malformed: unavailable) otherwise. A date that is present but not a date
 * makes the whole source malformed, as a malformed map does: read as a
 * missing date it would turn a rotation reminder back into a request for
 * the date, and recordRotation would write over the record (review of
 * #1039). An absent date is just not known yet.
 */
function recordMap(doc, field, date) {
  if (!doc) return {};
  const map = doc[field];
  if (!isPlainObject(map)) return null;
  const records = Object.values(map);
  if (!records.every(isPlainObject)) return null;
  const wellFormed = records.every((record) => record[date.field] == null || date.valid(record[date.field]));
  return wellFormed ? map : null;
}

/**
 * Secret state record map: checks both lastWriteAt and createdAt timestamps.
 */
function secretRecordMap(doc) {
  if (!doc) return {};
  const map = doc.secrets;
  if (!isPlainObject(map)) return null;
  const records = Object.values(map);
  if (!records.every(isPlainObject)) return null;
  const wellFormed = records.every(
    (record) =>
      (record.lastWriteAt == null || isInstant(record.lastWriteAt)) &&
      (record.createdAt == null || isInstant(record.createdAt))
  );
  return wellFormed ? map : null;
}

const projectSecretRecords = (map) =>
  map === null
    ? null
    : Object.fromEntries(
        Object.entries(map).map(([key, record]) => {
          const out = { lastWriteAt: stringOrNull(record.lastWriteAt) };
          if (record.createdAt) out.createdAt = stringOrNull(record.createdAt);
          return [key, out];
        })
      );

/**
 * Lab certificates record map: validates notBefore and notAfter.
 */
function labCertificatesMap(doc) {
  if (!doc) return {};
  const map = doc.certificates;
  if (!isPlainObject(map)) return null;
  const records = Object.values(map);
  if (!records.every(isPlainObject)) return null;
  const wellFormed = records.every(
    (record) =>
      (record.notBefore == null || isInstant(record.notBefore)) &&
      (record.notAfter == null || isInstant(record.notAfter))
  );
  return wellFormed ? map : null;
}

const projectLabCertificates = (map) =>
  map === null
    ? null
    : Object.fromEntries(
        Object.entries(map).map(([key, record]) => [
          key,
          {
            notBefore: stringOrNull(record.notBefore),
            notAfter: stringOrNull(record.notAfter),
          },
        ])
      );

/**
 * SWA reset document: validates lastResetAt instant.
 */
function swaResetRecord(doc) {
  if (!doc) return {};
  if (!isPlainObject(doc)) return null;
  if (doc.lastResetAt != null && !isInstant(doc.lastResetAt)) return null;
  return { lastResetAt: stringOrNull(doc.lastResetAt) };
}

/**
 * The one field each kind of record is read for, copied out by name, so
 * nothing else a stored record holds (a stray value in a contaminated
 * secret_state record, or a field added later) crosses into `sources`
 * (review of #1039). recordRotation keeps reading recordMap whole, because
 * it writes the register's records back.
 */
const projectRecords = (map, field) =>
  map === null
    ? null
    : Object.fromEntries(
        Object.entries(map).map(([key, record]) => [key, { [field]: stringOrNull(record[field]) }])
      );

/** The sheet's rows: `[]` for no sheet or no rows yet, null when `reminders` is not a list. */
function sheetRows(doc) {
  if (!doc || doc.reminders === undefined) return [];
  return Array.isArray(doc.reminders) ? doc.reminders : null;
}

/** One projected row, copied field by field. */
function mcpRecord(row) {
  return {
    status: stringOrNull(row.status),
    lastTokenRefresh: stringOrNull(row.lastTokenRefresh),
    oauthStatus: stringOrNull(row.oauthStatus),
    oauthConnectedAt: stringOrNull(row.oauthConnectedAt),
    oauthRefreshedAt: stringOrNull(row.oauthRefreshedAt),
    hasToken: row.hasToken === true,
  };
}

/** Every register MCP server's projected record by id; null for a server with no document. */
async function readMcpServers(store) {
  const rows = await store.queryDocs('mcp_servers', MCP_SERVER_QUERY, [
    { name: '@ids', value: [...MCP_SERVER_IDS] },
  ]);
  const byId = new Map((rows ?? []).filter(isPlainObject).map((row) => [row.id, row]));
  return Object.fromEntries(
    MCP_SERVER_IDS.map((id) => [id, byId.has(id) ? mcpRecord(byId.get(id)) : null])
  );
}

/**
 * Every source: the sheet first, then the date sources in parallel (see the
 * header for why that order).
 *
 * Resolves to `{ sources, unavailable, reminderDoc }`: `sources` as status.js
 * reads them, plus `reminders` (the stored rows, or null when the sheet could
 * not be read); `unavailable` the ids of the sources that failed or were
 * malformed; `reminderDoc` the sheet as read, with its ETag, for the sync.
 */
export async function readCredentialSources(store) {
  const sheet = await settle(() => store.readDoc(CONTAINER, REMINDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION));
  const [secretState, coder, register, servers, labCerts, swa] = await Promise.all([
    settle(() => store.readDoc(CONTAINER, SECRET_STATE_DOC_ID, ADMIN_CONFIG_PARTITION)),
    settle(() => store.readDoc(CONTAINER, CODER_AUTOMATION_DOC_ID, ADMIN_CONFIG_PARTITION)),
    settle(() => store.readDoc(CONTAINER, CREDENTIAL_REGISTER_DOC_ID, ADMIN_CONFIG_PARTITION)),
    settle(() => readMcpServers(store)),
    settle(() => store.readDoc(CONTAINER, LAB_CERTIFICATES_DOC_ID, ADMIN_CONFIG_PARTITION)),
    settle(() => store.readDoc(CONTAINER, SWA_RESET_DOC_ID, ADMIN_CONFIG_PARTITION)),
  ]);

  const secrets = secretState.ok
    ? projectSecretRecords(secretRecordMap(secretState.value))
    : null;
  const records = register.ok
    ? projectRecords(recordMap(register.value, 'credentials', ROTATION_DATE), ROTATION_DATE.field)
    : null;
  const certificates = labCerts.ok
    ? projectLabCertificates(labCertificatesMap(labCerts.value))
    : null;
  const swaReset = swa.ok ? swaResetRecord(swa.value) : null;
  const rows = sheet.ok ? sheetRows(sheet.value) : null;
  const unavailable = [
    ...(rows === null ? ['reminders'] : []),
    ...(secrets === null ? ['secret-state'] : []),
    ...(coder.ok ? [] : ['coder-automation']),
    ...(records === null ? ['credential-register'] : []),
    ...(certificates === null ? ['lab-certificates'] : []),
    ...(swaReset === null ? ['swa-reset'] : []),
    // A failed query leaves every server absent, which status.js tells
    // apart from a server with no document (null): unknown, not unconnected.
    ...(servers.ok ? [] : MCP_SERVER_IDS.map((id) => `mcp:${id}`)),
  ];
  return {
    sources: {
      secrets: secrets ?? {},
      coder: coder.value,
      records: records ?? {},
      mcp: servers.ok ? servers.value : {},
      labCertificates: certificates ?? {},
      swaReset: swaReset ?? {},
      reminders: rows,
    },
    unavailable,
    reminderDoc: sheet.ok && rows !== null ? sheet.value : null,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record, or with `rotatedOn` null clear, when one credential was last
 * rotated. Resolves to the stored record (null when cleared); throws with
 * `code: 'CONFLICT'` when every attempt lost a race, and with `code:
 * 'MALFORMED'` when the stored document's `credentials` is not a map of
 * records, which a write would otherwise replace with this one record. No
 * id is in either message, which a caller may log.
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {{ credentialId: string, rotatedOn: string|null, actor: string, at: string }} change
 */
export async function recordRotation(
  store,
  { credentialId, rotatedOn, actor, at },
  { attempts = RECORD_WRITE_ATTEMPTS, sleep = defaultSleep } = {}
) {
  const record = rotatedOn ? { rotatedOn, recordedAt: at, recordedBy: actor || 'unknown' } : null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(20 * 2 ** Math.min(attempt, 5) + Math.random() * 20);
    const current = await store.readDoc(CONTAINER, CREDENTIAL_REGISTER_DOC_ID, ADMIN_CONFIG_PARTITION);
    const stored = recordMap(current, 'credentials', ROTATION_DATE);
    if (stored === null) {
      throw Object.assign(new Error('The credential register document is malformed'), { code: 'MALFORMED' });
    }
    const credentials = { ...stored };
    if (record) credentials[credentialId] = record;
    else delete credentials[credentialId];
    const next = {
      id: CREDENTIAL_REGISTER_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: CREDENTIAL_REGISTER_DOC_TYPE,
      credentials,
    };
    try {
      if (current) {
        await store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK);
      } else {
        await store.createDoc(CONTAINER, next);
      }
      return record;
    } catch (error) {
      // 412: replaced since our read. 409: created since our read found
      // nothing. Either way, read again and change again.
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw Object.assign(new Error('The credential register kept changing while it was written'), {
    code: 'CONFLICT',
  });
}

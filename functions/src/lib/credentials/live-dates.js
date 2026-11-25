/**
 * What the live sources say about one credential (#1026): when it was last
 * rotated, and by whom; when it expires, where a source reports that; and,
 * for an MCP server, whether it is connected. status.js judges these, and
 * re-exports what callers use, so they keep one import. Pure, and nothing
 * here touches a value: see status.js's header.
 */
import { parseDateOnly } from '../reminders/calendar.js';
import { isRecordable } from './register.js';

/** An ISO instant from an ISO string or epoch ms, or null. */
function instant(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The owner's recorded date for an entry, as `YYYY-MM-DD`, or null. */
function recordedOn(entry, records) {
  const rotatedOn = records?.[entry.id]?.rotatedOn;
  return isRecordable(entry) && parseDateOnly(rotatedOn) !== null ? rotatedOn : null;
}

/**
 * An MCP server's connection, from its projected record (sources.js
 * MCP_SERVER_QUERY): `connected`, `expired` (a refresh failed, so someone
 * must sign in again) or `not_connected`. Null when the record could not be
 * read, which is not the same as absent.
 *
 * Plaud's token is pasted, not obtained through Connect, and its timer marks
 * the document `disconnected` when a refresh fails (lib/timers/plaud-token.js).
 * The others are OAuth Connect servers, and this is mcp-oauth.js's
 * oauthConnectionState rule read off the projection: `oauth.status`, and
 * whether a token is there. status.test.js holds the two to the same answer.
 */
export function mcpConnection(serverId, mcp) {
  if (!mcp || !Object.hasOwn(mcp, serverId)) return null;
  const record = mcp[serverId];
  if (!record) return 'not_connected';
  return serverId === 'plaud' ? plaudConnection(record) : oauthConnection(record);
}

/** Plaud's pasted token: its timer marks the document `disconnected` when a refresh fails. */
function plaudConnection(record) {
  if (record.status === 'disconnected') return 'expired';
  return record.hasToken ? 'connected' : 'not_connected';
}

/** An OAuth Connect server, by mcp-oauth.js's oauthConnectionState rule. */
function oauthConnection(record) {
  if (record.oauthStatus === 'connected' && record.hasToken) return 'connected';
  return record.oauthStatus === 'disconnected' ? 'expired' : 'not_connected';
}

/** When an MCP server's token was last renewed, from its projected record, or null. */
function mcpRenewedAt(serverId, mcp) {
  const record = mcp?.[serverId];
  if (!record) return null;
  if (serverId === 'plaud') return instant(record.lastTokenRefresh);
  return instant(record.oauthRefreshedAt) ?? instant(record.oauthConnectedAt);
}

/** The Coder automation report's dates for one of its two tokens. */
function coderDates(which, coder) {
  if (!coder) return { rotatedAt: null, expiresAt: null };
  if (which === 'statusToken') {
    return { rotatedAt: instant(coder.statusTokenRotatedAt), expiresAt: instant(coder.statusTokenExpiresAt) };
  }
  return { rotatedAt: null, expiresAt: instant(coder.rotationTokenExpiresAt) };
}

/** A rotation seen in one source, or null when that source gave no date. */
const rotation = (at, source) => (at ? { at, source } : null);

/** When the Keys tab last wrote a Key Vault secret (or first created it). */
const secretWrittenAt = (record) => instant(record?.lastWriteAt) ?? instant(record?.createdAt);

/**
 * What the live sources say about one entry.
 *
 * @param {object} entry a register entry
 * @param {object} sources
 * @param {Record<string, object>} [sources.secrets] admin_config/secret_state's `secrets`
 * @param {object|null} [sources.coder] admin_config/coder_automation
 * @param {Record<string, object|null>} [sources.mcp] projected mcp_servers records by id, a failed read absent
 * @param {Record<string, object>} [sources.records] admin_config/credential_register's `credentials`
 */
export function resolveLive(entry, sources = {}) {
  const source = entry.source ?? {};
  const coder = source.coder ? coderDates(source.coder, sources.coder) : null;
  const cert = source.labCertificate ? sources.labCertificates?.[source.labCertificate] : undefined;
  const recorded = recordedOn(entry, sources.records);
  // In this order: when two sources give the same instant, the later one names it.
  const rotations = [
    rotation(source.secret && secretWrittenAt(sources.secrets?.[source.secret]), 'key-vault'),
    rotation(coder?.rotatedAt, 'lab-host'),
    rotation(source.labCertificate && instant(cert?.notBefore), 'lab-host'),
    rotation(source.swaReset && instant(sources.swaReset?.lastResetAt), 'azure'),
    rotation(source.mcpServer && mcpRenewedAt(source.mcpServer, sources.mcp), 'oauth'),
    rotation(recorded && `${recorded}T00:00:00.000Z`, 'owner'),
  ].filter(Boolean);

  // ISO strings of one shape sort as time; the latest rotation is the one that counts.
  const latest = rotations.sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  return {
    lastRotatedAt: latest?.at ?? null,
    lastRotatedSource: latest?.source ?? null,
    recordedOn: recorded,
    // A certificate's own end date, else what the Coder report says.
    expiresAt: cert?.notAfter ? instant(cert.notAfter) : (coder?.expiresAt ?? null),
    connection: source.mcpServer ? mcpConnection(source.mcpServer, sources.mcp) : null,
  };
}

/**
 * workflow-records.js — the three records the operational timers write:
 * a dated `workflow_digests` document (merged, one per day), a
 * `workflow_alerts` document (raised or refreshed), and a system audit entry.
 *
 * Firestore's `set(..., { merge: true })` becomes read-then-write here; a
 * patch replaces its top-level keys, which is how every caller uses it (each
 * timer owns one sub-object of the digest).
 *
 * The write is ETag-guarded (#1010). It was a plain read-then-upsert, which
 * is a lost update the moment two timers merge the same day's document in the
 * same second — and they do: the publishing watchdog fires at 00, 06, 12 and
 * 18:00 UTC, the link check at Monday 06:00, and since #1010 the scheduled
 * publisher records every fifteen-minute run here too, on the same instants.
 * Whichever wrote second used to erase the other's sub-object. Now the loser
 * of the race gets a 412 (or a 409 on the day's first write), reads again and
 * merges onto the winner's document.
 */
import { randomUUID } from 'node:crypto';

/** YYYY-MM-DD of `date` in UTC — the digest document id. */
export function digestDateOf(date) {
  return date.toISOString().slice(0, 10);
}

/** Attempts before a merge that keeps losing races gives up. */
export const DIGEST_WRITE_ATTEMPTS = 5;

/**
 * Merge `patch`'s top-level keys into the day's digest: read, merge, then
 * replace under the `_etag` it was read with (or create the day's document),
 * again from the read on a 412 or 409.
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 */
export async function mergeDigest(store, digestDate, patch, { attempts = DIGEST_WRITE_ATTEMPTS } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = await store.readDoc('workflow_digests', digestDate, digestDate);
    const doc = { ...(existing || {}), ...patch, id: digestDate, digestDate };
    try {
      if (existing) {
        await store.replaceDocIfMatch('workflow_digests', doc, { partitionKey: digestDate });
      } else {
        await store.createDoc('workflow_digests', doc);
      }
      return doc;
    } catch (error) {
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw new Error(
    `workflow_digests/${digestDate} kept changing; ${Object.keys(patch).join(', ')} was not written`
  );
}

/** Raise (or refresh) an alert. `firstSeenAt` survives refreshes; `updatedAt` moves. */
export async function raiseAlert(store, alertId, fields, now = () => new Date()) {
  const existing = (await store.readDoc('workflow_alerts', alertId, alertId)) || {};
  const stamp = now().toISOString();
  const doc = {
    ...existing,
    ...fields,
    id: alertId,
    active: true,
    firstSeenAt: existing.firstSeenAt || stamp,
    updatedAt: stamp,
  };
  await store.upsertDoc('workflow_alerts', doc);
  return doc;
}

/** A system (no user) entry in admin_audit_logs — Site-Main's buildSystemAuditLogData. */
export async function writeSystemAudit(
  store,
  { action, source, details = {} },
  { now = () => new Date(), uuid = randomUUID } = {}
) {
  const doc = {
    id: uuid(),
    action: String(action || 'system_action'),
    actor: 'system',
    source: String(source || 'cron'),
    userId: null,
    userEmail: null,
    timestamp: now().toISOString(),
    details,
    compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
  };
  await store.upsertDoc('admin_audit_logs', doc);
  return doc;
}

/** Epoch ms of an ISO string / Date / Firestore-shaped value, else 0. */
export function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  // A migrated Firestore time stored as plain JSON: { seconds, nanoseconds }
  // or { _seconds, _nanoseconds } (#1516).
  const seconds = value.seconds ?? value._seconds;
  if (typeof seconds === 'number') return seconds * 1000;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

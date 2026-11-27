/**
 * cloudflare/record.js — what every accepted change on the Cloudflare page
 * leaves behind (#1905), and the zone check every change passes first.
 *
 *   - requireOurZone: before any write, the zone the id points at is read
 *     and must be the one the request names (#1911; the site's own when it
 *     names none). Each zone's protected list names that zone's records, so
 *     applying it to another zone would protect nothing; a mismatch is
 *     refused with 409 and nothing is changed. A looked-up id that found
 *     another zone is forgotten, so the next request looks it up again.
 *   - audit: one admin_audit_logs row (`cloudflare_change`), with the zone,
 *     the caller and, for an agent key, its id. It answers the row's id and
 *     whether the row was written, so a change whose row failed is never
 *     silent.
 *   - tellOwner: an agent key's change is sent to the owner's phone, naming
 *     the zone in its title and its last sentence. The
 *     Telegram source is `cloudflare-change:<agent>:<audit row id>`, one per
 *     change, so notify.js's 15-minute cooldown (which is per source) never
 *     swallows a second change; notify.js shows any source with that prefix
 *     as "the Cloudflare page".
 *   - warnOwner: a change that needs checking is sent to the owner's phone
 *     whoever made it, a person or an agent key, as one warning in place of
 *     the agent's plain message. Two things need checking: the change was
 *     made in Cloudflare but its audit row could not be written, and (for a
 *     DNS edit) the saved record came back with a protected name. Its source
 *     is `cloudflare-check:<audit row id>`, one per change, shown by
 *     notify.js as "the Cloudflare page" too.
 */
import { randomUUID } from 'node:crypto';
import { errorFacts } from '../http/error-response.js';
import { agentKeyById, isAgentUser } from '../agent-content/agent-keys.js';
import { CloudflareError, forgetZoneIds } from './client.js';
import { SITE_ZONE } from './protected.js';

/** The sentence for a zone check that found another zone: CF_ZONE_ID for the site's, the lookup for any other. */
export function wrongZoneMessage(zoneName) {
  if (zoneName === SITE_ZONE) {
    return `The zone this site is set to (CF_ZONE_ID) is not ${SITE_ZONE}, so nothing was changed. Check CF_ZONE_ID, which Terraform sets on the function app.`;
  }
  return `The zone looked up for ${zoneName} answered with another name, so nothing was changed. Try again: the zone is looked up afresh.`;
}

export const WRONG_ZONE_MESSAGE = wrongZoneMessage(SITE_ZONE);

/** Refuses (409) unless the client's zone is the one the request names. */
export async function requireOurZone(client, zoneName = SITE_ZONE) {
  const zone = await client.getZone();
  const name = String(zone?.name ?? '').toLowerCase();
  if (name === zoneName) return;
  if (!client.zoneId) forgetZoneIds(zoneName);
  throw new CloudflareError(wrongZoneMessage(zoneName), { status: 409, code: 'CLOUDFLARE_WRONG_ZONE' });
}

/** The zone a call acts on, by name. */
const zoneNameOf = (call) => call.zone?.name ?? SITE_ZONE;

/** The clock and the id maker, from the handler's options or the real ones. */
export const clockOf = ({ now = () => new Date(), uuid = randomUUID } = {}) => ({ now, uuid });

/**
 * Writes the audit row for an accepted change and answers `{ id, written }`.
 * Best effort: the change has happened, so a failed write is logged (its
 * code only), `written` is false, and recordChange tells the owner.
 */
export async function audit({ deps, context, user, request, zone }, details) {
  const id = deps.uuid();
  try {
    await deps.store.upsertDoc('admin_audit_logs', {
      id,
      timestamp: deps.now().toISOString(),
      action: 'cloudflare_change',
      userId: user?.oid || user?.sub || null,
      userEmail: user?.email || null,
      ...(isAgentUser(user) ? { agent: user.agent } : {}),
      resourceType: 'cloudflare',
      resourceId: details.family,
      details: { zone: zone?.name ?? SITE_ZONE, ...details },
      userAgent: request.headers?.get?.('user-agent') || null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch (error) {
    context?.error?.('[cloudflare] audit row failed', errorFacts(error));
    return { id, written: false };
  }
  return { id, written: true };
}

/** The caller as the phone message and an agent key's refusals name it: the agent key's name, or a person. */
export const actorOf = (user) => (isAgentUser(user) ? agentKeyById(user.agent)?.displayName || user.agent : 'Someone signed in to the admin portal');

/** The sentence a warning adds when the audit row could not be written. */
export const UNAUDITED_NOTE =
  'The change was made in Cloudflare, but its audit row could not be written, so the audit log does not show it. Check the change on the Cloudflare page.';

/** The sentence every phone message ends its first part with: which zone. */
const zoneLine = (call) => `Zone: ${zoneNameOf(call)}.`;

/** Sends a change that needs checking to the owner's phone, whoever made it: one warning per change. */
export async function warnOwner(call, auditId, sentence, notes) {
  const { deps, user } = call;
  if (!deps.notifier) return;
  try {
    await deps.notifier.notifyTelegram({
      title: `Check this Cloudflare change in ${zoneNameOf(call)}`,
      message: [`${actorOf(user)} ${sentence}`, zoneLine(call), ...notes].join(' '),
      severity: 'warning',
      source: `cloudflare-check:${auditId}`,
    });
  } catch {
    // The notifier never throws; this is belt and braces.
  }
}

/** Sends an agent key's change to the owner's phone, one message per change. */
export async function tellOwner(call, auditId, sentence) {
  const { deps, user } = call;
  if (!isAgentUser(user) || !deps.notifier) return;
  const name = actorOf(user);
  try {
    await deps.notifier.notifyTelegram({
      title: `Cloudflare changed by ${name} in ${zoneNameOf(call)}`,
      message: `${name} ${sentence} ${zoneLine(call)}`,
      severity: 'info',
      source: `cloudflare-change:${user.agent}:${auditId}`,
    });
  } catch {
    // The notifier never throws; this is belt and braces.
  }
}

/**
 * The audit row and the phone message for one accepted change, answering
 * whether the row was written (the route's `audited`). `checks` are extra
 * sentences that make the change one to check (a DNS record saved under a
 * protected name); with any of them, or a row that failed, the owner gets
 * one warning whoever made the change, in place of the agent's plain message.
 */
export async function recordChange(call, details, sentence, checks = []) {
  const { id, written } = await audit(call, details);
  const notes = written ? checks : [...checks, UNAUDITED_NOTE];
  if (notes.length) await warnOwner(call, id, sentence, notes);
  else await tellOwner(call, id, sentence);
  return written;
}

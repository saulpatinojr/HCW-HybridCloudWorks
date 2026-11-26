/**
 * cloudflare/record.js — what every accepted change on the Cloudflare page
 * leaves behind (#1905), and the zone check every change passes first.
 *
 *   - requireOurZone: before any write, the zone the id points at is read
 *     and must be the site's own (ZONE_APEX). The protected list names the
 *     site's records, so applying it to another zone would protect nothing;
 *     a mismatch is refused with 409 and nothing is changed.
 *   - audit: one admin_audit_logs row (`cloudflare_change`), with the caller
 *     and, for an agent key, its id. Its id is returned, so the phone
 *     message can name it.
 *   - tellOwner: an agent key's change is sent to the owner's phone. The
 *     Telegram source is `cloudflare-change:<agent>:<audit row id>`, one per
 *     change, so notify.js's 15-minute cooldown (which is per source) never
 *     swallows a second change; notify.js shows any source with that prefix
 *     as "the Cloudflare page".
 */
import { randomUUID } from 'node:crypto';
import { errorFacts } from '../http/error-response.js';
import { agentKeyById, isAgentUser } from '../agent-content/agent-keys.js';
import { CloudflareError } from './client.js';
import { ZONE_APEX } from './protected.js';

export const WRONG_ZONE_MESSAGE = `The zone this site is set to (CF_ZONE_ID) is not ${ZONE_APEX}, so nothing was changed. Check CF_ZONE_ID, which Terraform sets on the function app.`;

/** Refuses (409) unless the configured zone is the site's own. */
export async function requireOurZone(client) {
  const zone = await client.getZone();
  const name = String(zone?.name ?? '').toLowerCase();
  if (name !== ZONE_APEX) {
    throw new CloudflareError(WRONG_ZONE_MESSAGE, { status: 409, code: 'CLOUDFLARE_WRONG_ZONE' });
  }
}

/** The clock and the id maker, from the handler's options or the real ones. */
export const clockOf = ({ now = () => new Date(), uuid = randomUUID } = {}) => ({ now, uuid });

/**
 * Writes the audit row for an accepted change and answers its id. Best
 * effort: the change has happened, so a failed write is logged (its code
 * only) and the answer still says so.
 */
export async function audit({ deps, context, user, request }, details) {
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
      details,
      userAgent: request.headers?.get?.('user-agent') || null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch (error) {
    context?.error?.('[cloudflare] audit row failed', errorFacts(error));
  }
  return id;
}

/** Sends an agent key's change to the owner's phone, one message per change. */
export async function tellOwner({ deps, user }, auditId, sentence) {
  if (!isAgentUser(user) || !deps.notifier) return;
  const name = agentKeyById(user.agent)?.displayName || user.agent;
  try {
    await deps.notifier.notifyTelegram({
      title: `Cloudflare changed by ${name}`,
      message: `${name} ${sentence}`,
      severity: 'info',
      source: `cloudflare-change:${user.agent}:${auditId}`,
    });
  } catch {
    // The notifier never throws; this is belt and braces.
  }
}

/** The audit row and, for an agent key, the phone message, for one accepted change. */
export async function recordChange(call, details, sentence) {
  const auditId = await audit(call, details);
  await tellOwner(call, auditId, sentence);
}

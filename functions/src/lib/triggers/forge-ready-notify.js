/**
 * forge-ready-notify.js — the Telegram "a post is staged" notification
 * (T-606). When the forge lands a draft at forge_ready it arms
 * `forgeReadyNotifyTrigger` (lib/content/forge.js), and the content change
 * feed calls this: claim the rising edge, send one Telegram message with the
 * title, grade, format, the signed preview link and the /approve + /reject
 * command hints, then clear the flag.
 *
 * Retry semantics differ from ai-cover on purpose. ai-cover clears its flag
 * on failure because a failed generation should not silently re-bill later.
 * A notification is the opposite: an unsent message should fire when it can.
 * So on ANY not-sent outcome (Telegram unconfigured, cooldown, API error,
 * exception) the TRIGGER FLAG IS NEVER CLEARED — it stays armed and the claim
 * stays in place. Clearing it, or writing any other boolean, would re-fire the
 * feed on our own write and loop; leaving the claim makes the failure quiet
 * for the claim-timeout window (15 min).
 *
 * What it does write (T-735) is a numeric attempt counter and two strings.
 * The header used to say "writes NOTHING", and relied on "any later write to
 * the document retries" — which is not true for a forge_ready document,
 * because nothing writes to one again unless a human acts. A transient
 * Telegram failure therefore stranded the draft in silence. The counter
 * cannot re-arm the trigger (the claim keys on a boolean) and makes an
 * undelivered notification visible to the ops snapshot and to a sweeper.
 * `notifyTelegram` uses `source: forge_ready:{id}` so the 15-minute notify
 * cooldown is per post, not global — a second post forged a minute later
 * still notifies. (Each id adds one small key to system/notify_state;
 * acceptable at blog cadence.)
 */
import { claimRisingEdge, releaseRisingEdgeClaim } from './rising-edge-claim.js';
import { readKey } from '../ai/router.js';
import { buildPreviewToken } from '../public-preview.js';
import { toPublicUrl } from '../cms/publish.js';
import { errorFacts, errorCode } from '../http/error-response.js';

/**
 * Fields recording a delivery that did NOT happen (T-735).
 *
 * Numbers and strings, never a boolean: the rising-edge claim keys on
 * `forgeReadyNotifyTrigger`, so anything boolean written here could re-arm the
 * feed on our own write. These make an undelivered notification visible to the
 * ops snapshot and to any future sweeper, without touching the trigger.
 */
export const NOTIFY_ATTEMPTS_FIELD = 'forgeReadyNotifyAttempts';
export const NOTIFY_LAST_ATTEMPT_FIELD = 'forgeReadyNotifyLastAttemptAt';
export const NOTIFY_LAST_REASON_FIELD = 'forgeReadyNotifyLastReason';

export const FORGE_READY_NOTIFY_CLAIM_FIELDS = Object.freeze({
  flagField: 'forgeReadyNotifyTrigger',
  claimField: 'forgeReadyNotifyRunId',
  claimedAtField: 'forgeReadyNotifyRunAt',
});

/** The message body, exported so the test pins what the owner actually reads. */
export function buildForgeReadyMessage(data, previewUrl) {
  const grade = data.forgeGrade || {};
  const lines = [];
  if (typeof grade.overall === 'number') {
    lines.push(
      `Grade: ${grade.overall}${typeof grade.threshold === 'number' ? ` (threshold ${grade.threshold})` : ''}`
    );
  }
  const format = data.format || data.forgeMeta?.formatKey;
  if (format) lines.push(`Format: ${format}`);
  const seoFindings = Array.isArray(grade.seo?.findings) ? grade.seo.findings : [];
  if (seoFindings.length) {
    // Point at the banner only when the preview link below actually works.
    lines.push(
      previewUrl
        ? `SEO: ${seoFindings.length} advisory note(s) — details in the preview banner.`
        : `SEO: ${seoFindings.length} advisory note(s).`
    );
  }
  lines.push(
    previewUrl
      ? `Preview: ${previewUrl}`
      : 'Preview link unavailable until PREVIEW_SIGNING_SECRET is seeded.'
  );
  lines.push('');
  lines.push(`Approve and publish: /approve ${data.id}`);
  lines.push(`Reject: /reject ${data.id} [reason]`);
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {{ notifyTelegram: Function }} deps.notifier
 */
export function createForgeReadyNotifier({
  store,
  notifier,
  env = process.env,
  now = () => new Date(),
  log = {},
}) {
  async function run(contentId, eventId) {
    const claim = await claimRisingEdge(store, 'content', contentId, {
      ...FORGE_READY_NOTIFY_CLAIM_FIELDS,
      eventId,
      now,
    });
    if (!claim.claim) return { ran: false, reason: claim.reason };
    const data = claim.data;

    try {
      const secret = readKey(env, 'PREVIEW_SIGNING_SECRET');
      const previewUrl = secret
        ? toPublicUrl(
            `/preview/${encodeURIComponent(contentId)}?t=${encodeURIComponent(
              buildPreviewToken(secret, contentId, { now: () => now().getTime() })
            )}`
          )
        : null;

      const result = await notifier.notifyTelegram({
        title: `Forge ready: ${data.Title || contentId}`,
        message: buildForgeReadyMessage(data, previewUrl),
        severity: 'info',
        source: `forge_ready:${contentId}`,
      });

      if (!result.sent) {
        // The flag stays true and the claim stays released-by-expiry, exactly
        // as the header describes: writing a failure marker here would re-fire
        // the feed on our own write and loop.
        //
        // What the header's escape hatch assumed — "any later write to the
        // document retries" — is not true for a forge_ready document: nothing
        // writes to one again unless a human acts. So a transient Telegram
        // failure stranded the draft silently, and the only evidence was a flag
        // sitting true in Cosmos (T-735).
        //
        // A bounded attempt counter is the smallest thing that makes the state
        // visible without re-arming the trigger logic: it is a NUMBER, not the
        // boolean flag the claim keys on, so writing it cannot re-trigger the
        // rising edge. A document whose attempts climb is one nobody was told
        // about, which is what the ops snapshot and any future sweeper need in
        // order to find it.
        const attempts = Number(data[NOTIFY_ATTEMPTS_FIELD] || 0) + 1;
        log.warn?.(
          `[forge-ready-notify] ${contentId}: not sent (${result.reason}), attempt ${attempts}`
        );
        try {
          await store.patchDoc('content', contentId, {
            [NOTIFY_ATTEMPTS_FIELD]: attempts,
            [NOTIFY_LAST_ATTEMPT_FIELD]: now().toISOString(),
            [NOTIFY_LAST_REASON_FIELD]: String(result.reason || 'unknown').slice(0, 200),
          });
        } catch (patchError) {
          // Best effort: failing to record the attempt must not turn a
          // delivery problem into a handler error.
          log.warn?.(
            `[forge-ready-notify] ${contentId}: could not record attempt: ${errorFacts(patchError)}`
          );
        }
        return { ran: false, reason: `not_sent:${result.reason}`, attempts };
      }

      await store.patchDoc('content', contentId, {
        ...releaseRisingEdgeClaim(FORGE_READY_NOTIFY_CLAIM_FIELDS),
        forgeReadyNotifyTrigger: false,
        forgeReadyNotifiedAt: now().toISOString(),
      });
      return { ran: true, reason: 'sent' };
    } catch (err) {
      log.error?.(`[forge-ready-notify] ${contentId}: ${errorFacts(err)}`);
      return { ran: false, reason: `error: ${errorCode(err)}` };
    }
  }

  return { run };
}

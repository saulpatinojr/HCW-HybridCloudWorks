/**
 * social-caption-trigger.js — social captions auto-queued to Publer on
 * publish (Blog Machine backlog #1).
 *
 * `processPublishContent` arms `socialCaptionTrigger` on a live publish (once
 * per document), and the content change feed runs this: claim the rising
 * edge, generate a caption (lib/social-caption.js, feature-gated), and queue
 * the post.
 *
 * The whole feature is switched by `admin_config/social_autopost`:
 *   { enabled, accountIds: [{ id, provider }], scheduleDelayMinutes }
 * Absent or disabled → the trigger clears itself without spending a model
 * call. The delay (default 60 min) is the owner's undo window: the post sits
 * scheduled in Publer, cancellable from Publer or the Social Hub, instead of
 * publishing the instant the article does.
 *
 * Where the post goes:
 *   - Publer configured → one bulk schedule call (the exact payload shape
 *     SocialHubPage's manual compose sends), and the social_posts doc keeps
 *     the returned publerJobId — the existing 5-minute reconcile timer
 *     (lib/timers/publer-sync.js) matches on that id and adopts state from
 *     Publer from then on. No polling here.
 *   - Publer NOT configured → the caption still lands as a draft
 *     social_posts doc, ready in the Social Hub compose tab, so the work is
 *     kept rather than lost.
 *
 * The doc is written with syncOrigin 'system', which the social_posts feed
 * handler skips — creating it must not trigger an edit-push back at Publer.
 *
 * Failure semantics follow ai-cover, not forge-ready-notify: a caption is a
 * convenience, so an error clears the flag (with socialCaptionError stamped)
 * rather than staying armed to retry — the owner composes manually from the
 * Social Hub deep link if they still want the post.
 */
import { claimRisingEdge, releaseRisingEdgeClaim, SKIP_REASONS } from './rising-edge-claim.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { generateCaptionText } from '../social-caption.js';
import { publicUrlOf } from '../cms/publish.js';
import { recordedFailure } from '../http/error-response.js';

// Lifted to cms/publish.js so the related-posts interlinker shares it;
// re-exported here because this was its original home.
export { publicUrlOf };

export const SOCIAL_CAPTION_CLAIM_FIELDS = Object.freeze({
  flagField: 'socialCaptionTrigger',
  claimField: 'socialCaptionRunId',
  claimedAtField: 'socialCaptionRunAt',
});

export const AUTOPOST_CONFIG_ID = 'social_autopost';
const DEFAULT_DELAY_MINUTES = 60;

/** The Publer bulk payload — the exact shape SocialHubPage's compose sends. */
export function buildAutopostBulk(accounts, text, scheduledAtIso) {
  return {
    state: 'scheduled',
    posts: accounts.map((account) => ({
      networks: {
        [String(account.provider || 'linkedin').toLowerCase()]: { type: 'status', text },
      },
      accounts: [{ id: account.id, scheduled_at: scheduledAtIso }],
    })),
  };
}

/**
 * Build the social caption queuer: a caption written and queued to Publer
 * once per published document.
 *
 * @param {object} deps
 * @param {object} deps.store - the content and social post containers
 * @param {object} deps.ai - the router
 * @param {object|null} deps.publer - the Publer client, or null when unset
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 * @returns {{ run: (contentId: string, eventId: string) => Promise<object> }}
 */
export function createSocialCaptionQueuer({
  store,
  ai,
  publer,
  now = () => new Date(),
  uuid,
  log = {},
}) {
  /**
   * Claim the rising edge, write the caption and queue it. A failure clears
   * the flag and stores a sentence with a code and a reference (#945).
   *
   * @param {string} contentId - the published document
   * @param {string} eventId - the change feed's event id for the claim
   * @returns {Promise<{ ran: boolean, reason: string, socialPostId?: string }>}
   */
  async function run(contentId, eventId) {
    const claim = await claimRisingEdge(store, 'content', contentId, {
      ...SOCIAL_CAPTION_CLAIM_FIELDS,
      eventId,
      now,
    });
    if (!claim.claim) {
      if (claim.reason !== SKIP_REASONS.FLAG_NOT_SET)
        log.log?.(`[social-caption] content/${contentId} skipped: ${claim.reason}`);
      return { ran: false, reason: claim.reason };
    }
    const data = claim.data;

    try {
      const config = await store
        .readDoc('admin_config', AUTOPOST_CONFIG_ID, ADMIN_CONFIG_PARTITION)
        .catch(() => null);
      const accounts = (Array.isArray(config?.accountIds) ? config.accountIds : []).filter(
        (account) => account?.id
      );
      if (!config?.enabled || accounts.length === 0) {
        // Off (or pointed at no accounts): clear quietly, no model call spent.
        await store.patchDoc('content', contentId, {
          ...releaseRisingEdgeClaim(SOCIAL_CAPTION_CLAIM_FIELDS),
          socialCaptionTrigger: false,
        });
        return { ran: false, reason: 'autopost_disabled' };
      }

      const platforms = [...new Set(accounts.map((a) => String(a.provider || '').toLowerCase()))]
        .filter(Boolean);
      const caption = await generateCaptionText(
        { ai },
        {
          title: data.Title || data.title || '',
          summary: data.Summary || data.summary || '',
          platforms,
        }
      );
      if (!caption) throw new Error('Caption generation returned nothing');

      const url = publicUrlOf(data);
      const text = url ? `${caption}\n\n${url}` : caption;
      const stamp = now().toISOString();

      let publerJobId = null;
      let scheduledAtIso = null;
      let reason = 'queued_draft:publer_not_configured';
      if (publer.configured) {
        const delayMinutes = Number(config.scheduleDelayMinutes) || DEFAULT_DELAY_MINUTES;
        scheduledAtIso = new Date(now().getTime() + delayMinutes * 60 * 1000).toISOString();
        const response = await publer.request(
          '/posts/schedule',
          'POST',
          { bulk: buildAutopostBulk(accounts, text, scheduledAtIso) }
        );
        publerJobId = response?.data?.job_id || response?.job_id || null;
        reason = 'queued_to_publer';
      }

      // The doc SocialHubPage's manual compose writes, plus provenance. The
      // reconcile timer adopts it by publerJobId once Publer materializes
      // the posts.
      const socialPostId = uuid();
      await store.upsertDoc('social_posts', {
        id: socialPostId,
        contentId,
        caption,
        url: url || null,
        accountIds: accounts.map((account) => account.id),
        platforms,
        scheduledAt: scheduledAtIso,
        publerJobId,
        status: publerJobId ? 'scheduled' : 'draft',
        source: 'auto_publish',
        syncStatus: publerJobId ? 'pending' : 'draft',
        syncOrigin: 'system',
        createdAt: stamp,
      });

      await store.patchDoc('content', contentId, {
        ...releaseRisingEdgeClaim(SOCIAL_CAPTION_CLAIM_FIELDS),
        socialCaptionTrigger: false,
        socialCaptionGeneratedAt: stamp,
        socialPostId,
        socialCaptionError: null,
      });
      return { ran: true, reason, socialPostId };
    } catch (err) {
      // ai-cover discipline: release the claim AND clear the flag — a caption
      // is not worth a retry loop; the Social Hub deep link is the fallback.
      // The stored error is a sentence with the code and the reference of
      // the content-free log line (#945).
      await store.patchDoc('content', contentId, {
        ...releaseRisingEdgeClaim(SOCIAL_CAPTION_CLAIM_FIELDS),
        socialCaptionTrigger: false,
        socialCaptionError: recordedFailure(log, 'The social caption could not be written.', err),
      });
      return { ran: false, reason: `error: ${err?.message || err}` };
    }
  }
  return { run };
}

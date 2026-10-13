/**
 * speech-licence.js: whether a transcript's audio may go to Podbean under
 * the licence it was rendered with (ADR 0029 §2a, amended 2026-09-26).
 *
 * ## The rule
 *
 * Owner decision 2026-09-26: "Test only, block publish". An episode whose
 * audio ElevenLabs rendered on the FREE plan is never pushed to Podbean.
 * ElevenLabs' terms for that plan: it "does not include a commercial license
 * and cannot be used for any commercial purpose", and anything published from
 * it must carry "elevenlabs.io" or "11.ai" in its title
 * (https://help.elevenlabs.io/hc/en-us/articles/13313564601361). The site is
 * moving toward sponsorships, so the show is commercial, and the attribution
 * route was declined along with the setting that would have chosen it. A
 * render on a paid plan publishes exactly as before.
 *
 * ## Decided from the render, not from today's plan
 *
 * The plan is read once, by the credit pre-flight, when the audio is made,
 * and stored on the transcript as `speechTier` and `speechFreePlan`
 * (generate.js, store.js). Upgrading the account later does not license audio
 * that was rendered before the upgrade: "Content created outside of a paid
 * subscription (before or after) cannot be used commercially" (same article).
 * The fix is to regenerate on the paid plan, and a regeneration replaces the
 * whole document as a draft, so it is approved afresh against its own plan.
 *
 * ## An ElevenLabs render with no recorded plan counts as free
 *
 * Every render since the pre-flight landed records a plan, because a render
 * whose subscription cannot be read is refused (elevenlabs-account.js). A
 * document without one therefore predates it or was written by hand. Its
 * licence cannot be shown to be commercial, so it is refused like a free one.
 *
 * ## Where it is enforced
 *
 * Approval (`POST cms/podcast/transcripts/review` → `published`) refuses with
 * 409 and writes nothing. Nothing public reads `podcast_transcripts`, so
 * approval is what puts an episode on the show. The retry route refuses the
 * same way. The publish job checks again and records a `free_plan_licence`
 * skip, for a document that became published some other way.
 */
import { isFreePlan } from '../listen-and-learn/speech/elevenlabs-account.js';

export const FREE_PLAN_LICENCE_URL = 'https://help.elevenlabs.io/hc/en-us/articles/13313564601361';
export const ELEVENLABS_PRICING_URL = 'https://elevenlabs.io/pricing';

/**
 * Whether the transcript's stored audio was rendered by ElevenLabs on the
 * free plan, or on a plan that was not recorded.
 *
 * Only stored audio counts: a transcript with no `audioPath` puts nothing of
 * ElevenLabs's on the feed, and the host step skips it as `no_audio`.
 *
 * @param {object} doc a `podcast_transcripts` document
 */
export function renderedOnFreePlan(doc) {
  if (!doc?.audioPath || doc.speechProvider !== 'elevenlabs') return false;
  if (doc.speechFreePlan === true) return true;
  if (doc.speechFreePlan === false) return isFreePlan({ tier: doc.speechTier });
  return true;
}

/**
 * The refusal sentence for a free-plan render, or null when the audio may
 * be published. Names the licence and the upgrade, and what to do after it.
 *
 * @param {object} doc a `podcast_transcripts` document
 * @returns {string|null}
 */
export function freePlanRefusal(doc) {
  if (!renderedOnFreePlan(doc)) return null;
  const plan =
    doc.speechFreePlan === true || isFreePlan({ tier: doc.speechTier })
      ? 'on the ElevenLabs free plan'
      : 'by ElevenLabs on a plan that was not recorded';
  return (
    `This episode's audio was rendered ${plan}, which has no commercial licence and cannot be used ` +
    `for any commercial purpose (${FREE_PLAN_LICENCE_URL}), so it is not published to Podbean ` +
    `(owner decision 2026-09-26, ADR 0029 §2a). Upgrade to a paid ElevenLabs plan ` +
    `(${ELEVENLABS_PRICING_URL}), regenerate the audio, then approve again.`
  );
}

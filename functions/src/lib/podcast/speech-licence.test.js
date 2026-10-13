/**
 * The free-plan publish rule (owner decision 2026-09-26, ADR 0029 §2a).
 *
 * Pinned: ElevenLabs audio rendered on the free plan, or on a plan that was
 * never recorded, is refused, and the sentence names the licence and the
 * upgrade; paid-plan audio, audio from no provider, and a transcript with no
 * audio at all are not this rule's business.
 */
import { describe, it, expect } from 'vitest';
import {
  ELEVENLABS_PRICING_URL,
  FREE_PLAN_LICENCE_URL,
  freePlanRefusal,
  renderedOnFreePlan,
} from './speech-licence.js';

const voiced = (over = {}) => ({
  id: 'article_x',
  audioPath: 'article/x.mp3',
  speechProvider: 'elevenlabs',
  speechTier: 'free',
  speechFreePlan: true,
  ...over,
});

describe('renderedOnFreePlan', () => {
  it('is true for ElevenLabs audio rendered on the free plan', () => {
    expect(renderedOnFreePlan(voiced())).toBe(true);
    // The status said free even though the tier string did not.
    expect(renderedOnFreePlan(voiced({ speechTier: 'trial', speechFreePlan: true }))).toBe(true);
  });

  it('is false for a paid plan', () => {
    expect(renderedOnFreePlan(voiced({ speechTier: 'creator', speechFreePlan: false }))).toBe(false);
    expect(renderedOnFreePlan(voiced({ speechTier: 'starter', speechFreePlan: false }))).toBe(false);
  });

  it('treats an ElevenLabs render with no recorded plan as free, since its licence cannot be shown', () => {
    expect(renderedOnFreePlan(voiced({ speechTier: null, speechFreePlan: null }))).toBe(true);
    expect(renderedOnFreePlan(voiced({ speechTier: undefined, speechFreePlan: undefined }))).toBe(true);
  });

  it('never trusts a stored false over a tier that says free', () => {
    expect(renderedOnFreePlan(voiced({ speechTier: 'free', speechFreePlan: false }))).toBe(true);
  });

  it('is false when there is no stored audio, or another provider read it', () => {
    expect(renderedOnFreePlan(voiced({ audioPath: null }))).toBe(false);
    expect(renderedOnFreePlan(voiced({ speechProvider: 'gemini' }))).toBe(false);
    expect(renderedOnFreePlan(voiced({ speechProvider: null }))).toBe(false);
    expect(renderedOnFreePlan(null)).toBe(false);
  });
});

describe('freePlanRefusal', () => {
  it('names the licence, the upgrade and what to do after it', () => {
    const sentence = freePlanRefusal(voiced());
    expect(sentence).toMatch(/rendered on the ElevenLabs free plan/);
    expect(sentence).toMatch(/no commercial licence and cannot be used for any commercial purpose/);
    expect(sentence).toContain(FREE_PLAN_LICENCE_URL);
    expect(sentence).toMatch(/not published to Podbean/);
    expect(sentence).toMatch(/Upgrade to a paid ElevenLabs plan/);
    expect(sentence).toContain(ELEVENLABS_PRICING_URL);
    expect(sentence).toMatch(/regenerate the audio, then approve again\.$/);
    expect(FREE_PLAN_LICENCE_URL).toBe('https://help.elevenlabs.io/hc/en-us/articles/13313564601361');
  });

  it('says the plan was not recorded when it was not, rather than calling it free', () => {
    expect(freePlanRefusal(voiced({ speechTier: null, speechFreePlan: null }))).toMatch(
      /rendered by ElevenLabs on a plan that was not recorded/
    );
  });

  it('is null when the audio may be published', () => {
    expect(freePlanRefusal(voiced({ speechTier: 'pro', speechFreePlan: false }))).toBeNull();
    expect(freePlanRefusal(voiced({ audioPath: null }))).toBeNull();
  });
});

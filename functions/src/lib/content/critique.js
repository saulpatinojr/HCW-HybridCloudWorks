/**
 * critique.js — the quality gate between a generated draft and a human.
 *
 * Ported from Site-Main `lib/content-critique.js` (088f458): a deterministic
 * banned-phrase scan plus one cheap model critique. Fails OPEN — a broken
 * critique call reports `pass` with the error attached — so a provider
 * hiccup never blocks ingestion.
 */
import { scanBannedPhrases } from '../cms/content-modules.js';

export const CRITIQUE_SYSTEM_PROMPT = `You are a skeptical editor for Hybrid Cloud Works reviewing a drafted blog post before it reaches a human reviewer. Judge only what is given — do not rewrite it, do not be polite.

The content may contain inline <module type="...">...</module> tags (fact/recommendation/text/code/links/design). These are intentional structural markup for rendered UI callouts, not a defect — do not flag their presence or syntax as an issue; judge only the substance of the surrounding prose and the module content itself.

Return ONLY valid JSON, no markdown fences:
{
  "genericityScore": integer 0-10. 10 = reads like generic AI filler that could be about almost any provider or topic with a find-and-replace; 0 = highly specific and could only have been written about this exact source.
  "specificityScore": integer 0-10. 10 = full of concrete details tied to the source (real numbers, commands, version strings, named services); 0 = vague and abstract throughout.
  "verdict": "pass" or "revise".
  "issues": array of up to 5 short, specific, actionable fixes. Empty array if verdict is "pass".
}

Mark "revise" if genericityScore is 7 or higher, or specificityScore is 3 or lower, or the piece reads like a generic template rather than an article grounded in its specific source.`;

export function normalizeScore(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : fallback;
}

/**
 * @param {object} deps
 * @param {{ generateJsonResponse: Function, defaultModelFor: Function, getActiveAiProvider: Function }} deps.ai
 */
export function createCritic({ ai, signal: defaultSignal }) {
  return {
    async critiqueDraft({ title, postContent, signal: callSignal }) {
      const activeSignal = callSignal || defaultSignal;
      if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
      const bannedPhraseHits = scanBannedPhrases(`${title || ''}\n${postContent || ''}`);
      try {
        const judged = await ai.generateJsonResponse({
          prompt: `Title: ${title || 'Untitled'}\n\nContent:\n${String(postContent || '').slice(0, 12000)}`,
          systemPrompt: CRITIQUE_SYSTEM_PROMPT,
          // No explicit model. This used to resolve one for whichever provider
          // key order picked, which was harmless only while the two could not
          // disagree; with portal ordering in play it could hand a Claude model
          // id to Gemini. `purpose` lets the router pick the model for the
          // provider it actually selects.
          purpose: 'draft',
          feature: 'critique',
          signal: activeSignal,
        });
        const genericityScore = normalizeScore(judged?.genericityScore, 0);
        const specificityScore = normalizeScore(judged?.specificityScore, 10);
        const verdict =
          bannedPhraseHits.length > 0 || judged?.verdict === 'revise' ? 'revise' : 'pass';
        const issues = Array.isArray(judged?.issues) ? judged.issues.slice(0, 5).map(String) : [];
        if (bannedPhraseHits.length > 0) {
          issues.unshift(`Remove overused AI-sounding phrase(s): ${bannedPhraseHits.join(', ')}`);
        }
        return {
          verdict,
          genericityScore,
          specificityScore,
          bannedPhraseHits,
          issues: issues.slice(0, 5),
        };
      } catch (err) {
        return {
          verdict: 'pass',
          genericityScore: null,
          specificityScore: null,
          bannedPhraseHits,
          issues: [],
          error: err?.message || String(err),
        };
      }
    },
  };
}

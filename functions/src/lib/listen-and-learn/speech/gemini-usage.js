/**
 * gemini-usage.js — what a Gemini speech call is billed on: the token counts
 * the API reports, or an estimate from the audio's length when it reports
 * none (gemini.js exports these again).
 */

/**
 * Audio tokens per second, for the case where the response reports no `usage`.
 *
 * Google prices generated TTS audio at 25 tokens per second (pricing guide,
 * verified 2026-10-27). Reported counts remain preferred, and any duration-
 * derived count remains explicitly marked estimatedTokens.
 */
const AUDIO_TOKENS_PER_SECOND = 25;
export { AUDIO_TOKENS_PER_SECOND as GEMINI_AUDIO_TOKENS_PER_SECOND };

/**
 * Billing across every part. Reported counts are summed when every reply
 * carried them; if any part reported none the whole call is estimated from
 * the audio length, because mixing a billed number with a derived one would
 * put a half-fictional figure on the portal's spend page as a real one.
 */
export function summedTokenUsage(usages, seconds) {
  const each = usages.map((usage) => tokenUsage(usage, 0));
  if (each.every((u) => !u.estimatedTokens)) {
    return {
      promptTokens: each.reduce((sum, u) => sum + u.promptTokens, 0),
      completionTokens: each.reduce((sum, u) => sum + u.completionTokens, 0),
      estimatedTokens: false,
    };
  }
  return tokenUsage(null, seconds);
}

/**
 * What this call is billed on.
 *
 * Prefers the counts the API reports. TTS is priced with an audio-output rate
 * an order of magnitude above the text rate, so the output count is what
 * decides an episode's cost — reporting a made-up one would put a fictional
 * number on the portal's spend page next to real ones.
 */
export function tokenUsage(usage, seconds) {
  const reportedIn = Number(usage?.total_input_tokens);
  const reportedOut = Number(usage?.total_output_tokens);

  if (Number.isFinite(reportedIn) && Number.isFinite(reportedOut)) {
    return { promptTokens: reportedIn, completionTokens: reportedOut, estimatedTokens: false };
  }

  return {
    promptTokens: Number.isFinite(reportedIn) ? reportedIn : 0,
    completionTokens: Math.round(seconds * AUDIO_TOKENS_PER_SECOND),
    estimatedTokens: true,
  };
}

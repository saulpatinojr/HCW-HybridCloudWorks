/**
 * social-caption.js — `generateSocialCaption` (the last unimplemented social
 * RPC; api-surface.json carried it in notImplemented since the import) and
 * the caption core the on-publish auto-queue trigger shares.
 *
 * The caption is written to be posted by a person: hook first, concrete,
 * no engagement-bait, at most two hashtags. The article link is appended by
 * the CALLER (SocialHubPage composes `caption\n\nurl`; the trigger does the
 * same) so the model never invents or mangles a URL.
 */

import { startBudgetClock } from './ai/time-budget.js';
import { errorResponse } from './http/error-response.js';

export const CAPTION_MAX_CHARS = 900;

/**
 * The Generate button's AI time budget, counted from the moment the handler
 * starts. `generateSocialCaption` has no entry in the client's timeout table
 * (frontend lib/api.js), so it gets the 20 s default. Inside 15 s, a slow
 * first provider fails over rather than outliving the page (router.js
 * header, SYNCHRONOUS CALLS HAVE A TIME BUDGET). The on-publish trigger runs
 * in the background and passes none. sync-budgets.test.js pins it.
 */
export const CAPTION_AI_BUDGET_MS = 15_000;

export function buildCaptionPrompt({ title, summary, platforms = [] }) {
  const platformNote = platforms.length
    ? `It will be posted to: ${platforms.join(', ')}.`
    : 'It will be posted to professional social networks.';
  return `Write a short social-media caption announcing this article. ${platformNote}

Rules:
- First line is the hook: the article's sharpest concrete point, not "New blog post".
- 2 to 4 short lines total, under ${CAPTION_MAX_CHARS} characters.
- Sound like a practitioner sharing something useful, never like marketing.
- No emojis walls, no "link in bio", no engagement bait, no invented facts.
- At most two hashtags, only if they are genuinely standard for the topic.
- Do NOT include any URL — the link is appended separately.

Article title: ${title}
Article summary: ${summary}

Reply with the caption text only.`;
}

/**
 * The shared core: one model call, feature-gated as socialCaption.
 * @returns {Promise<string>} the caption (trimmed, capped)
 */
export async function generateCaptionText(
  { ai },
  { title = '', summary = '', platforms = [], budgetMs = null }
) {
  const caption = await ai.generateTextResponse({
    prompt: buildCaptionPrompt({ title, summary, platforms }),
    purpose: 'general',
    feature: 'socialCaption',
    budgetMs,
  });
  return String(caption || '')
    .trim()
    .slice(0, CAPTION_MAX_CHARS);
}

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * POST /api/generateSocialCaption — { contentId?, title, summary, sourceUrl?,
 * platforms? } → { success, caption }. Title and summary come from the
 * caller's already-loaded content row (SocialHubPage sends both); when only a
 * contentId is sent, the document is read so the Telegram/portal callers can
 * stay thin.
 */
export function createSocialCaptionHandlers({
  guard,
  store,
  ai,
  aiBudgetMs = CAPTION_AI_BUDGET_MS,
}) {
  async function generateSocialCaption(request, context) {
    const budgetLeft = startBudgetClock(aiBudgetMs);
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    try {
      const body = (await request.json().catch(() => null)) || {};
      let { title = '', summary = '' } = body;
      const platforms = Array.isArray(body.platforms) ? body.platforms.map(String) : [];

      if ((!title || !summary) && body.contentId) {
        const doc = await store.readDoc('content', String(body.contentId), String(body.contentId));
        title = title || doc?.Title || doc?.title || '';
        summary = summary || doc?.Summary || doc?.summary || '';
      }
      if (!String(title).trim() && !String(summary).trim()) {
        return json(400, { error: 'title or summary (or a resolvable contentId) required' });
      }

      const caption = await generateCaptionText(
        { ai },
        { title, summary, platforms, budgetMs: budgetLeft() }
      );
      if (!caption) return json(502, { error: 'Caption generation returned nothing' });
      return json(200, { success: true, caption });
    } catch (error) {
      return errorResponse(context, 'Failed to generate caption', error, 500, request);
    }
  }
  return { generateSocialCaption };
}

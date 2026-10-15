/**
 * The voice-calibration job (registered in functions/forge-jobs.js): reads
 * the owner's recent published posts and writes SUGGESTED wordSoup additions
 * and style hints onto the profile's `suggestions` field. Never merged
 * automatically: the Studio renders them as accept/dismiss chips, and an
 * accept arrives back as an ordinary updateForgeConfig carrying the new
 * wordSoup — so the profile stays the owner's own, keystroke for keystroke
 * (PR #841 split of forge-studio.js).
 */
import { ADMIN_CONFIG_PARTITION } from '../../cosmos-client.js';
import { normalizeSuggestions } from './config.js';

const CALIBRATION_PROMPT = `You are analysing a set of published articles by one author to help them tune an AI writing profile that must sound exactly like them. Study the writing itself: sentence rhythm, vocabulary, recurring analogies, opinions they keep returning to, how they open and close, what they never say.

Return strict JSON with keys:
- wordSoupAdditions: array of short third-person notes (max 15) capturing the author's perspective, recurring themes, opinions and domain anchors, each usable verbatim inside a "who this author is" context block.
- styleHints: array of short imperative style rules (max 10) an AI drafter should follow to sound like this author (e.g. sentence length habits, how they use examples, what they avoid).
- recurringPhrases: array of short phrases (max 10) the author genuinely reuses, worth keeping available.

Base every entry ONLY on the supplied articles. No generic writing advice. No code fences, only raw JSON.`;

/** Retries for the suggestions write under a concurrent profile save. */
export const CALIBRATION_WRITE_ATTEMPTS = 3;

/**
 * Write `suggestions` onto forge_profile without losing a concurrent edit.
 *
 * The job runs for minutes while the owner may be saving the profile in the
 * Studio; a plain read-modify-write here put the profile back to what the
 * job had read (ADR 0033 inventory: "calibration read-modify-write without
 * ETag"). The replace is conditional on the ETag the read returned; a 412
 * re-reads and tries again, and a profile that does not exist yet is
 * created, with a 409 (someone created it first) looping back to the
 * replace path.
 */
export async function writeSuggestions(store, suggestions) {
  for (let attempt = 0; attempt < CALIBRATION_WRITE_ATTEMPTS; attempt += 1) {
    const current = await store.readDoc('admin_config', 'forge_profile', ADMIN_CONFIG_PARTITION);
    try {
      if (current) {
        return await store.replaceDocIfMatch(
          'admin_config',
          {
            ...current,
            id: 'forge_profile',
            configScope: ADMIN_CONFIG_PARTITION,
            suggestions,
          },
          { partitionKey: ADMIN_CONFIG_PARTITION }
        );
      }
      return await store.createDoc('admin_config', {
        id: 'forge_profile',
        configScope: ADMIN_CONFIG_PARTITION,
        suggestions,
      });
    } catch (error) {
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw new Error('Could not write calibration suggestions: the profile kept changing.');
}

/**
 * The voice-calibration job body. Reads the owner's most recent published
 * posts, asks one model call for profile suggestions, and writes them to
 * forge_profile.suggestions — and nothing else. A test pins that invariant.
 *
 * @param {{ postCount?: number }} payload
 * @param {object} deps — { store, ai, now, log }
 */
export async function runVoiceCalibration(
  payload,
  { store, ai, now = () => new Date(), log = {}, signal }
) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const postCount = Math.max(3, Math.min(15, Number(payload?.postCount) || 10));
  const posts = await store.queryDocs(
    'content',
    'SELECT TOP @n c.Title, c.blogDraft, c.content, c.Content, c.postContent FROM c WHERE c.Live = true ORDER BY c.publishedAt DESC',
    [{ name: '@n', value: postCount }]
  );
  // The body under whichever field the pipeline wrote it, first one wins.
  const bodyOf = (post) =>
    String([post.blogDraft, post.content, post.Content, post.postContent].find(Boolean) || '');
  const bodies = (posts || [])
    .map((post) => {
      const text = bodyOf(post);
      return text ? `## ${post.Title || 'Untitled'}\n\n${text.slice(0, 6000)}` : '';
    })
    .filter(Boolean);
  if (bodies.length === 0) {
    throw new Error('No published posts with a body to calibrate from.');
  }

  const parsed = await ai.generateJsonResponse({
    prompt: `${CALIBRATION_PROMPT}\n\nArticles (${bodies.length}):\n\n${bodies.join('\n\n---\n\n')}`,
    purpose: 'analysis',
    feature: 'voiceCalibration',
    signal,
  });

  const suggestions = normalizeSuggestions({
    ...parsed,
    generatedAt: now().toISOString(),
    postCount: bodies.length,
  });

  await writeSuggestions(store, suggestions);
  log.log?.(
    `[voice-calibration] ${bodies.length} posts → ${suggestions.wordSoupAdditions.length} additions, ${suggestions.styleHints.length} hints`
  );
  return suggestions;
}

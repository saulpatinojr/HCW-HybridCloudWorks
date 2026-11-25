/**
 * ai-cover-prompt.js — the words an AI cover is generated from, and where
 * its file goes: the built-in prompt, the Image Prompts library or the
 * editor's own, the per-provider default heroes, and the blob path.
 * ai-cover.js says how a cover is made and exports all of this again.
 */
import {
  composeSetPrompt,
  lineageFor,
  loadKeywordMatrix,
  resolvePromptSetForContent,
} from '../cms/image-prompts.js';
import { errorFacts } from '../http/error-response.js';

/**
 * The curated per-provider default heroes (T-606): admin_config/default_heroes
 * carries { heroes: { Azure: '/api/public/media/covers/…', AWS: …, Multi: … } }
 * — uploaded once by the owner through the image gallery. Absent doc or
 * provider key = no fallback, same behavior as before the feature.
 */
export const DEFAULT_HEROES_CONFIG_ID = 'default_heroes';

/** Case-insensitive provider → hero URL, with Multi as the catch-all. */
export function pickDefaultHero(heroes = {}, providerRaw = '') {
  const provider = String(providerRaw || '')
    .trim()
    .toLowerCase();
  const entries = Object.entries(heroes || {});
  const byKey = (wanted) => entries.find(([key]) => key.toLowerCase() === wanted)?.[1] || null;
  if (provider) {
    const exact = byKey(provider);
    if (exact) return exact;
    if (provider.includes('google')) {
      const gcp = byKey('gcp');
      if (gcp) return gcp;
    }
  }
  return byKey('multi');
}

export const PROVIDER_THEMES = Object.freeze({
  Azure: { color: 'blue and white', vibe: 'modern and corporate' },
  AWS: { color: 'orange and dark blue', vibe: 'professional and energetic' },
  GCP: { color: 'multicolor (blue, red, yellow, green)', vibe: 'playful and innovative' },
  GitHub: { color: 'purple and dark gray', vibe: 'developer-focused and sleek' },
  Terraform: { color: 'purple', vibe: 'technical and structured' },
  FinOps: { color: 'teal and green', vibe: 'financial and analytical' },
  // #775. Docker's blue is the site's --docker-blue, #1D63ED.
  Docker: { color: 'bright blue and white', vibe: 'modular and developer-friendly' },
  Multi: { color: 'multicolor gradient', vibe: 'versatile and integrated' },
});

/** The built-in prompt: the ultimate fallback when no set applies. */
export const BUILTIN_PROMPT_VERSION = 'builtin-lego-v1';

export function buildImagePrompt(article) {
  const provider =
    [article.cloudProvider, article['Cloud Provider'], article.provider, article.Provider].find(
      Boolean
    ) || 'Azure';
  const theme = PROVIDER_THEMES[provider] || PROVIDER_THEMES.Azure;
  if (article.keyTopics && article.visualTheme && article.summary) {
    return `Create a professional technical illustration in ${theme.color} color scheme with a ${theme.vibe} aesthetic.

Scene: 2-3 cute Lego minifigure-style characters collaborating to build cloud infrastructure.

They are constructing and working on: ${article.keyTopics.join(', ')}

Visual metaphor: ${article.visualTheme}

Context: ${article.summary}

Style requirements:
- Isometric 3D illustration, clean and modern design
- Modular building blocks with Lego brick aesthetic
- Characters actively building/connecting/deploying components
- Subtle ${provider} branding elements (colors, logo hints)
- Tech-focused and professional yet playful
- No text overlays, labels, or written words in the image
- Focus on the collaborative building activity

The scene should visually represent the article's core concepts through the Lego characters' construction work.`;
  }
  const resources =
    [article.resources, article.Resources, article.title, article.Title].find(Boolean) ||
    'cloud infrastructure';
  return `Create a professional technical illustration in ${theme.color} color scheme with a ${theme.vibe} aesthetic. The scene features cute Lego minifigure-style characters collaborating to build cloud infrastructure. Show 2-3 blocky characters working together on: ${resources}. The characters should be constructing these as modular building blocks, similar to Lego bricks. Include subtle ${provider} branding elements. Style: isometric 3D illustration, clean and modern, tech-focused, with a playful builder theme. No text or logos, just the visual scene.`;
}

/**
 * The prompt a cover generation sends, and where it came from.
 *
 *   override  the editor typed one (`altCoverImagePrompt`) — used verbatim
 *   library   the Image Prompts set resolved for this document
 *   builtin   the Lego prompt above
 *
 * Never throws: a library that cannot be read falls through to the built-in
 * prompt with the reason logged, because a cover is still owed.
 *
 * @returns {Promise<{ prompt: string, source: 'override'|'library'|'builtin', lineage: object, aspectRatio?: string }>}
 */
export async function resolveCoverPrompt({ store, log = {} }, data, { slot = 'hero' } = {}) {
  const provided = typeof data.altCoverImagePrompt === 'string' && data.altCoverImagePrompt.trim();
  if (provided) {
    return {
      prompt: provided,
      source: 'override',
      aspectRatio: undefined,
      lineage: lineageFor({
        set: null,
        prompt: null,
        promptText: provided,
        slot,
        source: 'override',
      }),
    };
  }
  try {
    const resolved = await resolvePromptSetForContent(store, data);
    if (resolved?.set?.primaryPrompt) {
      const keyword = await loadKeywordMatrix(store, log);
      const prompt = composeSetPrompt({
        set: resolved.set,
        prompt: resolved.prompt,
        slot,
        article: data,
        keyword,
      });
      return {
        prompt,
        source: 'library',
        aspectRatio: String(resolved.set.aspectRatio || '').trim() || undefined,
        lineage: lineageFor({
          set: resolved.set,
          prompt: resolved.prompt,
          promptText: prompt,
          slot,
          source: resolved.source,
        }),
      };
    }
  } catch (error) {
    log.warn?.(
      `[generateAiCover] prompt library unavailable, using built-in prompt: ${errorFacts(error)}`
    );
  }
  const prompt = buildImagePrompt(data);
  return {
    prompt,
    source: 'builtin',
    aspectRatio: undefined,
    lineage: {
      ...lineageFor({ set: null, prompt: null, promptText: prompt, slot, source: 'builtin' }),
      promptTemplateVersion: BUILTIN_PROMPT_VERSION,
    },
  };
}

/** Requested image slots, capped at 4; hero-only when none are set. */
export function resolveAiCoverTargets(data) {
  return Array.isArray(data.aiImageTargets) && data.aiImageTargets.length > 0
    ? data.aiImageTargets.slice(0, 4)
    : ['hero'];
}

/** `2026-08-28T12:00:00.000Z` → `20260828120000`: safe in a blob name. */
export function compactStamp(iso) {
  return String(iso || '')
    .replace(/[-:TZ]/g, '')
    .replace(/\..*$/, '')
    .slice(0, 14);
}

/**
 * The blob path for one generated cover. Stamped so a regeneration writes a
 * new file beside the old one rather than over it (ADR 0033 §6.2).
 */
export function aiCoverBlobPath(contentId, target, stampIso) {
  return `${contentId}-ai-${target}-${compactStamp(stampIso)}.png`;
}


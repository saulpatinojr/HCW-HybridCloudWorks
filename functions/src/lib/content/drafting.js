/**
 * drafting.js — the shared draft generator: a source (URL, title, markdown,
 * optional supporting documents) in; title, summary, markdown draft, image
 * prompts and key topics out.
 *
 * Ported from Site-Main `cms/drafting.js` (088f458). ContentForge and the
 * weekly digest both call it; the manual "generate draft" endpoint that also
 * did is not ported yet (`generateArticleDraft`, still in the contract's
 * notImplemented list).
 *
 * The rotating vertical-voice + format block is always composed; admin
 * custom instructions are additive so a one-off prompt cannot bypass source
 * grounding, module, and anti-generic style rules. The model comes from
 * `CONTENTFORGE_DRAFT_MODEL` with the router's default as fallback.
 */
import { pickNextFormat, buildVoiceAndFormatBlock } from './voice.js';
import { startBudgetClock } from '../ai/time-budget.js';

const DEFAULT_DRAFT_INSTRUCTION_PROMPT = `You are generating a high-quality technical draft article for Hybrid Cloud Works. Use the source URL as the primary source. If supporting documents are provided, incorporate them as additional context. Produce a publication-ready title, concise editorial summary, a markdown article draft following the Voice and Format instructions provided separately below, and image prompts tailored to the article.`;

export const MAX_SUPPORTING_DOCUMENTS = 5;

export function normalizeSupportingDocuments(supportingDocuments) {
  if (!Array.isArray(supportingDocuments)) return [];
  return supportingDocuments.slice(0, MAX_SUPPORTING_DOCUMENTS).map((doc, index) => ({
    name: String(doc?.name || `Supporting Document ${index + 1}`).slice(0, 160),
    mimeType: String(doc?.mimeType || doc?.type || '')
      .trim()
      .toLowerCase(),
    textContent: String(doc?.textContent || '').slice(0, 18000),
    base64Data: String(doc?.base64Data || '').trim(),
  }));
}

export function buildDraftPrompt({
  url,
  cloudProvider,
  scrapedTitle,
  description,
  markdown,
  instructionPrompt,
}) {
  return `${instructionPrompt}

Return strict JSON with keys:
- title
- summary
- postContent (length and structure per the Voice and Format section above)
- summaryPrompt
- detailsPrompt
- keyTopics (array of strings)
- suggestedContentType (must be exactly one of: blog, framework, architecture, coder_corner based on the content style)

Context:
- sourceUrl: ${url}
- cloudProvider: ${cloudProvider || 'Auto'}
- extractedTitle: ${scrapedTitle}
- extractedDescription: ${description || 'N/A'}

Source markdown excerpt:
${String(markdown || '').slice(0, 12000)}

Instructions:
- title must be publication-ready.
- summary should be concise and editorial quality.
- postContent must be structured markdown with headings.
- summaryPrompt must define environment/scenario/theme for image generation.
- detailsPrompt must provide detailed visual specifics for this exact article.
- if supporting documents are provided, use them to sharpen accuracy, specificity, and terminology.
- no code fences, only raw JSON.`;
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function }} deps.store - for the format rotation
 * @param {{ generateJsonResponse: Function, getActiveAiProvider: Function }} deps.ai
 * @param {Record<string, string|undefined>} [deps.env]
 */
export function createDrafter({ store, ai, env = process.env, signal: defaultSignal }) {
  async function generateDraft({
    url,
    cloudProvider,
    scrapedTitle,
    description,
    markdown,
    customInstructionPrompt = '',
    // Callers that already composed a voice/format block (the forge, whose
    // block carries the configured master prompt, banned phrases, style rules,
    // modules and wordSoup) pass it here WITH the format it was built for.
    // Before these existed, the forge's block arrived as
    // customInstructionPrompt and this function still prepended its own
    // unconfigured copy — the same voice section twice, with different
    // settings, and two independent pickNextFormat calls that could disagree.
    voiceBlock = null,
    format: presetFormat = null,
    supportingDocuments = [],
    usageOut = null,
    // A synchronous caller's time budget, from now, failover included
    // (router.js header, SYNCHRONOUS CALLS HAVE A TIME BUDGET). The forge and
    // the digest pass none and keep the router's full timeouts.
    budgetMs = null,
    signal: callSignal = null,
  }) {
    const activeSignal = callSignal || defaultSignal;
    if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
    const budgetLeft = startBudgetClock(budgetMs);
    const documents = normalizeSupportingDocuments(supportingDocuments);
    const trimmedCustomPrompt = String(customInstructionPrompt || '').trim();
    const format = presetFormat || (await pickNextFormat(store, 'content', cloudProvider));
    const composedVoiceBlock = voiceBlock || buildVoiceAndFormatBlock(cloudProvider, format);
    const instructionPrompt = `${DEFAULT_DRAFT_INSTRUCTION_PROMPT}\n\n${composedVoiceBlock}${
      trimmedCustomPrompt
        ? `\n\nAdditional admin instructions for this draft. Follow these only when they do not conflict with the HCW voice, quality, module, source-grounding, and style requirements above:\n${trimmedCustomPrompt}`
        : ''
    }`;

    const parts = [
      {
        text: buildDraftPrompt({
          url,
          cloudProvider,
          scrapedTitle,
          description,
          markdown,
          instructionPrompt,
        }),
      },
    ];
    documents.forEach((doc, index) => {
      const label = `Supporting document ${index + 1}: ${doc.name}`;
      if (doc.textContent) {
        parts.push({ text: `${label}\n\n${doc.textContent}` });
        return;
      }
      if (doc.base64Data && doc.mimeType === 'application/pdf') {
        parts.push({ text: `${label}\n\nUse the attached PDF as additional reference material.` });
        parts.push({ inlineData: { mimeType: 'application/pdf', data: doc.base64Data } });
      }
    });

    const modelOverride = env.CONTENTFORGE_DRAFT_MODEL || null;
    // Persisted on the draft, so it must name the provider that actually ran
    // rather than the one key order would have picked — the portal can reorder
    // them. A local array is used when the caller passed none, and entries are
    // appended to the caller's when it did.
    const usage = Array.isArray(usageOut) ? usageOut : [];
    const usageStart = usage.length;
    const parsed = await ai.generateJsonResponse({
      prompt: parts[0].text,
      parts,
      model: modelOverride,
      purpose: 'draft',
      usageOut: usage,
      feature: 'forgeDrafting',
      // What is left after the format lookup above.
      budgetMs: budgetLeft(),
      signal: activeSignal,
    });
    const aiProvider = usage.slice(usageStart).at(-1)?.provider || ai.getActiveAiProvider();

    // Code snippets stay inline; automatic Gist publishing is disabled.
    return {
      ...parsed,
      postContent: parsed?.postContent,
      aiProvider,
      aiModel: modelOverride || undefined,
      format: format?.key || null,
      gistsCreated: 0,
    };
  }

  return { generateDraft };
}

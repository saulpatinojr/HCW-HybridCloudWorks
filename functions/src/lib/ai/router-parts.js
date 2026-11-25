/**
 * router-parts.js — a call's message parts in the shape each provider API
 * takes (router.js). A part a converter cannot carry is refused, never
 * dropped.
 */

/**
 * A part a converter cannot carry is refused, never dropped.
 *
 * Until #433 each converter returned null for a shape it did not recognise and
 * filtered it out, so a `fileData` part reached the model as nothing and the
 * model answered — confidently — without it. Nothing errored and nothing
 * logged. The refusal is a 400 on purpose: `isRetryableError` will not retry
 * it and `isProviderUnusable` will not fail over from it, because the next
 * provider would refuse the same part (or, worse, be the one that drops it).
 * The wording avoids every token those two predicates match on.
 */
function refusePart(provider, part, expected) {
  const shape =
    part && typeof part === 'object' ? `{${Object.keys(part).join(', ')}}` : String(typeof part);
  const err = new Error(
    `Cannot send a prompt part to ${provider}: expected ${expected}, got ${shape}. Nothing was sent.`
  );
  err.status = 400;
  err.code = 'AI_PART_REFUSED';
  return err;
}

/** Multimodal parts → OpenAI content blocks. */
export function toOpenAiContent(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ type: 'text', text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    const mime = String(part?.inlineData?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') && part?.inlineData?.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
      };
    }
    throw refusePart(
      'openai',
      part,
      mime
        ? `{text} or image/* inline data, not ${mime}`
        : '{text} or {inlineData:{mimeType:image/*,data}}'
    );
  });
}

/**
 * Parts → one plain string, for a text-only provider. Only text parts are
 * possible here — `chainForParts` keeps anything else away — so any other
 * shape is refused rather than dropped, as everywhere else.
 */
export function toPlainText(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return prompt;
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text;
      throw refusePart('nvidia', part, '{text}');
    })
    .join('\n\n');
}

/** Multimodal parts → Anthropic content blocks. */
export function toAnthropicContent(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ type: 'text', text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    const mime = String(part?.inlineData?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') && part?.inlineData?.data) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    throw refusePart(
      'anthropic',
      part,
      mime
        ? `{text} or image/* inline data, not ${mime}`
        : '{text} or {inlineData:{mimeType:image/*,data}}'
    );
  });
}

/** Multimodal parts → Gemini parts (already the native shape). */
export function toGeminiParts(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { text: part.text };
    if (part?.inlineData?.mimeType && part?.inlineData?.data) {
      return {
        inlineData: {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    // A URL the model should fetch is not a part on this endpoint at all — it
    // is a grounded call; see generateGroundedJsonResponse.
    throw refusePart('gemini', part, '{text} or {inlineData:{mimeType,data}}');
  });
}

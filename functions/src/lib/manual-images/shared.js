/**
 * What the manual image handlers share: the JSON reply, the blob-path
 * stamp, the model description a caller is told, the preview slots and the
 * named-set read (PR #841 split of manual-images.js).
 */
import { normalizePromptConfigKey } from '../cms/image-prompts.js';
import { authoredMessage, errorResponse, logFailure } from '../http/error-response.js';

export const PREVIEW_SLOTS = ['hero', 'secondary1', 'secondary2', 'secondary3'];

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** An ISO stamp as the 14 digits a blob path carries. */
export const compact = (iso) =>
  String(iso || '')
    .replace(/[-:TZ]/g, '')
    .replace(/\..*$/, '')
    .slice(0, 14);

/** What a caller is told about the model behind a generation. */
export function modelInfo(replicate) {
  return {
    imageProvider: replicate?.provider || 'replicate',
    imageModel: replicate?.model || '',
    costPerImageUsd:
      typeof replicate?.costPerImageUsd === 'number' ? replicate.costPerImageUsd : null,
  };
}

/** The set (and prompt) a request names, when it names one and it exists. */
export async function readNamedSet(store, setName, promptName) {
  const set = normalizePromptConfigKey(setName);
  if (!set || typeof store.readDoc !== 'function') return { set: null, prompt: null };
  const setDoc = await store.readDoc('image_prompt_sets', set, set).catch(() => null);
  if (!setDoc) return { set: null, prompt: null };
  const prompt = normalizePromptConfigKey(promptName);
  const promptDoc = prompt
    ? await store.readDoc('image_prompt_sets_prompts', prompt, set).catch(() => null)
    : null;
  return { set: setDoc, prompt: promptDoc };
}

/**
 * The answer every generation route gives when the generator or the store
 * throws: a 500 with the message and the cause — except for the image
 * budget (triggers/ai-cover.js), whose refusal carries its own status (429
 * exhausted, 503 unreadable) and code, kept so the page can say "paused"
 * rather than "server error" (#854).
 */
export function generationFailure(context, label, error, message, request = null) {
  const budget = typeof error?.code === 'string' && error.code.startsWith('IMAGE_BUDGET_');
  if (budget) {
    // The budget's own sentence is authored (ImageBudgetError); the log line
    // is content-free, with the code and the correlation id (#945).
    const correlationId = logFailure(context, `${label} paused`, error, request);
    return json(error.status || 429, {
      error: message,
      code: error.code,
      message: authoredMessage(error, 'Image generation is paused by the monthly budget.'),
      correlationId,
    });
  }
  return errorResponse(context, message, error, 500, request);
}

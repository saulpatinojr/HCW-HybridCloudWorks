/**
 * The keyword matrix: synonym groups and scene augmentations, applied to the
 * text of the article being illustrated (PR #841 split of image-prompts.js).
 */
import { KEYWORD_COLLECTIONS, LIST_WINDOW } from './shared.js';
import { errorFacts } from '../../http/error-response.js';

/** Does any of `patterns` appear in the lower-cased text? */
function hitsIn(lower, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const p = String(pattern || '')
      .trim()
      .toLowerCase();
    return p && lower.includes(p);
  });
}

/** The distinct `field` values of the groups whose patterns hit, in order. */
function matchedValues(lower, groups, field) {
  const values = [];
  for (const group of groups || []) {
    const value = String(group?.[field] || '').trim();
    if (value && hitsIn(lower, group.patterns) && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * What the keyword matrix does to a piece of text: synonym groups whose
 * patterns appear collapse to their canonical tag; augmentations whose
 * patterns appear contribute their scene directive. Case-insensitive
 * substring match, which is what the panel's live tester has always shown.
 */
export function applyKeywordMatrix(text, { synonyms = [], augmentations = [] } = {}) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return { canonical: [], directives: [] };
  return {
    canonical: matchedValues(lower, synonyms, 'canonical'),
    directives: matchedValues(lower, augmentations, 'directive'),
  };
}

/** The prompt lines a matrix result contributes; [] when nothing matched. */
export function keywordMatrixLines(result) {
  const lines = [];
  if (result?.canonical?.length) lines.push(`Key concepts: ${result.canonical.join(', ')}.`);
  for (const directive of result?.directives || []) lines.push(directive);
  return lines;
}

/**
 * Both keyword collections, for a generator. Never throws: a matrix that
 * cannot be read is an empty matrix, because the image is the work and the
 * matrix is seasoning. A store without `queryDocs` reads as empty too.
 */
export async function loadKeywordMatrix(store, log = {}) {
  if (typeof store?.queryDocs !== 'function') return { synonyms: [], augmentations: [] };
  try {
    const [synonyms, augmentations] = await Promise.all([
      store.queryDocs(KEYWORD_COLLECTIONS.synonyms, `SELECT TOP ${LIST_WINDOW} * FROM c`, []),
      store.queryDocs(KEYWORD_COLLECTIONS.augmentations, `SELECT TOP ${LIST_WINDOW} * FROM c`, []),
    ]);
    return { synonyms: synonyms || [], augmentations: augmentations || [] };
  } catch (error) {
    log.warn?.(`[imagePrompts] keyword matrix unavailable: ${errorFacts(error)}`);
    return { synonyms: [], augmentations: [] };
  }
}

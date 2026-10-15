/**
 * The set document's creative fields (ADR 0033 §4 Images): bounds, version
 * and history rules, and the template-version stamp a generated image
 * records (PR #841 split of image-prompts.js).
 */
import { ContentValidationError, assertStringLength } from '../content-update-validation.js';
import { normalizePromptConfigKey } from './shared.js';

/** Aspect ratios Replicate's image models accept; '' means "model default". */
export const SET_ASPECT_RATIOS = Object.freeze(['', '16:9', '1:1', '4:3', '3:2', '9:16', '4:5']);
export const SET_HISTORY_LIMIT = 10;
export const SET_TAG_LIMIT = 20;

const SET_TEXT_LIMITS = Object.freeze({
  purpose: 500,
  theme: 500,
  styleRules: 4000,
  negativePrompt: 2000,
});

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((tag) =>
          String(tag || '')
            .trim()
            .toLowerCase()
            .slice(0, 40)
        )
        .filter(Boolean)
    ),
  ].slice(0, SET_TAG_LIMIT);
}

const named = (body, key) => body[key] !== undefined && body[key] !== null;

/** The bounded text fields a body names; throws on an over-long one. */
function creativeTextFields(body) {
  const fields = {};
  for (const [key, limit] of Object.entries(SET_TEXT_LIMITS)) {
    if (!named(body, key)) continue;
    assertStringLength(body[key], key, limit, { allowEmpty: true });
    fields[key] = String(body[key] || '').trim();
  }
  return fields;
}

/** The aspect ratio a body names, validated; throws on an unknown one. */
function aspectRatioField(body) {
  if (!named(body, 'aspectRatio')) return {};
  const ratio = String(body.aspectRatio || '').trim();
  if (!SET_ASPECT_RATIOS.includes(ratio)) {
    throw new ContentValidationError(
      `aspectRatio must be one of ${SET_ASPECT_RATIOS.filter(Boolean).join(', ')}`
    );
  }
  return { aspectRatio: ratio };
}

/** The creative fields a body names, bounded; throws on a bad one. */
function creativeSetFields(body) {
  return {
    ...creativeTextFields(body),
    ...aspectRatioField(body),
    ...(named(body, 'tags') ? { tags: cleanTags(body.tags) } : {}),
  };
}

/**
 * Version and history: a new set starts at 1 with its creation stamps; an
 * existing one increments only when the primary prompt text changed, pushing
 * the previous prompt onto `history` (newest first, capped).
 */
function setVersionFields(existing, primaryPrompt, { nowIso, updatedBy }) {
  if (!existing) return { version: 1, history: [], createdAt: nowIso, createdBy: updatedBy };
  const previousPrompt = String(existing.primaryPrompt || '').trim();
  if (previousPrompt === primaryPrompt) return {};
  const previousVersion = Number(existing.version) || 1;
  return {
    version: previousVersion + 1,
    history: [
      {
        version: previousVersion,
        primaryPrompt: previousPrompt,
        savedAt: existing.updatedAt || null,
        savedBy: existing.updatedBy || null,
      },
      ...(Array.isArray(existing.history) ? existing.history : []),
    ].slice(0, SET_HISTORY_LIMIT),
  };
}

/**
 * The fields a saveSet writes, given what exists. Pure, so the version and
 * history rules are testable: `version` increments when the primary prompt
 * text changes, and the previous prompt is pushed onto `history` (newest
 * first, capped at SET_HISTORY_LIMIT). Optional creative fields are written
 * only when the body names them, so an older client that sends only
 * `primaryPrompt` cannot blank a set's style rules.
 *
 * @throws {ContentValidationError} on an over-long field or an unknown aspect ratio
 */
export function buildSetSaveFields(existing, body, { nowIso, updatedBy }) {
  const primaryPrompt = String(body.primaryPrompt || '').trim();
  return {
    primaryPrompt,
    updatedAt: nowIso,
    updatedBy,
    ...creativeSetFields(body),
    ...setVersionFields(existing, primaryPrompt, { nowIso, updatedBy }),
  };
}

/** `${name}@v${version}` — the template version a generated image records. */
export function promptTemplateVersionFor(set) {
  const name = normalizePromptConfigKey(set?.name || set?.id);
  return name ? `${name}@v${Number(set?.version) || 1}` : '';
}

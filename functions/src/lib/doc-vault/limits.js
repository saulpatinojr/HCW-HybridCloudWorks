/**
 * doc-vault/limits.js — the limits of a Doc Vault document and the refusal
 * a field that breaks one is answered with. Shared by fields.js and
 * tags-links.js; model.js re-exports what callers use.
 */
import { AuthoredError } from '../http/error-response.js';

export const CATEGORIES = Object.freeze([
  'Template',
  'Application',
  'Letter',
  'Notes',
  'Reference',
  'Other',
]);
export const DEFAULT_CATEGORY = 'Other';

export const MAX_TITLE_CHARS = 200;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 40;
export const MAX_LINK_CHARS = 500;
/** The body cap, in UTF-8 bytes, as the draft body cap is. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Thrown for input the owner can correct; the handler answers 400 with the sentence (authored, #945). */
export class DocVaultInputError extends AuthoredError {}

export const fail = (message) => {
  throw new DocVaultInputError(message);
};

/** True when the text holds a control character (tab and line breaks allowed with `allowLayout`). */
export const hasControlCharacter = (text, { allowLayout }) => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) return true;
    if (allowLayout && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

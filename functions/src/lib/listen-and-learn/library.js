/**
 * The Audio Library model over the two Listen & Learn containers (ADR 0033
 * §4): a BOOK or COURSE is a `listen_and_learn` document, a CHAPTER or LESSON
 * is a `listen_and_learn_episodes` document in its partition, and an AUDIO
 * VERSION is an entry in the chapter's `versions[]` (publish.js). No new
 * container: everything here is new fields on the existing documents, read
 * with defaults so a set generated before the library existed is a course
 * with one implicit version per episode.
 *
 * This module is the pure half — the body validators the handlers apply and
 * the view shapes they return — so every rule about what a book may carry is
 * testable without a store. The handlers (handlers.js) do the I/O.
 */
import { STATUS, manualChapterId, slugifyTitle } from './publish.js';
import { authoredMessage } from '../http/error-response.js';
import { normalizeVoiceSettings, voiceSettingsOf } from './speech-settings.js';
import {
  checkBoolean,
  checkEnum,
  checkInteger,
  checkPattern,
  checkTags,
  checkText,
  checkUrl,
  collectFields,
  fail,
  firstError,
} from './validate.js';

export const BOOK_KINDS = Object.freeze(['course', 'book']);

/** A provider segment is a blob path segment and a public route segment. */
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
/** A book's code is its slug: the exam code slot for a book with no exam. */
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** A version id as `publish.js` mints them (`versionStamp`). */
const VERSION_ID_PATTERN = /^[a-z0-9]{1,20}$/i;

export const LIMITS = Object.freeze({
  title: 160,
  author: 120,
  description: 2000,
  tag: 40,
  tags: 20,
  url: 500,
  // Enough for a long article; the speech is chunked, so this is a cost and
  // sanity bound rather than a provider limit.
  sourceText: 60000,
});

// ── field checks the generic ones in validate.js do not cover ──────────────

function checkVoice(value) {
  if (value === undefined) return { skip: true };
  const voice = normalizeVoiceSettings(value);
  return voice.error ? fail(voice.error) : { value: voice.value };
}

function checkSourceContentIds(value) {
  if (value === undefined) return { skip: true };
  const valid = Array.isArray(value) && value.every((id) => typeof id === 'string' && id.trim());
  if (!valid) return fail('sourceContentIds must be an array of ids');
  return { value: [...new Set(value.map((id) => id.trim()))].slice(0, 50) };
}

/**
 * Text to speak, trimmed but with its line breaks kept — `checkText`
 * collapses whitespace for a label, which spoken text must not have done to
 * it. `null` clears the text.
 */
function checkSpokenText(value) {
  if (value === undefined) return { skip: true };
  if (value !== null && typeof value !== 'string') return fail('sourceText must be a string');
  const text = value === null ? '' : value.trim();
  if (text.length > LIMITS.sourceText) {
    return fail(`sourceText must be at most ${LIMITS.sourceText} characters`);
  }
  return { value: text || null };
}

function checkClearError(value) {
  if (value === undefined) return { skip: true };
  return value === true ? { value: true } : fail('clearError must be true');
}

/**
 * The fields a book PATCH may carry, validated: `{ value }` holds only the
 * fields present in the body, so the handler can hand it to `patchDoc`
 * without touching anything the body did not name.
 */
export function parseBookPatch(body) {
  return collectFields([
    ['title', checkText(body?.title, 'title', LIMITS.title, { required: true })],
    ['certTitle', checkText(body?.certTitle, 'certTitle', LIMITS.title)],
    ['author', checkText(body?.author, 'author', LIMITS.author)],
    ['description', checkText(body?.description, 'description', LIMITS.description)],
    ['coverImageUrl', checkUrl(body?.coverImageUrl, 'coverImageUrl', LIMITS.url)],
    ['tags', checkTags(body?.tags, { maxTags: LIMITS.tags, maxTagLength: LIMITS.tag })],
    ['kind', checkEnum(body?.kind, 'kind', BOOK_KINDS)],
    ['voice', checkVoice(body?.voice)],
    ['sourceContentIds', checkSourceContentIds(body?.sourceContentIds)],
  ]);
}

/**
 * A book PATCH body as the route reads it: the metadata fields through
 * `parseBookPatch` and `archived` beside them, since archiving is a
 * lifecycle move the handler acts on rather than a field it writes. A body
 * naming neither is "Nothing to change".
 */
export function parseBookEdit(body) {
  const { archived, ...fields } = body;
  const patch = Object.keys(fields).length ? parseBookPatch(fields) : { value: {} };
  const error =
    patch.error ||
    firstError([
      [archived !== undefined && typeof archived !== 'boolean', 'archived must be true or false'],
      [archived === undefined && Object.keys(patch.value).length === 0, 'Nothing to change'],
    ]);
  return error ? fail(error) : { value: { fields: patch.value, archived } };
}

/**
 * A new book from a POST body: a provider, a kind, a title, and the
 * optional metadata. Its code — the exam-code slot, the blob path segment
 * and the admin route segment — is the title's slug unless the body names
 * an exam code, which a course bound to a certification does.
 */
export function parseBookCreate(body) {
  const provider = String(body?.provider || '')
    .trim()
    .toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    return { error: 'provider is required (lowercase letters, digits and hyphens)' };
  }
  const kind = body?.kind === undefined ? 'book' : body.kind;
  if (!BOOK_KINDS.includes(kind)) return { error: `kind must be one of ${BOOK_KINDS.join(', ')}` };

  const patch = parseBookPatch({ ...body, kind, title: body?.title ?? '' });
  if (patch.error) return { error: patch.error };

  const explicit = body?.examCode === undefined ? '' : String(body.examCode).trim().toLowerCase();
  const code = explicit || slugifyTitle(patch.value.title);
  if (!CODE_PATTERN.test(code)) {
    return { error: 'The title (or exam code) must yield a slug of letters, digits and hyphens' };
  }

  return {
    value: {
      provider,
      examCode: code,
      ...patch.value,
      voice: patch.value.voice || voiceSettingsOf(null),
      tags: patch.value.tags || [],
      author: patch.value.author ?? null,
      description: patch.value.description ?? null,
      coverImageUrl: patch.value.coverImageUrl ?? null,
    },
  };
}

/**
 * A new hand-made chapter from a POST body: a title, and its text either
 * pasted or to be read from a content item (the handler resolves the item).
 * `{ value }` carries the id the chapter will have, so a duplicate is
 * refused before anything is written.
 */
export function parseChapterCreate(body) {
  const title = checkText(body?.title, 'title', LIMITS.title, { required: true });
  if (title.skip || title.error) return { error: title.error || 'title is required' };

  const text = checkText(body?.sourceText, 'sourceText', LIMITS.sourceText);
  if (text.error) return { error: text.error };

  const contentId = typeof body?.contentId === 'string' ? body.contentId.trim() : '';
  const sourceText = text.skip ? null : text.value;
  if (!sourceText && !contentId) {
    return { error: 'Give the chapter text to speak (sourceText) or a content item (contentId)' };
  }

  let id;
  try {
    id = manualChapterId(title.value);
  } catch (err) {
    return { error: authoredMessage(err, 'The chapter title cannot be made into an id.') };
  }

  const speak = body?.speak === undefined ? Boolean(sourceText || contentId) : Boolean(body.speak);

  return {
    value: {
      id,
      title: title.value,
      // Spoken text keeps its line breaks: `checkText` collapsed whitespace
      // for a label, so the raw value is re-read here, bounded the same way.
      sourceText: sourceText ? String(body.sourceText).trim().slice(0, LIMITS.sourceText) : null,
      contentId: contentId || null,
      speak,
    },
  };
}

/**
 * The fields a chapter PATCH may carry: a rename, a new position, new text
 * to speak next time, the active version, archive / restore, and clearing a
 * regeneration error ("Keep current"). Validated the same way as a book.
 */
export function parseChapterPatch(body) {
  return collectFields([
    ['title', checkText(body?.title, 'title', LIMITS.title, { required: true })],
    ['order', checkInteger(body?.order, 'order', { min: 0, max: 10000 })],
    ['sourceText', checkSpokenText(body?.sourceText)],
    [
      'activeVersionId',
      checkPattern(
        body?.activeVersionId,
        VERSION_ID_PATTERN,
        'activeVersionId must name a version'
      ),
    ],
    ['archived', checkBoolean(body?.archived, 'archived')],
    ['clearError', checkClearError(body?.clearError)],
  ]);
}

/**
 * The status fields that archive a chapter, or restore one, or null when the
 * chapter is already where the move would put it. A book archive stamps
 * `archivedWithBook` so that restoring the book puts back only the chapters
 * it took, and restoring the book skips a chapter archived on its own.
 */
export function chapterArchiveUpdates(chapter, archive, { at, withBook = false }) {
  const isArchived = chapter.status === STATUS.archived;
  if (archive && !isArchived) {
    return {
      status: STATUS.archived,
      statusBeforeArchive: chapter.status || STATUS.draft,
      archivedAt: at,
      archivedWithBook: withBook ? true : null,
    };
  }
  const restorable = isArchived && (!withBook || chapter.archivedWithBook);
  if (!archive && restorable) {
    return {
      status: chapter.statusBeforeArchive || STATUS.draft,
      statusBeforeArchive: null,
      archivedAt: null,
      archivedWithBook: null,
    };
  }
  return null;
}

/** `{ order: [ids] }` — every id a string, no duplicates, at least one. */
export function parseReorder(body) {
  const ids = body?.order;
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'order must list the chapter ids' };
  if (ids.length > 200) return { error: 'order lists too many chapters' };
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return { error: 'order must list chapter ids' };
  }
  if (new Set(ids).size !== ids.length) return { error: 'order lists a chapter twice' };
  return { value: ids.map((id) => id.trim()) };
}

// ── view shapes live in views.js; re-exported so callers keep one import ────
export { publishedChapters, summarizeChapters, toBookView, toChapterView } from './views.js';

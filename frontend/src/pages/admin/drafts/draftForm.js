/**
 * The Drafts page's form model (/admin/drafts) — pure, so the page and its
 * tests agree on what "unsaved changes" means.
 *
 * The form holds every field as the string an input shows; the API takes
 * and answers typed values (functions/src/lib/cms/drafts.js
 * validateDraftFields). `fromDraft` and `toPayload` are the two crossings,
 * and dirtiness is a comparison of two forms, never of a form and a payload,
 * so a reading time of 5 and "5" cannot look like an edit.
 */

export const DRAFTS_ROUTE = 'cms/drafts';
export const IMPORT_ROUTE = 'cms/drafts/import-repo';
export const draftRoute = (id) => `${DRAFTS_ROUTE}/${encodeURIComponent(id)}`;
/** Where an article in review opens: its page on the Review Queue. */
export const reviewPath = (id) => `/admin/review-queue/${encodeURIComponent(id)}`;

/** The template's two tracks (docs/content/blog-template.md), offered, not enforced. */
export const TRACK_SUGGESTIONS = Object.freeze(['how-to', 'build-log']);

export const EMPTY_FORM = Object.freeze({
  title: '',
  subtitle: '',
  date: '',
  track: '',
  part: '',
  tags: '',
  reading: '',
  body: '',
  // The taxonomy (ADR 0033 §4): a draft written here is an article someone
  // typed in, until the owner says otherwise.
  kind: 'article',
  ideaOrigin: 'manual',
});

const FORM_KEYS = Object.keys(EMPTY_FORM);

/** What the stage badge says. */
export const STAGE_LABELS = Object.freeze({
  draft: 'Draft',
  in_review: 'In Review',
  live: 'Live',
  past_review: 'Past review',
  new: 'New',
});

/**
 * Where a draft came from, as the list says it (`draftOrigin` on the document,
 * functions/src/lib/cms/drafts-stage.js DRAFT_ORIGINS). Anything else, the
 * page's own 'drafts', reads "Written here".
 */
export const ORIGIN_LABELS = Object.freeze({
  'repo-import': 'From docs/content',
  vault: 'From my vault',
  paste: 'Pasted in',
});

/** What a stage lets the owner do, for a draft not saved yet. */
export const NEW_DRAFT_ACTIONS = Object.freeze({
  edit: true,
  save: true,
  sendToReview: false,
  backToDrafts: false,
  delete: true,
});

/** An API draft view → the form. */
export function fromDraft(draft) {
  const fields = draft?.fields || {};
  return {
    title: String(fields.title ?? ''),
    subtitle: String(fields.subtitle ?? ''),
    date: String(fields.date ?? ''),
    track: String(fields.track ?? ''),
    part: String(fields.part ?? ''),
    tags: Array.isArray(fields.tags) ? fields.tags.join(', ') : '',
    reading: fields.reading === null || fields.reading === undefined ? '' : String(fields.reading),
    body: String(fields.body ?? ''),
    kind: String(fields.kind || EMPTY_FORM.kind),
    ideaOrigin: String(fields.ideaOrigin || EMPTY_FORM.ideaOrigin),
  };
}

/** `azure, docker ,, azure` → ['azure', 'docker']. */
export function parseTags(value) {
  return [
    ...new Set(
      String(value || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    ),
  ];
}

/** The form → the `fields` a save sends. */
export function toPayload(form) {
  const reading = String(form.reading ?? '').trim();
  return {
    title: String(form.title ?? '').trim(),
    subtitle: String(form.subtitle ?? '').trim(),
    date: String(form.date ?? '').trim() || null,
    track: String(form.track ?? '').trim() || null,
    part: String(form.part ?? '').trim() || null,
    tags: parseTags(form.tags),
    reading: reading === '' ? null : Number(reading),
    body: String(form.body ?? ''),
    // Only when set: an unset value leaves the stored classification alone.
    ...(form.kind && { kind: String(form.kind).trim() }),
    ...(form.ideaOrigin && { ideaOrigin: String(form.ideaOrigin).trim() }),
  };
}

/** Does the form differ from the version last saved (or from empty, for a new draft)? */
export function isDirty(form, baseline) {
  if (!form || !baseline) return false;
  return FORM_KEYS.some((key) => String(form[key] ?? '') !== String(baseline[key] ?? ''));
}

/**
 * 'saved' | 'unsaved' | 'saving' | 'error' | 'new' → the words beside the
 * Save button. 'new' is a draft that has never been saved.
 */
export function describeSaveState({ saving, error, dirty, isNew }) {
  if (saving) return { key: 'saving', label: 'Saving…' };
  if (error) return { key: 'error', label: 'Not saved — see the message above' };
  if (dirty) return { key: 'unsaved', label: 'Unsaved changes' };
  if (isNew) return { key: 'new', label: 'Not saved yet' };
  return { key: 'saved', label: 'Saved' };
}

/** One line per file from the import's `results`. */
export function describeImportResult(result = {}) {
  const name = String(result.path || '')
    .split('/')
    .at(-1);
  const title = result.title || name;
  if (result.outcome === 'imported') return { title, text: 'Imported as a draft', tone: 'ok' };
  if (result.code === 'ALREADY_IMPORTED') {
    const where = STAGE_LABELS[result.stage] || 'Drafts';
    return { title, text: `Already imported — ${where}`, tone: 'skip' };
  }
  if (result.code === 'PUBLISHED_ELSEWHERE') {
    return {
      title,
      text: 'Skipped — an article with this title is already published',
      tone: 'skip',
    };
  }
  const verb = result.outcome === 'failed' ? 'Failed' : 'Skipped';
  return {
    title,
    text: `${verb}: ${result.error || result.code || 'no reason given'}`,
    tone: 'bad',
  };
}

/** The toast for a finished import. */
export function summarizeImport(counts = {}) {
  const imported = counts.imported || 0;
  const other = Object.entries(counts)
    .filter(([outcome]) => outcome !== 'imported')
    .reduce((sum, [, n]) => sum + n, 0);
  if (imported === 0) {
    return {
      title: 'Nothing new to import',
      description: `${other} ${other === 1 ? 'file was' : 'files were'} already here or skipped; see the list.`,
    };
  }
  return {
    title: `${imported} ${imported === 1 ? 'draft' : 'drafts'} imported`,
    description: other
      ? `${other} already here or skipped; see the list.`
      : 'Nothing was published.',
  };
}

export const LIVE_DELETE_MESSAGE =
  'This article is live on the site, so deleting it is refused and nothing was changed. A published article is never touched from Drafts.';

/**
 * Why Delete is refused for this article, or null when it may be asked. The
 * API refuses the same ones (functions/src/lib/cms/drafts-stage.js
 * deleteRefusal); saying so here spares a confirm that could only end in a
 * refusal.
 */
export function deleteRefusalMessage(draft) {
  if (!draft?.id || draft.actions?.delete) return null;
  if (draft.stage === 'live') return LIVE_DELETE_MESSAGE;
  return `This article is "${draft.contentStatus}", past review, so deleting it here is refused and nothing was changed.`;
}

/** The delete confirm's wording: an article In Review takes its queue item with it. */
export function deleteConfirmCopy(draft) {
  if (draft?.stage === 'in_review') {
    return {
      title: 'Delete this draft and its In Review item?',
      description:
        'It has been sent to In Review. Deleting it removes it from Drafts and from the Review Queue. This cannot be undone.',
    };
  }
  return {
    title: 'Delete this draft?',
    description: draft?.id
      ? 'The draft is removed from the site. This cannot be undone.'
      : 'This draft has never been saved; its text will be discarded.',
  };
}

// ── Paste or upload a markdown draft (POST cms/drafts/from-markdown) ───────

export const FROM_MARKDOWN_ROUTE = 'cms/drafts/from-markdown';

/**
 * The most a draft file can be: the 256 KB body plus 16 KB of front matter
 * (functions/src/lib/cms/drafts-markdown.js MAX_MARKDOWN_BYTES). Checked here
 * only to spare sending a file the API would refuse; the API is the rule.
 */
export const MAX_MARKDOWN_FILE_BYTES = 272 * 1024;

/**
 * One line of the result list for one file (or the pasted text): `answer` is
 * what the API said, or `error` is what went wrong. Plain words, no codes.
 *
 * @param {string} name - the file name, or 'Pasted text'
 * @param {{ answer?: object, error?: Error }} outcome
 * @returns {{ name: string, kind: 'created'|'present'|'published'|'failed',
 *   tone: 'ok'|'skip'|'bad', text: string, warnings: string[] }}
 */
export function describeMarkdownResult(name, { answer, error } = {}) {
  if (error) {
    return {
      name,
      kind: 'failed',
      tone: 'bad',
      text: `Not added: ${error.message || 'something went wrong; nothing was saved.'}`,
      warnings: [],
    };
  }
  if (answer?.outcome === 'created') {
    return {
      name,
      kind: 'created',
      tone: 'ok',
      text: 'Created as a draft',
      warnings: answer.warnings || [],
    };
  }
  if (answer?.code === 'PUBLISHED_ELSEWHERE') {
    return {
      name,
      kind: 'published',
      tone: 'skip',
      text: 'Already present — an article with this title is already published',
      warnings: [],
    };
  }
  if (answer?.code === 'ALREADY_IMPORTED') {
    const where = STAGE_LABELS[answer.stage] || 'Drafts';
    return {
      name,
      kind: 'present',
      tone: 'skip',
      text: `Already present — ${where}`,
      warnings: [],
    };
  }
  return {
    name,
    kind: 'failed',
    tone: 'bad',
    text: 'Not added: the answer was not one this page understands; nothing was changed.',
    warnings: [],
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The one line under a finished batch: "3 files: 1 created, 1 already present, 1 not added." */
export function summarizeMarkdownBatch(lines, noun = 'file') {
  const count = (kind) => lines.filter((line) => line.kind === kind).length;
  const created = count('created');
  const present = count('present') + count('published');
  const failed = count('failed');
  const parts = [`${created} created`, `${present} already present`, `${failed} not added`];
  return `${plural(lines.length, noun, `${noun}s`)}: ${parts.join(', ')}. Nothing was published.`;
}

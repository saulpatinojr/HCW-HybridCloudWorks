/**
 * Stage 2's draft machinery: source URLs, supporting documents, and the
 * generate-draft call itself.
 *
 * Module-level functions over a state bag, as imageStage.js is and as
 * linkWrites.js established (#634). The page holds the state; these act on it,
 * which is what lets them be exercised without mounting the page.
 *
 * Behaviour here is deliberately identical to the inline handlers it replaces.
 */
import { postJSON } from '@/lib/api';
import { isArticleTopic } from '@/lib/articleTopics';
import { ensureTldrSectionAtEnd } from '@/lib/contentDraft';

/**
 * What the generator is told when the operator has not said otherwise.
 *
 * Editable in Stage 2 and carried in the session snapshot, so changing it
 * here changes only the default a fresh draft starts from.
 */
export const DEFAULT_DRAFT_INSTRUCTION_PROMPT =
  'You are generating a high-quality technical draft article for Hybrid Cloud Works. Use the source URL as the primary source. If supporting documents are provided, incorporate them as additional context. Produce a publication-ready title, concise editorial summary, a structured markdown article draft around 2500-3200 words, and image prompts tailored to the article.';

/** 4 MB, matched by the generate-draft function on the other side. */
export const MAX_STAGE_TWO_FILE_BYTES = 4 * 1024 * 1024;

/** Uploads and document URLs share one budget; neither has its own. */
export const MAX_STAGE_TWO_SUPPORTING_SOURCES = 5;

/**
 * http(s) only.
 *
 * `new URL` accepts `javascript:` and `data:` happily, so the protocol test is
 * the point of this rather than the parse.
 */
export function isValidHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A fetchable PDF or TXT.
 *
 * The extension test allows a query string or fragment after it, because a
 * signed blob URL almost always carries one.
 */
export function isSupportedDocumentUrl(value = '') {
  if (!isValidHttpUrl(value)) return false;
  const normalized = String(value).trim().toLowerCase();
  return /\.pdf($|[?#])/.test(normalized) || /\.txt($|[?#])/.test(normalized);
}

/** A file's bytes as base64, without the `data:...;base64,` prefix. */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64Data = result.includes(',') ? result.split(',').pop() : result;
      resolve(base64Data || '');
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Which of the two kinds a file is, or '' for neither.
 *
 * Either signal is enough, because a browser reports `file.type` from the
 * name anyway — an extensionless PDF still arrives as `application/pdf`, and a
 * PDF the OS has no mapping for arrives with an empty type but a usable name.
 * Unlike the image path (#631) neither signal can be preferred: they are the
 * same guess made twice.
 *
 * TXT is tested first, and a file that satisfies both is read as text. That is
 * what the inline version did and it is not worth changing here.
 */
export function supportingKindOf(file) {
  const extension = String(file.name.split('.').pop() || '').toLowerCase();
  if (file.type === 'text/plain' || extension === 'txt') return 'txt';
  if (file.type === 'application/pdf' || extension === 'pdf') return 'pdf';
  return '';
}

function documentId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One supporting document, read into the shape the draft request wants, or a
 * throw. The throw is what abandons the whole batch — see addSupportingDocuments.
 */
export async function readSupportingDocument(file) {
  const kind = supportingKindOf(file);
  if (!kind) {
    throw new Error('Only PDF and TXT files are supported in Stage 2.');
  }
  if (file.size > MAX_STAGE_TWO_FILE_BYTES) {
    throw new Error(`${file.name} exceeds the 4 MB Stage 2 file limit.`);
  }

  const base = { id: documentId(), name: file.name, size: file.size, kind };
  if (kind === 'txt') {
    // Truncated rather than refused: 20k characters is already far more than
    // the draft call will use, and a long log file is a normal thing to attach.
    return {
      ...base,
      mimeType: 'text/plain',
      textContent: String(await file.text()).slice(0, 20000),
      base64Data: '',
    };
  }
  return {
    ...base,
    mimeType: 'application/pdf',
    textContent: '',
    base64Data: await readFileAsBase64(file),
  };
}

/**
 * Read the picked files and add them to the Stage 2 budget.
 *
 * All-or-nothing on purpose: the documents are committed to state only after
 * every one has been read, so a single unsupported or oversized file leaves
 * the list exactly as it was rather than adding a partial batch the operator
 * then has to reconcile.
 */
export async function addSupportingDocuments(state, event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  const availableSlots =
    MAX_STAGE_TWO_SUPPORTING_SOURCES -
    (state.supportingDocuments.length + state.kbDocumentUrls.length);
  if (availableSlots <= 0) {
    state.setError(
      `You can keep up to ${MAX_STAGE_TWO_SUPPORTING_SOURCES} total supporting documents in Stage 2.`
    );
    event.target.value = '';
    return;
  }

  const nextFiles = files.slice(0, availableSlots);
  state.setError('');

  try {
    const parsedDocuments = [];
    for (const file of nextFiles) {
      parsedDocuments.push(await readSupportingDocument(file));
    }

    state.setSupportingDocuments((prev) => [...prev, ...parsedDocuments]);

    if (files.length > availableSlots) {
      state.setResult({
        stage: 2,
        message: `Only the first ${availableSlots} file(s) were added. Stage 2 supports up to ${MAX_STAGE_TWO_SUPPORTING_SOURCES} total supporting documents.`,
      });
    }
  } catch (err) {
    state.setError(err.message || 'Failed to load supporting documents.');
  } finally {
    // Always, so re-picking the same file fires a change event again.
    event.target.value = '';
  }
}

export function removeSupportingDocument(state, documentId_) {
  state.setSupportingDocuments((prev) => prev.filter((doc) => doc.id !== documentId_));
}

/** Add the typed document URL to the list, against the shared Stage 2 budget. */
export function addKbDocumentUrl(state) {
  const normalizedUrl = state.kbDocumentUrl.trim();
  if (!isSupportedDocumentUrl(normalizedUrl)) {
    state.setError('Please enter a valid public PDF or TXT URL before adding it.');
    return;
  }

  if (
    state.supportingDocuments.length + state.kbDocumentUrls.length >=
    MAX_STAGE_TWO_SUPPORTING_SOURCES
  ) {
    state.setError(
      `Stage 2 supports up to ${MAX_STAGE_TWO_SUPPORTING_SOURCES} total supporting documents across uploads and document URLs.`
    );
    return;
  }

  state.setKbDocumentUrls((prev) => {
    if (prev.includes(normalizedUrl)) return prev;
    return [...prev, normalizedUrl];
  });
  state.setKbDocumentUrl('');
  state.setError('');
}

export function removeKbDocumentUrl(state, urlToRemove) {
  state.setKbDocumentUrls((prev) => prev.filter((entry) => entry !== urlToRemove));
}

/** Add the typed KB article URL. Unlike documents these have no budget. */
export function addKbArticleUrl(state) {
  const normalizedUrl = state.sourceUrl.trim();
  if (!isValidHttpUrl(normalizedUrl)) {
    state.setError('Please enter a valid KB article URL before adding it.');
    return;
  }

  state.setKbArticleUrls((prev) => {
    if (prev.includes(normalizedUrl)) return prev;
    return [...prev, normalizedUrl];
  });
  state.setSourceUrl('');
  state.setError('');
}

export function removeKbArticleUrl(state, urlToRemove) {
  state.setKbArticleUrls((prev) => prev.filter((entry) => entry !== urlToRemove));
}

/**
 * Append a section template to the draft, once.
 *
 * The duplicate check is on the heading text, so a heading the operator has
 * since edited will not match and the block can be added a second time. That
 * is the existing behaviour and changing it is not this commit's business.
 */
export function insertSectionBlock(state, section) {
  if (!state.draftReady) return;

  const hasSection = state.draftContent.includes(section.heading);
  if (hasSection) {
    state.setResult({ stage: 4, message: `${section.title} already exists in the draft.` });
    return;
  }

  state.setDraftContent(
    ensureTldrSectionAtEnd(`${state.draftContent.trim()}\n\n${section.template}`.trim())
  );
}

/**
 * Every source URL the draft call should see: the added list plus whatever is
 * still sitting unadded in the input, de-duplicated and with blanks dropped.
 *
 * The unadded one counts so that typing a URL and pressing Generate works
 * without pressing Add first — a real path, and the reason this is not simply
 * `kbArticleUrls`.
 */
export function effectiveSourceUrlsFor(state) {
  return Array.from(
    new Set(
      [
        ...state.kbArticleUrls,
        isValidHttpUrl(state.sourceUrl) ? state.sourceUrl.trim() : '',
      ].filter(Boolean)
    )
  );
}

/** The generate-draft request body. Pure, so it can be asserted directly. */
export function draftRequestFor(state, sourceUrls) {
  return {
    url: sourceUrls[0],
    urls: sourceUrls,
    cloudProvider: state.provider || null,
    customInstructionPrompt: state.draftInstructionPrompt.trim(),
    documentUrls: state.kbDocumentUrls,
    supportingDocuments: state.supportingDocuments.map((doc) => ({
      name: doc.name,
      mimeType: doc.mimeType,
      textContent: doc.textContent || '',
      base64Data: doc.base64Data || '',
    })),
  };
}

/** A response string field, or the fallback when it is absent or empty. */
const textOr = (value, fallback = '') => value || fallback;

/** A response list field, or the fallback when it is absent or empty. */
const listOr = (value, fallback) => (Array.isArray(value) && value.length > 0 ? value : fallback);

/**
 * A draft response reduced to the eight values the page stores.
 *
 * Pure, and separate from the writing below, because every one of these is a
 * fallback and a thin or malformed response is the normal failure — the
 * generator returning `{}` must still leave the page in a usable state rather
 * than blanking the operator's work.
 */
export function normalizeDraft(draft, state, sourceUrls) {
  return {
    // The list the operator worked from, so a response carrying none does not
    // silently empty it.
    sourceUrls: listOr(draft.sourceUrls, sourceUrls),
    title: textOr(draft.title, textOr(state.title, 'Untitled')),
    summary: textOr(draft.summary),
    content: ensureTldrSectionAtEnd(textOr(draft.postContent)),
    // Any array, including an empty one — unlike sourceUrls, an empty topic
    // list is a legitimate answer rather than a missing one.
    topics: Array.isArray(draft.keyTopics) ? draft.keyTopics : [],
    // The address topic the drafting step suggests (#1628); anything not on
    // the list becomes '', which lets the server pick one at publish.
    topic: isArticleTopic(draft.topic) ? draft.topic : '',
    summaryPrompt: textOr(draft.summaryPrompt),
    detailsPrompt: textOr(draft.detailsPrompt),
  };
}

/** Commit a normalized draft to state. */
export function applyDraftResponse(state, draft, sourceUrls) {
  const next = normalizeDraft(draft, state, sourceUrls);
  state.setKbArticleUrls(next.sourceUrls);
  state.setSourceUrl('');
  state.setDraftTitle(next.title);
  state.setDraftSummary(next.summary);
  state.setDraftContent(next.content);
  state.setDraftTopics(next.topics);
  state.setDraftTopic(next.topic);
  state.setSummaryPrompt(next.summaryPrompt);
  state.setDetailsPrompt(next.detailsPrompt);
  state.setDraftReady(true);
}

/**
 * Generate the draft in memory. Nothing is persisted here — Stage 4 does that.
 *
 * Regeneration is the same call; only the confirmation wording differs, and it
 * is read from draftReady BEFORE the response sets it, which is why it is
 * captured on the first line.
 */
export async function submitDraft(state, event) {
  event.preventDefault();
  const isRegeneration = state.draftReady;
  state.setSubmittingDraft(true);
  state.setError('');
  state.setResult(null);

  const sourceUrls = effectiveSourceUrlsFor(state);
  if (sourceUrls.length === 0) {
    state.setSubmittingDraft(false);
    state.setError('Please add at least one valid KB article URL for Stage 2.');
    return;
  }

  try {
    const response = await postJSON('generateArticleDraft', draftRequestFor(state, sourceUrls));
    applyDraftResponse(state, response?.draft || {}, sourceUrls);
    // Any images generated from the previous draft describe text that no
    // longer exists, so they go rather than being silently carried forward.
    state.resetGeneratedDraftAssets();
    state.setResult({
      stage: 2,
      message: isRegeneration
        ? 'Draft regenerated in memory with the latest KB articles, document URLs, files, and prompt. Review Stage 3 images before saving.'
        : 'Draft generated in memory. Continue to Stages 3 and 4.',
    });
  } catch (err) {
    state.setError(err.message || 'Submission failed.');
  } finally {
    state.setSubmittingDraft(false);
  }
}

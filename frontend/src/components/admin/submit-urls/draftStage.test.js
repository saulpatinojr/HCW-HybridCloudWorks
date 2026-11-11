/**
 * Stage 2's machinery, run directly rather than by mounting the page (#634).
 *
 * The page had eight tests over 1,088 lines when this started, and two of its
 * features had shipped broken under that ratio (#630, #631). These cover what
 * Stage 2 does: the shared five-document budget, the all-or-nothing read, and
 * the draft call's payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  MAX_STAGE_TWO_FILE_BYTES,
  addKbArticleUrl,
  addKbDocumentUrl,
  addSupportingDocuments,
  applyDraftResponse,
  draftRequestFor,
  effectiveSourceUrlsFor,
  insertSectionBlock,
  isSupportedDocumentUrl,
  isValidHttpUrl,
  normalizeDraft,
  readSupportingDocument,
  removeKbArticleUrl,
  removeSupportingDocument,
  submitDraft,
  supportingKindOf,
} from './draftStage';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

const file = (name, type, bytes = 3) => new File([new Uint8Array(bytes)], name, { type });

function bag(overrides = {}) {
  return {
    draftContent: '',
    draftInstructionPrompt: '  keep it short  ',
    draftReady: false,
    kbArticleUrls: [],
    kbDocumentUrl: '',
    kbDocumentUrls: [],
    provider: '',
    sourceUrl: '',
    supportingDocuments: [],
    title: '',
    resetGeneratedDraftAssets: vi.fn(),
    setDetailsPrompt: vi.fn(),
    setDraftContent: vi.fn(),
    setDraftReady: vi.fn(),
    setDraftSummary: vi.fn(),
    setDraftTitle: vi.fn(),
    setDraftTopics: vi.fn(),
    setDraftTopic: vi.fn(),
    setError: vi.fn(),
    setKbArticleUrls: vi.fn(),
    setKbDocumentUrl: vi.fn(),
    setKbDocumentUrls: vi.fn(),
    setResult: vi.fn(),
    setSourceUrl: vi.fn(),
    setSubmittingDraft: vi.fn(),
    setSummaryPrompt: vi.fn(),
    setSupportingDocuments: vi.fn(),
    ...overrides,
  };
}

/** A file-input change event whose value can be inspected after the call. */
const changeEvent = (files) => ({ target: { files, value: 'C:\\fakepath\\x' } });

describe('isValidHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isValidHttpUrl('http://example.com')).toBe(true);
    expect(isValidHttpUrl('  https://example.com/a?b=1  ')).toBe(true);
  });

  it('refuses schemes that parse but are not fetchable pages', () => {
    // `new URL` is happy with both, which is the whole reason for the protocol
    // test rather than a bare try/catch.
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('data:text/html,<p>')).toBe(false);
    expect(isValidHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('refuses what does not parse at all', () => {
    expect(isValidHttpUrl('not a url')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });
});

describe('isSupportedDocumentUrl', () => {
  it('takes a PDF or TXT, including behind a query string or fragment', () => {
    // A signed blob URL almost always carries one, so anchoring the extension
    // to end-of-string would reject the common case.
    expect(isSupportedDocumentUrl('https://e.com/a.pdf')).toBe(true);
    expect(isSupportedDocumentUrl('https://e.com/a.txt?sig=abc')).toBe(true);
    expect(isSupportedDocumentUrl('https://e.com/a.PDF#page=2')).toBe(true);
  });

  it('refuses other document types and non-http URLs', () => {
    expect(isSupportedDocumentUrl('https://e.com/a.docx')).toBe(false);
    expect(isSupportedDocumentUrl('https://e.com/a')).toBe(false);
    expect(isSupportedDocumentUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('supportingKindOf', () => {
  it('reads either signal, because the browser derives one from the other', () => {
    expect(supportingKindOf(file('a.txt', 'text/plain'))).toBe('txt');
    expect(supportingKindOf(file('notes', 'text/plain'))).toBe('txt');
    expect(supportingKindOf(file('a.pdf', ''))).toBe('pdf');
    expect(supportingKindOf(file('report', 'application/pdf'))).toBe('pdf');
  });

  it('resolves a file that answers to both as text', () => {
    // Existing behaviour, pinned rather than endorsed: TXT is tested first.
    expect(supportingKindOf(file('a.pdf', 'text/plain'))).toBe('txt');
  });

  it('is empty for anything else', () => {
    expect(supportingKindOf(file('a.docx', 'application/msword'))).toBe('');
  });
});

describe('readSupportingDocument', () => {
  it('refuses an unsupported type', async () => {
    await expect(readSupportingDocument(file('a.docx', 'application/msword'))).rejects.toThrow(
      /PDF and TXT/
    );
  });

  it('refuses a file over the 4 MB limit, naming it', async () => {
    const big = file('huge.pdf', 'application/pdf', MAX_STAGE_TWO_FILE_BYTES + 1);
    await expect(readSupportingDocument(big)).rejects.toThrow(/huge\.pdf/);
  });

  it('carries TXT through as text, not base64', async () => {
    const doc = await readSupportingDocument(new File(['hello'], 'a.txt', { type: 'text/plain' }));
    expect(doc).toMatchObject({
      kind: 'txt',
      mimeType: 'text/plain',
      textContent: 'hello',
      base64Data: '',
    });
  });

  it('truncates a very long TXT rather than refusing it', async () => {
    const long = new File(['x'.repeat(25000)], 'a.txt', { type: 'text/plain' });
    const doc = await readSupportingDocument(long);
    expect(doc.textContent).toHaveLength(20000);
  });

  it('carries PDF through as base64, not text', async () => {
    const doc = await readSupportingDocument(file('a.pdf', 'application/pdf'));
    expect(doc).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf', textContent: '' });
    expect(typeof doc.base64Data).toBe('string');
  });
});

describe('addSupportingDocuments', () => {
  it('does nothing when the picker was dismissed', async () => {
    const state = bag();
    await addSupportingDocuments(state, changeEvent([]));
    expect(state.setSupportingDocuments).not.toHaveBeenCalled();
    expect(state.setError).not.toHaveBeenCalled();
  });

  it('refuses once the shared budget is spent, counting URLs too', async () => {
    // Uploads and document URLs share one allowance of five; three of each
    // would be over it even though neither alone is.
    const state = bag({
      supportingDocuments: [{}, {}, {}],
      kbDocumentUrls: ['a', 'b'],
    });
    const event = changeEvent([file('a.txt', 'text/plain')]);
    await addSupportingDocuments(state, event);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('up to 5'));
    expect(state.setSupportingDocuments).not.toHaveBeenCalled();
    expect(event.target.value).toBe('');
  });

  it('takes only what fits and says how many it took', async () => {
    const state = bag({ supportingDocuments: [{}, {}, {}, {}] });
    await addSupportingDocuments(
      state,
      changeEvent([file('a.txt', 'text/plain'), file('b.txt', 'text/plain')])
    );
    const [[setter]] = state.setSupportingDocuments.mock.calls;
    expect(setter([])).toHaveLength(1);
    expect(state.setResult).toHaveBeenCalledWith({
      stage: 2,
      message: expect.stringContaining('Only the first 1 file(s)'),
    });
  });

  it('adds nothing at all when one file in the batch is bad', async () => {
    // All-or-nothing: a partial batch is worse than none, because the operator
    // then has to work out which of the five they picked actually landed.
    const state = bag();
    await addSupportingDocuments(
      state,
      changeEvent([file('good.txt', 'text/plain'), file('bad.docx', 'application/msword')])
    );
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('PDF and TXT'));
    expect(state.setSupportingDocuments).not.toHaveBeenCalled();
  });

  it('clears the input even when the read failed, so the same file can be re-picked', async () => {
    const state = bag();
    const event = changeEvent([file('bad.docx', 'application/msword')]);
    await addSupportingDocuments(state, event);
    expect(event.target.value).toBe('');
  });
});

describe('addKbDocumentUrl', () => {
  it('refuses a URL that is not a PDF or TXT', () => {
    const state = bag({ kbDocumentUrl: 'https://e.com/a.docx' });
    addKbDocumentUrl(state);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('PDF or TXT'));
    expect(state.setKbDocumentUrls).not.toHaveBeenCalled();
  });

  it('refuses once the shared budget is spent', () => {
    const state = bag({
      kbDocumentUrl: 'https://e.com/a.pdf',
      supportingDocuments: [{}, {}, {}],
      kbDocumentUrls: ['x', 'y'],
    });
    addKbDocumentUrl(state);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('across uploads'));
    expect(state.setKbDocumentUrls).not.toHaveBeenCalled();
  });

  it('adds the trimmed URL and clears the field', () => {
    const state = bag({ kbDocumentUrl: '  https://e.com/a.pdf  ' });
    addKbDocumentUrl(state);
    const [[setter]] = state.setKbDocumentUrls.mock.calls;
    expect(setter([])).toEqual(['https://e.com/a.pdf']);
    expect(state.setKbDocumentUrl).toHaveBeenCalledWith('');
  });

  it('does not add the same URL twice', () => {
    const state = bag({ kbDocumentUrl: 'https://e.com/a.pdf' });
    addKbDocumentUrl(state);
    const [[setter]] = state.setKbDocumentUrls.mock.calls;
    const existing = ['https://e.com/a.pdf'];
    expect(setter(existing)).toBe(existing);
  });
});

describe('addKbArticleUrl', () => {
  it('refuses an invalid URL', () => {
    const state = bag({ sourceUrl: 'not a url' });
    addKbArticleUrl(state);
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('valid KB article URL'));
    expect(state.setKbArticleUrls).not.toHaveBeenCalled();
  });

  it('adds it and clears the field', () => {
    const state = bag({ sourceUrl: 'https://kb.example.com/1' });
    addKbArticleUrl(state);
    const [[setter]] = state.setKbArticleUrls.mock.calls;
    expect(setter([])).toEqual(['https://kb.example.com/1']);
    expect(state.setSourceUrl).toHaveBeenCalledWith('');
  });
});

describe('the removals', () => {
  it('drop only the entry named', () => {
    const state = bag();
    removeKbArticleUrl(state, 'b');
    const [[urls]] = state.setKbArticleUrls.mock.calls;
    expect(urls(['a', 'b', 'c'])).toEqual(['a', 'c']);

    removeSupportingDocument(state, 'id-2');
    const [[docs]] = state.setSupportingDocuments.mock.calls;
    expect(docs([{ id: 'id-1' }, { id: 'id-2' }])).toEqual([{ id: 'id-1' }]);
  });
});

describe('insertSectionBlock', () => {
  const section = { heading: '## FAQ', title: 'FAQ', template: '## FAQ\n\nQ?' };

  it('does nothing before a draft exists', () => {
    const state = bag({ draftReady: false });
    insertSectionBlock(state, section);
    expect(state.setDraftContent).not.toHaveBeenCalled();
  });

  it('says so rather than adding a second copy', () => {
    const state = bag({ draftReady: true, draftContent: 'intro\n\n## FAQ\n\nQ?' });
    insertSectionBlock(state, section);
    expect(state.setResult).toHaveBeenCalledWith({
      stage: 4,
      message: 'FAQ already exists in the draft.',
    });
    expect(state.setDraftContent).not.toHaveBeenCalled();
  });

  it('appends the template when it is not already there', () => {
    const state = bag({ draftReady: true, draftContent: 'intro' });
    insertSectionBlock(state, section);
    const [[next]] = state.setDraftContent.mock.calls;
    expect(next).toContain('intro');
    expect(next).toContain('## FAQ');
  });
});

describe('effectiveSourceUrlsFor', () => {
  it('counts a URL still sitting unadded in the input', () => {
    // Typing a URL and pressing Generate without pressing Add first is a real
    // path, and the reason this is not simply kbArticleUrls.
    const state = bag({ kbArticleUrls: ['https://a.com'], sourceUrl: 'https://b.com' });
    expect(effectiveSourceUrlsFor(state)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('drops an invalid input and de-duplicates', () => {
    const state = bag({ kbArticleUrls: ['https://a.com', 'https://a.com'], sourceUrl: 'nope' });
    expect(effectiveSourceUrlsFor(state)).toEqual(['https://a.com']);
  });

  it('is empty when there is nothing usable', () => {
    expect(effectiveSourceUrlsFor(bag())).toEqual([]);
  });
});

describe('draftRequestFor', () => {
  it('sends the first URL as `url` and all of them as `urls`', () => {
    const req = draftRequestFor(bag(), ['https://a.com', 'https://b.com']);
    expect(req.url).toBe('https://a.com');
    expect(req.urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('trims the instruction prompt and nulls an unset provider', () => {
    const req = draftRequestFor(bag(), ['https://a.com']);
    expect(req.customInstructionPrompt).toBe('keep it short');
    expect(req.cloudProvider).toBeNull();
  });

  it('sends only the four fields of each supporting document', () => {
    // The local id and size stay on the client; there is no reason to ship them.
    const state = bag({
      supportingDocuments: [
        { id: 'x', size: 12, name: 'a.pdf', mimeType: 'application/pdf', base64Data: 'AAA' },
      ],
    });
    expect(draftRequestFor(state, ['https://a.com']).supportingDocuments).toEqual([
      { name: 'a.pdf', mimeType: 'application/pdf', textContent: '', base64Data: 'AAA' },
    ]);
  });
});

describe('normalizeDraft', () => {
  it('leaves the page usable when the generator returns nothing at all', () => {
    // A thin response is the normal failure, and it must not blank the work.
    const next = normalizeDraft({}, bag({ title: 'Typed' }), ['https://a.com']);
    expect(next).toMatchObject({
      sourceUrls: ['https://a.com'],
      title: 'Typed',
      summary: '',
      topics: [],
      summaryPrompt: '',
      detailsPrompt: '',
    });
  });

  it('treats an empty topic list as an answer but an empty URL list as absent', () => {
    // The asymmetry is deliberate: no topics is a legitimate result, no source
    // URLs is a response that failed to echo them.
    const next = normalizeDraft({ keyTopics: [], sourceUrls: [] }, bag(), ['https://a.com']);
    expect(next.topics).toEqual([]);
    expect(next.sourceUrls).toEqual(['https://a.com']);
  });

  it('keeps a suggested address topic from the list and drops anything else (#1628)', () => {
    expect(normalizeDraft({ topic: 'hybrid' }, bag(), []).topic).toBe('hybrid');
    // Not on the list, wrong case, wrong type, or absent: '' lets the server pick.
    for (const topic of ['kubernetes', 'Hybrid', 7, null, undefined]) {
      expect(normalizeDraft({ topic }, bag(), []).topic).toBe('');
    }
  });
});

describe('applyDraftResponse', () => {
  it('keeps the URLs it was working from when the response carries none', () => {
    const state = bag();
    applyDraftResponse(state, {}, ['https://a.com']);
    expect(state.setKbArticleUrls).toHaveBeenCalledWith(['https://a.com']);
  });

  it('prefers the URLs the response resolved', () => {
    const state = bag();
    applyDraftResponse(state, { sourceUrls: ['https://canonical.com'] }, ['https://a.com']);
    expect(state.setKbArticleUrls).toHaveBeenCalledWith(['https://canonical.com']);
  });

  it('falls back through the response title, the typed title, then Untitled', () => {
    const withTitle = bag({ title: 'Typed' });
    applyDraftResponse(withTitle, {}, []);
    expect(withTitle.setDraftTitle).toHaveBeenCalledWith('Typed');

    const bare = bag();
    applyDraftResponse(bare, {}, []);
    expect(bare.setDraftTitle).toHaveBeenCalledWith('Untitled');
  });

  it('never sets topics to a non-array', () => {
    const state = bag();
    applyDraftResponse(state, { keyTopics: 'not an array' }, []);
    expect(state.setDraftTopics).toHaveBeenCalledWith([]);
  });

  it('sets the suggested address topic, or clears it when the response has none', () => {
    const suggested = bag();
    applyDraftResponse(suggested, { topic: 'migration' }, []);
    expect(suggested.setDraftTopic).toHaveBeenCalledWith('migration');

    const none = bag();
    applyDraftResponse(none, {}, []);
    expect(none.setDraftTopic).toHaveBeenCalledWith('');
  });
});

describe('submitDraft', () => {
  const event = () => ({ preventDefault: vi.fn() });

  beforeEach(() => {
    vi.clearAllMocks();
    postJSON.mockResolvedValue({ draft: { title: 'T', postContent: 'body' } });
  });

  it('refuses with no usable URL, and clears the spinner it just set', () => {
    const state = bag();
    submitDraft(state, event());
    expect(postJSON).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('at least one valid'));
    expect(state.setSubmittingDraft).toHaveBeenLastCalledWith(false);
  });

  it('generates, stores the draft, and drops the previous run images', async () => {
    // The old images describe text that no longer exists.
    const state = bag({ kbArticleUrls: ['https://a.com'] });
    await submitDraft(state, event());
    expect(postJSON).toHaveBeenCalledWith('generateArticleDraft', expect.any(Object));
    expect(state.setDraftReady).toHaveBeenCalledWith(true);
    expect(state.resetGeneratedDraftAssets).toHaveBeenCalled();
  });

  it('words the confirmation differently on a regeneration', async () => {
    const fresh = bag({ kbArticleUrls: ['https://a.com'], draftReady: false });
    await submitDraft(fresh, event());
    const [[first]] = fresh.setResult.mock.calls.slice(-1);
    expect(first.message).toContain('Draft generated in memory');

    const again = bag({ kbArticleUrls: ['https://a.com'], draftReady: true });
    await submitDraft(again, event());
    const [[second]] = again.setResult.mock.calls.slice(-1);
    expect(second.message).toContain('regenerated');
  });

  it('survives a response with no draft at all', async () => {
    postJSON.mockResolvedValue({});
    const state = bag({ kbArticleUrls: ['https://a.com'] });
    await submitDraft(state, event());
    expect(state.setDraftTitle).toHaveBeenCalledWith('Untitled');
    expect(state.setError).not.toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('always clears the spinner, including when the call throws', async () => {
    postJSON.mockRejectedValue(new Error('generator down'));
    const state = bag({ kbArticleUrls: ['https://a.com'] });
    await submitDraft(state, event());
    expect(state.setError).toHaveBeenCalledWith('generator down');
    expect(state.setSubmittingDraft).toHaveBeenLastCalledWith(false);
    expect(state.setDraftReady).not.toHaveBeenCalled();
  });
});

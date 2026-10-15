import { describe, it, expect, vi } from 'vitest';
import {
  createRecordingDrafter,
  createContentFromRecordingHandler,
  parseRecordingRequest,
  inferProviderFromRecording,
  RECORDING_CONTENT_TYPES,
  MIN_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  RECORDING_DRAFT_HTTP_BUDGET_MS,
} from './draft-from-recording.js';
import { createContentDocument } from '../cms/content-create.js';
import { AFTER_MODEL_MARGIN_MS } from '../ai/time-budget.js';
import { AiBudgetExhaustedError } from '../ai/router.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const now = () => NOW;
const TRANSCRIPT =
  'So today we are talking about Azure landing zones and why the hub and spoke '.repeat(8);

function memStore(containers = {}) {
  const data = Object.fromEntries(
    Object.entries(containers).map(([k, v]) => [k, new Map(v.map((d) => [d.id, d]))])
  );
  const get = (c) => (data[c] ||= new Map());
  return {
    data,
    readDoc: vi.fn(async (c, id) => get(c).get(id) || null),
    upsertDoc: vi.fn(async (c, doc) => {
      get(c).set(doc.id, doc);
      return doc;
    }),
    patchDoc: vi.fn(async (c, id, u) => {
      const next = { ...(get(c).get(id) || { id }), ...u };
      get(c).set(id, next);
      return next;
    }),
    // findDuplicateContent queries content; an empty result = no duplicate.
    queryDocs: vi.fn(async () => []),
  };
}

const recording = {
  id: 'rec-1',
  title: 'Landing zones, live',
  transcript: TRANSCRIPT,
  status: 'new',
};

const goodDraft = {
  title: 'Why hub and spoke still wins',
  summary: 'A summary.',
  postContent: '## Heading\n\nBody text long enough to be a draft.\n\n## TL;DR\n\n- point',
  summaryPrompt: 'sp',
  detailsPrompt: 'dp',
  keyTopics: ['azure', 'landing zones'],
  suggestedContentType: 'blog',
  aiProvider: 'gemini',
  aiModel: null,
  format: 'deep-dive',
};

const request = (body, headers = {}) => ({
  json: async () => body,
  headers: new Map(Object.entries(headers)),
  params: {},
});
const allowGuard = { requireRole: vi.fn(async () => ({ user: { email: 'ed@hcw.test' } })) };
const denyGuard = {
  requireRole: vi.fn(async () => ({ error: { status: 401, body: '{"error":"no"}' } })),
};
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });

describe('parseRecordingRequest', () => {
  it('requires an identifier-shaped recordingId and a known contentType', () => {
    expect(() => parseRecordingRequest(null)).toThrow(/JSON body/);
    expect(() => parseRecordingRequest({ contentType: 'blog_post' })).toThrow(/recordingId/);
    expect(() => parseRecordingRequest({ recordingId: 'a b', contentType: 'blog_post' })).toThrow(
      /identifier/
    );
    expect(() => parseRecordingRequest({ recordingId: 'rec-1', contentType: 'tweet' })).toThrow(
      /contentType must be one of/
    );
    const ok = parseRecordingRequest({
      recordingId: 'rec-1',
      contentType: 'podcast_notes',
      title: ' T ',
      provider: 'gemini',
      transcript: 'x',
    });
    expect(ok).toEqual({
      recordingId: 'rec-1',
      title: 'T',
      transcript: 'x',
      contentType: 'podcast_notes',
      requestedProvider: 'gemini',
      cloudProvider: '',
    });
    // Every dropdown value in RecordingsPage.jsx is a contract key.
    expect(Object.keys(RECORDING_CONTENT_TYPES).sort()).toEqual(
      ['blog_post', 'linkedin_post', 'meeting_summary', 'podcast_notes', 'technical_guide'].sort()
    );
  });

  it('infers the cloud provider from the title and transcript, explicit value first', () => {
    expect(inferProviderFromRecording({ title: 'x', transcript: TRANSCRIPT })).toBe('Azure');
    expect(
      inferProviderFromRecording({ title: 'GitHub Actions deep dive', transcript: 'hi' })
    ).toBe('Github');
    expect(inferProviderFromRecording({ title: 'Lunch', transcript: 'nothing cloudy' })).toBe(
      'Multi'
    );
    expect(
      inferProviderFromRecording({ cloudProvider: 'aws', title: 'Azure', transcript: '' })
    ).toBe('Aws');
    // An explicit value the pipeline does not know is not persisted verbatim.
    expect(
      inferProviderFromRecording({ cloudProvider: 'Nimbus', title: 'Azure', transcript: '' })
    ).toBe('Azure');
  });
});

describe('createContentFromRecording', () => {
  function build({ store, drafter, persist = createContentDocument, budgetMs } = {}) {
    const s = store || memStore({ recordings: [recording] });
    const d = drafter || { generateDraft: vi.fn(async () => goodDraft) };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handler = createContentFromRecordingHandler({
      guard: allowGuard,
      recordingDrafter: createRecordingDrafter({
        drafter: d,
        store: s,
        persist,
        now,
        uuid: () => 'content-uuid-1',
        log,
      }),
      budgetMs,
    });
    return { store: s, drafter: d, handler, log };
  }
  const ctx = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  it('drafts through the shared drafter, persists through createContentDocument, links the recording', async () => {
    const { store, drafter, handler } = build();
    const res = parse(
      await handler(
        request({
          recordingId: 'rec-1',
          transcript: TRANSCRIPT,
          title: 'Landing zones, live',
          contentType: 'technical_guide',
          provider: 'gemini',
        }),
        ctx
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      contentId: 'content-uuid-1',
      linked: true,
      draft: {
        title: 'Why hub and spoke still wins',
        aiProvider: 'gemini',
        cloudProvider: 'Azure',
      },
    });

    // The drafter got the transcript as the source and the type's instructions.
    const call = drafter.generateDraft.mock.calls[0][0];
    expect(call.markdown).toBe(TRANSCRIPT.trim());
    expect(call.url).toBe('recording:rec-1');
    expect(call.cloudProvider).toBe('Azure');
    expect(call.customInstructionPrompt).toBe(RECORDING_CONTENT_TYPES.technical_guide.instructions);

    // The document is the createContentItem shape, not a private one.
    const doc = store.data.content.get('content-uuid-1');
    expect(doc).toMatchObject({
      id: 'content-uuid-1',
      type: 'blog',
      publishTarget: expect.any(String),
      Title: 'Why hub and spoke still wins',
      postContent: expect.stringContaining('## Heading'),
      contentStatus: 'draft',
      storageCollection: 'content',
      source: 'recording',
      sourceRecordingId: 'rec-1',
      recordingContentType: 'technical_guide',
      requestedAiProvider: 'gemini',
      aiProvider: 'gemini',
      'Cloud Provider': 'Azure',
      createdBy: 'ed@hcw.test',
      'Created At': NOW.toISOString(),
    });
    expect(doc.contentQuality).toBeDefined();
    expect(doc.imageReadiness).toBeDefined();
    expect(doc.titleNormalized ?? doc.dedupTitle ?? true).toBeTruthy();

    // The link back, server-side.
    expect(store.data.recordings.get('rec-1')).toMatchObject({
      status: 'routed',
      contentId: 'content-uuid-1',
      routedAt: NOW.toISOString(),
      routedContentType: 'technical_guide',
    });
  });

  it('falls back to the stored transcript and title when the request omits them', async () => {
    const { drafter, handler } = build();
    const res = parse(
      await handler(request({ recordingId: 'rec-1', contentType: 'meeting_summary' }), ctx)
    );
    expect(res.status).toBe(200);
    expect(drafter.generateDraft.mock.calls[0][0].markdown).toBe(TRANSCRIPT.trim());
    expect(drafter.generateDraft.mock.calls[0][0].scrapedTitle).toBe('Landing zones, live');
  });

  it('refuses without the editor role, before reading the body', async () => {
    const drafter = { generateDraft: vi.fn() };
    const handler = createContentFromRecordingHandler({
      guard: denyGuard,
      recordingDrafter: createRecordingDrafter({
        drafter,
        store: memStore(),
        persist: createContentDocument,
      }),
    });
    const res = await handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx);
    expect(res.status).toBe(401);
    expect(drafter.generateDraft).not.toHaveBeenCalled();
  });

  it('maps input, lookup and size failures to 400 / 404 / 422 / 413 without calling the model', async () => {
    const { drafter, handler, store } = build();
    expect(parse(await handler(request({ recordingId: 'rec-1' }), ctx)).status).toBe(400);
    expect(parse(await handler(request(null), ctx)).status).toBe(400);
    expect(
      parse(await handler(request({ recordingId: 'missing', contentType: 'blog_post' }), ctx))
        .status
    ).toBe(404);
    expect(
      parse(
        await handler(
          request({ recordingId: 'rec-1', contentType: 'blog_post', transcript: 'too short' }),
          ctx
        )
      )
    ).toMatchObject({ status: 422, body: { code: 'TRANSCRIPT_TOO_SHORT' } });
    expect(
      parse(
        await handler(
          request({
            recordingId: 'rec-1',
            contentType: 'blog_post',
            transcript: 'a'.repeat(MAX_TRANSCRIPT_CHARS + 1),
          }),
          ctx
        )
      )
    ).toMatchObject({ status: 413, body: { code: 'TRANSCRIPT_TOO_LONG' } });
    expect(drafter.generateDraft).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(MIN_TRANSCRIPT_CHARS).toBeLessThan(TRANSCRIPT.length);
  });

  it('reports a disabled or unconfigured AI feature as 503, a timeout as 504, anything else as 502', async () => {
    const disabled = new Error("The 'forgeDrafting' AI feature is turned off in the admin portal.");
    disabled.code = 'AI_FEATURE_DISABLED';
    let r = build({
      drafter: {
        generateDraft: vi.fn(async () => {
          throw disabled;
        }),
      },
    });
    expect(
      parse(await r.handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx))
    ).toMatchObject({ status: 503, body: { code: 'AI_FEATURE_DISABLED' } });
    expect(r.store.patchDoc).not.toHaveBeenCalled();

    const unconfigured = new Error('no key');
    unconfigured.code = 'AI_NOT_CONFIGURED';
    r = build({
      drafter: {
        generateDraft: vi.fn(async () => {
          throw unconfigured;
        }),
      },
    });
    expect(
      parse(await r.handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx))
        .status
    ).toBe(503);

    r = build({
      drafter: { generateDraft: vi.fn(() => new Promise(() => {})) },
      budgetMs: 20,
    });
    expect(
      parse(await r.handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx))
    ).toMatchObject({ status: 504, body: { code: 'DRAFT_BUDGET_EXCEEDED' } });

    r = build({
      drafter: {
        generateDraft: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
    });
    expect(
      parse(await r.handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx))
    ).toMatchObject({
      status: 502,
      // A provider's own words ('boom') never reach the answer (#945).
      body: { code: 'GENERATION_FAILED', error: 'The draft could not be created from this recording.' },
    });
  });

  it('hands the drafter its HTTP budget less the after-model margin, which the body cannot set', async () => {
    const { drafter, handler } = build();
    await handler(
      request({ recordingId: 'rec-1', contentType: 'blog_post', budgetMs: 999_999 }),
      ctx
    );
    const { budgetMs } = drafter.generateDraft.mock.calls[0][0];
    const ceiling = RECORDING_DRAFT_HTTP_BUDGET_MS - AFTER_MODEL_MARGIN_MS;
    // Less only the time the recording read took.
    expect(budgetMs).toBeLessThanOrEqual(ceiling);
    expect(budgetMs).toBeGreaterThan(ceiling - 1_000);
  });

  it("maps the router's AI_BUDGET_EXHAUSTED to 504 with its own (authored) message", async () => {
    const exhausted = new AiBudgetExhaustedError(
      "This AI call's 70 s budget ran out after nvidia (timed out); gemini (timed out). Not tried: openai."
    );
    const r = build({
      drafter: {
        generateDraft: vi.fn(async () => {
          throw exhausted;
        }),
      },
    });
    expect(
      parse(await r.handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx))
    ).toMatchObject({
      status: 504,
      body: { code: 'AI_BUDGET_EXHAUSTED', error: exhausted.message },
    });
    expect(r.store.patchDoc).not.toHaveBeenCalled();
  });

  it('surfaces the persistence path’s own verdicts (409 duplicate) and does not link the recording', async () => {
    const persist = vi.fn(async () => ({
      status: 409,
      body: { success: false, error: 'Duplicate content detected', existingId: 'c-old' },
    }));
    const { handler, store } = build({ persist });
    const res = parse(
      await handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx)
    );
    expect(res).toMatchObject({
      status: 409,
      body: { code: 'PERSIST_REJECTED', details: { existingId: 'c-old' } },
    });
    expect(store.patchDoc).not.toHaveBeenCalled();
    // The persistence call carried the shared write path's contract.
    expect(persist.mock.calls[0][0]).toMatchObject({
      runEditorialCritique: false,
      user: { email: 'ed@hcw.test' },
      data: { source: 'recording', contentStatus: 'draft' },
    });
  });

  it('returns 200 with linked:false when the recording link-back fails after the draft exists', async () => {
    // A 5xx here would invite a retry that creates a second draft; the client
    // PATCHes the same fields itself, so the link-back is best-effort.
    const store = memStore({ recordings: [recording] });
    store.patchDoc.mockImplementation(async () => {
      const err = new Error('Request rate is large');
      err.code = 429;
      throw err;
    });
    const { handler, log } = build({ store });
    const res = parse(
      await handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx)
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, contentId: 'content-uuid-1', linked: false });
    expect(store.data.content.get('content-uuid-1')).toBeDefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/link-back failed \(429\)/);
    expect(log.warn.mock.calls[0][0]).not.toContain('rec-1');
  });

  it('logs the status and code of a failure, never the message', async () => {
    const c = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
    const { handler } = build();
    await handler(request({ recordingId: 'missing-id-xyz', contentType: 'blog_post' }), c);
    // Content-free: the sentence, the code and the correlation id (#945).
    expect(c.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[[^\]]+\] The draft could not be created from this recording\. \(name=RecordingDraftError code=RECORDING_NOT_FOUND( at=[^)]+)?\)$/
      )
    );
    expect(JSON.stringify(c.warn.mock.calls)).not.toContain('missing-id-xyz');
    const boom = build({
      drafter: {
        generateDraft: vi.fn(async () => {
          throw new Error('secret text');
        }),
      },
    });
    await boom.handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), c);
    expect(c.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[[^\]]+\] The draft could not be created from this recording\. \(name=Error( at=[^)]+)?\)$/)
    );
    expect(JSON.stringify(c.error.mock.calls)).not.toContain('secret text');
  });

  it('treats an empty model answer as a generation failure, not a blank draft', async () => {
    const { handler, store } = build({
      drafter: { generateDraft: vi.fn(async () => ({ ...goodDraft, postContent: '   ' })) },
    });
    const res = parse(
      await handler(request({ recordingId: 'rec-1', contentType: 'blog_post' }), ctx)
    );
    expect(res).toMatchObject({ status: 502, body: { code: 'DRAFT_EMPTY' } });
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { retrieveEvidence } from './retrieval.js';
import { askBrain } from './assistant.js';
const item = (id, title = 'Docker release candidate', fields = {}) => ({
  id,
  title,
  body: 'Docker release rehearsal with a candidate image.',
  type: 'note',
  tags: ['docker'],
  ...fields,
});
const retrieve = (sources, fields = {}) =>
  retrieveEvidence({
    sources,
    question: 'Outline an article from this idea and cite my source notes',
    deadline: Date.now() + 85000,
    ...fields,
  });
describe('focused brain evidence retrieval', () => {
  it('asks for a subject on generic unscoped requests without spending on a provider', async () => {
    const sources = { search: vi.fn() };
    const ai = { generateJsonResponse: vi.fn() };
    expect(
      await askBrain({
        sources,
        ai,
        question: 'Outline an article from this idea and cite my source notes',
      }),
    ).toMatchObject({
      needsContext: true,
      insufficientEvidence: true,
      sources: [],
    });
    expect(sources.search).not.toHaveBeenCalled();
    expect(ai.generateJsonResponse).not.toHaveBeenCalled();
  });
  it('anchors a selected idea and excludes unrelated promotional evidence', async () => {
    const sources = {
      contextItems: vi.fn(async () => [item('idea')]),
      search: vi.fn(async () => ({
        items: [
          item('promotion', 'Azure event and FinOps', {
            body: 'AI event invitation.',
            tags: ['azure'],
          }),
          item('related'),
        ],
        cursor: null,
      })),
    };
    const result = await retrieve(sources, { contextId: 'idea' });
    expect(result.selected.map((r) => r.id)).toEqual(['idea', 'related']);
    expect(result.focusId).toBe('idea');
    expect(sources.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: expect.stringContaining('docker') }),
    );
  });
  it('uses body evidence with multiple anchor terms and preserves explicitly linked context', async () => {
    const sources = {
      contextItems: async () => [
        item('idea'),
        item('linked', 'Explicitly linked research', {
          tags: [],
          body: 'Private linked source',
        }),
      ],
      search: async () => ({
        items: [
          item('body', 'Build rehearsal', {
            tags: [],
            body: 'Docker release validation',
          }),
        ],
        cursor: null,
      }),
    };
    expect(
      (await retrieve(sources, { contextId: 'idea' })).selected.map(
        (r) => r.id,
      ),
    ).toEqual(['idea', 'linked', 'body']);
  });
  it('deduplicates recording copies and exact reference copies while retaining distinct private notes', async () => {
    const a = item('recording-a', 'Docker release meeting', {
      type: 'reference',
      source: { container: 'recordings' },
    });
    const b = item('recording-b', 'Docker release meeting', {
      type: 'reference',
      source: { container: 'podcast_transcripts' },
      body: 'Another transcript of the meeting',
    });
    const ref = item('content-a', 'Docker guide', { type: 'reference' });
    const sources = {
      search: async () => ({
        items: [
          a,
          b,
          ref,
          { ...ref, id: 'content-b' },
          item('private-a'),
          item('private-b'),
        ],
        cursor: null,
      }),
    };
    const result = await retrieve(sources, { question: 'Docker release' });
    expect(result.selected.map((r) => r.id)).toEqual([
      'recording-a',
      'private-a',
      'private-b',
      'content-a',
    ]);
  });
  it('keeps retrieval bounded, ranks candidates across pages and reports remaining work', async () => {
    const search = vi.fn(async ({ cursor }) => ({
      items: [
        item(`page-${cursor || 0}`),
        ...Array.from({ length: 4 }, (_, i) =>
          item(`extra-${cursor || 0}-${i}`),
        ),
      ],
      cursor: String(Number(cursor || 0) + 1),
    }));
    const result = await retrieve({ search }, { question: 'Docker release' });
    expect(search).toHaveBeenCalledTimes(3);
    expect(result.selected).toHaveLength(8);
    expect(result.partial).toBe(true);
  });
  it('rejects unavailable context and retrieval timeout without calling search', async () => {
    await expect(
      retrieve({ contextItems: async () => [] }, { contextId: 'removed' }),
    ).rejects.toMatchObject({ status: 404 });
    const search = vi.fn();
    await expect(
      retrieve({ search }, { question: 'Docker', deadline: Date.now() }),
    ).rejects.toMatchObject({ status: 504 });
    expect(search).not.toHaveBeenCalled();
  });
  it('flags shortened evidence and resolves citations to exact private items rather than tool landing pages', async () => {
    const sources = {
      contextItems: async () => [
        item('specific', 'Docker release', {
          href: '/admin/recording-hub',
          body: 'Docker '.repeat(1000),
        }),
      ],
      search: async () => ({ items: [], cursor: null }),
    };
    const ai = {
      generateJsonResponse: vi.fn(async () => ({
        insufficientEvidence: false,
        claims: [{ text: 'A release outline', sourceIds: ['S1'] }],
        suggestions: [],
      })),
    };
    const answer = await askBrain({
      sources,
      ai,
      question: 'Outline this idea',
      contextId: 'specific',
    });
    expect(answer.sources[0].href).toBe('/admin/second-brain?item=specific');
    expect(answer.partialRetrieval).toBe(true);
    const prompt = JSON.parse(ai.generateJsonResponse.mock.calls[0][0].prompt);
    expect(prompt.focusSourceId).toBe('S1');
    expect(prompt.evidence[0].excerpt).toHaveLength(5000);
  });
});

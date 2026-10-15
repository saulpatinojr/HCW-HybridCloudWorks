/**
 * The source-grounded half of the generate job (#433).
 *
 * Its own file rather than an addition to listen-and-learn-jobs.test.js: the
 * job is one registration serving two payload shapes, and the guide half's
 * tests must not need to know about the router's grounded door. The run
 * itself is tested against its seams in lib/listen-and-learn/source-episode.test.js;
 * what is pinned here is the seam between payload and run — that a source
 * list makes the payload a source episode, and that the registration is the
 * one the enqueue route names.
 */
import { describe, it, expect, vi } from 'vitest';

const registered = [];
vi.mock('../lib/jobs.js', async (importOriginal) => ({
  ...(await importOriginal()),
  registerJobType: vi.fn((type, spec) => registered.push({ type, spec })),
}));
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: vi.fn(),
  upsertDoc: vi.fn(),
  patchDoc: vi.fn(),
}));
vi.mock('../lib/blob-storage.js', () => ({ uploadBlob: vi.fn() }));

const { parseGeneratePayload } = await import('./listen-and-learn-jobs.js');
const { LISTEN_AND_LEARN_JOB_TYPE } = await import('../lib/listen-and-learn/source-episode.js');
const { GROUNDING_LIMITS } = await import('../lib/ai/router.js');

const sourcePayload = (over = {}) => ({
  platform: 'azure',
  examCode: 'AZ-104',
  title: 'Entra ID basics',
  sources: [
    { kind: 'page', url: 'https://example.com/entra' },
    { kind: 'video', url: 'https://youtu.be/abc123' },
  ],
  ...over,
});

describe('parseGeneratePayload with sources', () => {
  it('is a source episode, and needs no study guide URL', () => {
    const { value, error } = parseGeneratePayload(sourcePayload());
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      kind: 'source',
      platform: 'azure',
      examCode: 'AZ-104',
      title: 'Entra ID basics',
      areaSlug: 'source_entra-id-basics',
    });
    expect(value.sources).toHaveLength(2);
    expect(value).not.toHaveProperty('studyGuideUrl');
  });

  it('is decided by the presence of the field, not its length', () => {
    // An empty list is refused by the source rules rather than silently
    // becoming a guide run that would then want a study guide URL.
    const { error } = parseGeneratePayload(sourcePayload({ sources: [] }));
    expect(error).toMatch(/at least one source/);
    expect(error).not.toMatch(/studyGuideUrl/);
  });

  it('refuses the same things the route refuses, in the same words', () => {
    expect(
      parseGeneratePayload(
        sourcePayload({ sources: [{ kind: 'page', url: 'https://www.youtube.com/watch?v=x' }] })
      ).error
    ).toMatch(/YouTube URL given as kind 'page'/);
    const many = Array.from({ length: GROUNDING_LIMITS.videos + 1 }, (_, i) => ({
      kind: 'video',
      url: `https://youtu.be/v${i}`,
    }));
    expect(parseGeneratePayload(sourcePayload({ sources: many })).error).toMatch(
      new RegExp(`at most ${GROUNDING_LIMITS.videos} videos`)
    );
    expect(parseGeneratePayload(sourcePayload({ title: '' })).error).toMatch(/title is required/);
  });

  it('leaves a payload without sources on the guide path, unchanged', () => {
    const { value } = parseGeneratePayload({
      platform: 'azure',
      examCode: 'AZ-104',
      studyGuideUrl: 'https://learn.microsoft.com/az-104',
    });
    expect(value).not.toHaveProperty('kind');
    expect(value.studyGuideUrl).toBe('https://learn.microsoft.com/az-104');
  });
});

describe('the registration', () => {
  it('is the job type the enqueue route names, and its payload fits the caps', () => {
    const job = registered.find((r) => r.type === LISTEN_AND_LEARN_JOB_TYPE);
    expect(job).toBeDefined();
    expect(job.spec.role).toBe('editor');

    // Twenty pages and ten videos with a title each must not be refused for
    // size by the generic enqueue when the route's own validation accepts it.
    const full = sourcePayload({
      sources: [
        ...Array.from({ length: GROUNDING_LIMITS.pages }, (_, i) => ({
          kind: 'page',
          url: `https://learn.microsoft.com/en-us/azure/some/long/documentation/path/${i}`,
          title: 'A descriptive title for the page, as an owner might type one',
        })),
        ...Array.from({ length: GROUNDING_LIMITS.videos }, (_, i) => ({
          kind: 'video',
          url: `https://www.youtube.com/watch?v=abcdefghij${i}`,
          title: 'A descriptive title for the video',
        })),
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(full), 'utf8')).toBeLessThan(job.spec.maxPayloadBytes);
  });
});

/**
 * forge-from-url worker logic (Blog Machine T-602) and the target resolver
 * the /forge Telegram command depends on — its payload key mismatch shipped
 * once already (T-601), so the resolver's contract is pinned here too.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The module registers job types on import, and registerJobType throws on a
// duplicate — so the registry is faked rather than shared across test files.
vi.mock('../lib/jobs.js', () => ({ registerJobType: vi.fn() }));
vi.mock('../lib/cosmos-client.js', () => ({
  ADMIN_CONFIG_PARTITION: 'admin_config',
  readDoc: vi.fn(),
  queryDocs: vi.fn(),
  patchDoc: vi.fn(),
  upsertDoc: vi.fn(),
  incrementIf: vi.fn(),
  replaceDocIfMatch: vi.fn(),
  createDoc: vi.fn(),
}));
vi.mock('../lib/ai/router.js', () => ({
  generateJsonResponse: vi.fn(),
  generateTextResponse: vi.fn(),
  getActiveAiProvider: vi.fn(),
}));
const issueBuild = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../lib/job-failure-notify.js', () => ({
  createJobFailureOnComplete: vi.fn(() => notify),
}));
vi.mock('../lib/newsletter/issue.js', () => ({
  createIssueBuilder: vi.fn(() => ({ build: issueBuild })),
}));

const { resolveForgeTargets, runForgeFromUrl, forgeFromUrlComplete, FORGE_MAX_BATCH, forgeStore } =
  await import('./forge-jobs.js');
const { registerJobType } = await import('../lib/jobs.js');

// Registration happens once, on import. Vitest 5 clears mock call history
// before each test by default, so the import-time calls are copied here
// before any test runs, rather than read from the mock inside a test.
const registrations = [...registerJobType.mock.calls];

describe('the store the jobs hand to the forge (ADR 0033)', () => {
  /** Every `store.<method>(` the given module calls. */
  const storeMethodsIn = (file) => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    return [...new Set([...text.matchAll(/\bstore\.(\w+)\(/g)].map((m) => m[1]))];
  };

  it('carries every method forge.js calls, so the budget claim cannot throw a TypeError', () => {
    // The crash: forge.js claimForgeBudget calls store.incrementIf,
    // store.replaceDocIfMatch and store.createDoc; the store here had none of
    // them, so every manual forge job died at the claim, before any model call.
    const called = storeMethodsIn('../lib/content/forge.js');
    expect(called).toEqual(
      expect.arrayContaining(['incrementIf', 'replaceDocIfMatch', 'createDoc'])
    );
    for (const method of called) {
      expect(typeof forgeStore[method], `forgeStore.${method}`).toBe('function');
    }
  });

  it('carries every method the calibration job and the drafter call too', () => {
    // forge-studio.js is a re-export shim since PR #841; the calibration job's
    // store calls live in forge-studio/calibration.js. The non-empty check
    // keeps this loop from passing vacuously if that file moves again.
    // The drafter reaches the store through its own deps, so only the
    // calibration module is held to a non-empty call list.
    expect(storeMethodsIn('../lib/content/forge-studio/calibration.js').length).toBeGreaterThan(0);
    const files = ['../lib/content/forge-studio/calibration.js', '../lib/content/drafting.js'];
    for (const file of files) {
      for (const method of storeMethodsIn(file)) {
        expect(typeof forgeStore[method], `${file} → forgeStore.${method}`).toBe('function');
      }
    }
  });
});

describe('build-newsletter-issue', () => {
  const worker = () => registrations.find(([name]) => name === 'build-newsletter-issue')[1].worker;

  it('passes no days of its own, so the window saved in Newsletter settings applies (#557)', async () => {
    issueBuild.mockClear();
    await worker()({}, { context: {} });
    expect(issueBuild).toHaveBeenCalledWith({ days: undefined });
    await worker()(undefined, { context: {} });
    expect(issueBuild).toHaveBeenLastCalledWith({ days: undefined });
  });

  it('still passes an explicit days through for the builder to clamp, and nothing else', async () => {
    issueBuild.mockClear();
    await worker()({ days: 14, keep: true, keptBy: 'someone' }, { context: {} });
    expect(issueBuild).toHaveBeenCalledWith({ days: 14 });
  });
});

describe('resolveForgeTargets', () => {
  it('accepts sourceContentId and sourceContentIds, deduped and trimmed', () => {
    expect(resolveForgeTargets({ sourceContentId: ' a ' })).toEqual(['a']);
    expect(resolveForgeTargets({ sourceContentIds: ['a', 'b', 'a', ''] })).toEqual(['a', 'b']);
  });

  it('rejects an empty payload and an oversized batch', () => {
    expect(() => resolveForgeTargets({})).toThrow(/sourceContentId/);
    expect(() =>
      resolveForgeTargets({
        sourceContentIds: Array.from({ length: FORGE_MAX_BATCH + 1 }, (_, i) => `c${i}`),
      })
    ).toThrow(/At most/);
  });
});

describe('runForgeFromUrl', () => {
  const PAGE = `<html><head><title>Scraped Page</title></head></html>`;
  const deps = (over = {}) => ({
    scrape: vi.fn(async () => ({
      success: true,
      markdown: '# Source',
      html: PAGE,
      images: [],
      wordCount: 10,
      scrapeMode: 'direct_html',
    })),
    forge: {
      runForgePipeline: vi.fn(async () => ({
        ok: true,
        result: { success: true, contentId: 'new-1', status: 'forge_ready' },
      })),
    },
    store: { upsertDoc: vi.fn() },
    now: () => new Date('2026-08-28T00:00:00Z'),
    uuid: () => 'new-1',
    log: {},
    actor: { email: 'owner@hcw' },
    ...over,
  });

  it('scrapes, writes the source doc, forges it, and reports the staging status', async () => {
    const d = deps();
    const out = await runForgeFromUrl({ url: 'https://learn.microsoft.com/azure/x' }, d);
    expect(d.store.upsertDoc).toHaveBeenCalledWith(
      'content',
      expect.objectContaining({
        id: 'new-1',
        Title: 'Scraped Page',
        'Cloud Provider': 'Azure', // inferred from the URL when payload has none
        contentStatus: 'inspected',
        inspectTrigger: false,
        source: 'forge-url',
      })
    );
    expect(d.forge.runForgePipeline).toHaveBeenCalledWith({
      contentId: 'new-1',
      actor: { email: 'owner@hcw' },
    });
    expect(out).toMatchObject({
      status: 'forge_ready',
      sourceUrl: 'https://learn.microsoft.com/azure/x',
    });
  });

  it('honours an explicit provider over inference', async () => {
    const d = deps();
    await runForgeFromUrl({ url: 'https://learn.microsoft.com/azure/x', provider: 'Finops' }, d);
    expect(d.store.upsertDoc.mock.calls[0][1]['Cloud Provider']).toBe('Finops');
  });

  it('fails the job on a bad URL or failed scrape, before any write', async () => {
    const d = deps({
      scrape: vi.fn(async () => ({ success: false, error: '403' })),
    });
    await expect(runForgeFromUrl({ url: 'https://a.example/x' }, d)).rejects.toThrow(/403/);
    await expect(runForgeFromUrl({ url: 'nope' }, d)).rejects.toMatchObject({
      code: 'BAD_URL',
    });
    expect(d.store.upsertDoc).not.toHaveBeenCalled();
  });

  it('reports a duplicate (409) as skipped instead of failing the job', async () => {
    const d = deps({
      forge: {
        runForgePipeline: vi.fn(async () => ({
          ok: false,
          httpStatus: 409,
          error: 'Skipped as likely duplicate of published "X"',
          duplicateOf: 'X',
        })),
      },
    });
    const out = await runForgeFromUrl({ url: 'https://a.example/x' }, d);
    expect(out).toMatchObject({
      success: false,
      skipped: true,
      duplicateOf: 'X',
    });
  });

  it('fails the job when the pipeline fails for any non-duplicate reason', async () => {
    const d = deps({
      forge: {
        runForgePipeline: vi.fn(async () => ({
          ok: false,
          httpStatus: 502,
          error: 'Generation failed',
        })),
      },
    });
    await expect(runForgeFromUrl({ url: 'https://a.example/x' }, d)).rejects.toThrow(
      /Generation failed/
    );
  });
});

describe('forge-from-url with a brief on the payload (the Forge Studio Queue, 2026-10-06)', () => {
  const PAGE = `<html><head><title>Scraped Page</title></head></html>`;
  const deps = (over = {}) => ({
    scrape: vi.fn(async () => ({
      success: true,
      markdown: '# Source',
      html: PAGE,
      images: [],
      wordCount: 10,
      scrapeMode: 'direct_html',
    })),
    forge: {
      runForgePipeline: vi.fn(async () => ({
        ok: true,
        result: { success: true, contentId: 'new-1', status: 'forge_ready' },
      })),
    },
    store: { upsertDoc: vi.fn(), patchDoc: vi.fn(async () => ({ _etag: 'e2' })) },
    now: () => new Date('2026-10-06T00:00:00Z'),
    uuid: () => 'new-1',
    log: {},
    actor: { email: 'owner@hcw' },
    ...over,
  });

  it('applies the brief onto the source document before the pipeline runs, in URL mode on the scraped URL', async () => {
    const d = deps();
    const calls = [];
    d.store.patchDoc.mockImplementation(async () => {
      calls.push('brief');
      return { _etag: 'e2' };
    });
    d.forge.runForgePipeline.mockImplementation(async () => {
      calls.push('forge');
      return { ok: true, result: { success: true, contentId: 'new-1', status: 'forge_ready' } };
    });
    await runForgeFromUrl(
      {
        url: 'https://learn.microsoft.com/azure/x',
        brief: { objective: 'Explain', mode: 'idea', sourceUrl: 'https://evil.test', targetChannel: 'coder_corner' },
        kind: 'guide',
        ideaOrigin: 'imported-source',
        queueItemId: 'q-1',
      },
      d
    );
    expect(calls).toEqual(['brief', 'forge']);
    expect(d.store.patchDoc).toHaveBeenCalledWith(
      'content',
      'new-1',
      expect.objectContaining({
        kind: 'guide',
        ideaOrigin: 'imported-source',
        type: 'coder_corner',
        publishTarget: 'coder_corner',
        forgeBrief: expect.objectContaining({
          objective: 'Explain',
          mode: 'url',
          sourceUrl: 'https://learn.microsoft.com/azure/x',
          savedBy: 'owner@hcw',
        }),
        activity: [expect.objectContaining({ action: 'forge_brief_saved', actor: 'owner@hcw' })],
      })
    );
  });

  it('applies a brief that names only a tone (the URL gives it substance) and none when the payload has none', async () => {
    const d = deps();
    await runForgeFromUrl({ url: 'https://a.test/x', brief: { tone: 'Opinionated' } }, d);
    expect(d.store.patchDoc).toHaveBeenCalledTimes(1);
    expect(d.store.patchDoc.mock.calls[0][2].forgeBrief).toMatchObject({
      tone: 'Opinionated',
      sourceUrl: 'https://a.test/x',
    });
    await runForgeFromUrl({ url: 'https://a.test/x' }, d);
    expect(d.store.patchDoc).toHaveBeenCalledTimes(1);
    expect(d.forge.runForgePipeline).toHaveBeenCalledTimes(2);
  });

  it('onComplete hands the failure ping a payload with the URL and entry id only, never the brief', async () => {
    notify.mockClear();
    await forgeFromUrlComplete(
      {
        job: {
          id: 'j3',
          type: 'forge-from-url',
          payload: { url: 'https://a.test', brief: { objective: 'secret plan' }, kind: 'guide', queueItemId: 'q-1' },
        },
        status: 'failed',
        result: null,
        error: 'scrape 403',
      },
      { context: {}, now: () => new Date('2026-10-06T00:00:00Z') }
    );
    expect(notify).toHaveBeenCalledTimes(1);
    const [info] = notify.mock.calls[0];
    expect(info.job.payload).toEqual({ url: 'https://a.test', queueItemId: 'q-1' });
    expect(JSON.stringify(info)).not.toContain('secret plan');
  });

  it('onComplete records the outcome on the queue entry only when the job came from the queue', async () => {
    const cosmos = await import('../lib/cosmos-client.js');
    cosmos.readDoc.mockClear?.();
    const hookCtx = { context: {}, now: () => new Date('2026-10-06T00:00:00Z') };
    await forgeFromUrlComplete(
      { job: { id: 'j1', type: 'forge-from-url', payload: { url: 'https://a.test' } }, status: 'succeeded', result: { success: true, contentId: 'c1' }, error: null },
      hookCtx
    );
    expect(cosmos.readDoc).not.toHaveBeenCalledWith(
      'admin_config',
      expect.stringMatching(/^forge_queue_item:/),
      'admin_config'
    );
    await forgeFromUrlComplete(
      {
        job: {
          id: 'j2',
          type: 'forge-from-url',
          payload: { url: 'https://a.test', queueItemId: 'forge_queue_item:q-1' },
        },
        status: 'failed',
        result: null,
        error: 'scrape 403',
      },
      hookCtx
    );
    expect(cosmos.readDoc).toHaveBeenCalledWith('admin_config', 'forge_queue_item:q-1', 'admin_config');
  });

  it('the registered type takes a 16 KiB payload and uses the queue-aware onComplete', () => {
    const spec = registrations.find(([name]) => name === 'forge-from-url')[1];
    expect(spec.maxPayloadBytes).toBe(16384);
    expect(spec.onComplete).toBe(forgeFromUrlComplete);
  });

  it('runForgeFromUrl honors aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('aborted'));
    const deps = {
      scrape: vi.fn(),
      forge: { runForgePipeline: vi.fn() },
      store: { upsertDoc: vi.fn() },
      now: () => new Date(),
      uuid: () => 'u1',
      log: { log: vi.fn() },
      actor: {},
      signal: controller.signal,
    };
    await expect(runForgeFromUrl({ url: 'https://example.com' }, deps)).rejects.toThrow('aborted');
    expect(deps.scrape).not.toHaveBeenCalled();
  });

  it('forge-article worker honors aborted signal', async () => {
    const spec = registrations.find(([name]) => name === 'forge-article')[1];
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    await expect(
      spec.worker(
        { sourceContentId: 'c-1' },
        { context: { log: vi.fn() }, job: {}, signal: controller.signal }
      )
    ).rejects.toThrow('timeout');
  });
});


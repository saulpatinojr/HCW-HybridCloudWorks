/**
 * Generation payload validation.
 *
 * `studyGuideUrl` is fetched server-side by the Function App's managed
 * identity, from inside the VNet. An attacker-chosen URL there is an SSRF
 * foothold, not a typo — which is why the scheme check is a hard `https://`
 * prefix test and why it is pinned here rather than left to the parser.
 */
import { describe, it, expect, vi } from 'vitest';

// The module registers a job type on import, and registerJobType throws on a
// duplicate — so the registry is faked rather than shared across test files.
vi.mock('../lib/jobs.js', async (importOriginal) => ({
  ...(await importOriginal()),
  registerJobType: vi.fn(),
}));
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: vi.fn(),
  upsertDoc: vi.fn(),
  patchDoc: vi.fn(),
  ADMIN_CONFIG_PARTITION: 'admin_config',
}));
vi.mock('../lib/blob-storage.js', () => ({ uploadBlob: vi.fn() }));
// The real cost table stays: the speech estimate below is priced through it,
// and a stubbed getCostEstimate would make the arithmetic here meaningless.
vi.mock('../lib/ai/router.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateJsonResponse: vi.fn(),
  getActiveAiProvider: vi.fn(),
}));

const {
  parseGeneratePayload,
  resolveRunModel,
  roundUpUsd,
  speechEstimateForRun,
  MAX_AREAS_PER_RUN,
  TASK_MODEL_NOTE,
  runListenAndLearnGeneration,
  runSpeakChapter,
} = await import('./listen-and-learn-jobs.js');
const { MAX_SCRIPT_BYTES } = await import('../lib/listen-and-learn/script.js');
const { estimateGeminiCostUsd } = await import('../lib/listen-and-learn/speech/index.js');

const BEST = 'gemini-3.1-flash-tts-preview';
const ECONOMY = 'gemini-2.5-flash-preview-tts';

const valid = (over = {}) => ({
  platform: 'azure',
  examCode: 'AZ-104',
  studyGuideUrl: 'https://learn.microsoft.com/credentials/az-104',
  ...over,
});

describe('parseGeneratePayload', () => {
  it('accepts a well-formed request and normalises the platform', () => {
    const { value, error } = parseGeneratePayload(valid({ platform: 'AZURE' }));
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      platform: 'azure',
      examCode: 'AZ-104',
      studyGuideUrl: 'https://learn.microsoft.com/credentials/az-104',
      areas: null,
    });
  });

  it('carries the optional certification identity through', () => {
    const { value } = parseGeneratePayload(
      valid({ certTitle: '  Azure Administrator  ', certSlug: 'az-104' })
    );
    expect(value.cert).toEqual({ title: 'Azure Administrator', slug: 'az-104' });
  });

  it('nulls a blank certification title rather than storing an empty string', () => {
    const { value } = parseGeneratePayload(valid({ certTitle: '   ' }));
    expect(value.cert.title).toBeNull();
  });

  it('refuses a platform with no study-guide adapter, naming the ones there are', () => {
    const { error } = parseGeneratePayload(valid({ platform: 'vmware' }));
    expect(error).toMatch(/not available for "vmware"/);
    expect(error).toMatch(/azure, github, aws/);
  });

  it('refuses every non-https study guide URL', () => {
    // http is downgradeable, and file/localhost/metadata URLs are the actual
    // SSRF targets on a Function App inside a VNet.
    for (const studyGuideUrl of [
      'http://learn.microsoft.com/x',
      'file:///etc/passwd',
      'http://169.254.169.254/metadata/instance',
      'HTTPS://learn.microsoft.com/x', // scheme is case-sensitive in this test
      '//learn.microsoft.com/x',
      '',
    ]) {
      expect(parseGeneratePayload(valid({ studyGuideUrl })).error).toBe(
        'studyGuideUrl must be an https URL'
      );
    }
  });

  it('accepts an https URL', () => {
    expect(parseGeneratePayload(valid()).error).toBeUndefined();
  });

  it('requires an exam code', () => {
    expect(parseGeneratePayload(valid({ examCode: '  ' })).error).toBe('examCode is required');
  });

  it('bounds how many areas one run may generate', () => {
    // Each area is a model call plus one or more synthesis requests; an
    // unbounded list is an unbounded spend.
    const areas = Array.from({ length: MAX_AREAS_PER_RUN + 1 }, (_, i) => `area-${i}`);
    expect(parseGeneratePayload(valid({ areas })).error).toMatch(
      new RegExp(`At most ${MAX_AREAS_PER_RUN} areas`)
    );

    const ok = areas.slice(0, MAX_AREAS_PER_RUN);
    expect(parseGeneratePayload(valid({ areas: ok })).error).toBeUndefined();
  });

  it('ignores a non-array areas value instead of trusting it', () => {
    expect(parseGeneratePayload(valid({ areas: 'area-1' })).value.areas).toBeNull();
  });

  it('refuses a missing payload without throwing', () => {
    expect(parseGeneratePayload(undefined).error).toBeTruthy();
    expect(parseGeneratePayload(null).error).toBeTruthy();
  });

  describe('ttsModel — ignored since the Tasks tab owns the model (ADR 0034 slice 5, #860)', () => {
    it('carries no model through, whatever the payload names', () => {
      // A client written before this slice still gets its 202; the worker
      // reads the model for the listenAndLearnSpeech task when it runs.
      for (const ttsModel of [BEST, ECONOMY, '', null, 'polly', 7]) {
        const { value, error } = parseGeneratePayload(valid({ ttsModel }));
        expect(error, String(ttsModel)).toBeUndefined();
        expect(value, String(ttsModel)).not.toHaveProperty('ttsModel');
      }
      expect(parseGeneratePayload(valid()).value).not.toHaveProperty('ttsModel');
    });

    it('is ignored on a source-grounded run too', () => {
      const source = {
        platform: 'azure',
        examCode: 'AZ-104',
        title: 'Entra ID basics',
        sources: [{ kind: 'page', url: 'https://learn.microsoft.com/entra' }],
      };
      expect(parseGeneratePayload({ ...source, ttsModel: 'polly' }).value).toMatchObject({
        kind: 'source',
      });
      expect(parseGeneratePayload({ ...source, ttsModel: ECONOMY }).value).not.toHaveProperty(
        'ttsModel'
      );
    });
  });
});

describe('resolveRunModel', () => {
  // The model is the listenAndLearnSpeech task's, read through the router
  // (ADR 0034 slice 5, #860): the resolver names the Gemini model; Azure AI
  // Speech stays the switch's own fallback, so a task with nothing eligible
  // answers null and lets the switch decide; a task switched off fails the
  // run before the voice is called.
  const routerWith = (outcome) => ({
    modelForTask: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  });

  it('reads the task’s model through the router, naming the task', async () => {
    const ai = routerWith({ provider: 'gemini', model: BEST, selection: 'custom', why: 'custom chain, step 1' });
    expect(await resolveRunModel(ai)).toBe(BEST);
    expect(ai.modelForTask).toHaveBeenCalledWith({ task: 'listenAndLearnSpeech' });
  });

  it('is null when the task has nothing eligible, leaving the switch to Azure or "not configured"', async () => {
    const refused = new Error("No eligible model carries 'tts' for 'listenAndLearnSpeech'");
    refused.code = 'AI_NOT_CONFIGURED';
    expect(await resolveRunModel(routerWith(refused))).toBeNull();
    expect(await resolveRunModel(routerWith({ provider: 'gemini', model: null }))).toBeNull();
  });

  it('lets a switched-off task fail the run rather than reading in a voice nobody chose', async () => {
    const off = new Error("The 'listenAndLearnSpeech' AI feature is turned off in the admin portal.");
    off.code = 'AI_FEATURE_DISABLED';
    await expect(resolveRunModel(routerWith(off))).rejects.toBe(off);
    const broken = new Error('Cosmos is down');
    await expect(resolveRunModel(routerWith(broken))).rejects.toBe(broken);
  });
});

describe('speechEstimateForRun', () => {
  // Stated in the 202 before the run starts (ADR 0029 §2a). A ceiling: every
  // episode priced at MAX_SCRIPT_BYTES, the most UTF-8 bytes a script may
  // hold. Always the Listen & Learn product: Gemini, never ElevenLabs.
  const GEMINI = { GEMINI_API_KEY: 'g' };
  const ALL = { ELEVENLABS_API_KEY: 'e', GEMINI_API_KEY: 'g' };
  const perEpisode = (model) => estimateGeminiCostUsd(model, MAX_SCRIPT_BYTES);

  it('prices every requested area at the script ceiling, with Gemini, at the dearer model', () => {
    const estimate = speechEstimateForRun(valid({ areas: ['a', 'b'] }), GEMINI);
    expect(MAX_SCRIPT_BYTES).toBe(9000);
    expect(perEpisode(BEST)).toBeGreaterThan(0);
    expect(estimate).toEqual({
      provider: 'gemini',
      model: null,
      modelSource: 'task',
      modelNote: TASK_MODEL_NOTE,
      episodes: 2,
      perEpisodeUsd: perEpisode(BEST),
      estimatedCostUsd: roundUpUsd(perEpisode(BEST) * 2),
    });
    expect(estimate.estimatedCostUsd).toBeGreaterThanOrEqual(perEpisode(BEST) * 2);
  });

  it('does not name a model it cannot know: the task chooses when the run starts, so the figure is the dearer model’s', () => {
    // The hook is synchronous and sees only the payload; the worker reads the
    // listenAndLearnSpeech task's model through the router (ADR 0034 slice 5).
    // Saying "2.5" here when the task resolves to "3.1" would be a 202 that
    // disagrees with the run (Copilot on #462), so the model is null with a
    // sentence, and the figure is the ceiling whichever the task chooses. A
    // ttsModel in the payload is ignored, never echoed back.
    for (const payload of [
      valid({ areas: ['a', 'b'] }),
      valid({ areas: ['a', 'b'], ttsModel: '' }),
      valid({ areas: ['a', 'b'], ttsModel: ECONOMY }),
      valid({ areas: ['a', 'b'], ttsModel: 'gemini-2.5-pro-preview-tts' }),
    ]) {
      const estimate = speechEstimateForRun(payload, GEMINI);
      expect(estimate).toEqual({
        provider: 'gemini',
        model: null,
        modelSource: 'task',
        modelNote: TASK_MODEL_NOTE,
        episodes: 2,
        perEpisodeUsd: perEpisode(BEST),
        estimatedCostUsd: roundUpUsd(perEpisode(BEST) * 2),
      });
      expect(estimate.perEpisodeUsd).toBeGreaterThan(perEpisode(ECONOMY));
      expect(JSON.stringify(estimate)).not.toContain('pro-preview');
    }
    expect(TASK_MODEL_NOTE).toBe('the model is chosen under AI Engine → Tasks (Listen & Learn speech)');
    // A LISTEN_AND_LEARN_TTS_MODEL setting naming a cheaper model does not
    // lower the figure either: the task could still resolve to Best.
    expect(
      speechEstimateForRun(valid({ areas: ['a'] }), { ...GEMINI, LISTEN_AND_LEARN_TTS_MODEL: ECONOMY })
        .perEpisodeUsd
    ).toBe(perEpisode(BEST));
  });

  it('trims the run total to six decimals without ever dropping below the exact figure', () => {
    // toFixed rounds to nearest; a ceiling rounds up (Copilot on the PR).
    expect(roundUpUsd(0.4400004)).toBe(0.440001);
    expect(roundUpUsd(0.4400006)).toBe(0.440001);
    expect(roundUpUsd(0.44)).toBe(0.44);
    expect(roundUpUsd(0)).toBe(0);
    for (const usd of [0.1234561, 1.9999999, 3.5200001, 7 / 3]) {
      expect(roundUpUsd(usd)).toBeGreaterThanOrEqual(usd);
      expect(roundUpUsd(usd) - usd).toBeLessThan(1e-6);
    }
  });

  it('describes Gemini even when the ElevenLabs key is present — that key is the podcast’s', () => {
    const estimate = speechEstimateForRun(valid({ areas: ['a'] }), ALL);
    expect(estimate.provider).toBe('gemini');
    expect(estimate.model).toBeNull();
    expect(estimate.perEpisodeUsd).toBe(perEpisode(BEST));
  });

  it('assumes the most a run may generate when the areas are not yet known', () => {
    const estimate = speechEstimateForRun(valid(), GEMINI);
    expect(estimate.episodes).toBe(MAX_AREAS_PER_RUN);
    expect(estimate.estimatedCostUsd).toBeCloseTo(perEpisode(BEST) * MAX_AREAS_PER_RUN, 6);
  });

  it('never prices more areas than a run may generate', () => {
    const areas = Array.from({ length: MAX_AREAS_PER_RUN + 3 }, (_, i) => `area-${i}`);
    expect(speechEstimateForRun(valid({ areas }), GEMINI).episodes).toBe(MAX_AREAS_PER_RUN);
  });

  it('says there is no provider rather than pricing nothing at zero, and why', () => {
    const none = {
      provider: null,
      model: null,
      modelSource: null,
      episodes: MAX_AREAS_PER_RUN,
      perEpisodeUsd: null,
      estimatedCostUsd: null,
      reason: 'not_configured',
    };
    expect(speechEstimateForRun(valid(), {})).toEqual(none);
    // An ElevenLabs key alone configures nothing for this product.
    expect(speechEstimateForRun(valid(), { ELEVENLABS_API_KEY: 'e' })).toEqual(none);
  });

  it('tells an unusable pin apart from nothing configured', () => {
    // Both price as null; only one of them is the normal transcript-only
    // state. The other is a setting to correct before the audio step fails.
    const pinned = { GEMINI_API_KEY: 'g', LISTEN_AND_LEARN_TTS_PROVIDER: 'azure' };
    expect(speechEstimateForRun(valid(), pinned)).toMatchObject({
      provider: null,
      reason: 'pin_unavailable',
    });
    // A pin naming the podcast's provider is unusable too, key or no key.
    const crossed = { ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'elevenlabs' };
    expect(speechEstimateForRun(valid(), crossed).reason).toBe('pin_unavailable');
    const unknown = { GEMINI_API_KEY: 'g', LISTEN_AND_LEARN_TTS_PROVIDER: 'polly' };
    expect(speechEstimateForRun(valid(), unknown).reason).toBe('pin_unavailable');
    // A usable pin — the one Terraform sets — carries no reason at all.
    const usable = { ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'gemini' };
    expect(speechEstimateForRun(valid(), usable)).not.toHaveProperty('reason');
    expect(speechEstimateForRun(valid(), usable).provider).toBe('gemini');
  });

  it('is honest that Azure Speech is not priced', () => {
    const azure = { AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_REGION: 'eastus' };
    expect(speechEstimateForRun(valid({ areas: ['a'] }), azure)).toEqual({
      provider: 'azure',
      model: null,
      modelSource: null,
      episodes: 1,
      perEpisodeUsd: null,
      estimatedCostUsd: null,
    });
  });

  it('does not throw on a payload the worker would refuse', () => {
    expect(() => speechEstimateForRun(null, GEMINI)).not.toThrow();
    expect(speechEstimateForRun({ areas: 'not-a-list' }, GEMINI).episodes).toBe(MAX_AREAS_PER_RUN);
  });
});

describe('listen-and-learn worker abort handling', () => {
  it('runListenAndLearnGeneration throws if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runListenAndLearnGeneration(valid(), { signal: controller.signal })
    ).rejects.toThrow();
  });

  it('runSpeakChapter throws if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSpeakChapter({ platform: 'azure', examCode: 'AZ-104', chapterId: 'ch1' }, { signal: controller.signal })
    ).rejects.toThrow();
  });
});

/**
 * The audio and image tasks join the Tasks table (ADR 0034 slice 5, #860):
 * the media providers in the catalogue and the resolver, the media tasks'
 * default mode, the selection document's two provider lists, the migration
 * of the model fields the settings pages carried, the router's one door for
 * the media call sites, and the per-task Test that spends nothing on them.
 */
import { describe, it, expect, vi } from 'vitest';
import { selectChain } from './select.js';
import { normalizeSelection, validateSelection } from './selection.js';
import {
  MEDIA_MIGRATION_TASKS,
  applyMediaMigration,
  defaultSelection,
  migrateSelection,
} from './migrate-selection.js';
import { createAiConfigLoader, selectionFrom } from './ai-config.js';
import {
  createListContext,
  listModels,
  readModelCatalog,
  selectableModelsFor,
  visibleModelsFor,
} from './model-catalog.js';
import { enrichModel, pricingFor } from './model-catalog-doc.js';
import { MEDIA_KEY_ENV, createAiRouter } from './router.js';
import { KNOWN_PROVIDERS, MEDIA_PROVIDERS, DEFAULT_PROVIDER_ORDER } from './provider-order.js';
import { AI_TASKS, PLANNED_TASKS } from './tasks.js';
import { createAdminIntegrationHandlers } from '../admin-integrations.js';

const quiet = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
const noSleep = async () => {};
const ALL = [...KNOWN_PROVIDERS];
const everyone = { keyed: ALL, enabled: ALL };
const chatOnly = { keyed: [...DEFAULT_PROVIDER_ORDER], enabled: [...DEFAULT_PROVIDER_ORDER] };

const v2 = (tasks = {}, priority = DEFAULT_PROVIDER_ORDER.map((provider) => ({ provider, model: null }))) =>
  normalizeSelection({ version: 2, global: { priority }, tasks });

describe('the resolver (select.js)', () => {
  it('a media task defaults to Recommended and resolves to its recommendation when the provider is keyed', () => {
    for (const task of ['listenAndLearnSpeech', 'podcastVoice', 'coverArt', 'manualImages']) {
      const { mode, chain } = selectChain({ task, selection: v2(), catalog: null, availability: everyone });
      expect(mode, task).toBe('recommended');
      expect(chain[0], task).toMatchObject({
        provider: AI_TASKS[task].recommended.provider,
        model: AI_TASKS[task].recommended.model,
        selection: 'recommended',
      });
    }
  });

  it('the Priority list is a chat list: every chat provider is turned away from a media task, by capability or by the product rule', () => {
    const { mode, chain, rejected } = selectChain({
      task: 'podcastVoice',
      selection: v2(),
      catalog: null,
      availability: chatOnly,
    });
    // ElevenLabs holds no key here, so the recommendation fails and the list serves — nothing.
    expect(mode).toBe('global');
    expect(chain).toEqual([]);
    expect(rejected.find((r) => r.provider === 'elevenlabs')).toMatchObject({ code: 'no-key' });
    // Gemini carries tts, and is still turned away: the podcast voice is
    // ElevenLabs-only (ADR 0029 §2b), a lock no document lifts.
    expect(rejected.find((r) => r.provider === 'gemini')).toMatchObject({
      code: 'policy',
      why: 'not eligible: Podcast voice is served by elevenlabs only',
    });
    for (const provider of DEFAULT_PROVIDER_ORDER.filter((p) => p !== 'gemini')) {
      expect(rejected.find((r) => r.provider === provider), provider).toMatchObject({
        code: 'capability',
        missing: ['tts'],
        why: `not eligible: ${provider} cannot carry tts`,
      });
    }
    // And the other way: ElevenLabs never reads Listen & Learn, Gemini never makes an image.
    const doc = v2({
      listenAndLearnSpeech: { mode: 'custom', chain: [{ provider: 'elevenlabs' }], thenGlobal: false },
      coverArt: { mode: 'custom', chain: [{ provider: 'gemini', model: 'imagen-4.0-generate-001' }], thenGlobal: false },
    });
    const speech = selectChain({ task: 'listenAndLearnSpeech', selection: doc, catalog: null, availability: everyone });
    expect(speech.rejected[0]).toMatchObject({ provider: 'elevenlabs', code: 'policy' });
    expect(speech.chain[0]).toMatchObject({ provider: 'gemini', selection: 'global', modalityModel: 'gemini-3.8-flash-tts' });
    const cover = selectChain({ task: 'coverArt', selection: doc, catalog: null, availability: everyone });
    expect(cover.rejected[0]).toMatchObject({ provider: 'gemini', code: 'capability', missing: ['image'] });
    expect(cover.chain).toEqual([]);
  });

  it('Gemini carries tts: a custom chain naming its TTS model serves Listen & Learn speech, a chat model does not', () => {
    const best = v2({
      listenAndLearnSpeech: {
        mode: 'custom',
        chain: [{ provider: 'gemini', model: 'gemini-3.1-flash-tts-preview' }],
        thenGlobal: false,
      },
    });
    const { chain } = selectChain({ task: 'listenAndLearnSpeech', selection: best, catalog: null, availability: everyone });
    expect(chain).toEqual([
      expect.objectContaining({ provider: 'gemini', model: 'gemini-3.1-flash-tts-preview', selection: 'custom' }),
    ]);
    const text = v2({
      listenAndLearnSpeech: {
        mode: 'custom',
        chain: [{ provider: 'gemini', model: 'gemini-3.6-flash' }],
        thenGlobal: false,
      },
    });
    const refused = selectChain({ task: 'listenAndLearnSpeech', selection: text, catalog: null, availability: everyone });
    expect(refused.rejected[0]).toMatchObject({ provider: 'gemini', code: 'capability', missing: ['tts'] });
    // §6: nothing eligible and no list behind it reads as global — and the
    // list's Gemini step, judged on Gemini's TTS recommendation, serves.
    expect(refused.mode).toBe('global');
    expect(refused.flags[0]).toMatch(/no entry of the custom chain is eligible/);
    expect(refused.chain[0]).toMatchObject({ provider: 'gemini', model: null, modalityModel: 'gemini-3.8-flash-tts' });
  });

  it('a custom step naming a media provider and no model is judged on its modality recommendation', () => {
    const doc = v2({
      podcastVoice: { mode: 'custom', chain: [{ provider: 'elevenlabs', model: null }], thenGlobal: false },
    });
    const { chain } = selectChain({ task: 'podcastVoice', selection: doc, catalog: null, availability: everyone });
    expect(chain[0]).toMatchObject({ provider: 'elevenlabs', model: null, modalityModel: 'eleven_v3' });
  });

  it('a media provider never serves a chat task', () => {
    const doc = v2({
      forgeDrafting: { mode: 'custom', chain: [{ provider: 'replicate', model: 'google/imagen-4-fast' }], thenGlobal: false },
    });
    // normalizeSelection already dropped the step; the resolver would reject it anyway.
    expect(doc.tasks.forgeDrafting.chain).toEqual([]);
    const raw = { id: null, label: 't', modality: 'text', needs: ['text'], public: false, recommended: null };
    const { chain, rejected } = selectChain({
      task: raw,
      selection: { version: 2, global: { priority: [{ provider: 'replicate', model: 'google/imagen-4-fast' }] }, tasks: {} },
      catalog: null,
      availability: everyone,
    });
    expect(chain).toEqual([]);
    expect(rejected[0]).toMatchObject({ provider: 'replicate', code: 'capability', missing: ['text'] });
  });

  it('a planned task has no eligible model whatever is keyed, and says so by capability', () => {
    for (const task of PLANNED_TASKS) {
      const { mode, chain, rejected, flags } = selectChain({ task, selection: v2(), catalog: null, availability: everyone });
      expect(mode, task).toBe('global');
      expect(chain, task).toEqual([]);
      expect(flags, task).toEqual([]);
      for (const r of rejected) expect(r, `${task}/${r.provider}`).toMatchObject({ code: 'capability' });
    }
  });
});

describe('the selection document (selection.js)', () => {
  const ok = v2();

  it('refuses a media provider in the Priority list and names where it belongs', () => {
    const errors = validateSelection({ ...ok, global: { priority: [{ provider: 'elevenlabs' }] } });
    expect(errors).toEqual([
      expect.stringMatching(/^global\.priority\[0\]\.provider must be one of gemini, openai, anthropic, nvidia, foundry \(the Priority list is the chat list/),
    ]);
    expect(normalizeSelection({ ...ok, global: { priority: [{ provider: 'elevenlabs' }, { provider: 'gemini' }] } }).global.priority).toEqual([
      { provider: 'gemini', model: null },
    ]);
  });

  it('a chain step must name a provider that can carry the task’s needs', () => {
    const speech = { ...ok, tasks: { podcastVoice: { mode: 'custom', chain: [{ provider: 'elevenlabs', model: 'eleven_v3' }] } } };
    expect(validateSelection(speech)).toEqual([]);
    const drafting = { ...ok, tasks: { forgeDrafting: { mode: 'custom', chain: [{ provider: 'elevenlabs' }] } } };
    expect(validateSelection(drafting)).toEqual([
      'tasks.forgeDrafting.chain[0].provider: elevenlabs cannot carry text (Forge drafting needs it)',
    ]);
    const unknown = { ...ok, tasks: { podcastVoice: { mode: 'custom', chain: [{ provider: 'polly' }] } } };
    expect(validateSelection(unknown)).toEqual([
      `tasks.podcastVoice.chain[0].provider must be one of ${KNOWN_PROVIDERS.join(', ')}`,
    ]);
    expect(normalizeSelection(drafting).tasks.forgeDrafting.chain).toEqual([]);
    expect(normalizeSelection(speech).tasks.podcastVoice.chain).toEqual([{ provider: 'elevenlabs', model: 'eleven_v3' }]);
  });

  it('§6’s "would have no model" rule sees the media providers as keyed', () => {
    const doc = { ...ok, tasks: { podcastVoice: { mode: 'custom', chain: [{ provider: 'elevenlabs' }], thenGlobal: false } } };
    expect(validateSelection(doc, { availability: everyone })).toEqual([]);
    expect(validateSelection(doc, { availability: chatOnly })).toEqual([
      expect.stringMatching(/^tasks\.podcastVoice: this task would have no model/),
    ]);
  });
});

describe('the migration of the model fields the settings pages carried (migrate-selection.js)', () => {
  it('a stored model that differs from the recommendation becomes the task’s custom chain, thenGlobal off', () => {
    const migrated = migrateSelection({
      media: { listenAndLearnSpeech: 'gemini-3.1-flash-tts-preview', podcastVoice: 'eleven_v4' },
    });
    expect(migrated.tasks.listenAndLearnSpeech).toEqual({
      mode: 'custom',
      chain: [{ provider: 'gemini', model: 'gemini-3.1-flash-tts-preview' }],
      thenGlobal: false,
    });
    expect(migrated.tasks.podcastVoice).toEqual({
      mode: 'custom',
      chain: [{ provider: 'elevenlabs', model: 'eleven_v4' }],
      thenGlobal: false,
    });
    expect(MEDIA_MIGRATION_TASKS).toEqual(['listenAndLearnSpeech', 'podcastVoice']);
  });

  it('a stored model equal to the recommendation, or none, leaves the task on Recommended', () => {
    const same = migrateSelection({
      media: { listenAndLearnSpeech: 'gemini-3.8-flash-tts', podcastVoice: 'eleven_v3' },
    });
    expect(same.tasks).not.toHaveProperty('listenAndLearnSpeech');
    expect(same.tasks).not.toHaveProperty('podcastVoice');
    expect(migrateSelection({ media: { listenAndLearnSpeech: '  ', podcastVoice: null } }).tasks).toEqual(
      migrateSelection({}).tasks
    );
    expect(migrateSelection({ media: null })).toEqual(migrateSelection({}));
    // The code defaults never touch a media task.
    for (const task of ['listenAndLearnSpeech', 'podcastVoice', 'coverArt', 'manualImages', ...PLANNED_TASKS]) {
      expect(defaultSelection().tasks, task).not.toHaveProperty(task);
    }
  });

  it('applies to a stored v2 document that has no entry for the task, and never to one that has', () => {
    const stored = { id: 'ai-routing', version: 2, global: { priority: [{ provider: 'gemini', model: null }] }, tasks: {} };
    const media = { listenAndLearnSpeech: 'gemini-3.1-flash-tts-preview', podcastVoice: null };
    const applied = applyMediaMigration(normalizeSelection(stored), media);
    expect(applied.tasks.listenAndLearnSpeech).toMatchObject({ mode: 'custom', thenGlobal: false });
    expect(migrateSelection({ routing: stored, media }).tasks.listenAndLearnSpeech).toEqual(applied.tasks.listenAndLearnSpeech);
    expect(selectionFrom({ providers: null, features: null, routing: stored, media }).tasks.listenAndLearnSpeech).toEqual(
      applied.tasks.listenAndLearnSpeech
    );

    const chosen = { ...stored, tasks: { listenAndLearnSpeech: { mode: 'recommended' } } };
    expect(applyMediaMigration(normalizeSelection(chosen), media).tasks.listenAndLearnSpeech).toEqual({ mode: 'recommended' });
    // Nothing to apply: the same object back.
    const doc = normalizeSelection(stored);
    expect(applyMediaMigration(doc, null)).toBe(doc);
    expect(applyMediaMigration(doc, { listenAndLearnSpeech: null, podcastVoice: null })).toBe(doc);
  });

  it('the loader reads the stored speech document and the podcast model setting as the migration’s input', async () => {
    const readDoc = vi.fn(async (container, id) => {
      if (container === 'admin_config' && id === 'listen_and_learn_speech') return { geminiModel: 'gemini-3.1-flash-tts-preview' };
      return null;
    });
    const loader = createAiConfigLoader({
      store: { queryDocs: vi.fn(async () => []), readDoc },
      env: { LISTEN_AND_LEARN_ELEVENLABS_MODEL: 'eleven_v4' },
      log: quiet,
    });
    const { selection } = await loader.load();
    expect(readDoc).toHaveBeenCalledWith('admin_config', 'listen_and_learn_speech', 'admin_config');
    expect(selection.tasks.listenAndLearnSpeech).toEqual({
      mode: 'custom',
      chain: [{ provider: 'gemini', model: 'gemini-3.1-flash-tts-preview' }],
      thenGlobal: false,
    });
    expect(selection.tasks.podcastVoice).toEqual({
      mode: 'custom',
      chain: [{ provider: 'elevenlabs', model: 'eleven_v4' }],
      thenGlobal: false,
    });

    // A document that cannot be read is "none stored", and the other reads still land.
    const failing = createAiConfigLoader({
      store: {
        queryDocs: vi.fn(async () => []),
        readDoc: vi.fn(async (container) => {
          if (container === 'admin_config') throw new Error('boom');
          return null;
        }),
      },
      env: { LISTEN_AND_LEARN_ELEVENLABS_MODEL: '@Microsoft.KeyVault(x)' },
      log: quiet,
    });
    const fallback = await failing.load();
    expect(fallback.selection.tasks).not.toHaveProperty('listenAndLearnSpeech');
    expect(fallback.selection.tasks).not.toHaveProperty('podcastVoice');
  });
});

describe('the media providers in the catalogue (model-catalog.js)', () => {
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  const env = { ELEVENLABS_API_KEY: 'xi-key', REPLICATE_API_KEY: 'r8_key' };

  it('ElevenLabs lists GET /v1/models with the xi-api-key header, ids from model_id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        { model_id: 'eleven_v3', name: 'Eleven v3' },
        { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2' },
        { name: 'no id' },
        { model_id: ' eleven_v3 ' },
      ])
    );
    const ctx = createListContext({ env, fetchImpl, foundryToken: async () => 'tok' });
    expect(await listModels(ctx, 'elevenlabs')).toEqual(['eleven_v3', 'eleven_multilingual_v2']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/models',
      expect.objectContaining({ headers: { 'xi-api-key': 'xi-key' } })
    );
    // Not an array: a malformed list, never an empty one.
    const object = createListContext({ env, fetchImpl: vi.fn(async () => jsonResponse(200, { models: [] })) });
    await expect(listModels(object, 'elevenlabs')).rejects.toThrow(/Malformed list/);
  });

  it('Replicate’s list is the static set of image models this repository calls; a provider with no key is skipped', async () => {
    const fetchImpl = vi.fn();
    expect(await listModels(createListContext({ env, fetchImpl }), 'replicate')).toEqual(['google/imagen-4-fast']);
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const provider of MEDIA_PROVIDERS) {
      expect(await listModels(createListContext({ env: {}, fetchImpl }), provider), provider).toBeNull();
    }
    expect(MEDIA_KEY_ENV).toEqual({ elevenlabs: 'ELEVENLABS_API_KEY', replicate: 'REPLICATE_API_KEY' });
  });

  it('the read document carries the media providers, seeded with their defaults before the first list', async () => {
    const catalog = await readModelCatalog({ store: { readDoc: async () => null } });
    expect(Object.keys(catalog.providers)).toEqual([...KNOWN_PROVIDERS]);
    expect(Object.keys(catalog.providers.elevenlabs.models)).toEqual(['eleven_v3']);
    expect(Object.keys(catalog.providers.replicate.models)).toEqual(['google/imagen-4-fast']);
    expect(catalog.providers.elevenlabs.models.eleven_v3).toMatchObject({
      status: 'unknown',
      capabilities: ['tts'],
      modality: 'tts',
      pricing: { inputPer1M: 0, outputPer1M: 100, unit: '1M characters' },
      unpriced: false,
    });
    expect(catalog.providers.replicate.models['google/imagen-4-fast']).toMatchObject({
      capabilities: ['image'],
      modality: 'image',
      pricing: { perUnitUsd: 0.02, unit: 'image' },
      unpriced: false,
    });
    // A chat row keeps its shape: no unit field to learn.
    expect(pricingFor('foundry', 'gpt-5-nano')).toEqual({ inputPer1M: 0.05, outputPer1M: 0.4 });
    expect(pricingFor('replicate', 'google/imagen-4')).toBeNull();
  });

  it('a select offers the models that carry the task’s needs: tts for a speech task, text for a chat pin', async () => {
    const seeded = await readModelCatalog({ store: { readDoc: async () => null } });
    const catalog = {
      providers: {
        ...seeded.providers,
        gemini: {
          ...seeded.providers.gemini,
          models: Object.fromEntries(
            ['gemini-3.5-flash-lite', 'gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview'].map((id) => [
              id,
              { id, status: 'live', hidden: false, ...enrichModel('gemini', id) },
            ])
          ),
        },
      },
    };
    expect(selectableModelsFor(catalog, 'gemini', ['tts'])).toEqual([
      'gemini-2.5-flash-preview-tts',
      'gemini-3.1-flash-tts-preview',
    ]);
    expect(selectableModelsFor(catalog, 'gemini', ['text'])).toEqual(['gemini-3.5-flash-lite']);
    expect(visibleModelsFor(catalog, 'gemini')).toEqual(['gemini-3.5-flash-lite']);
    expect(selectableModelsFor(catalog, 'elevenlabs', ['tts'])).toEqual(['eleven_v3']);
    expect(selectableModelsFor(catalog, 'elevenlabs', ['text'])).toEqual([]);
    expect(selectableModelsFor(catalog, 'replicate', ['image'])).toEqual(['google/imagen-4-fast']);
  });
});

describe('the router’s one door for the media call sites (router.js modelForTask)', () => {
  const storeOf = ({ selection = null, features = null } = {}) => ({
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async (_c, id) => (id === 'ai-routing' ? selection : id === 'ai-features' ? features : null)),
  });
  const router = (env, store = storeOf()) =>
    createAiRouter({ env, fetch: vi.fn(), sleep: noSleep, log: quiet, store });
  const keys = { GEMINI_API_KEY: 'g', ELEVENLABS_API_KEY: 'e', REPLICATE_API_KEY: 'r' };

  it('answers the task’s first candidate: the recommendation by default, named as such', async () => {
    const r = router(keys);
    expect(r.availableMediaProviders()).toEqual(['elevenlabs', 'replicate']);
    expect(r.availableProviders()).toEqual(['gemini']);
    expect(await r.modelForTask({ task: 'podcastVoice' })).toMatchObject({
      task: 'podcastVoice',
      provider: 'elevenlabs',
      model: 'eleven_v3',
      selection: 'recommended',
      why: expect.stringMatching(/^recommended for this task/),
      flags: [],
    });
    expect(await r.modelForTask({ task: 'coverArt' })).toMatchObject({ provider: 'replicate', model: 'google/imagen-4-fast' });
    expect(await r.modelForTask({ task: 'listenAndLearnSpeech' })).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash-tts',
    });
  });

  it('a custom step naming the provider alone answers the modality model; a stored choice answers itself', async () => {
    const selection = {
      id: 'ai-routing',
      version: 2,
      global: { priority: [{ provider: 'gemini', model: null }] },
      tasks: {
        podcastVoice: { mode: 'custom', chain: [{ provider: 'elevenlabs', model: null }], thenGlobal: false },
        listenAndLearnSpeech: {
          mode: 'custom',
          chain: [{ provider: 'gemini', model: 'gemini-3.1-flash-tts-preview' }],
          thenGlobal: false,
        },
      },
    };
    const r = router(keys, storeOf({ selection }));
    expect(await r.modelForTask({ task: 'podcastVoice' })).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v3', selection: 'custom' });
    expect(await r.modelForTask({ task: 'listenAndLearnSpeech' })).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.1-flash-tts-preview',
      selection: 'custom',
    });
  });

  it('a task with no keyed provider that carries its need says so, and a switched-off task is refused', async () => {
    await expect(router({ GEMINI_API_KEY: 'g' }).modelForTask({ task: 'coverArt' })).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
      message: expect.stringMatching(
        /^'coverArt' is served by replicate only, and it holds a usable key or model. Seed REPLICATE_API_KEY in Key Vault/
      ),
    });
    await expect(router({ GEMINI_API_KEY: 'g' }).modelForTask({ task: 'podcastVoice' })).rejects.toMatchObject({
      message: expect.stringMatching(/Seed ELEVENLABS_API_KEY/),
    });
    await expect(router(keys).modelForTask({ task: 'embeddings' })).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
      message: expect.stringMatching(/^No eligible model carries 'embedding' for 'embeddings'/),
    });
    await expect(router(keys).modelForTask({ task: 'nope' })).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    const off = router(keys, storeOf({ features: { id: 'ai-features', features: { podcastVoice: false } } }));
    await expect(off.modelForTask({ task: 'podcastVoice' })).rejects.toMatchObject({ code: 'AI_FEATURE_DISABLED' });
  });

  it('the effective read lists the media providers as keyed-is-enabled, with what each provider carries', async () => {
    const effective = await router(keys).resolveEffectiveSelection();
    expect(effective.availability).toMatchObject({
      keyed: ['gemini', 'elevenlabs', 'replicate'],
      enabled: ['gemini', 'elevenlabs', 'replicate'],
      media: ['elevenlabs', 'replicate'],
    });
    expect(effective.availability.capabilities.elevenlabs).toEqual(['tts']);
    expect(effective.tasks.podcastVoice).toMatchObject({
      media: true,
      planned: false,
      entry: { mode: 'recommended' },
      mode: 'recommended',
    });
    expect(effective.tasks.embeddings).toMatchObject({ media: true, planned: true, recommended: null, chain: [] });
    expect(effective.tasks.forgeDrafting).toMatchObject({ media: false, planned: false, only: null });
    expect(effective.tasks.podcastVoice.only).toEqual(['elevenlabs']);
  });
});

describe('the per-task Test spends nothing on a media task (ai-tasks.js)', () => {
  const allowGuard = { requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, role: 'editor', error: null })) };
  const request = (task) => ({ query: { get: () => null }, params: { task }, json: async () => ({}) });
  const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

  it('reports the candidate it would use, with the reason, and never calls the provider', async () => {
    const callProvider = vi.fn();
    const router = createAiRouter({
      env: { GEMINI_API_KEY: 'g', ELEVENLABS_API_KEY: 'e' },
      fetch: vi.fn(),
      sleep: noSleep,
      log: quiet,
      store: { queryDocs: vi.fn(async () => []), readDoc: vi.fn(async () => null) },
    });
    const handlers = createAdminIntegrationHandlers({
      guard: allowGuard,
      store: { queryDocs: vi.fn(async () => []), readDoc: vi.fn(async () => null), upsertDoc: vi.fn(), patchDoc: vi.fn(), deleteDoc: vi.fn() },
      effectiveSelection: router.resolveEffectiveSelection,
      ai: { callProvider, getCostEstimate: () => 0 },
    });
    const spoken = JSON.parse((await handlers.testAiTask(request('podcastVoice'), context)).body);
    expect(spoken).toMatchObject({
      ok: true,
      task: 'podcastVoice',
      mode: 'recommended',
      dryRun: true,
      wouldUse: { provider: 'elevenlabs', model: 'eleven_v3', why: expect.stringMatching(/^recommended/) },
      answeredBy: null,
      skipped: [],
    });
    expect(callProvider).not.toHaveBeenCalled();

    const nothing = JSON.parse((await handlers.testAiTask(request('coverArt'), context)).body);
    expect(nothing).toMatchObject({ ok: false, dryRun: true, wouldUse: null, error: 'No candidate of the chain is eligible' });
    expect(nothing.rejected.find((r) => r.provider === 'replicate')).toMatchObject({ code: 'no-key' });
    expect(callProvider).not.toHaveBeenCalled();
  });
});

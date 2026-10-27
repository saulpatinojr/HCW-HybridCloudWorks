/**
 * The AI task registry (ADR 0034 slice 1, #856): every feature is a task,
 * every task says what kind of answer it needs, and every recommendation
 * names a priced model with a reason and a date. Slice 5 (#860) adds the
 * audio and image tasks, which recommend a media provider, and the planned
 * ones, which recommend nothing because nobody can serve them yet.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_TASKS,
  CAPABILITIES,
  MEDIA_MODALITIES,
  MODALITIES,
  PLANNED_TASKS,
  PUBLIC_TASKS,
  TASK_NAMES,
  defaultModeFor,
  isMediaTask,
  taskFor,
} from './tasks.js';
import { AI_FEATURES, FEATURE_NAMES, PROVIDER_PLACEMENT_DEFAULTS } from './features-catalogue.js';
import { PROVIDERS, isPriced } from './router.js';
import { KNOWN_PROVIDERS, MEDIA_PROVIDERS, PROVIDER_CAPABILITIES, providerCarries } from './provider-order.js';
import { RECOMMENDED_BY_MODALITY, recommendedModelFor } from './provider-recommendations.js';
import { pricingFor } from './model-catalog-doc.js';

describe('the registry and the feature catalogue are one list', () => {
  it('has exactly the feature names, in the same order, less the planned tasks', () => {
    expect(TASK_NAMES.filter((id) => !PLANNED_TASKS.includes(id))).toEqual(FEATURE_NAMES);
  });

  it('a feature is its task\'s label, description and route, and nothing else', () => {
    for (const id of FEATURE_NAMES) {
      expect(AI_FEATURES[id]).toEqual({
        label: AI_TASKS[id].label,
        description: AI_TASKS[id].description,
        route: AI_TASKS[id].route,
      });
    }
  });

  it('a planned task has no feature switch: a toggle for nothing would read as a working one', () => {
    expect(PLANNED_TASKS).toEqual(['recordingTranscript', 'pageOcr', 'embeddings']);
    for (const id of PLANNED_TASKS) expect(AI_FEATURES[id], id).toBeUndefined();
  });

  it('taskFor reads own properties only', () => {
    expect(taskFor('inspector')).toBe(AI_TASKS.inspector);
    expect(taskFor('constructor')).toBeUndefined();
    expect(taskFor('nope')).toBeUndefined();
  });
});

describe('every task says what it needs', () => {
  it('has a known modality and needs drawn from the capability vocabulary', () => {
    for (const [id, task] of Object.entries(AI_TASKS)) {
      expect(MODALITIES, id).toContain(task.modality);
      expect(task.needs.length, id).toBeGreaterThan(0);
      for (const need of task.needs) expect(CAPABILITIES, `${id} needs ${need}`).toContain(need);
      expect(typeof task.public, id).toBe('boolean');
    }
  });

  it('the public tasks are the two anonymous explain routes, where the trial tier is locked off', () => {
    expect(PUBLIC_TASKS).toEqual(['pricingExplain', 'landingZoneExplain']);
    for (const id of PUBLIC_TASKS) {
      expect(PROVIDER_PLACEMENT_DEFAULTS.nvidia[id], id).toBe('off');
    }
  });

  it('grounding is a need only the grounded task has, and only Gemini can meet', () => {
    const grounded = TASK_NAMES.filter((id) => AI_TASKS[id].needs.includes('grounding'));
    expect(grounded).toEqual(['sourceGrounding']);
    expect(AI_TASKS.sourceGrounding.recommended.provider).toBe('gemini');
    expect(Object.keys(RECOMMENDED_BY_MODALITY).filter((p) => RECOMMENDED_BY_MODALITY[p].grounding)).toEqual([
      'gemini',
    ]);
  });

  it('the media tasks need their modality and nothing else, and default to Recommended (slice 5)', () => {
    const media = TASK_NAMES.filter((id) => isMediaTask(AI_TASKS[id]));
    expect(media).toEqual([
      'listenAndLearnSpeech',
      'podcastVoice',
      'coverArt',
      'manualImages',
      'recordingTranscript',
      'pageOcr',
      'embeddings',
    ]);
    for (const id of media) {
      expect(MEDIA_MODALITIES, id).toContain(AI_TASKS[id].modality);
      expect(AI_TASKS[id].needs, id).toEqual([AI_TASKS[id].modality]);
      expect(AI_TASKS[id].public, id).toBe(false);
    }
    for (const id of ['listenAndLearnSpeech', 'podcastVoice', 'coverArt', 'manualImages']) {
      expect(defaultModeFor(AI_TASKS[id]), id).toBe('recommended');
    }
    for (const id of PLANNED_TASKS) expect(defaultModeFor(AI_TASKS[id]), id).toBe('global');
    expect(defaultModeFor(AI_TASKS.forgeDrafting)).toBe('global');
    expect(defaultModeFor(undefined)).toBe('global');
  });

  it('a planned task is one no provider can carry; every other need has a provider', () => {
    for (const id of PLANNED_TASKS) {
      const carriers = KNOWN_PROVIDERS.filter((p) => providerCarries(p, AI_TASKS[id].needs));
      expect(carriers, `${id} is planned but ${carriers.join(', ')} carries it`).toEqual([]);
    }
    for (const id of FEATURE_NAMES) {
      const carriers = KNOWN_PROVIDERS.filter((p) => providerCarries(p, AI_TASKS[id].needs));
      expect(carriers.length, `${id}: no provider carries ${AI_TASKS[id].needs.join(', ')}`).toBeGreaterThan(0);
    }
    for (const [provider, carried] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(KNOWN_PROVIDERS, provider).toContain(provider);
      for (const capability of carried) expect(CAPABILITIES, `${provider} carries ${capability}`).toContain(capability);
    }
    expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([...KNOWN_PROVIDERS].sort());
    // The media providers carry their one modality; the chat providers never carry a media one.
    expect(PROVIDER_CAPABILITIES.elevenlabs).toEqual(['tts']);
    expect(PROVIDER_CAPABILITIES.replicate).toEqual(['image']);
    for (const provider of PROVIDERS) {
      expect(providerCarries(provider, ['image']), provider).toBe(false);
      expect(providerCarries(provider, ['text']), provider).toBe(true);
    }
    expect(providerCarries('gemini', ['tts'])).toBe(true);
    expect(providerCarries('bedrock', ['text'])).toBe(false);
  });
});

describe('recommendations are claims with a date, naming a priced model', () => {
  it('every task but the planned ones recommends a provider the resolver knows and a model the catalogue prices', () => {
    for (const [id, task] of Object.entries(AI_TASKS)) {
      if (task.planned) {
        expect(task.recommended, `${id} is planned and must recommend nothing`).toBeNull();
        continue;
      }
      const { provider, model, reason, asOf } = task.recommended;
      expect(KNOWN_PROVIDERS, id).toContain(provider);
      expect(providerCarries(provider, task.needs), `${id}: ${provider} cannot carry ${task.needs}`).toBe(true);
      expect(pricingFor(provider, model), `${id}: ${provider}/${model} is unpriced`).not.toBeNull();
      expect(isPriced(provider, model), `${id}: ${provider}/${model} is unpriced`).toBe(true);
      expect(reason.length, id).toBeGreaterThan(20);
      expect(asOf, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('the media tasks recommend the model that was their default before slice 5, so nothing changes on merge', () => {
    expect(AI_TASKS.listenAndLearnSpeech.recommended).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash-tts',
    });
    expect(AI_TASKS.podcastVoice.recommended).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v3' });
    expect(AI_TASKS.coverArt.recommended).toMatchObject({ provider: 'replicate', model: 'google/imagen-4-fast' });
    expect(AI_TASKS.manualImages.recommended).toMatchObject({ provider: 'replicate', model: 'google/imagen-4-fast' });
  });

  it('no public task recommends a trial-tier provider', () => {
    for (const id of PUBLIC_TASKS) expect(AI_TASKS[id].recommended.provider, id).not.toBe('nvidia');
  });

  it('every chat provider recommends a priced text model, and a vision model only where it reads images', () => {
    for (const provider of PROVIDERS) {
      const table = RECOMMENDED_BY_MODALITY[provider];
      expect(table, provider).toBeDefined();
      expect(table.text, `${provider} has no text recommendation`).toBeDefined();
      for (const [modality, entry] of Object.entries(table)) {
        expect([...MODALITIES, 'grounding'], `${provider}/${modality}`).toContain(modality);
        expect(isPriced(provider, entry.model), `${provider}/${modality}: ${entry.model}`).toBe(true);
        expect(pricingFor(provider, entry.model), `${provider}/${modality}: ${entry.model} row`).not.toBeNull();
        expect(entry.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    expect(recommendedModelFor('nvidia', 'vision')).toBeUndefined();
    expect(recommendedModelFor('foundry', 'json').model).toBe('gpt-5-mini');
  });

  it('a media provider recommends a priced model for its one modality and nothing for text (slice 5)', () => {
    for (const provider of MEDIA_PROVIDERS) {
      const table = RECOMMENDED_BY_MODALITY[provider];
      expect(Object.keys(table), provider).toEqual([...PROVIDER_CAPABILITIES[provider]]);
      for (const [modality, entry] of Object.entries(table)) {
        expect(pricingFor(provider, entry.model), `${provider}/${modality}`).not.toBeNull();
        expect(entry.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(recommendedModelFor(provider, 'text')).toBeUndefined();
    }
    expect(recommendedModelFor('gemini', 'tts').model).toBe('gemini-3.8-flash-tts');
    expect(recommendedModelFor('elevenlabs', 'tts').model).toBe('eleven_v3');
    expect(recommendedModelFor('replicate', 'image').model).toBe('google/imagen-4-fast');
  });
});

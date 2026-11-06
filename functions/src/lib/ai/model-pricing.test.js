import { describe, it, expect } from 'vitest';
import { getCostEstimate } from './router.js';
import { pricingFor } from './model-catalog-doc.js';
import { AUDIO_INPUT_RATES, audioInputRateFor, modelRatesFor } from './model-tables.js';
import { tokenUsage } from '../listen-and-learn/speech/gemini.js';
import { migrateSelection } from './migrate-selection.js';

const CASES = [
  ['gemini-3.8-flash-tts', '2027-01-01T00:00:00Z', [0.5, 9], [1, 18]],
  ['gemini-3.8-flash-lite-tts', '2027-01-01T00:00:00Z', [0.5, 6], [1, 12]],
  ['gemini-3.8-flash', '2027-01-01T00:00:00Z', [0.75, 3.75], [1.5, 7.5]],
  ['gemini-4-argon', '2026-12-01T00:00:00Z', [2, 10], [4, 20]],
];

describe('published introductory prices expire', () => {
  for (const [model, cutoff, introductory, regular] of CASES) {
    it(`${model}: catalogue and usage use the same rates on either side of ${cutoff}`, () => {
      for (const [at, rates] of [[Date.parse(cutoff) - 1, introductory], [Date.parse(cutoff), regular]]) {
        expect(modelRatesFor('gemini', model, at)).toEqual(rates);
        expect(pricingFor('gemini', model, at)).toEqual({ inputPer1M: rates[0], outputPer1M: rates[1] });
        expect(getCostEstimate('gemini', model, 1_000_000, 1_000_000, at)).toBe(rates[0] + rates[1]);
      }
    });
  }
});

it('uses the published 25 output audio tokens per second, still marked estimated', () => {
  expect(tokenUsage(null, 10)).toEqual({ promptTokens: 0, completionTokens: 250, estimatedTokens: true });
});

it('preserves a saved legacy speech choice as a custom route after the recommendation changes', () => {
  expect(migrateSelection({ media: { listenAndLearnSpeech: 'gemini-2.5-flash-preview-tts' } }).tasks.listenAndLearnSpeech).toMatchObject({
    mode: 'custom', thenGlobal: false, chain: [{ provider: 'gemini', model: 'gemini-2.5-flash-preview-tts' }],
  });
});

describe('audio input rates (ADR 0040, read from the pricing page 2026-11-05)', () => {
  it('3.6 Flash audio follows the same introductory window as the page states, and the others are flat', () => {
    const cutoff = Date.parse('2027-01-01T00:00:00Z');
    expect(audioInputRateFor('gemini', 'gemini-3.6-flash', cutoff - 1)).toBe(0.75);
    expect(audioInputRateFor('gemini', 'gemini-3.6-flash', cutoff)).toBe(1.5);
    expect(audioInputRateFor('gemini', 'gemini-3.5-flash-lite')).toBe(0.3);
    expect(audioInputRateFor('gemini', 'gemini-2.5-flash')).toBe(1.0);
  });

  it('a model with no audio row is unpriced for audio rather than priced at the text rate', () => {
    expect(audioInputRateFor('gemini', 'gemini-3.8-flash-tts')).toBeNull();
    expect(audioInputRateFor('openai', 'gpt-5-mini')).toBeNull();
    expect(audioInputRateFor('gemini', 'constructor')).toBeNull();
  });

  it('every audio-priced model is also priced for text, so its output tokens can be costed', () => {
    for (const [provider, rows] of Object.entries(AUDIO_INPUT_RATES)) {
      for (const model of Object.keys(rows)) expect(modelRatesFor(provider, model), `${provider}/${model}`).not.toBeNull();
    }
  });
});

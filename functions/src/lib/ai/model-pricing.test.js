import { describe, it, expect } from 'vitest';
import { getCostEstimate } from './router.js';
import { pricingFor } from './model-catalog-doc.js';
import { modelRatesFor } from './model-tables.js';
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

/**
 * The Gemini TTS models Listen & Learn offers: two ids, priced, Economy the
 * module default. The choice itself is the listenAndLearnSpeech task's
 * since ADR 0034 slice 5 (#860): the per-run, per-book and stored fields
 * this file used to parse are gone (speech-settings.voice.test.js holds the
 * book half; listen-and-learn-jobs.test.js the run half).
 */
import { describe, it, expect } from 'vitest';
import {
  LISTEN_AND_LEARN_DEFAULT_MODEL,
  LISTEN_AND_LEARN_GEMINI_MODELS,
  LISTEN_AND_LEARN_GEMINI_MODEL_IDS,
  LISTEN_AND_LEARN_SPEECH_CONFIG_ID,
} from './speech-settings.js';
import * as speechSettings from './speech-settings.js';
import { GEMINI_DEFAULT_MODEL } from './speech/gemini.js';
import { COST_TABLE } from '../ai/router.js';
import { AI_TASKS } from '../ai/tasks.js';
import { LISTEN_AND_LEARN_SPEECH_DOC_ID } from '../ai/containers.js';

const BEST = 'gemini-3.1-flash-tts-preview';
const ECONOMY = 'gemini-2.5-flash-preview-tts';

describe('the two choices', () => {
  it('are Best (3.1) and Economy (2.5, the module default — ADR 0033 §4), in that order, with the owner’s labels', () => {
    expect(LISTEN_AND_LEARN_GEMINI_MODELS).toEqual([
      { id: BEST, tier: 'best', label: 'Best — newest voice, about twice the cost' },
      { id: ECONOMY, tier: 'economy', label: 'Economy — cheaper' },
    ]);
    expect(LISTEN_AND_LEARN_GEMINI_MODEL_IDS).toEqual([BEST, ECONOMY]);
    // The cheapest sensible voice reads when the task names no model.
    expect(GEMINI_DEFAULT_MODEL).toBe(ECONOMY);
    expect(LISTEN_AND_LEARN_DEFAULT_MODEL).toBe(ECONOMY);
    expect(Object.isFrozen(LISTEN_AND_LEARN_GEMINI_MODELS)).toBe(true);
  });

  it('are both priced in the cost table, Economy at half', () => {
    // "About twice the cost" on the Best label is a claim about COST_TABLE.
    const [, bestOut] = COST_TABLE.gemini[BEST];
    const [, economyOut] = COST_TABLE.gemini[ECONOMY];
    expect(bestOut).toBe(economyOut * 2);
  });

  it('recommends the reviewed multi-speaker model while retaining the legacy adapter default', () => {
    expect(AI_TASKS.listenAndLearnSpeech.recommended).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash-tts',
    });
  });
});

describe('the model fields left this module (ADR 0034 slice 5, #860)', () => {
  it('parses, lists and reads no model any more; the Tasks tab owns the choice', () => {
    for (const name of [
      'parseTtsModel',
      'listenAndLearnModelOptions',
      'readStoredListenAndLearnModel',
      'resolveListenAndLearnModel',
      'isListenAndLearnGeminiModel',
      'MODEL_CHOICE_RULE',
    ]) {
      expect(speechSettings[name], name).toBeUndefined();
    }
  });

  it('still names the stored document, which the config loader reads once as the migration’s input', () => {
    expect(LISTEN_AND_LEARN_SPEECH_CONFIG_ID).toBe('listen_and_learn_speech');
    expect(LISTEN_AND_LEARN_SPEECH_DOC_ID).toBe(LISTEN_AND_LEARN_SPEECH_CONFIG_ID);
  });
});

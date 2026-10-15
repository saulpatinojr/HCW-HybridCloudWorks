import { describe, it, expect, vi } from 'vitest';
import {
  FORMAT_LIBRARY,
  VERTICAL_VOICE,
  voiceForProvider,
  pickFormat,
  pickNextFormat,
  buildVoiceAndFormatBlock,
  buildStyleRulesClause,
} from './voice.js';
import { createCritic } from './critique.js';
import { KNOWN_MODULE_TYPES } from '../cms/content-modules.js';

describe('voice and format', () => {
  it('picks the voice by provider, case-insensitively, defaulting to multi', () => {
    expect(voiceForProvider('AWS')).toBe(VERTICAL_VOICE.aws);
    expect(voiceForProvider(' finops ')).toBe(VERTICAL_VOICE.finops);
    expect(voiceForProvider(undefined)).toBe(VERTICAL_VOICE.multi);
  });

  it('rotates deterministically to the first format not in recent history', () => {
    expect(pickFormat([]).key).toBe('how_to');
    expect(pickFormat(['how_to', 'comparison']).key).toBe('checklist');
    expect(pickFormat(FORMAT_LIBRARY.map((f) => f.key)).key).toBe('how_to');
  });

  it('every module type a format asks for exists in the module grammar', () => {
    for (const format of FORMAT_LIBRARY) {
      for (const type of format.modules.use) {
        expect(KNOWN_MODULE_TYPES.has(type), `${format.key} uses unknown type ${type}`).toBe(true);
      }
    }
  });

  it('pickNextFormat reads the recent formats for the provider and fails open', async () => {
    const store = {
      queryDocs: vi.fn(async () => [{ format: 'how_to' }, { format: 'comparison' }]),
    };
    expect((await pickNextFormat(store, 'content', 'aws')).key).toBe('checklist');
    expect(store.queryDocs.mock.calls[0][1]).toMatch(
      /WHERE c\.cloudProvider = @provider ORDER BY c\.scrapedAt DESC/
    );
    expect(store.queryDocs.mock.calls[0][2]).toEqual([{ name: '@provider', value: 'aws' }]);
    await pickNextFormat(store, 'content', null);
    expect(store.queryDocs.mock.calls[1][1]).not.toMatch(/WHERE/);
    const broken = {
      queryDocs: vi.fn(async () => {
        throw new Error('no index');
      }),
    };
    expect((await pickNextFormat(broken, 'content', 'aws')).key).toBe('how_to');
  });

  it('the block carries voice, format, word range, banned phrases, style rules, module syntax and overrides', () => {
    const block = buildVoiceAndFormatBlock('azure', FORMAT_LIBRARY[6], {
      masterPrompt: 'MASTER',
      extraBanned: ['synergy'],
      styleRules: { custom: ['No exclamation marks'] },
    });
    expect(block.startsWith('MASTER\n\n')).toBe(true);
    expect(block).toMatch(/Write as an Azure-focused practitioner/);
    expect(block).toMatch(/"Technical Deep Dive" \(internal key: deep_dive\)/);
    expect(block).toMatch(/1600-2200 words/);
    expect(block).toMatch(/"synergy"/);
    expect(block).toMatch(/No exclamation marks/);
    expect(block).toMatch(/<module type="design" align="all">/);
    // The rich Phase 4 types each get an exact-syntax line with a JSON example.
    for (const type of ['pull_quote', 'stat_board', 'comparison', 'timeline', 'callout']) {
      expect(block).toContain(`<module type="${type}"`);
    }
    expect(block).toMatch(/stat_board, comparison, and timeline always render full width/);
    expect(buildStyleRulesClause({ noEmDash: false, noHyphenTells: false })).toBe('');
  });
});

describe('critiqueDraft', () => {
  const ai = (judged) => ({
    generateJsonResponse: vi.fn(async () => judged),
    defaultModelFor: () => 'm',
    getActiveAiProvider: () => 'anthropic',
  });

  it('passes a specific draft, revises on the model verdict, and always revises on a banned phrase', async () => {
    expect(
      (
        await createCritic({
          ai: ai({ verdict: 'pass', genericityScore: 1, specificityScore: 9, issues: [] }),
        }).critiqueDraft({ title: 'T', postContent: 'm6i.2xlarge' })
      ).verdict
    ).toBe('pass');
    expect(
      (
        await createCritic({
          ai: ai({
            verdict: 'revise',
            genericityScore: 8,
            specificityScore: 2,
            issues: ['a', 'b', 'c', 'd', 'e', 'f'],
          }),
        }).critiqueDraft({ title: 'T', postContent: 'x' })
      ).issues
    ).toHaveLength(5);
    const banned = await createCritic({
      ai: ai({ verdict: 'pass', genericityScore: 1, specificityScore: 9, issues: [] }),
    }).critiqueDraft({ title: 'T', postContent: "Let's dive in to this game-changer" });
    expect(banned.verdict).toBe('revise');
    expect(banned.issues[0]).toMatch(/Remove overused AI-sounding phrase/);
    expect(banned.bannedPhraseHits.length).toBeGreaterThanOrEqual(2);
  });

  it('fails open when the model call fails', async () => {
    const failing = {
      generateJsonResponse: vi.fn(async () => {
        throw new Error('429');
      }),
      defaultModelFor: () => 'm',
      getActiveAiProvider: () => 'anthropic',
    };
    const r = await createCritic({ ai: failing }).critiqueDraft({ title: 'T', postContent: 'x' });
    expect(r).toMatchObject({
      verdict: 'pass',
      genericityScore: null,
      error: 'The critique could not run (Error).',
    });
  });
});

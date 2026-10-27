/**
 * The selection document's pure rules on the page (ADR 0034 §4, #859): the
 * Priority list's split and moves, a task entry's draft and stored shapes,
 * the chain editor's changes, and the sentences read from the resolver's
 * answer. Nothing here resolves a chain.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_CHAIN,
  MEDIA_PROVIDER_LABELS,
  addToPriority,
  chainProvidersFor,
  describeEffective,
  describePriorityRow,
  draftEntry,
  firstRejection,
  isDirty,
  movePriority,
  providerLabel,
  retiredInUse,
  setPriorityModel,
  splitPriority,
  storedEntry,
  taskBadges,
  toggleExclude,
  updateChain,
  withTaskEntry,
} from './selectionModel';

const PROVIDERS = [
  { id: 'gemini', name: 'Gemini' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Claude' },
  { id: 'nvidia', name: 'NVIDIA API' },
  { id: 'foundry', name: 'Foundry' },
];
const AVAIL = { keyed: ['gemini', 'openai', 'nvidia'], enabled: ['gemini', 'nvidia', 'foundry'] };
const DOC = {
  version: 2,
  global: {
    priority: [
      { provider: 'foundry', model: null },
      { provider: 'gemini', model: null },
      { provider: 'openai', model: 'gpt-5-mini' },
      { provider: 'nvidia', model: null },
    ],
  },
  tasks: {
    telegram: { mode: 'custom', chain: [{ provider: 'openai', model: null }], thenGlobal: true },
  },
  updatedAt: 'r1',
};

describe('providerLabel', () => {
  it('is the card’s name, else the id — never a label typed into the page', () => {
    expect(providerLabel('anthropic', PROVIDERS)).toBe('Claude');
    expect(providerLabel('someone', PROVIDERS)).toBe('someone');
    expect(providerLabel('gemini')).toBe('gemini');
  });
});

describe('the Priority list', () => {
  it('splits the rows a call may reach from the ones it cannot, with the reason', () => {
    const { listed, unlisted } = splitPriority(DOC, AVAIL, PROVIDERS);
    expect(listed.map((s) => s.provider)).toEqual(['gemini', 'nvidia']);
    expect(unlisted).toEqual([
      { provider: 'foundry', reason: 'no key', add: false },
      { provider: 'openai', reason: 'switched off', add: false },
      { provider: 'anthropic', reason: 'no key', add: false },
    ]);
  });

  it('offers to add a reachable provider the document does not name', () => {
    const doc = { ...DOC, global: { priority: [{ provider: 'gemini', model: null }] } };
    const { unlisted } = splitPriority(doc, AVAIL, PROVIDERS);
    expect(unlisted.find((u) => u.provider === 'nvidia')).toEqual({
      provider: 'nvidia',
      reason: 'not in the list',
      add: true,
    });
    expect(addToPriority(doc, 'nvidia').global.priority).toEqual([
      { provider: 'gemini', model: null },
      { provider: 'nvidia', model: null },
    ]);
    expect(addToPriority(doc, 'gemini').global.priority).toHaveLength(1);
  });

  it('moves among the listed rows only, keeping the unlisted ones after them', () => {
    const moved = movePriority(DOC, AVAIL, 'nvidia', -1);
    expect(moved.global.priority.map((s) => s.provider)).toEqual([
      'nvidia',
      'gemini',
      'foundry',
      'openai',
    ]);
    expect(movePriority(DOC, AVAIL, 'gemini', -1).global.priority).toEqual(DOC.global.priority);
    expect(movePriority(DOC, AVAIL, 'nvidia', 1).global.priority).toEqual(DOC.global.priority);
    expect(movePriority(DOC, AVAIL, 'foundry', 1).global.priority).toEqual(DOC.global.priority);
    expect(moved.tasks).toEqual(DOC.tasks);
    expect(moved.updatedAt).toBe('r1');
  });

  it('sets a row’s model, with the select’s default value reading as null', () => {
    expect(setPriorityModel(DOC, 'gemini', 'gemini-3.6-flash').global.priority[1]).toEqual({
      provider: 'gemini',
      model: 'gemini-3.6-flash',
    });
    expect(setPriorityModel(DOC, 'openai', '__default__').global.priority[2]).toEqual({
      provider: 'openai',
      model: null,
    });
  });

  it('describes what a row will use: its model, or the defaults the API reports', () => {
    expect(describePriorityRow({ model: 'gpt-5-mini' })).toBe(
      'Will use gpt-5-mini for every task.'
    );
    expect(
      describePriorityRow({
        model: null,
        defaults: { draft: 'gpt-5-mini', general: 'gpt-5-nano', multimodal: 'gpt-5-mini' },
        modality: { text: 'gpt-5-nano', vision: 'gpt-5-mini' },
      })
    ).toBe('Will use gpt-5-mini for drafts, gpt-5-nano for short answers; vision: gpt-5-mini.');
    expect(
      describePriorityRow({
        model: null,
        defaults: { draft: 'z-ai/glm-5.3', general: 'z-ai/glm-5.3', multimodal: 'z-ai/glm-5.3' },
        modality: { text: 'z-ai/glm-5.3', vision: null },
      })
    ).toBe('Will use z-ai/glm-5.3; vision: no model — the next row serves.');
  });
});

describe('a task entry', () => {
  it('drafts every field and stores only what the document keeps', () => {
    expect(draftEntry(undefined)).toEqual({
      mode: 'global',
      chain: [],
      thenGlobal: true,
      exclude: [],
    });
    expect(
      draftEntry({ mode: 'custom', chain: [{ provider: 'gemini' }], thenGlobal: false })
    ).toEqual({
      mode: 'custom',
      chain: [{ provider: 'gemini', model: null }],
      thenGlobal: false,
      exclude: [],
    });
    expect(
      storedEntry({ mode: 'global', chain: [{ provider: 'gemini', model: null }], exclude: [] })
    ).toBeNull();
    expect(storedEntry({ mode: 'global', exclude: ['nvidia'] })).toEqual({
      mode: 'global',
      exclude: ['nvidia'],
    });
    expect(
      storedEntry({ mode: 'recommended', chain: [{ provider: 'gemini', model: null }] })
    ).toEqual({
      mode: 'recommended',
    });
    expect(
      storedEntry({
        mode: 'custom',
        chain: [{ provider: 'gemini', model: '__default__' }],
        thenGlobal: false,
      })
    ).toEqual({ mode: 'custom', chain: [{ provider: 'gemini', model: null }], thenGlobal: false });
  });

  it('is dirty when the stored shape would change, not when only the draft’s extras do', () => {
    const entry = { mode: 'global' };
    expect(isDirty(draftEntry(entry), entry)).toBe(false);
    expect(
      isDirty({ ...draftEntry(entry), chain: [{ provider: 'gemini', model: null }] }, entry)
    ).toBe(false);
    expect(isDirty({ ...draftEntry(entry), mode: 'recommended' }, entry)).toBe(true);
    expect(isDirty(toggleExclude(draftEntry(entry), 'nvidia', true), entry)).toBe(true);
  });

  it('is written into the document, or removed when it is plain global', () => {
    const next = withTaskEntry(DOC, 'inspector', { mode: 'recommended' });
    expect(next.tasks.inspector).toEqual({ mode: 'recommended' });
    expect(next.tasks.telegram).toEqual(DOC.tasks.telegram);
    expect(withTaskEntry(next, 'telegram', { mode: 'global' }).tasks).toEqual({
      inspector: { mode: 'recommended' },
    });
  });

  it('excludes a provider once, and removes it again', () => {
    const d = toggleExclude(toggleExclude(draftEntry(null), 'nvidia', true), 'nvidia', true);
    expect(d.exclude).toEqual(['nvidia']);
    expect(toggleExclude(d, 'nvidia', false).exclude).toEqual([]);
  });
});

describe('the chain editor’s changes', () => {
  it('adds a provider once, caps the chain, changes a step, and removes one', () => {
    let chain = updateChain([], { type: 'add', provider: 'gemini' });
    chain = updateChain(chain, { type: 'add', provider: 'gemini' });
    expect(chain).toEqual([{ provider: 'gemini', model: null }]);
    chain = updateChain(chain, { type: 'model', index: 0, model: 'gemini-3.6-flash' });
    expect(chain[0].model).toBe('gemini-3.6-flash');
    // A provider switch drops the model, which belonged to the other provider.
    chain = updateChain(chain, { type: 'provider', index: 0, provider: 'openai' });
    expect(chain).toEqual([{ provider: 'openai', model: null }]);
    chain = updateChain(chain, { type: 'add', provider: 'gemini' });
    // A provider already in the chain cannot be chosen twice.
    expect(updateChain(chain, { type: 'provider', index: 1, provider: 'openai' })).toEqual(chain);
    for (const p of ['anthropic', 'nvidia', 'foundry'])
      chain = updateChain(chain, { type: 'add', provider: p });
    expect(chain).toHaveLength(MAX_CHAIN);
    expect(updateChain(chain, { type: 'remove', index: 0 }).map((s) => s.provider)).toEqual([
      'gemini',
      'anthropic',
      'nvidia',
    ]);
    expect(updateChain(chain, { type: 'nope' })).toBe(chain);
  });
});

describe('what the resolver’s answer says', () => {
  const resolved = {
    label: 'Pricing explanations',
    entry: { mode: 'recommended' },
    mode: 'global',
    chain: [{ provider: 'gemini', model: null, modalityModel: 'gemini-3.5-flash-lite' }],
    rejected: [
      {
        provider: 'foundry',
        model: 'gpt-5-nano',
        code: 'not-live',
        selection: 'recommended',
        why: 'not recommended: gpt-5-nano on foundry is unknown in the catalogue',
      },
      {
        provider: 'nvidia',
        model: null,
        code: 'policy',
        selection: 'global',
        why: 'not eligible: trial tier on a public route',
      },
    ],
    flags: [],
  };

  it('names the effective model via its provider, or the provider default it was judged on', () => {
    expect(describeEffective(resolved, PROVIDERS)).toBe('Provider default via Gemini');
    expect(
      describeEffective({ chain: [{ provider: 'openai', model: 'gpt-5-mini' }] }, PROVIDERS)
    ).toBe('gpt-5-mini via OpenAI');
    expect(describeEffective({ chain: [] })).toBe('No eligible model');
  });

  it('names the first turned-away candidate with its sentence', () => {
    expect(firstRejection(resolved, PROVIDERS)).toBe(
      'Foundry: not recommended: gpt-5-nano on foundry is unknown in the catalogue'
    );
    expect(firstRejection({ rejected: [] })).toBeNull();
  });

  it('badges a recommendation that did not lead, a custom chain that fell through, unpriced, and nothing eligible', () => {
    expect(taskBadges(resolved)).toEqual(['recommendation not live']);
    expect(
      taskBadges({
        entry: { mode: 'custom' },
        mode: 'global',
        chain: [{ provider: 'gemini', model: 'x' }],
      })
    ).toEqual(['custom had nothing eligible']);
    expect(taskBadges({ entry: { mode: 'global' }, mode: 'global', chain: [] })).toEqual([
      'no eligible model',
    ]);
    const catalog = { providers: { openai: { models: { 'o3-mini': { unpriced: true } } } } };
    expect(
      taskBadges(
        {
          entry: { mode: 'global' },
          mode: 'global',
          chain: [{ provider: 'openai', model: 'o3-mini' }],
        },
        catalog
      )
    ).toEqual(['unpriced']);
    expect(
      taskBadges(
        {
          entry: { mode: 'global' },
          mode: 'global',
          chain: [{ provider: 'openai', model: 'gpt-5-mini' }],
        },
        catalog
      )
    ).toEqual([]);
  });

  it('lists retired models still named, with where, from the rejections', () => {
    const effective = {
      tasks: {
        telegram: {
          label: 'Telegram assistant',
          rejected: [{ provider: 'openai', model: 'gpt-4o', code: 'retired', selection: 'custom' }],
        },
        inspector: {
          label: 'Content Inspector',
          rejected: [
            { provider: 'gemini', model: 'gemini-2.5-pro', code: 'retired', selection: 'global' },
            { provider: 'nvidia', model: null, code: 'policy', selection: 'global' },
          ],
        },
        forgeDrafting: {
          label: 'Forge drafting',
          rejected: [
            { provider: 'gemini', model: 'gemini-2.5-pro', code: 'retired', selection: 'global' },
          ],
        },
      },
    };
    expect(retiredInUse(effective)).toEqual([
      { provider: 'openai', model: 'gpt-4o', where: ['Telegram assistant'] },
      { provider: 'gemini', model: 'gemini-2.5-pro', where: ['the Priority list'] },
    ]);
    expect(retiredInUse(null)).toEqual([]);
  });
});

describe('the media providers on the page (ADR 0034 slice 5, #860)', () => {
  const availability = {
    keyed: ['gemini', 'elevenlabs'],
    enabled: ['gemini', 'elevenlabs'],
    media: ['elevenlabs', 'replicate'],
    capabilities: {
      gemini: ['text', 'json', 'vision', 'grounding', 'tts'],
      anthropic: ['text', 'json', 'vision'],
      elevenlabs: ['tts'],
      replicate: ['image'],
    },
  };

  it('names a media provider without a card, never a model id', () => {
    expect(providerLabel('elevenlabs', PROVIDERS)).toBe('ElevenLabs');
    expect(providerLabel('replicate')).toBe('Replicate');
    expect(MEDIA_PROVIDER_LABELS).toEqual({ elevenlabs: 'ElevenLabs', replicate: 'Replicate' });
  });

  it('offers a task only the providers that carry its needs, the media ones included, under its product rule', () => {
    const ids = (resolved) => chainProvidersFor(resolved, PROVIDERS, availability).map((p) => p.id);
    expect(ids({ needs: ['tts'], only: null })).toEqual(['gemini', 'elevenlabs']);
    expect(ids({ needs: ['tts'], only: ['elevenlabs'] })).toEqual(['elevenlabs']);
    expect(ids({ needs: ['tts'], only: ['gemini'] })).toEqual(['gemini']);
    expect(ids({ needs: ['image'], only: ['replicate'] })).toEqual(['replicate']);
    expect(ids({ needs: ['text'] })).toEqual(['gemini', 'anthropic']);
    expect(ids({ needs: ['embedding'] })).toEqual([]);
    // No capabilities on the answer (an older API): every card, as before.
    expect(chainProvidersFor({ needs: ['tts'] }, PROVIDERS, {}).map((p) => p.id)).toEqual(
      PROVIDERS.map((p) => p.id)
    );
    expect(chainProvidersFor({ needs: ['tts'] }, PROVIDERS, availability)[1]).toEqual({
      id: 'elevenlabs',
      name: 'ElevenLabs',
    });
  });
});

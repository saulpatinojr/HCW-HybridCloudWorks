/**
 * The resolver (ADR 0034 §3, #858): precedence, rule 5's filters, the policy
 * locks in both directions, and what a chain says about itself.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRIORITY,
  GROUNDING_PROVIDERS,
  SELECTION_SOURCES,
  TRIAL_TIER_PROVIDERS,
  UNDECLARED_TASK,
  selectChain,
} from './select.js';
import { AI_TASKS, PUBLIC_TASKS, TASK_NAMES } from './tasks.js';
import { DEFAULT_PROVIDER_ORDER, KNOWN_PROVIDERS } from './provider-order.js';
import { RECOMMENDED_BY_MODALITY, recommendedModelFor } from './provider-recommendations.js';
import { seedModelsFor } from './model-catalog.js';
import { enrichmentFor } from './model-enrichment.js';

const ALL = [...DEFAULT_PROVIDER_ORDER];
const everything = { keyed: ALL, enabled: ALL };

/** A catalogue where every router default is `live`, with per-model overrides. */
function catalogue(overrides = {}, providerOverrides = {}) {
  const providers = {};
  for (const provider of ALL) {
    const models = {};
    for (const id of seedModelsFor(provider)) {
      models[id] = {
        id,
        status: 'live',
        hidden: false,
        ...enrichmentFor(id),
        unpriced: false,
        ...(overrides[`${provider}/${id}`] || {}),
      };
    }
    providers[provider] = { stale: false, seeded: false, models, ...(providerOverrides[provider] || {}) };
  }
  return { providers };
}

const steps = (chain) => chain.map((c) => `${c.provider}:${c.model ?? '-'}`);
const providersOf = (chain) => chain.map((c) => c.provider);

describe('Second Brain private provider policy', () => {
  it('uses Foundry alone even when a custom chain and global fallback include every provider', () => {
    const selection = doc(ALL, { brainAssistant: { mode: 'custom', chain: ALL.map((provider) => ({ provider, model: null })), thenGlobal: true } });
    const result = selectChain({ task: 'brainAssistant', selection, catalog: catalogue(), availability: everything });
    expect(providersOf(result.chain)).toEqual(['foundry']);
    const unavailable = selectChain({ task: 'brainAssistant', selection, catalog: catalogue(), availability: { keyed: ALL.filter((p) => p !== 'foundry'), enabled: ALL } });
    expect(unavailable.chain).toEqual([]);
  });
});

const doc = (global, tasks = {}) => ({
  version: 2,
  global: { priority: global.map((p) => (typeof p === 'string' ? { provider: p, model: null } : p)) },
  tasks,
});

describe('the default: no document, every task global', () => {
  it('walks the default order with the provider default as the model, one entry per provider', () => {
    const { mode, chain, rejected, flags } = selectChain({
      task: 'forgeDrafting',
      selection: null,
      catalog: catalogue(),
      availability: everything,
    });
    expect(mode).toBe('global');
    expect(providersOf(chain)).toEqual(ALL);
    expect(chain.every((c) => c.model === null && c.selection === 'global')).toBe(true);
    // A null model is judged on the provider's modality recommendation.
    expect(chain.map((c) => c.modalityModel)).toEqual(
      ALL.map((p) => recommendedModelFor(p, 'text').model)
    );
    expect(chain[0].why).toMatch(/Priority 1/);
    expect(chain[0].why).toMatch(/the provider's default for the call's purpose/);
    expect(rejected).toEqual([]);
    expect(flags).toEqual([]);
  });

  it('DEFAULT_PRIORITY is the default order and a document with an empty list reads as it, flagged', () => {
    expect(DEFAULT_PRIORITY.map((s) => s.provider)).toEqual(DEFAULT_PROVIDER_ORDER);
    const { chain, flags } = selectChain({
      task: 'telegram',
      selection: doc([]),
      catalog: catalogue(),
      availability: everything,
    });
    expect(providersOf(chain)).toEqual(ALL);
    expect(flags).toEqual(['the Priority list is empty; using the default provider order']);
  });

  it('works with no catalogue at all: every model is judged by the code table and allowed with a note', () => {
    const { chain } = selectChain({
      task: 'inspector',
      selection: doc([{ provider: 'gemini', model: 'gemini-9-ultra' }, 'openai']),
      catalog: null,
      availability: everything,
    });
    expect(steps(chain)).toEqual(['gemini:gemini-9-ultra', 'openai:-']);
    expect(chain[0].why).toMatch(/not in the catalogue yet/);
    expect(chain[1].why).toMatch(/not in the catalogue yet/);
  });
});

describe('rule 5 — every candidate, whatever named it', () => {
  it('a provider with no key is never in the chain, from the list or a chain, and says so', () => {
    const availability = { keyed: ['gemini'], enabled: ['gemini'] };
    const fromList = selectChain({
      task: 'telegram',
      selection: doc(['anthropic', 'gemini']),
      catalog: catalogue(),
      availability,
    });
    expect(providersOf(fromList.chain)).toEqual(['gemini']);
    expect(fromList.rejected).toEqual([
      {
        provider: 'anthropic',
        model: null,
        selection: 'global',
        code: 'no-key',
        why: 'not available: anthropic holds no key',
      },
    ]);
    const fromChain = selectChain({
      task: 'telegram',
      selection: doc(['gemini'], {
        telegram: { mode: 'custom', chain: [{ provider: 'openai', model: 'gpt-5-mini' }], thenGlobal: true },
      }),
      catalog: catalogue(),
      availability,
    });
    expect(providersOf(fromChain.chain)).toEqual(['gemini']);
    expect(fromChain.rejected[0]).toMatchObject({ provider: 'openai', selection: 'custom', code: 'no-key' });
  });

  it('a provider switched off on its card is rejected as disabled', () => {
    const { chain, rejected } = selectChain({
      task: 'telegram',
      selection: doc(['openai', 'gemini']),
      catalog: catalogue(),
      availability: { keyed: ALL, enabled: ['gemini'] },
    });
    expect(providersOf(chain)).toEqual(['gemini']);
    expect(rejected).toEqual([
      {
        provider: 'openai',
        model: null,
        selection: 'global',
        code: 'disabled',
        why: 'not available: openai is switched off in the admin portal',
      },
    ]);
  });

  it('a provider turned away for its own sake is judged once; a model-level rejection leaves a later step its chance', () => {
    const { chain, rejected } = selectChain({
      task: 'telegram',
      selection: doc(['foundry', 'gemini'], {
        telegram: {
          mode: 'custom',
          chain: [{ provider: 'foundry', model: null }, { provider: 'gemini', model: 'gemini-3.6-flash' }],
          thenGlobal: true,
        },
      }),
      catalog: catalogue({ 'gemini/gemini-3.6-flash': { status: 'retired' } }),
      availability: { keyed: ['gemini'], enabled: ['gemini'] },
    });
    expect(steps(chain)).toEqual(['gemini:-']);
    expect(rejected.map((r) => [r.provider, r.selection, r.code])).toEqual([
      ['foundry', 'custom', 'no-key'],
      ['gemini', 'custom', 'retired'],
    ]);
  });

  it("a task's exclude list turns a provider away whatever the mode", () => {
    for (const mode of ['global', 'custom', 'recommended']) {
      const tasks = {
        forgeDrafting: {
          mode,
          exclude: ['foundry'],
          ...(mode === 'custom' ? { chain: [{ provider: 'foundry', model: null }], thenGlobal: true } : {}),
        },
      };
      const { chain, rejected } = selectChain({
        task: 'forgeDrafting',
        selection: doc(['foundry', 'gemini'], tasks),
        catalog: catalogue(),
        availability: everything,
      });
      expect(providersOf(chain), mode).toEqual(['gemini']);
      expect(rejected.some((r) => r.provider === 'foundry' && r.code === 'excluded'), mode).toBe(true);
    }
  });

  it('a retired model is turned away; an unknown one and a stale list are allowed with a note', () => {
    const catalog = catalogue(
      {
        'gemini/gemini-3.5-flash-lite': { status: 'retired' },
        'openai/gpt-5-nano': { status: 'unknown' },
      },
      { anthropic: { stale: true } }
    );
    const { chain, rejected } = selectChain({
      task: 'telegram',
      selection: doc(['gemini', 'openai', 'anthropic']),
      catalog,
      availability: everything,
    });
    expect(providersOf(chain)).toEqual(['openai', 'anthropic']);
    expect(rejected[0]).toMatchObject({ provider: 'gemini', code: 'retired' });
    expect(chain[0].why).toMatch(/has not been confirmed by a catalogue refresh yet/);
  });

  it('a model must carry the task\'s needs: a vision task skips a provider whose text model cannot read images', () => {
    const { chain, rejected } = selectChain({
      task: 'altText',
      selection: doc(['nvidia', 'openai', { provider: 'anthropic', model: 'claude-haiku-4-5' }]),
      catalog: catalogue({ 'anthropic/claude-haiku-4-5': { capabilities: ['text', 'json'] } }),
      availability: everything,
    });
    expect(providersOf(chain)).toEqual(['openai']);
    // No vision recommendation for the trial tier at all; a named model that lacks it.
    expect(rejected).toEqual([
      expect.objectContaining({ provider: 'nvidia', code: 'no-model' }),
      expect.objectContaining({
        provider: 'anthropic',
        code: 'capability',
        why: 'not eligible: claude-haiku-4-5 on anthropic does not carry vision',
      }),
    ]);
  });

  it('a named model wins over the modality recommendation and is judged as itself', () => {
    const { chain } = selectChain({
      task: 'inspector',
      selection: doc([{ provider: 'foundry', model: 'gpt-5-nano' }]),
      catalog: catalogue(),
      availability: everything,
    });
    expect(chain[0]).toMatchObject({ provider: 'foundry', model: 'gpt-5-nano', modalityModel: 'gpt-5-nano' });
    expect(chain[0].why).toBe('Priority 1 · model gpt-5-nano');
  });
});

describe('the policy locks, in both directions (ADR 0034 §6)', () => {
  const nvidiaFirst = ['nvidia', 'gemini', 'openai', 'anthropic', 'foundry'];

  it('names the trial tier and the grounding provider', () => {
    expect(TRIAL_TIER_PROVIDERS).toEqual(['nvidia']);
    expect(GROUNDING_PROVIDERS).toEqual(['gemini']);
    expect(PUBLIC_TASKS).toEqual(['pricingExplain', 'landingZoneExplain']);
  });

  it('a public task cannot be given the trial tier by the Priority list', () => {
    for (const task of PUBLIC_TASKS) {
      const { chain, rejected } = selectChain({
        task,
        selection: doc(nvidiaFirst),
        catalog: catalogue(),
        availability: everything,
      });
      expect(providersOf(chain), task).not.toContain('nvidia');
      expect(chain[0].provider, task).toBe('gemini');
      expect(rejected, task).toContainEqual({
        provider: 'nvidia',
        model: null,
        selection: 'global',
        code: 'policy',
        why: 'not eligible: trial tier on a public route',
      });
    }
  });

  it('nor by a custom chain, even one that does not fall through to the list', () => {
    for (const task of PUBLIC_TASKS) {
      const { mode, chain, rejected, flags } = selectChain({
        task,
        selection: doc(['gemini'], {
          [task]: { mode: 'custom', chain: [{ provider: 'nvidia', model: 'z-ai/glm-5.3' }], thenGlobal: false },
        }),
        catalog: catalogue(),
        availability: everything,
      });
      expect(providersOf(chain), task).toEqual(['gemini']);
      expect(mode, task).toBe('global');
      expect(rejected[0], task).toMatchObject({ provider: 'nvidia', selection: 'custom', code: 'policy' });
      expect(flags[0], task).toMatch(/no entry of the custom chain is eligible/);
    }
  });

  it('nor by a recommendation that pointed at it', () => {
    for (const id of PUBLIC_TASKS) {
      const task = { id, ...AI_TASKS[id], recommended: { provider: 'nvidia', model: 'z-ai/glm-5.3', reason: 'free' } };
      const { mode, chain, rejected, flags } = selectChain({
        task,
        selection: doc(['gemini'], { [id]: { mode: 'recommended' } }),
        catalog: catalogue(),
        availability: everything,
      });
      expect(providersOf(chain), id).toEqual(['gemini']);
      expect(mode, id).toBe('global');
      expect(rejected[0], id).toMatchObject({ provider: 'nvidia', selection: 'recommended', code: 'policy' });
      expect(flags[0], id).toMatch(/the recommended model is not eligible/);
    }
  });

  it('nor by a call that names no task, or an unknown one', () => {
    for (const task of [null, undefined, 'notATask']) {
      const { chain, rejected } = selectChain({
        task,
        selection: doc(nvidiaFirst),
        catalog: catalogue(),
        availability: everything,
      });
      expect(providersOf(chain), String(task)).toEqual(['gemini', 'openai', 'anthropic', 'foundry']);
      expect(rejected[0], String(task)).toMatchObject({ provider: 'nvidia', code: 'policy' });
    }
    expect(UNDECLARED_TASK.public).toBe(true);
  });

  it('the other direction: the trial tier does serve every non-public task, placed wherever the list puts it', () => {
    for (const task of TASK_NAMES.filter((id) => !AI_TASKS[id].public)) {
      const { chain, rejected } = selectChain({
        task,
        selection: doc(nvidiaFirst),
        catalog: catalogue(),
        availability: everything,
      });
      const { needs } = AI_TASKS[task];
      if (AI_TASKS[task].only && !AI_TASKS[task].only.includes('nvidia') && !needs.some((n) => !['text', 'json'].includes(n))) {
        expect(providersOf(chain), task).not.toContain('nvidia');
        expect(chain.every((step) => AI_TASKS[task].only.includes(step.provider)), task).toBe(true);
      } else if (needs.includes('grounding')) {
        // The other lock, not the trial-tier one.
        expect(rejected.find((r) => r.provider === 'nvidia')?.why, task).toBe(
          'not eligible: grounding is Gemini-only'
        );
      } else if (needs.some((n) => !['text', 'json'].includes(n))) {
        expect(providersOf(chain), task).not.toContain('nvidia');
        expect(rejected.find((r) => r.provider === 'nvidia')?.code, task).not.toBe('policy');
      } else {
        expect(chain[0].provider, task).toBe('nvidia');
      }
    }
  });

  it('grounding is Gemini-only: every other provider is turned away for the grounded task, and Gemini serves', () => {
    const { chain, rejected } = selectChain({
      task: 'sourceGrounding',
      selection: doc(['foundry', 'openai', 'anthropic', 'nvidia', 'gemini'], {
        sourceGrounding: { mode: 'custom', chain: [{ provider: 'foundry', model: 'gpt-5-mini' }], thenGlobal: true },
      }),
      catalog: catalogue(),
      availability: everything,
    });
    expect(providersOf(chain)).toEqual(['gemini']);
    expect(rejected.map((r) => r.provider)).toEqual(['foundry', 'openai', 'anthropic', 'nvidia']);
    for (const r of rejected) {
      expect(r).toMatchObject({ code: 'policy', why: 'not eligible: grounding is Gemini-only' });
    }
  });

  it('a document cannot enable a provider that holds no key, in any mode', () => {
    const availability = { keyed: ['gemini'], enabled: ['gemini'] };
    const named = (mode) => ({
      mode,
      ...(mode === 'custom' ? { chain: [{ provider: 'foundry', model: 'gpt-5-mini' }], thenGlobal: true } : {}),
    });
    for (const mode of ['global', 'custom', 'recommended']) {
      const { chain, rejected } = selectChain({
        task: 'forgeDrafting',
        selection: doc(['foundry', 'gemini'], { forgeDrafting: named(mode) }),
        catalog: catalogue(),
        availability,
      });
      expect(providersOf(chain), mode).toEqual(['gemini']);
      expect(rejected.every((r) => r.provider === 'foundry' && r.code === 'no-key'), mode).toBe(true);
    }
  });
});

describe('precedence (ADR 0034 §3)', () => {
  it('1. an explicit model from the call site is carried by every candidate, recorded as explicit', () => {
    const { chain } = selectChain({
      task: 'forgeDrafting',
      selection: doc(['foundry', 'gemini'], { forgeDrafting: { mode: 'recommended' } }),
      catalog: catalogue(),
      availability: everything,
      explicitModel: 'gpt-5-nano',
    });
    expect(chain.map((c) => [c.provider, c.model, c.selection])).toEqual([
      ['foundry', 'gpt-5-nano', 'explicit'],
      ['gemini', 'gpt-5-nano', 'explicit'],
    ]);
    expect(chain[0].why).toMatch(/explicit model from the call site/);
  });

  it('1. an explicit model is still held to rule 5: retired is turned away, and settles the provider', () => {
    const { chain, rejected } = selectChain({
      task: 'telegram',
      selection: doc(['gemini', 'openai'], {
        telegram: { mode: 'custom', chain: [{ provider: 'gemini', model: null }], thenGlobal: true },
      }),
      catalog: catalogue({ 'gemini/gemini-3.6-flash': { status: 'retired' } }),
      availability: everything,
      explicitModel: 'gemini-3.6-flash',
    });
    expect(chain.map((c) => [c.provider, c.model, c.selection])).toEqual([['openai', 'gemini-3.6-flash', 'explicit']]);
    expect(rejected).toEqual([
      {
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        selection: 'custom',
        code: 'retired',
        why: 'not eligible: gemini-3.6-flash is retired on gemini',
      },
    ]);
  });

  it('1. an explicit model that does not carry the task\'s needs is turned away', () => {
    const { chain, rejected } = selectChain({
      task: 'altText',
      selection: doc(['anthropic', 'openai']),
      catalog: catalogue({ 'anthropic/claude-haiku-4-5': { capabilities: ['text', 'json'] } }),
      availability: everything,
      explicitModel: 'claude-haiku-4-5',
    });
    expect(chain.map((c) => c.provider)).toEqual(['openai']);
    expect(rejected[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      code: 'capability',
      why: 'not eligible: claude-haiku-4-5 on anthropic does not carry vision',
    });
  });

  it('1. an explicit model the catalogue does not list is accepted, with the note', () => {
    const { chain, rejected } = selectChain({
      task: 'telegram',
      selection: doc(['foundry']),
      catalog: catalogue(),
      availability: everything,
      explicitModel: 'gpt-5.4-nano',
    });
    expect(rejected).toEqual([]);
    expect(chain[0]).toMatchObject({ provider: 'foundry', model: 'gpt-5.4-nano', selection: 'explicit' });
    expect(chain[0].why).toBe(
      'explicit model from the call site; Priority 1 · gpt-5.4-nano on foundry is not in the catalogue yet; allowed until a refresh says otherwise'
    );
  });

  it('2. recommended: the registry model leads when live, priced, keyed, enabled and able; the list follows', () => {
    const { mode, chain, flags } = selectChain({
      task: 'forgeDrafting',
      selection: doc(['gemini', 'foundry'], { forgeDrafting: { mode: 'recommended' } }),
      catalog: catalogue(),
      availability: everything,
    });
    expect(mode).toBe('recommended');
    expect(steps(chain)).toEqual(['foundry:gpt-5-mini', 'gemini:-']);
    expect(chain[0].selection).toBe('recommended');
    expect(chain[0].why).toMatch(/^recommended for this task: /);
    expect(chain[1].selection).toBe('global');
    expect(flags).toEqual([]);
  });

  it.each([
    ['not yet confirmed (unknown)', { status: 'unknown' }, /is unknown in the catalogue/],
    ['retired', { status: 'retired' }, /is retired on foundry/],
    ['unpriced', { unpriced: true }, /is unpriced/],
    ['missing a need', { capabilities: ['text'] }, /does not carry json/],
  ])('2. a recommendation that is %s falls through to the list, flagged', (_label, override, why) => {
    const { mode, chain, rejected, flags } = selectChain({
      task: 'inspector',
      selection: doc(['gemini', 'foundry'], { inspector: { mode: 'recommended' } }),
      catalog: catalogue({ 'foundry/gpt-5-mini': override }),
      availability: everything,
    });
    expect(mode).toBe('global');
    expect(chain[0].provider).toBe('gemini');
    expect(rejected[0]).toMatchObject({ provider: 'foundry', model: 'gpt-5-mini', selection: 'recommended' });
    expect(rejected[0].why).toMatch(why);
    expect(flags[0]).toMatch(/the recommended model is not eligible/);
  });

  it('2. a recommendation whose provider list is stale still leads, with a note', () => {
    const { chain } = selectChain({
      task: 'forgeDrafting',
      selection: doc(['gemini'], { forgeDrafting: { mode: 'recommended' } }),
      catalog: catalogue({}, { foundry: { stale: true } }),
      availability: everything,
    });
    expect(chain[0]).toMatchObject({ provider: 'foundry', selection: 'recommended' });
    expect(chain[0].why).toMatch(/catalogue list is stale/);
  });

  it('2. a recommendation that is not in the catalogue at all does not lead', () => {
    const { chain, rejected } = selectChain({
      task: 'forgeDrafting',
      selection: doc(['gemini'], { forgeDrafting: { mode: 'recommended' } }),
      catalog: { providers: {} },
      availability: everything,
    });
    expect(chain[0].provider).toBe('gemini');
    expect(rejected[0]).toMatchObject({ code: 'not-listed' });
  });

  it('3. custom: the chain in order, then the list without repeating a provider', () => {
    const { mode, chain } = selectChain({
      task: 'forgeDrafting',
      selection: doc(['gemini', 'openai', 'foundry'], {
        forgeDrafting: {
          mode: 'custom',
          chain: [{ provider: 'foundry', model: 'gpt-5-nano' }, { provider: 'anthropic', model: null }],
          thenGlobal: true,
        },
      }),
      catalog: catalogue(),
      availability: everything,
    });
    expect(mode).toBe('custom');
    expect(steps(chain)).toEqual(['foundry:gpt-5-nano', 'anthropic:-', 'gemini:-', 'openai:-']);
    expect(chain.map((c) => c.selection)).toEqual(['custom', 'custom', 'global', 'global']);
    expect(chain[0].why).toBe('custom chain, step 1 · model gpt-5-nano');
  });

  it('3. custom with thenGlobal off stops at the chain', () => {
    const { chain } = selectChain({
      task: 'forgeDrafting',
      selection: doc(['gemini', 'openai'], {
        forgeDrafting: { mode: 'custom', chain: [{ provider: 'anthropic', model: null }], thenGlobal: false },
      }),
      catalog: catalogue(),
      availability: everything,
    });
    expect(providersOf(chain)).toEqual(['anthropic']);
  });

  it('4. global: Priority 1 first, with each row\'s model where one is named', () => {
    const { chain } = selectChain({
      task: 'telegram',
      selection: doc([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, 'foundry', 'gemini']),
      catalog: catalogue(),
      availability: everything,
    });
    expect(steps(chain)).toEqual(['anthropic:claude-sonnet-4-6', 'foundry:-', 'gemini:-']);
    expect(chain.map((c) => c.why)).toEqual([
      'Priority 1 · model claude-sonnet-4-6',
      "Priority 2 · model: the provider's default for the call's purpose (gpt-5-nano for text)",
      "Priority 3 · model: the provider's default for the call's purpose (gemini-3.5-flash-lite for text)",
    ]);
  });

  it('the selection sources are the four the usage row may carry', () => {
    expect(SELECTION_SOURCES).toEqual(['explicit', 'recommended', 'custom', 'global']);
  });

  it('every provider in the modality table resolves a null for the modalities it names', () => {
    for (const [provider, table] of Object.entries(RECOMMENDED_BY_MODALITY)) {
      for (const modality of Object.keys(table)) {
        // A media modality needs its own capability; a text one is judged on text.
        const needs = ['tts', 'image'].includes(modality) ? [modality] : ['text'];
        const task = { id: null, label: 't', modality, needs, public: false, recommended: null };
        // Every known provider keyed, the media ones included (slice 5).
        const known = { keyed: [...KNOWN_PROVIDERS], enabled: [...KNOWN_PROVIDERS] };
        const { chain } = selectChain({ task, selection: doc([provider]), catalog: null, availability: known });
        expect(chain[0]?.modalityModel, `${provider}/${modality}`).toBe(table[modality].model);
      }
    }
  });
});

/**
 * The contract (ADR 0034 "Validation", #858): on the documents of
 * 2026-10-04, migrated to version 2, the resolver returns for every task the
 * chain the pre-slice router produced — resolveProviderOrder →
 * applyFeaturePlacement → applyFeatureRoute → the card pin — provider for
 * provider, model for model. The fixture is representative
 * (fixtures/selection-2026-10-04.js says why); the "before" chain is
 * computed by the very functions the router called until this slice, which
 * stay importable for that reason.
 *
 * Two documented differences, neither a change to any call that is made:
 *
 *   - `sourceGrounding`: the old chain listed OpenAI and Claude after Gemini
 *     (placement only removed the per-feature providers), but the grounded
 *     path never called them — it found Gemini in the chain or failed
 *     (router.js generateGroundedJson). The resolver's chain is Gemini
 *     alone, because grounding is a policy lock now (select.js), and the
 *     others appear in `rejected` saying so. Same call, honest chain.
 *   - a call that names no task: it was never given NVIDIA or Foundry
 *     (placement answered 'off' for no feature); the resolver keeps the
 *     trial tier off it (a policy lock) and lets Foundry, a paid provider
 *     the owner put second, serve it. ai-call-sites.test.js keeps every
 *     production call site naming a task, so no production call is one.
 */
import { describe, it, expect } from 'vitest';
import {
  applyFeaturePlacement,
  applyFeatureRoute,
  configuredModelFor,
  normalizeRouting,
  resolveProviderOrder,
  routeFor,
} from './ai-config.js';
import { migrateSelection } from './migrate-selection.js';
import { selectChain } from './select.js';
import { seedModelsFor } from './model-catalog.js';
import { enrichmentFor } from './model-enrichment.js';
import { DEFAULT_PROVIDER_ORDER } from './provider-order.js';
import { AI_TASKS, TASK_NAMES, isMediaTask } from './tasks.js';

// Second Brain is new after this historical migration fixture. Its private
// provider lock is tested by select.test.js. The media tasks had no old chain: they are
// held by select.test.js and migrate-selection.test.js, not by this contract.
const CHAT_TASKS = TASK_NAMES.filter((task) => !isMediaTask(AI_TASKS[task]) && task !== 'brainAssistant');
import {
  FEATURES,
  PROVIDERS,
  ROUTING_V1,
  ROUTING_V1_WITH_ROUTE,
  WITH_SEED_PINS,
} from './fixtures/selection-2026-10-04.js';

/** Every router default `live` for every provider, as a refreshed catalogue has them. */
function liveCatalogue() {
  const providers = {};
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    const models = {};
    for (const id of seedModelsFor(provider)) {
      models[id] = { id, status: 'live', hidden: false, ...enrichmentFor(id), unpriced: false };
    }
    providers[provider] = { stale: false, seeded: false, models };
  }
  return { providers };
}

/**
 * The chain the router produced before this slice, for one task — for the
 * grounded task, the one entry of it the grounded path ever called (header).
 */
function before({ providers, features, routing }, keyed, task) {
  const resolved = resolveProviderOrder(providers, keyed);
  const placed = applyFeaturePlacement(resolved.order, features, task);
  const route = routeFor(normalizeRouting(routing), task);
  const chain = applyFeatureRoute(placed.order, route).chain.map(({ provider, model }) => ({
    provider,
    model: model || configuredModelFor(providers, provider),
  }));
  return task === 'sourceGrounding' ? chain.filter((s) => s.provider === 'gemini') : chain;
}

/** The chain the resolver produces on the migrated document, for one task. */
function after(docs, keyed, task, catalog = liveCatalogue()) {
  const { order: enabled } = resolveProviderOrder(docs.providers, keyed);
  return selectChain({
    task,
    selection: migrateSelection(docs),
    catalog,
    availability: { keyed, enabled },
  }).chain.map(({ provider, model }) => ({ provider, model }));
}

const KEY_SETS = {
  'every provider keyed': DEFAULT_PROVIDER_ORDER,
  'the three original keys only': ['gemini', 'openai', 'anthropic'],
  'NVIDIA and Foundry only': ['nvidia', 'foundry'],
  'Foundry and Gemini': ['foundry', 'gemini'],
};

const DOCS = {
  'no routes, no pins (the owner\'s order of 2026-10-04)': {
    providers: PROVIDERS,
    features: FEATURES,
    routing: ROUTING_V1,
  },
  'no routes, the seed\'s pins': { providers: WITH_SEED_PINS, features: FEATURES, routing: ROUTING_V1 },
  'two routes, no pins': { providers: PROVIDERS, features: FEATURES, routing: ROUTING_V1_WITH_ROUTE },
  'two routes, the seed\'s pins': {
    providers: WITH_SEED_PINS,
    features: FEATURES,
    routing: ROUTING_V1_WITH_ROUTE,
  },
  'Claude switched off, as the ADR\'s context lists it': {
    providers: PROVIDERS.map((c) => (c.id === 'anthropic' ? { ...c, enabled: false } : c)),
    features: FEATURES,
    routing: ROUTING_V1,
  },
};

describe('the resolver returns the chain the router produced before, for every task', () => {
  for (const [docsLabel, docs] of Object.entries(DOCS)) {
    for (const [keysLabel, keyed] of Object.entries(KEY_SETS)) {
      it(`${docsLabel}; ${keysLabel}`, () => {
        for (const task of CHAT_TASKS) {
          expect(after(docs, keyed, task), task).toEqual(before(docs, keyed, task));
        }
      });
    }
  }

  it('the chains are the ones the owner saw: Foundry first for content, Gemini for the public route', () => {
    const docs = DOCS['no routes, no pins (the owner\'s order of 2026-10-04)'];
    const chain = (task) => after(docs, DEFAULT_PROVIDER_ORDER, task).map((s) => s.provider);
    expect(chain('forgeDrafting')).toEqual(['foundry', 'nvidia', 'gemini', 'openai', 'anthropic']);
    expect(chain('altText')).toEqual(['foundry', 'gemini', 'openai', 'anthropic']);
    expect(chain('pricingExplain')).toEqual(['gemini', 'openai', 'anthropic']);
    expect(chain('landingZoneExplain')).toEqual(['gemini', 'openai', 'anthropic']);
    expect(chain('sourceGrounding')).toEqual(['gemini']);
    // With the two routes: the route leads, Foundry's placement follows it.
    const routed = DOCS['two routes, no pins'];
    expect(after(routed, DEFAULT_PROVIDER_ORDER, 'forgeDrafting')).toEqual([
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      { provider: 'gemini', model: null },
      { provider: 'foundry', model: null },
      { provider: 'nvidia', model: null },
      { provider: 'openai', model: null },
    ]);
  });

  it('holds before the first catalogue refresh too, when every default is still unknown', () => {
    const docs = DOCS['no routes, the seed\'s pins'];
    const unknown = liveCatalogue();
    for (const entry of Object.values(unknown.providers)) {
      for (const model of Object.values(entry.models)) model.status = 'unknown';
    }
    for (const task of CHAT_TASKS) {
      expect(after(docs, DEFAULT_PROVIDER_ORDER, task, unknown), task).toEqual(
        before(docs, DEFAULT_PROVIDER_ORDER, task)
      );
      expect(after(docs, DEFAULT_PROVIDER_ORDER, task, null), task).toEqual(
        before(docs, DEFAULT_PROVIDER_ORDER, task)
      );
    }
  });

  it('documented difference: the grounded task\'s chain is Gemini alone, the rest turned away by the lock', () => {
    const docs = DOCS['no routes, no pins (the owner\'s order of 2026-10-04)'];
    const old = applyFeatureRoute(
      applyFeaturePlacement(resolveProviderOrder(docs.providers, DEFAULT_PROVIDER_ORDER).order, docs.features, 'sourceGrounding').order,
      null
    ).chain.map((s) => s.provider);
    expect(old).toEqual(['gemini', 'openai', 'anthropic']);
    const { chain, rejected } = selectChain({
      task: 'sourceGrounding',
      selection: migrateSelection(docs),
      catalog: liveCatalogue(),
      availability: { keyed: DEFAULT_PROVIDER_ORDER, enabled: DEFAULT_PROVIDER_ORDER },
    });
    expect(chain.map((s) => s.provider)).toEqual(['gemini']);
    expect(rejected.map((r) => [r.provider, r.code])).toEqual([
      ['nvidia', 'excluded'],
      ['foundry', 'excluded'],
      ['openai', 'policy'],
      ['anthropic', 'policy'],
    ]);
  });

  it('documented difference: a call that names no task may use Foundry, never the trial tier', () => {
    const docs = DOCS['no routes, no pins (the owner\'s order of 2026-10-04)'];
    expect(before(docs, DEFAULT_PROVIDER_ORDER, null).map((s) => s.provider)).toEqual([
      'gemini',
      'openai',
      'anthropic',
    ]);
    expect(after(docs, DEFAULT_PROVIDER_ORDER, null).map((s) => s.provider)).toEqual([
      'foundry',
      'gemini',
      'openai',
      'anthropic',
    ]);
  });
});

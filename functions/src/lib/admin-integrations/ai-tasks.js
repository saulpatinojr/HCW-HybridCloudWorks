/**
 * ai-tasks.js — the Tasks tab's two reads of production (ADR 0034 §4, slice
 * 4, #859), beside the selection document's GET and PUT in ai-routing.js:
 *
 *   GET cms/ai-routing/effective — the resolver's answer for every task over
 *   the configuration the router reads (router.js effectiveSelection: the
 *   same loader, cache dropped first). The browser cannot import the
 *   resolver, and a copy of it on the page would be the second list this
 *   page has already had once; so the page renders this answer and never
 *   computes its own. effective-selection.contract.test.js holds the
 *   answer for a task equal to selectChain's on the same documents.
 *
 *   POST cms/ai-routing/test/{task} — the task's effective chain walked with
 *   the Test's prompt and caps (proxy.js testTaskCandidate) until one
 *   candidate answers: which one did, how fast, and why each one above it
 *   did not. The chain is the resolver's, so the policy locks hold here as
 *   they do for a real call — the public explain route is never tested
 *   against the trial tier (ai-tasks.test.js).
 *
 * A MEDIA TASK'S TEST SPENDS NOTHING (ADR 0034 slice 5, #860). The Test
 * above sends a one-word prompt down a chat chain, which costs a fraction
 * of a cent; a voice or an image model has no one-word prompt, and the
 * cheapest audio or image is real money on an account the Usage tab can
 * see. So for a task whose modality is tts, image, stt, ocr or embedding
 * the Test resolves the chain and answers the candidate it WOULD use, with
 * the resolver's reason, and never calls the provider: `dryRun: true`,
 * `wouldUse: { provider, model, why }` (null when nothing is eligible),
 * `answeredBy: null`, `skipped: []`. The page says so on the line.
 *
 * Each handler body is a module-level function over `ctx` (guard, store,
 * now, uuid, clock, ai, effectiveSelection); the factory at the bottom only
 * wires them.
 */
import { AI_TASKS, TASK_NAMES, isMediaTask } from '../ai/tasks.js';
import { testTaskCandidate } from '../ai/proxy.js';
import { json } from '../http/admin-handler.js';
import { errorFacts } from '../http/error-response.js';

/** GET /api/cms/ai-routing/effective — every task's chain, rejected candidates and flags. */
async function getAiRoutingEffective(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  if (typeof ctx.effectiveSelection !== 'function') {
    return json(503, { error: 'The AI router is not available to this process' });
  }
  try {
    const effective = await ctx.effectiveSelection();
    return json(200, { success: true, ...effective });
  } catch (error) {
    context.error('getAiRoutingEffective failed:', errorFacts(error));
    return json(500, { error: 'Failed to resolve the AI routing' });
  }
}

/** The route's task segment: a registry task, or `{ error }`. */
function taskParam(request) {
  const task = String(request.params?.task || '').trim();
  if (!TASK_NAMES.includes(task)) {
    return { error: `Unknown AI task: ${task || '(none)'}. Known: ${TASK_NAMES.join(', ')}` };
  }
  return { task };
}

/**
 * Walk the chain: each candidate is tried in turn and the first that
 * answers ends the walk. The ones before it are `skipped` with the
 * provider's own sentence; the ones after it are not tried.
 */
async function walkChain(ctx, chain, context) {
  const deps = { store: ctx.store, ai: ctx.ai, now: ctx.now, uuid: ctx.uuid, clock: ctx.clock, log: context };
  const skipped = [];
  for (const candidate of chain) {
    const outcome = await testTaskCandidate(deps, {
      providerId: candidate.provider,
      model: candidate.model,
    });
    if (outcome.ok) {
      return {
        answeredBy: { provider: candidate.provider, model: outcome.model, latencyMs: outcome.latencyMs },
        skipped,
      };
    }
    skipped.push({
      provider: candidate.provider,
      model: candidate.model,
      why: outcome.error,
      code: outcome.code,
      latencyMs: outcome.latencyMs,
    });
  }
  return { answeredBy: null, skipped };
}

/**
 * A media task's answer (header): the first eligible candidate as the call
 * site would read it (router.js modelForTask: a step naming no model
 * answers the model it was judged on), nothing called.
 */
function dryRunReport(task, resolved) {
  const first = resolved.chain[0] || null;
  const wouldUse = first
    ? { provider: first.provider, model: first.model || first.modalityModel || null, why: first.why || '' }
    : null;
  return {
    ok: Boolean(wouldUse),
    task,
    mode: resolved.mode,
    dryRun: true,
    wouldUse,
    answeredBy: null,
    skipped: [],
    rejected: resolved.rejected,
    flags: resolved.flags,
    ...(wouldUse ? {} : { error: 'No candidate of the chain is eligible' }),
  };
}

/** The Test's answer for one task: a dry run for a media task, otherwise the chain walked. */
async function taskTestReport(ctx, task, context) {
  const { tasks } = await ctx.effectiveSelection();
  const resolved = tasks[task];
  if (isMediaTask(AI_TASKS[task])) return dryRunReport(task, resolved);
  const { answeredBy, skipped } = await walkChain(ctx, resolved.chain, context);
  return {
    ok: Boolean(answeredBy),
    task,
    mode: resolved.mode,
    answeredBy,
    skipped,
    rejected: resolved.rejected,
    flags: resolved.flags,
    ...(answeredBy ? {} : { error: 'No candidate of the chain answered' }),
  };
}

/**
 * POST /api/cms/ai-routing/test/{task} — run the task's effective chain with
 * the Test's limits. 200 with `ok: false` when no candidate answered, as the
 * card's Test answers: a chain that cannot serve is an answer, not a fault.
 * A media task is a dry run (header).
 */
async function testAiTask(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const param = taskParam(request);
  if (param.error) return json(400, { ok: false, error: param.error });
  if (typeof ctx.effectiveSelection !== 'function' || !ctx.ai?.callProvider) {
    return json(503, { ok: false, error: 'The AI router is not available to this process' });
  }
  try {
    return json(200, await taskTestReport(ctx, param.task, context));
  } catch (error) {
    context.error('testAiTask failed:', errorFacts(error));
    return json(500, { ok: false, error: 'Failed to test the task' });
  }
}

/**
 * @param {{ guard: object, store: object, now: () => Date, uuid: () => string,
 *           clock?: () => number, ai?: { callProvider: Function, getCostEstimate: Function },
 *           effectiveSelection?: () => Promise<object> }} ctx
 */
export function createAiTaskHandlers(ctx) {
  const deps = { clock: () => Date.now(), ...ctx };
  return {
    getAiRoutingEffective: (request, context) => getAiRoutingEffective(deps, request, context),
    testAiTask: (request, context) => testAiTask(deps, request, context),
  };
}

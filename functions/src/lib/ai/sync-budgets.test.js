/**
 * The synchronous AI routes' time budgets, pinned against the browser's
 * timeouts (frontend/src/lib/api.js) and the edge's ~100 s (router.js
 * header, SYNCHRONOUS CALLS HAVE A TIME BUDGET).
 *
 * WHY A TEST. A budget is only worth anything if it ends before the browser
 * gives up. The server's numbers and the client's live in two packages, so
 * nothing else keeps them in agreement. Raise a budget past the client's
 * timeout, or lower a client timeout under a budget, and this fails naming
 * both.
 *
 * It also guards the list itself, in the same way ai-call-sites.test.js does.
 * An HTTP registration that can reach a model has to appear below, either
 * with its budget or with the reason it has none. A new synchronous route
 * therefore cannot quietly let a slow first provider outlive the browser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DRAFT_HTTP_BUDGET_MS } from '../content/draft-from-url.js';
import { RECORDING_DRAFT_HTTP_BUDGET_MS } from '../content/draft-from-recording.js';
import { NEWSLETTER_AI_BUDGET_MS } from '../newsletter/admin-handlers.js';
import { CAPTION_AI_BUDGET_MS } from '../social-caption.js';
import { FORGE_ASSIST_AI_BUDGET_MS, FORGE_ASSIST_HTTP_BUDGET_MS } from '../content/forge-studio.js';
import { AFTER_MODEL_MARGIN_MS, MIN_ATTEMPT_MS } from './time-budget.js';

const API_JS = fileURLToPath(new URL('../../../../frontend/src/lib/api.js', import.meta.url));
const REGISTRATIONS = fileURLToPath(new URL('../../functions/', import.meta.url));

/**
 * Cloudflare ends a proxied request that has not answered in about 100 s
 * (HTTP 524). Every budget must end well before it, whatever the client
 * allows.
 */
const EDGE_TIMEOUT_MS = 100_000;

/** The least time left between a budget and the client's timeout for the network and a cold start. */
const MIN_HEADROOM_MS = 5_000;

/**
 * The client's timeout table, read from its source. The lookup is exact
 * (`FUNCTION_TIMEOUT_MS[fnName] || DEFAULT_TIMEOUT_MS`). A route not in the
 * table, and every route whose name carries an id, gets the default.
 */
function clientTimeouts() {
  const source = readFileSync(API_JS, 'utf8');
  const fallback = source.match(/const DEFAULT_TIMEOUT_MS = (\d+);/);
  const table = source.match(/const FUNCTION_TIMEOUT_MS = \{([\s\S]*?)\n\};/);
  const exactLookup = source.includes('return FUNCTION_TIMEOUT_MS[fnName] || DEFAULT_TIMEOUT_MS;');
  if (!fallback || !table || !exactLookup) {
    throw new Error(
      'frontend/src/lib/api.js no longer declares its timeouts the way this test reads them. Update the parser here; do not change the budgets to make it pass.'
    );
  }
  const byRoute = {};
  for (const [, key, ms] of table[1].matchAll(/^\s*'?([\w/{}.-]+)'?:\s*(\d+),/gm)) {
    byRoute[key] = Number(ms);
  }
  return { fallback: Number(fallback[1]), byRoute };
}

const CLIENT = clientTimeouts();

/**
 * Each synchronous route that reaches an NVIDIA-first feature: the budget
 * its handler runs under, the part of it the AI router gets, and the
 * client timeout it must answer inside.
 */
const BUDGETED = [
  {
    route: 'generateArticleDraft',
    clientMs: CLIENT.byRoute.generateArticleDraft,
    handlerMs: DRAFT_HTTP_BUDGET_MS,
    aiMs: DRAFT_HTTP_BUDGET_MS - AFTER_MODEL_MARGIN_MS,
  },
  {
    route: 'createContentFromRecording',
    clientMs: CLIENT.byRoute.createContentFromRecording,
    handlerMs: RECORDING_DRAFT_HTTP_BUDGET_MS,
    aiMs: RECORDING_DRAFT_HTTP_BUDGET_MS - AFTER_MODEL_MARGIN_MS,
  },
  {
    // cms/newsletters/{id}/intro and /subjects: the id is in the name.
    route: 'regenerateNewsletterIntro, suggestNewsletterSubjects',
    clientMs: CLIENT.fallback,
    handlerMs: NEWSLETTER_AI_BUDGET_MS,
    aiMs: NEWSLETTER_AI_BUDGET_MS,
  },
  {
    route: 'generateSocialCaption',
    clientMs: CLIENT.byRoute.generateSocialCaption ?? CLIENT.fallback,
    handlerMs: CAPTION_AI_BUDGET_MS,
    aiMs: CAPTION_AI_BUDGET_MS,
  },
  {
    // Forge Studio's AI actions over the draft text (ADR 0033).
    route: 'cms/forge/assist',
    clientMs: CLIENT.byRoute['cms/forge/assist'],
    handlerMs: FORGE_ASSIST_HTTP_BUDGET_MS,
    aiMs: FORGE_ASSIST_AI_BUDGET_MS,
  },
];

/**
 * Every HTTP registration that can reach a model, with the budget it runs
 * under or the reason it has none. The reasons are about NVIDIA. That is
 * the provider whose 120 s attempts made drafts outlive the browser, and
 * none of these three routes can reach it first.
 */
const HTTP_ROUTES_THAT_REACH_A_MODEL = Object.freeze({
  'generate-article-draft-http.js': 'budget: DRAFT_HTTP_BUDGET_MS',
  'recording-content-http.js': 'budget: RECORDING_DRAFT_HTTP_BUDGET_MS',
  'newsletter-admin-http.js': 'budget: NEWSLETTER_AI_BUDGET_MS',
  'social-caption-http.js': 'budget: CAPTION_AI_BUDGET_MS',
  'forge-config-http.js':
    'budget: FORGE_ASSIST_HTTP_BUDGET_MS (cms/forge/assist; the two config RPCs reach no model)',
  'ai-proxy-http.js':
    'none: the portal Test and Playground call one named provider through callProvider, with no failover; the Test caps itself (proxy.js)',
  'cloud-tools-http.js':
    'none yet: NVIDIA is locked off for the anonymous explain route (ai-config.js); a budget for its paid providers is a separate decision',
  'telegram-http.js':
    'none yet: NVIDIA is last for the Telegram assistant, reached only after all three paid providers fail; a budget for the webhook is a separate decision',
});

/** Does this registration file reach one of the router's model calls? */
function reachesAModel(text) {
  return (
    /import \* as ai from '\.\.\/lib\/ai\/router\.js'/.test(text) ||
    /import\('\.\.\/lib\/ai\/router\.js'\)/.test(text) ||
    /import \{[^}]*\b(?:generateTextResponse|generateJsonResponse|generateGroundedJsonResponse|callProvider)\b[^}]*\} from '\.\.\/lib\/ai\/router\.js'/.test(
      text
    )
  );
}

describe('synchronous AI routes answer before the browser and the edge give up', () => {
  it('reads the client timeouts it pins against', () => {
    // A parser that matched nothing would make every comparison below vacuous.
    expect(CLIENT.fallback).toBeGreaterThan(0);
    expect(CLIENT.byRoute.generateArticleDraft).toBeGreaterThan(0);
    expect(CLIENT.byRoute.createContentFromRecording).toBeGreaterThan(0);
    // The newsletter routes carry an id, so only the default can apply.
    expect(Object.keys(CLIENT.byRoute).filter((key) => key.startsWith('cms/newsletters'))).toEqual(
      []
    );
  });

  it.each(BUDGETED)(
    '$route: the handler answers inside the client timeout and the edge',
    (entry) => {
      const where = `${entry.route}: handler ${entry.handlerMs} ms, client ${entry.clientMs} ms`;
      expect(entry.clientMs - entry.handlerMs, where).toBeGreaterThanOrEqual(MIN_HEADROOM_MS);
      expect(EDGE_TIMEOUT_MS - entry.handlerMs, where).toBeGreaterThanOrEqual(MIN_HEADROOM_MS);
    }
  );

  it.each(BUDGETED)('$route: the AI budget leaves room for a failover at all', (entry) => {
    // The reserve is half the budget, so a second provider needs 2 x MIN_ATTEMPT_MS.
    expect(entry.aiMs, entry.route).toBeLessThanOrEqual(entry.handlerMs);
    expect(entry.aiMs, entry.route).toBeGreaterThanOrEqual(2 * MIN_ATTEMPT_MS);
  });

  it('every HTTP registration that can reach a model is listed, with its budget or its reason', () => {
    const found = readdirSync(REGISTRATIONS)
      .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
      .filter((file) => {
        const text = readFileSync(join(REGISTRATIONS, file), 'utf8');
        return reachesAModel(text) && /\bhttpRoute(?:ByMethod)?\(/.test(text);
      })
      .sort();
    expect(
      found,
      'A synchronous route that reaches a model must be budgeted (router.js header) or listed here with the reason it is not.'
    ).toEqual(Object.keys(HTTP_ROUTES_THAT_REACH_A_MODEL).sort());
  });
});

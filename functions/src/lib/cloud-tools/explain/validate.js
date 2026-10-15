/**
 * The request body of POST public/cloud-tools/explain, validated field by
 * field, and its canonical form (#613 Phase 3; the route's header is in
 * handler.js).
 *
 * The numbers are the page's own arithmetic, echoed back; the model is told
 * to use only those numbers, and the validated body is what it is told them
 * in, so nothing unvalidated reaches the prompt. Every string is capped,
 * every number must be finite, every unknown key is refused, and every
 * refusal is a sentence naming the field — never the value.
 */

import { createHash } from 'node:crypto';
import { AuthoredError, authoredMessage } from '../../http/error-response.js';

import { PROVIDERS } from '../pricing/baseline.js';
import { regionOption } from '../pricing/regions.js';

export const EXPLAIN_MAX_BODY_BYTES = 8 * 1024;

const MAX_STRING = 80;
const MAX_RESULTS = 3;
const MAX_SEGMENTS = 8;
const MAX_EXTRAS = 8;

const BODY_KEYS = ['region', 'scenarioId', 'scenarioLabel', 'extras', 'egressGb', 'results'];
const RESULT_KEYS = ['provider', 'total', 'base', 'segments', 'unavailable'];
const SEGMENT_KEYS = ['extraId', 'label', 'cost'];

/**
 * A refusal in the validator: a sentence naming the field, never the value.
 * Authored (#945): the public route answers with it, and
 * public-visitor-copy.test.js holds every sentence to visitor language.
 */
class Refusal extends AuthoredError {}
const refuse = (message) => {
  throw new Refusal(message);
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(value, allowed, where) {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) refuse(`${where} has unknown field(s): ${extra.join(', ')}`);
}

function text(value, where) {
  if (value === undefined || value === null) refuse(`${where} is required`);
  if (typeof value !== 'string') refuse(`${where} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) refuse(`${where} must not be empty`);
  if (trimmed.length > MAX_STRING) refuse(`${where} must be at most ${MAX_STRING} characters`);
  return trimmed;
}

function money(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse(`${where} must be a finite number`);
  }
  return value;
}

function list(value, where, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse(`${where} must be an array`);
  if (value.length > max) refuse(`${where} may hold at most ${max} entries`);
  return value;
}

const stringList = (value, where, max) =>
  list(value, where, max).map((entry, i) => text(entry, `${where}[${i}]`));

function segment(value, where) {
  if (!isPlainObject(value)) refuse(`${where} must be an object`);
  onlyKeys(value, SEGMENT_KEYS, where);
  return {
    extraId: text(value.extraId, `${where}.extraId`),
    label: text(value.label, `${where}.label`),
    cost: money(value.cost, `${where}.cost`),
  };
}

function result(value, where, seen) {
  if (!isPlainObject(value)) refuse(`${where} must be an object`);
  onlyKeys(value, RESULT_KEYS, where);
  const provider = text(value.provider, `${where}.provider`);
  if (!PROVIDERS.includes(provider)) refuse(`${where}.provider is not a known provider`);
  if (seen.has(provider)) refuse(`${where}.provider repeats ${provider}`);
  seen.add(provider);
  return {
    provider,
    total: money(value.total, `${where}.total`),
    base: money(value.base, `${where}.base`),
    segments: list(value.segments, `${where}.segments`, MAX_SEGMENTS).map((s, j) =>
      segment(s, `${where}.segments[${j}]`)
    ),
    unavailable: stringList(value.unavailable, `${where}.unavailable`, MAX_SEGMENTS),
  };
}

function results(value) {
  if (!Array.isArray(value) || value.length === 0) refuse('results must be a non-empty array');
  if (value.length > MAX_RESULTS) refuse(`results may hold at most ${MAX_RESULTS} entries`);
  const seen = new Set();
  return value.map((entry, i) => result(entry, `results[${i}]`, seen));
}

function body(value) {
  if (!isPlainObject(value)) refuse('Body must be a JSON object');
  onlyKeys(value, BODY_KEYS, 'body');
  const region = text(value.region, 'region');
  if (!regionOption(region)) refuse('region is not one of the comparison regions');
  const egressGb = money(value.egressGb, 'egressGb');
  if (egressGb < 0) refuse('egressGb must not be negative');
  return {
    region,
    scenarioId: text(value.scenarioId, 'scenarioId'),
    scenarioLabel: text(value.scenarioLabel, 'scenarioLabel'),
    extras: stringList(value.extras, 'extras', MAX_EXTRAS),
    egressGb,
    results: results(value.results),
  };
}

/**
 * The request body, validated field by field, in the canonical key order.
 *
 * @returns {{ value: object } | { error: string }}
 */
export function validateExplainRequest(raw) {
  try {
    return { value: body(raw) };
  } catch (error) {
    if (error instanceof Refusal) return { error: authoredMessage(error, 'The request was refused.') };
    throw error;
  }
}

/**
 * The canonical text of a validated request: the validator's own key order,
 * results sorted by provider, so the same scenario hashes the same whichever
 * order the page listed the providers in.
 */
export function canonicalExplainRequest(value) {
  return JSON.stringify({
    ...value,
    results: [...value.results].sort((a, b) => a.provider.localeCompare(b.provider)),
  });
}

export function explainCacheId(canonical) {
  return `explain:${createHash('sha256').update(canonical).digest('hex')}`;
}

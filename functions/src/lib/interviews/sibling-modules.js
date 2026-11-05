/**
 * sibling-modules.js — how the content-type slice reaches the two interview
 * modules another slice owns (ADR 0040, the slice plan).
 *
 * `schema.js` (the interview's field limits, `validateInterviewFields` and
 * `validateQa`) is written by the jobs slice, and `storage.js` (where the
 * recording and transcripts live) by the upload slice. This slice imports
 * both but must not create either, and its pull request has to pass its
 * checks before theirs have merged. So the two are loaded here, lazily and
 * by a path held in a variable, which keeps the bundler and the test runner
 * from resolving the file until it is actually asked for; a test hands in a
 * stand-in with `stubSiblingModulesForTests` and never touches the disk.
 *
 * The wrappers below also fix the one shape this slice relies on: a check
 * either returns `{ ok: true, value }` or `{ ok: false, error }`, where
 * `error` is a sentence for the editor. The schema's own functions answer
 * that same shape, with `error` already passed through `authoredMessage`
 * on their side (schema.js `fail`), so it is carried as is; a function that
 * throws instead is caught here and only an authored sentence passes the
 * door, anything else answering the fixed fallback.
 */
import { authoredMessage } from '../http/error-response.js';

const SCHEMA_MODULE = './schema.js';
const STORAGE_MODULE = './storage.js';

let overrides = null;

/**
 * Replace the sibling modules for a test, or restore the real ones with no
 * argument. A partial object stands in for only the modules it names.
 *
 * @param {{ schema?: object, storage?: object } | null} [modules]
 */
export function stubSiblingModulesForTests(modules = null) {
  overrides = modules;
}

/** The interview schema module, the jobs slice's `schema.js`. */
export async function interviewSchema() {
  if (overrides?.schema) return overrides.schema;
  return import(/* @vite-ignore */ SCHEMA_MODULE);
}

/** The interview storage module, the upload slice's `storage.js`. */
export async function interviewStorage() {
  if (overrides?.storage) return overrides.storage;
  return import(/* @vite-ignore */ STORAGE_MODULE);
}

/**
 * Run one schema check and answer in the fixed shape.
 *
 * @param {(input: unknown) => unknown} check - the schema function
 * @param {unknown} input
 * @param {string} fallback - the sentence used when the error carries none
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: string }>}
 */
async function runCheck(check, input, fallback) {
  try {
    const result = await check(input);
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
    }
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error: authoredMessage(error, fallback) };
  }
}

/**
 * The interview's own fields (title, subtitle, date, guest, bio, image,
 * tags, qa, related — whichever are present) against the schema.
 *
 * @param {object} partial
 */
export async function checkInterviewFields(partial) {
  const schema = await interviewSchema();
  if (typeof schema.validateInterviewFields !== 'function') {
    return { ok: false, error: 'The interview checks are not available.' };
  }
  return runCheck(
    schema.validateInterviewFields,
    partial,
    'One of the interview fields was refused.'
  );
}

/**
 * The question-and-answer list against the schema: 1 to 40 items, each with
 * a question and an answer within their limits.
 *
 * @param {unknown} qa
 */
export async function checkInterviewQa(qa) {
  const schema = await interviewSchema();
  if (typeof schema.validateQa !== 'function') {
    return { ok: false, error: 'The interview checks are not available.' };
  }
  return runCheck(schema.validateQa, qa, 'The questions and answers were refused.');
}

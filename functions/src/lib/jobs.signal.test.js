/**
 * jobs.signal.test.js — every registered worker passes its AbortSignal on
 * (#942).
 *
 * runJob aborts a controller at a type's timeout and hands the worker its
 * signal. Until #1198 not one of the registered workers used it, so a job
 * recorded as `timeout` went on calling models and writing documents, and
 * jobs.test.js — which proves the signal fires for a synthetic worker —
 * could not fail. #1198 threads the signal from each worker into the
 * libraries it calls; this is the cheap, repository-wide guard that keeps it
 * there, a static check over the live registry. The workers' own tests
 * assert what each library does with it.
 *
 * Three things are held here, each because a weaker form could be satisfied
 * without the property it stands for (#942 follow-up):
 *
 *  1. The modules: every file under src/ that calls registerJobType —
 *     however it imports it, aliased or as a namespace — is found by reading
 *     the tree and imported, and the list is pinned, so a new job module is
 *     held to the rule the day it is added.
 *  2. The types: the registry holds exactly the types pinned below; a new
 *     one fails here until it is added, and so is read by the check in 3.
 *  3. The worker passes its signal onward, into the library or the next
 *     function, in its own code once its comments and strings are removed.
 *     What counts is an argument that carries the signal itself: the signal
 *     (destructured, under any name), `ctx.signal`, or the whole context
 *     object `ctx`, alone or as a property or spread of an object argument,
 *     so a thin wrapper `(p, ctx) => run(p, ctx)` passes. What does not:
 *     naming it in a destructuring and never using it, testing it in an
 *     `if`, naming it in a string, passing something computed from it
 *     (`signal.aborted`, `!signal`), or handing it to a call that only
 *     converts or logs it (`Boolean(signal)`, `String(signal)`,
 *     `context.log(signal)`).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listJobTypes, getJobType } from './jobs.js';

const SRC = new URL('../', import.meta.url);

/** Every .js file under `dir` (a file URL ending in /), tests excluded, as file URLs. */
function sourceFiles(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir));
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) return [];
    return [new URL(entry.name, dir)];
  });
}

/** `text` with every regular-expression metacharacter escaped. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The names under which a module's source can call registerJobType: each
 * import of it from a `jobs.js`, aliased or not, and `<ns>.registerJobType`
 * for a namespace import.
 */
function registrationCallees(text) {
  const names = [];
  for (const [, specifiers] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/jobs\.js['"]/g)) {
    for (const specifier of specifiers.split(',')) {
      const [imported, local] = specifier.trim().split(/\s+as\s+/);
      if (imported === 'registerJobType') names.push(local || imported);
    }
  }
  for (const [, ns] of text.matchAll(/import\s*\*\s*as\s+([\w$]+)\s+from\s*['"][^'"]*\/jobs\.js['"]/g)) {
    names.push(`${ns}.registerJobType`);
  }
  return names;
}

/** Does this source call registerJobType under any name it imported it as? */
function registersJobTypes(text) {
  return registrationCallees(text).some((name) =>
    new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}\\s*\\(`, 'm').test(text)
  );
}

const jobModules = sourceFiles().filter((file) => registersJobTypes(readFileSync(file, 'utf8')));
for (const file of jobModules) await import(file.href);

/** A file's path under src/, with forward slashes. */
const underSrc = (file) =>
  fileURLToPath(file).slice(fileURLToPath(SRC).length).replace(/\\/g, '/');

/** A function's code with its comments, then its string and template literals, removed. */
function codeOf(fn) {
  return Function.prototype.toString
    .call(fn)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** The index of the parenthesis closing the one at `open`, or -1. */
function closingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')' && (depth -= 1) === 0) return i;
  }
  return -1;
}

/** The index of the parenthesis opening the one closing at `close`, or -1. */
function openingParen(code, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (code[i] === ')') depth += 1;
    else if (code[i] === '(' && (depth -= 1) === 0) return i;
  }
  return -1;
}

/** `text` split at its top-level commas, each part trimmed, empty parts dropped. */
function topLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ('([{'.includes(text[i])) depth += 1;
    else if (')]}'.includes(text[i])) depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** A binding or property with its default (`= {}`) removed; `=>` and comparisons are not defaults. */
function withoutDefault(binding) {
  let depth = 0;
  for (let i = 0; i < binding.length; i += 1) {
    if ('([{'.includes(binding[i])) depth += 1;
    else if (')]}'.includes(binding[i])) depth -= 1;
    else if (depth === 0 && binding[i] === '=' && !/[=>]/.test(binding[i + 1] || '') && !/[=!<>]/.test(binding[i - 1] || '')) {
      return binding.slice(0, i).trim();
    }
  }
  return binding.trim();
}

/**
 * The function's own parameter list and the code after it. Code that is not
 * a parenthesised function (a single bare parameter) has no context to pass.
 */
function splitFunction(code) {
  const open = code.indexOf('(');
  if (open === -1 || !/^\s*(async\s*)?(function\s*\*?\s*)?[\w$]*\s*$/.test(code.slice(0, open))) {
    return { params: '', body: code };
  }
  const close = closingParen(code, open);
  return close === -1 ? { params: '', body: code } : { params: code.slice(open + 1, close), body: code.slice(close + 1) };
}

/**
 * What carries the worker's signal, read from its second parameter: for a
 * destructured context, the local name of `signal` (or `abortSignal`) and
 * any rest element; for a context taken whole, the context itself and its
 * `.signal`.
 */
function signalCarriers(params) {
  const ctx = withoutDefault(topLevel(params)[1] || '');
  if (/^[\w$]+$/.test(ctx)) {
    return { names: new Set([ctx]), members: new Set([`${ctx}.signal`, `${ctx}?.signal`]) };
  }
  const names = new Set();
  if (ctx.startsWith('{') && ctx.endsWith('}')) {
    for (const entry of topLevel(ctx.slice(1, -1)).map(withoutDefault)) {
      if (entry.startsWith('...')) names.add(entry.slice(3).trim());
      else if (entry === 'signal' || entry === 'abortSignal') names.add(entry);
      else {
        const renamed = /^(?:signal|abortSignal)\s*:\s*([\w$]+)$/.exec(entry);
        if (renamed) names.add(renamed[1]);
      }
    }
  }
  return { names, members: new Set() };
}

/**
 * Does this argument carry the signal itself: a carrier, spread or whole, or
 * an object literal with one as a property value, a shorthand or a spread?
 * Anything computed from it (`signal.aborted`, `!signal`, a call) does not.
 */
function carries(argument, carriers) {
  const expression = argument.replace(/^\.\.\./, '').trim();
  if (carriers.names.has(expression) || carriers.members.has(expression)) return true;
  if (!expression.startsWith('{') || !expression.endsWith('}')) return false;
  return topLevel(expression.slice(1, -1)).some((entry) => {
    if (entry.startsWith('...')) return carries(entry, carriers);
    const property = /^([^:]+?)\s*:\s*([\s\S]+)$/.exec(entry);
    return property ? carries(property[2], carriers) : carriers.names.has(entry);
  });
}

/** Calls that only convert or log what they are given; the signal handed to one goes nowhere. */
const NO_OP_CALLEE = /(?:^|\.)(?:Boolean|String|Number|BigInt|isArray|stringify|keys|values|entries|log|info|debug|warn|error|trace)$/;

/**
 * The name called at `open`: the member chain before it, or — for Vitest's
 * `(0, __vite_ssr_import_0__.fn)(…)` — the last part of the parenthesised list.
 */
function calleeAt(body, open) {
  const before = body.slice(0, open).trimEnd();
  if (before.endsWith(')')) {
    const start = openingParen(before, before.length - 1);
    return start === -1 ? '' : topLevel(before.slice(start + 1, -1)).at(-1) || '';
  }
  const chain = /([\w$.?]+)$/.exec(before);
  return chain ? chain[1].replace(/\?\./g, '.') : '';
}

/**
 * Does the worker hand its signal to a call in its own code? A call's
 * parenthesis follows a name, a `]` or a `)`, and not a keyword such as
 * `if`; a parenthesis followed by `{` or `=>` opens a definition, not a call.
 * Each argument is read whole, nested calls included, and counts only when
 * it carries the signal itself to a call that is not a conversion or a log.
 */
function passesSignalOn(worker) {
  const { params, body } = splitFunction(codeOf(worker));
  const carriers = signalCarriers(params);
  if (carriers.names.size === 0 && carriers.members.size === 0) return false;
  for (let open = body.indexOf('('); open !== -1; open = body.indexOf('(', open + 1)) {
    const before = body.slice(0, open);
    if (!/[\w$)\]]\s*$/.test(before)) continue;
    if (/\b(?:if|while|for|switch|catch|return|typeof|await|async|function\s*\*?\s*[\w$]*)\s*$/.test(before)) continue;
    const close = closingParen(body, open);
    if (close === -1 || /^\s*(?:\{|=>)/.test(body.slice(close + 1))) continue;
    if (NO_OP_CALLEE.test(calleeAt(body, open))) continue;
    if (topLevel(body.slice(open + 1, close)).some((argument) => carries(argument, carriers))) return true;
  }
  return false;
}

/** Every job type the registry must hold, today fifteen plus noop. */
const EXPECTED_TYPES = [
  'batch-inspect',
  'build-newsletter-issue',
  'cosmos-export-container',
  'fetch-rss-feeds',
  'forge-article',
  'forge-from-url',
  'generate-listen-and-learn',
  'generate-podcast-transcript',
  'generate-podcast-transcript-from-recording',
  'noop',
  'publish-content',
  'publish-podcast-transcript',
  'refresh-tool-pricing',
  'speak-listen-and-learn-chapter',
  'transcribe-recording-upload',
  'voice-calibration',
];

/** Every module that registers them; lib/jobs.js registers noop itself. */
const EXPECTED_MODULES = [
  'functions/cloud-tools-jobs.js',
  'functions/cosmos-export.js',
  'functions/forge-jobs.js',
  'functions/inspect-jobs.js',
  'functions/listen-and-learn-jobs.js',
  'functions/podcast-jobs.js',
  'functions/publish-jobs.js',
  'functions/rss-jobs.js',
];

describe('the job modules and types are all found (#942)', () => {
  it('finds every module under src/ that registers a job type, and no other', () => {
    expect(jobModules.map(underSrc).sort()).toEqual(EXPECTED_MODULES);
  });

  it('the registry holds exactly the pinned types', () => {
    expect(listJobTypes().map(({ type }) => type).sort()).toEqual(EXPECTED_TYPES);
  });

  it('the scan sees an aliased import and a namespace import, and not a comment', () => {
    expect(registersJobTypes("import { registerJobType as reg } from '../lib/jobs.js';\nreg('x', {});")).toBe(true);
    expect(registersJobTypes("import * as jobs from './jobs.js';\njobs.registerJobType('x', {});")).toBe(true);
    expect(registersJobTypes("import { JOBS_QUEUE } from '../lib/jobs.js';\n// registerJobType('x')")).toBe(false);
    expect(registersJobTypes("import { registerJobType } from '../lib/lab-jobs.js';\nregisterJobType('x');")).toBe(
      false
    );
  });
});

describe('every registered worker passes its AbortSignal on (#942)', () => {
  it.each(EXPECTED_TYPES)('%s', (type) => {
    const { worker } = getJobType(type);
    expect(
      passesSignalOn(worker),
      `${type}'s worker never passes ctx.signal on: thread it into the calls that do its work`
    ).toBe(true);
  });

  it('the check fails a worker that only names the signal', () => {
    const destructuredUnused = async (payload, { context, signal }) => context.log(payload);
    const inAString = async (payload, { context }) => context.log(payload, 'signal');
    const inATemplate = async (payload, { context }) => context.log(`the signal ${payload}`);
    const inAComment = async (payload, { context }) => {
      // passes the signal along (it does not)
      /* run(payload, signal) */
      return context.log(payload);
    };
    const onlyTested = async (payload, { context, signal }) => {
      if (signal) return null;
      return context.log(payload);
    };
    // Checked once at the start and never handed to the work itself.
    const onlyCheckedFirst = async (payload, { context, signal }) => {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      return run(payload, { context });
    };
    for (const worker of [
      destructuredUnused,
      inAString,
      inATemplate,
      inAComment,
      onlyTested,
      onlyCheckedFirst,
    ]) {
      expect(passesSignalOn(worker), worker.toString()).toBe(false);
    }
  });

  it('and fails one that hands a call only something made from the signal, or a conversion or log of it', () => {
    const converted = async (payload, { signal }) => run(payload, { live: Boolean(signal) });
    const asText = async (payload, { signal }) => run(payload, String(signal));
    const logged = async (payload, { context, signal }) => {
      context.log(signal);
      return run(payload);
    };
    const itsFlag = async (payload, { signal }) => run(payload, signal.aborted);
    const itsFlagInAnObject = async (payload, { signal }) => run(payload, { aborted: signal?.aborted });
    const negated = async (payload, { signal }) => run(payload, !signal);
    const anotherField = async (payload, ctx) => run(payload, ctx.context);
    const aDefinitionNotACall = async (payload, { signal }) => {
      function inner(signal) {
        return signal;
      }
      return run(payload, inner);
    };
    for (const worker of [
      converted,
      asText,
      logged,
      itsFlag,
      itsFlagInAnObject,
      negated,
      anotherField,
      aDefinitionNotACall,
    ]) {
      expect(passesSignalOn(worker), worker.toString()).toBe(false);
    }
  });

  it('and passes one that hands it to a call', () => {
    const destructured = async (payload, { context, signal }) => run(payload, { context, signal });
    const fromContext = async (payload, ctx) => run(payload, ctx.signal);
    const intoALibrary = async function worker(payload, { signal }) {
      return createForge({ store: sample, signal }).run(payload);
    };
    for (const worker of [destructured, fromContext, intoALibrary]) {
      expect(passesSignalOn(worker), worker.toString()).toBe(true);
    }
  });

  it('and passes a thin wrapper that hands on the whole context, or the signal under another name', () => {
    const thinWrapper = (p, ctx) => run(p, ctx);
    const spread = (p, ctx) => run(p, { ...ctx, extra: 1 });
    const renamed = (p, { signal: stop }) => run(p, { abortSignal: stop });
    const rest = (p, { context, ...rest }) => run(p, { context, options: rest });
    const withDefault = async (payload, { signal } = {}) => run(payload, signal);
    for (const worker of [thinWrapper, spread, renamed, rest, withDefault]) {
      expect(passesSignalOn(worker), worker.toString()).toBe(true);
    }
  });
});

/** Named in the sample workers above, which are read, never run; it takes what they pass it. */
function run(payload, options) {
  return { payload, options };
}
/** As `run`: the library factory the sample worker hands its signal to. */
function createForge(options) {
  return { run, options };
}
const sample = {};

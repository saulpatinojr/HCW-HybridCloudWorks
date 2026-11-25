/**
 * The state of one findFileReads run, kept in one object (`an`) that the other
 * parts of the analysis are handed: the parsed modules, the caller's options,
 * the places found so far, and which functions a test can run.
 */
import { enclosingFunction, FUNCTION_TYPES } from './syntax.mjs';
import { loadModule } from './load-module.mjs';
import { markMutations } from './uses.mjs';
import { recordUse } from './record-uses.mjs';
import { commandLineOnly } from './command-line.mjs';

/** A file that mentions none of these cannot read a file, so failing to parse it is harmless. */
const MENTIONS_FILE_ACCESS = /\bfs\b|node:fs|readFile|readdir|existsSync|statSync|createReadStream|new URL\(/;

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Every call that runs `binding`'s function: by name, and through a parameter that was handed the function. */
export const callsOf = (binding) => [...binding.calls, ...binding.viaParams.flatMap((param) => param.calls)];

export const isUsedAsValue = (binding) => binding.escapes || binding.callbackUses.length > 0;

/** Parses every module, notes who uses which name, and works out which functions a test runs. */
export function createAnalysis({ modules, reportIn, cwd, resolveImport, probeFile }) {
  const an = { loaded: new Map(), references: [], reportIn, cwd, resolveImport, probeFile, runningFunctions: null, steps: 0, bindingCounter: 0 };
  loadAll(an, modules);
  const allFunctions = [];
  for (const module of an.loaded.values()) {
    for (const node of module.nodes) {
      if (FUNCTION_TYPES.has(node.type)) allFunctions.push(node);
      markMutations(node);
      recordUse(an, node);
    }
  }
  findRunningFunctions(an, allFunctions);
  return an;
}

function loadAll(an, modules) {
  for (const [file, entry] of modules) {
    const text = typeof entry === 'string' ? entry : entry.text;
    try {
      an.loaded.set(file, loadModule(file, text, typeof entry === 'string' ? undefined : (entry.ast ?? undefined)));
    } catch (error) {
      if (an.reportIn(file) && MENTIONS_FILE_ACCESS.test(text)) {
        an.references.push({
          file,
          line: error.lineNumber ?? 1,
          expression: '(whole file)',
          primitive: 'parse',
          results: [],
          unresolved: [`the file could not be parsed (${error.message}), so the files it reads are unknown`],
        });
      }
    }
  }
}

/** Whether a test runs `node`: it is not command-line-only code, and its function (if any) is one a test runs. */
export function runsInTests(an, node) {
  if (commandLineOnly(node)) return false;
  const fn = enclosingFunction(node);
  return !fn || an.runningFunctions.has(fn);
}

/** The functions a test runs: those in test files, then every function that something already running calls. */
function findRunningFunctions(an, allFunctions) {
  an.runningFunctions = new Set(allFunctions.filter((fn) => TEST_FILE.test(fn.file)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of allFunctions) {
      if (an.runningFunctions.has(fn) || !functionRuns(an, fn)) continue;
      an.runningFunctions.add(fn);
      changed = true;
    }
  }
}

/** A named function runs when something that runs calls it; a callback or method runs with the code around it. */
function functionRuns(an, fn) {
  const b = fn.$binding;
  if (!b) return runsInTests(an, fn);
  return b.escapes || callsOf(b).some((call) => runsInTests(an, call)) || b.callbackUses.some((use) => runsInTests(an, use.call));
}

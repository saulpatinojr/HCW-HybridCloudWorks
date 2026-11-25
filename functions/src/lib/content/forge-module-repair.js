/**
 * forge-module-repair.js — the forge's deterministic module repair, split
 * out of forge-pipeline.js (which re-exports repairModules). Nothing here
 * does I/O.
 *
 * The prompt asks for 4-8 modules, but models routinely overshoot (16+ has
 * been observed) or emit malformed modules. Repair fixes what can be fixed
 * mechanically: strip invalid align attributes, remove empty/broken modules,
 * and when the count still exceeds MAX_MODULES, unwrap the excess (from the
 * end of the document) into plain markdown so no prose is lost.
 */
import {
  MODULE_TAG_REGEX,
  KNOWN_MODULE_TYPES,
  JSON_MODULE_TYPES,
  MAX_MODULES,
} from '../cms/content-modules.js';
import { trimmed, unwrapModuleContent } from './forge-module-unwrap.js';
import { jsonModuleSemanticIssue } from './forge-module-checks.js';

const MAX_SPACERS = 2;
const MAX_PICTURE_PLACEHOLDERS = 2;
const VALID_ALIGNS = ['left', 'right', 'all'];

function buildModuleTag(type, align, content) {
  return `<module type="${type}"${align ? ` align="${align}"` : ''}>${content}</module>`;
}

/** Pass-1 verdict for one module: a replacement when it must stop being a module, else null. */
function repairModuleStructure(mod) {
  if (!KNOWN_MODULE_TYPES.has(mod.type)) {
    return {
      replacement: trimmed(mod.content),
      repair: `Unwrapped unknown module type "${mod.type}"`,
    };
  }
  if (JSON_MODULE_TYPES.has(mod.type)) return jsonModuleRepair(mod);
  if (!trimmed(mod.content)) {
    return { replacement: '', repair: `Removed empty ${mod.type} module` };
  }
  return null;
}

/** The pass-1 verdict for a module whose body must be JSON. */
function jsonModuleRepair(mod) {
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed(mod.content));
  } catch {
    return {
      replacement: unwrapModuleContent(mod.type, mod.content),
      repair: `Removed ${mod.type} module with invalid JSON`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      replacement: '',
      repair: `Removed ${mod.type} module whose JSON body is not an object`,
    };
  }
  const empty = emptyModuleRepair(mod.type, parsed);
  if (empty) return { replacement: '', repair: empty };
  const semanticIssue = jsonModuleSemanticIssue(mod.type, parsed);
  if (!semanticIssue) return null;
  return {
    replacement: unwrapModuleContent(mod.type, mod.content),
    repair: `Unwrapped ${mod.type} module ${semanticIssue}`,
  };
}

/** The note for a picture or links module with nothing in it, else null. */
function emptyModuleRepair(type, parsed) {
  if (type === 'picture' && !trimmed(parsed.imageUrl) && !trimmed(parsed.imagePrompt)) {
    return 'Removed picture module with neither imageUrl nor imagePrompt';
  }
  if (type === 'links' && !(Array.isArray(parsed.links) && parsed.links.length)) {
    return 'Removed links module with no links';
  }
  return null;
}

/**
 * Pass 2: thin decorative modules while over the cap. `run` is the repair
 * in progress: `{ modules, isStillModule, overCap, replacements, repairs }`.
 */
function thinDecorativeModules(run) {
  for (const [budget, matchType, label] of [
    [MAX_SPACERS, 'spacer', 'excess spacer module'],
    [MAX_PICTURE_PLACEHOLDERS, 'picture', 'excess picture placeholder module'],
  ]) {
    if (!run.overCap()) break;
    thinType(run, { budget, matchType, label });
  }
}

/** Unwrap the modules of one type past its budget, while still over the cap. */
function thinType(run, { budget, matchType, label }) {
  let seen = 0;
  for (const mod of run.modules) {
    if (!run.isStillModule(mod) || mod.type !== matchType) continue;
    seen += 1;
    if (seen <= budget) continue;
    run.replacements.set(mod, unwrapModuleContent(mod.type, mod.content));
    run.repairs.push(`Removed ${label}`);
    if (!run.overCap()) return;
  }
}

/** Every module tag in `source`, in order. */
function findModules(source) {
  const modules = [];
  MODULE_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = MODULE_TAG_REGEX.exec(source)) !== null) {
    modules.push({
      raw: match[0],
      index: match.index,
      type: match[1],
      align: match[2],
      content: match[3],
    });
  }
  return modules;
}

/** Pass 1: the structural verdict, then an invalid align, for each module. */
function repairEach({ modules, replacements, repairs }) {
  for (const mod of modules) {
    const verdict = repairModuleStructure(mod) ?? alignRepair(mod);
    if (!verdict) continue;
    replacements.set(mod, verdict.replacement);
    repairs.push(verdict.repair);
  }
}

/** A module with an align value that is not allowed keeps its body and loses the align. */
function alignRepair(mod) {
  if (!mod.align || VALID_ALIGNS.includes(mod.align)) return null;
  return {
    replacement: buildModuleTag(mod.type, null, mod.content),
    repair: `Dropped invalid align "${mod.align}" on a ${mod.type} module`,
  };
}

/** Pass 3: unwrap from the end of the document until the count is within the cap. */
function unwrapOverCap(run, maxModules) {
  const { modules, isStillModule, overCap, replacements, repairs } = run;
  for (let i = modules.length - 1; i >= 0 && overCap(); i -= 1) {
    const mod = modules[i];
    if (!isStillModule(mod)) continue;
    replacements.set(mod, unwrapModuleContent(mod.type, mod.content));
    repairs.push(`Unwrapped ${mod.type} module over the ${maxModules}-module cap`);
  }
}

/** The document with each replaced module swapped for its replacement. */
function rebuild(source, modules, replacements) {
  let rebuilt = '';
  let cursor = 0;
  for (const mod of modules) {
    rebuilt += source.slice(cursor, mod.index);
    const replacement = replacements.get(mod);
    rebuilt += replacement === undefined ? mod.raw : replacement;
    cursor = mod.index + mod.raw.length;
  }
  rebuilt += source.slice(cursor);
  return rebuilt.replace(/\n{3,}/g, '\n\n');
}

/**
 * Mechanically repair module defects so validateModules can pass.
 * @returns {{ markdown: string, repairs: string[] }}
 */
export function repairModules(markdown = '', maxModules = MAX_MODULES) {
  const source = String(markdown || '');
  const modules = findModules(source);
  if (!modules.length) return { markdown: source, repairs: [] };

  const repairs = [];
  const replacements = new Map(); // module -> replacement string ('' = remove)
  const isStillModule = (mod) => {
    const replacement = replacements.get(mod);
    return replacement === undefined || replacement.startsWith('<module ');
  };
  const overCap = () => modules.filter(isStillModule).length > maxModules;
  const run = { modules, isStillModule, overCap, replacements, repairs };

  repairEach(run);
  thinDecorativeModules(run);
  if (overCap()) unwrapOverCap(run, maxModules);

  if (!repairs.length) return { markdown: source, repairs: [] };
  return { markdown: rebuild(source, modules, replacements), repairs };
}

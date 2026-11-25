/**
 * The shared tools of the two log-line tests beside this file:
 * `no-raw-error-in-logs.test.js` (no error text in a log line, #1794) and
 * `no-ids-in-logs.test.js` (no stored id in a log line, #1802).
 *
 * Both read every module under functions/src as a syntax tree (parsed with
 * Vite's `parseSync`, which vitest brings), find the calls that write a log
 * line, and judge what each one is given. What a log line is, how a module is
 * parsed and walked, and how a list of kept sites is checked are the same
 * for both, so they live here once. This file is test code: nothing the
 * deployed functions run imports it.
 */
import { eachChild, isFunction, lastName, memberName, unwrap } from './ast-walk.test-helper.js';

export {
  eachChild,
  functionName,
  isFunction,
  lastName,
  memberName,
  parse,
  patternNames,
  scopeOf,
  unwrap,
} from './ast-walk.test-helper.js';
export { moduleTable, realTree, resolveImport, sourceFiles } from './module-table.test-helper.js';

export const LOG_METHODS = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace', 'verbose']);
export const LOG_RECEIVERS = new Set(['context', 'ctx', 'console', 'log', 'logger', 'invocationContext']);
/** A bare call to one of these names is an injected logger function. */
export const LOG_FUNCTION_NAMES = new Set(['log', 'logger', 'warn', 'logWarn']);

/** Calls whose result is a yes/no or a number, never the text they read. */
export const PREDICATES = new Set([
  'test',
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'search',
  'has',
  'localeCompare',
  'Boolean',
  'Number',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'isInteger',
]);

/**
 * Whether an expression is a logger method: `context.warn`, `ctx.log.error`,
 * with or without `?.` and `.bind(...)`.
 *
 * @param {object} callee - an ESTree expression
 * @returns {boolean}
 */
export function isLoggerMember(callee) {
  const c = unwrap(callee);
  if (c?.type === 'CallExpression' && lastName(c.callee) === 'bind') return isLoggerMember(unwrap(c.callee).object);
  if (c?.type === 'LogicalExpression') return isLoggerMember(c.left) || isLoggerMember(c.right);
  if (c?.type !== 'MemberExpression' || !LOG_METHODS.has(memberName(c))) return false;
  return LOG_RECEIVERS.has(lastName(c.object));
}

/**
 * Compare the sites found with the decisions listed.
 *
 * @param {ReturnType<typeof scanLogSources>} sites - what the scan found
 * @param {Array<{ site: string, why: string, times?: number }>} allowed - the list
 * @returns {{ unlisted: string[], stale: string[], misfiled: string[] }}
 */
export function judgeLogSites(sites, allowed) {
  const counts = new Map();
  for (const s of sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  const listed = new Map(allowed.map((entry) => [entry.site, entry]));
  const stale = [];
  const misfiled = [];
  for (const entry of allowed) {
    const found = counts.get(entry.site) ?? 0;
    if (found === 0) stale.push(entry.site);
    else if (found !== (entry.times ?? 1)) misfiled.push(`${entry.site} — listed ${entry.times ?? 1}, found ${found}`);
    if (!entry.why?.trim()) misfiled.push(`${entry.site} — needs a written reason`);
  }
  const unlisted = sites.filter((s) => !listed.has(s.key)).map((s) => `${s.file}:${s.line} — ${s.key}`);
  return { unlisted, stale, misfiled };
}

/**
 * Local names that alias a logger method: `const warn = context.warn`, `(l) => context.warn(l)`.
 *
 * @param {object} program - the parsed module
 * @returns {Set<string>}
 */
export function aliasesOf(program) {
  const out = new Set();
  /** Record a variable that aliases a logger method. */
  const collect = (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && aliasesLogger(unwrap(node.init))) {
      out.add(node.id.name);
    }
    eachChild(node, collect);
  };
  collect(program);
  return out;
}

/** Whether a variable's value is a logger method, or a one-line function around a log line. */
function aliasesLogger(init) {
  if (isLoggerMember(init)) return true;
  // `const info = (line) => log.log(`[x] ${line}`)`: a one-line function around a log line.
  let body = isFunction(init) ? init.body : null;
  if (body?.type === 'BlockStatement' && body.body.length === 1) {
    body = body.body[0].expression ?? body.body[0].argument ?? null;
  }
  const call = unwrap(body);
  return call?.type === 'CallExpression' && isLoggerMember(call.callee);
}

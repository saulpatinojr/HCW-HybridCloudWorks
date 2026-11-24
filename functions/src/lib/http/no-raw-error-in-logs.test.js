/**
 * No raw error text reaches a log line (#1794).
 *
 * Log lines under functions/ are content-free: no document ids, tokens, file
 * paths, route values or payloads. An error's `message` and `stack` are text
 * some library wrote, and can carry any of those. `no-raw-error-leaks.test.js`
 * beside this file keeps that text out of HTTP response bodies and leaves log
 * lines alone on purpose; this test is the other half. The accepted line is a
 * constant sentence plus `errorCode(err)` or `errorFacts(err)` from
 * `lib/http/error-response.js` (a code, a status, a class name, our own stack
 * frames: nothing that can hold a sentence).
 *
 * WHAT COUNTS AS A LOG LINE. Parsed with Vite's `parseSync` (vitest brings
 * it), so comments and strings are never mistaken for code:
 *
 *   - A call to `.log`, `.warn`, `.error`, `.info`, `.debug`, `.trace` or
 *     `.verbose` on something whose last name is `context`, `ctx`, `console`,
 *     `log`, `logger` or `invocationContext`: `context.warn(...)`,
 *     `ctx.log.error(...)`, `state.context.warn?.(...)`, `deps.log.error(...)`.
 *   - A call to a local alias of one (`const warn = context.warn`, or
 *     `(line) => context.warn(line)`), and of `a.warn || b.error`.
 *   - A bare call to a variable or parameter named `log`, `logger`, `warn` or
 *     `logWarn`, which is how an injected logger function is spelled here.
 *   - A LOG WRAPPER: a named function in the tree, at any depth, that hands one
 *     of its parameters to a log line as text
 *     (`function note(context, text) { context.log(text); }`, not
 *     `context.log(errorCode(error))`). A call to it is a log line for that
 *     argument, in the same file or through an import, followed to a fixpoint.
 *
 * WHAT COUNTS AS ERROR TEXT in an argument of one:
 *
 *   - `.message` or `.stack` read off anything, with or without `?.`.
 *   - A whole error: a `catch` parameter, a `.catch()` or `.then(_, onRejected)`
 *     parameter, or a variable named like one (`err`, `error`, `fooError`),
 *     given as it is, in a template literal, concatenated, stringified, or
 *     placed in an object, array or spread. Azure's logger prints an error
 *     object's message and stack, so the object is the text.
 *   - A field of an error other than the content-free ones (SAFE_ERROR_FIELDS:
 *     `code`, `status`, `statusCode`, `name`, ...): `err.body`, `err.details`.
 *   - An error handed to any function except the content-free describers
 *     (`errorCode`, `errorFacts`, `ownFrames`, `codeShaped`, imported from the
 *     door module; and the few local ones in LOCAL_DESCRIBERS, each held by
 *     `describerProblems` to returning nothing of the error's text) and
 *     yes/no tests (`.includes`, `Boolean`, ...), so the text cannot be
 *     laundered through a helper.
 *   - A variable that holds any of the above (`const msg = err.message`),
 *     followed through aliases, destructuring and reassignment in the same
 *     function scope.
 *
 * KNOWN LIMITS, each pinned by a self-test that fails when it is lifted:
 *
 *   - Text a function RETURNS is not followed into its caller's log line
 *     (`const result = await run(); context.log(JSON.stringify(result))`),
 *     unless the field read is itself `.message` or `.stack`. The timers'
 *     run summaries and the change feed's results are printed this way, so
 *     their `error` and `reason` fields carry `errorCode(err)` by hand.
 *   - Text stored on a property and read back (`summary.error = err.message;
 *     log(summary.error)`) is not followed; only variables are.
 *
 * THE ALLOWLIST. A site that keeps the text is listed in ALLOWED with a
 * written reason. A new site fails until it is converted or listed, and an
 * entry that no longer matches anything fails too. Keys are
 * `file › function › expression`, so a moved line never touches them.
 */
import { describe, expect, it } from 'vitest';
import {
  LOG_FUNCTION_NAMES,
  PREDICATES,
  aliasesOf as aliasesOfProgram,
  eachChild,
  functionName,
  isFunction,
  isLoggerMember,
  judgeLogSites,
  lastName,
  memberName,
  moduleTable,
  parse,
  patternNames,
  realTree,
  scopeOf,
  unwrap,
} from './log-scan.test-helper.js';

/** The module whose describers return a code, never a sentence. */
const DOOR_MODULE = 'lib/http/error-response.js';
/** Its exports that may be handed an error inside a log line. */
const SAFE_DESCRIBERS = new Set(['errorCode', 'errorFacts', 'ownFrames', 'codeShaped']);

const RAW_FIELDS = new Set(['message', 'stack']);
/** Fields of an error that name it without carrying what was said or sent. */
const SAFE_ERROR_FIELDS = new Set([
  'code',
  'status',
  'statusCode',
  'name',
  'retryAfterSeconds',
  'retryAfterMs',
  'retryAfterInMs',
  'substatus',
  'httpStatus',
  'transient',
  'retryable',
  'refused',
  'kind',
  'length',
]);
/**
 * Functions in the tree that describe an error for a log line without its
 * text, each with what it returns. A call to one is content-free, and
 * `describerProblems` below holds each to that: the scan's own taint logic
 * is run over what it returns, and one that reads the message to classify
 * it may return only fixed values.
 */
const LOCAL_DESCRIBERS = new Map([
  ['lib/addons/status.js::failureReason', "a sentence that module wrote, chosen by the error's code, class or status"],
  ['lib/labs/lab-starts.js::safeLogCode', 'a number from 100 to 599, else the word "error"'],
  ['lib/labs/visitor-session.js::errorKind', 'a three-digit status, a system code or a class name, else the word "error"'],
  ['lib/newsletter/admin-responses.js::errorMeta', "the error's class name and code, each held to the door's code shape"],
  [
    'lib/rss/feed-error-code.js::feedErrorCode',
    "HTTP_ and three digits, TIMEOUT, REDIRECTS or PARSE, chosen by the feed library's message shape; else the door's errorCode",
  ],
]);

/** A variable named like an error is treated as one. */
const ERROR_NAME = /^(e|err|error|ex|exc|exception|cause|rejection)$|(Error|Err)$/;

/** Whether a function is a rejection handler: `.catch(fn)` or `.then(_, fn)`. */
function isRejectionHandler(fn) {
  const call = fn.parent;
  if (call?.type !== 'CallExpression') return false;
  const method = lastName(call.callee);
  return (method === 'catch' && call.arguments[0] === fn) || (method === 'then' && call.arguments[1] === fn);
}

/**
 * One module's scopes: every declared name, and whether it holds an error or
 * an error's text. `tainted` is filled in by sitesOf to a fixpoint.
 *
 * @param {object} program - the parsed module
 * @returns {Map<object, Map<string, { kind: 'error' | 'text' | null }>>}
 */
function scopesOf(program) {
  const scopes = new Map();
  /** Declare a name in a scope; a stronger kind wins over none. */
  const declare = (scope, name, kind = null) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const table = scopes.get(scope);
    const existing = table.get(name);
    if (!existing) table.set(name, { kind });
    else if (kind && !existing.kind) existing.kind = kind;
  };
  /** Record what each node declares. */
  const visit = (node) => {
    if (isFunction(node)) {
      if (node.type === 'FunctionDeclaration' && node.id) declare(scopeOf(node), node.id.name);
      node.params.forEach((param, index) => {
        const rejected = index === 0 && isRejectionHandler(node);
        for (const { name, from } of patternNames(param)) {
          if (rejected) declare(node, name, from === null ? 'error' : RAW_FIELDS.has(from) ? 'text' : null);
          else declare(node, name);
        }
      });
    } else if (node.type === 'CatchClause' && node.param) {
      for (const { name, from } of patternNames(node.param)) {
        declare(node, name, from === null ? 'error' : SAFE_ERROR_FIELDS.has(from) ? null : 'text');
      }
    } else if (node.type === 'VariableDeclarator') {
      for (const { name } of patternNames(node.id)) declare(scopeOf(node), name);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      declare(scopeOf(node), node.id.name);
    } else if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) declare(program, spec.local.name);
    }
    eachChild(node, visit);
  };
  visit(program);
  return scopes;
}

/**
 * Parse a tree of modules and build the scan's tools over it: what error
 * text an expression carries (`taint`), how it spreads through variables
 * (`settle`), and which calls are log lines (`loggedArguments`).
 *
 * @param {Record<string, string>} modules - tree key → source
 * @returns {object} the parsed modules and the tools
 */
function analyse(modules) {
  const parsed = Object.entries(modules).map(([file, source]) => {
    const program = parse(file, source);
    return { file, source, program, scopes: scopesOf(program), table: moduleTable(file, program) };
  });
  const byFile = new Map(parsed.map((m) => [m.file, m]));
  /** `file::function` → the parameter positions it hands to a log line. */
  const wrappers = new Map();

  /** Look a name up through the enclosing scopes. */
  const lookup = (m, node, name) => {
    for (let scope = scopeOf(node); scope; scope = scope.type === 'Program' ? null : scopeOf(scope)) {
      const found = m.scopes.get(scope)?.get(name);
      if (found) return { ...found, scope, entry: found };
    }
    return null;
  };

  /** Whether an identifier resolves to an import of a content-free describer. */
  const isSafeDescriber = (m, callee) => {
    const c = unwrap(callee);
    if (c?.type !== 'Identifier') return false;
    const imported = m.table.imports.get(c.name);
    return Boolean(imported) && imported.from === DOOR_MODULE && SAFE_DESCRIBERS.has(imported.name);
  };

  /**
   * What error text an expression carries: 'text' (an error's words), 'error'
   * (a whole error) or null.
   */
  const taint = (m, node) => {
    const n = unwrap(node);
    if (!n) return null;
    /** The strongest taint among several expressions. */
    const any = (nodes) => {
      let found = null;
      for (const child of nodes) {
        const kind = taint(m, child);
        if (kind === 'text') return 'text';
        found = found ?? kind;
      }
      return found;
    };
    switch (n.type) {
      case 'Identifier': {
        const bound = lookup(m, n, n.name);
        if (bound?.kind) return bound.kind;
        if (ERROR_NAME.test(n.name)) return 'error';
        return null;
      }
      case 'MemberExpression': {
        const name = memberName(n);
        if (name && RAW_FIELDS.has(name)) return 'text';
        if (name && SAFE_ERROR_FIELDS.has(name)) return null;
        // Any other field of an error is still the error's content (`err.response.data`);
        // a field of a string is not the string.
        return taint(m, n.object) === 'error' ? 'error' : null;
      }
      case 'TemplateLiteral':
        return any(n.expressions) ? 'text' : null;
      case 'TaggedTemplateExpression':
        return any(n.quasi.expressions) ? 'text' : null;
      case 'BinaryExpression':
        return n.operator === '+' && any([n.left, n.right]) ? 'text' : null;
      case 'LogicalExpression':
        return any([n.left, n.right]);
      case 'ConditionalExpression':
        return any([n.consequent, n.alternate]);
      case 'AssignmentExpression':
        return taint(m, n.right);
      case 'SequenceExpression':
        return taint(m, n.expressions.at(-1));
      case 'SpreadElement':
        return taint(m, n.argument);
      case 'ArrayExpression':
        return any(n.elements.filter(Boolean)) ? 'text' : null;
      case 'ObjectExpression':
        return any(n.properties.map((p) => (p.type === 'SpreadElement' ? p : p.value))) ? 'text' : null;
      case 'NewExpression':
        return any(n.arguments) ? 'text' : null;
      case 'CallExpression': {
        if (isSafeDescriber(m, n.callee)) return null;
        if (LOCAL_DESCRIBERS.has(wrapperKey(m, n.callee))) return null;
        const method = lastName(n.callee);
        if (method && PREDICATES.has(method)) return null;
        const callee = unwrap(n.callee);
        const receiver = callee?.type === 'MemberExpression' ? [callee.object] : [];
        return any([...receiver, ...n.arguments]) ? 'text' : null;
      }
      default:
        return null;
    }
  };

  /** Spread taint through declarations and assignments until nothing changes. */
  const settle = (m) => {
    let changed = true;
    /** Mark a declared name, reporting whether that was news. */
    const mark = (node, name, kind) => {
      const bound = lookup(m, node, name);
      if (!bound || bound.entry.kind === 'text' || bound.entry.kind === kind) return;
      bound.entry.kind = bound.entry.kind === 'error' && kind !== 'text' ? 'error' : kind;
      changed = true;
    };
    /** Apply one declarator or assignment. */
    const visit = (node) => {
      if (node.type === 'VariableDeclarator' && node.init) {
        const kind = taint(m, node.init);
        if (kind) {
          for (const { name, from } of patternNames(node.id)) {
            if (from === null) mark(node, name, kind);
            else if (kind === 'text' || !SAFE_ERROR_FIELDS.has(from)) mark(node, name, 'text');
          }
        }
      } else if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        const kind = taint(m, node.right);
        if (kind) mark(node, node.left.name, node.operator === '=' ? kind : 'text');
      }
      eachChild(node, visit);
    };
    for (let round = 0; changed && round < 20; round += 1) {
      changed = false;
      visit(m.program);
    }
  };

  /** Local names that alias a logger method (the shared helper, by module). */
  const aliasesOf = (m) => aliasesOfProgram(m.program);

  /** The wrapper key a callee resolves to, in this module or through an import. */
  const wrapperKey = (m, callee) => {
    const c = unwrap(callee);
    if (c?.type !== 'Identifier') return null;
    if (m.table.functions.has(c.name) || m.table.nested.has(c.name)) return `${m.file}::${c.name}`;
    const imported = m.table.imports.get(c.name);
    if (!imported?.from) return null;
    const local = byFile.get(imported.from)?.table.exports.get(imported.name);
    return local ? `${imported.from}::${local}` : null;
  };

  /**
   * The arguments of a call that end up in a log line, or null when the call
   * is not a log line.
   */
  const loggedArguments = (m, call, aliases) => {
    const callee = unwrap(call.callee);
    if (isLoggerMember(callee)) return call.arguments;
    if (callee?.type === 'Identifier') {
      if (aliases.has(callee.name)) return call.arguments;
      const slots = wrappers.get(wrapperKey(m, callee));
      if (slots) return call.arguments.filter((_, index) => slots.has(index));
      // An injected logger function, unless the name is a function this module defines or imports.
      if (LOG_FUNCTION_NAMES.has(callee.name) && !m.table.functions.has(callee.name) && !m.table.imports.has(callee.name)) {
        return call.arguments;
      }
    }
    return null;
  };

  /** Find the functions that hand a parameter to a log line, to a fixpoint. */
  const findWrappers = () => {
    for (let round = 0; round < 8; round += 1) {
      const before = [...wrappers.values()].reduce((sum, slots) => sum + slots.size, 0);
      for (const m of parsed) {
        const aliases = aliasesOf(m);
        for (const [name, fn] of [...m.table.functions, ...m.table.nested]) {
          const params = fn.params.map((param) => (param.type === 'AssignmentPattern' ? param.left : param));
          const table = m.scopes.get(fn);
          /**
           * Note each parameter that would put an error's text in a logged
           * argument if it were handed an error: `text` in `log.warn(text)`,
           * not `error` in `log.warn(errorCode(error))` or `error.status`.
           */
          const visit = (node) => {
            if (node.type === 'CallExpression') {
              for (const arg of loggedArguments(m, node, aliases) ?? []) {
                if (taint(m, arg)) continue;
                params.forEach((param, index) => {
                  const entry = param.type === 'Identifier' ? table?.get(param.name) : null;
                  if (!entry || entry.kind) return;
                  entry.kind = 'error';
                  const carried = taint(m, arg);
                  entry.kind = null;
                  if (!carried) return;
                  const key = `${m.file}::${name}`;
                  if (!wrappers.has(key)) wrappers.set(key, new Set());
                  wrappers.get(key).add(index);
                });
              }
            }
            eachChild(node, visit);
          };
          visit(fn);
        }
      }
      if ([...wrappers.values()].reduce((sum, slots) => sum + slots.size, 0) === before) break;
    }
  };

  return { parsed, byFile, taint, settle, aliasesOf, loggedArguments, findWrappers, isSafeDescriber };
}

/**
 * Scan a tree of modules for error text in log lines.
 *
 * @param {Record<string, string>} modules - tree key → source
 * @returns {Array<{ key: string, file: string, line: number, what: string }>}
 */
export function scanLogSources(modules) {
  const { parsed, taint, settle, aliasesOf, loggedArguments, findWrappers } = analyse(modules);
  for (const m of parsed) settle(m);
  findWrappers();

  const sites = [];
  for (const m of parsed) {
    if (m.file === DOOR_MODULE) continue;
    const aliases = aliasesOf(m);
    /** Report each logged argument that carries error text. */
    const visit = (node) => {
      if (node.type === 'CallExpression') {
        for (const arg of loggedArguments(m, node, aliases) ?? []) {
          if (!taint(m, arg)) continue;
          const what = m.source.slice(arg.start, arg.end).replace(/\s+/g, ' ');
          sites.push({
            key: `${m.file} › ${functionName(node)} › ${what}`,
            file: m.file,
            start: arg.start,
            end: arg.end,
            line: m.source.slice(0, node.start).split('\n').length,
            what,
          });
        }
      }
      eachChild(node, visit);
    };
    visit(m.program);
  }
  return sites;
}

/**
 * The body of the `group`-th capturing group of a regular expression's
 * source, or null when there is no such group.
 *
 * @param {string} pattern - the source of a regular expression
 * @param {number} group - 1 for the first capturing group
 * @returns {string | null}
 */
function captureGroupBody(pattern, group) {
  const open = [];
  let seen = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') i += 1;
    else if (inClass) inClass = ch !== ']';
    else if (ch === '[') inClass = true;
    else if (ch === '(') {
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` do not capture; `(` and `(?<name>` do.
      const capturing = pattern[i + 1] !== '?' || /^\?<[^=!]/.test(pattern.slice(i + 1, i + 4));
      if (capturing) seen += 1;
      open.push(capturing && seen === group ? i : -1);
    } else if (ch === ')') {
      const start = open.pop();
      if (start >= 0) return pattern.slice(start + 1, i);
    }
  }
  return null;
}

/** A capturing group that can only ever hold a few digits: `\d{3}`, `[0-9]{1,3}`. */
const DIGITS_ONLY_GROUP = /^(?:\\d|\[0-9\])\{\d(?:,\d)?\}$/;

/**
 * What is wrong with the LOCAL_DESCRIBERS list. A describer is a function
 * the scan trusts to turn an error into something a log line may carry, so
 * each one is held to one of two rules:
 *
 *   - A describer that never reads the error's `message` or `stack`: the
 *     scan's own taint logic is run over everything it returns, with its
 *     parameters taken to be errors. `String(error)`, `error.toString()`,
 *     `JSON.stringify(error)`, a template or a concatenation holding the
 *     error or a field of it outside SAFE_ERROR_FIELDS, and the error itself
 *     are all refused, the same as in a log line.
 *   - A describer that READS the message or stack (to classify it), by a
 *     member read or by destructuring: every `return` must be a fixed value.
 *     That is a literal, a member of a fixed table of literals, a door
 *     describer's answer (`errorCode(error)`), or a template of a fixed
 *     prefix and a regular expression's capture of a few digits
 *     (`HTTP_${match[1]}` from `/^Status code (\d{3})$/`). Nothing computed
 *     from the text any other way may leave the function.
 *
 * @param {Record<string, string>} modules - tree key → source
 * @param {Iterable<string>} [keys] - `file::function` entries to check
 * @returns {string[]}
 */
export function describerProblems(modules, keys = LOCAL_DESCRIBERS.keys()) {
  const wanted = [...keys];
  const files = new Set(wanted.map((key) => key.split('::')[0]));
  const { byFile, taint, settle, isSafeDescriber } = analyse(
    Object.fromEntries(Object.entries(modules).filter(([file]) => files.has(file)))
  );
  const problems = [];
  for (const key of wanted) {
    const [file, name] = key.split('::');
    const m = byFile.get(file);
    const fn = m?.table.functions.get(name);
    if (!fn) {
      problems.push(`${key} — no such top-level function`);
      continue;
    }
    /** The text of a node, on one line, for a message. */
    const text = (node) => m.source.slice(node.start, node.end).replace(/\s+/g, ' ');

    // Whatever a describer is handed is an error.
    for (const { name: param, from } of fn.params.flatMap((p) => patternNames(p))) {
      const entry = m.scopes.get(fn)?.get(param);
      if (entry) entry.kind = from === null ? 'error' : SAFE_ERROR_FIELDS.has(from) ? null : 'text';
    }
    settle(m);

    const reads = [];
    const returns = fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement' ? [fn.body] : [];
    /** Collect the raw reads anywhere inside, and the returns of the function itself. */
    const visit = (node, own) => {
      if (node.type === 'MemberExpression' && RAW_FIELDS.has(memberName(node))) reads.push(`.${memberName(node)}`);
      if (node.type === 'ObjectPattern') {
        for (const { from } of patternNames(node)) if (RAW_FIELDS.has(from)) reads.push(`{ ${from} }`);
      }
      if (own && node.type === 'ReturnStatement' && node.argument) returns.push(node.argument);
      eachChild(node, (child) => visit(child, own && !isFunction(child)));
    };
    eachChild(fn, (child) => visit(child, !isFunction(child)));

    /** The declaration of a name inside the describer or at the top of its module. */
    const declarationOf = (identifier) => {
      let found = null;
      /** Find the declarator of that name. */
      const search = (node) => {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === identifier) found = node;
        eachChild(node, search);
      };
      search(fn);
      if (found) return found;
      for (const statement of m.program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type === 'VariableDeclaration') declaration.declarations.forEach(search);
      }
      return found;
    };
    /** Whether an expression is a string, number, boolean or null written in the source. */
    const isLiteral = (node) =>
      (node?.type === 'Literal' && !node.regex) || (node?.type === 'TemplateLiteral' && node.expressions.length === 0);
    /** Whether a name is a table of literals declared with `const`: an object or an array of them. */
    const isFixedTable = (identifier) => {
      const declarator = declarationOf(identifier);
      if (declarator?.parent.kind !== 'const') return false;
      let init = unwrap(declarator.init);
      if (init?.type === 'CallExpression' && lastName(init.callee) === 'freeze') init = unwrap(init.arguments[0]);
      if (init?.type === 'ObjectExpression') return init.properties.every((p) => p.type === 'Property' && isLiteral(unwrap(p.value)));
      if (init?.type === 'ArrayExpression') return init.elements.every((el) => isLiteral(unwrap(el)));
      return false;
    };
    /** Whether an expression is `match[n]` for a capture that can only hold a few digits. */
    const isDigitCapture = (node) => {
      const n = unwrap(node);
      if (n?.type !== 'MemberExpression' || !n.computed || !Number.isInteger(n.property.value)) return false;
      const object = unwrap(n.object);
      const call = object?.type === 'Identifier' ? unwrap(declarationOf(object.name)?.init) : null;
      if (call?.type !== 'CallExpression') return false;
      const callee = unwrap(call.callee);
      const method = callee?.type === 'MemberExpression' ? memberName(callee) : null;
      const regex = method === 'exec' ? unwrap(callee.object) : method === 'match' ? unwrap(call.arguments[0]) : null;
      const body = regex?.regex ? captureGroupBody(regex.regex.pattern, n.property.value) : null;
      return body !== null && DIGITS_ONLY_GROUP.test(body);
    };
    /** Whether a returned expression is a fixed value, whatever the message said. */
    const isFixed = (node) => {
      const n = unwrap(node);
      if (isLiteral(n)) return true;
      if (n.type === 'Identifier') return n.name === 'undefined';
      if (n.type === 'ConditionalExpression') return isFixed(n.consequent) && isFixed(n.alternate);
      if (n.type === 'LogicalExpression') return isFixed(n.left) && isFixed(n.right);
      if (n.type === 'CallExpression') return isSafeDescriber(m, n.callee);
      if (n.type === 'MemberExpression') {
        const table = unwrap(n.object);
        return table?.type === 'Identifier' && isFixedTable(table.name);
      }
      if (n.type === 'TemplateLiteral') {
        const [prefix, suffix] = n.quasis.map((q) => q.value.cooked);
        return n.expressions.length === 1 && /^[A-Z][A-Z0-9_]{0,15}$/.test(prefix) && suffix === '' && isDigitCapture(n.expressions[0]);
      }
      return false;
    };

    if (reads.length) {
      for (const returned of returns) {
        if (!isFixed(returned)) {
          problems.push(
            `${key} — reads ${reads[0]} and returns \`${text(returned)}\`, which is not a fixed value (a literal, a member of a table of literals, a door describer's answer, or a prefix and a capture of digits)`
          );
        }
      }
    } else {
      for (const returned of returns) {
        if (taint(m, returned)) problems.push(`${key} — returns \`${text(returned)}\`, which carries the error's own text`);
      }
    }
  }
  return problems;
}

/**
 * The log lines that keep an error's text, each with its reason. Empty on
 * purpose: convert a new line to `errorCode(err)` or `errorFacts(err)` rather
 * than list it here.
 */
const ALLOWED = [];

describe('no raw error text in log lines (#1794)', () => {
  it('scans every module under functions/src, and every log line is content-free or decided', { timeout: 60_000 }, () => {
    const modules = realTree();
    expect(Object.keys(modules).length).toBeGreaterThan(300);
    expect(modules[DOOR_MODULE]).toBeDefined();
    const { unlisted, stale, misfiled } = judgeLogSites(scanLogSources(modules), ALLOWED);
    expect(
      unlisted,
      `a log line carries an error's own text; log errorCode(err) or errorFacts(err) from lib/http/error-response.js instead:\n${unlisted.join('\n')}`,
    ).toEqual([]);
    expect(stale, `allowlist entries that no longer match anything:\n${stale.join('\n')}`).toEqual([]);
    expect(misfiled, `allowlist entries that are wrong:\n${misfiled.join('\n')}`).toEqual([]);
  });

  it('every local describer exists and returns nothing of an error\'s own text', () => {
    expect(describerProblems(realTree())).toEqual([]);
  });
});

describe('the log scan itself', () => {
  const DOOR = "import { errorCode, errorFacts } from './http/error-response.js';";
  /** The flagged expressions a one-module tree yields. */
  const found = (source, file = 'lib/x.js') => scanLogSources({ [file]: source }).map((s) => s.what);
  /** A module whose catch block is the given source. */
  const caught = (body, head = '') => `${head}
    export async function handle(request, context) {
      try { await work(); } catch (oops) { ${body} }
    }`;

  it('finds .message and .stack in a log line, with or without ?., under any name', () => {
    expect(found(caught('context.error(`failed: ${oops.message}`);'))).toEqual(['`failed: ${oops.message}`']);
    expect(found(caught('context.warn?.(`failed: ${oops?.message || oops}`);'))).toEqual([
      '`failed: ${oops?.message || oops}`',
    ]);
    expect(found(caught('context.log(oops?.stack);'))).toEqual(['oops?.stack']);
    expect(found('export const f = (log, reply) => log.warn(reply.error.message);')).toEqual(['reply.error.message']);
  });

  it('finds a whole error: given as it is, stringified, concatenated, or placed in an object', () => {
    expect(found(caught("context.error('failed:', oops);"))).toEqual(['oops']);
    expect(found(caught('context.error(String(oops));'))).toEqual(['String(oops)']);
    expect(found(caught("context.error('failed: ' + oops);"))).toEqual(["'failed: ' + oops"]);
    expect(found(caught('context.error(JSON.stringify(oops));'))).toEqual(['JSON.stringify(oops)']);
    expect(found(caught("context.error('failed', { id: 1, error: oops });"))).toEqual(['{ id: 1, error: oops }']);
    // A variable named like an error counts without a catch in sight.
    expect(found("export const f = (context, hookError) => context.warn('hook', hookError);")).toEqual(['hookError']);
  });

  it('finds a call spread over several lines, which a line search cannot', () => {
    const source = caught(`context.error(
        'the write failed',
        {
          detail: oops
            .message,
        }
      );`);
    expect(found(source)).toHaveLength(1);
  });

  it('follows an alias, a destructured message, a reassignment and a .catch() parameter', () => {
    expect(found(caught('const why = oops.message; context.warn(`failed: ${why}`);'))).toEqual(['`failed: ${why}`']);
    expect(found(caught('const { message } = oops; context.warn(message);'))).toEqual(['message']);
    expect(found(caught("let why = ''; why = String(oops); context.warn(why);"))).toEqual(['why']);
    expect(found('export const f = (context) => work().catch((nope) => context.warn(`x ${nope}`));')).toEqual([
      '`x ${nope}`',
    ]);
    expect(found('export const f = (context) => work().then(null, (nope) => context.warn(nope));')).toEqual(['nope']);
  });

  it('reads a field of an error as its content, except the content-free ones', () => {
    expect(found(caught('context.warn(`x ${oops.body}`);'))).toEqual(['`x ${oops.body}`']);
    expect(found(caught('context.warn(`x ${oops.response.data}`);'))).toEqual(['`x ${oops.response.data}`']);
    expect(found(caught('context.warn(`x ${oops.code} ${oops?.status} ${oops.name} ${oops.response?.status}`);'))).toEqual([]);
  });

  it('accepts the door\'s describers, and nothing that only looks like them', () => {
    expect(found(caught('context.error(`failed: ${errorCode(oops)}`);', DOOR))).toEqual([]);
    expect(found(caught("context.error('failed:', errorFacts(oops));", DOOR))).toEqual([]);
    // The same name, not imported from the door: scanned like any helper.
    expect(found(caught('context.error(errorCode(oops));', 'const errorCode = (e) => e.message;'))).toEqual([
      'errorCode(oops)',
    ]);
    // An error handed to any other function inside a log line is the text.
    expect(found(caught('context.error(describe(oops));'))).toEqual(['describe(oops)']);
    // A yes/no about the text is not the text.
    expect(found(caught("context.warn(`timeout: ${oops.message.includes('timeout')}`);"))).toEqual([]);
    expect(found(caught("context.warn(oops.code === 'X' ? 'refused' : 'failed');"))).toEqual([]);
  });

  it('knows a log line by its receiver, an alias, a one-line function and an injected logger', () => {
    expect(found(caught('ctx.log.error(oops.message);'))).toEqual(['oops.message']);
    expect(found(caught('state.context.warn?.(oops.message);'))).toEqual(['oops.message']);
    expect(found(caught('deps.log?.warn?.(oops.message);'))).toEqual(['oops.message']);
    expect(found(caught('console.error(oops);'))).toEqual(['oops']);
    expect(found(caught('const warn = context.warn.bind(context); warn(oops.message);'))).toEqual(['oops.message']);
    expect(found(caught('const info = (line) => context.log(`[x] ${line}`); info(oops.message);'))).toEqual([
      'oops.message',
    ]);
    expect(found('export const f = async ({ log }) => { try { await work(); } catch (e) { log(`x ${e.message}`); } };')).toEqual([
      '`x ${e.message}`',
    ]);
    // Not a log line: the text goes somewhere this test does not judge.
    expect(found(caught('results.push(oops.message); throw new Error(oops.message);'))).toEqual([]);
  });

  it('follows a log wrapper: in the file, nested, and through an import', () => {
    const wrapper = 'function note(context, text) { context.warn(`[x] ${text}`); }';
    expect(found(caught('note(context, oops.message);', wrapper))).toEqual(['oops.message']);
    expect(found(caught('const note = (text) => { count += 1; context.warn(text); }; note(String(oops));'))).toEqual([
      'String(oops)',
    ]);
    const tree = {
      'lib/note.js': `export ${wrapper}`,
      'lib/x.js': caught('note(context, oops.message);', "import { note } from './note.js';"),
    };
    expect(scanLogSources(tree).map((s) => s.key)).toEqual(['lib/x.js › handle › oops.message']);
    // A helper that logs only the error's code is not a wrapper: the error may be handed to it.
    const safe = `${DOOR}\nfunction refuse(context, error) { context.warn(\`refused (\${errorCode(error)}, \${error.status})\`); throw error; }`;
    expect(found(caught('refuse(context, oops);', safe))).toEqual([]);
  });

  it('KNOWN LIMIT: text a function returns is not followed into the caller\'s log line', () => {
    const source = `
      async function run() { try { await work(); } catch (oops) { return { reason: oops.message }; } }
      export async function timer(context) { const result = await run(); context.log(JSON.stringify(result)); }`;
    expect(found(source)).toEqual([]);
  });

  it('KNOWN LIMIT: text stored on a property and read back is not followed', () => {
    expect(found(caught('const summary = {}; summary.error = oops.message; context.log(summary.error);'))).toEqual([]);
  });

  it('judges the list: unlisted, stale, miscounted, and without a reason', () => {
    const sites = scanLogSources({ 'lib/x.js': caught('context.warn(oops.message); context.warn(oops.message);') });
    const site = 'lib/x.js › handle › oops.message';
    expect(judgeLogSites(sites, []).unlisted).toHaveLength(2);
    expect(judgeLogSites(sites, [{ site, why: 'kept for a reason', times: 2 }])).toEqual({ unlisted: [], stale: [], misfiled: [] });
    expect(judgeLogSites(sites, [{ site, why: 'kept for a reason' }]).misfiled).toEqual([`${site} — listed 1, found 2`]);
    expect(judgeLogSites(sites, [{ site, why: ' ', times: 2 }]).misfiled).toEqual([`${site} — needs a written reason`]);
    expect(judgeLogSites([], [{ site, why: 'kept for a reason' }]).stale).toEqual([site]);
  });

  /** The problems of one describer, `describe`, written as the given source. */
  const describerFaults = (source, head = '') =>
    describerProblems({ 'lib/a.js': `${head}\n${source}` }, ['lib/a.js::describe']).map((p) => p.split(' — ')[1]);

  it('refuses a local describer that is missing', () => {
    const modules = { 'lib/a.js': 'export const kind = (e) => e.code;' };
    expect(describerProblems(modules, ['lib/a.js::kind'])).toEqual([]);
    expect(describerProblems(modules, ['lib/a.js::gone', 'lib/b.js::kind'])).toEqual([
      'lib/a.js::gone — no such top-level function',
      'lib/b.js::kind — no such top-level function',
    ]);
  });

  it('runs the taint logic over what a describer returns: the error, its text and its other fields are refused', () => {
    /** One leaking return, and the fault it must raise. */
    const leaks = (returned, body = '') =>
      expect(describerFaults(`export function describe(error) { ${body} return ${returned}; }`)).toEqual([
        `returns \`${returned}\`, which carries the error's own text`,
      ]);
    leaks('String(error)');
    leaks('error.toString()');
    leaks('JSON.stringify(error)');
    leaks('`failed: ${error}`');
    leaks("'failed: ' + error");
    leaks('`${error?.body}`');
    leaks('error.response.data');
    leaks('error');
    leaks('text', 'const text = String(error);');
    leaks('`${body}`', 'const { body } = error;');
    // An arrow with no braces is its own return, and a destructured parameter is still the error's.
    expect(describerFaults('export const describe = (e) => `${e}`;')).toHaveLength(1);
    expect(describerFaults('export const describe = ({ details }) => details;')).toHaveLength(1);
    // The content-free fields, and anything held to a shape by a yes/no test, pass.
    expect(describerFaults('export const describe = (e) => `${e.name} ${e?.code} ${e.status}`;')).toEqual([]);
    expect(
      describerFaults(
        "export function describe(error) { const kind = String(error?.code ?? error?.name ?? 'error'); return /^[A-Z]+$/.test(kind) ? kind : 'error'; }"
      )
    ).toEqual([]);
  });

  it('refuses the describer the old check let through: a destructured message, the whole error and a field', () => {
    const faults = describerFaults(
      'export function describe(error) { const { message } = error; return `${message} ${String(error)} ${error?.body}`; }'
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/^reads \{ message \} and returns .* which is not a fixed value/);
  });

  it('lets a describer read the message to classify it only when every return is a fixed value', () => {
    const door = "import { errorCode } from './http/error-response.js';";
    const classifier = `
      const WORDS = Object.freeze({ gone: 'the page is gone', slow: 'no answer in time' });
      export function describe(error) {
        const message = typeof error?.message === 'string' ? error.message : '';
        const status = /^Status code (\\d{3})$/.exec(message);
        if (status) return \`HTTP_\${status[1]}\`;
        if (/timed out/.test(message)) return 'TIMEOUT';
        if (message.includes('gone')) return WORDS.gone;
        if (error.stack?.includes('slow')) return WORDS[error.code];
        return error?.code === 'X' ? 'REFUSED' : errorCode(error);
      }`;
    expect(describerFaults(classifier, door)).toEqual([]);

    /** A reading describer with one return, and how many faults it raises. */
    const reading = (returned, body = '') =>
      describerFaults(`export function describe(error) { const text = error.message; ${body} return ${returned}; }`, door);
    // Any part of the text, however it is cut or wrapped.
    expect(reading('text')).toHaveLength(1);
    expect(reading('text.slice(0, 10)')).toHaveLength(1);
    expect(reading('`PREFIX_${text}`')).toHaveLength(1);
    expect(reading('error.message')).toHaveLength(1);
    // A field the scan calls content-free is still not fixed once the message has been read.
    expect(reading('error.code')).toHaveLength(1);
    // A capture that is not digits only, an unbounded one, and a template with more than a prefix.
    expect(reading('`HTTP_${m[1]}`', 'const m = /^Status (.+)$/.exec(text);')).toHaveLength(1);
    expect(reading('`HTTP_${m[1]}`', 'const m = /^Status (\\d+)$/.exec(text);')).toHaveLength(1);
    expect(reading('`HTTP_${m[2]}`', 'const m = /^(?:a|b) (\\w+) (?<n>.*) (\\d{3})$/.exec(text);')).toHaveLength(1);
    expect(reading('`HTTP_${m[1]} for ${text}`', 'const m = /^Status (\\d{3})$/.exec(text);')).toHaveLength(1);
    expect(reading('`http ${m[1]}`', 'const m = /^Status (\\d{3})$/.exec(text);')).toHaveLength(1);
    // A table that is not all literals, or not a const, is not a fixed table.
    expect(reading('TABLE.a', 'const TABLE = { a: text };')).toHaveLength(1);
    expect(reading('TABLE.a', "let TABLE = { a: 'x' };")).toHaveLength(1);
    // The same name as a door describer, not imported from the door.
    expect(
      describerFaults('const errorCode = (e) => e.message;\nexport function describe(error) { void error.stack; return errorCode(error); }')
    ).toHaveLength(1);
    // The good shapes: a later group, digits by [0-9], `.match`, and the door's answer.
    // An escaped or bracketed parenthesis and a `(?:` are not groups, so the count still lands on the digits.
    expect(reading('`HTTP_${m[2]}`', 'const m = /^(?:a|b) \\((\\w+)\\) [(] (\\d{3})$/.exec(text);')).toEqual([]);
    expect(reading('`HTTP_${m[1]}`', 'const m = /^(?:a|b) \\((\\w+)\\) [(] (\\d{3})$/.exec(text);')).toHaveLength(1);
    expect(reading('`CODE_${m[1]}`', 'const m = text.match(/^Status ([0-9]{1,3})$/);')).toEqual([]);
    expect(reading("m ? 'FOUND' : errorCode(error)", 'const m = /x/.test(text);')).toEqual([]);
  });
});

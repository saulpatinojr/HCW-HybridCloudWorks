/**
 * No raw error text reaches an HTTP response body (AP-B10, #945).
 *
 * The acceptance on #945 is "no raw error message in admin response bodies".
 * The first guard (#1198) read fifteen named files for one spelling,
 * `(message|error): (error|err)?.message`, so `error: error.message`, any
 * other variable name, any other file, and text passed through a helper all
 * went unseen. This one reads every module under functions/src and follows
 * the text, not the spelling.
 *
 * WHAT COUNTS AS ERROR TEXT. Parsed with Vite's `parseSync` (vitest brings
 * it; public-visitor-copy.test.js uses it the same way), so comments and
 * strings are never mistaken for code:
 *
 *   - `.message` or `.stack` read off anything, whatever it is called, with
 *     or without `?.`, and `{ message }` destructured from anything.
 *   - An error itself made into text: `String(e)`, `${e}`, `e + ''`,
 *     `e.toString()`, `JSON.stringify(e)`. An error is a `catch` parameter, a
 *     `.catch()` or `.then(_, onRejected)` parameter (resolved by scope, any
 *     name), or a variable named like one (`err`, `reason`, `fooError`).
 *   - Anything derived from those: an alias, a template literal, `||`/`??`,
 *     a ternary, a string method (`.slice`, `.replace`, ...).
 *   - A whole caught error placed in an object, array or spread.
 *   - A Promise.allSettled result's `reason`, through `filter`, `map`,
 *     `for...of` and destructuring (#1200 review M3 e).
 *   - CARRIED TEXT (#1200 review M3 a): what a function returns when its
 *     return holds a site the allowlist files as c or s with text in it,
 *     whether in the returned value or in a call it hands straight back
 *     (`(e) => result('unknown', e.message)`). Followed to a fixpoint through
 *     callers that return it on, `await`, aliases, destructuring, fields read
 *     off it, objects and lists it is stored in, `Promise.all`, `.then` and
 *     `.catch` handlers, a helper handed a function that returns it
 *     (`readThroughCache({ read })`), a lazy `import()`, and a dependency
 *     parameter's default (`readChecks = readLabChecksLazily`). Carried text
 *     is a site only where it lands in a response body: that is how a stored
 *     or log-only decision is kept out of an answer. The hub's Podbean reads
 *     (M1) and the Labs snapshot's lab checks (M2) were both this.
 *
 * WHERE IT MAY NOT GO WITHOUT A DECISION (a "site"): an object property, an
 * array element, a spread, a `return`, a property assignment, a `throw`, or
 * an argument of any call except a log line (`context.warn(...)` and
 * friends), a test (`.includes`, `.test`, ...), a stringifier whose result is
 * judged where it lands, and a plain `new Error(...)` re-throw. Passing the
 * text to a helper is a site, so it cannot be laundered through one, and a
 * helper that returns it is a site, so it cannot be laundered out of one.
 * A site is IN A RESPONSE BODY when it sits in a response object's
 * `body`/`jsonBody`, in a builder's body argument (a builder is resolved by
 * import, to a fixpoint), or in the second argument of an unresolved call
 * whose first is a literal HTTP status, `reply(500, {...})`, which is how an
 * injected builder is recognised (M3 b). An authored class is resolved
 * through imports, aliases, re-exports and namespaces, so `new X(e.message)`
 * for an aliased AuthoredError subclass is a site (M3 d).
 *
 * KNOWN LIMITS, each pinned by a self-test that fails when it is lifted:
 *
 *   - An injected builder called with a computed status (`reply(status, ...)`)
 *     is not recognised as one.
 *   - A whole error handed to a helper that stringifies a parameter not
 *     named like an error (`describe(x) { return String(x); }`) is not
 *     followed into the helper's result (M3 c).
 *
 * And by design: carried text starts only at a site with text in it, so a
 * whole error returned on (`return { error }`) is judged where its fields
 * are read; any field read off carried text counts as carried, so a count
 * read off a carried object is reported until it is read from elsewhere;
 * and text written to a document and read back in another request is not
 * followed at all, which is what class s, and step 2's write-time door, are
 * for.
 *
 * THE DOOR. `lib/http/error-response.js` is the only module that may read an
 * error's message for a body: `authoredMessage(error, fallback)` and
 * `failureFields(...)` return the message of an `AuthoredError` (text this code
 * wrote) and the fallback for anything else. `storedFailure` and
 * `recordedFailure` are the same door for a document: the authored message,
 * or the fallback with the error's code and a log line's reference, written
 * at the moment of failure so no later read serves someone else's words.
 * Each call is a site too, so every place authored text can surface is
 * listed below and reviewed; constructing an authored error from someone
 * else's text is a site.
 *
 * THE ALLOWLIST. Every site that is not converted is listed in ALLOWED with
 * a class and a one-line reason:
 *
 *   b  authored text through the door. Must be a door call. Entries marked
 *      PUBLIC answer a visitor: their sentences may name no vendor, tool,
 *      model or admin-side state (public-visitor-copy.test.js checks them).
 *   c  never reaches an HTTP response: a log or audit field, a notification
 *      to the owner, the message of an error that is thrown on, a summary a
 *      timer only logs. Must not sit inside a response body.
 *   s  stored diagnostic: written to a document or a job result now, read
 *      back by an admin page later. Not a same-request leak, and kept only
 *      by a recorded decision; every other stored site goes through
 *      storedFailure or recordedFailure (class b) since #945's second step.
 *      Must not sit inside a response body.
 *   n  not an error's text at all: the property happens to be `message`
 *      (a git commit's, a workflow alert's). Must not be a door call.
 *
 * A new site fails until someone converts it or lists it; an entry that no
 * longer matches anything fails too, so the list cannot rot. Keys are
 * `file › function › what`, where `what` is the flagged expression as written
 * with its property or call, so line moves never touch them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const ROOTS = ['lib', 'functions'];

/** The door module: the one place allowed to read an error's message for a body. */
const DOOR_MODULE = 'lib/http/error-response.js';
/** Its exports that return authored text. */
const DOORS = new Set(['authoredMessage', 'authoredDetails', 'failureFields', 'storedFailure', 'recordedFailure']);
/** The authored base class; its subclasses are found in the tree. */
const AUTHORED_BASE = 'AuthoredError';

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
  'field',
]);
const LOG_METHODS = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace', 'verbose']);
const LOG_RECEIVERS = new Set(['context', 'ctx', 'console', 'log', 'logger', 'invocationContext']);
const STRING_METHODS = new Set([
  'slice',
  'substring',
  'substr',
  'trim',
  'trimStart',
  'trimEnd',
  'replace',
  'replaceAll',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'split',
  'concat',
  'padEnd',
  'padStart',
  'normalize',
  'at',
  'charAt',
  'match',
  'matchAll',
  'repeat',
  'toString',
]);
const PREDICATES = new Set([
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
]);
const STRINGIFIERS = new Set(['String', 'inspect', 'format']);
/**
 * A variable named like an error is treated as one when it is stringified.
 * Not `reason` or `problem`: in this codebase those name sentences the code
 * wrote, and a caught error under either name is still found by scope.
 */
const ERROR_NAME = /^(e|err|error|ex|exc|exception|cause|rejection)$|(Error|Err)$/;
/** `new X(...)` with one of these names re-throws rather than answers. */
const ERROR_CLASS = /(Error|Exception|Refusal)$/;

/**
 * Taint kinds, strongest first: `text` (an error's words), `error` (a whole
 * caught error), `carried` (what a function returns when its return holds a
 * class-c or class-s site), `authored` (a door's sentence), `named` (a name
 * that looks like an error) and `settled` (a Promise.allSettled result,
 * whose `.reason` is an error).
 */
const RANK = { text: 4, error: 3, carried: 2.5, authored: 2, named: 1, settled: 0.5 };
/** Array methods whose result holds the same settled results as their receiver. */
const SETTLED_PASS = new Set(['filter', 'slice', 'concat', 'flat', 'sort', 'reverse', 'toSorted', 'toReversed']);
/** Array methods whose first argument is called with each element. */
const CALLBACK_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findLast', 'some', 'every']);
/** The allowlist classes whose returned sites make a function's result a source (see the header). */
const CARRIER_CLASSES = new Set(['c', 's']);
/** A literal HTTP status as a call's first argument: the call is treated as a response builder. */
const STATUS_RANGE = [100, 599];
/** The strongest of several taint kinds, by RANK. */
const strongest = (...kinds) =>
  kinds.reduce((a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a), null);
/** A whole error made into text counts as text. */
const asText = (kind) => (kind === 'error' || kind === 'named' ? 'text' : kind);

/**
 * The expression beneath parentheses, optional chains, `await` and commas.
 *
 * @param {object} node - an ESTree expression
 * @returns {object}
 */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'ParenthesizedExpression' ||
      current.type === 'ChainExpression' ||
      current.type === 'AwaitExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression')
  ) {
    current = current.expression ?? current.argument;
  }
  if (current?.type === 'SequenceExpression') return unwrap(current.expressions.at(-1));
  return current;
}

/**
 * A property key's name, for a non-computed identifier or a string literal.
 *
 * @param {object} property - Property, MethodDefinition or PropertyDefinition
 * @returns {string | null}
 */
function keyName(property) {
  const kinds = ['Property', 'MethodDefinition', 'PropertyDefinition'];
  if (!property || !kinds.includes(property.type)) return null;
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value;
  }
  return null;
}

/**
 * A member expression's property name, when it is statically known.
 *
 * @param {object} member - an ESTree MemberExpression
 * @returns {string | null}
 */
function memberName(member) {
  const p = member.property;
  if (!member.computed && (p.type === 'Identifier' || p.type === 'PrivateIdentifier')) return p.name;
  if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
  return null;
}

/**
 * The last name in a callee or object: `json` for `json` and `responses.json`.
 *
 * @param {object} node - an ESTree expression
 * @returns {string | null}
 */
function lastName(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression') return memberName(n);
  return null;
}

/**
 * Whether `node` is a function of any form.
 *
 * @param {object} node - an ESTree node
 * @returns {boolean}
 */
function isFunction(node) {
  return (
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression'
  );
}

/**
 * Visit every child node of `node`, skipping position fields.
 *
 * @param {object} node - an ESTree node
 * @param {(child: object, key: string) => void} fn - called per child node
 */
function eachChild(node, fn) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') fn(item, key);
    } else if (typeof value.type === 'string') {
      fn(value, key);
    }
  }
}

/**
 * Whether a callee is a log line: `context.warn`, `log.error`, `console.log`.
 *
 * @param {object} callee - an ESTree expression
 * @returns {boolean}
 */
function isLogger(callee) {
  const c = unwrap(callee);
  if (c?.type !== 'MemberExpression' || !LOG_METHODS.has(memberName(c))) return false;
  return LOG_RECEIVERS.has(lastName(c.object));
}

/**
 * Whether an object literal is an HTTP response: a `jsonBody`, or a `body`
 * beside `status` or `headers` and no `method` (an outbound request).
 *
 * @param {object} node - an ESTree ObjectExpression
 * @returns {boolean}
 */
function isResponseObject(node) {
  const keys = new Set(node.properties.map(keyName).filter(Boolean));
  if (keys.has('jsonBody')) return true;
  return keys.has('body') && (keys.has('status') || keys.has('headers')) && !keys.has('method');
}

/**
 * Parse one module, failing loudly rather than scanning nothing.
 *
 * @param {string} file - path used for the parser and the message
 * @param {string} source - module text
 * @returns {object} the ESTree Program
 */
function parse(file, source) {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(`${file} did not parse: ${errors[0].message}`);
  return program;
}

/**
 * The expressions a function returns, not crossing into nested functions.
 *
 * @param {object} fn - an ESTree function node
 * @returns {object[]}
 */
function returnsOf(fn) {
  if (fn.body.type !== 'BlockStatement') return [fn.body];
  const out = [];
  /** Collect the function's return expressions, not a nested function's. */
  const walk = (node) => {
    if (isFunction(node)) return;
    if (node.type === 'ReturnStatement' && node.argument) out.push(node.argument);
    eachChild(node, walk);
  };
  eachChild(fn.body, walk);
  return out;
}

/**
 * A relative import's target as a key of the scanned tree, or null.
 *
 * @param {string} file - the importing module's tree key
 * @param {string} specifier - the import's source string
 * @returns {string | null}
 */
function resolveImport(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

/**
 * One module's functions, imports and exports, for resolving which calls
 * build a response.
 *
 * @param {string} file - tree key
 * @param {object} program - the parsed module
 * @returns {{ locals: Map, members: Map, classes: Map, imports: Map, exports: Map, stars: string[] }}
 */
function moduleTable(file, program) {
  const locals = new Map();
  const members = new Map();
  /** class name → its `extends` expression (or null) */
  const classes = new Map();
  const imports = new Map();
  const exports = new Map();
  const stars = [];
  /** Record the module's functions, classes, exports and star re-exports. */
  const collect = (node) => {
    if (node.type === 'ClassDeclaration' && node.id) {
      classes.set(node.id.name, node.superClass ?? null);
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && unwrap(node.init)?.type === 'ClassExpression') {
      classes.set(node.id.name, unwrap(node.init).superClass ?? null);
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      locals.set(node.id.name, node);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      isFunction(unwrap(node.init))
    ) {
      locals.set(node.id.name, unwrap(node.init));
    } else if (node.type === 'Property' && isFunction(unwrap(node.value)) && keyName(node)) {
      members.set(keyName(node), unwrap(node.value));
    } else if (node.type === 'MethodDefinition' && node.key.type === 'Identifier') {
      members.set(node.key.name, node.value);
    }
    eachChild(node, collect);
  };
  collect(program);
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') {
      const from = resolveImport(file, st.source.value);
      if (!from) continue;
      for (const spec of st.specifiers) {
        if (spec.type === 'ImportSpecifier') {
          imports.set(spec.local.name, { from, imported: spec.imported.name ?? spec.imported.value });
        } else if (spec.type === 'ImportDefaultSpecifier') {
          imports.set(spec.local.name, { from, imported: 'default' });
        } else {
          imports.set(spec.local.name, { from, namespace: true });
        }
      }
    } else if (st.type === 'ExportNamedDeclaration') {
      const from = st.source ? resolveImport(file, st.source.value) : null;
      if (st.declaration?.type === 'FunctionDeclaration' || st.declaration?.type === 'ClassDeclaration') {
        exports.set(st.declaration.id.name, { local: st.declaration.id.name });
      } else if (st.declaration?.type === 'VariableDeclaration') {
        for (const d of st.declaration.declarations) {
          if (d.id.type === 'Identifier') exports.set(d.id.name, { local: d.id.name });
        }
      }
      for (const spec of st.specifiers ?? []) {
        const exported = spec.exported.name ?? spec.exported.value;
        const local = spec.local.name ?? spec.local.value;
        exports.set(exported, from ? { from, imported: local } : { local });
      }
    } else if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration;
      if (isFunction(d)) {
        if (d.id) exports.set('default', { local: d.id.name });
        else {
          locals.set('default', d);
          exports.set('default', { local: 'default' });
        }
      } else if (d?.type === 'ClassDeclaration' && d.id) {
        exports.set('default', { local: d.id.name });
      } else if (d?.type === 'Identifier') {
        exports.set('default', { local: d.name });
      }
    } else if (st.type === 'ExportAllDeclaration' && !st.exported) {
      const from = resolveImport(file, st.source.value);
      if (from) stars.push(from);
    }
  }
  return { locals, members, classes, imports, exports, stars };
}

/**
 * The argument slot each identifier a function's parameters bind comes
 * from: `'1'` for the whole second argument, `'1.error'` for the `error`
 * property of an object passed there. `(status, { error, code })` binds
 * status → '0', error → '1.error', code → '1.code'.
 *
 * @param {object} fn - an ESTree function node
 * @returns {Map<string, string>}
 */
function parameterSlots(fn) {
  const out = new Map();
  /** Map every name a parameter pattern binds to its argument slot. */
  const bindAll = (pattern, slot) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') out.set(pattern.name, slot);
    else if (pattern.type === 'AssignmentPattern') bindAll(pattern.left, slot);
    else if (pattern.type === 'RestElement') bindAll(pattern.argument, slot);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((el) => bindAll(el, slot));
    else if (pattern.type === 'ObjectPattern') {
      for (const p of pattern.properties) {
        const key = p.type === 'Property' ? keyName(p) : null;
        // One level deep: a property of a destructured argument is its own slot.
        const own = key && !slot.includes('.') ? `${slot}.${key}` : slot;
        bindAll(p.type === 'RestElement' ? p.argument : p.value, own);
      }
    }
  };
  fn.params.forEach((p, i) => bindAll(p, String(i)));
  return out;
}

/**
 * The parameter slots an expression serialises whole: a parameter placed as
 * a value, an element, a spread or a stringifier's argument. A field read off
 * it (`error.code`) or a helper it is handed to (`errorCode(error)`) is not
 * that, and is judged where it happens.
 *
 * @param {object} expression - an ESTree expression
 * @param {Map<string, string>} params - from parameterSlots()
 * @returns {Set<string>}
 */
function mentionedParameters(expression, params) {
  const out = new Set();
  /** Find the parameters an expression puts into the value it builds. */
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') {
      const isKey = key === 'key' && parent?.type === 'Property' && !parent.computed && !parent.shorthand;
      if (!isKey && params.has(node.name)) out.add(params.get(node.name));
      return;
    }
    if (node.type === 'MemberExpression' || isFunction(node)) return;
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = lastName(node.callee);
      if (STRINGIFIERS.has(callee) || callee === 'stringify') {
        for (const a of node.arguments) walk(a, node, 'arguments');
      }
      return;
    }
    eachChild(node, (child, k) => walk(child, node, k));
  };
  walk(expression, null, null);
  return out;
}

/**
 * The argument nodes a call puts in the slots of the callee's body, as the
 * set of the caller's own parameter slots they mention.
 *
 * @param {object} call - an ESTree CallExpression
 * @param {Set<string>} slots - the callee's body slots
 * @param {Map<string, string>} params - the caller's parameterSlots()
 * @returns {Set<string>}
 */
function slotsThrough(call, slots, params) {
  const out = new Set();
  for (const slot of slots) {
    const [index, key] = slot.split('.');
    const arg = call.arguments[Number(index)];
    if (!arg) continue;
    const plain = unwrap(arg);
    const property =
      key && plain?.type === 'ObjectExpression' ? plain.properties.find((p) => keyName(p) === key) : null;
    if (key && plain?.type === 'ObjectExpression' && !property) continue;
    for (const s of mentionedParameters(property ? property.value : arg, params)) out.add(s);
  }
  return out;
}

/**
 * Which calls in the tree build an HTTP response, and which of their
 * arguments land in the body. A function builds one when it returns a
 * response object (its body parameters are the ones the `body`/`jsonBody`
 * value mentions) or returns a call to another builder (its body parameters
 * are the ones it passes into that builder's body), to a fixpoint. Resolved
 * the way each module resolves a name, so two unrelated functions that share
 * one stay apart. The door's functions are not builders.
 *
 * @param {Map<string, ReturnType<typeof moduleTable>>} tables - every module's table
 * @returns {{ builderOf: (file: string, call: object) => Set<string> | null,
 *   resolveCall: (file: string, call: object) => string | null }} body argument slots, and the call resolver
 */
function responseBuilders(tables) {
  /** The function a module exports under a name, through re-exports. */
  const resolveExport = (file, name, seen = new Set()) => {
    const table = tables.get(file);
    if (!table || seen.has(`${file}::${name}`)) return null;
    seen.add(`${file}::${name}`);
    const entry = table.exports.get(name);
    if (entry?.local) return resolveLocal(file, entry.local, seen);
    if (entry?.from) return resolveExport(entry.from, entry.imported, seen);
    for (const star of table.stars) {
      const hit = resolveExport(star, name, seen);
      if (hit) return hit;
    }
    return null;
  };
  /** The function a local or imported name refers to. */
  const resolveLocal = (file, name, seen = new Set()) => {
    const table = tables.get(file);
    if (!table) return null;
    if (table.locals.has(name)) return `${file}::${name}`;
    const imported = table.imports.get(name);
    if (imported && !imported.namespace) return resolveExport(imported.from, imported.imported, seen);
    return null;
  };
  /** The function a call's callee resolves to, or null. */
  const resolveCall = (file, call) => {
    const callee = unwrap(call.callee);
    if (!callee) return null;
    if (callee.type === 'Identifier') return resolveLocal(file, callee.name);
    if (callee.type !== 'MemberExpression') return null;
    const property = memberName(callee);
    if (!property) return null;
    const object = unwrap(callee.object);
    // `(await import('./x.js')).f()`: a lazy import resolves like a static one.
    if (object?.type === 'ImportExpression' && typeof object.source?.value === 'string') {
      const from = resolveImport(file, object.source.value);
      return from ? resolveExport(from, property) : null;
    }
    const namespace = object?.type === 'Identifier' && tables.get(file)?.imports.get(object.name);
    if (namespace?.namespace) return resolveExport(namespace.from, property);
    return tables.get(file)?.members.has(property) ? `${file}::.${property}` : null;
  };
  const functions = [];
  for (const [file, table] of tables) {
    if (file === DOOR_MODULE) continue;
    for (const [name, fn] of table.locals) functions.push({ key: `${file}::${name}`, file, fn });
    for (const [name, fn] of table.members) functions.push({ key: `${file}::.${name}`, file, fn });
  }
  /** builder key → the argument slots that land in its body ('1', '1.error') */
  const builders = new Map();
  /** The body slots one returned expression implies, or null when it builds nothing. */
  const bodyOf = (file, expression, params) => {
    const node = unwrap(expression);
    if (!node) return null;
    if (node.type === 'ObjectExpression') {
      if (!isResponseObject(node)) return null;
      const body = node.properties.find((p) => ['body', 'jsonBody'].includes(keyName(p)));
      return body ? mentionedParameters(body.value, params) : new Set();
    }
    if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      const sides = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node.left, node.right];
      const found = sides.map((side) => bodyOf(file, side, params)).filter(Boolean);
      return found.length ? new Set(found.flatMap((s) => [...s])) : null;
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (lastName(node.callee) === 'HttpResponse') {
        return new Set(node.arguments.flatMap((a) => [...mentionedParameters(a, params)]));
      }
      const inner = builders.get(resolveCall(file, node));
      return inner ? slotsThrough(node, inner, params) : null;
    }
    return null;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const fn of functions) {
      const params = parameterSlots(fn.fn);
      const found = returnsOf(fn.fn).map((r) => bodyOf(fn.file, r, params)).filter(Boolean);
      if (!found.length) continue;
      const body = new Set(found.flatMap((s) => [...s]));
      const before = builders.get(fn.key);
      if (!before || [...body].some((i) => !before.has(i))) {
        builders.set(fn.key, new Set([...(before ?? []), ...body]));
        grew = true;
      }
    }
  }
  return { builderOf: (file, call) => builders.get(resolveCall(file, call)) ?? null, resolveCall };
}

/**
 * Local names that are log lines: `const warn = (...a) => log.warn?.(...a)`,
 * `const log = context.log`.
 *
 * @param {object} program - the parsed module
 * @returns {Set<string>}
 */
function loggerAliases(program) {
  const out = new Set();
  /** Record a variable that aliases a logger method. */
  const collect = (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const init = unwrap(node.init);
      let body = isFunction(init) ? init.body : null;
      if (body?.type === 'BlockStatement' && body.body.length === 1) {
        body = body.body[0].expression ?? body.body[0].argument ?? null;
      }
      const call = unwrap(body);
      if (call?.type === 'CallExpression' && isLogger(call.callee)) out.add(node.id.name);
      if (init?.type === 'MemberExpression' && isLogger(init)) out.add(node.id.name);
    }
    eachChild(node, collect);
  };
  collect(program);
  return out;
}

/**
 * The classes whose instances pass the door: AuthoredError and every class
 * in the tree that extends one of them, each resolved the way its module
 * resolves the name, through imports, aliases (`import { AuthoredError as
 * Base }`), re-exports and namespaces, so an aliased subclass built from
 * `e.message` is still a site. A `new X(...)` whose X does not resolve to a
 * class in the tree falls back to the authored classes' names.
 *
 * @param {Map<string, ReturnType<typeof moduleTable>>} tables - every module's table
 * @returns {(file: string, callee: object) => boolean} whether `new callee(...)` builds an authored error
 */
function authoredClasses(tables) {
  const base = `${DOOR_MODULE}::${AUTHORED_BASE}`;
  /** The class a module exports under a name, through re-exports. */
  const resolveExport = (file, name, seen) => {
    if (file === DOOR_MODULE && name === AUTHORED_BASE) return base;
    const table = tables.get(file);
    if (!table || seen.has(`${file}:=${name}`)) return null;
    seen.add(`${file}:=${name}`);
    const entry = table.exports.get(name);
    if (entry?.local) return resolveName(file, entry.local, seen);
    if (entry?.from) return resolveExport(entry.from, entry.imported, seen);
    for (const star of table.stars) {
      const hit = resolveExport(star, name, seen);
      if (hit) return hit;
    }
    return null;
  };
  /** The class a local or imported name refers to, as `file::Class`. */
  const resolveName = (file, name, seen = new Set()) => {
    if (file === DOOR_MODULE && name === AUTHORED_BASE) return base;
    const table = tables.get(file);
    if (!table) return null;
    if (table.classes.has(name)) return `${file}::${name}`;
    const imported = table.imports.get(name);
    if (imported && !imported.namespace) return resolveExport(imported.from, imported.imported, seen);
    return null;
  };
  /** The class an expression (`X`, `ns.X`) refers to. */
  const resolveNode = (file, node) => {
    const n = unwrap(node);
    if (n?.type === 'Identifier') return resolveName(file, n.name);
    if (n?.type !== 'MemberExpression') return null;
    const object = unwrap(n.object);
    const property = memberName(n);
    const namespace = object?.type === 'Identifier' && tables.get(file)?.imports.get(object.name);
    return namespace?.namespace && property ? resolveExport(namespace.from, property, new Set()) : null;
  };
  const authored = new Set([base]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, table] of tables) {
      for (const [name, superClass] of table.classes) {
        const key = `${file}::${name}`;
        if (!authored.has(key) && superClass && authored.has(resolveNode(file, superClass))) {
          authored.add(key);
          grew = true;
        }
      }
    }
  }
  const names = new Set([...authored].map((key) => key.split('::')[1]));
  return (file, callee) => {
    const resolved = resolveNode(file, callee);
    return resolved ? authored.has(resolved) : names.has(lastName(callee));
  };
}

/**
 * Bindings for one module: which identifier refers to which declaration,
 * with each declaration's initial kind ('error' for a caught error, 'text'
 * for a destructured `message`, 'named' for a name that looks like an
 * error).
 *
 * @param {object} program - the parsed module
 * @returns {Map<object, { kind: string | null }>} identifier node → binding
 */
function bindingsOf(program) {
  const scopeOf = new WeakMap();
  const declared = new WeakSet();
  const refs = new Map();
  const rejection = new WeakSet();
  /** A scope under its parent, owned by a function. */
  const newScope = (parent, fn) => ({ parent, fn, names: new Map() });
  /** The nearest scope that belongs to a function. */
  const functionScope = (scope) => {
    let s = scope;
    while (s && !s.fn) s = s.parent;
    return s;
  };
  /** Bind every name a pattern declares in `scope`, with its initial kind. */
  const declare = (scope, pattern, kind) => {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier': {
        declared.add(pattern);
        const binding = { kind: kind ?? (ERROR_NAME.test(pattern.name) ? 'named' : null) };
        scope.names.set(pattern.name, binding);
        refs.set(pattern, binding);
        break;
      }
      case 'ObjectPattern':
        for (const p of pattern.properties) {
          if (p.type === 'RestElement') {
            declare(scope, p.argument, kind === 'error' ? 'error' : null);
            continue;
          }
          const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
          const text = RAW_FIELDS.has(keyName(p)) && target.type === 'Identifier';
          declare(scope, p.value, text ? 'text' : null);
        }
        break;
      case 'ArrayPattern':
        for (const el of pattern.elements) declare(scope, el, null);
        break;
      case 'AssignmentPattern':
        declare(scope, pattern.left, kind);
        break;
      case 'RestElement':
        declare(scope, pattern.argument, kind);
        break;
      default:
        break;
    }
  };
  /** First pass: create the scopes and declare every binding (hoisting is moot: all are declared before any is resolved). */
  const visit = (node, scope) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Program': {
        const s = newScope(null, true);
        scopeOf.set(node, s);
        for (const c of node.body) visit(c, s);
        return;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        if (node.type === 'FunctionDeclaration' && node.id) declare(scope, node.id, 'plain');
        const s = newScope(scope, true);
        scopeOf.set(node, s);
        if (node.type === 'FunctionExpression' && node.id) declare(s, node.id, 'plain');
        node.params.forEach((p, i) => declare(s, p, i === 0 && rejection.has(node) ? 'error' : null));
        for (const p of node.params) eachChild(p, (c) => visit(c, s));
        if (node.body.type === 'BlockStatement') {
          scopeOf.set(node.body, s);
          for (const st of node.body.body) visit(st, s);
        } else {
          visit(node.body, s);
        }
        return;
      }
      case 'ClassDeclaration':
        if (node.id) declare(scope, node.id, 'plain');
        eachChild(node, (c, k) => k !== 'id' && visit(c, scope));
        return;
      case 'BlockStatement':
      case 'StaticBlock': {
        const s = newScope(scope, false);
        scopeOf.set(node, s);
        for (const st of node.body) visit(st, s);
        return;
      }
      case 'CatchClause': {
        const s = newScope(scope, false);
        scopeOf.set(node, s);
        if (node.param) declare(s, node.param, node.param.type === 'Identifier' ? 'error' : null);
        visit(node.body, s);
        return;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const s = newScope(scope, false);
        scopeOf.set(node, s);
        eachChild(node, (c) => visit(c, s));
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope);
        const s = newScope(scope, false);
        scopeOf.set(node, s);
        for (const c of node.cases) eachChild(c, (x) => visit(x, s));
        return;
      }
      case 'VariableDeclaration': {
        const target = node.kind === 'var' ? functionScope(scope) : scope;
        for (const d of node.declarations) {
          declare(target, d.id, null);
          if (d.init) visit(d.init, scope);
          eachChild(d.id, (c) => visit(c, scope));
        }
        return;
      }
      case 'ImportDeclaration':
        for (const spec of node.specifiers) declare(scope, spec.local, 'plain');
        return;
      case 'CallExpression': {
        const callee = unwrap(node.callee);
        if (callee?.type === 'MemberExpression') {
          const method = memberName(callee);
          const handler = method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : null;
          if (isFunction(unwrap(handler))) rejection.add(unwrap(handler));
        }
        eachChild(node, (c) => visit(c, scope));
        return;
      }
      default:
        eachChild(node, (c) => visit(c, scope));
    }
  };
  visit(program, null);

  /** Second pass: point each identifier reference at its binding, skipping keys, member names and labels. */
  const resolve = (node, scope, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    const s = scopeOf.get(node) ?? scope;
    if (node.type === 'Identifier') {
      if (declared.has(node)) return;
      if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      const keyed = ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type);
      if (keyed && key === 'key' && !parent.computed) return;
      for (let c = s; c; c = c.parent) {
        if (c.names.has(node.name)) {
          refs.set(node, c.names.get(node.name));
          return;
        }
      }
      return;
    }
    if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(node.type)) {
      if (node.body) resolve(node.body, s, node, 'body');
      return;
    }
    if (node.type === 'Property' && node.shorthand) {
      resolve(node.value, s, node, 'value');
      return;
    }
    eachChild(node, (c, k) => resolve(c, s, node, k));
  };
  resolve(program, null, null, null);
  return refs;
}

/**
 * Every site in one module where error text (or authored text from the door)
 * lands in a value that leaves its function.
 *
 * @param {string} file - tree key, for the report
 * @param {object} program - the parsed module
 * @param {string} source - the module text, for lines and snippets
 * @param {{ builderOf: Function, resolveCall: Function, isAuthoredNew: Function,
 *   carriers: Set<string>, carrierReturns: Set<string> }} tree - from the whole tree; `carrierReturns`
 *   collects the functions found returning a carried value this round
 * @returns {Array<{ key: string, file: string, line: number, kind: string, inResponse: boolean,
 *   returnsFrom: string | null }>}
 */
function sitesOf(file, program, source, { builderOf, resolveCall, isAuthoredNew, carriers, carrierReturns }) {
  const refs = bindingsOf(program);
  const aliases = loggerAliases(program);
  // A dependency parameter's default (`readChecks = readLabChecksLazily`):
  // called by the parameter's name, it resolves to its default.
  const defaults = new Map();
  /** Record each `name = otherName` default in a pattern. */
  const collectDefaults = (node) => {
    if (node.type === 'AssignmentPattern' && node.left.type === 'Identifier' && unwrap(node.right)?.type === 'Identifier') {
      defaults.set(node.left.name, unwrap(node.right));
    }
    eachChild(node, collectDefaults);
  };
  collectDefaults(program);
  /** The function a call resolves to, through a parameter's default when it names one. */
  const resolveVia = (call) => {
    const direct = resolveCall(file, call);
    if (direct) return direct;
    const callee = unwrap(call.callee);
    return callee?.type === 'Identifier' && defaults.has(callee.name)
      ? resolveCall(file, { callee: defaults.get(callee.name) })
      : null;
  };

  // The door is the door module's export, reached through an import — not
  // any function that happens to share its name.
  const doorLocals = new Set();
  const doorNamespaces = new Set();
  for (const st of program.body) {
    if (st.type !== 'ImportDeclaration' || resolveImport(file, st.source.value) !== DOOR_MODULE) continue;
    for (const spec of st.specifiers) {
      if (spec.type === 'ImportNamespaceSpecifier') doorNamespaces.add(spec.local.name);
      else if (spec.type === 'ImportSpecifier' && DOORS.has(spec.imported.name ?? spec.imported.value)) {
        doorLocals.add(spec.local.name);
      }
    }
  }
  /** Whether a callee is the door, reached through an import of the door module. */
  const isDoor = (callee) => {
    const c = unwrap(callee);
    if (c?.type === 'Identifier') return doorLocals.has(c.name);
    const object = c?.type === 'MemberExpression' ? unwrap(c.object) : null;
    return object?.type === 'Identifier' && doorNamespaces.has(object.name) && DOORS.has(memberName(c));
  };

  /** What an expression's value is: one of the RANK kinds, or null. */
  const kindOf = (node) => {
    const n = unwrap(node);
    if (!n) return null;
    switch (n.type) {
      case 'Identifier': {
        const kind = refs.get(n)?.kind ?? null;
        return kind === 'plain' ? null : kind;
      }
      case 'MemberExpression': {
        const name = memberName(n);
        if (RAW_FIELDS.has(name)) return 'text';
        const objectKind = kindOf(n.object);
        if (objectKind === 'error') return SAFE_ERROR_FIELDS.has(name) ? null : 'error';
        // Anything read off a carried value may be the text it carries.
        if (objectKind === 'carried') return 'carried';
        // A settled result's `reason` is the rejection: an error.
        if (objectKind === 'settled') return name === 'reason' ? 'error' : n.computed ? 'settled' : null;
        if ((objectKind === 'text' || objectKind === 'authored') && n.computed) return objectKind;
        return null;
      }
      case 'TemplateLiteral':
        return strongest(...n.expressions.map((e) => asText(kindOf(e))));
      case 'BinaryExpression':
        return n.operator === '+' ? strongest(asText(kindOf(n.left)), asText(kindOf(n.right))) : null;
      case 'LogicalExpression':
        return n.operator === '&&' ? kindOf(n.right) : strongest(kindOf(n.left), kindOf(n.right));
      case 'ConditionalExpression':
        return strongest(kindOf(n.consequent), kindOf(n.alternate));
      case 'AssignmentExpression':
        return kindOf(n.right);
      case 'CallExpression': {
        const callee = unwrap(n.callee);
        const name = lastName(callee);
        if (isDoor(callee)) return 'authored';
        const stringify =
          STRINGIFIERS.has(name) || (name === 'stringify' && lastName(callee?.object) === 'JSON');
        if (stringify) return asText(strongest(...n.arguments.map(kindOf)));
        if (name === 'allSettled' && lastName(callee?.object) === 'Promise') return 'settled';
        if (callee?.type === 'MemberExpression') {
          const receiver = kindOf(callee.object);
          if ((receiver === 'text' || receiver === 'authored') && STRING_METHODS.has(name)) return receiver;
          if ((receiver === 'error' || receiver === 'named') && name === 'toString') return 'text';
          if (receiver === 'settled' && SETTLED_PASS.has(name)) return 'settled';
          if (receiver === 'carried' && (SETTLED_PASS.has(name) || name === 'map' || name === 'flatMap')) {
            return 'carried';
          }
          // `settled.map((r) => String(r.reason))` holds what its callback returns.
          const fn = unwrap(n.arguments[0]);
          if (receiver === 'settled' && (name === 'map' || name === 'flatMap') && isFunction(fn)) {
            return strongest(...returnsOf(fn).map(kindOf));
          }
        }
        // (a) The result of a function whose return holds a class-c or
        // class-s site (or another carrier's result) is carried text.
        if (carriers.size) {
          const key = resolveVia(n);
          if (key && carriers.has(key)) return 'carried';
          // `Promise.all([...])` holds what its list holds; `p.catch(f)` and
          // `p.then(a, b)` hold what their handlers return, by reference or
          // inline. Only carried text is followed this way.
          if (name === 'all' && lastName(callee?.object) === 'Promise') {
            return kindOf(n.arguments[0]) === 'carried' ? 'carried' : null;
          }
          if (callee?.type === 'MemberExpression' && (name === 'catch' || name === 'then' || name === 'finally')) {
            const kinds = [kindOf(callee.object), ...n.arguments.map(handlerKind)];
            return kinds.includes('carried') ? 'carried' : null;
          }
          // A helper handed a function that returns carried text, directly or
          // as an option (`readThroughCache({ read: () => fetchOverview() })`),
          // is taken to return what that function returns.
          const handed = n.arguments.flatMap((a) => {
            const arg = unwrap(a.type === 'SpreadElement' ? a.argument : a);
            if (isFunction(arg)) return [arg];
            return arg?.type === 'ObjectExpression'
              ? arg.properties.filter((p) => p.type === 'Property' && isFunction(unwrap(p.value))).map((p) => p.value)
              : [];
          });
          if (handed.some((fn) => handlerKind(fn) === 'carried')) return 'carried';
        }
        return null;
      }
      case 'ObjectExpression':
        // A literal holding carried text carries it (`{ ...unreadable(e), agents: {} }`).
        return n.properties.some((p) => kindOf(p.type === 'SpreadElement' ? p.argument : isFunction(p.value) ? null : p.value) === 'carried')
          ? 'carried'
          : null;
      case 'ArrayExpression':
        return n.elements.some((el) => el && kindOf(el.type === 'SpreadElement' ? el.argument : el) === 'carried')
          ? 'carried'
          : null;
      default:
        return null;
    }
  };

  /** What a promise handler returns: a carrier by reference, or an inline function's returns. */
  const handlerKind = (arg) => {
    const fn = unwrap(arg);
    if (isFunction(fn)) return strongest(...returnsOf(fn).map(kindOf));
    const key = fn?.type === 'Identifier' || fn?.type === 'MemberExpression' ? resolveCall(file, { callee: fn }) : null;
    return key && carriers.has(key) ? 'carried' : null;
  };

  // Aliases, to a fixpoint: `const why = e?.message ?? 'x'` makes `why` text.
  // `each` definitions bind a loop's or a callback's element to its list;
  // `into` ones raise an object to carried when a carried value is stored in it.
  const definitions = [];
  /** The variable at the root of a member chain (`out` in `out.errors[x]`), or null. */
  const rootOf = (node) => {
    let n = unwrap(node);
    while (n?.type === 'MemberExpression') n = unwrap(n.object);
    return n?.type === 'Identifier' ? n : null;
  };
  /** Record every variable declaration with an initialiser, and every element and store binding. */
  const collect = (node) => {
    if (node.type === 'VariableDeclarator' && node.init) definitions.push([node.id, node.init, 'value']);
    if (node.type === 'AssignmentExpression' && ['=', '||=', '??=', '&&=', '+='].includes(node.operator)) {
      if (node.left.type !== 'MemberExpression') definitions.push([node.left, node.right, 'value']);
      else if (rootOf(node.left)) definitions.push([rootOf(node.left), node.right, 'into']);
    }
    if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration') {
      for (const d of node.left.declarations) definitions.push([d.id, node.right, 'each']);
    }
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee);
      const method = callee?.type === 'MemberExpression' ? memberName(callee) : null;
      const fn = unwrap(node.arguments[0]);
      if (CALLBACK_METHODS.has(method) && isFunction(fn) && fn.params[0]) {
        definitions.push([fn.params[0], callee.object, 'each']);
      }
      if ((method === 'push' || method === 'unshift') && rootOf(callee.object)) {
        for (const a of node.arguments) definitions.push([rootOf(callee.object), a.type === 'SpreadElement' ? a.argument : a, 'into']);
      }
    }
    eachChild(node, collect);
  };
  collect(program);
  /** Raise a binding's taint to a stronger kind; whether it changed. */
  const raise = (binding, kind) => {
    if (!binding || !kind || (RANK[kind] ?? 0) <= (RANK[binding.kind] ?? 0)) return false;
    binding.kind = kind;
    return true;
  };
  /**
   * Raise every name a pattern binds to `kind`; a settled result's
   * destructured `reason` is an error. True when one changed.
   */
  const bindPattern = (pattern, kind) => {
    let changed = false;
    /** Raise one pattern element. */
    const visit = (p, key = null) => {
      if (!p) return;
      if (p.type === 'Identifier') changed = raise(refs.get(p), kind === 'settled' && key === 'reason' ? 'error' : kind) || changed;
      else if (p.type === 'AssignmentPattern') visit(p.left, key);
      else if (p.type === 'RestElement') visit(p.argument);
      else if (p.type === 'ArrayPattern') p.elements.forEach((el) => visit(el));
      else if (p.type === 'ObjectPattern') {
        for (const q of p.properties) visit(q.type === 'RestElement' ? q.argument : q.value, q.type === 'Property' ? keyName(q) : null);
      }
    };
    visit(pattern);
    return changed;
  };
  /** Raise the kind of the bindings an assignment or declaration writes; true when one changed. */
  const bind = (target, value, mode = 'value') => {
    const kind = kindOf(value);
    // Only a settled list or a carried value reaches a loop's or a callback's
    // element, and only a carried value taints the object it is stored in.
    if (mode === 'each') return kind === 'settled' || kind === 'carried' ? bindPattern(target, kind) : false;
    if (mode === 'into') return kind === 'carried' ? raise(refs.get(target), 'carried') : false;
    const t = target.type === 'AssignmentPattern' ? target.left : target;
    if (t.type === 'Identifier') return raise(refs.get(t), kind);
    if (kind === 'settled' || kind === 'carried') return bindPattern(t, kind);
    if (t.type !== 'ObjectPattern' || kind !== 'error') return false;
    let changed = false;
    for (const p of t.properties) {
      if (p.type !== 'Property') continue;
      const local = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
      if (local.type !== 'Identifier') continue;
      const name = keyName(p);
      const kind = RAW_FIELDS.has(name) ? 'text' : SAFE_ERROR_FIELDS.has(name) ? null : 'error';
      changed = raise(refs.get(local), kind) || changed;
    }
    return changed;
  };
  for (let grew = true, rounds = 0; grew && rounds < 25; rounds += 1) {
    grew = false;
    for (const [target, value, mode] of definitions) if (bind(target, value, mode)) grew = true;
  }

  const found = [];
  const names = [];
  /** The tree key of each function being walked (as moduleTable keys it), innermost last. */
  const fnKeys = [];
  /** The function whose return value is being walked, or null outside a return. */
  let returning = null;
  /** Object arguments of which only some properties land in a builder's body. */
  const partialBodies = new WeakMap();
  let responseDepth = 0;
  /** The 1-based line of a source offset. */
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;
  /** A node's source on one line, cut for a key. */
  const snippet = (node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').trim().slice(0, 120);
  /** Record a site, keyed by file, function and expression. */
  const report = (node, what, kind) => {
    const fn = names.at(-1) ?? '<module>';
    found.push({
      key: `${file} › ${fn} › ${what(snippet(node))}`,
      file,
      line: lineOf(node.start),
      kind: kind === 'named' || kind === 'settled' ? 'error' : kind,
      inResponse: responseDepth > 0,
      returnsFrom: returning,
    });
  };
  /** Run a visit with every site marked as inside a response body. */
  const inResponse = (fn) => {
    responseDepth += 1;
    try {
      fn();
    } finally {
      responseDepth -= 1;
    }
  };
  /** Whether a taint kind makes a site here: carried text only inside a response body. */
  const flagged = (kind, wholeErrorCounts) =>
    kind === 'text' ||
    kind === 'authored' ||
    (wholeErrorCounts && (kind === 'error' || kind === 'settled')) ||
    (kind === 'carried' && responseDepth > 0);

  /** A value position: report it when it holds error text, else look inside. */
  const value = (node, what, wholeErrorCounts = false) => {
    const kind = kindOf(node);
    // A literal that carries text is reported at the property that holds it.
    const literal = ['ObjectExpression', 'ArrayExpression'].includes(unwrap(node)?.type);
    if (flagged(kind, wholeErrorCounts) && !(kind === 'carried' && literal)) {
      report(node, what, kind);
      return;
    }
    // A carried value returned on is a carrier of its own (next round).
    if (kind === 'carried' && returning) carrierReturns.add(returning);
    walk(node);
  };

  /** The key moduleTable and resolveCall know a function by, or null. */
  const treeKeyOf = (node, parent) => {
    if (node.type === 'FunctionDeclaration' && node.id) return `${file}::${node.id.name}`;
    if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return `${file}::${parent.id.name}`;
    if (['Property', 'MethodDefinition'].includes(parent?.type) && keyName(parent)) return `${file}::.${keyName(parent)}`;
    return null;
  };

  /** The name a function is known by for a key. */
  const functionName = (node, parent) => {
    if (node.id?.name) return node.id.name;
    if (parent?.type === 'VariableDeclarator') return parent.id?.name ?? null;
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type)) return keyName(parent);
    if (parent?.type === 'AssignmentExpression') return lastName(parent.left);
    return null;
  };

  /** The site walk: value positions are judged, everything else is descended. */
  const walk = (node, parent = null) => {
    if (!node || typeof node.type !== 'string') return;
    if (isFunction(node)) {
      const name = functionName(node, parent);
      if (name) names.push(name);
      const saved = responseDepth;
      const savedReturning = returning;
      responseDepth = 0;
      returning = null;
      fnKeys.push(treeKeyOf(node, parent));
      for (const p of node.params) walk(p, node);
      if (node.body.type === 'BlockStatement') walk(node.body, node);
      else {
        returning = fnKeys.at(-1);
        value(node.body, (t) => `return ${t}`);
      }
      fnKeys.pop();
      returning = savedReturning;
      responseDepth = saved;
      if (name) names.pop();
      return;
    }
    switch (node.type) {
      case 'ObjectExpression': {
        const response = isResponseObject(node);
        const partial = partialBodies.get(node);
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            value(p.argument, (t) => `...${t}`, true);
            continue;
          }
          if (p.computed) walk(p.key, p);
          if (isFunction(p.value)) {
            walk(p.value, p);
            continue;
          }
          const key = keyName(p) ?? '[computed]';
          /** Visit the property's value as a site of its own. */
          const visitValue = () => value(p.value, (t) => `${key}: ${t}`, true);
          const body = (response && (key === 'body' || key === 'jsonBody')) || Boolean(partial?.has(key));
          if (body) inResponse(visitValue);
          else visitValue();
        }
        return;
      }
      case 'ArrayExpression':
        for (const el of node.elements) {
          if (el) value(el.type === 'SpreadElement' ? el.argument : el, (t) => `[${t}]`, true);
        }
        return;
      case 'ReturnStatement':
        if (node.argument) {
          const savedReturning = returning;
          returning = fnKeys.at(-1) ?? null;
          value(node.argument, (t) => `return ${t}`);
          returning = savedReturning;
        }
        return;
      case 'ThrowStatement':
        value(node.argument, (t) => `throw ${t}`);
        return;
      case 'YieldExpression':
        if (node.argument) value(node.argument, (t) => `yield ${t}`);
        return;
      case 'AssignmentExpression':
        if (node.left.type === 'MemberExpression') {
          walk(node.left, node);
          value(node.right, (t) => `.${memberName(node.left) ?? '[computed]'} = ${t}`, true);
        } else {
          walk(node.right, node);
        }
        return;
      case 'TaggedTemplateExpression':
        walk(node.tag, node);
        for (const e of node.quasi.expressions) value(e, (t) => `${lastName(node.tag)}\`${t}\``);
        return;
      case 'CallExpression':
      case 'NewExpression':
        // A site in a call inside a return is held by that return too:
        // `(e) => result('unknown', e.message)` hands it straight back.
        visitCall(node);
        return;
      default:
        eachChild(node, (child) => walk(child, node));
    }
  };

  /** (b) An unresolved call with a literal HTTP status first, `reply(500, {...})`: its second argument is a body. */
  const statusCall = (node) => {
    const first = unwrap(node.arguments[0]);
    return (
      node.arguments.length >= 2 &&
      first?.type === 'Literal' &&
      Number.isInteger(first.value) &&
      first.value >= STATUS_RANGE[0] &&
      first.value <= STATUS_RANGE[1] &&
      !resolveCall(file, node)
    );
  };

  /** A call or `new`: its arguments are sites unless it logs, tests, stringifies or is the door. */
  const visitCall = (node) => {
    const callee = unwrap(node.callee);
    const name = lastName(callee) ?? '?';
    walk(node.callee, node);
    const logs = isLogger(callee) || (callee?.type === 'Identifier' && aliases.has(callee.name));
    if (node.type === 'CallExpression' && logs) return;
    const receiver = callee?.type === 'MemberExpression' ? kindOf(callee.object) : null;
    const passesThrough =
      node.type === 'CallExpression' &&
      (STRINGIFIERS.has(name) ||
        (name === 'stringify' && lastName(callee?.object) === 'JSON') ||
        ((receiver === 'text' || receiver === 'authored') && STRING_METHODS.has(name)));
    const isNew = node.type === 'NewExpression';
    if (isNew && isAuthoredNew(file, node.callee)) {
      for (const a of node.arguments) value(a, (t) => `new ${name}(${t})`);
      return;
    }
    if (passesThrough || PREDICATES.has(name) || isDoor(callee) || (isNew && ERROR_CLASS.test(name))) {
      for (const a of node.arguments) walk(a, node);
      return;
    }
    // A builder's body arguments are in the response; a whole error
    // handed to one is serialised, so it counts there and nowhere else
    // (a helper that only reads `error.code` is scanned on its own). An
    // object argument whose properties the builder destructures is in
    // the body only for the properties the body uses. A builder injected
    // as a dependency is not resolvable, so a literal status is its sign.
    let slots = node.type === 'CallExpression' ? builderOf(file, node) : null;
    if (!slots && node.type === 'CallExpression' && statusCall(node)) slots = new Set(['1']);
    node.arguments.forEach((a, index) => {
      const arg = a.type === 'SpreadElement' ? a.argument : a;
      const plain = unwrap(arg);
      const prefix = `${index}.`;
      const keys = [...(slots ?? [])].filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
      const partial = !slots?.has(String(index)) && keys.length > 0 && plain?.type === 'ObjectExpression';
      if (partial) partialBodies.set(plain, new Set(keys));
      const inBody =
        Boolean(slots?.has(String(index))) ||
        (keys.length > 0 && !partial) ||
        (name === 'errorResponse' && index === 1);
      /** Visit the argument as a site of its own. */
      const visitArg = () => value(arg, (t) => `${name}(${t})`, inBody);
      if (inBody) inResponse(visitArg);
      else visitArg();
    });
  };
  walk(program);
  return found;
}

/**
 * Scan source strings as if they were the modules of one tree.
 *
 * (a) Carriers, to a fixpoint: a function whose return value holds a site
 * the allowlist files as class c or s, or holds another carrier's result, is
 * a carrier, and what a call to it returns is carried text. Carried text is
 * a site only where it lands in a response body, which is how a stored or
 * log-only decision is kept from reaching an answer through a helper's
 * result (#1200 review M3: the Podbean hub's reads and the lab checks).
 *
 * @param {Record<string, string>} modules - tree key → source
 * @param {{ allowed?: Array<{ site: string, class: string }> }} [options] - the decisions, for the carriers
 * @returns {Array<{ key: string, file: string, line: number, kind: string, inResponse: boolean,
 *   returnsFrom: string | null }>}
 */
export function scanSources(modules, { allowed = [] } = {}) {
  const parsed = Object.entries(modules).map(([file, source]) => ({
    file,
    source,
    program: parse(file, source),
  }));
  const tables = new Map(parsed.map(({ file, program }) => [file, moduleTable(file, program)]));
  const { builderOf, resolveCall } = responseBuilders(tables);
  const isAuthoredNew = authoredClasses(tables);
  const classOf = new Map(allowed.map((entry) => [entry.site, entry.class]));
  const scanned = parsed.filter((m) => m.file !== DOOR_MODULE);
  const carriers = new Set();
  let sites = [];
  for (let round = 0; round < 12; round += 1) {
    const carrierReturns = new Set();
    const tree = { builderOf, resolveCall, isAuthoredNew, carriers, carrierReturns };
    sites = scanned.flatMap((m) => sitesOf(m.file, m.program, m.source, tree));
    const before = carriers.size;
    // Text, not a whole error: a returned error object is read by its
    // caller's own rules (its code, its status, the door), and seeding on it
    // would taint every field of the result.
    for (const s of sites) {
      if (s.returnsFrom && s.kind === 'text' && CARRIER_CLASSES.has(classOf.get(s.key))) carriers.add(s.returnsFrom);
    }
    for (const key of carrierReturns) carriers.add(key);
    if (carriers.size === before) break;
  }
  return sites;
}

/**
 * Compare the sites found with the decisions listed.
 *
 * @param {ReturnType<typeof scanSources>} sites - what the scan found
 * @param {Array<{ site: string, class: string, why: string, times?: number }>} allowed - the list
 * @returns {{ unlisted: string[], stale: string[], misfiled: string[] }}
 */
export function judge(sites, allowed) {
  const bySite = new Map();
  for (const s of sites) bySite.set(s.key, [...(bySite.get(s.key) ?? []), s]);
  const unlisted = [];
  const stale = [];
  const misfiled = [];
  const listed = new Map(allowed.map((entry) => [entry.site, entry]));
  for (const entry of allowed) {
    const hits = bySite.get(entry.site) ?? [];
    if (hits.length === 0) {
      stale.push(entry.site);
      continue;
    }
    if (hits.length !== (entry.times ?? 1)) {
      misfiled.push(`${entry.site} — listed ${entry.times ?? 1}, found ${hits.length}`);
    }
    if (!['b', 'c', 's', 'n'].includes(entry.class) || !entry.why?.trim()) {
      misfiled.push(`${entry.site} — needs a class (b, c, s or n) and a reason`);
    }
    for (const hit of hits) {
      if (entry.class === 'b' && hit.kind !== 'authored') {
        misfiled.push(`${entry.site} — class b must go through the door (authoredMessage, authoredDetails, failureFields, storedFailure, recordedFailure)`);
      }
      if (entry.class !== 'b' && hit.kind === 'authored') {
        misfiled.push(`${entry.site} — a door call is class b`);
      }
      if ((entry.class === 'c' || entry.class === 's') && hit.inResponse) {
        misfiled.push(`${entry.site} — sits in a response body (line ${hit.line}), so it cannot be ${entry.class}`);
      }
    }
  }
  for (const [key, hits] of bySite) {
    if (!listed.has(key)) {
      for (const hit of hits) unlisted.push(`${hit.file}:${hit.line} ${hit.kind}${hit.inResponse ? ' IN RESPONSE' : ''} — ${key}`);
    }
  }
  return { unlisted, stale, misfiled };
}

/**
 * Every source module under the scanned roots, as tree keys.
 *
 * @param {string} dir - absolute directory to walk
 * @returns {string[]}
 */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.(c|m)?js$/.test(entry) && !/\.(test|spec)\.(c|m)?js$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The real tree: every module under functions/src/lib and functions/src/functions.
 *
 * @returns {Record<string, string>}
 */
function realTree() {
  const modules = {};
  for (const root of ROOTS) {
    for (const full of sourceFiles(join(SRC, root))) {
      modules[relative(SRC, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  }
  return modules;
}

/**
 * The decisions. Sorted by file; one line per reason. See the header for the
 * classes.
 */
const ALLOWED = [
  { site: "lib/brain/handlers.js › route › error: authoredMessage(error, 'Could not complete the action.')", class: 'b', why: 'Owner-only authored BrainError sentence; upstream errors use errorResponse.' },
  { site: 'lib/brain/handlers.js › route › ...authoredDetails(error)', class: 'b', why: 'Owner-only conflict projection of the current private note, constructed by the repository after authorization.' },
  { site: "lib/brain/handlers.js › route › error: authoredMessage(error, 'Invalid input.')", class: 'b', why: 'Existing draft/taxonomy validator sentences; provider and database text is never returned.' },
  { site: 'functions/listen-and-learn-jobs.js › runSpeakChapter › error: storedFailure(err, \'The chapter could not be voiced.\', { correlationId: context?.invocationId ?? null, })', class: 'b', why: 'stored at write time through the door (#945 step 2): the chapter\'s error and lastError, with runJob\'s reference; the public Listen & Learn read has not returned it since #1201 (an allowlist of fields)' },
  { site: 'functions/public-submissions.js › handleSubmission › error: authoredMessage(err, \'Too many submissions — try again later.\')', class: 'b', why: 'PUBLIC: SubmissionRateLimitError sentence, vendor-free' },
  { site: 'lib/addons/status.js › failureReason › return error.message', class: 'c', why: 'feeds a warn line only' },
  { site: 'lib/admin-integrations/config-collections.js › mcpWriteError › return authoredMessage(error, \'The MCP server settings were refused.\')', class: 'b', why: 'McpPolicyError sentences from the MCP save rules; anything else gets the fixed sentence' },
  { site: 'lib/ai/mcp-oauth-handlers.js › completeMcpOAuth › fail(message)', class: 'b', why: 'McpOAuthError sentence (OAuth error code, no provider text) plus "press Connect"' },
  { site: 'lib/ai/mcp-oauth-handlers.js › startMcpOAuth › fail(authoredMessage(error, \'The sign-in was not started.\'))', class: 'b', why: 'McpOAuthError sentence on the Connect answer' },
  { site: 'lib/ai/mcp-oauth.js › describeFetchFailure › return `${where} is not an address this site fetches (${authoredMessage(error, \'refused\')}).`', class: 'b', why: 'the guard\'s FetchRefusedError sentence, inside an McpOAuthError' },
  { site: 'lib/ai/mcp-oauth.js › firstDocument › failure: answered ? null : failure', class: 'c', why: 'carries the last McpOAuthError to discoverOAuth, which answers through the door' },
  { site: 'lib/ai/mcp-oauth.js › performRefresh › sentence: authoredMessage(error, `The sign-in to ${name} could not be renewed just now.`)', class: 'b', why: 'an McpOAuthError sentence or a fixed one; stored as the card status, read by mcp.js' },
  { site: 'lib/ai/mcp-oauth.js › revokeOAuthGrant › reason: authoredMessage(error, `${name}\'s revocation endpoint was refused.`)', class: 'b', why: 'requireHttpsUrl\'s McpOAuthError sentence on the disconnect answer' },
  { site: 'lib/ai/mcp-oauth.js › revokeOAuthGrant › scrub(authoredMessage(error, `${bare(endpoint)} could not be reached for the revocation.`))', class: 'b', why: 'an McpOAuthError sentence (no provider text) on the disconnect answer, scrubbed of tokens' },
  { site: 'lib/ai/mcp-oauth.js › startOAuthConnect › new McpOAuthError(`${name}: ${authoredMessage(error, \'the server URL was refused.\')}`)', class: 'b', why: 'McpPolicyError\'s URL sentence inside an McpOAuthError' },
  { site: 'lib/ai/mcp-oauth.js › unreachable › new McpOAuthError(`${name}\'s ${what} could not be read: ${authoredMessage(failure, \'no address answered.\')}`)', class: 'b', why: 'the last McpOAuthError\'s sentence inside a new one' },
  { site: 'lib/ai/mcp-policy.js › mcpToolRefusal › return `Tool "${tool}" refused on MCP server "${serverId}": ${authoredMessage(error, \'its tool policy is invalid\')}`', class: 'b', why: 'McpPolicyError sentence for a tool call the policy refuses (admin MCP console)' },
  { site: 'lib/ai/mcp.js › callMcpTool › error: authoredMessage(error, \'The server is not connected; press Connect on its card.\')', class: 'b', why: 'McpOAuthNotConnectedError "press Connect" sentence (admin MCP console)' },
  { site: 'lib/ai/mcp.js › mcpAuthError › error: authoredMessage(error, fallback)', class: 'b', why: 'McpUpstreamError/McpOAuthError sentence or the fixed fallback; never the server body' },
  { site: 'lib/ai/mcp.js › syncToolListOutcome › error: notConnected', class: 'b', why: 'McpOAuthNotConnectedError "press Connect" sentence (Sync Tools answer)' },
  { site: 'lib/ai/mcp.js › syncToolListOutcome › markServerError(message)', class: 'b', why: 'the transport\'s authored sentence, stored as the MCP card\'s lastError' },
  { site: 'lib/ai/mcp.js › syncToolListOutcome › markServerNeedsConnection(notConnected)', class: 'b', why: 'McpOAuthNotConnectedError sentence, stored as the MCP card status' },
  { site: 'lib/ai/mcp.js › syncToolListOutcome › mcpAuthError(message)', class: 'b', why: 'the transport\'s authored sentence handed on as mcpAuthError\'s fallback' },
  { site: 'lib/ai/mcp.js › validatedMcpUrl › error: authoredMessage(error, \'The MCP server URL or key binding was refused.\')', class: 'b', why: 'McpPolicyError URL/key-binding sentence (admin MCP routes)' },
  { site: 'lib/ai/model-catalog.js › listEveryProvider › error: authoredMessage(error, `The model list could not be read (${errorCode(error)}).`)', class: 'b', why: 'CatalogListError sentence or the code; refresh answer and the card lastError' },
  { site: 'lib/ai/router.js › callWithFailover › error: error', class: 'c', why: 'keeps each attempt\'s error for failover; budgetExhausted records only codes' },
  { site: 'lib/ambassador/validate.js › validateWith › error: authoredMessage(error, \'A field was refused.\')', class: 'b', why: 'FieldError sentences written in this validator (admin ambassador hub)' },
  { site: 'lib/credentials/cloudflare-roll.js › rollAndApplyCloudflareToken › warning: `Token applied, but post-write verification returned: ${verificationWarning}`', class: 'c', why: 'returns diagnostic warning from roll orchestrator; library module, no HTTP response body' },
  { site: 'lib/credentials/cloudflare-roll.js › rollCloudflareToken › return e.message', class: 'c', why: 'throws an Error with Cloudflare roll-token error messages; library module, no HTTP response body' },
  { site: 'lib/credentials/cloudflare-roll.js › verifyCloudflareToken › return e.message', class: 'c', why: 'throws an Error with Cloudflare verification error messages; library module, no HTTP response body' },
  { site: 'lib/cloud-tools/explain/kinds/landingZone.js › validateLandingZoneExplainRequest › error: authoredMessage(error, \'The request was refused.\')', class: 'b', why: 'PUBLIC: Refusal sentences; public-visitor-copy.test.js holds them to visitor language' },
  { site: 'lib/cloud-tools/explain/validate.js › validateExplainRequest › error: authoredMessage(error, \'The request was refused.\')', class: 'b', why: 'PUBLIC: Refusal sentences; public-visitor-copy.test.js holds them to visitor language' },
  { site: 'lib/cloud-tools/refresh.js › run › error: recordedFailure(log, "The region\'s price history could not be written.", error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the pricing refresh job result (failed[]), read by getJob' },
  { site: 'lib/cloud-tools/refresh.js › run › error: recordedFailure(log, \'The region could not be refreshed.\', error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the pricing refresh job result (failed[]), read by getJob' },
  { site: 'lib/cms/content-create.js › createContentDocument › error: authoredMessage(error, "The kind or idea origin was refused.")', class: 'b', why: 'TaxonomyFieldError sentence (field, id sent, allowed ids)' },
  { site: 'lib/cms/content-update.js › parseUpdateBody › error: authoredMessage(error, "The updates could not be read.")', class: 'b', why: 'ContentValidationError sentences from the update validator' },
  { site: 'lib/cms/content-update.js › settleLinkedBlogs › .error = error', class: 'c', why: 'hands the error to the update handler, which re-throws it into errorResponse' },
  { site: 'lib/cms/content-update.js › taxonomyRefusal › error: authoredMessage(error, "The kind or idea origin was refused.")', class: 'b', why: 'TaxonomyFieldError sentence (field, id sent, allowed ids)' },
  { site: 'lib/cms/drafts-handlers.js › answerFor › error: authoredMessage(error, `Could not ${what}.`)', class: 'b', why: 'DraftInputError, ContentValidationError and TaxonomyFieldError sentences on the 400' },
  { site: 'lib/cms/image-prompts/actions.js › promptFieldsOf › error: authoredMessage(error, \'The prompt was refused.\')', class: 'b', why: 'ContentValidationError sentences; other errors go to the route 500' },
  { site: 'lib/cms/image-prompts/actions.js › savePageAssignment › error: authoredMessage(error, \'That page cannot take a prompt set.\')', class: 'b', why: 'ContentValidationError page-allowlist sentence; other errors go to the route 500' },
  { site: 'lib/cms/image-prompts/actions.js › saveSetFields › error: authoredMessage(error, \'The prompt set was refused.\')', class: 'b', why: 'ContentValidationError sentences; a failed read goes to the route 500' },
  { site: 'lib/cms/inline-images.js › one › leaveAlone(String(error?.message || error || \'unknown\'))', class: 'c', why: 'reaches only the scrubbed warn line; the stored summary keeps counts and URLs' },
  { site: 'lib/cms/publish.js › processPublishContent › error: authoredMessage(err, \'Publishing stopped on an unexpected failure.\')', class: 'b', why: 'an authored refusal or this module\'s sentence; publish, set-slug and the Telegram job read it' },
  { site: 'lib/content-workflow/editor.js › validateSaveEditorDraftBody › error: authoredMessage(error, \'The draft could not be validated.\')', class: 'b', why: 'ContentValidationError sentences (admin editor save)' },
  { site: 'lib/content/critique.js › critiqueDraft › error: storedFailure(err, \'The critique could not run.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): contentQuality.critique.error, shown in the editor\'s quality panel' },
  { site: 'lib/content/draft-from-recording.js › createContentFromRecording › ...failureFields( context, \'The draft could not be created from this recording.\', error, request )', class: 'b', why: 'RecordingDraftError and AI router refusals shown; provider text is not; correlation id' },
  { site: 'lib/content/draft-from-recording.js › createContentFromRecording › details: details', class: 'b', why: 'a RecordingDraftError\'s details: content-create\'s own refusal body (dedup, quality)' },
  { site: 'lib/content/draft-from-url.js › generateArticleDraft › json(failureFields(context, \'The draft could not be generated.\', error, request))', class: 'b', why: 'UrlDraftError and AI router refusals shown; provider text is not; correlation id' },
  { site: 'lib/content/forge-studio/assist.js › runAssist › ...failureFields(context, \'The assist did not finish.\', error)', class: 'b', why: 'AI router refusals (not configured, switched off, budget) shown; provider text is not' },
  { site: 'lib/content/forge-studio/config.js › updateForgeConfig › json(failureFields(context, \'The Forge configuration could not be saved.\', error))', class: 'b', why: 'failureFields: an authored refusal or the safe sentence, with a correlation id' },
  { site: 'lib/content/forge-studio/queue.js › forgeOne › failed: authoredMessage(error, fallback)', class: 'b', why: 'JobPayloadTooLargeError sentence (newJobDoc\'s bound) or one of two fixed ones, chosen by whether the revert was confirmed; the store\'s words never reach notStarted' },
  { site: 'lib/content/forge-studio/queue.js › guarded › json(failureFields(context, \'The queue could not be updated.\', error, request))', class: 'b', why: 'failureFields: an authored refusal or the safe sentence, with a correlation id' },
  { site: 'lib/content/forge-studio/workspace.js › patchUnderEtag › refuse(failureFields(context, \'The draft could not be saved.\', error))', class: 'b', why: 'failureFields: an authored refusal or the safe sentence, with a correlation id' },
  { site: 'lib/content/forge-studio/workspace.js › saveBrief › json(failureFields(context, \'The brief could not be saved.\', error))', class: 'b', why: 'failureFields: an authored refusal or the safe sentence, with a correlation id' },
  { site: 'lib/content/forge.js › runForgePipeline › error: recordedFailure(log, \'Generation failed.\', err)', class: 'b', why: 'stored at write time through the door (#945 step 2): the forge outcome, stored as the job result and job.error' },
  { site: 'lib/content/forge.js › runForgePipeline › note: recordedFailure(log, \'Grading failed.\', err)', class: 'b', why: 'the grade\'s note, through the door (#945 step 2): kept in memory only; forgeGrade stores overall and subs, not the note' },
  { site: 'lib/content/inspect-job.js › run › inspectError: recordedFailure(log, \'The inspection failed.\', error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the document\'s inspectError; the public content read has not returned it since #1201 (an allowlist of fields)' },
  { site: 'lib/content/scrape.js › scrapeArticle › failure(reason)', class: 'b', why: 'FetchRefusedError/ScrapeError sentence or the failure\'s code; carried to the draft routes', times: 2 },
  { site: 'lib/decision-center/sources.js › toItem › [row.message]', class: 'n', why: 'a workflow alert\'s own message field, not an error\'s: no writer stores error text there (raiseAlert in link-check and the publishing watchdog, and buildPublishFailureAlert, write none)' },
  { site: 'lib/doc-vault/handlers.js › answerFor › error: authoredMessage(error, `Could not ${what}.`)', class: 'b', why: 'DocVaultInputError sentences on the 400: they name the rule a field broke and never repeat what was sent (model.test.js, handlers.test.js "puts none of it in a refusal either")' },
  { site: "lib/doc-vault/markdown.js › parseVaultFile › refuse(authoredMessage(error, 'The file could not be read as a document.'))", class: 'b', why: 'DocVaultInputError sentences for an uploaded file that breaks a document rule; they name the rule, not the text' },
  { site: 'lib/gallery/import.js › fetchForImport › refuse(`Could not fetch image: ${reason}`)', class: 'b', why: 'FetchRefusedError sentence (URL masked) or the failure\'s code on the 422' },
  { site: 'lib/health/probe-results.js › putProbeResult › error: authoredMessage(error, \'The result changed while it was written.\')', class: 'b', why: 'the CONFLICT AuthoredError written in writeResult' },
  { site: 'lib/health/pulse-checks.js › cosmosFailure › result(storedFailure(error, \'The ops-health snapshot could not be read.\'))', class: 'b', why: 'stored at write time through the door (#945 step 2): the pulse result the Health view shows' },
  { site: 'lib/health/pulse.js › run › error: recordedFailure(log, \'The check failed.\', row.error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the pulse document\'s failures' },
  { site: 'lib/health/pulse.js › run › error: recordedFailure(log, \'The check result was not recorded.\', error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the pulse document\'s failures' },
  { site: 'lib/health/pulse.js › snapshotChecks › error: error', class: 'c', why: 'a row for run(), which stores each failure through recordedFailure (class b)' },
  { site: 'lib/health/pulse.js › timed › error: error', class: 'c', why: 'a row for run(), which stores each failure through recordedFailure (class b)' },
  { site: 'lib/integrations/connection-probe.js › authenticateProbe › refused: error', class: 'c', why: 'the ProbeAuthenticationError, answered through the door by the handler' },
  { site: 'lib/integrations/connection-probe.js › handler › error: `${authoredMessage(refused, \'The token exchange was refused\')}.`', class: 'b', why: 'ProbeAuthenticationError sentence; the token endpoint\'s own words stay out' },
  { site: 'lib/integrations/connection-probe.js › handler › error: `${probe.service} cannot be tested: ${setting} ${authoredMessage(error, \'cannot be used in the request\')}`', class: 'b', why: 'UnusableCredentialError sentence naming the setting, never its value' },
  { site: 'lib/integrations/rest-proxy.js › handler › error: authoredMessage(error, \'The path was refused.\')', class: 'b', why: 'UnsafePathError sentence for a refused proxy path' },
  { site: 'lib/integrations/upstream-error.js › readUpstreamError › [data.message]', class: 's', why: 'kept by decision (#463, #358): the provider\'s sentence on a 401/403 is the diagnosis (Publer\'s 401 means the workspace id); stored only as lastFailDetail on the key verdict, which the super_admin API-keys page alone reads, and the probe and proxy already relay the redacted body to that page' },
  { site: 'lib/jobs.js › runJob › truncate(storedFailure(error, timedOut ? \'The job ran out of time.\' : \'The job failed.\', { correlationId, }))', class: 'b', why: 'stored at write time through the door (#945 step 2): job.error, read back by getJob, with the log line\'s reference' },
  { site: 'lib/labs/coder-status.js › verifiedRead › error: error', class: 'c', why: 'the read error for the caller to name by status; its message is not read' },
  { site: 'lib/labs/drift.js › describeReadError › return isAuthoredError(error) && error.code ? `${error.code}: ${sentence}` : sentence', class: 'b', why: 'stored at write time through the door (#945 step 2): the drift read\'s lastError on the Labs card' },
  { site: 'lib/labs/drift.js › toCommit › title: message.split(\'\\n\')[0].trim().slice(0, MAX_TITLE_LENGTH)', class: 'n', why: 'a GitHub commit\'s title (commit.message), not an error' },
  { site: 'lib/labs/lab-checks.js › unreadable › result(storedFailure(error, "The check\'s data could not be read."))', class: 'b', why: 'stored at write time through the door (#945 step 2): the lab check result the Labs page shows' },
  { site: 'lib/listen-and-learn/generate.js › generateEpisodes › error: failure', class: 'b', why: 'stored at write time through the door (#945 step 2): the episode\'s error and lastError (persistFailure) and the job result; the public Listen & Learn read has not returned it since #1201 (an allowlist of fields)', times: 2 },
  { site: 'lib/listen-and-learn/generate.js › generateEpisodes › videoError: videoError', class: 'b', why: 'stored at write time through the door (#945 step 2): the generation job result, read by getJob' },
  { site: 'lib/listen-and-learn/generate.js › renderAudio › error: authoredMessage(err, \'No speech provider is configured.\')', class: 'b', why: 'SpeechNotConfiguredError sentence naming the setting (admin episode state)' },
  { site: 'lib/listen-and-learn/library.js › parseChapterCreate › error: authoredMessage(err, \'The chapter title cannot be made into an id.\')', class: 'b', why: 'EpisodeIdError sentence on the create-chapter 400' },
  { site: 'lib/listen-and-learn/source-episode.js › generateSourceEpisode › error: storedFailure(err, \'The episode could not be generated.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the episode\'s error and lastError (persistFailure); the public Listen & Learn read has not returned it since #1201 (an allowlist of fields)' },
  { site: 'lib/listen-and-learn/source-episode.js › parseSourceEpisodePayload › error: authoredMessage(err, \'The episode title cannot be made into an id.\')', class: 'b', why: 'EpisodeIdError sentence on the enqueue 400' },
  { site: 'lib/listen-and-learn/source-episode.js › parseSourceEpisodePayload › error: authoredMessage(err, \'The sources were refused.\')', class: 'b', why: 'InvalidSourcesError sentences about the URLs the editor typed' },
  { site: 'lib/listen-and-learn/speech-handlers.js › taskModelReport › error: authoredMessage(err, \'The speech model could not be chosen.\')', class: 'b', why: 'AI router refusal (not configured, switched off) on the speech options answer' },
  { site: 'lib/listen-and-learn/speech/elevenlabs-account.js › errorMessage › return message.replace(KEY_PATTERN, \'[key]\').replace(/\\s+/g, \' \').trim().slice(0, 300)', class: 'c', why: 'read only to test for the word permission (isPermissionAnswer); never shown' },
  { site: 'lib/listen-and-learn/speech/gemini.js › describeErrors › return `${e?.code || \'unknown\'}: ${String(e?.message || \'\').slice(0, 200) || \'no message\'}`', class: 'c', why: 'composes a GeminiSpeechError (not authored) that is thrown on; the door replaces it' },
  { site: 'lib/listen-and-learn/speech/index.js › describeSpeechProviders › pinError: pinError', class: 'b', why: 'SpeechNotConfiguredError pin sentence on the speech options answer' },
  { site: 'lib/listen-and-learn/videos.js › findVideosForAreas › error: failure', class: 'b', why: 'stored at write time through the door (#945 step 2): the generation job result (per-area video error)' },
  { site: 'lib/manual-images/shared.js › generationFailure › message: authoredMessage(error, \'Image generation is paused by the monthly budget.\')', class: 'b', why: 'ImageBudgetError sentence (totals and settings) so the page can say paused' },
  { site: 'lib/newsletter/admin-handlers.js › recordBroadcast › error: error', class: 'c', why: 'hands the error to sentButUnrecorded, which logs errorMeta (name and code) only' },
  { site: 'lib/newsletter/issue.js › describeAiError › return authoredMessage(error, `the AI call failed (${errorCode(error)})`).slice(0, 300)', class: 'b', why: 'AI router refusals shown to the owner; provider text becomes "the AI call failed (code)"' },
  { site: 'lib/notify.js › formatTelegramText › return `${severityPrefix(severity)} ${title}\\n\\n${message}\\n\\nReported by ${displayName}.`', class: 'c', why: 'the owner\'s Telegram message, not an HTTP response' },
  { site: 'lib/notify.js › notifyTelegram › message: message', class: 'c', why: 'the owner\'s Telegram message, not an HTTP response' },
  { site: 'lib/platform-settings.js › normalizedSettingValue › error: authoredMessage(error, \'The setting was refused.\')', class: 'b', why: 'a normalizer refusal (PlatformSettingValidationError, TaxonomyError, RemindersValidationError)' },
  { site: 'lib/platform-settings.js › presentSetting › problem: authoredMessage(error, \'The stored value no longer passes validation.\')', class: 'b', why: 'a normalizer refusal for the stored value (PlatformSettingValidationError and kin)' },
  { site: 'lib/platform-settings.js › writeMerged › error: authoredMessage(error, \'The setting was refused.\')', class: 'b', why: 'a merge refusal (RemindersValidationError) on the 400' },
  { site: 'lib/podcast/elevenlabs-admin.js › listVoices › voicesError: authoredMessage(error, \'The ElevenLabs voices could not be listed.\')', class: 'b', why: 'ElevenLabsSpeechError sentence (permission and where to set it), no provider text' },
  { site: 'lib/podcast/elevenlabs-admin.js › previewRefusal › error: authoredMessage(error, \'The voice preview could not be fetched.\')', class: 'b', why: 'ElevenLabsSpeechError preview sentence, no provider text' },
  { site: 'lib/podcast/elevenlabs-admin.js › readAccountState › subscriptionError: authoredMessage(error, \'The ElevenLabs subscription could not be read.\')', class: 'b', why: 'ElevenLabsSpeechError sentence (permission and where to set it), no provider text' },
  { site: 'lib/podcast/elevenlabs-admin.js › renderSample › error: authoredMessage(error, \'The podcast voice model could not be chosen.\')', class: 'b', why: 'AI router refusal for the podcastVoice task' },
  { site: 'lib/podcast/elevenlabs-admin.js › renderSample › error: authoredMessage(error, \'The sample could not be rendered.\')', class: 'b', why: 'SpeechError/ElevenLabsSpeechError sentence (credit, plan, voices), no provider text' },
  { site: 'lib/podcast/generate.js › generateTranscriptFromArticle › error: err', class: 'c', why: 'hands the error to recordScriptFailure, which stores storedFailure\'s sentence (class b)' },
  { site: 'lib/podcast/generate.js › recordScriptFailure › error: storedFailure(error, \'The script could not be written.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the transcript document\'s error' },
  { site: 'lib/podcast/generate.js › renderAudio › error: storedFailure(err, \'Audio was synthesised but not stored.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the transcript document\'s audioError' },
  { site: 'lib/podcast/generate.js › renderAudio › error: storedFailure(err, \'The audio could not be synthesised.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the transcript document\'s audioError' },
  { site: 'lib/podcast/generate.js › renderAudio › error: storedFailure(err, \'The podcast voice model could not be chosen.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the transcript document\'s audioError' },
  { site: 'lib/podcast/generate.js › renderAudio › error: storedFailure(err, \'The podcast voices could not be read.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the transcript document\'s audioError' },
  { site: 'lib/podcast/handlers.js › generateTranscript › error: authoredMessage(err, \'This article cannot be keyed as a transcript.\')', class: 'b', why: 'TranscriptKeyError sentence naming the article id' },
  { site: 'lib/podcast/handlers.js › reviewTranscript › doc: error?.latest ?? { ...existing, ...updated }', class: 'c', why: 'the document a conflict error carries, not its text' },
  { site: 'lib/podcast/host-publish.js › toRecordedError › message: storedFailure(error, \'The Podbean step failed unexpectedly.\')', class: 'b', why: 'stored at write time through the door (#945 step 2): the host-publish record, and the hub\'s overview and stats answers' },
  { site: 'lib/podcast/podbean.js › describeErrorBody › [data.message]', class: 'c', why: 'the scrubbed provider text kept on PodbeanError.detail, in memory only: the message (authored since #945) names the status and the code, and nothing stores or logs detail' },
  { site: 'lib/podcast/podbean.js › transportError › scrub(error?.message || String(error))', class: 'c', why: 'the scrubbed provider text kept on PodbeanError.detail, in memory only: the message (authored since #945) names the status and the code, and nothing stores or logs detail' },
  { site: 'lib/podcast/podbean.js › uploadMedia › scrub(error?.message || String(error))', class: 'c', why: 'the scrubbed provider text kept on PodbeanError.detail, in memory only: the message (authored since #945) names the status and the code, and nothing stores or logs detail' },
  { site: 'lib/podcast/recording-generate.js › generateTranscriptFromRecording › error: err', class: 'c', why: 'hands the error to recordScriptFailure, which stores storedFailure\'s sentence (class b)' },
  { site: 'lib/public-preview.js › projectForgeGrade › message: typeof finding.message === \'string\' ? finding.message : \'\'', class: 'n', why: 'an SEO lint finding\'s own sentence (content/seo-lint.js writes every one), projected for the preview banner (#1201); not an error' },
  { site: 'lib/rss/ingest.js › processRssFeeds › push(`${provider}/${feed.name}: ${recordedFailure(log, \'The feed could not be read.\', err)}`)', class: 'b', why: 'stored at write time through the door (#945 step 2): the RSS job result (errors[]), read by getJob' },
  { site: 'lib/rss/ingest.js › processRssFeeds › push(`homepage_feeds: ${recordedFailure(log, \'The homepage feed could not be rebuilt.\', err)}`)', class: 'b', why: 'stored at write time through the door (#945 step 2): the RSS job result (errors[]), read by getJob' },
  { site: 'lib/scheduled-publish.js › publishDue › error: recordedFailure(context, \'The publish failed.\', error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the scheduled-publish failure alert' },
  { site: 'lib/scheduled-publish.js › recordRun › error: recordedFailure(context, \'The scheduled publish run failed.\', error)', class: 'b', why: 'stored at write time through the door (#945 step 2): the scheduled-publish run record on the digest' },
  { site: 'lib/streamyard/onair.js › publicRegister › error: authoredMessage(err, "Too many requests — try again later.")', class: 'b', why: 'PUBLIC: SubmissionRateLimitError sentence, vendor-free' },
  { site: 'lib/telegram/bot.js › formatAlerts › return `• ${a.id} — ${a.title || a.message || \'untitled\'} (${a.severity || \'info\'})`', class: 'c', why: 'an alert\'s text in the owner\'s Telegram reply' },
  { site: 'lib/telegram/bot.js › handleUpdate › detail: detail', class: 'b', why: 'stored at write time through the door (#945 step 2): telegram_bot_activity' },
  { site: 'lib/telegram/bot.js › handleUpdate › reply: reply', class: 'b', why: 'handleUpdate result: on a failure, the stored sentence from the door (CodeRabbit on #1200); logged by the webhook as handled/ignored only', times: 2 },
  { site: 'lib/telegram/bot.js › handleUpdate › send(reply)', class: 'b', why: 'the owner\'s Telegram reply: on a failure, the door\'s stored sentence with code and reference, never the error\'s words (CodeRabbit on #1200)' },
  { site: 'lib/timers/ai-provider-probe.js › refreshCatalog › error: String(error?.message || error)', class: 'c', why: 'the timer run summary, only logged' },
  { site: 'lib/timers/blog-listings.js › run › error: err?.message || String(err)', class: 'c', why: 'the timer run summary, only logged' },
  { site: 'lib/timers/delivery-monitor-watch.js › describeReadError › return isAuthoredError(error) && error.code ? `${error.code}: ${sentence}` : sentence', class: 'b', why: 'stored at write time through the door (#945 step 2): the delivery watch read\'s lastError on its admin_config record, read by no HTTP route' },
  { site: 'lib/timers/forge-scheduled.js › run › error: err?.message || String(err)', class: 'c', why: 'the timer run summary, only logged (failures stripped from the line)' },
  { site: 'lib/timers/mcp-token-refresh.js › run › error: String(error?.message || error).slice(0, 300)', class: 'c', why: 'the timer run summary, only logged' },
  { site: 'lib/timers/newsletter-autobuild.js › buildAutoBuildMessage › message: `${result?.message || \'The builder refused to build this issue.\'}\\n\\nNothing was overwritten and nothing was sent.\\n${dr', class: 'c', why: 'the owner\'s Telegram message about the Monday build' },
  { site: 'lib/timers/newsletter-autobuild.js › buildAutoBuildMessage › message: `${result.message}\\n\\nNothing was sent and no draft was written.`', class: 'c', why: 'the owner\'s Telegram message about the Monday build' },
  { site: 'lib/timers/newsletter-autobuild.js › run › message: `The Monday build of the weekly newsletter failed: ${reason}\\n\\nNothing was sent. You can build it from the Newsletter H', class: 'c', why: 'the owner\'s Telegram message about the Monday build' },
  { site: 'lib/timers/plaud-token.js › run › lastTokenRefreshError: recordedFailure(log, \'The token refresh failed.\', err)', class: 'b', why: 'stored at write time through the door (#945 step 2): the Plaud connection\'s lastTokenRefreshError' },
  { site: 'lib/timers/podcasts.js › processFeed › error: message', class: 'c', why: 'the timer run summary, only logged' },
  { site: 'lib/timers/podcasts.js › run › error: message', class: 'c', why: 'the timer run summary, only logged' },
  { site: 'lib/timers/reminders.js › sayReminder › message: message', class: 'c', why: 'the owner\'s Telegram reminder' },
  { site: 'lib/timers/skills-hub.js › run › error: err?.message || String(err)', class: 'c', why: 'the timer run summary, only logged' },
  { site: 'lib/triggers/ai-cover.js › assertImageBudget › cause: cause', class: 'c', why: 'the cause rides on ImageBudgetError (non-enumerable) for the log; never serialised' },
  { site: 'lib/triggers/ai-cover.js › run › .altCoverImageError = `fallback: default hero (${failure})`', class: 'b', why: 'stored at write time through the door (#945 step 2): the document\'s altCoverImageError; the public content read has not returned it since #1201 (an allowlist of fields)' },
  { site: 'lib/triggers/ai-cover.js › run › altCoverImageError: failure', class: 'b', why: 'stored at write time through the door (#945 step 2): the document\'s altCoverImageError; the public content read has not returned it since #1201 (an allowlist of fields)' },
  { site: 'lib/triggers/ai-cover.js › run › reason: fallbackApplied ? `error_with_default_hero: ${err?.message || err}` : `error: ${err?.message || err}`', class: 'c', why: 'the trigger result, only logged by the change feed' },
  { site: 'lib/triggers/forge-ready-notify.js › run › reason: `error: ${err?.message || err}`', class: 'c', why: 'the trigger result, only logged by the change feed' },
  { site: 'lib/triggers/handlers.js › content › inspectError: recordedFailure(context, \'The inspection failed.\', err)', class: 'b', why: 'stored at write time through the door (#945 step 2): the document\'s inspectError; the public content read has not returned it since #1201 (an allowlist of fields)' },
  { site: 'lib/triggers/handlers.js › runEach › error: err?.message || String(err)', class: 'c', why: 'the change-feed batch results, only logged' },
  { site: 'lib/triggers/handlers.js › socialPosts › syncError: recordedFailure(context, \'The post could not be synced to Publer.\', err)', class: 'b', why: 'stored at write time through the door (#945 step 2): the social post\'s syncError' },
  { site: 'lib/triggers/image-mirror.js › generateTemplateCover › reason: `error: ${err?.message || err}`', class: 'c', why: 'the trigger result, only logged by the change feed' },
  { site: 'lib/triggers/image-mirror.js › mirror › reason: `error: ${err?.message || err}`', class: 'c', why: 'the trigger result, only logged by the change feed' },
  { site: 'lib/triggers/social-caption-trigger.js › run › reason: `error: ${err?.message || err}`', class: 'c', why: 'the trigger result, only logged by the change feed' },
  { site: 'lib/triggers/social-caption-trigger.js › run › socialCaptionError: recordedFailure(log, \'The social caption could not be written.\', err)', class: 'b', why: 'stored at write time through the door (#945 step 2): the document\'s socialCaptionError; the public content read has not returned it since #1201 (an allowlist of fields)' },
];

describe('no raw error text in HTTP response bodies (AP-B10, #945)', () => {
  // A parse of every module under functions/src and a fixpoint over carried
  // text: deterministic work that took 6.1 s on a CI runner (vitest's default
  // is 5 s) and about half that on a workstation. The budget is for the work,
  // not for a flake; a scan that grows past it should be made faster.
  it('scans every module under functions/src, and every site is converted or decided', { timeout: 60_000 }, () => {
    const modules = realTree();
    expect(Object.keys(modules).length).toBeGreaterThan(300);
    expect(modules[DOOR_MODULE]).toBeDefined();
    const { unlisted, stale, misfiled } = judge(scanSources(modules, { allowed: ALLOWED }), ALLOWED);
    expect(unlisted, `error text reaches a value that leaves its function:\n${unlisted.join('\n')}`).toEqual([]);
    expect(stale, `allowlist entries that no longer match anything:\n${stale.join('\n')}`).toEqual([]);
    expect(misfiled, `allowlist entries in the wrong class:\n${misfiled.join('\n')}`).toEqual([]);
  });
});

describe('the scan itself', () => {
  /** The site keys a one-module tree yields. */
  const sitesIn = (source, file = 'lib/x.js') => scanSources({ [file]: source }).map((s) => s.key);
  /** A one-route module whose handler body is the given source. */
  const handler = (body) => `
    const json = (status, body) => ({ status, body: JSON.stringify(body) });
    export async function handle(request, context) {
      try { await work(); } catch (oops) { ${body} }
    }`;

  it('finds .message under any name, with or without ?., in any file', () => {
    expect(sitesIn(handler('return json(500, { error: oops.message });'), 'lib/new/anywhere.js')).toEqual([
      'lib/new/anywhere.js › handle › error: oops.message',
    ]);
    expect(sitesIn(handler('return json(500, { message: oops?.message });'))).toEqual([
      'lib/x.js › handle › message: oops?.message',
    ]);
  });

  it('finds an error stringified: String(e), a template literal, concatenation, toString', () => {
    expect(sitesIn(handler('return json(500, { error: String(oops) });'))).toEqual([
      'lib/x.js › handle › error: String(oops)',
    ]);
    expect(sitesIn(handler('return json(500, { error: `failed: ${oops}` });'))).toEqual([
      'lib/x.js › handle › error: `failed: ${oops}`',
    ]);
    expect(sitesIn(handler("return json(500, { error: 'failed: ' + oops });"))).toEqual([
      "lib/x.js › handle › error: 'failed: ' + oops",
    ]);
    expect(sitesIn(handler('return json(500, { error: oops.toString() });'))).toEqual([
      'lib/x.js › handle › error: oops.toString()',
    ]);
  });

  it('follows an alias, a destructured message and a .catch() parameter', () => {
    expect(sitesIn(handler("const why = oops?.message ?? 'x'; return json(500, { error: why });"))).toEqual([
      'lib/x.js › handle › error: why',
    ]);
    expect(sitesIn(handler('const { message } = oops; return json(500, { error: message });'))).toEqual([
      'lib/x.js › handle › error: message',
    ]);
    expect(
      sitesIn(`const json = (s, b) => ({ status: s, body: b });
        export const read = () => load().catch((problem) => json(500, { error: \`\${problem}\` }));`)
    ).toEqual(['lib/x.js › read › error: `${problem}`']);
  });

  it('finds text laundered into a helper and out of one', () => {
    expect(sitesIn(handler('return refuse(400, oops.message);'))).toEqual(['lib/x.js › handle › refuse(oops.message)']);
    expect(sitesIn('export function why(failure) { return failure.message; }')).toEqual([
      'lib/x.js › why › return failure.message',
    ]);
    expect(sitesIn(handler('errors.push(`${id}: ${oops.message}`);'))).toEqual([
      'lib/x.js › handle › push(`${id}: ${oops.message}`)',
    ]);
  });

  it('marks a site inside a response body, through a builder in another module', () => {
    const sites = scanSources({
      'lib/http/reply.js': 'export const reply = (status, body) => ({ status, jsonBody: body });',
      'lib/y.js': `import { reply } from './http/reply.js';
        export async function h() { try { await go(); } catch (e) { return reply(500, { error: e.message }); } }`,
    });
    expect(sites).toEqual([expect.objectContaining({ key: 'lib/y.js › h › error: e.message', inResponse: true })]);
  });

  it('counts a whole error only where a builder serialises it', () => {
    expect(sitesIn(handler('return json(500, oops);'))).toEqual(['lib/x.js › handle › json(oops)']);
    expect(sitesIn(handler("return errorResponse(context, 'Failed to save', oops, 500, request);"))).toEqual([]);
    expect(sitesIn(handler("return errorResponse(context, `Failed: ${oops.message}`, oops);"))).toEqual([
      'lib/x.js › handle › errorResponse(`Failed: ${oops.message}`)',
    ]);
  });

  it('treats a local alias of a log call as a log line', () => {
    expect(
      sitesIn(`export function sweep(log) {
        const warn = (...a) => log.warn?.(...a);
        try { go(); } catch (err) { warn(\`failed: \${err?.message}\`); }
      }`)
    ).toEqual([]);
  });

  it('follows a destructured builder argument property by property', () => {
    const sites = scanSources({
      'lib/d.js': `const json = (status, body) => ({ status, body: JSON.stringify(body) });
        const refused = ({ status, code, error }) => json(status, { ok: false, code, error });
        const unrecorded = ({ id, error }) => json(500, { ok: false, id, why: errorCode(error) });
        export async function h() {
          try { await go(); } catch (e) {
            if (e.code === 1) return unrecorded({ id: 'x', error: e });
            return refused({ status: 400, code: 'BAD', error: e.message });
          }
        }`,
    });
    expect(sites).toEqual([
      expect.objectContaining({ key: 'lib/d.js › h › error: e', kind: 'error', inResponse: false }),
      expect.objectContaining({ key: 'lib/d.js › h › error: e.message', kind: 'text', inResponse: true }),
    ]);
  });

  it('refuses an authored error built from someone else\'s text', () => {
    const sites = scanSources({
      'lib/http/error-response.js': 'export class AuthoredError extends Error {}',
      'lib/z.js': `import { AuthoredError } from './http/error-response.js';
        class Refused extends AuthoredError {}
        export function wrap(e) { return new Refused(\`no: \${e.message}\`); }`,
    });
    expect(sites.map((s) => s.key)).toEqual(['lib/z.js › wrap › new Refused(`no: ${e.message}`)']);
  });

  it('reports a door call as authored, and leaves logs, tests and re-throws alone', () => {
    const sites = scanSources({
      'lib/http/error-response.js': 'export function authoredMessage(e, f) { return f; }',
      'lib/q.js': `import { authoredMessage } from './http/error-response.js';
        const json = (s, b) => ({ status: s, body: b });
        export async function h(context) {
          try { await go(); } catch (error) {
            context.error?.('failed', error.message);
            if (error.message.includes('timeout')) throw new Error(\`timed out: \${error.message}\`);
            return json(400, { error: authoredMessage(error, 'That did not work.') });
          }
        }`,
    });
    expect(sites).toEqual([
      expect.objectContaining({
        key: "lib/q.js › h › error: authoredMessage(error, 'That did not work.')",
        kind: 'authored',
        inResponse: true,
      }),
    ]);
  });

  it('does not take a look-alike for the door: a local authoredMessage is scanned like any helper', () => {
    expect(
      sitesIn(`const authoredMessage = (e) => e.message;
        const json = (s, b) => ({ status: s, body: b });
        export function h() { try { go(); } catch (error) { return json(500, { error: authoredMessage(error) }); } }`)
    ).toEqual(['lib/x.js › authoredMessage › return e.message']);
  });

  it('(a) follows a stored decision out of an awaited helper result into a response body (M1: the hub reads)', () => {
    const modules = {
      'lib/podcast/record.js': `export function toRecorded(error) {
          return { status: null, message: error?.message ? String(error.message) : String(error) };
        }`,
      'lib/podcast/reads.js': `import { toRecorded } from './record.js';
        async function settle(read) {
          try { return { value: await read() }; } catch (error) { return { error: toRecorded(error) }; }
        }
        export async function readOverview(client) {
          const show = await settle(() => client.getShow());
          const errors = {};
          if (show.error) errors.show = show.error;
          return { show: show.value ?? null, errors };
        }`,
      'lib/podcast/handlers.js': `import { readOverview } from './reads.js';
        const json = (status, body) => ({ status, body: JSON.stringify(body) });
        export async function getOverview(client) {
          const overview = await readOverview(client);
          return json(200, { success: true, ...overview });
        }`,
    };
    const allowed = [
      {
        site: 'lib/podcast/record.js › toRecorded › message: error?.message ? String(error.message) : String(error)',
        class: 's',
        why: 'stored on the host record',
      },
    ];
    const sites = scanSources(modules, { allowed });
    expect(sites).toContainEqual(
      expect.objectContaining({ key: 'lib/podcast/handlers.js › getOverview › ...overview', kind: 'carried', inResponse: true })
    );
    expect(judge(sites, allowed).unlisted).toEqual([
      expect.stringContaining('carried IN RESPONSE — lib/podcast/handlers.js › getOverview › ...overview'),
    ]);
    // The decision is what makes the helper a source: undecided, nothing is carried.
    expect(scanSources(modules).some((s) => s.kind === 'carried')).toBe(false);
  });

  it('(a) follows a site handed straight back through a helper call (M2: the lab checks)', () => {
    const modules = {
      'lib/labs/checks.js': `const result = (status, summary) => ({ status, summary });
        const unreadable = (error) => result('unknown', \`The check could not be read: \${error?.message || error}\`);
        export async function readChecks(store) {
          let drift;
          try { drift = result('healthy', await store.read('drift')); } catch (error) { drift = unreadable(error); }
          return { drift };
        }`,
      'lib/labs/route.js': `import { readChecks } from './checks.js';
        const json = (status, body) => ({ status, body: JSON.stringify(body) });
        export async function getChecks(store) { return json(200, await readChecks(store)); }`,
    };
    const allowed = [
      {
        site: 'lib/labs/checks.js › unreadable › result(`The check could not be read: ${error?.message || error}`)',
        class: 's',
        why: 'stored on the check',
      },
    ];
    expect(scanSources(modules, { allowed })).toContainEqual(
      expect.objectContaining({
        key: 'lib/labs/route.js › getChecks › json(await readChecks(store))',
        kind: 'carried',
        inResponse: true,
      })
    );
    // A door call returned on is class b, never a carrier.
    const doored = {
      ...modules,
      'lib/http/error-response.js': 'export function storedFailure(e, f) { return f; }',
      'lib/labs/checks.js': modules['lib/labs/checks.js']
        .replace('const result', "import { storedFailure } from '../http/error-response.js';\n        const result")
        .replace('`The check could not be read: ${error?.message || error}`', "storedFailure(error, 'The check could not be read.')"),
    };
    expect(scanSources(doored, { allowed }).some((s) => s.kind === 'carried')).toBe(false);
  });

  it('(a) follows a carrier behind a lazy import and a dependency default (the Labs snapshot)', () => {
    const modules = {
      'lib/labs/checks.js': `const unreadable = (error) => ({ status: 'unknown', summary: String(error) });
        export async function readChecks(store) {
          const [drift] = await Promise.all([store.read('drift').catch(unreadable)]);
          return { checks: { drift } };
        }`,
      'lib/labs.js': `const readChecksLazily = async (...args) => (await import('./labs/checks.js')).readChecks(...args);
        const json = (status, body) => ({ status, body: JSON.stringify(body) });
        export function createLabs({ store, readChecks = readChecksLazily }) {
          return { async snapshot() { const labChecks = await readChecks(store); return json(200, { checks: labChecks.checks }); } };
        }`,
    };
    const allowed = [{ site: 'lib/labs/checks.js › unreadable › summary: String(error)', class: 's', why: 'stored' }];
    expect(scanSources(modules, { allowed })).toContainEqual(
      expect.objectContaining({ key: 'lib/labs.js › snapshot › checks: labChecks.checks', kind: 'carried', inResponse: true })
    );
  });

  it('(d) resolves an authored superclass through an aliased import, a re-export and a namespace', () => {
    const sites = scanSources({
      'lib/http/error-response.js': 'export class AuthoredError extends Error {}',
      'lib/errors.js': `import { AuthoredError as Base } from './http/error-response.js';
        export class Refusal extends Base {}`,
      'lib/index.js': "export { Refusal as Declined } from './errors.js';",
      'lib/w.js': `import { Declined } from './index.js';
        import * as errors from './errors.js';
        class PlainError extends Error {}
        export function wrap(e) {
          if (e.code === 1) throw new PlainError(e.message);
          if (e.code === 2) throw new errors.Refusal(e.message);
          throw new Declined(\`no: \${e.message}\`);
        }`,
    });
    expect(sites.map((s) => s.key)).toEqual([
      'lib/w.js › wrap › new Refusal(e.message)',
      'lib/w.js › wrap › new Declined(`no: ${e.message}`)',
    ]);
  });

  it('(e) reads a Promise.allSettled rejection as an error, through filters, loops and destructuring', () => {
    expect(
      sitesIn(`const json = (s, b) => ({ status: s, body: JSON.stringify(b) });
        export async function h(reads) {
          const settled = await Promise.allSettled(reads);
          const [first] = settled;
          const failures = settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason));
          for (const r of settled) if (r.reason) return json(500, { error: \`\${r.reason}\` });
          const { reason } = first;
          return json(500, { failures, first: reason?.message, why: String(reason), count: settled.length });
        }`)
    ).toEqual([
      'lib/x.js › h › return String(r.reason)',
      'lib/x.js › h › error: `${r.reason}`',
      'lib/x.js › h › failures: failures',
      'lib/x.js › h › first: reason?.message',
      'lib/x.js › h › why: String(reason)',
    ]);
  });

  it('(b) treats an injected builder called with a literal status as a response', () => {
    const sites = scanSources({
      'lib/inj.js': `export function create({ reply }) {
          return async () => { try { await go(); } catch (e) { return reply(500, { error: e.message }); } };
        }`,
    });
    expect(sites).toEqual([
      expect.objectContaining({ key: 'lib/inj.js › create › error: e.message', inResponse: true }),
    ]);
  });

  it('KNOWN LIMIT (b): an injected builder called with a computed status is not recognised', () => {
    // When this fails because the site is now marked inResponse: true, the
    // limit is fixed: fold the case into the test above and drop the header note.
    const sites = scanSources({
      'lib/inj.js': `export function create({ reply }) {
          return async (status) => { try { await go(); } catch (e) { return reply(status, { error: e.message }); } };
        }`,
    });
    expect(sites).toEqual([
      expect.objectContaining({ key: 'lib/inj.js › create › error: e.message', inResponse: false }),
    ]);
  });

  it('KNOWN LIMIT (c): a whole error handed to a helper that stringifies a differently named parameter', () => {
    // describe(x) makes any value text, but x is neither a caught error nor
    // named like one, so the call's result is not followed into the body.
    // When this fails because a site is found, the limit is fixed: make it a
    // positive test and drop the header note.
    expect(
      sitesIn(`${handler('return json(500, { error: describe(oops) });')}
        function describe(x) { return String(x); }`)
    ).toEqual([]);
  });

  it('judges the list: unlisted, stale, wrong class', () => {
    const sites = [
      { key: 'a', file: 'f', line: 1, kind: 'text', inResponse: true },
      { key: 'b', file: 'f', line: 2, kind: 'authored', inResponse: true },
    ];
    expect(judge(sites, [])).toEqual({
      unlisted: ['f:1 text IN RESPONSE — a', 'f:2 authored IN RESPONSE — b'],
      stale: [],
      misfiled: [],
    });
    const verdict = judge(sites, [
      { site: 'a', class: 'c', why: 'never answered' },
      { site: 'b', class: 'b', why: 'authored' },
      { site: 'gone', class: 'c', why: 'was here once' },
    ]);
    expect(verdict.stale).toEqual(['gone']);
    expect(verdict.misfiled).toEqual(['a — sits in a response body (line 1), so it cannot be c']);
  });
});

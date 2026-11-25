/**
 * No stored id reaches a log line (#1802).
 *
 * Log lines under functions/ are content-free: no document ids, tokens, file
 * paths, route values or payloads. `no-raw-error-in-logs.test.js` beside
 * this file keeps an error's own text out of a log line; this test is the
 * same idea for the other thing a line used to carry, the id of a stored
 * thing (an article, a job, an upload, a signed-in person, a chat). The
 * accepted line is a fixed sentence with a count, a kind, a yes/no or
 * `errorCode(err)`; the run's invocation id, which the host adds to every
 * line, is what ties the line to the run.
 *
 * WHAT COUNTS AS A LOG LINE. The same as in the other test, from the shared
 * `log-scan.test-helper.js`: a call to `.log`, `.warn`, `.error`, `.info`,
 * `.debug`, `.trace` or `.verbose` on `context`, `ctx`, `console`, `log`,
 * `logger` or `invocationContext`; a local alias of one; a bare call to an
 * injected `log`, `logger`, `warn` or `logWarn`; and a LOG WRAPPER, a named
 * function that hands one of its parameters to a log line as text, followed
 * in the same file or through an import.
 *
 * WHAT COUNTS AS AN ID in an argument of one. The scan reads NAMES, because
 * a name is all the source says about a value:
 *
 *   - A variable, parameter or field named like a stored id (STORED_ID_NAME
 *     in `log-json.js`: `id`, `ids`, `_id`, `oid`, `sub`, `uid`, and anything
 *     ending in `Id`, `Ids`, `ID` or `IDs`), like a person (`by`, `email`,
 *     `upn`, or ending in `By` or `Email`), or like a place a stored thing
 *     lives (`slug`, `url`, `href`, `path`, `blobName`, `filename`, `token`,
 *     and names ending in those). It counts as it is, in a template literal,
 *     concatenated, in an object or array, or handed to any function inside
 *     the line (`String(id)`, `ids.join(',')`, `lookup(id).label`).
 *   - A variable that holds one (`const where = `${container}/${doc.id}``),
 *     followed through templates, concatenation, aliases and destructuring
 *     in the same function scope.
 *   - A WHOLE VALUE: `JSON.stringify(...)` in a log line. What a value holds
 *     cannot be read off the line that prints it, so a summary is printed
 *     with `jsonForLog` from `log-json.js`, which leaves out every field
 *     named like a stored id.
 *
 * WHAT DOES NOT COUNT: a count or a yes/no about an id (`ids.length`,
 * `Boolean(id)`, `id === other`); a name in capitals, which is a constant
 * written in the code (`PODCAST_FEEDS_CONFIG_ID`); and `invocationId` and
 * `correlationId`, the reference numbers the host gives each run.
 *
 * KNOWN LIMITS, each pinned by a self-test that fails when it is lifted:
 *
 *   - A name is a hint. An id held under a name that does not say so
 *     (`const which = lookup()`, a field called `key` or `name`) is not seen.
 *   - A value a function RETURNS is not followed into the caller's line
 *     (`const label = describe(doc); log(label)`), and neither is a value a
 *     caller hands to a function's parameter, except through a log wrapper.
 *   - An id inside a sentence stored under another name (`outcome.error`
 *     that quotes an id or a title) is not seen; `jsonForLog` cannot see it
 *     either. Summaries carry fixed words or `errorCode(err)` by hand.
 *
 * THE LIST OF KEPT SITES. A line that keeps an id-shaped name is listed in
 * ALLOWED with a written reason: it is a fixed name from the code, not the
 * id of a stored document. A new site fails until it is changed or listed,
 * and an entry that no longer matches anything fails too. Keys are
 * `file › function › expression`, so a moved line never touches them.
 */
import { describe, expect, it } from 'vitest';
import { RUN_REFERENCE_NAMES, STORED_ID_NAME } from './log-json.js';
import {
  LOG_FUNCTION_NAMES,
  PREDICATES,
  aliasesOf,
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

/** The module whose printer leaves ids out of a whole value. */
const PRINTER_MODULE = 'lib/http/log-json.js';
const SAFE_PRINTERS = new Set(['jsonForLog']);

/** A name that says who did something. */
const PERSON_NAME = /^(?:by|email|upn)$|(?:By|Email)$/;
/** A name that says where a stored thing lives, or what opens it. */
const PLACE_NAME =
  /^(?:slug|url|href|path|blobName|blobPath|filename|fileName|token)$|(?:Slug|Url|URL|Href|Path|BlobName|Filename|FileName|Token)$/;
/** A name in capitals is a constant written in the code. */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
/** A count of something is not the thing. */
const COUNT_FIELDS = new Set(['length', 'size']);
/**
 * Calls that hand back the text they were given, more or less: the only
 * calls an id is followed through on its way into a variable.
 */
const TEXT_CALLS = new Set([
  'String',
  'toString',
  'stringify',
  'join',
  'slice',
  'substring',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'padStart',
  'padEnd',
  'concat',
  'replace',
  'replaceAll',
  'encodeURIComponent',
]);

/**
 * Whether a name says its value is an id, a person or a place.
 *
 * @param {string | null} name - a variable, parameter or field name
 * @returns {boolean}
 */
export function isIdName(name) {
  if (!name || RUN_REFERENCE_NAMES.has(name) || CONSTANT_NAME.test(name)) return false;
  return STORED_ID_NAME.test(name) || PERSON_NAME.test(name) || PLACE_NAME.test(name);
}

/**
 * One module's scopes: every declared name, and whether it holds an id
 * (`carries`, filled in by `settle`).
 *
 * @param {object} program - the parsed module
 * @returns {Map<object, Map<string, { carries: boolean }>>}
 */
function scopesOf(program) {
  const scopes = new Map();
  /** Declare a name in a scope. */
  const declare = (scope, name) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    if (!scopes.get(scope).has(name)) scopes.get(scope).set(name, { carries: false });
  };
  /** Record what each node declares. */
  const visit = (node) => {
    if (isFunction(node)) {
      if (node.type === 'FunctionDeclaration' && node.id) declare(scopeOf(node), node.id.name);
      for (const param of node.params) for (const { name } of patternNames(param)) declare(node, name);
    } else if (node.type === 'CatchClause' && node.param) {
      for (const { name } of patternNames(node.param)) declare(node, name);
    } else if (node.type === 'VariableDeclarator') {
      for (const { name } of patternNames(node.id)) declare(scopeOf(node), name);
    } else if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) declare(program, spec.local.name);
    }
    eachChild(node, visit);
  };
  visit(program);
  return scopes;
}

/**
 * Parse a tree of modules and build the scan's tools over it.
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
      if (found) return found;
    }
    return null;
  };

  /** Whether a callee is the printer imported from the printer module. */
  const isSafePrinter = (m, callee) => {
    const c = unwrap(callee);
    if (c?.type !== 'Identifier') return false;
    const imported = m.table.imports.get(c.name);
    return Boolean(imported) && imported.from === PRINTER_MODULE && SAFE_PRINTERS.has(imported.name);
  };

  /**
   * The parts of an expression that carry an id, pushed onto `out`. With
   * `anyCall` false (a value on its way into a variable) only the calls in
   * TEXT_CALLS are looked through, so `const doc = await read(id)` does not
   * make `doc` an id.
   */
  const carriers = (m, node, out = [], anyCall = true) => {
    const n = unwrap(node);
    if (!n) return out;
    /** Collect from several expressions. */
    const all = (nodes) => {
      for (const child of nodes) if (child) carriers(m, child, out, anyCall);
      return out;
    };
    switch (n.type) {
      case 'Identifier':
        if (!CONSTANT_NAME.test(n.name) && (isIdName(n.name) || lookup(m, n, n.name)?.carries)) out.push(n);
        return out;
      case 'MemberExpression': {
        const name = memberName(n);
        if (name && COUNT_FIELDS.has(name)) return out;
        if (isIdName(name)) {
          out.push(n);
          return out;
        }
        // A plain field of a variable (`row.action`) is not the variable: a
        // variable that holds an id is text, and text has no such field.
        if (name && unwrap(n.object)?.type === 'Identifier') return out;
        return carriers(m, n.object, out, anyCall);
      }
      case 'TemplateLiteral':
        return all(n.expressions);
      case 'TaggedTemplateExpression':
        return all(n.quasi.expressions);
      case 'BinaryExpression':
        return n.operator === '+' ? all([n.left, n.right]) : out;
      case 'LogicalExpression':
        return all([n.left, n.right]);
      case 'ConditionalExpression':
        return all([n.consequent, n.alternate]);
      case 'AssignmentExpression':
        return carriers(m, n.right, out, anyCall);
      case 'SequenceExpression':
        return carriers(m, n.expressions.at(-1), out, anyCall);
      case 'SpreadElement':
        return carriers(m, n.argument, out, anyCall);
      case 'ArrayExpression':
        return anyCall ? all(n.elements) : out;
      case 'ObjectExpression':
        return anyCall ? all(n.properties.map((p) => (p.type === 'SpreadElement' ? p : p.value))) : out;
      case 'NewExpression':
        return anyCall ? all(n.arguments) : out;
      case 'CallExpression': {
        if (isSafePrinter(m, n.callee)) return out;
        const method = lastName(n.callee);
        if (method && PREDICATES.has(method)) return out;
        if (!anyCall && !TEXT_CALLS.has(method)) return out;
        const callee = unwrap(n.callee);
        return all([...(callee?.type === 'MemberExpression' ? [callee.object] : []), ...n.arguments]);
      }
      default:
        return out;
    }
  };

  /** The `JSON.stringify(...)` calls anywhere in an expression: whole values. */
  const wholeValues = (node, out = []) => {
    const n = unwrap(node);
    if (!n || isFunction(n)) return out;
    if (n.type === 'CallExpression') {
      const callee = unwrap(n.callee);
      const isStringify =
        callee?.type === 'MemberExpression' && memberName(callee) === 'stringify' && lastName(callee.object) === 'JSON';
      if (isStringify && unwrap(n.arguments[0])?.type !== 'Literal') out.push(n);
    }
    eachChild(n, (child) => wholeValues(child, out));
    return out;
  };

  /** Mark the variables that hold an id, until nothing changes. */
  const settle = (m) => {
    let changed = true;
    /** Mark a declared name, noting whether that was news. */
    const mark = (node, name) => {
      const entry = lookup(m, node, name);
      if (!entry || entry.carries) return;
      entry.carries = true;
      changed = true;
    };
    /** Apply one declarator or assignment. */
    const visit = (node) => {
      if (node.type === 'VariableDeclarator' && node.init) {
        const whole = carriers(m, node.init, [], false).length > 0;
        for (const { name, from } of patternNames(node.id)) {
          if ((from === null && whole) || (from !== null && isIdName(from))) mark(node, name);
        }
      } else if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        if (carriers(m, node.right, [], false).length > 0) mark(node, node.left.name);
      }
      eachChild(node, visit);
    };
    for (let round = 0; changed && round < 20; round += 1) {
      changed = false;
      visit(m.program);
    }
  };

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

  /** The arguments of a call that end up in a log line, or null when the call is not one. */
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

  /** Find the functions that hand a parameter to a log line as text, to a fixpoint. */
  const findWrappers = () => {
    for (let round = 0; round < 8; round += 1) {
      const before = [...wrappers.values()].reduce((sum, slots) => sum + slots.size, 0);
      for (const m of parsed) {
        const aliases = aliasesOf(m.program);
        for (const [name, fn] of [...m.table.functions, ...m.table.nested]) {
          const params = fn.params.map((param) => (param.type === 'AssignmentPattern' ? param.left : param));
          const table = m.scopes.get(fn);
          /** Note each parameter that would put an id in a logged argument if it were handed one. */
          const visit = (node) => {
            if (node.type === 'CallExpression') {
              for (const arg of loggedArguments(m, node, aliases) ?? []) {
                params.forEach((param, index) => {
                  const entry = param.type === 'Identifier' ? table?.get(param.name) : null;
                  // A parameter named like an id is reported inside the function itself.
                  if (!entry || entry.carries || isIdName(param.name)) return;
                  entry.carries = true;
                  const reached = carriers(m, arg).some(
                    (hit) => hit.type === 'Identifier' && hit.name === param.name && lookup(m, hit, hit.name) === entry
                  );
                  entry.carries = false;
                  if (!reached) return;
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

  return { parsed, carriers, wholeValues, settle, loggedArguments, findWrappers };
}

/**
 * Scan a tree of modules for ids in log lines.
 *
 * @param {Record<string, string>} modules - tree key → source
 * @returns {Array<{ key: string, file: string, line: number, what: string, kind: 'id' | 'whole value' }>}
 */
export function scanLogIds(modules) {
  const { parsed, carriers, wholeValues, settle, loggedArguments, findWrappers } = analyse(modules);
  for (const m of parsed) settle(m);
  findWrappers();

  const sites = [];
  for (const m of parsed) {
    if (m.file === PRINTER_MODULE) continue;
    const aliases = aliasesOf(m.program);
    /** Report each part of a logged argument that carries an id, once. */
    const visit = (node) => {
      if (node.type === 'CallExpression') {
        const seen = new Set();
        for (const arg of loggedArguments(m, node, aliases) ?? []) {
          const found = [
            ...wholeValues(arg).map((hit) => ({ hit, kind: 'whole value' })),
            ...carriers(m, arg).map((hit) => ({ hit, kind: 'id' })),
          ];
          for (const { hit, kind } of found) {
            const what = m.source.slice(hit.start, hit.end).replace(/\s+/g, ' ');
            if (seen.has(what)) continue;
            seen.add(what);
            sites.push({
              key: `${m.file} › ${functionName(node)} › ${what}`,
              file: m.file,
              line: m.source.slice(0, node.start).split('\n').length,
              what,
              kind,
            });
          }
        }
      }
      eachChild(node, visit);
    };
    visit(m.program);
  }
  return sites;
}

/**
 * The log lines that keep an id-shaped name, each with its reason. Every
 * entry is a fixed name from the code or a registered name, never the id of
 * a stored document, an upload, a job, a person or a chat: change a new
 * line to a count or a kind rather than list it here. The decision behind
 * the list is in `.claude/CLAUDE.md`, "The per-folder points a pre-PR review
 * must check", under `functions/**`.
 */
const ALLOWED = [
  // The printed text is the setting's name (ADDON_..._URL), looked up by the add-on's fixed id from the code; the id is not printed.
  { site: 'lib/addons/status.js › readStatus › id', why: "looks up the add-on's setting name; the id itself is not printed" },
  { site: 'lib/addons/status.js › refresh › id', why: "looks up the add-on's setting name; the id itself is not printed" },
  // The registered name of a tool server the owner added, read from the store before the line runs.
  { site: 'lib/reminders/providers.js › syncReminderProviders › provider.id', why: 'a fixed provider name from REMINDER_PROVIDERS ("credentials", "ambassador"), never a stored id; says which sync to look at (#1886)', times: 2 },
  { site: 'lib/ai/mcp.js › getSessionId › serverId', why: 'the registered name of a tool server; says which server to fix' },
  { site: 'lib/ai/mcp.js › callMcpTool › serverId', why: 'the registered name of a tool server; says which server to fix' },
  // A provider's name from the catalogue in the code.
  { site: 'lib/ai/proxy.js › runTestCall › providerId', why: "a provider's fixed name from the catalogue in the code" },
  { site: 'lib/ai/proxy.js › testProviderConnection › providerId', why: "a provider's fixed name from the catalogue in the code" },
  // Configuration, not a stored value: the line exists to show which allowed-origins setting this process runs with.
  { site: 'lib/auth/http-route.js › logAllowlistOnce › JSON.stringify(extraOrigins)', why: 'the allowed-origins setting, a list of site addresses from configuration' },
  { site: 'lib/auth/http-route.js › logAllowlistOnce › JSON.stringify(raw)', why: 'the allowed-origins setting as configured, quoted so an empty value shows' },
  // A backup run's label is its date.
  { site: 'lib/backup/backup-status.js › readRun › runId', why: "a backup run's date label" },
  { site: 'lib/backup/cosmos-export.js › run › runId', why: "a backup run's date label", times: 2 },
  { site: 'lib/backup/cosmos-export.js › exportContainer › runId', why: "a backup run's date label" },
  { site: 'lib/backup/cosmos-export.js › completeRunIfLast › runId', why: "a backup run's date label" },
  { site: 'lib/cloud-tools/explain/handler.js › generate › state.kind.id', why: 'the kind of explanation, one of the fixed names in the code' },
  // The pricing catalogue's own names; the only caller is the scheduled refresh, which reads them from the catalogue.
  { site: 'lib/cloud-tools/pricing/index.js › fetchLivePricing › serviceId', why: "a service's fixed name from the pricing catalogue", times: 2 },
  { site: 'lib/cloud-tools/refresh.js › run › regionId', why: "a region's fixed name from the pricing catalogue" },
  { site: 'lib/decision-center.js › collectDecisions › source.id', why: 'a decision source, one of the fixed names in the code' },
  // The agent has signed in and is registered; its name says which machine tried to finish a job it does not hold.
  { site: 'lib/lab-agent.js › heldJobRefusal › agent.agentId', why: "a registered lab machine's name, on a security refusal" },
  { site: 'lib/labs/minute-cache.js › read › id', why: 'a cache entry, each a constant name in the code' },
  { site: 'lib/labs/minute-cache.js › write › id', why: 'a cache entry, each a constant name in the code' },
  { site: 'lib/newsletter/sections.js › collectSections › section.id', why: 'a newsletter section, one of the fixed names in the code' },
  // auditDetailsForLog builds the value for a log line: a setting's name and a summary, with the template id reduced to set or not set.
  { site: 'lib/platform-settings.js › putSetting › JSON.stringify(auditDetailsForLog(details))', why: 'a summary built for the log line, with its one id reduced to set or not set' },
];

describe('no stored id in log lines (#1802)', () => {
  it('scans every module under functions/src, and every log line is free of ids or decided', { timeout: 60_000 }, () => {
    const modules = realTree();
    expect(Object.keys(modules).length).toBeGreaterThan(300);
    expect(modules[PRINTER_MODULE]).toBeDefined();
    const { unlisted, stale, misfiled } = judgeLogSites(scanLogIds(modules), ALLOWED);
    expect(
      unlisted,
      `a log line prints an id (or a whole value with JSON.stringify); print a count, a kind or errorCode(err), and a summary with jsonForLog from lib/http/log-json.js:\n${unlisted.join('\n')}`
    ).toEqual([]);
    expect(stale, `kept-site entries that no longer match anything:\n${stale.join('\n')}`).toEqual([]);
    expect(misfiled, `kept-site entries that are wrong:\n${misfiled.join('\n')}`).toEqual([]);
  });
});

describe('the id scan itself', () => {
  /** The flagged expressions a one-module tree yields. */
  const found = (source, file = 'lib/x.js') => scanLogIds({ [file]: source }).map((s) => s.what);
  /** A module whose handler body is the given source. */
  const handler = (body, head = '') => `${head}
    export async function handle(request, context, doc) { ${body} }`;

  it('finds an id by its name: a variable, a field, with or without ?.', () => {
    expect(found(handler('context.log(`saved ${doc.id}`);'))).toEqual(['doc.id']);
    expect(found(handler('const contentId = request.params.x; context.warn(`skipped content/${contentId}`);'))).toEqual([
      'contentId',
    ]);
    expect(found(handler('context.warn(`chat ${request.message.chat?.id}`);'))).toEqual(['request.message.chat?.id']);
    expect(found(handler('context.log(`by ${request.user?.oid || "unknown"}`);'))).toEqual(['request.user?.oid']);
    expect(found(handler("context.log('queued', doc.jobId, doc.type);"))).toEqual(['doc.jobId']);
    expect(found(handler('context.log(`refused ${doc.refusedIds}`);'))).toEqual(['doc.refusedIds']);
  });

  it('finds a person and a place by name too', () => {
    expect(found(handler('const by = who(); context.log(`changed by ${by}`);'))).toEqual(['by']);
    expect(found(handler('context.log(`reviewed by ${doc.reviewedBy}, mail ${doc.email}`);'))).toEqual([
      'doc.reviewedBy',
      'doc.email',
    ]);
    expect(found(handler('context.log(`stored ${doc.blobName} at ${doc.blobPath} for ${doc.slug}`);'))).toEqual([
      'doc.blobName',
      'doc.blobPath',
      'doc.slug',
    ]);
    expect(found(handler('context.log(`fetching ${doc.imageUrl} with ${doc.accessToken}`);'))).toEqual([
      'doc.imageUrl',
      'doc.accessToken',
    ]);
  });

  it('finds an id however it is placed: an object, an array, a concatenation, a call', () => {
    expect(found(handler("context.warn('failed', { serverId: doc.serverId, code: 1 });"))).toEqual(['doc.serverId']);
    expect(found(handler("context.warn('failed', { id: doc.id });"))).toEqual(['doc.id']);
    expect(found(handler("context.warn('failed for ' + doc.id);"))).toEqual(['doc.id']);
    expect(found(handler('context.warn(String(doc.id));'))).toEqual(['doc.id']);
    expect(found(handler("context.warn(`refused: ${doc.refusedIds.join(', ')}`);"))).toEqual(['doc.refusedIds']);
    expect(found(handler('context.warn(`setting ${entryFor(doc.id).setting}`);'))).toEqual(['doc.id']);
    expect(found(handler('context.warn(`job ${JSON.parse(doc.body).jobId}`);'))).toEqual(['JSON.parse(doc.body).jobId']);
  });

  it('finds a call spread over several lines, which a line search cannot', () => {
    const source = handler(`context.warn(
        'the write failed',
        {
          which: doc
            .id,
        }
      );`);
    expect(found(source)).toEqual(['doc .id']);
  });

  it('follows a variable that holds an id: a template, a concatenation, an alias, a destructured field', () => {
    expect(found(handler('const where = `content/${doc.id}`; context.warn(`skipped ${where}`);'))).toEqual(['where']);
    expect(found(handler("let where = ''; where = 'blogs/' + doc.id; context.warn(where);"))).toEqual(['where']);
    expect(found(handler('const which = doc.id; context.warn(which);'))).toEqual(['which']);
    expect(found(handler('const { id: which } = doc; context.warn(which);'))).toEqual(['which']);
    expect(found(handler("const list = doc.refusedIds.join(', '); context.warn(list);"))).toEqual(['list']);
    // A document read by its id is not the id.
    expect(found(handler('const row = await store.readDoc("c", doc.id, doc.id); context.log(`status ${row.status}`);'))).toEqual(
      []
    );
  });

  it('accepts a count, a yes/no, a constant and the run reference numbers', () => {
    expect(found(handler('context.warn(`${doc.refusedIds.length} refused, ${ids.size} seen`);'))).toEqual([]);
    expect(found(handler('context.warn(`has id: ${Boolean(doc.id)}, same: ${doc.id === other.id}`);'))).toEqual([]);
    expect(found(handler("context.warn(doc.id ? 'saved' : 'new');"))).toEqual([]);
    expect(found(handler('context.warn(`seed admin_config/${FEEDS_CONFIG_ID}`);', "const FEEDS_CONFIG_ID = 'feeds';"))).toEqual([]);
    expect(found(handler('context.warn(`run ${context.invocationId} ${correlationId}`);'))).toEqual([]);
    // Names that only look like the rule's words.
    expect(found(handler('context.log(`${doc.valid} ${doc.paid} ${doc.kind} ${doc.subject} ${doc.tokens}`);'))).toEqual([]);
  });

  it('refuses a whole value printed with JSON.stringify, and accepts jsonForLog', () => {
    const printer = "import { jsonForLog } from './http/log-json.js';";
    expect(found(handler('const result = await run(); context.log(`done ${JSON.stringify(result)}`);'))).toEqual([
      'JSON.stringify(result)',
    ]);
    expect(found(handler('context.log(`done ${JSON.stringify({ ...doc, failures: undefined }).slice(0, 200)}`);'))).toEqual([
      'JSON.stringify({ ...doc, failures: undefined })',
    ]);
    expect(found(handler('const result = await run(); context.log(`done ${jsonForLog(result)}`);', printer))).toEqual([]);
    expect(found(handler('context.log(`done ${jsonForLog({ id: doc.id })}`);', printer))).toEqual([]);
    // The same name, not imported from the printer module: scanned like any function.
    expect(found(handler('context.log(jsonForLog({ id: doc.id }));', 'const jsonForLog = (v) => JSON.stringify(v);'))).toEqual([
      'doc.id',
    ]);
  });

  it('knows a log line by its receiver, an alias, a one-line function and an injected logger', () => {
    expect(found(handler('ctx.log.error(doc.id);'))).toEqual(['doc.id']);
    expect(found(handler('state.context.warn?.(doc.id);'))).toEqual(['doc.id']);
    expect(found(handler('deps.log?.warn?.(doc.id);'))).toEqual(['doc.id']);
    expect(found(handler('console.error(doc.id);'))).toEqual(['doc.id']);
    expect(found(handler('const warn = context.warn.bind(context); warn(doc.id);'))).toEqual(['doc.id']);
    expect(found(handler('const info = (line) => context.log(`[x] ${line}`); info(doc.id);'))).toEqual(['doc.id']);
    expect(found('export const f = async ({ log }, doc) => { log(`x ${doc.id}`); };')).toEqual(['doc.id']);
    // Not a log line: the id goes somewhere this test does not judge.
    expect(found(handler('results.push({ id: doc.id }); return json(200, { id: doc.id });'))).toEqual([]);
  });

  it('follows a log wrapper: in the file, nested, and through an import', () => {
    const wrapper = 'function note(context, text) { context.warn(`[x] ${text}`); }';
    expect(found(handler('note(context, doc.id);', wrapper))).toEqual(['doc.id']);
    expect(found(handler('const note = (text) => { count += 1; context.warn(text); }; note(`saved ${doc.id}`);'))).toEqual([
      'doc.id',
    ]);
    const tree = {
      'lib/note.js': `export ${wrapper}`,
      'lib/x.js': handler('note(context, doc.id);', "import { note } from './note.js';"),
    };
    expect(scanLogIds(tree).map((s) => s.key)).toEqual(['lib/x.js › handle › doc.id']);
    // A function that logs only a count of what it is given is not a wrapper.
    const counting = 'function tally(context, rows) { context.log(`${rows.length} rows`); }';
    expect(found(handler('tally(context, doc.refusedIds);', counting))).toEqual([]);
  });

  it('KNOWN LIMIT: an id under a name that does not say so is not seen', () => {
    expect(found(handler('const which = pick(); context.log(`saved ${which} as ${doc.key} for ${doc.name}`);'))).toEqual([]);
  });

  it('KNOWN LIMIT: a value a function returns, or is handed, is not followed', () => {
    const source = `
      const describe = (doc) => \`content/\${doc.id}\`;
      function report(context, label) { const line = label; return line; }
      export function handle(context, doc) { const label = describe(doc); context.log(label); report(context, doc.id); }`;
    expect(found(source)).toEqual([]);
  });

  it('KNOWN LIMIT: an id inside a sentence stored under another name is not seen', () => {
    expect(found(handler('const outcome = await run(doc.id); context.warn(`refused: ${outcome.error}`);'))).toEqual([]);
  });

  it('judges the list of kept sites with the shared judge', () => {
    const sites = scanLogIds({ 'lib/x.js': handler('context.warn(doc.id); context.warn(doc.id);') });
    const site = 'lib/x.js › handle › doc.id';
    expect(judgeLogSites(sites, []).unlisted).toHaveLength(2);
    expect(judgeLogSites(sites, [{ site, why: 'a fixed name', times: 2 }])).toEqual({ unlisted: [], stale: [], misfiled: [] });
    expect(judgeLogSites([], [{ site, why: 'a fixed name' }]).stale).toEqual([site]);
  });
});

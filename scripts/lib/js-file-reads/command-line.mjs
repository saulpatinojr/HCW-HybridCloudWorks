/**
 * Code that only runs when a script is started from the command line
 * (`if (process.argv[1] === ...)`). A test never gets there, so the reads in
 * it are left out.
 */
import { childrenOf, lookup } from './syntax.mjs';

// What a test of "was this script started from the command line" means, and
// whether code sits where only such a start reaches, worked out once per node.
// Keyed by the node, so each analysis has its own answers: an analysis works
// on syntax trees of its own (see loadModule), never one another analysis used.
const POLARITY_CACHE = new WeakMap();
const COMMAND_LINE_ONLY_CACHE = new WeakMap();

/** A plain name, `name`. */
const isName = (n, name) => n.type === 'Identifier' && n.name === name;

/** `object.property`, written with a dot, on a plain name. */
const isNamedMember = (n, object, property) =>
  n.type === 'MemberExpression' && !n.computed && isName(n.object, object) && n.property.name === property;

/** `import.meta.main`. */
const isImportMetaMain = (n) => n.type === 'MemberExpression' && n.object.type === 'MetaProperty' && n.property.name === 'main';

/** Whether a name set once to a value whose code passes `test` (followed at most three names deep). */
function nameSetTo(n, depth, test) {
  if (n.type !== 'Identifier' || depth >= 3) return false;
  const binding = lookup(n, n.name);
  return binding?.kind === 'var' && binding.inits.some((init) => test(init, depth + 1));
}

/** Whether any node under `root` passes `here(n)`, or is a name set to something that passes `test`. */
function anyNodeUnder(root, depth, here, test) {
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (here(n) || nameSetTo(n, depth, test)) return true;
    for (const child of childrenOf(n)) stack.push(child);
  }
  return false;
}

/** process.argv, require.main or import.meta.main. */
const looksAtArgv = (n) => isNamedMember(n, 'process', 'argv') || isNamedMember(n, 'require', 'main') || isImportMetaMain(n);

function mentionsArgv(root, depth = 0) {
  return anyNodeUnder(root, depth, looksAtArgv, mentionsArgv);
}

function mentionsEnv(root) {
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (isNamedMember(n, 'process', 'env')) return true;
    for (const child of childrenOf(n)) stack.push(child);
  }
  return false;
}

/** process.argv[i]: one element of the command line. */
const isArgvIndex = (n) => n.type === 'MemberExpression' && n.computed && isNamedMember(n.object, 'process', 'argv');

/** process.argv[i], require.main or import.meta.main. */
const looksAtOneArgv = (n) => isArgvIndex(n) || isNamedMember(n, 'require', 'main') || isImportMetaMain(n);

/** Whether a test looks at one element of process.argv (process.argv[1]), or at require.main / import.meta.main. */
function indexesArgv(root, depth = 0) {
  return anyNodeUnder(root, depth, looksAtOneArgv, indexesArgv);
}

/** What `!test` means: the opposite of what `test` means. */
const NEGATED = { positive: 'negative', negative: 'positive' };

/**
 * Whether a test about "was this script started from the command line" is
 * true when it is: 'positive' (=== ...), 'negative' (!== ..., !...), 'unclear'
 * (|| and the like), or null when it does not look at the command line.
 */
function computePolarity(test, depth = 0) {
  // a test on the environment alone ('env') says nothing about how the script was started
  if (!mentionsArgv(test)) return mentionsEnv(test) ? 'env' : null;
  const byShape = POLARITY_BY_SHAPE.find(([applies]) => applies(test, depth));
  if (byShape) return byShape[1](test, depth);
  // || and ?: can run either way; anything else that looks at the command line (process.argv[1], x.endsWith(...)) means "started from it"
  if (test.type === 'LogicalExpression' || test.type === 'ConditionalExpression') return 'unclear';
  return indexesArgv(test) ? 'positive' : 'unclear';
}

/** A name set once, and never again, to a test: the test it was set to. */
function singleInit(test) {
  const binding = lookup(test, test.name);
  return binding?.kind === 'var' && binding.inits.length === 1 && binding.assigns.length === 0 ? binding.inits[0] : null;
}

/** The meaning of each shape of test that looks at the command line: [does it have this shape, what it means]. */
const POLARITY_BY_SHAPE = [
  [(test) => test.type === 'UnaryExpression' && test.operator === '!', (test, depth) => NEGATED[startedFromCommandLine(test.argument, depth)] ?? 'unclear'],
  [
    (test) => test.type === 'BinaryExpression',
    (test) => {
      if (!indexesArgv(test)) return 'unclear'; // process.argv.length === 2 says nothing about whether this is the script that was started
      if (['===', '=='].includes(test.operator)) return 'positive';
      return ['!==', '!='].includes(test.operator) ? 'negative' : 'unclear';
    },
  ],
  [
    (test) => test.type === 'LogicalExpression' && test.operator === '&&',
    (test, depth) => {
      const sides = [startedFromCommandLine(test.left, depth), startedFromCommandLine(test.right, depth)].filter((side) => side && side !== 'env');
      return sides.length > 0 && sides.every((side) => side === sides[0]) ? sides[0] : 'unclear';
    },
  ],
  [
    (test) => test.type === 'LogicalExpression' && test.operator === '||',
    (test, depth) => {
      // started from the command line OR forced by an environment variable: the script still has to be the one started
      const sides = [startedFromCommandLine(test.left, depth), startedFromCommandLine(test.right, depth)];
      return sides.every((side) => side === 'positive' || side === 'env') && sides.includes('positive') ? 'positive' : 'unclear';
    },
  ],
  [(test, depth) => test.type === 'Identifier' && depth < 3 && singleInit(test) !== null, (test, depth) => startedFromCommandLine(singleInit(test), depth + 1)],
];

function startedFromCommandLine(test, depth = 0) {
  if (!POLARITY_CACHE.has(test)) POLARITY_CACHE.set(test, computePolarity(test, depth));
  return POLARITY_CACHE.get(test);
}

/** True inside the branch of `if (<this script was started>)` that a test never enters. */
export function commandLineOnly(node) {
  if (!COMMAND_LINE_ONLY_CACHE.has(node)) COMMAND_LINE_ONLY_CACHE.set(node, computeCommandLineOnly(node));
  return COMMAND_LINE_ONLY_CACHE.get(node);
}

function computeCommandLineOnly(node) {
  for (let n = node; n.parent; n = n.parent) {
    if (isCommandLineBranch(n.parent, n)) return true;
  }
  return false;
}

/** Whether `n` is the part of `p` that runs only when the script was started from the command line. */
function isCommandLineBranch(p, n) {
  if (p.type === 'IfStatement' || p.type === 'ConditionalExpression') {
    const sense = startedFromCommandLine(p.test);
    return (sense === 'positive' && p.consequent === n) || (sense === 'negative' && p.alternate === n);
  }
  return p.type === 'LogicalExpression' && p.operator === '&&' && p.right === n && startedFromCommandLine(p.left) === 'positive';
}

/**
 * Working out the values an expression could have, one kind of expression at a
 * time. `ctx` is the evaluation context: `ctx.an` is the analysis (see
 * analysis.mjs), the rest says what is being worked out at the moment (the
 * values a call gave its parameters, the names in progress, how deep the calls go).
 */
import { dirname } from 'node:path';
import { MAX_STEPS, TOO_MANY, arr, plainCode, positionsOf, product, str, uniq, unk } from './values.mjs';
import { concatValue, templateValue } from './text-values.mjs';
import { lookup } from './syntax.mjs';
import { evalBinding } from './evaluate-names.mjs';
import { evalMember, evalNew } from './evaluate-objects.mjs';
import { evalCall } from './evaluate-calls.mjs';

/** A context for working out one expression from the start. */
export function freshContext(an) {
  an.steps = 0;
  return { an, frame: null, active: new Set(), nested: new Map(), approx: new Map(), reentered: new Set(), depth: 0 };
}

/** How each kind of expression is worked out. A kind not here is not followed. */
const EVALUATORS = new Map([
  ['Literal', evalLiteral],
  ['TemplateLiteral', evalTemplate],
  ['Identifier', evalIdentifier],
  ['MemberExpression', evalMember],
  ['CallExpression', evalCall],
  ['NewExpression', evalNew],
  ['AwaitExpression', (node, ctx) => evalNode(node.argument, ctx)],
  ['ChainExpression', (node, ctx) => evalNode(node.expression, ctx)],
  ['SequenceExpression', (node, ctx) => evalNode(node.expressions.at(-1), ctx)],
  ['ConditionalExpression', (node, ctx) => uniq([...evalNode(node.consequent, ctx), ...evalNode(node.alternate, ctx)])],
  ['LogicalExpression', (node, ctx) => uniq(node.operator === '&&' ? evalNode(node.right, ctx) : [...evalNode(node.left, ctx), ...evalNode(node.right, ctx)])],
  ['BinaryExpression', (node, ctx) => (node.operator === '+' ? evalConcat(node, ctx) : [unk(`it uses the operator ${node.operator}`)])],
  ['AssignmentExpression', (node, ctx) => evalNode(node.right, ctx)],
  ['ArrayExpression', (node, ctx) => [evalArray(node, ctx)]],
  ['ObjectExpression', (node) => [{ k: 'obj', node }]],
  ['ArrowFunctionExpression', (node) => [{ k: 'fn', node }]],
  ['FunctionExpression', (node) => [{ k: 'fn', node }]],
]);

export function evalNode(node, ctx) {
  if (++ctx.an.steps > MAX_STEPS) return [unk('it takes too many steps to follow')];
  const evaluate = EVALUATORS.get(node.type);
  return evaluate ? evaluate(node, ctx) : [unk(`it uses ${plainCode(node.type)}, which the guard does not follow`)];
}

function evalLiteral(node) {
  if (typeof node.value === 'string') return [str(node.value)];
  if (typeof node.value === 'number' || typeof node.value === 'boolean') return [str(String(node.value))];
  return node.value === null ? [] : [unk('it is not a string')];
}

function evalTemplate(node, ctx) {
  const combos = product(node.expressions.map((expr) => evalNode(expr, ctx)));
  if (combos === null) return [unk(TOO_MANY)];
  return uniq(combos.map((combo) => templateValue(node.quasis, combo)));
}

function evalConcat(node, ctx) {
  const out = [];
  for (const l of evalNode(node.left, ctx)) {
    for (const r of evalNode(node.right, ctx)) out.push(concatValue(l, r));
  }
  return uniq(out);
}

function evalArray(node, ctx) {
  const items = [];
  for (const element of node.elements) {
    if (!element) continue;
    if (element.type === 'SpreadElement') {
      for (const spread of evalNode(element.argument, ctx)) items.push(...positionsOf(spread, 'it spreads a value that is not a list (array)'));
    } else {
      items.push(evalNode(element, ctx));
    }
  }
  return arr(items);
}

/** Names that are not declared anywhere but still have a known value (or a known reason they have none). */
const UNDECLARED_NAMES = new Map([
  ['__dirname', (node) => [str(dirname(node.file))]],
  ['__filename', (node) => [str(node.file)]],
  ['undefined', () => []],
  ['process', () => [unk('it comes from `process`: the command line or the environment, which are chosen when the program starts')]],
]);

function evalIdentifier(node, ctx) {
  const { name } = node;
  const binding = lookup(node, name);
  if (binding) return evalBinding(binding, ctx);
  const known = UNDECLARED_NAMES.get(name);
  return known ? known(node) : [unk(`\`${name}\` is a global the guard does not follow`)];
}

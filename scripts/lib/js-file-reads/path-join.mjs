/** path.join / path.resolve over fully worked-out arguments, one value per argument. */
import { isAbsolute, join, resolve, sep } from 'node:path';
import { endsWithSeparator, inWords, passesThrough, pre, str, unk } from './values.mjs';

/** A known path `start` with one more part `next` added. */
function joinKnown(start, next) {
  const folder = endsWithSeparator(start) ? start : start + sep;
  if (next.k === 'str') return str(join(start, next.v));
  if (next.k === 'pre') return pre(join(start, next.v) + (endsWithSeparator(next.v) ? sep : ''), next.why);
  if (next.k === 'tmp' || next.k === 'ext') return next;
  if (next.k === 'name') return pre(folder);
  return pre(folder, next.k === 'unk' ? next.why : `a path is built from ${inWords(next)}`);
}

/** What follows a part that is not known is added after it, but going up with .. would leave the folder we know. */
function afterUnknownPart(acc, next) {
  if (next.k === 'str' && next.v.split(/[\\/]/).includes('..')) return { value: unk('a path goes up (..) after a part the guard does not know'), done: true };
  return { value: acc };
}

/**
 * One step of a join: the path so far (`acc`) with `next` added. Returns { value } to go on with,
 * or { value, done: true } when the answer is already known and the rest of the parts change nothing.
 */
function joinStep(acc, next, isResolve) {
  if (isResolve && next.k === 'str' && isAbsolute(next.v)) return { value: next };
  if (acc.k === 'pre' || acc.k === 'name') return afterUnknownPart(acc, next);
  if (passesThrough(acc)) return { value: acc, done: true };
  if (acc.k !== 'str') return { value: unk(`a path is built from ${inWords(acc)}`), done: true };
  return { value: joinKnown(acc.v, next) };
}

/** path.resolve makes the result absolute, starting from the folder the tests run in. */
function resolvedFromCwd(acc, cwd) {
  if (acc.k === 'str') return str(resolve(cwd, acc.v));
  if (acc.k === 'pre' && !isAbsolute(acc.v)) return pre(resolve(cwd, acc.v) + (endsWithSeparator(acc.v) ? sep : ''));
  return acc;
}

export function joinValues(values, isResolve, cwd) {
  let acc = values[0];
  for (const next of values.slice(1)) {
    const step = joinStep(acc, next, isResolve);
    if (step.done) return step.value;
    acc = step.value;
  }
  return isResolve ? resolvedFromCwd(acc, cwd) : acc;
}

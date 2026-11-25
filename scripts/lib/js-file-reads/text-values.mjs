/** Text built from pieces: template strings and `a + b`, for one choice of value of each piece. */
import { NAME, inWords, passesThrough, pre, str, unk } from './values.mjs';

/** Why a path built from a known start and then `v` is only partly known: null for a name from a listing. */
function partlyKnownWhy(v, uses) {
  if (v.k === 'name') return null;
  return v.k === 'unk' ? v.why : `${uses} ${inWords(v)}`;
}

/** A template string with one choice of value for each `${}`, the quasis around them as written. */
export function templateValue(quasis, combo) {
  let text = '';
  for (let i = 0; i < quasis.length; i++) {
    text += quasis[i].value.cooked ?? '';
    const v = combo[i];
    if (!v) continue;
    if (v.k !== 'str') return templateStopsAt(text, v);
    text += v.v;
  }
  return str(text);
}

/** A template string whose text so far is `text`, at a value `v` that is not plain text. */
function templateStopsAt(text, v) {
  if (v.k === 'pre') return pre(text + v.v, v.why);
  if (text !== '') return pre(text, partlyKnownWhy(v, 'a template string uses'));
  if (v.k === 'name') return NAME;
  if (v.k === 'tmp' || v.k === 'ext' || v.k === 'unk') return v;
  return unk('a template string starts with a value that is not known');
}

/** `l + r`, for one value of each side. */
export function concatValue(l, r) {
  if (l.k === 'str' && r.k === 'str') return str(l.v + r.v);
  if (l.k === 'str' && r.k === 'pre') return pre(l.v + r.v, r.why);
  if (l.k === 'pre' || l.k === 'name' || passesThrough(l)) return l;
  if (l.k === 'str' && l.v !== '') return pre(l.v, partlyKnownWhy(r, 'a string is joined to'));
  return unk('it is built from a value that is not known');
}

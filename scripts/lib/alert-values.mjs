/** Evaluating the few shapes of Terraform value the alert rules use, and refusing the rest by name (alert-declarations.mjs). */
import { skipString } from './hcl-blocks.mjs';

/** The literal string an expression is, or null when it is not one string. */
export function quoted(expr) {
  if (!expr?.startsWith('"')) return null;
  let end;
  try {
    end = skipString(expr, 0);
  } catch {
    return null;
  }
  return end === expr.length ? expr.slice(1, -1) : null;
}

/**
 * Evaluate a quoted template, handing each `${…}` to `resolve`. Escapes are
 * undone; a `%{…}` directive is refused, since no rule name uses one.
 */
export function evaluateTemplate(expr, resolve) {
  const body = quoted(expr);
  if (body === null) throw new Error(`not a quoted string: ${expr}`);
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      out += body[i + 1];
      i += 2;
    } else if ((c === '$' || c === '%') && body[i + 1] === c && body[i + 2] === '{') {
      out += `${c}{`;
      i += 3;
    } else if (c === '%' && body[i + 1] === '{') {
      throw new Error(`template directive in ${expr}`);
    } else if (c === '$' && body[i + 1] === '{') {
      // Interpolations in a name hold a bare reference, never a nested brace.
      const close = body.indexOf('}', i + 2);
      out += resolve(body.slice(i + 2, close).trim());
      i = close + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

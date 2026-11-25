/**
 * The HCL formatter the emitter modules share (#667). The output is what
 * `terraform fmt` would write: two-space indentation, `=` aligned across a
 * run of single-line attributes and left alone where a multi-line value or a
 * comment breaks the run, no trailing whitespace, one newline at the end.
 * `body()` is that rule, so no emitter can drift from it by accident;
 * hcl.test.js checks the shape and, where terraform is installed,
 * `terraform fmt -check` is the referee.
 */
import { AVM_MODULES, SUBSCRIPTION_SCOPED_PROVIDERS } from '../avmVersions';

export const INDENT = '  ';

/** A quoted HCL string. Values here are ours, so only the quote and backslash need care. */
export const q = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * An object key: bare when it is a plain identifier (letters, digits,
 * underscore), quoted otherwise. HCL identifiers may contain hyphens, so
 * `Enable-DDoS-VNET = {` is valid; quoting it anyway means a reader does not
 * have to know the grammar to trust the file.
 */
export const key = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : q(name));

const isAttr = (item) => Array.isArray(item) && typeof item[1] === 'string';
const isNested = (item) => Array.isArray(item) && Array.isArray(item[1]);

/** Emit a run of single-line attributes with their `=` aligned. */
function flushRun(run, out) {
  if (!run.length) return;
  const width = Math.max(...run.map(([key]) => key.length));
  for (const [key, value] of run) out.push(`${key.padEnd(width)} = ${value}`);
  run.length = 0;
}

/** Emit `key = {` … `}` (or `[` … `]`), the inner lines indented one level. */
function pushNested([key, lines], out) {
  out.push(`${key} = ${lines[0]}`);
  for (const line of lines.slice(1, -1)) out.push(line === '' ? '' : INDENT + line);
  out.push(lines[lines.length - 1]);
}

/**
 * The lines of a block body. `items`: `[key, value]` for a single-line
 * attribute, `[key, lines]` for a multi-line one, or a string emitted as is
 * (a comment, a blank line, or a line of a nested block).
 */
export function body(items) {
  const out = [];
  const run = [];
  for (const item of items) {
    if (isAttr(item)) {
      run.push(item);
      continue;
    }
    flushRun(run, out);
    if (isNested(item)) pushNested(item, out);
    else out.push(item);
  }
  flushRun(run, out);
  return out;
}

/** `header {` … `}` with the body indented one level. */
export function block(header, items) {
  return [`${header} {`, ...body(items).map((l) => (l === '' ? '' : INDENT + l)), '}'];
}

/** A `{ … }` object value for a nested attribute. */
export const obj = (items) => ['{', ...body(items), '}'];

/**
 * A `[ … ]` list value, one element per line, trailing commas as fmt keeps
 * them. An element may be a multi-line value from `obj()`: its inner lines
 * are indented one level and its closing line takes the comma. Before this,
 * an object element was joined into one broken line, which Terraform refused.
 */
export const list = (elements) => [
  '[',
  ...elements.flatMap((e) =>
    Array.isArray(e)
      ? [e[0], ...e.slice(1, -1).map((l) => (l === '' ? '' : INDENT + l)), `${e[e.length - 1]},`]
      : [`${e},`]
  ),
  ']',
];

/** `{ path, content }` with LF line endings and one newline at EOF. */
export const file = (path, lines) => ({ path, content: `${lines.join('\n')}\n` });

/** The `source` and `version` lines of a module call, from the pins. */
export function moduleSource(name) {
  const pinned = AVM_MODULES[name];
  return [
    ['source', q(pinned.source)],
    ['version', q(pinned.version)],
  ];
}

/**
 * The `providers` map of a module block: every provider the module requires
 * at its pinned tag, the subscription-scoped ones (azurerm, azapi) pointed
 * at `alias`, the rest at their default configuration. With `alias` null
 * everything maps to the defaults. Once a block has a `providers` argument
 * Terraform inherits nothing for the providers it omits, which is why the
 * map is generated from the module's list rather than written by hand.
 */
export function providersMap(name, alias) {
  return obj(
    AVM_MODULES[name].requiredProviders.map((p) => [
      p,
      alias && SUBSCRIPTION_SCOPED_PROVIDERS.includes(p) ? `${p}.${alias}` : p,
    ])
  );
}

/** A policy default value: the alz provider wants each as a JSON object with `value`. */
export const jsonValue = (expr) => `jsonencode({ value = ${expr} })`;

/** Blocks separated by one blank line. */
export const joinBlocks = (blocks) => blocks.flatMap((b, i) => (i === 0 ? b : ['', ...b]));

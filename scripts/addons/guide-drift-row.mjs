/**
 * guide-drift-row.mjs (#1356, split out #1845) — the guide's side of check-guide-drift.mjs.
 *
 * Reads what an add-on's integration guide says: the pasted catalogue row (found under its "Catalogue row"
 * heading and evaluated in an empty node:vm context, never with eval in this process) and the lab-host port the
 * guide states. check-guide-drift.mjs explains why the row is treated as text from another repository.
 *
 * Node built-ins only: .github/workflows/addon-guide-check.yml fetches this file by name, with no npm install.
 */
import vm from 'node:vm';

/** Turns a value that came out of the vm context into plain data of this realm (a frozen array is still an array). */
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * The text of the guide's pasted row: the first ```js block under the heading that starts "Catalogue row"
 * (a number before the words is allowed: "## 1. Catalogue row"). Returns { block } or { error }.
 */
export function extractRowBlock(guideText) {
  const lines = guideText.replace(/\r\n/g, '\n').split('\n');
  const heading = lines.findIndex((line) => /^#{1,6}[ \t]+(?:\d+\.[ \t]*)?Catalogue row\b/i.test(line));
  if (heading === -1) return { error: 'the guide has no heading that starts "Catalogue row"' };

  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^#{1,6}[ \t]/.test(lines[i])) break;
    if (!/^```(?:js|javascript)[ \t]*$/.test(lines[i])) continue;
    const end = lines.findIndex((line, at) => at > i && /^```[ \t]*$/.test(line));
    if (end === -1) return { error: 'the guide\'s row block is never closed (no closing ``` line)' };
    return { block: lines.slice(i + 1, end).join('\n') };
  }
  return { error: 'the guide has no ```js block under its "Catalogue row" heading' };
}

/** Evaluates the pasted object literal in an empty vm context. Returns { row } or { error }. */
export function evaluateRowBlock(block) {
  let value;
  try {
    value = vm.runInNewContext(`(${block}\n)`, Object.create(null), {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch (error) {
    return { error: `the guide's row block is not a readable object (${String(error?.message ?? error).split('\n')[0]})` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: "the guide's row block is not a single `{ ... }` object" };
  }
  let row;
  try {
    row = plain(value);
  } catch (error) {
    return { error: `the guide's row block is not plain data (${error.message})` };
  }
  return { row };
}

/**
 * The port the guide states, or null when it states none. Reads a table row whose label mentions the loopback
 * port; the value must start with a number (optionally in backticks, optionally `127.0.0.1:` before it).
 * "not assigned; ... the Cloud Assessor uses 18083" starts with a word, so it states nothing.
 */
export function guidePort(guideText) {
  for (const line of guideText.replace(/\r\n/g, '\n').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || cells[0] !== '') continue;
    if (!/loopback port/i.test(cells[1])) continue;
    const value = cells[2].match(/^`?(?:127\.0\.0\.1:)?(\d{2,5})\b/);
    if (value) return Number(value[1]);
  }
  return null;
}

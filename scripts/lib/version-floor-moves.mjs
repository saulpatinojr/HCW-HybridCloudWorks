/**
 * Moving an engines.node range in the files that record it (#715): the
 * package.json, and the root entry of the package-lock.json beside it, which
 * npm copies from the package.json and lib/version-pins.mjs holds to it.
 *
 * Each file is edited as JSON, one field, and written back in the form npm
 * writes it: two-space JSON and a final newline. A file not already in that
 * form is refused rather than reformatted, so a move never carries a reformat
 * nobody reviewed; so is a file whose range is not the one being moved. Pure:
 * text in, text out, and update-version-floors.mjs does the reading and
 * writing.
 */

const npmForm = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parseInNpmForm(file, text) {
  const value = JSON.parse(text);
  if (npmForm(value) !== text) throw new Error(`${file} is not in the form npm writes (two-space JSON, final newline), so it was not moved`);
  return value;
}

function moveIn(file, engines, from, to) {
  if (engines?.node !== from) {
    const recorded = engines?.node === undefined ? 'no engines.node' : `engines.node "${engines.node}"`;
    throw new Error(`${file} records ${recorded}, not "${from}", so it was not moved`);
  }
  engines.node = to;
}

/** package.json text with engines.node moved from `from` to `to`. */
export function moveManifestRange(file, text, from, to) {
  const manifest = parseInNpmForm(file, text);
  moveIn(file, manifest.engines, from, to);
  return npmForm(manifest);
}

/** package-lock.json text with its root entry's engines.node moved from `from` to `to`. */
export function moveLockfileRange(file, text, from, to) {
  const lock = parseInNpmForm(file, text);
  moveIn(file, lock.packages?.['']?.engines, from, to);
  return npmForm(lock);
}

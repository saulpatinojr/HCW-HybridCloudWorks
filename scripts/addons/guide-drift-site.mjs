/**
 * guide-drift-site.mjs (#1356, split out #1845) — the website's side of check-guide-drift.mjs.
 *
 * Reads what the website says about an add-on: its row in frontend/src/data/addons/catalogue.js and its port in
 * the lab host's group_vars (lab-host/ansible/group_vars/all.yml).
 *
 * Node built-ins only: .github/workflows/addon-guide-check.yml fetches this file by name, with no npm install.
 */
import { plain } from './guide-drift-row.mjs';

/**
 * The catalogue row with this id. The file is pure data with no imports (its own header says so), so it is
 * loaded as a module from a data: URL, which works whatever package.json is or is not beside the file.
 */
export async function loadCatalogueRow(catalogueText, id) {
  const url = `data:text/javascript;base64,${Buffer.from(catalogueText, 'utf8').toString('base64')}`;
  let module;
  try {
    module = await import(url);
  } catch (error) {
    throw new Error(`the site's catalogue could not be loaded: ${error.message}`);
  }
  const rows = module.addons;
  if (!Array.isArray(rows)) throw new Error("the site's catalogue does not export an `addons` list");
  const row = rows.find((candidate) => candidate?.id === id);
  return row === undefined ? null : plain(row);
}

/**
 * The `port:` of each `addons:` row in the lab host's group_vars, by id. Split the same way read-addon-pins.mjs
 * splits (rows start at two spaces and `- id:`), but a row with no digest still counts: the guide may state a
 * port before the image exists.
 */
export function readAddonPorts(groupVarsText) {
  const block = groupVarsText.replace(/\r\n/g, '\n').match(/^addons:\n([\s\S]*?)(?=\n[A-Za-z_]+:|\n*(?![\s\S]))/m)?.[1];
  if (!block) throw new Error('no `addons:` block in the group_vars file');
  const ports = new Map();
  for (const row of `\n${block}`.split(/\n {2}- id:[ \t]*/).slice(1)) {
    const id = row.match(/^([a-z0-9-]+)/)?.[1];
    if (!id) throw new Error('an addons row has no id');
    const port = row.match(/^ {4}port:[ \t]*(\d+)\b/m)?.[1];
    ports.set(id, port === undefined ? null : Number(port));
  }
  return ports;
}

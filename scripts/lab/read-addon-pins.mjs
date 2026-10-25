/**
 * read-addon-pins.mjs — the tool add-on images the lab host runs, read from the pins in
 * lab-host/ansible/group_vars/all.yml, as a GitHub Actions matrix (addon-image-scout.yml).
 *
 * The host pulls each add-on by digest (`addons[].image` and `addons[].image_digest`), so a digest is what
 * runs. The check reads the same two lines the `addons` role reads rather than keeping a second list that
 * could drift from them. A row with no digest is skipped, because the role does not deploy it either; a row
 * whose image or digest is not the shape the role accepts stops the run, because a check that quietly
 * skipped a malformed pin would pass for the wrong reason.
 *
 *   node scripts/lab/read-addon-pins.mjs        prints {"include":[{"id":..., "image":"docker.io/...@sha256:..."}]}
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lab-host', 'ansible', 'group_vars', 'all.yml');
const IMAGE = /^docker\.io\/hybridcloudworks\/[a-z0-9][a-z0-9-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The `addons:` rows of a group_vars file that carry a digest: `[{ id, image, digest }]`. */
export function readAddonPins(text) {
  const block = text.replace(/\r\n/g, '\n').match(/^addons:\n([\s\S]*?)(?=\n[A-Za-z_]+:|\n*(?![\s\S]))/m)?.[1];
  if (!block) throw new Error('no `addons:` block in the group_vars file');
  const rows = `\n${block}`.split(/\n {2}- id:[ \t]*/).slice(1);
  if (rows.length === 0) throw new Error('the `addons:` block has no rows');

  const pins = [];
  for (const row of rows) {
    const id = row.match(/^([a-z0-9-]+)/)?.[1];
    if (!id) throw new Error('an addons row has no id');
    const enabled = row.match(/^ {4}enabled:[ \t]*(\w+)/m)?.[1];
    const image = row.match(/^ {4}image:[ \t]*(\S+)/m)?.[1];
    // YAML reads `"sha256:…"`, `'sha256:…'` and a bare sha256:… as the same string, and so does the addons role,
    // so all three are pins here; skipping a bare one would drop the image from the check without a word.
    const m = row.match(/^ {4}image_digest:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#"']+))/m);
    const digest = m?.[1] ?? m?.[2] ?? m?.[3] ?? '';
    if (enabled === 'false' || digest === '') continue;
    if (!image || !IMAGE.test(image)) throw new Error(`add-on ${id}: image ${JSON.stringify(image)} is not docker.io/hybridcloudworks/<name>`);
    if (!DIGEST.test(digest)) throw new Error(`add-on ${id}: image_digest ${JSON.stringify(digest)} is not sha256:<64 hex>`);
    pins.push({ id, image, digest });
  }
  if (pins.length === 0) throw new Error('no add-on row carries a digest, so there is nothing to check');
  return pins;
}

/** The GitHub Actions matrix for those pins: each entry's `image` is `<repository>@<digest>`. */
export function toMatrix(pins) {
  return { include: pins.map(({ id, image, digest }) => ({ id, image: `${image}@${digest}` })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] ?? DEFAULT_FILE;
  process.stdout.write(`${JSON.stringify(toMatrix(readAddonPins(readFileSync(file, 'utf8'))))}\n`);
}

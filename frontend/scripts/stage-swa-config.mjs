/**
 * Stage staticwebapp.config.json into the build output, with the policy the
 * output needs.
 *
 * The deployed content root is `dist`, not `frontend`. Azure Static Web Apps
 * reads `staticwebapp.config.json` from the root of whatever is uploaded, so a
 * dist without it is a dist that silently loses every route rule.
 *
 * WHY THE FILE IS NOT SIMPLY IN `public/`, which Vite would copy for free: it
 * is read from the repository root of `frontend/` by `src/lib/csp.test.js`,
 * which asserts the CSP `connect-src` names the same host as
 * `VITE_AZURE_FUNCTIONS_URL`, and it is referenced by that path in
 * Migration-Plan §3.4, CHANGELOG.md and Architecture-Plan. Moving it would make
 * five references wrong to save one copy. And since #935 the staged copy is
 * not the committed file: the policy is finished here, from the pages.
 *
 * WHAT BREAKS WITHOUT IT, and why it would not be obvious: §3.4 exists because
 * the soft 404 was already broken once. The config carries the SPA fallback
 * rewrite, the 404 override and the CSP. Deploy without it and the site loads,
 * the home page works, and every deep link 404s — which reads as a routing bug
 * in the app rather than a missing file.
 *
 * THE CONTENT-SECURITY-POLICY IS FINISHED HERE, NOT IN THE SOURCE FILE (AP-F11,
 * #935). The committed policy has no 'unsafe-inline' anywhere. The site is
 * static, so there is no per-request nonce to hand an inline style; what the
 * pre-rendered pages carry inline is allowed by hash instead, and the hashes
 * are computed from the pages in dist on every build. A change to the legal
 * pages' stylesheet or to a component's `style` prop updates the policy on the
 * next build, with nobody editing a header by hand:
 *
 *   - `<style>` elements — the two legal pages share one block — get one
 *     'sha256-…' per distinct body, appended to style-src.
 *   - `style` attributes — React's `style` prop, framer-motion's initial
 *     state, the code highlighter's token colours, the tables in published
 *     articles — get one 'sha256-…' per distinct value, in style-src-attr
 *     behind 'unsafe-hashes'. That keyword is what lets a hash apply to an
 *     attribute at all; the name is the specification's, and the hashes are of
 *     this build's own markup, never of anything a request supplies. All three
 *     forms the HTML parser accepts are read — `style="…"`, `style='…'` and an
 *     unquoted `style=…` — because React writes the first, but a page copied
 *     from `public/` or an article body from the CMS can carry either of the
 *     others, and a value this misses is blocked on the deployed site with
 *     nothing in CI to say so.
 *
 * Styles React sets at runtime go through the CSSOM, which no CSP governs, so
 * hydration and client-side navigation need nothing from this. A `style`
 * attribute that reaches the page as HTML — a pre-rendered page, or an article
 * body set with innerHTML — is checked, and because the hash is of the value,
 * the same markup passes on both paths. The hash of an attribute is of its
 * value as the browser parses it, so React's entity escapes (`&quot;` in a
 * font-family) are decoded before hashing.
 *
 * Measured 2026-10-15 on 230 HTML documents: 2 `<style>` elements with 1
 * distinct body, 2,969 `style` attributes with 80 distinct values. The
 * measurement, its sources and how to repeat it are in
 * docs/architecture/how-it-is-built.md.
 *
 * This runs as `postbuild`, so it is part of `npm run build` rather than a step
 * a workflow has to remember. Any deploy path that builds gets a complete dist.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
// A start tag: its name, then everything up to the `>` that closes it. A
// quoted value may hold a `>` of its own, so a quoted run is taken whole.
const START_TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
// One attribute of a start tag: a name and, if it has one, a value in any of
// the three forms the HTML specification allows — double-quoted,
// single-quoted or unquoted. The unquoted class excludes what the
// specification forbids there, so it stops where the parser would.
const TAG_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The entities React and the CMS emit inside an attribute value. */
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * An attribute value as the browser parses it.
 *
 * The CSP hash is of the parsed value, and React escapes `"` as `&quot;` and
 * `'` as `&#x27;` on the way out, so a font-family with quotes in it hashes
 * wrongly unless the escapes are undone first. Unknown entities are left as
 * written, which is also what the parser does. A numeric reference the HTML
 * spec calls invalid (zero, a surrogate, or past U+10FFFF) becomes U+FFFD, as
 * the parser makes it; `String.fromCodePoint` would throw on two of those and
 * fail the build on one stray `&#x110000;` (CodeRabbit on #1185).
 */
export function decodeAttribute(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        !Number.isFinite(code) ||
        code === 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return '\uFFFD';
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Every start tag in a page, with its attributes read the way the HTML parser
 * reads them: names lower-cased, the first of a repeated name kept, a name
 * with no value set to the empty string, and each value decoded whichever of
 * the three forms it is written in.
 *
 * Only text in attribute position is an attribute. A search of the whole page
 * for `style=` also finds it inside another attribute's value — the
 * pre-render's seed carries whole article bodies, escaped, in one — and in
 * prose; with an unquoted value allowed, every such hit would put a hash of
 * nothing real into the policy. Shared with check-image-hosts.mjs, so the
 * policy and the image gate read a page the same way.
 */
export function* startTags(html) {
  for (const tag of html.matchAll(START_TAG)) {
    const attributes = new Map();
    for (const attribute of tag[2].matchAll(TAG_ATTRIBUTE)) {
      const name = attribute[1].toLowerCase();
      if (attributes.has(name)) continue;
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      attributes.set(name, decodeAttribute(value));
    }
    yield { name: tag[1].toLowerCase(), attributes };
  }
}

/** The value of every `style` attribute in a page, decoded, in any of the three forms. */
export function styleAttributeValues(html) {
  const values = [];
  for (const { attributes } of startTags(html)) {
    if (attributes.has('style')) values.push(attributes.get('style'));
  }
  return values;
}

/** The CSP source token for a text: `'sha256-<base64>'` over its UTF-8 bytes. */
export function sha256Source(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * Every inline style in a set of pages, keyed by hash.
 *
 * `elements` is one entry per distinct `<style>` body; `attributes` one per
 * distinct `style` attribute value. Each entry carries where it was seen, so
 * the report after a build can say which page introduced a new hash.
 *
 * @param {Iterable<[string, string]>} pages  `[path, html]` pairs.
 */
export function collectInlineStyles(pages) {
  const elements = new Map();
  const attributes = new Map();
  let elementCount = 0;
  let attributeCount = 0;
  for (const [path, html] of pages) {
    for (const match of html.matchAll(STYLE_ELEMENT)) {
      elementCount += 1;
      const body = match[1];
      const hash = sha256Source(body);
      const entry = elements.get(hash) ?? { bytes: Buffer.byteLength(body, 'utf8'), files: [] };
      if (!entry.files.includes(path)) entry.files.push(path);
      elements.set(hash, entry);
    }
    for (const value of styleAttributeValues(html)) {
      attributeCount += 1;
      const hash = sha256Source(value);
      const entry = attributes.get(hash) ?? { value, count: 0, files: [] };
      entry.count += 1;
      if (!entry.files.includes(path)) entry.files.push(path);
      attributes.set(hash, entry);
    }
  }
  return { elements, attributes, elementCount, attributeCount };
}

/** The policy split into `[name, sources[]]` pairs, in order. */
function directives(policy) {
  return policy
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return [name, sources];
    });
}

/**
 * The committed policy with this build's style hashes in it.
 *
 * Refuses a policy that already carries 'unsafe-inline' or a style-src-attr:
 * the first would make every hash here decorative, and the second is this
 * function's to write. Both are the committed file drifting back towards the
 * state #935 removed, and a build is the earliest place that can say so.
 */
export function withInlineStyleHashes(policy, { elementHashes = [], attributeHashes = [] }) {
  if (/'unsafe-inline'/.test(policy)) {
    throw new Error(
      "staticwebapp.config.json carries 'unsafe-inline'; the policy allows inline style by hash, computed here, and never by that keyword (#935)."
    );
  }
  const parsed = directives(policy);
  if (parsed.some(([name]) => name === 'style-src-attr')) {
    throw new Error(
      'staticwebapp.config.json carries a style-src-attr directive; it is computed from dist by stage-swa-config.mjs and must not be committed (#935).'
    );
  }
  const styleSrc = parsed.find(([name]) => name === 'style-src');
  if (!styleSrc) {
    throw new Error('staticwebapp.config.json has no style-src directive to add the hashes to.');
  }
  styleSrc[1].push(...[...elementHashes].sort());
  if (attributeHashes.length > 0) {
    parsed.push(['style-src-attr', ["'unsafe-hashes'", ...[...attributeHashes].sort()]]);
  }
  return `${parsed.map(([name, sources]) => [name, ...sources].join(' ')).join('; ')};`;
}

/**
 * Every file under a directory with one of the extensions, as
 * `[relative path, text]`, each level in code-unit order of its names so the
 * result is the same on every filesystem. Shared with check-image-hosts.mjs.
 *
 * The walk branches on the type readdir returns with each name and reads a
 * file with no stat before it. A stat followed by a read judges one file and
 * opens whatever is at the path by the time of the read (CodeQL
 * js/file-system-race); the entry's own type has no such gap to fall into.
 * An entry that is neither a directory nor a regular file — a symbolic link
 * among them — is not followed, and a build writes none.
 */
export function filesUnder(root, extensions) {
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push([relative(root, path), readFileSync(path, 'utf8')]);
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Every HTML document under a directory, as `[relative path, text]`.
 *
 * Line endings are normalised to LF before anything is hashed, because that
 * is what the browser does: the HTML parser turns CR LF and a lone CR into
 * LF before a `<style>` body or an attribute value exists to be hashed. The
 * pre-render writes LF, but a page copied from `public/` on a checkout with
 * the wrong line endings would otherwise hash to a value no browser computes.
 */
export function htmlPages(root) {
  return filesUnder(root, ['.html']).map(([path, text]) => [path, text.replace(/\r\n?/g, '\n')]);
}

/**
 * Read the committed config, finish its policy from the pages in dist, and
 * write the result beside them. Returns what was computed, for the log.
 */
export function stageConfig({ source, dist }) {
  const config = JSON.parse(readFileSync(source, 'utf8'));
  const policy = config.globalHeaders?.['Content-Security-Policy'];
  if (typeof policy !== 'string') {
    throw new Error(`${source} has no globalHeaders.Content-Security-Policy to stage.`);
  }
  const styles = collectInlineStyles(htmlPages(dist));
  config.globalHeaders['Content-Security-Policy'] = withInlineStyleHashes(policy, {
    elementHashes: [...styles.elements.keys()],
    attributeHashes: [...styles.attributes.keys()],
  });
  const destination = join(dist, 'staticwebapp.config.json');
  writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`);
  return { destination, styles, policy: config.globalHeaders['Content-Security-Policy'] };
}

function main() {
  const source = fileURLToPath(new URL('../staticwebapp.config.json', import.meta.url));
  const dist = fileURLToPath(new URL('../dist', import.meta.url));

  if (!existsSync(source)) {
    console.error(
      `[stage-swa-config] ${source} is missing — the deployed site would lose every route rule.`
    );
    process.exit(1);
  }
  if (!existsSync(dist)) {
    console.error(
      '[stage-swa-config] dist/ does not exist. Run this after vite build, not before.'
    );
    process.exit(1);
  }

  const { destination, styles, policy } = stageConfig({ source, dist });
  console.log(
    `[stage-swa-config] inline style: ${styles.elementCount} <style> element(s), ${styles.elements.size} distinct; ` +
      `${styles.attributeCount} style attribute(s), ${styles.attributes.size} distinct — hashed into the policy`
  );
  console.log(
    `[stage-swa-config] staticwebapp.config.json -> dist/ (${statSync(destination).size} bytes; policy ${policy.length} characters)`
  );
}

// Guarded so the pure functions above can be imported by stage-swa-config.test.js
// without the import writing into dist.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[stage-swa-config] ${error.message}`);
    process.exit(1);
  }
}

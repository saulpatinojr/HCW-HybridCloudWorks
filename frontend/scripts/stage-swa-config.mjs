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
 *   - `style="…"` attributes — React's `style` prop, framer-motion's initial
 *     state, the code highlighter's token colours, the tables in published
 *     articles — get one 'sha256-…' per distinct value, in style-src-attr
 *     behind 'unsafe-hashes'. That keyword is what lets a hash apply to an
 *     attribute at all; the name is the specification's, and the hashes are of
 *     this build's own markup, never of anything a request supplies.
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
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*"([^"]*)"/gi;

/** The entities React and the CMS emit inside an attribute value. */
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * An attribute value as the browser parses it.
 *
 * The CSP hash is of the parsed value, and React escapes `"` as `&quot;` and
 * `'` as `&#x27;` on the way out, so a font-family with quotes in it hashes
 * wrongly unless the escapes are undone first. Unknown entities are left as
 * written, which is also what the parser does.
 */
export function decodeAttribute(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
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
    for (const match of html.matchAll(STYLE_ATTRIBUTE)) {
      attributeCount += 1;
      const value = decodeAttribute(match[1]);
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
 * Every HTML document under a directory, as `[relative path, text]`.
 *
 * Line endings are normalised to LF before anything is hashed, because that
 * is what the browser does: the HTML parser turns CR LF and a lone CR into
 * LF before a `<style>` body or an attribute value exists to be hashed. The
 * pre-render writes LF, but a page copied from `public/` on a checkout with
 * the wrong line endings would otherwise hash to a value no browser computes.
 */
export function htmlPages(root) {
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.html'))
        pages.push([relative(root, path), readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')]);
    }
  };
  walk(root);
  return pages;
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

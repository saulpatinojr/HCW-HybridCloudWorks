/**
 * The reading half of the weekly AWS and Google Cloud module pin check
 * (#1869): registry sources and version lists, the newest stable release,
 * and the Terraform and provider constraints in a release's versions.tf.
 * Plain data in, plain data out: no network, no files. cloud-module-pins.mjs
 * re-exports all of it beside the report half, so callers import one file.
 * Split in two only to keep each file small enough to read.
 */

/** A registry answer that cannot be read, or a request that did not finish. */
export class CheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckError';
  }
}

const REGISTRY = 'https://registry.terraform.io/v1/modules';
const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Split a registry source into its three parts and the optional submodule
 * path after `//`. `terraform-google-modules/cloud-storage/google//modules/simple_bucket`
 * is the cloud-storage module, read from its `modules/simple_bucket` folder.
 *
 * @param {string} source
 * @returns {{ namespace: string, name: string, provider: string, submodule: string }}
 */
export function registryAddress(source) {
  const [root, ...rest] = String(source).split('//');
  const parts = root.split('/');
  if (parts.length !== 3 || !parts.every((part) => PART.test(part))) {
    throw new CheckError(
      `"${source}" is not a registry source of the form namespace/name/provider.`
    );
  }
  const submodule = rest.join('//').replace(/^\/+|\/+$/g, '');
  if (submodule.split('/').some((part) => part === '..')) {
    throw new CheckError(`"${source}" has a submodule path that leaves the module.`);
  }
  const [namespace, name, provider] = parts;
  return { namespace, name, provider, submodule };
}

/** The registry page that lists every published release of a module. */
export const versionsUrl = ({ namespace, name, provider }) =>
  `${REGISTRY}/${namespace}/${name}/${provider}/versions`;

/** The registry page for one release, which names its GitHub repository and tag. */
export const releaseUrl = ({ namespace, name, provider }, version) =>
  `${REGISTRY}/${namespace}/${name}/${provider}/${version}`;

/**
 * `MAJOR.MINOR.PATCH` as three numbers, or null for anything else (a
 * pre-release such as `2.0.0-beta1` is not a release the builder pins).
 */
export function parseVersion(value) {
  const m = STABLE.exec(String(value));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The release strings out of a registry `/versions` answer. Throws when the
 * answer is not the shape the registry documents, because an empty list
 * read from a broken answer would otherwise look like "not published".
 *
 * @param {unknown} doc the parsed JSON
 * @param {string} source for the message
 * @returns {string[]}
 */
export function listedVersions(doc, source) {
  const versions = doc?.modules?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new CheckError(
      `The registry's list of releases for ${source} was empty or not in the expected shape, so the pin could not be checked.`
    );
  }
  return versions.map((entry) => String(entry?.version ?? ''));
}

/** The highest stable release in a list, or null when there is none. */
export function newestRelease(versions) {
  return versions
    .filter((v) => parseVersion(v))
    .reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/**
 * Whether the pin is published, and the newest release beside it.
 *
 * @param {string} pinned the version in moduleVersions.js
 * @param {string[]} versions what the registry lists
 */
export function judgePin(pinned, versions) {
  const newest = newestRelease(versions);
  const published = versions.includes(pinned);
  const newer = Boolean(
    published && newest && parseVersion(pinned) && compareVersions(newest, pinned) > 0
  );
  return { published, newest, newer };
}

/**
 * The raw versions.tf of a release on GitHub, from the repository the
 * registry names (`https://github.com/<owner>/<repo>`) and its tag. Null when
 * the repository is not on github.com, which this check then reports instead
 * of guessing.
 */
export function versionsTfUrl(repository, tag, submodule = '') {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    String(repository)
  );
  if (!m || !tag) return null;
  const folder = submodule ? `${submodule}/` : '';
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${encodeURIComponent(tag)}/${folder}versions.tf`;
}

/** The text with HCL comments (`#`, `//` and slash-star blocks) blanked out. */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"])(#|\/\/).*$/gm, '$1');
}

/** The text between the `{` at `open` and its matching `}`. */
function blockAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/**
 * What a versions.tf asks for: `required_version` and the `version` of each
 * entry under `required_providers`. A provider listed without a version is
 * kept with `null`, so "asks for nothing in particular" is not lost.
 *
 * @param {string} text
 * @returns {{ terraform: string | null, providers: Record<string, string | null> }}
 */
export function parseVersionsTf(text) {
  const clean = stripComments(text);
  const terraform = /required_version\s*=\s*"([^"]*)"/.exec(clean)?.[1] ?? null;
  const providers = {};
  const start = /required_providers\s*\{/.exec(clean);
  if (start) {
    const body = blockAt(clean, start.index + start[0].length - 1);
    for (const m of body.matchAll(/([A-Za-z0-9_-]+)\s*=\s*\{([^{}]*)\}/g)) {
      providers[m[1]] = /version\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? null;
    }
  }
  return { terraform, providers };
}

/**
 * A constraint written one way: clauses trimmed, single spaces, and a
 * trailing `.0` dropped from a clause that is not `~>` (`>= 5.43.0` and
 * `>= 5.43` allow the same versions; `~> 5.0` and `~> 5` do not).
 */
export function normalizeConstraint(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .split(',')
    .map((clause) => clause.trim().replace(/\s+/g, ' '))
    .map((clause) => clause.replace(/^(~>|>=|<=|>|<|=)\s*/, '$1 '))
    .map((clause) => (clause.startsWith('~>') ? clause : clause.replace(/(\d+\.\d+)\.0$/, '$1')))
    .filter(Boolean)
    .join(', ');
}

/**
 * Where what a newer release's versions.tf asks for differs from the
 * `requires` recorded for the pin. Only what that one file declares is
 * compared: the recorded value can be tighter because it also counts the
 * submodules the release calls, so a line here is a prompt to read the
 * release by hand, not proof the pin is wrong.
 *
 * @param {{ terraform: string, providers: Record<string, string> }} recorded
 * @param {{ terraform: string | null, providers: Record<string, string | null> }} read
 * @returns {Array<{ what: string, recorded: string | null, read: string | null }>}
 */
export function requiresDrift(recorded, read) {
  const drift = [];
  const differs = (a, b) => normalizeConstraint(a) !== normalizeConstraint(b);
  if (read.terraform !== null && differs(recorded.terraform, read.terraform)) {
    drift.push({ what: 'Terraform', recorded: recorded.terraform, read: read.terraform });
  }
  for (const [name, constraint] of Object.entries(read.providers)) {
    const mine = recorded.providers?.[name] ?? null;
    if (constraint === null && mine === null) continue;
    if (differs(mine, constraint)) {
      drift.push({ what: `provider ${name}`, recorded: mine, read: constraint });
    }
  }
  return drift;
}

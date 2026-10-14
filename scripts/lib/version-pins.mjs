/**
 * Where the repository chooses a version, and which reader reads it (#715).
 *
 * Every reader is a text scan rather than a parse: nothing in this repository
 * parses YAML or HCL, `scripts/` carries two runtime dependencies on purpose,
 * and workflow-write-permissions.test.mjs set the precedent. Each reader
 * over-reports rather than under-reports: a value it cannot read is a problem
 * ("cannot verify"), never a silent pass.
 *
 * A reader returns { pins, problems }. A pin is { file, line, where, kind,
 * raw } plus exactly one of `version` (an exact or line-only version),
 * `range` (an npm engines range) or `constraint` (a Terraform constraint),
 * or `missing: true` for a package.json with no engines.node. `where` is
 * `file > job > step` for a workflow, so a platform ceiling can name one.
 *
 * The workflow reader is in version-pins-workflows.mjs, the Dockerfile, lab
 * job image and lab host readers in version-pins-hosts.mjs; this file holds the manifests,
 * version files and Terraform, and the table that sends each tracked file to
 * its reader. scripts/version-floors.mjs re-exports what the tests use.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { parseVersion } from './version-math.mjs';
import { empty, linesOf, merge, read } from './pin-text.mjs';
import { readWorkflow } from './version-pins-workflows.mjs';
import { JOB_IMAGES_FILE, readDockerfile, readJobImages, readLabHost } from './version-pins-hosts.mjs';

export { readDockerfile, readJobImages, readLabHost, readWorkflow };

/** engines.node of one package.json, or a `missing` marker the rules check against the exemptions. */
function readPackageJson(root, file) {
  const text = read(root, file);
  let engines;
  try {
    engines = JSON.parse(text).engines?.node;
  } catch (err) {
    return { pins: [], problems: [{ file, line: 0, where: file, kind: 'node', raw: '', message: `unreadable JSON: ${err.message}` }] };
  }
  const where = `${file} > engines.node`;
  if (engines === undefined) return { pins: [{ file, line: 0, where, kind: 'node', raw: '', version: null, missing: true }], problems: [] };
  const line = linesOf(text).findIndex((l) => /"node"\s*:/.test(l)) + 1;
  return { pins: [{ file, line, where, kind: 'node', raw: engines, range: engines }], problems: [] };
}

/**
 * A package-lock.json's root entry repeats its package.json's engines.node,
 * and npm rewrites it from there on the next install. One that disagrees is
 * a finding rather than a pin: left alone, the old range would ride into
 * whichever unrelated pull request next runs `npm install` in that package.
 */
function readLockfile(root, file) {
  const manifest = posix.join(posix.dirname(file), 'package.json');
  const where = `${file} > packages[""].engines.node`;
  let locked;
  let declared;
  try {
    locked = JSON.parse(read(root, file)).packages?.['']?.engines?.node;
    declared = JSON.parse(read(root, manifest)).engines?.node;
  } catch (err) {
    return { pins: [], problems: [{ file, line: 0, where, kind: 'node', raw: '', message: `cannot compare with ${manifest}: ${err.message}` }] };
  }
  if (locked === declared) return empty();
  const shown = (range) => (range === undefined ? 'no engines.node' : `engines.node "${range}"`);
  return {
    pins: [],
    problems: [
      {
        file,
        line: 0,
        where,
        kind: 'node',
        raw: locked ?? '',
        message: `records ${shown(locked)} where ${manifest} declares ${shown(declared)}; run npm install in ${posix.dirname(file)} so the two agree`,
      },
    ],
  };
}

const VERSION_FILES = { '.nvmrc': 'node', '.node-version': 'node', '.python-version': 'python' };

/** .nvmrc, .node-version, .python-version: nvm, fnm, volta and pyenv read the first line, `v26` and `26` alike. */
function readVersionFile(root, file) {
  const kind = VERSION_FILES[posix.basename(file)];
  const raw = linesOf(read(root, file))[0].trim();
  const value = raw.replace(/^v/, '');
  const at = { file, line: 1, where: file, raw, kind };
  if (parseVersion(value)) return { pins: [{ ...at, version: value }], problems: [] };
  return { pins: [], problems: [{ ...at, message: `${posix.basename(file)} names "${raw}", not a version the floors check can read` }] };
}

/**
 * required_version in any .tf file, and runtime_version where the resource's
 * runtime_name is "node": a Python or .NET app's version is not this kind's.
 */
function readTerraform(root, file) {
  const out = empty();
  let runtimeName = null;
  linesOf(read(root, file)).forEach((l, i) => {
    const required = /^\s*required_version\s*=\s*"([^"]+)"/.exec(l);
    if (required) out.pins.push({ file, line: i + 1, where: `${file} > required_version`, kind: 'terraform', raw: required[1], constraint: required[1] });
    runtimeName = /^\s*runtime_name\s*=\s*"([^"]+)"/.exec(l)?.[1] ?? runtimeName;
    const runtime = runtimeName === 'node' && /^\s*runtime_version\s*=\s*"([^"]+)"/.exec(l);
    if (runtime) out.pins.push({ file, line: i + 1, where: `${file} > runtime_version`, kind: 'node', raw: runtime[1], version: runtime[1] });
  });
  return out;
}

/** Every `NAME = 'value'` or `NAME=value` line in a known file, as a Terraform pin of the given shape. */
function readAssignment(root, file, pattern, label, shape) {
  const out = empty();
  linesOf(read(root, file)).forEach((l, i) => {
    const m = pattern.exec(l);
    if (m) out.pins.push({ file, line: i + 1, where: `${file} > ${label}`, kind: 'terraform', raw: m[1], [shape]: m[1] });
  });
  return out;
}

const AVM = 'frontend/src/lib/landingZone/avmVersions.js';
const VERSIONS_ENV = 'lab-image/versions.env';
const DOCKERFILE = /^Dockerfile(\..+)?$|\.Dockerfile$/;

/** Which reader owns which tracked file. The first match wins. */
const FILE_READERS = [
  { owns: (file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file), read: (root, file) => readWorkflow(file, read(root, file)) },
  { owns: (file, base) => DOCKERFILE.test(base), read: (root, file, floors) => readDockerfile(file, read(root, file), floors) },
  { owns: (file) => file === JOB_IMAGES_FILE, read: (root, file, floors) => readJobImages(file, read(root, file), floors) },
  { owns: (file, base) => Object.hasOwn(VERSION_FILES, base), read: readVersionFile },
  { owns: (file, base) => base === 'package.json', read: readPackageJson },
  { owns: (file, base) => base === 'package-lock.json', read: readLockfile },
  { owns: (file) => file.endsWith('.tf'), read: readTerraform },
  {
    owns: (file) => file === AVM,
    read: (root, file) => readAssignment(root, file, /TERRAFORM_REQUIRED_VERSION\s*=\s*'([^']+)'/, 'TERRAFORM_REQUIRED_VERSION', 'constraint'),
  },
  {
    owns: (file) => file === VERSIONS_ENV,
    read: (root, file) => readAssignment(root, file, /^TERRAFORM_VERSION=(\S+)/, 'TERRAFORM_VERSION', 'version'),
  },
];

/** A walk of `root`, for a directory that is not a repository (a test fixture, a container copy). */
function walk(root, dir = '') {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => !['node_modules', '.git', '.terraform'].includes(entry.name))
    .flatMap((entry) => {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(root, rel) : [rel];
    });
}

/** `git ls-files`, or a walk of the directory when it is not a repository. */
export function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return walk(root);
  }
}

/**
 * Every pin in the tree, and every place a pin should be but cannot be read.
 * `files` defaults to `git ls-files`, so an untracked file never counts.
 */
export function collectPins(root, floors, files = trackedFiles(root)) {
  const results = files.flatMap((file) => {
    const reader = FILE_READERS.find((r) => r.owns(file, posix.basename(file)));
    return reader ? [reader.read(root, file, floors)] : [];
  });
  return merge([...results, readLabHost(root)]);
}

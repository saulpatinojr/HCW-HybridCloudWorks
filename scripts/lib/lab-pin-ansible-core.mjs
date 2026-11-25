/** ansible-core's newest release in its line, with every wheel's hash and its dependencies checked (see lab-pin-bumps.mjs). */
import { escapeRe, VERSIONS_ENV_PATH } from './lab-pin-constants.mjs';
import { replaceOne, setEnvValue } from './lab-pin-edits.mjs';
import { compareVersions, newest } from '../lab-pins-upstream.mjs';

// ── ansible-core (versions.env's ANSIBLE_CORE_* lines) ─────────────────────

export const PYPI = 'https://pypi.org/pypi';
export const STABLE_VERSION = /^\d+(\.\d+)+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const lineOf = (version) => String(version).split('.').slice(0, 2).join('.');

/** A project name as PEP 503 compares it: lower case, each run of `-`, `_` and `.` one `-`. */
export const normalizePyName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, '-');

/**
 * The ANSIBLE_CORE_DEPS lines of versions.env, each `name==version
 * --hash=sha256:<hex>`. A line in any other shape throws, so nothing is
 * planned from a block this does not understand.
 */
export function readAnsibleCoreDeps(envText) {
  const block = String(envText).match(/^ANSIBLE_CORE_DEPS='([^']*)'$/m);
  if (!block) throw new Error('versions.env has no ANSIBLE_CORE_DEPS block');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s=]+) --hash=sha256:([0-9a-f]{64})$/);
      if (!m) throw new Error(`ANSIBLE_CORE_DEPS has a line that is not name==version --hash=sha256:<hex>: ${line}`);
      return { line, name: m[1], version: m[2], sha256: m[3] };
    });
}

/**
 * A release's Requires-Dist from its PyPI JSON, keyed by normalised name: the
 * specifier (spaces removed) and the marker, as written. A requirement behind
 * an `extra` marker is left out, because nothing here installs an extra.
 */
export function requirementsOf(requiresDist) {
  const out = new Map();
  for (const entry of requiresDist ?? []) {
    const [requirement, marker = ''] = String(entry).split(';').map((part) => part.trim());
    if (/\bextra\s*==/.test(marker)) continue;
    const m = requirement.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*\(?([^)]*)\)?$/);
    if (!m) throw new Error(`cannot read the requirement ${JSON.stringify(entry)}`);
    out.set(normalizePyName(m[1]), { name: m[1], specifier: m[2].replace(/\s+/g, ''), marker });
  }
  return out;
}

/** Two requirement maps that say the same thing, whatever order PyPI listed them in. */
const sameRequirements = (a, b) => {
  const flat = (map) => JSON.stringify([...map].sort(([x], [y]) => x.localeCompare(y)));
  return flat(a) === flat(b);
};

/** The version a specifier pins exactly (`==1.2.3`); null for a range, a wildcard or no specifier. */
export function exactPin(specifier) {
  return String(specifier).match(/^===?([^,*<>=!~\s]+)$/)?.[1] ?? null;
}

/** A wheel file name's python, abi and platform tags: which interpreter and platform it is built for. */
export const wheelTags = (filename) => String(filename).replace(/\.whl$/, '').split('-').slice(-3).join('-');

/** A release's wheels from its PyPI JSON, yanked ones left out. */
const wheelsOf = (release) => (release?.urls ?? []).filter((f) => f.packagetype === 'bdist_wheel' && !f.yanked);

/** ansible-core's one pure-Python wheel for a release, with its SHA256; throws on anything else. */
function ansibleCoreWheel(release, version, url) {
  const wheels = wheelsOf(release);
  const expected = `ansible_core-${version}-py3-none-any.whl`;
  if (wheels.length !== 1 || wheels[0].filename !== expected) {
    throw new Error(`${url} lists ${wheels.map((w) => w.filename).join(', ') || 'no wheel'}, not the one wheel ${expected}`);
  }
  const sha256 = wheels[0].digests?.sha256;
  if (!SHA256_HEX.test(sha256 ?? '')) throw new Error(`${url}: ${expected} carries no SHA256`);
  return { filename: expected, sha256 };
}

export const envEditOf = (key, to) => ({ file: VERSIONS_ENV_PATH, where: key, to, apply: (t) => setEnvValue(t, key, to) });

/**
 * The edits and evidence that move ansible-core from `pinned` to `target`,
 * a newer release in the same line; throws, to become a note, on anything it
 * cannot verify.
 */
async function ansibleCoreBump({ text, pinned, pinnedSha, target, http }) {
  const nextUrl = `${PYPI}/ansible-core/${target}/json`;
  const currentUrl = `${PYPI}/ansible-core/${pinned}/json`;
  const next = await http.json(nextUrl);
  const current = await http.json(currentUrl);
  const nextWheel = ansibleCoreWheel(next, target, nextUrl);
  const currentWheel = ansibleCoreWheel(current, pinned, currentUrl);
  if (currentWheel.sha256 !== pinnedSha) {
    throw new Error(`ANSIBLE_CORE_SHA256 is not the SHA256 ${currentUrl} lists for ${currentWheel.filename} (${currentWheel.sha256}), so the pin being moved from is itself unverified`);
  }
  const requiresPython = [next.info?.requires_python || 'unset', current.info?.requires_python || 'unset'];
  if (requiresPython[0] !== requiresPython[1]) {
    throw new Error(`ansible-core ${target} declares Requires-Python ${requiresPython[0]}, where ${pinned} declared ${requiresPython[1]}; check it against BASE_PYTHON_VERSION and bootstrap.sh's PYTHON_VERSION by hand`);
  }

  const deps = readAnsibleCoreDeps(text);
  const moves = dependencyMoves({ deps, next, current, pinned, target });

  const edits = [envEditOf('ANSIBLE_CORE_VERSION', target), envEditOf('ANSIBLE_CORE_SHA256', nextWheel.sha256)];
  const evidence = [
    { item: `${nextWheel.filename} (SHA256)`, value: nextWheel.sha256, source: `${nextUrl}, \`digests.sha256\` of the release's one wheel` },
    {
      item: `ansible-core ${target}'s requirements`,
      value: (next.info?.requires_dist ?? []).join(', ') || 'none',
      source: `the same as ${pinned}'s (${currentUrl}) apart from any exact pin moved below, and Requires-Python ${requiresPython[0]} likewise`,
    },
  ];
  // Every pinned wheel read back from PyPI, one request each, so the pull
  // request carries the whole requirements file's provenance, not just the
  // line that moved.
  for (const dep of deps) {
    const found = await dependencyEvidence(dep, moves.get(normalizePyName(dep.name)), target, http);
    if (found.edit) edits.push(found.edit);
    evidence.push(found.evidence);
  }
  return { key: 'ansible-core', label: 'ansible-core (lab image and lab host)', from: pinned, to: target, edits, evidence };
}

/** A requirement as a reader writes it: `name>=1.2; marker`. */
const showRequirement = (req) => `${req.name}${req.specifier || ' (any version)'}${req.marker ? `; ${req.marker}` : ''}`;

/**
 * What the new release requires, against what the pinned one did. Only an
 * exact pin is followed; any other change leaves open whether the pinned
 * dependency still satisfies it, which is not evaluated here. Returns the
 * dependencies to move, as normalized name -> version; throws on anything else
 * that changed.
 */
function dependencyMoves({ deps, next, current, pinned, target }) {
  const byName = new Map(deps.map((dep) => [normalizePyName(dep.name), dep]));
  const wanted = requirementsOf(next.info?.requires_dist);
  const had = requirementsOf(current.info?.requires_dist);
  const moves = new Map();
  for (const [key, req] of wanted) {
    const dep = byName.get(key);
    if (!dep) throw new Error(`ansible-core ${target} requires ${showRequirement(req)}, which ANSIBLE_CORE_DEPS does not list`);
    const exact = exactPin(req.specifier);
    if (!exact) assertUnchanged(req, had.get(key), { dep, pinned, target });
    else if (exact !== dep.version) moves.set(key, exact);
  }
  const dropped = [...had].find(([key]) => !wanted.has(key));
  if (dropped) {
    throw new Error(`ansible-core ${target} no longer requires ${dropped[1].name}; ANSIBLE_CORE_DEPS still lists it, and which of its other lines go with it is not worked out here`);
  }
  return moves;
}

/** A requirement that is not an exact pin must be the same as the pinned release's, or nothing moves. */
function assertUnchanged(req, before, { dep, pinned, target }) {
  if (before && before.specifier === req.specifier && before.marker === req.marker) return;
  throw new Error(
    `ansible-core ${target} requires ${showRequirement(req)}, where ${pinned} required ${before ? showRequirement(before) : 'nothing of it'}; whether ${dep.name}==${dep.version} still satisfies that is not evaluated here`
  );
}

/**
 * One ANSIBLE_CORE_DEPS line read back from PyPI: its evidence, and when the
 * new ansible-core pins it to another version (`moveTo`), the edit that moves it.
 */
async function dependencyEvidence(dep, moveTo, target, http) {
  const url = `${PYPI}/${dep.name}/${dep.version}/json`;
  const release = await http.json(url);
  const pinnedWheel = wheelsOf(release).find((f) => f.digests?.sha256 === dep.sha256);
  if (!pinnedWheel) {
    throw new Error(`${url} lists no wheel of ${dep.name} ${dep.version} with the SHA256 ANSIBLE_CORE_DEPS pins (${dep.sha256.slice(0, 12)}…)`);
  }
  if (!moveTo) {
    return { evidence: { item: `${pinnedWheel.filename} (SHA256, unchanged)`, value: dep.sha256, source: url } };
  }
  const movedUrl = `${PYPI}/${dep.name}/${moveTo}/json`;
  const moved = await http.json(movedUrl);
  const tags = wheelTags(pinnedWheel.filename);
  const same = wheelsOf(moved).filter((f) => wheelTags(f.filename) === tags);
  if (same.length !== 1 || !SHA256_HEX.test(same[0].digests?.sha256 ?? '')) {
    throw new Error(`ansible-core ${target} pins ${dep.name}==${moveTo}, and ${movedUrl} lists ${same.length} wheels with a SHA256 for ${tags}, the tags of the pinned ${pinnedWheel.filename}`);
  }
  if (!sameRequirements(requirementsOf(release.info?.requires_dist), requirementsOf(moved.info?.requires_dist))) {
    throw new Error(`ansible-core ${target} pins ${dep.name}==${moveTo}, whose own requirements differ from ${dep.version}'s (${movedUrl}), so which other lines move with it is not worked out here`);
  }
  const line = `${dep.name}==${moveTo} --hash=sha256:${same[0].digests.sha256}`;
  return {
    edit: {
      file: VERSIONS_ENV_PATH,
      where: `ANSIBLE_CORE_DEPS ${dep.name}`,
      to: line,
      apply: (t) => replaceOne(t, new RegExp(`^(${escapeRe(dep.line)})$`, 'm'), line, `ANSIBLE_CORE_DEPS ${dep.name}`),
    },
    evidence: {
      item: `${same[0].filename} (SHA256; ansible-core ${target} pins ${dep.name}==${moveTo})`,
      value: same[0].digests.sha256,
      source: `${movedUrl}, the wheel for the same tags as the ${pinnedWheel.filename} it replaces`,
    },
  };
}

/**
 * ansible-core: the newest stable release in the pinned line, with its
 * wheel's SHA256 and every ANSIBLE_CORE_DEPS hash read back from PyPI's JSON
 * API for the version it pins. The image's fetch stage and lab-host/
 * bootstrap.sh both install these lines in --require-hashes mode, so a hash
 * PyPI does not serve would fail both; read back here, a mistyped or
 * replaced one never reaches a pull request.
 *
 * What moves: ANSIBLE_CORE_VERSION and ANSIBLE_CORE_SHA256, and a line of
 * ANSIBLE_CORE_DEPS only when the new release pins that dependency exactly,
 * to the wheel built for the same tags as the one pinned. What does not, and
 * is a note: a new release line (newest is PyPI's `info.version`, which is
 * never a pre-release while a stable release exists; a line is a decision,
 * not a bump), a release whose Requires-Python or any other requirement
 * differs from the pinned one's, and any hash PyPI does not serve.
 */
export async function planAnsibleCore(env, text, http) {
  const pinned = env.ANSIBLE_CORE_VERSION;
  const pinnedSha = env.ANSIBLE_CORE_SHA256;
  if (!STABLE_VERSION.test(pinned ?? '') || !SHA256_HEX.test(pinnedSha ?? '')) {
    throw new Error('versions.env has no ANSIBLE_CORE_VERSION and ANSIBLE_CORE_SHA256 to move from');
  }
  const projectUrl = `${PYPI}/ansible-core/json`;
  const project = await http.json(projectUrl);
  const latest = project.info?.version;
  if (!STABLE_VERSION.test(latest ?? '')) throw new Error(`${projectUrl} names ${latest ?? 'no release'} as the newest, which is not a stable release`);
  const notes = [];
  if (compareVersions(lineOf(latest), lineOf(pinned)) > 0) {
    notes.push({
      label: 'ansible-core release line',
      from: pinned,
      to: latest,
      reason: `ansible-core ${latest} starts the ${lineOf(latest)} line, which is moved by hand: check its controller and module-side Python ranges (lab-image/README.md, "Updating a version", and the comment in lab-host/bootstrap.sh), and move the \`ansible-lint (lab-host)\` and \`lab-host role tests\` jobs' pins in .github/workflows/ci.yml with it (the same line in both)`,
    });
  }
  // The pinned line's newest stable release with a wheel; `releases` is the
  // project JSON's map of every version to its files. `info.version` is one
  // of its keys, so it passes the same wheel and yank filter as every other
  // release rather than being added after it: a newest release with only a
  // yanked wheel, or only an sdist, would otherwise be the target, fail in
  // ansibleCoreBump and hide an older patch that is a valid bump (CodeRabbit,
  // #1189). PyPI lists `releases` among its JSON API's deprecated keys
  // (https://docs.pypi.org/api/json/), so a response without it is a note
  // rather than a quiet week with nothing to move.
  if (!project.releases || typeof project.releases !== 'object') {
    throw new Error(`${projectUrl} carries no releases map to choose a release in the ${lineOf(pinned)} line from`);
  }
  const inLine = Object.entries(project.releases)
    .filter(([version]) => STABLE_VERSION.test(version) && lineOf(version) === lineOf(pinned))
    .filter(([, files]) => (files ?? []).some((f) => f.packagetype === 'bdist_wheel' && !f.yanked))
    .map(([version]) => version);
  const target = newest(inLine);
  if (!target || compareVersions(target, pinned) <= 0) return { bump: null, notes };
  try {
    return { bump: await ansibleCoreBump({ text, pinned, pinnedSha, target, http }), notes };
  } catch (error) {
    return { bump: null, notes: [...notes, { label: 'ansible-core (lab image and lab host)', from: pinned, to: target, reason: error?.message || String(error) }] };
  }
}

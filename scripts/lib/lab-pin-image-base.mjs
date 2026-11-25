/** The image-base set: the lab image's base, the sandbox template's base and ansible-core (see lab-pin-bumps.mjs). */
import { DOCKER_GUIDE_PAGE_PATH, DOCKERFILE_PATH, README_PATH, SANDBOX_DOCKERFILE_PATH, VERSIONS_ENV_PATH } from './lab-pin-constants.mjs';
import { amd64EntryOf, imageEnv, parseImageRef, resolveTag } from './lab-pin-registry.mjs';
import { applyBumps, readEnv, replaceEvery, replaceFrom, replaceOne, setCheckedOn, setEnvValue } from './lab-pin-edits.mjs';
import { planAnsibleCore } from './lab-pin-ansible-core.mjs';
import { compareVersions } from './lab-pins-versions.mjs';

// ── Lab image base (versions.env and its FROM lines) ───────────────────────

/**
 * The base images' newest digests. BASE_IMAGE is a patch tag
 * (python:3.14.7-slim-trixie), which stops moving once the next patch ships,
 * so the line tag (python:3.14-slim-trixie) is what is read; the CPython it
 * carries comes from the image config's PYTHON_VERSION, and the patch tag for
 * that release must carry the same linux/amd64 image before the pin moves to
 * it. The two tags' indexes (an index is the list of per-platform images
 * behind one tag) are not compared whole: the line tag can list a platform
 * the build never uses, still on the previous CPython (riscv64 did, #1426),
 * and that is not a reason to wait. What is pinned is still the patch tag's
 * own index digest. A new minor line is a floors decision
 * (scripts/version-floors.json), not a rebuild, so the line stays put.
 * lab-image/README.md, "Updating a version", is this procedure by hand.
 */
const noAmd64 = (ref) => `no linux/amd64 image in ${ref}, the only platform the lab image is built for; nothing moves until there is one`;

/**
 * The sentence in lab-image/README.md that names the base: its tag and the
 * CPython release it carries, the same two values as BASE_IMAGE and
 * BASE_PYTHON_VERSION. The python base bump rewrites it the way the image-tools
 * bump rewrites the provider mirror sentence (README_MIRROR_RE, below).
 */
export const README_BASE_RE =
  /(Both targets are built on the official `[^`\s]+` image,\s+pinned by index digest: CPython \d+\.\d+\.\d+)(?=\s)/m;

export function renderReadmeBaseProse(versions) {
  return `Both targets are built on the official \`${versions.BASE_IMAGE}\` image,\npinned by index digest: CPython ${versions.BASE_PYTHON_VERSION}`;
}

/** The python base: the line tag's newest digest, its CPython, and the patch tag that must agree on linux/amd64. */
async function planPythonBase(env, http, today) {
  const base = parseImageRef(env.BASE_IMAGE);
  const tagParts = base?.tag?.match(/^(\d+)\.(\d+)\.(\d+)(-[a-z0-9.-]+)$/);
  if (!base || !tagParts) throw new Error('BASE_IMAGE is not a python:<x.y.z>-<variant> tag');
  const [, major, minor, , variant] = tagParts;
  const lineTag = `${major}.${minor}${variant}`;
  const line = await resolveTag(http, base.name, lineTag);
  // Checked before anything else, the "already pinned" return included: a
  // line tag with no linux/amd64 image is a note, never "current".
  const lineAmd64 = amd64EntryOf(line.manifest);
  if (!lineAmd64) throw new Error(noAmd64(`${base.name}:${lineTag}`));
  if (line.digest === env.BASE_DIGEST) return null;
  const pythonVersion = (await imageEnv(http, base.name, line.manifest))
    .find((e) => e.startsWith('PYTHON_VERSION='))
    ?.slice('PYTHON_VERSION='.length);
  if (!pythonVersion || !/^\d+\.\d+\.\d+$/.test(pythonVersion)) throw new Error(`${base.name}:${lineTag} sets no PYTHON_VERSION`);
  if (compareVersions(pythonVersion, env.BASE_PYTHON_VERSION) < 0) {
    throw new Error(`${base.name}:${lineTag} carries CPython ${pythonVersion}, older than the pinned ${env.BASE_PYTHON_VERSION}`);
  }
  const patchTag = `${pythonVersion}${variant}`;
  const patch = await resolveTag(http, base.name, patchTag);
  // Settled means both tags carry the same linux/amd64 image, the only one
  // the build pulls. Comparing the whole index would wait on platforms the
  // lab never runs. No amd64 entry is a note, not a guess.
  const patchAmd64 = amd64EntryOf(patch.manifest);
  if (!patchAmd64) throw new Error(noAmd64(`${base.name}:${patchTag}`));
  if (patchAmd64.digest !== lineAmd64.digest) {
    throw new Error(
      `${base.name}:${patchTag} is ${patch.digest} (linux/amd64 ${patchAmd64.digest}) but ${base.name}:${lineTag} is ${line.digest} (linux/amd64 ${lineAmd64.digest}); the two have not settled`
    );
  }
  // The pin is already this patch tag's index: nothing to move. Without this
  // the line tag's index differing only on another platform read as "behind".
  if (pythonVersion === env.BASE_PYTHON_VERSION && patch.digest === env.BASE_DIGEST) return null;
  const oldRef = `${env.BASE_IMAGE}@${env.BASE_DIGEST}`;
  const newImage = `${base.name}:${patchTag}`;
  const newRef = `${newImage}@${patch.digest}`;
  const readmeBase = renderReadmeBaseProse({ BASE_IMAGE: newImage, BASE_PYTHON_VERSION: pythonVersion });
  const envEdit = (key, to) => ({ file: VERSIONS_ENV_PATH, where: key, to, apply: (t) => setEnvValue(t, key, to) });
  return {
    key: 'base',
    label: `Lab image base (${base.name}:${lineTag})`,
    from: `${env.BASE_IMAGE}@${env.BASE_DIGEST.slice(0, 19)}`,
    to: `${newImage}@${patch.digest.slice(0, 19)}`,
    edits: [
      envEdit('BASE_IMAGE', newImage),
      envEdit('BASE_DIGEST', patch.digest),
      envEdit('BASE_PYTHON_VERSION', pythonVersion),
      { file: DOCKERFILE_PATH, where: 'every external FROM', to: newRef, apply: (t) => replaceFrom(t, oldRef, newRef) },
      // The guide page names the tag in its prose and its inspect command,
      // and the CPython release beside it; DockerGuides.test.jsx holds the
      // page to versions.env, so a bump without these failed `frontend` (#1123).
      {
        file: DOCKER_GUIDE_PAGE_PATH,
        where: 'the base tag, wherever the page names it',
        to: newImage,
        apply: (t) => replaceEvery(t, env.BASE_IMAGE, newImage, 'BuildingImagesPage base tag'),
      },
      {
        file: DOCKER_GUIDE_PAGE_PATH,
        where: 'the CPython release the page names',
        to: `CPython ${pythonVersion}`,
        apply: (t) => replaceEvery(t, `CPython ${env.BASE_PYTHON_VERSION}`, `CPython ${pythonVersion}`, 'BuildingImagesPage CPython'),
      },
      {
        file: DOCKER_GUIDE_PAGE_PATH,
        where: 'CHECKED_ON, the day the page was last read against the files',
        to: today.toISOString().slice(0, 10),
        apply: (t) => setCheckedOn(t, today),
      },
      // The lab image README names the same tag and CPython release in the
      // paragraph under its table of targets. Nothing moved it until #1604, so
      // a bump left it on the old base; a test in lab-pin-bumps.test.mjs holds
      // it to versions.env. `to` is the whole sentence, as `from` is, so a
      // digest-only move shows the two the same.
      {
        file: README_PATH,
        where: 'the base tag and CPython release the README names',
        to: readmeBase,
        apply: (t) => replaceOne(t, README_BASE_RE, readmeBase, 'README base sentence'),
      },
    ],
    evidence: [
      { item: `${base.name}:${lineTag} (index digest)`, value: line.digest, source: line.reads.join('; ') },
      { item: `${newImage} (index digest, the one pinned)`, value: patch.digest, source: patch.reads.join('; ') },
      {
        item: 'linux/amd64 image in both indexes (the same)',
        value: patchAmd64.digest,
        source: 'the linux/amd64 entry of each index above; the lab image is built for linux/amd64 only, so other platforms in the line tag are not compared',
      },
      {
        item: 'CPython in that image',
        value: pythonVersion,
        source:
          'PYTHON_VERSION in the linux/amd64 image config, each manifest and the config blob hashed against the digest that named it; smoke.sh checks it against BASE_PYTHON_VERSION',
      },
    ],
  };
}

/** The sandbox template's base: its tag's newest digest. */
async function planSandboxBase(env, http) {
  const sandbox = parseImageRef(env.SANDBOX_BASE_IMAGE);
  if (!sandbox?.tag) throw new Error('SANDBOX_BASE_IMAGE names no tag');
  const resolved = await resolveTag(http, sandbox.name, sandbox.tag);
  if (resolved.digest === env.SANDBOX_BASE_DIGEST) return null;
  const oldRef = `${env.SANDBOX_BASE_IMAGE}@${env.SANDBOX_BASE_DIGEST}`;
  const newRef = `${env.SANDBOX_BASE_IMAGE}@${resolved.digest}`;
  return {
    key: 'sandbox',
    label: `Sandbox template base (${env.SANDBOX_BASE_IMAGE})`,
    from: env.SANDBOX_BASE_DIGEST.slice(0, 19),
    to: resolved.digest.slice(0, 19),
    edits: [
      {
        file: VERSIONS_ENV_PATH,
        where: 'SANDBOX_BASE_DIGEST',
        to: resolved.digest,
        apply: (t) => setEnvValue(t, 'SANDBOX_BASE_DIGEST', resolved.digest),
      },
      { file: SANDBOX_DOCKERFILE_PATH, where: 'FROM', to: newRef, apply: (t) => replaceFrom(t, oldRef, newRef) },
    ],
    evidence: [{ item: `${env.SANDBOX_BASE_IMAGE} (index digest)`, value: resolved.digest, source: resolved.reads.join('; ') }],
  };
}

export async function planImageBase({ files, http, today = new Date() }) {
  const env = readEnv(files[VERSIONS_ENV_PATH]);
  const bumps = [];
  const notes = [];
  for (const [label, from, plan] of [
    [`Lab image base (${env.BASE_IMAGE})`, env.BASE_IMAGE, planPythonBase],
    [`Sandbox template base (${env.SANDBOX_BASE_IMAGE})`, env.SANDBOX_BASE_DIGEST, planSandboxBase],
  ]) {
    try {
      const bump = await plan(env, http, today);
      if (bump) bumps.push(bump);
    } catch (error) {
      notes.push({ label, from, to: '—', reason: error?.message || String(error) });
    }
  }
  try {
    const ansibleCore = await planAnsibleCore(env, files[VERSIONS_ENV_PATH], http);
    if (ansibleCore.bump) bumps.push(ansibleCore.bump);
    notes.push(...ansibleCore.notes);
  } catch (error) {
    notes.push({ label: 'ansible-core (lab image and lab host)', from: env.ANSIBLE_CORE_VERSION ?? '—', to: '—', reason: error?.message || String(error) });
  }
  const result = applyBumps(files, bumps);
  return { files: result.files, applied: result.applied, notes: [...notes, ...result.notes] };
}

/** The image-digests set: the two digests a publish from main just pushed, in capabilities.js and the Coder templates (see lab-pin-bumps.mjs). */
import { CAPABILITIES_PATH, CODER_TEMPLATE_PATHS, FULL_IMAGE, RUNNER_IMAGE } from './lab-pin-constants.mjs';
import { parseImageRef, readManifest } from './lab-pin-registry.mjs';
import { applyBumps, replaceOne } from './lab-pin-edits.mjs';

// ── The consumers' digests (capabilities.js, the Coder templates) ──────────

const RUNNER_PIN = /'(docker\.io\/hybridcloudworks\/hcw-lab-runner:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64})'/;
const TEMPLATE_TAG = /^[ \t]*image_tag[ \t]*=[ \t]*"([^"]+)"/m;
const TEMPLATE_DIGEST = /^[ \t]*image_digest[ \t]*=[ \t]*"(sha256:[0-9a-f]{64})"/m;

/**
 * Pin the two images a publish from main just pushed. The digests arrive from
 * the publish job (read back from Docker Hub there with imagetools); they are read
 * again here from the registry, by tag, and must agree, so a digest that was
 * mistyped or replaced in between never reaches a consumer.
 */
export async function planImageDigests({ files, http, runner, full }) {
  const bumps = [];
  const notes = [];
  const runnerRef = imageRefArgument('--runner', runner, RUNNER_IMAGE);
  const fullRef = imageRefArgument('--full', full, FULL_IMAGE);

  const currentRunner = parseImageRef(files[CAPABILITIES_PATH].match(RUNNER_PIN)?.[1])?.digest;
  // Each template that pins `hcw-lab` and is not on the published digest yet
  // (#1704): all of them move together, so none stays on an older build.
  const templatesBehind = CODER_TEMPLATE_PATHS.filter(
    (p) => files[p]?.match(TEMPLATE_DIGEST)?.[1] !== fullRef.digest
  );

  // What a line says the pin moves from. For the workspace image, the digest
  // of the first template that is behind, so a line or a note never reads
  // `x -> x` when only a guided lab moved (Copilot on #1710).
  const targets = [
    {
      key: 'runner',
      ref: runnerRef,
      label: 'hcw-lab-runner (vps-agent job image)',
      behind: currentRunner !== runnerRef.digest,
      from: currentRunner ?? '—',
      edits: (pinned) => [{ file: CAPABILITIES_PATH, where: 'IMAGES.hcwLabRunner', to: pinned, apply: (t) => replaceOne(t, RUNNER_PIN, pinned, 'IMAGES.hcwLabRunner') }],
    },
    {
      key: 'full',
      ref: fullRef,
      label: 'hcw-lab (Coder workspace images)',
      behind: templatesBehind.length > 0,
      from: files[templatesBehind[0]]?.match(TEMPLATE_DIGEST)?.[1] ?? '—',
      edits: () =>
        templatesBehind.flatMap((file) => [
          { file, where: 'local.image_tag', to: fullRef.tag, apply: (t) => replaceOne(t, TEMPLATE_TAG, fullRef.tag, 'image_tag') },
          { file, where: 'local.image_digest', to: fullRef.digest, apply: (t) => replaceOne(t, TEMPLATE_DIGEST, fullRef.digest, 'image_digest') },
        ]),
    },
  ];

  for (const target of targets.filter((t) => t.behind)) {
    try {
      bumps.push(await imageDigestBump(target, http));
    } catch (error) {
      notes.push({ label: target.label, from: target.from, to: target.ref.digest, reason: error?.message || String(error) });
    }
  }

  const result = applyBumps(files, bumps);
  return { files: result.files, applied: result.applied, notes: [...notes, ...result.notes] };
}

/** An image argument parsed, or an error saying the shape it must have. */
function imageRefArgument(flag, value, image) {
  const ref = parseImageRef(value);
  if (ref?.name !== image || !ref.tag || !ref.digest) {
    throw new Error(`${flag} must be ${image}:<tag>@sha256:<digest>, got ${value}`);
  }
  return ref;
}

/** One image's bump, after its digest is read again from Docker Hub by tag and found to agree. */
async function imageDigestBump({ key, ref, label, from, edits }, http) {
  const read = await readManifest(http, ref.name, ref.tag);
  if (read.digest !== ref.digest) throw new Error(`${ref.name}:${ref.tag} is ${read.digest} on Docker Hub, not the ${ref.digest} the publish job reported`);
  const pinned = `${ref.name}:${ref.tag}@${ref.digest}`;
  return {
    key,
    label,
    from: from.slice(0, 19),
    to: ref.digest.slice(0, 19),
    edits: edits(pinned),
    evidence: [
      {
        item: `${ref.name}:${ref.tag} (manifest digest)`,
        value: ref.digest,
        source: `the publish job's \`docker buildx imagetools inspect\` of the pushed tag, and ${read.url} read again here (bytes hashed, Docker-Content-Digest agreed); provenance attested to GHCR by that job`,
      },
    ],
  };
}

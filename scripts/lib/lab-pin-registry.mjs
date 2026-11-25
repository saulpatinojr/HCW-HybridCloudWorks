/** Reading container registries for the lab pin planners: a tag's digest, checked two ways (see lab-pin-bumps.mjs). */
import { sha256Hex, USER_AGENT } from './lab-pin-constants.mjs';
import { fetchRetrying, JSON_ACCEPT, parseJsonFrom } from './lab-pins-fetch.mjs';

// ── HTTP, memoised per run ─────────────────────────────────────────────────

/**
 * One fetcher per run. Each URL is read once even when two bumps need it (the
 * Docker Packages index serves four), so every bump in one pull request rests
 * on the same reading. A read that fails with a server error or a 406 is
 * tried again, unchanged, before it counts as failed (fetchRetrying in
 * lab-pins-fetch.mjs); `retry` is for the tests, which do not sleep.
 */
export function makeHttp(fetchImpl = fetch, { githubToken, retry } = {}) {
  const cache = new Map();
  function raw(url, headers = {}) {
    const auth = githubToken && url.startsWith('https://api.github.com/') ? { Authorization: `Bearer ${githubToken}` } : {};
    const all = { 'User-Agent': USER_AGENT, ...auth, ...headers };
    const key = `${url} ${JSON.stringify(all)}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          // The body is read inside the retry, so a connection dropped half
          // way through is tried again and its error names the address.
          return fetchRetrying(fetchImpl, url, { headers: all }, {
            ...retry,
            read: async (response) => ({ body: Buffer.from(await response.arrayBuffer()), headers: response.headers }),
          });
        })()
      );
    }
    return cache.get(key);
  }
  return {
    raw,
    text: async (url, headers) => (await raw(url, headers)).body.toString('utf8'),
    // JSON first, any type after it: lab-pins-upstream.mjs, JSON_ACCEPT, says why (#1677).
    json: async (url, headers) => parseJsonFrom(url, (await raw(url, { Accept: JSON_ACCEPT, ...headers })).body.toString('utf8')),
  };
}

// ── Container registries ───────────────────────────────────────────────────

export const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Where an image lives: GHCR for ghcr.io/…, Docker Hub otherwise (`library/` for
 * an official image). An explicit `docker.io/` is Docker Hub too, and is not
 * part of the repository name the registry API takes.
 */
export function registryOf(image) {
  if (image.startsWith('ghcr.io/')) {
    const repository = image.slice('ghcr.io/'.length);
    return {
      host: 'ghcr.io',
      repository,
      tokenUrl: `https://ghcr.io/token?scope=repository:${repository}:pull`,
      hubTags: null,
    };
  }
  const name = image.startsWith('docker.io/') ? image.slice('docker.io/'.length) : image;
  const repository = name.includes('/') ? name : `library/${name}`;
  return {
    host: 'registry-1.docker.io',
    repository,
    tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    hubTags: `https://hub.docker.com/v2/repositories/${repository}/tags/`,
  };
}

/** `name[:tag][@sha256:…]` → its parts; null when it is not one. */
export function parseImageRef(ref) {
  const m = String(ref ?? '').match(/^([a-z0-9][a-z0-9._/-]*?)(?::([A-Za-z0-9._-]+))?(?:@(sha256:[0-9a-f]{64}))?$/);
  return m ? { name: m[1], tag: m[2] ?? null, digest: m[3] ?? null } : null;
}

/**
 * A manifest by tag or digest, its bytes hashed here. The hash IS the digest
 * (content addressing), so a Docker-Content-Digest header that disagrees with
 * the bytes is refused rather than believed.
 */
export async function readManifest(http, image, reference) {
  const registry = registryOf(image);
  const { token } = await http.json(registry.tokenUrl);
  const url = `https://${registry.host}/v2/${registry.repository}/manifests/${reference}`;
  const { body, headers } = await http.raw(url, { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES });
  const digest = `sha256:${sha256Hex(body)}`;
  const header = headers.get('docker-content-digest');
  if (header && header !== digest) {
    throw new Error(`${url}: Docker-Content-Digest says ${header}, but the bytes served hash to ${digest}`);
  }
  return { digest, manifest: JSON.parse(body.toString('utf8')), url, token };
}

/**
 * A tag's digest, read twice where the publisher offers two readings: the
 * registry (above) and, for Docker Hub, the Hub API's record of the same tag.
 * They must agree; a tag re-pushed between the two reads fails here and is
 * tried again next week rather than half-believed.
 */
export async function resolveTag(http, image, tag) {
  const primary = await readManifest(http, image, tag);
  const reads = [`${primary.url} (manifest bytes hashed; Docker-Content-Digest agreed)`];
  const registry = registryOf(image);
  if (registry.hubTags) {
    const hubUrl = `${registry.hubTags}${encodeURIComponent(tag)}`;
    const hub = await http.json(hubUrl);
    if (hub.digest !== primary.digest) {
      throw new Error(`${image}:${tag}: the registry serves ${primary.digest}, but Docker Hub's API reports ${hub.digest}`);
    }
    reads.push(`${hubUrl} (Docker Hub API, same digest)`);
  }
  return { digest: primary.digest, manifest: primary.manifest, token: primary.token, reads };
}

/**
 * The linux/amd64 entry of an index, or null. The lab image is built for
 * linux/amd64 only (no `platforms:` in publish-lab-image.yml, and that
 * workflow refuses a `--platform` on any FROM), so this is the one image in a
 * base tag's index the build ever pulls.
 */
export function amd64EntryOf(index) {
  return (index?.manifests ?? []).find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64') ?? null;
}

/** The linux/amd64 image config's Env, from an index; every hop hashed against the digest that named it. */
export async function imageEnv(http, image, index) {
  const registry = registryOf(image);
  const entry = amd64EntryOf(index);
  if (!entry) throw new Error(`${image}: the index has no linux/amd64 manifest`);
  const manifest = await readManifest(http, image, entry.digest);
  if (manifest.digest !== entry.digest) throw new Error(`${image}: manifest ${entry.digest} hashed to ${manifest.digest}`);
  const configDigest = manifest.manifest.config?.digest;
  if (!configDigest) throw new Error(`${image}: the linux/amd64 manifest names no config`);
  const blob = await http.raw(`https://${registry.host}/v2/${registry.repository}/blobs/${configDigest}`, {
    Authorization: `Bearer ${manifest.token}`,
  });
  if (`sha256:${sha256Hex(blob.body)}` !== configDigest) throw new Error(`${image}: config blob does not hash to ${configDigest}`);
  return JSON.parse(blob.body.toString('utf8')).config?.Env ?? [];
}

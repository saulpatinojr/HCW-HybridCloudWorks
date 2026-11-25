/** Comparing release versions, and reading the pins from group_vars (lab-pins-upstream.mjs). */

// ── Version arithmetic ─────────────────────────────────────────────────────

/** `5:29.8.1-1~ubuntu.26.04~resolute` → `29.8.1`; `v2.11.4` → `2.11.4`; `18.6` → `18.6`. */
export function coreVersion(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/(\d+(?:\.\d+)+)/);
  return m ? m[1] : null;
}

/** Numeric, segment-wise comparison of dotted versions. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Newest of a list of version strings, by compareVersions; null when empty. */
export function newest(versions) {
  return versions.reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

const STABLE = /^\d+(\.\d+)+$/;
export const isStable = (v) => STABLE.test(v);

// ── Reading the pins ───────────────────────────────────────────────────────

/** The scalar value of `key: value` on its own line, quotes stripped; null when absent. */
export function scalar(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, 'm'));
  return m ? m[1].trim() : null;
}

/** The pins this script watches, read from group_vars/all.yml. */
export function readPins(text) {
  // docker_release_pins is nested: take the resolute (26.04) block's values.
  const resolute = text.match(/^docker_release_pins:\s*\n\s+resolute:\s*\n([\s\S]*?)\n\s+noble:/m)?.[1] ?? '';
  return {
    dockerEngine: coreVersion(scalar(resolute, 'engine')),
    containerd: coreVersion(scalar(resolute, 'containerd')),
    dockerBuildx: coreVersion(scalar(resolute, 'buildx')),
    dockerCompose: coreVersion(scalar(resolute, 'compose')),
    caddy: coreVersion(scalar(text, 'caddy_version')),
    caddyCloudflare: coreVersion(scalar(text, 'caddy_cloudflare_module_version')),
    coder: coreVersion(scalar(text, 'coder_image_tag')),
    postgres: coreVersion(scalar(text, 'coder_postgres_image_tag')),
    portainer: coreVersion(scalar(text, 'portainer_image_tag')),
    vault: coreVersion(scalar(text, 'vault_version')),
    nodeExporter: coreVersion(scalar(text, 'node_exporter_version')),
    node: coreVersion(scalar(text, 'labs_agent_node_version')),
    cosign: coreVersion(scalar(text, 'cosign_version')),
  };
}

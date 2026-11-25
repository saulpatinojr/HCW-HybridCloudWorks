/** The image-tools set: the tools baked into the lab images and the Terraform providers in their mirror (see lab-pin-bumps.mjs). */
import { README_PATH, VERSIONS_ENV_PATH } from './lab-pin-constants.mjs';
import { sumsLine } from './lab-pin-indexes.mjs';
import { applyBumps, readEnv, replaceOne } from './lab-pin-edits.mjs';
import { envEditOf, lineOf, STABLE_VERSION } from './lab-pin-ansible-core.mjs';
import { compareVersions, coreVersion, newest } from './lab-pins-versions.mjs';
import { newestAptVersion, newestGitHubRelease, newestHashicorp } from './lab-pins-fetch.mjs';

// ── Lab image tools, providers and Azure CLI (image-tools) ────────────────

export const PROVIDER_SPECS = Object.freeze({
  azurerm: {
    namespace: 'hashicorp',
    name: 'azurerm',
    line: '5',
    versionKey: 'PROVIDER_AZURERM_VERSION',
    shaKey: 'PROVIDER_AZURERM_SHA256',
    label: 'azurerm provider (5.x line)',
  },
  azurermV4: {
    namespace: 'hashicorp',
    name: 'azurerm',
    line: '4',
    versionKey: 'PROVIDER_AZURERM_V4_VERSION',
    shaKey: 'PROVIDER_AZURERM_V4_SHA256',
    label: 'azurerm provider (4.x line)',
  },
  azapi: {
    namespace: 'azure',
    name: 'azapi',
    versionKey: 'PROVIDER_AZAPI_VERSION',
    shaKey: 'PROVIDER_AZAPI_SHA256',
    label: 'azapi provider',
  },
  alz: {
    namespace: 'azure',
    name: 'alz',
    versionKey: 'PROVIDER_ALZ_VERSION',
    shaKey: 'PROVIDER_ALZ_SHA256',
    label: 'alz provider',
  },
  random: {
    namespace: 'hashicorp',
    name: 'random',
    versionKey: 'PROVIDER_RANDOM_VERSION',
    shaKey: 'PROVIDER_RANDOM_SHA256',
    label: 'random provider',
  },
  modtm: {
    namespace: 'azure',
    name: 'modtm',
    versionKey: 'PROVIDER_MODTM_VERSION',
    shaKey: 'PROVIDER_MODTM_SHA256',
    label: 'modtm provider',
  },
  time: {
    namespace: 'hashicorp',
    name: 'time',
    versionKey: 'PROVIDER_TIME_VERSION',
    shaKey: 'PROVIDER_TIME_SHA256',
    label: 'time provider',
  },
});

export const README_MIRROR_RE =
  /(The mirror holds azurerm [^\s]+ and [^\s]+, azapi [^\s]+, alz\s+[^\s]+, random [^\s]+, modtm [^\s]+ and time [^\s]+, each zip verified after)/m;

export function renderReadmeMirrorProse(versions) {
  return `The mirror holds azurerm ${versions.PROVIDER_AZURERM_VERSION} and ${versions.PROVIDER_AZURERM_V4_VERSION}, azapi ${versions.PROVIDER_AZAPI_VERSION}, alz\n  ${versions.PROVIDER_ALZ_VERSION}, random ${versions.PROVIDER_RANDOM_VERSION}, modtm ${versions.PROVIDER_MODTM_VERSION} and time ${versions.PROVIDER_TIME_VERSION}, each zip verified after`;
}

/** The note a tool gets when its bump could not be verified: what was pinned and why it did not move. */
const toolNote = (label, from, error) => ({ label, from: from ?? '—', to: '—', reason: error?.message || String(error) });

/**
 * The tools whose release index, checksum file and versions.env keys share one
 * shape: the newest release from an index, and its SHA256 from a checksums file.
 */
const CHECKSUMMED_TOOLS = [
  {
    key: 'terraform',
    note: 'Terraform',
    label: 'Terraform (runner target)',
    versionKey: 'TERRAFORM_VERSION',
    shaKey: 'TERRAFORM_SHA256',
    indexUrl: 'https://releases.hashicorp.com/terraform/index.json',
    newestOf: (index) => newestHashicorp(index),
    sumsUrl: (target) => `https://releases.hashicorp.com/terraform/${target}/terraform_${target}_SHA256SUMS`,
    file: (target) => `terraform_${target}_linux_amd64.zip`,
  },
  {
    key: 'kubeconform',
    note: 'kubeconform',
    label: 'kubeconform (runner target)',
    versionKey: 'KUBECONFORM_VERSION',
    shaKey: 'KUBECONFORM_SHA256',
    indexUrl: 'https://api.github.com/repos/yannh/kubeconform/releases?per_page=30',
    newestOf: (index) => newestGitHubRelease(index),
    sumsUrl: (target) => `https://github.com/yannh/kubeconform/releases/download/v${target}/CHECKSUMS`,
    file: () => 'kubeconform-linux-amd64.tar.gz',
  },
  {
    key: 'helm',
    note: 'Helm',
    label: 'Helm (runner target)',
    versionKey: 'HELM_VERSION',
    shaKey: 'HELM_SHA256',
    indexUrl: 'https://api.github.com/repos/helm/helm/releases?per_page=30',
    newestOf: (index) => newestGitHubRelease(index),
    sumsUrl: (target) => `https://get.helm.sh/helm-v${target}-linux-amd64.tar.gz.sha256sum`,
    file: (target) => `helm-v${target}-linux-amd64.tar.gz`,
  },
];

/** One CHECKSUMMED_TOOLS entry's bump, or null when the pin is already the newest. */
async function checksummedToolBump(tool, env, http) {
  const target = tool.newestOf(await http.json(tool.indexUrl));
  const pinned = env[tool.versionKey];
  if (!target || compareVersions(target, pinned) <= 0) return null;
  const sumsUrl = tool.sumsUrl(target);
  const file = tool.file(target);
  const hex = sumsLine(await http.text(sumsUrl), file);
  if (!hex) throw new Error(`${sumsUrl} has no line for ${file}`);
  return {
    key: tool.key,
    label: tool.label,
    from: pinned,
    to: target,
    edits: [envEditOf(tool.versionKey, target), envEditOf(tool.shaKey, hex)],
    evidence: [{ item: `${file} (SHA256)`, value: hex, source: sumsUrl }],
  };
}

/**
 * kubectl. A patch release of the pinned Kubernetes line is a bump. A
 * newer line is a note: the schemas kubeconform checks against
 * (KUBERNETES_JSON_SCHEMA_*) are a commit and a tree hash that no publisher
 * serves a checksum for, so a bot cannot move them with kubectl, and the
 * line is moved by hand with a test holding the two on one line (#1323). The
 * patch comes from the pinned line's own pointer, so a newer line does not
 * hide a patch release of the line in use. A newer line's note goes onto
 * `notes`; the bump, if any, is returned.
 */
async function kubectlBump(env, http, notes) {
  const pinned = env.KUBECTL_VERSION;
  if (!STABLE_VERSION.test(pinned ?? '')) throw new Error('versions.env has no KUBECTL_VERSION to move from');
  const line = lineOf(pinned);
  const newest = coreVersion((await http.text('https://dl.k8s.io/release/stable.txt')).trim());
  if (newest && compareVersions(lineOf(newest), line) > 0) {
    notes.push({
      label: 'Kubernetes release line',
      from: pinned,
      to: newest,
      reason: `Kubernetes ${newest} starts the ${lineOf(newest)} line, so kubectl stays on ${line} until the line is moved by hand. Move KUBECTL_VERSION, KUBECTL_SHA256 and the three KUBERNETES_JSON_SCHEMA_ lines in one pull request (lab-image/README.md, "Kubernetes schemas"); a test fails when they sit on different lines`,
    });
  }
  const lineUrl = `https://dl.k8s.io/release/stable-${line}.txt`;
  const target = coreVersion((await http.text(lineUrl)).trim());
  if (target && lineOf(target) !== line) throw new Error(`${lineUrl} names ${target}, which is not on the ${line} line`);
  if (!target || compareVersions(target, pinned) <= 0) return null;
  const sumsUrl = `https://dl.k8s.io/release/v${target}/bin/linux/amd64/kubectl.sha256`;
  const hex = (await http.text(sumsUrl)).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${sumsUrl} served invalid SHA256: ${hex}`);
  return {
    key: 'kubectl',
    label: 'kubectl (full target)',
    from: pinned,
    to: target,
    edits: [envEditOf('KUBECTL_VERSION', target), envEditOf('KUBECTL_SHA256', hex)],
    evidence: [{ item: `kubectl v${target} (SHA256)`, value: hex, source: sumsUrl }],
  };
}

/** Azure CLI: the older of the newest releases in the two apt suites, so it is published in both. */
async function azureCliBump(env, http) {
  const bookwormUrl = 'https://packages.microsoft.com/repos/azure-cli/dists/bookworm/main/binary-amd64/Packages';
  const resoluteUrl = 'https://packages.microsoft.com/repos/azure-cli/dists/resolute/main/binary-amd64/Packages';
  const [bookworm, resolute] = await Promise.all([http.text(bookwormUrl), http.text(resoluteUrl)]);
  const vBookworm = newestAptVersion(bookworm, 'azure-cli');
  const vResolute = newestAptVersion(resolute, 'azure-cli');
  const target = vBookworm && vResolute && compareVersions(vBookworm, vResolute) <= 0 ? vBookworm : vResolute;
  const pinned = env.AZURE_CLI_VERSION;
  if (!target || compareVersions(target, pinned) <= 0) return null;
  return {
    key: 'azure-cli',
    label: 'Azure CLI (full target & sandbox)',
    from: pinned,
    to: target,
    edits: [envEditOf('AZURE_CLI_VERSION', target)],
    evidence: [
      {
        item: `azure-cli ${target} (Debian bookworm & Ubuntu resolute)`,
        value: target,
        source: `${bookwormUrl} and ${resoluteUrl}; verified published in both suites`,
      },
    ],
  };
}

/** One Terraform provider's bump from the registry, or null when the pin is already the newest. */
async function providerBump(key, spec, pinned, http) {
  const versionsUrl = `https://registry.terraform.io/v1/providers/${spec.namespace}/${spec.name}/versions`;
  const index = await http.json(versionsUrl);
  const candidates = (index.versions ?? [])
    .map((v) => coreVersion(v.version))
    .filter((v) => v && (!spec.line || v.startsWith(`${spec.line}.`)));
  const target = newest(candidates);
  if (!target || compareVersions(target, pinned) <= 0) return null;
  const dlUrl = `https://registry.terraform.io/v1/providers/${spec.namespace}/${spec.name}/${target}/download/linux/amd64`;
  const dl = await http.json(dlUrl);
  const hex = dl.shasum;
  if (!/^[0-9a-f]{64}$/.test(hex ?? '')) throw new Error(`${dlUrl} gave invalid shasum: ${hex}`);
  return {
    key,
    label: spec.label,
    from: pinned,
    to: target,
    edits: [envEditOf(spec.versionKey, target), envEditOf(spec.shaKey, hex)],
    evidence: [{ item: `${spec.name} v${target} (linux_amd64 SHA256)`, value: hex, source: dlUrl }],
  };
}

/**
 * Every Terraform provider's bump, with the README's mirror sentence moved in
 * the first one when any provider moved and the README was read.
 */
async function providerBumps(env, files, http, notes) {
  const nextVersions = { ...env };
  const bumps = [];
  for (const [key, spec] of Object.entries(PROVIDER_SPECS)) {
    const pinned = env[spec.versionKey];
    try {
      const bump = await providerBump(key, spec, pinned, http);
      if (!bump) continue;
      nextVersions[spec.versionKey] = bump.to;
      nextVersions[spec.shaKey] = bump.edits[1].to;
      bumps.push(bump);
    } catch (error) {
      notes.push(toolNote(spec.label, pinned, error));
    }
  }

  // If any provider moved and README_PATH was read, update the prose in README_PATH
  if (bumps.length > 0 && files[README_PATH]) {
    const prose = renderReadmeMirrorProse(nextVersions);
    bumps[0].edits.push({
      file: README_PATH,
      where: 'provider filesystem mirror prose',
      to: prose,
      apply: (t) => replaceOne(t, README_MIRROR_RE, prose, 'provider mirror prose'),
    });
  }
  return bumps;
}

export async function planImageTools({ files, http }) {
  const env = readEnv(files[VERSIONS_ENV_PATH]);
  const bumps = [];
  const notes = [];
  // Each step's bump, or its note when it throws; the steps run one after another, in this order.
  const steps = [
    ...CHECKSUMMED_TOOLS.map((tool) => [tool.note, tool.versionKey, () => checksummedToolBump(tool, env, http)]),
    ['kubectl', 'KUBECTL_VERSION', () => kubectlBump(env, http, notes)],
    ['Azure CLI', 'AZURE_CLI_VERSION', () => azureCliBump(env, http)],
  ];
  for (const [label, versionKey, run] of steps) {
    try {
      const bump = await run();
      if (bump) bumps.push(bump);
    } catch (error) {
      notes.push(toolNote(label, env[versionKey], error));
    }
  }

  bumps.push(...(await providerBumps(env, files, http, notes)));
  const result = applyBumps(files, bumps);
  return { files: result.files, applied: result.applied, notes: [...notes, ...result.notes] };
}

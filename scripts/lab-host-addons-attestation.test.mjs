/**
 * lab-host-addons-attestation.test.mjs — add-on image attestation verification (#1069)
 *
 * Add-on container images are pulled by digest, but the digest is an integrity
 * pin, not publisher authentication. Each add-on attaches SLSA build provenance
 * (actions/attest-build-provenance) signed through Sigstore with a GitHub Actions
 * OIDC token.
 *
 * Before docker_image_pull, the addons role verifies this provenance using cosign
 * against Sigstore's public trust root and the expected workflow identity:
 *   - OIDC issuer: https://token.actions.githubusercontent.com
 *   - Type: slsaprovenance1 (SLSA Provenance v1)
 *   - Identity pattern: ^https://github\.com/<repo>/\.github/workflows/publish-images\.yml@refs/tags/
 *
 * If the identity does not match or Sigstore cannot be reached, the deploy
 * fails closed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const GROUP_VARS = read('lab-host/ansible/group_vars/all.yml');
const ADDONS_TASKS = read('lab-host/ansible/roles/addons/tasks/main.yml');
const ADDONS_DEFAULTS = read('lab-host/ansible/roles/addons/defaults/main.yml');
const ADDONS_SPECS = read('lab-host/ansible/roles/addons/meta/argument_specs.yml');
const BOOTSTRAP = read('lab-host/bootstrap.sh');

describe('group_vars/all.yml add-on attestation configuration', () => {
  it('pins cosign_version and cosign_checksum', () => {
    expect(GROUP_VARS).toMatch(/^cosign_version:\s*"?\d+\.\d+\.\d+"?$/m);
    expect(GROUP_VARS).toMatch(/^cosign_checksum:\s*sha256:[0-9a-f]{64}$/m);
  });

  it('declares an attestation_identity_regexp for every deployed add-on row', () => {
    // Extract each add-on stanza under addons:
    const addonsBlock = GROUP_VARS.match(/addons:\n([\s\S]*?)(?=\n[a-z_]+:|\n*$)/)?.[1] ?? '';
    const stanzas = addonsBlock.split(/\n\s{2}- id:\s*/).filter(Boolean);
    expect(stanzas.length).toBeGreaterThan(0);

    for (const stanza of stanzas) {
      const idMatch = stanza.match(/^([a-z0-9-]+)/);
      const id = idMatch ? idMatch[1] : 'unknown';
      const isDeployed = /image_digest:\s*"sha256:[0-9a-f]{64}"/.test(stanza);
      if (isDeployed) {
        expect(stanza, `add-on ${id} must specify attestation_identity_regexp`).toMatch(
          /attestation_identity_regexp:\s*['"][^'"]+['"]/
        );
      }
    }
  });

  it('validates each add-on attestation identity against expected workflow signatures', () => {
    const expected = {
      migration: {
        repo: 'saulpatinojr/HCW-AzMigrateOrchestrator_Addon',
        // The repository is being renamed; images built before and after carry different names in their attestation.
        alsoAccepts: ['saulpatinojr/HCW-MigrateOrchestrator_AddOn'],
        tag: 'v0.3.1',
      },
      'network-assessment': {
        repo: 'saulpatinojr/HCW-NetworkEyes_AddOn',
        tag: 'v0.1.0',
      },
      'cloud-assessment': {
        repo: 'saulpatinojr/HCW-CloudAssessor_AddOn',
        tag: 'v0.1.0',
      },
    };

    for (const [id, spec] of Object.entries(expected)) {
      const patternMatch = GROUP_VARS.match(
        new RegExp(`id:\\s*${id}[\\s\\S]*?attestation_identity_regexp:\\s*['"]([^'"]+)['"]`)
      );
      expect(patternMatch, `attestation_identity_regexp for ${id} not found`).toBeTruthy();
      const regex = new RegExp(patternMatch[1]);

      const legitimateIdentity = `https://github.com/${spec.repo}/.github/workflows/publish-images.yml@refs/tags/${spec.tag}`;
      expect(regex.test(legitimateIdentity), `regex for ${id} must match ${legitimateIdentity}`).toBe(true);

      // A renamed repository is accepted only under the names listed for it, and only for the same workflow and tag refs.
      for (const other of spec.alsoAccepts ?? []) {
        const renamed = `https://github.com/${other}/.github/workflows/publish-images.yml@refs/tags/${spec.tag}`;
        expect(regex.test(renamed), `regex for ${id} must match ${renamed}`).toBe(true);
        const renamedBranch = `https://github.com/${other}/.github/workflows/publish-images.yml@refs/heads/main`;
        expect(regex.test(renamedBranch), `regex for ${id} must reject branch refs under ${other}`).toBe(false);
        const lookalike = `https://github.com/${other}-fork/.github/workflows/publish-images.yml@refs/tags/${spec.tag}`;
        expect(regex.test(lookalike), `regex for ${id} must reject a lookalike of ${other}`).toBe(false);
      }

      // Rejects non-tag refs (e.g. branch push)
      const branchIdentity = `https://github.com/${spec.repo}/.github/workflows/publish-images.yml@refs/heads/main`;
      expect(regex.test(branchIdentity), `regex for ${id} must reject branch refs`).toBe(false);

      // Rejects wrong workflow
      const wrongWorkflow = `https://github.com/${spec.repo}/.github/workflows/ci.yml@refs/tags/${spec.tag}`;
      expect(regex.test(wrongWorkflow), `regex for ${id} must reject wrong workflow`).toBe(false);

      // Rejects wrong repository
      const wrongRepo = `https://github.com/attacker/${spec.repo.split('/')[1]}/.github/workflows/publish-images.yml@refs/tags/${spec.tag}`;
      expect(regex.test(wrongRepo), `regex for ${id} must reject foreign repo`).toBe(false);
    }
  });
});

describe('addons role tasks and specs', () => {
  it('asserts that each deployed add-on carries an attestation identity pattern', () => {
    expect(ADDONS_TASKS).toContain('Refuse to deploy an add-on without an attestation identity pattern');
    expect(ADDONS_TASKS).toContain('item.attestation_identity_regexp | default(\'\') | length > 0');
  });

  it('downloads cosign and verifies SLSA provenance before docker_image_pull', () => {
    const downloadIdx = ADDONS_TASKS.indexOf('Download the pinned cosign binary and verify its checksum');
    const verifyIdx = ADDONS_TASKS.indexOf('Verify build provenance attestation before pull for each deployed add-on image');
    const pullIdx = ADDONS_TASKS.indexOf('Pull each deployed add-on image by digest');

    expect(downloadIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(downloadIdx);
    expect(pullIdx).toBeGreaterThan(verifyIdx);

    expect(ADDONS_TASKS).toContain('verify-attestation');
    expect(ADDONS_TASKS).toContain('--type');
    expect(ADDONS_TASKS).toContain('{{ addons_attestation_type }}');
    expect(ADDONS_TASKS).toContain('--certificate-oidc-issuer');
    expect(ADDONS_TASKS).toContain('{{ addons_attestation_oidc_issuer }}');
    expect(ADDONS_TASKS).toContain('--certificate-identity-regexp');
    expect(ADDONS_TASKS).toContain('{{ item.attestation_identity_regexp }}');
  });

  it('declares role defaults for cosign and attestation verification', () => {
    expect(ADDONS_DEFAULTS).toMatch(/^addons_cosign_bin:\s*\/usr\/local\/bin\/cosign$/m);
    expect(ADDONS_DEFAULTS).toMatch(/^addons_attestation_type:\s*slsaprovenance1$/m);
    expect(ADDONS_DEFAULTS).toMatch(/^addons_attestation_oidc_issuer:\s*https:\/\/token\.actions\.githubusercontent\.com$/m);
  });

  it('documents attestation properties in argument_specs.yml', () => {
    expect(ADDONS_SPECS).toContain('attestation_identity_regexp:');
    expect(ADDONS_SPECS).toContain('addons_cosign_bin:');
    expect(ADDONS_SPECS).toContain('addons_attestation_type:');
    expect(ADDONS_SPECS).toContain('addons_attestation_oidc_issuer:');
  });
});

describe('bootstrap.sh cosign installation', () => {
  it('pins COSIGN_VERSION and COSIGN_SHA256 at the top', () => {
    expect(BOOTSTRAP).toMatch(/^COSIGN_VERSION=\d+\.\d+\.\d+$/m);
    expect(BOOTSTRAP).toMatch(/^COSIGN_SHA256=[0-9a-f]{64}$/m);
    expect(BOOTSTRAP).toMatch(/^COSIGN_BIN=\/usr\/local\/bin\/cosign$/m);
  });

  it('installs cosign SHA256-verified from GitHub releases', () => {
    expect(BOOTSTRAP).toContain('installing cosign ${COSIGN_VERSION} from its GitHub release, SHA256-verified');
    expect(BOOTSTRAP).toContain('https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/');
    expect(BOOTSTRAP).toContain('refusing to install cosign: ${cosign_binary} does not match COSIGN_SHA256');
    expect(BOOTSTRAP).toContain('install -m 0755 -o root -g root "${cosign_tmp}/${cosign_binary}" "${COSIGN_BIN}"');
  });
});

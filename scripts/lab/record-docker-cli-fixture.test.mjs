/**
 * The pure parts of record-docker-cli-fixture.mjs: which engine version the
 * host pins, and which CLI the fixture records. The download, the hash check
 * and the capture run are exercised by lab-supply-chain.yml on the runner.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCKER_APT_KEY_URL,
  dockerAptKeyChecksum,
  inReleaseVerifier,
  pinnedEngine,
  recordedCli,
} from './record-docker-cli-fixture.mjs';
import { DOCKER_CLI_FIXTURE_PATH, GROUP_VARS_PATH } from '../lib/lab-pin-bumps.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const real = (path) => readFileSync(join(REPO, path), 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

describe('record-docker-cli-fixture', () => {
  const slice = [
    'docker_release_pins:',
    '  resolute:',
    '    containerd: "2.3.6-1"',
    '    engine: "5:29.9.0-1~ubuntu.26.04~resolute"',
    '  noble:',
    '    engine: "5:29.9.0-1~ubuntu.24.04~noble"',
    '',
  ].join('\n');

  it("reads a codename's engine pin, wherever it sits under the codename, and its upstream core", () => {
    expect(pinnedEngine(slice)).toEqual({ version: '5:29.9.0-1~ubuntu.26.04~resolute', core: '29.9.0' });
    expect(pinnedEngine(slice, 'noble')).toEqual({ version: '5:29.9.0-1~ubuntu.24.04~noble', core: '29.9.0' });
    expect(() => pinnedEngine(slice, 'jammy')).toThrow(/docker_release_pins\.jammy\.engine not found/);
    expect(() => pinnedEngine(slice, 'resolute:\n    engine: "x"|.*')).toThrow(/is not a release codename/);
    expect(() => pinnedEngine(slice, 'Resolute')).toThrow(/is not a release codename/);
    expect(() => pinnedEngine('docker_release_pins:\n  resolute:\n    engine: "latest"\n')).toThrow(
      /not an epoch:upstream-revision/
    );
  });

  it('reads the CLI a fixture records, and null for anything else', () => {
    expect(recordedCli('{"dockerCli":"29.9.0"}')).toBe('29.9.0');
    expect(recordedCli('{"other":1}')).toBeNull();
    expect(recordedCli('not json')).toBeNull();
  });

  it('reads the checksum group_vars pins the Docker signing key to, and refuses a file without one', () => {
    expect(dockerAptKeyChecksum(`x: 1\ndocker_apt_key_checksum: sha256:${'b'.repeat(64)}\n`)).toBe('b'.repeat(64));
    expect(() => dockerAptKeyChecksum('x: 1\n')).toThrow(/docker_apt_key_checksum not found/);
    expect(DOCKER_APT_KEY_URL).toBe('https://download.docker.com/linux/ubuntu/gpg');
  });

  it('verifies the InRelease signature with the pinned key, and refuses a key that does not hash to the pin', async () => {
    const key = Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----\nfake\n-----END PGP PUBLIC KEY BLOCK-----\n');
    const http = { raw: vi.fn(async (url) => ({ body: url === DOCKER_APT_KEY_URL ? key : Buffer.alloc(0) })) };
    const workDir = mkdtempSync(join(os.tmpdir(), 'record-test-'));
    try {
      const run = vi.fn();
      const verify = await inReleaseVerifier({ http, keyChecksum: sha256(key), workDir, run });
      expect(run.mock.calls[0][0]).toBe('gpg');
      expect(run.mock.calls[0][1]).toEqual(['--batch', '--yes', '--dearmor', '-o', join(workDir, 'docker.gpg'), join(workDir, 'docker.asc')]);
      expect(readFileSync(join(workDir, 'docker.asc'))).toEqual(key);

      verify('Origin: Docker\n', 'https://download.docker.com/linux/ubuntu/dists/resolute/InRelease');
      expect(run.mock.calls[1][0]).toBe('gpgv');
      expect(run.mock.calls[1][1]).toEqual(['--keyring', join(workDir, 'docker.gpg'), join(workDir, 'InRelease')]);
      expect(readFileSync(join(workDir, 'InRelease'), 'utf8')).toBe('Origin: Docker\n');

      const refusing = vi.fn((cmd) => {
        if (cmd === 'gpgv') throw new Error('BAD signature');
      });
      const strict = await inReleaseVerifier({ http, keyChecksum: sha256(key), workDir, run: refusing });
      expect(() => strict('tampered', 'https://example/InRelease')).toThrow(
        /https:\/\/example\/InRelease: signature not verified by the pinned Docker key \(BAD signature\)/
      );

      await expect(inReleaseVerifier({ http, keyChecksum: 'c'.repeat(64), workDir, run })).rejects.toThrow(
        /hashes to [0-9a-f]{64}, not the pinned c{64}/
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('the live pin, the live key checksum and the live fixture are all readable, in the shapes the script expects', () => {
    const groupVars = real(GROUP_VARS_PATH);
    const { version, core } = pinnedEngine(groupVars);
    expect(version).toMatch(/^5:\d+\.\d+\.\d+-1~ubuntu\.26\.04~resolute$/);
    expect(core).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerAptKeyChecksum(groupVars)).toMatch(/^[0-9a-f]{64}$/);
    expect(recordedCli(real(DOCKER_CLI_FIXTURE_PATH))).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

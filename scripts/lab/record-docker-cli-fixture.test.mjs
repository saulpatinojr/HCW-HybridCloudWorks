/**
 * The pure parts of record-docker-cli-fixture.mjs: which engine version the
 * host pins, and which CLI the fixture records. The download, the hash check
 * and the capture run are exercised by lab-supply-chain.yml on the runner.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedEngine, recordedCli } from './record-docker-cli-fixture.mjs';
import { DOCKER_CLI_FIXTURE_PATH, GROUP_VARS_PATH } from '../lib/lab-pin-bumps.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const real = (path) => readFileSync(join(REPO, path), 'utf8');

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
    expect(() => pinnedEngine('docker_release_pins:\n  resolute:\n    engine: "latest"\n')).toThrow(
      /not an epoch:upstream-revision/
    );
  });

  it('reads the CLI a fixture records, and null for anything else', () => {
    expect(recordedCli('{"dockerCli":"29.9.0"}')).toBe('29.9.0');
    expect(recordedCli('{"other":1}')).toBeNull();
    expect(recordedCli('not json')).toBeNull();
  });

  it('the live pin and the live fixture are both readable, in the shapes the script expects', () => {
    const { version, core } = pinnedEngine(real(GROUP_VARS_PATH));
    expect(version).toMatch(/^5:\d+\.\d+\.\d+-1~ubuntu\.26\.04~resolute$/);
    expect(core).toMatch(/^\d+\.\d+\.\d+$/);
    expect(recordedCli(real(DOCKER_CLI_FIXTURE_PATH))).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

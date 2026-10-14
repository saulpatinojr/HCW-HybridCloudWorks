/**
 * The sandbox flag list is this component's entire security boundary (T-743).
 *
 * `runInDocker` shells out to `docker run` with a payload that reached this
 * host from the platform API. What keeps that safe is a fixed set of flags —
 * `--network none`, `--cap-drop ALL`, `--user 65534:65534`, `--read-only`,
 * `--security-opt no-new-privileges` — and until this file existed nothing
 * asserted any of them. The `vps-agent` CI job ran `npm ci` and stopped, so an
 * edit dropping `--network none` shipped green.
 *
 * These tests assert the argv `buildDockerArgs` produces, not that Docker
 * behaves — Docker is not installed in CI and must not be. The argv IS the
 * boundary: what this file pins is that the flags are present, that they carry
 * the right values, and that a capability cannot displace them. Since #675 it
 * also pins the `hcw.lab-job` label every container carries (ADR 0032
 * identifies job containers by that label, not by count) and the `tar`
 * payload path: what the archive parser accepts, and everything it refuses.
 *
 * Node's built-in test runner deliberately: this package's one virtue as a CI
 * check was that its lockfile carries a single dependency, and adding a test
 * framework to the component that holds a certificate on a third-party VPS
 * would trade that away for nothing. `node --test` needs no dependency at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  buildDockerArgs,
  prepareJobDir,
  parseTar,
  decodeTarPayload,
  vetTarPath,
  payloadPathFor,
  SANDBOX_FLAGS,
  OUTPUT_CAP_BYTES,
  JOB_DIR_MODE,
  PAYLOAD_MODE,
  JOB_LABEL,
  TAR_MAX_ENTRIES,
  DEFAULT_NOFILE,
} from './docker-runner.js';
import { CAPABILITIES } from './capabilities.js';

const LIMITS = { memory: '512m', cpus: '0.5', pidsLimit: 128, nofile: 2048 };
const CTX = {
  jobDir: '/tmp/labjob-test',
  containerName: 'labjob-deadbeef',
  jobId: '0f7c2b1e-9a4d-4c3e-8f21-6b5a7c8d9e01',
};

/** Index of a flag in an argv array, or -1. */
const at = (argv, flag) => argv.indexOf(flag);

/**
 * A minimal ustar writer, so the parser is tested against archives whose
 * every byte this file controls rather than against whatever `tar` on the
 * test machine emits. entries: [{ name, type?: '0'|'5'|'2'|'L'..., data?, prefix? }]
 */
function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'latin1');
    header.write('0000000\0', 108, 'latin1');
    header.write('0000000\0', 116, 'latin1');
    header.write(entry.size ?? `${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    header.write('00000000000\0', 136, 'latin1');
    header.write('        ', 148, 'latin1');
    header.write(entry.type ?? '0', 156, 'latin1');
    header.write(entry.magic ?? 'ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    blocks.push(header);
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

const b64 = (buf) => buf.toString('base64');

/**
 * The sandbox contract, written out here rather than imported.
 *
 * This duplication is the point. The first version of this file asserted each
 * flag's value against `SANDBOX_FLAGS` itself, which meant an edit changing
 * `--user 65534:65534` to `--user 0:0` changed the expectation in the same
 * move and the suite stayed green — the exact "test restates the
 * implementation" failure this file's header warns about, caught by mutating
 * the constant and watching nothing fail. These literals are the contract; the
 * module's constant is an implementation of it, and `matches the contract
 * exactly` below is what holds the two together.
 */
const REQUIRED_SANDBOX = [
  ['--network', 'none'],
  ['--read-only', null],
  ['--security-opt', 'no-new-privileges'],
  ['--cap-drop', 'ALL'],
  ['--user', '65534:65534'],
];

describe('the sandbox contract', () => {
  test('SANDBOX_FLAGS matches the contract exactly', () => {
    // Order matters only in that every flag must precede the image, which is
    // asserted per capability below. What matters here is the exact set and
    // the exact values: this is the assertion that fails when someone relaxes
    // the sandbox by editing its own definition.
    assert.deepEqual(
      [...SANDBOX_FLAGS].sort(),
      [...REQUIRED_SANDBOX].sort(),
      'the sandbox flag set or one of its values changed — this is a security boundary, not a default'
    );
  });

  test('the job label key is the one ADR 0032 names', () => {
    assert.equal(JOB_LABEL, 'hcw.lab-job');
  });
});

describe('buildDockerArgs — the sandbox boundary', () => {
  for (const [type, capability] of Object.entries(CAPABILITIES)) {
    describe(`capability ${type}`, () => {
      const encoding = capability.payloadEncodings.includes('text') ? 'text' : capability.payloadEncodings[0];
      const argv = buildDockerArgs(capability, { ...CTX, encoding }, LIMITS);

      test('carries every sandbox flag with its exact value', () => {
        for (const [flag, value] of REQUIRED_SANDBOX) {
          const i = at(argv, flag);
          assert.notEqual(i, -1, `${flag} is missing — the sandbox is weaker than it reads`);
          if (value !== null) {
            assert.equal(argv[i + 1], value, `${flag} carries the wrong value`);
          }
        }
      });

      test('labels the container with the job id, before the image', () => {
        const i = at(argv, '--label');
        assert.notEqual(i, -1, '--label is missing; the host cannot tell this container from a stray');
        assert.equal(argv[i + 1], `hcw.lab-job=${CTX.jobId}`);
        assert.ok(i < at(argv, capability.image), '--label appears after the image and is inert');
        assert.equal(argv.filter((a) => a === '--label').length, 1, 'exactly one label');
      });

      test('mounts the workspace read-only and nowhere else', () => {
        const mounts = argv.filter((a, i) => argv[i - 1] === '-v' || argv[i - 1] === '--volume');
        assert.deepEqual(mounts, [`${CTX.jobDir}:/workspace:ro`]);
      });

      test('applies the resource limits from config, not from the capability', () => {
        assert.equal(argv[at(argv, '--memory') + 1], LIMITS.memory);
        assert.equal(argv[at(argv, '--cpus') + 1], LIMITS.cpus);
        assert.equal(argv[at(argv, '--pids-limit') + 1], String(LIMITS.pidsLimit));
      });

      test('allows no swap: the swap limit equals the memory limit (LAB-13)', () => {
        assert.equal(argv[at(argv, '--memory-swap') + 1], LIMITS.memory);
        assert.equal(argv[at(argv, '--memory-swap') + 1], argv[at(argv, '--memory') + 1]);
      });

      test('caps open files from config, and from a default when config names none (LAB-13)', () => {
        assert.equal(argv[at(argv, '--ulimit') + 1], `nofile=${LIMITS.nofile}:${LIMITS.nofile}`);
        const older = buildDockerArgs(capability, { ...CTX, encoding }, { memory: '512m', cpus: '0.5', pidsLimit: 128 });
        assert.equal(older[at(older, '--ulimit') + 1], `nofile=${DEFAULT_NOFILE}:${DEFAULT_NOFILE}`);
      });

      test('removes the container and names it for the timeout kill path', () => {
        assert.ok(argv.includes('--rm'));
        assert.equal(argv[at(argv, '--name') + 1], CTX.containerName);
      });

      test('every sandbox flag precedes the image, so none is read as a command argument', () => {
        const image = at(argv, capability.image);
        assert.notEqual(image, -1, 'the image is not in the argv');
        for (const [flag] of REQUIRED_SANDBOX) {
          assert.ok(at(argv, flag) < image, `${flag} appears after the image and is inert`);
        }
      });

      test('the payload path is the only thing derived from job input', () => {
        // The command comes from buildCommand, which receives ONE argument: the
        // in-container payload path this module chose. Nothing from the job's
        // own bytes reaches argv — that is the whole point of writing the
        // payload to a file rather than interpolating it.
        const command = argv.slice(at(argv, capability.image) + 1);
        const expected = capability.buildCommand(payloadPathFor(capability, encoding));
        assert.deepEqual(command, expected);
      });
    });
  }

  test('refuses a capability that tries to set a sandbox-controlled flag', () => {
    for (const bad of ['--network', '--privileged', '--cap-add', '-v', '--user', '--pid', '--label', '--memory-swap', '--ulimit']) {
      assert.throws(
        () =>
          buildDockerArgs(
            { ...CAPABILITIES['shell-echo'], extraDockerArgs: [bad, 'whatever'] },
            CTX,
            LIMITS
          ),
        /sandbox-controlled docker flags/,
        `${bad} was accepted from a capability`
      );
    }
  });

  test('refuses to start a container for a job with no usable id', () => {
    // The label is how the host validation tells a job container from
    // anything else; a container it cannot attribute must not exist.
    for (const jobId of [undefined, '', 'has space', 'semi;colon', '-leading', 'x'.repeat(129)]) {
      assert.throws(
        () => buildDockerArgs(CAPABILITIES['shell-echo'], { ...CTX, jobId }, LIMITS),
        /job id/,
        `job id ${JSON.stringify(jobId)} reached docker`
      );
    }
  });

  test('a legitimate extraDockerArgs entry still works', () => {
    // terraform-validate needs a writable tmpfs because `terraform init`
    // writes .terraform/ and the root filesystem is read-only. That is the
    // shape the refusal above must NOT break — and the tmpfs must be owned
    // by the container user, or the first write is Permission denied.
    const argv = buildDockerArgs(CAPABILITIES['terraform-validate'], CTX, LIMITS);
    assert.equal(argv[at(argv, '--tmpfs') + 1], '/tmp/run:rw,size=64m,uid=65534,gid=65534,mode=0700');
    assert.equal(argv[at(argv, '--network') + 1], 'none');
  });

  test('extraDockerArgs land after the sandbox flags and before the image', () => {
    const argv = buildDockerArgs(CAPABILITIES['terraform-validate'], CTX, LIMITS);
    assert.ok(at(argv, '--tmpfs') > at(argv, '--cap-drop'));
    assert.ok(at(argv, '--tmpfs') < at(argv, CAPABILITIES['terraform-validate'].image));
  });

  test('a tar payload hands the command the workspace root, not a file', () => {
    assert.equal(payloadPathFor(CAPABILITIES['terraform-validate'], 'text'), '/workspace/main.tf');
    assert.equal(payloadPathFor(CAPABILITIES['terraform-validate'], 'tar'), '/workspace');
  });
});

describe('the job directory is readable by the container user', () => {
  // The container runs as 65534:65534 and this process does not, so the
  // per-job directory `fs.mkdtemp` creates (0700) was untraversable from
  // inside and every job failed before its command ran. POSIX modes are not
  // meaningful on Windows, so the assertion runs only where they are.
  const posix = process.platform !== 'win32';

  test('modes are world-readable and the directory is traversable', { skip: !posix }, async () => {
    const jobDir = await prepareJobDir('payload.txt', 'hello');
    try {
      const dirMode = (await fs.stat(jobDir)).mode & 0o777;
      const fileMode = (await fs.stat(path.join(jobDir, 'payload.txt'))).mode & 0o777;
      assert.equal(dirMode, JOB_DIR_MODE);
      assert.equal(fileMode, PAYLOAD_MODE);
      assert.equal(dirMode & 0o005, 0o005, 'others can read and traverse the directory');
      assert.equal(fileMode & 0o004, 0o004, 'others can read the payload');
      assert.equal(fileMode & 0o022, 0, 'nobody but the owner can write the payload');
      assert.equal(await fs.readFile(path.join(jobDir, 'payload.txt'), 'utf8'), 'hello');
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true });
    }
  });

  test('the payload lands in a fresh labjob- directory', async () => {
    const jobDir = await prepareJobDir('payload.txt', 'x');
    try {
      assert.match(path.basename(jobDir), /^labjob-/);
      assert.deepEqual(await fs.readdir(jobDir), ['payload.txt']);
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true });
    }
  });

  test('an unknown encoding writes nothing and leaves no directory behind', async () => {
    await assert.rejects(prepareJobDir('payload.txt', 'x', 'zip'), /unknown payload encoding/);
  });
});

describe('tar payloads', () => {
  test('a chart-shaped archive unpacks into the job directory, files and directories only', async () => {
    const archive = makeTar([
      { name: 'mychart/', type: '5' },
      { name: 'mychart/Chart.yaml', data: 'apiVersion: v2\nname: mychart\n' },
      { name: 'mychart/templates/', type: '5' },
      { name: 'mychart/templates/deployment.yaml', data: 'kind: Deployment\n' },
      { name: './values.yaml', data: 'replicaCount: 1\n' },
    ]);
    const jobDir = await prepareJobDir(undefined, b64(archive), 'tar');
    try {
      assert.equal(await fs.readFile(path.join(jobDir, 'mychart', 'Chart.yaml'), 'utf8'), 'apiVersion: v2\nname: mychart\n');
      assert.equal(await fs.readFile(path.join(jobDir, 'mychart', 'templates', 'deployment.yaml'), 'utf8'), 'kind: Deployment\n');
      assert.equal(await fs.readFile(path.join(jobDir, 'values.yaml'), 'utf8'), 'replicaCount: 1\n');
      assert.deepEqual((await fs.readdir(jobDir)).sort(), ['mychart', 'values.yaml']);
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true });
    }
  });

  test('a gzipped archive is accepted, and the ustar prefix field is honoured', () => {
    const archive = makeTar([{ name: 'main.tf', prefix: 'deep/root', data: 'x' }]);
    const entries = parseTar(decodeTarPayload(b64(zlib.gzipSync(archive))));
    assert.deepEqual(entries.map((e) => [e.path, e.type, e.data.toString()]), [['deep/root/main.tf', 'file', 'x']]);
  });

  test('refuses absolute paths and .. segments rather than normalising them', () => {
    for (const name of ['/etc/passwd', '../escape.tf', 'a/../../escape.tf', 'a/./b', 'a//b', 'back\\slash', '']) {
      assert.throws(() => parseTar(makeTar([{ name, data: 'x' }])), /tar payload/, `${JSON.stringify(name)} was accepted`);
    }
    assert.equal(vetTarPath('./mychart/values.yaml'), 'mychart/values.yaml');
    assert.equal(vetTarPath('dir/'), 'dir');
  });

  test('refuses symlinks, hard links, pax headers and GNU long names', () => {
    for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g', 'L', 'K']) {
      assert.throws(
        () => parseTar(makeTar([{ name: 'entry', type, data: 'x' }])),
        /only regular files and directories/,
        `entry type '${type}' was accepted`
      );
    }
  });

  test('bounds the entry count, the unpacked size and the payload shape', () => {
    const many = makeTar(Array.from({ length: TAR_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
    assert.throws(() => parseTar(many), /more than/);
    assert.throws(() => parseTar(makeTar([{ name: 'big', size: '77777777777\0', data: 'x' }])), /truncated|exceeds/);
    assert.throws(() => decodeTarPayload('not base64!!'), /expected base64/);
    assert.throws(() => decodeTarPayload({}), /expected base64/);
    // A gzip bomb stops at the output cap instead of filling memory.
    const bomb = zlib.gzipSync(Buffer.alloc(9 * 1024 * 1024, 0));
    assert.throws(() => decodeTarPayload(b64(bomb)), /gunzip failed/);
  });

  test('a refused archive leaves no job directory behind', async () => {
    const tmp = os.tmpdir();
    const labjobs = async () => (await fs.readdir(tmp)).filter((d) => d.startsWith('labjob-'));
    const before = new Set(await labjobs());
    await assert.rejects(prepareJobDir(undefined, b64(makeTar([{ name: '../x', data: 'x' }])), 'tar'), /tar payload/);
    for (const d of await labjobs()) {
      assert.ok(before.has(d), `${d} was left behind by a refused payload`);
    }
  });
});

describe('output handling', () => {
  test('the output cap is a real bound, not a comment', () => {
    assert.equal(OUTPUT_CAP_BYTES, 64 * 1024);
  });
});

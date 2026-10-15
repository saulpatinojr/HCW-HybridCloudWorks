/**
 * Sandboxed Docker execution.
 *
 * Security posture for every job:
 *   --network none          no network access (default; per-capability opt-out is NOT supported)
 *   --read-only             read-only root filesystem
 *   --memory / --cpus       resource limits from env config
 *   --pids-limit            fork-bomb protection
 *   --security-opt no-new-privileges
 *   --cap-drop ALL
 *   non-root user (65534)
 *   wall-clock timeout      container is force-killed on expiry
 *   --label hcw.lab-job     every container names the job it runs (ADR 0032)
 *
 * The payload is written to a per-job temp dir on the host and mounted
 * read-only at /workspace. Commands come ONLY from the capability
 * allowlist (argv arrays — never shell-interpolated user strings).
 *
 * Two payload encodings (#675). `text` is the original: the payload string is
 * written as one file named by the capability. `tar` is for multi-file
 * inputs (a Helm chart, a Terraform root with several files): the payload is
 * the base64 of a tar archive, optionally gzipped, which `prepareJobDir`
 * unpacks into the job directory with the parser in this file. The parser is
 * deliberately not a dependency and not the host's `tar`: it accepts regular
 * files and directories only, refuses absolute paths, `..` segments,
 * symlinks, hard links and every extension header, and bounds the entry
 * count and the unpacked size, because the archive is untrusted input that
 * reached this host from the API and the job directory is the one place on
 * the host it may touch.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const OUTPUT_CAP_BYTES = 64 * 1024;

/** The Docker label every job container carries, keyed by job id (ADR 0032). */
export const JOB_LABEL = 'hcw.lab-job';

/** Payload encodings the runner understands; a capability lists the ones it accepts. */
export const PAYLOAD_ENCODINGS = Object.freeze(['text', 'tar']);

/** Bounds on an unpacked `tar` payload. The API caps the encoded payload at 64 KB. */
export const TAR_MAX_ENTRIES = 512;
export const TAR_MAX_BYTES = 8 * 1024 * 1024;

/** Server-issued job ids are UUIDs; anything else does not reach a docker argv. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Spawn one process and collect its output, bounded by a wall clock and, when
 * a `signal` is given, by an abort. Both end the child with SIGKILL: the
 * `docker run` CLI forwards a SIGTERM to the container's PID 1 and waits,
 * and the agent's socket proxy refuses that forwarded kill
 * (docker-proxy.haproxy.cfg.j2), so a polite signal would hang here until
 * the wall clock. The container itself is removed by the caller afterwards.
 * `spawnImpl` is for tests, which must never need Docker.
 */
function runProcess(cmd, args, timeoutMs, { signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;

    if (signal?.aborted) {
      resolve({ exitCode: -1, output: out, truncated, timedOut, aborted: true });
      return;
    }

    const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const append = (chunk) => {
      if (out.length >= OUTPUT_CAP_BYTES) {
        truncated = true;
        return;
      }
      out += chunk.toString('utf8').slice(0, OUTPUT_CAP_BYTES - out.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Settled once: 'error' on a spawn failure may be followed by 'close',
    // and the listener comes off so an abort after the child has gone is a
    // no-op rather than a kill of a pid the OS may have reused.
    const settle = (result) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('close', (code) => {
      settle({ exitCode: aborted ? -1 : (code ?? -1), output: out, truncated, timedOut, aborted });
    });
    child.on('error', (err) => {
      settle({ exitCode: -1, output: `spawn error: ${err.message}`, truncated, timedOut, aborted });
    });
  });
}

/**
 * The sandbox flags, in the order `buildDockerArgs` emits them.
 *
 * Exported so `docker-runner.test.js` asserts against a named list rather than
 * re-typing the array it is checking — a test that restates the implementation
 * passes whatever the implementation says (T-743). Each entry is
 * `[flag, value]`; a value of `null` means the flag takes no argument.
 *
 * Nothing here is per-capability. A capability contributes `extraDockerArgs`,
 * which are appended AFTER these and therefore cannot displace them — but note
 * that Docker's own last-wins behaviour means an `extraDockerArgs` entry
 * repeating one of these flags would still override it. `buildDockerArgs`
 * refuses that case rather than trusting the capability list to stay honest.
 */
export const SANDBOX_FLAGS = [
  ['--network', 'none'],
  ['--read-only', null],
  ['--security-opt', 'no-new-privileges'],
  ['--cap-drop', 'ALL'],
  ['--user', '65534:65534'],
];

/** The file-descriptor ceiling when the agent's config names none (LABS_AGENT_JOB_NOFILE). */
export const DEFAULT_NOFILE = 1024;

/**
 * The `--memory-swap` value for a memory limit: twice it, which is Docker's
 * default (swap at most the memory limit) written out. A limit this cannot
 * read (`512mb`, text) yields null and the flag is left out, so Docker
 * applies the same default itself rather than refusing the container.
 *
 * @param {string|number} memory the `--memory` value, e.g. `512m`, `1g`, bytes
 * @returns {string|null}
 */
export function memorySwapFor(memory) {
  const match = String(memory ?? '').match(/^(\d+)([bkmg]?)$/i);
  return match ? `${Number(match[1]) * 2}${match[2]}` : null;
}

/** Flags a capability may never set, because they weaken the sandbox. */
const RESERVED_FLAGS = new Set([
  ...SANDBOX_FLAGS.map(([flag]) => flag),
  '--privileged',
  '--pid',
  '--ipc',
  '--userns',
  '--cap-add',
  '--device',
  '--memory',
  '--memory-swap',
  '--cpus',
  '--pids-limit',
  '--ulimit',
  '--label',
  '-l',
  '-v',
  '--volume',
  '--mount',
]);

/** The in-container path handed to `buildCommand` for each encoding. */
export function payloadPathFor(capability, encoding) {
  return encoding === 'tar' ? '/workspace' : `/workspace/${capability.payloadFileName}`;
}

/**
 * Build the full `docker` argv for one job.
 *
 * Pure and exported for testing: the sandbox flag list is this component's
 * entire security boundary, and before T-743 nothing asserted it stayed
 * intact — an edit dropping `--network none` shipped green.
 *
 * @param {object} capability entry from lib/capabilities.js
 * @param {object} ctx        { jobDir, containerName, jobId, encoding }
 * @param {object} limits     { memory, cpus, pidsLimit, nofile? }
 * @returns {string[]} argv after the `docker` executable itself
 */
export function buildDockerArgs(capability, { jobDir, containerName, jobId, encoding = 'text' }, limits) {
  // A stated swap bound and a file-descriptor ceiling (LAB-13, #959).
  // `--memory-swap` is written out as twice `--memory`, which is Docker's
  // own default (swap at most the memory limit) made explicit so the bound
  // is in the argv the proxy and the tests see. It is NOT pinned to
  // `--memory`: that reading OOM-killed the Landing Zone Builder's full
  // validate in the image smoke test on a runner that has swap (#1172), and
  // on the host, which has no swap, it would change nothing anyway. `nofile`
  // defaults here, not only in index.js, so a caller that
  // passes the three older limits (lab-image/sandbox-check.mjs) still emits
  // the ceiling. Only a positive whole number is used: `0.5`, `Infinity`
  // (what `1e999` in the env becomes) or text would reach Docker as a
  // ulimit it refuses, and every job would fail to start (review on #1172).
  const requested = Number(limits.nofile);
  const nofile = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_NOFILE;
  const swap = memorySwapFor(limits.memory);
  const extra = capability.extraDockerArgs || [];
  const reserved = extra.filter((arg) => RESERVED_FLAGS.has(arg));
  if (reserved.length > 0) {
    // Refuse rather than emit a weakened sandbox. A capability is repository
    // code, so this is a developer error caught at run time, not an attacker
    // path — but the failure has to be loud, because the alternative is a
    // container that looks sandboxed in this file and is not.
    throw new Error(
      `capability may not set sandbox-controlled docker flags: ${reserved.join(', ')}`
    );
  }
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    // The label is how the host tells a job container from anything else
    // (ADR 0032 validation), so a job with no usable id does not run.
    throw new Error('job id is missing or not a plain identifier; refusing to start a container');
  }

  return [
    'run',
    '--rm',
    '--name', containerName,
    '--label', `${JOB_LABEL}=${jobId}`,
    ...SANDBOX_FLAGS.flatMap(([flag, value]) => (value === null ? [flag] : [flag, value])),
    '--memory', limits.memory,
    ...(swap ? ['--memory-swap', swap] : []),
    '--cpus', limits.cpus,
    '--pids-limit', String(limits.pidsLimit),
    '--ulimit', `nofile=${nofile}:${nofile}`,
    '-v', `${jobDir}:/workspace:ro`,
    ...extra,
    capability.image,
    ...capability.buildCommand(payloadPathFor(capability, encoding)),
  ];
}

/**
 * Modes for the per-job staging directory and the payload copy inside it.
 *
 * The container runs as 65534:65534 (SANDBOX_FLAGS) while this process runs
 * as the agent user, and `fs.mkdtemp` creates 0700 — a directory UID 65534
 * cannot traverse, so every job failed before its command ran. World-readable
 * is acceptable here and nowhere else: the directory exists for one job,
 * holds only that job's payload copy (which already reached this host from
 * the API and is bind-mounted read-only), and is removed in `finally`.
 */
export const JOB_DIR_MODE = 0o755;
export const PAYLOAD_MODE = 0o644;

const readOctal = (buf, start, length) => {
  const text = buf.toString('latin1', start, start + length).replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error('tar payload: a header field is not octal (base-256 sizes are not supported)');
  }
  return parseInt(text, 8);
};

const readString = (buf, start, length) =>
  buf.toString('utf8', start, start + length).replace(/\0.*$/s, '');

/**
 * Normalise and vet one archive path. Returns the relative POSIX path, or
 * throws. Anything that could name a location outside the job directory —
 * an absolute path, a `..` segment, a backslash, a NUL — is refused outright
 * rather than normalised away, because a payload that carries one is not a
 * chart or a Terraform root, whatever else it is.
 */
export function vetTarPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('tar payload: an entry has no name');
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new Error(`tar payload: refusing entry with a NUL or backslash in its name`);
  }
  let p = raw;
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.startsWith('/')) throw new Error(`tar payload: refusing absolute path ${JSON.stringify(raw)}`);
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '' || s === '.')) {
    throw new Error(`tar payload: refusing path ${JSON.stringify(raw)}`);
  }
  return segments.join('/');
}

/** The tar typeflags a payload may carry, and what each becomes. */
const TAR_ENTRY_TYPES = { 0: 'file', '\0': 'file', 5: 'dir' };

/**
 * Read one 512-byte tar header. Returns null at the end-of-archive marker,
 * otherwise the entry's name (with the ustar prefix joined on), typeflag
 * and data size.
 */
function readTarHeader(buf, offset) {
  const header = buf.subarray(offset, offset + 512);
  if (header.every((b) => b === 0)) return null;
  let name = readString(header, 0, 100);
  if (header.toString('latin1', 257, 263) === 'ustar\0') {
    const prefix = readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
  }
  return { name, typeflag: String.fromCharCode(header[156]), size: readOctal(header, 124, 12) };
}

/**
 * Map a typeflag to 'file' or 'dir', or throw. Every other entry type is an
 * error: there is no legitimate reason for a lab payload to carry a symlink,
 * a hard link, a device node, or a pax or GNU long-name extension, and each
 * of those is a way to write somewhere other than the job directory or to
 * smuggle a path past `vetTarPath`.
 */
function tarEntryType({ name, typeflag }) {
  const type = TAR_ENTRY_TYPES[typeflag];
  if (!type) {
    const shown = typeflag === '\0' ? '\\0' : typeflag;
    throw new Error(
      `tar payload: refusing entry ${JSON.stringify(name)} of type '${shown}' (only regular files and directories are accepted)`
    );
  }
  return type;
}

function assertTarBounds(entryCount, totalBytes) {
  if (entryCount > TAR_MAX_ENTRIES) {
    throw new Error(`tar payload: more than ${TAR_MAX_ENTRIES} entries`);
  }
  if (totalBytes > TAR_MAX_BYTES) {
    throw new Error(`tar payload: unpacked size exceeds ${TAR_MAX_BYTES} bytes`);
  }
}

/**
 * Parse a (ustar or GNU) tar buffer into regular files and directories,
 * each path vetted by `vetTarPath` and the whole bounded by `assertTarBounds`.
 *
 * @returns {{ path: string, type: 'file'|'dir', data: Buffer }[]}
 */
export function parseTar(buf) {
  const entries = [];
  let offset = 0;
  let total = 0;
  while (offset + 512 <= buf.length) {
    const header = readTarHeader(buf, offset);
    if (header === null) break;
    const dataStart = offset + 512;
    const dataEnd = dataStart + header.size;
    if (dataEnd > buf.length) throw new Error('tar payload: truncated archive');
    offset = dataStart + Math.ceil(header.size / 512) * 512;

    const type = tarEntryType(header);
    const vetted = vetTarPath(header.name);
    if (vetted === '') continue; // the archive's own root, "./"
    entries.push({
      path: vetted,
      type,
      data: type === 'dir' ? Buffer.alloc(0) : buf.subarray(dataStart, dataEnd),
    });
    total += header.size;
    assertTarBounds(entries.length, total);
  }
  return entries;
}

/** Decode a `tar` payload string: base64, then gunzip if it is gzipped. */
export function decodeTarPayload(payload) {
  if (typeof payload !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(payload)) {
    throw new Error('tar payload: expected base64');
  }
  let buf = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: TAR_MAX_BYTES });
    } catch (err) {
      throw new Error(`tar payload: gunzip failed (${err.code || err.message})`);
    }
  }
  return buf;
}

/**
 * Create the per-job staging directory under os.tmpdir() and write the
 * payload into it, with modes the sandboxed container user can read.
 * Exported so the test can assert the modes and the unpacking without Docker.
 * @param {string} payloadFileName from the capability (used by `text`)
 * @param {string} payload         job payload string
 * @param {'text'|'tar'} encoding  how to interpret the payload
 * @returns {Promise<string>} the job directory path
 */
export async function prepareJobDir(payloadFileName, payload, encoding = 'text') {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'labjob-'));
  await fs.chmod(jobDir, JOB_DIR_MODE);
  try {
    if (encoding === 'text') {
      await fs.writeFile(path.join(jobDir, payloadFileName), payload, { encoding: 'utf8', mode: PAYLOAD_MODE });
    } else if (encoding === 'tar') {
      const root = path.resolve(jobDir);
      for (const entry of parseTar(decodeTarPayload(payload))) {
        const target = path.resolve(root, ...entry.path.split('/'));
        if (!target.startsWith(root + path.sep)) {
          throw new Error(`tar payload: ${JSON.stringify(entry.path)} resolves outside the job directory`);
        }
        if (entry.type === 'dir') {
          await fs.mkdir(target, { recursive: true, mode: JOB_DIR_MODE });
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: JOB_DIR_MODE });
          await fs.writeFile(target, entry.data, { mode: PAYLOAD_MODE });
        }
      }
    } else {
      throw new Error(`unknown payload encoding ${JSON.stringify(encoding)}`);
    }
  } catch (err) {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return jobDir;
}

/** How long `docker rm -f` of a job container may take before the agent stops waiting for it. */
export const REMOVE_TIMEOUT_MS = 10000;

/**
 * Execute a job in a sandboxed container.
 *
 * An abort of `signal` is the agent shutting down (lib/shutdown.js): the
 * `docker run` child is killed, the container is removed by name through
 * the proxy (the one DELETE it allows: the job's own `labjob-` name with
 * `force=1`), and the result says `aborted` so the job is reported as
 * interrupted rather than as the learner's failure. Before #959's fix the
 * agent exited with the container running and nothing reported, and the
 * job sat `claimed` until the server's lease lapsed.
 *
 * @param {object} capability entry from lib/capabilities.js
 * @param {object} job        { id, payload, payloadEncoding? } as claimed from the API
 * @param {object} limits     { memory, cpus, pidsLimit, nofile } from env config
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]  aborted when the agent is stopping
 * @param {typeof spawn} [options.spawnImpl] tests only; production always spawns `docker`
 * @returns {Promise<{exitCode:number, output:string, truncated:boolean, timedOut:boolean, aborted:boolean}>}
 */
export async function runInDocker(capability, job, limits, { signal, spawnImpl = spawn } = {}) {
  const encoding = job.payloadEncoding || 'text';
  const accepted = capability.payloadEncodings || ['text'];
  if (!PAYLOAD_ENCODINGS.includes(encoding) || !accepted.includes(encoding)) {
    throw new Error(`payload encoding ${JSON.stringify(encoding)} is not accepted by this capability`);
  }
  const jobDir = await prepareJobDir(capability.payloadFileName, job.payload, encoding);
  const containerName = `labjob-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const dockerArgs = buildDockerArgs(capability, { jobDir, containerName, jobId: job.id, encoding }, limits);

    if (signal?.aborted) {
      // Stopped before `docker run` was spawned: there is no container to
      // remove, and starting one now would only be killed below.
      return { exitCode: -1, output: '', truncated: false, timedOut: false, aborted: true };
    }

    const timeoutMs = (capability.timeoutSeconds + 15) * 1000; // grace for image pull/start
    const result = await runProcess('docker', dockerArgs, timeoutMs, { signal, spawnImpl });

    if (result.timedOut || result.aborted) {
      // Ensure the container is gone. Killing the CLI child leaves the
      // container running (the CLI is only attached to it), so this removal
      // is what actually stops the job, on the wall-clock path and on the
      // shutdown path alike. Not given the signal: it is already aborted.
      await runProcess('docker', ['rm', '-f', containerName], REMOVE_TIMEOUT_MS, { spawnImpl });
    }
    if (result.truncated) {
      result.output += '\n[output truncated at 64KB]';
    }
    return result;
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

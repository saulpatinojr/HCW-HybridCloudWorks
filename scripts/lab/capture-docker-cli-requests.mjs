/**
 * Record every Docker API request the docker CLI makes for the lab agent's
 * jobs, so the agent's socket proxy can be held to what the CLI really sends
 * (LAB-5, 2026-10-07; lab-host/ansible/roles/labs_agent/templates/
 * docker-proxy.haproxy.cfg.j2).
 *
 * It starts a recording stand-in for the Docker daemon on a loopback TCP
 * port, points the local docker CLI at it with DOCKER_HOST, and runs, for
 * every capability in vps-agent/lib/capabilities.js, the exact argv
 * buildDockerArgs builds, then the `docker rm -f` the runner sends for a job
 * that timed out. The stand-in answers like a daemon whose container prints
 * one line and exits 0: ping, create, the upgraded attach stream, a wait
 * whose headers arrive before the start (the CLI waits for them), start.
 * Nothing reaches a real daemon and no image is pulled.
 *
 * Run it with the docker CLI the lab host pins (docker_release_pins in
 * lab-host/ansible/group_vars/all.yml) whenever that pin, the sandbox flags
 * or a capability changes, and commit the fixture it writes:
 *
 *   node scripts/lab/capture-docker-cli-requests.mjs scripts/fixtures/docker-cli-agent-requests.json
 *
 * The pin's own moves do this without a person: lab-supply-chain.yml runs
 * scripts/lab/record-docker-cli-fixture.mjs after the host bump, which
 * installs the pinned docker-ce-cli into a temporary directory from Docker's
 * signed apt index and runs this with it first on PATH.
 *
 * scripts/lab-host-docker-proxy.test.mjs fails when the argv recorded there
 * is no longer the argv buildDockerArgs builds, which is the signal to run
 * this again.
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const { buildDockerArgs } = await import(pathToFileURL(path.join(repoRoot, 'vps-agent', 'lib', 'docker-runner.js')).href);
const { CAPABILITIES } = await import(pathToFileURL(path.join(repoRoot, 'vps-agent', 'lib', 'capabilities.js')).href);

/** The job every capability is recorded for: the host's staging path, a mkdtemp-shaped suffix. */
export const JOB = Object.freeze({
  jobDir: '/var/lib/hcw-labs-agent/tmp/labjob-Ab3xZ9',
  containerName: 'labjob-0123456789ab',
  jobId: '7f9c2b1e-3d4a-4c5b-8e6f-0a1b2c3d4e5f',
});
export const LIMITS = Object.freeze({ memory: '512m', cpus: '0.5', pidsLimit: 128 });
const KEPT_HEADERS = ['content-length', 'content-type', 'transfer-encoding', 'upgrade', 'connection'];
const CRLF = '\r\n';
const API_VERSION = '1.56';

function frame(text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const head = (status, headers) =>
  [`HTTP/1.1 ${status}`, `Api-Version: ${API_VERSION}`, 'Ostype: linux', ...headers, '', ''].join(CRLF);

/** Run one docker argv against a fresh recording daemon; resolves with what it saw. */
function record(argv, dockerConfig) {
  const id = crypto.randomBytes(32).toString('hex');
  const requests = [];
  const state = { attach: null, wait: null, started: false };

  const finish = () => {
    if (!state.started) return;
    if (state.attach) {
      state.attach.end(frame('recorded\n'));
      state.attach = null;
    }
    if (state.wait) {
      const body = `${JSON.stringify({ StatusCode: 0, Error: null })}\n`;
      state.wait.end(`${Buffer.byteLength(body).toString(16)}${CRLF}${body}${CRLF}0${CRLF}${CRLF}`);
      state.wait = null;
    }
  };

  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const end = buf.indexOf(`${CRLF}${CRLF}`);
        if (end === -1) return;
        const [requestLine, ...headerLines] = buf.subarray(0, end).toString('latin1').split(CRLF);
        // A Map, not an object: header names come from the client, and an
        // object would take `__proto__` as one.
        const headers = new Map();
        for (const line of headerLines) {
          const colon = line.indexOf(':');
          headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        const length = Number(headers.get('content-length') || 0);
        if (buf.length < end + 4 + length) return;
        const body = buf.subarray(end + 4, end + 4 + length).toString('utf8');
        buf = buf.subarray(end + 4 + length);
        const [method, target] = requestLine.split(' ');
        const [pathname, query = ''] = target.split('?');
        requests.push({
          method,
          path: pathname.replace(id, '<id>'),
          query,
          headers: Object.fromEntries(KEPT_HEADERS.filter((h) => headers.has(h)).map((h) => [h, headers.get(h)])),
          body,
        });
        const json = (status, value) => {
          const text = JSON.stringify(value);
          sock.write(head(status, ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(text)}`]) + text);
        };
        if (pathname === '/_ping') {
          sock.write(head('200 OK', ['Content-Type: text/plain', 'Content-Length: 2']) + (method === 'HEAD' ? '' : 'OK'));
        } else if (/\/containers\/create$/.test(pathname)) {
          json('201 Created', { Id: id, Warnings: [] });
        } else if (pathname.endsWith(`/containers/${id}/attach`)) {
          sock.write(head('101 UPGRADED', ['Content-Type: application/vnd.docker.raw-stream', 'Connection: Upgrade', 'Upgrade: tcp']));
          state.attach = sock;
          finish();
          return;
        } else if (pathname.endsWith(`/containers/${id}/wait`)) {
          sock.write(head('200 OK', ['Content-Type: application/json', 'Transfer-Encoding: chunked']));
          state.wait = sock;
          finish();
          return;
        } else if (pathname.endsWith(`/containers/${id}/start`)) {
          sock.write(head('204 No Content', []));
          state.started = true;
          setTimeout(finish, 50);
        } else if (method === 'DELETE') {
          sock.write(head('204 No Content', []));
        } else {
          json('404 Not Found', { message: `recording daemon: no answer for ${method} ${pathname}` });
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const child = spawn('docker', argv, {
        env: { ...process.env, DOCKER_HOST: `tcp://127.0.0.1:${port}`, DOCKER_CONFIG: dockerConfig, DOCKER_CONTEXT: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      const timer = setTimeout(() => child.kill(), 15000);
      child.on('error', reject);
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        server.close();
        resolve({ exitCode, output, requests });
      });
    });
  });
}

async function main([out]) {
  if (!out) throw new Error('usage: node scripts/lab/capture-docker-cli-requests.mjs <fixture.json>');
  const cliVersion = execFileSync('docker', ['version', '--format', '{{.Client.Version}}'], { encoding: 'utf8' }).trim();
  // An empty client configuration, so no credential helper, context or proxy
  // setting of the machine running this changes what the CLI sends.
  const dockerConfig = mkdtempSync(path.join(os.tmpdir(), 'docker-config-'));
  try {
    const runs = {};
    for (const [name, capability] of Object.entries(CAPABILITIES)) {
      const encoding = (capability.payloadEncodings || ['text'])[0];
      const argv = buildDockerArgs(capability, { ...JOB, encoding }, LIMITS);
      const result = await record(argv, dockerConfig);
      if (result.exitCode !== 0) throw new Error(`${name}: docker exited ${result.exitCode}: ${result.output}`);
      runs[name] = { encoding, argv, requests: result.requests };
    }
    const removeArgv = ['rm', '-f', JOB.containerName];
    const removal = await record(removeArgv, dockerConfig);
    if (removal.exitCode !== 0) throw new Error(`rm -f: docker exited ${removal.exitCode}: ${removal.output}`);
    const fixture = {
      $comment:
        'Written by scripts/lab/capture-docker-cli-requests.mjs; read by scripts/lab-host-docker-proxy.test.mjs. Container ids are <id>.',
      dockerCli: cliVersion,
      apiVersion: API_VERSION,
      job: JOB,
      limits: LIMITS,
      runs,
      remove: { argv: removeArgv, requests: removal.requests },
    };
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(`wrote ${out}: ${Object.keys(runs).length} capabilities and rm -f, docker CLI ${cliVersion}\n`);
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`capture-docker-cli-requests: ${error.message}\n`);
    process.exit(1);
  });
}

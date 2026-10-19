/**
 * bin/report-host-check.js and the function behind it (2026-10-19, #1282).
 *
 * The same contract as report-coder-automation.test.js, for the one-shot a
 * host check calls: one JSON object in, agentId from configuration,
 * `{"ok":true}` out, the error's class alone on stderr, exit 0 or 1. The
 * load-bearing assertion is again what the process writes: a report's own
 * `error` sentence, which a host wrote and a server refusal may quote,
 * appears in nothing the process prints on any path, so a check whose
 * failure text names a URL or a file never puts it on the journal twice.
 *
 * The function is driven with an injected client, and once through the real
 * lib/api.js with an injected fetch and credential, so the body on the wire
 * is checked too. The bin is spawned for the paths that need no network.
 * Node's built-in test runner, like the rest of this package.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createApiClient } from './api.js';
import { MAX_INPUT_BYTES } from './report-coder-automation.js';
import { INPUT_FIELDS, runReportHostCheck } from './report-host-check.js';

// A host's error sentence, plainly made up, used to prove nothing a report
// says is echoed by this side.
const HOST_ERROR = 'FAKEHOSTERROR: Portainer answered HTTP 502 on /api/system/status';
const REPORT = Object.freeze({
  checkedAt: '2026-10-19T04:30:00Z',
  up: true,
  version: '2.45.2',
  edition: 'EE',
  licenseValid: true,
  licenseExpiresAt: '2027-09-26T00:00:00Z',
  environmentName: 'local',
  environmentUp: true,
  containers: { total: 10, running: 8, unhealthy: 0, restarting: 0, exited: 2 },
  imagesChecked: 8,
  imagesOutdated: 0,
  error: null,
});
const FAILED_REPORT = Object.freeze({ ...REPORT, up: false, error: HOST_ERROR });
const ENV = {
  LABS_AGENT_API_BASE: 'https://api.example.test/api/',
  LABS_AGENT_TENANT_ID: 'tenant',
  LABS_AGENT_CLIENT_ID: 'client',
  LABS_AGENT_CERT_PATH: '/etc/hcw/labs-agent.pem',
  LABS_AGENT_API_SCOPE: 'api://hcw/.default',
  LABS_AGENT_ID: 'vps-hostinger-01',
};

function sink() {
  const chunks = [];
  return {
    chunks,
    text: () => chunks.join(''),
    write(chunk, callback) {
      chunks.push(String(chunk));
      callback?.();
      return true;
    },
  };
}

/** Run the function with `input` on stdin and a client that does `answer`. */
async function run(input, { answer = async () => ({ ok: true }), env = ENV } = {}) {
  const stdout = sink();
  const stderr = sink();
  const calls = [];
  const configs = [];
  const code = await runReportHostCheck({
    stdin: Readable.from([Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))]),
    stdout,
    stderr,
    env,
    hostname: () => 'the-hostname',
    createClient: (config) => {
      configs.push(config);
      return {
        reportHostCheck: async (body) => {
          calls.push(body);
          return answer(body);
        },
      };
    },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls, configs };
}

const assertNothingEchoed = (...outputs) => {
  for (const output of outputs) {
    assert.doesNotMatch(output, /FAKEHOSTERROR/, "the report's error sentence reached an output");
    assert.doesNotMatch(output, /2\.45\.2|local|containers/, 'a report value reached an output');
  }
};

describe('success', () => {
  it('sends the check and its report, and prints {"ok":true} alone', async () => {
    const result = await run({ check: 'portainer', report: REPORT });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '{"ok":true}\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(result.calls, [{ check: 'portainer', report: REPORT }]);
    assertNothingEchoed(result.stdout, result.stderr);
  });

  it('prints the one field whatever the server adds, a failed reading included', async () => {
    const result = await run(
      { check: 'portainer', report: FAILED_REPORT },
      { answer: async () => ({ ok: true, extra: HOST_ERROR }) }
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '{"ok":true}\n');
    assert.deepEqual(result.calls, [{ check: 'portainer', report: FAILED_REPORT }]);
    assertNothingEchoed(result.stdout, result.stderr);
  });

  it('builds the client from the agent configuration, the same names as index.js', async () => {
    const { configs } = await run({ check: 'portainer', report: REPORT });
    assert.equal(configs.length, 1);
    assert.equal(configs[0].apiBase, 'https://api.example.test/api');
    assert.equal(configs[0].agentId, 'vps-hostinger-01');
    assert.equal(configs[0].certificatePath, '/etc/hcw/labs-agent.pem');
    const { LABS_AGENT_ID: _omitted, ...noId } = ENV;
    assert.equal((await run({ check: 'portainer', report: REPORT }, { env: noId })).configs[0].agentId, 'the-hostname');
  });

  it('puts agentId, the check and the report on the wire through lib/api.js, nothing else', async () => {
    const requests = [];
    const stdout = sink();
    const code = await runReportHostCheck({
      stdin: Readable.from([Buffer.from(JSON.stringify({ check: 'portainer', report: REPORT }))]),
      stdout,
      stderr: sink(),
      env: ENV,
      createClient: (config) =>
        createApiClient({
          ...config,
          credential: { getToken: async () => ({ token: 'agent-token' }) },
          fetchImpl: async (url, init) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
          },
        }),
    });
    assert.equal(code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.example.test/api/agent/reportHostCheck');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer agent-token');
    assert.deepEqual(requests[0].body, { agentId: 'vps-hostinger-01', check: 'portainer', report: REPORT });
    assert.equal(stdout.text(), '{"ok":true}\n');
  });
});

describe('failure: the class alone on stderr, exit 1, nothing on stdout', () => {
  it('a refusal from the server, even one that quotes the report, prints its HTTP status only', async () => {
    const result = await run(
      { check: 'portainer', report: FAILED_REPORT },
      {
        answer: async () => {
          throw Object.assign(new Error(`report.error must be at most 300 characters: ${HOST_ERROR}`), {
            status: 400,
          });
        },
      }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'HTTP 400\n');
    assertNothingEchoed(result.stdout, result.stderr);
  });

  it('a thrown error prints its class, never its text', async () => {
    const result = await run(
      { check: 'portainer', report: FAILED_REPORT },
      {
        answer: async () => {
          throw new TypeError(`fetch failed while sending ${HOST_ERROR}`);
        },
      }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'TypeError\n');
    assertNothingEchoed(result.stdout, result.stderr);
  });

  it('a 2xx that does not say ok is not success', async () => {
    const result = await run({ check: 'portainer', report: REPORT }, { answer: async () => ({ recorded: true }) });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'UNEXPECTED_ANSWER\n');
  });

  it('refuses input that is not one JSON object of the two keys, before any client exists', async () => {
    for (const input of [
      `not json ${HOST_ERROR}`,
      `{"check":"portainer","report":{}} {"check":"portainer","report":{}}`,
      JSON.stringify([{ check: 'portainer', report: REPORT }]),
      'null',
      JSON.stringify({ agentId: 'someone-else', check: 'portainer', report: REPORT }),
      JSON.stringify({ statusToken: 'x', check: 'portainer', report: REPORT }),
      JSON.stringify({ check: 'portainer', report: FAILED_REPORT, note: 'x' }),
    ]) {
      const result = await run(input);
      assert.equal(result.code, 1, input);
      assert.equal(result.stderr, 'INVALID_INPUT\n', input);
      assert.equal(result.configs.length, 0, 'a client was built for refused input');
      assertNothingEchoed(result.stdout, result.stderr);
    }
  });

  it('refuses more input than a report could be', async () => {
    const result = await run(JSON.stringify({ check: 'portainer', report: { error: 'x'.repeat(MAX_INPUT_BYTES) } }));
    assert.equal(result.stderr, 'INPUT_TOO_LARGE\n');
    assert.equal(result.calls.length, 0);
  });

  it('refuses to run without the agent configuration, and says MISSING_CONFIG only', async () => {
    const { LABS_AGENT_CERT_PATH: _omitted, ...env } = ENV;
    const result = await run({ check: 'portainer', report: FAILED_REPORT }, { env });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'MISSING_CONFIG\n');
    assert.equal(result.configs.length, 0);
    assertNothingEchoed(result.stdout, result.stderr);
  });

  it('accepts exactly the route body without agentId, and leaves the report to the server', async () => {
    assert.deepEqual([...INPUT_FIELDS], ['check', 'report']);
    // A check the server does not know, and a report of the wrong shape, are
    // sent as they are: the server answers 400 with a sentence, and a second
    // copy of its rules here would only drift from the first.
    const result = await run({ check: 'not-a-check', report: 'nope' });
    assert.deepEqual(result.calls, [{ check: 'not-a-check', report: 'nope' }]);
  });
});

describe('the bin, as the host runs it', () => {
  const bin = fileURLToPath(new URL('../bin/report-host-check.js', import.meta.url));
  // The parent's environment without any agent setting, so no run here can
  // reach an API or an identity provider.
  const bare = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LABS_AGENT_')));
  const spawn = (input, env = bare) =>
    spawnSync(process.execPath, [bin], { input, env, encoding: 'utf8', timeout: 20_000 });

  it('exits 1 with MISSING_CONFIG and never echoes the report it was given', () => {
    const result = spawn(JSON.stringify({ check: 'portainer', report: FAILED_REPORT }));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'MISSING_CONFIG\n');
    assertNothingEchoed(result.stdout, result.stderr);
  });

  it('exits 1 with INVALID_INPUT for input it cannot read, report and all', () => {
    const result = spawn(`{"check":"portainer","report":{"error":"${HOST_ERROR}",`, { ...bare, ...ENV });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'INVALID_INPUT\n');
    assertNothingEchoed(result.stdout, result.stderr);
  });
});

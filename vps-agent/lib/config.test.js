/**
 * One reading of the agent's API settings, shared by the long-running agent
 * and the Coder automation one-shot (2026-10-08). What matters is that the
 * two cannot disagree: same names, same fallback for the agent id, and
 * neither entry point reading those names itself. The job limits stay in
 * index.js, where lab-image/sandbox-check.mjs and
 * scripts/lab-job-limits.test.mjs read them, and that is pinned here too.
 *
 * Node's built-in test runner, like the rest of this package.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { REQUIRED_SETTINGS, missingConfig, readApiConfig } from './config.js';

const ENV = {
  LABS_AGENT_API_BASE: 'https://api.example.test/api//',
  LABS_AGENT_TENANT_ID: 'tenant',
  LABS_AGENT_CLIENT_ID: 'client',
  LABS_AGENT_CERT_PATH: '/etc/hcw/labs-agent.pem',
  LABS_AGENT_API_SCOPE: 'api://hcw/.default',
  LABS_AGENT_ID: 'vps-hostinger-01',
};

/** The API names: the five required ones and the agent id. */
const API_NAMES = [...REQUIRED_SETTINGS.map(([name]) => name), 'LABS_AGENT_ID'];

describe('readApiConfig', () => {
  it('reads the names .env.example documents, and trims the API base of trailing slashes', () => {
    assert.deepEqual(readApiConfig(ENV, () => 'unused'), {
      apiBase: 'https://api.example.test/api',
      tenantId: 'tenant',
      clientId: 'client',
      certificatePath: '/etc/hcw/labs-agent.pem',
      scope: 'api://hcw/.default',
      agentId: 'vps-hostinger-01',
    });
  });

  it('falls back to the hostname for the agent id, as the agent always has', () => {
    const { LABS_AGENT_ID: _omitted, ...env } = ENV;
    assert.equal(readApiConfig(env, () => 'srv-host').agentId, 'srv-host');
  });

  it('documents every name it reads in .env.example', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const name of API_NAMES) assert.match(example, new RegExp(`^${name}=`, 'm'), name);
  });
});

describe('missingConfig', () => {
  it('names every required setting that is absent, in order, and nothing when all are set', () => {
    assert.deepEqual(missingConfig(readApiConfig(ENV, () => 'h')), []);
    assert.deepEqual(
      missingConfig(readApiConfig({}, () => 'h')),
      REQUIRED_SETTINGS.map(([name]) => name)
    );
    const { LABS_AGENT_CERT_PATH: _omitted, ...env } = ENV;
    assert.deepEqual(missingConfig(readApiConfig(env, () => 'h')), ['LABS_AGENT_CERT_PATH']);
  });
});

describe('every entry point reads the API settings through this module', () => {
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('index.js and the two one-shots import it and read no API name themselves', () => {
    // The host checks' one-shot joined the Coder automation's on 2026-10-19 (#1282).
    for (const file of ['../index.js', './report-coder-automation.js', './report-host-check.js']) {
      const code = strip(readFileSync(new URL(file, import.meta.url), 'utf8'));
      assert.match(code, /from '\.\/(lib\/)?config\.js'/, `${file} does not import lib/config.js`);
      for (const name of API_NAMES) {
        assert.doesNotMatch(code, new RegExp(`process\\.env\\.${name}\\b`), `${file} reads ${name} itself`);
      }
    }
  });

  it('leaves the job limits in index.js, as `process.env.NAME || <default>`, where the image check reads them', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    for (const name of ['LABS_AGENT_JOB_MEMORY', 'LABS_AGENT_JOB_CPUS', 'LABS_AGENT_JOB_PIDS', 'LABS_AGENT_POLL_MS', 'LABS_AGENT_MAX_CONCURRENT']) {
      assert.match(index, new RegExp(`process\\.env\\.${name} \\|\\| `), name);
    }
  });
});

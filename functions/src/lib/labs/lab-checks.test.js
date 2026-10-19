/**
 * The Hybrid Lab recurrence checks, as the pulse and the Labs snapshot read
 * them (#1009).
 *
 * The template check is the one that matters here: a template Coder serves
 * that is not the converged commit's is critical, a template the automation
 * never published is critical, and a report without the digests is unknown,
 * never healthy. The drift rule itself is drift.test.js's.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  CODER_TEMPLATE_PROBE,
  CODER_TOKEN_PROBE,
  LAB_CANARY_PROBE,
  LAB_DRIFT_AGENTS_QUERY,
  LAB_DRIFT_PROBE,
  PORTAINER_LICENCE_WARNING_DAYS,
  PORTAINER_PROBE,
  PORTAINER_REPORT_STALE_AFTER_MS,
  TEMPLATE_REPORT_COLD_AFTER_MS,
  coderTemplateVerdict,
  portainerVerdict,
  readCoderTemplate,
  readLabChecks,
  readLabDrift,
  readPortainer,
} from './lab-checks.js';
import { HEALTH_PROBES } from '../health/probe-catalogue.js';
import { HOST_CHECKS_DOC_ID } from './host-checks.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const nowMs = NOW.getTime();
const hoursAgo = (h) => new Date(nowMs - h * 60 * 60 * 1000).toISOString();
const PUBLISHED = 'a'.repeat(64);
const CHECKOUT = 'b'.repeat(64);

const report = (over = {}) => ({
  id: 'coder_automation',
  reportedAt: hoursAgo(3),
  checkedAt: hoursAgo(3),
  templatePushedAt: '2026-10-08T04:40:00.000Z',
  templateVersion: 'brave_turing6',
  templateDigest: PUBLISHED,
  templateSourceDigest: PUBLISHED,
  ...over,
});

describe('coderTemplateVerdict', () => {
  it('is healthy when the published template is the checkout’s', () => {
    expect(coderTemplateVerdict(report(), nowMs)).toEqual({
      status: 'healthy',
      summary:
        'Coder serves the hcw-lab template of the commit the host converged from (brave_turing6), published 2026-10-08. Reported 3 h ago.',
      detail: `published ${PUBLISHED}\ncheckout  ${PUBLISHED}`,
    });
  });

  it('is critical when the checkout moved on and the publish did not follow (finding 8)', () => {
    const verdict = coderTemplateVerdict(report({ templateSourceDigest: CHECKOUT }), nowMs);
    expect(verdict.status).toBe('critical');
    expect(verdict.summary).toMatch(
      /^Coder serves the hcw-lab template published 2026-10-08 \(brave_turing6\), which is not the template in the commit the host converged from/
    );
    expect(verdict.summary).toMatch(/hcw-coder-automation push-template/);
  });

  it('is critical when the automation never published the template', () => {
    const verdict = coderTemplateVerdict(report({ templatePushedAt: null, templateDigest: null }), nowMs);
    expect(verdict.status).toBe('critical');
    expect(verdict.summary).toMatch(/has never published the hcw-lab template/);
  });

  it('is unknown, never healthy, when the report carries no digests yet', () => {
    for (const over of [{ templateDigest: undefined }, { templateSourceDigest: undefined }, { templateSourceDigest: 'nope' }]) {
      const verdict = coderTemplateVerdict(report(over), nowMs);
      expect(verdict.status, JSON.stringify(over)).toBe('unknown');
      expect(verdict.summary).toMatch(/carries no template digests/);
    }
  });

  it('is unknown before the host has reported at all', () => {
    expect(coderTemplateVerdict(null, nowMs).status).toBe('unknown');
  });

  it('is degraded on a matching pair from a report older than the Integrations card’s silence', () => {
    const old = new Date(nowMs - TEMPLATE_REPORT_COLD_AFTER_MS - 60_000).toISOString();
    const verdict = coderTemplateVerdict(report({ reportedAt: old }), nowMs);
    expect(verdict.status).toBe('degraded');
    expect(verdict.summary).toMatch(/more than a week old/);
  });

  it('still says critical for a mismatch in an old report: the lag only grows', () => {
    const old = new Date(nowMs - TEMPLATE_REPORT_COLD_AFTER_MS - 60_000).toISOString();
    expect(coderTemplateVerdict(report({ reportedAt: old, templateSourceDigest: CHECKOUT }), nowMs).status).toBe(
      'critical'
    );
  });
});

describe('the readers', () => {
  const store = (docs = {}, agents = []) => ({
    readDoc: vi.fn(async (_c, id) => docs[id] ?? null),
    queryDocs: vi.fn(async () => agents),
  });

  it('are named by the Health Hub probes they answer, live and readable by a viewer', () => {
    for (const id of [LAB_DRIFT_PROBE, CODER_TEMPLATE_PROBE, LAB_CANARY_PROBE, CODER_TOKEN_PROBE, PORTAINER_PROBE]) {
      expect(HEALTH_PROBES[id], id).toEqual({ kind: 'live', writeRole: 'viewer' });
    }
  });

  it('readLabDrift reads the applied commits and main’s record, or uses the rows it is given', async () => {
    const s = store({}, [{ id: 'vps-1', active: true, applied: null }]);
    expect((await readLabDrift(s, nowMs)).status).toBe('critical');
    expect(s.queryDocs).toHaveBeenCalledWith('lab_agents', LAB_DRIFT_AGENTS_QUERY, []);
    expect(s.readDoc).toHaveBeenCalledWith('admin_config', 'lab_drift', 'admin_config');

    const given = store();
    await readLabDrift(given, nowMs, [{ id: 'vps-1', active: true }]);
    expect(given.queryDocs).not.toHaveBeenCalled();
  });

  it('readCoderTemplate reads the host’s Coder upkeep report', async () => {
    const s = store({ coder_automation: report() });
    expect((await readCoderTemplate(s, nowMs)).status).toBe('healthy');
    expect(s.readDoc).toHaveBeenCalledWith('admin_config', 'coder_automation', 'admin_config');
  });

  it('readPortainer reads the host checks document and judges its portainer entry; no document is "not reported"', async () => {
    const absent = store();
    expect((await readPortainer(absent, nowMs)).status).toBe('unknown');
    expect(absent.readDoc).toHaveBeenCalledWith('admin_config', HOST_CHECKS_DOC_ID, 'admin_config');

    const s = store({
      [HOST_CHECKS_DOC_ID]: {
        id: HOST_CHECKS_DOC_ID,
        checks: {
          portainer: {
            checkedAt: hoursAgo(0),
            up: true,
            version: '2.45.2',
            edition: 'EE',
            licenseValid: true,
            licenseExpiresAt: '2027-09-26T00:00:00.000Z',
            environmentName: 'local',
            environmentUp: true,
            containers: { total: 10, running: 8, unhealthy: 0, restarting: 0, exited: 2 },
            imagesChecked: 8,
            imagesOutdated: 0,
            error: null,
            receivedAt: hoursAgo(0),
          },
        },
      },
    });
    expect((await readPortainer(s, nowMs)).status).toBe('healthy');
  });

  it('readLabChecks answers every check by probe id, and a failed read is that check’s unknown alone', async () => {
    const s = store({ coder_automation: report() });
    s.readDoc.mockImplementation(async (_c, id) => {
      if (id === 'lab_drift') throw new Error('Cosmos said 503');
      return report();
    });
    const { checks, drift } = await readLabChecks(s, nowMs, [{ id: 'vps-1', active: true }]);
    expect(Object.keys(checks).sort()).toEqual(
      [CODER_TEMPLATE_PROBE, CODER_TOKEN_PROBE, LAB_CANARY_PROBE, LAB_DRIFT_PROBE, PORTAINER_PROBE].sort()
    );
    // The Coder report document carries no portainer entry, so the check is
    // "not reported" rather than a failed read.
    expect(checks[PORTAINER_PROBE].status).toBe('unknown');
    expect(checks[PORTAINER_PROBE].summary).toMatch(/^Portainer has not reported/);
    expect(checks[LAB_DRIFT_PROBE]).toEqual({
      status: 'unknown',
      summary: "The check's data could not be read (Error).",
      detail: null,
    });
    expect(drift.agents).toEqual({});
    expect(checks[CODER_TEMPLATE_PROBE].status).toBe('healthy');
  });

  it('keeps the per-agent lines out of the check, for the cards alone', async () => {
    const s = store();
    const { checks, drift } = await readLabChecks(s, nowMs, [{ id: 'vps-1', active: true }]);
    expect(checks[LAB_DRIFT_PROBE]).not.toHaveProperty('agents');
    expect(drift.agents['vps-1'].status).toBe('critical');
  });
});

describe('portainerVerdict (#1282)', () => {
  const minutesAgo = (m) => new Date(nowMs - m * 60 * 1000).toISOString();
  const daysAhead = (d) => new Date(nowMs + d * 24 * 60 * 60 * 1000).toISOString();
  // The host's reading as host-checks.js stores it: counts and states, and
  // the site's time of receipt.
  const entry = (over = {}) => ({
    checkedAt: minutesAgo(4),
    up: true,
    version: '2.45.2',
    edition: 'EE',
    licenseValid: true,
    licenseExpiresAt: '2027-09-26T00:00:00.000Z',
    environmentName: 'local',
    environmentUp: true,
    containers: { total: 10, running: 8, unhealthy: 0, restarting: 0, exited: 2 },
    imagesChecked: 8,
    imagesOutdated: 0,
    error: null,
    receivedAt: minutesAgo(3),
    ...over,
  });

  it('is unknown, naming the seeding step, before the host has reported', () => {
    for (const none of [null, undefined]) {
      expect(portainerVerdict(none, nowMs)).toEqual({
        status: 'unknown',
        summary: "Portainer has not reported: the host's check needs vault_portainer_api_token (lab-host/README.md, Portainer).",
        detail: null,
      });
    }
  });

  it('is healthy with the numbers when everything is as it should be', () => {
    expect(portainerVerdict(entry(), nowMs)).toEqual({
      status: 'healthy',
      summary: 'Portainer 2.45.2 EE, local Up, 8 containers running, images current, licence to 2027-09-26; read 3 min ago.',
      detail: [
        'Portainer 2.45.2 EE',
        'environment local up',
        'containers 10 total, 8 running, 0 unhealthy, 0 restarting, 2 exited',
        'images 8 checked, 0 outdated',
        'licence valid, expires 2027-09-26',
        `read ${minutesAgo(4)}, received ${minutesAgo(3)}`,
      ].join('\n'),
    });
  });

  it('is critical, naming the timer, when the last report is older than three missed runs', () => {
    const stale = new Date(nowMs - PORTAINER_REPORT_STALE_AFTER_MS - 60_000).toISOString();
    const verdict = portainerVerdict(entry({ receivedAt: stale }), nowMs);
    expect(verdict.status).toBe('critical');
    expect(verdict.summary).toBe(
      `No Portainer report since ${stale} (46 min ago); the host's hcw-portainer-check timer is not running or cannot reach the site.`
    );
    // Exactly at the window it is still evidence.
    const edge = new Date(nowMs - PORTAINER_REPORT_STALE_AFTER_MS).toISOString();
    expect(portainerVerdict(entry({ receivedAt: edge }), nowMs).status).toBe('healthy');
    // An entry with no time of receipt cannot be fresh.
    const { receivedAt: _r, ...noReceipt } = entry();
    expect(portainerVerdict(noReceipt, nowMs).summary).toMatch(/^No Portainer report since an unknown time;/);
  });

  it('is critical with the reason when Portainer did not answer, the check failed, or the local environment is down', () => {
    const down = portainerVerdict(
      entry({ up: false, version: null, edition: null, environmentUp: false, error: 'connection refused on the loopback' }),
      nowMs
    );
    expect(down.status).toBe('critical');
    expect(down.summary).toBe('Portainer on the lab host did not answer its check 3 min ago: connection refused on the loopback.');
    expect(down.detail).toMatch(/^Portainer \(not answering\)\nenvironment local down\n/);

    expect(portainerVerdict(entry({ up: false, error: null }), nowMs).summary).toMatch(/: no reason recorded\.$/);

    const failed = portainerVerdict(entry({ error: 'HTTP 500 on /api/endpoints' }), nowMs);
    expect(failed.status).toBe('critical');
    expect(failed.summary).toBe('Portainer answered but its check failed 3 min ago: HTTP 500 on /api/endpoints.');

    const environment = portainerVerdict(entry({ environmentUp: false }), nowMs);
    expect(environment.status).toBe('critical');
    expect(environment.summary).toBe(
      "Portainer is up but its local environment is down 3 min ago, so it cannot reach the host's Docker engine."
    );
  });

  it('is degraded naming the counts when a container is unhealthy or restarting', () => {
    const verdict = portainerVerdict(
      entry({ containers: { total: 10, running: 8, unhealthy: 1, restarting: 2, exited: 0 } }),
      nowMs
    );
    expect(verdict.status).toBe('degraded');
    expect(verdict.summary).toBe('1 unhealthy and 2 restarting of 10 containers on the lab host, as Portainer saw them 3 min ago.');
  });

  it('is degraded naming the count when running images have an update available', () => {
    const verdict = portainerVerdict(entry({ imagesOutdated: 3 }), nowMs);
    expect(verdict.status).toBe('degraded');
    expect(verdict.summary).toBe('3 of 8 running images have an update available in their registry.');
  });

  it('is degraded when the licence is invalid, or ends within 30 days measured from now', () => {
    const invalid = portainerVerdict(entry({ licenseValid: false }), nowMs);
    expect(invalid.status).toBe('degraded');
    expect(invalid.summary).toBe(
      'Portainer reports its licence as not valid (expiry 2027-09-26); renew it before the Business Edition features lapse.'
    );

    const soon = portainerVerdict(entry({ licenseExpiresAt: daysAhead(29) }), nowMs);
    expect(soon.status).toBe('degraded');
    expect(soon.summary).toBe(`Portainer's licence expires ${daysAhead(29).slice(0, 10)}, in 29 days; renew it before then.`);

    const lapsed = portainerVerdict(entry({ licenseExpiresAt: daysAhead(-1) }), nowMs);
    expect(lapsed.status).toBe('degraded');
    expect(lapsed.summary).toBe(`Portainer's licence expired ${daysAhead(-1).slice(0, 10)}; renew it.`);

    expect(portainerVerdict(entry({ licenseExpiresAt: daysAhead(PORTAINER_LICENCE_WARNING_DAYS + 1) }), nowMs).status).toBe('healthy');
  });

  it('names every degraded reason at once, so one does not hide another', () => {
    const verdict = portainerVerdict(
      entry({
        containers: { total: 10, running: 8, unhealthy: 1, restarting: 0, exited: 1 },
        imagesOutdated: 2,
        licenseValid: false,
      }),
      nowMs
    );
    expect(verdict.status).toBe('degraded');
    expect(verdict.summary).toMatch(/^1 unhealthy and 0 restarting of 10 containers/);
    expect(verdict.summary).toMatch(/2 of 8 running images have an update available/);
    expect(verdict.summary).toMatch(/licence as not valid/);
  });

  it('says what a Community Edition reading cannot say: no image check, no licence', () => {
    const verdict = portainerVerdict(
      entry({ edition: 'CE', imagesChecked: null, imagesOutdated: null, licenseValid: null, licenseExpiresAt: null }),
      nowMs
    );
    expect(verdict).toEqual({
      status: 'healthy',
      summary: 'Portainer 2.45.2 CE, local Up, 8 containers running, images not checked, no licence reported; read 3 min ago.',
      detail: [
        'Portainer 2.45.2 CE',
        'environment local up',
        'containers 10 total, 8 running, 0 unhealthy, 0 restarting, 2 exited',
        'images not checked',
        'licence not reported',
        `read ${minutesAgo(4)}, received ${minutesAgo(3)}`,
      ].join('\n'),
    });
    expect(portainerVerdict(entry({ imagesChecked: 0, imagesOutdated: 0 }), nowMs).summary).toMatch(/no running image to check/);
    expect(portainerVerdict(entry({ licenseExpiresAt: null }), nowMs).summary).toMatch(/licence valid; read/);
  });

  it('never throws on odd data, and the detail carries counts and states only', () => {
    const odd = portainerVerdict({ receivedAt: minutesAgo(1), up: true, environmentUp: true }, nowMs);
    expect(odd.status).toBe('healthy');
    expect(odd.summary).toBe('Portainer, local Up, 0 containers running, images not checked, no licence reported; read 1 min ago.');
    expect(odd.detail).toMatch(/containers \? total, \? running/);
  });
});

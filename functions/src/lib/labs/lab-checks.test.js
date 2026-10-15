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
  TEMPLATE_REPORT_COLD_AFTER_MS,
  coderTemplateVerdict,
  readCoderTemplate,
  readLabChecks,
  readLabDrift,
} from './lab-checks.js';
import { HEALTH_PROBES } from '../health/probe-catalogue.js';

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
    for (const id of [LAB_DRIFT_PROBE, CODER_TEMPLATE_PROBE]) {
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

  it('readLabChecks answers both by probe id, and a failed read is that check’s unknown alone', async () => {
    const s = store({ coder_automation: report() });
    s.readDoc.mockImplementation(async (_c, id) => {
      if (id === 'lab_drift') throw new Error('Cosmos said 503');
      return report();
    });
    const { checks, drift } = await readLabChecks(s, nowMs, [{ id: 'vps-1', active: true }]);
    expect(Object.keys(checks).sort()).toEqual(
      [CODER_TEMPLATE_PROBE, CODER_TOKEN_PROBE, LAB_CANARY_PROBE, LAB_DRIFT_PROBE].sort()
    );
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

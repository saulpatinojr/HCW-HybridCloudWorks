import { describe, expect, it } from 'vitest';
import { LIVE_STATUSES, orphanReason, parseWindows, readRun, run } from './check-ci-access-windows.mjs';

const ENV = { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'o/r' };

/** An `access-restriction show` document with these rules on each site. */
const restrictions = ({ site = [], scm = [] } = {}) =>
  JSON.stringify({
    ipSecurityRestrictionsDefaultAction: 'Deny',
    ipSecurityRestrictions: [
      { name: 'cloudflare-0', action: 'Allow', ipAddress: '173.245.48.0/20', priority: 100 },
      ...site.map((name) => ({ name, action: 'Allow', ipAddress: '203.0.113.7/32', priority: 300 })),
      { name: 'Deny all', action: 'Deny', ipAddress: '0.0.0.0/0', priority: 2147483647 },
    ],
    scmIpSecurityRestrictions: scm.map((name) => ({
      name,
      action: 'Allow',
      ipAddress: '203.0.113.8/32',
      priority: 300,
    })),
  });

/** A fake Actions API: each run id answers with its run, or 404 when absent. */
function github(runs) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const id = /\/actions\/runs\/(\d+)$/.exec(url)?.[1];
    const body = id ? runs[id] : undefined;
    if (body === 'boom') return { ok: false, status: 502, json: async () => ({}) };
    if (!body) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

describe('parseWindows', () => {
  it('finds the ci-* rules on both sites, with the run id each name ends in', () => {
    const text = restrictions({ site: ['ci-smoke-111', 'ci-manifest-222'], scm: ['ci-deploy-scm-333'] });
    expect(parseWindows(text)).toEqual([
      { name: 'ci-smoke-111', site: 'site', runId: '111' },
      { name: 'ci-manifest-222', site: 'site', runId: '222' },
      { name: 'ci-deploy-scm-333', site: 'SCM site', runId: '333' },
    ]);
  });

  it('ignores Terraform’s cloudflare-* rules and the deny-all', () => {
    expect(parseWindows(restrictions())).toEqual([]);
  });

  it('keeps a ci-* rule with no run id, with a null id', () => {
    expect(parseWindows(restrictions({ site: ['ci-hand-made'] }))).toEqual([
      { name: 'ci-hand-made', site: 'site', runId: null },
    ]);
  });

  it('reads a document with no SCM list, which a site without SCM rules may return', () => {
    const doc = JSON.parse(restrictions({ site: ['ci-smoke-1'] }));
    delete doc.scmIpSecurityRestrictions;
    expect(parseWindows(JSON.stringify(doc))).toHaveLength(1);
  });

  it('refuses anything that is not the document', () => {
    expect(() => parseWindows('not json')).toThrow(/not JSON/);
    expect(() => parseWindows('{}')).toThrow(/no `ipSecurityRestrictions` list/);
  });
});

describe('orphanReason', () => {
  const win = { name: 'ci-smoke-9', site: 'site', runId: '9' };

  it.each(LIVE_STATUSES)('leaves a window alone while its run is %s', (status) => {
    expect(orphanReason(win, { status, conclusion: null })).toBeNull();
  });

  it('names a window whose run has ended, with the conclusion', () => {
    expect(orphanReason(win, { status: 'completed', conclusion: 'cancelled' })).toBe(
      'run 9 has ended (completed, cancelled)'
    );
  });

  it('names a window whose run does not exist, and one whose name carries no run id', () => {
    expect(orphanReason(win, { status: 'missing', conclusion: null })).toMatch(/does not exist/);
    expect(orphanReason({ ...win, runId: null }, { status: 'unknown' })).toMatch(/no run id/);
  });
});

describe('readRun', () => {
  it('sends the token and reads the run’s status, conclusion and page', async () => {
    const { fetchImpl, calls } = github({
      7: { status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/7' },
    });
    await expect(readRun({ runId: '7', token: 't0ken', owner: 'o', repo: 'r', fetchImpl })).resolves.toEqual({
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/o/r/actions/runs/7',
    });
    expect(calls).toEqual([{ url: 'https://api.github.com/repos/o/r/actions/runs/7', auth: 'Bearer t0ken' }]);
  });

  it('reads a 404 as a missing run and throws on anything else', async () => {
    const { fetchImpl } = github({ 8: 'boom' });
    await expect(readRun({ runId: '1', token: 't', owner: 'o', repo: 'r', fetchImpl })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readRun({ runId: '8', token: 't', owner: 'o', repo: 'r', fetchImpl })).rejects.toThrow(/502/);
  });
});

describe('run', () => {
  it('passes, without asking GitHub, when no ci-* window is open', async () => {
    const { fetchImpl, calls } = github({});
    expect(await run({ input: restrictions(), env: ENV, fetchImpl })).toEqual({ code: 0, lines: ['none open'] });
    expect(calls).toHaveLength(0);
  });

  it('passes while every open window is held by a run in progress (a concurrent deploy)', async () => {
    const { fetchImpl } = github({ 5: { status: 'in_progress', conclusion: null } });
    const result = await run({ input: restrictions({ scm: ['ci-deploy-scm-5'] }), env: ENV, fetchImpl });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('none orphaned (1 open, each held by a run in progress)');
  });

  it('fails naming each window a dead run left open, and leaves the live one out', async () => {
    const { fetchImpl } = github({
      5: { status: 'in_progress', conclusion: null },
      6: { status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com/o/r/actions/runs/6' },
    });
    const input = restrictions({ site: ['ci-smoke-6', 'ci-manifest-404'], scm: ['ci-deploy-scm-5'] });
    const result = await run({ input, env: ENV, fetchImpl });
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      '2 orphaned: ci-smoke-6, ci-manifest-404',
      '- `ci-smoke-6` on the site: run 6 has ended (completed, cancelled) (https://github.com/o/r/actions/runs/6).',
      '- `ci-manifest-404` on the site: run 404 does not exist in this repository.',
    ]);
  });

  it('gives the exact command that removes each orphan when the step names the app (APP, RG)', async () => {
    const { fetchImpl } = github({ 6: { status: 'completed', conclusion: 'failure' } });
    const input = restrictions({ site: ['ci-smoke-6'], scm: ['ci-deploy-scm-6'] });
    const env = { ...ENV, APP: 'func-site-prod-cus-01', RG: 'rg-web-site-prod-cus' };
    const { lines } = await run({ input, env, fetchImpl });
    expect(lines[1]).toBe(
      '- `ci-smoke-6` on the site: run 6 has ended (completed, failure). Remove it: ' +
        '`az functionapp config access-restriction remove -n func-site-prod-cus-01 -g rg-web-site-prod-cus --rule-name ci-smoke-6`'
    );
    expect(lines[2]).toMatch(/--rule-name ci-deploy-scm-6 --scm-site true`$/);
  });

  it('cannot run without the token and repository, or when GitHub fails, and says so', async () => {
    const input = restrictions({ site: ['ci-smoke-1'] });
    expect((await run({ input, env: {}, fetchImpl: github({}).fetchImpl })).code).toBe(2);
    const broken = await run({ input, env: ENV, fetchImpl: github({ 1: 'boom' }).fetchImpl });
    expect(broken.code).toBe(2);
    expect(broken.lines[1]).toMatch(/`ci-smoke-1` could not be read: GitHub answered 502/);
    expect((await run({ input: 'nope', env: ENV })).lines[0]).toBe('unreadable');
  });
});

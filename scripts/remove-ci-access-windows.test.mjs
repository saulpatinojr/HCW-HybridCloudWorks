import { describe, expect, it } from 'vitest';
import { LIVE_STATUSES } from './check-ci-access-windows.mjs';
import { decideStorage, decideWindow, formatUnreadable, parseNetworkRuleSet, run } from './remove-ci-access-windows.mjs';

const ENV = { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'o/r', APP: 'func-site-prod-cus-01', RG: 'rg-web-site-prod-cus' };
const DEPLOY_RUNS = '/actions/workflows/deploy-functions.yml/runs';

/** An `access-restriction show` document with these rules on each site. */
const restrictions = ({ site = [], scm = [] } = {}) =>
  JSON.stringify({
    ipSecurityRestrictions: [
      { name: 'cloudflare-0', action: 'Allow', ipAddress: '173.245.48.0/20', priority: 100 },
      ...site.map((rule) => (typeof rule === 'string' ? { name: rule, action: 'Allow', ipAddress: '203.0.113.7/32', priority: 300 } : rule)),
      { name: 'Deny all', action: 'Deny', ipAddress: '0.0.0.0/0', priority: 2147483647 },
    ],
    scmIpSecurityRestrictions: scm.map((name) => ({ name, action: 'Allow', ipAddress: '203.0.113.8/32', priority: 300 })),
  });

/** A storage account's `networkRuleSet`. */
const network = ({ defaultAction = 'Deny', ips = [] } = {}) =>
  JSON.stringify({ bypass: 'AzureServices', defaultAction, ipRules: ips.map((ip) => ({ action: 'Allow', ipAddressOrRange: ip })), virtualNetworkRules: [] });

/**
 * A fake Actions API: each run id answers with its run (404 when absent), and
 * the deploy-runs listing answers with `deploys`.
 */
function github(runs, deploys = []) {
  const fetchImpl = async (url) => {
    if (url.includes(DEPLOY_RUNS)) return { ok: true, status: 200, json: async () => ({ workflow_runs: deploys }) };
    const id = /\/actions\/runs\/(\d+)$/.exec(url)?.[1];
    const body = id ? runs[id] : undefined;
    if (body === 'boom') return { ok: false, status: 502, json: async () => ({}) };
    if (!body) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: true, status: 200, json: async () => body };
  };
  return fetchImpl;
}

/**
 * A stand-in `az`: answers reads from `state`, records every write, and
 * fails the writes whose joined arguments match `failing` (every time, or
 * the first `failing.times` times).
 */
function fakeAz({ site = restrictions(), storage = network(), failing = null } = {}) {
  const writes = [];
  let failures = 0;
  const az = async (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('functionapp config access-restriction show')) return site;
    if (joined.startsWith('storage account show')) return storage;
    writes.push(joined);
    if (failing && failing.match.test(joined) && (failing.times === undefined || failures < failing.times)) {
      failures += 1;
      const error = new Error('az failed');
      error.stderr = failing.stderr ?? 'ERROR: (StorageAccountOperationInProgress) An operation is currently performing on this storage account\nmore';
      throw error;
    }
    return '';
  };
  return { az, writes };
}

const noSleep = { sleep: async () => {}, pauses: [0, 0] };

describe('decideWindow', () => {
  const win = { name: 'ci-smoke-9', site: 'site', runId: '9' };

  it.each(LIVE_STATUSES)('leaves a window alone while its run is %s (the run will close it)', (status) => {
    expect(decideWindow(win, { status, conclusion: null })).toEqual({ action: 'keep', reason: `run 9 is ${status.replace('_', ' ')} and will close it` });
  });

  it('removes a window whose run has ended, saying how it ended', () => {
    expect(decideWindow(win, { status: 'completed', conclusion: 'cancelled' })).toEqual({
      action: 'remove',
      reason: 'run 9 has ended (completed, cancelled)',
    });
  });

  it('removes a window whose run no longer exists: nothing else can', () => {
    expect(decideWindow(win, { status: 'missing', conclusion: null })).toMatchObject({ action: 'remove' });
  });

  it('leaves a rule that names no run alone and reports it: a person placed it, so a person decides', () => {
    const decision = decideWindow({ name: 'ci-hand-made', site: 'site', runId: null }, { status: 'unknown' });
    expect(decision.action).toBe('report');
    expect(decision.reason).toMatch(/names no run/);
  });
});

describe('decideStorage', () => {
  it('keeps a closed account closed', () => {
    expect(decideStorage({ defaultAction: 'Deny', ipRules: [] }, [])).toMatchObject({ action: 'keep', setDeny: false, removeAddresses: [] });
  });

  it('restores an account left at Allow with a stale runner rule when no deploy is in progress', () => {
    const decision = decideStorage({ defaultAction: 'Allow', ipRules: [{ ipAddressOrRange: '203.0.113.7' }] }, []);
    expect(decision).toMatchObject({ action: 'restore', setDeny: true, removeAddresses: ['203.0.113.7'] });
    expect(decision.reason).toBe('default action Allow and 1 IP rule(s) with no functions deploy in progress');
  });

  it('restores the default action alone when only that is open, and the rules alone when only those are', () => {
    expect(decideStorage({ defaultAction: 'Allow', ipRules: [] }, [])).toMatchObject({ action: 'restore', setDeny: true, removeAddresses: [] });
    expect(decideStorage({ defaultAction: 'Deny', ipRules: [{ ipAddressOrRange: '198.51.100.4' }] }, [])).toMatchObject({
      action: 'restore',
      setDeny: false,
      removeAddresses: ['198.51.100.4'],
    });
  });

  it('leaves an open account alone while a functions deploy is in progress: that run closes its own window', () => {
    const decision = decideStorage({ defaultAction: 'Allow', ipRules: [{ ipAddressOrRange: '203.0.113.7' }] }, [{ id: 1, run_number: 312 }]);
    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('default action Allow and 1 IP rule(s), held by deploy run #312 in progress; that run closes its own window');
  });
});

describe('parseNetworkRuleSet', () => {
  it('reads the firewall and refuses anything that is not it', () => {
    expect(parseNetworkRuleSet(network({ defaultAction: 'Allow', ips: ['203.0.113.7'] }))).toMatchObject({ defaultAction: 'Allow' });
    expect(() => parseNetworkRuleSet('nope')).toThrow(/not JSON/);
    expect(() => parseNetworkRuleSet('{}')).toThrow(/no `defaultAction`/);
    expect(() => parseNetworkRuleSet('{"defaultAction":"Deny"}')).toThrow(/no `ipRules`/);
  });
});

describe('run', () => {
  it('writes nothing and says so when no ci-* window is open and the storage account is closed', async () => {
    const { az, writes } = fakeAz();
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01' }, az, fetchImpl: github({}), ...noSleep });
    expect(result).toEqual({ code: 0, lines: ['nothing left open', '- storage account `stsiteprodcus01`: default action Deny and no IP rules; nothing is open.'] });
    expect(writes).toEqual([]);
  });

  it('removes the windows of finished runs, leaves a live run’s window and a hand-made rule alone, and names each', async () => {
    const { az, writes } = fakeAz({
      site: restrictions({ site: ['ci-smoke-6', 'ci-manifest-404', 'ci-hand-made'], scm: ['ci-deploy-scm-5', 'ci-deploy-scm-6'] }),
    });
    const fetchImpl = github({
      5: { status: 'in_progress', conclusion: null, html_url: 'https://github.com/o/r/actions/runs/5' },
      6: { status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com/o/r/actions/runs/6' },
    });
    const result = await run({ env: ENV, az, fetchImpl, ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      '3 removed, 1 left alone (run in progress), 1 left for a person',
      '- `ci-smoke-6` on the site: removed, run 6 has ended (completed, cancelled) (https://github.com/o/r/actions/runs/6).',
      '- `ci-manifest-404` on the site: removed, run 404 does not exist in this repository.',
      '- `ci-hand-made` on the site: left alone, it names no run, in its name or its description, so no run opened it; left for a person to read.',
      '- `ci-deploy-scm-5` on the SCM site: left alone, run 5 is in progress and will close it (https://github.com/o/r/actions/runs/5).',
      '- `ci-deploy-scm-6` on the SCM site: removed, run 6 has ended (completed, cancelled) (https://github.com/o/r/actions/runs/6).',
    ]);
    // Exactly the three removals, each by name, the SCM one with --scm-site.
    expect(writes).toEqual([
      'functionapp config access-restriction remove -g rg-web-site-prod-cus -n func-site-prod-cus-01 --rule-name ci-smoke-6 --output none',
      'functionapp config access-restriction remove -g rg-web-site-prod-cus -n func-site-prod-cus-01 --rule-name ci-manifest-404 --output none',
      'functionapp config access-restriction remove -g rg-web-site-prod-cus -n func-site-prod-cus-01 --rule-name ci-deploy-scm-6 --output none --scm-site true',
    ]);
  });

  it('puts the storage account back (Deny first, then each IP rule) when it is open and no deploy is in progress', async () => {
    const { az, writes } = fakeAz({ storage: network({ defaultAction: 'Allow', ips: ['203.0.113.7', '203.0.113.8'] }) });
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01' }, az, fetchImpl: github({}, []), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      '1 removed',
      '- storage account `stsiteprodcus01`: restored (default action set to Deny, IP rule 1 of 2 removed, IP rule 2 of 2 removed), default action Allow and 2 IP rule(s) with no functions deploy in progress.',
    ]);
    expect(writes).toEqual([
      'storage account update -g rg-web-site-prod-cus -n stsiteprodcus01 --default-action Deny --output none',
      'storage account network-rule remove -g rg-web-site-prod-cus --account-name stsiteprodcus01 --ip-address 203.0.113.7 --output none',
      'storage account network-rule remove -g rg-web-site-prod-cus --account-name stsiteprodcus01 --ip-address 203.0.113.8 --output none',
    ]);
  });

  it('leaves an open storage account alone while a deploy run is in progress, and asks GitHub only then', async () => {
    const { az, writes } = fakeAz({ storage: network({ defaultAction: 'Allow', ips: ['203.0.113.7'] }) });
    const deploys = [{ id: 1, run_number: 312, status: 'in_progress', html_url: 'https://github.com/o/r/actions/runs/1' }];
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01' }, az, fetchImpl: github({}, deploys), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('1 left alone (run in progress)');
    expect(result.lines[1]).toMatch(/held by deploy run #312 in progress/);
    expect(writes).toEqual([]);
  });

  it('retries a refused write (Azure’s 409 while an earlier update runs) and succeeds on a later try', async () => {
    const { az, writes } = fakeAz({ storage: network({ defaultAction: 'Allow' }), failing: { match: /default-action Deny/, times: 2 } });
    const slept = [];
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01' }, az, fetchImpl: github({}, []), sleep: async (ms) => slept.push(ms), pauses: [5000, 20000] });
    expect(result.code).toBe(0);
    expect(slept).toEqual([5000, 20000]);
    expect(writes.filter((w) => w.includes('default-action Deny'))).toHaveLength(3);
  });

  it('fails, naming the step, when a write keeps being refused, and keeps the rest of its work', async () => {
    const { az } = fakeAz({
      site: restrictions({ site: ['ci-smoke-6'] }),
      storage: network({ defaultAction: 'Allow' }),
      failing: { match: /default-action Deny/, stderr: 'ERROR: (AuthorizationFailed) The client does not have authorization to perform action' },
    });
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01' }, az, fetchImpl: github({ 6: { status: 'completed', conclusion: 'failure' } }, []), ...noSleep });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe('1 removed, 1 FAILED');
    expect(result.lines[1]).toBe('- `ci-smoke-6` on the site: removed, run 6 has ended (completed, failure).');
    expect(result.lines[2]).toBe(
      '- storage account `stsiteprodcus01`: NOT fully restored (default action Allow with no functions deploy in progress): ' +
        '"default action set to Deny" failed: ERROR: (AuthorizationFailed) The client does not have authorization to perform action'
    );
  });

  it('writes nothing in a dry run and says what it would do', async () => {
    const { az, writes } = fakeAz({ site: restrictions({ site: ['ci-smoke-6'] }), storage: network({ defaultAction: 'Allow' }) });
    const fetchImpl = github({ 6: { status: 'completed', conclusion: 'failure' } }, []);
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01', DRY_RUN: '1' }, az, fetchImpl, ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('dry run: 2 would remove');
    expect(result.lines[1]).toMatch(/would remove/);
    expect(result.lines[2]).toMatch(/would be restored/);
    expect(writes).toEqual([]);
  });

  it('cannot run without its inputs, or when Azure or GitHub cannot be read, and writes nothing then', async () => {
    expect((await run({ env: {}, az: fakeAz().az })).code).toBe(2);
    expect((await run({ env: { APP: 'a', RG: 'g' }, az: fakeAz().az })).lines[1]).toMatch(/GITHUB_TOKEN/);

    const broken = { az: async () => { const e = new Error('x'); e.stderr = 'ERROR: (AuthorizationFailed) no\n'; throw e; } };
    const unreadable = await run({ env: ENV, ...broken, fetchImpl: github({}) });
    expect(unreadable.code).toBe(2);
    expect(unreadable.lines[1]).toMatch(/access restrictions could not be read: ERROR: \(AuthorizationFailed\) no/);

    const { az, writes } = fakeAz({ site: restrictions({ site: ['ci-smoke-1'] }) });
    const github502 = await run({ env: ENV, az, fetchImpl: github({ 1: 'boom' }), ...noSleep });
    expect(github502.code).toBe(2);
    expect(github502.lines[1]).toMatch(/`ci-smoke-1` could not be read: GitHub answered 502/);
    expect(writes).toEqual([]);

    const badStorage = await run({ env: { ...ENV, STOR: 's' }, az: fakeAz({ storage: 'nope' }).az, fetchImpl: github({}), ...noSleep });
    expect(badStorage.code).toBe(2);
    expect(badStorage.lines[1]).toMatch(/storage account's firewall could not be read/);
  });

  it('leaves an open storage account alone when the deploy history cannot be read', async () => {
    const { az, writes } = fakeAz({ storage: network({ defaultAction: 'Allow' }) });
    const fetchImpl = async (url) => (url.includes(DEPLOY_RUNS) ? { ok: false, status: 503, json: async () => ({}) } : { ok: false, status: 404, json: async () => ({}) });
    const result = await run({ env: { ...ENV, STOR: 'stsiteprodcus01' }, az, fetchImpl, ...noSleep });
    expect(result.code).toBe(2);
    expect(result.lines[1]).toMatch(/open storage firewall was left as it is/);
    expect(writes).toEqual([]);
  });

  it('formats an unreadable verdict as exit 2', () => {
    expect(formatUnreadable('why')).toEqual({ code: 2, lines: ['unreadable', expect.stringContaining('why')] });
  });
});

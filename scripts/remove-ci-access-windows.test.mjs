import { describe, expect, it } from 'vitest';
import { LIVE_STATUSES } from './check-ci-access-windows.mjs';
import { decideStorage, decideWindow, formatUnreadable, parseStorage, parseWindowTag, run } from './remove-ci-access-windows.mjs';

const ENV = { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'o/r', APP: 'func-site-prod-cus-01', RG: 'rg-web-site-prod-cus' };
const STOR = { ...ENV, STOR: 'stsiteprodcus01' };
const IP = '203.0.113.7';

/** An `access-restriction show` document with these rules on each site. */
const restrictions = ({ site = [], scm = [] } = {}) =>
  JSON.stringify({
    ipSecurityRestrictions: [
      { name: 'cloudflare-0', action: 'Allow', ipAddress: '173.245.48.0/20', priority: 100 },
      ...site.map((name) => ({ name, action: 'Allow', ipAddress: '203.0.113.7/32', priority: 300 })),
      { name: 'Deny all', action: 'Deny', ipAddress: '0.0.0.0/0', priority: 2147483647 },
    ],
    scmIpSecurityRestrictions: scm.map((name) => ({ name, action: 'Allow', ipAddress: '203.0.113.8/32', priority: 300 })),
  });

/** The storage account as the script's query returns it: firewall and window tag. */
const storage = ({ defaultAction = 'Deny', ips = [], window = null } = {}) =>
  JSON.stringify({ defaultAction, ipRules: ips.map((ip) => ({ action: 'Allow', ipAddressOrRange: ip })), window });

/** A fake Actions API: each run id answers with its run, or 404 when absent. */
function github(runs) {
  return async (url) => {
    const id = /\/actions\/runs\/(\d+)$/.exec(url)?.[1];
    const body = id ? runs[id] : undefined;
    if (body === 'boom') return { ok: false, status: 502, json: async () => ({}) };
    if (!body) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: true, status: 200, json: async () => body };
  };
}

/**
 * A stand-in `az`: answers reads from its state, records every write, and
 * fails the writes whose joined arguments match `failing` (every time, or
 * the first `failing.times` times). `onWrite` may change the state after a
 * write, to play a deploy starting mid-run.
 */
function fakeAz({ site = restrictions(), account = storage(), failing = null, onWrite = null } = {}) {
  const writes = [];
  let failures = 0;
  const state = { site, account };
  const az = async (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('functionapp config access-restriction show')) return state.site;
    if (joined.startsWith('storage account show')) return state.account;
    writes.push(joined);
    if (failing && failing.match.test(joined) && (failing.times === undefined || failures < failing.times)) {
      failures += 1;
      const error = new Error('az failed');
      error.stderr = failing.stderr ?? 'ERROR: (StorageAccountOperationInProgress) An operation is currently performing on this storage account\nmore';
      throw error;
    }
    if (onWrite) onWrite(state, writes.length);
    return '';
  };
  return { az, writes };
}

const noSleep = { sleep: async () => {}, pauses: [0, 0] };
const ended = { status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com/o/r/actions/runs/6' };

describe('decideWindow', () => {
  const win = { name: 'ci-smoke-9', site: 'site', runId: '9' };

  it.each(LIVE_STATUSES)('leaves a window alone while its run is %s (the run will close it)', (status) => {
    expect(decideWindow(win, { status, conclusion: null })).toEqual({ action: 'keep', reason: `run 9 is ${status.replace('_', ' ')} and will close it` });
  });

  it('removes a window whose run has ended, saying how it ended', () => {
    expect(decideWindow(win, { status: 'completed', conclusion: 'cancelled' })).toEqual({ action: 'remove', reason: 'run 9 has ended (completed, cancelled)' });
  });

  it('removes a window whose run no longer exists: nothing else can', () => {
    expect(decideWindow(win, { status: 'missing', conclusion: null })).toMatchObject({ action: 'remove' });
  });

  it('removes only the three names the workflows write; any other ci-* rule is left and reported, digits or not', () => {
    for (const name of ['ci-deploy-scm-9', 'ci-manifest-9']) {
      expect(decideWindow({ name, site: 'site', runId: '9' }, { status: 'missing' }).action, name).toBe('remove');
    }
    for (const name of ['ci-hand-made', 'ci-owner-2026', 'ci-smoke-9-copy', 'ci-smoke-']) {
      const decision = decideWindow({ name, site: 'site', runId: /\d+$/.exec(name)?.[0] ?? null }, { status: 'missing' });
      expect(decision.action, name).toBe('report');
      expect(decision.reason).toMatch(/a person placed it/);
    }
  });
});

describe('parseWindowTag', () => {
  it('reads "<run id> <address>" and nothing else', () => {
    expect(parseWindowTag('38819173840 203.0.113.7')).toEqual({ runId: '38819173840', address: '203.0.113.7' });
    expect(parseWindowTag(' 42 203.0.113.7 ')).toEqual({ runId: '42', address: '203.0.113.7' });
    for (const bad of [null, '', '42', '203.0.113.7', '42 not-an-ip', 'run 42 203.0.113.7', '42 203.0.113.7 extra']) expect(parseWindowTag(bad), String(bad)).toBeNull();
  });
});

describe('decideStorage', () => {
  const closed = { defaultAction: 'Deny', ipRules: [], window: null };
  const openFor = (window) => ({ defaultAction: 'Allow', ipRules: [{ ipAddressOrRange: IP }], window });

  it('keeps a closed account closed', () => {
    expect(decideStorage(closed, null)).toMatchObject({ action: 'keep', setDeny: false, removeAddress: null });
  });

  it("reports an open account with no window tag and touches nothing: it is the operator's rule or the rollback default (infra/variables.tf)", () => {
    const operator = decideStorage({ defaultAction: 'Deny', ipRules: [{ ipAddressOrRange: '198.51.100.4' }], window: null }, null);
    expect(operator).toMatchObject({ action: 'report', setDeny: false, removeAddress: null });
    expect(operator.reason).toMatch(/1 IP rule\(s\) and no ciwindow tag.*operator window/);
    const rollback = decideStorage({ defaultAction: 'Allow', ipRules: [], window: null }, null);
    expect(rollback).toMatchObject({ action: 'report', setDeny: false, removeAddress: null });
    expect(rollback.reason).toMatch(/default action Allow and no ciwindow tag/);
  });

  it('reports a tag it cannot read, and touches nothing', () => {
    expect(decideStorage(openFor('garbage'), null)).toMatchObject({ action: 'report', setDeny: false, removeAddress: null });
  });

  it.each(LIVE_STATUSES)('leaves the window alone while the tagged run is %s', (status) => {
    const decision = decideStorage(openFor(`6 ${IP}`), { status });
    expect(decision).toMatchObject({ action: 'keep', setDeny: false, removeAddress: null });
    expect(decision.reason).toBe(`its window is run 6's, which is ${status.replace('_', ' ')} and will close it`);
  });

  it("restores the window of a run that has ended: Deny, that run's address, as its close step would", () => {
    const decision = decideStorage(openFor(`6 ${IP}`), { status: 'completed', conclusion: 'cancelled' });
    expect(decision).toMatchObject({ action: 'restore', setDeny: true, removeAddress: IP });
    expect(decision.reason).toBe("its window is run 6's and run 6 has ended (completed, cancelled); default action Allow and 1 IP rule(s)");
  });

  it('restores only what is still open: a tag left after the close ran means only the tag goes', () => {
    expect(decideStorage({ ...closed, window: `6 ${IP}` }, { status: 'completed', conclusion: 'success' })).toMatchObject({ action: 'restore', setDeny: false, removeAddress: null });
  });

  it("removes only the tagged address, never another rule beside it, and restores on a run that does not exist", () => {
    const decision = decideStorage({ defaultAction: 'Allow', ipRules: [{ ipAddressOrRange: '198.51.100.4' }, { ipAddressOrRange: IP }], window: `6 ${IP}` }, { status: 'missing' });
    expect(decision).toMatchObject({ action: 'restore', setDeny: true, removeAddress: IP });
    expect(decision.reason).toMatch(/run 6 does not exist/);
    const gone = decideStorage({ defaultAction: 'Allow', ipRules: [{ ipAddressOrRange: '198.51.100.4' }], window: `6 ${IP}` }, { status: 'missing' });
    expect(gone.removeAddress).toBeNull();
  });
});

describe('parseStorage', () => {
  it('reads the firewall and tag and refuses anything that is not them', () => {
    expect(parseStorage(storage({ defaultAction: 'Allow', ips: [IP], window: `6 ${IP}` }))).toEqual({ defaultAction: 'Allow', ipRules: [{ action: 'Allow', ipAddressOrRange: IP }], window: `6 ${IP}` });
    expect(parseStorage(storage()).window).toBeNull();
    expect(() => parseStorage('nope')).toThrow(/not JSON/);
    expect(() => parseStorage('{}')).toThrow(/no `defaultAction`/);
    expect(() => parseStorage('{"defaultAction":"Deny"}')).toThrow(/no `ipRules`/);
  });
});

describe('run', () => {
  it('writes nothing and says so when no ci-* window is open and the storage account is closed', async () => {
    const { az, writes } = fakeAz();
    const result = await run({ env: STOR, az, fetchImpl: github({}), ...noSleep });
    expect(result).toEqual({ code: 0, lines: ['nothing left open', '- storage account `stsiteprodcus01`: default action Deny, no IP rules and no window tag; nothing is open.'] });
    expect(writes).toEqual([]);
  });

  it("removes the windows of finished runs, leaves a live run's window and a hand-made rule alone, and names each", async () => {
    const { az, writes } = fakeAz({ site: restrictions({ site: ['ci-smoke-6', 'ci-manifest-404', 'ci-hand-made'], scm: ['ci-deploy-scm-5', 'ci-deploy-scm-6'] }) });
    const fetchImpl = github({ 5: { status: 'in_progress', conclusion: null, html_url: 'https://github.com/o/r/actions/runs/5' }, 6: ended });
    const result = await run({ env: ENV, az, fetchImpl, ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      '3 removed, 1 left alone (run in progress), 1 left for a person',
      '- `ci-smoke-6` on the site: removed, run 6 has ended (completed, cancelled) (https://github.com/o/r/actions/runs/6).',
      '- `ci-manifest-404` on the site: removed, run 404 does not exist in this repository.',
      '- `ci-hand-made` on the site: left alone, its name is not one a workflow writes (ci-deploy-scm-, ci-smoke- or ci-manifest- and a run id), so a person placed it; left for a person to read.',
      '- `ci-deploy-scm-5` on the SCM site: left alone, run 5 is in progress and will close it (https://github.com/o/r/actions/runs/5).',
      '- `ci-deploy-scm-6` on the SCM site: removed, run 6 has ended (completed, cancelled) (https://github.com/o/r/actions/runs/6).',
    ]);
    expect(writes).toEqual([
      'functionapp config access-restriction remove -g rg-web-site-prod-cus -n func-site-prod-cus-01 --rule-name ci-smoke-6 --output none',
      'functionapp config access-restriction remove -g rg-web-site-prod-cus -n func-site-prod-cus-01 --rule-name ci-manifest-404 --output none',
      'functionapp config access-restriction remove -g rg-web-site-prod-cus -n func-site-prod-cus-01 --rule-name ci-deploy-scm-6 --output none --scm-site true',
    ]);
  });

  it('does not ask GitHub about a rule it will not remove anyway', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await run({ env: ENV, az: fakeAz({ site: restrictions({ site: ['ci-owner-2026'] }) }).az, fetchImpl, ...noSleep });
    expect(asked).toEqual([]);
  });

  it("restores a dead deploy run's storage window in its close step's order: Deny, that address, the tag", async () => {
    const { az, writes } = fakeAz({ account: storage({ defaultAction: 'Allow', ips: ['198.51.100.4', IP], window: `6 ${IP}` }) });
    const result = await run({ env: STOR, az, fetchImpl: github({ 6: ended }), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      '1 removed',
      "- storage account `stsiteprodcus01`: restored (default action set to Deny, the run's IP rule removed, tag cleared), its window is run 6's and run 6 has ended (completed, cancelled); default action Allow and 2 IP rule(s) (https://github.com/o/r/actions/runs/6).",
    ]);
    expect(writes).toEqual([
      'storage account update -g rg-web-site-prod-cus -n stsiteprodcus01 --default-action Deny --output none',
      'storage account network-rule remove -g rg-web-site-prod-cus --account-name stsiteprodcus01 --ip-address 203.0.113.7 --output none',
      'storage account update -g rg-web-site-prod-cus -n stsiteprodcus01 --remove tags.ciwindow --output none',
    ]);
  });

  it("leaves an operator's rule and the rollback default alone, reporting them, when no deploy run tagged the account", async () => {
    const { az, writes } = fakeAz({ account: storage({ defaultAction: 'Allow', ips: ['198.51.100.4'] }) });
    const result = await run({ env: STOR, az, fetchImpl: github({}), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('1 left for a person');
    expect(result.lines[1]).toMatch(/left alone, default action Allow and 1 IP rule\(s\) and no ciwindow tag/);
    expect(writes).toEqual([]);
  });

  it('leaves the window alone while the tagged deploy run is in progress', async () => {
    const { az, writes } = fakeAz({ account: storage({ defaultAction: 'Allow', ips: [IP], window: `6 ${IP}` }) });
    const result = await run({ env: STOR, az, fetchImpl: github({ 6: { status: 'in_progress', conclusion: null } }), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('1 left alone (run in progress)');
    expect(writes).toEqual([]);
  });

  it('stops the restore the moment a new deploy run writes its own tag, and leaves that run its window', async () => {
    // After the Deny lands, a new deploy (run 7) opens its window: tag, rule, Allow.
    const onWrite = (state, n) => {
      if (n === 1) state.account = storage({ defaultAction: 'Allow', ips: ['203.0.113.9', IP], window: '7 203.0.113.9' });
    };
    const { az, writes } = fakeAz({ account: storage({ defaultAction: 'Allow', ips: [IP], window: `6 ${IP}` }), onWrite });
    const result = await run({ env: STOR, az, fetchImpl: github({ 6: ended }), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('1 left alone (run in progress)');
    expect(result.lines[1]).toMatch(/stopped before "the run's IP rule removed": the ciwindow tag changed, so a new deploy run owns the window now/);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/--default-action Deny/);
  });

  it("retries a refused write (Azure's 409 while an earlier update runs) and succeeds on a later try", async () => {
    const { az, writes } = fakeAz({ account: storage({ defaultAction: 'Allow', window: `6 ${IP}` }), failing: { match: /default-action Deny/, times: 2 } });
    const slept = [];
    const result = await run({ env: STOR, az, fetchImpl: github({ 6: ended }), sleep: async (ms) => slept.push(ms), pauses: [5000, 20000] });
    expect(result.code).toBe(0);
    expect(slept).toEqual([5000, 20000]);
    expect(writes.filter((w) => w.includes('default-action Deny'))).toHaveLength(3);
  });

  it('does not retry an authorization refusal, fails naming the step, and keeps the rest of its work', async () => {
    const slept = [];
    const { az, writes } = fakeAz({
      site: restrictions({ site: ['ci-smoke-6'] }),
      account: storage({ defaultAction: 'Allow', ips: [IP], window: `6 ${IP}` }),
      failing: { match: /default-action Deny/, stderr: 'ERROR: (AuthorizationFailed) The client does not have authorization to perform action' },
    });
    const result = await run({ env: STOR, az, fetchImpl: github({ 6: { status: 'completed', conclusion: 'failure' } }), sleep: async (ms) => slept.push(ms), pauses: [5000, 20000] });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe('1 removed, 1 FAILED');
    expect(result.lines[1]).toBe('- `ci-smoke-6` on the site: removed, run 6 has ended (completed, failure).');
    expect(result.lines[2]).toBe(
      "- storage account `stsiteprodcus01`: NOT fully restored (its window is run 6's and run 6 has ended (completed, failure); default action Allow and 1 IP rule(s)): " +
        '"default action set to Deny" failed: ERROR: (AuthorizationFailed) The client does not have authorization to perform action; done before that: nothing'
    );
    expect(slept).toEqual([]);
    expect(writes.filter((w) => w.includes('default-action Deny'))).toHaveLength(1);
  });

  it('writes nothing in a dry run and says what it would do', async () => {
    const { az, writes } = fakeAz({ site: restrictions({ site: ['ci-smoke-6'] }), account: storage({ defaultAction: 'Allow', ips: [IP], window: `6 ${IP}` }) });
    const result = await run({ env: { ...STOR, DRY_RUN: '1' }, az, fetchImpl: github({ 6: ended }), ...noSleep });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe('dry run: 2 would remove');
    expect(result.lines[1]).toMatch(/would remove/);
    expect(result.lines[2]).toMatch(/would be restored \(default action set to Deny, the run's IP rule removed, tag cleared\)/);
    expect(writes).toEqual([]);
  });

  it('cannot run without its inputs, or when Azure or GitHub cannot be read, and writes nothing then', async () => {
    expect((await run({ env: {}, az: fakeAz().az })).code).toBe(2);
    expect((await run({ env: { APP: 'a', RG: 'g' }, az: fakeAz().az })).lines[1]).toMatch(/GITHUB_TOKEN/);

    const broken = async () => {
      const e = new Error('x');
      e.stderr = 'ERROR: (AuthorizationFailed) no\n';
      throw e;
    };
    const unreadable = await run({ env: ENV, az: broken, fetchImpl: github({}) });
    expect(unreadable.code).toBe(2);
    expect(unreadable.lines[1]).toMatch(/access restrictions could not be read: ERROR: \(AuthorizationFailed\) no/);

    const { az, writes } = fakeAz({ site: restrictions({ site: ['ci-smoke-1'] }) });
    const github502 = await run({ env: ENV, az, fetchImpl: github({ 1: 'boom' }), ...noSleep });
    expect(github502.code).toBe(2);
    expect(github502.lines[1]).toMatch(/`ci-smoke-1` could not be read: GitHub answered 502/);
    expect(writes).toEqual([]);

    const badStorage = await run({ env: STOR, az: fakeAz({ account: 'nope' }).az, fetchImpl: github({}), ...noSleep });
    expect(badStorage.code).toBe(2);
    expect(badStorage.lines[1]).toMatch(/storage account's firewall could not be read/);

    const tagged = fakeAz({ account: storage({ defaultAction: 'Allow', ips: [IP], window: `6 ${IP}` }) });
    const badRun = await run({ env: STOR, az: tagged.az, fetchImpl: github({ 6: 'boom' }), ...noSleep });
    expect(badRun.code).toBe(2);
    expect(badRun.lines[1]).toMatch(/deploy run behind the storage account's window tag could not be read/);
    expect(tagged.writes).toEqual([]);
  });

  it('formats an unreadable verdict as exit 2', () => {
    expect(formatUnreadable('why')).toEqual({ code: 2, lines: ['unreadable', expect.stringContaining('why')] });
  });
});

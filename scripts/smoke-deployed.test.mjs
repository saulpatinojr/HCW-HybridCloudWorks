/**
 * The smoke script's pure helpers. The script itself only proves anything
 * against a deployment; these prove the assertions it will make are the right
 * ones — a smoke test with a wrong filter passes against a broken deployment,
 * which is worse than no smoke test.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  parseArgs,
  looksPublic,
  projectionLeaks,
  LIST_MUST_NOT_CARRY,
  looksValidEstate,
  looksValidCoderStatus,
  FIREWALL_RETRY_BUDGET_MS,
  FIREWALL_RETRY_INTERVAL_MS,
  createOriginFetch,
  isOriginFirewallRefusal,
} from './smoke-deployed.mjs';

describe('parseArgs', () => {
  it('reads --base and strips trailing slashes', () => {
    expect(parseArgs(['--base', 'https://x.azurewebsites.net/api/']).base).toBe(
      'https://x.azurewebsites.net/api'
    );
  });

  it('enables the cosmos tier only on request', () => {
    expect(parseArgs([]).cosmos).toBe(false);
    expect(parseArgs(['--cosmos']).cosmos).toBe(true);
  });

  it('reads --tier and defaults to null', () => {
    expect(parseArgs([]).tier).toBe(null);
    expect(parseArgs(['--tier', '1']).tier).toBe(1);
    expect(parseArgs(['--tier', '2']).tier).toBe(2);
  });
});

describe('looksPublic — mirrors the server filter', () => {
  it('admits every published spelling and Live', () => {
    expect(looksPublic({ Live: true })).toBe(true);
    expect(looksPublic({ Status: 'Live' })).toBe(true);
    for (const s of ['published', 'published_blog', 'published_news', 'published_both']) {
      expect(looksPublic({ contentStatus: s })).toBe(true);
    }
  });

  it('flags drafts, so a leak in the deployed filter is caught', () => {
    expect(looksPublic({ contentStatus: 'draft' })).toBe(false);
    expect(looksPublic({})).toBe(false);
  });
});

describe('projectionLeaks — mirrors the T-206 exclusion list', () => {
  it('covers all eight excluded body fields', () => {
    expect(LIST_MUST_NOT_CARRY).toHaveLength(8);
    const heavy = Object.fromEntries(LIST_MUST_NOT_CARRY.map((f) => [f, 'x']));
    expect(projectionLeaks(heavy)).toEqual(LIST_MUST_NOT_CARRY);
  });

  it('does not flag the one body field the projection keeps', () => {
    // `explanation` is deliberately IN the projection (Coder Corner excerpt
    // fallback); the smoke test must not report it as a leak.
    expect(projectionLeaks({ explanation: 'x', Title: 't' })).toEqual([]);
  });
});

describe('looksValidEstate — validates public/labs/estate contract', () => {
  it('validates unconfigured response', () => {
    expect(looksValidEstate({ configured: false })).toBe(true);
    expect(looksValidEstate(null)).toBe(false);
    expect(looksValidEstate({})).toBe(false);
  });

  it('validates configured response with required blocks', () => {
    expect(
      looksValidEstate({
        configured: true,
        arc: { status: 'Connected' },
        agent: { online: true },
        coder: { reachable: true },
      })
    ).toBe(true);

    expect(
      looksValidEstate({
        configured: true,
        arc: { status: 'Connected' },
      })
    ).toBe(false);
  });
});

describe('looksValidCoderStatus — validates public/labs/coder-status contract', () => {
  it('validates unconfigured response', () => {
    expect(looksValidCoderStatus({ configured: false })).toBe(true);
    expect(looksValidCoderStatus(null)).toBe(false);
  });

  it('validates configured response with reachable flag', () => {
    expect(looksValidCoderStatus({ configured: true, reachable: true })).toBe(true);
    expect(looksValidCoderStatus({ configured: true, reachable: false })).toBe(true);
    expect(looksValidCoderStatus({ configured: true })).toBe(false);
  });
});

// The origin's own firewall. The facts these tests rest on are from a real run
// (39997538990, 2026-10-23) and a real request: the platform's refusal is
// HTTP 403 "Ip Forbidden" with an `x-ms-forbidden-ip` header and an HTML body.
const firewallRefusal = () =>
  new Response('<html><title>Web App - Unavailable</title></html>', {
    status: 403,
    statusText: 'Ip Forbidden',
    headers: { 'x-ms-forbidden-ip': '203.0.113.7', 'content-type': 'text/html' },
  });
const appForbidden = () =>
  new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
const ok = () => new Response('{}', { status: 200 });

describe('isOriginFirewallRefusal', () => {
  it('recognises the platform refusal by its status and its header', () => {
    expect(isOriginFirewallRefusal(firewallRefusal())).toBe(true);
  });

  it('does not take an app-level 403 for it: the guards and CORS checks expect that one', () => {
    expect(isOriginFirewallRefusal(appForbidden())).toBe(false);
  });

  it('needs the 403 as well as the header', () => {
    const odd = new Response('{}', { status: 200, headers: { 'x-ms-forbidden-ip': '203.0.113.7' } });
    expect(isOriginFirewallRefusal(odd)).toBe(false);
  });

  it.each([[null], [undefined], [{}], [{ status: 403 }]])('is false for %j', (res) => {
    expect(isOriginFirewallRefusal(res)).toBe(false);
  });
});

describe('createOriginFetch', () => {
  const make = (answers, options = {}) => {
    const queue = [...answers];
    const fetchImpl = vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next();
    });
    const sleep = vi.fn(async () => {});
    return { fetchImpl, sleep, originFetch: createOriginFetch({ fetchImpl, sleep, ...options }) };
  };

  it('passes a normal answer straight through, without waiting', async () => {
    const { originFetch, fetchImpl, sleep } = make([ok]);
    const res = await originFetch('https://x/api/health');
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits out the firewall refusal and returns the answer that follows (run 39997538990)', async () => {
    const { originFetch, fetchImpl, sleep } = make([firewallRefusal, firewallRefusal, ok]);
    const res = await originFetch('https://x/api/public/content?limit=5');
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(FIREWALL_RETRY_INTERVAL_MS);
    expect(originFetch.stats).toEqual({ retries: 2, waitedMs: 2 * FIREWALL_RETRY_INTERVAL_MS });
  });

  it('never retries an app-level 403, so the guard and CORS checks still see it', async () => {
    const { originFetch, fetchImpl, sleep } = make([appForbidden, ok]);
    const res = await originFetch('https://x/api/getCurrentAdminStatus');
    expect(res.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([401, 404, 500, 503])('never retries a %i', async (status) => {
    const { originFetch, fetchImpl } = make([() => new Response('', { status }), ok]);
    expect((await originFetch('https://x/api/y')).status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets a thrown network error through untouched', async () => {
    const boom = new TypeError('fetch failed');
    const { originFetch, sleep } = make([boom]);
    await expect(originFetch('https://x/api/health')).rejects.toBe(boom);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up when the budget is spent and returns the last refusal, so the check fails with its 403', async () => {
    const tries = FIREWALL_RETRY_BUDGET_MS / FIREWALL_RETRY_INTERVAL_MS;
    const { originFetch, fetchImpl, sleep } = make(Array.from({ length: tries + 5 }, () => firewallRefusal));
    const res = await originFetch('https://x/api/public/content?limit=5');
    expect(res.status).toBe(403);
    expect(isOriginFirewallRefusal(res)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(tries + 1);
    expect(sleep).toHaveBeenCalledTimes(tries);
  });

  it('shares one budget across every request, so a rule that never arrives costs it once', async () => {
    const answers = Array.from({ length: 30 }, () => firewallRefusal);
    const { originFetch, sleep } = make(answers, { budgetMs: 10_000, intervalMs: 5_000 });
    await originFetch('https://x/api/a');
    expect(sleep).toHaveBeenCalledTimes(2);
    const second = await originFetch('https://x/api/b');
    expect(second.status).toBe(403);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('keeps its budget for later requests when an early one needed none', async () => {
    const { originFetch, sleep } = make([ok, firewallRefusal, ok], { budgetMs: 10_000, intervalMs: 5_000 });
    await originFetch('https://x/api/a');
    const res = await originFetch('https://x/api/b');
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('has a budget the deploy can afford: well under the workflow poll\'s 150 s', () => {
    expect(FIREWALL_RETRY_BUDGET_MS).toBeLessThanOrEqual(120_000);
    expect(FIREWALL_RETRY_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe('the smoke script reaches the origin only through originFetch', () => {
  // A bare fetch() added later would bring the one-request failure of run
  // 39997538990 back, for that check alone, with nothing else to say why.
  it('has no bare fetch( call outside createOriginFetch\'s default', () => {
    const source = readFileSync(new URL('./smoke-deployed.mjs', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bare = [...code.matchAll(/(?<![\w.])fetch\(/g)];
    expect(bare).toHaveLength(0);
    expect(code).toMatch(/fetchImpl = globalThis\.fetch/);
  });
});

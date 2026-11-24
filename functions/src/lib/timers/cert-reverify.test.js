/**
 * cert-reverify.js — `verdictFor`, the per-certification decision the Sunday
 * timer applies. The whole run is pinned in timers.test.js; this covers the
 * decision table on its own, including the Credly reads it does and does
 * not make.
 */
import { describe, it, expect, vi } from 'vitest';
import { verdictFor } from './cert-reverify.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');

function depsSaying(bodyFor) {
  const fetch = vi.fn(async (url) => ({ text: async () => bodyFor(url) }));
  return { deps: { fetch, log: {} }, fetch };
}

describe('verdictFor', () => {
  it('retires an active cert that has expired without asking Credly', async () => {
    const { deps, fetch } = depsSaying(() => '');
    const cert = { certState: true, expDate: '2026-01-01', verifyUrl: 'https://credly.com/x' };
    expect(await verdictFor(deps, cert, NOW)).toEqual({ next: 'inactive', reason: 'expired' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retires an active cert whose Credly badge cannot be verified, and keeps one that can', async () => {
    const { deps } = depsSaying((url) => (url.endsWith('/r') ? 'Unable to verify badge' : 'ok'));
    const active = { certState: true, expDate: '2099-01-01' };
    expect(await verdictFor(deps, { ...active, verifyUrl: 'https://credly.com/r' }, NOW)).toEqual({
      next: 'inactive',
      reason: 'revoked',
    });
    expect(
      await verdictFor(deps, { ...active, verifyUrl: 'https://credly.com/f' }, NOW)
    ).toBeNull();
  });

  it('only Credly URLs are verified; another verifier leaves the cert as it is', async () => {
    const { deps, fetch } = depsSaying(() => 'Unable to verify badge');
    const cert = { certState: true, verifyUrl: 'https://example.test/badge' };
    expect(await verdictFor(deps, cert, NOW)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a network failure on Credly never revokes', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('timeout');
    });
    const warn = vi.fn();
    const cert = { name: 'U', certState: true, verifyUrl: 'https://credly.com/u' };
    expect(await verdictFor({ fetch, log: { warn } }, cert, NOW)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Failed to reach Credly for a certification: /));
  });

  it('renews an inactive cert whose expiry is ahead, unless Credly still refuses it', async () => {
    const { deps } = depsSaying((url) => (url.endsWith('/r') ? 'Unable to verify badge' : 'ok'));
    expect(await verdictFor(deps, { certState: false, expDate: '2099-06-01' }, NOW)).toEqual({
      next: 'active',
      reason: 'renewed',
    });
    expect(
      await verdictFor(
        deps,
        { certState: false, expDate: '2099-06-01', verifyUrl: 'https://credly.com/r' },
        NOW
      )
    ).toBeNull();
  });

  it('leaves an inactive cert alone when it has lapsed or has no expiry to reason from', async () => {
    const { deps, fetch } = depsSaying(() => 'ok');
    expect(await verdictFor(deps, { certState: false, expDate: '2020-01-01' }, NOW)).toBeNull();
    expect(await verdictFor(deps, { certState: false }, NOW)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

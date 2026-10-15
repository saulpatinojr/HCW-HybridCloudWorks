import { describe, it, expect } from 'vitest';
import { isIpv4, judge } from './assert-ipv4.mjs';

describe('isIpv4', () => {
  it('accepts exactly four decimal octets in range', () => {
    for (const ok of ['0.0.0.0', '99.10.220.113', '255.255.255.255', '20.1.2.3']) expect(isIpv4(ok), ok).toBe(true);
  });

  it('refuses out-of-range octets, leading zeros, and anything that is not four octets', () => {
    for (const bad of ['256.1.1.1', '1.1.1', '1.1.1.1.1', '01.1.1.1', '1.1.1.1/32', '', ' 1.1.1.1', '1.1.1.1\n', 'a.b.c.d', '2001:db8::1']) {
      expect(isIpv4(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses non-strings', () => {
    for (const bad of [null, undefined, 1, {}, []]) expect(isIpv4(bad)).toBe(false);
  });
});

describe('judge', () => {
  it('trims the newline a curl body carries and returns the address', () => {
    expect(judge('99.10.220.113\n')).toEqual({ ok: true, address: '99.10.220.113' });
  });

  it('refuses an HTML error page, quoting it shortened and without control characters', () => {
    const page = `<!doctype html>\n<html><body>${'x'.repeat(200)}</body></html>`;
    const verdict = judge(page);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason.startsWith("not one IPv4 address: '<!doctype html>?<html>")).toBe(true);
    expect(verdict.reason.length).toBeLessThan(120);
    expect(verdict.reason.endsWith("'…")).toBe(true);
    expect(/[\x00-\x1f]/.test(verdict.reason)).toBe(false);
  });

  it('refuses an empty body, which is what a timed-out curl leaves behind', () => {
    expect(judge('')).toEqual({ ok: false, reason: "not one IPv4 address: ''" });
  });
});

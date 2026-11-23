import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Every workflow that asks the internet for the runner's address uses this
 * check (#1778). publish-content-manifest.yml had its own inline pattern,
 * which accepted numbers above 255 (999.1.1.1 passed). A new fetch that skips
 * the shared check, or pipes curl straight into a program, fails here.
 */
describe('workflows that fetch the runner address', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
  const fetches = [];
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = readFileSync(join(dir, file), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line));
    lines.forEach((line, index) => {
      if (/ipify|ifconfig\.me|icanhazip|checkip/.test(line)) {
        fetches.push({ file, line: line.trim(), next: (lines[index + 1] ?? '').trim() });
      }
    });
  }

  it('finds the fetches it is meant to guard', () => {
    const files = [...new Set(fetches.map((f) => f.file))].sort();
    expect(files).toEqual(['deploy-functions.yml', 'publish-content-manifest.yml']);
  });

  it('stores the answer in a variable, then hands it to assert-ipv4.mjs on the next line', () => {
    for (const { file, line, next } of fetches) {
      expect(line, file).toBe('RUNNER_IP_RAW=$(curl -sS --max-time 10 https://api.ipify.org)');
      expect(next, file).toBe('RUNNER_IP=$(node scripts/assert-ipv4.mjs <<<"${RUNNER_IP_RAW}")');
    }
  });
});

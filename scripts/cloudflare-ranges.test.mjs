import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declaredCloudflareRanges, MIN_DECLARED_RANGES } from './assert-origin-lock.mjs';
import {
  CLOUDFLARE_IPS_URL,
  SET,
  VARIABLES_PATH,
  diffRanges,
  isIpv4Cidr,
  main,
  parsePublished,
  renderDefault,
  renderEvidence,
} from './cloudflare-ranges.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const variables = readFileSync(join(REPO, VARIABLES_PATH), 'utf8');
const declared = declaredCloudflareRanges(variables);

const envelope = (ipv4, extra = {}) => JSON.stringify({ success: true, errors: [], messages: [], result: { ipv4_cidrs: ipv4, ipv6_cidrs: ['2400:cb00::/32'], etag: 'abc123', ...extra } });
const fakeFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('isIpv4Cidr', () => {
  it('accepts a dotted quad with a prefix of 0 to 32', () => {
    for (const ok of ['173.245.48.0/20', '0.0.0.0/0', '255.255.255.255/32', '131.0.72.0/22']) expect(isIpv4Cidr(ok), ok).toBe(true);
  });

  it('refuses IPv6, bare addresses, bad octets, bad prefixes and leading zeros', () => {
    for (const bad of ['2400:cb00::/32', '173.245.48.0', '256.0.0.0/8', '1.2.3.4/33', '01.2.3.4/8', '1.2.3.4/08', '', ' 1.2.3.4/8']) {
      expect(isIpv4Cidr(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('parsePublished', () => {
  it("reads Cloudflare's envelope into the IPv4 list and its etag, ignoring IPv6", () => {
    expect(parsePublished(envelope(declared))).toEqual({ ranges: declared, etag: 'abc123' });
  });

  it('refuses a short list, so a truncated answer can never narrow the lock', () => {
    const short = declared.slice(0, MIN_DECLARED_RANGES - 1);
    expect(() => parsePublished(envelope(short))).toThrow(/below the floor/);
  });

  it('refuses anything that is not the success envelope, a non-CIDR entry, a repeat, or non-JSON', () => {
    expect(() => parsePublished(JSON.stringify({ success: false, result: { ipv4_cidrs: declared } }))).toThrow(/envelope/);
    expect(() => parsePublished(JSON.stringify({ success: true, result: {} }))).toThrow(/envelope/);
    expect(() => parsePublished(envelope([...declared.slice(0, -1), '2400:cb00::/32']))).toThrow(/not IPv4 CIDRs: 2400:cb00::\/32/);
    expect(() => parsePublished(envelope([...declared.slice(0, -1), declared[0]]))).toThrow(/repeats/);
    expect(() => parsePublished('<html>')).toThrow(/not JSON/);
  });

  it('reads an etag only when it is a string', () => {
    expect(parsePublished(envelope(declared, { etag: 42 })).etag).toBe('');
  });
});

describe('diffRanges', () => {
  it('is same when the lists match in content and order', () => {
    expect(diffRanges(declared, [...declared])).toEqual({ added: [], removed: [], reordered: false, same: true });
  });

  it('names what Cloudflare added and what it retired', () => {
    const published = [...declared.slice(1), '198.51.100.0/24'];
    expect(diffRanges(declared, published)).toEqual({ added: ['198.51.100.0/24'], removed: [declared[0]], reordered: false, same: false });
  });

  it('notices a reorder of the same ranges, because rule priorities follow the order', () => {
    const published = [...declared].reverse();
    expect(diffRanges(declared, published)).toMatchObject({ added: [], removed: [], reordered: true, same: false });
  });
});

describe('renderDefault', () => {
  it("rewrites only the variable's default, keeping the file's indentation, and the result parses back", () => {
    const published = [...declared.slice(1), '198.51.100.0/24'];
    const out = renderDefault(variables, published);
    expect(declaredCloudflareRanges(out)).toEqual(published);
    expect(out).toContain('\n    "198.51.100.0/24",\n  ]');
    // Everything outside the variable's block is byte-identical.
    const at = variables.indexOf('variable "cloudflare_ip_ranges"');
    expect(out.slice(0, at)).toBe(variables.slice(0, at));
    expect(out.slice(out.indexOf('\n}', at))).toBe(variables.slice(variables.indexOf('\n}', at)));
  });

  it('is idempotent on the current list', () => {
    expect(renderDefault(variables, declared)).toBe(variables);
  });

  it('refuses a source without the variable or without a list default', () => {
    expect(() => renderDefault('variable "other" {\n  default = []\n}\n', declared)).toThrow(/no variable/);
    expect(() => renderDefault('variable "cloudflare_ip_ranges" {\n  default = "x"\n}\n', declared)).toThrow(/no list default/);
  });
});

describe('renderEvidence', () => {
  it('names the read, one row per moved range, and what each means at the origin', () => {
    const published = [...declared.slice(1), '198.51.100.0/24'];
    const md = renderEvidence({ declared, published, etag: 'abc123', date: '2026-10-15' });
    expect(md).toContain(`Read ${CLOUDFLARE_IPS_URL} on 2026-10-15 (etag \`abc123\`)`);
    expect(md).toContain('| `198.51.100.0/24` | published, not declared | a Cloudflare edge the origin refuses today; the apply adds its Allow rule |');
    expect(md).toContain(`| \`${declared[0]}\` | declared, no longer published | a rule nothing reaches through; the apply removes it |`);
  });
});

describe('main', () => {
  const io = (body, status) => {
    const writes = [];
    const logs = [];
    return {
      io: { read: () => variables, write: (t) => writes.push(t), log: (l) => logs.push(l), fetch: fakeFetch(body, status), date: '2026-10-15', output: '' },
      writes,
      logs,
    };
  };

  it('--check exits 0 and writes nothing when the lists match', async () => {
    const { io: ctx, writes, logs } = io(envelope(declared));
    expect(await main(['--check'], ctx)).toBe(0);
    expect(writes).toEqual([]);
    expect(logs.join('\n')).toMatch(/is current/);
  });

  it('--check exits 3 when behind, naming the ranges, and writes nothing', async () => {
    const published = [...declared.slice(1), '198.51.100.0/24'];
    const { io: ctx, writes, logs } = io(envelope(published));
    expect(await main(['--check'], ctx)).toBe(3);
    expect(writes).toEqual([]);
    expect(logs.join('\n')).toContain('+ 198.51.100.0/24');
    expect(logs.join('\n')).toContain(`- ${declared[0]}`);
  });

  it('--bump rewrites the default to the published list and exits 0', async () => {
    const published = [...declared.slice(1), '198.51.100.0/24'];
    const { io: ctx, writes } = io(envelope(published));
    expect(await main(['--bump'], ctx)).toBe(0);
    expect(writes).toHaveLength(1);
    expect(declaredCloudflareRanges(writes[0])).toEqual(published);
  });

  it('--bump --dry-run exits 0 and writes nothing', async () => {
    const published = [...declared.slice(1), '198.51.100.0/24'];
    const { io: ctx, writes, logs } = io(envelope(published));
    expect(await main(['--bump', '--dry-run'], ctx)).toBe(0);
    expect(writes).toEqual([]);
    expect(logs.join('\n')).toMatch(/dry run/);
  });

  it('exits 2 and writes nothing on an HTTP failure, a short list or a bad envelope', async () => {
    for (const [body, status] of [
      ['', 503],
      [envelope(declared.slice(0, 3)), 200],
      ['{"success":false}', 200],
    ]) {
      const { io: ctx, writes, logs } = io(body, status);
      expect(await main(['--bump'], ctx)).toBe(2);
      expect(writes).toEqual([]);
      expect(logs.join('\n')).toMatch(/could not be read/);
    }
  });

  it('exits 2 without a mode', async () => {
    const { io: ctx } = io(envelope(declared));
    expect(await main([], ctx)).toBe(2);
  });

  it('names its set the way the opener does', () => {
    expect(SET).toBe('cloudflare-ranges');
  });
});

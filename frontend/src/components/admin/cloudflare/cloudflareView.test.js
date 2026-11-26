/**
 * The Cloudflare page's pure half (#1905): locks, setting controls, the DNS
 * form, the rules editor and the purge list, and the browser's mirror of the
 * server's protected rule phases.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROTECTED_PHASES,
  dnsForm,
  dnsNameLock,
  dnsRecordBody,
  dnsRecordPatch,
  editableRules,
  entrypointRulesets,
  familyRows,
  normalizeDnsName,
  otherRulesets,
  parsePurgeList,
  parseRulesDraft,
  parseSettingDraft,
  phaseLock,
  protectedPhaseList,
  settingControl,
  settingDraft,
  settingLabel,
  settingMatches,
  ttlText,
} from './cloudflareView';

const ZONE = 'example.com';
const STATUS = {
  configured: true,
  zone: { id: 'z1', name: ZONE, status: 'active', plan: 'Free Website' },
  families: [
    { id: 'settings', label: 'Zone settings', readable: true },
    { id: 'dns', readable: false },
  ],
  protected: {
    dnsNames: [
      { name: ZONE, reason: 'The site itself.' },
      'www.example.com',
      { name: 'api-azure.example.com', reason: 'Managed in infra/frontend.tf.' },
    ],
    phases: [{ phase: 'http_request_late_transform', reason: 'The origin secret rule.' }],
  },
};

describe('the browser’s mirror of the server’s protected phases', () => {
  const serverFile = join(
    process.cwd(),
    '..',
    'functions',
    'src',
    'lib',
    'cloudflare',
    'protected.js'
  );

  it('locks the origin secret rule and the API rate limit, each with a reason', () => {
    expect(PROTECTED_PHASES.map((item) => item.phase)).toEqual([
      'http_request_late_transform',
      'http_ratelimit',
    ]);
    for (const item of PROTECTED_PHASES) expect(item.reason).toMatch(/\w.{30,}/);
  });

  // functions/src/lib/cloudflare/protected.js imports nothing, so the browser
  // can read it. It must export PROTECTED_PHASES: a list of phase names, or of
  // objects with a `phase` field. Skipped until the file exists.
  it.skipIf(!existsSync(serverFile))('names the same phases as the server’s list', async () => {
    const server = await import(/* @vite-ignore */ pathToFileURL(serverFile).href);
    const phases = (server.PROTECTED_PHASES ?? []).map((item) =>
      typeof item === 'string' ? item : item.phase
    );
    expect([...phases].sort()).toEqual(PROTECTED_PHASES.map((item) => item.phase).sort());
  });
});

describe('locks', () => {
  it('joins the server’s phases with the mirror, the server’s reason first', () => {
    const list = protectedPhaseList(STATUS);
    expect(list.map((item) => item.phase)).toEqual([
      'http_request_late_transform',
      'http_ratelimit',
    ]);
    expect(list[0].reason).toBe('The origin secret rule.');
    expect(protectedPhaseList(null)).toHaveLength(2);
  });

  it('locks a phase the ruleset marks, the mirror names, and nothing else', () => {
    expect(
      phaseLock('http_custom', { ruleset: { locked: true, lockedReason: 'Server says.' } })
    ).toBe('Server says.');
    expect(phaseLock('http_ratelimit')).toMatch(/rate limit/);
    expect(phaseLock('http_request_late_transform', { status: STATUS })).toBe(
      'The origin secret rule.'
    );
    expect(phaseLock('http_request_firewall_custom', { status: STATUS })).toBeNull();
  });

  it('spells a DNS name in full, with @ as the zone', () => {
    expect(normalizeDnsName('@', ZONE)).toBe(ZONE);
    expect(normalizeDnsName('Lab', ZONE)).toBe('lab.example.com');
    expect(normalizeDnsName('lab.example.com.', ZONE)).toBe('lab.example.com');
    expect(normalizeDnsName('', ZONE)).toBe('');
  });

  it('locks the protected names, any certificate check, and nothing else', () => {
    expect(dnsNameLock('@', { status: STATUS })).toBe('The site itself.');
    expect(dnsNameLock('www', { status: STATUS })).toMatch(/keeps the site running/);
    expect(dnsNameLock('api-azure.example.com', { status: STATUS })).toMatch(/frontend\.tf/);
    expect(dnsNameLock('_acme-challenge.lab', { status: STATUS })).toMatch(/certificate/);
    expect(dnsNameLock('lab', { status: STATUS })).toBeNull();
    expect(dnsNameLock('', { status: STATUS })).toBeNull();
    // A listed name ending in * is a prefix.
    const prefixed = { ...STATUS, protected: { dnsNames: ['lab-*'] } };
    expect(dnsNameLock('lab-one.example.com', { status: prefixed })).not.toBeNull();
    expect(dnsNameLock('labs.example.com', { status: prefixed })).toBeNull();
  });

  it('reads the families the status reports', () => {
    expect(familyRows(STATUS)).toEqual([
      { id: 'settings', label: 'Zone settings', readable: true },
      { id: 'dns', label: 'DNS records', readable: false },
    ]);
    expect(familyRows(null)).toEqual([]);
  });
});

describe('settings', () => {
  it('chooses the control from the value', () => {
    expect(settingControl({ id: 'always_use_https', value: 'on', editable: true })).toBe('switch');
    expect(settingControl({ id: 'ssl', value: 'strict', editable: true })).toBe('select');
    expect(settingControl({ id: 'ssl', value: 'something_new', editable: true })).toBe('json');
    expect(settingControl({ id: 'browser_cache_ttl', value: 14400, editable: true })).toBe(
      'number'
    );
    expect(settingControl({ id: 'security_header', value: { a: 1 }, editable: true })).toBe('json');
    expect(settingControl({ id: 'ipv6', value: 'on', editable: false })).toBe('readonly');
  });

  it('turns a control’s text into the value to send, or a sentence', () => {
    expect(parseSettingDraft('switch', 'off')).toBe('off');
    expect(() => parseSettingDraft('switch', 'maybe')).toThrow(/on or off/);
    expect(parseSettingDraft('number', ' 300 ')).toBe(300);
    expect(() => parseSettingDraft('number', 'abc')).toThrow(/number/);
    expect(parseSettingDraft('json', '{"a":1}')).toEqual({ a: 1 });
    expect(() => parseSettingDraft('json', '{a:1}')).toThrow(/not valid JSON/);
    expect(() => parseSettingDraft('readonly', 'x')).toThrow(/cannot be changed/);
    expect(settingDraft('json', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(settingDraft('number', 5)).toBe('5');
  });

  it('names and filters settings in words', () => {
    expect(settingLabel('always_use_https')).toBe('Always use https');
    expect(settingMatches({ id: 'always_use_https' }, 'HTTPS')).toBe(true);
    expect(settingMatches({ id: 'always_use_https' }, 'cache')).toBe(false);
    expect(settingMatches({ id: 'always_use_https' }, '')).toBe(true);
  });
});

describe('the DNS form', () => {
  it('builds a new record, proxied only where Cloudflare can proxy', () => {
    expect(
      dnsRecordBody({ ...dnsForm(), name: 'lab', content: '192.0.2.10', proxied: true })
    ).toEqual({ type: 'A', name: 'lab', content: '192.0.2.10', ttl: 1, proxied: true });
    expect(
      dnsRecordBody({ ...dnsForm(), type: 'TXT', name: 'x', content: 'hello', proxied: true })
    ).toEqual({ type: 'TXT', name: 'x', content: 'hello', ttl: 1 });
    expect(
      dnsRecordBody({
        ...dnsForm(),
        type: 'MX',
        name: '@',
        content: 'mx.example.net',
        priority: '10',
      })
    ).toMatchObject({ priority: 10 });
  });

  it('says what is missing or out of range', () => {
    expect(() => dnsRecordBody({ ...dnsForm(), type: 'SRV' })).toThrow(/Choose a type/);
    expect(() => dnsRecordBody(dnsForm())).toThrow(/Enter the name/);
    expect(() => dnsRecordBody({ ...dnsForm(), name: 'a' })).toThrow(/Enter the content/);
    expect(() => dnsRecordBody({ ...dnsForm(), name: 'a', content: 'b', ttl: '30' })).toThrow(
      /TTL/
    );
    expect(() =>
      dnsRecordBody({ ...dnsForm(), type: 'MX', name: 'a', content: 'b', priority: '' })
    ).toThrow(/priority/);
  });

  it('sends only what changed when editing, and keeps the type', () => {
    const record = {
      id: 'r1',
      type: 'CNAME',
      name: 'lab.example.com',
      content: 'old.example.net',
      ttl: 1,
      proxied: true,
      comment: '',
    };
    expect(dnsRecordPatch(record, dnsForm(record))).toEqual({});
    expect(
      dnsRecordPatch(record, { ...dnsForm(record), type: 'A', content: 'new.example.net' })
    ).toEqual({ content: 'new.example.net' });
    expect(dnsRecordPatch(record, { ...dnsForm(record), proxied: false, ttl: '300' })).toEqual({
      ttl: 300,
      proxied: false,
    });
  });

  it('says Automatic for TTL 1', () => {
    expect(ttlText(1)).toBe('Automatic');
    expect(ttlText(300)).toBe('300 s');
  });
});

describe('the rules editor', () => {
  it('starts from the rules without Cloudflare’s own fields', () => {
    expect(
      editableRules({
        rules: [{ id: 'a', version: '3', last_updated: 'x', expression: 'true', action: 'block' }],
      })
    ).toEqual([{ id: 'a', expression: 'true', action: 'block' }]);
    expect(editableRules(null)).toEqual([]);
  });

  it('accepts a list of rules with an expression and an action each', () => {
    expect(parseRulesDraft('[{"expression":"true","action":"block"}]')).toHaveLength(1);
    expect(parseRulesDraft('[]')).toEqual([]);
    expect(() => parseRulesDraft('{')).toThrow(/not valid JSON/);
    expect(() => parseRulesDraft('{}')).toThrow(/must be a list/);
    expect(() => parseRulesDraft('[1]')).toThrow(/Rule 1 is not an object/);
    expect(() => parseRulesDraft('[{"action":"block"}]')).toThrow(/expression/);
  });

  it('separates the zone’s own entry points from Cloudflare’s managed rulesets', () => {
    const all = [
      { id: '1', kind: 'zone', phase: 'http_ratelimit' },
      { id: '2', kind: 'managed', phase: 'http_request_firewall_managed' },
    ];
    expect(entrypointRulesets(all).map((r) => r.id)).toEqual(['1']);
    expect(otherRulesets(all).map((r) => r.id)).toEqual(['2']);
  });
});

describe('the purge list', () => {
  it('keeps https addresses on the zone, once each', () => {
    expect(
      parsePurgeList('https://example.com/a\n\nhttps://www.example.com/b\nhttps://example.com/a', {
        zoneName: ZONE,
      })
    ).toEqual({ files: ['https://example.com/a', 'https://www.example.com/b'], problems: [] });
  });

  it('says what is wrong with each line, and with too many', () => {
    const { problems } = parsePurgeList('http://example.com/a\nnot a url\nhttps://other.net/x', {
      zoneName: ZONE,
    });
    expect(problems).toHaveLength(3);
    expect(parsePurgeList('').problems).toEqual(['Enter at least one address, one per line.']);
    const many = Array.from({ length: 31 }, (_, i) => `https://example.com/${i}`).join('\n');
    expect(parsePurgeList(many, { zoneName: ZONE, max: 30 }).problems).toEqual([
      'At most 30 addresses at once; there are 31.',
    ]);
  });
});

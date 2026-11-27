/**
 * The Cloudflare page's pure half (#1905): locks, setting controls, the DNS
 * form, the rules editor and the purge list, and the browser's mirror of the
 * server's protected rule phases.
 */
import { describe, expect, it } from 'vitest';
import * as server from '../../../../../functions/src/lib/cloudflare/prerequisites.js';
import * as rateLimit from '../../../../../functions/src/lib/cloudflare/rate-limit.js';
import {
  APEX_WILDCARD_REASON,
  FAMILY_STATES,
  PREREQUISITE_NOTES,
  RATE_LIMIT_TONES,
  changeWarning,
  missingPrerequisites,
  notConfiguredHeadline,
  notConfiguredNote,
  READ_ONLY_PHASE_REASON,
  dnsForm,
  dnsNameLock,
  dnsRecordBody,
  dnsRecordPatch,
  editableRules,
  entrypointRulesets,
  familyRows,
  needsTypedConfirm,
  normalizeDnsName,
  otherRulesets,
  parsePurgeList,
  parseRulesDraft,
  parseSettingDraft,
  phaseLock,
  protectedPhaseList,
  rateLimitLine,
  rateLimitNeedsRule,
  settingControl,
  settingDraft,
  settingLabel,
  settingMatches,
  ttlText,
  zoneStatus,
} from './cloudflareView';
import { cloudflareParams, tabHref } from './tabs';

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

describe('locks', () => {
  it('joins the server’s phases with the mirror, the server’s reason first', () => {
    const list = protectedPhaseList(STATUS);
    expect(list.map((item) => item.phase)).toEqual(['http_request_late_transform']);
    expect(list[0].reason).toBe('The origin secret rule.');
    expect(protectedPhaseList(null)).toHaveLength(1);
    expect(
      protectedPhaseList({
        protected: { phases: [{ phase: 'http_ratelimit', reason: 'Server says.' }] },
      })
    ).toContainEqual({ phase: 'http_ratelimit', reason: 'Server says.' });
  });

  it('locks a phase the ruleset marks, a Terraform phase, and every phase not on the allow-list', () => {
    expect(
      phaseLock('http_custom', { ruleset: { locked: true, lockedReason: 'Server says.' } })
    ).toBe('Server says.');
    expect(phaseLock('http_ratelimit')).toBeNull();
    expect(phaseLock('http_ratelimit', { status: STATUS })).toBeNull();
    expect(phaseLock('http_request_late_transform', { status: STATUS })).toBe(
      'The origin secret rule.'
    );
    expect(phaseLock('http_request_firewall_custom', { status: STATUS })).toBeNull();
    expect(phaseLock('http_request_origin', { status: STATUS })).toBe(READ_ONLY_PHASE_REASON);
    expect(phaseLock('http_request_cache_settings')).toBe(READ_ONLY_PHASE_REASON);
  });

  it('spells a DNS name in full, with @ as the zone', () => {
    expect(normalizeDnsName('@', ZONE)).toBe(ZONE);
    expect(normalizeDnsName('Lab', ZONE)).toBe('lab.example.com');
    expect(normalizeDnsName('lab.example.com.', ZONE)).toBe('lab.example.com');
    expect(normalizeDnsName('', ZONE)).toBe('');
  });

  it('locks the protected names, any certificate check, the wildcards over them, and nothing else', () => {
    expect(dnsNameLock('@', { status: STATUS })).toBe('The site itself.');
    expect(dnsNameLock('www', { status: STATUS })).toMatch(/keeps the site running/);
    expect(dnsNameLock('api-azure.example.com', { status: STATUS })).toMatch(/frontend\.tf/);
    expect(dnsNameLock('_acme-challenge.lab', { status: STATUS })).toMatch(/certificate/);
    expect(dnsNameLock('*', { status: STATUS })).toBe(APEX_WILDCARD_REASON);
    expect(dnsNameLock('*.api-azure', { status: STATUS })).toMatch(/frontend\.tf/);
    expect(dnsNameLock('lab', { status: STATUS })).toBeNull();
    // A wildcard answers _acme-challenge.<base>, a protected prefix, so it is locked (#1913 review).
    expect(dnsNameLock('*.lab', { status: STATUS })).toMatch(/certificate/);
    expect(dnsNameLock('', { status: STATUS })).toBeNull();
    // A `*.x` entry covers every name under x.
    const wild = {
      ...STATUS,
      protected: { dnsNames: [{ name: '*.lab.example.com', reason: 'Lab.' }] },
    };
    expect(dnsNameLock('a.b.lab.example.com', { status: wild })).toBe('Lab.');
    expect(dnsNameLock('labs.example.com', { status: wild })).toBeNull();
    // The prefixes come from the status answer once it is read.
    const prefixed = {
      ...STATUS,
      protected: { dnsPrefixes: [{ prefix: '_check', reason: 'P.' }] },
    };
    expect(dnsNameLock('_check-1.example.com', { status: prefixed })).toBe('P.');
    expect(dnsNameLock('_acme-challenge.example.com', { status: prefixed })).toBeNull();
  });

  it('reads the families the status reports', () => {
    expect(familyRows(STATUS)).toEqual([
      {
        id: 'settings',
        label: 'Zone settings',
        readable: true,
        state: 'yes',
        words: 'can be read',
      },
      {
        id: 'dns',
        label: 'DNS records',
        readable: false,
        state: 'refused',
        words: FAMILY_STATES.refused,
      },
    ]);
    const [unknown] = familyRows({ families: [{ id: 'cache', readable: null }] });
    expect(unknown).toMatchObject({ state: 'unknown', words: 'could not check right now' });
    expect(FAMILY_STATES.refused).toMatch(/lacks this permission/);
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
    // tls_1_3 offers its third value, zrt, so it is a select even when it reads on or off.
    expect(settingControl({ id: 'tls_1_3', value: 'on', editable: true })).toBe('select');
    expect(settingControl({ id: 'tls_1_3', value: 'zrt', editable: true })).toBe('select');
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
    expect(() => parseRulesDraft('[]')).toThrow(/delete every rule/);
    expect(() => parseRulesDraft('{')).toThrow(/not valid JSON/);
    expect(() => parseRulesDraft('{}')).toThrow(/must be a list/);
    expect(() => parseRulesDraft('[1]')).toThrow(/Rule 1 is not an object/);
    expect(() => parseRulesDraft('[{"action":"block"}]')).toThrow(/expression/);
  });

  it('asks for the phase name typed when a custom security or rate limiting rule would be removed', () => {
    expect(needsTypedConfirm('http_request_firewall_custom', 3, 2)).toBe(true);
    expect(needsTypedConfirm('http_request_firewall_custom', 3, 3)).toBe(false);
    expect(needsTypedConfirm('http_ratelimit', 1, 0)).toBe(true);
    expect(needsTypedConfirm('http_ratelimit', 1, 2)).toBe(false);
    expect(needsTypedConfirm('http_request_dynamic_redirect', 3, 1)).toBe(false);
  });

  it('separates the zone’s own entry points from Cloudflare’s managed rulesets', () => {
    const all = [
      { id: '1', kind: 'zone', phase: 'http_request_late_transform' },
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

describe('the API rate limit line (#1909)', () => {
  it('has a tone for every state the server can report, and no other', () => {
    expect(Object.keys(RATE_LIMIT_TONES)).toEqual([...rateLimit.RATE_LIMIT_STATES]);
  });

  it('is green with a rule on, amber when the phase is empty or every rule is off', () => {
    const on = rateLimitLine({
      configured: true,
      rateLimit: rateLimit.rateLimitFromRuleset({ rules: [{}] }),
    });
    expect(on).toMatchObject({ state: 'on', tone: 'healthy' });
    expect(rateLimitNeedsRule(on)).toBe(false);
    for (const ruleset of [null, { rules: [] }, { rules: [{ enabled: false }] }]) {
      const line = rateLimitLine({
        configured: true,
        rateLimit: rateLimit.rateLimitFromRuleset(ruleset),
      });
      expect(line.tone, JSON.stringify(ruleset)).toBe('degraded');
      expect(line.message).toMatch(/part 4 of the Cloudflare admin runbook/);
      expect(rateLimitNeedsRule(line)).toBe(true);
    }
  });

  it('gives a refusal and an outage their own tones, with the server’s sentence', () => {
    expect(
      rateLimitLine({ configured: true, rateLimit: rateLimit.rateLimitUnread(403) })
    ).toMatchObject({
      state: 'refused',
      tone: 'critical',
      message: expect.stringMatching(/refused the admin token/),
    });
    expect(
      rateLimitLine({ configured: true, rateLimit: rateLimit.rateLimitUnread(null) })
    ).toMatchObject({
      state: 'unreachable',
      tone: 'offline',
    });
  });

  it('says "not checked" with the server’s sentence while the token or the zone id is not set', () => {
    const message = server.notConfiguredMessage(['token']);
    expect(
      rateLimitLine({ configured: false, missing: ['token'], message, rateLimit: null })
    ).toEqual({
      state: 'not-configured',
      tone: 'unknown',
      message: `Not checked. ${message}`,
    });
  });

  it('says nothing about the lab zone, set up or not', () => {
    const lab = { name: 'hybridcloudinsights.com' };
    expect(rateLimitLine({ configured: false, managed: lab, message: 'x' })).toBeNull();
    expect(rateLimitLine({ configured: true, managed: lab, rateLimit: null })).toBeNull();
  });

  it('is null when the answer carries no rate limit (the lab zone) or a state it does not know', () => {
    expect(rateLimitLine({ configured: true, rateLimit: null })).toBeNull();
    expect(rateLimitLine({ configured: true })).toBeNull();
    expect(rateLimitLine({ configured: true, rateLimit: { state: 'constructor' } })).toBeNull();
    expect(rateLimitLine(null)).toBeNull();
  });
});

describe('not set up yet', () => {
  it('knows the same missing things as the server, by the same names', () => {
    expect(Object.keys(PREREQUISITE_NOTES)).toEqual(Object.keys(server.PREREQUISITES));
  });

  it('names only the token, with the Keys tab, when only the token is missing', () => {
    const note = notConfiguredNote({ missing: ['token'] });
    expect(note.keysLink).toBe(true);
    expect(note.description).toMatch(/paste it on Integrations → Keys/);
    expect(note.description).not.toMatch(/CF_ZONE_ID|Terraform/);
  });

  it('names only the zone id, from Terraform and with no Keys tab, when only it is missing', () => {
    const note = notConfiguredNote({ missing: ['zoneId'] });
    expect(note.keysLink).toBe(false);
    expect(note.description).toMatch(/CF_ZONE_ID.*not pasted anywhere: Terraform sets it/);
    expect(note.description).not.toMatch(/admin token/);
  });

  it('names both when both are missing', () => {
    const note = notConfiguredNote({ missing: ['token', 'zoneId'] });
    expect(note.keysLink).toBe(true);
    expect(note.description).toMatch(/admin token.*CF_ZONE_ID/);
  });

  it('reads what is missing from the server’s sentence when there is no list', () => {
    for (const missing of [['token'], ['zoneId'], ['token', 'zoneId']]) {
      expect(missingPrerequisites({ message: server.notConfiguredMessage(missing) })).toEqual(
        missing
      );
    }
    expect(notConfiguredNote({ message: server.notConfiguredMessage(['zoneId']) }).keysLink).toBe(
      false
    );
  });

  it('prefers the list to the sentence, and shows a sentence it cannot read as it is', () => {
    expect(
      missingPrerequisites({ missing: ['zoneId'], message: 'CLOUDFLARE_ADMIN_TOKEN' })
    ).toEqual(['zoneId']);
    expect(notConfiguredNote({ message: 'Something else.' })).toEqual({
      description: 'Something else.',
      keysLink: false,
    });
    expect(notConfiguredNote().keysLink).toBe(true);
  });

  it('heads the page with what is missing', () => {
    expect(notConfiguredHeadline({ missing: ['token'] })).toBe(
      'Not set up yet: the admin token is missing.'
    );
    expect(notConfiguredHeadline({ missing: ['zoneId'] })).toBe(
      'Not set up yet: the zone id is missing (Terraform sets the zone id).'
    );
    expect(notConfiguredHeadline({ missing: [] })).toBe('Not set up yet.');
    expect(notConfiguredHeadline(null)).toBe('Not set up yet.');
  });
});

describe('a saved change that needs checking', () => {
  it('has no warning when the row was written and the name is open', () => {
    expect(changeWarning({ audited: true, protectedAfterWrite: false })).toBeNull();
    expect(changeWarning(true)).toBeNull();
    expect(changeWarning(undefined)).toBeNull();
  });

  it('warns when the audit row could not be written', () => {
    expect(changeWarning({ audited: false })).toMatch(/audit row could not be written/);
  });

  it('warns when a DNS edit came back under a protected name, and says both when both', () => {
    expect(changeWarning({ audited: true, protectedAfterWrite: true })).toMatch(
      /came back with a protected name/
    );
    expect(changeWarning({ audited: false, protectedAfterWrite: true })).toMatch(
      /protected name.*audit row could not be written/
    );
  });

  it('warns when a rule write landed just after another one (#1910)', () => {
    expect(changeWarning({ audited: true, concurrentWrite: true })).toMatch(
      /saved just before yours/
    );
    expect(changeWarning({ audited: true, concurrentWrite: false })).toBeNull();
  });
});

describe('the status for the picked zone (#1911)', () => {
  const SITE = 'hybridcloudworks.com';
  const LAB = 'hybridcloudinsights.com';
  const answer = (name) => ({ configured: true, ...(name ? { managed: { name } } : {}) });
  const read = (data, pending = false) => ({ loaded: Boolean(data), data, pending });

  it('uses an answer about the picked zone', () => {
    expect(zoneStatus(read(answer(LAB)), LAB)).toEqual({ status: answer(LAB), otherZone: false });
    expect(zoneStatus(read(answer(SITE)), SITE)).toEqual({
      status: answer(SITE),
      otherZone: false,
    });
  });

  it('reads an answer that names no zone (a server before #1911) as the site’s', () => {
    expect(zoneStatus(read(answer(null)), SITE).status).toEqual(answer(null));
    expect(zoneStatus(read(answer(null)), LAB)).toEqual({ status: null, otherZone: true });
  });

  it('shows nothing while the picked zone’s read is out, and says so once another zone’s answer has settled', () => {
    expect(zoneStatus(read(answer(SITE), true), LAB)).toEqual({ status: null, otherZone: false });
    expect(zoneStatus(read(answer(SITE)), LAB)).toEqual({ status: null, otherZone: true });
    expect(zoneStatus(read(null), LAB)).toEqual({ status: null, otherZone: false });
  });
});

describe('the page address (#1911)', () => {
  it('keeps the tab, and the zone unless it is the site’s', () => {
    expect(String(cloudflareParams('tab=dns', { zone: 'hybridcloudinsights.com' }))).toBe(
      'tab=dns&zone=hybridcloudinsights.com'
    );
    expect(String(cloudflareParams('tab=dns&zone=hybridcloudinsights.com', { tab: 'rules' }))).toBe(
      'tab=rules&zone=hybridcloudinsights.com'
    );
    expect(
      String(
        cloudflareParams('tab=dns&zone=hybridcloudinsights.com', { zone: 'hybridcloudworks.com' })
      )
    ).toBe('tab=dns');
    expect(String(cloudflareParams('tab=dns&zone=example.com', {}))).toBe('tab=dns');
    expect(String(cloudflareParams('program=x', { tab: 'cache' }))).toBe('program=x&tab=cache');
  });

  it('links a tab in the site’s zone by default, and in the lab zone when asked', () => {
    expect(tabHref('dns')).toBe('/admin/cloudflare?tab=dns');
    expect(tabHref('rules', 'hybridcloudinsights.com')).toBe(
      '/admin/cloudflare?tab=rules&zone=hybridcloudinsights.com'
    );
  });
});

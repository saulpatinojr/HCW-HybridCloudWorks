import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST,
  AuditReadError,
  DEFAULT_WINDOW_HOURS,
  ENV,
  HCP_TERRAFORM_TOKEN_NAME,
  ISSUE_TITLE_PREFIX,
  MAX_PAGES,
  ZONE_NAME,
  actionType,
  auditLogUrl,
  classify,
  describeActor,
  dnsRecordChanges,
  fetchAuditLog,
  isDnsRecordEntry,
  isLabAcmeChallenge,
  isProductionZone,
  main,
  maskEmail,
  normalise,
  parseArgs,
  parseWhen,
  recordFields,
  renderReport,
  resolveWindow,
} from './cloudflare-dns-audit.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cloudflare-dns-audit.mjs');

// Fixtures, written by hand from the documented Audit Logs v2 shape
// (developers.cloudflare.com/fundamentals/account/account-security/audit-logs/,
// "Example how to query Audit Logs"): id, account, action{description,result,
// time,type}, actor{id,context,email,ip_address,token_id,token_name,type},
// raw{cf_ray_id,method,status_code,uri,user_agent}, resource{id,product,
// request,response,scope,type}, zone{id,name}. The ids are RFC 5737 and
// made-up hex; nothing here is a real identifier.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const OTHER_ZONE = '11111111222222223333333344444444';
const OWNER = 'owner@example.com';
const CADDY_TOKEN = 'lab-caddy-dns01';
const SECRET_CONTENT = 'v=spf1 include:_spf.example.net -all';

let seq = 0;
function entry({ actor, action = 'create', result = 'success', time, record, zone = { id: ZONE, name: ZONE_NAME }, resource = {}, raw = {} }) {
  seq += 1;
  const id = `a${String(seq).padStart(31, '0')}`;
  const method = { create: 'POST', update: 'PATCH', delete: 'DELETE', view: 'GET' }[action];
  const recordId = resource.id ?? `r${String(seq).padStart(31, '0')}`;
  const body = record ? { id: recordId, name: record.name, type: record.type, content: record.content ?? SECRET_CONTENT, ttl: 1, proxied: false } : {};
  return {
    id,
    account: { id: ACCOUNT, name: 'HybridCloudWorks' },
    action: { description: `DNS record ${action}`, result, time: time ?? `2026-10-18T0${Math.min(seq, 9)}:00:00Z`, type: action },
    actor,
    raw: {
      cf_ray_id: '8e9b1c60ef9e1c9a',
      method,
      status_code: result === 'success' ? 200 : 403,
      uri: action === 'create' ? `/zones/${zone.id}/dns_records` : `/zones/${zone.id}/dns_records/${recordId}`,
      user_agent: 'test',
      ...raw,
    },
    resource: {
      id: recordId,
      product: 'dns',
      request: action === 'delete' ? {} : body,
      response: action === 'delete' ? { id: recordId } : { result: body },
      scope: { id: zone.id, type: 'zones' },
      type: 'dns_record',
      ...resource,
    },
    zone,
  };
}

const TERRAFORM = { id: 'f6b5de0326bb5182b8a4840ee01ec774', context: 'api_token', email: OWNER, ip_address: '203.0.113.10', token_id: 'c0ffee0123456789c0ffee0123456789', token_name: HCP_TERRAFORM_TOKEN_NAME, type: 'user' };
const CADDY = { id: 'f6b5de0326bb5182b8a4840ee01ec774', context: 'api_token', email: OWNER, ip_address: '198.51.100.7', token_id: 'dead00beef0123456789abcdefabcdef', token_name: CADDY_TOKEN, type: 'user' };
const OWNER_DASH = { id: 'f6b5de0326bb5182b8a4840ee01ec774', context: 'dash', email: OWNER, ip_address: '192.0.2.44', type: 'user' };
const STRANGER = { id: '0000000000000000000000000000beef', context: 'api_token', email: 'mallory@example.org', ip_address: '192.0.2.99', token_id: 'bad0bad0bad0bad0bad0bad0bad0bad0', token_name: 'totally-legit', type: 'user' };
// The shapes the first live run (2026-10-18) showed: no token_name or token_id anywhere.
const CADDY_HOST_IP = '198.51.100.7';
const TFC_ACCOUNT_TOKEN = { id: ACCOUNT, context: 'api_token', ip_address: '54.242.151.9', type: 'account' };
const OWNER_USER_TOKEN = { id: 'f6b5de0326bb5182b8a4840ee01ec774', context: 'api_token', email: OWNER, ip_address: '192.0.2.44', type: 'user' };
const CADDY_BY_IP = { id: ACCOUNT, context: 'api_token', ip_address: CADDY_HOST_IP, type: 'account' };
const TERRAFORM_RAW = { user_agent: 'terraform-provider-cloudflare/5.27.0 terraform-plugin-framework/1.15.0 Terraform/1.16.0' };

const envelope = (result, cursor = '') => ({ success: true, errors: [], messages: [], result, result_info: { count: String(result.length), cursor } });

/** A fetch that answers from `pages` (an array of bodies, one per cursor hop) and records every URL it was given. */
function fakeFetch(pages, { status = 200, text } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const cursor = new URL(url).searchParams.get('cursor') ?? '';
    const page = cursor === '' ? pages[0] : pages[Number(cursor.replace('cursor-', ''))];
    const body = text !== undefined ? text : JSON.stringify(page ?? envelope([]));
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const ENVIRONMENT = { [ENV.token]: 'cf-test-token-never-printed', [ENV.accountId]: ACCOUNT, [ENV.zoneId]: ZONE, [ENV.ownerEmail]: OWNER, [ENV.caddyTokenName]: CADDY_TOKEN, [ENV.caddyHostIp]: CADDY_HOST_IP };
const NOW = Date.parse('2026-10-18T05:50:00Z');

async function run(pages, { env = ENVIRONMENT, argv = [], fetchOptions } = {}) {
  const logs = [];
  const fetchImpl = fakeFetch(pages, fetchOptions);
  const dir = mkdtempSync(join(tmpdir(), 'cf-audit-'));
  const report = join(dir, 'report.md');
  const code = await main([...argv, '--report', report], { env, fetch: fetchImpl, now: NOW, log: (l) => logs.push(l) });
  let written = '';
  try {
    written = readFileSync(report, 'utf8');
  } catch {
    written = '';
  }
  return { code, out: logs.join('\n'), report: written, calls: fetchImpl.calls };
}

describe('the allowlist', () => {
  const settings = { zoneId: ZONE, ownerEmail: OWNER, caddyTokenName: CADDY_TOKEN, caddyHostIp: CADDY_HOST_IP };

  it('names four entries, each with a reason', () => {
    expect(ALLOWLIST.map((e) => e.id)).toEqual(['hcp-terraform', 'terraform-owner-token', 'caddy-acme', 'owner-dashboard']);
    for (const e of ALLOWLIST) expect(e.reason.length, e.id).toBeGreaterThan(40);
  });

  it("allows every record action by the HCP Terraform token, by the token's name when the log carries it", () => {
    const e = normalise(entry({ actor: TERRAFORM, action: 'update', record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' } }));
    expect(classify(e, settings)).toEqual({ verdict: 'EXPECTED', rule: 'hcp-terraform' });
    const del = normalise(entry({ actor: TERRAFORM, action: 'delete', resource: { request: {}, response: {} } }));
    expect(classify(del, settings)).toEqual({ verdict: 'EXPECTED', rule: 'hcp-terraform' });
  });

  it('allows the HCP Terraform token as the log really carries it: an account token with the provider user agent and no name', () => {
    // The shape of the first live run (2026-10-18): actor {context, id, ip_address, type}, no token fields.
    const e = normalise(entry({ actor: TFC_ACCOUNT_TOKEN, action: 'update', record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' }, raw: TERRAFORM_RAW }));
    expect(e.tokenName).toBe('');
    expect(classify(e, settings)).toEqual({ verdict: 'EXPECTED', rule: 'hcp-terraform' });
    const created = normalise(entry({ actor: TFC_ACCOUNT_TOKEN, action: 'create', record: { name: 'new.hybridcloudworks.com', type: 'A', content: '192.0.2.1' }, raw: TERRAFORM_RAW }));
    expect(classify(created, settings).rule).toBe('hcp-terraform');
  });

  it('refuses an account token without the provider user agent, and the provider user agent from the lab host', () => {
    const curl = normalise(entry({ actor: TFC_ACCOUNT_TOKEN, record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' }, raw: { user_agent: 'curl/8.5.0' } }));
    expect(classify(curl, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
    // A Terraform user agent is a header anyone can send: from the Caddy token's address it is the Caddy token, judged by its own rule.
    const fromHost = normalise(entry({ actor: { ...TFC_ACCOUNT_TOKEN, ip_address: CADDY_HOST_IP }, record: { name: 'www.hybridcloudworks.com', type: 'A', content: '192.0.2.1' }, raw: TERRAFORM_RAW }));
    expect(classify(fromHost, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
  });

  it("allows the owner's own terraform runs under their own entry, and not another user's", () => {
    // The 2026-10-06 00:26Z shape: a user-owned token, the owner's e-mail, the provider user agent.
    const owner = normalise(entry({ actor: OWNER_USER_TOKEN, action: 'update', record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' }, raw: TERRAFORM_RAW }));
    expect(classify(owner, settings)).toEqual({ verdict: 'EXPECTED', rule: 'terraform-owner-token' });
    const other = normalise(entry({ actor: { ...OWNER_USER_TOKEN, email: 'mallory@example.org' }, action: 'update', record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' }, raw: TERRAFORM_RAW }));
    expect(classify(other, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
    const ownerCurl = normalise(entry({ actor: OWNER_USER_TOKEN, action: 'update', record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' }, raw: { user_agent: 'curl/8.5.0' } }));
    expect(classify(ownerCurl, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
  });

  it('allows the Caddy token only on a TXT _acme-challenge record for a lab name', () => {
    const txt = normalise(entry({ actor: CADDY, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(txt, settings)).toEqual({ verdict: 'EXPECTED', rule: 'caddy-acme' });
    const coder = normalise(entry({ actor: CADDY, record: { name: '_acme-challenge.coder.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(coder, settings)).toEqual({ verdict: 'EXPECTED', rule: 'caddy-acme' });
  });

  it("allows the Caddy token by the lab host's address when the log carries no token name", () => {
    const txt = normalise(entry({ actor: CADDY_BY_IP, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' }, raw: { user_agent: 'Caddy/2.11.4 (libdns-cloudflare)' } }));
    expect(txt.tokenName).toBe('');
    expect(classify(txt, settings)).toEqual({ verdict: 'EXPECTED', rule: 'caddy-acme' });
    const a = normalise(entry({ actor: CADDY_BY_IP, record: { name: 'www.hybridcloudworks.com', type: 'A', content: '192.0.2.1' } }));
    expect(classify(a, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
    const elsewhere = normalise(entry({ actor: { ...CADDY_BY_IP, ip_address: '192.0.2.200' }, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(elsewhere, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
  });

  it('refuses the Caddy token on an A record, a non-challenge TXT, and a challenge for a site name', () => {
    const a = normalise(entry({ actor: CADDY, record: { name: 'www.hybridcloudworks.com', type: 'A', content: '192.0.2.1' } }));
    expect(classify(a, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
    const txt = normalise(entry({ actor: CADDY, record: { name: 'hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(txt, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
    const site = normalise(entry({ actor: CADDY, record: { name: '_acme-challenge.www.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(site, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
  });

  it("allows the owner's dashboard edits, not the owner's API-token edits, and not another dashboard user", () => {
    const dash = normalise(entry({ actor: OWNER_DASH, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } }));
    expect(classify(dash, settings)).toEqual({ verdict: 'EXPECTED', rule: 'owner-dashboard' });
    const upper = normalise(entry({ actor: { ...OWNER_DASH, email: OWNER.toUpperCase() }, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } }));
    expect(classify(upper, settings).verdict).toBe('EXPECTED');
    const api = normalise(entry({ actor: { ...OWNER_DASH, context: 'api_token', token_name: 'personal', token_id: '0123456789abcdef0123456789abcdef' }, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } }));
    expect(classify(api, settings).verdict).toBe('UNEXPECTED');
    const other = normalise(entry({ actor: { ...OWNER_DASH, email: 'someone@example.com' }, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } }));
    expect(classify(other, settings).verdict).toBe('UNEXPECTED');
  });

  it('is inactive, never permissive, when a setting it needs is unset', () => {
    const none = { zoneId: ZONE, ownerEmail: '', caddyTokenName: '', caddyHostIp: '' };
    const txt = normalise(entry({ actor: CADDY, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(txt, none).verdict).toBe('UNEXPECTED');
    const byIp = normalise(entry({ actor: CADDY_BY_IP, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(byIp, none).verdict).toBe('UNEXPECTED');
    const dash = normalise(entry({ actor: OWNER_DASH, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } }));
    expect(classify(dash, none).verdict).toBe('UNEXPECTED');
    const ownerTf = normalise(entry({ actor: OWNER_USER_TOKEN, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' }, raw: TERRAFORM_RAW }));
    expect(classify(ownerTf, none).verdict).toBe('UNEXPECTED');
    const unnamed = normalise(entry({ actor: { ...CADDY, token_name: '' }, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(unnamed, none).verdict).toBe('UNEXPECTED');
    // The HCP entry needs no setting; an empty caddyHostIp never makes it match a host request by accident.
    const tfc = normalise(entry({ actor: TFC_ACCOUNT_TOKEN, record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME' }, raw: TERRAFORM_RAW }));
    expect(classify(tfc, none)).toEqual({ verdict: 'EXPECTED', rule: 'hcp-terraform' });
  });

  it('refuses an unknown actor whatever the record', () => {
    const e = normalise(entry({ actor: STRANGER, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' } }));
    expect(classify(e, settings)).toEqual({ verdict: 'UNEXPECTED', rule: null });
  });
});

describe('reading an entry', () => {
  it('recognises a lab challenge name, case- and dot-insensitively, and nothing else', () => {
    expect(isLabAcmeChallenge('_acme-challenge.lab.hybridcloudworks.com')).toBe(true);
    expect(isLabAcmeChallenge('_ACME-Challenge.Coder.Lab.HybridCloudWorks.com.')).toBe(true);
    expect(isLabAcmeChallenge('_acme-challenge.hybridcloudworks.com')).toBe(false);
    expect(isLabAcmeChallenge('_acme-challenge.www.hybridcloudworks.com')).toBe(false);
    expect(isLabAcmeChallenge('lab.hybridcloudworks.com')).toBe(false);
    expect(isLabAcmeChallenge('_acme-challenge.lab.hybridcloudworks.com.evil.example')).toBe(false);
    expect(isLabAcmeChallenge(undefined)).toBe(false);
  });

  it('masks an e-mail to its first letter and domain', () => {
    expect(maskEmail('owner@example.com')).toBe('o***@example.com');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });

  it('reads the action type, falling back to the HTTP method', () => {
    expect(actionType({ action: { type: 'Update' } })).toBe('update');
    expect(actionType({ raw: { method: 'DELETE' } })).toBe('delete');
    expect(actionType({ raw: { method: 'GET' } })).toBe('view');
    expect(actionType({})).toBe('');
  });

  it('tells a DNS-record entry by resource type, by product, or by the request URI', () => {
    expect(isDnsRecordEntry({ resource: { type: 'dns_record' } })).toBe(true);
    expect(isDnsRecordEntry({ resource: { type: 'DNSRecord' } })).toBe(true);
    expect(isDnsRecordEntry({ resource: { product: 'dns', type: 'record' } })).toBe(true);
    expect(isDnsRecordEntry({ resource: { product: 'dns' } })).toBe(true);
    expect(isDnsRecordEntry({ raw: { uri: `/zones/${ZONE}/dns_records/abc` } })).toBe(true);
    expect(isDnsRecordEntry({ resource: { product: 'dns', type: 'dnssec' } })).toBe(false);
    expect(isDnsRecordEntry({ resource: { product: 'zone', type: 'zone_setting' }, raw: { uri: `/zones/${ZONE}/settings/ssl` } })).toBe(false);
    expect(isDnsRecordEntry({ resource: { product: 'members', type: 'member' } })).toBe(false);
  });

  it('matches the production zone by id when known and by name always', () => {
    expect(isProductionZone({ zone: { id: ZONE, name: '' } }, ZONE)).toBe(true);
    expect(isProductionZone({ zone: { id: OTHER_ZONE, name: ZONE_NAME } }, ZONE)).toBe(true);
    expect(isProductionZone({ zone: { id: OTHER_ZONE, name: 'other.example' } }, ZONE)).toBe(false);
    expect(isProductionZone({ zone: { name: ZONE_NAME } }, '')).toBe(true);
    expect(isProductionZone({ raw: { uri: `/zones/${ZONE}/dns_records` } }, ZONE)).toBe(true);
    expect(isProductionZone({}, '')).toBe(false);
  });

  it('reads the record name and type from the response, its result, the request or a value block', () => {
    expect(recordFields({ resource: { response: { result: { name: 'a.example', type: 'a' } } } })).toEqual({ name: 'a.example', type: 'A' });
    expect(recordFields({ resource: { response: {}, request: { name: 'b.example.', type: 'TXT' } } })).toEqual({ name: 'b.example', type: 'TXT' });
    expect(recordFields({ resource: { value: { name: 'c.example', type: 'CNAME' } } })).toEqual({ name: 'c.example', type: 'CNAME' });
    expect(recordFields({ resource: { response: { id: 'x' } } })).toEqual({ name: '', type: '' });
  });

  it('fills a bare delete from the create of the same record in the window', () => {
    const create = entry({ actor: CADDY, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT' }, resource: { id: 'r-same' } });
    const del = entry({ actor: CADDY, action: 'delete', resource: { id: 'r-same', request: {}, response: { id: 'r-same' } } });
    const got = normalise(del, [create, del]);
    expect(got).toMatchObject({ recordName: '_acme-challenge.lab.hybridcloudworks.com', recordType: 'TXT', nameSource: 'sibling', actionType: 'delete' });
    const alone = normalise(del, [del]);
    expect(alone).toMatchObject({ recordName: 'unknown', recordType: 'unknown', nameSource: 'none' });
  });

  it('keeps only create/update/delete on DNS records in the zone, oldest first', () => {
    const entries = [
      entry({ actor: TERRAFORM, action: 'update', time: '2026-10-18T03:00:00Z', record: { name: 'docs.hybridcloudworks.com', type: 'CNAME' } }),
      entry({ actor: TERRAFORM, action: 'view', time: '2026-10-18T02:00:00Z', record: { name: 'docs.hybridcloudworks.com', type: 'CNAME' } }),
      entry({ actor: TERRAFORM, action: 'create', time: '2026-10-18T01:00:00Z', record: { name: 'x.other.example', type: 'A' }, zone: { id: OTHER_ZONE, name: 'other.example' } }),
      entry({ actor: OWNER_DASH, action: 'update', time: '2026-10-18T00:30:00Z', record: { name: 'ssl', type: 'setting' }, resource: { product: 'zone', type: 'zone_setting' }, raw: { uri: `/zones/${ZONE}/settings/ssl` } }),
      entry({ actor: OWNER_DASH, action: 'create', time: '2026-10-18T00:10:00Z', record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } }),
    ];
    const got = dnsRecordChanges(entries, { zoneId: ZONE });
    expect(got.map((c) => [c.time, c.recordName])).toEqual([
      ['2026-10-18T00:10:00Z', 'www.hybridcloudworks.com'],
      ['2026-10-18T03:00:00Z', 'docs.hybridcloudworks.com'],
    ]);
  });

  it('describes a token by name, a dashboard user by masked e-mail, and anything else by type and id', () => {
    expect(describeActor(normalise(entry({ actor: TERRAFORM, record: { name: 'a', type: 'A' } })))).toBe(`token \`${HCP_TERRAFORM_TOKEN_NAME}\` (c0ffee01…) from 203.0.113.10`);
    expect(describeActor(normalise(entry({ actor: OWNER_DASH, record: { name: 'a', type: 'A' } })))).toBe('dashboard user o***@example.com from 192.0.2.44');
    expect(describeActor(normalise(entry({ actor: { id: 'sys1', type: 'system' }, record: { name: 'a', type: 'A' } })))).toBe('system sys1');
  });
});

describe('the window and the arguments', () => {
  it(`defaults to the last ${DEFAULT_WINDOW_HOURS} hours ending now`, () => {
    const w = resolveWindow(parseArgs([]), NOW);
    expect(w).toEqual({ since: '2026-10-17T03:50:00Z', before: '2026-10-18T05:50:00Z', hours: DEFAULT_WINDOW_HOURS });
  });

  it('takes --since and --before as dates or timestamps, and --hours', () => {
    expect(resolveWindow(parseArgs(['--since', '2026-10-01', '--before', '2026-10-02T12:00:00Z']), NOW)).toEqual({ since: '2026-10-01T00:00:00Z', before: '2026-10-02T12:00:00Z', hours: 36 });
    expect(resolveWindow(parseArgs(['--hours', '48']), NOW).since).toBe('2026-10-16T05:50:00Z');
    expect(parseWhen('2026-13-45')).toBeNull();
    expect(parseWhen('yesterday')).toBeNull();
  });

  it('refuses an unknown flag, a flag without a value, a bad --hours, and an inverted window', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(AuditReadError);
    expect(() => parseArgs(['--since'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--hours', '0'])).toThrow(/positive/);
    expect(() => resolveWindow(parseArgs(['--since', '2026-10-18', '--before', '2026-10-17']), NOW)).toThrow(/before/);
  });

  it('builds the list URL with the window, the page size, ascending order and the cursor', () => {
    const url = new URL(auditLogUrl({ accountId: ACCOUNT, since: '2026-10-17T03:50:00Z', before: '2026-10-18T05:50:00Z', cursor: 'abc=' }));
    expect(url.origin + url.pathname).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/logs/audit`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ since: '2026-10-17T03:50:00Z', before: '2026-10-18T05:50:00Z', limit: '1000', direction: 'asc', cursor: 'abc=' });
    expect(new URL(auditLogUrl({ accountId: ACCOUNT, since: 'a', before: 'b' })).searchParams.has('cursor')).toBe(false);
  });
});

describe('fetchAuditLog', () => {
  it('follows the cursor across two pages and sends the bearer token', async () => {
    const first = [entry({ actor: TERRAFORM, record: { name: 'a.hybridcloudworks.com', type: 'A' } })];
    const second = [entry({ actor: TERRAFORM, record: { name: 'b.hybridcloudworks.com', type: 'A' } })];
    const fetchImpl = fakeFetch([envelope(first, 'cursor-1'), envelope(second, '')]);
    const got = await fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl });
    expect(got.pages).toBe(2);
    expect(got.entries.map((e) => e.id)).toEqual([first[0].id, second[0].id]);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(fetchImpl.calls[1].url).toContain('cursor=cursor-1');
    expect(fetchImpl.calls[0].init.headers.authorization).toBe('Bearer tok');
  });

  it('stops on an empty page even when a cursor comes with it, and refuses a cursor that repeats', async () => {
    const stop = fakeFetch([envelope([], 'cursor-1')]);
    expect((await fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: stop })).pages).toBe(1);
    const loop = fakeFetch([envelope([entry({ actor: TERRAFORM, record: { name: 'a', type: 'A' } })], 'cursor-1'), envelope([entry({ actor: TERRAFORM, record: { name: 'b', type: 'A' } })], 'cursor-1')]);
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: loop })).rejects.toThrow(/cursor repeated/);
  });

  it(`fails past ${MAX_PAGES} pages rather than reporting a prefix as the window`, async () => {
    const endless = async (url) => {
      const n = Number(new URL(url).searchParams.get('cursor')?.replace('cursor-', '') ?? 0) + 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(envelope([entry({ actor: TERRAFORM, record: { name: 'a', type: 'A' } })], `cursor-${n}`)) };
    };
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: endless })).rejects.toThrow(new RegExp(`more than ${MAX_PAGES} pages`));
  });

  it('turns a non-200, a non-JSON body, a success:false envelope and a thrown fetch into AuditReadError, never into an empty window', async () => {
    const forbidden = fakeFetch([], { status: 403, text: JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }) });
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: forbidden })).rejects.toThrow(/HTTP 403 \(Authentication error\)/);
    const html = fakeFetch([], { status: 200, text: '<html>maintenance</html>' });
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: html })).rejects.toThrow(/not the `success: true` envelope/);
    const refused = fakeFetch([], { status: 200, text: JSON.stringify({ success: false, errors: [{ message: 'nope' }], result: [] }) });
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: refused })).rejects.toThrow(/envelope.*nope/);
    const empty200 = fakeFetch([], { status: 502, text: '' });
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: empty200 })).rejects.toThrow(/HTTP 502/);
    const down = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(fetchAuditLog({ accountId: ACCOUNT, since: 's', before: 'b', token: 'tok', fetchImpl: down })).rejects.toThrow(/request failed \(ECONNRESET\)/);
  });
});

describe('main', () => {
  it('exits 0 on an empty window and says nothing changed', async () => {
    const got = await run([envelope([])]);
    expect(got.code).toBe(0);
    expect(got.report).toContain('0 DNS-record changes on the zone, **0 unexpected**');
    expect(got.report).toContain('No DNS record in the zone was created, updated or deleted in the window.');
    expect(got.calls).toHaveLength(1);
    expect(got.calls[0].url).toContain('since=2026-10-17T03%3A50%3A00Z');
  });

  it("exits 0 on an expected Terraform edit and an expected Caddy challenge, and prints neither the token nor a record's content", async () => {
    const pages = [
      envelope([
        entry({ actor: TERRAFORM, action: 'update', record: { name: 'api-azure.hybridcloudworks.com', type: 'CNAME', content: 'func-site-prod-cus-01.azurewebsites.net' } }),
        entry({ actor: CADDY, record: { name: '_acme-challenge.lab.hybridcloudworks.com', type: 'TXT', content: 'AbCdEf-challenge-token-0123456789' }, resource: { id: 'r-acme' } }),
        entry({ actor: CADDY, action: 'delete', resource: { id: 'r-acme', request: {}, response: { id: 'r-acme' } } }),
      ]),
    ];
    const got = await run(pages);
    expect(got.code).toBe(0);
    expect(got.report).toContain('3 DNS-record changes on the zone, **0 unexpected**');
    expect(got.report).toContain('| EXPECTED (`hcp-terraform`) |');
    expect(got.report).toContain('| TXT | `_acme-challenge.lab.hybridcloudworks.com` | EXPECTED (`caddy-acme`) |');
    expect(got.report).toContain('| delete | TXT | `_acme-challenge.lab.hybridcloudworks.com (from the paired entry)` | EXPECTED (`caddy-acme`) |');
    expect(got.report).toContain('`hcp-terraform` active, `terraform-owner-token` active, `caddy-acme` active, `owner-dashboard` active.');
    for (const secret of ['cf-test-token-never-printed', 'func-site-prod-cus-01.azurewebsites.net', 'AbCdEf-challenge-token', SECRET_CONTENT, OWNER]) {
      expect(got.report, secret).not.toContain(secret);
      expect(got.out, secret).not.toContain(secret);
    }
  });

  it('exits 2 on an A record from the Caddy token, naming it UNEXPECTED beside the expected rows', async () => {
    const pages = [
      envelope([
        entry({ actor: CADDY, record: { name: '_acme-challenge.coder.lab.hybridcloudworks.com', type: 'TXT' } }),
        entry({ actor: CADDY, record: { name: 'www.hybridcloudworks.com', type: 'A', content: '192.0.2.1' } }),
      ]),
    ];
    const got = await run(pages);
    expect(got.code).toBe(2);
    expect(got.report).toContain('2 DNS-record changes on the zone, **1 unexpected**');
    expect(got.report).toContain(`| token \`${CADDY_TOKEN}\` (dead00be…) from 198.51.100.7 | create | A | \`www.hybridcloudworks.com\` | **UNEXPECTED** |`);
    expect(got.report).toContain('matched no allowlist entry');
    expect(got.report).not.toContain('192.0.2.1');
  });

  it('exits 2 on an unknown actor, with the masked e-mail and the entry id for the dashboard', async () => {
    const e = entry({ actor: STRANGER, action: 'delete', resource: { request: {}, response: {} } });
    const got = await run([envelope([e])]);
    expect(got.code).toBe(2);
    expect(got.report).toContain('| token `totally-legit` (bad0bad0…) from 192.0.2.99 | delete | unknown | `unknown` | **UNEXPECTED** |');
    expect(got.report).toContain(`\`${e.id}\``);
    expect(got.report).not.toContain('mallory@example.org');
  });

  it('exits 2, not 0, on a dashboard edit while the owner e-mail is unset, and the report says the entry is inactive', async () => {
    const env = { ...ENVIRONMENT, [ENV.ownerEmail]: '' };
    const got = await run([envelope([entry({ actor: OWNER_DASH, record: { name: 'www.hybridcloudworks.com', type: 'CNAME' } })])], { env });
    expect(got.code).toBe(2);
    expect(got.report).toContain(`\`owner-dashboard\` inactive (\`${ENV.ownerEmail}\` unset; its edits read UNEXPECTED)`);
  });

  it('reads across two pages and judges both', async () => {
    const pages = [
      envelope([entry({ actor: TERRAFORM, record: { name: 'a.hybridcloudworks.com', type: 'A' } })], 'cursor-1'),
      envelope([entry({ actor: STRANGER, record: { name: 'b.hybridcloudworks.com', type: 'A' } })], ''),
    ];
    const got = await run(pages);
    expect(got.code).toBe(2);
    expect(got.calls).toHaveLength(2);
    expect(got.report).toContain('over 2 pages; 2 DNS-record changes on the zone, **1 unexpected**');
  });

  it('exits 1 on a non-200, and the report says the log was not read', async () => {
    const got = await run([], { fetchOptions: { status: 401, text: JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }], result: null }) } });
    expect(got.code).toBe(1);
    expect(got.out).toContain('::error::Cloudflare DNS audit did not run: page 1: HTTP 401 (Invalid API Token)');
    expect(got.report).toContain('**The audit log was not read:** page 1: HTTP 401 (Invalid API Token)');
    expect(got.report).not.toContain('UNEXPECTED');
    expect(got.out).not.toContain('cf-test-token-never-printed');
  });

  it('exits 1 without the token or the account id, naming the missing name, and fetches nothing', async () => {
    const noToken = await run([envelope([])], { env: { ...ENVIRONMENT, [ENV.token]: '' } });
    expect(noToken.code).toBe(1);
    expect(noToken.out).toContain(`${ENV.token} is not set`);
    expect(noToken.calls).toHaveLength(0);
    const noAccount = await run([envelope([])], { env: { ...ENVIRONMENT, [ENV.accountId]: '  ' } });
    expect(noAccount.code).toBe(1);
    expect(noAccount.out).toContain(`${ENV.accountId} is not set`);
    expect(noAccount.calls).toHaveLength(0);
  });

  it('exits 1 on an argument it cannot parse, with the usage', async () => {
    const got = await run([envelope([])], { argv: ['--since', 'yesterday'] });
    expect(got.code).toBe(1);
    expect(got.out).toContain('--since "yesterday" is not a YYYY-MM-DD date or RFC3339 timestamp');
    const bad = await main(['--bogus'], { env: ENVIRONMENT, log: () => {} });
    expect(bad).toBe(1);
  });

  it('renders a pipe in a record name without breaking the table', () => {
    const judged = [{ ...normalise(entry({ actor: STRANGER, record: { name: 'a|b.hybridcloudworks.com', type: 'TXT' } })), verdict: 'UNEXPECTED', rule: null }];
    const md = renderReport({ window: { since: 's', before: 'b', hours: 26 }, entries: 1, pages: 1, judged, settings: { ownerEmail: OWNER, caddyTokenName: CADDY_TOKEN, zoneId: ZONE } });
    expect(md).toContain('`a\\|b.hybridcloudworks.com`');
  });

  it('renders a backslash before a pipe without the pipe becoming a column break', () => {
    // `a\|b` escaped pipe-only would read `a\\|b`: a literal backslash, then a
    // live pipe. Backslashes are doubled first, so the pipe's escape survives.
    const judged = [{ ...normalise(entry({ actor: STRANGER, record: { name: 'a\\|b.hybridcloudworks.com', type: 'TXT' } })), verdict: 'UNEXPECTED', rule: null }];
    const md = renderReport({ window: { since: 's', before: 'b', hours: 26 }, entries: 1, pages: 1, judged, settings: { ownerEmail: OWNER, caddyTokenName: CADDY_TOKEN, zoneId: ZONE } });
    expect(md).toContain('`a\\\\\\|b.hybridcloudworks.com`');
    const row = md.split('\n').find((l) => l.startsWith('| ') && l.includes('UNEXPECTED'));
    expect(row.split(/(?<!\\)\|/).length).toBe(md.split('\n').find((l) => l.startsWith('| Time')).split('|').length);
  });

  it('prints the shape of each unexpected entry: actor field names, method and user agent, never values', () => {
    const actor = { id: ACCOUNT, context: 'api_token', ip_address: '54.242.151.9', type: 'account' };
    const longUa = 'terraform-provider-cloudflare/5.12.0 (+https://registry.terraform.io/providers/cloudflare/cloudflare) Terraform/1.16.0';
    const raw = { user_agent: longUa, method: 'post' };
    const judged = [{ ...normalise(entry({ actor, record: { name: 'edge.hybridcloudworks.com', type: 'A' }, raw })), verdict: 'UNEXPECTED', rule: null }];
    const md = renderReport({ window: { since: 's', before: 'b', hours: 26 }, entries: 1, pages: 1, judged, settings: { ownerEmail: OWNER, caddyTokenName: CADDY_TOKEN, zoneId: ZONE } });
    const shape = md.split('\n').find((l) => l.startsWith('- `') && l.includes('actor fields'));
    expect(shape).toContain('actor fields `{context,id,ip_address,type}`');
    expect(shape).toContain('`POST`');
    expect(shape).toContain(`\`${longUa.slice(0, 60)}…\``);
    expect(shape).not.toContain(ACCOUNT);
    expect(shape).not.toContain(SECRET_CONTENT);
  });

  it('keeps a hostile user agent inside its code span: backticks and link syntax render as text', () => {
    const actor = { id: ACCOUNT, context: 'api_token', ip_address: '192.0.2.99', type: 'account' };
    const raw = { user_agent: '`[click me](https://evil.example)` curl', method: 'POST' };
    const judged = [{ ...normalise(entry({ actor, record: { name: 'x.hybridcloudworks.com', type: 'A' }, raw })), verdict: 'UNEXPECTED', rule: null }];
    const md = renderReport({ window: { since: 's', before: 'b', hours: 26 }, entries: 1, pages: 1, judged, settings: { ownerEmail: OWNER, caddyTokenName: CADDY_TOKEN, zoneId: ZONE } });
    const shape = md.split('\n').find((l) => l.startsWith('- `') && l.includes('actor fields'));
    expect(shape).toContain("user agent `'[click me](https://evil.example)' curl`");
    // Every code span on the line opens and closes: an even count of backticks, none from the value.
    expect((shape.match(/`/g) || []).length % 2).toBe(0);
  });

  it('prints no shape section when every change is expected', () => {
    const judged = [{ ...normalise(entry({ actor: TERRAFORM, record: { name: 'edge.hybridcloudworks.com', type: 'A' } })), verdict: 'EXPECTED', rule: 'hcp-terraform' }];
    const md = renderReport({ window: { since: 's', before: 'b', hours: 26 }, entries: 1, pages: 1, judged, settings: { ownerEmail: OWNER, caddyTokenName: CADDY_TOKEN, zoneId: ZONE } });
    expect(md).not.toContain('Shape of the unexpected entries');
  });
});

describe('the entry point', () => {
  function spawn(args, env) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  it('prints usage for --help and exits 0', () => {
    const got = spawn(['--help'], process.env);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain('Usage: node scripts/cloudflare-dns-audit.mjs');
    expect(got.stdout).toContain(ENV.token);
  });

  it('exits 1, not 0, without a token, before any request is made', () => {
    const env = { ...process.env };
    delete env[ENV.token];
    delete env[ENV.accountId];
    const got = spawn([], env);
    expect(got.code).toBe(1);
    expect(got.stdout + got.stderr).toContain(`${ENV.token} is not set`);
  });

  it('exports the issue title prefix the workflow searches by', () => {
    expect(ISSUE_TITLE_PREFIX).toBe('Cloudflare DNS audit: unexpected record change');
  });
});

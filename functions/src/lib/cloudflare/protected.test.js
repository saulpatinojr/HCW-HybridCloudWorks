/**
 * The protected list (#1905) held to the Terraform that manages the zone:
 * every DNS record in infra/frontend.tf and infra-lab/dns.tf, and every rule
 * phase in infra/, must be on it, or the Cloudflare page could change what
 * the next Terraform run would undo. The protected phases are exactly the
 * ones infra/ writes, so a phase Terraform gives up (the API rate limit,
 * #1903) is not left locked, and one it takes on is never left editable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terraformSource } from '../../../test/terraform-source.js';
import {
  APEX_WILDCARD_REASON,
  CONFIG_RULES_SETTINGS_PAGE,
  RULE_SETTING_PARAMETERS,
  UNLISTED_RULE_SETTING_REASON,
  ownerOnlyRuleTouches,
  EDITABLE_PHASES,
  LAB_ACME_TARGET,
  LAB_SUBTREE,
  LAB_ZONE,
  MANAGED_ZONES,
  OWNER_ONLY_SETTINGS,
  PROTECTED_DNS_NAMES,
  PROTECTED_PHASES,
  READ_ONLY_PHASE_REASON,
  SITE_ZONE,
  UNMANAGED_ZONE_REASON,
  ZONE_APEX,
  checkDnsName,
  dnsNameProtection,
  isEditablePhase,
  managedZone,
  otherManagedZone,
  protectionIn,
  normalizeDnsName,
  ownerOnlySettingReason,
  phaseProtection,
} from './protected.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const infra = terraformSource(join(ROOT, 'infra'));
const frontend = readFileSync(join(ROOT, 'infra/frontend.tf'), 'utf8');
const labDns = readFileSync(join(ROOT, 'infra-lab/dns.tf'), 'utf8');
const labVariables = readFileSync(join(ROOT, 'infra-lab/variables.tf'), 'utf8');
/** Both Terraform configurations that write to the zone: the site's (infra/) and the lab's (infra-lab/). */
const zoneTerraform = [infra, terraformSource(join(ROOT, 'infra-lab'))].join('\n');

/** A variable's string default, read from its block. */
function defaultOf(source, name) {
  const block = new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*"([^"]+)"`).exec(source);
  expect(block, `variable ${name} has no default`).not.toBeNull();
  return block[1];
}

describe('the protected DNS names', () => {
  it('names the zone Terraform serves on', () => {
    expect(defaultOf(infra, 'domain')).toBe(ZONE_APEX);
  });

  it('holds every cloudflare_dns_record in infra/frontend.tf', () => {
    const names = [...frontend.matchAll(/resource "cloudflare_dns_record" "[^"]+" \{[\s\S]*?\n {2}name\s*=\s*"([^"]+)"/g)].map(
      (match) => match[1].replace('${var.domain}', ZONE_APEX)
    );
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      expect(name, 'a name with an unread variable').not.toContain('${');
      expect(dnsNameProtection(name), name).not.toBeNull();
    }
  });

  it('holds every record infra-lab/dns.tf makes, read from its variables’ defaults', () => {
    const lab = defaultOf(labVariables, 'lab_hostname');
    // The A record is the lab host's name itself; the others come from two locals.
    expect(labDns).toMatch(/resource "cloudflare_dns_record" "lab" \{[\s\S]*?name\s*=\s*var\.lab_hostname/);
    const local = [...labDns.matchAll(/^\s+[a-z_]+\s*=\s*"([^"]*\$\{var\.lab_hostname\}[^"]*)"/gm)].map((match) =>
      match[1].replace('${var.lab_hostname}', lab)
    );
    expect(local.length).toBeGreaterThanOrEqual(5);
    for (const name of [lab, ...local]) {
      expect(dnsNameProtection(name), name).not.toBeNull();
      expect(PROTECTED_DNS_NAMES.map((entry) => entry.name), name).toContain(name);
    }
  });

  it('protects the site itself, every _acme-challenge name and everything under a wildcard, and nothing else by accident', () => {
    for (const name of ['@', ZONE_APEX, `${ZONE_APEX}.`, 'www', `WWW.${ZONE_APEX}`, '_acme-challenge.blog', `_acme-challenge.${ZONE_APEX}`, `x.lab.${ZONE_APEX}`, `a.b.coder.lab.${ZONE_APEX}`]) {
      expect(dnsNameProtection(name), name).not.toBeNull();
    }
    for (const name of ['blog', `blog.${ZONE_APEX}`, `wwww.${ZONE_APEX}`, `docs2.${ZONE_APEX}`, `labs.${ZONE_APEX}`, `www.go.${ZONE_APEX}`]) {
      expect(dnsNameProtection(name), name).toBeNull();
    }
  });

  it('reads a name the way Cloudflare does', () => {
    expect(normalizeDnsName('@')).toBe(ZONE_APEX);
    expect(normalizeDnsName('Blog.')).toBe(`blog.${ZONE_APEX}`);
    expect(normalizeDnsName(`docs.${ZONE_APEX}`)).toBe(`docs.${ZONE_APEX}`);
  });

  it('gives every entry a reason that names where it is managed or what it is', () => {
    for (const entry of PROTECTED_DNS_NAMES) expect(entry.reason.length, entry.name).toBeGreaterThan(20);
  });
});

describe('the protected rule phases', () => {
  // Every phase infra/ and infra-lab/ write rules into, as Terraform names them.
  const literalPhases = [...zoneTerraform.matchAll(/^\s*phase\s*=\s*"([a-z_]+)"/gm)].map((match) => match[1]);
  const terraformPhases = [...new Set(literalPhases)].sort();

  it('reads every ruleset’s phase as a plain name, so none can slip past the list', () => {
    const rulesets = [...zoneTerraform.matchAll(/^resource "cloudflare_ruleset" "[^"]+"/gm)];
    const phaseLines = [...zoneTerraform.matchAll(/^\s*phase\s*=/gm)];
    expect(rulesets.length).toBeGreaterThanOrEqual(1);
    // A phase written as a variable or an expression would be a ruleset with no literal phase line.
    expect(literalPhases.length, 'a cloudflare_ruleset whose phase is not a plain "name"').toBe(rulesets.length);
    expect(phaseLines.length, 'a phase = line whose value is not a plain "name"').toBe(literalPhases.length);
  });

  it('protects exactly the phases Terraform writes rules into, each with its own reason', () => {
    expect(terraformPhases).toContain('http_request_late_transform');
    expect(PROTECTED_PHASES.map((entry) => entry.phase).sort()).toEqual(terraformPhases);
    for (const phase of terraformPhases) {
      expect(isEditablePhase(phase), phase).toBe(false);
      expect(phaseProtection(phase), phase).not.toBe(READ_ONLY_PHASE_REASON);
      expect(phaseProtection(phase), phase).not.toBeNull();
    }
  });

  it('protects only the origin rule: the API rate limit is the Cloudflare page’s since #1903', () => {
    expect(PROTECTED_PHASES.map((entry) => entry.phase)).toEqual(['http_request_late_transform']);
    expect(phaseProtection('HTTP_REQUEST_LATE_TRANSFORM')).not.toBeNull();
    expect(phaseProtection('http_ratelimit')).toBeNull();
    expect(phaseProtection('HTTP_RATELIMIT')).toBeNull();
    expect(terraformPhases, 'Terraform writes the rate limit again: move it back to PROTECTED_PHASES').not.toContain('http_ratelimit');
  });
});

describe('the allow-list of rule phases', () => {
  it('names exactly the six phases that may be replaced, each with a plain description', () => {
    expect(EDITABLE_PHASES.map((entry) => entry.phase)).toEqual([
      'http_request_dynamic_redirect',
      'http_request_transform',
      'http_response_headers_transform',
      'http_config_settings',
      'http_request_firewall_custom',
      'http_ratelimit',
    ]);
    expect(EDITABLE_PHASES.find((entry) => entry.phase === 'http_ratelimit').description).toBe(
      'Rate limiting: limit how many requests one address can make, for example to the API.'
    );
    for (const entry of EDITABLE_PHASES) {
      expect(entry.description.length, entry.phase).toBeGreaterThan(20);
      expect(isEditablePhase(entry.phase)).toBe(true);
      expect(phaseProtection(entry.phase)).toBeNull();
    }
  });

  it('never lists a Terraform phase as editable', () => {
    for (const entry of PROTECTED_PHASES) expect(isEditablePhase(entry.phase), entry.phase).toBe(false);
  });

  it.each([
    'http_request_origin',
    'http_request_cache_settings',
    'http_request_cloud_connector',
    'http_request_snippets',
    'http_request_firewall_managed',
    'ddos_l7',
    'http_request_something_new',
    '',
  ])('reads %j as read-only, with the sentence about traffic', (phase) => {
    expect(isEditablePhase(phase)).toBe(false);
    expect(phaseProtection(phase)).toBe(READ_ONLY_PHASE_REASON);
  });

  it('says why in plain words', () => {
    expect(READ_ONLY_PHASE_REASON).toMatch(/can send or store the site's traffic elsewhere, so it is changed in the Cloudflare dashboard/);
  });
});

describe('the owner-only settings', () => {
  it('lists the eleven settings that decide how connections are encrypted, each with a reason telling the owner what to do', () => {
    // The last six since #1933, each id checked on Cloudflare's own page on 2026-11-27.
    expect(OWNER_ONLY_SETTINGS.map((entry) => entry.setting)).toEqual([
      'ssl',
      'min_tls_version',
      'always_use_https',
      'security_header',
      'tls_client_auth',
      'tls_1_3',
      'ciphers',
      'ssl_automatic_mode',
      '0rtt',
      'sha1_support',
      'tls_1_2_only',
    ]);
    for (const entry of OWNER_ONLY_SETTINGS) {
      expect(ownerOnlySettingReason(entry.setting)).toMatch(/Change it on the Cloudflare page yourself/);
    }
    expect(ownerOnlySettingReason('SSL')).not.toBeNull();
    expect(ownerOnlySettingReason('brotli')).toBeNull();
  });
});

describe('the rule fields that stand in for an owner-only setting (#1931)', () => {
  const entryFor = (phase) => RULE_SETTING_PARAMETERS.find((entry) => entry.phase === phase);

  it('lists every configuration rule field on Cloudflare’s settings page, read 2026-11-27, closed to anything else', () => {
    expect(CONFIG_RULES_SETTINGS_PAGE).toBe('https://developers.cloudflare.com/rules/configuration-rules/settings/');
    const config = entryFor('http_config_settings');
    expect(config).toMatchObject({ place: 'parameter', closed: true });
    expect(Object.keys(config.names).sort()).toEqual([
      'automatic_https_rewrites',
      'bic',
      'content_converter',
      'disable_rum',
      'disable_zaraz',
      'email_obfuscation',
      'fonts',
      'hotlink_protection',
      'opportunistic_encryption',
      'polish',
      'request_body_buffering',
      'response_body_buffering',
      'rocket_loader',
      'security_level',
      'ssl',
    ]);
  });

  it('maps only ssl (configuration rules) and the Strict-Transport-Security header (HSTS) to owner-only settings', () => {
    const mapped = RULE_SETTING_PARAMETERS.flatMap((entry) => Object.entries(entry.names).filter(([, setting]) => setting).map(([name, setting]) => `${entry.phase} ${name} ${setting}`));
    expect(mapped).toEqual([
      'http_config_settings ssl ssl',
      'http_response_headers_transform strict-transport-security security_header',
    ]);
    for (const entry of RULE_SETTING_PARAMETERS) {
      expect(isEditablePhase(entry.phase), entry.phase).toBe(true);
      for (const setting of Object.values(entry.names).filter(Boolean)) expect(ownerOnlySettingReason(setting), setting).not.toBeNull();
    }
  });

  it('finds what a rule sets, in any letter case, and refuses an unlisted configuration field', () => {
    const touched = (phase, parameters) => ownerOnlyRuleTouches(phase, { action_parameters: parameters }).map(({ name, setting }) => [name, setting]);
    expect(touched('http_config_settings', { ssl: 'off', fonts: true })).toEqual([['ssl', 'ssl']]);
    expect(touched('http_config_settings', { SSL: 'off' })).toEqual([['ssl', 'ssl']]);
    expect(touched('http_config_settings', { fonts: true, polish: 'lossy' })).toEqual([]);
    expect(touched('http_config_settings', { mirage: true })).toEqual([['mirage', null]]);
    expect(ownerOnlyRuleTouches('http_config_settings', { action_parameters: { mirage: true } })[0].reason).toBe(UNLISTED_RULE_SETTING_REASON);
    expect(touched('http_response_headers_transform', { headers: { 'Strict-Transport-Security': { operation: 'remove' }, 'X-Frame-Options': {} } })).toEqual([
      ['strict-transport-security', 'security_header'],
    ]);
    expect(touched('http_response_headers_transform', { headers: { 'X-Frame-Options': {} } })).toEqual([]);
    // The other editable phases set no zone setting, and a rule with no parameters touches nothing.
    expect(touched('http_request_dynamic_redirect', { ssl: 'off' })).toEqual([]);
    expect(touched('http_request_transform', { ssl: 'off' })).toEqual([]);
    expect(ownerOnlyRuleTouches('http_config_settings', { expression: 'true' })).toEqual([]);
    expect(ownerOnlyRuleTouches('http_config_settings', { action_parameters: ['ssl'] })).toEqual([]);
  });
});

describe('a name a caller sends', () => {
  it.each([
    ['@', ZONE_APEX],
    ['blog', `blog.${ZONE_APEX}`],
    ['Blog', `blog.${ZONE_APEX}`],
    [ZONE_APEX, ZONE_APEX],
    [`shop.${ZONE_APEX}`, `shop.${ZONE_APEX}`],
    ['*', `*.${ZONE_APEX}`],
    ['*.blog', `*.blog.${ZONE_APEX}`],
    ['_dmarc', `_dmarc.${ZONE_APEX}`],
  ])('reads %j as %j', (name, full) => {
    expect(checkDnsName(name)).toEqual({ name: full });
  });

  it.each(['', '.', '..', '.blog', 'blog.', 'a..b', '@.blog', 'blog.@', 'a@b', 'blog.*', '*a', 'a.*.b', '**', 'a b', `${'a'.repeat(64)}`])(
    'refuses %j with a sentence',
    (name) => {
      expect(checkDnsName(name).problem).toMatch(/\w/);
    }
  );

  it('refuses a name longer than 253 characters in full', () => {
    const long = Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.');
    expect(checkDnsName(long).problem).toMatch(/253/);
  });
});

describe('wildcards', () => {
  it('protects the zone-wide wildcard and any wildcard over a protected name', () => {
    expect(dnsNameProtection('*')).toBe(APEX_WILDCARD_REASON);
    expect(dnsNameProtection(`*.${ZONE_APEX}`)).toBe(APEX_WILDCARD_REASON);
    for (const name of ['*.api-azure', '*.www', '*.docs', '*._acme-challenge', '*.lab', '*.x.lab', `*.asuid.api-azure.${ZONE_APEX}`]) {
      expect(dnsNameProtection(name), name).not.toBeNull();
    }
    // Every other wildcard too: *.blog would answer _acme-challenge.blog (#1913 review).
    for (const name of ['*.blog', '*.shop.blog', `*.api-azure2.${ZONE_APEX}`]) {
      expect(dnsNameProtection(name), name).not.toBeNull();
    }
  });
});

describe('the module itself', () => {
  it('imports nothing, so the browser can mirror it', () => {
    const source = readFileSync(join(ROOT, 'functions/src/lib/cloudflare/protected.js'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe('the managed zones (#1911)', () => {
  it('names exactly the site’s zone, first, and the lab zone, each with its role', () => {
    expect(MANAGED_ZONES.map((zone) => zone.name)).toEqual([ZONE_APEX, LAB_ZONE]);
    expect(SITE_ZONE).toBe(ZONE_APEX);
    for (const zone of MANAGED_ZONES) expect(zone.role.length, zone.name).toBeGreaterThan(40);
  });

  it('names the lab zone Caddy writes into (infra-lab/variables.tf, the delegation target)', () => {
    expect(defaultOf(labVariables, 'lab_acme_challenge_target')).toBe(`_acme-challenge.lab.${LAB_ZONE}`);
  });

  it('reads a zone name in any letter case, and nothing else', () => {
    expect(managedZone('HybridCloudInsights.com')?.name).toBe(LAB_ZONE);
    for (const name of ['', 'example.com', `${LAB_ZONE}.`, ` ${LAB_ZONE}`, `x.${LAB_ZONE}`, null, undefined]) {
      expect(managedZone(name), String(name)).toBeNull();
    }
  });

  const lab = (name) => dnsNameProtection(name, LAB_ZONE);

  it('protects every name starting _ in the lab zone, Caddy’s checks and verification names alike (R1)', () => {
    for (const name of ['_acme-challenge', '_acme-challenge.note', '_acme-challenge-x', '_atproto', '_dmarc', '_domainkey', '_gh-example-o', '_foo.www', '_']) {
      expect(lab(name), name).toMatch(/Caddy.*lab-host\/README\.md.*_dmarc/);
    }
  });

  it('derives the protected lab subtree from the delegation target infra-lab points at', () => {
    expect(LAB_ACME_TARGET).toBe(defaultOf(labVariables, 'lab_acme_challenge_target'));
    expect(LAB_SUBTREE).toBe(`lab.${LAB_ZONE}`);
    expect(LAB_ACME_TARGET.endsWith(`.${LAB_SUBTREE}`)).toBe(true);
  });

  it.each(['lab', 'x.lab', 'a.b.lab', '_acme-challenge.lab', `_acme-challenge.lab.${LAB_ZONE}`, 'LAB'])('protects %s, in the lab’s certificate subtree', (name) => {
    expect(lab(name)).toMatch(/certificate.*lab-host\/README\.md/);
  });

  it.each(['*', '*.lab', '*.x.lab', '*.foo', '*.www', '*.a.b', `*.${LAB_ZONE}`])('refuses the wildcard %s in the lab zone (#1911 review F1)', (name) => {
    expect(lab(name)).not.toBeNull();
    if (name !== '*' && name !== `*.${LAB_ZONE}`) expect(lab(name)).toMatch(/wildcard|certificate/);
  });

  it('protects the lab zone’s apex for every record type, and leaves www and other names open (F2)', () => {
    for (const name of ['@', LAB_ZONE, `${LAB_ZONE}.`]) expect(lab(name), name).toMatch(/receive mail for the domain/);
    for (const name of ['www', 'note', 'labs', 'mylab', 'lab-two', `x.www.${LAB_ZONE}`, 'a_b']) expect(lab(name), name).toBeNull();
    // A part starting with _ anywhere in the name is refused, not only the first (#1911).
    for (const name of ['www._x', 's1._domainkey', 'a._dmarc.www']) expect(lab(name), name).toMatch(/_/);
  });

  it('leaves the site zone’s _ names as they were: only _acme-challenge is refused there (R1)', () => {
    expect(dnsNameProtection('_dmarc')).toBeNull();
    expect(dnsNameProtection('_atproto')).toBeNull();
    expect(dnsNameProtection('_acme-challenge.blog')).not.toBeNull();
  });

  it('keeps every site protection out of the lab zone, and the lab zone’s apex out of the site’s', () => {
    expect(dnsNameProtection('www', LAB_ZONE)).toBeNull();
    expect(dnsNameProtection(`www.${ZONE_APEX}`, ZONE_APEX)).not.toBeNull();
    expect(dnsNameProtection('@')).not.toBeNull();
  });

  it('refuses a wildcard over any protected name, not only over a protected base (F1)', () => {
    const zone = { name: 'example.test', dnsNames: [{ name: 'a.b.example.test', reason: 'R' }], dnsPrefixes: [], phases: [], wildcardReason: null };
    expect(protectionIn(zone, '*.b.example.test')).toBe('R');
    expect(protectionIn(zone, '*.c.b.example.test')).toBeNull();
    expect(protectionIn(zone, '*.other.example.test')).toBeNull();
    expect(protectionIn(zone, '*.example.test')).toBe(APEX_WILDCARD_REASON);
    const starred = { ...zone, dnsNames: [{ name: '*.a.b.example.test', reason: 'S' }] };
    expect(protectionIn(starred, '*.b.example.test')).toBe('S');
  });

  it('refuses a wildcard that would answer for a protected prefix below it (#1913 review)', () => {
    // *.foo answers _acme-challenge.foo when no exact record exists.
    const zone = { name: 'example.test', dnsNames: [], dnsPrefixes: [{ prefix: '_acme-challenge', reason: 'P' }], phases: [], wildcardReason: null };
    expect(protectionIn(zone, '*.foo.example.test')).toBe('P');
    expect(protectionIn(zone, '*.a.b.example.test')).toBe('P');
    expect(protectionIn(zone, 'foo.example.test')).toBeNull();
    // The real site zone: every wildcard there would answer a certificate-check name.
    for (const name of ['*.foo', '*.blog', '*.x.y']) expect(dnsNameProtection(name), name).toMatch(/_acme-challenge|certificate/i);
  });

  it('names the other managed zone a name belongs to (F6)', () => {
    expect(otherManagedZone(`x.${ZONE_APEX}`, LAB_ZONE)).toBe(ZONE_APEX);
    expect(otherManagedZone(ZONE_APEX, LAB_ZONE)).toBe(ZONE_APEX);
    expect(otherManagedZone(`X.${LAB_ZONE}.`, ZONE_APEX)).toBe(LAB_ZONE);
    for (const [name, zone] of [['blog', ZONE_APEX], [`x.${LAB_ZONE}`, LAB_ZONE], ['@', LAB_ZONE], [`x${ZONE_APEX}`, LAB_ZONE]]) {
      expect(otherManagedZone(name, zone), name).toBeNull();
    }
  });

  it('refuses everything in a zone that is not managed', () => {
    expect(dnsNameProtection('blog', 'example.com')).toBe(UNMANAGED_ZONE_REASON);
  });

  it('keeps the allow-list of phases the same in the lab zone, without the site’s Terraform reason', () => {
    expect(phaseProtection('http_request_late_transform', LAB_ZONE)).toBe(READ_ONLY_PHASE_REASON);
    expect(phaseProtection('http_request_late_transform', ZONE_APEX)).toMatch(/origin secret rule/);
    for (const entry of EDITABLE_PHASES) expect(phaseProtection(entry.phase, LAB_ZONE), entry.phase).toBeNull();
    expect(phaseProtection('http_request_origin', LAB_ZONE)).toBe(READ_ONLY_PHASE_REASON);
  });

  it('holds no Terraform record in the lab zone: infra-lab writes only into the site’s zone', () => {
    const zoneIds = [...terraformSource(join(ROOT, 'infra-lab')).matchAll(/^\s*zone_id\s*=\s*(\S+)/gm)].map((match) => match[1]);
    expect(zoneIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(zoneIds)).toEqual(new Set(['var.cloudflare_zone_id']));
  });
});

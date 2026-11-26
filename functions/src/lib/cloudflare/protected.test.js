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
  EDITABLE_PHASES,
  OWNER_ONLY_SETTINGS,
  PROTECTED_DNS_NAMES,
  PROTECTED_PHASES,
  READ_ONLY_PHASE_REASON,
  ZONE_APEX,
  checkDnsName,
  dnsNameProtection,
  isEditablePhase,
  normalizeDnsName,
  ownerOnlySettingReason,
  phaseProtection,
} from './protected.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const infra = terraformSource(join(ROOT, 'infra'));
const frontend = readFileSync(join(ROOT, 'infra/frontend.tf'), 'utf8');
const labDns = readFileSync(join(ROOT, 'infra-lab/dns.tf'), 'utf8');
const labVariables = readFileSync(join(ROOT, 'infra-lab/variables.tf'), 'utf8');

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
  // Every phase infra/ writes rules into, as Terraform names them.
  const terraformPhases = [...new Set([...infra.matchAll(/^\s*phase\s*=\s*"([a-z_]+)"/gm)].map((match) => match[1]))].sort();

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
  it('lists the five settings an agent key may not change, each with a reason telling the owner what to do', () => {
    expect(OWNER_ONLY_SETTINGS.map((entry) => entry.setting)).toEqual(['ssl', 'min_tls_version', 'always_use_https', 'security_header', 'tls_client_auth']);
    for (const entry of OWNER_ONLY_SETTINGS) {
      expect(ownerOnlySettingReason(entry.setting)).toMatch(/Change it on the Cloudflare page yourself/);
    }
    expect(ownerOnlySettingReason('SSL')).not.toBeNull();
    expect(ownerOnlySettingReason('brotli')).toBeNull();
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
    for (const name of ['*.blog', '*.shop.blog', `*.api-azure2.${ZONE_APEX}`]) {
      expect(dnsNameProtection(name), name).toBeNull();
    }
  });
});

describe('the module itself', () => {
  it('imports nothing, so the browser can mirror it', () => {
    const source = readFileSync(join(ROOT, 'functions/src/lib/cloudflare/protected.js'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

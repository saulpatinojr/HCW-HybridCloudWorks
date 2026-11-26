/**
 * The protected list (#1905) held to the Terraform that manages the zone:
 * every DNS record in infra/frontend.tf and infra-lab/dns.tf, and every rule
 * phase in infra/, must be on it, or the Cloudflare page could change what
 * the next Terraform run would undo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terraformSource } from '../../../test/terraform-source.js';
import {
  PROTECTED_DNS_NAMES,
  PROTECTED_PHASES,
  ZONE_APEX,
  dnsNameProtection,
  normalizeDnsName,
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
  it('holds every phase Terraform writes rules into', () => {
    const phases = [...infra.matchAll(/^\s*phase\s*=\s*"([a-z_]+)"/gm)].map((match) => match[1]);
    expect(phases).toContain('http_request_late_transform');
    for (const phase of phases) expect(phaseProtection(phase), phase).not.toBeNull();
  });

  it('holds the rate limit phase too, before its Terraform reaches main', () => {
    expect(PROTECTED_PHASES.map((entry) => entry.phase)).toEqual(['http_request_late_transform', 'http_ratelimit']);
    expect(phaseProtection('HTTP_RATELIMIT')).not.toBeNull();
    expect(phaseProtection('http_request_dynamic_redirect')).toBeNull();
  });
});

describe('the module itself', () => {
  it('imports nothing, so the browser can mirror it', () => {
    const source = readFileSync(join(ROOT, 'functions/src/lib/cloudflare/protected.js'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

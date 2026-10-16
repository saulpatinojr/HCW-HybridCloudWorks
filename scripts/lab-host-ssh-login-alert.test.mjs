/**
 * alert-lab-ssh-login (#953, LAB-7) pages on any SSH login to the lab host
 * that is not the administrative user, by public key, with a pinned key. Two
 * of those three facts live in infra/ (the rule's variables) and in lab-host/
 * (the hardening role's user and its pinned keys), and nothing at run time
 * compares them: a key rotated in Ansible and not in Terraform would page on
 * every login, and one rotated in Terraform and not in Ansible would page on
 * none of the new key's. So they are held together here.
 *
 * The key is compared by fingerprint, computed from the public key exactly as
 * `ssh-keygen -lf` and sshd's log line compute it: SHA-256 over the decoded
 * key blob, base64 without padding, after `SHA256:`.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers infra/ and lab-host/.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(REPO, relative), 'utf8');

const variables = read('infra/variables.tf');
const labHybrid = read('infra/lab-hybrid.tf');
const groupVars = read('lab-host/ansible/group_vars/all.yml');

/** One `variable "<name>" { … }` block of infra/variables.tf. */
function variableBlock(name) {
  const start = variables.indexOf(`variable "${name}" {`);
  expect(start, `var.${name} is not in infra/variables.tf`).toBeGreaterThanOrEqual(0);
  return variables.slice(start, variables.indexOf('\n}\n', start) + 2);
}

/** A variable's `default = [ "…", … ]` as strings. */
function listDefault(name) {
  const match = /^\s*default\s*=\s*\[([^\]]*)\]/m.exec(variableBlock(name));
  expect(match, `var.${name} has no list default`).not.toBeNull();
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** One top-level resource block of lab-hybrid.tf, up to its closing brace. */
function resourceBlock(header) {
  const start = labHybrid.indexOf(header);
  expect(start, `${header} is not in infra/lab-hybrid.tf`).toBeGreaterThanOrEqual(0);
  return labHybrid.slice(start, labHybrid.indexOf('\n}\n', start) + 2);
}

/** A YAML scalar with its quotes taken off. */
function unquote(value) {
  const trimmed = value.trim();
  if (/^".*"$/.test(trimmed)) return JSON.parse(trimmed);
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

/** A top-level `key: value` from a YAML file, unquoted, without a trailing comment. */
export function yamlScalar(text, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*(?:#.*)?$`, 'm').exec(text);
  expect(match, `${key} is not set in group_vars/all.yml`).not.toBeNull();
  return unquote(match[1]);
}

/**
 * A top-level list from a YAML file, in either of the two forms a list of
 * keys is written in: flow (`key: []`, `key: ["…", "…"]`) or block (`key:`
 * then `  - …` lines). Anything else, a Jinja reference or a folded scalar,
 * is refused rather than read as empty, which would skip the comparison.
 */
export function yamlList(text, key) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  expect(index, `${key} is not set in group_vars/all.yml`).toBeGreaterThanOrEqual(0);
  const inline = lines[index].slice(key.length + 1).replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('[')) {
    let flow = inline;
    for (let next = index + 1; !flow.trimEnd().endsWith(']') && next < lines.length; next += 1) {
      flow += ` ${lines[next].trim()}`;
    }
    const body = flow.trim().slice(1, -1).trim();
    if (body === '') return [];
    return [...body.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,\s][^,]*/g)].map((m) => unquote(m[0]));
  }
  if (inline !== '') {
    throw new Error(`${key} is neither a flow list nor a block list in group_vars/all.yml: "${inline}"`);
  }
  const items = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*?)\s*$/.exec(line);
    if (!item || /^[>|]/.test(item[1])) {
      throw new Error(`${key}: write each key as one plain or quoted scalar on its own "- " line, not "${line.trim()}"`);
    }
    items.push(unquote(item[1]));
  }
  return items;
}

/**
 * The OpenSSH SHA256 fingerprint of an authorized_keys line: options and a
 * comment are allowed and ignored. The blob is checked first, so a truncated
 * or mis-pasted key fails here rather than producing a fingerprint nothing
 * matches: in the SSH wire format it is a run of length-prefixed fields that
 * ends exactly at the end of the blob, and the first is the key's own type.
 */
export function sshFingerprint(line) {
  const fields = line.trim().split(/\s+/);
  const at = fields.findIndex((field) => /^(ssh-|ecdsa-|sk-)/.test(field));
  if (at < 0 || at + 1 >= fields.length) throw new Error(`not a public key line: "${line}"`);
  const [type, encoded] = fields.slice(at, at + 2);
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length < 4 || blob.toString('base64') !== encoded) throw new Error(`the ${type} key's blob is not base64`);
  let offset = 0;
  while (offset < blob.length) {
    if (offset + 4 > blob.length) throw new Error(`the ${type} key's blob is truncated`);
    offset += 4 + blob.readUInt32BE(offset);
  }
  if (offset !== blob.length) throw new Error(`the ${type} key's blob is truncated`);
  if (blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1') !== type) {
    throw new Error(`the key's blob is not a ${type} key: the type and the blob are from two keys`);
  }
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

const pinnedKeys = yamlList(groupVars, 'hardening_admin_authorized_keys');
const fingerprints = listDefault('lab_ssh_admin_key_fingerprints');
const adminUsers = listDefault('lab_ssh_admin_users');

describe('the fingerprint helper', () => {
  // A throwaway key made for this test, its private half deleted at once;
  // the expected value is what `ssh-keygen -lf` printed for it.
  const throwaway = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFTfYlbe2zbYyL9Nk/sJBAUA0FEns2q5nmkkdayY/clc';

  it('computes what ssh-keygen -lf prints, with or without options and a comment', () => {
    const expected = 'SHA256:MpPPsaMPP9K/xw1ypUbS4cQ+DsNdiKXl7T553MZBkuA';
    expect(sshFingerprint(throwaway)).toBe(expected);
    expect(sshFingerprint(`${throwaway} someone@somewhere`)).toBe(expected);
    expect(sshFingerprint(`no-agent-forwarding,from="192.0.2.0/24" ${throwaway}`)).toBe(expected);
  });

  it('refuses a key whose blob does not carry its type, and a line that is not a key', () => {
    expect(() => sshFingerprint(throwaway.replace('ssh-ed25519', 'ssh-rsa'))).toThrow(/not a ssh-rsa key/);
    expect(() => sshFingerprint(throwaway.slice(0, -8))).toThrow(/truncated/);
    expect(() => sshFingerprint('SHA256:MpPPsaMPP9K/xw1ypUbS4cQ+DsNdiKXl7T553MZBkuA')).toThrow(/not a public key line/);
  });

  it('reads both YAML list forms, and refuses one it cannot read', () => {
    expect(yamlList('k: []\n', 'k')).toEqual([]);
    expect(yamlList('k: ["a b", \'c\']\n', 'k')).toEqual(['a b', 'c']);
    expect(yamlList('k:\n  # a comment\n  - "a b"\n  - c d\nnext: 1\n', 'k')).toEqual(['a b', 'c d']);
    expect(() => yamlList('k: "{{ other }}"\n', 'k')).toThrow(/neither a flow list nor a block list/);
    expect(() => yamlList('k:\n  - >-\n    a\n', 'k')).toThrow(/one plain or quoted scalar/);
  });
});

describe('alert-lab-ssh-login expects what the hardening role installs', () => {
  it('pins fingerprints in OpenSSH SHA256 form, at least one', () => {
    expect(fingerprints.length).toBeGreaterThan(0);
    for (const fingerprint of fingerprints) expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('expects the hardening role’s administrative user', () => {
    expect(adminUsers).toContain(yamlScalar(groupVars, 'hardening_admin_user'));
  });

  it.skipIf(pinnedKeys.length === 0)(
    'pins exactly the fingerprints of hardening_admin_authorized_keys (skipped only while that list is empty, as on main before #953’s key pin; then the role copies root’s keys and there is nothing to compare)',
    () => {
      const ansible = [...new Set(pinnedKeys.map(sshFingerprint))].sort();
      expect(
        [...new Set(fingerprints)].sort(),
        'infra/variables.tf lab_ssh_admin_key_fingerprints must be the fingerprints of lab-host/ansible/group_vars/all.yml hardening_admin_authorized_keys: run ssh-keygen -lf on each key'
      ).toEqual(ansible);
    }
  );
});

describe('the rule reads those variables, and is the event-shaped rule ADR 0022 decision 6 describes', () => {
  const rule = resourceBlock('resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_ssh_login_unexpected"');

  it('builds its lists from the three variables', () => {
    expect(rule).toContain('let AdminUsers = dynamic(${jsonencode(var.lab_ssh_admin_users)});');
    expect(rule).toContain('let PinnedKeys = dynamic(${jsonencode(var.lab_ssh_admin_key_fingerprints)});');
    expect(rule).toContain('let LoopbackOnly = ${var.lab_ssh_loopback_only};');
    expect(/variable "lab_ssh_loopback_only" \{[\s\S]*?type\s*=\s*bool[\s\S]*?default\s*=\s*false/.test(variables)).toBe(true);
  });

  it('pages at severity 1, stateless and unmuted, every 15 minutes over rows ingested in the last 20', () => {
    expect(rule).toMatch(/^\s*severity\s*=\s*1$/m);
    expect(rule).not.toMatch(/auto_mitigation_enabled\s*=\s*true/);
    expect(rule).not.toContain('mute_actions_after_alert_duration');
    expect(rule).toMatch(/evaluation_frequency\s*=\s*"PT15M"/);
    expect(rule).toMatch(/window_duration\s*=\s*"PT1H"/);
    expect(rule).toContain('| where ingestion_time() > ago(20m)');
  });

  it('drops the VERBOSE "Accepted key" and "Accepted certificate" lines, which are not logins, before the parse', () => {
    const drop = rule.indexOf('Accepted key ');
    expect(drop).toBeGreaterThan(0);
    expect(rule.indexOf('Accepted certificate ')).toBeGreaterThan(0);
    expect(drop).toBeLessThan(rule.indexOf('| parse SyslogMessage'));
  });
});

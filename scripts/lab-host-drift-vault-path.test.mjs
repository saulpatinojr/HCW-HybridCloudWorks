/**
 * The nightly drift check reads the same vault bootstrap.sh does (#1631).
 *
 * hcw-playbook-drift (the hardening role) runs the playbook in check mode
 * every night. It passes the vault only when both files it is configured
 * with exist. Until 2026-11-10 its defaults named /etc/hcw/vault.yml and
 * /etc/hcw/vault.pass, while bootstrap.sh keeps the vault in
 * /etc/hcw/ansible/vault.yml and /etc/hcw/ansible/vault-password. So every
 * nightly run went without the vault and stopped at the Coder role's
 * secrets assertion, and the drift alert fired every night for a failure
 * that was the check's own. This test holds the two paths together.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(REPO, path), 'utf8');

/** The value of `NAME=...` in bootstrap.sh, with `${OTHER}` expanded. */
function bootstrapVar(text, name, seen = {}) {
  const line = text.match(new RegExp(`^${name}=("?)([^"\\n]*)\\1$`, 'm'));
  if (!line) throw new Error(`bootstrap.sh does not set ${name}`);
  return line[2].replace(/\$\{([A-Z_]+)\}/g, (_, inner) => seen[inner] ?? bootstrapVar(text, inner, seen));
}

describe('the drift check uses the vault bootstrap.sh uses (#1631)', () => {
  const bootstrap = read('lab-host/bootstrap.sh');
  const defaults = parse(read('lab-host/ansible/roles/hardening/defaults/main.yml'));
  const specs = parse(read('lab-host/ansible/roles/hardening/meta/argument_specs.yml'));
  const options = specs.argument_specs.main.options;

  it.each([
    ['hardening_drift_vault_file', 'HCW_VAULT_FILE'],
    ['hardening_drift_vault_password_file', 'HCW_VAULT_PASSWORD_FILE'],
  ])('%s is bootstrap.sh\'s %s, in the defaults and the argument spec', (variable, shellName) => {
    const path = bootstrapVar(bootstrap, shellName);
    expect(path).toMatch(/^\/etc\/hcw\/ansible\//);
    expect(defaults[variable]).toBe(path);
    expect(options[variable].default).toBe(path);
  });
});

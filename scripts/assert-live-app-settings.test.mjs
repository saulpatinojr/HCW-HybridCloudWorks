/**
 * The post-deploy check that a clobbered app-settings map fails the deploy.
 *
 * Two assertions carry this file. That the parse reads the REAL infra/ rather
 * than a fixture — a check calibrated only against invented Terraform would
 * pass while matching nothing the repository actually writes. And that an
 * empty declared set is a hard failure rather than a vacuous pass, because
 * that is this file's own version of the bug it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { INFRA, terraformSource } from './terraform-source.mjs';
import {
  MIN_DECLARED,
  declaredKeyVaultSettings,
  missingSettings,
  parseLiveNames,
} from './assert-live-app-settings.mjs';

describe('declaredKeyVaultSettings, against the real infra/', () => {
  const declared = declaredKeyVaultSettings(terraformSource(INFRA));

  it('parses a plausible number of references — a silent parse failure would pass everything', () => {
    expect(declared.length).toBeGreaterThanOrEqual(MIN_DECLARED);
  });

  it('includes the credentials the 2026-09-09 race lost', () => {
    // Five of the six. PUBLIC_API_ORIGIN is a plain setting and deliberately
    // out of scope — see the module header. Two of the five were the podcast
    // host's pair, retired with that host on 2026-10-13 (ADR 0029 §1c); the
    // Podbean pair that replaced them is the same kind of setting and stands
    // in for them here.
    for (const name of [
      'ELEVENLABS_API_KEY',
      'PODBEAN_CLIENT_ID',
      'PODBEAN_CLIENT_SECRET',
      'PLAUD_EMBEDDED_CLIENT_ID',
      'PLAUD_EMBEDDED_API_KEY',
    ]) {
      expect(declared, name).toContain(name);
    }
  });

  it('returns setting names, not secret names', () => {
    // The two spellings differ by design: app settings are UPPER_SNAKE_CASE,
    // vault secrets UPPER-KEBAB-CASE. Capturing the wrong group would compare
    // vault names against live settings and report every one as missing.
    expect(declared.every((n) => !n.includes('-'))).toBe(true);
    expect(declared).toContain('ELEVENLABS_API_KEY');
    expect(declared).not.toContain('ELEVENLABS-API-KEY');
  });
});

describe('declaredKeyVaultSettings, on controlled input', () => {
  const reference = (setting, secret) =>
    `"${setting}" = "@Microsoft.KeyVault(SecretUri=\${azurerm_key_vault.hcw.vault_uri}secrets/${secret})"`;

  it('reads one reference', () => {
    expect(declaredKeyVaultSettings(reference('A_KEY', 'A-KEY'))).toEqual(['A_KEY']);
  });

  it('ignores a plain setting, which is the documented gap', () => {
    expect(declaredKeyVaultSettings('"PUBLIC_API_ORIGIN" = "https://example.com"')).toEqual([]);
  });

  it('ignores a reference to a different vault', () => {
    // Only this repository's vault is the app's; a reference to another one is
    // not a setting this deploy can assert anything about.
    const other =
      '"X" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.other.vault_uri}secrets/X)"';
    expect(declaredKeyVaultSettings(other)).toEqual([]);
  });
});

describe('missingSettings', () => {
  it('names what the live map lost', () => {
    expect(missingSettings(['A', 'B', 'C'], ['A', 'C'])).toEqual(['B']);
  });

  it('is quiet when the live map is a superset', () => {
    // The live app carries platform settings Terraform never declares. Extra
    // names are normal and must not fail a deploy.
    expect(missingSettings(['A'], ['A', 'WEBSITE_RUN_FROM_PACKAGE'])).toEqual([]);
  });

  it('reports everything when the live map is empty', () => {
    expect(missingSettings(['A', 'B'], [])).toEqual(['A', 'B']);
  });

  it('is case-sensitive, because a mismatched spelling resolves to nothing', () => {
    expect(missingSettings(['A_KEY'], ['a_key'])).toEqual(['A_KEY']);
  });
});

describe('parseLiveNames', () => {
  it('reads the shape `az --query "[].name" -o tsv` produces', () => {
    expect(parseLiveNames('A\nB\nC\n')).toEqual(['A', 'B', 'C']);
  });

  it('survives CRLF and blank lines rather than inventing empty names', () => {
    // An empty string in the live set would make a declared "" look present.
    expect(parseLiveNames('A\r\n\r\nB\r\n')).toEqual(['A', 'B']);
  });

  it('yields nothing for empty input, so the CLI can refuse rather than pass', () => {
    expect(parseLiveNames('')).toEqual([]);
    expect(parseLiveNames(undefined)).toEqual([]);
  });
});

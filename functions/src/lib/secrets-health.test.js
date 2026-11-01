/**
 * Unresolved Key Vault references must be countable (T-720).
 *
 * The property that matters most here is not the counting — it is that this
 * module's idea of "unresolved" is EXACTLY `readKey`'s. If the two ever
 * disagree, health reports a fine estate while the application behaves as
 * though the key is absent, which is the precise blindness this exists to
 * remove. That agreement is asserted directly, against the real `readKey`,
 * rather than restated.
 */

import { describe, it, expect } from 'vitest';
import {
  isUnresolvedReference,
  unresolvedSecretNames,
  unresolvedSecretCount,
  KEY_VAULT_REFERENCE_PREFIX,
} from './secrets-health.js';
import { readKey } from './ai/router.js';

const REFERENCE = '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/PUBLER-API-KEY)';

describe('isUnresolvedReference', () => {
  it('recognises the literal a failed reference arrives as', () => {
    expect(isUnresolvedReference(REFERENCE)).toBe(true);
    expect(isUnresolvedReference(KEY_VAULT_REFERENCE_PREFIX)).toBe(true);
  });

  it('tolerates the whitespace and BOM readKey tolerates', () => {
    // An app setting edited through the portal can pick up either. If this
    // missed them, a genuinely broken reference would report healthy.
    expect(isUnresolvedReference(`  ${REFERENCE}  `)).toBe(true);
    expect(isUnresolvedReference(`﻿${REFERENCE}`)).toBe(true);
  });

  it('is false for a real value, and for anything that is not a string', () => {
    expect(isUnresolvedReference('sk-live-abc123')).toBe(false);
    expect(isUnresolvedReference('')).toBe(false);
    expect(isUnresolvedReference('   ')).toBe(false);
    for (const value of [undefined, null, 0, 1, true, {}, [], () => {}]) {
      expect(isUnresolvedReference(value)).toBe(false);
    }
  });

  it('does not fire on a value that merely mentions Key Vault', () => {
    // A URI is not a reference; a sentence mentioning the prefix is not one either.
    expect(isUnresolvedReference('https://kv-site-prod-cus-01.vault.azure.net/')).toBe(false);
    expect(isUnresolvedReference('see @Microsoft.KeyVault( in the docs')).toBe(false);
  });
});

describe('unresolvedSecretNames', () => {
  it('counts a setting once although App Service exposes it twice', () => {
    // On App Service every app setting is in the process as NAME and as
    // APPSETTING_NAME, same value. The Health page read 6 for 3 on 2026-11-01.
    const env = {
      AZURE_SPEECH_KEY: REFERENCE,
      APPSETTING_AZURE_SPEECH_KEY: REFERENCE,
      CODER_BROKER_TOKEN: REFERENCE,
      APPSETTING_CODER_BROKER_TOKEN: REFERENCE,
      PUBLER_API_KEY: 'resolved-value',
      APPSETTING_PUBLER_API_KEY: 'resolved-value',
      WEBSITE_SITE_NAME: 'func-site-prod-cus-01',
    };
    expect(unresolvedSecretNames(env)).toEqual(['AZURE_SPEECH_KEY', 'CODER_BROKER_TOKEN']);
    expect(unresolvedSecretCount(env)).toBe(2);
  });

  it('keeps a prefixed name that has no plain twin, so nothing is hidden by the prefix alone', () => {
    const env = { APPSETTING_ONLY_HERE: REFERENCE };
    expect(unresolvedSecretNames(env)).toEqual(['APPSETTING_ONLY_HERE']);
  });

  it('sorts the names and tolerates an empty or missing environment', () => {
    expect(unresolvedSecretNames({ B_KEY: REFERENCE, A_KEY: REFERENCE })).toEqual(['A_KEY', 'B_KEY']);
    expect(unresolvedSecretNames({})).toEqual([]);
    expect(unresolvedSecretNames(undefined)).toEqual([]);
    expect(unresolvedSecretCount(undefined)).toBe(0);
  });
});

describe('agreement with readKey', () => {
  it('calls unresolved exactly what readKey calls absent', () => {
    // THE property. readKey decides whether a feature runs; this decides
    // whether an operator is told. They must not drift apart.
    const values = [
      REFERENCE,
      `  ${REFERENCE}  `,
      `﻿${REFERENCE}`,
      KEY_VAULT_REFERENCE_PREFIX,
      'sk-live-abc123',
      '  spaced-but-real  ',
      '',
      '   ',
      'https://kv.vault.azure.net/',
    ];

    for (const value of values) {
      const env = { CANDIDATE: value };
      const absentToReadKey = readKey(env, 'CANDIDATE') === '';
      const unresolvedHere = isUnresolvedReference(value);
      // readKey also calls an EMPTY value absent, and an empty value is not an
      // unresolved reference — so the implication runs one way only.
      if (unresolvedHere) {
        expect(absentToReadKey, `readKey accepted ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });
});

describe('unresolvedSecretNames', () => {
  it('names every unresolved setting, sorted, and nothing else', () => {
    const env = {
      PUBLER_API_KEY: REFERENCE,
      ANTHROPIC_API_KEY: 'sk-ant-real',
      CF_ORIGIN_SECRET: REFERENCE,
      STORAGE_BLOB_ENDPOINT: 'https://st.blob.core.windows.net/',
      NODE_ENV: 'production',
    };
    expect(unresolvedSecretNames(env)).toEqual(['CF_ORIGIN_SECRET', 'PUBLER_API_KEY']);
  });

  it('is empty for a healthy estate', () => {
    expect(unresolvedSecretNames({ A: 'x', B: 'y' })).toEqual([]);
  });

  it('does not throw on absent or odd input', () => {
    for (const env of [undefined, null, {}]) {
      expect(unresolvedSecretNames(env)).toEqual([]);
      expect(unresolvedSecretCount(env)).toBe(0);
    }
  });
});

describe('unresolvedSecretCount', () => {
  it('is the length of the name list', () => {
    const env = { A: REFERENCE, B: REFERENCE, C: 'fine' };
    expect(unresolvedSecretCount(env)).toBe(unresolvedSecretNames(env).length);
    expect(unresolvedSecretCount(env)).toBe(2);
  });

  it('is 0 in a healthy estate — so any other value is actionable', () => {
    // What makes a bare count sufficient for an alert without disclosing which
    // integrations exist.
    expect(unresolvedSecretCount({ ANTHROPIC_API_KEY: 'sk-ant-real' })).toBe(0);
  });
});

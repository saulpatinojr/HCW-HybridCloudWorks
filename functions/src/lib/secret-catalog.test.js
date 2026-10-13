/**
 * The catalogue must match the `infra/` module exactly.
 *
 * The API-keys page writes to Key Vault under the name this catalogue gives.
 * If that name is not the one `infra/` references, the write succeeds, the
 * vault gains a secret, and the app setting still resolves to nothing — so the
 * page shows a value seeded and the feature stays dark. That is
 * Required-Inputs §4.5's failure exactly, and it is invisible until someone
 * uses the feature.
 *
 * Text-read like `app-settings-secrets.test.js` and `cors-platform-origins.test.js`,
 * so it fails in CI on a checkout with no Azure credentials and no Terraform
 * binary.
 */
import { describe, it, expect } from 'vitest';
import { terraformSource } from '../../test/terraform-source.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEYLESS_PROVIDERS, PROVIDERS } from './ai/router.js';

// The providers with a secret behind them: the only ones the API-keys page can
// show, and so the only ones whose verdicts the router reports (#849 added a
// keyless one, Foundry, reached with the app's identity).
const KEYED_PROVIDERS = PROVIDERS.filter((p) => !KEYLESS_PROVIDERS.includes(p));
import {
  GENERATABLE_SECRETS,
  SECRET_CATALOG,
  SECRET_SECTIONS,
  findBySecretName,
  isGeneratable,
  isSeedableSecret,
} from './secret-catalog.js';

const INFRA = join(fileURLToPath(new URL('../../..', import.meta.url)), 'infra');

/**
 * Every `"SETTING" = "@Microsoft.KeyVault(SecretUri=…secrets/SECRET)"` pair in
 * `infra/`, as Terraform pairs them. Reading the PAIR rather than two separate
 * lists is what makes a swapped or mistyped counterpart detectable.
 */
function terraformPairs() {
  const source = terraformSource(INFRA);
  const pattern =
    /"([A-Z0-9_]+)"\s*=\s*"@Microsoft\.KeyVault\(SecretUri=\$\{azurerm_key_vault\.hcw\.vault_uri\}secrets\/([A-Z0-9-]+)\)"/g;
  return [...source.matchAll(pattern)].map((m) => ({ setting: m[1], secret: m[2] }));
}

describe('secret catalogue ↔ Terraform', () => {
  const pairs = terraformPairs();

  it('parses a plausible number of references — a silent parse failure would pass everything', () => {
    // Guards the guard. If the regex stopped matching, every assertion below
    // would compare two empty sets and pass while checking nothing.
    expect(pairs.length).toBeGreaterThan(15);
  });

  it('covers exactly the secrets Terraform references — no more, no fewer', () => {
    const declared = pairs.map((p) => p.secret).sort();
    const catalogued = SECRET_CATALOG.map((e) => e.secret).sort();
    expect(catalogued).toEqual(declared);
  });

  it('pairs each secret with the app setting Terraform pairs it with', () => {
    // The UPPER_SNAKE ↔ UPPER-KEBAB translation is where a typo hides: the
    // reference resolves to nothing and the failure presents as missing data.
    const declared = new Map(pairs.map((p) => [p.secret, p.setting]));
    const mismatched = SECRET_CATALOG.filter((e) => declared.get(e.secret) !== e.setting).map(
      (e) => `${e.secret} → catalogue says ${e.setting}, infra/ says ${declared.get(e.secret)}`
    );
    expect(mismatched).toEqual([]);
  });

  it('names a real section for every entry', () => {
    const sections = new Set(SECRET_SECTIONS.map((s) => s.id));
    const orphans = SECRET_CATALOG.filter((e) => !sections.has(e.section)).map((e) => e.secret);
    expect(orphans).toEqual([]);
  });

  it('puts at least one secret in every section it declares', () => {
    // An empty section renders as a heading with nothing under it, which reads
    // as "these are all missing" rather than "there are none".
    const used = new Set(SECRET_CATALOG.map((e) => e.section));
    expect(SECRET_SECTIONS.filter((s) => !used.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  it('gives every entry a label and help text', () => {
    const bare = SECRET_CATALOG.filter((e) => !e.label?.trim() || !e.help?.trim()).map(
      (e) => e.secret
    );
    expect(bare).toEqual([]);
  });

  it('claims a liveness check only where something actually reports one', () => {
    // `hasLivenessCheck: true` reaches the page and suppresses the "no liveness
    // check for this one" caveat beside a green light. If nothing records a
    // verdict for that secret, the light can never go red and the page has
    // quietly promised a check it does not run. Two things report, both
    // through lib/key-verdict.js: the AI router for its providers, and the
    // Publer client and proxy for PUBLER_API_KEY (#358), and the Telegram
    // connection probe for TELEGRAM_BOT_TOKEN (#483). Those are the only
    // legal probes; adding one here without a reporter is the lie this guards.
    //
    // `telegram` earned its place by being unambiguous: getMe takes the token
    // and nothing else, so a 401 has exactly one thing to blame. Podbean and
    // YouTube have the same beaker and deliberately NOT a probe — Podbean's
    // token exchange takes two settings, so a refusal could blame either, and
    // YouTube answers 403 for an exceeded quota as well as a bad key, and a
    // light that reddens on a quota day is #358 repeated.
    //
    // Compares the SET of reporter names, not the raw list: one reporter may
    // legitimately cover more than one secret, which `publer` now does across
    // PUBLER_API_KEY and PUBLER_WORKSPACE_ID. What must stay closed is the set
    // of names, since a name with no reporter behind it is the promise this
    // test exists to refuse.
    const probed = [...new Set(SECRET_CATALOG.filter((e) => e.probe).map((e) => e.probe))].sort();
    expect(probed).toEqual([...KEYED_PROVIDERS, 'publer', 'telegram'].sort());
  });

  it('carries the Publer probe on BOTH the key and the workspace id', () => {
    // This assertion used to say the opposite, and the comment under it gave
    // the reason: the id "is an identifier that travels with its key", so a
    // probe there "would promise a light that nothing switches". Measured
    // against the live API on 2026-09-09, that is wrong in the expensive
    // direction. Publer answers 401 when the WORKSPACE ID is wrong and 403
    // when the KEY is — the reverse of its documentation — so the workspace id
    // is a value an upstream service rejects on its own, and something does
    // switch that light. Reporting both against the key is what sent #358
    // into two days of reminting a key that was fine.
    const byProbe = Object.fromEntries(SECRET_CATALOG.map((e) => [e.setting, e.probe]));
    expect(byProbe.PUBLER_API_KEY).toBe('publer');
    expect(byProbe.PUBLER_WORKSPACE_ID).toBe('publer');
  });

  it('declares probe explicitly on every entry, so "no liveness check" is a decision', () => {
    // `undefined` would read as null at the call site but means nobody chose.
    const undeclared = SECRET_CATALOG.filter((e) => !('probe' in e)).map((e) => e.secret);
    expect(undeclared).toEqual([]);
  });
});

describe('AI provider help text (#815)', () => {
  // Until 2026-09-29 the page called Anthropic "second" and OpenAI "third"
  // while DEFAULT_PROVIDER_ORDER tried OpenAI first of the two, and told the
  // owner NVIDIA wrote "first" on the day it became the backup. The order is
  // the AI Engine page's to change, so no fixed position survives in text.
  const providerEntries = SECRET_CATALOG.filter((e) => PROVIDERS.includes(e.probe));

  it('covers every provider the router implements', () => {
    expect(providerEntries.map((e) => e.probe).sort()).toEqual([...KEYED_PROVIDERS].sort());
  });

  it('names no position in the order, which the AI Engine page can change', () => {
    const positional = providerEntries
      .filter((e) => /\b(first|second|third|fourth|fifth|last)\b/i.test(e.help))
      .map((e) => `${e.label}: ${e.help}`);
    expect(positional).toEqual([]);
  });

  it('sends the reader to the AI Engine page for the order instead', () => {
    const silent = providerEntries.filter((e) => !/AI Engine page/.test(e.help)).map((e) => e.label);
    expect(silent).toEqual([]);
  });
});

describe('generatable secrets', () => {
  it('are all in the catalogue', () => {
    expect(GENERATABLE_SECRETS.filter((name) => !isSeedableSecret(name))).toEqual([]);
  });

  it('are only values this estate invents, never ones an upstream service issues', () => {
    // A generated Gemini key is not "a weak key" — it is a WRONG key, and it
    // shows a green light while every call 401s. Absent is safer than wrong.
    expect([...GENERATABLE_SECRETS].sort()).toEqual(['CLIENT-IP-SALT', 'PREVIEW-SIGNING-SECRET']);
    expect(isGeneratable('GEMINI-API-KEY')).toBe(false);
    expect(isGeneratable('TELEGRAM-BOT-TOKEN')).toBe(false);
  });
});

describe('lookup helpers', () => {
  it('finds a known secret and refuses an unknown one', () => {
    expect(findBySecretName('GEMINI-API-KEY')?.setting).toBe('GEMINI_API_KEY');
    expect(findBySecretName('NOT-A-SECRET')).toBeUndefined();
    expect(isSeedableSecret('NOT-A-SECRET')).toBe(false);
  });

  it('refuses non-string and empty input rather than matching something', () => {
    for (const bad of [null, undefined, '', 0, {}, []]) {
      expect(isSeedableSecret(bad)).toBe(false);
      expect(isGeneratable(bad)).toBe(false);
    }
  });

  it('is case-sensitive — the app-setting spelling must not match a vault name', () => {
    expect(isSeedableSecret('gemini-api-key')).toBe(false);
    expect(isSeedableSecret('GEMINI_API_KEY')).toBe(false);
  });
});

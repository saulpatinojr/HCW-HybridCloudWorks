import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISALLOWED_STANDING_ROLES,
  parseInput,
  verifyKeyVaultPosture,
  verifyStoragePosture,
  verifyNoStandingGrants,
  runAllPostureChecks,
} from './check-storage-keyvault-deny.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'check-storage-keyvault-deny.mjs');

describe('DISALLOWED_STANDING_ROLES', () => {
  it('contains Owner and Contributor', () => {
    expect(DISALLOWED_STANDING_ROLES.has('Owner')).toBe(true);
    expect(DISALLOWED_STANDING_ROLES.has('Contributor')).toBe(true);
  });
});

describe('parseInput', () => {
  it('parses valid JSON string', () => {
    expect(parseInput('{"status": "ok"}')).toEqual({ status: 'ok' });
  });

  it('returns object directly when already an object', () => {
    const obj = { foo: 'bar' };
    expect(parseInput(obj)).toBe(obj);
  });

  it('throws on non-JSON string or non-object', () => {
    expect(() => parseInput('')).toThrow(/empty/);
    expect(() => parseInput(123)).toThrow(TypeError);
    expect(() => parseInput('{bad json}')).toThrow();
  });
});

describe('verifyKeyVaultPosture', () => {
  it('passes when defaultAction is Deny and ipRules is empty', () => {
    const kv = {
      properties: {
        networkAcls: {
          defaultAction: 'Deny',
          bypass: 'AzureServices',
          ipRules: [],
        },
      },
    };
    const result = verifyKeyVaultPosture(kv);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.details.defaultAction).toBe('Deny');
    expect(result.details.ipRulesCount).toBe(0);
  });

  it('fails when defaultAction is Allow or missing', () => {
    const kvAllow = {
      properties: {
        networkAcls: {
          defaultAction: 'Allow',
          ipRules: [],
        },
      },
    };
    const resAllow = verifyKeyVaultPosture(kvAllow);
    expect(resAllow.ok).toBe(false);
    expect(resAllow.errors[0]).toMatch(/defaultAction is "Allow", expected "Deny"/);

    const kvMissing = { properties: {} };
    const resMissing = verifyKeyVaultPosture(kvMissing);
    expect(resMissing.ok).toBe(false);
    expect(resMissing.errors[0]).toMatch(/expected "Deny"/);
  });

  it('fails when standing IP rules are left open', () => {
    const kvWithIp = {
      properties: {
        networkAcls: {
          defaultAction: 'Deny',
          ipRules: [{ value: '203.0.113.10/32' }],
        },
      },
    };
    const res = verifyKeyVaultPosture(kvWithIp);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/has 1 standing IP rule/);
    expect(res.details.ipRulesCount).toBe(1);
  });
});

describe('verifyStoragePosture', () => {
  it('passes when defaultAction is Deny', () => {
    const stor = {
      properties: {
        networkRuleSet: {
          defaultAction: 'Deny',
          bypass: 'AzureServices',
        },
      },
    };
    const result = verifyStoragePosture(stor);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.details.defaultAction).toBe('Deny');
  });

  it('fails when defaultAction is Allow', () => {
    const stor = {
      properties: {
        networkRuleSet: {
          defaultAction: 'Allow',
        },
      },
    };
    const result = verifyStoragePosture(stor);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/defaultAction is "Allow", expected "Deny"/);
  });
});

describe('verifyNoStandingGrants', () => {
  it('passes with least-privilege scoped roles', () => {
    const assignments = [
      {
        roleDefinitionName: 'HCW Alert Rule Reader',
        scope: '/subscriptions/sub-1/resourceGroups/rg-sec',
        principalId: 'p-1',
      },
      {
        roleDefinitionName: 'Key Vault Secrets User',
        scope: '/subscriptions/sub-1/resourceGroups/rg-sec/providers/Microsoft.KeyVault/vaults/kv-1',
        principalId: 'p-2',
      },
    ];
    const result = verifyNoStandingGrants(assignments);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.evaluatedCount).toBe(2);
  });

  it('fails when standing broad roles exist (Contributor, Owner)', () => {
    const assignments = [
      {
        roleDefinitionName: 'Contributor',
        scope: '/subscriptions/sub-1',
        principalId: 'ci-runner',
      },
      {
        roleDefinitionName: 'Owner',
        scope: '/subscriptions/sub-1',
        principalId: 'standing-admin',
      },
    ];
    const result = verifyNoStandingGrants(assignments);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/Disallowed standing grant found: role "Contributor"/);
    expect(result.errors[1]).toMatch(/Disallowed standing grant found: role "Owner"/);
  });

  it('fails on subscription-wide Reader when forbidSubscriptionReader is set', () => {
    const assignments = [
      {
        roleDefinitionName: 'Reader',
        scope: '/subscriptions/11111111-2222-3333-4444-555555555555',
        principalId: 'ci-reader',
      },
    ];
    const result = verifyNoStandingGrants(assignments, { forbidSubscriptionReader: true });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/Disallowed subscription-wide Reader role/);
  });
});

describe('runAllPostureChecks', () => {
  it('aggregates errors across Key Vault, Storage, and Role Assignments', () => {
    const keyVault = { properties: { networkAcls: { defaultAction: 'Deny' } } };
    const storage = { properties: { networkRuleSet: { defaultAction: 'Deny' } } };
    const roleAssignments = [{ roleDefinitionName: 'Reader', scope: '/subscriptions/sub-1/resourceGroups/rg-1' }];

    const goodResult = runAllPostureChecks({ keyVault, storage, roleAssignments });
    expect(goodResult.ok).toBe(true);
    expect(goodResult.errors).toEqual([]);

    const badResult = runAllPostureChecks({
      keyVault: { properties: { networkAcls: { defaultAction: 'Allow' } } },
      storage: { properties: { networkRuleSet: { defaultAction: 'Allow' } } },
      roleAssignments: [{ roleDefinitionName: 'Owner', scope: '/subscriptions/sub-1' }],
    });
    expect(badResult.ok).toBe(false);
    expect(badResult.errors).toHaveLength(3);
  });
});

describe('CLI execution', () => {
  it('prints help with --help and exits 0', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage: node check-storage-keyvault-deny.mjs/);
  });

  it('fails with exit 2 when no flags provided', () => {
    const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Provide at least one of/);
  });

  it('passes with exit 0 on clean JSON files', () => {
    const kvFile = join(tmpdir(), `kv-${Date.now()}.json`);
    const storFile = join(tmpdir(), `stor-${Date.now()}.json`);
    writeFileSync(kvFile, JSON.stringify({ properties: { networkAcls: { defaultAction: 'Deny' } } }));
    writeFileSync(storFile, JSON.stringify({ properties: { networkRuleSet: { defaultAction: 'Deny' } } }));

    try {
      const res = spawnSync(process.execPath, [scriptPath, '--keyvault', kvFile, '--storage', storFile], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/All posture checks passed/);
    } finally {
      try { unlinkSync(kvFile); } catch {}
      try { unlinkSync(storFile); } catch {}
    }
  });

  it('fails with exit 1 on failing JSON configuration', () => {
    const kvFile = join(tmpdir(), `kv-bad-${Date.now()}.json`);
    writeFileSync(kvFile, JSON.stringify({ properties: { networkAcls: { defaultAction: 'Allow' } } }));

    try {
      const res = spawnSync(process.execPath, [scriptPath, '--keyvault', kvFile], {
        encoding: 'utf8',
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Posture checks failed/);
    } finally {
      try { unlinkSync(kvFile); } catch {}
    }
  });
});

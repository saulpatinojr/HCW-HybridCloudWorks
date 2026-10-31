/**
 * The export classification and the provisioned container spec must agree
 * (ADR 0028 §2). Read as text from `infra/cosmos-containers.json` so it fails
 * on a checkout with no Azure credentials, exactly like
 * `cosmos-client.test.js` does for partition keys.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPORT_CLASSES,
  AUTHORED,
  CONFIGURATION,
  OPERATIONAL,
  classify,
  classifiedContainers,
  exportPlanFor,
  SEPARATE_DATABASE_CONTAINERS,
  separateDatabaseFor,
} from './export-classification.js';

const SPEC = join(
  fileURLToPath(new URL('../../../..', import.meta.url)),
  'infra',
  'cosmos-containers.json'
);

const CODE_BRAIN_SPEC = join(
  fileURLToPath(new URL('../../../..', import.meta.url)),
  'infra',
  'cosmos-code-brain-containers.json'
);

/** The Code Conductor brain's own database (#1457, ADR 0036). */
function codeBrainSpec() {
  return JSON.parse(readFileSync(CODE_BRAIN_SPEC, 'utf8'));
}

/** Every container Terraform provisions, in either database. */
function provisioned() {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
  return [...spec.containers, ...codeBrainSpec().containers].map((c) => c.name).sort();
}

/** The app settings Terraform sets once the Code Conductor database exists. */
const WITH_CODE_BRAIN = { CODE_BRAIN_COSMOS_DATABASE: 'hcw_code_brain' };

describe('export classification against infra/cosmos-containers.json', () => {
  it('the specs provision 79 classified containers including both brains and Doc Vault', () => {
    // 72 at the ADR's writing; podcast_transcripts (#435) made it 73,
    // tool_price_history (#613 Phase 3) 74 and ambassador (ADR 0033 §4) 75.
    // Doc Vault adds one authored container. Second Brain adds authored
    // brain_records and regenerable brain_search. The Code Conductor brain
    // (#1457) adds authored code_brain_records, in its own database.
    expect(provisioned()).toHaveLength(79);
  });

  it('every provisioned container is classified exactly once', () => {
    const names = classifiedContainers();
    const seen = new Map();
    for (const name of names) seen.set(name, (seen.get(name) || 0) + 1);
    const duplicates = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
    expect(duplicates, 'named in more than one class').toEqual([]);

    const unclassified = provisioned().filter((name) => classify(name) === null);
    expect(
      unclassified,
      'provisioned in infra/cosmos-containers.json but classified nowhere — decide its class in export-classification.js'
    ).toEqual([]);
  });

  it('nothing unprovisioned is listed', () => {
    const live = new Set(provisioned());
    const phantom = classifiedContainers().filter((name) => !live.has(name));
    expect(phantom, 'classified but not provisioned — remove it or provision it').toEqual([]);
  });

  it('classifies 48 authored, 10 configuration, 7 operational, 14 excluded', () => {
    // 44 at the ADR's writing; ambassador, Doc Vault, brain_records and
    // code_brain_records add four.
    expect(AUTHORED).toHaveLength(48);
    expect(CONFIGURATION).toHaveLength(10);
    expect(OPERATIONAL).toHaveLength(7);
    const excluded = ['regenerable', 'seed', 'transient'].flatMap(
      (k) => EXPORT_CLASSES[k].containers
    );
    expect(excluded).toHaveLength(14);
  });

  it('every class states both run modes, and no excluded class exports on either', () => {
    for (const [name, spec] of Object.entries(EXPORT_CLASSES)) {
      expect(typeof spec.full, `${name}.full`).toBe('boolean');
      expect(typeof spec.delta, `${name}.delta`).toBe('boolean');
      // A delta without a full would restore nothing to apply the delta to.
      if (spec.delta) expect(spec.full, `${name} has deltas but no full`).toBe(true);
    }
    for (const name of ['regenerable', 'seed', 'transient']) {
      expect(EXPORT_CLASSES[name].full).toBe(false);
      expect(EXPORT_CLASSES[name].delta).toBe(false);
    }
  });
});

describe('exportPlanFor', () => {
  it('full is A + B + C (65), delta is A + B (58), both sorted and duplicate-free', () => {
    const full = exportPlanFor('full', WITH_CODE_BRAIN);
    const delta = exportPlanFor('delta', WITH_CODE_BRAIN);
    expect(full).toHaveLength(65);
    expect(delta).toHaveLength(58);
    expect(full).toEqual([...full].sort());
    expect(delta).toEqual([...delta].sort());
    expect(new Set(full).size).toBe(65);
    // Class C is exported on full runs only (owner decision, #231).
    for (const name of OPERATIONAL) {
      expect(full).toContain(name);
      expect(delta).not.toContain(name);
    }
    // The delta set is a subset of the full set.
    for (const name of delta) expect(full).toContain(name);
  });

  it('never plans an excluded container', () => {
    const excluded = ['regenerable', 'seed', 'transient'].flatMap(
      (k) => EXPORT_CLASSES[k].containers
    );
    for (const name of excluded) {
      expect(exportPlanFor('full')).not.toContain(name);
      expect(exportPlanFor('delta')).not.toContain(name);
    }
  });

  it('plans the Code Conductor brain on every run once its database setting exists, and not before', () => {
    // Terraform creates the database and sets CODE_BRAIN_COSMOS_DATABASE in
    // one apply, so the authored records are backed up before the workspace
    // is switched on, and a deploy that lands first plans nothing it cannot read.
    for (const mode of ['full', 'delta']) {
      expect(exportPlanFor(mode, WITH_CODE_BRAIN)).toContain('code_brain_records');
      expect(exportPlanFor(mode, {})).not.toContain('code_brain_records');
      expect(exportPlanFor(mode, { CODE_BRAIN_COSMOS_DATABASE: '  ' })).not.toContain('code_brain_records');
      // Nothing else changes with the setting.
      expect(exportPlanFor(mode, WITH_CODE_BRAIN).filter((c) => c !== 'code_brain_records')).toEqual(
        exportPlanFor(mode, {})
      );
    }
  });

  it('knows which containers live in a separate database, and each is in the Code Conductor spec', () => {
    const codeContainers = codeBrainSpec().containers.map((c) => c.name).sort();
    expect(Object.keys(SEPARATE_DATABASE_CONTAINERS).sort()).toEqual(codeContainers);
    for (const name of codeContainers) {
      expect(classify(name)).toBe('authored');
      expect(separateDatabaseFor(name, WITH_CODE_BRAIN)).toBe(codeBrainSpec().database);
    }
    expect(separateDatabaseFor('brain_records', WITH_CODE_BRAIN)).toBeNull();
    expect(separateDatabaseFor('code_brain_records', {})).toBeUndefined();
  });

  it('refuses an unknown mode rather than planning nothing', () => {
    expect(() => exportPlanFor('weekly')).toThrow(/mode must be one of full, delta/);
    expect(() => exportPlanFor(undefined)).toThrow(/mode must be one of/);
  });
});

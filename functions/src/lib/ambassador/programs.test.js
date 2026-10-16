import { describe, it, expect } from 'vitest';
import { DEFAULT_PROGRAMS, SUPERSEDED_SEED_VALUES } from './programs.js';

describe('ambassador seed programs (ADR 0033 §4)', () => {
  it('exports a frozen list of default programs', () => {
    expect(Array.isArray(DEFAULT_PROGRAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROGRAMS)).toBe(true);
    expect(DEFAULT_PROGRAMS.length).toBeGreaterThanOrEqual(5);
  });

  it('validates each seed program contract', () => {
    for (const program of DEFAULT_PROGRAMS) {
      expect(typeof program.id).toBe('string');
      expect(program.id).toMatch(/^program-[a-z0-9-]+$/);
      expect(typeof program.name).toBe('string');
      expect(program.name.length).toBeGreaterThan(0);
      expect(typeof program.provider).toBe('string');
      expect(typeof program.category).toBe('string');
      expect(typeof program.description).toBe('string');
      expect(program.description.length).toBeGreaterThan(10);
      if (program.applicationUrl !== null) {
        expect(typeof program.applicationUrl).toBe('string');
        expect(program.applicationUrl.startsWith('https://')).toBe(true);
      }
      expect(Array.isArray(program.eligibility)).toBe(true);
      expect(Array.isArray(program.criteria)).toBe(true);
      expect(Array.isArray(program.recommendedActivities)).toBe(true);
      expect(Array.isArray(program.requirements)).toBe(true);
      expect(program.requirements.length).toBeGreaterThan(0);

      for (const req of program.requirements) {
        expect(typeof req.id).toBe('string');
        expect(typeof req.label).toBe('string');
        expect(typeof req.description).toBe('string');
        expect(Array.isArray(req.evidenceTypes)).toBe(true);
        expect(typeof req.minCount).toBe('number');
        expect(req.minCount).toBeGreaterThan(0);
        expect(typeof req.weight).toBe('number');
        expect(req.weight).toBeGreaterThan(0);
      }

      if (program.applicationQuestions) {
        expect(Array.isArray(program.applicationQuestions)).toBe(true);
        for (const q of program.applicationQuestions) {
          expect(typeof q.id).toBe('string');
          expect(typeof q.section).toBe('string');
          expect(typeof q.prompt).toBe('string');
          expect(typeof q.kind).toBe('string');
        }
      }
    }
  });

  it('includes key community programs', () => {
    const ids = DEFAULT_PROGRAMS.map((p) => p.id);
    expect(ids).toContain('program-microsoft-mvp');
    expect(ids).toContain('program-aws-community-builders');
  });

  it('exports valid superseded seed values for migration versioning', () => {
    expect(typeof SUPERSEDED_SEED_VALUES).toBe('object');
    expect(Object.isFrozen(SUPERSEDED_SEED_VALUES)).toBe(true);

    const gk = SUPERSEDED_SEED_VALUES['program-gitkraken-ambassador'];
    expect(gk).toBeDefined();
    expect(gk.revision).toBe(2);
    expect(typeof gk.fields).toBe('object');
    expect(gk.fields.criteria).toContain('Content');
    expect(Array.isArray(gk.fields.requirements)).toBe(true);
    expect(gk.fields.requirements.length).toBeGreaterThan(0);
  });
});

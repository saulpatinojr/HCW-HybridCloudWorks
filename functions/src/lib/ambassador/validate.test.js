/**
 * The schema walker behind the three ambassador validators (ADR 0033 §4):
 * unknown keys refused first, a required field cleaned on a full write even
 * when absent, only present fields touched on a partial patch, and a
 * refusal naming the field it came from. The handler-level behaviour is
 * pinned in ../ambassador.test.js; this pins the walker's own rules.
 */
import { describe, it, expect } from 'vitest';
import { validateApplication, validateEvidence, validateProgram } from './validate.js';

describe('full writes', () => {
  it('a required field missing from a full write is refused by its own rule', () => {
    expect(validateProgram({})).toEqual({ error: 'name is required' });
    expect(validateApplication({})).toEqual({ error: 'programId is required' });
    expect(validateEvidence({ title: 'T' })).toEqual({ error: 'date is required (YYYY-MM-DD)' });
  });

  it('a required field present but empty is refused the same way', () => {
    expect(validateProgram({ name: '   ' }).error).toBe('name is required');
    expect(validateEvidence({ title: 'T', date: '' }).error).toBe('date is required (YYYY-MM-DD)');
  });

  it('defaults sourceModule to manual and refuses one off the list', () => {
    expect(validateEvidence({ title: 'T', date: '2026-01-02' }).value.sourceModule).toBe('manual');
    expect(validateEvidence({ title: 'T', date: '2026-01-02', sourceModule: 'x' }).error).toMatch(
      /sourceModule must be one of/
    );
  });

  it('unknown keys are refused before any field rule runs, and only own keys count as known', () => {
    expect(validateProgram({ toString: 1 }).error).toMatch(/Unknown program field\(s\): toString/);
    expect(validateApplication({ programId: '', nope: 1 }).error).toMatch(/Unknown application/);
  });
});

describe('partial patches', () => {
  it('touch only the fields present, required ones included', () => {
    expect(validateProgram({ provider: ' Microsoft ' }, { partial: true })).toEqual({
      value: { provider: 'Microsoft' },
    });
    expect(validateEvidence({ notes: 'n' }, { partial: true })).toEqual({ value: { notes: 'n' } });
  });

  it('let a patch clear the evidence date but not send a bad one', () => {
    expect(validateEvidence({ date: null }, { partial: true })).toEqual({ value: { date: null } });
    expect(validateEvidence({ date: 'soon' }, { partial: true }).error).toBe(
      'date must be a YYYY-MM-DD date'
    );
  });

  it('clear an application date with null or an empty string, and name a bad one', () => {
    expect(validateApplication({ decisionDate: '' }, { partial: true }).value).toEqual({
      decisionDate: null,
    });
    expect(validateApplication({ renewalDate: 'x' }, { partial: true }).error).toBe(
      'renewalDate must be a YYYY-MM-DD date'
    );
  });
});

describe('field rules', () => {
  it('program: URLs must be http(s), requirements are checked row by row, numbers are whole', () => {
    expect(validateProgram({ name: 'P', applicationUrl: 'ftp://x' }).error).toBe(
      'applicationUrl must be an http(s) URL'
    );
    expect(validateProgram({ name: 'P', requirements: 'no' }).error).toBe(
      'requirements must be an array'
    );
    expect(validateProgram({ name: 'P', requirements: [{}] }).error).toBe(
      'requirements[0].label is required'
    );
    expect(
      validateProgram({ name: 'P', order: '3.7', reminders: { daysBeforeDeadline: -2 } }).value
    ).toMatchObject({ order: 3, reminders: { daysBeforeDeadline: 0, daysBeforeRenewal: 0 } });
  });

  it('program: application questions need an id, a prompt and a known kind, once each, at most 200', () => {
    const q = (patch) => validateProgram({ name: 'P', applicationQuestions: [patch] });
    expect(q({}).error).toBe('applicationQuestions[0].id is required');
    expect(q({ id: 'a' }).error).toBe('applicationQuestions[0].prompt is required');
    expect(q({ id: 'a', prompt: 'Why?', kind: 'essay' }).error).toMatch(
      /applicationQuestions\[0\].kind must be one of profile, text/
    );
    expect(
      validateProgram({
        name: 'P',
        applicationQuestions: [
          { id: 'a', prompt: 'Why?', kind: 'text' },
          { id: 'a', prompt: 'Again?', kind: 'text' },
        ],
      }).error
    ).toBe('applicationQuestions[1].id "a" repeats an earlier one');
    expect(validateProgram({ name: 'P', applicationQuestions: 'no' }).error).toBe(
      'applicationQuestions must be an array'
    );
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `q${i}`,
      prompt: 'x',
      kind: 'text',
    }));
    expect(validateProgram({ name: 'P', applicationQuestions: many }).error).toMatch(/at most 200/);
    expect(
      q({
        id: ' grid ',
        section: 'Tools',
        prompt: 'How often?',
        kind: 'scale',
        rows: ['Teams', '', 7],
        options: ['Daily', 'Never'],
        maxChars: '0',
        maxItems: '24.9',
        required: 'yes',
      }).value.applicationQuestions[0]
    ).toEqual({
      id: 'grid',
      section: 'Tools',
      prompt: 'How often?',
      kind: 'scale',
      maxChars: null,
      options: ['Daily', 'Never'],
      allowOther: false,
      rows: ['Teams'],
      maxItems: 24,
      hint: '',
      required: false,
    });
    // A choice may take a typed value beside its options; only `true` turns it on.
    expect(
      q({ id: 'area', prompt: 'Area', kind: 'choice', options: ['A'], allowOther: true }).value
        .applicationQuestions[0].allowOther
    ).toBe(true);
    expect(
      q({ id: 'area', prompt: 'Area', kind: 'choice', options: ['A'], allowOther: 'yes' }).value
        .applicationQuestions[0].allowOther
    ).toBe(false);
  });

  it('application: responses hold up to 300 entries — 200 guided plus 100 free-list — and more is refused, not clipped', () => {
    const entries = (n) =>
      Array.from({ length: n }, (_, i) => ({ questionId: `q${i}`, text: `a${i}` }));
    expect(
      validateApplication({ programId: 'p', responses: entries(300) }).value.responses
    ).toHaveLength(300);
    expect(validateApplication({ programId: 'p', responses: entries(301) }).error).toBe(
      'responses must hold at most 300 entries (301 sent)'
    );
  });

  it('program: scoring is null or a credits unit with labelled tiers; evidence metrics carry credits', () => {
    expect(validateProgram({ name: 'P', scoring: null }).value.scoring).toBeNull();
    expect(validateProgram({ name: 'P', scoring: 'points' }).error).toBe(
      'scoring must be an object or null'
    );
    expect(validateProgram({ name: 'P', scoring: { unit: 'points' } }).error).toBe(
      'scoring.unit must be one of credits'
    );
    expect(
      validateProgram({
        name: 'P',
        scoring: {
          unit: 'credits',
          tiers: [{ label: 'Contributor', credits: '10' }, { credits: 5 }],
        },
      }).value.scoring
    ).toEqual({ unit: 'credits', tiers: [{ label: 'Contributor', credits: 10 }] });
    expect(
      validateEvidence({ title: 'T', date: '2026-01-02', metrics: { credits: '3' } }).value.metrics
    ).toEqual({ reach: null, attendees: null, views: null, credits: 3 });
  });

  it('application: a badge may be a site path, custom values are trimmed strings, flags default on', () => {
    const ok = validateApplication({
      programId: 'p',
      badgeImageUrl: '/api/public/media/badge.png',
      customValues: { ' a ': 1 },
      private: 'yes',
    });
    expect(ok.value).toMatchObject({
      badgeImageUrl: '/api/public/media/badge.png',
      customValues: { a: '' },
      private: true,
    });
    expect(validateApplication({ programId: 'p', badgeImageUrl: 'nope' }).error).toBe(
      'badgeImageUrl must be an http(s) URL or a site path'
    );
    expect(validateApplication({ programId: 'p', status: 'won' }).error).toMatch(
      /status must be one of/
    );
  });

  it('evidence: verification status is from the list and a snapshot keeps only an http(s) URL', () => {
    expect(
      validateEvidence({ title: 'T', date: '2026-01-02', verificationStatus: 'maybe' }).error
    ).toMatch(/verificationStatus must be one of/);
    expect(
      validateEvidence({
        title: 'T',
        date: '2026-01-02',
        snapshot: { title: 'S', date: '2026-01-02T10:00:00Z', url: 'javascript:x' },
      }).value.snapshot
    ).toEqual({ title: 'S', date: '2026-01-02', url: null, capturedAt: null });
  });

  // #1313: the requirement a row is filed under; null or blank means none.
  it('evidence: requirementId is trimmed text, blank is none, a patch may clear it, and it is capped', () => {
    const base = { title: 'T', date: '2026-01-02' };
    expect(validateEvidence({ ...base, requirementId: '  reach ' }).value.requirementId).toBe('reach');
    expect(validateEvidence({ ...base, requirementId: '' }).value.requirementId).toBeNull();
    expect(validateEvidence({ ...base, requirementId: null }).value.requirementId).toBeNull();
    expect(validateEvidence({ ...base }).value).not.toHaveProperty('requirementId');
    expect(validateEvidence({ requirementId: 'reach' }, { partial: true })).toEqual({
      value: { requirementId: 'reach' },
    });
    expect(validateEvidence({ requirementId: null }, { partial: true })).toEqual({
      value: { requirementId: null },
    });
    expect(validateEvidence({ ...base, requirementId: 'x'.repeat(300) }).value.requirementId).toHaveLength(100);
  });
});

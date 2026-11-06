/**
 * The interview's publish-time refusals (ADR 0040, D5 and D9), with the
 * jobs slice's schema stood in for: this slice imports `schema.js` and does
 * not write it, so the check is handed a stand-in through the loader.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthoredError } from '../http/error-response.js';
import { CONSENT_REQUIRED } from './consent.js';
import {
  INVALID_INTERVIEW,
  interviewBodyText,
  interviewPublishRefusal,
  isInterviewTarget,
} from './publish-gate.js';
import { stubSiblingModulesForTests } from './sibling-modules.js';

const clock = { now: () => new Date('2026-11-05T12:00:00.000Z') };
const consented = {
  consent: { confirmed: true, date: '2026-11-01', wording: 'v1', confirmedBy: { oid: 'oid-1' } },
};

afterEach(() => stubSiblingModulesForTests(null));

describe('isInterviewTarget', () => {
  it('matches the type however it is cased, and nothing else', () => {
    expect(isInterviewTarget('interview')).toBe(true);
    expect(isInterviewTarget('Interview')).toBe(true);
    expect(isInterviewTarget('blog')).toBe(false);
    expect(isInterviewTarget(undefined)).toBe(false);
  });
});

describe('interviewBodyText', () => {
  it('flattens the questions and answers into one text the rubric can count', () => {
    const text = interviewBodyText({
      qa: [
        { q: 'First?', a: 'First answer.' },
        { q: 'Second?', a: 'Second answer.' },
      ],
    });
    expect(text).toBe('First?\n\nFirst answer.\n\nSecond?\n\nSecond answer.');
  });

  it('is empty with no list, and skips an item with nothing in it', () => {
    expect(interviewBodyText({})).toBe('');
    expect(interviewBodyText({ qa: [{}, null, { q: '', a: '' }] })).toBe('');
  });
});

describe('interviewPublishRefusal', () => {
  it('refuses a missing consent before asking the schema anything', async () => {
    const validateQa = vi.fn();
    stubSiblingModulesForTests({ schema: { validateQa } });
    const refusal = await interviewPublishRefusal({ qa: [{ q: 'q', a: 'a' }] }, clock);
    expect(refusal).toMatchObject({ status: 422, code: CONSENT_REQUIRED });
    expect(validateQa).not.toHaveBeenCalled();
  });

  it('refuses a Q&A list the schema throws on, with the schema’s own sentence', async () => {
    stubSiblingModulesForTests({
      schema: {
        validateQa: () => {
          throw new AuthoredError('qa[1] a is 7000 characters; the most is 6000.');
        },
      },
    });
    const refusal = await interviewPublishRefusal({ ...consented, qa: [{ q: 'q', a: 'x' }] }, clock);
    expect(refusal).toMatchObject({ status: 422, code: INVALID_INTERVIEW });
    expect(refusal.error).toMatch(/cannot be published/);
    expect(refusal.error).toContain('qa[1] a is 7000 characters');
  });

  it('keeps a schema failure that is not an authored sentence out of the answer', async () => {
    stubSiblingModulesForTests({
      schema: {
        validateQa: () => {
          throw new Error('TypeError: cannot read secret internals at /srv/schema.js:12');
        },
      },
    });
    const refusal = await interviewPublishRefusal({ ...consented, qa: [{ q: 'q', a: 'a' }] }, clock);
    expect(refusal.code).toBe(INVALID_INTERVIEW);
    expect(refusal.error).not.toContain('secret internals');
  });

  it('carries a schema answer of { ok: false, error }, the shape schema.js uses, as the refusal', async () => {
    stubSiblingModulesForTests({
      schema: { validateQa: () => ({ ok: false, error: 'qa must have at least one item.' }) },
    });
    const refusal = await interviewPublishRefusal({ ...consented, qa: [] }, clock);
    expect(refusal).toMatchObject({ status: 422, code: INVALID_INTERVIEW });
    expect(refusal.error).toContain('qa must have at least one item.');
  });

  it('takes the value out of a schema answer of { ok: true, value }', async () => {
    const validateQa = vi.fn((qa) => ({ ok: true, value: qa }));
    stubSiblingModulesForTests({ schema: { validateQa } });
    expect(await interviewPublishRefusal({ ...consented, qa: [{ q: 'q', a: 'a' }] }, clock)).toBeNull();
  });

  it('is null when the consent is in order and the schema accepts the list', async () => {
    const validateQa = vi.fn((qa) => qa);
    stubSiblingModulesForTests({ schema: { validateQa } });
    const doc = { ...consented, qa: [{ q: 'q', a: 'a' }] };
    expect(await interviewPublishRefusal(doc, clock)).toBeNull();
    expect(validateQa).toHaveBeenCalledWith(doc.qa);
  });

  it('refuses rather than passes when the schema module has no validateQa', async () => {
    stubSiblingModulesForTests({ schema: {} });
    const refusal = await interviewPublishRefusal({ ...consented, qa: [{ q: 'q', a: 'a' }] }, clock);
    expect(refusal).toMatchObject({ status: 422, code: INVALID_INTERVIEW });
  });
});

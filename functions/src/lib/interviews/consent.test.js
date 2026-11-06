/**
 * The consent record (ADR 0040, D9): one fixed sentence under a version
 * name, a confirmed box with a real date that is not in the future, and the
 * administrator attributed from the token rather than the form.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSENT_REQUIRED,
  CONSENT_WORDING_V1,
  CONSENT_WORDING_VERSION,
  ConsentError,
  attributeConsent,
  consentRefusal,
  validateConsent,
} from './consent.js';

const clock = { now: () => new Date('2026-11-05T12:00:00.000Z') };

describe('validateConsent', () => {
  it('accepts a confirmed box with a real date on or before today', () => {
    expect(validateConsent({ confirmed: true, date: '2026-11-05' }, clock)).toEqual({
      confirmed: true,
      date: '2026-11-05',
      wording: CONSENT_WORDING_VERSION,
    });
    expect(validateConsent({ confirmed: true, date: '2026-10-01' }, clock).date).toBe('2026-10-01');
  });

  it.each([
    ['no block at all', undefined],
    ['a list', []],
    ['an unticked box', { confirmed: false, date: '2026-11-05' }],
    ['a string instead of true', { confirmed: 'yes', date: '2026-11-05' }],
    ['no date', { confirmed: true }],
    ['a date in another shape', { confirmed: true, date: '05/11/2026' }],
    ['a date that is not real', { confirmed: true, date: '2026-02-30' }],
    ['a date in the future', { confirmed: true, date: '2026-11-06' }],
  ])('refuses %s with CONSENT_REQUIRED and a sentence', (_name, input) => {
    let error;
    try {
      validateConsent(input, clock);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConsentError);
    expect(error.status).toBe(422);
    expect(error.code).toBe(CONSENT_REQUIRED);
    expect(error.message).toMatch(/consent|agree/i);
  });

  it('keeps the wording in code, under a version, so a later change is a new version', () => {
    expect(CONSENT_WORDING_VERSION).toBe('v1');
    expect(CONSENT_WORDING_V1).toMatch(/hybridcloudworks\.com/);
    expect(CONSENT_WORDING_V1).toMatch(/recording is kept privately/);
  });
});

describe('attributeConsent', () => {
  it('takes who confirmed it from the token, not the form', () => {
    const consent = validateConsent({ confirmed: true, date: '2026-11-05' }, clock);
    const stored = attributeConsent(consent, { oid: 'oid-1', email: 'editor@example.test' }, '2026-11-05T12:00:00.000Z');
    expect(stored).toEqual({
      confirmed: true,
      date: '2026-11-05',
      wording: 'v1',
      confirmedBy: { oid: 'oid-1', email: 'editor@example.test' },
      confirmedAt: '2026-11-05T12:00:00.000Z',
    });
  });

  it('falls back to sub and preferred_username, and to null when the token carries neither', () => {
    const consent = { confirmed: true, date: '2026-11-05', wording: 'v1' };
    expect(attributeConsent(consent, { sub: 's', preferred_username: 'p' }, 'x').confirmedBy).toEqual({
      oid: 's',
      email: 'p',
    });
    expect(attributeConsent(consent, {}, 'x').confirmedBy).toEqual({ oid: null, email: null });
  });
});

describe('consentRefusal, the publish-time check', () => {
  const good = {
    consent: { confirmed: true, date: '2026-11-01', wording: 'v1', confirmedBy: { oid: 'oid-1' } },
  };

  it('is null for a record in order', () => {
    expect(consentRefusal(good, clock)).toBeNull();
  });

  it.each([
    ['no record', {}],
    ['a record that is not an object', { consent: 'yes' }],
    ['an unconfirmed record', { consent: { confirmed: false, date: '2026-11-01' } }],
    ['no date', { consent: { confirmed: true } }],
    ['a future date', { consent: { confirmed: true, date: '2026-12-01', wording: 'v1', confirmedBy: { oid: 'o' } } }],
    // Not written by POST cms/interviews: no attribution, or another wording.
    ['no attribution', { consent: { confirmed: true, date: '2026-11-01', wording: 'v1' } }],
    ['an empty oid', { consent: { confirmed: true, date: '2026-11-01', wording: 'v1', confirmedBy: { oid: ' ' } } }],
    ['another wording version', { consent: { confirmed: true, date: '2026-11-01', wording: 'v0', confirmedBy: { oid: 'o' } } }],
  ])('names %s as CONSENT_REQUIRED', (_name, doc) => {
    const refusal = consentRefusal(doc, clock);
    expect(refusal.code).toBe(CONSENT_REQUIRED);
    expect(typeof refusal.error).toBe('string');
  });
});

/**
 * The one rate limit rule (#1909, #1918): what counts as a rule that is on,
 * and the sentences the Health card, the Overview and the daily check show.
 * Moved here from the browser's test when the browser stopped judging rules.
 */
import { describe, it, expect } from 'vitest';
import { NO_RULE_ON, READ_FAILED, failedVerdict, notCheckedVerdict, rateLimitVerdict } from './rate-limit.js';

const rule = (extra = {}) => ({ id: 'r1', expression: 'true', action: 'block', ...extra });
const of = (...rules) => rateLimitVerdict({ ruleset: { rules } });

describe('rateLimitVerdict', () => {
  it('is healthy when a rule is on, naming how many, and says when only some are', () => {
    expect(of(rule({ enabled: true }))).toEqual({ state: 'on', status: 'healthy', count: 1, sentence: '1 API rate limit rule is on.' });
    expect(of(rule(), rule({ enabled: false }), rule({ id: 'r3' }))).toMatchObject({
      status: 'healthy',
      count: 2,
      sentence: '2 of 3 API rate limit rules are on.',
    });
  });

  it('is amber when the phase has no rule set, an empty list, or every rule off', () => {
    expect(rateLimitVerdict({ ruleset: null })).toEqual({
      state: 'off',
      status: 'degraded',
      count: 0,
      sentence: `${NO_RULE_ON} The rate limiting phase (http_ratelimit) has no rules, so one address can send the API as many requests as it likes.`,
    });
    expect(of().sentence).toContain('has no rules');
    expect(of(rule({ enabled: false })).sentence).toContain('holds one rule, switched off or only logging');
    expect(of(rule({ enabled: false }), rule({ enabled: false })).sentence).toContain('holds 2 rules');
    for (const odd of [undefined, null, {}, { ruleset: {} }, { ruleset: { rules: 'x' } }]) {
      expect(rateLimitVerdict(odd).state).toBe('off');
    }
  });

  it('counts as on only a rule with no enabled flag or enabled true, as the agent guard does', () => {
    for (const enabled of [null, 0, 'false', 'true', 1, false]) {
      expect(of(rule({ enabled }))).toMatchObject({ state: 'off', status: 'degraded' });
    }
    expect(of(rule({ enabled: true })).state).toBe('on');
    expect(of(rule()).state).toBe('on');
    expect(of(null, 'x', 3, []).state).toBe('off');
  });

  it('does not count a rule that only logs, since it limits nothing', () => {
    expect(of(rule({ action: 'log' }))).toMatchObject({ state: 'off', status: 'degraded' });
    expect(of(rule({ action: 'LOG' })).state).toBe('off');
    expect(of(rule({ action: 'log' }), rule({ id: 'r2' }))).toMatchObject({ state: 'on', count: 1 });
  });
});

describe('the verdicts for a read that did not answer', () => {
  it('says "not checked" in grey and "could not be read" with the status it is given', () => {
    expect(notCheckedVerdict('Cloudflare is not set up yet.')).toEqual({
      state: 'not-configured',
      status: 'unknown',
      count: 0,
      sentence: 'Not checked. Cloudflare is not set up yet.',
    });
    expect(failedVerdict('Cloudflare could not be reached.', 'offline')).toEqual({
      state: 'failed',
      status: 'offline',
      count: 0,
      sentence: `${READ_FAILED} Cloudflare could not be reached.`,
    });
  });
});

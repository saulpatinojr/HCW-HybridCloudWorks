/**
 * The API rate limit check (#1909): the one verdict the Health probe and the
 * Cloudflare Overview share, for each state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: vi.fn(),
  sendJSON: vi.fn(),
}));

const { NO_RULE_ON, checkRateLimit, rateLimitFailure, rateLimitVerdict } =
  await import('./rateLimitCheck');

const PHASE_ROUTE = 'cms/cloudflare/rulesets/phases/http_ratelimit';
const rule = (extra = {}) => ({ id: 'r1', expression: 'true', action: 'block', ...extra });
const refusal = (message, status, code) => Object.assign(new Error(message), { status, code });

beforeEach(() => getJSON.mockReset());

describe('the rate limit verdict', () => {
  it('is healthy when a rule is on, naming how many', async () => {
    getJSON.mockResolvedValueOnce({ ruleset: { rules: [rule({ enabled: true })] } });
    expect(await checkRateLimit()).toEqual({
      state: 'on',
      status: 'healthy',
      count: 1,
      sentence: '1 API rate limit rule is on.',
    });
    expect(getJSON).toHaveBeenCalledWith(PHASE_ROUTE);
  });

  it('counts a rule with no enabled flag as on, and says when only some are', () => {
    const answer = { ruleset: { rules: [rule(), rule({ enabled: false }), rule({ id: 'r3' })] } };
    expect(rateLimitVerdict(answer)).toMatchObject({
      status: 'healthy',
      count: 2,
      sentence: '2 of 3 API rate limit rules are on.',
    });
  });

  it('is amber when the phase has no rule set', async () => {
    getJSON.mockResolvedValueOnce({ ruleset: null, version: null });
    const check = await checkRateLimit();
    expect(check).toMatchObject({ state: 'off', status: 'degraded', count: 0 });
    expect(check.sentence).toBe(
      `${NO_RULE_ON} The rate limiting phase (http_ratelimit) has no rules, so one address can send the API as many requests as it likes.`
    );
  });

  it('is amber when every rule is switched off, or the rule list is empty', () => {
    const off = rateLimitVerdict({ ruleset: { rules: [rule({ enabled: false })] } });
    expect(off).toMatchObject({ state: 'off', status: 'degraded' });
    expect(off.sentence).toContain('holds one rule, switched off or only logging');
    expect(rateLimitVerdict({ ruleset: { rules: [] } }).sentence).toContain('has no rules');
    expect(rateLimitVerdict(undefined).state).toBe('off');
  });

  it('is not checked, with the server’s sentence, while Cloudflare is not set up', async () => {
    const sentence = 'Cloudflare is not set up yet: the admin token (CLOUDFLARE_ADMIN_TOKEN).';
    getJSON.mockRejectedValueOnce(refusal(sentence, 503, 'CLOUDFLARE_NOT_CONFIGURED'));
    expect(await checkRateLimit()).toEqual({
      state: 'not-configured',
      status: 'unknown',
      count: 0,
      sentence: `Not checked. ${sentence}`,
    });
  });

  it('is red only when the read itself fails, with the error’s sentence', async () => {
    getJSON.mockRejectedValueOnce(new Error('Failed to fetch'));
    expect(await checkRateLimit()).toEqual({
      state: 'failed',
      status: 'offline',
      count: 0,
      sentence: 'The rate limiting rules could not be read: Failed to fetch',
    });
    expect(rateLimitFailure(refusal('Cloudflare answered with an error.', 502))).toMatchObject({
      state: 'failed',
      status: 'offline',
    });
    // The server answers a token Cloudflare refused with 502, so it is offline, not a role problem.
    expect(rateLimitFailure(refusal('Cloudflare refused the token.', 502))).toMatchObject({
      state: 'failed',
      status: 'offline',
    });
    expect(rateLimitFailure(refusal('Something broke.', 500))).toMatchObject({
      state: 'failed',
      status: 'critical',
    });
  });

  it('is not checked, never red, when the caller lacks the editor role (a viewer pressing Test all)', () => {
    for (const status of [401, 403]) {
      expect(rateLimitFailure(refusal('Requires editor or higher', status))).toEqual({
        state: 'not-allowed',
        status: 'unknown',
        count: 0,
        sentence: 'Not checked: reading the rate limiting rules needs the editor role.',
      });
    }
  });

  it('does not count a rule that only logs, since it limits nothing', () => {
    const logging = rateLimitVerdict({ ruleset: { rules: [rule({ action: 'log' })] } });
    expect(logging).toMatchObject({ state: 'off', status: 'degraded' });
    expect(logging.sentence).toContain('switched off or only logging');
    expect(
      rateLimitVerdict({ ruleset: { rules: [rule({ action: 'log' }), rule({ id: 'r2' })] } })
    ).toMatchObject({ state: 'on', count: 1 });
  });
});

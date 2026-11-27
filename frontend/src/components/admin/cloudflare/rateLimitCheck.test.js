/**
 * The API rate limit check (#1909, #1918): the server's verdict, which the Health probe
 * and the Cloudflare Overview both show, and the browser-only failures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: vi.fn(),
  sendJSON: vi.fn(),
}));

const { NOT_UPDATED, checkRateLimit, rateLimitFailure, rateLimitVerdict } =
  await import('./rateLimitCheck');

const PHASE_ROUTE = 'cms/cloudflare/rulesets/phases/http_ratelimit';
const refusal = (message, status, code) => Object.assign(new Error(message), { status, code });
/** The server's verdict, as the phase route answers it (#1918). */
const ON = { state: 'on', status: 'healthy', count: 1, sentence: '1 API rate limit rule is on.' };
const OFF = {
  state: 'off',
  status: 'degraded',
  count: 0,
  sentence:
    'No API rate limit rule is on. The rate limiting phase (http_ratelimit) has no rules, so one address can send the API as many requests as it likes.',
};
const GREY = { state: 'not-updated', status: 'unknown', count: 0, sentence: NOT_UPDATED };

beforeEach(() => getJSON.mockReset());

describe('the rate limit verdict', () => {
  it('shows the server’s verdict when a rule is on', async () => {
    getJSON.mockResolvedValueOnce({ ruleset: { rules: [] }, rateLimit: ON });
    expect(await checkRateLimit()).toEqual(ON);
    expect(getJSON).toHaveBeenCalledWith(PHASE_ROUTE);
  });

  it('shows the server’s amber verdict when no rule is on', async () => {
    getJSON.mockResolvedValueOnce({ ruleset: null, version: null, rateLimit: OFF });
    expect(await checkRateLimit()).toEqual(OFF);
  });

  it('never judges the rules itself: an answer without a verdict is grey, whatever its rules say', async () => {
    // A back end older than this page answers the rules and no verdict.
    getJSON.mockResolvedValueOnce({ ruleset: { rules: [{ id: 'r1', action: 'block' }] } });
    expect(await checkRateLimit()).toEqual(GREY);
    expect(rateLimitVerdict({ ruleset: null })).toEqual(GREY);
    expect(rateLimitVerdict(undefined)).toEqual(GREY);
    expect(GREY.sentence).toBe('Not checked: the server has not been updated yet.');
  });

  it('accepts only known state and status words, paired as the server pairs them', () => {
    for (const rateLimit of [
      { ...ON, state: 'maybe' },
      { ...ON, status: 'critical' },
      { ...OFF, status: 'healthy' },
      { ...ON, state: 'constructor' },
      { ...ON, state: '__proto__' },
      { ...ON, count: -1 },
      { ...ON, count: 1.5 },
      { ...ON, count: '1' },
      { ...ON, sentence: '' },
      { ...ON, sentence: 42 },
      'on',
      null,
    ]) {
      expect(rateLimitVerdict({ rateLimit }), JSON.stringify(rateLimit)).toEqual(GREY);
    }
  });

  it('shows the verdict field by field, nothing else it carries, and caps the sentence', () => {
    const shown = rateLimitVerdict({ rateLimit: { ...ON, extra: 'x', sentence: 'y'.repeat(900) } });
    expect(Object.keys(shown).sort()).toEqual(['count', 'sentence', 'state', 'status']);
    expect(shown.sentence).toHaveLength(500);
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
    expect(rateLimitFailure(refusal('Requires editor or higher', 403))).toEqual({
      state: 'not-allowed',
      status: 'unknown',
      count: 0,
      sentence: 'Not checked: reading the rate limiting rules needs the editor role.',
    });
  });

  it('treats a 401 (a missing or expired sign-in) as a real failure, not a role limit', () => {
    const expired = rateLimitFailure(refusal('Your session has expired.', 401));
    expect(expired.state).toBe('failed');
    expect(expired.status).not.toBe('unknown');
    expect(expired.sentence).toContain('Your session has expired.');
  });
});

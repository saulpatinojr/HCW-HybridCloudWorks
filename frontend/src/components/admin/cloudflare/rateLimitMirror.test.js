/**
 * "Is the API rate limit rule on?" is asked in the browser (rateLimitCheck.js:
 * the Health probe and the Cloudflare Overview) and on the server (the daily
 * checkCloudflareRateLimit timer, #1918, through
 * functions/src/lib/cloudflare/rate-limit.js). The timer writes its answer
 * onto the same Health card a Test writes, so the two must give the same
 * verdict, word for word, for every shape a phase answer can have, or the
 * card would change its mind depending on who last looked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NO_RULE_ON as SERVER_NO_RULE_ON,
  RATE_LIMIT_PHASE as SERVER_PHASE,
  RATE_LIMIT_PROBE_ID,
  READ_FAILED,
  failedVerdict,
  notCheckedVerdict,
  rateLimitVerdict as serverVerdict,
} from '../../../../../functions/src/lib/cloudflare/rate-limit.js';

vi.mock('@/lib/api', () => ({ getJSON: vi.fn(), postJSON: vi.fn(), sendJSON: vi.fn() }));

const { NO_RULE_ON, RATE_LIMIT_PHASE, rateLimitFailure, rateLimitVerdict } =
  await import('./rateLimitCheck');
const { PROBES } = await import('@/pages/admin/health/probeRegistry');

const rule = (extra = {}) => ({ id: 'r1', expression: 'true', action: 'block', ...extra });

const ANSWERS = [
  undefined,
  null,
  {},
  { ruleset: null },
  { ruleset: {} },
  { ruleset: { rules: null } },
  { ruleset: { rules: 'not a list' } },
  { ruleset: { rules: [] } },
  { ruleset: { rules: [rule()] } },
  { ruleset: { rules: [rule({ enabled: true })] } },
  { ruleset: { rules: [rule({ enabled: false })] } },
  { ruleset: { rules: [rule({ enabled: null })] } },
  { ruleset: { rules: [rule({ enabled: 0 })] } },
  { ruleset: { rules: [rule({ enabled: 'false' })] } },
  { ruleset: { rules: [rule({ enabled: 'true' })] } },
  { ruleset: { rules: [rule({ action: 'log' })] } },
  { ruleset: { rules: [rule({ action: 'LOG' })] } },
  { ruleset: { rules: [rule({ action: undefined })] } },
  { ruleset: { rules: [rule({ action: 'challenge' })] } },
  { ruleset: { rules: [null, 'x', 3, [], rule()] } },
  { ruleset: { rules: [rule(), rule({ enabled: false }), rule({ action: 'log' })] } },
  { ruleset: { rules: [rule({ enabled: false }), rule({ enabled: false })] } },
  { ruleset: { rules: [rule(), rule({ id: 'r2' })] } },
];

describe('the rate limit rule, browser and server', () => {
  it('name the same phase, probe and words', () => {
    expect(RATE_LIMIT_PHASE).toBe(SERVER_PHASE);
    expect(NO_RULE_ON).toBe(SERVER_NO_RULE_ON);
    expect(PROBES.some((probe) => probe.id === RATE_LIMIT_PROBE_ID)).toBe(true);
  });

  it.each(ANSWERS.map((answer) => [JSON.stringify(answer) ?? 'undefined', answer]))(
    'give the same verdict for %s',
    (_label, answer) => {
      expect(rateLimitVerdict(answer)).toEqual(serverVerdict(answer));
    }
  );

  it('word a failed read and a missing setup the same way', () => {
    const message = 'Cloudflare could not be reached. Try again shortly.';
    expect(rateLimitFailure(new Error(message)).sentence).toBe(failedVerdict(message).sentence);
    expect(failedVerdict(message).sentence.startsWith(READ_FAILED)).toBe(true);
    const notSetUp = Object.assign(new Error('Cloudflare is not set up yet.'), {
      code: 'CLOUDFLARE_NOT_CONFIGURED',
    });
    expect(rateLimitFailure(notSetUp)).toEqual(notCheckedVerdict('Cloudflare is not set up yet.'));
  });
});

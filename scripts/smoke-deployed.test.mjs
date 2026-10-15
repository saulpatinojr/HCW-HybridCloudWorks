/**
 * The smoke script's pure helpers. The script itself only proves anything
 * against a deployment; these prove the assertions it will make are the right
 * ones — a smoke test with a wrong filter passes against a broken deployment,
 * which is worse than no smoke test.
 */
import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  looksPublic,
  projectionLeaks,
  LIST_MUST_NOT_CARRY,
  looksValidEstate,
  looksValidCoderStatus,
} from './smoke-deployed.mjs';

describe('parseArgs', () => {
  it('reads --base and strips trailing slashes', () => {
    expect(parseArgs(['--base', 'https://x.azurewebsites.net/api/']).base).toBe(
      'https://x.azurewebsites.net/api'
    );
  });

  it('enables the cosmos tier only on request', () => {
    expect(parseArgs([]).cosmos).toBe(false);
    expect(parseArgs(['--cosmos']).cosmos).toBe(true);
  });
});

describe('looksPublic — mirrors the server filter', () => {
  it('admits every published spelling and Live', () => {
    expect(looksPublic({ Live: true })).toBe(true);
    expect(looksPublic({ Status: 'Live' })).toBe(true);
    for (const s of ['published', 'published_blog', 'published_news', 'published_both']) {
      expect(looksPublic({ contentStatus: s })).toBe(true);
    }
  });

  it('flags drafts, so a leak in the deployed filter is caught', () => {
    expect(looksPublic({ contentStatus: 'draft' })).toBe(false);
    expect(looksPublic({})).toBe(false);
  });
});

describe('projectionLeaks — mirrors the T-206 exclusion list', () => {
  it('covers all eight excluded body fields', () => {
    expect(LIST_MUST_NOT_CARRY).toHaveLength(8);
    const heavy = Object.fromEntries(LIST_MUST_NOT_CARRY.map((f) => [f, 'x']));
    expect(projectionLeaks(heavy)).toEqual(LIST_MUST_NOT_CARRY);
  });

  it('does not flag the one body field the projection keeps', () => {
    // `explanation` is deliberately IN the projection (Coder Corner excerpt
    // fallback); the smoke test must not report it as a leak.
    expect(projectionLeaks({ explanation: 'x', Title: 't' })).toEqual([]);
  });
});

describe('looksValidEstate — validates public/labs/estate contract', () => {
  it('validates unconfigured response', () => {
    expect(looksValidEstate({ configured: false })).toBe(true);
    expect(looksValidEstate(null)).toBe(false);
    expect(looksValidEstate({})).toBe(false);
  });

  it('validates configured response with required blocks', () => {
    expect(
      looksValidEstate({
        configured: true,
        arc: { status: 'Connected' },
        agent: { online: true },
        coder: { reachable: true },
      })
    ).toBe(true);

    expect(
      looksValidEstate({
        configured: true,
        arc: { status: 'Connected' },
      })
    ).toBe(false);
  });
});

describe('looksValidCoderStatus — validates public/labs/coder-status contract', () => {
  it('validates unconfigured response', () => {
    expect(looksValidCoderStatus({ configured: false })).toBe(true);
    expect(looksValidCoderStatus(null)).toBe(false);
  });

  it('validates configured response with reachable flag', () => {
    expect(looksValidCoderStatus({ configured: true, reachable: true })).toBe(true);
    expect(looksValidCoderStatus({ configured: true, reachable: false })).toBe(true);
    expect(looksValidCoderStatus({ configured: true })).toBe(false);
  });
});

/**
 * The Recording Hub's pure helpers (#576).
 *
 * `fmtDate` is the one worth the file. PlaudTab and PodcastTab each carried
 * their own copy, identical except that only PodcastTab's guarded
 * `Number.isNaN` — so the same malformed timestamp rendered as '' on one tab
 * and "Invalid Date" on the other. They are one function now, and this pins
 * which behaviour won.
 */
import { describe, expect, it } from 'vitest';
import {
  describeLastRefresh,
  describeSkip,
  fmtDate,
  fmtDuration,
  fmtWhen,
  hostErrorMessage,
  hostState,
  sourceLabel,
} from './recordingView';

describe('fmtDate', () => {
  it('is empty for nothing', () => {
    expect(fmtDate('')).toBe('');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
  });

  it('is empty for a malformed stamp rather than "Invalid Date"', () => {
    expect(fmtDate('not a date')).toBe('');
  });

  it('formats a real stamp', () => {
    expect(fmtDate('2026-09-16T10:00:00Z')).toContain('2026');
  });
});

describe('fmtDuration', () => {
  it('is empty for no duration', () => {
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(undefined)).toBe('');
  });

  it('scales from seconds to hours', () => {
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
    expect(fmtDuration(3_725_000)).toBe('1h 2m');
  });
});

describe('fmtWhen', () => {
  it('reads both shapes the Plaud document stores (#358)', () => {
    // lastTokenRefresh is an ISO string; oauthExpiresAt is epoch milliseconds.
    expect(fmtWhen('2026-09-16T10:00:00Z')).toContain('2026');
    expect(fmtWhen(Date.parse('2026-09-16T10:00:00Z'))).toContain('2026');
  });

  it('is empty for absent or unparseable values', () => {
    expect(fmtWhen(null)).toBe('');
    expect(fmtWhen('')).toBe('');
    expect(fmtWhen('nonsense')).toBe('');
  });
});

describe('describeLastRefresh', () => {
  it('distinguishes never-rotated from unreadable', () => {
    // A field that is PRESENT but unparseable must not claim the timer never
    // ran — it did, we merely cannot read when.
    expect(describeLastRefresh(null)).toBe('not since this token was stored');
    expect(describeLastRefresh('nonsense')).toBe('recorded, but its timestamp could not be read');
    expect(describeLastRefresh('2026-09-16T10:00:00Z')).toContain('2026');
  });
});

describe('describeSkip', () => {
  it('prefers the stored sentence over the code', () => {
    expect(describeSkip({ skipped: 'no_audio', reason: 'the file was empty' })).toBe(
      'the file was empty'
    );
  });

  it('falls back to a readable phrase per code', () => {
    expect(describeSkip({ skipped: 'no_audio' })).toContain('no audio');
    expect(describeSkip({ skipped: 'not_configured' })).toContain('PODBEAN_CLIENT_ID');
    // The job's guard for ElevenLabs free-plan audio (2026-09-26).
    expect(describeSkip({ skipped: 'free_plan_licence' })).toMatch(
      /ElevenLabs free plan, which has no commercial licence/
    );
  });

  it('never renders an object, and is empty for no host', () => {
    expect(describeSkip({ skipped: 'mystery' })).toBe('mystery');
    expect(describeSkip(null)).toBe('');
  });
});

describe('hostState', () => {
  it('names the four states, in the order HostLine renders them', () => {
    expect(hostState({ host: { podbean: { pending: true, episodeId: 'e1' } } })).toBe('pending');
    expect(hostState({ host: { podbean: { episodeId: 'e1' } } })).toBe('published');
    expect(hostState({ host: { podbean: { error: 'boom' } } })).toBe('error');
    expect(hostState({ host: { podbean: { skipped: 'no_audio' } } })).toBe('skipped');
  });

  it('is `none` when nothing has tried to publish it', () => {
    expect(hostState({})).toBe('none');
    expect(hostState({ host: {} })).toBe('none');
    expect(hostState({ host: { podbean: 'nope' } })).toBe('none');
    expect(hostState(null)).toBe('none');
    // The retired host's key (ADR 0029 §1c) is not read: the only record
    // production ever stored there was this skip, which says nothing about Podbean.
    expect(hostState({ host: { rsscom: { skipped: 'not_configured' } } })).toBe('none');
  });
});

describe('hostErrorMessage', () => {
  it('reads both shapes the record stores', () => {
    expect(hostErrorMessage({ error: 'boom' })).toBe('boom');
    expect(hostErrorMessage({ error: { message: 'boom' } })).toBe('boom');
    expect(hostErrorMessage({ error: {} })).toBe('publish failed');
    expect(hostErrorMessage({})).toBe('');
  });
});

describe('sourceLabel', () => {
  it('names each way a recording reaches the container', () => {
    expect(sourceLabel('plaud-embedded')).toBe('Plaud Embedded');
    expect(sourceLabel('plaud_mcp')).toBe('Plaud copy');
    expect(sourceLabel('manual_upload')).toBe('Pasted');
    expect(sourceLabel('')).toBe('stored');
  });
});

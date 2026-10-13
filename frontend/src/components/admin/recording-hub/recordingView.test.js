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
  describeDownloads,
  describeLastRefresh,
  describeSkip,
  fmtDate,
  fmtDuration,
  fmtWhen,
  hostErrorMessage,
  hostState,
  liveRowFor,
  liveStatusLabel,
  sourceLabel,
  sparklineBars,
  unmatchedLiveRows,
  overviewNotes,
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

describe('the Podbean overview helpers (#1115)', () => {
  const overview = {
    episodes: [
      { transcriptId: 'article_a', episodeId: 'E1', downloads: { total: 12, byDay: {} } },
      { transcriptId: null, episodeId: 'E9', downloads: null },
      { transcriptId: 'article_b', episodeId: 'E2', downloads: { total: 1, byDay: {} } },
    ],
  };

  it('liveStatusLabel reads publish as Live and draft as a draft on the host', () => {
    expect(liveStatusLabel('publish')).toBe('Live');
    expect(liveStatusLabel('draft')).toBe('Draft on Podbean');
    expect(liveStatusLabel('scheduled')).toBe('scheduled');
    expect(liveStatusLabel(null)).toBe('Unknown');
  });

  it('describeDownloads is the count over the window, singular for one, and empty for no count', () => {
    expect(describeDownloads({ downloads: { total: 12 } })).toBe('12 downloads, last 30 days');
    expect(describeDownloads({ downloads: { total: 1 } }, 7)).toBe('1 download, last 7 days');
    expect(describeDownloads({ downloads: { total: 0 } })).toBe('0 downloads, last 30 days');
    expect(describeDownloads({ downloads: null })).toBe('');
    expect(describeDownloads({ downloads: { total: 'many' } })).toBe('');
    expect(describeDownloads(null)).toBe('');
  });

  it('sparklineBars orders by date and scales to the busiest day', () => {
    expect(sparklineBars({ '2026-10-12': 5, '2026-10-10': 10, '2026-10-11': 0 })).toEqual([
      { date: '2026-10-10', count: 10, height: 100 },
      { date: '2026-10-11', count: 0, height: 0 },
      { date: '2026-10-12', count: 5, height: 50 },
    ]);
  });

  it('sparklineBars keeps a quiet window as zero-height bars, and drops what is not a count', () => {
    expect(sparklineBars({ '2026-10-10': 0, '2026-10-11': 0 })).toEqual([
      { date: '2026-10-10', count: 0, height: 0 },
      { date: '2026-10-11', count: 0, height: 0 },
    ]);
    expect(sparklineBars({ '2026-10-10': 'x', '2026-10-11': -1, '2026-10-12': '3' })).toEqual([
      { date: '2026-10-12', count: 3, height: 100 },
    ]);
    expect(sparklineBars(null)).toEqual([]);
    expect(sparklineBars([])).toEqual([]);
    expect(sparklineBars({})).toEqual([]);
  });

  it('liveRowFor finds the row by transcript id, then by the record’s episode id, else null', () => {
    expect(liveRowFor(overview, { id: 'article_a' }).episodeId).toBe('E1');
    expect(
      liveRowFor(overview, { id: 'article_a_regenerated', host: { podbean: { episodeId: 'E2' } } })
        .transcriptId
    ).toBe('article_b');
    expect(
      liveRowFor(overview, { id: 'nope', host: { podbean: { episodeId: 'E404' } } })
    ).toBeNull();
    expect(liveRowFor(overview, { id: 'nope' })).toBeNull();
    expect(liveRowFor(null, { id: 'article_a' })).toBeNull();
    expect(liveRowFor({ episodes: 'bad' }, { id: 'article_a' })).toBeNull();
  });

  it('unmatchedLiveRows is every row no transcript names', () => {
    expect(unmatchedLiveRows(overview).map((row) => row.episodeId)).toEqual(['E9']);
    expect(unmatchedLiveRows(null)).toEqual([]);
    expect(unmatchedLiveRows({ configured: false })).toEqual([]);
  });
});

describe('overviewNotes', () => {
  it('counts the rows that carry download figures, whatever the cap says', () => {
    const data = {
      downloadsCapped: 1,
      episodes: [
        { downloads: { total: 3, byDay: {} } },
        { downloads: null, error: { code: 'UPSTREAM', message: 'x' } },
        { downloads: null, error: { code: 'NOT_LISTED', message: 'y' } },
      ],
      errors: {},
    };
    expect(overviewNotes(data).coverage).toBe('downloads shown for 1 of 3');
    expect(overviewNotes({ episodes: [{ downloads: { total: 1, byDay: {} } }], errors: {} }).coverage).toBeNull();
    expect(overviewNotes({ episodes: [], errors: {} }).coverage).toBeNull();
  });

  it('surfaces the show read failure as well as the episode-listing one', () => {
    const data = {
      episodes: [],
      errors: {
        show: { code: 'UPSTREAM', message: 'Podbean answered 503 while reading the podcast.' },
        episodes: { code: 'UPSTREAM', message: 'Podbean answered 429 while listing episodes.' },
      },
    };
    expect(overviewNotes(data).failures).toEqual([
      'Show details: Podbean answered 503 while reading the podcast.',
      'Podbean answered 429 while listing episodes.',
    ]);
    expect(overviewNotes({ episodes: [], errors: {} }).failures).toEqual([]);
  });
});

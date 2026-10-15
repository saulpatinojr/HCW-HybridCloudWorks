/**
 * videos.js — what a failed video search says (#945 step 2).
 *
 * The per-area `error` and the run's `videoError` are stored on the
 * generation job's result and served to the admin page by getJob, so they
 * carry this module's sentence (the status and the API's reason code) and
 * never the Data API's message or a socket's text.
 */
import { describe, it, expect, vi } from 'vitest';
import { isAuthoredError } from '../http/error-response.js';
import { VideoSearchError, findVideosForAreas, searchVideos } from './videos.js';

const areas = [{ slug: 'area-1', name: 'Area 1', subheadings: ['Manage identities'] }];

/** A Data API answer with the given status and body. */
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('a failed video search', () => {
  it('names the status and the reason code, never the API message', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(403, {
        error: {
          message: 'The request cannot be completed because you have exceeded your quota for key AIza-x.',
          errors: [{ reason: 'quotaExceeded' }],
        },
      })
    );
    const error = await searchVideos('AZ-104', { apiKey: 'k', fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(VideoSearchError);
    expect(isAuthoredError(error)).toBe(true);
    expect(error.status).toBe(403);
    expect(error.message).toBe('YouTube Data API HTTP 403 (daily quota exhausted): quotaExceeded');
    expect(error.message).not.toContain('AIza');
  });

  it('names the socket code when the API cannot be reached, never the socket text', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com key=AIza-x'), {
        code: 'ENOTFOUND',
      });
    });
    const error = await searchVideos('AZ-104', { apiKey: 'k', fetchImpl }).catch((e) => e);
    expect(error.message).toBe('Failed to reach the YouTube Data API (ENOTFOUND).');
  });

  it('stores the sentence per area, so the job result shows the reason', async () => {
    const fetchImpl = vi.fn(async () => reply(400, { error: { message: 'Bad q: <script>', errors: [{ reason: 'badRequest' }] } }));
    const [result] = await findVideosForAreas(areas, { examCode: 'AZ-104', apiKey: 'k', fetchImpl });
    expect(result).toMatchObject({ areaSlug: 'area-1', videos: [] });
    expect(result.error).toBe('YouTube Data API HTTP 400: badRequest');
  });

  it('stores a fixed sentence with the code for a failure it did not write', async () => {
    // An unreadable clock makes `toISOString` throw a RangeError before any
    // request: an error this module did not write, so its text stays out.
    const fetchImpl = vi.fn();
    const [result] = await findVideosForAreas(areas, {
      examCode: 'AZ-104',
      apiKey: 'k',
      fetchImpl,
      nowMs: Number.NaN,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.error).toBe('The video search failed (RangeError).');
  });

  it('refuses without a key in its own words', async () => {
    const [result] = await findVideosForAreas(areas, { examCode: 'AZ-104', apiKey: '' });
    expect(result.error).toBe('YOUTUBE_API_KEY is not configured');
  });
});

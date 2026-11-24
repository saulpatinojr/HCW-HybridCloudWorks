/**
 * createRssParser: what its errors tell a log line (#1794). The fetch is
 * replaced; the feed library is the installed one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorCode, errorFacts, storedFailure } from '../http/error-response.js';

const guardedFetch = vi.hoisted(() => vi.fn());
vi.mock('../http/guarded-fetch.js', () => ({ guardedFetch }));

const { createRssParser } = await import('./ingest.js');

/** Make the next fetch answer with this status and body. */
const answer = (status, body = '') =>
  guardedFetch.mockResolvedValueOnce({ response: { ok: status >= 200 && status < 300, status }, text: () => body });

/** The error a feed read rejects with. */
const failure = async () =>
  (await createRssParser()).parseURL('https://feeds.example/private-show').then(
    () => {
      throw new Error('the read did not fail');
    },
    (error) => error
  );

describe('createRssParser: a failed read says which failure it was, by code', () => {
  beforeEach(() => guardedFetch.mockReset());

  it('carries the HTTP status as a field, so a 404 and a 500 read differently', async () => {
    answer(404);
    const missing = await failure();
    expect(errorCode(missing)).toBe('HTTP_404');
    expect(errorFacts(missing)).toMatch(/^name=Error status=404 at=src\/lib\/rss\/ingest\.js:\d+$/);
    expect(storedFailure(missing, 'The feed could not be read.')).toBe('The feed could not be read (HTTP_404).');
    answer(500);
    expect(errorCode(await failure())).toBe('HTTP_500');
  });

  it('gives a body that is not a feed the code PARSE, and keeps the library\'s words out of it', async () => {
    for (const body of ['<rss><channel><item></rss>', 'not xml', '<html><body/></html>']) {
      answer(200, body);
      const error = await failure();
      expect(errorCode(error), body).toBe('PARSE');
      expect(errorFacts(error), body).toMatch(/^name=Error code=PARSE cause=Error\b/);
      expect(error.message).toBe('The feed body could not be read as a feed.');
    }
  });

  it('still returns the feed when the body is one', async () => {
    answer(200, '<rss version="2.0"><channel><title>T</title><item><title>One</title></item></channel></rss>');
    const feed = await (await createRssParser()).parseURL('https://feeds.example/show');
    expect(feed.items.map((entry) => entry.title)).toEqual(['One']);
  });
});

import { describe, expect, it } from 'vitest';
import { errorFacts } from '../http/error-response.js';
import { feedErrorCode } from './feed-error-code.js';

describe('feedErrorCode: a code for a feed that could not be read (#1794)', () => {
  it("says what the facts alone cannot: every one of the feed library's failures is a plain Error", () => {
    for (const message of ['Status code 404', 'Status code 500', 'Request timed out after 60000ms', 'Unable to parse XML.']) {
      expect(errorFacts(new Error(message)).split(' ')[0]).toBe('name=Error');
    }
    expect(feedErrorCode(new Error('Status code 404'))).toBe('HTTP_404');
    expect(feedErrorCode(new Error('Status code 500'))).toBe('HTTP_500');
    expect(feedErrorCode(new Error('Request timed out after 60000ms'))).toBe('TIMEOUT');
    expect(feedErrorCode(new Error('Too many redirects'))).toBe('REDIRECTS');
    expect(feedErrorCode(new Error('Unable to parse XML.'))).toBe('PARSE');
    expect(feedErrorCode(new Error('Feed not recognized as RSS 1 or 2.'))).toBe('PARSE');
    expect(feedErrorCode(new Error('default RSS version not recognized.'))).toBe('PARSE');
    expect(feedErrorCode(new Error('Unexpected close tag\nLine: 0\nColumn: 26\nChar: >'))).toBe('PARSE');
  });

  it('matches what the installed feed library really throws for a broken body', async () => {
    const { default: RssParser } = await import('rss-parser');
    const parser = new RssParser();
    for (const body of ['<rss><channel><item></rss>', 'not xml', '', '<html><body/></html>']) {
      const error = await parser.parseString(body).then(
        () => null,
        (thrown) => thrown
      );
      expect(error, body).toBeInstanceOf(Error);
      expect(feedErrorCode(error), body).toBe('PARSE');
    }
  });

  it('keeps the name an error already gives itself, and never classifies it by its words', () => {
    expect(feedErrorCode(Object.assign(new Error('Status code 404'), { code: 'ENOTFOUND' }))).toBe('ENOTFOUND');
    expect(feedErrorCode(Object.assign(new Error('Request timed out after 5ms'), { status: 503 }))).toBe('HTTP_503');
    expect(feedErrorCode(new TypeError('Status code 404'))).toBe('TypeError');
    expect(feedErrorCode(new DOMException('The operation timed out', 'TimeoutError'))).toBe('TimeoutError');
  });

  it('only ever returns a fixed word, HTTP_ and three digits, or the door\'s code: never any of the message', () => {
    const secret = 'customer-acme-invoice-2291';
    const messages = [
      `Status code 404 ${secret}`,
      `${secret} Status code 404`,
      `Status code 4040`,
      `Status code ${secret}`,
      `Request timed out after ${secret}ms`,
      `Too many redirects to ${secret}`,
      `Unable to parse XML. ${secret}`,
      `${secret}\nLine: 1\nColumn: 2\nChar: x`,
      secret,
      '',
    ];
    const allowed = /^(HTTP_\d{3}|TIMEOUT|REDIRECTS|PARSE|Error)$/;
    for (const message of messages) {
      const code = feedErrorCode(new Error(message));
      expect(code, message).toMatch(allowed);
      expect(code).not.toContain(secret);
    }
    // Only an exact status sentence is a status.
    expect(feedErrorCode(new Error('Status code 4040'))).toBe('Error');
    expect(feedErrorCode(new Error(`Status code 404 ${secret}`))).toBe('Error');
    // Not an error at all.
    expect(feedErrorCode(null)).toBe('UNKNOWN');
    expect(feedErrorCode('Status code 404')).toBe('UNKNOWN');
    expect(feedErrorCode({ message: 'Status code 404' })).toBe('UNKNOWN');
  });
});

/**
 * feed-error-code.js — a content-free code for a feed that could not be read
 * (#1794).
 *
 * The feed library (rss-parser, and the XML reader under it) reports most
 * failures as a plain `Error` whose only information is its message: no
 * `code`, no `status`, no class name of its own. A log line that prints only
 * the error's code then reads `name=Error` for a missing feed, a slow one and
 * a broken one alike. This helper recognises the library's own fixed message
 * shapes and answers with a code from a fixed set, so the line can say which
 * it was without ever carrying the message.
 *
 * It READS the message to classify it and never returns any part of it:
 * every `return` is a fixed word, `HTTP_` plus the three digits the pattern
 * captured, or what `errorCode` gives. `no-raw-error-in-logs.test.js` holds
 * the function to that rule.
 */
import { errorCode } from '../http/error-response.js';

/** The library's fixed sentences for a body it could not read as a feed. */
const PARSE_MESSAGES = new Set([
  'Unable to parse XML.',
  'Feed not recognized as RSS 1 or 2.',
  'default RSS version not recognized.',
]);

/** The XML reader's failure: its reason, then where in the text it stopped. */
const XML_FAULT_SHAPE = /\nLine: \d{1,9}\nColumn: \d{1,9}\nChar: /;

/**
 * What went wrong reading a feed, as a code a log line may carry.
 *
 * An error that already names itself (a socket code such as `ENOTFOUND`, an
 * HTTP status, a class name other than `Error`) keeps that name. A plain
 * `Error` is matched against the feed library's message shapes.
 *
 * @param {unknown} error - anything a feed read threw
 * @returns {string} `HTTP_404`, `TIMEOUT`, `REDIRECTS`, `PARSE`, or what `errorCode` gives
 */
export function feedErrorCode(error) {
  if (errorCode(error) !== 'Error') return errorCode(error);
  const message = typeof error?.message === 'string' ? error.message : '';
  const status = /^Status code (\d{3})$/.exec(message);
  if (status) return `HTTP_${status[1]}`;
  if (/^Request timed out after \d{1,9}ms$/.test(message)) return 'TIMEOUT';
  if (message === 'Too many redirects') return 'REDIRECTS';
  if (PARSE_MESSAGES.has(message) || XML_FAULT_SHAPE.test(message)) return 'PARSE';
  return errorCode(error);
}

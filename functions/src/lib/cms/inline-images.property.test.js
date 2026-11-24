/**
 * Property tests for `scrubUrls` (./inline-images.js): the text of a failed
 * image fetch made safe for a log line, with every http(s) address replaced
 * by `[url]`.
 *
 * A property test states a rule that must hold for every input, and a
 * library (fast-check) makes up hundreds of inputs to try to break it. A
 * failure prints the smallest input found and a seed that replays the run.
 *
 * The addresses come from article bodies and from the error text of servers
 * this site does not run, and an address can carry a signed query string (a
 * temporary password in the link), so the rule is that none of it survives.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { scrubUrls } from './inline-images.js';

const RUNS = { numRuns: 500 };

const scheme = fc.constantFrom('http://', 'https://', 'HTTP://', 'HttpS://');
/** What follows the scheme: anything up to the next blank, quotes and brackets included. */
const rest = fc.oneof(
  fc.webUrl({ withQueryParameters: true, withFragments: true }).map((url) => url.replace(/^https?:\/\//, '')),
  fc.stringMatching(/^[!-~]{1,30}$/),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 20 }).filter((s) => !/\s/.test(s))
);
/** A word of the message that is not an address: no blank, and no `:` so it cannot form a scheme. */
const word = fc.stringMatching(/^[!-9;-~]{0,12}$/);
/** What may sit right before an address in a message: nothing, or a quote or bracket. */
const opener = fc.constantFrom('', '(', '"', "'", '<', '[', 'src=');
const blank = fc.constantFrom(' ', '\n', '\t', '  ');

/** One piece of a message: a plain word, or an address with what was put in it. */
const piece = fc.oneof(
  word.map((text) => ({ text, scrubbed: text })),
  fc.tuple(opener, scheme, rest).map(([before, s, r]) => ({ text: before + s + r, scrubbed: `${before}[url]` }))
);
/** A whole message: pieces with a blank between each two. */
const message = fc
  .array(fc.tuple(piece, blank), { maxLength: 8 })
  .map((parts) => ({
    text: parts.map(([p, gap]) => p.text + gap).join(''),
    scrubbed: parts.map(([p, gap]) => p.scrubbed + gap).join(''),
  }));

describe('scrubUrls (property)', () => {
  // Rule 1: after scrubbing, no http(s) address is left in the text,
  // whatever the text was.
  it('leaves no http(s) address in any text', () => {
    fc.assert(
      fc.property(fc.oneof(message.map((m) => m.text), fc.string({ unit: 'binary', maxLength: 200 })), (text) => {
        expect(scrubUrls(text)).not.toMatch(/https?:\/\/\S/i);
      }),
      RUNS
    );
  });

  // Rule 2: the whole address goes, up to the next blank, and nothing else
  // does. A quote, bracket or apostrophe inside an address does not end it,
  // so the part after it (a path, a signed query string) is not left behind.
  it('removes each address whole and keeps every other word', () => {
    fc.assert(
      fc.property(message, ({ text, scrubbed }) => {
        expect(scrubUrls(text)).toBe(scrubbed);
      }),
      RUNS
    );
  });

  // Rule 3: scrubbing twice changes nothing more, and text with no address
  // comes back as it was.
  it('is stable: a second pass changes nothing, and plain text is untouched', () => {
    fc.assert(
      fc.property(message, fc.array(fc.tuple(word, blank), { maxLength: 8 }), ({ text }, plain) => {
        const once = scrubUrls(text);
        expect(scrubUrls(once)).toBe(once);
        const sentence = plain.map(([w, gap]) => w + gap).join('');
        expect(scrubUrls(sentence)).toBe(sentence);
      }),
      RUNS
    );
  });

  // Rule 4: a value that is not text is answered with text and no error.
  it('answers a value that is not text with text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(null, undefined), fc.integer(), fc.boolean(), fc.double()), (value) => {
        expect(typeof scrubUrls(value)).toBe('string');
      }),
      RUNS
    );
  });
});

/**
 * draft-guard.js — the honesty guard on an interview draft (ADR 0040 D4,
 * #1565).
 *
 * A model asked to turn a transcript into questions and answers will, now
 * and then, tidy a sentence into one the guest did not say, or lift a
 * "quote" that is a paraphrase. On a page that attributes every word to a
 * named person that is not a style problem, it is a misquote. Two rules,
 * applied to every item before it is stored, and nothing else:
 *
 *   1. A pull quote must appear VERBATIM in the GUEST'S OWN TURNS, compared
 *      with whitespace collapsed, case folded and typographic quotes and
 *      dashes straightened. One that does not is dropped — not flagged,
 *      dropped — because a pull quote is set apart on the page as the
 *      guest's exact words and there is no honest way to show one that is
 *      not; a sentence the interviewer said is not the guest's either. Only
 *      when the speakers could not be told apart (`speakersUnsure`) is the
 *      whole transcript the reference, since the guest's turns are then a
 *      guess.
 *   2. An answer must draw at least 80% of its distinct words of five
 *      letters or more from the guest's own turns. One that does not is
 *      KEPT and flagged `needsReview: true` for the editor, because an
 *      answer that reads strangely to this rule (a short one, a technical
 *      one with acronyms) may be fine, and the editor sees the transcript.
 *
 * Nothing invented survives silently; nothing the guest said is thrown
 * away. The guard is pure: the transcript text, the guest's turns and the
 * list in, the list and a report out.
 */

export const ANSWER_WORD_SHARE = 0.8;
export const MIN_WORD_LENGTH = 5;

/** Fold case, straighten quotes and dashes, collapse whitespace. */
export function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The distinct words of `MIN_WORD_LENGTH` letters or more, folded. */
export function longWords(text) {
  const words = new Set();
  for (const match of normalizeForMatch(text).matchAll(/[\p{L}\p{N}'-]+/gu)) {
    const word = match[0].replace(/^['-]+|['-]+$/g, '');
    if (word.length >= MIN_WORD_LENGTH) words.add(word);
  }
  return words;
}

/**
 * The share of an answer's long words that the guest's turns contain, in
 * [0, 1]. An answer with no long words at all is taken as the guest's: the
 * rule has nothing to judge, and a one-line answer is not an invention.
 */
export function answerShare(answer, guestWords) {
  const words = longWords(answer);
  if (words.size === 0) return 1;
  let found = 0;
  for (const word of words) if (guestWords.has(word)) found += 1;
  return found / words.size;
}

/**
 * Apply the two rules.
 *
 * @param {Array<{q:string,a:string,pullQuote?:string}>} qa - the validated list
 * @param {{ transcriptText: string, guestText: string, speakersUnsure?: boolean }} source - the whole
 *   transcript as text, the guest's turns alone (the speaker mapping in
 *   draft.js decides which turns those are), and whether that mapping is a guess
 * @returns {{ qa: Array, droppedQuotes: number, flagged: number }}
 */
export function guardDraft(qa, { transcriptText, guestText, speakersUnsure = false }) {
  const transcript = normalizeForMatch(speakersUnsure ? transcriptText : guestText);
  const guestWords = longWords(guestText);
  let droppedQuotes = 0;
  let flagged = 0;
  const out = (qa || []).map((item) => {
    const next = { q: item.q, a: item.a, pullQuote: item.pullQuote || '' };
    if (next.pullQuote) {
      const quote = normalizeForMatch(next.pullQuote);
      if (!quote || !transcript.includes(quote)) {
        next.pullQuote = '';
        droppedQuotes += 1;
      }
    }
    if (answerShare(next.a, guestWords) < ANSWER_WORD_SHARE) {
      next.needsReview = true;
      flagged += 1;
    }
    return next;
  });
  return { qa: out, droppedQuotes, flagged };
}

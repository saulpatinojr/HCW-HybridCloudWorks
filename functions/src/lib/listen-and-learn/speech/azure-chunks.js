/**
 * azure-chunks.js — cutting a dialogue into Azure speech requests that stay
 * inside the audio duration Azure will render in one go (azure.js says how
 * the requests are sent, and exports chunkTurns and the budget again).
 */

/**
 * The API truncates at 600 seconds of audio. 480 is the working budget: the
 * 20% headroom absorbs the error in the estimate below, and being wrong in
 * this direction costs one extra request while being wrong in the other
 * silently deletes the end of an episode.
 */
export const MAX_SECONDS_PER_REQUEST = 480;

/**
 * UTF-8 bytes of dialogue per second of speech.
 *
 * Deliberately pessimistic. The voice list publishes `WordsPerMinute` per
 * voice, from about 130 for the slowest en-US voices to 190 for the fastest;
 * a SLOW voice produces fewer bytes per second, so assuming slow over-estimates
 * the duration of a given script and chunks earlier than strictly needed.
 * Estimating with a fast voice would under-estimate duration and walk straight
 * into the truncation this constant exists to avoid.
 */
export const BYTES_PER_SECOND = 13;

export const MAX_BYTES_PER_REQUEST = MAX_SECONDS_PER_REQUEST * BYTES_PER_SECOND;

export const byteLength = (text) => Buffer.byteLength(String(text || ''), 'utf8');

/**
 * Split one over-long turn on sentence boundaries.
 *
 * Splitting inside a turn is safe in a way that dropping one is not: both
 * halves are spoken by the same voice, so the listener hears continuous
 * speech. Falls back to a hard byte split only if a single "sentence" is
 * itself over budget, which means punctuation-free text.
 */
/**
 * A sentence with no boundary to use, split on characters: the full chunks,
 * each at most `limit` bytes plus one multi-byte character, and the
 * remainder still open.
 */
function splitByBytes(sentence, limit) {
  const parts = [];
  let chunk = '';
  for (const char of sentence) {
    if (byteLength(chunk) + byteLength(char) > limit) {
      parts.push(chunk.trim());
      chunk = '';
    }
    chunk += char;
  }
  return { parts, remainder: chunk };
}

function splitTurnText(text, limit) {
  const sentences = String(text).match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
  const parts = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer && byteLength(buffer) + byteLength(sentence) > limit) {
      parts.push(buffer.trim());
      buffer = '';
    }
    if (byteLength(sentence) > limit) {
      if (buffer.trim()) parts.push(buffer.trim());
      const split = splitByBytes(sentence, limit);
      parts.push(...split.parts);
      buffer = split.remainder;
      continue;
    }
    buffer += sentence;
  }

  if (buffer.trim()) parts.push(buffer.trim());
  return parts.filter(Boolean);
}

/**
 * Group turns into requests that stay inside the duration budget.
 *
 * Whole turns wherever possible so a speaker change never falls across a
 * request boundary mid-thought; an over-long single turn is split rather than
 * emitted alone and truncated.
 */
export function chunkTurns(turns, limit = MAX_BYTES_PER_REQUEST) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const turn of turns) {
    const text = String(turn?.text || '').trim();
    if (!text) continue;
    const speaker = turn.speaker;

    if (byteLength(text) > limit) {
      flush();
      for (const part of splitTurnText(text, limit)) {
        chunks.push([{ speaker, text: part }]);
      }
      continue;
    }

    if (currentBytes + byteLength(text) > limit) flush();
    current.push({ speaker, text });
    currentBytes += byteLength(text);
  }

  flush();
  return chunks;
}


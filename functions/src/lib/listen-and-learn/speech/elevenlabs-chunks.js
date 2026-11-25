/**
 * elevenlabs-chunks.js — cutting a dialogue into ElevenLabs Text to Dialogue
 * requests, measured in code points, the unit the API states its ceiling and
 * its bill in (elevenlabs.js says why and exports all of this again).
 */

/** Documented ceiling on the summed `inputs[].text` length per request. */
export const MAX_CHARACTERS_PER_REQUEST = 2000;

/** Characters as the API counts them: code points, not UTF-16 units. */
export const characterCount = (text) => [...String(text ?? '')].length;

/** Sum of every turn's text, for the cost estimate and the usage row. */
export function dialogueCharacters(turns) {
  return (turns || []).reduce((total, turn) => total + characterCount(turn?.text), 0);
}

/**
 * Split one over-long turn on sentence boundaries, measured in code points.
 *
 * Both halves are spoken by the same voice, so the listener hears continuous
 * speech. Falls back to a per-character split only when a single "sentence"
 * is itself over the limit, which means punctuation-free text.
 */
function splitTurnText(text, limit) {
  const sentences = String(text).match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [String(text)];
  const parts = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer && characterCount(buffer) + characterCount(sentence) > limit) {
      parts.push(buffer.trim());
      buffer = '';
    }
    if (characterCount(sentence) > limit) {
      if (buffer.trim()) parts.push(buffer.trim());
      buffer = splitSentenceByCharacter(sentence, limit, parts);
    } else {
      buffer += sentence;
    }
  }

  if (buffer.trim()) parts.push(buffer.trim());
  return parts.filter(Boolean);
}

/**
 * A sentence longer than the limit, cut every `limit` characters: each full
 * piece is added to `parts`, and the last, partial one is returned to carry on.
 */
function splitSentenceByCharacter(sentence, limit, parts) {
  let chunk = '';
  for (const char of sentence) {
    if (characterCount(chunk) + 1 > limit) {
      parts.push(chunk.trim());
      chunk = '';
    }
    chunk += char;
  }
  return chunk;
}

/**
 * Group turns into requests of at most `limit` CODE POINTS of text.
 *
 * The same policy as azure.js's `chunkTurns` — whole turns wherever possible
 * so a speaker change never falls across a request boundary mid-thought, an
 * over-long turn split rather than sent whole and refused — in the unit this
 * API states its ceiling and its bill in. `text.length` would count UTF-16
 * units and over-count astral characters; bytes would over-count everything
 * outside ASCII.
 *
 * @param {{speaker: string, text: string}[]} turns
 * @param {number} [limit]
 * @returns {{speaker: string, text: string}[][]}
 */
export function chunkTurnsByCharacters(turns, limit = MAX_CHARACTERS_PER_REQUEST) {
  const chunks = [];
  let current = [];
  let currentCount = 0;

  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentCount = 0;
  };

  for (const turn of turns) {
    const text = String(turn?.text || '').trim();
    if (!text) continue;
    const speaker = turn.speaker;
    const count = characterCount(text);

    if (count > limit) {
      flush();
      for (const part of splitTurnText(text, limit)) {
        chunks.push([{ speaker, text: part }]);
      }
      continue;
    }

    if (currentCount + count > limit) flush();
    current.push({ speaker, text });
    currentCount += count;
  }

  flush();
  return chunks;
}


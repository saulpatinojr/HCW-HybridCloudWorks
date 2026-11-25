/**
 * The document vault's upload results in plain words: one line per file, and
 * the summary under a batch. Moved out of docVaultModel.js, which re-exports
 * them, when that file grew too long.
 */

// ── uploads ────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What each answer the API gives for an upload reads as, and its tone. */
const OUTCOME_LINES = {
  created: { tone: 'ok', text: (doc, where) => `Added as a new document${where}` },
  versioned: {
    tone: 'ok',
    text: (doc, where) =>
      `Saved as version ${doc?.version ?? 'next'} of a document already here${where}`,
  },
  unchanged: { tone: 'skip', text: () => 'Already here with exactly this text; nothing changed' },
  restored: { tone: 'ok', text: () => 'Brought back from Trash; the text was the same' },
};

/**
 * One line of the result list for one file (or the pasted text): `answer` is
 * what the API said, or `error` is what went wrong. Plain words, no codes.
 *
 * @param {string} name
 * @param {{ answer?: object, error?: Error }} outcome
 * @returns {{ name: string, kind: 'created'|'versioned'|'unchanged'|'restored'|'failed',
 *   tone: 'ok'|'skip'|'bad', text: string, warnings: string[] }}
 */
export function describeUploadResult(name, { answer, error } = {}) {
  if (error) {
    return {
      name,
      kind: 'failed',
      tone: 'bad',
      text: `Not added: ${error.message || 'something went wrong; nothing was saved.'}`,
      warnings: [],
    };
  }
  const outcome = answer?.outcome;
  const line = Object.prototype.hasOwnProperty.call(OUTCOME_LINES, outcome ?? '')
    ? OUTCOME_LINES[outcome]
    : null;
  if (!line) {
    return {
      name,
      kind: 'failed',
      tone: 'bad',
      text: 'Not added: the answer was not one this page understands; nothing was changed.',
      warnings: [],
    };
  }
  const doc = answer.document;
  const where = doc?.category ? ` in ${doc.category}` : '';
  return {
    name,
    kind: outcome,
    tone: line.tone,
    text: line.text(doc, where),
    warnings: Array.isArray(answer.warnings) ? answer.warnings : [],
  };
}

/** The one line under a finished batch: "3 files: 1 added, 1 new version, 1 not added." */
export function summarizeBatch(lines, noun = 'file') {
  const count = (kind) => lines.filter((line) => line.kind === kind).length;
  const added = count('created') + count('restored');
  const versions = count('versioned');
  const unchanged = count('unchanged');
  const failed = count('failed');
  const parts = [
    `${added} added`,
    `${plural(versions, 'new version', 'new versions')}`,
    `${unchanged} already here`,
    `${failed} not added`,
  ];
  return `${plural(lines.length, noun, `${noun}s`)}: ${parts.join(', ')}.`;
}

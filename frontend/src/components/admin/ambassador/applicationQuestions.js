/**
 * The guided application's pure rules (ADR 0033 §4): a program's official
 * questions grouped by section in the form's order, how a structured answer
 * (network + URL rows, a frequency grid, tagged activities) is stored in the
 * one `responses[].text` string the API keeps, the plain text each answer
 * copies as, and the whole packet for pasting into the official form. No
 * React; applicationQuestions.test.js pins it.
 */

export const YES_NO = Object.freeze(['Yes', 'No']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(String(value || '').trim());

/** The questions in their sections, first-seen order kept; an unnamed section is "Questions". */
export function questionSections(questions) {
  const sections = new Map();
  for (const question of questions || []) {
    const name = question.section || 'Questions';
    if (!sections.has(name)) sections.set(name, { section: name, questions: [] });
    sections.get(name).questions.push(question);
  }
  return [...sections.values()];
}

/** The stored responses by question id. */
export const responsesMap = (responses) =>
  new Map((responses || []).map((r) => [r.questionId, r.text || '']));

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const asArray = (text) => {
  const parsed = parseJson(text);
  return Array.isArray(parsed) ? parsed : [];
};

// How each structured kind reads its stored string.
const PARSERS = {
  links: (stored) =>
    asArray(stored)
      .filter(isRecord)
      .map((row) => ({ network: String(row.network || ''), url: String(row.url || '') })),
  scale: (stored) => {
    const parsed = parseJson(stored);
    return isRecord(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([row, value]) => [row, String(value)]))
      : {};
  },
  activities: (stored) => asArray(stored).filter((id) => typeof id === 'string'),
};

/**
 * A stored answer back in the shape its kind edits: links as
 * `[{ network, url }]`, a scale as `{ row: option }`, activities as evidence
 * ids; every other kind is the text itself.
 */
export function parseAnswer(kind, text) {
  const stored = typeof text === 'string' ? text : '';
  return Object.hasOwn(PARSERS, kind) ? PARSERS[kind](stored) : stored;
}

// A JSON string of `list`, or '' for an empty one.
const jsonOrEmpty = (list, toJson = (l) => l) => (list.length ? JSON.stringify(toJson(list)) : '');

// How each structured kind writes its edited value.
const SERIALISERS = {
  links: (value) =>
    jsonOrEmpty(
      (Array.isArray(value) ? value : []).map((row) => ({
        network: String(row.network || ''),
        url: String(row.url || ''),
      }))
    ),
  scale: (value) =>
    jsonOrEmpty(
      Object.entries(isRecord(value) ? value : {}).filter(([, v]) => v),
      Object.fromEntries
    ),
  activities: (value) => jsonOrEmpty((Array.isArray(value) ? value : []).filter(Boolean)),
};

/**
 * The edited value as the one string the API stores; an empty answer is the
 * empty string. A link row still blank is kept, so a row just added stays
 * on screen to be filled in; only a list with no rows at all is empty.
 */
export function serialiseAnswer(kind, value) {
  return Object.hasOwn(SERIALISERS, kind) ? SERIALISERS[kind](value) : String(value ?? '');
}

/** One attached evidence item as the line an activity copies as. */
const activityLine = (item) =>
  `${item.title} — ${item.date || 'undated'}${item.url ? ` · ${item.url}` : ''}`;

// How each structured kind copies as text.
const ANSWER_TEXT = {
  links: (value) =>
    value
      .filter((row) => row.url)
      .map((row) => `${row.network || 'Link'}: ${row.url}`)
      .join('\n'),
  scale: (value, question) =>
    (question.rows || [])
      .filter((row) => value[row])
      .map((row) => `${row}: ${value[row]}`)
      .join('\n'),
  activities: (value, question, evidenceById) =>
    value
      .map((id) => {
        const item = evidenceById?.get(id);
        return item ? activityLine(item) : id;
      })
      .join('\n'),
};

/** An answer as the plain text that goes on the clipboard; `evidenceById` names tagged activities. */
export function answerText(question, text, { evidenceById } = {}) {
  const value = parseAnswer(question.kind, text);
  return Object.hasOwn(ANSWER_TEXT, question.kind)
    ? ANSWER_TEXT[question.kind](value, question, evidenceById)
    : value;
}

/**
 * The whole application as plain text in the form's order — every section,
 * every question, the answer or "(not answered)" — for pasting into the
 * official form one block at a time.
 */
export function packetText(questions, responses, { evidenceById, title } = {}) {
  const by = responsesMap(responses);
  const lines = title ? [title, ''] : [];
  for (const { section, questions: list } of questionSections(questions)) {
    lines.push(`## ${section}`, '');
    for (const question of list) {
      const answer = answerText(question, by.get(question.id) || '', { evidenceById });
      lines.push(question.prompt, answer || '(not answered)', '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

/** Whether a stored answer says anything: for links, at least one row with a URL. */
export function isAnswered(question, text) {
  if (!text) return false;
  if (question.kind === 'links') return parseAnswer('links', text).some((row) => row.url);
  return true;
}

/** How many of the questions have an answer. */
export function answeredCount(questions, responses) {
  const by = responsesMap(responses);
  return (questions || []).filter((q) => isAnswered(q, by.get(q.id))).length;
}

/** `{ [questionId]: message }` for a URL that is not http(s) or a text over its limit. */
export function questionErrors(questions, responses) {
  const by = responsesMap(responses);
  const errors = {};
  for (const question of questions || []) {
    const error = answerError(question, by.get(question.id) || '');
    if (error) errors[question.id] = error;
  }
  return errors;
}

/** What is wrong with one stored answer, or null when nothing is (or it is empty). */
function answerError(question, text) {
  if (!text) return null;
  if (question.kind === 'url') {
    return isHttpUrl(text) ? null : 'Must start with http:// or https://.';
  }
  if (question.kind === 'links') {
    const bad = parseAnswer('links', text).find((row) => row.url && !isHttpUrl(row.url));
    return bad ? `"${bad.url}" must start with http:// or https://.` : null;
  }
  const limited = question.maxChars && ['text', 'profile'].includes(question.kind);
  if (limited && text.length > question.maxChars) {
    return `Over the limit by ${text.length - question.maxChars} characters.`;
  }
  return null;
}

/**
 * The Draft tab's pure parts (ADR 0033 §7 slice 2): the AI actions it
 * offers, the text helpers behind its "use this result" buttons, and the
 * selection a selection-scoped action works on. DraftTab.jsx re-exports the
 * public names so imports of it keep working.
 */

/**
 * The AI actions, in the order the row shows them. `scope: 'selection'`
 * actions work on the selected text when there is one, else on the whole
 * body; the rest always read the whole draft. Labels match the server's
 * ASSIST_ACTIONS (forge-studio.js), which owns the prompts.
 */
export const ASSIST_ACTIONS = Object.freeze(
  [
    ['outline', 'Generate outline', 'all'],
    ['expand', 'Expand section', 'selection'],
    ['condense', 'Condense', 'selection'],
    ['rewrite', 'Rewrite', 'selection'],
    ['tone', 'Change tone', 'selection'],
    ['title', 'Suggest title', 'all'],
    ['summary', 'Summary', 'all'],
    ['metadata', 'Metadata', 'all'],
    ['social', 'Extract social posts', 'all'],
    ['claims', 'Check unsupported claims', 'all'],
  ].map(([id, label, scope]) => ({ id, label, scope }))
);

/** The outline a model proposed, as markdown headings and bullets. */
export function outlineToMarkdown(outline = []) {
  return outline
    .map((section) => {
      const bullets = (section.bullets || []).map((b) => `- ${b}`).join('\n');
      return `## ${section.heading}${bullets ? `\n\n${bullets}` : ''}`;
    })
    .join('\n\n');
}

/** Replace `[start, end)` of `body` with `text`; the whole body when no range. */
export function spliceBody(body, range, text) {
  if (!range || range.start === range.end) return text;
  return `${body.slice(0, range.start)}${text}${body.slice(range.end)}`;
}

/** What the grade line says about a grade against its threshold. */
export function gradeVerdict(overall, threshold) {
  if (typeof threshold !== 'number') return '';
  return overall >= threshold ? ' · clears it' : ' · below it';
}

/** The selected `[start, end)` of a textarea, or null when nothing is selected. */
export function selectionOf(el) {
  if (!el) return null;
  const { selectionStart, selectionEnd } = el;
  return selectionStart !== selectionEnd ? { start: selectionStart, end: selectionEnd } : null;
}

/** The range an action works on: the selection for a selection-scoped action, else none. */
export function selectionFor(actionId, el) {
  const spec = ASSIST_ACTIONS.find((a) => a.id === actionId);
  return spec?.scope === 'selection' ? selectionOf(el) : null;
}

/** The text an action reads: the selected passage, or the whole body. */
export function sourceText(body, range) {
  return range ? body.slice(range.start, range.end) : body;
}

/**
 * How each "use" button lands a result on the session, by the change's
 * `type`. `context` carries the body and keywords as they stand and the
 * range the result was made for.
 */
const APPLIERS = Object.freeze({
  title: (session, value) => session.setText('title', value),
  summary: (session, value) => session.setText('summary', value),
  keywords: (session, value, { keywords }) =>
    session.setBrief('seoKeywords', [keywords, value].filter(Boolean).join(', ')),
  replace: (session, value, { body, range }) =>
    session.setText('body', spliceBody(body, range, value)),
  'replace-all': (session, value) => session.setText('body', value),
  append: (session, value, { body }) =>
    session.setText('body', `${body.trimEnd()}\n\n${value}`.trim()),
});

/** Apply one result to the session; an unknown type changes nothing. */
export function applyAssistResult(session, { type, text }, context) {
  APPLIERS[type]?.(session, text, context);
}

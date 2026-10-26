import { digest, fail, tokens } from './model.js';

const STOP = new Set(
  'a an and are as at be been by can could do does for from have how i in into is it its me my of on or our show that the their these this to using was we what when where which with would you your existing material please outline article idea ideas cite source sources note notes next series research develop summarize summary create write answer question'.split(
    ' ',
  ),
);
export const meaningfulTerms = (value) =>
  tokens(value).filter((word) => !STOP.has(word));
function evidenceKey(item) {
  if (item.type !== 'reference') return item.id;
  const title = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
  if (item.source?.recordingId) return `recording/${item.source.recordingId}`;
  return `reference/${digest(`${title}/${item.body.trim()}/${item.summary || ''}`)}`;
}
function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = evidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export async function retrieveEvidence({
  sources,
  question,
  contextId,
  deadline,
}) {
  const context = contextId ? await sources.contextItems(contextId) : [];
  if (contextId && !context.length)
    fail(404, 'NOT_FOUND', 'The selected context is no longer available.');
  const anchor = context[0];
  const anchorTerms = anchor
    ? meaningfulTerms(`${anchor.tags.join(' ')} ${anchor.title}`).slice(0, 8)
    : [];
  const queryTerms = meaningfulTerms(question);
  // Generic requests without a selected item cannot identify a subject. Do
  // not spend on arbitrary matches to words such as "article" or "source".
  const terms = [...new Set([...anchorTerms, ...queryTerms])].slice(0, 12);
  let cursor = null;
  const candidates = [];
  for (let page = 0; terms.length && page < 3; page++) {
    if (Date.now() >= deadline - 5000)
      fail(504, 'TIMEOUT', 'Retrieval took too long. Try a narrower question.');
    const result = await sources.search({
      q: terms.join(' '),
      cursor,
      limit: 30,
    });
    candidates.push(...result.items);
    cursor = result.cursor;
    if (!cursor) break;
  }
  const relevant = candidates.filter((item) => {
    if (!anchorTerms.length) return true;
    const titleTags = `${item.title} ${item.tags.join(' ')}`.toLowerCase();
    const body = item.body.toLowerCase();
    return (
      anchorTerms.some((term) => titleTags.includes(term)) ||
      anchorTerms.filter((term) => body.includes(term)).length >= 2
    );
  });
  const score = (item) => {
    const titleTags = `${item.title} ${item.tags.join(' ')}`.toLowerCase();
    return terms.reduce(
      (sum, term) =>
        sum +
        (titleTags.includes(term) ? 5 : 0) +
        (item.body.toLowerCase().includes(term) ? 1 : 0),
      0,
    );
  };
  relevant.sort((a, b) => score(b) - score(a));
  const all = unique([...context, ...relevant]);
  const selected = all.slice(0, 8);
  return {
    selected,
    focusId: anchor?.id || null,
    needsContext: !terms.length && !context.length,
    partial:
      Boolean(cursor) ||
      all.length > selected.length ||
      selected.some((item) => item.truncated || item.body.length > 5000),
  };
}

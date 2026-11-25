/**
 * The Q&A editor's pure rules and the status moves the page offers. Split
 * out of interviewModel.js, whose LIMITS they share.
 */
import { LIMITS } from './interviewLimits';

/** An empty question for the editor's Add button. */
export const emptyQaItem = () => ({ q: '', a: '', pullQuote: '' });

/** The Q&A list with item `index` moved by `delta` (−1 up, +1 down). */
export function moveQa(qa, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= qa.length) return qa;
  const next = qa.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The problems with a Q&A list before it is saved, as a list of sentences. */
export function qaProblems(qa) {
  const problems = [];
  if (!Array.isArray(qa) || qa.length === 0) return ['Keep at least one question and answer.'];
  if (qa.length > LIMITS.MAX_QA) problems.push(`Keep at most ${LIMITS.MAX_QA} questions.`);
  qa.forEach((item, i) => {
    const n = i + 1;
    if (!String(item.q || '').trim()) problems.push(`Question ${n} is empty.`);
    if (!String(item.a || '').trim()) problems.push(`Answer ${n} is empty.`);
    if (String(item.q || '').trim().length > LIMITS.MAX_SHORT) {
      problems.push(`Question ${n} is longer than ${LIMITS.MAX_SHORT} characters.`);
    }
    if (String(item.a || '').trim().length > LIMITS.MAX_ANSWER) {
      problems.push(`Answer ${n} is longer than ${LIMITS.MAX_ANSWER} characters.`);
    }
    if (String(item.pullQuote || '').trim().length > LIMITS.MAX_SHORT) {
      problems.push(
        `The pull quote of question ${n} is longer than ${LIMITS.MAX_SHORT} characters.`
      );
    }
  });
  return problems;
}

/** The list as the update route takes it: trimmed, the flag kept only where set. */
export function qaForSave(qa) {
  return qa.map((item) => ({
    q: String(item.q || '').trim(),
    a: String(item.a || '').trim(),
    pullQuote: String(item.pullQuote || '').trim(),
    ...(item.needsReview === true ? { needsReview: true } : {}),
  }));
}

/**
 * The status moves the page offers for a content status, each with the role
 * the server asks for. Publishing needs `approved`, the pipeline's rule
 * (functions/src/lib/cms/content-status.js).
 */
export function statusActions(status, { live = false, hasQa: qaPresent = false } = {}) {
  if (live || status === 'published') {
    return [{ id: 'unpublish', label: 'Unpublish', minRole: 'publisher' }];
  }
  if (!qaPresent) return [];
  const action = STATUS_ACTIONS.find(([statuses]) => statuses.includes(status));
  return action ? [{ ...action[1] }] : [];
}

// The move offered for each content status once there is a Q&A.
const STATUS_ACTIONS = [
  [['approved'], { id: 'publish', label: 'Publish', minRole: 'publisher' }],
  [['in_review'], { id: 'approve', label: 'Approve', minRole: 'editor', to: 'approved' }],
  [
    ['draft', 'inspected', 'ingested', 'needs_rework', 'rejected'],
    { id: 'review', label: 'Send to review', minRole: 'editor', to: 'in_review' },
  ],
];

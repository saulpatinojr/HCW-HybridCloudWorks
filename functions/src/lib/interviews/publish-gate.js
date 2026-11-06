/**
 * publish-gate.js — what the publish pipeline asks of an interview before the
 * ordinary gates run (ADR 0040, D5 and D9).
 *
 * Two refusals, both before the quality gate and both final: a consent record
 * that is missing, unconfirmed or dated in the future (`CONSENT_REQUIRED`),
 * and a question-and-answer list that does not pass the interview schema
 * (`INVALID_INTERVIEW`). Then the text the quality rubric reads: the contract
 * body reader only reads strings, so the Q&A list is flattened into one
 * `bodyText` field for the gate's own copy of the document. Nothing here
 * writes; the publish pipeline decides what to persist.
 */
import { consentRefusal } from './consent.js';
import { checkInterviewQa } from './sibling-modules.js';

export const INVALID_INTERVIEW = 'INVALID_INTERVIEW';

/** True for the content type this gate applies to. */
export const isInterviewTarget = (target) => String(target || '').toLowerCase() === 'interview';

/**
 * The questions and answers as one plain text, a question then its answer,
 * blank lines between, for the word count the rubric takes.
 *
 * @param {object} doc
 * @returns {string}
 */
export function interviewBodyText(doc = {}) {
  const qa = Array.isArray(doc.qa) ? doc.qa : [];
  return qa
    .map((item) => `${String(item?.q || '').trim()}\n\n${String(item?.a || '').trim()}`.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The reason an interview may not be published, or null.
 *
 * @param {object} doc - the stored content document
 * @param {{ now: () => Date }} clock
 * @returns {Promise<{ status: 422, code: string, error: string } | null>}
 */
export async function interviewPublishRefusal(doc, { now }) {
  const consent = consentRefusal(doc, { now });
  if (consent) return { status: 422, ...consent };
  const qa = await checkInterviewQa(doc?.qa);
  if (!qa.ok) {
    return {
      status: 422,
      code: INVALID_INTERVIEW,
      error: `The interview cannot be published: ${qa.error}`,
    };
  }
  return null;
}

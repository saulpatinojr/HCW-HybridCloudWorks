/**
 * studyguide-text.js — the small text rules every study guide parser shares
 * (studyguide.js and studyguide-learn.js): whitespace, slugs, the weight
 * label, the elements skipped, and the parsers' own error. studyguide.js
 * exports slugify, weightLabel and StudyGuideError again.
 */
import { AuthoredError } from '../http/error-response.js';

/** Containers whose list items are navigation or link tables, not objectives. */
export const SKIPPED = 'nav, table, script, style';

export const clean = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

/** `Manage Azure identities` → `manage-azure-identities`. */
export function slugify(text) {
  return clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A study guide this module could not read, in its own sentence (a status,
 * a redirect, a layout with no weighted areas). Authored (#945): the job and
 * the episode store it as written.
 */
export class StudyGuideError extends AuthoredError {}

/** `20–25%`, `15%`, or `''` when the guide states no weighting. */
export function weightLabel(low, high) {
  if (low === null || low === undefined) return '';
  if (high === null || high === undefined || high === low) return `${low}%`;
  return `${low}–${high}%`;
}


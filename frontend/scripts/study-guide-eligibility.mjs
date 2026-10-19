/**
 * Which catalogue exams the study-guide refresher fetches a guide for. On its
 * own, with no import beyond certStatus, so the refresher's test can hold the
 * rule without loading the Listen & Learn parser (functions/ code, with its
 * own dependencies) that update-study-guides.mjs needs for the fetch itself.
 */
import { deriveStatus, todayIso } from '../src/lib/certStatus.js';

/**
 * Certifications with a guide to fetch: retired exams redirect, so skip them.
 *
 * Retired as the page renders it on `today` (`deriveStatus`), not as the file
 * stores it: since #1091 a row read ahead of the vendor's day is stored
 * `retired` with the day still to come, and its guide stays on Learn and its
 * exam stays bookable until that day. The 2026-10-19 run filtered on the
 * stored status and deleted PL-400's outline eleven days early. Should a
 * guide redirect before its day, the fetch fails and the previous outline is
 * kept, as with any other failed fetch; nothing is lost either way.
 *
 * @param {Array<object>} certifications the catalogue rows
 * @param {string} [today] `YYYY-MM-DD`; the real clock by default
 */
export function eligibleCerts(certifications, today = todayIso()) {
  return certifications.filter((c) => c.studyGuideUrl && deriveStatus(c, today) !== 'retired');
}

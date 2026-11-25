/**
 * studyguide-learn.js — reading a Microsoft Learn study guide page into
 * weighted skill areas, for studyguide.js (which fetches the page, holds
 * the parsers for the other providers, and says how the areas are used).
 */
import { load as loadHtml } from 'cheerio';
import { clean, SKIPPED, slugify, StudyGuideError, weightLabel } from './studyguide-text.js';

/**
 * "Manage Azure identities and governance (20–25%)" → name, low, high.
 * Microsoft uses an en dash; a plain hyphen and a single percentage
 * ("Monitor resources (15%)") both appear across providers.
 */
const HEADING_WEIGHT =
  /^(?<name>.+?)\s*\(\s*(?<low>\d{1,3})\s*(?:[-–—]\s*(?<high>\d{1,3})\s*)?%\s*\)\s*$/;

/** h2 sections that end the skills-measured region. */
const TERMINATORS = ['study resources', 'change log', 'related links'];

/** Summary list that repeats every area — parsing it would duplicate them all. */
const GLANCE = 'skills at a glance';

/**
 * Microsoft Learn `resources/study-guides/{exam}` pages have a stable shape
 * across Azure, GitHub and Microsoft 365 exams:
 *
 *   h2  Skills measured as of April 17, 2026
 *   h3  Skills at a glance                        <- summary list, skipped
 *   h3  Manage Azure identities and governance (20–25%)
 *   h4    Manage Microsoft Entra users and groups
 *   li      Create users and groups
 *   h2  Study resources                           <- ends the skills section
 */
export function parseMicrosoftLearn(html, { examCode, sourceUrl }) {
  const $ = loadHtml(html);
  $(SKIPPED).remove();

  const walk = { $, areas: [], current: null, inGlance: false, done: false };
  for (const node of $('h2, h3, h4, li').toArray()) {
    readLearnNode(walk, node);
    if (walk.done) break;
  }
  const { areas } = walk;

  if (areas.length === 0) {
    throw new StudyGuideError(
      `No weighted skill areas found in the study guide for ${examCode}. ` +
        `The page layout may have changed: ${sourceUrl}`
    );
  }

  const title =
    clean($('h1').first().text()) || `Study guide for Exam ${String(examCode).toUpperCase()}`;

  return {
    examCode: String(examCode).toUpperCase(),
    title,
    sourceUrl,
    areas: areas.map((a) => ({ ...a, weightLabel: weightLabel(a.weightLow, a.weightHigh) })),
  };
}

/** One heading or bullet of a Learn study guide, read into the walk's areas. */
function readLearnNode(walk, node) {
  const tag = node.tagName.toLowerCase();
  const text = clean(walk.$(node).text());
  if (!text) return;
  if (tag === 'h2') readLearnH2(walk, text);
  else if (tag === 'h3') readLearnH3(walk, node, text);
  else if (walk.current && !walk.inGlance) readLearnItem(walk.current, tag, text);
}

/** An h2 ends the skills section at "Study resources" and the like; any other ends the summary list. */
function readLearnH2(walk, text) {
  const lowered = text.toLowerCase();
  if (TERMINATORS.some((t) => lowered.startsWith(t))) {
    walk.done = true;
    return;
  }
  walk.inGlance = false;
}

/** An h3 opens a weighted skill area, or the summary list, or ends the previous area. */
function readLearnH3(walk, node, text) {
  walk.inGlance = text.toLowerCase().startsWith(GLANCE);
  const match = HEADING_WEIGHT.exec(text);
  if (match && !walk.inGlance) {
    const { name, low, high } = match.groups;
    walk.current = {
      name: clean(name),
      slug: slugify(name),
      // The heading's own `id`, read off the DOM rather than derived. Learn
      // builds its anchors from the WHOLE heading — "(20–25%)" becomes
      // "2025" — so `slugify(name)` cannot reproduce them, and a guessed
      // fragment would scroll the reader to the top of the page while
      // looking like a deep link. `null` when the page carries none; the
      // caller renders a plain link rather than a broken one (#498).
      anchor: walk.$(node).attr('id') || null,
      weightLow: Number(low),
      weightHigh: high === undefined ? null : Number(high),
      subheadings: [],
      objectives: [],
      sections: [],
    };
    walk.areas.push(walk.current);
  } else if (!match) {
    // A non-weighted h3 (e.g. "Audience profile") ends the previous area
    // so its bullets are not absorbed as objectives.
    walk.current = null;
  }
}

/** An h4 is a subsection of the current area; a bullet is one of its objectives. */
function readLearnItem(current, tag, text) {
  if (tag === 'h4') {
    if (!current.subheadings.includes(text)) {
      current.subheadings.push(text);
      current.sections.push({ title: text, objectives: [] });
    }
    return;
  }
  // Learn repeats some bullets between the objective list and the change
  // log; dedupe so an area is not padded with the same line twice.
  if (!current.objectives.includes(text)) current.objectives.push(text);
  // Also attached to the subsection it sits under, so the script prompt can
  // require coverage section by section rather than as one flat list.
  const section = current.sections.at(-1);
  if (section && !section.objectives.includes(text)) section.objectives.push(text);
}


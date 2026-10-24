/**
 * Interviews: the file format, its checks, and how one interview becomes the
 * pages of the book view.
 *
 * An interview is one JSON file in `src/data/interviews/`, named
 * `<slug>.json`. The slug is the file name and is the page's address:
 * `/azure/interviews/<slug>`. A file whose name starts with an underscore is a
 * draft: nothing reads it, so it can sit in the folder while it is written.
 * The format is written out, with an example, in
 * docs/runbooks/add-an-interview.md.
 *
 * WHY THE CHECKS ARE STRICT. These files are written by hand by someone who
 * may not read code, and they become public pages. A wrong date, a link that
 * is not a link or a picture with no description should fail the build with a
 * sentence naming the file and the field, not ship. `normalizeInterview` is
 * what the data module and its test both call, so the build and the test
 * cannot disagree about what a valid file is.
 *
 * LINKS. Only an address on this site (starts with a single `/`) or an
 * `https://` address is accepted. `javascript:`, `data:` and `//host` links
 * are refused, because the text of these files is shown to visitors as links.
 */

import { routes } from '@/lib/routeFactory';

/** `/azure/interviews`, from the route factory so there is one place a provider path is spelled. */
export const INTERVIEWS_PATH = routes.interviews('azure');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_TITLE = 160;
const MAX_SHORT = 240;
const MAX_ANSWER = 6000;
const MAX_QA = 40;
const MAX_LINKS = 12;

/** The address of the interview list. */
export const interviewsPath = () => INTERVIEWS_PATH;

/** The address of one interview. */
export const interviewPath = (slug) => `${INTERVIEWS_PATH}/${encodeURIComponent(slug)}`;

/** A file that is not a valid interview. The message names the file and the field. */
export class InterviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InterviewError';
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, where, { max = MAX_SHORT, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InterviewError(`${where} is missing.`);
    return '';
  }
  if (typeof value !== 'string') throw new InterviewError(`${where} must be text.`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new InterviewError(`${where} is empty.`);
  if (trimmed.length > max) {
    throw new InterviewError(`${where} is ${trimmed.length} characters; the most is ${max}.`);
  }
  return trimmed;
}

/**
 * The address if it is on this site or `https://`, otherwise null. An address
 * on this site starts with one `/`: `//host` is another site, and a backslash
 * is read as a slash by some browsers.
 */
export function safeLink(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value || /[\u0000-\u001f\u007f\\\s]/.test(value)) return null;
  if (value.startsWith('/')) return value.startsWith('//') ? null : value;
  // A host must follow "https://" as written: the URL parser quietly turns
  // "https:///host" into "https://host", and an address that does not look the
  // way it works has no place in a file a person typed.
  if (!/^https:\/\/[^/]/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname ? value : null;
  } catch {
    return null;
  }
}

/** True when the address leaves this site. */
export const isExternalLink = (url) => /^https:\/\//i.test(url);

function link(value, where) {
  if (!isObject(value)) throw new InterviewError(`${where} must have a title and a url.`);
  const title = text(value.title, `${where} title`);
  const url = safeLink(value.url);
  if (!url) {
    throw new InterviewError(
      `${where} url must be an address on this site (starting with one "/") or an https:// address.`
    );
  }
  return { title, url };
}

function links(value, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InterviewError(`${where} must be a list.`);
  if (value.length > MAX_LINKS)
    throw new InterviewError(`${where} has more than ${MAX_LINKS} links.`);
  return value.map((item, index) => link(item, `${where}[${index + 1}]`));
}

function isoDate(value, where) {
  const raw = text(value, where, { max: 10 });
  const match = ISO_DATE.exec(raw);
  if (!match) throw new InterviewError(`${where} must be a date written YYYY-MM-DD.`);
  const [, year, month, day] = match.map(Number);
  const real = new Date(Date.UTC(year, month - 1, day));
  if (
    real.getUTCFullYear() !== year ||
    real.getUTCMonth() !== month - 1 ||
    real.getUTCDate() !== day
  ) {
    throw new InterviewError(`${where} is not a real date.`);
  }
  return raw;
}

/**
 * Check one interview file and return it in the one shape the pages read.
 * Throws an `InterviewError` naming the file (`<slug>.json`) and the field.
 *
 * @param {unknown} raw - the parsed JSON
 * @param {string} slug - the file name without `.json`
 */
export function normalizeInterview(raw, slug) {
  const file = `${slug}.json`;
  const at = (field) => `${file}: ${field}`;
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new InterviewError(
      `${file}: the file name must be lower-case words joined by hyphens (for example azure-landing-zones-2026).`
    );
  }
  if (!isObject(raw)) throw new InterviewError(`${file}: must hold one JSON object.`);

  const guestRaw = raw.guest;
  if (!isObject(guestRaw))
    throw new InterviewError(at('guest must have a name and, if you like, a role.'));

  const tags = raw.tags === undefined ? [] : raw.tags;
  if (!Array.isArray(tags)) throw new InterviewError(at('tags must be a list.'));
  tags.forEach((tag, index) => {
    if (typeof tag !== 'string' || !TAG.test(tag)) {
      throw new InterviewError(
        at(
          `tags[${index + 1}] must be lower-case words joined by hyphens (for example landing-zones).`
        )
      );
    }
  });

  if (!Array.isArray(raw.qa) || raw.qa.length === 0) {
    throw new InterviewError(at('qa must be a list with at least one question and answer.'));
  }
  if (raw.qa.length > MAX_QA) throw new InterviewError(at(`qa has more than ${MAX_QA} questions.`));
  const qa = raw.qa.map((item, index) => {
    const where = at(`qa[${index + 1}]`);
    if (!isObject(item)) throw new InterviewError(`${where} must have a q and an a.`);
    return {
      q: text(item.q, `${where} q`, { max: MAX_SHORT }),
      a: text(item.a, `${where} a`, { max: MAX_ANSWER }),
      pullQuote: text(item.pullQuote, `${where} pullQuote`, { max: MAX_SHORT, required: false }),
    };
  });

  let image = null;
  if (raw.image !== undefined && raw.image !== null) {
    if (!isObject(raw.image)) throw new InterviewError(at('image must have a src and an alt.'));
    const src = safeLink(raw.image.src);
    if (!src) {
      throw new InterviewError(
        at(
          'image src must be an address on this site (starting with one "/") or an https:// address.'
        )
      );
    }
    image = {
      src,
      alt: text(raw.image.alt, at('image alt (what the picture shows)'), { max: MAX_SHORT }),
    };
  }

  const related = isObject(raw.related) ? raw.related : {};
  return {
    slug,
    title: text(raw.title, at('title'), { max: MAX_TITLE }),
    subtitle: text(raw.subtitle, at('subtitle'), { max: MAX_SHORT, required: false }),
    date: isoDate(raw.date, at('date')),
    guest: {
      name: text(guestRaw.name, at('guest name'), { max: MAX_SHORT }),
      role: text(guestRaw.role, at('guest role'), { max: MAX_SHORT, required: false }),
    },
    bio: text(raw.bio, at('bio'), { max: MAX_ANSWER, required: false }),
    image,
    tags,
    qa,
    related: {
      labs: links(related.labs, at('related.labs')),
      learn: links(related.learn, at('related.learn')),
    },
  };
}

/** Newest first; the same day keeps a steady order by slug. */
export function sortInterviews(list) {
  return [...list].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

/** The first words of the first answer, for a page description or a card. */
export function interviewSummary(interview, max = 155) {
  const source = interview.bio || interview.qa[0]?.a || interview.title;
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** "24 October 2026", from the YYYY-MM-DD in the file, with no time zone involved. */
export function formatInterviewDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The pages of the book view, as data. The cover is first and the back cover
 * last, and the count is even, because a book's pages come in leaves of two:
 * a blank page is added before the back cover when the count would be odd.
 *
 * @returns {Array<{ kind: 'cover'|'bio'|'qa'|'related'|'blank'|'end', [key: string]: unknown }>}
 */
export function buildBookPages(interview) {
  const pages = [{ kind: 'cover', interview }];
  if (interview.bio || interview.tags.length > 0 || interview.guest.role) {
    pages.push({ kind: 'bio', interview });
  }
  interview.qa.forEach((item, index) => {
    pages.push({ kind: 'qa', number: index + 1, total: interview.qa.length, ...item });
  });
  const { labs, learn } = interview.related;
  if (labs.length > 0 || learn.length > 0) pages.push({ kind: 'related', labs, learn });
  // Cover and back cover included: an odd count so far means one blank page.
  if ((pages.length + 1) % 2 !== 0) pages.push({ kind: 'blank' });
  pages.push({ kind: 'end', interview });
  return pages;
}

/** How many leaves (a sheet with a page on each side) the book has. */
export const leafCount = (pages) => Math.ceil(pages.length / 2);

/**
 * The last spread: spread 0 is the closed book showing the cover on the
 * right; spread `leafCount` is the closed book showing the back cover on the
 * left; the spreads between show two pages.
 */
export const lastSpread = (pages) => leafCount(pages);

/** Zero-based indexes of the pages on show at a spread, in left-to-right order. */
export function visiblePageIndexes(spread, pages) {
  const last = lastSpread(pages);
  const clamped = Math.min(Math.max(spread, 0), last);
  return [2 * clamped - 1, 2 * clamped].filter((index) => index >= 0 && index < pages.length);
}

/** What a screen reader is told after each turn. The cover and back cover are not numbered. */
export function spreadStatus(spread, pages) {
  const last = lastSpread(pages);
  if (spread <= 0) return 'Cover.';
  if (spread >= last) return 'Back cover.';
  const left = 2 * spread - 1;
  const right = 2 * spread;
  const inner = pages.length - 2;
  return `Pages ${left} and ${right} of ${inner}.`;
}

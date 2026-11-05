/**
 * schema.js — the interview shape and its limits, on the server (ADR 0040
 * D4, #1565).
 *
 * The limits are the ones `frontend/src/lib/interviews.js` enforces when a
 * page renders an interview (`normalizeInterview`): title 160, subtitle and
 * every other short field 240, bio and an answer 6000, 1 to 40 questions,
 * 12 links a list, lower-case hyphenated slugs and tags, and a link that is
 * on this site or `https://`. They are written twice, there and here,
 * because the page must refuse a bad document on its own and the server
 * must refuse one before it is stored; `schema.test.js` reads the frontend
 * file and fails when the two drift, the pattern
 * `public-reads.allowlist.test.js` uses.
 *
 * Two entry points: `validateQa` for the list the drafting job produces and
 * the editor saves, and `validateInterviewFields` for a partial update of
 * the document's own fields (the CMS slice hooks it into
 * content-update-validation.js for `type === 'interview'`). Both answer
 * `{ ok: true, value }` or `{ ok: false, error }` with a sentence that names
 * the field, so a route can answer it and a job can store it.
 */

import { AuthoredError, authoredMessage } from '../http/error-response.js';

export const LIMITS = Object.freeze({
  MAX_TITLE: 160,
  MAX_SHORT: 240,
  MAX_ANSWER: 6000,
  MAX_QA: 40,
  MAX_LINKS: 12,
  MAX_TAGS: 20,
});

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The same rule as the frontend's `safeLink`: on this site (one leading `/`) or `https://`. */
export function safeLink(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value || /[\u0000-\u001f\u007f\\\s]/.test(value)) return null;
  if (value.startsWith('/')) return value.startsWith('//') ? null : value;
  if (!/^https:\/\/[^/]/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname ? value : null;
  } catch {
    return null;
  }
}

/** A sentence this validator wrote for the field it names: an authored error, so a route may show it. */
class FieldError extends AuthoredError {}

function text(value, where, { max = LIMITS.MAX_SHORT, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new FieldError(`${where} is missing.`);
    return '';
  }
  if (typeof value !== 'string') throw new FieldError(`${where} must be text.`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new FieldError(`${where} is empty.`);
  if (trimmed.length > max) {
    throw new FieldError(`${where} is ${trimmed.length} characters; the most is ${max}.`);
  }
  return trimmed;
}

function isoDate(value, where) {
  const raw = text(value, where, { max: 10 });
  const match = ISO_DATE.exec(raw);
  if (!match) throw new FieldError(`${where} must be a date written YYYY-MM-DD.`);
  const [, year, month, day] = match.map(Number);
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) {
    throw new FieldError(`${where} is not a real date.`);
  }
  return raw;
}

function link(value, where) {
  if (!isObject(value)) throw new FieldError(`${where} must have a title and a url.`);
  const title = text(value.title, `${where} title`);
  const url = safeLink(value.url);
  if (!url) {
    throw new FieldError(
      `${where} url must be an address on this site (starting with one "/") or an https:// address.`
    );
  }
  return { title, url };
}

function links(value, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new FieldError(`${where} must be a list.`);
  if (value.length > LIMITS.MAX_LINKS) throw new FieldError(`${where} has more than ${LIMITS.MAX_LINKS} links.`);
  return value.map((item, index) => link(item, `${where}[${index + 1}]`));
}

function tags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new FieldError('tags must be a list.');
  if (value.length > LIMITS.MAX_TAGS) throw new FieldError(`tags has more than ${LIMITS.MAX_TAGS} entries.`);
  return value.map((tag, index) => {
    if (typeof tag !== 'string' || !TAG.test(tag)) {
      throw new FieldError(`tags[${index + 1}] must be lower-case words joined by hyphens (for example landing-zones).`);
    }
    return tag;
  });
}

function qaItem(item, where) {
  if (!isObject(item)) throw new FieldError(`${where} must have a q and an a.`);
  const out = {
    q: text(item.q, `${where} q`, { max: LIMITS.MAX_SHORT }),
    a: text(item.a, `${where} a`, { max: LIMITS.MAX_ANSWER }),
    pullQuote: text(item.pullQuote, `${where} pullQuote`, { max: LIMITS.MAX_SHORT, required: false }),
  };
  // The honesty guard's flag, kept only when set, so the editor sees it.
  if (item.needsReview === true) out.needsReview = true;
  return out;
}

/** The result shape every validator answers. */
const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error: authoredMessage(error, 'A field was refused.') });

/**
 * The Q&A list, trimmed and bounded: 1 to 40 items, each with a question,
 * an answer and an optional pull quote within the limits.
 *
 * @param {unknown} list
 * @returns {{ ok: true, value: Array<{q:string,a:string,pullQuote:string,needsReview?:true}> } | { ok: false, error: string }}
 */
export function validateQa(list) {
  try {
    if (!Array.isArray(list) || list.length === 0) {
      throw new FieldError('qa must be a list with at least one question and answer.');
    }
    if (list.length > LIMITS.MAX_QA) throw new FieldError(`qa has more than ${LIMITS.MAX_QA} questions.`);
    return ok(list.map((item, index) => qaItem(item, `qa[${index + 1}]`)));
  } catch (error) {
    if (error instanceof FieldError) return fail(error);
    throw error;
  }
}

/** The fields of an interview document a route may set, each with its check. */
const FIELD_CHECKS = Object.freeze({
  slug: (value) => {
    const slug = text(value, 'slug', { max: LIMITS.MAX_TITLE });
    if (!SLUG.test(slug)) throw new FieldError('slug must be lower-case words joined by hyphens.');
    return slug;
  },
  title: (value) => text(value, 'title', { max: LIMITS.MAX_TITLE }),
  subtitle: (value) => text(value, 'subtitle', { max: LIMITS.MAX_SHORT, required: false }),
  date: (value) => isoDate(value, 'date'),
  guest: (value) => {
    if (!isObject(value)) throw new FieldError('guest must have a name and, if you like, a role.');
    return {
      name: text(value.name, 'guest name', { max: LIMITS.MAX_SHORT }),
      role: text(value.role, 'guest role', { max: LIMITS.MAX_SHORT, required: false }),
    };
  },
  bio: (value) => text(value, 'bio', { max: LIMITS.MAX_ANSWER, required: false }),
  image: (value) => {
    if (value === null || value === undefined) return null;
    if (!isObject(value)) throw new FieldError('image must have a src and an alt.');
    const src = safeLink(value.src);
    if (!src) {
      throw new FieldError('image src must be an address on this site (starting with one "/") or an https:// address.');
    }
    return { src, alt: text(value.alt, 'image alt (what the picture shows)', { max: LIMITS.MAX_SHORT }) };
  },
  tags,
  qa: (value) => {
    const result = validateQa(value);
    if (!result.ok) throw new FieldError(result.error);
    return result.value;
  },
  related: (value) => {
    if (value === null || value === undefined) return { labs: [], learn: [] };
    if (!isObject(value)) throw new FieldError('related must have labs and learn lists.');
    return { labs: links(value.labs, 'related.labs'), learn: links(value.learn, 'related.learn') };
  },
});

export const INTERVIEW_FIELDS = Object.freeze(Object.keys(FIELD_CHECKS));

/**
 * A partial update of an interview's own fields. Every key present is
 * checked; a key this schema does not name is refused, so the public
 * fields can never be set to something the page would refuse, and the
 * private blocks (`consent`, `provenance`, `interview`, `transcription`)
 * are never written through a field update.
 *
 * @param {unknown} partial
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateInterviewFields(partial) {
  try {
    if (!isObject(partial)) throw new FieldError('The update must be an object of fields.');
    const value = {};
    for (const key of Object.keys(partial)) {
      if (!Object.hasOwn(FIELD_CHECKS, key)) throw new FieldError(`${key} is not a field an interview has.`);
      value[key] = FIELD_CHECKS[key](partial[key]);
    }
    return ok(value);
  } catch (error) {
    if (error instanceof FieldError) return fail(error);
    throw error;
  }
}

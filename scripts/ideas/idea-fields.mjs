/** Reading each front-matter field of an idea note into its value, or the reason it cannot be read (idea-notes.mjs). */
import { LIMITS, WORDS } from './idea-rules.mjs';
import { unquote } from './idea-front-matter.mjs';

/** A field from its key and the text after the colon: empty, a `[a, b]` list, or one value. */
export function fieldFrom(key, rest, line) {
  const field = { key, line, kind: 'empty', value: '', items: [] };
  if (rest.startsWith('[') && rest.endsWith(']')) {
    field.kind = 'list';
    field.items = rest
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter(Boolean);
  } else if (rest) {
    field.kind = 'scalar';
    field.value = unquote(rest);
    const junk = textAfterQuote(rest);
    if (junk) field.junk = junk;
  }
  return field;
}

/** What follows a quoted value's closing quote, other than a comment; '' for none. */
function textAfterQuote(rest) {
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") return '';
  const close = rest.indexOf(quote, 1);
  const after = close > 0 ? rest.slice(close + 1).trim() : '';
  return after.startsWith('#') ? '' : after;
}

/**
 * One value from the properties, or null. A missing value is an issue when it
 * is `required`; a list, or a quoted value with text after its closing quote,
 * is always one.
 */
function scalarOf({ fields, add }, key, { required = false } = {}) {
  const field = fields.get(key);
  if (!field || field.kind === 'empty') {
    if (required) add(`${key} is missing`, key, field?.line ?? null);
    return null;
  }
  if (field.kind === 'list') {
    add(`${key} must be one value, not a list`, key, field.line);
    return null;
  }
  if (field.junk) {
    add(
      `${key} starts with a quote mark and carries on after it ("${field.junk}"), which would be cut off; wrap the whole value in the other kind of quote mark`,
      key,
      field.line
    );
    return null;
  }
  return field.value;
}

/** A required value that must be one of `allowed`, or null with an issue. */
export function oneOfValue(ctx, key, allowed) {
  const value = scalarOf(ctx, key, { required: true });
  if (value === null) return null;
  if (!allowed.includes(value)) {
    ctx.add(`${key}: "${value}" is not one of ${allowed.join(', ')}`, key, ctx.fields.get(key).line);
    return null;
  }
  return value;
}

export function themeOf(ctx) {
  const theme = scalarOf(ctx, 'theme', { required: true });
  if (theme !== null && (!WORDS.test(theme) || theme.length > LIMITS.theme)) {
    ctx.add(
      `theme: "${theme}" must be lower-case words joined by hyphens, at most ${LIMITS.theme} characters`,
      'theme',
      ctx.fields.get('theme').line
    );
  }
  return theme;
}

/** The title property, or the file name without `.md` when there is none. */
export function titleOf(ctx, name) {
  const stem = String(name ?? '').replace(/\.md$/i, '').trim();
  const title = (scalarOf(ctx, 'title') ?? '').trim() || stem;
  if (!title) ctx.add('the note has no title and no usable file name', 'title');
  if (title.length > LIMITS.title) {
    ctx.add(`title is ${title.length} characters; at most ${LIMITS.title}`, 'title', ctx.fields.get('title')?.line);
  }
  return title;
}

export function subtitleOf(ctx) {
  const subtitle = (scalarOf(ctx, 'subtitle') ?? '').trim();
  if (subtitle.length > LIMITS.subtitle) {
    ctx.add(
      `subtitle is ${subtitle.length} characters; at most ${LIMITS.subtitle}`,
      'subtitle',
      ctx.fields.get('subtitle')?.line
    );
  }
  return subtitle;
}

/** The tags, without `#` and repeats; each must be hyphenated words, and there is a limit to how many. */
export function tagsOf(ctx) {
  const tagField = ctx.fields.get('tags');
  const tags = [];
  if (!tagField || tagField.kind === 'empty') return tags;
  const raw = tagField.kind === 'list' ? tagField.items : [tagField.value];
  for (const entry of raw) {
    const tag = String(entry).replace(/^#/, '');
    if (!WORDS.test(tag) || tag.length > LIMITS.tag) {
      ctx.add(
        `tag "${entry}" must be lower-case words joined by hyphens, at most ${LIMITS.tag} characters`,
        'tags',
        tagField.line
      );
    } else if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  if (tags.length > LIMITS.tags) {
    ctx.add(`${tags.length} tags; at most ${LIMITS.tags}`, 'tags', tagField.line);
  }
  return tags;
}

/** Reading time in minutes, or null when it is not given or not a whole number from 1 to 999. */
export function readingOf(ctx) {
  const readingRaw = scalarOf(ctx, 'reading');
  if (readingRaw === null) return null;
  if (/^\d{1,3}$/.test(readingRaw) && Number(readingRaw) > 0) return Number(readingRaw);
  ctx.add(`reading: "${readingRaw}" must be a whole number of minutes, 1 to 999`, 'reading', ctx.fields.get('reading').line);
  return null;
}

/** An optional value that must match `valid` when it is given; `message(value)` is the issue when it does not. */
export function optionalOf(ctx, key, valid, message) {
  const value = scalarOf(ctx, key);
  if (value !== null && !valid(value)) ctx.add(message(value), key, ctx.fields.get(key).line);
  return value;
}

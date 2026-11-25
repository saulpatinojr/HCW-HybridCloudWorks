/**
 * idea-notes.mjs — the format of an idea note, the check that holds a folder of
 * them to it, and the one-way step that turns an outlined idea into a blog draft.
 *
 * WHAT THIS IS FOR. The owner keeps a second brain in Obsidian, outside this
 * repository: ideas for content, grouped by theme, each with a type, a format
 * and a status. The repository is public, so the notes never come here. What
 * does come here is this code, which reads a note that someone hands it and
 * never writes to the vault's notes. The one thing it produces is a draft
 * article, `blog-<name>.md`, which promote-idea.mjs saves in the vault's own
 * Drafts folder (never in this repository) to be uploaded on Admin > Drafts. It
 * is in the shape the server's markdown reader takes
 * (functions/src/lib/cms/repo-draft.js, parseRepoDraft), so a promoted idea is
 * a copy of the same words rather than a translation.
 *
 * THE FORMAT, in an Obsidian note's Properties (YAML between two `---` lines):
 *
 *   type     what it becomes: blog, framework, architecture or coder_corner
 *            (the content types the publisher supports; news comes from feeds)
 *   theme    the group it belongs to: lower-case words joined by hyphens
 *   format   how it is told: how-to, build-log, article, video, podcast, newsletter
 *   status   where it is: idea, outlined, drafted, published or parked
 *
 * and, all optional: title (the file name when absent), subtitle, tags,
 * reading (minutes), part ("1 of 2") and date (YYYY-MM-DD).
 *
 * WHY THE PROPERTIES ARE READ BY HAND. Obsidian writes lists in the block form
 * (`tags:` then `  - azure`), and the import's own reader takes only the inline
 * form (`tags: [azure]`). The reader here takes both, and nothing else it does
 * not need: no YAML library, so the scripts package gains no dependency. Keys
 * it does not know (`aliases`, `cssclasses`, whatever a plugin adds) are left
 * alone.
 *
 * WHAT PROMOTING REFUSES, and why. A note body becomes an article that will be
 * published. The check cannot know what is private, but it can refuse what
 * can only be private notes or only work in Obsidian: [[wikilinks]] and
 * ![[embeds]] to other notes, %% comments %%, and Dataview or Tasks query
 * blocks. Anything else in the body is carried over as written, so the draft
 * has to be read before it is uploaded; the runbook says so.
 *
 * Dependency-free on purpose (node: only): a functions test imports this file
 * to prove that what it writes passes the real import.
 */

export const IDEA_TYPES = Object.freeze([
  'blog',
  'framework',
  'architecture',
  'coder_corner',
  'interview',
]);
export const IDEA_FORMATS = Object.freeze([
  'how-to',
  'build-log',
  'article',
  'video',
  'podcast',
  'newsletter',
]);
export const IDEA_STATUSES = Object.freeze(['idea', 'outlined', 'drafted', 'published', 'parked']);

/** The formats a blog draft can be: the template's two tracks (docs/content/blog-template.md). */
export const FORMAT_TO_TRACK = Object.freeze({ 'how-to': 'how-to', 'build-log': 'build-log' });

/** The limits the import enforces (repo-draft.js), plus the ones this format adds. */
export const LIMITS = Object.freeze({
  title: 300,
  subtitle: 500,
  tags: 12,
  tag: 40,
  theme: 40,
  part: 20,
});

/** The statuses from which an idea must have something written under its properties. */
const NEEDS_BODY = Object.freeze(['outlined', 'drafted', 'published']);

const KNOWN_KEYS = Object.freeze([
  'type',
  'theme',
  'format',
  'status',
  'title',
  'subtitle',
  'tags',
  'reading',
  'part',
  'date',
]);

/** Lower-case words joined by hyphens: the shape of a theme, a tag and a draft's file name. */
const WORDS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The file name a draft gets is held to the shape the markdown reader's path rule takes
 * (repo-draft.js REPO_DRAFT_PATH_PATTERN, MAX_REPO_PATH_LENGTH), so the same file
 * name also works if the old import-from-repo route is ever used.
 */
const DRAFT_PATH = /^docs\/content\/blog-[a-z0-9-]+\.md$/;
const MAX_DRAFT_PATH = 120;
const MAX_NAME_CHARS = 80;

const BLOCKED_FENCES = Object.freeze(['dataview', 'dataviewjs', 'tasks', 'query']);

function unquote(raw) {
  const text = String(raw ?? '').trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length > 1) {
    const close = text.indexOf(quote, 1);
    if (close > 0) return text.slice(1, close);
  }
  return text.split(' #')[0].trim();
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The properties block of a note and the text after it.
 *
 * `fields` is null when the note does not open with a closed block. Each field
 * is `{ key, line, kind: 'scalar'|'list'|'empty', value, items }`, with `line`
 * counted from 1 in the file. `problems` are lines the reader could not
 * understand inside a key it needs.
 *
 * @param {string} text
 */
export function parseNote(text) {
  const source = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  if (lines[0].trimEnd() !== '---') {
    return { fields: null, unclosed: false, problems: [], body: source, bodyLine: 1 };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (end === -1) {
    return { fields: null, unclosed: true, problems: [], body: source, bodyLine: 1 };
  }

  const fields = new Map();
  const problems = [];
  let current = null;
  for (let index = 1; index < end; index += 1) {
    current = readPropertyLine(lines[index].trimEnd(), index + 1, { current, fields, problems });
  }

  return {
    fields,
    unclosed: false,
    problems,
    body: lines.slice(end + 1).join('\n'),
    bodyLine: end + 2,
  };
}

/**
 * One line of the properties block, onto `fields` or `problems`. Returns the
 * field that list items and continued lines below it belong to.
 */
function readPropertyLine(raw, line, { current, fields, problems }) {
  if (!raw.trim() || raw.trimStart().startsWith('#')) return current;

  const item = /^\s*-\s+(.*)$/.exec(raw) ?? /^\s*-$/.exec(raw);
  if (item && current) {
    current.kind = 'list';
    const value = unquote(item[1] ?? '');
    if (value) current.items.push(value);
    return current;
  }

  // Obsidian allows any text as a property name ("date created", "année"), so
  // take everything up to the first colon that is followed by a space or the
  // end of the line. Keys the format does not name are ignored, whatever they say.
  const entry = /^([^\s:#'"[-][^:]*?):(?:[ \t]+(.*))?$/.exec(raw);
  if (!entry) return unreadablePropertyLine(raw, line, current, problems);

  const field = fieldFrom(entry[1].trim(), (entry[2] ?? '').trim(), line);
  if (fields.has(field.key)) {
    problems.push({ line, field: field.key, message: `${field.key} is written twice` });
  } else {
    fields.set(field.key, field);
  }
  return field;
}

/**
 * A line that is not `name: value`: an indented line goes on from the field
 * above it (a problem only for a key the format reads); anything else is a
 * problem, and ends that field.
 */
function unreadablePropertyLine(raw, line, current, problems) {
  if (/^\s/.test(raw) && current) {
    if (KNOWN_KEYS.includes(current.key)) {
      problems.push({
        line,
        field: current.key,
        message: `${current.key} must fit on one line`,
      });
    }
    return current;
  }
  problems.push({
    line,
    field: null,
    message: `cannot read this line of the properties; write it as name: value`,
  });
  return null;
}

/** A field from its key and the text after the colon: empty, a `[a, b]` list, or one value. */
function fieldFrom(key, rest, line) {
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
function oneOfValue(ctx, key, allowed) {
  const value = scalarOf(ctx, key, { required: true });
  if (value === null) return null;
  if (!allowed.includes(value)) {
    ctx.add(`${key}: "${value}" is not one of ${allowed.join(', ')}`, key, ctx.fields.get(key).line);
    return null;
  }
  return value;
}

function themeOf(ctx) {
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
function titleOf(ctx, name) {
  const stem = String(name ?? '').replace(/\.md$/i, '').trim();
  const title = (scalarOf(ctx, 'title') ?? '').trim() || stem;
  if (!title) ctx.add('the note has no title and no usable file name', 'title');
  if (title.length > LIMITS.title) {
    ctx.add(`title is ${title.length} characters; at most ${LIMITS.title}`, 'title', ctx.fields.get('title')?.line);
  }
  return title;
}

function subtitleOf(ctx) {
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
function tagsOf(ctx) {
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
function readingOf(ctx) {
  const readingRaw = scalarOf(ctx, 'reading');
  if (readingRaw === null) return null;
  if (/^\d{1,3}$/.test(readingRaw) && Number(readingRaw) > 0) return Number(readingRaw);
  ctx.add(`reading: "${readingRaw}" must be a whole number of minutes, 1 to 999`, 'reading', ctx.fields.get('reading').line);
  return null;
}

/** An optional value that must match `valid` when it is given; `message(value)` is the issue when it does not. */
function optionalOf(ctx, key, valid, message) {
  const value = scalarOf(ctx, key);
  if (value !== null && !valid(value)) ctx.add(message(value), key, ctx.fields.get(key).line);
  return value;
}

/**
 * Hold one note to the format.
 *
 * @param {string} name the file name, e.g. `landing zones for small teams.md`
 * @param {string} text the file's content
 * @returns {{ issues: Array<{ line: number | null, field: string | null, message: string }>, note: object | null }}
 *   `note` is the normalised idea when there are no issues, and null otherwise.
 */
export function checkNote(name, text) {
  const parsed = parseNote(text);
  const issues = [];
  const add = (message, field = null, line = null) => issues.push({ line, field, message });

  if (!parsed.fields) {
    add(
      parsed.unclosed
        ? 'the properties block opens with --- but never closes with ---'
        : 'the note has no properties: it must start with a --- line, then type, theme, format and status, then a closing --- line',
      null,
      1
    );
    return { issues, note: null };
  }
  for (const problem of parsed.problems) add(problem.message, problem.field, problem.line);

  for (const field of parsed.fields.values()) {
    const lower = field.key.toLowerCase();
    if (field.key !== lower && KNOWN_KEYS.includes(lower)) {
      add(`write "${field.key}" in lower case, as "${lower}"`, field.key, field.line);
    }
  }

  const ctx = { fields: parsed.fields, add };
  const type = oneOfValue(ctx, 'type', IDEA_TYPES);
  const format = oneOfValue(ctx, 'format', IDEA_FORMATS);
  const status = oneOfValue(ctx, 'status', IDEA_STATUSES);
  const theme = themeOf(ctx);
  const title = titleOf(ctx, name);
  const subtitle = subtitleOf(ctx);
  const tags = tagsOf(ctx);
  const reading = readingOf(ctx);
  const part = optionalOf(ctx, 'part', (value) => /^\d{1,2} of \d{1,2}$/.test(value), (value) => `part: "${value}" must be written like "1 of 2"`);
  const date = optionalOf(ctx, 'date', isCalendarDate, (value) => `date: "${value}" must be a real date written YYYY-MM-DD`);

  const body = parsed.body.replace(/^\n+/, '').trimEnd();
  if (status !== null && NEEDS_BODY.includes(status) && !body.trim()) {
    add(
      `status is "${status}" but nothing is written under the properties; add the outline, or set the status back to idea`,
      'status',
      parsed.fields.get('status').line
    );
  }

  if (issues.length > 0) return { issues, note: null };
  return {
    issues,
    note: {
      title,
      subtitle,
      type,
      theme,
      format,
      status,
      tags,
      reading,
      part: part || null,
      date: date || null,
      body,
      bodyLine: parsed.bodyLine,
    },
  };
}

/**
 * What in a note body can only be private notes or only work in Obsidian.
 * Fenced code is skipped (a shell example may hold `[[ -f x ]]`), and so is
 * inline code.
 *
 * @returns {Array<{ line: number, what: string }>}
 */
export function findObsidianOnly(body, bodyLine = 1) {
  const found = [];
  let fence = null;
  const lines = String(body ?? '').split('\n');
  lines.forEach((text, offset) => {
    const line = bodyLine + offset;
    const opening = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(text);
    if (opening) {
      if (fence === null) {
        fence = opening[1][0];
        if (BLOCKED_FENCES.includes(opening[2].toLowerCase())) {
          found.push({
            line,
            what: `a ${opening[2]} block, which only Obsidian can run`,
          });
        }
      } else if (opening[1][0] === fence && !opening[2]) {
        fence = null;
      }
      return;
    }
    if (fence !== null) return;
    const prose = text.replace(/`[^`]*`/g, '');
    if (prose.includes('[[')) {
      found.push({
        line,
        what: 'a [[wikilink]] or ![[embed]] to another note, which would show as plain brackets on the site',
      });
    }
    if (prose.includes('%%')) {
      found.push({ line, what: 'an Obsidian %% comment %%, which is a private note to yourself' });
    }
  });
  return found;
}

/** What makes a value unsafe to write unquoted: a leading YAML indicator, a closing quote, `: `, ` #` or a final colon. */
const NEEDS_QUOTES = [
  (text) => /^[\-?:,[\]{}#&*!|>'"%@`]/.test(text),
  (text) => /['"]$/.test(text),
  (text) => text.includes(': '),
  (text) => text.includes(' #'),
  (text) => text.endsWith(':'),
];

/**
 * A value for a front-matter line that the import's reader gives back as written,
 * or null when none exists. The reader (repo-draft.js `readScalar`) ends a quoted
 * value at the next quote of the same kind and cuts an unquoted one at ` #`.
 */
export function frontMatterValue(value) {
  const text = String(value);
  if (!NEEDS_QUOTES.some((needs) => needs(text))) return text;
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  return null;
}

/** `Landing zones: why not?` → `landing-zones-why-not` */
export function draftName(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/g, '');
}

/**
 * Turn an outlined idea into the text of a blog draft, or say why it cannot be.
 * Pure: it writes nothing.
 *
 * @param {object} note the `note` that checkNote returned
 * @param {{ name?: string, now?: () => Date }} [options]
 *   `name` replaces the file name taken from the title (lower-case words and hyphens).
 * @returns {{ ok: true, name: string, fileName: string, text: string } | { ok: false, reasons: string[] }}
 */
export function planPromotion(note, { name, now = () => new Date() } = {}) {
  const reasons = [];
  if (note.status !== 'outlined') {
    reasons.push(`status is "${note.status}"; only an outlined idea is promoted`);
  }
  if (note.type !== 'blog') {
    reasons.push(
      `type is "${note.type}"; only blog articles become drafts`
    );
  }
  const track = FORMAT_TO_TRACK[note.format];
  if (!track) {
    reasons.push(`format is "${note.format}"; a blog draft is a how-to or a build-log`);
  }
  for (const hit of findObsidianOnly(note.body, note.bodyLine)) {
    reasons.push(`line ${hit.line}: ${hit.what}; remove or rewrite it`);
  }

  const title = frontMatterValue(note.title);
  if (title === null) reasons.push('the title holds both kinds of quote mark; reword it');
  const subtitle = note.subtitle ? frontMatterValue(note.subtitle) : '';
  if (subtitle === null) reasons.push('the subtitle holds both kinds of quote mark; reword it');

  const chosen = name ?? draftName(note.title);
  const fileName = `blog-${chosen}.md`;
  const nameProblem = fileNameProblem(name, chosen, fileName);
  if (nameProblem) reasons.push(nameProblem);
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, name: chosen, fileName, text: draftText(note, { title, subtitle, track, now }) };
}

/** Why the chosen file name will not do, or null: not hyphenated words, or not a path the draft reader accepts. */
function fileNameProblem(name, chosen, fileName) {
  if (!chosen || !WORDS.test(chosen)) {
    return name
      ? `--name "${name}" must be lower-case words joined by hyphens`
      : 'the title gives no usable file name (no letters or digits a file name can hold); pass --name';
  }
  const path = `docs/content/${fileName}`;
  if (!DRAFT_PATH.test(path) || path.length > MAX_DRAFT_PATH) {
    return `${path} is not a file name the draft reader accepts (at most ${MAX_DRAFT_PATH} characters)`;
  }
  return null;
}

/** The draft: its front matter, then the note's body. */
function draftText(note, { title, subtitle, track, now }) {
  const lines = ['---', `title: ${title}`];
  if (note.subtitle) lines.push(`subtitle: ${subtitle}`);
  lines.push(`date: ${note.date ?? now().toISOString().slice(0, 10)}`);
  lines.push(`track: ${track}`);
  if (note.part) lines.push(`part: ${note.part}`);
  if (note.tags.length > 0) lines.push(`tags: [${note.tags.join(', ')}]`);
  if (note.reading) lines.push(`reading: ${note.reading}`);
  lines.push('---', '', note.body, '');
  return lines.join('\n');
}

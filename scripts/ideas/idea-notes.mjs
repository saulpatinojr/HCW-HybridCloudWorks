/**
 * idea-notes.mjs — the format of an idea note, the check that holds a folder of
 * them to it, and the one-way step that turns an outlined idea into a blog draft.
 *
 * WHAT THIS IS FOR. The owner keeps a second brain in Obsidian, outside this
 * repository: ideas for content, grouped by theme, each with a type, a format
 * and a status. The repository is public, so the notes never come here. What
 * does come here is this code, which reads a note that someone hands it and
 * never writes to the vault. The one thing it produces is a draft article in
 * `docs/content/blog-<name>.md`, in the shape the admin's "Import from
 * docs/content" already takes (functions/src/lib/cms/repo-draft.js), so a
 * promoted idea is a copy of the same words rather than a translation.
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
 * WHAT PROMOTING REFUSES, and why. A note body becomes a file in a public
 * repository. The check cannot know what is private, but it can refuse what
 * can only be private notes or only work in Obsidian: [[wikilinks]] and
 * ![[embeds]] to other notes, %% comments %%, and Dataview or Tasks query
 * blocks. Anything else in the body is carried over as written, so the draft
 * has to be read before it is committed; the runbook says so.
 *
 * Dependency-free on purpose (node: only): a functions test imports this file
 * to prove that what it writes passes the real import.
 */

export const IDEA_TYPES = Object.freeze(['blog', 'framework', 'architecture', 'coder_corner']);
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

/** The drafts the admin import will take (repo-draft.js REPO_DRAFT_PATH_PATTERN, MAX_REPO_PATH_LENGTH). */
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
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return { fields: null, unclosed: true, problems: [], body: source, bodyLine: 1 };
  }

  const fields = new Map();
  const problems = [];
  let current = null;
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index].trimEnd();
    const line = index + 1;
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const item = /^\s*-\s+(.*)$/.exec(raw) ?? /^\s*-$/.exec(raw);
    if (item && current) {
      current.kind = 'list';
      const value = unquote(item[1] ?? '');
      if (value) current.items.push(value);
      continue;
    }

    const entry = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(raw);
    if (!entry) {
      if (/^\s/.test(raw) && current) {
        if (KNOWN_KEYS.includes(current.key)) {
          problems.push({
            line,
            field: current.key,
            message: `${current.key} must fit on one line`,
          });
        }
        continue;
      }
      problems.push({
        line,
        field: null,
        message: `cannot read this line of the properties; write it as name: value`,
      });
      current = null;
      continue;
    }

    const key = entry[1];
    const rest = (entry[2] ?? '').trim();
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
      const quote = rest[0];
      if (quote === '"' || quote === "'") {
        const close = rest.indexOf(quote, 1);
        const after = close > 0 ? rest.slice(close + 1).trim() : '';
        if (after && !after.startsWith('#')) field.junk = after;
      }
    }
    if (fields.has(key)) {
      problems.push({ line, field: key, message: `${key} is written twice` });
    } else {
      fields.set(key, field);
    }
    current = field;
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

  const get = (key) => parsed.fields.get(key);
  const scalar = (key, { required = false } = {}) => {
    const field = get(key);
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
  };
  const oneOf = (key, allowed) => {
    const value = scalar(key, { required: true });
    if (value === null) return null;
    if (!allowed.includes(value)) {
      add(`${key}: "${value}" is not one of ${allowed.join(', ')}`, key, get(key).line);
      return null;
    }
    return value;
  };

  const type = oneOf('type', IDEA_TYPES);
  const format = oneOf('format', IDEA_FORMATS);
  const status = oneOf('status', IDEA_STATUSES);

  const theme = scalar('theme', { required: true });
  if (theme !== null && (!WORDS.test(theme) || theme.length > LIMITS.theme)) {
    add(
      `theme: "${theme}" must be lower-case words joined by hyphens, at most ${LIMITS.theme} characters`,
      'theme',
      get('theme').line
    );
  }

  const stem = String(name ?? '').replace(/\.md$/i, '').trim();
  const title = (scalar('title') ?? '').trim() || stem;
  if (!title) add('the note has no title and no usable file name', 'title');
  if (title.length > LIMITS.title) {
    add(`title is ${title.length} characters; at most ${LIMITS.title}`, 'title', get('title')?.line);
  }

  const subtitle = (scalar('subtitle') ?? '').trim();
  if (subtitle.length > LIMITS.subtitle) {
    add(
      `subtitle is ${subtitle.length} characters; at most ${LIMITS.subtitle}`,
      'subtitle',
      get('subtitle')?.line
    );
  }

  const tagField = get('tags');
  const tags = [];
  if (tagField && tagField.kind !== 'empty') {
    const raw = tagField.kind === 'list' ? tagField.items : [tagField.value];
    for (const entry of raw) {
      const tag = String(entry).replace(/^#/, '');
      if (!WORDS.test(tag) || tag.length > LIMITS.tag) {
        add(
          `tag "${entry}" must be lower-case words joined by hyphens, at most ${LIMITS.tag} characters`,
          'tags',
          tagField.line
        );
      } else if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
    if (tags.length > LIMITS.tags) {
      add(`${tags.length} tags; at most ${LIMITS.tags}`, 'tags', tagField.line);
    }
  }

  let reading = null;
  const readingRaw = scalar('reading');
  if (readingRaw !== null) {
    if (/^\d{1,3}$/.test(readingRaw) && Number(readingRaw) > 0) {
      reading = Number(readingRaw);
    } else {
      add(`reading: "${readingRaw}" must be a whole number of minutes, 1 to 999`, 'reading', get('reading').line);
    }
  }

  const part = scalar('part');
  if (part !== null && !/^\d{1,2} of \d{1,2}$/.test(part)) {
    add(`part: "${part}" must be written like "1 of 2"`, 'part', get('part').line);
  }

  const date = scalar('date');
  if (date !== null && !isCalendarDate(date)) {
    add(`date: "${date}" must be a real date written YYYY-MM-DD`, 'date', get('date').line);
  }

  const body = parsed.body.replace(/^\n+/, '').trimEnd();
  if (status !== null && NEEDS_BODY.includes(status) && !body.trim()) {
    add(
      `status is "${status}" but nothing is written under the properties; add the outline, or set the status back to idea`,
      'status',
      get('status').line
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

/**
 * A value for a front-matter line that the import's reader gives back as written,
 * or null when none exists. The reader (repo-draft.js `readScalar`) ends a quoted
 * value at the next quote of the same kind and cuts an unquoted one at ` #`.
 */
export function frontMatterValue(value) {
  const text = String(value);
  const plain =
    !/^[\-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
    !/['"]$/.test(text) &&
    !text.includes(': ') &&
    !text.includes(' #') &&
    !text.endsWith(':');
  if (plain) return text;
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
      `type is "${note.type}"; the repository import takes blog articles only (docs/content/blog-*.md)`
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
  if (!chosen || !WORDS.test(chosen)) {
    reasons.push(
      name
        ? `--name "${name}" must be lower-case words joined by hyphens`
        : 'the title gives no usable file name (no letters or digits a file name can hold); pass --name'
    );
  }
  const fileName = `blog-${chosen}.md`;
  const path = `docs/content/${fileName}`;
  if (chosen && WORDS.test(chosen) && (!DRAFT_PATH.test(path) || path.length > MAX_DRAFT_PATH)) {
    reasons.push(`${path} is not a path the import accepts (at most ${MAX_DRAFT_PATH} characters)`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const lines = ['---', `title: ${title}`];
  if (note.subtitle) lines.push(`subtitle: ${subtitle}`);
  lines.push(`date: ${note.date ?? now().toISOString().slice(0, 10)}`);
  lines.push(`track: ${track}`);
  if (note.part) lines.push(`part: ${note.part}`);
  if (note.tags.length > 0) lines.push(`tags: [${note.tags.join(', ')}]`);
  if (note.reading) lines.push(`reading: ${note.reading}`);
  lines.push('---', '', note.body, '');
  return { ok: true, name: chosen, fileName, text: lines.join('\n') };
}
